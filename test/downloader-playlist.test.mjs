// WDTV 下载器清单解析自测（Node ESM，零依赖，不随部署）
// 运行：node test/downloader-playlist.test.mjs
//
// 锁住「先解析地址再拼分片」这条需求：
// 播放地址是 /proxy/<encodeURIComponent(真实地址)> 形态（proxyPlay 源 / 混合内容兜底），
// 相对分片必须解析到内层真实目录再套回代理。旧实现直接把 /proxy/<encoded> 当 new URL 的
// base —— 它不是绝对地址，new URL() 直接抛错，整份清单 0 分片，
// 最终报「清单中没有可下载的视频分片」（见 2026-11 的下载失败回归）。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
    if (cond) { pass++; console.log('  ok  ' + name); }
    else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

// ===== 沙箱：按页面脚本顺序只加载 downloader.js（广告引擎缺失时走透传分支） =====
const noop = () => { };
const el = () => ({ style: {}, appendChild: noop, addEventListener: noop, classList: { add: noop, remove: noop } });

// 假上游：主清单用相对子清单地址（采集站真实形态），子清单用相对分片地址
const MASTER_PATH = '/wjv11/202609/11/G3jnWmWhN095/video/index.m3u8';
const MEDIA_PATH = '/wjv11/202609/11/G3jnWmWhN095/video/1000k_720/hls/index.m3u8';
const MASTER_TEXT = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=128,RESOLUTION=1280x720',
    '1000k_720/hls/index.m3u8',
    ''
].join('\n');
const MEDIA_TEXT = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXTINF:2.000000,',
    'seg0.ts',
    '#EXTINF:2.000000,',
    'seg1.ts',
    '#EXTINF:2.000000,',
    'seg2.ts',
    '#EXT-X-ENDLIST',
    ''
].join('\n');

