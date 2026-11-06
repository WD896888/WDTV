// WDTV 状态组件基础模块自测（Node ESM，零依赖，不随部署）
// 运行：node --test test/states.test.mjs
// 覆盖 states / focus-trap / image-fallback 三个 IIFE 模块的纯函数与轻量 DOM 行为。

// ---- 最小 DOM mock（focus-trap 与 states.mount 用）----
let doc;
function mkFocusable(id, visible) {
    return {
        id: id,
        disabled: false,
        _focused: 0,
        getAttribute() { return null; },
        getClientRects() { return visible ? [{ width: 10, height: 10 }] : []; },
        focus() { doc.activeElement = this; this._focused++; }
    };
}
doc = {
    activeElement: null,
    _handlers: [],
    addEventListener(type, fn) { this._handlers.push({ type: type, fn: fn }); },
    removeEventListener(type, fn) { this._handlers = this._handlers.filter(h => h.fn !== fn); },
    querySelector(sel) { return sel === '#box' ? box : null; }
};
globalThis.document = doc;

const box = { innerHTML: '' };

await import('../js/states.js');
await import('../js/focus-trap.js');
await import('../js/image-fallback.js');

const S = globalThis.WDTVStates;
const FT = globalThis.WDTVFocusTrap;
const F = globalThis.WDTVImageFallback;

let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
    if (cond) { pass++; console.log('  ok  ' + name); }
    else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

console.log('\n[1] WDTVStates 纯函数');
{
    t('导出：WDTVStates 六个方法齐全',
        !!S && ['spinner', 'loading', 'empty', 'error', 'mount', 'clear'].every(k => typeof S[k] === 'function'));
    const sm = S.spinner('sm');
    t('spinner：三档尺寸 sm', sm.indexOf('wdtv-state-spinner--sm') !== -1, sm);
    t('spinner：非法尺寸回退 md', S.spinner('xx').indexOf('wdtv-state-spinner--md') !== -1, S.spinner('xx'));
    t('spinner：lg / tone', S.spinner('lg', 'accent').indexOf('wdtv-state-spinner--lg') !== -1 && S.spinner('lg', 'accent').indexOf('wdtv-state-tone--accent') !== -1);
    t('spinner：tone 字符被安全化', S.spinner('md', 'a b"c').indexOf('wdtv-state-tone--abc') !== -1, S.spinner('md', 'a b"c'));

    const ld = S.loading('<script>alert(1)</script>');
    t('loading：含 spinner 与 label', ld.indexOf('wdtv-state-loading') !== -1 && ld.indexOf('wdtv-state-spinner') !== -1);
    t('loading：文案被 HTML 转义（无裸 <script>）', ld.indexOf('<script>') === -1 && ld.indexOf('&lt;script&gt;') !== -1, ld);

    const ep = S.empty('没有结果', '换个关键词试试', 'plain');
    t('empty：plain 变体', ep.indexOf('wdtv-state-empty--plain') !== -1, ep);
    t('empty：boxed 变体', S.empty('T', 'D', 'boxed').indexOf('wdtv-state-empty--boxed') !== -1);
    t('empty：默认 boxed', S.empty('T').indexOf('wdtv-state-empty--boxed') !== -1);
    t('empty：标题/描述转义', S.empty('<b>', '<i>').indexOf('<b>') === -1 && S.empty('<b>', '<i>').indexOf('&lt;b&gt;') !== -1);

    const er = S.error('加载失败', '再试一次');
    t('error：data-wdtv-retry 属性供事件委托', er.indexOf('data-wdtv-retry="1"') !== -1, er);
    t('error：data-retry-label 与按钮文案', er.indexOf('data-retry-label="再试一次"') !== -1 && er.indexOf('>再试一次<') !== -1);
    t('error：message 转义', S.error('<img onerror=1>').indexOf('<img') === -1 && S.error('<img onerror=1>').indexOf('&lt;img') !== -1);
    t('error：默认重试文案', S.error('x').indexOf('>重试<') !== -1);
}

console.log('\n[2] WDTVStates.mount / clear');
{
    box.innerHTML = '<p>old</p>';
    const r1 = S.mount(box, '<div class="wdtv-state-loading">x</div>');
    t('mount：写入 innerHTML 且返回容器', r1 === box && box.innerHTML.indexOf('wdtv-state-loading') !== -1, box.innerHTML);
    const r2 = S.clear(box);
    t('clear：清空 innerHTML 且返回容器', r2 === box && box.innerHTML === '', JSON.stringify(box.innerHTML));
    box.innerHTML = 'z';
    t('mount：支持选择器字符串', S.mount('#box', 'Y') === box && box.innerHTML === 'Y');
    t('mount/clear：空容器返回 null 不抛错', S.mount(null, 'x') === null && S.clear(null) === null);
}

