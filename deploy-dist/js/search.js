// 搜索请求：直连优先，失败后回退本地代理
// 统一请求出口与源健康度（含直连维度）见 api.js 的 fetchWithFallback / SOURCE_HEALTH。
const SEARCH_DIRECT_TIMEOUT = 2500;  // 直连尝试预算（不可达主机快速失败后立即回退代理）
const SEARCH_TOTAL_BUDGET = 12000;   // 单请求总预算

// ===== 内置成人/伦理内容过滤（默认开启，界面无开关，用户不可改） =====
// 名单和判定只在这里维护；任何搜索源的结果进入列表前都会先过这一层。
var WDTV_ADULT_FILTER_KEYWORDS = [
    '伦理片', '伦理', '色情片', '色情', '成人片', '成人视频', '成人',
    '里番动漫', '里番', '福利片', '福利视频', '福利姬', '福利',
    '无码', '有码', '国产传媒', '制服诱惑', '黑丝诱惑', '萝莉少女',
    '门事件', 'swag', '网红主播', '同性片', '同志片',
    '三级片', '三级', '限制级', '18禁', '18+', 'av', 'gv'
];
var WDTV_ADULT_LATIN_RE = /^[a-z0-9+]+$/i;

function wdtvAdultKeywordHits(text, keyword) {
    var s = String(text || '').toLowerCase()
        .replace(/[\uff01-\uff5e]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); })
        .replace(/[\s\u3000\-_·.,，。、\/\\|]/g, '');
    var k = String(keyword || '').toLowerCase()
        .replace(/[\uff01-\uff5e]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); })
        .replace(/[\s\u3000\-_·.,，。、\/\\|]/g, '');
    if (!k) return false;
    // 短英文/数字词按独立 token 匹配，避免 av 命中 avengers 这类误杀
    if (WDTV_ADULT_LATIN_RE.test(k)) {
        var escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp('(^|[^a-z0-9+])' + escaped + '([^a-z0-9+]|$)').test(s);
    }
    return s.indexOf(k) >= 0;
}

function isAdultFilteredItem(item) {
    if (!item || typeof item !== 'object') return false;
    var text = [
        item.type_name, item.vod_name, item.vod_tag,
        item.vod_remarks, item.vod_content
    ].join(' ');
    return WDTV_ADULT_FILTER_KEYWORDS.some(function (k) {
        return wdtvAdultKeywordHits(text, k);
    });
}

function filterAdultSearchItems(items) {
    if (!Array.isArray(items)) return items;
    return items.filter(function (item) { return !isAdultFilteredItem(item); });
}

async function fetchSearchData(url, apiId, signal) {
    return fetchWithFallback(url, {
        headers: API_CONFIG.search.headers,
        directTimeout: SEARCH_DIRECT_TIMEOUT,
        totalBudget: SEARCH_TOTAL_BUDGET,
        apiId: apiId || null,
        signal: signal || null,
        race: true
    });
}

// 由接口响应推断源的总页数：优先 pagecount 字段；
// 部分源不返回 pagecount，此时按 total/limit 推算（limit 缺失时用首页条数兜底）。
function resolvePageCount(data) {
    const pagecount = Number(data && data.pagecount);
    if (pagecount > 0) return Math.floor(pagecount);
    const total = Number(data && data.total);
    if (total > 0) {
        const limit = Number(data && data.limit) > 0 ? Number(data.limit)
            : (Array.isArray(data.list) && data.list.length > 0 ? data.list.length : 20);
        return Math.max(1, Math.ceil(total / limit));
    }
    return 1;
}

