// 离线测 Vercel 代理的核心差异：processM3u8Content 重写逻辑 + 客户端新旧逻辑
// 用 axios（走 server.mjs 已验证可通）拉真实列表，再喂给从 api/proxy/[...path].mjs 原样拷贝的重写函数
import axios from 'axios';

// ===== 以下三个函数原样拷贝自 api/proxy/[...path].mjs（仅 logDebug 置空）=====
const logDebug = () => {};
function getBaseUrl(urlStr) {
    if (!urlStr) return '';
    try {
        const parsedUrl = new URL(urlStr);
        const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
        if (pathSegments.length <= 1) return `${parsedUrl.origin}/`;
        pathSegments.pop();
        return `${parsedUrl.origin}/${pathSegments.join('/')}/`;
    } catch (e) { return urlStr + '/'; }
}
function resolveUrl(baseUrl, relativeUrl) {
    if (!relativeUrl) return '';
    if (relativeUrl.match(/^https?:\/\/.+/i)) return relativeUrl;
    if (!baseUrl) return relativeUrl;
    try { return new URL(relativeUrl, baseUrl).toString(); }
    catch (e) {
        if (relativeUrl.startsWith('/')) { try { return new URL(baseUrl).origin + relativeUrl; } catch { return relativeUrl; } }
        return `${baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1)}${relativeUrl}`;
    }
}
function rewriteUrlToProxy(targetUrl) {
    if (!targetUrl || typeof targetUrl !== 'string') return '';
    return `/proxy/${encodeURIComponent(targetUrl)}`;
}
function processKeyLine(line, baseUrl) { return line.replace(/URI="([^"]+)"/, (m, uri) => `URI="${rewriteUrlToProxy(resolveUrl(baseUrl, uri))}"`); }
function processMapLine(line, baseUrl) { return line.replace(/URI="([^"]+)"/, (m, uri) => `URI="${rewriteUrlToProxy(resolveUrl(baseUrl, uri))}"`); }
function processMediaPlaylist(url, content) {
    const baseUrl = getBaseUrl(url);
    const lines = content.split('\n');
    const output = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line && i === lines.length - 1) { output.push(line); continue; }
        if (!line) continue;
        if (line.startsWith('#EXT-X-KEY')) { output.push(processKeyLine(line, baseUrl)); continue; }
        if (line.startsWith('#EXT-X-MAP')) { output.push(processMapLine(line, baseUrl)); continue; }
        if (line.startsWith('#EXTINF')) { output.push(line); continue; }
        if (!line.startsWith('#')) { output.push(rewriteUrlToProxy(resolveUrl(baseUrl, line))); continue; }
        output.push(line);
    }
    return output.join('\n');
}
function processMasterPlaylist(url, content) {
    const baseUrl = getBaseUrl(url);
    const lines = content.split('\n');
    const output = [];
    let expectUri = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) { if (i === lines.length - 1) output.push(line); continue; }
        if (expectUri && !line.startsWith('#')) {
            output.push(rewriteUrlToProxy(resolveUrl(baseUrl, line)));
            expectUri = false;
            continue;
        }
        expectUri = false;
        if (line.startsWith('#EXT-X-STREAM-INF')) { output.push(line); expectUri = true; continue; }
        if (line.startsWith('#EXT-X-MEDIA')) {
            output.push(line.replace(/URI="([^"]+)"/, (m, uri) => `URI="${rewriteUrlToProxy(resolveUrl(baseUrl, uri))}"`));
            continue;
        }
        if (!line.startsWith('#')) { output.push(rewriteUrlToProxy(resolveUrl(baseUrl, line))); continue; }
        output.push(line);
    }
    return output.join('\n');
}
function processM3u8Content(targetUrl, content) {
    if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) return processMasterPlaylist(targetUrl, content);
    return processMediaPlaylist(targetUrl, content);
}
// ===== 拷贝结束 =====

const PROXY_URL = '/proxy/';
function resolveM3u8Url(base, relative) {
    try { return new URL(relative, base).href; } catch { return relative; }
}

