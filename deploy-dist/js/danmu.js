// ============================================================
// 弹幕数据模块（弹弹play v2 规范客户端 + 匹配引擎 + 缓存）
// ------------------------------------------------------------
// 职责（只负责"取数据"，渲染由 artplayer-plugin-danmuku 插件完成）：
//   1. 端点解析：自定义端点 → 同源转发层 /danmu/ 探测（弹弹play官方 API，首选）→ 内置自建源 → 旧公共代理（均不可用则静默禁用）
//   2. 弹弹play v2 客户端：search/episodes（自动匹配）、search/anime + bangumi（手动匹配）、
//      comment/{episodeId}（弹幕拉取）；搜索/剧集/弹幕请求统一 45s 慢超时（冷启动聚合实测 25s+），
//      其余请求 12s，任何失败返回空值、绝不向上抛错
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
    const SLOW_TIMEOUT = 45000;             // 搜索/剧集请求超时（毫秒）：自建源聚合全平台时单次搜索实测 30~40s
    const MAP_TTL = 30 * 24 * 60 * 60 * 1000; // 记忆映射有效期：30 天
    const MAP_MAX = 60;                     // 记忆映射最大条目数（超出按 ts 最旧淘汰）
    const CACHE_MAX = 15;                   // 弹幕缓存最大集数（超出按 ts 最旧淘汰）
    const CACHE_SIZE_LIMIT = 2.5 * 1024 * 1024; // 弹幕缓存写入体积上限（超出淘汰最旧一半再试）
    const DANMU_MAX = 8000;                 // 单集弹幕数量上限（超出均匀抽样）
    const MATCH_MIN_SCORE = 0.35;           // 自动匹配最低置信分
    const DURATION_TOLERANCE = 300;         // 时长校验允许偏差（秒）

    const LS_MAP_KEY = 'danmuEpisodeMap';   // 记忆映射：标题#集数 → episodeId
    const LS_CACHE_KEY = 'danmuCache';      // 弹幕缓存：episodeId → {list, ts}
    // 标题级弹幕缓存：标题#集数 → {list, sourceBase, ...}。episodeId 是各源本地 ID，
    // 实例回收后会失效；仅按 ID 缓存会让「之前看过的视频」每次都撞失效 ID + 冷构建，
    // 表现为弹幕迟迟不出。这里按剧名再存一份可直接渲染的列表，进入旧片秒开。
    const LS_TITLE_KEY = 'danmuTitleCache';
    const TITLE_MAX = 12;                   // 最多 12 集（与 danmuCache 同量级，受体积上限约束）
    const TITLE_TTL = 30 * 24 * 60 * 60 * 1000;
    const TITLE_VERSION = 1;                // 与 MEMO_VERSION 独立：新增结构不作废已有记忆/ID 缓存

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
    // 最近一次匹配信息（播放器弹幕浮层「弹幕信息」展示用）：与 lastDanmuku 同生命周期，
    // 记录匹配到的作品/剧集/来源/条数；初始化/未匹配时为 available:false
    let lastMatchInfo = null;

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

    const MEMO_VERSION = 3; // v3：模糊匹配降权修复后引入，作废 v2 期间可能写错的记忆

    function lookupMap(titleKey) {
        const entry = readLSJSON(LS_MAP_KEY)[titleKey];
        if (!entry || !entry.episodeId) return null;
        // 版本校验必须与 saveMap 写入的字段名一致（v: MEMO_VERSION）——此前误查 entry.v2，
        // 而写入的是 v，导致记忆映射永不命中：每次播放都全链路重搜（弹幕"经常不自动加载"主因）
        if (entry.v !== MEMO_VERSION) return null;
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
            v: MEMO_VERSION,
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
        // 同上：必须与 saveCache 写入的 v 字段对齐——误查 v2 导致弹幕缓存永不命中，
        // 预热/手动匹配写入的数据全部读不出（手动选集成功后 reload 仍整链重搜、屏幕空白）
        if (entry.v !== MEMO_VERSION) return null;
        return entry.list;
    }

    function saveCache(episodeId, list) {
        const cache = readLSJSON(LS_CACHE_KEY);
        cache[episodeId] = { v: MEMO_VERSION, list, ts: Date.now() };
        evictOldest(cache, CACHE_MAX);
        // 体积超限：整体淘汰最旧一半再试；仍失败则放弃本次缓存（try/catch 内静默）
        try {
            if (JSON.stringify(cache).length > CACHE_SIZE_LIMIT) {
                evictOldest(cache, Math.max(1, Math.floor(CACHE_MAX / 2)));
            }
            localStorage.setItem(LS_CACHE_KEY, JSON.stringify(cache));
        } catch (e) { /* 丢弃，不影响功能 */ }
    }

    // ---- 标题级缓存（旧片重进秒开）----
    function titleKeyOf(ctx) {
        return normalizeTitle((ctx && ctx.title) || '') + '#' + ((ctx && ctx.episodeIndex) || 0);
    }

    function readTitleCache(ctx) {
        if (!ctx || !ctx.title) return null;
        const entry = readLSJSON(LS_TITLE_KEY)[titleKeyOf(ctx)];
        if (!entry || entry.v !== TITLE_VERSION || !Array.isArray(entry.list) || !entry.list.length) return null;
        if (Date.now() - (entry.ts || 0) > TITLE_TTL) return null;
        return entry;
    }

    function saveTitleCache(ctx, matched, list) {
        try {
            if (!ctx || !ctx.title || !list || !list.length) return;
            const key = titleKeyOf(ctx);
            const cache = readLSJSON(LS_TITLE_KEY);
            cache[key] = {
                v: TITLE_VERSION,
                episodeId: (matched && matched.episodeId !== undefined) ? matched.episodeId : null,
                animeTitle: (matched && matched.animeTitle) || '',
                episodeTitle: (matched && matched.episodeTitle) || '',
                sourceBase: (activeEndpoint && activeEndpoint.base) || null,
                list: list,
                ts: Date.now()
            };
            evictOldest(cache, TITLE_MAX);
            if (JSON.stringify(cache).length > CACHE_SIZE_LIMIT) {
                evictOldest(cache, Math.max(1, Math.floor(TITLE_MAX / 2)));
            }
            try {
                localStorage.setItem(LS_TITLE_KEY, JSON.stringify(cache));
            } catch (e) {
                // 配额不足：本次新条目不写，旧条目仍保留
                const retry = readLSJSON(LS_TITLE_KEY);
                delete retry[key];
                localStorage.setItem(LS_TITLE_KEY, JSON.stringify(retry));
            }
        } catch (e) { /* 静默 */ }
    }

    // 切源时清掉标题缓存：旧列表来自被弃用的源，留着会挡住新源的重匹配
    function deleteTitleCache(ctx) {
        try {
            if (!ctx || !ctx.title) return;
            const cache = readLSJSON(LS_TITLE_KEY);
            const key = titleKeyOf(ctx);
            if (cache[key]) { delete cache[key]; writeLSJSON(LS_TITLE_KEY, cache); }
        } catch (e) { /* 静默 */ }
    }

    // ------------------------------------------------------------
    // 网络层：统一 12s 超时 + 全 try/catch，失败返回 null，绝不抛错
    // （proxyToken 为可选防滥用口令，经 X-Proxy-Token 头携带——部分公共代理以此限流）
    // timeoutMs：可选覆盖超时。搜索/剧集请求须传 SLOW_TIMEOUT（自建源聚合 20+ 平台，
    // 实测一次搜索 30~40s，默认 12s 会把正常搜索掐死在超时上，导致浏览器端永远轮换到劣质源）
    async function fetchJSON(url, proxyToken, timeoutMs) {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = setTimeout(() => { if (controller) controller.abort(); }, timeoutMs || FETCH_TIMEOUT);
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
    // 返回候选端点列表（按优先级）：设置面板自定义端点 → 同源转发层 /danmu/（弹弹play
    // 官方 API，探测可用才列入，首选数据源）→ 内置自建源 → 旧公共代理
    // 全部不可用返回 []（弹幕静默禁用）
    function resolveEndpoints() {
        const custom = getCustomApi();
        // 自定义端点未变化时直接复用缓存结果（探测请求也随之省掉）
        if (endpointListPromise && endpointUsedCustom === custom) return endpointListPromise;
        endpointUsedCustom = custom;
        endpointListPromise = (async () => {
            const list = [];
            // 1. 设置面板自定义端点（支持「地址|口令」格式；用户显式选择，永远最高优先）
            const customEp = parseEndpoint(custom);
            if (customEp) list.push(customEp);
            // 2. 同源转发层探测：Cloudflare Pages Function 配置 DANMU_APP_ID/DANMU_APP_SECRET
            //    （official 模式）时返回 {configured:true, mode:'official'} → 弹弹play官方 API，
            //    经 CF 边缘缓存回源 api.dandanplay.net（搜索 30min / 弹幕 6h）
            const probe = await fetchJSON('/danmu/');
            if (probe && probe.configured === true) list.push({ base: '/danmu', token: null, mode: probe.mode || 'custom' });
            // 3. 内置自建源（CF Workers 自定义域，国内直连，无跨国风控）：官方源之后的备用源
            const cfEp = parseEndpoint(DEFAULT_DANMU_API);
            if (cfEp) list.push(cfEp);
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

    // 搜索结果里的 source 是采集端的代码（tencent/iqiyi/youku/migu…），标题尾巴
    // 「from xxx」同样只有缩写。统一还原为平台全名，供手动匹配列表展示。
    const SOURCE_NAMES = {
        'tencent': '腾讯视频', 'qqlive': '腾讯视频', 'tx': '腾讯视频',
        'iqiyi': '爱奇艺', 'qiyi': '爱奇艺',
        'youku': '优酷', 'mgtv': '芒果TV', 'mango': '芒果TV', 'hunantv': '芒果TV',
        'bilibili': 'bilibili', 'bili': 'bilibili', 'b站': 'bilibili',
        'migu': '咪咕视频', 'imgo': '咪咕视频',
        '360': '360视频', 'sohu': '搜狐视频', 'le': '乐视视频', 'pptv': 'PP视频',
        'renren': '人人视频', 'acfun': 'AcFun', 'kukui': '酷铠',
        'xigua': '西瓜视频', 'douyin': '抖音', 'm1905': '1905电影网', '1905': '1905电影网'
    };

    function sourceDisplayName(code, title) {
        let c = String(code || '').trim();
        if (!c && title) {
            const m = String(title).match(/\bfrom\s+([^\s)）]+)/i);
            if (m) c = m[1];
        }
        if (!c) return '未知来源';
        return SOURCE_NAMES[c.toLowerCase()] || c;
    }

    // 采集端标题尾巴（【日番】from tencent）只用于匹配打分，展示时必须剥掉。
    function cleanAnimeTitle(title) {
        return String(title || '')
            .replace(/\s*【[^】]*】\s*/g, ' ')
            .replace(/\s*from\s+\S+\s*$/i, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // 信息区「源」行要让人一眼认出平台，代码/来源尾巴还原为全名；
    // 没有来源信息时返回空串，交由调用方回退到端点标签（自建源/公共代理）。
    function platformLabelOf(matched) {
        const code = (matched && matched.source) || '';
        const title = (matched && matched.animeTitle) || '';
        if (!code && !/\bfrom\s+/i.test(title)) return '';
        const label = sourceDisplayName(code, title);
        return label === '未知来源' ? '' : label;
    }

    // 记录匹配成功信息（only 非静默路径调用：后台预热不污染展示状态）
    function markMatched(matched, ctx, list) {
        const platform = platformLabelOf(matched);
        const endpoint = getActiveSourceLabel();
        lastMatchInfo = {
            available: true,
            animeTitle: cleanAnimeTitle(matched && matched.animeTitle),
            episodeTitle: (matched && matched.episodeTitle) || '',
            episodeId: (matched && matched.episodeId !== undefined) ? matched.episodeId : null,
            sourceLabel: platform ? platform + ' · ' + endpoint : endpoint,
            platformLabel: platform,
            endpointLabel: endpoint,
            count: list ? list.length : 0,
            title: (ctx && ctx.title) || '',
            episodeIndex: (ctx && ctx.episodeIndex) || 0
        };
    }

    // 记录匹配失败信息（所有最终失败分支调用）
    function markUnavailable(ctx) {
        lastMatchInfo = {
            available: false,
            animeTitle: '',
            episodeTitle: '',
            episodeId: null,
            sourceLabel: getActiveSourceLabel(),
            count: 0,
            title: (ctx && ctx.title) || '',
            episodeIndex: (ctx && ctx.episodeIndex) || 0
        };
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
                deleteTitleCache(lastCtx); // 标题级列表也必须清，否则切源后仍读旧源数据
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
    // restrictBase：限定只在指定源上请求（不轮换不降级）。弹幕拉取必须带上——
    // LogVar 类源的集 ID 是实例本地 ID，同一数字在不同源上指向完全不同的剧集，
    // 自建源的集 404 后拿同号去别的源取，取回的是别的剧的弹幕（实测踩坑）
    async function apiGet(pathAndQuery, timeoutMs, restrictBase) {
        const eps = await resolveEndpoints();
        if (!eps.length) return null;
        let list = eps;
        if (pinnedBase) {
            const pinned = eps.find(e => e.base === pinnedBase);
            if (pinned) list = [pinned];
            else pinnedBase = null;
        }
        if (restrictBase) {
            const fixed = list.find(e => e.base === restrictBase);
            if (!fixed) return null; // 指定源已不在候选列表：直接失败，交给上层整链重搜
            list = [fixed];
        }
        if (!list.length) return null;
        let start = activeEndpoint ? list.indexOf(activeEndpoint) : 0;
        if (start < 0) start = 0;
        for (let i = 0; i < list.length; i++) {
            const ep = list[(start + i) % list.length];
            const data = await fetchJSON(ep.base + pathAndQuery, ep.token, timeoutMs);
            if (data && data.success !== false) { activeEndpoint = ep; return data; }
        }
        return null;
    }

    // ------------------------------------------------------------
    // 弹弹play v2 规范接口（经 apiGet 自动多源故障转移）
    // ------------------------------------------------------------
    // 一步式检索（animes[].episodes[] 直接带剧集列表）——2025-01 起规范参数名为 anime
    // （keyword= 会报"参数不符合规则"），自动匹配的主链路用它规避两步式在 CF
    // serverless 上的实例缓存失效问题
    async function searchEpisodes(keyword) {
        if (!keyword) return null;
        const data = await apiGet(`/api/v2/search/episodes?anime=${encodeURIComponent(keyword)}`, SLOW_TIMEOUT);
        return (data && Array.isArray(data.animes)) ? data.animes : null;
    }

    // 手动匹配/自动匹配第一级：番剧/剧集列表（不含剧集详情）
    async function searchAnime(keyword) {
        try {
            if (!keyword) return [];
            const data = await apiGet(`/api/v2/search/anime?keyword=${encodeURIComponent(keyword)}`, SLOW_TIMEOUT);
            return (data && Array.isArray(data.animes)) ? data.animes : [];
        } catch (e) {
            return [];
        }
    }

    // 手动匹配/自动匹配第二级：单部作品的剧集列表
    async function getBangumi(animeId) {
        try {
            if (animeId === undefined || animeId === null) return null;
            const data = await apiGet(`/api/v2/bangumi/${encodeURIComponent(animeId)}`, SLOW_TIMEOUT);
            return (data && data.bangumi) ? data.bangumi : null;
        } catch (e) {
            return null;
        }
    }

    // 拉取某集原始弹幕，失败返回 null。restrictBase=匹配发生的数据源——弹幕请求
    // 绝不跨源轮换（集 ID 是各源本地 ID，跨源取同号 = 取到别的剧的弹幕）
    // 必须传 SLOW_TIMEOUT：danmu_api 冷启动时首请求同步聚合构建弹幕库（实测 25s+），
    // 默认 12s 会把每次尝试掐死在构建中途，退避重试同样超时，冷集弹幕永远拉不到
    async function getComments(episodeId, restrictBase) {
        const data = await apiGet(`/api/v2/comment/${episodeId}?format=json&withRelated=true`, SLOW_TIMEOUT, restrictBase);
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
    // 自动匹配：记忆映射 → 两步式主链路（search/anime + 紧邻 bangumi）→
    // 一步式兜底（search/episodes）→ 集数对齐
    // 返回 {episodeId, animeTitle, episodeTitle} 或 null
    // ------------------------------------------------------------
    // 匹配用标题清洗：LogVar 类源的作品名带「【电视剧】from youku」等来源尾巴，
    // 参与相似度打分会稀释区分度（"东宫" vs "嫁东宫(2024)【电视剧】from 360" 同为满分）。
    // 去掉【】段与 from 尾巴、年份后再比，"东宫(2019)from youku" 与 "东宫2019" 归一为等价
    function cleanTitleForCompare(t) {
        return normalizeTitle(String(t || '')
            .replace(/【[^】]*】/g, ' ')
            .replace(/\bfrom\s+\S+\s*$/i, ' '))
            .replace(/\s*[（(]\d{4}[）)]\s*$/, '')
            .replace(/\s+(?:19|20)\d{2}$/, '');
    }

    // 标题尾部噪声：季数/分部/年份/语言画质标签。自动匹配按候选逐个尝试时，
    // 剥掉这些尾巴可救回「剧名小变动」的资源（如 "某剧 第二季 1080P" 搜不到，
    // "某剧" 能搜到）；连续循环剥离以处理 "第二季 国语 4K" 这类多重尾巴
    const TITLE_TAIL_NOISE_RE = /\s*(?:第\s*[一二三四五六七八九十百\d]+\s*[季部期]|season\s*\d+|part\s*\d+|上部|下部|上篇|下篇|[（(]\s*(?:19|20)\d{2}\s*[)）]|(?:19|20)\d{2}|国语|粤语|中文|中字|日语|原声|双语|高清|超清|蓝光|原盘|4k|8k|2160p|1080p|720p|hdr)\s*$/i;

    function stripTitleTail(t) {
        let s = String(t || '').trim();
        let prev;
        do {
            prev = s;
            s = s.replace(TITLE_TAIL_NOISE_RE, '').trim();
        } while (s && s !== prev);
        return s;
    }

    // 自动匹配标题候选（去重保序、过滤空串）：候选越多请求越多，因此只保留
    // 有区分度的几种变形，调用方按序逐个尝试、第一个有结果即停
    function buildTitleCandidates(rawTitle) {
        const seen = Object.create(null);
        const out = [];
        const add = function (v) {
            const s = String(v || '').trim();
            if (!s || seen[s]) return;
            seen[s] = true;
            out.push(s);
        };
        add(normalizeTitle(rawTitle));                  // 1. 现有规范化
        const cleaned = cleanTitleForCompare(rawTitle); // 2. 清洗来源尾巴/年份
        add(cleaned);
        add(stripTitleTail(cleaned));                   // 3. 再剥季数/分部/年份/画质等尾部标签
        // 4. 去掉成对括号内容后的基础名，再走规范化
        add(normalizeTitle(String(rawTitle || '')
            .replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）/g, ' ')));
        return out;
    }

    // 从候选作品列表中打分选最佳：bigram 相似度为主 + 类型小加成 + 标题等价大加分
    // + 非包含关系降权，返回按分数降序的候选数组（调用方依次尝试）
    function pickBestAnime(animes, ctxTitle) {
        const nUser = normalizeTitle(ctxTitle);
        const cUser = cleanTitleForCompare(ctxTitle);
        const scored = [];
        for (const anime of animes) {
            const raw = (anime && anime.animeTitle) || '';
            const nAnime = normalizeTitle(raw);
            let score = bigramSim(nUser, nAnime);
            // 标题等价大加分：清洗后完全一致（含年份差异，如 "东宫2019" vs "东宫(2019)"）
            // 视为同片，远高于仅包含关系的候选（嫁东宫/东宫皇子们）
            if (cUser && cleanTitleForCompare(raw) === cUser) score = Math.max(score, 0.9) + 0.2;
            // 非包含关系降权：仅靠年份等零碎 bigram 撞上的候选（如"东宫2019"撞上
            // "双层公寓：东京2019-2020"得 0.6）与用户标题毫无包含关系，减半后落入淘汰区；
            // 真命中（标题互相包含或等价）不受影响
            const cAnime = cleanTitleForCompare(raw);
            if (cUser && cAnime && cAnime.indexOf(cUser) < 0 && cUser.indexOf(cAnime) < 0) {
                score *= 0.5;
            }
            // 类型小加成：无强偏好，片名匹配度已接近时最多 +0.05
            if (score >= 0.5 && /电视剧|动漫|番剧/.test((anime && anime.typeDescription) || '')) {
                score += 0.05;
            }
            if (score < MATCH_MIN_SCORE) continue; // 低置信直接过滤
            scored.push({ anime, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored;
    }

    // 集数对齐选集：优先按集号，集号不可解析且总集数一致时按下标
    function alignEpisode(episodes, ctx) {
        if (!Array.isArray(episodes) || !episodes.length) return null;
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
            if (!anyParsed && ctx.totalEpisodes > 0 && episodes.length === ctx.totalEpisodes) {
                picked = episodes[ctx.episodeIndex] || null;
            } else if (episodes.length === 1 && ctx.episodeIndex === 0) {
                picked = episodes[0]; // 单集资源且当前就是第 1 集 → 直接选
            }
        }
        return picked;
    }

    function buildMatched(anime, picked) {
        if (!picked || picked.episodeId === undefined || picked.episodeId === null) return null;
        return {
            episodeId: picked.episodeId,
            animeTitle: (anime && anime.animeTitle) || '',
            episodeTitle: picked.episodeTitle || '',
            source: (anime && anime.source) || ''
        };
    }

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

        // 2. 两步式主链路：search/anime 选作品 → 紧邻调用 bangumi 拉剧集（回连同一实例，
        //    集 ID 才有效——LogVar 类源的 ID 是实例内存缓存，隔开就 404）。
        //    注意不能用一步式 search/episodes 当主链路：实测其返回的集 ID 与 comment
        //    接口不同空间（当轮即 404），只能当兜底。
        //    依次尝试前 3 个候选：第一名 bangumi 偶发 404（实例路由）或无剧集时，
        //    换下一名补救，而不是整轮失败。
        //    关键词按标题候选逐个尝试（第一个有结果即停）：剧名季数/分部/年份等小变动
        //    会让原样搜索返回空，剥掉尾巴的候选往往能命中；串行避免并发请求放大流量
        const titleCandidates = buildTitleCandidates(ctx.title);
        let animes = [];
        for (const kw of titleCandidates) {
            animes = await searchAnime(kw);
            if (animes && animes.length) break;
        }
        let matched = null;
        if (animes && animes.length) {
            const ranked = pickBestAnime(animes, ctx.title);
            for (const cand of ranked.slice(0, 3)) {
                const bangumi = await getBangumi(cand.anime && cand.anime.animeId);
                const episodes = (bangumi && Array.isArray(bangumi.episodes)) ? bangumi.episodes : [];
                matched = episodes.length ? buildMatched(cand.anime, alignEpisode(episodes, ctx)) : null;
                if (matched) break;
            }
        }

        // 3. 一步式兜底：两步式无结果时的备用路径（部分端点仅支持该形态），同样按候选逐个尝试
        if (!matched) {
            let oneShot = null;
            for (const kw of titleCandidates) {
                oneShot = await searchEpisodes(kw);
                if (oneShot && oneShot.length) break;
            }
            if (oneShot && oneShot.length) {
                const ranked = pickBestAnime(oneShot, ctx.title);
                for (const cand of ranked.slice(0, 3)) {
                    matched = buildMatched(cand.anime, alignEpisode(cand.anime && cand.anime.episodes, ctx));
                    if (matched) break;
                }
            }
        }
        if (!matched) return null;

        // 4. 时长校验（尽力而为）：弹幕侧规范不返回单集时长，校验恒跳过；
        //    保留钩子——未来数据源提供时长时，两侧时长差 > 300s 即降级为手动建议（不自动采用）
        const localDuration = durationProvider ? durationProvider(ctx.episodeUrl) : null;
        const danmuDuration = null; // 弹幕侧时长（当前规范未提供）
        if (localDuration && danmuDuration && Math.abs(localDuration - danmuDuration) > DURATION_TOLERANCE) {
            return null;
        }

        return matched;
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
    // 删除某标题的记忆映射（记忆指向的集 ID 失效时调用——LogVar 类自建源的集 ID
    // 是服务端内存缓存性质的，缓存过期/实例回收后 ID 即失效，留着只会每次撞死在旧记忆上）
    function deleteMemo(ctx) {
        try {
            if (!ctx || !ctx.title) return;
            const map = readLSJSON(LS_MAP_KEY);
            const key = normalizeTitle(ctx.title) + '#' + ctx.episodeIndex;
            if (map[key]) { delete map[key]; writeLSJSON(LS_MAP_KEY, map); }
        } catch (e) { /* 静默 */ }
    }

    // 单轮尝试：匹配 → 拉取弹幕；skipMemo=true 时跳过记忆映射（换源重匹配场景）；
    // silent=true 为后台预热模式：不派发事件、不改 lastDanmuku/currentEpisodeId、失败不轮换源
    // 返回 {list, matched, fromMemo}，list 非空即成功；fromMemo 标记本次匹配来自记忆映射，
    // 供调用方在失败时判定"记忆已失效"并清除
    async function tryMatchAndLoad(ctx, token, skipMemo, silent) {
        const matched = await autoMatch(ctx, skipMemo);
        if (token !== matchToken && !silent) return { list: [], matched: null, fromMemo: false };
        if (!matched || !matched.episodeId) return { list: [], matched: null, fromMemo: false };
        if (!silent) currentEpisodeId = matched.episodeId;

        // 弹幕必须从「产生匹配的那个源」拉取：集 ID 是各源本地 ID，跨源取同号会拿到
        // 别的剧的弹幕（LogVar 类源实测踩坑）。autoMatch 内部最后一次成功的 apiGet
        // 已把 activeEndpoint 停在匹配源上，此处定格为本次弹幕请求的唯一目标
        const matchBase = (activeEndpoint && activeEndpoint.base) || null;

        // 缓存命中：零网络请求直接返回
        const cached = readCache(matched.episodeId);
        if (cached && cached.length) {
            if (!silent) {
                lastDanmuku = cached;
                markMatched(matched, ctx, cached);
                dispatchLoaded({ count: cached.length, animeTitle: matched.animeTitle, episodeTitle: matched.episodeTitle });
            }
            saveTitleCache(ctx, matched, cached); // 老记忆仍有效时补写标题级缓存
            return { list: cached, matched, fromMemo: false };
        }

        // withRelated=true 必带：官方 comment 接口缺省只返回主弹幕库（近乎为空），
        // 弹幕主体在关联库（bilibili/腾讯视频等），实测芙莉莲第1话 131 → 7310 条
        const raw = await getComments(matched.episodeId, matchBase);
        if (token !== matchToken && !silent) return { list: [], matched: null, fromMemo: false };
        let list = raw ? sampleToMax(convertComments(raw)) : [];
        // danmu_api 冷启动特性：平台弹幕数据在后台异步构建，首次请求 404 后构建可持续
        // 30~120s（实测东宫第1集：12s/16s/29s 三连 404，约 2 分钟后 5000 条）。退避重试
        // 拉长到 4s/12s/25s/40s（窗口约 90s+请求耗时），覆盖慢构建；间隔拉大同时缓解
        // 密集重试触发的 429 限流（实测 4s/12s 重试风暴第 2 轮即 429 三连）。
        // 仍无弹幕才判定该源该集无数据（预热模式只保留 4s/12s 轻重试，避免后台任务长时间占用）
        const retryDelays = silent ? [4000, 12000] : [4000, 12000, 25000, 40000];
        for (const delay of retryDelays) {
            if (list.length || (token !== matchToken && !silent)) break;
            await new Promise(res => setTimeout(res, delay));
            if (token !== matchToken && !silent) return { list: [], matched: null, fromMemo: false };
            const raw2 = await getComments(matched.episodeId, matchBase);
            if (token !== matchToken && !silent) return { list: [], matched: null, fromMemo: false };
            list = raw2 ? sampleToMax(convertComments(raw2)) : [];
        }
        if (!list.length) return { list: [], matched, fromMemo: !skipMemo }; // 重试后仍无弹幕（调用方决定是否换源重匹配；来自记忆的失败需清记忆）

        if (!silent) {
            lastDanmuku = list;
            markMatched(matched, ctx, list);
        }
        saveCache(matched.episodeId, list);
        saveMap(normalizeTitle(ctx.title) + '#' + ctx.episodeIndex, matched);
        if (!silent) saveTitleCache(ctx, matched, list);
        if (!silent) dispatchLoaded({ count: list.length, animeTitle: matched.animeTitle, episodeTitle: matched.episodeTitle });
        return { list, matched, fromMemo: false };
    }

    // 供 artplayer-plugin-danmuku 异步数据源调用：任何失败都 resolve([])，绝不 reject。
    // 多源策略：第 1 轮常规匹配（含记忆映射）；失败后从活跃源的下一个起轮换，逐个源做
    // 整链重匹配（跨源 episodeId 互不兼容，必须重搜而非仅换弹幕接口），直到试完全部候选——
    // 只轮换一个源不够：记忆失效恢复时常恰好落在无该数据的源（如官方源无电视剧）上，
    // 继续轮到自建源才能救回来
    // 同集在途链复用：播放器初始化期间 baseEpisodeUrl/画质竞速会多次触发插件数据源
    // 重执行，每次 getForPlayer 若都 ++matchToken 重启，会把进行中的 35~70s 恢复链取消掉，
    // 表现为"弹幕经常出不来"。改为：同一 title#ep 的重复调用直接复用在途 Promise；
    // 只有 key 变化（真正换集）才作废旧链开新一轮
    let inflightKey = null;
    let inflightPromise = null;
    let inflightGeneration = 0;

    // 手动匹配成功后调用：在途的自动匹配链已被 matchToken 作废，但它的 Promise
    // 仍挂在 inflightPromise 上。若不摘掉，紧接着 plugin.load() 触发的同集请求会
    // 复用这条「注定返回空」的链，画面空白且必须刷新页面才恢复。
    function invalidateInflight() {
        inflightGeneration++;
        inflightKey = null;
        inflightPromise = null;
    }

    async function getForPlayer(ctx) {
        const key = ctx ? (normalizeTitle(ctx.title || '') + '#' + (ctx.episodeIndex || 0)) : '';
        if (inflightPromise && inflightKey === key) return inflightPromise;
        const token = ++matchToken;
        const generation = ++inflightGeneration;
        inflightKey = key;
        const pending = getForPlayerInner(ctx, token).finally(() => {
            // 只清理自己那一条链：invalidateInflight 之后的新链不能被旧链收尾抹掉
            if (inflightGeneration === generation) { inflightKey = null; inflightPromise = null; }
        });
        inflightPromise = pending;
        return pending;
    }

    async function getForPlayerInner(ctx, token) {
        try {
            // 总开关关闭：只返回空数据，不发任何事件（按钮本就不该出现）
            if (!ctx || !isEnabled()) return [];
            lastCtx = ctx;

            // 第 0 轮：标题级本地缓存（之前播放过的视频）。记忆映射只存 episodeId，
            // 自建源的 ID 是实例本地的，过期后要 90s 重试 + 全链重搜；这里直接拿
            // 上次成功渲染过的列表先出画面，且完全不依赖网络。
            const local = readTitleCache(ctx);
            if (local && (!pinnedBase || local.sourceBase === pinnedBase)) {
                const restored = local.sourceBase ? await restoreEndpointByBase(local.sourceBase) : true;
                if (restored) {
                    currentEpisodeId = local.episodeId || null;
                    lastDanmuku = local.list;
                    markMatched({
                        episodeId: local.episodeId,
                        animeTitle: local.animeTitle,
                        episodeTitle: local.episodeTitle
                    }, ctx, local.list);
                    dispatchLoaded({ count: local.list.length, animeTitle: local.animeTitle, episodeTitle: local.episodeTitle });
                    return local.list;
                }
            }

            // 第 1 轮：常规匹配（可能命中记忆映射）
            let r = await tryMatchAndLoad(ctx, token, false);
            if (token !== matchToken) return [];
            if (r.list.length) return r.list;
            // 记忆指向的集已失效：删除该条记忆，避免此后每次播放都先撞死在旧记忆上
            if (r.fromMemo) deleteMemo(ctx);

            // 第 2 轮起：轮换候选源逐个整链重匹配（跳过指向失败源的记忆映射）。
            // 手动选择的源失败时解除锁定再轮换兜底："有弹幕"优先级最高——所选源对该集
            // 无数据（公共代理抓不到/自定义源未配好）时若锁死不轮换，切源即成永久空屏；
            // 解除后自动故障转移生效，下拉框回显将跟随实际生效源（refreshDanmuPanel 同步）
            const eps = await resolveEndpoints();
            if (pinnedBase && !eps.some(e => e.base === pinnedBase)) pinnedBase = null;
            pinnedBase = null; // 锁定源已失败，交还自动多源转移
            for (let k = 0; k < eps.length; k++) {
                if (eps.length > 1) await rotateEndpoint();
                r = await tryMatchAndLoad(ctx, token, true);
                if (token !== matchToken) return [];
                if (r.list.length) return r.list;
            }

            currentEpisodeId = null;
            lastDanmuku = [];
            markUnavailable(ctx);
            dispatchUnavailable(); // 所有候选源均失败：确定无弹幕可用
            return [];
        } catch (e) {
            // 任何异常都静默降级，绝不影响播放
            if (token === matchToken) {
                currentEpisodeId = null;
                lastDanmuku = [];
                markUnavailable(ctx);
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
        invalidateInflight();      // 同时摘掉旧链：否则随后的 plugin.load() 会复用空结果
        try {
            if (!sel || sel.episodeId === undefined || sel.episodeId === null) return [];
            if (!isEnabled()) return [];
            // 手动选择同样锁源：剧集列表来自哪个源，弹幕就只能从那个源取（集 ID 本地性）
            const selBase = (activeEndpoint && activeEndpoint.base) || null;
            let raw = await getComments(sel.episodeId, selBase);
            // 与自动链路对齐的冷构建退避窗口（4s/12s/25s/40s，约 90s+）
            const retryDelays = [4000, 12000, 25000, 40000];
            for (const delay of retryDelays) {
                // getComments 返回弹幕数组本体（非响应对象），查 raw.comments 永假——
                // 误写会导致成功也白跑 3 次拉取 + 16s 退避，冷集 2 分多钟不出结果形同失败
                if (raw && raw.length) break;
                if (token !== matchToken) return [];
                await new Promise(res => setTimeout(res, delay));
                if (token !== matchToken) return [];
                raw = await getComments(sel.episodeId, selBase);
            }
            if (!raw) return [];
            const list = sampleToMax(convertComments(raw));
            if (!list.length) return [];

            currentEpisodeId = sel.episodeId;
            lastDanmuku = list;
            markMatched({
                episodeId: sel.episodeId,
                animeTitle: sel.animeTitle || '',
                episodeTitle: sel.episodeTitle || '',
                source: sel.source || ''
            }, lastCtx, list);
            saveCache(sel.episodeId, list);
            if (lastCtx && lastCtx.title) {
                const matched = {
                    episodeId: sel.episodeId,
                    animeTitle: sel.animeTitle || '',
                    episodeTitle: sel.episodeTitle || ''
                };
                saveMap(normalizeTitle(lastCtx.title) + '#' + lastCtx.episodeIndex, matched);
                saveTitleCache(lastCtx, matched, list);
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

    // 最近一次匹配信息（播放器浮层展示）：返回副本，调用方修改不影响内部状态
    function getMatchInfo() {
        return lastMatchInfo ? Object.assign({}, lastMatchInfo) : {
            available: false,
            animeTitle: '',
            episodeTitle: '',
            episodeId: null,
            sourceLabel: getActiveSourceLabel(),
            count: 0,
            title: (lastCtx && lastCtx.title) || '',
            episodeIndex: (lastCtx && lastCtx.episodeIndex) || 0
        };
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
        getCurrentEpisodeId,
        getMatchInfo,
        sourceDisplayName,
        cleanAnimeTitle
    };
})();
