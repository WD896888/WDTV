// WDTV 数据源订阅自测（Node ESM，零依赖，不随部署）
// 运行：node test/source-subscription.test.mjs
// mock window / localStorage / fetch，覆盖 JSONC、格式嗅探、直连优先、代理回退小时戳、
// 数量上限与去重、私网拒绝、失败不改源集合、熔断重置、remove 前缀、autoRefresh 跳过、exportAll。
// 风格参考 test/ad-filter.test.mjs：自定义断言 + process.exit(1)。

// ===================== mock 环境（必须在 import 模块之前建立） =====================
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const store = new Map();
const calls = { fetch: [], extend: 0, initCheckboxes: 0, prefetch: 0, removePrefix: [] };
let fetchImpl = null;          // 可编程：(url, opts) => Promise<res>
const scheduled = [];          // 记录 delay>0 的定时器（如 6s abort），不执行
const docHandlers = [];        // document 事件监听只记录不触发，保证测试可控

function mkEl() { return { innerHTML: '', textContent: '', value: '' }; }
const els = {
    wdtvSubscriptionUrl: mkEl(),
    wdtvSubscriptionRefresh: mkEl(),
    wdtvSubscriptionList: mkEl(),
    wdtvSubscriptionStatus: mkEl()
};

const doc = {
    hidden: false,
    readyState: 'complete',
    head: { appendChild() {} },
    createElement() { return mkEl(); },
    getElementById(id) { return els[id] || null; },
    addEventListener(type, fn) { docHandlers.push({ type: type, fn: fn }); }
};

function MockAbortController() {
    this.signal = { aborted: false };
    this.abort = function () { this.signal.aborted = true; };
}

const win = {
    localStorage: {
        getItem(k) { return store.has(k) ? store.get(k) : null; },
        setItem(k, v) { store.set(k, String(v)); },
        removeItem(k) { store.delete(k); },
        clear() { store.clear(); }
    },
    API_SITES: {},
    extendAPISites(newSites) { calls.extend++; Object.assign(win.API_SITES, newSites); },
    removeAPISitesByPrefix(prefix) {
        calls.removePrefix.push(prefix);
        Object.keys(win.API_SITES).forEach(function (k) {
            if (k.indexOf(prefix) === 0) delete win.API_SITES[k];
        });
    },
    initAPICheckboxes() { calls.initCheckboxes++; },
    prefetchAPISiteDns() { calls.prefetch++; },
    document: doc,
    navigator: { onLine: true },
    fetch(url, opts) {
        calls.fetch.push({ url: url, opts: opts });
        return fetchImpl ? fetchImpl(url, opts) : Promise.reject(new Error('fetch 未配置'));
    },
    setTimeout(fn, ms) {
        if (!ms || ms === 0) { fn(); return 1; }   // schedule 的 0ms 延迟立即执行，便于同步断言
        scheduled.push({ fn: fn, ms: ms }); return scheduled.length; // 6s abort 定时器不执行
    },
    clearTimeout() {},
    AbortController: MockAbortController
};

globalThis.window = win;
await import('../js/source-subscription.js');

const S = win.WDTVSourceSubscriptions || globalThis.WDTVSourceSubscriptions;
const I = S._internals;

// ===================== 断言与小工具 =====================
let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
    if (cond) { pass++; console.log('  ok  ' + name); }
    else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}
function okRes(text) {
    return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(text); } });
}
function SRC(name, url, detail) { return { name: name, url: url, detail: detail || '' }; }
function sourceList(sources, extra) { return JSON.stringify(Object.assign({ sources: sources }, extra || {})); }
function reset(opts) {
    opts = opts || {};
    store.clear();
    calls.fetch.length = 0;
    calls.extend = 0; calls.initCheckboxes = 0; calls.prefetch = 0;
    calls.removePrefix.length = 0;
    scheduled.length = 0;
    doc.hidden = !!opts.hidden;
    win.navigator.onLine = opts.offline ? false : true;
    win.API_SITES = {
        heimuer: { api: 'https://json.heimuer.xyz', name: '黑木耳' },
        qiqi: { api: 'https://www.qiqidys.com/api.php/provide/vod', name: '七七资源' }
    };
    fetchImpl = null;
}
async function tick() {
    await new Promise(function (r) { realSetTimeout(r, 0); });
    await new Promise(function (r) { realSetTimeout(r, 0); });
}
const SUB = 'https://sub.example.com/list.json';
const PREFIX_LEN = '/proxy/'.length;

