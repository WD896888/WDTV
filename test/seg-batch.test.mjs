// 批量取件客户端自测（Node，无网络）：js/seg-batch.js
// 运行：node test/seg-batch.test.mjs
//
// 这份协议被三处共用：整集下载器、播放缓存预取、服务端（server.mjs / functions/dl-batch.js）。
// 这里锁住客户端的切分/校验/降级行为，服务端侧见 pages-dl-batch.test.mjs。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
    if (cond) { pass++; console.log('  ok  ' + name); }
    else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

const ORIGIN = 'http://localhost:8080';
globalThis.location = { href: ORIGIN + '/player.html', origin: ORIGIN, protocol: 'http:' };
// 页面里 PROXY_URL 是 config.js 的 const（全局词法）；这里挂到 globalThis 模拟
globalThis.PROXY_URL = '/proxy/';
await import('../js/seg-batch.js');
const B = globalThis.WDTVSegBatch;

console.log('\n[1] 模块与地址归一化');
{
    t('WDTVSegBatch 已挂载', !!B && typeof B.fetch === 'function' && typeof B.supported === 'function');
    const inner = 'https://v11.ppqrrs.com/a/b/0.ts?sign=1';
    const proxied = '/proxy/' + encodeURIComponent(inner) + '?wdtv_m3u8_rw=1';
    t('代理形态解包成上游真实地址', B.batchUrlOf(proxied) === inner, B.batchUrlOf(proxied));
    t('直连地址原样透传', B.batchUrlOf(inner) === inner);
    t('默认可用', B.supported() === true);
}

// 假服务端：按 x-wdtv-* 头切分；body 为 3 片顺序拼接
const calls = [];
globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), signal: init.signal });
    return {
        ok: true, status: 200,
        headers: {
            get: (k) => {
                if (k === 'x-wdtv-status') return '200,200,404';
                if (k === 'x-wdtv-size') return '3,2,0';
                if (k === 'x-wdtv-clen') return '3,2,0';
                return null;
            }
        },
        arrayBuffer: async () => new Uint8Array([9, 9, 9, 8, 8]).buffer
    };
};

console.log('\n[2] 请求与切分');
{
    calls.length = 0;
    const urls = ['https://a.com/0.ts', 'https://a.com/1.ts', 'https://a.com/2.ts'];
    const parts = await B.fetch(urls, {});
    t('打到 /dl-batch', calls[0].url === '/dl-batch', calls[0].url);
    t('请求体原样带上地址', JSON.stringify(calls[0].body.urls) === JSON.stringify(urls));
    t('按 x-wdtv-size 顺序切分', parts[0].buf.byteLength === 3 && parts[1].buf.byteLength === 2, parts.map(p => p && p.buf.byteLength).join(','));
    t('带出上游声明长度（截断校验用）', parts[0].clen === 3 && parts[1].clen === 2);
    t('失败片返回 null', parts[2] === null);
    t('字节内容对应各自区间', new Uint8Array(parts[1].buf)[0] === 8);
    t('条数上限 6', B.MAX_URLS === 6);
}

console.log('\n[3] 中止与参数校验');
{
    const aborted = AbortSignal.abort();
    let err = null;
    try { await B.fetch(['https://a.com/0.ts'], { signal: aborted }); } catch (e) { err = e; }
    t('已中止的信号立即拒绝', !!err && (err.name === 'AbortError' || /abort/i.test(err.message)), err && (err.name || err.message));

    const empty = await B.fetch([], {});
    t('空列表直接返回空数组（不发请求）', Array.isArray(empty) && empty.length === 0);
}

console.log('\n[4] 接口缺失 → 永久停用（前端据此退回逐片）');
{
    globalThis.fetch = async () => ({ ok: false, status: 404, headers: { get: () => null } });
    let err = null;
    try { await B.fetch(['https://a.com/0.ts'], {}); } catch (e) { err = e; }
    t('404 抛错且标记 permanent', !!err && err.permanent === true, err && err.message);
    t('停用后 supported() 为 false', B.supported() === false);
    let err2 = null;
    try { await B.fetch(['https://a.com/0.ts'], {}); } catch (e) { err2 = e; }
    t('后续调用直接拒绝（不再白撞网络）', !!err2 && /停用/.test(err2.message), err2 && err2.message);
}

console.log('\n[5] 页面接入：必须先于使用方加载，且已登记版本号');
{
    for (const f of ['index.html', 'player.html']) {
        const s = read(f);
        const iSeg = s.indexOf('js/seg-batch.js');
        const iVc = s.indexOf('js/video-cache.js');
        const iDl = s.indexOf('js/downloader.js');
        t(`${f} 引入 seg-batch 且早于 video-cache/downloader`, iSeg > -1 && iSeg < iVc && iSeg < iDl);
    }
    const map = JSON.parse(read('scripts/version-map.json'));
    t('version-map 已登记 js/seg-batch.js', typeof map.assets['js/seg-batch.js'] === 'number');
    const server = read('server.mjs');
    const fn = read('functions/dl-batch.js');
    t('两个服务端都实现 /dl-batch 且下发同一组响应头',
        server.includes("app.post('/dl-batch'") && fn.includes('onRequestPost') &&
        server.includes("'x-wdtv-size'") && fn.includes("'x-wdtv-size'") &&
        server.includes("'x-wdtv-clen'") && fn.includes("'x-wdtv-clen'"));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：' + fails.join(' / ')); process.exit(1); }
