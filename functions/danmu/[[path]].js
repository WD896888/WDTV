// functions/danmu/[[path]].js - Cloudflare Pages Function（可选的弹幕转发层，纯透传型）
// 职责：
//   1. 状态探测：GET /danmu/ 返回 {configured, mode}，供前端启动时决定弹幕端点回退策略
//   2. 弹弹play v2 规范透传：/danmu/<path>?<query> 原样转发到上游
//      （official 模式自动附加 X-AppId/X-Timestamp/X-Signature 签名头；custom 模式直连自部署 danmu_api），
//      并重建响应头（补 CORS 与 Cache-Control），供前端弹幕客户端直接复用
//   3. 边缘缓存（caches.default，Cache API，无配额限制）：同一 colo 的重复弹幕请求直接命中，
//      不回源、不消耗上游请求
//   4. 同源 Referer 校验：带 Referer 且 host 不一致即 403，防止本端点被当开放代理滥用
//
// 为何不解析 body（重要约束）：
//   Cloudflare Pages 免费计划每次 Function 调用仅 10ms CPU，弹幕 JSON 动辄上万条，
//   一旦读取/解析/改写上游响应 body 必然超时。因此本模块对 body 只做"流式搬运"
//   （new Response(upstream.body, ...)），解析、匹配、格式转换全部在前端 js/danmu.js 完成；
//   仅有的异步计算是 official 模式的 HMAC-SHA256 签名（只参与构造请求头，微秒级，与 body 无关）。
//
// 环境变量（wrangler.toml [vars] 或 Dashboard，均为可选）：
//   DANMU_BASE       数据源①：自部署 danmu_api（弹弹play 协议兼容）地址，如 https://xxx.workers.dev
//   DANMU_APP_ID     数据源②：弹弹play 官方 AppId（开源非商业用途）
//   DANMU_APP_SECRET 数据源②：弹弹play 官方 AppSecret（敏感，必须用
//                    npx wrangler pages secret put DANMU_APP_SECRET --project-name=wdtv 设置）
//   模式判定：official（AppId+Secret 齐备）优先；其次 custom（DANMU_BASE）；都未配置则整体不可用
//
// 边缘缓存 TTL 策略（秒，弹弹play 官方建议：普通剧 6~24 小时、当季热门 30 分钟）：
//   /search/episodes                     → 1800（30min，动态性最强，新番首播时段更新频繁）
//   /comment/、/search/anime、/bangumi/  → 21600（6h）
//   其它未识别路径                        → 21600（6h，兜底）
//
// 其它约定：仅允许 GET（其余 405）；OPTIONS 预检 204 + CORS 头；上游 30s 超时保护（AbortController）；
// 上游 5xx/网络错误 → 502 JSON {error:'upstream'}（前端识别后静默降级，绝不影响播放）

// --- 配置 (从 Cloudflare 环境变量读取，wrangler.toml [vars] 或 Dashboard 中设置) ---
// DANMU_BASE (例如 "https://your-danmu-api.example.workers.dev")
// DANMU_APP_ID / DANMU_APP_SECRET (弹弹play 官方模式，Secret 用 wrangler pages secret put 设置)
// DEBUG (例如 false 或 true)
// --- 配置结束 ---

// --- 常量 ---
const OFFICIAL_API_BASE = 'https://api.dandanplay.net';
const OFFICIAL_REFERER = 'https://www.dandanplay.com/';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UPSTREAM_TIMEOUT_MS = 30000; // 上游请求 30s 超时保护（与 proxy 一致）

// 边缘缓存 TTL（秒）
const CACHE_TTL_DEFAULT = 21600; // /comment/、/search/anime、/bangumi/ 及其它路径
const CACHE_TTL_EPISODES = 1800; // /search/episodes（快速匹配，动态性最强）

// 透传时必须剔除的响应头：这些头描述的是"上游 → CF"这段链路/会话的信息，
// 原样带给客户端会导致长度校验失败、解码错误或缓存策略错乱（与 proxy 的透传过滤思路一致）
const STRIP_RESPONSE_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie', 'vary'];
// --- 常量结束 ---

// 根据转发路径选择边缘缓存 TTL（秒）
function getCacheTtl(path) {
    if (path.includes('/search/episodes')) return CACHE_TTL_EPISODES;
    return CACHE_TTL_DEFAULT;
}

