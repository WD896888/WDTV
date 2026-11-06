// WDTV 明暗主题模块自测（Node ESM，零依赖，不随部署）
// 运行：node --test test/theme.test.mjs
// 覆盖：三态循环、system 跟随 matchMedia change、存储异常降级、无 document /
// 无 matchMedia / 无 localStorage 降级、initialScript() 字符串与执行效果、dispose。
// 注：showToast 无 options 时行为不变的回归由 viewing-history.test.mjs（会 import
// ui.js 并调用含 showToast 的函数）间接覆盖，本文件不重复构造复杂 DOM mock。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
    if (cond) { pass++; console.log('  ok  ' + name); }
    else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

// ---- 最小环境 mock（必须在 import theme.js 之前就绪）----
const store = new Map();
let throwOnGet = false, throwOnSet = false;
globalThis.localStorage = {
    getItem(k) { if (throwOnGet) throw new Error('denied'); return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { if (throwOnSet) throw new Error('denied'); store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); }
};

const classOps = [];
const attrOps = [];
const root = {
    classList: { toggle(name, force) { classOps.push([name, !!force]); } },
    setAttribute(name, value) { attrOps.push([name, value]); },
    style: {}
};
globalThis.document = { documentElement: root };

function makeMQ(matches) {
    const ls = [];
    return {
        _matches: matches,
        get matches() { return this._matches; },
        set matches(v) { this._matches = v; },
        addEventListener(type, fn) { if (type === 'change') ls.push(fn); },
        removeEventListener(type, fn) { const i = ls.indexOf(fn); if (i !== -1) ls.splice(i, 1); },
        _fire(m) { this._matches = m; ls.slice().forEach(fn => fn({ matches: m })); },
        _count() { return ls.length; }
    };
}
const mq = makeMQ(false);
globalThis.window = globalThis;
globalThis.matchMedia = function () { return mq; };

await import('../js/theme.js');
const T = globalThis.WDTVTheme;

console.log('\n[1] 导出与默认降级');
{
    t('导出：WDTVTheme 八个函数 API 齐全',
        !!T && ['get', 'resolved', 'set', 'cycle', 'apply', 'onChange', 'dispose', 'initialScript']
            .every(k => typeof T[k] === 'function'));
    t('KEY 为 wdtvTheme', T.KEY === 'wdtvTheme');
    t('MODES 为 light/dark/system', JSON.stringify(T.MODES) === JSON.stringify(['light', 'dark', 'system']));

    store.clear();
    classOps.length = 0;
    attrOps.length = 0;
    t('无存储：get 降级 dark', T.get() === 'dark');
    t('无存储：resolved 为 dark', T.resolved() === 'dark');
    const r = T.apply();
    t('apply：返回 dark，给 <html> 打 dark class 且 colorScheme=dark',
        r === 'dark' &&
        classOps.some(op => op[0] === 'dark' && op[1] === true) &&
        root.style.colorScheme === 'dark');
    t('apply：同步写入 data-theme=dark（与三页 head 预绘制脚本一致）',
        attrOps.some(op => op[0] === 'data-theme' && op[1] === 'dark'),
        JSON.stringify(attrOps));

    // 运行中切换主题：data-theme 必须同步刷新，不能回退到首屏脚本写入的旧值
    T.set('light');
    attrOps.length = 0;
    T.apply();
    t('apply：切换到 light 时写入 data-theme=light（运行中切换不回退）',
        attrOps.some(op => op[0] === 'data-theme' && op[1] === 'light'),
        JSON.stringify(attrOps));
    store.clear(); // 还原空存储，避免影响后续用例
}