console.log('\n[3] WDTVFocusTrap 焦点循环');
{
    const outside = mkFocusable('outside', true);
    const a = mkFocusable('a', true);
    const hidden = mkFocusable('hidden', false); // 不可见，应被 getClientRects 过滤
    const b = mkFocusable('b', true);
    const container = {
        querySelectorAll() { return [a, hidden, b]; },
        contains(el) { return el === a || el === hidden || el === b; }
    };

    t('导出：FOCUSABLE 选择器含 button/a/input/[tabindex]',
        typeof FT.FOCUSABLE === 'string' && FT.FOCUSABLE.indexOf('button') !== -1 && FT.FOCUSABLE.indexOf('a[href]') !== -1 && FT.FOCUSABLE.indexOf('[tabindex]') !== -1);
    const vis = FT._focusable(container);
    t('focusable：过滤不可见元素（getClientRects().length>0）',
        vis.length === 2 && vis[0] === a && vis[1] === b, JSON.stringify(vis.map(x => x.id)));

    doc.activeElement = outside;
    const trap = FT.create(container);
    trap.activate();
    t('activate：记忆前置焦点并 focus 首个可见元素', doc.activeElement === a, String(doc.activeElement && doc.activeElement.id));
    t('activate：注册 keydown 监听', doc._handlers.length === 1, String(doc._handlers.length));
    const handler = doc._handlers[0].fn;

    // 最后一项 + Tab -> 循环回首个
    doc.activeElement = b;
    let prevented = false;
    handler({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
    t('Tab：末项循环回首项', prevented && doc.activeElement === a, String(doc.activeElement && doc.activeElement.id));

    // 首项 + Shift+Tab -> 循环到末项
    doc.activeElement = a;
    prevented = false;
    handler({ key: 'Tab', shiftKey: true, preventDefault() { prevented = true; } });
    t('Shift+Tab：首项循环到末项', prevented && doc.activeElement === b, String(doc.activeElement && doc.activeElement.id));

    // 焦点跑出容器 -> 拉回边界
    doc.activeElement = outside;
    handler({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
    t('Tab：焦点在容器外时拉回首项', doc.activeElement === a, String(doc.activeElement && doc.activeElement.id));

    // Esc 不处理
    doc.activeElement = a;
    let escPrevented = false;
    handler({ key: 'Escape', preventDefault() { escPrevented = true; } });
    t('Esc：不处理、不 preventDefault、不改焦点', !escPrevented && doc.activeElement === a);

    doc.activeElement = b;
    trap.deactivate();
    t('deactivate：归还焦点到打开前元素', doc.activeElement === outside, String(doc.activeElement && doc.activeElement.id));
    t('deactivate：移除 keydown 监听', doc._handlers.length === 0, String(doc._handlers.length));

    // 无 document 环境下安全 no-op
    const savedDoc = globalThis.document;
    delete globalThis.document;
    let noopOk = true;
    try { const tr = FT.create({}); tr.activate(); tr.deactivate(); } catch (e) { noopOk = false; }
    globalThis.document = savedDoc;
    t('focus-trap：无 document 时 activate/deactivate 安全 no-op', noopOk);
}

console.log('\n[4] WDTVImageFallback 候选与路径式代理');
{
    const douban = 'https://img1.doubanio.com/view/photo.jpg';
    const c = F.candidates(douban);
    t('candidates：首项是直连', c[0] === douban, JSON.stringify(c));
    t('candidates：豆瓣 imgN 归一为 img9', c[1] === 'https://img9.doubanio.com/view/photo.jpg', JSON.stringify(c));
    t('candidates：第三项为 /proxy/ 路径式包装（对归一后 URL 做 encodeURIComponent）',
        c[2] === '/proxy/' + encodeURIComponent('https://img9.doubanio.com/view/photo.jpg'), c[2]);
    t('candidates：代理项不含明文 :// 与 ?url=', c[2].indexOf('://') === -1 && c[2].indexOf('?url=') === -1, c[2]);
    t('candidates：绝不含 ?url= 查询式', c.join('|').indexOf('?url=') === -1, JSON.stringify(c));
    t('candidates：末项为空串（占位图回调）', c[c.length - 1] === '', JSON.stringify(c));

    const generic = F.candidates('https://example.com/a.jpg');
    t('candidates：非豆瓣 URL 无重复归一项（长度 3）', generic.length === 3 && generic[0] === 'https://example.com/a.jpg' && generic[2] === '', JSON.stringify(generic));
    t('proxyUrl：路径式且 URL 被 encodeURIComponent', F.proxyUrl('https://x/y?z=1') === '/proxy/' + encodeURIComponent('https://x/y?z=1'), F.proxyUrl('https://x/y?z=1'));
    t('normalizeDouban：img2/img9 统一为 img9',
        F.normalizeDouban('//img2.doubanio.com/p.jpg') === '//img9.doubanio.com/p.jpg' &&
        F.normalizeDouban('//img9.doubanio.com/p.jpg') === '//img9.doubanio.com/p.jpg');
    t('candidates：空 URL 返回空数组', F.candidates('').length === 0);
}

console.log('\n[5] WDTVImageFallback.apply onerror 逐级回退');
{
    const url = 'https://img1.doubanio.com/x.jpg';
    const seen = [];
    const img = {
        _src: '', attrs: {},
        setAttribute(n, v) { this.attrs[n] = v; },
        getAttribute(n) { return this.attrs[n] || null; },
        set src(v) { this._src = v; seen.push(v); },
        get src() { return this._src; },
        onfallback(u) { this._exhaustedUrl = u; }
        // 故意不提供 dispatchEvent：走 onfallback 钩子分支
    };
    const list = F.apply(img, url);
    t('apply：返回候选数组', Array.isArray(list) && list.length === 4, JSON.stringify(list));
    t('apply：默认 referrerPolicy / loading', img.attrs.referrerpolicy === 'no-referrer' && img.attrs.loading === 'lazy' && img.referrerPolicy === 'no-referrer', JSON.stringify(img.attrs));
    t('apply：首级是直连', seen[0] === url, JSON.stringify(seen));

    img.onerror(); // -> 归一
    img.onerror(); // -> 代理
    img.onerror(); // -> 空 -> 耗尽
    t('apply：逐级经过归一与代理', seen[1] === list[1] && seen[2] === list[2], JSON.stringify(seen));
    t('apply：耗尽触发 onfallback 与 data 标记', img._exhaustedUrl === url && img.attrs['data-wdtv-fallback'] === 'exhausted', JSON.stringify(img.attrs));
    t('apply：耗尽后 onerror 清空', img.onerror === null);
}

console.log('\n[6] WDTVImageFallback 浏览器环境：事件与 onfallback 同时生效（回归）');
{
    const url = 'https://img1.doubanio.com/y.jpg';
    const seen = [];
    const dispatched = [];
    const savedCE = globalThis.CustomEvent;
    // 提供 CustomEvent + dispatchEvent 的浏览器式环境
    globalThis.CustomEvent = function (type, opts) {
        this.type = type;
        this.detail = opts && opts.detail;
        this.bubbles = !!(opts && opts.bubbles);
    };
    const img = {
        _src: '', attrs: {},
        setAttribute(n, v) { this.attrs[n] = v; },
        getAttribute(n) { return this.attrs[n] || null; },
        set src(v) { this._src = v; seen.push(v); },
        get src() { return this._src; },
        dispatchEvent(ev) { dispatched.push(ev); return true; },
        onfallback(u) { this._exhaustedUrl = u; }
    };
    F.apply(img, url);
    img.onerror(); img.onerror(); img.onerror(); // 直连 -> 归一 -> 代理 -> 耗尽
    t('提供 CustomEvent+dispatchEvent：自定义事件被派发',
        dispatched.length === 1 && dispatched[0].type === 'wdtv-image-exhausted',
        JSON.stringify(dispatched.map(function (e) { return e.type; })));
    t('事件 detail 带 url 且 bubbles', dispatched.length === 1 &&
        dispatched[0].bubbles === true && dispatched[0].detail.url === url);
    t('提供 CustomEvent+dispatchEvent：onfallback 也被调用（关键回归）',
        img._exhaustedUrl === url, JSON.stringify(img._exhaustedUrl));
    t('耗尽的 data 标记仍被设置', img.attrs['data-wdtv-fallback'] === 'exhausted');
    if (savedCE === undefined) delete globalThis.CustomEvent;
    else globalThis.CustomEvent = savedCE;
}

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