console.log('\n[1] 模块加载 / API 完整性 / add 归一化与校验');
{
    t('mock window 可见', typeof window !== 'undefined' && window === win);
    t('WDTVSourceSubscriptions 挂到 window', !!win.WDTVSourceSubscriptions);
    t('公开 API 齐全', !!S && ['list', 'add', 'remove', 'setRefreshDays', 'setEnabled', 'resume',
        'syncOne', 'syncAll', 'autoRefresh', 'exportAll', 'render', 'setStatus']
        .every(function (k) { return typeof S[k] === 'function'; }));
    t('模块注册 DOMContentLoaded 兜底', docHandlers.some(function (h) { return h.type === 'DOMContentLoaded'; }));

    reset();
    t('add：trim + 去尾斜杠', S.add('  ' + SUB + '/  ') === true && S.list()[0].url === SUB);
    t('add：name 默认取 host', S.list()[0].name === 'sub.example.com');
    t('add：refreshDays 默认 0（纯手动）', S.list()[0].refreshDays === 0);
    t('add：enabled 默认 true', S.list()[0].enabled === true);
    t('add：去重', S.add(SUB) === false && S.list().length === 1);
    t('add：非 http(s) 拒绝', S.add('ftp://x/list.json') === false);
    t('add：空值拒绝', S.add('   ') === false);
    t('add：私网订阅地址拒绝', S.add('http://192.168.1.1/list.json') === false);
}

console.log('\n[2] JSONC 清洗（不误伤 https://，去注释/尾逗号，字符串内裸换行转义）');
{
    const raw = '{\n'
        + '  // 顶部注释 https://not-a-comment\n'
        + '  "sources": [\n'
        + '    { "name": "A", "url": "https://a.example.com/api.php/provide/vod", },\n'
        + '  ],\n'
        + '  "note": "字符串里的 https:// 不能被当注释，且这里\n有裸换行"\n'
        + '}';
    const cleaned = I.stripJSONC(raw);
    let parsed = null, parseOk = true;
    try { parsed = JSON.parse(cleaned); } catch (e) { parseOk = false; }
    t('JSONC 清洗后可 parse', parseOk && !!parsed);
    t('https:// 完整保留', !!parsed && parsed.sources[0].url === 'https://a.example.com/api.php/provide/vod');
    t('行注释已去除', cleaned.indexOf('顶部注释') === -1);
    t('字符串内 https:// 保留', !!parsed && parsed.note.indexOf('https://') >= 0);
    t('字符串内裸换行转义为 \\n', !!parsed && parsed.note.indexOf('\n') >= 0);
    t('块注释 + 尾逗号', (function () {
        try { return JSON.parse(I.stripJSONC('{"a":1, /* 块 */ "b":2,}')).b === 2; } catch (e) { return false; }
    })());

    // 端到端：带注释/尾逗号的配置能被同步解析
    reset(); S.add(SUB);
    fetchImpl = function () { return okRes(raw); };
    await S.syncOne(SUB, {});
    t('端到端：JSONC 配置成功导入 1 个源', S.list()[0].counts.vod === 1);
}

