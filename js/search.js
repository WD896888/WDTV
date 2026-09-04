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

// 搜索单个源：
//   第 1 页结果立即返回（不等待后续页），让首批结果尽早到达渲染；
//   第 2 页起在后台继续获取，完成后通过第三参数回调 onAdditional(results) 追加。
//   signal 为本次搜索会话的共享 AbortSignal（新搜索发起时 abort 旧请求）。
async function searchByAPIAndKeyWord(apiId, query, onAdditional, signal) {
    try {
        if (!API_SITES[apiId]) return [];

        const apiBaseUrl = API_SITES[apiId].api;
        const apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
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

        // 处理第一页结果
        const results = data.list.map(item => ({
            ...item,
            source_name: apiName,
            source_code: apiId
        }));

        // 后台补页：获取总页数后并行补抓第 2 页起的结果，不阻塞首批结果返回
        const pageCount = data.pagecount || 1;
        const pagesToFetch = Math.min(pageCount - 1, API_CONFIG.search.maxPages - 1);

        if (pagesToFetch > 0 && typeof onAdditional === 'function') {
            const fetchPage = async (page) => {
                try {
                    const pageUrl = apiBaseUrl + API_CONFIG.search.pagePath
                        .replace('{query}', encodeURIComponent(query))
                        .replace('{page}', page);
                    const pageResponse = await fetchSearchData(pageUrl, apiId, signal);
                    if (!pageResponse.ok) return [];
                    const pageData = await pageResponse.json();
                    if (!pageData || !pageData.list || !Array.isArray(pageData.list)) return [];
                    return pageData.list.map(item => ({
                        ...item,
                        source_name: apiName,
                        source_code: apiId
                    }));
                } catch (error) {
                    // 新搜索 abort 造成的失败不算源故障
                    if (!(error && error.name === 'AbortError')) {
                        console.warn(`API ${apiId} 第${page}页搜索失败:`, error);
                    }
                    return [];
                }
            };

            (async () => {
                const pagePromises = [];
                for (let page = 2; page <= pagesToFetch + 1; page++) {
                    pagePromises.push(fetchPage(page));
                }
                const additional = await Promise.all(pagePromises);
                const merged = [];
                additional.forEach(pageResults => {
                    if (pageResults.length > 0) merged.push(...pageResults);
                });
                if (merged.length > 0) {
                    try { onAdditional(merged); } catch (e) { /* 回调异常不影响补页 */ }
                }
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
