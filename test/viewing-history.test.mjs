// WDTV 观看历史收敛自测（Node ESM，零依赖，不随部署）
// 运行：node --test test/viewing-history.test.mjs
// ui.js 顶层注册了 DOMContentLoaded 监听，需先 mock 最小 DOM / window / localStorage 再动态 import。

const store = new Map();
globalThis.localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); }
};

const elCache = new Map();
function fakeEl() {
    return {
        style: {}, dataset: {}, id: '', innerHTML: '', textContent: '',
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        appendChild(child) { if (child && child.id) elCache.set(child.id, child); },
        setAttribute() {}, getAttribute() { return null; },
        querySelector() { return null; }, addEventListener() {}, removeChild() {}
    };
}
globalThis.document = {
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return elCache.get(id) || null; }, querySelector() { return null; },
    createElement() { return fakeEl(); },
    body: {
        appendChild(el) { if (el && el.id) elCache.set(el.id, el); },
        removeChild(el) { if (el && el.id) elCache.delete(el.id); }
    }
};
// window 自引用：让 window.upsertViewingHistory / window.localStorage 与 globalThis 一致
globalThis.window = globalThis;
// 抑制 showToast 的入场动画与 3 秒定时器（测试只关心存储结果，不关心 toast 表现）
globalThis.requestAnimationFrame = () => 0;
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

await import('../js/ui.js');

let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
    if (cond) { pass++; console.log('  ok  ' + name); }
    else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}
function raw() { return JSON.parse(localStorage.getItem('viewingHistory') || '[]'); }
function reset() { localStorage.removeItem('viewingHistory'); }
const U = globalThis.upsertViewingHistory;
const G = globalThis.getViewingHistory;

console.log('\n[0] 全局导出');
{
    t('导出：window.upsertViewingHistory 为函数', typeof window.upsertViewingHistory === 'function');
    t('导出：addToViewingHistory / deleteHistoryItem / clearViewingHistory 均可用',
        typeof globalThis.addToViewingHistory === 'function' &&
        typeof globalThis.deleteHistoryItem === 'function' &&
        typeof globalThis.clearViewingHistory === 'function');
}

console.log('\n[1] 收敛：播放页形态 + 首页形态只产生 1 条');
{
    reset();
    // 播放页形态（sourceCode + vod_id，showIdentifier 为 heimuer_888）
    U({
        title: '庆余年', sourceCode: 'heimuer', vod_id: '888', sourceName: '黑木耳',
        showIdentifier: 'heimuer_888',
        url: 'player.html?url=ep1&source=heimuer&id=888&index=0',
        directVideoUrl: 'https://cdn.example.com/ep1.m3u8',
        episodes: ['https://cdn.example.com/ep1.m3u8', 'https://cdn.example.com/ep2.m3u8'],
        episodeIndex: 0, playbackPosition: 120, duration: 1800, timestamp: 1000
    });
    // 首页形态（source_code + vod_id，自带旧的中文源名形态 showIdentifier）
    U({
        title: '庆余年', source_code: 'heimuer', vod_id: '888', sourceName: '黑木耳',
        showIdentifier: '黑木耳_888',
        url: 'https://other.example.com/player?x=1',
        episodes: ['https://cdn.example.com/ep1.m3u8', 'https://cdn.example.com/ep2.m3u8'],
        episodeIndex: 1, timestamp: 2000
    });
    const h = raw();
    t('收敛：两形态只产生 1 条', h.length === 1, JSON.stringify(h));
    t('收敛：showIdentifier 统一为 sourceCode_vodId', h[0] && h[0].showIdentifier === 'heimuer_888', JSON.stringify(h[0]));
    t('收敛：不把中文 sourceName 当 ID', h[0] && String(h[0].showIdentifier).indexOf('黑木耳') === -1, String(h[0] && h[0].showIdentifier));
    t('收敛：sourceCode 保留为 heimuer', h[0] && h[0].sourceCode === 'heimuer', JSON.stringify(h[0]));
    t('收敛：sourceName 作为展示字段保留', h[0] && h[0].sourceName === '黑木耳', JSON.stringify(h[0]));
    t('收敛：合并最新字段（episodeIndex / url / timestamp）',
        h[0] && h[0].episodeIndex === 1 && h[0].timestamp === 2000, JSON.stringify(h[0]));
}

