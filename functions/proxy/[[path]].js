// functions/proxy/[[path]].js - Cloudflare Pages Function
// 与 Vercel 版 (api/proxy/[...path].mjs) 行为/优化对齐：
//   1. M3U8 短缓存（M3U8_CACHE_TTL，默认 120s）与二进制分片长缓存（CACHE_TTL，默认 86400）分离，
//      避免换源/动态列表拿到陈旧的 m3u8
//   2. KV 直接缓存"处理后"的 M3U8 文本（与 Vercel 内存 LRU 缓存 processed 文本同语义），
//      命中后跳过上游 fetch 与逐行重写
//   3. 上游请求 30s 超时保护（AbortController），防止慢源挂死 Workers 请求预算
//   4. 豆瓣图片 CDN 防盗链：强制携带豆瓣站内 Referer，否则按 URL 确定性返回 418/403
//   5. 二进制透传响应头过滤：剔除 content-encoding/content-length/vary/set-cookie/expires/pragma
//      等干扰边缘缓存与长度校验的头，统一改写为我们自己的缓存策略
//   6. Cache API 显式边缘缓存：实测 Function 响应即便带 Cache-Control 也恒为
//      CF-Cache-Status: DYNAMIC（不会被 CDN 自动缓存），同一 ts 分片/豆瓣封面每次
//      都回源重拉。这里用 caches.default 显式缓存最终响应（m3u8 短 TTL、二进制长 TTL），
//      同一 colo 的重复请求直接命中边缘，不回源、不消耗上游流量
// 鉴权说明：前端不携带 auth 参数（与 Vercel 版一致），代理层不做密码校验

// --- 配置 (从 Cloudflare 环境变量读取，wrangler.toml [vars] 或 Dashboard 中设置) ---
// DEBUG (例如 false 或 true)
// CACHE_TTL (例如 86400)
// M3U8_CACHE_TTL (例如 120)
// USER_AGENTS_JSON (例如 ["UA1", "UA2"]) - JSON 字符串数组
// --- 配置结束 ---

// --- 常量 ---
const MEDIA_FILE_EXTENSIONS = [
    '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.f4v', '.m4v', '.3gp', '.3g2', '.ts', '.mts', '.m2ts',
    '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.alac', '.aiff', '.opus',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg', '.avif', '.heic'
];
// 额外可直接流式透传的二进制/文本扩展名（不在 MEDIA_FILE_EXTENSIONS 中）：
// .key 解密密钥（m3u8 KEY URI 经代理）、.vtt/.srt 字幕、字体文件
const EXTRA_STREAMABLE_EXTENSIONS = ['.key', '.vtt', '.srt', '.woff', '.woff2', '.ttf', '.otf'];
const MEDIA_CONTENT_TYPES = ['video/', 'audio/', 'image/'];

// 提取目标 URL 路径的小写扩展名（仅 pathname，天然排除查询串）；无扩展名返回 null
function getPathExtension(targetUrl) {
    try {
        const m = new URL(targetUrl).pathname.match(/(\.[a-z0-9]+)$/i);
        return m ? m[1].toLowerCase() : null;
    } catch (e) {
        return null;
    }
}

// 按扩展名判断是否可流式透传（无需嗅探内容即可确定是二进制媒体）；
// 明确排除 .m3u8——它必须走全量缓冲+逐行重写路径
function isStreamablePath(targetUrl) {
    const ext = getPathExtension(targetUrl);
    if (!ext || ext === '.m3u8') return false;
    return MEDIA_FILE_EXTENSIONS.includes(ext) || EXTRA_STREAMABLE_EXTENSIONS.includes(ext);
}
// --- 常量结束 ---

/**
 * 主要的 Pages Function 处理函数
 * 拦截发往 /proxy/* 的请求
 */