// 抓取单个源指定页码区间（含两端）的搜索结果。
// 返回 { items, fetchedThrough }：
//   items          —— 连续成功前缀（从 fromPage 起、无失败页）抓到的结果合并
//   fetchedThrough —— 该连续前缀的最大页码。语义：调用方拿到 fetchedThrough=N 时，
//                    可确定第 1..N 页结果都已在 items 里、第 N 页之后没有任何一页入库。
//                    某一页抓取失败（网络/格式错误）时整体停在该页之前，调用方下次
//                    会重试该页，避免失败页被永久跳过丢结果；服务端返回空列表
//                    （数据到底）算成功，指针正常推进，保证翻页能收敛。
// 页码起止由调用方给出：首次搜索的后台补页与搜索结果页的「加载更多」按源翻页共用。
// signal 为本次搜索会话的共享 AbortSignal（新搜索发起时 abort 旧请求）。
async function fetchSearchPages(apiId, query, fromPage, toPage, signal) {
    if (!API_SITES[apiId]) return { items: [], fetchedThrough: Math.max(0, (Math.floor(fromPage) || 1) - 1) };
    // HTML 搜索模式（天涯资源）：按站点搜索页分页补抓，不走标准 API
    if (API_SITES[apiId].searchMode === 'html') {
        return await fetchHtmlSearchPages(apiId, query, fromPage, toPage, signal);
    }
    // suggest 模式（最大资源）：一次取回全部匹配，没有后续页
    if (API_SITES[apiId].searchMode === 'suggest') {
        return { items: [], fetchedThrough: Math.max(0, (Math.floor(fromPage) || 1) - 1) };
    }
    const apiBaseUrl = API_SITES[apiId].api;
    const apiName = API_SITES[apiId].name;
    const from = Math.max(1, Math.floor(fromPage) || 1);
    const to = Math.max(from, Math.floor(toPage) || from);

    const pagePromises = [];
    for (let page = from; page <= to; page++) {
        pagePromises.push((async () => {
            try {
                // buildVodApiUrl：自定义源 api 字段已含接口路径时只补查询串，避免 …/provide/vod/api.php/provide/vod/ 双重路径
                // applySearchParam：个别源不认 wd=（天涯资源只认 keywords=）
                const pagePath = (typeof applySearchParam === 'function')
                    ? applySearchParam(API_CONFIG.search.pagePath, API_SITES[apiId])
                    : API_CONFIG.search.pagePath;
                const pageUrl = buildVodApiUrl(apiBaseUrl, pagePath)
                    .replace('{query}', encodeURIComponent(query))
                    .replace('{page}', page);
                const pageResponse = await fetchSearchData(pageUrl, apiId, signal);
                if (!pageResponse.ok) return { page, failed: true, list: [] };
                const pageText = await pageResponse.text();
                const pageData = (typeof parseCmsJsonSafe === 'function')
                    ? parseCmsJsonSafe(pageText) : JSON.parse(pageText);
                if (!pageData || !pageData.list || !Array.isArray(pageData.list)) {
                    return { page, failed: true, list: [] };
                }
                // 空列表算抓取成功（数据到底），由调用方按连续前缀推进指针
                return {
                    page,
                    failed: false,
                    list: pageData.list.map(item => ({
                        ...item,
                        vod_pic: normalizeRuyiPicUrl(item.vod_pic),
                        source_name: apiName,
                        source_code: apiId
                    }))
                };
            } catch (error) {
                // 新搜索 abort 造成的失败不算源故障
                if (!(error && error.name === 'AbortError')) {
                    console.warn(`API ${apiId} 第${page}页搜索失败:`, error);
                }
                return { page, failed: true, list: [] };
            }
        })());
    }

    const pages = await Promise.all(pagePromises);
    const items = [];
    let fetchedThrough = from - 1;
    for (const { page, failed, list } of pages) {
        if (failed) break; // 失败页即停：该页与其后所有页都不入库，指针停在失败页之前
        fetchedThrough = page;
        if (list && list.length > 0) items.push(...filterAdultSearchItems(list));
    }
    return { items, fetchedThrough };
}