console.log('\n[2] 收敛：缺 sourceCode 的首页形态仍按 title 归并，最终收敛到稳定 ID');
{
    reset();
    U({ title: '雪中悍刀行', sourceName: '电影天堂', vod_id: '55', url: 'player.html?url=A', timestamp: 100 });
    U({ title: '雪中悍刀行', sourceCode: 'heimuer', vod_id: '55', sourceName: '黑木耳', url: 'player.html?url=B', timestamp: 200 });
    const h = raw();
    t('收敛：缺 sourceCode 与带 sourceCode 两形态归并成 1 条', h.length === 1, JSON.stringify(h));
    t('收敛：最终 showIdentifier 收敛为稳定 ID', h[0] && h[0].showIdentifier === 'heimuer_55', JSON.stringify(h[0]));
}

console.log('\n[3] 旧记录兼容：读取侧按 title 归并、不丢弃、字段兜底');
{
    reset();
    localStorage.setItem('viewingHistory', JSON.stringify([
        { title: '老剧A', url: 'http://old/1', sourceName: '旧源', episodeIndex: 2, timestamp: 100 },
        { title: '老剧A', url: 'http://old/2', sourceName: '旧源', timestamp: 200 },
        { title: '老剧B', url: 'http://old/3', timestamp: 50 }
    ]));
    const g = G();
    t('旧记录：按 title 归并后为 2 条（A 合 1、B 保留）', g.length === 2, JSON.stringify(g));
    t('旧记录：不被丢弃（A 与 B 都在）',
        g.some(x => x.title === '老剧A') && g.some(x => x.title === '老剧B'), JSON.stringify(g));
    t('旧记录：保留 timestamp 最新者（A 的 url 来自 200 那条）',
        (g.find(x => x.title === '老剧A') || {}).url === 'http://old/2', JSON.stringify(g));
    t('旧记录：字段兜底不抛错（title/url/timestamp 类型有效）',
        g.every(x => typeof x.title === 'string' && typeof x.url === 'string' && typeof x.timestamp === 'number'), JSON.stringify(g));

    // 写入时把旧记录升级为统一标识并归并重复
    U({ title: '老剧A', sourceCode: 'heimuer', vod_id: '77', url: 'player.html?url=new', timestamp: 300 });
    const h = raw();
    t('旧记录：写入后 A 只剩 1 条且升级为统一 ID',
        h.filter(x => x.title === '老剧A').length === 1 &&
        (h.find(x => x.title === '老剧A') || {}).showIdentifier === 'heimuer_77', JSON.stringify(h));
    t('旧记录：B 仍保留不被丢弃', h.some(x => x.title === '老剧B'), JSON.stringify(h));
}

console.log('\n[3b] 脏数据 / 解析失败不白屏');
{
    reset();
    localStorage.setItem('viewingHistory', '{bad json');
    let okParse = false, arr = null;
    try { arr = G(); okParse = true; } catch (e) { okParse = false; }
    t('兼容：解析失败返回空数组且不抛错', okParse && Array.isArray(arr) && arr.length === 0, JSON.stringify(arr));

    localStorage.setItem('viewingHistory', JSON.stringify([null, 42, { title: '有效剧', url: 'u' }, 'str']));
    const g = G();
    t('兼容：脏条目被跳过、有效条目保留', g.length === 1 && g[0].title === '有效剧', JSON.stringify(g));
}

