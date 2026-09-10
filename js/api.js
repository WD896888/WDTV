// ===== 统一请求出口：直连优先，失败回退本地代理（搜索与详情共用） =====
// 资源站 MacCMS 接口普遍支持 CORS，直连速度最快；
// 全部请求挤过本地 /proxy/ 代理会多一跳且受服务端超时/重试影响，是搜索变慢的主因。
// 连接策略单点维护：后续调整超时、并发、重试只需改这里。

const DIRECT_TIMEOUT_DEFAULT = 2500;  // 直连尝试预算（不可达主机快速失败后立即回退代理）
const TOTAL_BUDGET_DEFAULT = 12000;   // 单请求总预算（含代理回退）

// 源健康度记录（localStorage，10 分钟 TTL）：
//   ok     —— 该源最近一次请求成败（近期失败过的源在聚合搜索时延后发起）
//   direct —— 该源最近一次直连成败（近期直连失败过的源跳过直连直接走代理，省去每次白等）
const SOURCE_HEALTH_KEY = 'wdtvSourceHealth';
const SOURCE_HEALTH_TTL = 10 * 60 * 1000;

function readSourceHealth() {
    try {
        return JSON.parse(localStorage.getItem(SOURCE_HEALTH_KEY) || '{}') || {};
    } catch (e) {
        return {};
    }
}

function updateSourceHealth(apiId, patch) {
    try {
        const health = readSourceHealth();
        health[apiId] = Object.assign({}, health[apiId], patch);
        localStorage.setItem(SOURCE_HEALTH_KEY, JSON.stringify(health));
    } catch (e) { /* 存储失败不影响请求 */ }
}

// 记录源整体请求成败
function markSourceHealth(apiId, ok) {
    updateSourceHealth(apiId, { ok: ok ? 1 : 0, ts: Date.now() });
}

// 记录源直连成败（独立于整体成败维度）
function markDirectHealth(apiId, directOk) {
    updateSourceHealth(apiId, { direct: directOk ? 1 : 0, dts: Date.now() });
}

// 该源近期（TTL 内）整体请求是否失败过
function isSourceUnhealthy(apiId) {
    const entry = readSourceHealth()[apiId];
    return !!(entry && entry.ok === 0 && Date.now() - entry.ts < SOURCE_HEALTH_TTL);
}

// 该源近期（TTL 内）直连是否失败过：是则跳过直连直接走代理
function hasRecentDirectFailure(apiId) {
    const entry = readSourceHealth()[apiId];
    return !!(entry && entry.direct === 0 && entry.dts && Date.now() - entry.dts < SOURCE_HEALTH_TTL);
}

// 将外部 signal（如"新搜索 abort 旧请求"）联动到请求自身的超时 controller
function linkAbortSignal(externalSignal, controller) {
    if (!externalSignal) return;
    if (externalSignal.aborted) {
        controller.abort();
        return;
    }
    externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
}