// 搜索单个源：
//   第 1 页结果立即返回（不等待后续页），让首批结果尽早到达渲染；
//   第 2 页起在后台继续获取，完成后通过第三参数回调 onAdditional(results, meta) 追加。
//   meta = { pageCount: 源总页数, fetchedThrough: 本次已抓到的最大页码 }，
//   供 UI 判断该源是否还有后续页可「加载更多」（补页完成才可知总页数，故无论补页
//   是否拿到结果都会回调一次）。
//   signal 为本次搜索会话的共享 AbortSignal（新搜索发起时 abort 旧请求）。
// ===== 天涯资源：站点 HTML 搜索页解析 =====
// 官方 API 关闭了关键词搜索，但官网搜索页
//   /index.php/vod/search/page/{page}/wd/{query}.html
// 仍返回完整结果（30 条/页、带分页），详情继续走标准 API ?ac=videolist&ids=。
function parseTyyszySearchHtml(html) {
    const out = { items: [], pageCount: 1 };
    if (!html) return out;
    try {
        if (typeof DOMParser === 'function') {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const seen = new Set();
            doc.querySelectorAll('a.movie-card[href*="/vod/detail/id/"]').forEach(function (a) {
                const href = a.getAttribute('href') || '';
                const m = href.match(/\/vod\/detail\/id\/(\d+)\.html/);
                if (!m || seen.has(m[1])) return;
                seen.add(m[1]);
                const img = a.querySelector('img');
                let pic = img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
                if (pic && !/^(https?:)?\/\//i.test(pic) && !/^data:/i.test(pic)) {
                    try { pic = new URL(pic, 'https://tyyszyapi.com').href; } catch (e) { /* 保留原值 */ }
                }
                const name = a.getAttribute('data-name')
                    || (img && img.getAttribute('alt'))
                    || (a.textContent || '').trim();
                if (!name) return;
                out.items.push({
                    vod_id: m[1],
                    vod_name: name,
                    vod_pic: normalizeRuyiPicUrl(pic),
                    vod_play_url: '',
                    type_name: '',
                    vod_remarks: ''
                });
            });
            let maxPage = 1;
            doc.querySelectorAll('a.page_link[href]').forEach(function (a) {
                const m = (a.getAttribute('href') || '').match(/\/search\/page\/(\d+)\/wd\//);
                if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10) || 1);
            });
            out.pageCount = maxPage;
            return out;
        }
        // 无 DOMParser 的环境：仅解析 id/名称，封面留空
        const re = /<a[^>]+href="[^"]*\/vod\/detail\/id\/(\d+)\.html"[^>]*data-name="([^"]*)"/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            out.items.push({ vod_id: m[1], vod_name: m[2], vod_pic: '', vod_play_url: '', type_name: '', vod_remarks: '' });
        }
    } catch (e) { /* 解析失败按空结果处理 */ }
    return out;
}

async function fetchHtmlSearchPage(apiId, query, page, signal) {
    const site = API_SITES[apiId];
    const url = String(site.searchUrl)
        .replace('{page}', String(page))
        .replace('{query}', encodeURIComponent(query));
    const response = await fetchSearchData(url, apiId, signal);
    if (!response.ok) return { page, items: [], pageCount: 1, failed: true };
    const html = await response.text();
    const parsed = parseTyyszySearchHtml(html);
    return { page, items: parsed.items, pageCount: parsed.pageCount, failed: false };
}

function decorateHtmlSearchItems(apiId, items) {
    const site = API_SITES[apiId];
    return filterAdultSearchItems(items).map(function (item) {
        return Object.assign({}, item, { source_name: site.name, source_code: apiId });
    });
}