console.log('\n[3] 格式嗅探（SourceList / TVBOX / 接口目录 / 裸数组 / 混用报错）');
{
    const r1 = I.sniff({ sources: [SRC('A', 'https://a.example.com/vod')], liveSources: [{}, {}], lives: [{}] });
    t('SourceList：format / vod / live 计数', r1.format === 'sourcelist' && r1.vod.length === 1 && r1.live === 3);

    const r2 = I.sniff({
        sites: [
            { name: 'A', type: 1, api: 'https://a.example.com/api.php/provide/vod' },       // 导入
            { name: 'B', type: 1, api: 'https://b.example.com/csp_Xyz' },                   // Spider → 跳过
            { name: 'C', type: 1, api: 'https://c.example.com/vod', searchable: 0 },        // searchable:0 → 跳过
            { name: 'D', type: 0, api: 'https://d.example.com/vod.xml' },                   // XML → 跳过
            { name: 'E', type: 0, api: 'https://e.example.com/api.php/provide/vod' }        // provide/vod → 导入
        ],
        lives: [{}]
    });
    t('TVBOX：format', r2.format === 'tvbox');
    t('TVBOX：仅导入 A / E', r2.vod.length === 2 &&
        r2.vod[0].api.indexOf('a.example') >= 0 && r2.vod[1].api.indexOf('e.example') >= 0);
    t('TVBOX：lives 计数', r2.live === 1);
    t('TVBOX：Spider/searchable:0/XML 跳过', r2.skipped === 3);

    const r3 = I.sniff([
        { name: 'X', baseUrl: 'https://x.example.com', enabled: false },
        { name: 'Y', baseUrl: 'https://y.example.com' },
        { name: 'Z', baseUrl: 'https://z.example.com', enabled: true }
    ]);
    t('接口目录：format', r3.format === 'catalog');
    t('接口目录：只取 baseUrl 且跳过 enabled:false', r3.vod.length === 2 &&
        r3.vod.every(function (v) { return v.api.indexOf('x.example') === -1; }));

    let threwMix = false;
    try {
        I.sniff([{ name: 'a', baseUrl: 'https://a.example.com' }, { name: 'b', url: 'https://b.example.com' }]);
    } catch (e) { threwMix = true; }
    t('混用 baseUrl 与 url：直接报格式错误', threwMix);

    const r4 = I.sniff([SRC('P', 'https://p.example.com'), SRC('Q', 'https://q.example.com')]);
    t('裸数组 [{name,url}]：array', r4.format === 'array' && r4.vod.length === 2);

    let threwUnknown = false;
    try { I.sniff({ foo: 1 }); } catch (e) { threwUnknown = true; }
    t('无法识别的格式：报错', threwUnknown);
}

console.log('\n[4] 私网字面量守卫（纯函数 + 导入源校验，不误伤域名）');
{
    const BLOCK = [
        'http://127.0.0.1/', 'http://192.168.1.5/x', 'http://10.0.0.1/', 'http://169.254.169.254/',
        'http://localhost/', 'http://[::1]/', 'http://2130706433/', 'ftp://x/'
    ];
    BLOCK.forEach(function (u) { t('拒绝 ' + u, I.isBlockedLiteral(u) === true); });
    const ALLOW = [
        'https://json.heimuer.xyz/', 'http://ffzy5.tv/', 'https://10.example.com/', 'https://192.168.example.com/'
    ];
    ALLOW.forEach(function (u) { t('放行 ' + u, I.isBlockedLiteral(u) === false); });
    t('isPublicHttp 拒非 http(s)', I.isPublicHttp('ftp://x/') === false);
    t('isPublicHttp 拒私网', I.isPublicHttp('http://192.168.1.5/vod') === false);
    t('isPublicHttp 放公网 http', I.isPublicHttp('http://ffzy5.tv/') === true);

    reset(); S.add(SUB);
    fetchImpl = function () {
        return okRes(sourceList([
            SRC('priv', 'http://192.168.1.5/vod'),
            SRC('lo', 'http://localhost/vod'),
            SRC('pub', 'https://pub.example.com/vod'),
            SRC('look', 'https://10.example.com/vod')
        ]));
    };
    await S.syncOne(SUB, {});
    const apis = Object.keys(win.API_SITES)
        .filter(function (k) { return k.indexOf(I.subPrefix(SUB)) === 0; })
        .map(function (k) { return win.API_SITES[k].api; });
    t('私网导入源被拒（仅剩 2 个公网）', apis.length === 2);
    t('形似私网域名 10.example.com 不误伤', apis.some(function (a) { return a.indexOf('10.example.com') >= 0; }) &&
        apis.some(function (a) { return a.indexOf('pub.example.com') >= 0; }));
}