console.log('\n[4] 删除 / 清空生效');
{
    reset();
    U({ title: '甲', sourceCode: 's1', vod_id: '1', url: 'url-jia', timestamp: 100 });
    U({ title: '乙', sourceCode: 's2', vod_id: '2', url: 'url-yi', timestamp: 200 });
    globalThis.deleteHistoryItem(encodeURIComponent('url-jia'));
    const h = raw();
    t('删除：按 url 删除生效', h.length === 1 && h[0].title === '乙', JSON.stringify(h));
    globalThis.clearViewingHistory();
    t('清空：localStorage 键被移除', localStorage.getItem('viewingHistory') === null);
    t('清空：getViewingHistory 返回空数组', G().length === 0);
}

console.log('\n[5] URL 不当剧级 ID');
{
    reset();
    const ep1 = 'https://cdn.example.com/ep1.m3u8';
    U({
        title: '无ID剧', directVideoUrl: 'https://cdn.example.com/live.m3u8',
        episodes: [ep1, 'https://cdn.example.com/ep2.m3u8'], url: 'player.html?url=xyz',
        episodeIndex: 0, timestamp: 100
    });
    const h = raw();
    const id = h[0] && h[0].showIdentifier;
    t('URL：缺参时写入不抛错且产生 1 条', h.length === 1, JSON.stringify(h));
    t('URL：showIdentifier 不含 http / ://（不是 URL）',
        !!id && id.indexOf('http') === -1 && id.indexOf('://') === -1, String(id));
    t('URL：showIdentifier 不等于 episodes[0] / directVideoUrl',
        id !== ep1 && id !== 'https://cdn.example.com/live.m3u8', String(id));
    t('URL：回退为 title 归一化值', id === 'title:无id剧', String(id));

    // 换源（不同 URL）但同 title 再写，仍 1 条（title 回退稳定，换源不变）
    U({
        title: '无ID剧', directVideoUrl: 'https://other.example.com/live.m3u8',
        episodes: ['https://other.example.com/ep1.m3u8'], url: 'player.html?url=abc', timestamp: 200
    });
    const h2 = raw();
    t('URL：换源后同剧仍只 1 条', h2.length === 1 && h2[0].showIdentifier === 'title:无id剧', JSON.stringify(h2));
}

console.log('\n[6] 上限 50 条');
{
    reset();
    for (let i = 0; i < 60; i++) {
        U({ title: '剧集' + i, sourceCode: 'src', vod_id: String(i), url: 'u' + i, timestamp: i });
    }
    t('上限：写入 60 条后不超过 50', raw().length === 50, String(raw().length));
}

console.log('\n[7] addToViewingHistory 薄封装走同一入口');
{
    reset();
    globalThis.addToViewingHistory({ title: '兼容函数', sourceCode: 's', vod_id: '9', url: 'u', timestamp: 1 });
    globalThis.addToViewingHistory({ title: '兼容函数', source_code: 's', vod_id: '9', url: 'u2', timestamp: 2 });
    t('兼容：addToViewingHistory 委托后也只 1 条', raw().length === 1, JSON.stringify(raw()));
}

console.log('\n[8] 跨源同名剧不误合并（收紧后的第 3 级只兼容弱标识旧记录）');
{
    reset();
    U({ title: '庆余年', sourceCode: 'heimuer', vod_id: '100', url: 'u1', timestamp: 1 });
    U({ title: '庆余年', sourceCode: 'bfzy', vod_id: '200', url: 'u2', timestamp: 2 });
    const h = raw();
    t('不同源同名剧保留 2 条', h.length === 2, JSON.stringify(h));
    t('两条各有独立稳定 sid', h.every(x => /^(heimuer|bfzy)_/.test(x.showIdentifier || '')), JSON.stringify(h.map(x => x.showIdentifier)));
    t('sourceCode 未被后写入者覆盖', h.some(x => x.sourceCode === 'heimuer') && h.some(x => x.sourceCode === 'bfzy'), JSON.stringify(h.map(x => x.sourceCode)));
    const g = globalThis.getViewingHistory();
    t('读取侧同样保留 2 条（面板不误合并跨源同名剧）', g.length === 2, JSON.stringify(g.map(x => x.showIdentifier)));
}

