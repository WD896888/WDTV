// ============================================================
// 弹幕数据模块（弹弹play v2 规范客户端 + 匹配引擎 + 缓存）
// ------------------------------------------------------------
// 职责（只负责"取数据"，渲染由 artplayer-plugin-danmuku 插件完成）：
//   1. 端点解析：同源转发层 /danmu/ 探测 → 自定义端点 → 内置默认端点（均不可用则静默禁用）
//   2. 弹弹play v2 客户端：search/episodes（自动匹配）、search/anime + bangumi（手动匹配）、
//      comment/{episodeId}（弹幕拉取）；请求统一 12s 超时，任何失败返回空值、绝不向上抛错
//   3. 自动匹配引擎：标题规范化（去噪声词）→ bigram 相似度打分 → 集数对齐 → 记忆映射
//   4. 缓存：弹幕按 episodeId 缓存、"标题+集数 → episodeId"记忆映射（localStorage，容量受限按最旧淘汰）
//   5. 事件通知：加载成功派发 danmu:loaded，确定无弹幕派发 danmu:unavailable（供播放器显隐控制按钮）
// 供 player.js 通过 window.Danmu 调用；本模块不依赖 player.js 的任何全局。
// ============================================================
(function () {
    'use strict';

    // 内置默认端点：Cloudflare Workers 自定义域自建弹幕源（danmu_api，2026-09 自阿里云 FC 回迁——
    // FC 按量付费欠费停服；workers.dev 域名国内被阻断，故绑定主站同 Zone 自定义域，国内直连无跨国风控；
    // TOKEN 为 URL 路径首段的防滥用口令，非密钥可公开）。
    // 注意：若自建源失效，可在首页设置面板填入自部署
    // danmu_api（https://github.com/huangxd-/danmu_api，CF Workers 免费一键部署）或其他兼容端点替换，
    // 同样支持「地址|口令」格式（TOKEN 经 X-Proxy-Token 头携带）；留空则回退本默认值。
    const DEFAULT_DANMU_API = 'https://danmu.wdmatch1.dpdns.org/zrt1ym8hlfq6';
    // 旧公共代理兜底（个人维护，高峰期限流；仅当自建源与转发层全部不可达时使用）
    const LEGACY_PUBLIC_PROXY = 'https://ddplay.retr0.xyz|8TUf1AYTwQFjGv';

    const FETCH_TIMEOUT = 12000;            // 单次请求超时（毫秒）
    const MAP_TTL = 30 * 24 * 60 * 60 * 1000; // 记忆映射有效期：30 天
    const MAP_MAX = 60;                     // 记忆映射最大条目数（超出按 ts 最旧淘汰）
    const CACHE_MAX = 15;                   // 弹幕缓存最大集数（超出按 ts 最旧淘汰）
    const CACHE_SIZE_LIMIT = 2.5 * 1024 * 1024; // 弹幕缓存写入体积上限（超出淘汰最旧一半再试）
    const DANMU_MAX = 8000;                 // 单集弹幕数量上限（超出均匀抽样）
    const MATCH_MIN_SCORE = 0.35;           // 自动匹配最低置信分
    const DURATION_TOLERANCE = 300;         // 时长校验允许偏差（秒）

    const LS_MAP_KEY = 'danmuEpisodeMap';   // 记忆映射：标题#集数 → episodeId
    const LS_CACHE_KEY = 'danmuCache';      // 弹幕缓存：episodeId → {list, ts}

    // 端点解析结果缓存（Promise）：解析一次反复使用；自定义端点变更时失效重解析
    // 多源故障转移：候选端点按优先级全量保留（转发层 → 自定义 → 内置默认），
    // 请求时从当前活跃端点起轮询，某个源挂掉自动降级到下一个（同时启用的核心机制）
    let endpointListPromise = null;
    let endpointUsedCustom = null;
    let activeEndpoint = null; // 当前实际使用的端点 {base, token}
    // 手动切换锁定的源（switchSource 设置，base 字符串）。用户显式选择的源优先于
    // 一切自动故障转移：不锁定的话，apiGet 的单请求级降级与 getForPlayer 的整链
    // 轮换都会在锁定源失败时悄悄转回其他源，"切换数据源"等于永远不生效
    let pinnedBase = null;

    // 解析端点配置串：'URL' 或 'URL|TOKEN'（TOKEN 为可选防滥用口令，请求时以 X-Proxy-Token 头携带）
    function parseEndpoint(raw) {
        const s = (raw || '').trim();
        if (!s) return null;
        const idx = s.lastIndexOf('|');
        const base = (idx > 0 ? s.slice(0, idx) : s).trim().replace(/\/+$/, '');
        if (!base) return null;
        const token = idx > 0 ? s.slice(idx + 1).trim() : '';
        return { base, token: token || null };
    }

    // 最近一次 getForPlayer 的上下文与结果（手动匹配、plugin.load 重建时使用）
    let lastCtx = null;
    let lastDanmuku = [];
    let currentEpisodeId = null;

    // 竞态令牌：换集/快速切换时旧请求结果直接丢弃，不污染新结果
    let matchToken = 0;

    // 时长查询函数（player.js 集成时注入：fn(episodeUrl) => 秒|null）
    let durationProvider = null;

    // ------------------------------------------------------------
    // 标题规范化：去噪声词（大小写不敏感）+ 归一空格 + 去首尾杂项标点（保留年份括号）
    // ------------------------------------------------------------
    const NOISE_WORDS = [
        'blu[- ]?ray', 'web[- ]?dl', 'h\\.?26[45]', 'x26[45]', 'hevc', 'avc',
        '1080p', '2160p', '720p', '4k', '8k', 'hdr', 'hd', 'aac', 'flac',
        'dolby', 'atmos', 'remux', 'fluo', 'dv',
        '蓝光', '高清', '高码率', '原盘', '杜比', '全景声', '帧率', '60帧', '120帧',
        '国语', '粤语', '中文', '中字', '日语', '原声', '双语', '简体', '繁体', '内嵌', '内封',
        '全集版', '未删减', '加长版', '独家', '抢先版'
    ];
    // 长词优先，避免 "HDR" 被 "HD" 先拆剩一个 R
    NOISE_WORDS.sort((a, b) => b.length - a.length);
    const NOISE_RE = new RegExp(NOISE_WORDS.join('|'), 'gi');

    function normalizeTitle(t) {
        if (!t) return '';
        let s = String(t)
            .replace(/[\u3000]+/g, ' ')   // 全角空格归一
            .replace(NOISE_RE, ' ')       // 去噪声词（大小写不敏感）
            .replace(/\s+/g, ' ')         // 多空格归一
            .trim();
        // 去掉开头/结尾的杂项标点；结尾的年份括号（如 "(2024)"）保留
        s = s.replace(/^[\s\-_·•|:：,，.。!！?？~～"'""''「」『』【】\[\]（）()]+/, '')
             .replace(/[\s\-_·•|:：,，.。!！?？~～"'""''「」『』【】\[\]]+$/, '');
        return s.trim();
    }

    // 字符 bigram 集合的重叠系数（交集 / 较小集合大小），取值 0~1
    function bigramSim(a, b) {
        if (!a || !b) return 0;
        if (a === b) return 1;
        const setA = new Set();
        for (let i = 0; i < a.length - 1; i++) setA.add(a.slice(i, i + 2));
        const setB = new Set();
        for (let i = 0; i < b.length - 1; i++) setB.add(b.slice(i, i + 2));
        if (!setA.size || !setB.size) return 0; // 单字标题无法构成 bigram，直接不匹配
        let inter = 0;
        setA.forEach(g => { if (setB.has(g)) inter++; });
        return inter / Math.min(setA.size, setB.size);
    }

    // 从剧集标题解析集号，失败返回 null
    function parseEpisodeNumber(t) {
        if (!t) return null;
        // 预先剥掉结尾闭合括号，便于 "[07]"/"第3话)" 之类取到数字
        const s = String(t).trim().replace(/[)）\]】」』\s]+$/, '');
        // 第12集 / 第03话 / 第2期 / 第5回
        let m = s.match(/第\s*(\d{1,4})\s*[集话期回]/);
        if (m) return parseInt(m[1], 10);
        // 结尾集号：E12 / P3 / 07 / "12集"（1900~2100 视为年份，避免把片尾年份误判为集号）
        m = s.match(/[Ee][Pp]?(\d{1,4})\s*[集话期回]?$/) || s.match(/(\d{1,4})\s*[集话期回]?$/);
        if (m) {
            const n = parseInt(m[1], 10);
            if (n >= 1900 && n <= 2100) return null; // 像年份的数字不当作集号
            return n;
        }
        return null;
    }

    // ------------------------------------------------------------
    // localStorage 读写（全部 try/catch：配额满/隐私模式静默降级，绝不报错）
    // ------------------------------------------------------------
    function readLSJSON(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return {};
            const obj = JSON.parse(raw);
            return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
        } catch (e) {
            return {};
        }
    }

    function writeLSJSON(key, obj) {
        try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) { /* 写满/异常静默 */ }
    }

    // 按 ts 最旧淘汰超容量条目（obj: { key: {ts, ...} }）
    function evictOldest(obj, max) {
        const keys = Object.keys(obj);
        if (keys.length <= max) return;
        keys.sort((a, b) => (obj[a].ts || 0) - (obj[b].ts || 0));
        while (Object.keys(obj).length > max) delete obj[keys.shift()];
    }

    function lookupMap(titleKey) {
        const entry = readLSJSON(LS_MAP_KEY)[titleKey];
        if (!entry || !entry.episodeId) return null;
        if (Date.now() - (entry.ts || 0) > MAP_TTL) return null; // 过期视为未命中
        return entry;
    }

    // 记忆命中后恢复其来源端点为活跃端点（跨源 episodeId 不兼容：
    // 旧记忆的 ID 只在原源有效，必须锁定回原源查询弹幕）。
    // 来源端点已不在候选列表（下线/被移除）时返回 false，调用方应忽略该记忆重新匹配
    function restoreEndpointByBase(base) {
        if (!base) return false;
        return resolveEndpoints().then(eps => {
            const ep = eps.find(e => e.base === base);
            if (ep) { activeEndpoint = ep; return true; }
            return false;
        });
    }

    function saveMap(titleKey, matched) {
        const map = readLSJSON(LS_MAP_KEY);
        map[titleKey] = {
            episodeId: matched.episodeId,
            animeTitle: matched.animeTitle || '',
            episodeTitle: matched.episodeTitle || '',
            sourceBase: (activeEndpoint && activeEndpoint.base) || null, // 记录来源端点，命中时锁定回原源
            ts: Date.now()
        };
        evictOldest(map, MAP_MAX);
        writeLSJSON(LS_MAP_KEY, map);
    }

    function readCache(episodeId) {
        const entry = readLSJSON(LS_CACHE_KEY)[episodeId];
        if (!entry || !Array.isArray(entry.list)) return null;
        return entry.list;
    }

    function saveCache(episodeId, list) {
        const cache = readLSJSON(LS_CACHE_KEY);
        cache[episodeId] = { list, ts: Date.now() };
        evictOldest(cache, CACHE_MAX);
        // 体积超限：整体淘汰最旧一半再试；仍失败则放弃本次缓存（try/catch 内静默）
        try {
            if (JSON.stringify(cache).length > CACHE_SIZE_LIMIT) {
                evictOldest(cache, Math.max(1, Math.floor(CACHE_MAX / 2)));
            }
            localStorage.setItem(LS_CACHE_KEY, JSON.stringify(cache));
        } catch (e) { /* 丢弃，不影响功能 */ }
    }

    // ------------------------------------------------------------
    // 网络层：统一 12s 超时 + 全 try/catch，失败返回 null，绝不抛错
    // （proxyToken 为可选防滥用口令，经 X-Proxy-Token 头携带——部分公共代理以此限流）
    // ------------------------------------------------------------
    async function fetchJSON(url, proxyToken) {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = setTimeout(() => { if (controller) controller.abort(); }, FETCH_TIMEOUT);
        try {
            const headers = { 'Accept': 'application/json' };
            if (proxyToken) headers['X-Proxy-Token'] = proxyToken;
            const res = await fetch(url, {
                method: 'GET',
                headers,
                signal: controller ? controller.signal : undefined
            });
            if (!res.ok) return null;
            const data = await res.json();
            return (data && typeof data === 'object') ? data : null;
        } catch (e) {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    function getCustomApi() {
        try {
            let v = (localStorage.getItem('danmuCustomApi') || '').trim();
            // 一次性迁移：指向历史默认源的自定义端点静默清除（workers.dev 域名国内被阻断、
            // 阿里云 FC 已欠费停服，残留会以最高优先级挡在新源前，每次请求都先超时 12s 才降级）
            if (v && (v.includes('danmu-api.1936371568.workers.dev') || v.includes('fcapp.run'))) {
                v = '';
                try { localStorage.removeItem('danmuCustomApi'); } catch (e) { /* 静默 */ }
            }
            return v.replace(/\/+$/, '');
        } catch (e) {
            return '';
        }
    }

    // 端点解析（lazy：首次用到弹幕时才发起探测，不在页面加载即发）
    // 返回候选端点列表（按优先级）：设置面板自定义端点 → 内置自建源 →
    // 同源转发层 /danmu/（探测可用才列入，自建源不可达时的回退）→ 旧公共代理
    // 全部不可用返回 []（弹幕静默禁用）
    function resolveEndpoints() {
        const custom = getCustomApi();
        // 自定义端点未变化时直接复用缓存结果（探测请求也随之省掉）
        if (endpointListPromise && endpointUsedCustom === custom) return endpointListPromise;
        endpointUsedCustom = custom;
        endpointListPromise = (async () => {
            const list = [];
            // 1. 设置面板自定义端点（支持「地址|口令」格式）
            const customEp = parseEndpoint(custom);
            if (customEp) list.push(customEp);
            // 2. 内置默认端点：自建源（CF Workers 自定义域，国内直连，无跨国风控）
            const cfEp = parseEndpoint(DEFAULT_DANMU_API);
            if (cfEp) list.push(cfEp);
            // 3. 同源转发层探测：Cloudflare Pages Functions 配置 DANMU_BASE/官方凭据时返回 {configured:true}
            //    （自建源直连失败时经 CF Pages Function 回源兜底）
            const probe = await fetchJSON('/danmu/');
            if (probe && probe.configured === true) list.push({ base: '/danmu', token: null, mode: probe.mode || 'custom' });
            // 4. 旧公共代理兜底
            const legacyEp = parseEndpoint(LEGACY_PUBLIC_PROXY);
            if (legacyEp) list.push(legacyEp);
            return list;
        })();
        return endpointListPromise;
    }

    // 对外兼容接口：返回主端点 base 或 null
    function resolveEndpoint() {
        return resolveEndpoints().then(list => list.length ? list[0].base : null);
    }

    // 活跃端点轮换：切到候选列表中的下一个源（多源故障转移的"整任务级"降级——
    // 跨源 episodeId 互不兼容，单请求级降级不够，匹配失败时需整链换源重搜）
    async function rotateEndpoint() {
        const eps = await resolveEndpoints();
        if (eps.length < 2) return;
        const idx = activeEndpoint ? eps.indexOf(activeEndpoint) : 0;
        activeEndpoint = eps[(idx + 1) % eps.length];
    }

    // 端点的可读标签（供 UI 展示数据来源：自建源/官方API/自定义源/公共代理）
    function labelOfEndpoint(ep) {
        if (!ep) return '未加载';
        if (ep.base === '/danmu') {
            return ep.mode === 'official' ? '弹弹play官方API' : '自建源';
        }
        const def = parseEndpoint(DEFAULT_DANMU_API);
        if (def && ep.base === def.base) return '自建源';
        const legacy = parseEndpoint(LEGACY_PUBLIC_PROXY);
        if (legacy && ep.base === legacy.base) return '公共代理';
        return '自定义源';
    }

    function getActiveSourceLabel() {
        return labelOfEndpoint(activeEndpoint);
    }

    // 候选源清单（弹幕设置浮层的下拉框选项）：[{base, label}]，按解析优先级排序
    async function getSourceList() {
        const eps = await resolveEndpoints();
        return eps.map(ep => ({ base: ep.base, label: labelOfEndpoint(ep) }));
    }

    // 当前活跃源 base（下拉框回显选中项）
    function getActiveSourceBase() {
        return activeEndpoint ? activeEndpoint.base : null;
    }

    // 手动切换源（浮层下拉框选择/轮换入口共用的落地逻辑）：指定目标端点 + 锁定 + 清空当前
    // 数据与该标题的记忆映射（旧映射指向旧源的 episodeId，不清会导致切源后第 1 轮仍命中旧 ID）。
    // 锁定语义：此后所有请求（自动匹配/预热/手动匹配）只走该源，直到再次切换或
    // 该源从候选列表消失（自定义端点变更等，在 apiGet/getForPlayer 中惰性解除）
    async function switchSource() {
        await rotateEndpoint();
        return applySourceEndpoint(activeEndpoint);
    }

    // 直接选定目标源（下拉框选择）：base 必须在候选列表中，返回新源标签；不合法返回 null
    async function selectSource(base) {
        const eps = await resolveEndpoints();
        const target = eps.find(ep => ep.base === base);
        if (!target) return null;
        return applySourceEndpoint(target);
    }

    function applySourceEndpoint(ep) {
        activeEndpoint = ep;
        pinnedBase = ep ? ep.base : null;
        lastDanmuku = [];
        try {
            if (lastCtx && lastCtx.title) {
                const map = readLSJSON(LS_MAP_KEY);
                delete map[normalizeTitle(lastCtx.title) + '#' + lastCtx.episodeIndex];
                writeLSJSON(LS_MAP_KEY, map);
            }
        } catch (e) { /* 静默 */ }
        return getActiveSourceLabel();
    }

    // 带故障转移的端点请求：从当前活跃端点起按优先级轮询候选列表；
    // 业务层错误（success:false，如官方源 errorCode）同样视为该源失败降级；
    // 全部失败返回 null（活跃端点保持不变，下次仍从主端点重试）。
    // 手动锁定源（pinnedBase）时只请求锁定端点，绝不静默降级到其他源——
    // 否则切换数据源会被这里的降级悄悄改回原源；锁定源已不在候选列表
    // （被移除/自定义端点变更）时解除锁定，恢复完整候选轮询
    async function apiGet(pathAndQuery) {
        const eps = await resolveEndpoints();
        if (!eps.length) return null;
        let list = eps;
        if (pinnedBase) {
            const pinned = eps.find(e => e.base === pinnedBase);
            if (pinned) list = [pinned];
            else pinnedBase = null;
        }
        let start = activeEndpoint ? list.indexOf(activeEndpoint) : 0;
        if (start < 0) start = 0;
        for (let i = 0; i < list.length; i++) {
            const ep = list[(start + i) % list.length];
            const data = await fetchJSON(ep.base + pathAndQuery, ep.token);
            if (data && data.success !== false) { activeEndpoint = ep; return data; }
        }
        return null;
    }

    // ------------------------------------------------------------
    // 弹弹play v2 规范接口（经 apiGet 自动多源故障转移）
    // ------------------------------------------------------------
    // 一步检索（animes[].episodes[] 即剧集平铺）——部分数据源/官方对该端点支持不佳
    // （实测公共代理返回 errorCode 2 且易漏作品），自动匹配改走 search/anime + bangumi 两步链路，
    // 此接口保留作为规范客户端完整性的一部分
    async function searchEpisodes(keyword) {
        if (!keyword) return null;
        const data = await apiGet(`/api/v2/search/episodes?keyword=${encodeURIComponent(keyword)}`);
        return (data && Array.isArray(data.animes)) ? data.animes : null;
    }

    // 手动匹配/自动匹配第一级：番剧/剧集列表（不含剧集详情）
    async function searchAnime(keyword) {
        try {
            if (!keyword) return [];
            const data = await apiGet(`/api/v2/search/anime?keyword=${encodeURIComponent(keyword)}`);
            return (data && Array.isArray(data.animes)) ? data.animes : [];
        } catch (e) {
            return [];
        }
    }

    // 手动匹配/自动匹配第二级：单部作品的剧集列表
    async function getBangumi(animeId) {
        try {
            if (animeId === undefined || animeId === null) return null;
            const data = await apiGet(`/api/v2/bangumi/${encodeURIComponent(animeId)}`);
            return (data && data.bangumi) ? data.bangumi : null;
        } catch (e) {
            return null;
        }
    }

    // 拉取某集原始弹幕（dandanplay 格式），失败返回 null
    async function getComments(episodeId) {
        const data = await apiGet(`/api/v2/comment/${episodeId}?format=json`);
        return (data && Array.isArray(data.comments)) ? data.comments : null;
    }

    // ------------------------------------------------------------
    // dandanplay p 字段 → 插件格式 {text, time, mode, color}
    // p = "<time秒>,<mode>,<color十进制>,<source>,..."；plugin 约定 mode 0=滚动 1=顶部 2=底部
    // ------------------------------------------------------------
    function convertComments(rawList) {
        const out = [];
        for (const c of rawList) {
            if (!c || typeof c.m !== 'string' || typeof c.p !== 'string') continue;
            const text = c.m.trim();
            if (!text || text.length > 100) continue; // 空文本/超长文本丢弃
            const parts = c.p.split(',');
            const time = parseFloat(parts[0]);
            if (!isFinite(time) || time < 0) continue;
            const rawMode = parseInt(parts[1], 10);
            let mode = 0;                     // dandanplay 1/2/3 均为滚动 → 0，未知类型也按滚动
            if (rawMode === 5) mode = 1;      // 顶部
            else if (rawMode === 4) mode = 2; // 底部
            const rawColor = parseInt(parts[2], 10);
            let color = '#FFFFFF';            // 无色/异常色默认白
            if (isFinite(rawColor) && rawColor > 0 && rawColor <= 0xFFFFFF) {
                color = '#' + rawColor.toString(16).padStart(6, '0');
            }
            out.push({ text, time, mode, color });
        }
        return out;
    }

    // 超上限时均匀抽样（保持时间分布），防止内存与渲染压力
    function sampleToMax(list) {
        if (list.length <= DANMU_MAX) return list;
        const step = list.length / DANMU_MAX;
        const out = [];
        for (let i = 0; i < DANMU_MAX; i++) out.push(list[Math.floor(i * step)]);
        return out;
    }

    // ------------------------------------------------------------
    // 自动匹配：记忆映射 → 检索作品（search/anime）→ 拉取剧集（bangumi）→ 集数对齐
    // 返回 {episodeId, animeTitle, episodeTitle} 或 null
    // ------------------------------------------------------------
    async function autoMatch(ctx, skipMemo) {
        // 1. 记忆映射命中（30 天内）直接复用，省去检索；换源重匹配时跳过（旧映射指向失败源）。
        //    命中时恢复其来源端点为活跃端点（跨源 ID 不兼容）；来源已下线则忽略记忆重新匹配。
        //    手动锁定源期间：指向其他源的记忆一律忽略——旧源 ID 在锁定源查询必然失败，
        //    必须按锁定源重新检索匹配（命中后写回的新记忆自然带锁定源的 sourceBase）
        const titleKey = normalizeTitle(ctx.title) + '#' + ctx.episodeIndex;
        if (!skipMemo) {
            const memo = lookupMap(titleKey);
            if (memo && (!pinnedBase || memo.sourceBase === pinnedBase)) {
                const restored = restoreEndpointByBase(memo.sourceBase);
                if (restored === false) {
                    return { episodeId: memo.episodeId, animeTitle: memo.animeTitle || '', episodeTitle: memo.episodeTitle || '' };
                }
                return restored.then(ok => {
                    if (!ok) return null; // 来源端点已下线：忽略旧记忆，走正常检索匹配
                    return { episodeId: memo.episodeId, animeTitle: memo.animeTitle || '', episodeTitle: memo.episodeTitle || '' };
                });
            }
        }

        // 2. 检索作品 + 打分：bigram 相似度为主，剧集/番剧类型小加成
        //    （用 search/anime 而非 search/episodes：后者部分数据源报参错/漏作品；
        //      anime 列表不含剧集，打分选定作品后再经 bangumi 拉剧集）
        const animes = await searchAnime(normalizeTitle(ctx.title));
        if (!animes || !animes.length) return null;

        const nUser = normalizeTitle(ctx.title);
        let best = null;
        for (const anime of animes) {
            const nAnime = normalizeTitle(anime && anime.animeTitle);
            let score = bigramSim(nUser, nAnime);
            // 类型小加成：无强偏好，片名匹配度已接近时最多 +0.05
            if (score >= 0.5 && /电视剧|动漫|番剧/.test((anime && anime.typeDescription) || '')) {
                score += 0.05;
            }
            if (score < MATCH_MIN_SCORE) continue; // 低置信直接过滤
            if (!best || score > best.score) best = { anime, score };
        }
        if (!best) return null;

        // 3. 拉取所选作品的剧集列表
        const bangumi = await getBangumi(best.anime && best.anime.animeId);
        const episodes = (bangumi && Array.isArray(bangumi.episodes)) ? bangumi.episodes : [];
        if (!episodes.length) return null;

        // 4. 集数对齐选集
        const target = ctx.episodeIndex + 1;
        const nums = episodes.map(ep => parseEpisodeNumber(ep && ep.episodeTitle));
        let picked = null;
        let anyParsed = false;
        for (let i = 0; i < episodes.length; i++) {
            if (nums[i] !== null) {
                anyParsed = true;
                if (nums[i] === target) { picked = episodes[i]; break; } // 集号不连续也按号对齐
            }
        }
        if (!picked) {
            // 集号无法解析：本站总集数与弹幕侧集数一致时按下标对齐
            if (!anyParsed && ctx.totalEpisodes > 0 && episodes.length === ctx.totalEpisodes) {
                picked = episodes[ctx.episodeIndex] || null;
            } else if (episodes.length === 1 && ctx.episodeIndex === 0) {
                // 单集资源且当前就是第 1 集 → 直接选
                picked = episodes[0];
            }
        }
        if (!picked || picked.episodeId === undefined || picked.episodeId === null) return null;

        // 5. 时长校验（尽力而为）：弹幕侧规范不返回单集时长，校验恒跳过；
        //    保留钩子——未来数据源提供时长时，两侧时长差 > 300s 即降级为手动建议（不自动采用）
        const localDuration = durationProvider ? durationProvider(ctx.episodeUrl) : null;
        const danmuDuration = null; // 弹幕侧时长（当前规范未提供）
        if (localDuration && danmuDuration && Math.abs(localDuration - danmuDuration) > DURATION_TOLERANCE) {
            return null;
        }

        return {
            episodeId: picked.episodeId,
            animeTitle: (best.anime && best.anime.animeTitle) || '',
            episodeTitle: picked.episodeTitle || ''
        };
    }

    // ------------------------------------------------------------
    // 事件通知（供 player.js 显隐控制栏弹幕按钮）
    // ------------------------------------------------------------
    function dispatchLoaded(detail) {
        try { window.dispatchEvent(new CustomEvent('danmu:loaded', { detail })); } catch (e) { /* 静默 */ }
    }

    function dispatchUnavailable() {
        try { window.dispatchEvent(new CustomEvent('danmu:unavailable')); } catch (e) { /* 静默 */ }
    }

    // ------------------------------------------------------------
    // 对外接口
    // ------------------------------------------------------------
    // 单轮尝试：匹配 → 拉取弹幕；skipMemo=true 时跳过记忆映射（换源重匹配场景）；
    // silent=true 为后台预热模式：不派发事件、不改 lastDanmuku/currentEpisodeId、失败不轮换源
    // 返回 {list, matched}，list 非空即成功
    async function tryMatchAndLoad(ctx, token, skipMemo, silent) {
        const matched = await autoMatch(ctx, skipMemo);
        if (token !== matchToken && !silent) return { list: [], matched: null };
        if (!matched || !matched.episodeId) return { list: [], matched: null };
        if (!silent) currentEpisodeId = matched.episodeId;

        // 缓存命中：零网络请求直接返回
        const cached = readCache(matched.episodeId);
        if (cached && cached.length) {
            if (!silent) {
                lastDanmuku = cached;
                dispatchLoaded({ count: cached.length, animeTitle: matched.animeTitle, episodeTitle: matched.episodeTitle });
            }
            return { list: cached, matched };
        }

        const raw = await getComments(matched.episodeId);
        if (token !== matchToken && !silent) return { list: [], matched: null };
        let list = raw ? sampleToMax(convertComments(raw)) : [];
        // danmu_api 冷启动特性：平台弹幕数据在后台异步构建，首次请求可能 404/空
        // （实测同 ID 首次 404、数秒后重试 200+1075 条）。两段退避重试（4s/12s）：
        // 第一段覆盖"快速构建"型，第二段覆盖"慢构建"型；仍无弹幕才判定该源该集无数据
        // （预热模式只保留第一段 4s 轻重试，避免后台任务长时间占用）
        const retryDelays = silent ? [4000] : [4000, 12000];
        for (const delay of retryDelays) {
            if (list.length || (token !== matchToken && !silent)) break;
            await new Promise(res => setTimeout(res, delay));
            if (token !== matchToken && !silent) return { list: [], matched: null };
            const raw2 = await getComments(matched.episodeId);
            if (token !== matchToken && !silent) return { list: [], matched: null };
            list = raw2 ? sampleToMax(convertComments(raw2)) : [];
        }
        if (!list.length) return { list: [], matched }; // 重试后仍无弹幕（调用方决定是否换源重匹配）

        if (!silent) lastDanmuku = list;
        saveCache(matched.episodeId, list);
        saveMap(normalizeTitle(ctx.title) + '#' + ctx.episodeIndex, matched);
        if (!silent) dispatchLoaded({ count: list.length, animeTitle: matched.animeTitle, episodeTitle: matched.episodeTitle });
        return { list, matched };
    }

    // 供 artplayer-plugin-danmuku 异步数据源调用：任何失败都 resolve([])，绝不 reject。
    // 多源策略：第 1 轮常规匹配（当前活跃源）；失败且存在多候选源时轮换源做第 2 轮
    // 整链重匹配（跨源 episodeId 互不兼容，必须重搜而非仅换弹幕接口）
    async function getForPlayer(ctx) {
        const token = ++matchToken;
        try {
            // 总开关关闭：只返回空数据，不发任何事件（按钮本就不该出现）
            if (!ctx || !isEnabled()) return [];
            lastCtx = ctx;

            // 第 1 轮：常规匹配
            let r = await tryMatchAndLoad(ctx, token, false);
            if (token !== matchToken) return [];
            if (r.list.length) return r.list;

            // 第 2 轮：轮换到下一个候选源整链重匹配（跳过指向失败源的记忆映射）。
            // 手动选择的源失败时解除锁定再轮换兜底："有弹幕"优先级最高——所选源对该集
            // 无数据（公共代理抓不到/自定义源未配好）时若锁死不轮换，切源即成永久空屏；
            // 解除后自动故障转移生效，下拉框回显将跟随实际生效源（refreshDanmuPanel 同步）
            const eps = await resolveEndpoints();
            if (pinnedBase && !eps.some(e => e.base === pinnedBase)) pinnedBase = null;
            pinnedBase = null; // 锁定源已失败，交还自动多源转移
            if (eps.length > 1) {
                await rotateEndpoint();
                r = await tryMatchAndLoad(ctx, token, true);
                if (token !== matchToken) return [];
                if (r.list.length) return r.list;
            }

            currentEpisodeId = null;
            lastDanmuku = [];
            dispatchUnavailable(); // 两轮均失败：确定无弹幕可用
            return [];
        } catch (e) {
            // 任何异常都静默降级，绝不影响播放
            if (token === matchToken) {
                currentEpisodeId = null;
                lastDanmuku = [];
                dispatchUnavailable();
            }
            return [];
        }
    }

    // 注册时长查询 fn(episodeUrl) => 秒|null（由 player.js 注入，模块内部不依赖 player.js 全局）
    function setDurationProvider(fn) {
        durationProvider = typeof fn === 'function' ? fn : null;
    }

    // 弹幕总开关（localStorage danmuEnabled，默认开）
    function isEnabled() {
        try {
            return localStorage.getItem('danmuEnabled') !== 'false';
        } catch (e) {
            return true;
        }
    }

    // 手动匹配选择：写入记忆映射（基于最近一次 getForPlayer 的上下文）+ 拉取弹幕 + 存缓存 + 派发事件。
    // 自建源冷启动特性：该集弹幕库后台异步构建，首次 comment 请求可能 404/空（自动匹配链路
    // 有两段退避重试，这里对齐）——否则表现为"搜索列表能出，点击选集即失败"。
    // 重试期间被更新请求作废（重新搜索/换集/重新自动匹配）则直接放弃
    async function manualSelect(sel) {
        const token = ++matchToken; // 作废在途的自动匹配请求
        try {
            if (!sel || sel.episodeId === undefined || sel.episodeId === null) return [];
            if (!isEnabled()) return [];
            let raw = await getComments(sel.episodeId);
            const retryDelays = [4000, 12000];
            for (const delay of retryDelays) {
                if (raw && Array.isArray(raw.comments) && raw.comments.length) break;
                if (token !== matchToken) return [];
                await new Promise(res => setTimeout(res, delay));
                if (token !== matchToken) return [];
                raw = await getComments(sel.episodeId);
            }
            if (!raw) return [];
            const list = sampleToMax(convertComments(raw));
            if (!list.length) return [];

            currentEpisodeId = sel.episodeId;
            lastDanmuku = list;
            saveCache(sel.episodeId, list);
            if (lastCtx && lastCtx.title) {
                saveMap(normalizeTitle(lastCtx.title) + '#' + lastCtx.episodeIndex, {
                    episodeId: sel.episodeId,
                    animeTitle: sel.animeTitle || '',
                    episodeTitle: sel.episodeTitle || ''
                });
            }
            dispatchLoaded({ count: list.length, animeTitle: sel.animeTitle || '', episodeTitle: sel.episodeTitle || '' });
            return list;
        } catch (e) {
            return [];
        }
    }

    function getLastDanmuku() {
        return lastDanmuku;
    }

    function getCurrentEpisodeId() {
        return currentEpisodeId;
    }

    // 挂载全局（无构建语法，IIFE + window）
    // 预热下一集弹幕（播放当前集中段时由 player.js 调用）：
    // 提前完成"搜索→匹配→拉取→写缓存/记忆"，换集时 tryMatchAndLoad 缓存命中秒回，
    // 消除换集后 5~20 秒的匹配空窗（换集弹幕"消失"的主因）。静默模式：失败无任何副作用
    const preloadedKeys = new Set(); // 本会话已预热过的集键（防重复预热）
    function preloadEpisode(ctx) {
        try {
            if (!ctx || !isEnabled()) return Promise.resolve([]);
            const key = normalizeTitle(ctx.title) + '#' + ctx.episodeIndex;
            if (preloadedKeys.has(key)) return Promise.resolve([]);
            preloadedKeys.add(key);
            // 传当前 matchToken：预热永不作废在途请求；反之正常请求到来时预热照跑（只写缓存无副作用）
            return tryMatchAndLoad(ctx, matchToken, false, true).then(r => r.list || []);
        } catch (e) {
            return Promise.resolve([]);
        }
    }

    window.Danmu = {
        getForPlayer,
        setDurationProvider,
        isEnabled,
        resolveEndpoint,
        getActiveSourceLabel,
        getSourceList,
        getActiveSourceBase,
        selectSource,
        switchSource,
        preloadEpisode,
        searchAnime,
        getBangumi,
        manualSelect,
        getLastDanmuku,
        getCurrentEpisodeId
    };
})();