console.log('\n[2] 三态 set / resolved / cycle');
{
    classOps.length = 0;
    t("set('light') 写入并返回 light", T.set('light') === 'light' && store.get('wdtvTheme') === 'light');
    t("set('light')：resolved light、移除 dark class、colorScheme light",
        T.resolved() === 'light' &&
        classOps.some(op => op[0] === 'dark' && op[1] === false) &&
        root.style.colorScheme === 'light');
    t("set('dark')：resolved dark", T.set('dark') === 'dark' && T.resolved() === 'dark');
    t('非法 set 值被忽略（不改存储）', T.set('solarized') === 'dark' && store.get('wdtvTheme') === 'dark');

    T.set('dark');
    t('cycle：dark -> system', T.cycle() === 'system' && store.get('wdtvTheme') === 'system');
    t('cycle：system -> light', T.cycle() === 'light');
    t('cycle：light -> dark', T.cycle() === 'dark');
    t('cycle 三态循环闭合回到起点', T.get() === 'dark');
}

console.log('\n[3] system 跟随 matchMedia change');
{
    classOps.length = 0;
    const changes = [];
    const off = T.onChange(p => changes.push(p));
    T.set('system');
    mq._matches = false;
    t('system + 浅色系统：resolved light', T.resolved() === 'light');

    mq._fire(true);
    t('matchMedia change 变暗：resolved 跟随为 dark', T.resolved() === 'dark');
    t('change 触发 apply（dark class 重新置 true）',
        classOps.some(op => op[0] === 'dark' && op[1] === true));
    t('change 触发 onChange 通知（mode=system, resolved=dark）',
        changes.length > 0 &&
        changes[changes.length - 1].mode === 'system' &&
        changes[changes.length - 1].resolved === 'dark');

    mq._fire(false);
    t('change 变浅：resolved 跟随为 light', T.resolved() === 'light');

    off();
    const before = changes.length;
    mq._fire(true);
    t('onChange 返回的 off() 可取消订阅', changes.length === before);
}

console.log('\n[4] localStorage 异常降级');
{
    store.clear();
    throwOnGet = true; throwOnSet = true;
    let ok = true;
    try {
        t('getItem 抛错：get 降级 dark', T.get() === 'dark');
        t('getItem 抛错：resolved 降级 dark', T.resolved() === 'dark');
        classOps.length = 0;
        t('set 时 setItem 抛错：仍 apply 且视觉降级 dark、不抛错',
            T.set('light') === 'light' && root.style.colorScheme === 'dark');
    } catch (e) { ok = false; }
    throwOnGet = false; throwOnSet = false;
    t('存储异常全程不抛错', ok);
}

console.log('\n[5] 无 document 安全 no-op');
{
    const savedDoc = globalThis.document;
    delete globalThis.document;
    let noDocOk = true;
    try {
        const x = T.apply();
        noDocOk = (x === 'dark' || x === 'light');
    } catch (e) { noDocOk = false; }
    globalThis.document = savedDoc;
    t('无 document 时 apply() 安全 no-op 不抛错', noDocOk);
}

console.log('\n[6] initialScript()');
{
    const code = T.initialScript();
    t('initialScript 返回字符串', typeof code === 'string');
    t('initialScript 不含 </script>', code.indexOf('</script>') === -1, code);
    t('initialScript 不含 <script', code.indexOf('<script') === -1, code);
    t('initialScript 读取 wdtvTheme 并写 colorScheme',
        code.indexOf('wdtvTheme') !== -1 && code.indexOf('colorScheme') !== -1, code);

    function runInitial(themeValue, sysDark) {
        const ls = { getItem: () => themeValue };
        const win = { matchMedia: () => ({ matches: sysDark }) };
        const cls = [];
        const doc = {
            documentElement: {
                classList: { toggle: (n, f) => cls.push([n, !!f]) },
                style: {}
            }
        };
        new Function('localStorage', 'window', 'document', code)(ls, win, doc);
        return { dark: cls.length ? cls[cls.length - 1][1] : null, scheme: doc.documentElement.style.colorScheme };
    }
    t('initialScript：light -> 无 dark class / colorScheme light',
        (() => { const r = runInitial('light', false); return r.dark === false && r.scheme === 'light'; })());
    t('initialScript：dark -> dark class / colorScheme dark',
        (() => { const r = runInitial('dark', false); return r.dark === true && r.scheme === 'dark'; })());
    t('initialScript：system + 深色系统 -> dark',
        (() => { const r = runInitial('system', true); return r.dark === true && r.scheme === 'dark'; })());
    t('initialScript：system + 浅色系统 -> light',
        (() => { const r = runInitial('system', false); return r.dark === false && r.scheme === 'light'; })());
    t('initialScript：非法值 -> 降级 dark',
        (() => { const r = runInitial('nope', false); return r.dark === true && r.scheme === 'dark'; })());
}

