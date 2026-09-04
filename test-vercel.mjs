// 把 Vercel serverless 函数适配到本地 Node http server，用真实剧集 URL 实测
import http from 'http';
import handler from './tmp-proxy-vercel-test.mjs';

const server = http.createServer(async (req, res) => {
    // 适配 Express 风格 req/res（Vercel Node 运行时包装）
    const u = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(u.searchParams.entries());
    // 模拟 Vercel：把 /api/proxy/ 后的路径段放入 req.query['...path']
    const m = req.url.match(/^\/api\/proxy\/(.+)$/);
    if (m) {
        // Vercel 对 catch-all 参数按原始路径 '/' 分段（%2F 不分段），decode 后 join
        const raw = m[1];
        const decoded = decodeURIComponent(raw);
        const segs = decoded.split('/').filter(s => s !== '');
        req.query['...path'] = segs.length > 1 ? segs : raw;
    }
    res.set = (k, v) => res.setHeader(k, v);
    res.removeHeader = (k) => res.removeHeader(k);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    res.send = (b) => res.end(b);
    await handler(req, res);
});

server.listen(8898, async () => {
    const BASE = 'http://localhost:8898';
    const PROXY_URL = '/proxy/';
    function resolveM3u8Url(base, relative) {
        try { return new URL(relative, base).href; } catch { return relative; }
    }
    // 当前仓库修复后的客户端逻辑
    async function newFetch(url, depth = 0) {
        try {
            const requestUrl = url.startsWith(PROXY_URL) ? url : PROXY_URL + encodeURIComponent(url);
            const resp = await fetch(BASE + requestUrl);
            if (!resp.ok) { console.log('  [resp not ok]', resp.status, await resp.text().then(t => t.slice(0, 100)).catch(() => '')); return null; }
            const text = await resp.text();
            if (!text.includes('#EXTM3U')) { console.log('  [not m3u8]', JSON.stringify(text.slice(0, 100))); return null; }
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
            const re = /#EXTINF:([\d.]+)/g; let mm;
            while ((mm = re.exec(text)) !== null) { total += parseFloat(mm[1]); found = true; }
            return found ? total : null;
        } catch (e) { console.log('  [err]', e.message); return null; }
    }

    const eps = [
        ['bfzy(直连媒体列表)', 'https://s2.bfllvip.com/video/zaijianairenzhichuguideta/17b2ca6031ae/index.m3u8'],
        ['mdzy(主列表)', 'https://play.modujx11.com/20251016/FTjJMoqq/index.m3u8'],
        ['ruyi(主列表)', 'https://svip.ryplay17.com/20251018/7148_02c2f827/index.m3u8'],
        ['zuid(主列表)', 'https://v14.zuidazym3u8.com/yyv14/202510/16/W4upc6eGP322/video/index.m3u8'],
        ['360zy(主列表)', 'https://vod1.maowushi.com/20251016/AalxRFv9/index.m3u8'],
    ];
    for (const [name, url] of eps) {
        const r = await newFetch(url);
        console.log(`${name}: ${r == null ? '失败' : Math.round(r / 60) + '分' + Math.round(r % 60) + '秒'}`);
    }
    // 顺便打印代理返回的主列表原文，确认重写形态
    const resp = await fetch(BASE + PROXY_URL + encodeURIComponent(eps[1][1]));
    console.log('\nmdzy 主列表经 Vercel 代理返回的原文:');
    console.log((await resp.text()).split('\n').slice(0, 6).join('\n'));
    process.exit(0);
});