const seen = [];
const sandbox = {
    console, URL, Blob, Uint8Array, Map, Set, Promise, Date, Math, JSON, Error, DOMException,
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    TextEncoder, crypto: globalThis.crypto, AbortController,
    navigator: { userAgent: 'node-smoke', maxTouchPoints: 0 },
    location: { href: 'http://localhost/player.html', protocol: 'http:', origin: 'http://localhost' },
    localStorage: { getItem: () => null, setItem: noop },
    indexedDB: { open: () => ({}) }, // init() 的 IDB 读取挂起，不影响解析
    document: {
        visibilityState: 'visible', addEventListener: noop, getElementById: () => null,
        querySelector: () => null, createElement: el, body: el(), head: el()
    },
    // 假 fetch：只认路径（同源代理 /proxy/<encoded> 与源站目录两种写法都返回同一份清单）
    fetch: async (url) => {
        const raw = String(url);
        seen.push(raw);
        let text = null;
        try {
            const inner = decodeURIComponent(raw.replace(/^https?:\/\/[^/]+/, '').replace(/^\/proxy\//, ''));
            const path = /^https?:\/\//.test(inner) ? new URL(inner).pathname : null;
            if (path === MASTER_PATH) text = MASTER_TEXT;
            else if (path === MEDIA_PATH) text = MEDIA_TEXT;
        } catch (e) { }
        if (text == null) return { ok: false, status: 404, statusText: 'Not Found', text: async () => '', body: null };
        return { ok: true, status: 200, text: async () => text, body: {} };
    }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
// 测试钩子：把内部函数挂到导出对象上（不修改仓库源码语义）
const src = read('js/downloader.js').replace(
    'window.WDTDownloader = {',
    'window.WDTDownloader = {\n    __test: { makePlaylistBase, parseMedia, parseMaster, resolvePlaylist, describeEmptyPlaylist, fetchSegBatch },'
);
let loadError = null;
try {
    vm.runInContext(read('js/seg-batch.js'), sandbox, { filename: 'seg-batch.js' });
    vm.runInContext(src, sandbox, { filename: 'downloader.js' });
} catch (e) { loadError = e; }
const T = sandbox.WDTDownloader && sandbox.WDTDownloader.__test;

console.log('\n[1] 加载与钩子');
t('downloader.js 可加载', loadError === null, loadError && loadError.message);
t('内部解析函数可测', !!T && typeof T.parseMedia === 'function');

const ENC_MASTER = '/proxy/' + encodeURIComponent('https://v11.ppqrrs.com' + MASTER_PATH) + '?wdtv_m3u8_rw=1';
const ENC_MEDIA = '/proxy/' + encodeURIComponent('https://v11.ppqrrs.com' + MEDIA_PATH) + '?wdtv_m3u8_rw=1';

console.log('\n[2] 代理形态基准：相对地址落到内层真实目录并套回代理');
{
    const base = T.makePlaylistBase(ENC_MEDIA);
    t('识别为代理形态', base.viaProxy === true);
    t('解析基准是内层真实地址', base.url === 'https://v11.ppqrrs.com' + MEDIA_PATH, base.url);
    const seg = base.resolve('seg0.ts');
    const inner = decodeURIComponent(String(seg).split('?')[0].replace(/^\/proxy\//, ''));
    t('分片解析到内层同级目录', inner === 'https://v11.ppqrrs.com/wjv11/202609/11/G3jnWmWhN095/video/1000k_720/hls/seg0.ts', String(seg));
    t('保留 m3u8 重写标记', /\?wdtv_m3u8_rw=1$/.test(String(seg)), String(seg));
    t('不再拼成 /proxy/seg0.ts', !/^\/proxy\/seg0\.ts/.test(String(seg)), String(seg));

    // 清单已被服务端改写成代理地址时，原样沿用（不能拿它当相对路径拼到源站域名下）
    const rewritten = '/proxy/' + encodeURIComponent('https://v11.adfg8.vip/a/b/seg0.ts') + '?wdtv_m3u8_rw=1';
    t('已是代理形态的分片原样保留', base.resolve(rewritten) === rewritten, base.resolve(rewritten));
}

console.log('\n[3] 直链基准：不做代理包装');
{
    const base = T.makePlaylistBase('https://v11.ppqrrs.com' + MEDIA_PATH);
    t('直链基准保留原地址', base.url === 'https://v11.ppqrrs.com' + MEDIA_PATH);
    t('直链分片解析为绝对地址', base.resolve('seg1.ts') === 'https://v11.ppqrrs.com/wjv11/202609/11/G3jnWmWhN095/video/1000k_720/hls/seg1.ts', base.resolve('seg1.ts'));
}

console.log('\n[4] 主清单/媒体清单解析');
{
    const variants = T.parseMaster(MASTER_TEXT, T.makePlaylistBase(ENC_MASTER));
    t('主清单解析出 1 个变体', variants.length === 1, JSON.stringify(variants));
    t('变体地址为代理形态且指向子清单', !!variants[0] && decodeURIComponent(variants[0].url.replace(/^\/proxy\//, '')).indexOf(MEDIA_PATH) > 0, variants[0] && variants[0].url);

    const withComment = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="cn",URI="audio.m3u8"',
        'v900.m3u8',
        ''
    ].join('\n');
    t('STREAM-INF 与 URI 之间的注释行不影响解析',
        T.parseMaster(withComment, T.makePlaylistBase(ENC_MASTER)).length === 1);

    const media = T.parseMedia(MEDIA_TEXT, T.makePlaylistBase(ENC_MEDIA));
    t('媒体清单解析出 3 个分片', media.segs.length === 3, String(media.segs.length));
    t('累计时长正确', Math.round(media.duration) === 6, String(media.duration));
    t('AES 密钥地址已按内层目录解析',
        !!media.keyChanges[0] && decodeURIComponent(String(media.keyChanges[0].enc.uri).replace(/^\/proxy\//, '')).indexOf('/1000k_720/hls/key.bin') > 0,
        media.keyChanges[0] && media.keyChanges[0].enc.uri);
}

console.log('\n[5] 端到端（离线假上游）：生产形态地址不再 0 分片');
{
    seen.length = 0;
    let media = null, err = null;
    try { media = await T.resolvePlaylist(ENC_MASTER, null, null); } catch (e) { err = e; }
    t('代理形态地址解析成功', err === null && !!media, err && err.message);
    t('分片数不为 0（回归点）', !!media && media.segs.length === 3, media ? String(media.segs.length) : '');

    let direct = null, err2 = null;
    try { direct = await T.resolvePlaylist('https://v11.ppqrrs.com' + MASTER_PATH, null, null); } catch (e) { err2 = e; }
    t('直链地址解析成功', err2 === null && !!direct, err2 && err2.message);
    t('直链分片数一致', !!direct && direct.segs.length === 3, direct ? String(direct.segs.length) : '');
}

console.log('\n[6] 0 分片的诊断不再一律甩同一句话');
{
    t('网页错误页判为非清单', /不是 m3u8 清单/.test(T.describeEmptyPlaylist('<html><body>404</body></html>')));
    t('主清单无可用变体单独提示', /画质子清单/.test(T.describeEmptyPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n')));
    t('LL-HLS 单独提示', /LL-HLS/.test(T.describeEmptyPlaylist('#EXTM3U\n#EXT-X-PART:URI="p.mp4"\n')));
    t('兜底文案保留换源建议', /建议换源/.test(T.describeEmptyPlaylist('#EXTM3U\n#EXT-X-VERSION:3\n')));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { console.log('失败项：' + fails.join(' / ')); process.exit(1); }
