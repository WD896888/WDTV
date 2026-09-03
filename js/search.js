// 搜索请求策略：直连优先，失败后回退本地代理
// 资源站 MacCMS 接口普遍支持 CORS，直连速度最快；
// 全部请求挤过本地 /proxy/ 代理会多一跳且受服务端超时/重试影响，是搜索变慢的主因。
const SEARCH_DIRECT_TIMEOUT = 4000;  // 直连尝试预算（不可达主机快速失败后立即回退代理）
const SEARCH_TOTAL_BUDGET = 12000;   // 单请求总预算

// 源健康度记录：记录每个源最近一次请求成败（10 分钟内失败过的源在聚合搜索时延后发起）
const SOURCE_HEALTH_KEY = 'wdtvSourceHealth';
const SOURCE_HEALTH_TTL = 10 * 60 * 1000;

function markSourceHealth(apiId, ok) {
    try {
        let health = {};
        try { health = JSON.parse(localStorage.getItem(SOURCE_HEALTH_KEY) || '{}'); } catch (e) { health = {}; }
        health[apiId] = { ok: ok ? 1 : 0, ts: Date.now() };
        localStorage.setItem(SOURCE_HEALTH_KEY, JSON.stringify(health));
    } catch (e) { /* 存储失败不影响搜索 */ }
}

function isSourceUnhealthy(apiId) {
    try {
        const health = JSON.parse(localStorage.getItem(SOURCE_HEALTH_KEY) || '{}');
        const entry = health[apiId];
        return !!(entry && entry.ok === 0 && Date.now() - entry.ts < SOURCE_HEALTH_TTL);
    } catch (e) { return false; }
}

async function fetchSearchData(url) {
    const deadline = Date.now() + SEARCH_TOTAL_BUDGET;

    // 1) 直连尝试
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

    // 2) 回退本地代理（使用剩余总预算）
    const proxiedUrl = PROXY_URL + encodeURIComponent(url);

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

        // 请求第一页结果（直连优先，失败回退代理）
        const response = await fetchSearchData(apiUrl);

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
        markSourceHealth(apiId, false);
        return [];
    }
}
