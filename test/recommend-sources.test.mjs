// WDTV 首页推荐多源模块自测（Node ESM，零依赖，不随部署）
// 风格对齐 test/ad-filter.test.mjs：自定义断言 + 失败时 process.exit(1)
// 运行：node test/recommend-sources.test.mjs  或  node scripts/run-tests.mjs
import '../js/recommend-sources.js';

const A = globalThis.WDTVRecommendSources;

// ---------- mock 基础设施 ----------
const MIN = 60 * 1000;
const BASE_NOW = 1700000000000;
let fakeNow = BASE_NOW;
Date.now = () => fakeNow;                 // 可控时钟：缓存 TTL 按 Date.now() 计算
function advance(ms) { fakeNow += ms; }

let acCount = 0;                          // 统计 AbortController 创建次数（验证直连/代理各自独立超时）
// signal 支持 addEventListener/removeEventListener/abort 事件派发，
// 用于 [16] 验证外部 signal 的 abort 事件确实联动到内部 controller（真实 AbortSignal 同语义）。
globalThis.AbortController = class {
    constructor() {
        acCount++;
        var listeners = [];
        this.signal = {
            aborted: false,
            addEventListener: function (type, fn) { if (type === 'abort') listeners.push(fn); },
            removeEventListener: function (type, fn) {
                listeners = listeners.filter(function (f) { return f !== fn; });
            },
            _fireAbort: function () { listeners.slice().forEach(function (f) { f(); }); }
        };
    }
    abort() {
        if (this.signal.aborted) return;
        this.signal.aborted = true;
        if (typeof this.signal._fireAbort === 'function') this.signal._fireAbort();
    }
};

let storageWrites = 0;                    // 模块不得新增 localStorage 键
globalThis.localStorage = {
    getItem: () => null,
    setItem: () => { storageWrites++; },
    removeItem: () => {},
    clear: () => {}
};

let calls = [];
let handler = null;
globalThis.fetch = function (url, opts) {
    const u = String(url);
    calls.push({ url: u, opts: opts || {} });
    let r;
    try { r = handler ? handler(u, opts || {}) : Promise.resolve(resp('')); }
    catch (e) { r = Promise.reject(e); }
    return r;
};

// 构造 fetch Response 形态（fetchWithFallback 读取 ok/status/text()）
function resp(text, ok = true, status) {
    return {
        ok: ok,
        status: status == null ? (ok ? 200 : 500) : status,
        text: () => Promise.resolve(text)
    };
}
function sixtyJson(data) { return JSON.stringify({ code: 200, data: data }); }
function reset(h) {
    calls = [];
    handler = h;
    acCount = 0;
    fakeNow = BASE_NOW;
    Date.now = () => fakeNow;
    A.clearCache();                       // 清 TTL 缓存 + in-flight，隔离每个用例
}

// 固定样例数据
const WEEKLY = [
    { id: 1001, title: '周榜电影A', rating: 8.6, cover: 'https://img9.doubanio.com/a.jpg' },
    { id: 1002, title: '周榜电影B', rating: 7.2, cover_proxy: 'https://doubanio.viki.moe/b.jpg' },
    { id: 999, rating: 5 }               // 脏数据：缺 title/cover → 丢弃
];
const BAIDU = [
    { title: '热播剧X', cover: 'https://pic.x.com/x.jpg' },
    { title: '热播剧Y', cover: 'https://pic.x.com/y.jpg' }
];
const CALENDAR = [
    { weekday: { id: 1, cn: '星期一' }, items: [
        { id: 10, name: 'Anime Original', name_cn: '中文名甲', images: { large: 'https://lain.bgm.tv/l/10.jpg' }, rating: { score: 8.76 } },
        { name: 'dirty', images: {} }    // 缺 id/封面 → 丢弃
    ] },
    { weekday: { id: 9 }, items: [       // 非法星期 → 丢弃
        { id: 88, name: 'bad', images: { large: 'x' } }
    ] },
    { weekday: { id: 7, cn: '星期日' }, items: [
        { id: 20, name: 'Sunday Show', images: { common: 'https://lain.bgm.tv/c/20.jpg' }, rating: { score: 0 } }
    ] }
];
const FIELDS = ['title', 'rate', 'cover', 'url', 'id', 'subtitle'];

