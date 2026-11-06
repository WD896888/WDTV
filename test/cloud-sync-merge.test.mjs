// WDTV 云同步合并分支与裁剪提示自测（Node ESM，零依赖，不随部署）
// 运行：node test/cloud-sync-merge.test.mjs  或  node scripts/run-tests.mjs
// 用最小桩加载 js/cloud-sync.js（IIFE + window.CloudSync），取 CloudSync._merge /
// CloudSync._trimPayloadToLimit，验证 wdtvSkipMarks / wdtvSourceSubscriptions 两个专用合并分支、
// 脏数据回退，以及兜底裁剪派发 wdtv-sync-trimmed 事件。

// ===================== mock 环境（必须在 import 模块之前建立） =====================
// cloud-sync.js 的 init() 在脚本加载时同步执行：会读 localStorage、包装 setItem/removeItem、
// 并调用 setInterval 起定时轮询。这里用最小桩让它安全跑完且不留下活跃定时器。
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = function () { return 0; };   // 阻止 15s 轮询定时器让进程挂住

const storeData = new Map();
const store = {
    getItem(k) { return storeData.has(k) ? storeData.get(k) : null; },
    setItem(k, v) { storeData.set(k, String(v)); },
    removeItem(k) { storeData.delete(k); },
    clear() { storeData.clear(); },
    length: 0,
    key() { return null; }
};

// 记录 cloud-sync.js 兜底裁剪派发的事件（window.dispatchEvent）
const dispatched = [];
const win = {
    dispatchEvent(ev) { dispatched.push(ev); return true; }
    // 故意不提供 addEventListener / WDTVTheme：startTimers / applyItems 的对应分支跳过
};

// CustomEvent 在 Node 里未必内建，提供最小实现；cloud-sync.js 用 typeof 守卫，缺失时静默
globalThis.CustomEvent = class {
    constructor(type, opts) { this.type = type; this.detail = (opts && opts.detail) || {}; }
};

globalThis.window = win;
globalThis.localStorage = store;
await import('../js/cloud-sync.js');
globalThis.setInterval = realSetInterval;

const CS = win.CloudSync;

// ===================== 断言小工具 =====================
let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
    if (cond) { pass++; console.log('  ok  ' + name); }
    else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}