console.log('\n[5] 数量上限 100 与去重（按 url 先到先得）');
{
    reset(); S.add(SUB);
    fetchImpl = function () {
        return okRes(sourceList([
            SRC('A', 'https://a.example.com/vod'),
            SRC('A2', 'https://a.example.com/vod'),  // 与 A 重复
            SRC('B', 'https://b.example.com/vod')
        ]));
    };
    await S.syncOne(SUB, {});
    t('去重：3 条含 1 重复 → 导入 2', S.list()[0].counts.vod === 2);

    reset(); S.add(SUB);
    const many = [];
    for (let i = 0; i < 120; i++) many.push(SRC('S' + i, 'https://s' + i + '.example.com/api.php/provide/vod'));
    many.push(SRC('dup', many[0].url));
    fetchImpl = function () { return okRes(sourceList(many)); };
    await S.syncOne(SUB, {});
    t('上限：counts.vod === 100', S.list()[0].counts.vod === 100);
    const keys = Object.keys(win.API_SITES).filter(function (k) { return k.indexOf(I.subPrefix(SUB)) === 0; });
    t('上限：API_SITES 前缀源恰 100 个', keys.length === 100);
}

console.log('\n[6] 直连成功时不走代理');
{
    reset(); S.add(SUB);
    fetchImpl = function () { return okRes(sourceList([SRC('A', 'https://a.example.com/vod')])); };
    await S.syncOne(SUB, {});
    t('只 fetch 1 次', calls.fetch.length === 1);
    t('第 1 次 URL 就是订阅地址', calls.fetch[0].url === SUB);
    t('直连 URL 不含 _wdtv', calls.fetch[0].url.indexOf('_wdtv') === -1);
    t('直连非 /proxy/ 路径', calls.fetch[0].url.indexOf('/proxy/') !== 0);
    t('直连带 Accept: application/json', calls.fetch[0].opts.headers.Accept === 'application/json');
    t('同步成功导入 1 个源', S.list()[0].counts.vod === 1);
}

console.log('\n[7] 直连失败回退路径式代理，且 URL 含 _wdtv 小时戳换缓存键');
{
    reset(); S.add(SUB);
    let n = 0;
    fetchImpl = function () {
        n++;
        return n === 1 ? Promise.reject(new Error('CORS'))
            : okRes(sourceList([SRC('A', 'https://a.example.com/vod')]));
    };
    await S.syncOne(SUB, {});
    t('共 2 次 fetch（直连 + 代理）', calls.fetch.length === 2);
    t('第 1 次为直连', calls.fetch[0].url === SUB);
    const proxyUrl = calls.fetch[1].url;
    t('代理为路径式 /proxy/', proxyUrl.indexOf('/proxy/') === 0);
    t('代理非查询式 ?url=', proxyUrl.indexOf('?url=') === -1);
    const decoded = decodeURIComponent(proxyUrl.slice(PREFIX_LEN));
    t('代理目标含 _wdtv 10 位小时戳', /_wdtv=\d{10}$/.test(decoded), decoded);
    t('代理目标以订阅 URL 开头', decoded.indexOf(SUB) === 0);
    t('代理回退后同步成功', S.list()[0].counts.vod === 1);

    // 已有查询串时用 & 拼接
    reset();
    const SUB2 = 'https://sub.example.com/list.json?token=abc';
    S.add(SUB2);
    n = 0;
    fetchImpl = function () {
        n++;
        return n === 1 ? Promise.reject(new Error('CORS'))
            : okRes(sourceList([SRC('A', 'https://a.example.com/vod')]));
    };
    await S.syncOne(SUB2, {});
    const dec2 = decodeURIComponent(calls.fetch[1].url.slice(PREFIX_LEN));
    t('已有查询串用 &_wdtv= 拼接', dec2.indexOf('token=abc&_wdtv=') >= 0 && /_wdtv=\d{10}$/.test(dec2), dec2);
}

