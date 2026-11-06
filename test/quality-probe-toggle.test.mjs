// WDTV A6 卡片画质探测 · 集成契约 + 行为自测（零依赖，可重复运行）
//
// 分两层：
//   A) 静态契约：锁住「只允许一套 A6 实现 / 默认关闭零请求 / 路径式代理 / 64KB / 4s / 结果消费」；
//   B) 行为自测：app.js 是浏览器脚本（顶层即读 localStorage / API_SITES / document），直接 import 会崩，
//      故用 fs.readFileSync 截取 A6 代码块，注入 mock 全局后用 new Function 执行并导出内部函数，
//      验证真实运行路径：开关关闭不创建 IntersectionObserver / 不发 fetch / 不建队列；
//      开启后才创建观察器；进视口延迟 500ms 才 push；快速滚过不触发；cancel 能中止在途；
//      deps.run 的 URL 形态、64KB 截断、RESOLUTION 短边、缓存与定向徽章。
// 运行：node test/quality-probe-toggle.test.mjs（或 npm test 统一入口）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../js/quality.js';       // → globalThis.WDTVQuality（真实纯函数模块）

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
    if (cond) { pass++; }
    else { fail++; fails.push(name + (extra ? ' | ' + extra : '')); }
}

// =================================================================
// A) 静态契约（保留并行期间已有的全部断言）
// =================================================================
console.log('[1] 只允许一套 A6 实现');
const queueCalls = (app.match(/PQ\.createProbeQueue\(\{/g) || []).length;
t('只有一处 createProbeQueue 调用', queueCalls === 1, '实际 ' + queueCalls);
t('不存在重复的 A6 独立 IIFE', !app.includes('批次2 · A6 卡片画质探测（默认关闭；开启后才产生请求）'));
t('只有一个 QUALITY_PROBE_STORAGE 常量', (app.match(/const QUALITY_PROBE_STORAGE/g) || []).length === 1);
t('toggle 只在初始化与 change 两处引用', (app.match(/wdtvQualityProbeToggle/g) || []).length === 2,
    String((app.match(/wdtvQualityProbeToggle/g) || []).length));
t('存储键名一致', app.includes("'wdtvQualityProbeEnabled'") && html.includes('wdtvQualityProbeToggle'));

console.log('\n[2] 默认关闭 → 零新增请求（静态 guard）');
t('HTML 开关默认不勾选', /id="wdtvQualityProbeToggle"[^>]*>/.test(html) && !/id="wdtvQualityProbeToggle"[^>]*checked/.test(html));
t('isQualityProbeEnabled 只在 true 时启用', /localStorage\.getItem\(QUALITY_PROBE_STORAGE\)\s*===\s*'true'/.test(app));
t('armQualityProbeRender 首行 guard', /qualityProbeArmed = isQualityProbeEnabled\(\);\s*if \(!qualityProbeArmed\) return;/.test(app));
t('observeQualityProbeCard 双 guard', app.includes('if (!qualityProbeArmed || !isQualityProbeEnabled()) return;'));
t('关闭开关立即中止在途', /if \(!e\.target\.checked\) cancelQualityProbes\(\)/.test(app));
t('新搜索开始时中止在途', (app.match(/cancelQualityProbes\(\)/g) || []).length >= 2);
t('关闭/渐进阶段：observeQualityProbeCard 的真实 guard 先于 observer 创建',
    (() => {
        const m = app.match(/function observeQualityProbeCard\(el\)\s*\{([\s\S]*?)\n\}/);
        if (!m) return false;
        const guardAt = m[1].indexOf('if (!qualityProbeArmed || !isQualityProbeEnabled()) return;');
        const observerAt = m[1].indexOf('ensureQualityProbeObserver()');
        return guardAt >= 0 && observerAt > guardAt;
    })());

console.log('\n[3] 请求与限流约束');
t('代理为路径式 /proxy/<encoded>', app.includes('PROXY_URL + encodeURIComponent(url)'));
// 注释里会写明「绝不照抄 /api/proxy?url= 查询式」，只检查非注释代码行
const codeLines = app.split('\n').filter(l => !/^\s*\/\//.test(l));
t('非注释代码不含 LibreTV 查询式代理', !codeLines.some(l => l.includes('/api/proxy?url=')));
t('播放列表只读前 64KB', app.includes('QUALITY_PROBE_MAX_BYTES = 64 * 1024'));
t('单条探测 4s 总预算', app.includes('QUALITY_PROBE_FETCH_TIMEOUT_MS = 4000'));
t('读满 64KB 即 cancel 流', app.includes('QUALITY_PROBE_MAX_BYTES') && /reader\.cancel/.test(app));
t('并发 2 / 每批 8', /concurrency:\s*2/.test(app) && /batchSize:\s*8/.test(app));
t('队列信号 + 会话信号 + 定时器三联动', app.includes('onQueueAbort') && app.includes('onSessionAbort') && app.includes('controller.abort()'));
t('复用 hover 预取详情', app.includes('getPrefetchedDetail(id, source)'));
t('RESOLUTION 取短边', app.includes('Math.min(Number(m[1]), Number(m[2]))'));
t('64KB 按剩余字节严格截断', app.includes('value.subarray(0, remaining)'));

console.log('\n[4] 结果消费');
t('缓存键走 WDTVQuality.qualityKey', app.includes('Q.qualityKey(sourceKey, vodId)'));
t('缓存用 mergeQualityEntries 维护', app.includes('Q.mergeQualityEntries(qualityProbeEntries, incoming)'));
t('结果消费：applyQualityProbeResult 只定向更新徽章、不调用整页渲染',
    (() => {
        const m = app.match(/function applyQualityProbeResult\(result\)\s*\{([\s\S]*?)\n\}/);
        if (!m) return false;
        const body = m[1];
        return body.includes('updateQualityProbeBadge(') &&
            !/renderFilteredSearchResults|renderSearchResults|renderResults\(|\.innerHTML\s*=/.test(body);
    })());
t('展开面板排序消费同一份缓存', app.includes('qualityProbeEntries'));

console.log('\n[4b] A6 本批新增契约（结构断言）');
t('队列看门狗为 60000（与 WDTVProbeQueue 默认一致）', /timeoutMs:\s*60000/.test(app));
t('探测详情请求带 trackHealth:false', app.includes('signal: controller.signal, trackHealth: false'));
t('失败 / 未知态徽章带 data-quality-retry="1"', app.includes('data-quality-retry="1"'));
t('重试委托清 seen 后重新入队',
    app.includes('qualityProbeSeen.delete(raw)') && app.includes('retryQualityProbeFromCard(card)'));
t('onStart 标记 probing 并定向刷 loading 徽章',
    app.includes('queue.push(fresh, onStart)') && app.includes('qualityProbeProbing.add(') &&
    app.includes('updateQualityProbeBadge(sourceKey, vodId, null, true)'));
t('describeQualityBadge 第二参按条目 probing 状态传（不再硬编码 false）',
    app.includes('Q.describeQualityBadge(probeEntry, probing)') &&
    app.includes('Q.describeQualityBadge(entry, !!probing)'));
t('BANDWIDTH 兜底走 WDTVQuality.inferHeightFromBitrate',
    app.includes('Q.inferHeightFromBitrate(maxBitrate)'));
t('首集非 m3u8 时中间集兜底（最多 2 次额外尝试）',
    app.includes('const picks = [0]') && app.includes('picks.length < 3'));

// =================================================================
// B) 行为自测：截取 A6 代码块 + mock 全局 + new Function
// =================================================================
const START = '// ===== 批次 2 · A6 卡片画质探测';
const END = '// 探测进度提示（复用搜索进度条位置）';
const bs = app.indexOf(START);
const be = app.indexOf(END, bs);
console.log('\n[5] 行为自测环境');
t('能截取 A6 代码块', bs >= 0 && be > bs, `bs=${bs} be=${be}`);
const block = be > bs ? app.slice(bs, be) : '';

const EXPORTS = `
return {
  isQualityProbeEnabled, armQualityProbeRender, armQualityProbeForVisibleCards,
  observeQualityProbeCard, enqueueQualityProbeFromCard, getQualityProbeQueue,
  cancelQualityProbes, qualityProbeRun, fetchPlaylistPrefix, applyQualityProbeResult,
  retryQualityProbeFromCard, isQualityProbeProbing,
  getSession: () => qualityProbeSession,
  getEntries: () => qualityProbeEntries,
  getArmed: () => qualityProbeArmed
};`;
const factory = new Function(block + EXPORTS);

const GLOBAL_NAMES = [
    'window', 'document', 'localStorage', 'fetch', 'IntersectionObserver',
    'setTimeout', 'clearTimeout', 'getPrefetchedDetail', 'fetchVideoDetailData',
    'getFilteredSearchResults', 'deriveGroupedResults', 'cssEscapeAttr',
    'PROXY_URL', 'RESULTS_PER_PAGE', 'currentResultPage', 'renderFilteredSearchResults'
];

const itemA = { source_code: 'src', vod_id: 'v1', vod_name: '测试剧' };

function loadA6(cfg) {
    const g = globalThis;
    const saved = {};
    GLOBAL_NAMES.forEach(n => { saved[n] = g[n]; });

    const state = {
        observerCtor: 0, observed: [], unobserved: [], disconnected: 0,
        observerCb: null, observerOpts: null, fetchCalls: [], pushCalls: [],
        cancelCalls: [], queueCreated: 0, queueDeps: null, timers: [],
        badgeText: '', badgeClasses: [], badgeAttrs: {}, readerCancelled: 0,
        startHooks: [], rerenderCount: 0
    };

    class MockIntersectionObserver {
        constructor(cb, opts) { state.observerCtor++; state.observerCb = cb; state.observerOpts = opts; }
        observe(el) { state.observed.push(el); }
        unobserve(el) { state.unobserved.push(el); }
        disconnect() { state.disconnected++; }
    }
    const fakeSetTimeout = (fn, ms) => {
        const id = state.timers.length + 1;
        state.timers.push({ id, fn, ms, cleared: false, fired: false });
        return id;
    };
    const fakeClearTimeout = (id) => {
        const rec = state.timers.find(x => x.id === id);
        if (rec) rec.cleared = true;
    };
    const flushTimers = (msEquals) => {
        state.timers.forEach(rec => {
            if (!rec.cleared && !rec.fired && (msEquals === undefined || rec.ms === msEquals)) {
                rec.fired = true; rec.fn();
            }
        });
    };

    const mockEl = {
        isConnected: true,
        dataset: { key: 'src_v1' },
        getAttribute(name) {
            if (name === 'data-group-key') return 'g1';
            if (name === 'data-key') return 'src_v1';
            return null;
        }
    };
    const badge = {
        textContent: '',
        classList: { add(c) { state.badgeClasses.push(c); } },
        setAttribute(k, v) { state.badgeAttrs[k] = v; },
        removeAttribute(k) { delete state.badgeAttrs[k]; },
        title: ''
    };
    const fakeCard = { querySelector(sel) { return sel === '.wdtv-quality-badge' ? badge : null; } };
    const documentMock = {
        querySelector() { return cfg.card === undefined ? fakeCard : cfg.card; },
        querySelectorAll() { return cfg.cards || []; },
        getElementById() { return null; }
    };
    const pqMock = {
        createProbeQueue(deps) {
            state.queueCreated++; state.queueDeps = deps;
            return {
                push(items, onStart) {
                    state.pushCalls.push(items);
                    if (typeof onStart === 'function') state.startHooks.push(onStart);
                    return Promise.resolve({});
                },
                cancel(keys) { state.cancelCalls.push(keys); }
            };
        }
    };
    const storage = Object.assign({}, cfg.storage || {});

    g.window = {
        WDTVQuality: g.WDTVQuality,
        WDTVProbeQueue: pqMock,
        location: { href: 'https://wdtv.example/' }
    };
    g.document = documentMock;
    g.localStorage = { getItem: (k) => (k in storage ? storage[k] : null), setItem: () => {} };
    g.IntersectionObserver = MockIntersectionObserver;
    g.setTimeout = fakeSetTimeout;
    g.clearTimeout = fakeClearTimeout;
    g.getPrefetchedDetail = () => null;
    g.fetchVideoDetailData = cfg.fetchVideoDetailData ||
        (async () => ({ episodes: ['https://cdn.test/hls/master.m3u8'] }));
    g.getFilteredSearchResults = () => (cfg.filtered || [itemA]);
    g.deriveGroupedResults = (list) => [{ key: 'g1', items: list }];
    g.cssEscapeAttr = (v) => String(v).replace(/["\\]/g, '\\$&');
    g.PROXY_URL = '/proxy/';
    g.RESULTS_PER_PAGE = 60;
    g.currentResultPage = 1;
    g.fetch = cfg.fetch || (async () => ({ ok: true, status: 200, body: null, text: async () => '' }));
    // 整页渲染入口：计数用于验证 applyQualityProbeResult 只定向更新、不整页重渲染
    g.renderFilteredSearchResults = () => { state.rerenderCount++; };

    const api = factory();
    function restore() {
        GLOBAL_NAMES.forEach(n => {
            if (saved[n] === undefined) delete g[n];
            else g[n] = saved[n];
        });
    }
    return { api, state, mockEl, badge, flushTimers, restore };
}

console.log('\n[6] 开关默认 false：零 observer / 零 fetch / 零队列');
{
    const env = loadA6({});
    const { api, state, mockEl } = env;
    t('isQualityProbeEnabled() === false（localStorage 无值）', api.isQualityProbeEnabled() === false);
    api.armQualityProbeRender([{ key: 'g1', items: [itemA] }]);
    api.observeQualityProbeCard(mockEl);
    api.armQualityProbeForVisibleCards();
    t('未创建 IntersectionObserver', state.observerCtor === 0, 'ctor=' + state.observerCtor);
    t('未创建探测队列', state.queueCreated === 0);
    t('未发起任何 fetch', state.fetchCalls.length === 0);
    t('未 push 任何条目', state.pushCalls.length === 0);
    t('getArmed() === false', api.getArmed() === false);
    t('getSession() 为 null（连 session 都不建）', api.getSession() === null);
    env.restore();
}

console.log('\n[7] 开关开启：创建观察器，进视口延迟 500ms 才 push');
{
    const env = loadA6({ storage: { wdtvQualityProbeEnabled: 'true' } });
    const { api, state, mockEl, flushTimers } = env;
    t('isQualityProbeEnabled() === true', api.isQualityProbeEnabled() === true);
    api.armQualityProbeRender([{ key: 'g1', items: [itemA] }]);
    api.observeQualityProbeCard(mockEl);
    t('创建了 1 个 IntersectionObserver', state.observerCtor === 1, 'ctor=' + state.observerCtor);
    t('rootMargin 为 120px', !!(state.observerOpts && state.observerOpts.rootMargin === '120px'));
    t('卡片被 observe', state.observed.length === 1 && state.observed[0] === mockEl);
    state.observerCb([{ isIntersecting: true, target: mockEl }]);
    t('刚进视口时还没 push（延迟未到）', state.pushCalls.length === 0);
    t('挂起了 1 个 500ms 计时器', state.timers.some(x => x.ms === 500 && !x.cleared),
        JSON.stringify(state.timers.map(x => x.ms)));
    flushTimers(500);
    t('500ms 到点后 push 了 1 批', state.pushCalls.length === 1);
    t('push 的条目含目标 item', state.pushCalls[0] && state.pushCalls[0][0] === itemA);
    t('置位后 observer.unobserve 该卡', state.unobserved.length === 1 && state.unobserved[0] === mockEl);
    t('队列懒创建且并发/批次为 2/8',
        state.queueCreated === 1 && state.queueDeps.concurrency === 2 && state.queueDeps.batchSize === 8);
    env.restore();
}

console.log('\n[8] 快速滚过不触发');
{
    const env = loadA6({ storage: { wdtvQualityProbeEnabled: 'true' } });
    const { api, state, mockEl, flushTimers } = env;
    api.armQualityProbeRender([{ key: 'g1', items: [itemA] }]);
    api.observeQualityProbeCard(mockEl);
    state.observerCb([{ isIntersecting: true, target: mockEl }]);
    state.observerCb([{ isIntersecting: false, target: mockEl }]);
    const pending = state.timers.filter(x => x.ms === 500);
    t('离开视口时 500ms 计时器被 clear', pending.length === 1 && pending[0].cleared === true);
    flushTimers(500);
    t('快速滚过后不 push、不发请求', state.pushCalls.length === 0 && state.fetchCalls.length === 0);
    env.restore();
}

console.log('\n[9] cancelQualityProbes 中止在途');
{
    const env = loadA6({ storage: { wdtvQualityProbeEnabled: 'true' } });
    const { api, state, mockEl, flushTimers } = env;
    api.armQualityProbeRender([{ key: 'g1', items: [itemA] }]);
    api.observeQualityProbeCard(mockEl);
    // 先让一批真正 push（队列被懒创建、存在在途任务）
    state.observerCb([{ isIntersecting: true, target: mockEl }]);
    flushTimers(500);
    // 再挂起一个「已进视口但 500ms 未到」的待触发计时器
    state.observerCb([{ isIntersecting: true, target: mockEl }]);
    t('取消前确有挂起的 500ms 计时器',
        state.timers.some(x => x.ms === 500 && !x.cleared && !x.fired));
    const session = api.getSession();
    t('开启后持有未 abort 的 session', !!session && session.signal.aborted === false);
    api.cancelQualityProbes();
    t('session 被 abort', !!session && session.signal.aborted === true);
    t('queue.cancel 被调用（中止在途任务）', state.cancelCalls.length === 1, JSON.stringify(state.cancelCalls));
    t('observer 被 disconnect', state.disconnected >= 1);
    t('getArmed() 复位为 false', api.getArmed() === false);
    t('待触发的 500ms 计时器被清',
        state.timers.filter(x => x.ms === 500 && !x.cleared && !x.fired).length === 0);
    env.restore();
}

console.log('\n[10] deps.run：路径式代理 / 64KB / 4s / RESOLUTION 短边 / 缓存与定向徽章');
{
    const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n1080/index.m3u8\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n720/index.m3u8\n';
    const big = playlist + 'X'.repeat(200000);
    const bytes = new TextEncoder().encode(big);
    let state;
    const env = loadA6({
        storage: { wdtvQualityProbeEnabled: 'true' },
        fetch: async (url) => {
            state.fetchCalls.push(url);
            return {
                ok: true, status: 200,
                body: {
                    getReader: () => ({
                        read: async () => ({ done: false, value: bytes }),
                        cancel: async () => { state.readerCancelled++; }
                    })
                },
                text: async () => big
            };
        }
    });
    state = env.state;
    const { api, badge } = env;
    const results = [];
    await api.qualityProbeRun([itemA], (r) => results.push(r), undefined);
    t('onResult 逐条回调 1 次', results.length === 1);
    t('RESOLUTION 取短边 → height=1080', results[0] && results[0].height === 1080, JSON.stringify(results[0]));
    t('sourceKey / vodId 正确', results[0].sourceKey === 'src' && results[0].vodId === 'v1');
    t('fetch 只发了 1 次', state.fetchCalls.length === 1);
    const url = state.fetchCalls[0] || '';
    t('URL 为路径式 /proxy/<encoded>',
        url.indexOf('/proxy/') === 0 &&
        url === '/proxy/' + encodeURIComponent('https://cdn.test/hls/master.m3u8'), url.slice(0, 80));
    t('URL 不含 ?url= / /api/proxy', !url.includes('?url=') && !url.includes('/api/proxy'));
    t('播放列表读满 64KB 后 reader.cancel()', state.readerCancelled === 1);
    t('安排了 4000ms 超时计时器且已清理', state.timers.some(x => x.ms === 4000 && x.cleared));
    const entries = api.getEntries();
    t('缓存键为 qualityKey 格式 src:v1', !!entries['src:v1'], Object.keys(entries).join(','));
    t('缓存 height=1080 且 from=probe',
        entries['src:v1'] && entries['src:v1'].height === 1080 && entries['src:v1'].from === 'probe');
    t('徽章文本更新为 1080P', badge.textContent === '1080P', badge.textContent);
    t('徽章加了探测结果类', state.badgeClasses.includes('wdtv-quality-probed'));
    const text = await api.fetchPlaylistPrefix('/proxy/x', undefined);
    t('fetchPlaylistPrefix 返回文本不超过 64KB', text.length <= 64 * 1024, 'len=' + text.length);
    t('结果消费不触发整页重渲染（mock 渲染函数计数为 0）',
        state.rerenderCount === 0, String(state.rerenderCount));
    env.restore();
}

console.log('\n[11] 无 master（媒体列表）→ 测不出，不抛错');
{
    const env = loadA6({
        storage: { wdtvQualityProbeEnabled: 'true' },
        fetch: async () => ({
            ok: true, status: 200, body: null,
            text: async () => '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10.0,\nseg1.ts\n#EXTINF:10.0,\nseg2.ts\n'
        })
    });
    const { api } = env;
    const results = [];
    let threw = false;
    try {
        await api.qualityProbeRun([{ source_code: 'src', vod_id: 'v2', vod_name: '单码率' }],
            (r) => results.push(r), undefined);
    } catch (e) { threw = true; }
    t('测不出时不抛异常', !threw);
    t('测不出时 onResult 无 height 无 error',
        results.length === 1 && results[0].height === undefined && results[0].error === undefined,
        JSON.stringify(results[0]));
    env.restore();
}

console.log('\n[12] onStart：批次真正开始时把徽章刷成「探测中」');
{
    const env = loadA6({ storage: { wdtvQualityProbeEnabled: 'true' } });
    const { api, state, mockEl, badge, flushTimers } = env;
    api.armQualityProbeRender([{ key: 'g1', items: [itemA] }]);
    api.observeQualityProbeCard(mockEl);
    state.observerCb([{ isIntersecting: true, target: mockEl }]);
    flushTimers(500);
    t('push 携带 onStart 回调', state.startHooks.length === 1 && typeof state.startHooks[0] === 'function');
    state.startHooks[0]();
    t('onStart：条目被标记为 probing', api.isQualityProbeProbing('src', 'v1') === true);
    t('onStart：徽章文本为「探测中…」', badge.textContent === '探测中…', badge.textContent);
    t('onStart：徽章状态为 loading', state.badgeAttrs['data-quality-state'] === 'loading',
        JSON.stringify(state.badgeAttrs));
    t('onStart：loading 态不带重试标记', state.badgeAttrs['data-quality-retry'] === undefined);
    env.restore();
}

console.log('\n[13] 失败态徽章可重试：清 seen 后重新入队');
{
    const env = loadA6({ storage: { wdtvQualityProbeEnabled: 'true' } });
    const { api, state, badge, mockEl } = env;
    api.applyQualityProbeResult({ sourceKey: 'src', vodId: 'v1', error: 'HTTP 504 网关超时' });
    t('失败态：徽章文本为「未测到」', badge.textContent === '未测到', badge.textContent);
    t('失败态：徽章带 data-quality-retry=1', state.badgeAttrs['data-quality-retry'] === '1',
        JSON.stringify(state.badgeAttrs));
    t('失败态：data-quality-state=failed', state.badgeAttrs['data-quality-state'] === 'failed');
    t('失败态：probing 标记已清除', api.isQualityProbeProbing('src', 'v1') === false);
    api.armQualityProbeRender([{ key: 'g1', items: [itemA] }]);
    api.enqueueQualityProbeFromCard(mockEl);
    t('入队后 push 1 批', state.pushCalls.length === 1, String(state.pushCalls.length));
    api.enqueueQualityProbeFromCard(mockEl);
    t('seen 去重：再次入队不重复 push', state.pushCalls.length === 1, String(state.pushCalls.length));
    api.retryQualityProbeFromCard(mockEl);
    t('重试：清 seen 后重新 push 1 批', state.pushCalls.length === 2, String(state.pushCalls.length));
    env.restore();
}

console.log('\n[14] 无 RESOLUTION 时用 BANDWIDTH 反推高度');
{
    const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=6000000,CODECS="avc1,mp4a"\nhi/index.m3u8\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=1000000\nlo/index.m3u8\n';
    const env = loadA6({
        storage: { wdtvQualityProbeEnabled: 'true' },
        fetch: async () => ({ ok: true, status: 200, body: null, text: async () => playlist })
    });
    const { api } = env;
    const results = [];
    await api.qualityProbeRun([itemA], (r) => results.push(r), undefined);
    t('BANDWIDTH 反推：最高档 6000000bps → height=1080',
        results.length === 1 && results[0].height === 1080, JSON.stringify(results[0]));
    env.restore();
}

console.log('\n[15] 首集非 m3u8 时尝试中间集');
{
    const env = loadA6({
        storage: { wdtvQualityProbeEnabled: 'true' },
        fetchVideoDetailData: async () => ({
            episodes: ['https://cdn.test/a.mp4', 'https://cdn.test/b.mp4',
                'https://cdn.test/hls/master.m3u8']
        }),
        fetch: async () => ({
            ok: true, status: 200, body: null,
            text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n1080/index.m3u8\n'
        })
    });
    const { api } = env;
    const results = [];
    await api.qualityProbeRun([itemA], (r) => results.push(r), undefined);
    t('中间集兜底：height=1080', results.length === 1 && results[0].height === 1080,
        JSON.stringify(results[0]));
    env.restore();
}

// =================================================================
// 人工验证步骤（补充静态 guard 无法覆盖的浏览器真实行为）
//   1) 打开页面，DevTools → Network，清空后不勾选「卡片画质探测」做一次搜索：
//      除搜索接口本身外，不应出现 /proxy/<m3u8> 请求，也不应有 IntersectionObserver 相关活动。
//   2) 勾选开关（localStorage.wdtvQualityProbeEnabled=true）后重新搜索或滚动结果区：
//      卡片进入视口 500ms 后才出现 /proxy/<encoded m3u8> 请求，最多 2 个并发。
//   3) 快速滚过卡片：不应产生探测请求。
//   4) 探测回来后只有对应卡片右上角 .wdtv-quality-badge 文本变化（如 1080P），
//      封面不重新加载、列表不整页闪烁。
//   5) 搜索过程中关闭开关 / 发起新搜索：Network 里在途探测请求被 Abort（显示为 canceled）。
// =================================================================

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
