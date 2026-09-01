// 搜索请求策略：仅对明确开放 CORS 的源（DIRECT_API_HOSTS）先直连，其余一律走本地代理
// 多数资源站接口未开放 CORS，浏览器直连必被拦截且只会空耗超时预算，直接走代理更快更稳。
const SEARCH_DIRECT_TIMEOUT = 6000;  // 直连尝试预算（仅对开放 CORS 的源生效）
const SEARCH_TOTAL_BUDGET = 15000;   // 单请求总预算（与原超时时间一致）

// 读取 config.js 里声明"开 CORS 可直接直连"的主机名；未配置时默认只有暴风资源。
const DIRECT_API_HOSTS = window.DIRECT_API_HOSTS || ['bfzyapi.com'];

// 判断该 API 是否对浏览器开放 CORS、值得先直连；其余源一律直接走代理
function directAllowed(apiUrl) {
    try {
        return DIRECT_API_HOSTS.includes(new URL(apiUrl).hostname);
    } catch (e) {
        return false;
    }
}

async function fetchSearchData(url, tryDirect = true) {
    const deadline = Date.now() + SEARCH_TOTAL_BUDGET;

    // 1) 直连尝试（仅对开放 CORS 的源执行，未开放则直接跳过，避免浪费 6s 超时预算）
    if (tryDirect) {
        try {
            const directController = new AbortController();
            const directTimer = setTimeout(() => directController.abort(), SEARCH_DIRECT_TIMEOUT);
            try {
                const direct = await fetch(url, {
                    headers: API_CONFIG.search.headers,
                    signal: directController.signal
                });
                if (direct.ok) return direct;
            } finally {
                clearTimeout(directTimer);
            }
        } catch (e) {
            // 直连失败（CORS/网络错误/超时），回退本地代理
        }
    }

    // 2) 回退本地代理（使用剩余总预算）
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
        // 该源是否开放 CORS 值得直连；未开放则全部走代理
        const tryDirect = directAllowed(apiUrl);

        // 请求第一页结果（开放 CORS 的源先直连，失败回退代理）
        const response = await fetchSearchData(apiUrl, tryDirect);

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
                        const pageResponse = await fetchSearchData(pageUrl, tryDirect);

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