console.log('\n[8] 同步失败不改动源集合（无副作用）');
{
    reset(); S.add(SUB);
    const before = JSON.stringify(win.API_SITES);
    fetchImpl = function () { return Promise.reject(new Error('down')); };
    await S.syncOne(SUB, {});
    t('失败：API_SITES 与同步前完全一致', JSON.stringify(win.API_SITES) === before);
    t('失败：不调用 extendAPISites', calls.extend === 0);
    t('失败：不清旧前缀源', calls.removePrefix.length === 0);
    t('失败：failStreak = 1', S.list()[0].failStreak === 1);
}

console.log('\n[9] 连续 3 次失败 paused；手动 force 成功重置');
{
    reset(); S.add(SUB);
    fetchImpl = function () { return Promise.reject(new Error('down')); };
    for (let i = 0; i < 3; i++) await S.syncOne(SUB, {});
    let it = S.list()[0];
    t('连续 3 次：failStreak = 3', it.failStreak === 3);
    t('连续 3 次：paused = true', it.paused === true);

    fetchImpl = function () { return okRes(sourceList([SRC('A', 'https://a.example.com/vod')])); };
    await S.syncOne(SUB, { force: true });
    it = S.list()[0];
    t('手动 force 成功：failStreak 重置 0', it.failStreak === 0);
    t('手动 force 成功：paused 重置 false', it.paused === false);
    t('手动 force 成功：lastSync 更新', it.lastSync > 0);
}

console.log('\n[10] remove 只删前缀源保留手动源；默认勾选；重复同步不累积');
{
    reset(); S.add(SUB);
    fetchImpl = function () {
        return okRes(sourceList([
            SRC('A', 'https://a.example.com/vod'),
            SRC('B', 'https://b.example.com/api.php/provide/vod')
        ]));
    };
    await S.syncOne(SUB, {});
    const prefix = I.subPrefix(SUB);
    const imported = Object.keys(win.API_SITES).filter(function (k) { return k.indexOf(prefix) === 0; });
    t('导入 2 个前缀源', imported.length === 2);
    const selBefore = JSON.parse(store.get('selectedAPIs') || '[]');
    t('新导入源默认勾选（写入 selectedAPIs）', imported.every(function (k) { return selBefore.indexOf(k) >= 0; }));
    t('同步后手动源仍在', !!win.API_SITES.heimuer && !!win.API_SITES.qiqi);

    S.remove(SUB);
    t('remove：前缀源全部清空', Object.keys(win.API_SITES).filter(function (k) { return k.indexOf(prefix) === 0; }).length === 0);
    t('remove：保留手动源 heimuer / qiqi', !!win.API_SITES.heimuer && !!win.API_SITES.qiqi);
    const selAfter = JSON.parse(store.get('selectedAPIs') || '[]');
    t('remove：selectedAPIs 不含前缀 key', !selAfter.some(function (k) { return k.indexOf(prefix) === 0; }));
    t('remove：订阅条目已移除', S.list().length === 0);
    t('remove：调用了 removeAPISitesByPrefix', calls.removePrefix.some(function (p) { return p === prefix; }));

    // 重复同步：先清旧再合并新，不累积旧源
    reset(); S.add(SUB);
    fetchImpl = function () {
        return okRes(sourceList([
            SRC('A', 'https://a.example.com/vod'),
            SRC('B', 'https://b.example.com/vod'),
            SRC('C', 'https://c.example.com/vod')
        ]));
    };
    await S.syncOne(SUB, {});
    const n1 = Object.keys(win.API_SITES).filter(function (k) { return k.indexOf(prefix) === 0; }).length;
    fetchImpl = function () { return okRes(sourceList([SRC('A', 'https://a.example.com/vod')])); };
    await S.syncOne(SUB, {});
    const n2 = Object.keys(win.API_SITES).filter(function (k) { return k.indexOf(prefix) === 0; }).length;
    t('重复同步替换旧源（3 → 1，不累积）', n1 === 3 && n2 === 1);
}