// 统一追加 CORS 头（已由同源 Referer 校验兜底防滥用，这里放开跨源便于前端任意端点切换）
function applyCorsHeaders(headers) {
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
}

// 统一的 JSON 响应（自动带 CORS 头）
function jsonResponse(data, status = 200, extraHeaders = {}) {
    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
    applyCorsHeaders(headers);
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
    return new Response(JSON.stringify(data), { status, headers });
}

// 计算弹弹play 官方 API 签名头：
//   X-Signature = Base64( HMAC-SHA256( key=DANMU_APP_SECRET, message=DANMU_APP_ID + Timestamp ) )
// 仅参与构造请求头（微秒级异步计算），不触碰任何响应 body
async function buildOfficialHeaders(env) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(env.DANMU_APP_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(env.DANMU_APP_ID + timestamp));
    // 签名恒为 32 字节，直接逐字节映射为 binary string 再 Base64
    const base64 = btoa(String.fromCharCode.apply(null, new Uint8Array(signature)));
    return {
        'X-AppId': env.DANMU_APP_ID,
        'X-Timestamp': timestamp,
        'X-Signature': base64,
        'User-Agent': CHROME_UA,
        'Referer': OFFICIAL_REFERER
    };
}

/**
 * 主要的 Pages Function 处理函数
 * 拦截发往 /danmu/* 的请求（[[path]] 可选捕获，/danmu/ 时为空）
 */
export async function onRequest(context) {
    const { request, env, waitUntil } = context;
    const url = new URL(request.url);
    const DEBUG_ENABLED = (env.DEBUG === 'true');
    const logDebug = (message) => {
        if (DEBUG_ENABLED) console.log(`[Danmu Func] ${message}`);
    };

    // --- OPTIONS 预检：直接 204 + CORS 头 ---
    if (request.method === 'OPTIONS') {
        const headers = new Headers();
        applyCorsHeaders(headers);
        return new Response(null, { status: 204, headers });
    }

    // --- 同源 Referer 校验：带 Referer 且其 host 与当前请求 host 不一致 → 403 ---
    // 无 Referer 放行（部分 WebView/PWA 不发 Referer）；畸形 Referer 视为不同源
    const referer = request.headers.get('Referer');
    if (referer) {
        let refererHost = null;
        try {
            refererHost = new URL(referer).host;
        } catch (e) { /* 畸形 Referer */ }
        if (refererHost !== url.host) {
            logDebug(`Referer 校验拒绝: ${referer}`);
            return jsonResponse({ error: 'forbidden' }, 403);
        }
    }

    // --- 方法校验：仅允许 GET ---
    if (request.method !== 'GET') {
        return jsonResponse({ error: 'method not allowed' }, 405, { Allow: 'GET, OPTIONS' });
    }

    // --- 模式判定：official（AppId+Secret 齐备）优先，其次 custom（DANMU_BASE） ---
    const mode = (env.DANMU_APP_ID && env.DANMU_APP_SECRET) ? 'official'
        : (env.DANMU_BASE ? 'custom' : null);

    // [[path]] 可选捕获：/danmu/（或 /danmu）时为空 → 状态探测端点
    // 注意：多段路径（如 api/v2/search/anime）时 params.path 是数组，需拼回字符串
    const rawPathRaw = (context.params && context.params.path) ? context.params.path : '';
    const rawPath = Array.isArray(rawPathRaw) ? rawPathRaw.join('/') : String(rawPathRaw || '');
    const isStatusEndpoint = (rawPath === '' || rawPath === '/');

    // --- 状态端点：不缓存（no-store），前端据此决定回退策略 ---
    if (isStatusEndpoint) {
        return jsonResponse(
            mode ? { configured: true, mode } : { configured: false },
            200,
            { 'Cache-Control': 'no-store' }
        );
    }

    // --- 未配置环境变量：普通路径请求一律 404，前端识别后回退自定义端点 ---
    if (!mode) {
        return jsonResponse({ configured: false }, 404, { 'Cache-Control': 'no-store' });
    }

    // --- 构造上游地址（捕获路径不含前导斜杠，统一归一化补上） ---
    // 调试补丁：透传段整体包 try/catch 把线上异常堆栈直接返回（排查 1101；定位后移除）
    try {
        return await passthroughRequest(context, request, env, url, rawPath, waitUntil);
    } catch (err) {
        const stack = (err && (err.stack || err.message)) || String(err);
        console.error('[Danmu Func fatal]', stack);
        return jsonResponse({ fatal: true, message: String(err && err.message || err), stack }, 500, { 'Cache-Control': 'no-store' });
    }
}