console.log('\n[9] 旧记录（无 showIdentifier）仍按 title 归并，不产生重复');
{
    reset();
    localStorage.setItem('viewingHistory', JSON.stringify([
        { title: '老剧', url: 'old1', timestamp: 1 },
        { title: '老剧', url: 'old2', timestamp: 2 }
    ]));
    U({ title: '老剧', sourceCode: 'src', vod_id: '9', url: 'new', timestamp: 3 });
    const h = raw();
    t('旧记录归并后只 1 条（不产生重复）', h.length === 1, JSON.stringify(h));
    t('归并后升级为统一稳定 sid', !!h[0].showIdentifier && h[0].showIdentifier === 'src_9', JSON.stringify(h[0]));
    const g = globalThis.getViewingHistory();
    t('读取侧也只 1 条', g.length === 1, JSON.stringify(g.map(x => x.showIdentifier)));
}

console.log('\n[10] 撤销：删除 / 清空后可恢复（showToast 第 3 参 onAction）');
{
    const origShowToast = globalThis.showToast;
    let captured = null;
    // ui.js 内 deleteHistoryItem / clearViewingHistory 走 window.showToast，可在此捕获 options
    globalThis.showToast = (msg, type, options) => { captured = { msg, type, options }; };

    // 删除后撤销：恢复删除前的完整快照
    reset();
    U({ title: '甲', sourceCode: 's1', vod_id: '1', url: 'url-jia', timestamp: 100 });
    U({ title: '乙', sourceCode: 's2', vod_id: '2', url: 'url-yi', timestamp: 200 });
    const beforeDelete = localStorage.getItem('viewingHistory');
    captured = null;
    globalThis.deleteHistoryItem(encodeURIComponent('url-jia'));
    t('删除：showToast 带 success + 撤销 onAction',
        !!captured && captured.type === 'success' && !!captured.options &&
        captured.options.actionLabel === '撤销' && typeof captured.options.onAction === 'function',
        JSON.stringify(captured && captured.options));
    t('删除：撤销前只剩乙', raw().length === 1 && raw()[0].title === '乙', JSON.stringify(raw()));
    captured.options.onAction();
    t('删除：撤销后写回删除前完整快照', localStorage.getItem('viewingHistory') === beforeDelete,
        JSON.stringify(raw()));
    t('删除：撤销后甲 / 乙均恢复', raw().length === 2 &&
        raw().some(x => x.title === '甲') && raw().some(x => x.title === '乙'), JSON.stringify(raw()));

    // 清空后撤销：恢复全部记录
    reset();
    U({ title: '丙', sourceCode: 's3', vod_id: '3', url: 'url-bing', timestamp: 300 });
    U({ title: '丁', sourceCode: 's4', vod_id: '4', url: 'url-ding', timestamp: 400 });
    const beforeClear = localStorage.getItem('viewingHistory');
    captured = null;
    globalThis.clearViewingHistory();
    t('清空：showToast 带 success + 撤销 onAction',
        !!captured && captured.type === 'success' && !!captured.options &&
        captured.options.actionLabel === '撤销' && typeof captured.options.onAction === 'function',
        JSON.stringify(captured && captured.options));
    t('清空：localStorage 键被移除', localStorage.getItem('viewingHistory') === null);
    captured.options.onAction();
    t('清空：撤销后写回清空前完整快照', localStorage.getItem('viewingHistory') === beforeClear,
        JSON.stringify(raw()));
    t('清空：撤销后 getViewingHistory 恢复 2 条', G().length === 2, JSON.stringify(G()));

    if (origShowToast === undefined) delete globalThis.showToast;
    else globalThis.showToast = origShowToast;
}

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