console.log('\n[11] setRefreshDays / setEnabled / resume');
{
    reset(); S.add(SUB);
    S.setRefreshDays(SUB, 7);
    t('setRefreshDays 合法值 7', S.list()[0].refreshDays === 7);
    S.setRefreshDays(SUB, 999);
    t('setRefreshDays 非法值钳制为 0', S.list()[0].refreshDays === 0);
    S.setEnabled(SUB, false);
    t('setEnabled false', S.list()[0].enabled === false);
    S.setEnabled(SUB, true);
    t('setEnabled true', S.list()[0].enabled === true);

    let arr = JSON.parse(store.get('wdtvSourceSubscriptions'));
    arr[0].failStreak = 5; arr[0].paused = true;
    store.set('wdtvSourceSubscriptions', JSON.stringify(arr));
    S.setRefreshDays(SUB, 3);
    t('改周期重置 failStreak / paused', S.list()[0].failStreak === 0 && S.list()[0].paused === false);

    arr = JSON.parse(store.get('wdtvSourceSubscriptions'));
    arr[0].failStreak = 4; arr[0].paused = true;
    store.set('wdtvSourceSubscriptions', JSON.stringify(arr));
    S.resume(SUB);
    t('resume 清 failStreak / paused', S.list()[0].failStreak === 0 && S.list()[0].paused === false);
}

console.log('\n[12] autoRefresh：页面不可见 / 离线跳过');
{
    reset({ hidden: true }); S.add(SUB); S.setRefreshDays(SUB, 1);
    fetchImpl = function () { return okRes(sourceList([SRC('A', 'https://a.example.com/vod')])); };
    S.autoRefresh();
    t('document.hidden 跳过（无 fetch）', calls.fetch.length === 0);

    reset({ offline: true }); S.add(SUB); S.setRefreshDays(SUB, 1);
    fetchImpl = function () { return okRes(sourceList([SRC('A', 'https://a.example.com/vod')])); };
    S.autoRefresh();
    t('navigator.onLine === false 跳过（无 fetch）', calls.fetch.length === 0);
}

console.log('\n[13] exportAll 结构（LibreTV-SourceList v2）');
{
    reset();
    const ex = S.exportAll();
    t('version === 2', ex.version === 2);
    t('sources 为数组', Array.isArray(ex.sources));
    t('含当前点播源', ex.sources.some(function (s) { return s.url === 'https://json.heimuer.xyz'; }));
    t('每条含 name / url / detail / isAdult=false', ex.sources.every(function (s) {
        return s.name && s.url && typeof s.detail === 'string' && s.isAdult === false;
    }));
    t('liveSources 为空数组', Array.isArray(ex.liveSources) && ex.liveSources.length === 0);
}

console.log('\n[14] autoRefresh：正常状态 + 到期订阅会触发刷新（放最后，避免幂等锁影响其它用例）');
{
    reset(); S.add(SUB); S.setRefreshDays(SUB, 1);
    fetchImpl = function () { return okRes(sourceList([SRC('A', 'https://a.example.com/vod')])); };
    S.autoRefresh();
    await tick();
    t('正常状态触发刷新（有 fetch）', calls.fetch.length >= 1);
}

