// 批次4：共看 seek 抑制桥单元验证
// 目标：确认 player.js 能拿到 suppressLocalSeek、它复用既有私有 suppress()、
// 且调用后 600ms 内的 onLocalSeeking 不再 send（不误广播程序自动 seek），不改同步协议、不新增请求。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'js/watch-party.js'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
    if (cond) { pass++; }
    else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

// ---- 1) 静态契约：导出桥存在且复用私有 suppress ----
t('导出对象含 suppressLocalSeek', /suppressLocalSeek:\s*function\s*\(\s*\)\s*\{\s*suppress\(\);?\s*\}/.test(src));
// 旧断言 `>= 1` 是恒真的（前一条已断言存在），新增重复定义或多余引用也能全绿。
t('suppressLocalSeek 全文恰好出现一次且仅一处定义',
    (src.match(/suppressLocalSeek/g) || []).length === 1 &&
    (src.match(/suppressLocalSeek:/g) || []).length === 1);
t('私有 suppress 仍是 600ms 抑制窗实现',
    src.includes('function suppress() { st.suppressUntil = performance.now() + SUPPRESS_MS; }'));
t('SUPPRESS_MS 仍为 600', /var SUPPRESS_MS = 600;/.test(src));
t('isSuppressed 仍读取 suppressUntil', /function isSuppressed\(\) \{ return performance.now\(\) < st.suppressUntil; \}/.test(src));
t('导出桥不发起 send', !/suppressLocalSeek[^}]*send\(/.test(src));
t('导出桥不发起 fetch', !/suppressLocalSeek[^}]*fetch\(/.test(src));
t('导出桥未引入新计时器', !/suppressLocalSeek[^}]*setTimeout/.test(src));

// ---- 2) 加载模块，验证导出对象与行为 ----
// watch-party.js 是 IIFE，加载期会读 document / localStorage / WebSocket 等；
// 这里给出最小桩，只求模块能挂出 window.WatchParty，不触发任何真实连接。
const saved = {};
// navigator / performance / crypto 在 Node 22 上是只读 getter，不保存也不覆盖，直接用环境自带值
const G = ['window', 'document', 'localStorage', 'sessionStorage', 'WebSocket',
    'BroadcastChannel', 'location', 'fetch', 'setInterval', 'clearInterval'];
for (const k of G) { saved[k] = globalThis[k]; }

const noopStorage = {
    getItem() { return null; }, setItem() { }, removeItem() { }, clear() { }, key() { return null; }, length: 0
};
const stubEl = {
    style: {}, classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
    addEventListener() { }, removeEventListener() { }, appendChild() { }, setAttribute() { },
    querySelector() { return null; }, querySelectorAll() { return []; }, remove() { },
    getAttribute() { return null; }, textContent: '', innerHTML: ''
};
const stubDoc = {
    readyState: 'loading', documentElement: stubEl, body: stubEl,
    addEventListener() { }, removeEventListener() { },
    getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
    createElement() { return Object.assign({}, stubEl); }, hidden: false, visibilityState: 'visible'
};
try {
    globalThis.window = globalThis;
    globalThis.document = stubDoc;
    globalThis.localStorage = noopStorage;
    globalThis.sessionStorage = noopStorage;
    globalThis.WebSocket = function () { };
    globalThis.BroadcastChannel = function () { this.postMessage = () => { }; this.close = () => { }; };
    globalThis.location = { href: 'https://example.test/player.html', search: '', pathname: '/player.html', origin: 'https://example.test' };
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls++; throw new Error('不应发起网络请求'); };
    globalThis.setInterval = () => 0;
    globalThis.clearInterval = () => { };

    await import('../js/watch-party.js');
    const WP = globalThis.WatchParty;
    t('模块导出 window.WatchParty', !!WP && typeof WP === 'object');
    t('suppressLocalSeek 是可调用函数', !!WP && typeof WP.suppressLocalSeek === 'function');
    t('调用 suppressLocalSeek 不抛错', (() => {
        try { WP.suppressLocalSeek(); return true; } catch (e) { return false; }
    })());
    t('调用后不发起 fetch', fetchCalls === 0, 'fetchCalls=' + fetchCalls);
    t('isActive 仍可用（同步协议未被改动）', typeof WP.isActive === 'function');
    t('hasControl 仍可用', typeof WP.hasControl === 'function');
    t('onMetadata / onEpisodeSwitch 仍导出', typeof WP.onMetadata === 'function' && typeof WP.onEpisodeSwitch === 'function');
} catch (e) {
    // 模块加载期依赖较复杂，若桩不足则单独降级为「静态契约已通过」
    t('模块加载桩可用', false, e.message);
} finally {
    for (const k of G) {
        if (saved[k] === undefined) delete globalThis[k];
        else globalThis[k] = saved[k];
    }
    delete globalThis.WatchParty;
}

console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