async function fetchHtmlSearchPages(apiId, query, fromPage, toPage, signal) {
    const from = Math.max(1, Math.floor(fromPage) || 1);
    const to = Math.max(from, Math.floor(toPage) || from);
    const pages = [];
    for (let p = from; p <= to; p++) pages.push(p);
    const results = await Promise.all(pages.map(async function (p) {
        try {
            return await fetchHtmlSearchPage(apiId, query, p, signal);
        } catch (error) {
            if (!(error && error.name === 'AbortError')) {
                console.warn(`API ${apiId} 第${p}页 HTML 搜索失败:`, error);
            }
            return { page: p, items: [], failed: true };
        }
    }));
    results.sort(function (a, b) { return a.page - b.page; });
    const items = [];
    let fetchedThrough = from - 1;
    for (const r of results) {
        if (r.failed) break;
        fetchedThrough = r.page;
        if (r.items && r.items.length > 0) items.push(...decorateHtmlSearchItems(apiId, r.items));
    }
    return { items, fetchedThrough };
}

async function searchByHtmlSource(apiId, query, onAdditional, signal) {
    try {
        const first = await fetchHtmlSearchPage(apiId, query, 1, signal);
        if (first.failed || first.items.length === 0) return [];
        const results = decorateHtmlSearchItems(apiId, first.items);
        if (typeof onAdditional === 'function') {
            const maxPages = Math.max(1, Number(API_CONFIG.search.maxPages) || 1);
            const lastPage = Math.min(Math.max(1, first.pageCount), maxPages);
            (async function () {
                let merged = [];
                let fetchedThrough = 1;
                if (lastPage >= 2) {
                    const bg = await fetchHtmlSearchPages(apiId, query, 2, lastPage, signal);
                    merged = bg.items;
                    fetchedThrough = Math.max(1, bg.fetchedThrough);
                }
                try {
                    onAdditional(merged, { pageCount: first.pageCount, fetchedThrough: fetchedThrough });
                } catch (e) { /* 回调异常不影响补页 */ }
            })();
        }
        return results;
    } catch (error) {
        if (!(error && error.name === 'AbortError')) {
            console.warn(`API ${apiId} HTML 搜索失败:`, error);
        }
        return [];
    }
}

// 站点 suggest 搜索（最大资源）：官方 API 忽略 wd，改用站点 suggest 接口。
// searchUrl 支持 {query} 占位；最大资源用 limit=2000 一次取回全部匹配。
async function searchBySuggestSource(apiId, query, onAdditional, signal) {
    const site = API_SITES[apiId];
    const encoded = encodeURIComponent(query);
    const url = String(site.searchUrl).indexOf('{query}') >= 0
        ? site.searchUrl.replace('{query}', encoded)
        : site.searchUrl + encoded;
    const picBase = String(site.searchPicBase || '').replace(/\/+$/, '');
    try {
        const response = await fetchSearchData(url, apiId, signal);
        if (!response.ok) return [];
        const text = await response.text();
        let data = null;
        try {
            data = (typeof parseCmsJsonSafe === 'function')
                ? parseCmsJsonSafe(text) : JSON.parse(text);
        } catch (e) { data = null; }
        if (!data || !Array.isArray(data.list)) return [];
        const results = data.list.map(item => {
            let pic = (item && item.pic) || '';
            // suggest 接口可能返回相对封面路径（如 /upload/...），用源配置的图床基地址补全
            if (pic && picBase && !/^(https?:)?\/\//i.test(pic) && !/^data:/i.test(pic)) {
                pic = picBase + (pic.charAt(0) === '/' ? '' : '/') + pic;
            }
            return {
                vod_id: item && item.id,
                vod_name: (item && item.name) || '',
                vod_pic: normalizeRuyiPicUrl(pic),
                vod_play_url: '',
                type_name: '',
                vod_remarks: '',
                source_name: site.name,
                source_code: apiId
            };
        }).filter(item => item.vod_id != null && item.vod_name).filter(item => !isAdultFilteredItem(item));
        if (typeof onAdditional === 'function') {
            onAdditional([], { pageCount: 1, fetchedThrough: 1 });
        }
        return results;
    } catch (error) {
        if (!(error && error.name === 'AbortError')) {
            console.warn(`API ${apiId} suggest 搜索失败:`, error);
        }
        return [];
    }
}