console.log('\n[15] 补充：status 文案脱敏 / 入参归一化 / autoRefresh 强制版');
{
    // 成功：已同步 N 个点播源，且不暴露订阅 URL / 域名 / 上游源域名
    reset(); S.add(SUB);
    fetchImpl = function () {
        return okRes(sourceList([
            SRC('A', 'https://a.example.com/vod'), SRC('B', 'https://b.example.com/vod')
        ]));
    };
    await S.syncOne(SUB, {});
    const okText = els.wdtvSubscriptionStatus.textContent || '';
    t('成功文案「已同步 2 个点播源」', okText.indexOf('已同步 2 个点播源') >= 0, okText);
    t('成功文案不含订阅 URL / 域名', okText.indexOf('sub.example.com') === -1 && okText.indexOf(SUB) === -1, okText);
    t('成功文案不含上游源域名', okText.indexOf('a.example.com') === -1, okText);

    // 失败：通用文案，不暴露上游 URL
    reset(); S.add(SUB);
    fetchImpl = function () { return Promise.reject(new Error('down')); };
    await S.syncOne(SUB, {});
    const failText = els.wdtvSubscriptionStatus.textContent || '';
    t('失败文案为通用文案', failText === '同步失败，请稍后重试', failText);
    t('失败文案不含订阅 URL', failText.indexOf('sub.example.com') === -1 && failText.indexOf(SUB) === -1, failText);

    // 各 CRUD 操作文案均不暴露订阅 URL
    reset(); S.add(SUB);
    t('add 文案不暴露 URL', (els.wdtvSubscriptionStatus.textContent || '').indexOf(SUB) === -1);
    S.setRefreshDays(SUB, 3);
    t('setRefreshDays 文案不暴露 URL', (els.wdtvSubscriptionStatus.textContent || '').indexOf(SUB) === -1);
    S.setEnabled(SUB, false);
    t('setEnabled 文案不暴露 URL', (els.wdtvSubscriptionStatus.textContent || '').indexOf(SUB) === -1);
    S.resume(SUB);
    t('resume 文案不暴露 URL', (els.wdtvSubscriptionStatus.textContent || '').indexOf(SUB) === -1);
    S.remove(SUB);
    t('remove 文案不暴露 URL', (els.wdtvSubscriptionStatus.textContent || '').indexOf(SUB) === -1);

    // render 输出普通结构，条目带 data-sub-url，不依赖类名
    reset(); S.add(SUB);
    const html = els.wdtvSubscriptionList.innerHTML || '';
    t('列表项带 data-sub-url', html.indexOf('data-sub-url=') >= 0);
    t('列表项为普通 div（不依赖类名）', html.indexOf('<div data-sub-url=') >= 0 && html.indexOf('class=') === -1, html.slice(0, 120));

    // 场景②：已在 list 的订阅，用原始（带空格/尾斜杠）URL 也能强制同步
    reset(); S.add(SUB);
    fetchImpl = function () { return okRes(sourceList([SRC('A', 'https://a.example.com/vod')])); };
    const n = await S.syncOne('  ' + SUB + '/  ', { force: true });
    t('syncOne 归一化入参后能匹配已存在订阅', n === 1 && S.list()[0].counts.vod === 1, 'n=' + n);

    // autoRefresh 强制版：refreshDays=0 也刷新（忽略到期判断），且不受 _autoStarted 幂等锁限制
    reset(); S.add(SUB);
    fetchImpl = function () { return okRes(sourceList([SRC('A', 'https://a.example.com/vod')])); };
    S.autoRefresh({ force: true });
    await tick();
    t('autoRefresh force 忽略到期判断触发同步', calls.fetch.length >= 1, 'fetch=' + calls.fetch.length);
    t('autoRefresh force 后 status 汇总成功文案',
        (els.wdtvSubscriptionStatus.textContent || '').indexOf('已同步') >= 0, els.wdtvSubscriptionStatus.textContent);
}

console.log('\n========================================');
console.log('结果：' + pass + ' 通过，' + fail + ' 失败');
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