// 统一"直连 → 代理回退"请求出口：
//   headers       请求头
//   directTimeout 直连预算（毫秒）
//   totalBudget   总预算（毫秒），代理回退使用剩余预算
//   apiId         源标识：提供时直连成败计入源健康度，且近期直连失败过的源自动跳过直连
//   signal        外部中止信号（新搜索发起时 abort 旧请求）
async function fetchWithFallback(url, { headers, directTimeout = DIRECT_TIMEOUT_DEFAULT, totalBudget = TOTAL_BUDGET_DEFAULT, apiId = null, signal = null } = {}) {
    const deadline = Date.now() + totalBudget;

    // 1) 直连尝试（近期直连失败过的源跳过，直接走代理）
    if (!(apiId && hasRecentDirectFailure(apiId))) {
        const directController = new AbortController();
        const directTimer = setTimeout(() => directController.abort(), directTimeout);
        linkAbortSignal(signal, directController);
        try {
            const direct = await fetch(url, { headers, signal: directController.signal });
            if (direct.ok) {
                if (apiId) markDirectHealth(apiId, true);
                return direct;
            }
            // 直连拿到非 2xx 响应：连通性正常，不计直连失败，继续尝试代理
        } catch (e) {
            if (e && e.name === 'AbortError' && signal && signal.aborted) throw e; // 外部主动中止，不再回退
            // 直连失败（CORS/网络错误/超时）：计入直连失败维度，回退本地代理
            if (apiId) markDirectHealth(apiId, false);
        } finally {
            clearTimeout(directTimer);
        }
    }

    // 2) 回退本地代理（使用剩余总预算）
    const proxiedUrl = PROXY_URL + encodeURIComponent(url);

    const remaining = Math.max(deadline - Date.now(), 3000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    linkAbortSignal(signal, controller);
    try {
        return await fetch(proxiedUrl, { headers, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ===== 源站集名工具（详情解析与首页/播放页渲染共用） =====

// HTML 转义：集名是第三方数据，渲染进 title 属性/文本节点前必须转义
function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 解析一个播放组的「集名$URL#集名$URL...」字符串，同时保留集名与地址（按 index 对齐）
// URL 起点 = 第一个「其后紧跟 http(s):// 的 $」：集名含 '$'（第1期$特辑$https://...）或
// URL 含 '$'（签名参数）都能取对；无 '$' 或 $ 后不是地址的片段与旧逻辑一致视为无效
function parsePlayGroup(src) {
    const names = [];
    const urls = [];
    src.split('#').forEach(ep => {
        let dollar = -1;
        let from = 0;
        for (;;) {
            const i = ep.indexOf('$', from);
            if (i < 0) break;
            if (/^\s*https?:\/\//.test(ep.slice(i + 1))) { dollar = i; break; }
            from = i + 1;
        }
        if (dollar < 0) return;
        const url = ep.slice(dollar + 1).trim();
        if (url) {
            urls.push(url);
            names.push(ep.slice(0, dollar).trim());
        }
    });
    return { names, urls };
}

// 集名结构化解析：8 位数字 → 日期；第N期/集 → 期数；上/中/下 → 分段；
// 回顾特辑/先导片/加更 等常见标签 → tags。仅做识别，绝不改写原始名字
function parseEpisodeNameMeta(raw) {
    const name = String(raw || '').trim();
    const meta = { raw: name, date: '', seq: '', seqNum: '', part: '', title: '', tags: [] };
    if (!name) return meta;

    // 工作串：边识别边移除，防止「回顾特辑」被再拆出「特辑」、日期被期数/标题残留干扰
    let work = name;

    // 标签：整词识别（长词组在前）
    const TAG_WORDS = ['回顾特辑', '先导片', '会员Plus', 'Plus版', '会员版', '加更', '纯享', '花絮', '预告', '特辑', '彩蛋', '直播'];
    TAG_WORDS.forEach(w => {
        if (work.includes(w)) {
            meta.tags.push(w);
            work = work.split(w).join(' ');
        }
    });

    // 期数：第N期/第N集/第N场（1-8 位数字，覆盖「第20251001期」这类日期式期号）
    let m = work.match(/第\s*(\d{1,8})\s*([期集场])/);
    if (m) {
        meta.seqNum = m[1];
        meta.seq = `第${m[1]}${m[2]}`;
        work = work.replace(m[0], ' ');
        // 期号本身是 8 位日期（第20251001期）时同步还原为标准日期
        const dm = meta.seqNum.match(/^(\d{4})(\d{2})(\d{2})$/);
        if (dm) {
            const mo = +dm[2], d = +dm[3];
            if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) meta.date = `${dm[1]}-${dm[2]}-${dm[3]}`;
        }
    }

    // 日期：8 位连续数字（常见 20251018），或带分隔符的 2025-10-18 / 2025.10.18 / 2025/10/18；
    // 前后不贴数字，避免 7 位残缺日期（2023102）被误读
    m = work.match(/(?:^|[^\d])(\d{4})[-/.年]?(\d{2})[-/.月]?(\d{2})(?:日|(?=[^\d])|$)/);
    if (m) {
        const mo = +m[2], d = +m[3];
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) meta.date = `${m[1]}-${m[2]}-${m[3]}`;
        work = work.replace(m[0], ' ');
    }

    // 分段：上/中/下（后面不再跟汉字才成立，避免误吃「上线」「下架」等词）
    m = work.match(/[上中下](?![一-鿿])/);
    if (m) {
        meta.part = m[0];
        work = work.replace(m[0], ' ');
    }

    // 剩余标题：剥掉日期串/期数/标签词后剩下的内容性文字（如「五哈团开篇惨遭百人追逐」）
    meta.title = work.replace(/^[:：\s\-—·、]+|[:：\s\-—·、]+$/g, '');
    return meta;
}

// 由结构化集名生成紧凑短标签（按钮第二行用）：日期 + 期数分段标签 + 标题/标签
function buildEpisodeShortLabel(meta) {
    if (!meta || !meta.raw) return '';
    const bits = [];
    if (meta.date) bits.push(meta.date.slice(5)); // 10-18（年份与详情标题重复，省略）
    let seqEmitted = false;
    // 期号本身是完整日期（第20251001期）时与 date 重复，只保留 date
    if (meta.seq && !(meta.date && /^\d{7,8}$/.test(meta.seqNum))) {
        bits.push(meta.seq + (meta.part || '') + meta.tags.join('')); // 第1期上 / 第1期加更
        seqEmitted = true;
    }
    const title = meta.title || '';
    if (title) {
        bits.push(title);
    } else if (meta.tags.length || (meta.part && !seqEmitted)) {
        bits.push(meta.tags.join('') + (meta.part && !seqEmitted ? meta.part : '')); // 先导片上 / 回顾特辑
    }
    return bits.length ? bits.join(' ') : meta.raw;
}

// 详情请求参数（直连/总预算与搜索略有差异）
const DETAIL_DIRECT_TIMEOUT = 2500;
const DETAIL_TOTAL_BUDGET = 15000;

// 详情请求：直连优先，失败后回退本地代理（与搜索共用统一请求出口与源健康度）
function fetchDetailData(url, apiId, signal) {
    return fetchWithFallback(url, {
        headers: API_CONFIG.detail.headers,
        directTimeout: DETAIL_DIRECT_TIMEOUT,
        totalBudget: DETAIL_TOTAL_BUDGET,
        apiId: apiId || null,
        signal: signal || null
    });
}

// 获取视频详情与集数列表（不依赖 Service Worker 的 /api/detail，任何环境均可直接调用）
// opts: { id, source }；返回 { code, episodes, videoInfo, ... }
// 详情获取方式由 config.js 各源的 detailMode 显式配置，不做运行时猜测：
//   'api'（默认）—— 仅标准接口；'html' —— 仅详情页解析；'auto' —— 接口优先、失败回退详情页
async function fetchVideoDetailData(opts) {
    try {
        const { id, source = 'heimuer' } = opts || {};

        if (!id) throw new Error('缺少视频ID参数');
        if (!/^[\w-]+$/.test(id)) throw new Error('无效的视频ID格式');

        if (!API_SITES[source]) {
            throw new Error('无效的API来源');
        }

        const detailMode = API_SITES[source].detailMode || 'api';
        const detailUrl = buildVodApiUrl(API_SITES[source].api, API_CONFIG.detail.path) + id;

        // 1) 标准接口详情（'api' / 'auto' 路径；直连优先，失败回退代理，直连成败计入源健康度）
        let apiResult = null;
        if (detailMode === 'api' || detailMode === 'auto') {
            try {
                const response = await fetchDetailData(detailUrl, source);
                if (response.ok) {
                    const data = await response.json();
                    if (data && data.list && Array.isArray(data.list) && data.list.length > 0) {
                        const videoDetail = data.list[0];

                        // 提取播放地址与集名（多播放源智能选择）
                        // 优先选含 .m3u8 直链的源（可直连/走代理播放）；
                        // 避免选到分享页链接源（如非凡影视的 feifan 源返回 HTML 页面，hls.js 无法播放）
                        // episodeNames 与 episodes 按 index 对齐（源站「集名$URL」的集名，旧逻辑被丢弃）
                        let episodes = [];
                        let episodeNames = [];
                        if (videoDetail.vod_play_url) {
                            const playSources = videoDetail.vod_play_url.split('$$$');
                            for (const src of playSources) {
                                const { names, urls } = parsePlayGroup(src);
                                if (urls.length === 0) continue;
                                if (urls.some(u => /\.m3u8([?#]|$)/i.test(u))) {
                                    episodes = urls; // 命中 m3u8 直链源，直接采用
                                    episodeNames = names;
                                    break;
                                }
                                if (episodes.length === 0) {
                                    episodes = urls; // 兜底：暂存第一个非空源（可能是 mp4 等其他可播格式）
                                    episodeNames = names;
                                }
                            }
                        }

                        // 如果没有找到播放地址，尝试从简介中提取 m3u8 链接
                        if (episodes.length === 0 && videoDetail.vod_content) {
                            const matches = videoDetail.vod_content.match(M3U8_PATTERN) || [];
                            episodes = matches.map(link => link.replace(/^\$/, ''));
                        }

                        apiResult = {
                            code: 200,
                            episodes: episodes,
                            episodeNames: episodeNames,
                            detailUrl: detailUrl,
                            videoInfo: {
                                title: videoDetail.vod_name,
                                cover: normalizeRuyiPicUrl(videoDetail.vod_pic),
                                desc: videoDetail.vod_content,
                                type: videoDetail.type_name,
                                year: videoDetail.vod_year,
                                area: videoDetail.vod_area,
                                director: videoDetail.vod_director,
                                actor: videoDetail.vod_actor,
                                remarks: videoDetail.vod_remarks,
                                source_name: API_SITES[source].name,
                                source_code: source
                            }
                        };

                        // 标准接口拿到集数，直接返回
                        if (episodes.length > 0) return apiResult;
                    }
                }
            } catch (e) {
                console.warn(`标准接口详情获取失败(${source}):`, e.message);
            }
        }

        // 2) 详情页 HTML 解析（'html' / 'auto' 路径；需源配置 detail 字段）
        if (detailMode === 'html' || detailMode === 'auto') {
            if (API_SITES[source].detail) {
                try {
                    const htmlResult = JSON.parse(await handleSpecialSourceDetail(id, source));
                    if (htmlResult && Array.isArray(htmlResult.episodes) && htmlResult.episodes.length > 0) {
                        return htmlResult;
                    }
                } catch (e) {
                    console.warn(`详情页解析失败(${source}):`, e.message);
                }
            } else {
                console.warn(`源 ${source} 配置为 ${detailMode} 但缺少 detail 字段，无法解析详情页`);
            }
        }

        // 3) 标准接口有视频信息但无集数：仍返回（弹窗展示信息）；两条路径都拿不到数据则报错
        if (apiResult) return apiResult;
        throw new Error('详情获取失败：未获取到可用集数');
    } catch (error) {
        console.error('获取视频详情失败:', error);
        return { code: 400, msg: error.message || '请求处理失败', episodes: [] };
    }
}

// 通用特殊源详情处理函数
async function handleSpecialSourceDetail(id, sourceCode) {
    try {
        // 构建详情页URL（使用配置中的detail URL而不是api URL）
        const detailUrl = `${API_SITES[sourceCode].detail}/index.php/vod/detail/id/${id}.html`;
        
        // 添加超时处理
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        const proxiedUrl = PROXY_URL + encodeURIComponent(detailUrl);
            
        // 获取详情页HTML
        const response = await fetch(proxiedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            },
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`详情页请求失败: ${response.status}`);
        }
        
        // 获取HTML内容
        const html = await response.text();
        
        // 根据不同源类型使用不同的正则表达式
        let matches = [];
        
        if (sourceCode === 'ffzy') {
            // 非凡影视使用特定的正则表达式
            const ffzyPattern = /\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g;
            matches = html.match(ffzyPattern) || [];
        }
        
        // 如果没有找到链接或者是其他源类型，尝试一个更通用的模式
        if (matches.length === 0) {
            const generalPattern = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
            matches = html.match(generalPattern) || [];
        }
        // 去重处理，避免一个播放源多集显示
        matches = [...new Set(matches)];
        // 处理链接
        matches = matches.map(link => {
            link = link.substring(1, link.length);
            const parenIndex = link.indexOf('(');
            return parenIndex > 0 ? link.substring(0, parenIndex) : link;
        });
        
        // 提取可能存在的标题、简介等基本信息
        const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
        const titleText = titleMatch ? titleMatch[1].trim() : '';
        
        const descMatch = html.match(/<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/);
        const descText = descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').trim() : '';
        
        return JSON.stringify({
            code: 200,
            episodes: matches,
            detailUrl: detailUrl,
            videoInfo: {
                title: titleText,
                desc: descText,
                source_name: API_SITES[sourceCode].name,
                source_code: sourceCode
            }
        });
    } catch (error) {
        console.error(`${API_SITES[sourceCode].name}详情获取失败:`, error);
        throw error;
    }
}

// ===== 各集时长检测共享工具（首页详情弹窗与播放页通用） =====

// 秒数格式化为 时:分:秒 或 分:秒
function formatEpisodeDuration(seconds) {
    const sec = Math.round(seconds);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

// m3u8 内相对地址转绝对地址
function resolveM3u8Url(base, relative) {
    try {
        return new URL(relative, base).href;
    } catch {
        return relative;
    }
}

// 时长检测的请求预算：视频 CDN 的 m3u8 是小文件一般秒回，直连预算略高于接口请求
const M3U8_DURATION_DIRECT_TIMEOUT = 4000;
const M3U8_DURATION_TOTAL_BUDGET = 14000;

// 通过解析 m3u8 播放列表累加分片时长得到总时长（主播放列表自动跳转一层取子列表）
// url 可能是绝对地址，也可能是代理重写后的同源路径（/proxy/...）：
// 代理透传多码率主列表时会把它内部的子列表地址重写为 /proxy/ 路径，
// 这种子列表地址必须原样直接请求，不能再包一层代理、也不能基于原 URL 做相对解析
// 拉取策略必须与播放路径对齐——播放器就是浏览器直连 CDN 的（视频 CDN 普遍开放 CORS），
// 因此绝对地址直连优先、失败（CORS/超时/混合内容拦截）再回退本地代理。
// 代理跑在海外 serverless 上时经常被视频 CDN 地域屏蔽/风控拒绝，
// 全部依赖代理会导致时长大面积检测失败而播放却一切正常。
// apiId 用 CDN 主机名：近期直连失败过的 CDN 自动跳过直连直接走代理，省去每集白等直连超时
async function fetchM3u8Duration(url, depth = 0) {
    try {
        let resp;
        if (url.startsWith(PROXY_URL)) {
            // 代理重写后的同源路径：直接请求（不可再次编码，也没有直连一说）
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);
            try {
                resp = await fetch(url, { signal: controller.signal });
            } finally {
                clearTimeout(timer);
            }
        } else {
            let apiId = null;
            try { apiId = 'm3u8:' + new URL(url).hostname; } catch (e) { /* 非法地址不记健康度 */ }
            resp = await fetchWithFallback(url, {
                directTimeout: M3U8_DURATION_DIRECT_TIMEOUT,
                totalBudget: M3U8_DURATION_TOTAL_BUDGET,
                apiId
            });
        }
        if (!resp || !resp.ok) return null;
        const text = await resp.text();
        if (!text.includes('#EXTM3U')) return null;

        // 主播放列表：取第一个子播放列表再解析
        if (text.includes('#EXT-X-STREAM-INF')) {
            if (depth >= 1) return null;
            const lines = text.split('\n');
            // 相对地址需基于原始真实地址解析：入参若是代理重写路径，先还原出真实地址
            let baseUrl = url;
            if (url.startsWith(PROXY_URL)) {
                try { baseUrl = decodeURIComponent(url.slice(PROXY_URL.length)); } catch (e) { /* 保持原样 */ }
            }
            for (let i = 0; i < lines.length; i++) {
                if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
                for (let j = i + 1; j < lines.length; j++) {
                    const line = lines[j].trim();
                    if (!line || line.startsWith('#')) continue;
                    // 子列表地址已被代理重写为 /proxy/ 同源路径时直接透传，否则按真实地址相对解析
                    const nextUrl = line.startsWith(PROXY_URL) ? line : resolveM3u8Url(baseUrl, line);
                    return await fetchM3u8Duration(nextUrl, depth + 1);
                }
            }
            return null;
        }

        // 媒体播放列表：累加所有 #EXTINF 分片时长
        let total = 0;
        let found = false;
        const re = /#EXTINF:([\d.]+)/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            total += parseFloat(m[1]);
            found = true;
        }
        return found ? total : null;
    } catch {
        return null;
    }
}

// 非 m3u8（如 mp4）地址：用隐藏 video 元素读取元数据时长
function fetchMediaDurationByVideo(url) {
    return new Promise(resolve => {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;
        let settled = false;
        const finish = val => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            video.removeAttribute('src');
            video.remove();
            resolve(val);
        };
        const timer = setTimeout(() => finish(null), 8000);
        video.addEventListener('loadedmetadata', () => finish(isFinite(video.duration) ? video.duration : null));
        video.addEventListener('error', () => finish(null));
        video.src = url;
    });
}