export async function onRequest(context) {
    const { request, env, waitUntil } = context;
    const url = new URL(request.url);

    // --- 从环境变量读取配置 ---
    const DEBUG_ENABLED = (env.DEBUG === 'true');
    const CACHE_TTL = parseInt(env.CACHE_TTL || '86400');       // ts 分片等二进制内容缓存 24 小时
    const M3U8_CACHE_TTL = parseInt(env.M3U8_CACHE_TTL || '120'); // m3u8 短缓存，避免换源/动态列表拿到陈旧数据
    let USER_AGENTS = [ // 与 Vercel 版相同的默认列表
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
    ];
    try {
        const agentsJson = env.USER_AGENTS_JSON;
        if (agentsJson) {
            const parsedAgents = JSON.parse(agentsJson);
            if (Array.isArray(parsedAgents) && parsedAgents.length > 0) {
                USER_AGENTS = parsedAgents;
            } else {
                logDebug("环境变量 USER_AGENTS_JSON 格式无效或为空，使用默认值");
            }
        }
    } catch (e) {
        logDebug(`解析环境变量 USER_AGENTS_JSON 失败: ${e.message}，使用默认值`);
    }
    // --- 配置读取结束 ---

    // 输出调试日志 (需要设置 DEBUG: true 环境变量)
    function logDebug(message) {
        if (DEBUG_ENABLED) {
            console.log(`[Proxy Func] ${message}`);
        }
    }

    // 展开错误及其 cause 链，返回可读的详细原因列表（用于连接测试诊断）
    function errorDetails(err) {
        const parts = [];
        let current = err;
        let depth = 0;
        while (current && depth < 6) {
            const bits = [];
            if (current.name) bits.push(current.name);
            if (current.syscall) bits.push('syscall=' + current.syscall);
            if (current.code) bits.push('code=' + current.code);
            if (current.errno !== undefined && current.errno !== null) bits.push('errno=' + current.errno);
            if (current.hostname) bits.push('host=' + current.hostname);
            if (current.address) bits.push('addr=' + current.address);
            if (current.port) bits.push('port=' + current.port);
            const msg = current.message || String(current);
            if (bits.indexOf(msg) === -1) bits.push(msg);
            parts.push(bits.join('  '));
            current = current.cause;
            depth++;
        }
        return parts.length ? parts : [String(err)];
    }

    // 从请求路径中提取目标 URL
    function getTargetUrlFromPath(pathname) {
        // 路径格式: /proxy/经过编码的URL
        // 例如: /proxy/https%3A%2F%2Fexample.com%2Fplaylist.m3u8
        const encodedUrl = pathname.replace(/^\/proxy\//, '');
        if (!encodedUrl) return null;
        try {
            let decodedUrl = decodeURIComponent(encodedUrl);

            // 简单检查解码后是否是有效的 http/https URL
            if (!decodedUrl.match(/^https?:\/\//i)) {
                // 也许原始路径就没有编码？如果看起来像URL就直接用
                if (encodedUrl.match(/^https?:\/\//i)) {
                    decodedUrl = encodedUrl;
                    logDebug(`Warning: Path was not encoded but looks like URL: ${decodedUrl}`);
                } else {
                    logDebug(`无效的目标URL格式 (解码后): ${decodedUrl}`);
                    return null;
                }
            }
            return decodedUrl;
        } catch (e) {
            logDebug(`解码目标URL时出错: ${encodedUrl} - ${e.message}`);
            return null;
        }
    }

    // 创建标准化的响应
    function createResponse(body, status = 200, headers = {}) {
        const responseHeaders = new Headers(headers);
        // 关键：添加 CORS 跨域头，允许前端 JS 访问代理后的响应
        responseHeaders.set("Access-Control-Allow-Origin", "*");
        responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
        responseHeaders.set("Access-Control-Allow-Headers", "*");

        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: responseHeaders
            });
        }

        return new Response(body, { status, headers: responseHeaders });
    }

    // 创建 M3U8 类型的响应
    // m3u8 短缓存：与 Vercel 版一致（ts 分片保持长缓存）
    function createM3u8Response(content) {
        return createResponse(content, 200, {
            "Content-Type": "application/vnd.apple.mpegurl;charset=utf-8",
            "Cache-Control": `public, max-age=${M3U8_CACHE_TTL}`
        });
    }

    // 获取随机 User-Agent
    function getRandomUserAgent() {
        return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    }

    // 构建转发到上游的请求头（与 Vercel 版 buildUpstreamHeaders 对齐）
    function buildUpstreamHeaders(targetUrl) {
        const headers = {
            'User-Agent': getRandomUserAgent(),
            'Accept': request.headers.get('Accept') || '*/*',
            'Accept-Language': request.headers.get('Accept-Language') || 'zh-CN,zh;q=0.9,en;q=0.8',
            // 尝试设置一个合理的 Referer
            'Referer': request.headers.get('Referer') || new URL(targetUrl).origin,
        };
        // BYTERANGE 分片：转发客户端 Range 头，上游按区间回 206。
        // 此前不转发导致每个区间请求都拿到 200 全量文件，带宽巨量浪费（多倍速卡顿诱因之一）
        const rangeHeader = request.headers.get('Range') || request.headers.get('range');
        if (rangeHeader) headers['Range'] = rangeHeader;
        // 豆瓣图片CDN防盗链：必须携带豆瓣站内 Referer，否则按 URL 确定性返回 418/403
        if (/doubanio\.com|douban\.com/i.test(targetUrl)) {
            headers['Referer'] = 'https://movie.douban.com/';
        }
        return headers;
    }

    // 请求上游（30s 超时保护，防止慢源挂死请求预算；与 Vercel 版对齐）
    async function fetchUpstream(targetUrl) {
        const headers = buildUpstreamHeaders(targetUrl);
        logDebug(`准备请求目标: ${targetUrl}`);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        let response;
        try {
            response = await fetch(targetUrl, { headers, redirect: 'follow', signal: controller.signal });
        } catch (error) {
            throw new Error(`连接目标 URL 失败 ${targetUrl}: ${error.message}`);
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            logDebug(`请求失败: ${response.status} ${response.statusText} - ${targetUrl}`);
            const err = new Error(`HTTP error ${response.status}: ${response.statusText}. URL: ${targetUrl}. Body: ${errorBody.substring(0, 200)}`);
            err.status = response.status;
            throw err;
        }

        return response;
    }

    // 获取远程内容及其类型（先全量缓冲再按内容嗅探，与 Vercel 版行为一致）
    async function fetchContentWithType(targetUrl) {
        try {
            const response = await fetchUpstream(targetUrl);
            // 读取响应内容为二进制（视频分片、图片等二进制内容绝不能用 text() 读取，否则数据损坏）
            const buffer = await response.arrayBuffer();
            const contentType = response.headers.get('Content-Type') || '';
            logDebug(`请求成功: ${targetUrl}, Content-Type: ${contentType}, 内容长度: ${buffer.byteLength}`);
            return { buffer, contentType, responseHeaders: response.headers };
        } catch (error) {
            logDebug(`请求异常 ${targetUrl}: ${error.message}`);
            // 保留 err.status 供错误响应使用
            throw error;
        }
    }

    // 判断二进制内容是否是 M3U8（优先看 Content-Type，再看文件头——
    // 很多采集站 CDN 用 application/octet-stream 提供 m3u8，必须嗅探内容）
    function isM3u8Buffer(buffer, contentType) {
        if (contentType && (contentType.includes('mpegurl'))) {
            return true;
        }
        if (!buffer || buffer.byteLength < 7) return false;
        return new TextDecoder().decode(buffer.slice(0, 64)).trimStart().startsWith('#EXTM3U');
    }

    // 判断是否是媒体文件 (根据扩展名和 Content-Type)
    function isMediaFile(url, contentType) {
        if (contentType) {
            for (const mediaType of MEDIA_CONTENT_TYPES) {
                if (contentType.toLowerCase().startsWith(mediaType)) {
                    return true;
                }
            }
        }
        const urlLower = url.toLowerCase();
        for (const ext of MEDIA_FILE_EXTENSIONS) {
            if (urlLower.endsWith(ext) || urlLower.includes(`${ext}?`)) {
                return true;
            }
        }
        return false;
    }

    // 将相对 URL 转换为绝对 URL
    function resolveUrl(baseUrl, relativeUrl) {
        if (!relativeUrl) return '';
        // 如果已经是绝对 URL，直接返回
        if (relativeUrl.match(/^https?:\/\//i)) {
            return relativeUrl;
        }
        if (!baseUrl) return relativeUrl;
        try {
            return new URL(relativeUrl, baseUrl).toString();
        } catch (e) {
            logDebug(`解析 URL 失败: baseUrl=${baseUrl}, relativeUrl=${relativeUrl}, error=${e.message}`);
            if (relativeUrl.startsWith('/')) {
                // 处理根路径相对 URL
                const urlObj = new URL(baseUrl);
                return `${urlObj.origin}${relativeUrl}`;
            }
            // 处理同级目录相对 URL
            return `${baseUrl.replace(/\/[^/]*$/, '/')}${relativeUrl}`;
        }
    }

    // 获取 URL 的基础路径 (用于解析相对路径)
    function getBaseUrl(urlStr) {
        try {
            const parsedUrl = new URL(urlStr);
            if (!parsedUrl.pathname || parsedUrl.pathname === '/') {
                return `${parsedUrl.origin}/`;
            }
            const pathParts = parsedUrl.pathname.split('/');
            pathParts.pop(); // 移除文件名或最后一个路径段
            return `${parsedUrl.origin}${pathParts.join('/')}/`;
        } catch (e) {
            logDebug(`获取 BaseUrl 时出错: ${urlStr} - ${e.message}`);
            const lastSlashIndex = urlStr.lastIndexOf('/');
            // 确保不是协议部分的斜杠 (http://)
            return lastSlashIndex > urlStr.indexOf('://') + 2 ? urlStr.substring(0, lastSlashIndex + 1) : urlStr + '/';
        }
    }

    // 将目标 URL 重写为内部代理路径 (/proxy/...)
    function rewriteUrlToProxy(targetUrl) {
        if (!targetUrl || typeof targetUrl !== 'string') return '';
        return `/proxy/${encodeURIComponent(targetUrl)}`;
    }

    // 处理 M3U8 中的 #EXT-X-KEY 行 (加密密钥)
    function processKeyLine(line, baseUrl) {
        return line.replace(/URI="([^"]+)"/, (match, uri) => {
            const absoluteUri = resolveUrl(baseUrl, uri);
            logDebug(`处理 KEY URI: 原始='${uri}', 绝对='${absoluteUri}'`);
            return `URI="${rewriteUrlToProxy(absoluteUri)}"`;
        });
    }

    // 处理 M3U8 中的 #EXT-X-MAP 行 (初始化片段)
    function processMapLine(line, baseUrl) {
        return line.replace(/URI="([^"]+)"/, (match, uri) => {
            const absoluteUri = resolveUrl(baseUrl, uri);
            logDebug(`处理 MAP URI: 原始='${uri}', 绝对='${absoluteUri}'`);
            return `URI="${rewriteUrlToProxy(absoluteUri)}"`;
        });
    }

    // 处理媒体 M3U8 播放列表 (包含视频/音频片段)
    function processMediaPlaylist(url, content) {
        const baseUrl = getBaseUrl(url);
        const lines = content.split('\n');
        const output = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // 保留最后的空行
            if (!line && i === lines.length - 1) {
                output.push(line);
                continue;
            }
            if (!line) continue; // 跳过中间的空行

            if (line.startsWith('#EXT-X-KEY')) {
                output.push(processKeyLine(line, baseUrl));
                continue;
            }
            if (line.startsWith('#EXT-X-MAP')) {
                output.push(processMapLine(line, baseUrl));
                continue;
            }
            if (line.startsWith('#EXTINF')) {
                output.push(line);
                continue;
            }
            if (!line.startsWith('#')) {
                const absoluteUrl = resolveUrl(baseUrl, line);
                logDebug(`重写媒体片段: 原始='${line}', 绝对='${absoluteUrl}'`);
                output.push(rewriteUrlToProxy(absoluteUrl));
                continue;
            }
            // 其他 M3U8 标签直接添加
            output.push(line);
        }
        return output.join('\n');
    }

    // 处理主 M3U8 播放列表
    // 主播放列表：透传多码率（与 Vercel 版一致：不再服务端选最高码率、不再递归抓子列表）。
    // 标准重写所有变体/音轨 URI 为代理路径后原样输出整个主列表：
    //   - hls.js 收到全部档位，恢复 ABR 自适应与前端多档清晰度菜单
    //   - 服务端折叠成单档会导致播放器只能看到 1 个 level（"源片仅此一档"，无法切换清晰度）
    function processMasterPlaylist(url, content) {
        const baseUrl = getBaseUrl(url);
        const lines = content.split('\n');
        const output = [];
        let expectUri = false; // #EXT-X-STREAM-INF 的 URI 在下一非注释行
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) { if (i === lines.length - 1) output.push(line); continue; }
            if (expectUri && !line.startsWith('#')) {
                output.push(rewriteUrlToProxy(resolveUrl(baseUrl, line)));
                expectUri = false;
                continue;
            }
            expectUri = false;
            if (line.startsWith('#EXT-X-STREAM-INF')) {
                output.push(line);
                expectUri = true;
                continue;
            }
            if (line.startsWith('#EXT-X-MEDIA')) {
                // 音轨/字幕轨的 URI 同样重写为代理路径
                output.push(line.replace(/URI="([^"]+)"/, (m, uri) => `URI="${rewriteUrlToProxy(resolveUrl(baseUrl, uri))}"`));
                continue;
            }
            if (!line.startsWith('#')) {
                // 主列表中游离的 URI 行（罕见），同样重写
                output.push(rewriteUrlToProxy(resolveUrl(baseUrl, line)));
                continue;
            }
            // 保留其他 M3U8 标签
            output.push(line);
        }
        return output.join('\n');
    }

    // 递归处理 M3U8 内容
    async function processM3u8Content(targetUrl, content) {
        if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) {
            logDebug(`检测到主播放列表: ${targetUrl}`);
            return processMasterPlaylist(targetUrl, content);
        }
        logDebug(`检测到媒体播放列表: ${targetUrl}`);
        return processMediaPlaylist(targetUrl, content);
    }

    // 二进制响应头过滤（与 Vercel 版 applyFilteredUpstreamHeaders 对齐）：
    // 排除 CORS（已显式设置）、已解压/需自定的头，并剔除干扰边缘缓存判定的头
    // （Vary 会碎片化缓存键、Set-Cookie 会直接禁用边缘缓存、Expires/Pragma 干扰缓存决策）
    function buildFilteredUpstreamHeaders(responseHeaders) {
        const filtered = new Headers();
        responseHeaders.forEach((value, key) => {
            const lowerKey = key.toLowerCase();
            if (!lowerKey.startsWith('access-control-') &&
                lowerKey !== 'content-encoding' && // Workers fetch 已解压，原头不再适用
                lowerKey !== 'content-length' &&   // 由实际转发内容决定
                lowerKey !== 'transfer-encoding' &&
                lowerKey !== 'content-type' &&     // 显式设置，避免缺失
                lowerKey !== 'vary' &&             // 碎片化边缘缓存键
                lowerKey !== 'set-cookie' &&       // 直接禁用边缘缓存
                lowerKey !== 'cache-control' &&    // 用我们自己的缓存策略
                lowerKey !== 'expires' &&
                lowerKey !== 'pragma') {
                filtered.set(key, value);
            }
        });
        return filtered;
    }

    // --- 主要请求处理逻辑 ---

    try {
        const targetUrl = getTargetUrlFromPath(url.pathname);

        if (!targetUrl) {
            logDebug(`无效的代理请求路径: ${url.pathname}`);
            return createResponse("无效的代理请求。路径应为 /proxy/<经过编码的URL>", 400);
        }

        logDebug(`收到代理请求: ${targetUrl}`);

        // --- 边缘缓存检查（Cache API，显式缓存最终响应） ---
        // 仅缓存 GET 且无 Range 头的请求；Range/HEAD 等走实时路径保证正确性。
        // 命中后直接返回缓存副本（换新 Response，避免消费掉缓存条目的 body 流）
        const canEdgeCache = request.method === 'GET' && !request.headers.has('Range') && !request.headers.has('range');
        const edgeCache = caches.default;
        const edgeCacheKey = new Request(request.url, { method: 'GET' });
        if (canEdgeCache) {
            try {
                const cachedResponse = await edgeCache.match(edgeCacheKey);
                if (cachedResponse) {
                    logDebug(`[边缘缓存命中] ${targetUrl}`);
                    const hit = new Response(cachedResponse.body, cachedResponse);
                    hit.headers.set('X-Proxy-Edge-Cache', 'HIT');
                    return hit;
                }
            } catch (cacheError) {
                logDebug(`边缘缓存读取失败: ${cacheError.message}`);
                // 出错则继续执行，不影响功能
            }
        }

        // --- 流式透传分支（扩展名可确定是二进制媒体时） ---
        // 直接把上游 body 流转发给客户端（tee 一份写入边缘缓存）：
        //   - 客户端 TTFB 大幅提前：不再等整片下载完成才开始回传
        //   - Worker 内存从"整片大小"降为流式常数
        // 边界约束：
        //   - 仅 GET（HEAD 无 body，走缓冲路径原样兼容）
        //   - .m3u8 与无扩展名/未知扩展名一律不走此分支，保证嗅探与重写正确性
        if (request.method === 'GET' && isStreamablePath(targetUrl)) {
            logDebug(`[流式透传] ${targetUrl}`);
            const upstream = await fetchUpstream(targetUrl);
            const upstreamType = upstream.headers.get('Content-Type') || '';
            const streamHeaders = buildFilteredUpstreamHeaders(upstream.headers);
            streamHeaders.set('Content-Type', upstreamType || 'application/octet-stream');

            // BYTERANGE 源：带 Range 的请求按上游状态码原样直通（206 保留 Content-Range）。
            // Cache API 不缓存 206，直通即可；此前此类请求被强制 200 全量返回
            if (upstream.status !== 200) {
                logDebug(`[流式透传] 上游状态 ${upstream.status}，直通不缓存: ${targetUrl}`);
                streamHeaders.set('X-Proxy-Edge-Cache', 'PASS');
                return new Response(upstream.body, { status: upstream.status, headers: streamHeaders });
            }

            streamHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
            streamHeaders.set('X-Proxy-Edge-Cache', 'MISS');

            if (!upstream.body) {
                // 极端兜底：上游无 body 时退回缓冲路径语义（构造空响应）
                logDebug(`[流式透传] 上游无 body，返回空内容: ${targetUrl}`);
                return createResponse(new ArrayBuffer(0), 200, streamHeaders);
            }

            if (!canEdgeCache) {
                // 不可边缘缓存（防御性分支）：直通，不做 tee
                return new Response(upstream.body, { status: 200, headers: streamHeaders });
            }

            // tee 上游流：一份给客户端，一份交给 Cache API 写入边缘缓存
            // （分片/封面内容不变，长 TTL 安全；客户端中断会导致缓存写入一并终止，无半截数据——
            //   cache.put 在 body 不完整时会抛错且不会落缓存）
            const [clientBody, cacheBody] = upstream.body.tee();
            const clientResponse = new Response(clientBody, { status: 200, headers: streamHeaders });
            if (canEdgeCache) {
                try {
                    const cacheResponse = new Response(cacheBody, { status: 200, headers: streamHeaders });
                    waitUntil(edgeCache.put(edgeCacheKey, cacheResponse)
                        .catch(e => logDebug(`流式内容写入边缘缓存失败 (${targetUrl}): ${e.message}`)));
                } catch (edgeCacheError) {
                    logDebug(`流式内容创建缓存副本失败 (${targetUrl}): ${edgeCacheError.message}`);
                }
            }
            return clientResponse;
        }

        // --- 缓存检查 (KV) ---
        // KV 直接缓存"处理后"的 M3U8 文本（与 Vercel 内存缓存 processed 文本同语义）：
        // 命中后跳过上游 fetch 与逐行重写；二进制分片交给 Cache-Control 边缘/浏览器缓存，
        // 避免 KV 存储膨胀与二进制损坏
        const cacheKey = `proxy_m3u8:${targetUrl}`;
        let kvNamespace = null;
        try {
            kvNamespace = env.LIBRETV_PROXY_KV;
            if (!kvNamespace) throw new Error("KV 命名空间未绑定");
        } catch (e) {
            logDebug(`KV 命名空间 'LIBRETV_PROXY_KV' 访问出错或未绑定: ${e.message}`);
            kvNamespace = null;
        }

        if (kvNamespace) {
            try {
                const cachedM3u8 = await kvNamespace.get(cacheKey);
                if (cachedM3u8) {
                    logDebug(`[缓存命中] M3U8: ${targetUrl}`);
                    return createM3u8Response(cachedM3u8);
                } else {
                    logDebug(`[缓存未命中] ${targetUrl}`);
                }
            } catch (kvError) {
                logDebug(`从 KV 读取缓存失败 (${cacheKey}): ${kvError.message}`);
                // 出错则继续执行，不影响功能
            }
        }

        // --- 实际请求 ---
        const { buffer, contentType, responseHeaders } = await fetchContentWithType(targetUrl);
        const isM3u8 = isM3u8Buffer(buffer, contentType);

        // --- 处理响应 ---
        if (isM3u8) {
            logDebug(`内容是 M3U8，开始处理: ${targetUrl}`);
            const processedM3u8 = await processM3u8Content(targetUrl, new TextDecoder().decode(buffer));

            // --- 写入缓存 (KV，仅 M3U8 处理后文本，短 TTL) ---
            if (kvNamespace) {
                try {
                    waitUntil(kvNamespace.put(cacheKey, processedM3u8, { expirationTtl: M3U8_CACHE_TTL }));
                    logDebug(`已将处理后的 M3U8 内容写入缓存: ${targetUrl}`);
                } catch (kvError) {
                    logDebug(`向 KV 写入缓存失败 (${cacheKey}): ${kvError.message}`);
                    // 写入失败不影响返回结果
                }
            }

            const m3u8Response = createM3u8Response(processedM3u8);
            m3u8Response.headers.set('X-Proxy-Edge-Cache', 'MISS');
            // --- 写入边缘缓存（Cache API，短 TTL 随响应 Cache-Control） ---
            if (canEdgeCache) {
                try {
                    waitUntil(edgeCache.put(edgeCacheKey, m3u8Response.clone()));
                } catch (edgeCacheError) {
                    logDebug(`写入边缘缓存失败 (${targetUrl}): ${edgeCacheError.message}`);
                }
            }
            return m3u8Response;
        } else {
            logDebug(`内容不是 M3U8 (类型: ${contentType})，直接返回: ${targetUrl}`);
            // 二进制透传：先过滤上游响应头（避免 content-encoding 长度不匹配、
            // Vary/Set-Cookie 干扰边缘缓存），再设置我们自己的缓存策略（ts 分片内容不变，长缓存）
            const finalHeaders = buildFilteredUpstreamHeaders(responseHeaders);
            finalHeaders.set('Content-Type', contentType || 'application/octet-stream');
            finalHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
            // 直接以 ArrayBuffer 回传，保证二进制（视频分片/图片）不被损坏
            const binaryResponse = createResponse(buffer, 200, finalHeaders);
            binaryResponse.headers.set('X-Proxy-Edge-Cache', 'MISS');
            // --- 写入边缘缓存（Cache API，长 TTL：分片/封面内容不变，可安全长期缓存） ---
            if (canEdgeCache) {
                try {
                    waitUntil(edgeCache.put(edgeCacheKey, binaryResponse.clone()));
                } catch (edgeCacheError) {
                    logDebug(`写入边缘缓存失败 (${targetUrl}): ${edgeCacheError.message}`);
                }
            }
            return binaryResponse;
        }

    } catch (error) {
        logDebug(`处理代理请求时发生严重错误: ${error.message} \n ${error.stack}`);
        return new Response(JSON.stringify({
            success: false,
            error: `代理处理错误: ${error.message}`,
            targetUrl: typeof targetUrl !== 'undefined' ? targetUrl : null,
            details: errorDetails(error)
        }), {
            status: error.status || 500,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
                'Access-Control-Allow-Headers': '*',
                'Content-Type': 'application/json'
            }
        });
    }
}

// 处理 OPTIONS 预检请求的函数
export async function onOptions(context) {
    // 直接返回允许跨域的头信息
    return new Response(null, {
        status: 204, // No Content
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*", // 允许所有请求头
            "Access-Control-Max-Age": "86400", // 预检请求结果缓存一天
        },
    });
}
