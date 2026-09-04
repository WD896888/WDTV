// /api/proxy/[...path].mjs - Vercel Serverless Function (ES Module)
// 响应发送契约与原版保持一致（全量缓冲 + Content-Length + res.send()）：
// Vercel 的 Node 运行时为 res 包装了 Express 风格方法（status/send/json），
// 该契约已在生产环境验证可靠；流式 pipe 在其包装层上行为不可控，不采用。

import fetch from 'node-fetch';
import { URL } from 'url';

// --- 配置 (从环境变量读取) ---
const DEBUG_ENABLED = process.env.DEBUG === 'true';
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '86400', 10); // ts 分片等二进制内容缓存 24 小时
const M3U8_CACHE_TTL = parseInt(process.env.M3U8_CACHE_TTL || '120', 10); // m3u8 短缓存，避免换源/动态列表拿到陈旧数据

// --- User Agent 处理 ---
// 默认 User Agent 列表
let USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
];
// 尝试从环境变量读取并解析 USER_AGENTS_JSON
try {
    const agentsJsonString = process.env.USER_AGENTS_JSON;
    if (agentsJsonString) {
        const parsedAgents = JSON.parse(agentsJsonString);
        // 检查解析结果是否为非空数组
        if (Array.isArray(parsedAgents) && parsedAgents.length > 0) {
            USER_AGENTS = parsedAgents; // 使用环境变量中的数组
            console.log(`[代理日志] 已从环境变量加载 ${USER_AGENTS.length} 个 User Agent。`);
        } else {
            console.warn("[代理日志] 环境变量 USER_AGENTS_JSON 不是有效的非空数组，使用默认值。");
        }
    }
} catch (e) {
    // 如果 JSON 解析失败，记录错误并使用默认值
    console.error(`[代理日志] 解析环境变量 USER_AGENTS_JSON 出错: ${e.message}。使用默认 User Agent。`);
}

// 广告过滤在代理中禁用，由播放器处理
const FILTER_DISCONTINUITY = false;

// --- m3u8 处理结果内存缓存（LRU，上限 200 条） ---
// 命中直接返回处理后的文本，跳过上游 fetch 与逐行重写（Serverless 实例存活期间有效）
const M3U8_CACHE_MAX = 200;
const m3u8Cache = new Map(); // 目标 URL -> { text, ts }

function getM3u8Cache(key) {
    const entry = m3u8Cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > M3U8_CACHE_TTL * 1000) {
        m3u8Cache.delete(key);
        return null;
    }
    // LRU：命中时移到末尾（最新）
    m3u8Cache.delete(key);
    m3u8Cache.set(key, entry);
    return entry.text;
}

function setM3u8Cache(key, text) {
    if (!text) return; // 空结果不缓存
    if (m3u8Cache.size >= M3U8_CACHE_MAX) {
        // 淘汰最旧（Map 首个 key）
        m3u8Cache.delete(m3u8Cache.keys().next().value);
    }
    m3u8Cache.set(key, { text, ts: Date.now() });
}

// --- 辅助函数 ---