async function fetchRaw(url) {
    const r = await axios.get(url, { timeout: 15000, responseType: 'text', transformResponse: x => x, headers: { 'User-Agent': 'Mozilla/5.0' } });
    return r.data;
}

// 模拟"经 Vercel 代理"返回的内容
async function fetchViaVercelProxy(url) {
    // 客户端传来的可能是代理路径 /proxy/<encoded>，本地模拟时解码回真实地址
    const realUrl = url.startsWith(PROXY_URL) ? decodeURIComponent(url.slice(PROXY_URL.length)) : url;
    const raw = await fetchRaw(realUrl);
    if (!raw.includes('#EXTM3U')) throw new Error('not m3u8: ' + raw.slice(0, 80));
    return processM3u8Content(realUrl, raw);
}

// 旧版客户端逻辑（修复前）
async function oldDetect(url) {
    const text = await fetchViaVercelProxy(url);
    if (!text.includes('#EXTM3U')) return null;
    if (text.includes('#EXT-X-STREAM-INF')) {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
            for (let j = i + 1; j < lines.length; j++) {
                const line = lines[j].trim();
                if (!line || line.startsWith('#')) continue;
                return { next: resolveM3u8Url(url, line) };
            }
        }
    }
    let total = 0, found = false;
    const re = /#EXTINF:([\d.]+)/g; let m;
    while ((m = re.exec(text)) !== null) { total += parseFloat(m[1]); found = true; }
    return found ? { total } : null;
}

// 新版客户端逻辑（修复后）
async function newDetect(url, depth = 0) {
    const text = await fetchViaVercelProxy(url);
    if (!text.includes('#EXTM3U')) return null;
    if (text.includes('#EXT-X-STREAM-INF')) {
        if (depth >= 1) return null;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
            for (let j = i + 1; j < lines.length; j++) {
                const line = lines[j].trim();
                if (!line || line.startsWith('#')) continue;
                const nextUrl = line.startsWith(PROXY_URL) ? line : resolveM3u8Url(url, line);
                return newDetect(nextUrl, depth + 1);
            }
        }
        return null;
    }
    let total = 0, found = false;
    const re = /#EXTINF:([\d.]+)/g; let m;
    while ((m = re.exec(text)) !== null) { total += parseFloat(m[1]); found = true; }
    return found ? total : null;
}

const eps = [
    ['bfzy(直连媒体列表)', 'https://s2.bfllvip.com/video/zaijianairenzhichuguideta/17b2ca6031ae/index.m3u8'],
    ['mdzy(主列表)', 'https://play.modujx11.com/20251016/FTjJMoqq/index.m3u8'],
    ['ruyi(主列表)', 'https://svip.ryplay17.com/20251018/7148_02c2f827/index.m3u8'],
    ['zuid(主列表)', 'https://v14.zuidazym3u8.com/yyv14/202510/16/W4upc6eGP322/video/index.m3u8'],
    ['360zy(主列表)', 'https://vod1.maowushi.com/20251016/AalxRFv9/index.m3u8'],
];

for (const [name, url] of eps) {
    // 旧逻辑：主列表解析出 next 后，旧代码会去请求 resolveM3u8Url(url, '/proxy/...') 得到的错误地址
    const o = await oldDetect(url);
    let oldResult = null;
    if (o && o.total != null) oldResult = o.total;
    else if (o && o.next) {
        // 模拟旧代码对错误 next 地址发起请求（这里直接判断其可达性）
        try {
            const bad = await fetchRaw(o.next);
            oldResult = bad.includes('#EXTM3U') ? '意外可达' : '非m3u8';
        } catch (e) { oldResult = `请求失败(${e.code || e.message.slice(0, 30)})`; }
    }
    const n = await newDetect(url);
    const fmt = s => s == null ? '失败' : (typeof s === 'number' ? Math.round(s / 60) + '分' + Math.round(s % 60) + '秒' : s);
    console.log(`${name}\n  旧逻辑: ${fmt(oldResult)}   新逻辑: ${fmt(n)}`);
}
process.exit(0);