let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
    if (cond) { pass++; console.log('  ok  ' + name); }
    else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}
function eq(actual, expected, name) {
    t(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

async function main() {
    console.log('\n[1] 模块导出 / SOURCES / get / 分发标记');
    {
        t('挂到 globalThis.WDTVRecommendSources', !!(A && typeof A === 'object'));
        ['fetchWithFallback', 'withCacheBuster', 'fetchHotList', 'fetchBangumi', 'get', 'fetch', 'describeFailure', 'clearCache'].forEach(fn => {
            t('导出 ' + fn, typeof A[fn] === 'function');
        });
        eq(A.SOURCES.douban.enabled, true, 'douban 默认可用');
        eq(A.SOURCES.hotlist.enabled, true, 'hotlist 默认可用');
        eq(A.SOURCES.bangumi.enabled, false, 'bangumi 默认 disabled');
        eq(A.ENDPOINTS.sixtyPrimary, 'https://60s.viki.moe', '60s 主实例');
        eq(A.ENDPOINTS.sixtyFallback, 'https://60s.crystelf.top', '60s 备用实例');
        eq(A.ENDPOINTS.bangumi, 'https://api.bgm.tv/calendar', 'Bangumi 端点');
        eq(A.get('hotlist').id, 'hotlist', 'get(hotlist)');
        eq(A.get('unknown'), null, 'get(未知) 返回 null');
        eq(await A.fetch('douban'), A.DOUBAN_LEGACY, 'fetch(douban) 返回既有链路标记');
        const unknown = await A.fetch('unknown');
        t('fetch(未知) 静默返回空数组', Array.isArray(unknown) && unknown.length === 0);
        ['hotlist', 'bangumi', 'douban'].forEach(id => {
            t('describeFailure(' + id + ') 为中文短文案', typeof A.describeFailure(id) === 'string' && A.describeFailure(id).length > 0);
        });
    }

    console.log('\n[2] withCacheBuster 两形态 + 小时戳');
    {
        const d = new Date(2026, 10, 5, 14);   // 2026-11-05 14 时 → 2026110514
        eq(A.withCacheBuster('https://x/a', d), 'https://x/a?_wdtv=2026110514', '无查询串用 ?');
        eq(A.withCacheBuster('https://x/a?foo=1', d), 'https://x/a?foo=1&_wdtv=2026110514', '已有查询串用 &');
        t('默认取当前时间，尾随 10 位小时戳', /_wdtv=\d{10}$/.test(A.withCacheBuster('https://x/a')));
    }

    console.log('\n[3] 直连成功：不调用代理（fetch 仅 1 次且 URL 原样）');
    {
        reset(() => Promise.resolve(resp('DIRECT-OK')));
        const text = await A.fetchWithFallback('https://60s.viki.moe/v2/baidu/teleplay', {});
        eq(text, 'DIRECT-OK', '返回直连文本');
        eq(calls.length, 1, 'fetch 仅调用 1 次');
        eq(calls[0].url, 'https://60s.viki.moe/v2/baidu/teleplay', 'URL 原样');
        t('直连 URL 不含 _wdtv / /proxy/', !calls[0].url.includes('_wdtv') && !calls[0].url.startsWith('/proxy/'));
        eq(acCount, 1, '仅创建 1 个 AbortController（未触发代理）');
    }

    console.log('\n[4] 直连失败（TypeError / 500）→ 回退路径式 /proxy/ 且带小时级缓存键');
    {
        // 4a：直连抛 TypeError，代理成功
        reset((url) => url.startsWith('/proxy/')
            ? Promise.resolve(resp('PROXY-OK'))
            : Promise.reject(new TypeError('Failed to fetch')));
        const t1 = await A.fetchWithFallback('https://60s.viki.moe/v2/douban/weekly/movie', {});
        eq(t1, 'PROXY-OK', '4a：回退代理后返回文本');
        eq(calls.length, 2, '4a：直连 + 代理共 2 次');
        t('4a：第 2 次为路径式 /proxy/', calls[1].url.startsWith('/proxy/'));
        const decodedA = decodeURIComponent(calls[1].url.slice('/proxy/'.length));
        t('4a：目标 URL 含 _wdtv= 小时戳', /_wdtv=\d{10}/.test(decodedA), decodedA);
        t('4a：缓存键附加在原目标 URL 上', decodedA.indexOf('https://60s.viki.moe/v2/douban/weekly/movie') === 0, decodedA);
        eq(acCount, 2, '4a：直连与代理各自独立超时控制器');

        // 4b：直连返回 500，代理成功
        reset((url) => url.startsWith('/proxy/')
            ? Promise.resolve(resp('PROXY-OK-500'))
            : Promise.resolve(resp('', false, 500)));
        const t2 = await A.fetchWithFallback('https://60s.viki.moe/v2/baidu/teleplay', {});
        eq(t2, 'PROXY-OK-500', '4b：非 2xx 触发回退');
        eq(calls.length, 2, '4b：直连 + 代理共 2 次');
        const decodedB = decodeURIComponent(calls[1].url.slice('/proxy/'.length));
        t('4b：代理目标 URL 含 _wdtv= 小时戳', /_wdtv=\d{10}/.test(decodedB), decodedB);
    }

    console.log('\n[5] 代理也失败 → 返回 null 不抛错');
    {
        reset(() => Promise.reject(new TypeError('network down')));
        let threw = false, val;
        try { val = await A.fetchWithFallback('https://x/api', {}); } catch (e) { threw = true; }
        t('5：不抛异常', !threw);
        eq(val, null, '5：返回 null');
        eq(calls.length, 2, '5：直连与代理各尝试一次');

        reset(() => Promise.resolve(resp('', false, 502)));
        let threw2 = false, val2;
        try { val2 = await A.fetchWithFallback('https://x/api2', {}); } catch (e) { threw2 = true; }
        t('5b：非 2xx 全程不抛异常', !threw2);
        eq(val2, null, '5b：返回 null');
    }

    console.log('\n[6] 60s：主实例失败自动切备用实例 / allSettled 单榜失败不影响另一榜');
    {
        // 6a：主实例（含其代理回退）全失败 → 切备用实例成功
        reset((url) => {
            if (url.startsWith('/proxy/')) return Promise.reject(new TypeError('proxy down'));
            if (url.includes('60s.viki.moe')) return Promise.reject(new TypeError('primary down'));
            if (url.includes('/v2/douban/weekly')) return Promise.resolve(resp(sixtyJson(WEEKLY)));
            if (url.includes('/v2/baidu/teleplay')) return Promise.resolve(resp(sixtyJson(BAIDU)));
            return Promise.reject(new TypeError('unknown'));
        });
        const items = await A.fetch('hotlist');
        eq(items.length, 4, '6a：备用实例两榜共 4 条（脏数据已丢弃）');
        t('6a：结果含豆瓣周榜', items.some(i => i.subtitle === '豆瓣周榜'));
        t('6a：结果含百度热播', items.some(i => i.subtitle === '百度热播'));
        t('6a：确实请求了备用实例', calls.some(c => c.url.includes('60s.crystelf.top')));

        // 6b：主实例周榜成功、百度榜失败（含代理回退失败）→ 只返回周榜，不切备用
        reset((url) => {
            if (url.startsWith('/proxy/')) return Promise.reject(new TypeError('no proxy'));
            if (url.includes('/v2/douban/weekly')) return Promise.resolve(resp(sixtyJson(WEEKLY)));
            return Promise.reject(new TypeError('teleplay down'));
        });
        const one = await A.fetch('hotlist');
        eq(one.length, 2, '6b：一榜失败另一榜仍返回 2 条');
        t('6b：仅有周榜数据', one.every(i => i.subtitle === '豆瓣周榜'));
        t('6b：整轮有结果即不切备用实例', !calls.some(c => c.url.includes('60s.crystelf.top')));
    }

    console.log('\n[7] Bangumi：默认 disabled → 零网络请求 / 返回空数组');
    {
        eq(A.get('bangumi').enabled, false, '7：SOURCES.bangumi 默认 disabled');
        reset(() => Promise.reject(new TypeError('bgm unreachable')));
        let threw = false, val;
        try { val = await A.fetch('bangumi'); } catch (e) { threw = true; }
        t('7：不抛异常', !threw);
        t('7：返回空数组', Array.isArray(val) && val.length === 0);
        eq(calls.length, 0, '7：disabled 源零请求（不发 UA、不回退代理、不空等 12s）');
    }

    console.log('\n[8] 数据映射为 DoubanItem（字段齐全 / 取值正确）');
    {
        reset((url) => {
            if (url.includes('/v2/douban/weekly')) return Promise.resolve(resp(sixtyJson(WEEKLY)));
            if (url.includes('/v2/baidu/teleplay')) return Promise.resolve(resp(sixtyJson(BAIDU)));
            return Promise.reject(new TypeError('x'));
        });
        const hot = await A.fetch('hotlist');
        eq(hot.length, 4, '8：热榜 4 条（脏数据丢弃）');
        hot.forEach((it, idx) => FIELDS.forEach(k =>
            t(`8：hot[${idx}].${k} 齐全`, Object.prototype.hasOwnProperty.call(it, k) && it[k] !== undefined)));
        const a = hot.find(i => i.title === '周榜电影A');
        eq(a.rate, '8.6', '8：周榜 rating → rate');
        eq(a.url, 'https://movie.douban.com/subject/1001/', '8：周榜 url 为豆瓣条目');
        const b = hot.find(i => i.title === '周榜电影B');
        eq(b.cover, 'https://doubanio.viki.moe/b.jpg', '8：cover 缺失时回退 cover_proxy');
        const x = hot.find(i => i.title === '热播剧X');
        eq(x.rate, '', '8：百度榜无评分 → rate 空串');
        t('8：百度榜 url 为搜索链接', x.url.indexOf('https://www.baidu.com/s?wd=') === 0);

        // Bangumi 默认 disabled（[7] 已覆盖零请求）；这里临时启用，保留数据映射回归覆盖
        A.SOURCES.bangumi.enabled = true;
        try {
            reset((url) => url.startsWith('/proxy/')
                ? Promise.reject(new TypeError('no proxy'))
                : Promise.resolve(resp(JSON.stringify(CALENDAR))));
            const bgm = await A.fetch('bangumi');
            eq(bgm.length, 2, '8：Bangumi 2 条（脏数据 + 非法星期丢弃）');
            bgm.forEach((it, idx) => FIELDS.forEach(k =>
                t(`8：bgm[${idx}].${k} 齐全`, Object.prototype.hasOwnProperty.call(it, k) && it[k] !== undefined)));
            eq(bgm[0].title, '中文名甲', '8：name_cn 优先');
            eq(bgm[0].rate, '8.8', '8：score 8.76 → 8.8');
            t('8：subtitle 标注周一', bgm[0].subtitle.includes('周一'));
            eq(bgm[0].url, 'https://bgm.tv/subject/10', '8：Bangumi url 为条目页');
            eq(bgm[1].rate, '', '8：score=0 → rate 空串');
            t('8：subtitle 标注周日', bgm[1].subtitle.includes('周日'));
            t('8：按周一→周日顺序分组扁平化', bgm[0].subtitle.includes('周一') && bgm[1].subtitle.includes('周日'));
        } finally {
            A.SOURCES.bangumi.enabled = false;
        }
    }

    console.log('\n[9] 缓存 TTL：热榜 60 分钟 / Bangumi 30 分钟（注入 now）');
    {
        reset((url) => {
            if (url.includes('/v2/douban/weekly')) return Promise.resolve(resp(sixtyJson(WEEKLY)));
            if (url.includes('/v2/baidu/teleplay')) return Promise.resolve(resp(sixtyJson(BAIDU)));
            return Promise.resolve(resp(JSON.stringify(CALENDAR)));
        });
        // 热榜 60 分钟
        await A.fetch('hotlist');
        const afterFirst = calls.length;
        t('9：首次填充缓存发起了请求', afterFirst > 0);
        advance(59 * MIN);
        const c59 = calls.length;
        await A.fetch('hotlist');
        t('9：59 分钟内命中缓存，不再请求', calls.length === c59);
        advance(2 * MIN);                        // 累计 61 分钟 > 60 TTL
        const c61 = calls.length;
        await A.fetch('hotlist');
        t('9：超过 60 分钟缓存失效，重新请求', calls.length > c61);

        // clearCache：refresh 时清源缓存后应重新请求
        const cClr = calls.length;
        await A.fetch('hotlist');
        t('9：命中缓存（刷新前基线）', calls.length === cClr);
        A.clearCache('hotlist');
        await A.fetch('hotlist');
        t('9：clearCache(hotlist) 后重新请求', calls.length > cClr);

        // Bangumi 30 分钟（独立 reset 重置时钟与缓存；临时启用 disabled 源以测 TTL）
        A.SOURCES.bangumi.enabled = true;
        try {
            reset((url) => url.startsWith('/proxy/')
                ? Promise.reject(new TypeError('no proxy'))
                : Promise.resolve(resp(JSON.stringify(CALENDAR))));
            await A.fetch('bangumi');
            const b0 = calls.length;
            t('9：Bangumi 启用后确实发起请求', b0 > 0);
            advance(29 * MIN);
            await A.fetch('bangumi');
            t('9：Bangumi 29 分钟内命中缓存', calls.length === b0);
            advance(2 * MIN);                        // 累计 31 分钟 > 30 TTL
            await A.fetch('bangumi');
            t('9：Bangumi 超过 30 分钟缓存失效，重新请求', calls.length > b0);
        } finally {
            A.SOURCES.bangumi.enabled = false;
        }
    }

    console.log('\n[10] in-flight 去重 + 不新增 localStorage 键');
    {
        reset((url) => {
            if (url.includes('/v2/douban/weekly')) return Promise.resolve(resp(sixtyJson(WEEKLY)));
            return Promise.resolve(resp(sixtyJson(BAIDU)));
        });
        // 并发两次同源 fetch（模拟 initDouban 两次 renderRecommend）：fetchSource 的 in-flight
        // 去重让第二次直接复用同一个 Promise，故两次 await 得到「同一对象引用」（r1 === r2），
        // 而不是旧断言里「长度相等即可」的近恒真兜底。
        const [r1, r2] = await Promise.all([A.fetch('hotlist'), A.fetch('hotlist')]);
        t('10：并发两次返回同一对象引用（真正 in-flight 去重）', r1 === r2,
            `r1===r2 ? ${r1 === r2}`);
        // 一次 fetchHotList 成功路径恰好 2 次直连（豆瓣周榜 + 百度热播），无代理回退、无翻倍。
        // 精确断言而非旧的 ≤2，能真正暴露「去重失效导致请求翻倍」。
        eq(calls.length, 2, '10：并发去重后仅一组上游请求（精确 2 次直连）');
        eq(storageWrites, 0, '10：全程未写 localStorage（不新增键）');
    }

    console.log('\n[11] 限流 code:1015 / 非法 JSON / 脏数据：安全降级空数组，不抛错不弹 toast');
    {
        const RATE_LIMITED = { code: 1015, data: [
            { id: 7777, title: '限流脏数据A', rating: 9.9, cover: 'https://img9.doubanio.com/z.jpg' }
        ] };
        // 11a：code!=200 的整榜丢弃，另一正常榜仍返回（allSettled 单榜独立）
        reset((url) => {
            if (url.startsWith('/proxy/')) return Promise.reject(new TypeError('no proxy'));
            if (url.includes('/v2/douban/weekly')) return Promise.resolve(resp(JSON.stringify(RATE_LIMITED)));
            if (url.includes('/v2/baidu/teleplay')) return Promise.resolve(resp(sixtyJson(BAIDU)));
            return Promise.reject(new TypeError('x'));
        });
        const lim = await A.fetch('hotlist');
        t('11a：code=1015 的榜被整榜丢弃', lim.length === 2 && lim.every(i => i.subtitle === '百度热播'));
        t('11a：限流脏数据未混入结果', !lim.some(i => i.title === '限流脏数据A'));

        // 11b：Cloudflare 限流纯文本（非法 JSON）→ 主备全失败静默 []
        reset(() => Promise.resolve(resp('error code: 1015')));
        let threw = false, val;
        try { val = await A.fetch('hotlist'); } catch (e) { threw = true; }
        t('11b：非 JSON 限流文本不抛异常', !threw);
        t('11b：静默返回空数组', Array.isArray(val) && val.length === 0);

        // 11c：code=200 但 data 非数组
        reset(() => Promise.resolve(resp(JSON.stringify({ code: 200, data: { error: 'oops' } }))));
        const bad = await A.fetch('hotlist');
        t('11c：data 非数组安全返回空数组', Array.isArray(bad) && bad.length === 0);
    }

    console.log('\n[12] 豆瓣周榜自带 url 优先（仅接受 http(s)，否则按 id 兜底）');
    {
        const WITH_URL = [
            { id: 2001, title: '带链接电影', rating: 8.0, cover: 'https://img9.doubanio.com/u.jpg', url: 'https://movie.douban.com/subject/2001/?from=60s' },
            { id: 2002, title: '无链接电影', rating: 7.0, cover: 'https://img9.doubanio.com/v.jpg' },
            { id: 2003, title: '恶意链接电影', rating: 6.0, cover: 'https://img9.doubanio.com/w.jpg', url: 'javascript:alert(1)' }
        ];
        reset((url) => {
            if (url.includes('/v2/douban/weekly')) return Promise.resolve(resp(sixtyJson(WITH_URL)));
            if (url.includes('/v2/baidu/teleplay')) return Promise.resolve(resp(sixtyJson([])));
            return Promise.reject(new TypeError('x'));
        });
        const u = await A.fetch('hotlist');
        const a = u.find(i => i.title === '带链接电影');
        const b = u.find(i => i.title === '无链接电影');
        const c = u.find(i => i.title === '恶意链接电影');
        t('12：自带 http(s) url 优先取用', !!a && a.url === 'https://movie.douban.com/subject/2001/?from=60s');
        t('12：无 url 按 id 拼豆瓣条目兜底', !!b && b.url === 'https://movie.douban.com/subject/2002/');
        t('12：非 http(s) url 被拒并回退，杜绝 href 注入', !!c && c.url === 'https://movie.douban.com/subject/2003/');
    }

    console.log('\n[13] 无重试风暴：主/备各换一次，全失败静默返回空数组');
    {
        reset(() => Promise.reject(new TypeError('all down')));  // 直连与代理都失败
        let threw = false, r;
        try { r = await A.fetch('hotlist'); } catch (e) { threw = true; }
        t('13：主备全失败不抛异常', !threw);
        t('13：主备全失败返回空数组', Array.isArray(r) && r.length === 0);
        const bases = new Set();
        calls.forEach(cu => {
            const m = cu.url.match(/https?:\/\/60s\.[^/]+/);
            if (m) bases.add(m[0]);
        });
        t('13：仅访问主 + 备两个实例', bases.size === 2, [...bases].join(','));
        t('13：总请求数受控（≤8，无重试风暴）', calls.length <= 8, `calls=${calls.length}`);
    }

    console.log('\n[14] 60 分钟缓存覆盖两个榜单：命中时零新增请求');
    {
        reset((url) => {
            if (url.includes('/v2/douban/weekly')) return Promise.resolve(resp(sixtyJson(WEEKLY)));
            if (url.includes('/v2/baidu/teleplay')) return Promise.resolve(resp(sixtyJson(BAIDU)));
            return Promise.resolve(resp(sixtyJson([])));
        });
        const first = await A.fetch('hotlist');
        t('14：首次结果同时含两榜', first.some(i => i.subtitle === '豆瓣周榜') && first.some(i => i.subtitle === '百度热播'));
        const n = calls.length;
        const second = await A.fetch('hotlist');
        t('14：命中缓存零新增请求', calls.length === n);
        t('14：缓存命中返回同一份合并结果', second.length === first.length);
    }

    console.log('\n[15] 豆瓣周榜 cover 协议白名单（仅 http(s) / data:image/，非法置空不丢条目）');
    {
        const COVERS = [
            { id: 1, title: 'https封面', cover: 'https://img.example/a.jpg' },
            { id: 2, title: 'http封面', cover: 'http://img.example/b.jpg' },
            { id: 3, title: 'data图片', cover: 'data:image/png;base64,iVBORw0KGgo=' },
            { id: 4, title: 'js伪协议', cover: 'javascript:alert(1)' },
            { id: 5, title: 'data-html', cover: 'data:text/html,<script>1</script>' },
            { id: 6, title: '协议相对', cover: '//img.example/c.jpg' },
            { id: 7, title: 'ftp', cover: 'ftp://img.example/d.jpg' }
        ];
        reset((url) => {
            if (url.includes('/v2/douban/weekly')) return Promise.resolve(resp(sixtyJson(COVERS)));
            return Promise.resolve(resp(sixtyJson([])));
        });
        const items = await A.fetch('hotlist');
        eq(items.length, 7, '15：7 条均保留（cover 非法只置空字符串，不丢条目）');
        const byTitle = (x) => items.find(i => i.title === x);
        eq(byTitle('https封面').cover, 'https://img.example/a.jpg', '15：https cover 放行');
        eq(byTitle('http封面').cover, 'http://img.example/b.jpg', '15：http cover 放行');
        eq(byTitle('data图片').cover, 'data:image/png;base64,iVBORw0KGgo=', '15：data:image/ 放行');
        eq(byTitle('js伪协议').cover, '', '15：javascript: 置空');
        eq(byTitle('data-html').cover, '', '15：data:text/html 置空');
        eq(byTitle('协议相对').cover, '', '15：协议相对串置空');
        eq(byTitle('ftp').cover, '', '15：ftp 置空');
    }

    console.log('\n[16] 外部 signal 联动：请求进行中 abort 立即中止内部 controller');
    {
        let innerSignal = null;
        reset((url, opts) => {
            innerSignal = opts && opts.signal;
            // 挂起 Promise：监听内部 controller.signal 的 abort，模拟真实 fetch 被 AbortSignal 拒绝
            return new Promise(function (resolve, reject) {
                const sig = opts && opts.signal;
                if (sig && typeof sig.addEventListener === 'function') {
                    sig.addEventListener('abort', function () { reject(new Error('aborted')); });
                }
            });
        });
        const external = new AbortController();
        const p = A.fetchWithFallback('https://x.example/api', { signal: external.signal });
        t('16：外部 signal 初态未 abort', external.signal.aborted === false);
        external.abort();                 // 触发联动：外部 abort 事件 → 内部 controller.abort()
        const val = await p;
        eq(val, null, '16：外部 abort 后返回 null（不再空等自身超时）');
        t('16：内部 controller 被联动 abort', !!innerSignal && innerSignal.aborted === true);
        eq(calls.length, 1, '16：外部 abort 后不触发代理二次请求（初态检查兜底）');
    }

    console.log('\n========================================');
    console.log(`结果：${pass} 通过，${fail} 失败`);
    if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
}

main().catch(e => {
    console.log('FAIL  测试执行异常：' + (e && e.stack ? e.stack : e));
    process.exit(1);
});