function logDebug(message) {
    if (DEBUG_ENABLED) {
        console.log(`[代理日志] ${message}`);
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

/**
 * 从代理请求路径中提取编码后的目标 URL。
 * @param {string} encodedPath - URL 编码后的路径部分 (例如 "https%3A%2F%2F...")
 * @returns {string|null} 解码后的目标 URL，如果无效则返回 null。
 */
function getTargetUrlFromPath(encodedPath) {
    if (!encodedPath) {
        logDebug("getTargetUrlFromPath 收到空路径。");
        return null;
    }
    try {
        const decodedUrl = decodeURIComponent(encodedPath);
        // 基础检查，看是否像一个 HTTP/HTTPS URL
        if (decodedUrl.match(/^https?:\/\/.+/i)) {
            return decodedUrl;
        } else {
            logDebug(`无效的解码 URL 格式: ${decodedUrl}`);
            // 备选检查：原始路径是否未编码但看起来像 URL？
            if (encodedPath.match(/^https?:\/\/.+/i)) {
                logDebug(`警告: 路径未编码但看起来像 URL: ${encodedPath}`);
                return encodedPath;
            }
            return null;
        }
    } catch (e) {
        // 捕获解码错误 (例如格式错误的 URI)
        logDebug(`解码目标 URL 出错: ${encodedPath} - ${e.message}`);
        return null;
    }
}

function getBaseUrl(urlStr) {
    if (!urlStr) return '';
    try {
        const parsedUrl = new URL(urlStr);
        // 处理根目录或只有文件名的情况
        const pathSegments = parsedUrl.pathname.split('/').filter(Boolean); // 移除空字符串
        if (pathSegments.length <= 1) {
            return `${parsedUrl.origin}/`;
        }
        pathSegments.pop(); // 移除最后一段
        return `${parsedUrl.origin}/${pathSegments.join('/')}/`;
    } catch (e) {
        logDebug(`获取 BaseUrl 失败: "${urlStr}": ${e.message}`);
        // 备用方法：查找最后一个斜杠
        const lastSlashIndex = urlStr.lastIndexOf('/');
        if (lastSlashIndex > urlStr.indexOf('://') + 2) { // 确保不是协议部分的斜杠
            return urlStr.substring(0, lastSlashIndex + 1);
        }
        return urlStr + '/'; // 如果没有路径，添加斜杠
    }
}

function resolveUrl(baseUrl, relativeUrl) {
    if (!relativeUrl) return ''; // 处理空的 relativeUrl
    if (relativeUrl.match(/^https?:\/\/.+/i)) {
        return relativeUrl; // 已经是绝对 URL
    }
    if (!baseUrl) return relativeUrl; // 没有基础 URL 无法解析

    try {
        // 使用 Node.js 的 URL 构造函数处理相对路径
        return new URL(relativeUrl, baseUrl).toString();
    } catch (e) {
        logDebug(`URL 解析失败: base="${baseUrl}", relative="${relativeUrl}". 错误: ${e.message}`);
        // 简单的备用逻辑
        if (relativeUrl.startsWith('/')) {
             try {
                const baseOrigin = new URL(baseUrl).origin;
                return `${baseOrigin}${relativeUrl}`;
             } catch { return relativeUrl; } // 如果 baseUrl 也无效，返回原始相对路径
        } else {
            // 假设相对于包含基础 URL 资源的目录
            return `${baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1)}${relativeUrl}`;
        }
    }
}

// ** 已修正：确保生成 /proxy/ 前缀的链接 **
function rewriteUrlToProxy(targetUrl) {
    if (!targetUrl || typeof targetUrl !== 'string') return '';
    // 返回与 vercel.json 的 "source" 和前端 PROXY_URL 一致的路径
    return `/proxy/${encodeURIComponent(targetUrl)}`;
}

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// 构建转发到上游的请求头
function buildUpstreamHeaders(targetUrl, requestHeaders) {
    const headers = {
        'User-Agent': getRandomUserAgent(),
        'Accept': requestHeaders['accept'] || '*/*', // 传递原始 Accept 头（如果有）
        'Accept-Language': requestHeaders['accept-language'] || 'zh-CN,zh;q=0.9,en;q=0.8',
        // 尝试设置一个合理的 Referer
        'Referer': requestHeaders['referer'] || new URL(targetUrl).origin,
    };
    // 豆瓣图片CDN防盗链：必须携带豆瓣站内 Referer，否则按 URL 确定性返回 418/403
    if (/doubanio\.com|douban\.com/i.test(targetUrl)) {
        headers['Referer'] = 'https://movie.douban.com/';
    }
    // 清理空值的头
    Object.keys(headers).forEach(key => headers[key] === undefined || headers[key] === null || headers[key] === '' ? delete headers[key] : {});
    return headers;
}

// 请求上游（30s 超时保护，防止慢源挂死函数占满 maxDuration 预算）
// 注意：使用手动 AbortController + setTimeout 而非 AbortSignal.timeout——
// 后者需要 Node 17.3+，旧版运行时上不存在会导致所有代理请求崩溃
async function fetchUpstream(targetUrl, requestHeaders) {
    const headers = buildUpstreamHeaders(targetUrl, requestHeaders);
    logDebug(`准备请求目标: ${targetUrl}，请求头: ${JSON.stringify(headers)}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let response;
    try {
        response = await fetch(targetUrl, {
            headers,
            redirect: 'follow',
            signal: controller.signal
        });
    } catch (error) {
        const err = new Error(`连接目标 URL 失败 ${targetUrl}: ${error.message}`);
        throw err;
    } finally {
        clearTimeout(timer);
    }

    // 检查响应是否成功
    if (!response.ok) {
        const errorBody = await response.text().catch(() => ''); // 尝试获取错误响应体
        logDebug(`请求失败: ${response.status} ${response.statusText} - ${targetUrl}`);
        // 创建一个包含状态码的错误对象
        const err = new Error(`HTTP 错误 ${response.status}: ${response.statusText}. URL: ${targetUrl}. Body: ${errorBody.substring(0, 200)}`);
        err.status = response.status; // 将状态码附加到错误对象
        throw err; // 抛出错误
    }

    return response;
}

// 全量缓冲请求（m3u8 处理与二进制转发统一路径：先缓冲再嗅探，与原版行为一致）
async function fetchContentWithType(targetUrl, requestHeaders) {
    try {
        const response = await fetchUpstream(targetUrl, requestHeaders);
        // 以二进制读取响应（视频分片等二进制内容绝不能用 text() 读取，否则数据损坏）
        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get('content-type') || '';
        logDebug(`请求成功: ${targetUrl}, Content-Type: ${contentType}, 内容长度: ${buffer.length}`);
        // 返回结果
        return { buffer, contentType, responseHeaders: response.headers };
    } catch (error) {
        // 捕获 fetch 本身的错误（网络、超时等）或上面抛出的 HTTP 错误
        logDebug(`请求异常 ${targetUrl}: ${error.message}`);
        // 重新抛出，确保包含原始错误信息
        throw new Error(`请求目标 URL 失败 ${targetUrl}: ${error.message}`);
    }
}

// 判断 Buffer 内容是否为 M3U8（优先看 Content-Type，再看文件头——
// 很多采集站 CDN 用 application/octet-stream 提供 m3u8，必须嗅探内容）
function isM3u8Buffer(buffer, contentType) {
    if (contentType && (contentType.includes('mpegurl'))) {
        return true;
    }
    if (!buffer || buffer.length < 7) {
        return false;
    }
    return buffer.subarray(0, 64).toString('utf8').trimStart().startsWith('#EXTM3U');
}

function isM3u8Content(content, contentType) {
    if (contentType && (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl') || contentType.includes('audio/mpegurl'))) {
        return true;
    }
    return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
}

function processKeyLine(line, baseUrl) {
    return line.replace(/URI="([^"]+)"/, (match, uri) => {
        const absoluteUri = resolveUrl(baseUrl, uri);
        logDebug(`处理 KEY URI: 原始='${uri}', 绝对='${absoluteUri}'`);
        return `URI="${rewriteUrlToProxy(absoluteUri)}"`;
    });
}

function processMapLine(line, baseUrl) {
     return line.replace(/URI="([^"]+)"/, (match, uri) => {
        const absoluteUri = resolveUrl(baseUrl, uri);
        logDebug(`处理 MAP URI: 原始='${uri}', 绝对='${absoluteUri}'`);
        return `URI="${rewriteUrlToProxy(absoluteUri)}"`;
     });
 }

function processMediaPlaylist(url, content) {
    const baseUrl = getBaseUrl(url);
    if (!baseUrl) {
        logDebug(`无法确定媒体列表的 Base URL: ${url}，相对路径可能无法处理。`);
    }
    const lines = content.split('\n');
    const output = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // 保留最后一个空行
        if (!line && i === lines.length - 1) { output.push(line); continue; }
        if (!line) continue; // 跳过中间空行
        // 广告过滤已禁用
        if (line.startsWith('#EXT-X-KEY')) { output.push(processKeyLine(line, baseUrl)); continue; }
        if (line.startsWith('#EXT-X-MAP')) { output.push(processMapLine(line, baseUrl)); continue; }
        if (line.startsWith('#EXTINF')) { output.push(line); continue; }
        // 处理 URL 行
        if (!line.startsWith('#')) {
            const absoluteUrl = resolveUrl(baseUrl, line);
            logDebug(`重写媒体片段: 原始='${line}', 解析后='${absoluteUrl}'`);
            output.push(rewriteUrlToProxy(absoluteUrl)); continue;
        }
        // 保留其他 M3U8 标签
        output.push(line);
    }
    return output.join('\n');
}

// 主播放列表：透传多码率（不再服务端选最高码率、不再二次 fetch 子列表）
// 标准重写所有变体/音轨 URI 为代理路径后原样输出整个主列表：
//   - 起播减少一次串行上游往返
//   - hls.js 恢复 ABR 自适应（弱网自动降档）
//   - 前端清晰度菜单恢复生效
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

function processM3u8Content(targetUrl, content) {
    // 判断是主列表还是媒体列表
    if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) {
        logDebug(`检测到主播放列表: ${targetUrl}`);
        return processMasterPlaylist(targetUrl, content);
    }
    logDebug(`检测到媒体播放列表: ${targetUrl}`);
    return processMediaPlaylist(targetUrl, content);
}

// 二进制响应头过滤：
// 排除 CORS（已显式设置）、已解压/需自定的头，并剔除干扰 Vercel 边缘缓存判定的头
// （Vary 会碎片化缓存键、Set-Cookie 会直接禁用边缘缓存、Expires/Pragma 干扰缓存决策）
function applyFilteredUpstreamHeaders(res, responseHeaders) {
    responseHeaders.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (!lowerKey.startsWith('access-control-') &&
            lowerKey !== 'content-encoding' && // node-fetch 已解压，原头不再适用
            lowerKey !== 'content-length' &&   // 由实际转发内容决定
            lowerKey !== 'transfer-encoding' &&
            lowerKey !== 'content-type' &&     // 显式设置，避免缺失
            lowerKey !== 'vary' &&             // 碎片化边缘缓存键
            lowerKey !== 'set-cookie' &&       // 直接禁用边缘缓存
            lowerKey !== 'cache-control' &&    // 用我们自己的缓存策略
            lowerKey !== 'expires' &&
            lowerKey !== 'pragma') {
            res.setHeader(key, value);
        }
    });
}

// --- Vercel Handler 函数 ---
// 函数最大执行时长（Hobby 计划上限 60s）：大视频分片转发需要足够时间
export const maxDuration = 60;

export default async function handler(req, res) {
    logDebug(`--- 代理请求: ${req.method} ${req.url}`);

    // --- 提前设置 CORS 头 ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*'); // 允许所有请求头

    // --- 处理 OPTIONS 预检请求 ---
    if (req.method === 'OPTIONS') {
        // 注意：不使用链式调用（Node 原生 removeHeader/setHeader 返回值不保证可链）
        res.status(204);
        res.setHeader('Access-Control-Max-Age', '86400'); // 缓存预检结果 24 小时
        res.end();
        return;
    }

    let targetUrl = null; // 初始化目标 URL

    try { // ---- 开始主处理逻辑的 try 块 ----

        // --- 提取目标 URL (主要依赖 req.query["...path"]) ---
        // Vercel 将 :path* 捕获的内容（可能包含斜杠）放入 req.query["...path"] 数组
        const pathData = req.query["...path"]; // 使用正确的键名
        let encodedUrlPath = '';

        if (pathData) {
            if (Array.isArray(pathData)) {
                encodedUrlPath = pathData.join('/'); // 重新组合
            } else if (typeof pathData === 'string') {
                encodedUrlPath = pathData; // 也处理 Vercel 可能只返回字符串的情况
            } else {
                logDebug(`[代理警告] req.query["...path"] 类型未知: ${typeof pathData}`);
            }
        } else {
            logDebug(`[代理警告] req.query["...path"] 为空或未定义。`);
            // 备选：尝试从 req.url 提取（如果需要）
            if (req.url && req.url.startsWith('/proxy/')) {
                encodedUrlPath = req.url.substring('/proxy/'.length);
            }
        }

        // 如果仍然为空，则无法继续
        if (!encodedUrlPath) {
             throw new Error("无法从请求中确定编码后的目标路径。");
        }

        // 解析目标 URL
        targetUrl = getTargetUrlFromPath(encodedUrlPath);

        // 检查目标 URL 是否有效
        if (!targetUrl) {
            // 抛出包含更多上下文的错误
            throw new Error(`无效的代理请求路径。无法从组合路径 "${encodedUrlPath}" 中提取有效的目标 URL。`);
        }

        logDebug(`开始处理目标 URL 的代理请求: ${targetUrl}`);

        // --- 获取并全量缓冲目标内容（与原版一致：先缓冲，再按内容嗅探） ---
        const { buffer, contentType, responseHeaders } = await fetchContentWithType(targetUrl, req.headers);

        // --- 内容嗅探判断是否 M3U8（文件头/Content-Type，不依赖 URL 后缀） ---
        // 注意：不能按 URL 预判——部分 CDN 用 application/octet-stream 且无 .m3u8
        // 后缀提供主/子播放列表，按 URL 预判会把 m3u8 当二进制原样透传，
        // 内部 URL 得不到重写，多档位列表与代理回放全挂。
        if (isM3u8Buffer(buffer, contentType)) {
            const content = buffer.toString('utf8');
            // 内存缓存命中直接返回，跳过逐行重写
            let processedM3u8 = getM3u8Cache(targetUrl);
            if (processedM3u8 === null) {
                processedM3u8 = processM3u8Content(targetUrl, content);
                setM3u8Cache(targetUrl, processedM3u8);
            }

            logDebug(`成功处理 M3U8: ${targetUrl}`);
            // 发送处理后的 M3U8 响应（分步调用，不依赖链式返回值）
            res.removeHeader('content-encoding'); // 很重要！node-fetch 已解压，原头不再适用
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl;charset=utf-8');
            // m3u8 短缓存：避免换源/动态列表拿到陈旧缓存（ts 分片保持长缓存）
            res.setHeader('Cache-Control', `public, max-age=${M3U8_CACHE_TTL}`);
            // 显式声明内容长度：避免分块流式发送。某些设备网络栈对
            // 分块(chunked)响应的"结束块"识别有异常，会一直等不到结尾而挂起超时
            res.setHeader('Content-Length', String(Buffer.byteLength(processedM3u8)));
            res.status(200);
            res.send(processedM3u8); // 发送 M3U8 文本

        } else {
            // --- 非 M3U8（视频分片、图片、HTML、JSON 等）：按二进制原样转发 ---
            logDebug(`直接返回非 M3U8 内容: ${targetUrl}, 类型: ${contentType}, 大小: ${buffer.length}`);

            // 响应头过滤（剔除 Vary/Set-Cookie 等干扰边缘缓存的头，保证 /proxy/* 可被 Vercel 边缘缓存命中）
            applyFilteredUpstreamHeaders(res, responseHeaders);
            res.setHeader('Content-Type', contentType || 'application/octet-stream');
            // 设置我们自己的缓存策略（ts 分片内容不变，长缓存 + 边缘缓存）
            res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`);
            // 显式声明内容长度（见上方注释）：避免分块流式，兼容收不到分块结束信号的设备
            res.setHeader('Content-Length', String(buffer.length));

            // 以二进制发送原始内容（切勿转成字符串，否则视频数据损坏）
            res.status(200);
            res.send(buffer);
        }

    // ---- 结束主处理逻辑的 try 块 ----
    } catch (error) { // ---- 捕获处理过程中的任何错误 ----
        console.error(`[代理错误] 目标: ${targetUrl || '解析失败'} | ${error.message}`);
        logDebug(`[代理错误堆栈] ${error.stack}`);

        // 尝试从错误对象获取状态码，否则默认为 500
        const statusCode = error.status || 500;

        // 确保在发送错误响应前没有发送过响应头
        if (!res.headersSent) {
             res.setHeader('Content-Type', 'application/json');
             // CORS 头应该已经在前面设置好了
             res.status(statusCode);
             res.json({
                success: false,
                error: `代理处理错误: ${error.message}`, // 返回错误消息给前端
                targetUrl: targetUrl, // 包含目标 URL 以便调试
                details: errorDetails(error) // 底层详细原因链（供连接测试诊断）
            });
        } else {
            // 如果响应头已发送，无法再发送 JSON 错误
            logDebug("[代理错误] 响应头已发送，无法发送 JSON 错误响应。");
            // 尝试结束响应
             if (!res.writableEnded) {
                 res.end();
             }
        }
    } finally {
        logDebug('--- 代理请求结束 ---');
    }
}
