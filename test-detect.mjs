// 决定性复现：真实剧集 URL × 真实 server.mjs 代理 × js/api.js 客户端逻辑（旧版 vs 新版）
const BASE = 'http://localhost:8899';   // 本地 server.mjs（Render/Docker 部署路径）
const PROXY_URL = '/proxy/';

function resolveM3u8Url(base, relative) {
    try { return new URL(relative, base).href; } catch { return relative; }
}

// ===== js/api.js 修复前（旧版）=====
async function oldFetch(url, depth = 0) {
    try {
        const resp = await fetch(BASE + PROXY_URL + encodeURIComponent(url));
        if (!resp.ok) return null;
        const text = await resp.text();
        if (!text.includes('#EXTM3U')) return null;
        if (text.includes('#EXT-X-STREAM-INF')) {
            if (depth >= 1) return null;
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
                for (let j = i + 1; j < lines.length; j++) {
                    const line = lines[j].trim();
                    if (!line || line.startsWith('#')) continue;
                    return await oldFetch(resolveM3u8Url(url, line), depth + 1);
                }
            }
            return null;
        }
        let total = 0, found = false;
        const re = /#EXTINF:([\d.]+)/g; let m;
        while ((m = re.exec(text)) !== null) { total += parseFloat(m[1]); found = true; }
        return found ? total : null;
    } catch (e) { console.log('  [old-err]', e.message); return null; }
}

// ===== js/api.js 修复后（新版，当前仓库代码）=====
async function newFetch(url, depth = 0) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        let resp;
        try {
            const requestUrl = url.startsWith(PROXY_URL) ? url : PROXY_URL + encodeURIComponent(url);
            resp = await fetch(BASE + requestUrl, { signal: controller.signal });
        } finally { clearTimeout(timer); }
        if (!resp.ok) { console.log('  [new] resp not ok:', resp.status); return null; }
        const text = await resp.text();
        if (!text.includes('#EXTM3U')) { console.log('  [new] not m3u8, first 80 chars:', JSON.stringify(text.slice(0, 80))); return null; }
        if (text.includes('#EXT-X-STREAM-INF')) {
            if (depth >= 1) return null;
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
                for (let j = i + 1; j < lines.length; j++) {
                    const line = lines[j].trim();
                    if (!line || line.startsWith('#')) continue;
                    const nextUrl = line.startsWith(PROXY_URL) ? line : resolveM3u8Url(url, line);
                    return await newFetch(nextUrl, depth + 1);
                }
            }
            return null;
        }
        let total = 0, found = false;
        const re = /#EXTINF:([\d.]+)/g; let m;
        while ((m = re.exec(text)) !== null) { total += parseFloat(m[1]); found = true; }
        return found ? total : null;
    } catch (e) { console.log('  [new-err]', e.message); return null; }
}

const eps = [
    ['bfzy(直连媒体列表)', 'https://s2.bfllvip.com/video/zaijianairenzhichuguideta/17b2ca6031ae/index.m3u8'],
    ['mdzy(主列表)', 'https://play.modujx11.com/20251016/FTjJMoqq/index.m3u8'],
    ['ruyi(主列表)', 'https://svip.ryplay17.com/20251018/7148_02c2f827/index.m3u8'],
    ['zuid(主列表)', 'https://v14.zuidazym3u8.com/yyv14/202510/16/W4upc6eGP322/video/index.m3u8'],
    ['360zy(主列表)', 'https://vod1.maowushi.com/20251016/AalxRFv9/index.m3u8'],
];

for (const [name, url] of eps) {
    const o = await oldFetch(url);
    const n = await newFetch(url);
    const fmt = s => s == null ? '失败' : Math.round(s / 60) + '分' + Math.round(s % 60) + '秒';
    console.log(`${name}\n  旧逻辑: ${fmt(o)}   新逻辑: ${fmt(n)}`);
}
process.exit(0);
