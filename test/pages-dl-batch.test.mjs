// Cloudflare Pages 批量取件函数自测（Node 直接 import，无网络、无 wrangler）
// 运行：node test/pages-dl-batch.test.mjs
//
// 锁住 protocols：前端 js/downloader.js 的 fetchSegBatch 按 x-wdtv-status / x-wdtv-size
// 切分响应体，本地 server.mjs 与 functions/dl-batch.js 必须给出完全一致的协议。
import { onRequestPost, onRequestOptions } from '../functions/dl-batch.js';

let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
    if (cond) { pass++; console.log('  ok  ' + name); }
    else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

const origin = 'https://wdtv.example.com';
const post = (body, referer) => {
    const headers = { 'content-type': 'application/json' };
    if (referer !== null) headers.referer = referer === undefined ? origin + '/player.html' : referer;
    return new Request(origin + '/dl-batch', { method: 'POST', headers, body: JSON.stringify(body) });
};

// 上游假响应：按 URL 里的 size 参数返回对应字节数
const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (target) => {
    calls.push(target);
    const u = String(target);
    const m = /size=(\d+)/.exec(u);
    if (u.includes('fail=1')) return new Response('nope', { status: 404 });
    const n = m ? parseInt(m[1], 10) : 10;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i + u.length) % 251;
    return new Response(bytes, { status: 200, headers: { 'content-length': String(n) } });
};

console.log('\n[1] 协议：状态/长度头 + 拼接顺序，与本地 server.mjs 一致');
{
    calls.length = 0;
    const urls = [
        'https://cdn-a.example.com/a.ts?size=6',
        'https://cdn-a.example.com/b.ts?size=0',
        'https://cdn-a.example.com/c.ts?size=4'
    ];
    const resp = await onRequestPost({ request: post({ urls }) });
    const buf = new Uint8Array(await resp.arrayBuffer());
    t('HTTP 200', resp.status === 200, String(resp.status));
    t('x-wdtv-status 逐项对齐', resp.headers.get('x-wdtv-status') === '200,200,200', resp.headers.get('x-wdtv-status'));
    t('x-wdtv-size 逐项对齐', resp.headers.get('x-wdtv-size') === '6,0,4', resp.headers.get('x-wdtv-size'));
    t('x-wdtv-clen 供前端做截断校验', resp.headers.get('x-wdtv-clen') === '6,0,4', resp.headers.get('x-wdtv-clen'));
    t('响应体为各片字节顺序拼接', buf.byteLength === 10, String(buf.byteLength));
    t('上游按顺序各请求一次', calls.length === 3, JSON.stringify(calls));
}

console.log('\n[2] 失败项：状态 0 + 长度 0，前端据此回退逐片');
{
    const urls = ['https://cdn-b.example.com/ok.ts?size=5', 'https://cdn-b.example.com/bad.ts?fail=1'];
    const resp = await onRequestPost({ request: post({ urls }) });
    const buf = new Uint8Array(await resp.arrayBuffer());
    t('上游 404 记为 0', resp.headers.get('x-wdtv-status') === '200,0', resp.headers.get('x-wdtv-status'));
    t('失败项不占字节', resp.headers.get('x-wdtv-size') === '5,0', resp.headers.get('x-wdtv-size'));
    t('只返回成功片字节', buf.byteLength === 5, String(buf.byteLength));
}

console.log('\n[3] 同源校验与 SSRF 守卫');
{
    const okReq = post({ urls: ['https://cdn-c.example.com/a.ts?size=3'] }, 'https://evil.example.net/x');
    const r403 = await onRequestPost({ request: okReq });
    t('跨站 Referer → 403', r403.status === 403, String(r403.status));

    const noRef = await onRequestPost({ request: post({ urls: ['https://cdn-c.example.com/a.ts?size=3'] }, null) });
    t('无 Referer（PWA/WebView）放行', noRef.status === 200, String(noRef.status));

    const blocked = await onRequestPost({ request: post({ urls: ['http://127.0.0.1/a.ts', 'http://192.168.1.2/b.ts'] }) });
    t('内网/回环地址全部拒绝 → 400', blocked.status === 400, String(blocked.status));

    const mixed = await onRequestPost({ request: post({ urls: ['http://10.0.0.5/x.ts', 'https://cdn-c.example.com/ok.ts?size=2'] }) });
    const s = mixed.headers.get('x-wdtv-status');
    t('内网项被剔除，公网项照常取回', mixed.status === 200 && s === '200', s);
}

console.log('\n[4] 边界：空列表 / 非法方法 / 预检');
{
    const empty = await onRequestPost({ request: post({ urls: [] }) });
    t('空列表 → 400', empty.status === 400, String(empty.status));

    const junk = await onRequestPost({ request: new Request(origin + '/dl-batch', { method: 'POST', body: 'not json' }) });
    t('非法 JSON → 400', junk.status === 400, String(junk.status));

    const opt = await onRequestOptions();
    t('OPTIONS 预检 204', opt.status === 204, String(opt.status));
}

globalThis.fetch = realFetch;
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：' + fails.join(' / ')); process.exit(1); }