function eq(actual, expected, name) {
    t(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}
// 构造 {key: {value, updatedAt}} 形式条目
function entry(value, updatedAt) { return { value: value, updatedAt: updatedAt }; }

console.log('\n[1] 模块加载 / 测试导出可用');
{
    t('挂到 window.CloudSync', !!(CS && typeof CS === 'object'));
    t('导出 _merge', typeof CS._merge === 'function');
    t('导出 _trimPayloadToLimit', typeof CS._trimPayloadToLimit === 'function');
}

console.log('\n[2] wdtvSkipMarks：marks 并集 + 同 key 取 updatedAt 大者 + enabled 取 updatedAt 大侧 + max');
{
    const L = entry({
        enabled: false,
        marks: {
            a: { segments: [1], enabled: true, updatedAt: 10 },
            b: { segments: [2], enabled: true, updatedAt: 20 }
        },
        updatedAt: 100
    }, 100);
    const C = entry({
        enabled: true,
        marks: {
            b: { segments: [9], enabled: false, updatedAt: 25 },   // 25 > 20 → 云端胜
            c: { segments: [3], enabled: true, updatedAt: 30 }
        },
        updatedAt: 200
    }, 200);
    const r = CS._merge({ wdtvSkipMarks: L }, { wdtvSkipMarks: C }).wdtvSkipMarks;
    const marks = r.value.marks;
    t('marks 取并集 a/b/c', ['a', 'b', 'c'].every(k => Object.prototype.hasOwnProperty.call(marks, k)) &&
        Object.keys(marks).length === 3, JSON.stringify(Object.keys(marks)));
    t('a 为本地独有（保留本地）', marks.a.segments[0] === 1);
    t('同 key b 取条目 updatedAt 大者（云端 25>20）', marks.b.segments[0] === 9);
    t('c 为云端独有', marks.c.segments[0] === 3);
    eq(r.value.enabled, true, 'enabled 取顶层 updatedAt 较大一侧（云端 200>100）');
    eq(r.value.updatedAt, 200, '结果 value.updatedAt = max');
    eq(r.updatedAt, 200, '结果 entry.updatedAt = max');
}

console.log('\n[3] wdtvSkipMarks：冲突本地 updatedAt 大 → 保留本地；enabled 相等保留本地');
{
    const L = entry({
        enabled: true,
        marks: { k: { segments: ['L'], enabled: true, updatedAt: 100 } },
        updatedAt: 50
    }, 50);
    const C = entry({
        enabled: false,
        marks: { k: { segments: ['C'], enabled: false, updatedAt: 50 } },
        updatedAt: 50   // 顶层 updatedAt 相等 → enabled 保留本地
    }, 50);
    const r = CS._merge({ wdtvSkipMarks: L }, { wdtvSkipMarks: C }).wdtvSkipMarks;
    t('同 key 本地条目 updatedAt 大 → 保留本地', r.value.marks.k.segments[0] === 'L');
    eq(r.value.enabled, true, '顶层 updatedAt 相等时 enabled 保留本地');
    eq(r.updatedAt, 50, 'entry.updatedAt = max(50,50)');
}

console.log('\n[4] wdtvSkipMarks：脏数据回退 last-write-wins（不抛错、返回原对象引用）');
{
    const good = entry({ enabled: true, marks: { x: { segments: [], updatedAt: 1 } }, updatedAt: 1 }, 200);
    // 非对象值
    const dirtyNonObj = entry('garbage', 100);
    let threw = false, r;
    try { r = CS._merge({ wdtvSkipMarks: dirtyNonObj }, { wdtvSkipMarks: good }).wdtvSkipMarks; }
    catch (e) { threw = true; }
    t('非对象值不抛异常', !threw);
    t('非对象值回退：云端 updatedAt 大 → 返回云端原对象', r === good);

    // marks 字段缺失（结构字段缺失）
    const dirtyNoMarks = entry({ enabled: true, updatedAt: 100 }, 100);
    const r2 = CS._merge({ wdtvSkipMarks: dirtyNoMarks }, { wdtvSkipMarks: good }).wdtvSkipMarks;
    t('marks 缺失回退：返回云端原对象', r2 === good);

    // null 删除标记（值非对象）
    const r3 = CS._merge({ wdtvSkipMarks: entry(null, 100) }, { wdtvSkipMarks: good }).wdtvSkipMarks;
    t('null 删除标记回退：返回云端原对象', r3 === good);

    // 相等 / 本地更大 → last-write-wins 保留本地
    const localNewer = entry('L', 300);
    const cloudOlder = entry('C', 200);
    const r4 = CS._merge({ wdtvSkipMarks: localNewer }, { wdtvSkipMarks: cloudOlder }).wdtvSkipMarks;
    t('脏数据且本地 updatedAt 大 → 保留本地原对象', r4 === localNewer);
}

console.log('\n[5] wdtvSourceSubscriptions：归一化去重 + 本地顺序在前 + 云端独有追加');
{
    const L = entry([
        { url: 'https://a/', updatedAt: 10, tag: 'L' },   // 尾斜杠归一化
        { url: 'https://b', updatedAt: 20, tag: 'L' }
    ], 100);
    const C = entry([
        { url: 'https://a', updatedAt: 5, tag: 'C' },      // 与本地同 url，5 < 10 → 保留本地
        { url: 'https://c', updatedAt: 30, tag: 'C' }
    ], 200);
    const r = CS._merge({ wdtvSourceSubscriptions: L }, { wdtvSourceSubscriptions: C }).wdtvSourceSubscriptions;
    const arr = r.value;
    eq(arr.length, 3, '并集共 3 条（a/b/c，按 url 去重）');
    eq(arr[0].url, 'https://a/', '第 1 条为本地 a（本地顺序在前）');
    eq(arr[0].tag, 'L', '同 url 本地 updatedAt 大 → 保留本地');
    eq(arr[1].url, 'https://b', '第 2 条为本地 b');
    eq(arr[2].url, 'https://c', '云端独有 c 追加在末尾');
    eq(r.updatedAt, 200, 'entry.updatedAt = max');
}

console.log('\n[6] wdtvSourceSubscriptions：同 url 云端 updatedAt 大 → 取新但保留本地位置');
{
    const L = entry([
        { id: 'https://a', updatedAt: 10, tag: 'L' },     // 用 id 归一化
        { url: 'https://b', updatedAt: 10, tag: 'L' }
    ], 100);
    const C = entry([
        { url: 'https://a/', updatedAt: 50, tag: 'C' },   // 50 > 10 → 云端胜
        { url: 'https://b', updatedAt: 5, tag: 'C' }
    ], 100);
    const r = CS._merge({ wdtvSourceSubscriptions: L }, { wdtvSourceSubscriptions: C }).wdtvSourceSubscriptions;
    eq(r.value.length, 2, '仍 2 条（无重复、无丢失）');
    eq(r.value[0].tag, 'C', 'a 取云端新条目');
    eq(r.value[0].url, 'https://a/', '取新后沿用云端对象（位置仍在首位）');
    eq(r.value[1].tag, 'L', 'b 本地 updatedAt 大 → 保留本地');
}

console.log('\n[7] wdtvSourceSubscriptions：脏数据回退 last-write-wins（不抛错、返回原对象引用）');
{
    const good = entry([{ url: 'https://a', updatedAt: 1 }], 200);
    // 一侧非数组
    const dirtyNotArray = entry({ url: 'https://a' }, 100);
    let threw = false, r;
    try { r = CS._merge({ wdtvSourceSubscriptions: dirtyNotArray }, { wdtvSourceSubscriptions: good }).wdtvSourceSubscriptions; }
    catch (e) { threw = true; }
    t('非数组不抛异常', !threw);
    t('非数组回退：返回云端原对象', r === good);

    // 元素缺 url/id（字段缺失）
    const dirtyNoKey = entry([{ name: 'x' }], 100);
    const r2 = CS._merge({ wdtvSourceSubscriptions: dirtyNoKey }, { wdtvSourceSubscriptions: good }).wdtvSourceSubscriptions;
    t('元素缺 url/id 回退：返回云端原对象', r2 === good);

    // 元素为 null
    const dirtyNullItem = entry([null], 100);
    const r3 = CS._merge({ wdtvSourceSubscriptions: dirtyNullItem }, { wdtvSourceSubscriptions: good }).wdtvSourceSubscriptions;
    t('元素为 null 回退：返回云端原对象', r3 === good);
}

console.log('\n[8] 兜底裁剪清空 marks 时派发 wdtv-sync-trimmed（window 存在），无 window 静默');
{
    const big = 'X'.repeat(600 * 1024);   // > MAX_PAYLOAD(500KB)，且不会被前面的裁剪分支删掉
    function makePayload() {
        return {
            v: 1,
            items: {
                wdtvTheme: entry(big, 1),   // 让兜底后仍超限，触发清空主体分支
                wdtvSkipMarks: entry({
                    enabled: true,
                    marks: { k1: { segments: 'Y', enabled: true, updatedAt: 1 } },
                    updatedAt: 1
                }, 1),
                wdtvSourceSubscriptions: entry([{ url: 'https://a', updatedAt: 1 }], 1)
            }
        };
    }
    dispatched.length = 0;
    const p = makePayload();
    let threw = false;
    try { CS._trimPayloadToLimit(p); } catch (e) { threw = true; }
    t('裁剪不抛异常', !threw);
    t('marks 被兜底清空为 {}', p.items.wdtvSkipMarks.value.marks &&
        Object.keys(p.items.wdtvSkipMarks.value.marks).length === 0);
    t('订阅主体被兜底清空为 []', Array.isArray(p.items.wdtvSourceSubscriptions.value) &&
        p.items.wdtvSourceSubscriptions.value.length === 0);
    eq(dispatched.length, 1, '派发 1 次 wdtv-sync-trimmed');
    t('事件 type 正确', !!dispatched[0] && dispatched[0].type === 'wdtv-sync-trimmed');
    t('事件 detail.reason === payload-limit', !!dispatched[0] &&
        dispatched[0].detail && dispatched[0].detail.reason === 'payload-limit');

    // 无 window：静默（不派发、不抛错）
    dispatched.length = 0;
    const savedWin = globalThis.window;
    globalThis.window = undefined;
    const p2 = makePayload();
    let threw2 = false;
    try { CS._trimPayloadToLimit(p2); } catch (e) { threw2 = true; }
    globalThis.window = savedWin;
    t('无 window 时不抛异常（静默）', !threw2);
    eq(dispatched.length, 0, '无 window 时不派发事件');
    t('无 window 时仍完成兜底清空', Object.keys(p2.items.wdtvSkipMarks.value.marks).length === 0);
}

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
