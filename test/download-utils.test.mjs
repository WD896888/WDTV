// WDTV 下载链路工具自测（Node ESM，零依赖，不随部署）
// 运行：node test/download-utils.test.mjs
// 与 static-contracts 的字符串断言不同：这里真实 import 并执行纯函数模块，
// 覆盖「4xx 快退 / 5xx 重试 / 混合内容诊断 / 存储报错」等可回归行为。
import '../js/download-utils.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const U = globalThis.WDTVDownloadUtils;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
let pass = 0, fail = 0;
const fails = [];

function t(name, cond, extra) {
    if (cond) { pass++; console.log('  ok  ' + name); }
    else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

console.log('\n[1] 模块加载与导出');
t('WDTVDownloadUtils 已挂载', !!U && typeof U.classifyHttpStatus === 'function');
t('六个纯函数齐全', ['classifyHttpStatus', 'isMixedContentBlocked', 'describeFetchFailure',
    'describePlaylistFailure', 'describeStorageError', 'isFsAccessSupported']
    .every(k => typeof U[k] === 'function'));

console.log('\n[2] HTTP 状态分类：确定性失败快退，抖动才重试');
{
    const fatalCodes = [400, 403, 404, 410, 451];
    for (const code of fatalCodes) {
        const r = U.classifyHttpStatus(code, 7);
        t(`HTTP ${code} 判为 fatal且不重试`, r.fatal === true && r.retryable === false, JSON.stringify(r));
    }
    const m = U.classifyHttpStatus(404, 7);
    t('404 文案带分片号与换源建议', m.message.includes('分片 7') && m.message.includes('HTTP 404')
        && m.message.includes('建议更换来源'), m.message);
    const retryCodes = [408, 429, 500, 502, 503];
    for (const code of retryCodes) {
        const r = U.classifyHttpStatus(code, 1);
        t(`HTTP ${code} 仍可重试`, r.fatal === false && r.retryable === true, JSON.stringify(r));
    }
    t('2xx 不是失败', U.classifyHttpStatus(200, 1).fatal === false);
    t('状态码缺失(0)按可重试处理', U.classifyHttpStatus(0, 1).fatal === false);
}

console.log('\n[3] 失败诊断：把网络术语翻译成可行动的原因');
{
    t('HTTPS 页面取 HTTP 源 = 混合内容', U.isMixedContentBlocked('http://cdn.example.com/a.m3u8', 'https:') === true);
    t('HTTPS 页面取 HTTPS 源不拦截', U.isMixedContentBlocked('https://cdn.example.com/a.m3u8', 'https:') === false);
    t('HTTP 页面取 HTTP 源不拦截', U.isMixedContentBlocked('http://cdn.example.com/a.m3u8', 'http:') === false);

    const mixed = U.describeFetchFailure('http://cdn.example.com/a.m3u8', 'TypeError: Failed to fetch', 'https:');
    t('混合内容文案点明原因与换源', mixed.includes('混合内容被拦截') && mixed.includes('建议更换来源'), mixed);

    const cors = U.describeFetchFailure('https://cdn.example.com/a.m3u8', 'Failed to fetch', 'https:');
    t('CORS/域名不可达文案给出换源建议', cors.includes('跨域限制或域名不可达') && cors.includes('建议更换来源'), cors);

    t('普通错误原样透传，不乱加文案', U.describeFetchFailure('https://x/a', 'HTTP 500', 'https:') === 'HTTP 500');
    t('NetworkError 也归入网络诊断', U.describeFetchFailure('https://x/a', 'NetworkError', 'https:').includes('跨域限制'));

    const pl = U.describePlaylistFailure('https://x/a', 'Failed to fetch', 'https:');
    t('清单解析失败带上下文', pl.includes('播放列表解析失败') && pl.includes('建议更换来源'), pl);
}

console.log('\n[4] 存储错误与保存能力探测');
{
    const s = U.describeStorageError(new Error('QuotaExceededError'));
    t('配额错误翻译成可读文案', s.includes('存储空间可能不足') && s.includes('QuotaExceededError'), s);
    t('字符串错误也能包装', U.describeStorageError('unknown').includes('unknown'));
    t('有 showSaveFilePicker 时支持磁盘直写',
        U.isFsAccessSupported({ showSaveFilePicker() { } }) === true);
    t('无 FS Access 时回退内存导出', U.isFsAccessSupported({}) === false);
}

console.log('\n[5] 静态契约：只留 MP4 + 流式写出已接入');
{
    const dl = read('js/downloader.js');
    t('格式常量固定为 mp4', /const OUTPUT_FORMAT = 'mp4'/.test(dl));
    t('批量弹窗已无格式选择行', !/wdtvDlBatchFormat/.test(dl) && !/data-fmt/.test(dl));
    t('剧集合成已无 TS 分支', !/task\.format === 'ts'/.test(dl) && !/video\/MP2T/.test(dl));
    t('不再把整集读进 parts 全量数组', !/const parts = \[\]/.test(dl));
    t('已接 FS Access 写盘', /armDiskWriter/.test(dl) && /resolveDiskWriter/.test(dl) && /sink\.write\(u8\)/.test(dl));
    t('已接确定性失败快退', /classifyHttpStatus/.test(dl) && /e\.fatal/.test(dl));
    t('已接可读失败诊断', /describeFetchFailure/.test(dl) && /describeStorageError/.test(dl));
    t('广告过滤契约未被破坏', /storageKey: afKey/.test(dl));
    t('mux.js 已通过 options.duration 回填 moov 时长',
        /setDuration: function/.test(read('libs/mux-mp4.js')) && /mp4\.setDuration\(options\.duration\)/.test(read('libs/mux-mp4.js')));

    for (const html of ['index.html', 'player.html']) {
        const src = read(html);
        const iUtils = src.indexOf('js/download-utils.js');
        const iDl = src.indexOf('js/downloader.js');
        t(`${html} 已引入 download-utils 且顺序在前`, iUtils > -1 && iDl > -1 && iUtils < iDl);
    }
    const map = JSON.parse(read('scripts/version-map.json'));
    t('version-map 已登记新模块', typeof map.assets['js/download-utils.js'] === 'number');
}

console.log('\n[6] 加载冒烟：按 HTML 顺序执行两个脚本不报错');
{
    const vm = await import('node:vm');
    const noop = () => { };
    const el = () => ({ style: {}, appendChild: noop, addEventListener: noop, classList: { add: noop, remove: noop } });
    const sandbox = {
        console, URL, Blob, Uint8Array, Map, Set, Promise, Date, Math, JSON, Error, DOMException,
        setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
        navigator: { userAgent: 'node-smoke' },
        location: { href: 'http://localhost/', protocol: 'http:', origin: 'http://localhost' },
        localStorage: { getItem: () => null, setItem: noop },
        indexedDB: { open: () => ({}) }, // 让 init() 的 IDB 读取挂起，不影响顶层挂载
        document: { addEventListener: noop, getElementById: () => null, createElement: el, body: el(), head: el(), querySelector: () => null }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    let loadError = null;
    try {
        vm.runInContext(read('js/download-utils.js'), sandbox, { filename: 'download-utils.js' });
        vm.runInContext(read('js/downloader.js'), sandbox, { filename: 'downloader.js' });
    } catch (e) { loadError = e; }
    t('两个脚本按序加载无异常', loadError === null, loadError && loadError.message);
    t('WDTVDownloadUtils 在下载器之前可用', !!sandbox.WDTVDownloadUtils);
    t('WDTDownloader 正常挂载', !!sandbox.WDTDownloader && typeof sandbox.WDTDownloader.enqueue === 'function');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：' + fails.join(' / ')); process.exit(1); }
