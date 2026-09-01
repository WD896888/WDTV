// 搜索请求策略：所有源统一走本地代理 /proxy/，不做任何单个源的直连特殊处理，
// 行为对每个源一致，逻辑通用可维护。
const SEARCH_TOTAL_BUDGET = 15000;   // 单请求总预算（与原超时时间一致）

async function fetchSearchData(url) {
    const deadline = Date.now() + SEARCH_TOTAL_BUDGET;

    // 统一走本地代理（使用剩余总预算）
    const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ?
        await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(url)) :
        PROXY_URL + encodeURIComponent(url);

    const remaining = Math.max(deadline - Date.now(), 3000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
        return await fetch(proxiedUrl, {
            headers: API_CONFIG.search.headers,
            signal: controller.signal
        });
    } finally {
        clearTimeout(timer);
    }
}

async function searchByAPIAndKeyWord(apiId, query) {
    try {
        if (!API_SITES[apiId]) return [];

        const apiBaseUrl = API_SITES[apiId].api;
        const apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
        const apiName = API_SITES[apiId].name;

        // 请求第一页结果（统一走代理）
        const response = await fetchSearchData(apiUrl);

        if (!response.ok) {
            return [];
        }

        const data = await response.json();

        if (!data || !data.list || !Array.isArray(data.list) || data.list.length === 0) {
            return [];
        }

        // 处理第一页结果
        const results = data.list.map(item => ({
            ...item,
            source_name: apiName,
            source_code: apiId
        }));

        // 获取总页数
        const pageCount = data.pagecount || 1;
        // 确定需要获取的额外页数 (最多获取maxPages页)
        const pagesToFetch = Math.min(pageCount - 1, API_CONFIG.search.maxPages - 1);

        // 如果有额外页数，获取更多页的结果
        if (pagesToFetch > 0) {
            const additionalPagePromises = [];

            for (let page = 2; page <= pagesToFetch + 1; page++) {
                // 构建分页URL
                const pageUrl = apiBaseUrl + API_CONFIG.search.pagePath
                    .replace('{query}', encodeURIComponent(query))
                    .replace('{page}', page);

                // 创建获取额外页的Promise
                const pagePromise = (async () => {
                    try {
                        const pageResponse = await fetchSearchData(pageUrl);

                        if (!pageResponse.ok) return [];

                        const pageData = await pageResponse.json();

                        if (!pageData || !pageData.list || !Array.isArray(pageData.list)) return [];

                        // 处理当前页结果
                        return pageData.list.map(item => ({
                            ...item,
                            source_name: apiName,
                            source_code: apiId
                        }));
                    } catch (error) {
                        console.warn(`API ${apiId} 第${page}页搜索失败:`, error);
                        return [];
                    }
                })();

                additionalPagePromises.push(pagePromise);
            }

            // 等待所有额外页的结果
            const additionalResults = await Promise.all(additionalPagePromises);

            // 合并所有页的结果
            additionalResults.forEach(pageResults => {
                if (pageResults.length > 0) {
                    results.push(...pageResults);
                }
            });
        }

        return results;
    } catch (error) {
        console.warn(`API ${apiId} 搜索失败:`, error);
        return [];
    }
}
