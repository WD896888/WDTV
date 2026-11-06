// 搜索请求：直连优先，失败后回退本地代理
// 统一请求出口与源健康度（含直连维度）见 api.js 的 fetchWithFallback / SOURCE_HEALTH。
const SEARCH_DIRECT_TIMEOUT = 2500;  // 直连尝试预算（不可达主机快速失败后立即回退代理）
const SEARCH_TOTAL_BUDGET = 12000;   // 单请求总预算

async function fetchSearchData(url, apiId, signal) {
    return fetchWithFallback(url, {
        headers: API_CONFIG.search.headers,
        directTimeout: SEARCH_DIRECT_TIMEOUT,
        totalBudget: SEARCH_TOTAL_BUDGET,
        apiId: apiId || null,
        signal: signal || null
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
    const apiBaseUrl = API_SITES[apiId].api;
    const apiName = API_SITES[apiId].name;
    const from = Math.max(1, Math.floor(fromPage) || 1);
    const to = Math.max(from, Math.floor(toPage) || from);

    const pagePromises = [];
    for (let page = from; page <= to; page++) {
        pagePromises.push((async () => {
            try {
                // buildVodApiUrl：自定义源 api 字段已含接口路径时只补查询串，避免 …/provide/vod/api.php/provide/vod/ 双重路径
                const pageUrl = buildVodApiUrl(apiBaseUrl, API_CONFIG.search.pagePath)
                    .replace('{query}', encodeURIComponent(query))
                    .replace('{page}', page);
                const pageResponse = await fetchSearchData(pageUrl, apiId, signal);
                if (!pageResponse.ok) return { page, failed: true, list: [] };
                const pageData = await pageResponse.json();
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
        if (list && list.length > 0) items.push(...list);
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
async function searchByAPIAndKeyWord(apiId, query, onAdditional, signal) {
    try {
        if (!API_SITES[apiId]) return [];

        const apiBaseUrl = API_SITES[apiId].api;
        // buildVodApiUrl：自定义源 api 字段已含接口路径时只补查询串，避免 …/provide/vod/api.php/provide/vod/ 双重路径
        const apiUrl = buildVodApiUrl(apiBaseUrl, API_CONFIG.search.path) + encodeURIComponent(query);
        const apiName = API_SITES[apiId].name;

        // 请求第一页结果（直连优先，失败回退代理；直连成败计入源健康度）
        const response = await fetchSearchData(apiUrl, apiId, signal);

        if (!response.ok) {
            markSourceHealth(apiId, false);
            return [];
        }

        let data;
        try {
            data = await response.json();
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
        const results = data.list.map(item => ({
            ...item,
            vod_pic: normalizeRuyiPicUrl(item.vod_pic),
            source_name: apiName,
            source_code: apiId
        }));

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
