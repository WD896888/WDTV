// ============================================================
// WDTV 首页推荐「多源」聚合（window.WDTVRecommendSources）
// - 零依赖普通 script（IIFE + window.*）：浏览器与 Node 自测均可引用
// - 连接策略：浏览器直连优先 → 失败回退同源 /proxy/ 路径式代理
//   * 60s 两个实例均返回 Access-Control-Allow-Origin: *，可浏览器直连
//   * Bangumi 当前网络不可达，默认关闭；开启后失败静默降级，绝不拖慢首屏
// - 回退代理时给目标 URL 附加小时级 _wdtv 参数换缓存键：/proxy/ 对 JSON
//   设 max-age=86400 边缘缓存，按小时换键可保证榜单最多陈旧 1 小时；直连不加
// - 所有对外 fetch 失败一律返回 null / 空数组，绝不抛错、绝不弹提示
// - 统一输出 DoubanItem：{ title, rate, cover, url, id, subtitle }
//   供既有 renderDoubanCards（读取 title/rate/cover/url）直接消费
// ============================================================
(function (g) {
    'use strict';

    // ---------- 端点与策略常量（集中在文件头部，便于按实测调整） ----------
    var PROXY_URL = '/proxy/';                    // 与 js/config.js:2 保持一致；路径式代理
    var DIRECT_TIMEOUT_MS = 6000;                // 直连单次超时
    var PROXY_TIMEOUT_MS = 6000;                 // 代理单次超时（直连+代理总预算 ≤12s）
    var UA = 'WDTV/1.0 (home-recommend; +https://libretv.is-an.org)'; // 可识别 UA（代理路径服务端转发）

    // 60s API（免 key）：默认主实例，整轮失败自动切备用实例。端点只取两类榜单，
    // 不硬编码多个猜测路径反复请求；端点 404 / 数据异常时整源静默降级为空数组。
    var SIXTY_BASE_PRIMARY = 'https://60s.viki.moe';
    var SIXTY_BASE_FALLBACK = 'https://60s.crystelf.top';
    var SIXTY_ENDPOINTS = {
        doubanWeekly: '/v2/douban/weekly/movie',  // 豆瓣周榜（电影）
        baiduTeleplay: '/v2/baidu/teleplay'      // 百度热播剧
    };
    var BANGUMI_ENDPOINT = 'https://api.bgm.tv/calendar';

    var HOT_CACHE_TTL = 60 * 60 * 1000;          // 榜单缓存 60 分钟
    var BANGUMI_CACHE_TTL = 30 * 60 * 1000;      // 放送表缓存 30 分钟
    var HOT_CACHE_KEY = 'wdtvRecommendHotList';
    var BANGUMI_CACHE_KEY = 'wdtvRecommendBangumi';

    // douban 源不在此重写，返回此标记让调用方走既有 fetchDoubanData 链路
    var DOUBAN_LEGACY_MARKER = '__wdtv_douban_legacy__';

    var WEEKDAY_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

    var SOURCES = {
        douban: { id: 'douban', label: '豆瓣热门', enabled: true, note: '现有豆瓣分类推荐，行为保持不变' },
        hotlist: { id: 'hotlist', label: '影视榜单', enabled: true, note: '豆瓣周榜 + 百度热播（60s API，可直连）' },
        bangumi: { id: 'bangumi', label: '新番放送', enabled: false, note: 'Bangumi 每日放送，当前网络不可达，默认关闭；失败静默降级' }
    };

    // ---------- 内存缓存（不写 localStorage，不新增键） ----------
    var cache = new Map();
    var inflight = new Map();   // 同一源并发去重：initDouban 会触发两次 renderRecommend
    function clock() { return Date.now(); }
    function cacheGet(key) {
        var e = cache.get(key);
        if (e && clock() - e.ts < e.ttl) return e.data;
        if (e) cache.delete(key);
        return null;
    }
    function cacheSet(key, data, ttl) { cache.set(key, { ts: clock(), data: data, ttl: ttl }); }
    function clearCache(id) {
        if (id === 'hotlist') { cache.delete(HOT_CACHE_KEY); inflight.delete('hotlist'); }
        else if (id === 'bangumi') { cache.delete(BANGUMI_CACHE_KEY); inflight.delete('bangumi'); }
        else { cache.clear(); inflight.clear(); }
    }

    // ---------- 小时级缓存键规避（仅在回退代理时调用） ----------
    // 给目标 URL 附加 _wdtv=YYYYMMDDHH，按小时换 /proxy/ 边缘缓存键。
    // 可传入 date 便于测试得到确定值；默认取当前时间。
    function withCacheBuster(url, date) {
        var d = date || new Date();
        function pad(n) { return n < 10 ? '0' + n : '' + n; }
        var stamp = '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours());
        var u = String(url);
        var sep = u.indexOf('?') >= 0 ? '&' : '?';
        return u + sep + '_wdtv=' + stamp;
    }

    // ---------- 单次请求：各自独立超时，失败一律返回 null ----------
    function requestText(url, o) {
        var external = o.signal;
        if (external && external.aborted) return Promise.resolve(null);
        var controller = new AbortController();
        var fetchOpts = { signal: controller.signal };
        if (o.headers) fetchOpts.headers = o.headers;
        var raw;
        try { raw = fetch(url, fetchOpts); } catch (e) { return Promise.resolve(null); }
        return new Promise(function (resolve) {
            var done = false;
            var onExternalAbort = null;
            var timer = setTimeout(function () {
                try { controller.abort(); } catch (e) {}
                finish(null);
            }, o.timeoutMs);
            function finish(v) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                // 解绑外部 signal 监听，避免请求结束后仍持有引用
                if (external && onExternalAbort && typeof external.removeEventListener === 'function') {
                    try { external.removeEventListener('abort', onExternalAbort); } catch (e) {}
                }
                resolve(v);
            }
            // 外部 signal 联动：调用方在请求进行中 abort 时立即中止内部 controller 并结束，
            // 而不是只检查初态、让请求空等到自身超时。无 addEventListener（最小桩）时跳过。
            if (external && typeof external.addEventListener === 'function') {
                onExternalAbort = function () {
                    try { controller.abort(); } catch (e) {}
                    finish(null);
                };
                try {
                    external.addEventListener('abort', onExternalAbort, { once: true });
                } catch (e) { onExternalAbort = null; }
            }
            Promise.resolve(raw).then(function (res) {
                var bad = !res || res.ok === false ||
                    (typeof res.status === 'number' && (res.status < 200 || res.status >= 300));
                if (bad) { finish(null); return; }
                var tp;
                try { tp = Promise.resolve(res.text()); } catch (e) { finish(null); return; }
                tp.then(function (text) { finish(typeof text === 'string' ? text : null); },
                        function () { finish(null); });
            }, function () { finish(null); });
        });
    }

    // ---------- 直连优先 → 回退 /proxy/ 路径式代理 ----------
    // 直连成功直接返回文本；网络错误/CORS/非 2xx 回退代理；任何失败返回 null 不抛错。
    function fetchWithFallback(url, opts) {
        opts = opts || {};
        var directOpts = {
            timeoutMs: opts.timeoutMs || DIRECT_TIMEOUT_MS,
            signal: opts.signal,
            headers: opts.headers
        };
        var proxyOpts = {
            timeoutMs: opts.timeoutMs || PROXY_TIMEOUT_MS,
            signal: opts.signal,
            headers: opts.headers
        };
        return requestText(url, directOpts).then(function (text) {
            if (text !== null && text !== undefined) return text;   // 直连成功，不碰代理
            // 直连失败：目标 URL 附加小时级参数换缓存键，再交给同源代理
            var proxied = PROXY_URL + encodeURIComponent(withCacheBuster(url));
            return requestText(proxied, proxyOpts);
        }).catch(function () { return null; });
    }

    // ---------- 60s 榜单：豆瓣周榜 + 百度热播 ----------
    function parseSixty(text, kind) {
        if (!text) return [];
        var parsed;
        try { parsed = JSON.parse(text); } catch (e) { return []; }  // 非 JSON（限流 HTML/纯文本）静默降级
        // 限流/异常响应（如 Cloudflare code:1015）：code 存在且非 200 直接丢弃，避免脏数据
        if (parsed && typeof parsed === 'object' && 'code' in parsed &&
            parsed.code !== 200 && parsed.code !== '200') return [];
        var data = parsed && parsed.data;
        if (!Array.isArray(data)) return [];
        var out = [];
        for (var i = 0; i < data.length; i++) {
            var raw = data[i] || {};
            var item = (kind === 'douban') ? mapDoubanWeekly(raw) : mapBaiduTeleplay(raw, i);
            if (item) out.push(item);
        }
        return out;
    }

    // 外部推荐数据的封面统一协议白名单（与 douban.js 渲染侧 safeAssetUrl 形成纵深防御）：
    // 仅 http(s) 或 data:image/ 内联图，javascript: / data:text/html / ftp: 一律置空。
    function safeAssetUrl(u) {
        var s = String(u || '');
        return (/^https?:\/\//i.test(s) || /^data:image\//i.test(s)) ? s : '';
    }

    function mapDoubanWeekly(raw) {
        var title = raw.title;
        var cover = raw.cover || raw.cover_proxy;
        if (!title || !cover) return null;
        var rate = (typeof raw.rating === 'number' && raw.rating > 0) ? String(raw.rating) : '';
        var id = raw.id != null ? String(raw.id) : '';
        // 60s 周榜自带 url 时优先取用（仅接受 http(s)，防外部数据注入 href），否则按 id 拼豆瓣条目兜底
        var fallbackUrl = id ? ('https://movie.douban.com/subject/' + id + '/') : 'https://movie.douban.com/';
        var detailUrl = (typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url)) ? raw.url : fallbackUrl;
        // cover 协议白名单：与 url 对齐，仅接受 http(s) 或 data:image/ 内联图片；
        // javascript: / data:text/html / ftp: / 协议相对串等一律置空，杜绝外部数据注入 img src。
        var coverUrl = safeAssetUrl(cover);
        return {
            title: String(title),
            rate: rate,
            cover: coverUrl,
            url: detailUrl,
            id: 'dbw_' + (id || title),
            subtitle: '豆瓣周榜'
        };
    }

    function mapBaiduTeleplay(raw, index) {
        var title = raw.title;
        var cover = raw.cover;
        if (!title || !cover) return null;
        return {
            title: String(title),
            rate: '',
            cover: safeAssetUrl(cover),
            url: 'https://www.baidu.com/s?wd=' + encodeURIComponent(String(title)),
            id: 'bd_' + index,
            subtitle: '百度热播'
        };
    }

    function fetchOneList(url, kind, opts) {
        return fetchWithFallback(url, opts).then(function (text) {
            return parseSixty(text, kind);
        });
    }

    // 两类榜单用 Promise.allSettled 并行，单榜失败不影响另一榜；
    // 主实例整轮（两榜皆空）失败时自动切备用实例，再失败静默返回 []。
    function fetchHotList(opts) {
        opts = opts || {};
        var cached = cacheGet(HOT_CACHE_KEY);
        if (cached) return Promise.resolve(cached);
        var bases = [SIXTY_BASE_PRIMARY, SIXTY_BASE_FALLBACK];
        return runBase(0);
        function runBase(bi) {
            if (bi >= bases.length) return Promise.resolve([]);
            var base = bases[bi];
            return Promise.allSettled([
                fetchOneList(base + SIXTY_ENDPOINTS.doubanWeekly, 'douban', opts),
                fetchOneList(base + SIXTY_ENDPOINTS.baiduTeleplay, 'baidu', opts)
            ]).then(function (settled) {
                var items = [];
                for (var i = 0; i < settled.length; i++) {
                    if (settled[i].status === 'fulfilled' && Array.isArray(settled[i].value)) {
                        items = items.concat(settled[i].value);
                    }
                }
                if (items.length) {
                    cacheSet(HOT_CACHE_KEY, items, HOT_CACHE_TTL);
                    return items;
                }
                return runBase(bi + 1);   // 整轮失败 → 换备用实例
            });
        }
    }

    // ---------- Bangumi 每日放送：按星期分组后扁平化为 DoubanItem[] ----------
    function parseBangumiCalendar(text) {
        if (!text) return [];
        var raw;
        try { raw = JSON.parse(text); } catch (e) { return []; }
        if (!Array.isArray(raw)) return [];
        var groups = {};
        for (var i = 0; i < raw.length; i++) {
            var day = raw[i] || {};
            var wid = day.weekday && day.weekday.id;
            if (!(wid >= 1 && wid <= 7)) continue;      // 丢弃 8 等非法星期
            var subs = Array.isArray(day.items) ? day.items : [];
            var arr = groups[wid] || (groups[wid] = []);
            for (var j = 0; j < subs.length; j++) {
                var item = mapBangumiSubject(subs[j] || {}, wid);
                if (item) arr.push(item);
            }
        }
        var out = [];
        for (var w = 1; w <= 7; w++) {                  // 周一 → 周日顺序
            if (groups[w]) out = out.concat(groups[w]);
        }
        return out;
    }

    function mapBangumiSubject(subject, weekdayId) {
        var title = subject.name_cn || subject.name;
        var imgs = subject.images || {};
        var cover = imgs.large || imgs.common || imgs.medium || imgs.small || imgs.grid;
        if (!title || !cover) return null;
        var score = (subject.rating && typeof subject.rating.score === 'number') ? subject.rating.score : 0;
        var rate = score > 0 ? score.toFixed(1) : '';
        var id = subject.id != null ? String(subject.id) : '';
        return {
            title: String(title),
            rate: rate,
            cover: safeAssetUrl(cover),
            url: id ? ('https://bgm.tv/subject/' + id) : 'https://bgm.tv/calendar',
            id: 'bgm_' + (id || title),
            subtitle: (WEEKDAY_CN[weekdayId] || '') + ' · 新番放送'
        };
    }

    // 失败返回 [] 且不弹任何提示；带可识别 UA（浏览器直连会忽略该头，代理路径由服务端转发）。
    function fetchBangumi(opts) {
        opts = opts || {};
        var cached = cacheGet(BANGUMI_CACHE_KEY);
        if (cached) return Promise.resolve(cached);
        var o = {
            timeoutMs: opts.timeoutMs,
            signal: opts.signal,
            headers: { 'User-Agent': UA, 'Accept': 'application/json' }
        };
        return fetchWithFallback(BANGUMI_ENDPOINT, o).then(function (text) {
            var items = parseBangumiCalendar(text);
            if (items.length) cacheSet(BANGUMI_CACHE_KEY, items, BANGUMI_CACHE_TTL);
            return items;
        });
    }

    // ---------- 分发 / 元数据 / 文案 ----------
    function get(id) { return SOURCES[id] || null; }

    // 同一次渲染可能被多处触发（initDouban 会调两次 renderRecommend），
    // 用 in-flight 去重保证同一源并发只发起一次网络请求，结果共享。
    function fetchSource(id, opts) {
        // 禁用源（如 Bangumi 当前网络不可达）：入口直接返回空数组，零网络请求，
        // 返回形状与其它失败路径一致（douban.js renderRecommendFromSource 据此显示克制空态）。
        // 这是 enabled 的唯一消费点：即便 change / readRecommendSource 漏校验，也不会再对
        // 不可达源发起「直连 6s + 代理 6s」的请求，杜绝「假禁用」。
        if (SOURCES[id] && SOURCES[id].enabled === false) return Promise.resolve([]);
        if (id !== 'hotlist' && id !== 'bangumi') {
            return Promise.resolve(id === 'douban' ? DOUBAN_LEGACY_MARKER : []);
        }
        if (inflight.has(id)) return inflight.get(id);
        var p = (id === 'hotlist') ? fetchHotList(opts) : fetchBangumi(opts);
        inflight.set(id, p);
        var done = function () { inflight.delete(id); };
        p.then(done, done);
        return p;
    }

    function describeFailure(id) {
        if (id === 'hotlist') return '影视榜单暂时无法加载，请稍后重试或切回豆瓣热门';
        if (id === 'bangumi') return '新番放送暂时无法加载，请检查网络或切回豆瓣热门';
        return '推荐内容暂时无法加载，请稍后重试';
    }

    // ============================================================
    // 导出
    // ============================================================
    g.WDTVRecommendSources = {
        SOURCES: SOURCES,
        DOUBAN_LEGACY: DOUBAN_LEGACY_MARKER,
        ENDPOINTS: {
            sixtyPrimary: SIXTY_BASE_PRIMARY,
            sixtyFallback: SIXTY_BASE_FALLBACK,
            doubanWeekly: SIXTY_ENDPOINTS.doubanWeekly,
            baiduTeleplay: SIXTY_ENDPOINTS.baiduTeleplay,
            bangumi: BANGUMI_ENDPOINT
        },
        HOT_CACHE_TTL: HOT_CACHE_TTL,
        BANGUMI_CACHE_TTL: BANGUMI_CACHE_TTL,
        fetchWithFallback: fetchWithFallback,
        withCacheBuster: withCacheBuster,
        fetchHotList: fetchHotList,
        fetchBangumi: fetchBangumi,
        get: get,
        fetch: fetchSource,
        describeFailure: describeFailure,
        clearCache: clearCache
    };
})(typeof window !== 'undefined' ? window : globalThis);