console.log('\n[7] vm 沙箱：无 document / 无 matchMedia / 无 localStorage');
{
    const src = readFileSync(fileURLToPath(new URL('../js/theme.js', import.meta.url)), 'utf8');
    const sandbox = {};
    vm.createContext(sandbox);
    let vmOk = true;
    try {
        vm.runInContext(src, sandbox);
        const T2 = sandbox.WDTVTheme;
        vmOk = !!T2 &&
            T2.get() === 'dark' &&
            T2.resolved() === 'dark' &&
            T2.apply() === 'dark' &&
            T2.cycle() === 'system' &&
            T2.set('system') === 'system' &&
            T2.resolved() === 'dark'; // 无 matchMedia 时 system 也降级 dark
    } catch (e) { vmOk = false; }
    t('三者皆缺失：全程降级 dark 且不抛错', vmOk);
}

console.log('\n[8] dispose');
{
    const changes2 = [];
    T.onChange(p => changes2.push(p));
    const cntBefore = mq._count();
    T.dispose();
    t('dispose：移除 matchMedia change 监听', mq._count() === cntBefore - 1,
        cntBefore + ' -> ' + mq._count());
    const n = changes2.length;
    mq._fire(true);
    t('dispose：change 不再触发通知', changes2.length === n);
}

console.log('\n[9] 三页 <head> 主题预绘制脚本一致性（静态护栏）');
{
    // 首屏防白闪依赖 <head> 内联脚本在 CSS 之前读偏好并打 dark class。
    // 三页脚本不要求逐字节相同，只要都读 wdtvTheme + matchMedia 且会设置 dark class。
    const pages = ['index.html', 'player.html', 'about.html'];
    pages.forEach(function (page) {
        const html = readFileSync(fileURLToPath(new URL('../' + page, import.meta.url)), 'utf8');
        const m = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
        const head = m ? m[1] : '';
        t(page + '：<head> 可解析', !!m);
        t(page + '：head 内预绘制脚本读取 wdtvTheme', head.indexOf('wdtvTheme') !== -1);
        t(page + '：head 内预绘制脚本读取 matchMedia', head.indexOf('matchMedia') !== -1);
        t(page + '：head 内预绘制脚本会设置 dark class',
            /classList\.toggle\(\s*['"]dark['"]/.test(head));
    });
}

console.log('\n[10] apply() 行为级：setAttribute(data-theme) 随 resolved 同步');
{
    // 用现有 mock document（root.setAttribute 记录到 attrOps）+ mock localStorage
    // 直接控制 resolved，验证 apply() 真的以 ('data-theme', 对应值) 调用 setAttribute。
    const probe = ['dark', 'light'].map(function (mode) {
        store.set('wdtvTheme', mode);   // 直接写 mock localStorage 控制 resolved
        attrOps.length = 0;
        const ret = T.apply();
        return {
            mode: mode,
            ret: ret,
            themeOps: attrOps.filter(function (op) { return op[0] === 'data-theme'; })
                .map(function (op) { return op[1]; })
        };
    });
    t('行为级：apply() 对 dark/light 两种 resolved 均以 setAttribute 写入对应的 data-theme',
        probe[0].ret === 'dark' && probe[0].themeOps.length === 1 && probe[0].themeOps[0] === 'dark' &&
        probe[1].ret === 'light' && probe[1].themeOps.length === 1 && probe[1].themeOps[0] === 'light',
        JSON.stringify(probe));
    store.clear(); // 还原空存储，避免影响后续
}

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