async function searchByAPIAndKeyWord(apiId, query, onAdditional, signal) {
    try {
        if (!API_SITES[apiId]) return [];

        // 天涯资源：官方 API 关闭搜索，改走站点 HTML 搜索页（支持分页）
        if (API_SITES[apiId].searchMode === 'html' && API_SITES[apiId].searchUrl) {
            return await searchByHtmlSource(apiId, query, onAdditional, signal);
        }

        // 最大资源：官方 API 忽略 wd，改走站点 suggest 接口
        if (API_SITES[apiId].searchMode === 'suggest' && API_SITES[apiId].searchUrl) {
            return await searchBySuggestSource(apiId, query, onAdditional, signal);
        }

        const apiBaseUrl = API_SITES[apiId].api;
        // buildVodApiUrl：自定义源 api 字段已含接口路径时只补查询串，避免 …/provide/vod/api.php/provide/vod/ 双重路径
        // applySearchParam：个别源不认 wd=（天涯资源只认 keywords=）
        const searchPath = (typeof applySearchParam === 'function')
            ? applySearchParam(API_CONFIG.search.path, API_SITES[apiId])
            : API_CONFIG.search.path;
        const apiUrl = buildVodApiUrl(apiBaseUrl, searchPath) + encodeURIComponent(query);
        const apiName = API_SITES[apiId].name;

        // 请求第一页结果（直连优先，失败回退代理；直连成败计入源健康度）
        const response = await fetchSearchData(apiUrl, apiId, signal);

        if (!response.ok) {
            markSourceHealth(apiId, false);
            return [];
        }

        let data;
        try {
            const text = await response.text();
            data = (typeof parseCmsJsonSafe === 'function')
                ? parseCmsJsonSafe(text) : JSON.parse(text);
        } catch (e) {
            markSourceHealth(apiId, false);
            return [];
        }

        // 格式无效说明源异常（有结果与否不影响健康度判断）
        if (!data || !data.list || !Array.isArray(data.list)) {
            markSourceHealth(apiId, false);
            return [];
        }
        markSourceHealth(apiId, true);

        if (data.list.length === 0) {
            return [];
        }

        // 处理第一页结果（封面图床域名归一，见 config.js normalizeRuyiPicUrl）
        const results = filterAdultSearchItems(data.list.map(item => ({
            ...item,
            vod_pic: normalizeRuyiPicUrl(item.vod_pic),
            source_name: apiName,
            source_code: apiId
        })));

        // 后台补页：获取总页数后并行补抓第 2 页起的结果，不阻塞首批结果返回。
        // 超出 maxPages 的页不自动抓（避免一次性放大请求量拖慢搜索），由用户
        // 翻页时按需补抓（见 app.js goToResultPage / ensureResultsForPage）。
        if (typeof onAdditional === 'function') {
            const pageCount = resolvePageCount(data);
            const maxPages = Math.max(1, Number(API_CONFIG.search.maxPages) || 1);
            const lastPage = Math.min(pageCount, maxPages);

            (async () => {
                let merged = [];
                let fetchedThrough = 1; // 第 1 页此时已抓到
                if (lastPage >= 2) {
                    const bg = await fetchSearchPages(apiId, query, 2, lastPage, signal);
                    merged = bg.items;
                    // 补页中途失败时指针停在失败页之前，UI 端的“加载更多”会重试该页
                    fetchedThrough = Math.max(1, bg.fetchedThrough);
                }
                try {
                    onAdditional(merged, { pageCount, fetchedThrough });
                } catch (e) { /* 回调异常不影响补页 */ }
            })();
        }

        return results;
    } catch (error) {
        // 新搜索 abort 造成的失败不算源故障
        if (error && error.name === 'AbortError') return [];
        console.warn(`API ${apiId} 搜索失败:`, error);
        markSourceHealth(apiId, false);
        return [];
    }
}