// 透传主流程（从 onRequest 拆出便于整体 try/catch 调试）
async function passthroughRequest(context, request, env, url, rawPath, waitUntil) {
    const DEBUG_ENABLED = (env.DEBUG === 'true');
    const logDebug = (message) => {
        if (DEBUG_ENABLED) console.log(`[Danmu Func] ${message}`);
    };
    const mode = (env.DANMU_APP_ID && env.DANMU_APP_SECRET) ? 'official'
        : (env.DANMU_BASE ? 'custom' : null);

    // --- 构造上游地址（捕获路径不含前导斜杠，统一归一化补上） ---
    const upstreamPath = '/' + rawPath.replace(/^\/+/, '');
    const upstreamBase = (mode === 'official') ? OFFICIAL_API_BASE : env.DANMU_BASE.replace(/\/+$/, '');
    const upstreamUrl = upstreamBase + upstreamPath + url.search;
    logDebug(`转发 GET ${upstreamUrl} (mode=${mode})`);

    // --- 边缘缓存检查（Cache API；cacheKey 不带任何请求头，保证同 URL 全量命中） ---
    const cacheKey = new Request(request.url, { method: 'GET', headers: {} });
    const edgeCache = caches.default;
    try {
        const cachedResponse = await edgeCache.match(cacheKey);
        if (cachedResponse) {
            // 命中：换新 Response 返回（避免消费掉缓存条目的 body 流），并确保 CORS 头存在
            logDebug(`[缓存命中] ${upstreamPath}`);
            const headers = new Headers(cachedResponse.headers);
            applyCorsHeaders(headers);
            return new Response(cachedResponse.body, { status: cachedResponse.status, headers });
        }
    } catch (e) {
        logDebug(`读取边缘缓存失败 (${upstreamPath}): ${e.message}`);
        // 出错则继续回源，不影响功能
    }

    // --- 回源请求头（放在缓存检查之后，命中时无需白白计算签名） ---
    const upstreamHeaders = (mode === 'official')
        ? await buildOfficialHeaders(env)
        : { 'User-Agent': CHROME_UA };

    // --- 回源：30s 超时保护（AbortController，与 proxy 写法一致） ---
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let upstream;
    try {
        upstream = await fetch(upstreamUrl, { method: 'GET', headers: upstreamHeaders, redirect: 'follow', signal: controller.signal });
    } catch (e) {
        clearTimeout(timer);
        logDebug(`上游请求失败 (${upstreamUrl}): ${e.message}`);
        return jsonResponse({ error: 'upstream' }, 502, { 'Cache-Control': 'no-store' });
    }
    clearTimeout(timer);

    if (upstream.status >= 500) {
        logDebug(`上游 ${upstream.status} (${upstreamUrl})`);
        return jsonResponse({ error: 'upstream' }, 502, { 'Cache-Control': 'no-store' });
    }

    // --- 重建响应头：保留 content-type，剔除上游链路专属头，补 CORS 与缓存策略 ---
    // 注意：body 只做流式搬运（upstream.body 直接交给新 Response），绝不读取/解析/改写
    const ttl = getCacheTtl(upstreamPath);
    const responseHeaders = new Headers(upstream.headers);
    for (const name of STRIP_RESPONSE_HEADERS) responseHeaders.delete(name);
    applyCorsHeaders(responseHeaders);
    responseHeaders.set('Cache-Control', `public, max-age=${ttl}`);
    const passthrough = new Response(upstream.body, { status: upstream.status, headers: responseHeaders });

    // --- 写入边缘缓存（仅 200；waitUntil 异步执行，不阻塞响应返回） ---
    if (upstream.status === 200) {
        try {
            waitUntil(edgeCache.put(cacheKey, passthrough.clone())
                .catch(e => logDebug(`写入边缘缓存失败 (${upstreamPath}): ${e.message}`)));
        } catch (e) {
            logDebug(`创建边缘缓存副本失败 (${upstreamPath}): ${e.message}`);
        }
    }

    return passthrough;
}
