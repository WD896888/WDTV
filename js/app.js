// 全局变量
let selectedAPIs = JSON.parse(localStorage.getItem('selectedAPIs') || 'null') || Object.keys(API_SITES); // 默认选中所有资源

// 添加当前播放的集数索引
let currentEpisodeIndex = 0;
// 添加当前视频的所有集数
let currentEpisodes = [];
// 添加当前视频的标题
let currentVideoTitle = '';
// 全局变量用于倒序状态
let episodesReversed = false;

// 页面初始化
document.addEventListener('DOMContentLoaded', function () {
    // 初始化API复选框
    initAPICheckboxes();

    // 初始化显示选中的API数量
    updateSelectedApiCount();

    // 渲染搜索历史
    renderSearchHistory();

    // 设置默认API选择（如果是第一次加载）
    if (!localStorage.getItem('hasInitializedDefaults_v2')) {
        // 默认选中所有资源
        selectedAPIs = Object.keys(API_SITES);
        localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));

        // 默认选中过滤开关
        localStorage.setItem(PLAYER_CONFIG.adFilteringStorage, 'true');

        // 默认关闭豆瓣功能
        localStorage.setItem('doubanEnabled', 'false');

        // 标记已初始化默认值
        localStorage.setItem('hasInitializedDefaults_v2', 'true');
    }

    // 设置广告过滤开关初始状态
    const adFilterToggle = document.getElementById('adFilterToggle');
    if (adFilterToggle) {
        adFilterToggle.checked = localStorage.getItem(PLAYER_CONFIG.adFilteringStorage) !== 'false'; // 默认为true
    }

    // 设置动态效果开关初始状态（默认开启）
    const dynamicEffectsToggle = document.getElementById('dynamicEffectsToggle');
    if (dynamicEffectsToggle) {
        dynamicEffectsToggle.checked = localStorage.getItem('dynamicEffectsEnabled') !== 'false';
        applyDynamicEffects(dynamicEffectsToggle.checked);
    }

    // 设置事件监听器
    setupEventListeners();
});

// 初始化API复选框
function initAPICheckboxes() {
    const container = document.getElementById('apiCheckboxes');
    container.innerHTML = '';

    // 创建所有API源的复选框（不区分数据源）
    const apidiv = document.createElement('div');
    apidiv.className = 'grid grid-cols-2 gap-2';

    Object.keys(API_SITES).forEach(apiKey => {
        const api = API_SITES[apiKey];
        const checked = selectedAPIs.includes(apiKey);

        const checkbox = document.createElement('div');
        checkbox.className = 'flex items-center';
        checkbox.innerHTML = `
            <input type="checkbox" id="api_${apiKey}"
                   class="form-checkbox text-blue-600"
                   ${checked ? 'checked' : ''}
                   data-api="${apiKey}">
            <label for="api_${apiKey}" class="ml-1 text-xs text-gray-600 truncate">${api.name}</label>
        `;
        apidiv.appendChild(checkbox);

        // 添加事件监听器
        checkbox.querySelector('input').addEventListener('change', function () {
            updateSelectedAPIs();
        });
    });
    container.appendChild(apidiv);
}

// 更新选中的API列表
function updateSelectedAPIs() {
    // 获取所有API复选框
    const builtInApiCheckboxes = document.querySelectorAll('#apiCheckboxes input:checked');

    // 获取选中的API
    selectedAPIs = Array.from(builtInApiCheckboxes).map(input => input.dataset.api);

    // 保存到localStorage
    localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));

    // 更新显示选中的API数量
    updateSelectedApiCount();
}

// 更新选中的API数量显示
function updateSelectedApiCount() {
    const countEl = document.getElementById('selectedApiCount');
    if (countEl) {
        countEl.textContent = selectedAPIs.length;
    }
}

// 全选或取消全选API
function selectAllAPIs(selectAll = true) {
    const checkboxes = document.querySelectorAll('#apiCheckboxes input[type="checkbox"]');

    checkboxes.forEach(checkbox => {
        checkbox.checked = selectAll;
    });

    updateSelectedAPIs();
}

function toggleSettings(e) {
    const settingsPanel = document.getElementById('settingsPanel');
    if (!settingsPanel) return;

    if (settingsPanel.classList.contains('show')) {
        settingsPanel.classList.remove('show');
    } else {
        settingsPanel.classList.add('show');
    }

    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
}

// 设置事件监听器
function setupEventListeners() {
    // 回车搜索
    document.getElementById('searchInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            search();
        }
    });

    // 点击外部关闭设置面板和历史记录面板
    document.addEventListener('click', function (e) {
        // 关闭设置面板
        const settingsPanel = document.querySelector('#settingsPanel.show');
        const settingsButton = document.querySelector('#settingsPanel .wdtv-close-btn');

        if (settingsPanel && settingsButton &&
            !settingsPanel.contains(e.target) &&
            !settingsButton.contains(e.target)) {
            settingsPanel.classList.remove('show');
        }

        // 关闭历史记录面板
        const historyPanel = document.querySelector('#historyPanel.show');
        const historyButton = document.querySelector('#historyPanel .wdtv-close-btn');

        if (historyPanel && historyButton &&
            !historyPanel.contains(e.target) &&
            !historyButton.contains(e.target)) {
            historyPanel.classList.remove('show');
        }
    });

    // 广告过滤开关事件绑定
    const adFilterToggle = document.getElementById('adFilterToggle');
    if (adFilterToggle) {
        adFilterToggle.addEventListener('change', function (e) {
            localStorage.setItem(PLAYER_CONFIG.adFilteringStorage, e.target.checked);
        });
    }

    // 动态效果开关事件绑定
    const dynamicEffectsToggle = document.getElementById('dynamicEffectsToggle');
    if (dynamicEffectsToggle) {
        dynamicEffectsToggle.addEventListener('change', function (e) {
            localStorage.setItem('dynamicEffectsEnabled', e.target.checked);
            applyDynamicEffects(e.target.checked);
        });
    }
}

// 应用动态效果开关状态：关闭时停用一切动画与视觉特效以降低性能开销
function applyDynamicEffects(enabled) {
    document.documentElement.classList.toggle('fx-off', !enabled);
    if (enabled) {
        // 重新启动首页动画循环（雨滴 / 玻璃水面）
        if (typeof window.__fxRain === 'function') window.__fxRain();
        if (typeof window.__fxGlass === 'function') window.__fxGlass();
    }
}

// 重置搜索区域
function resetSearchArea() {
    // 清理搜索结果
    document.getElementById('results').innerHTML = '';
    document.getElementById('searchInput').value = '';

    // 重置同名筛选状态
    lastSearchResults = [];
    currentNameFilter = '';
    const nameFilterBar = document.getElementById('nameFilterBar');
    if (nameFilterBar) {
        nameFilterBar.classList.add('hidden');
    }
    closeNameDropdown();
    const nameDropdownMenu = document.getElementById('nameDropdownMenu');
    if (nameDropdownMenu) {
        nameDropdownMenu.innerHTML = '';
    }
    const nameDropdownLabel = document.getElementById('nameDropdownLabel');
    if (nameDropdownLabel) {
        nameDropdownLabel.textContent = '全部';
    }

    // 恢复搜索区域的样式
    document.getElementById('searchArea').classList.add('flex-1');
    document.getElementById('searchArea').classList.remove('mb-8');
    document.getElementById('resultsArea').classList.add('hidden');

    // 确保页脚正确显示，移除相对定位
    const footer = document.querySelector('.footer');
    if (footer) {
        footer.style.position = '';
    }

    // 如果有豆瓣功能，检查是否需要显示豆瓣推荐区域
    if (typeof updateDoubanVisibility === 'function') {
        updateDoubanVisibility();
    }

    // 重置URL为主页
    try {
        window.history.pushState(
            {},
            `WDTV - 免费在线视频搜索与观看平台`,
            `/`
        );
        // 更新页面标题
        document.title = `WDTV - 免费在线视频搜索与观看平台`;
    } catch (e) {
        console.error('更新浏览器历史失败:', e);
    }
}

// 搜索功能 - 修改为支持多选API和多页结果
// 搜索缓存配置：相同关键词+相同源集合，5 分钟内直接复用结果（避免刷新/返回时重发全部请求）
const SEARCH_CACHE_PREFIX = 'wdtvSearchCache_';
const SEARCH_CACHE_TTL = 5 * 60 * 1000;

function getSearchCacheKey(query) {
    return SEARCH_CACHE_PREFIX + encodeURIComponent(query) + '|' + selectedAPIs.slice().sort().join(',');
}

// hover 预取详情：鼠标悬停结果卡片时提前获取详情，点击时秒开
const DETAIL_PREFETCH_MAX = 24;
const detailPrefetchCache = new Map();
let detailPrefetchActive = 0;

async function prefetchDetail(id, sourceCode) {
    if (!id || !sourceCode || typeof window.fetchVideoDetailData !== 'function') return;
    const key = `${sourceCode}_${id}`;
    if (detailPrefetchCache.has(key) || detailPrefetchActive >= 2) return;
    detailPrefetchCache.set(key, null); // 占位防止重复请求
    detailPrefetchActive++;
    try {
        const data = await window.fetchVideoDetailData({ id, source: sourceCode });
        if (data && data.code === 200 && Array.isArray(data.episodes) && data.episodes.length > 0) {
            if (detailPrefetchCache.size >= DETAIL_PREFETCH_MAX) {
                detailPrefetchCache.delete(detailPrefetchCache.keys().next().value);
            }
            detailPrefetchCache.set(key, data);
        } else {
            detailPrefetchCache.delete(key); // 预取失败则允许下次重试
        }
    } catch (e) {
        detailPrefetchCache.delete(key);
    } finally {
        detailPrefetchActive--;
    }
}

// 读取预取的详情（命中返回数据，未命中返回 null）
function getPrefetchedDetail(id, sourceCode) {
    return detailPrefetchCache.get(`${sourceCode}_${id}`) || null;
}

// 搜索序号：连续搜索时丢弃旧搜索的迟到的渲染/结果，防止遮罩与内容错位
let searchSeq = 0;

async function search() {
    const query = document.getElementById('searchInput').value.trim();

    if (!query) {
        showToast('请输入搜索内容', 'info');
        return;
    }

    if (selectedAPIs.length === 0) {
        showToast('请至少选择一个API源', 'warning');
        return;
    }

    const seq = ++searchSeq;

    showLoading();

    try {
        // 保存搜索历史
        saveSearchHistory(query);

        // 显示结果区域，调整搜索区域（缓存/渐进两条路径共用）
        document.getElementById('searchArea').classList.remove('flex-1');
        document.getElementById('searchArea').classList.add('mb-8');
        document.getElementById('resultsArea').classList.remove('hidden');
        const doubanArea = document.getElementById('doubanArea');
        if (doubanArea) {
            doubanArea.classList.add('hidden');
        }

        const cacheKey = getSearchCacheKey(query);

        // 1) 缓存命中：直接渲染，不重发请求
        try {
            const raw = sessionStorage.getItem(cacheKey);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && Array.isArray(parsed.results) && Date.now() - parsed.ts < SEARCH_CACHE_TTL && parsed.results.length > 0) {
                    lastSearchResults = parsed.results;
                    currentNameFilter = '';
                    populateNameFilter(lastSearchResults);
                    renderFilteredSearchResults();
                    try {
                        window.history.pushState({ search: query }, `搜索: ${query} - WDTV`, `/s=${encodeURIComponent(query)}`);
                        document.title = `搜索: ${query} - WDTV`;
                    } catch (e) { console.error('更新浏览器历史失败:', e); }
                    showToast('已使用 5 分钟内的搜索缓存', 'info');
                    return;
                }
            }
        } catch (e) { /* 缓存读取失败，继续正常搜索 */ }

        // 2) 渐进渲染：每个源返回即追加显示，不等最慢的源
        lastSearchResults = [];
        currentNameFilter = '';
        const resultsDiv = document.getElementById('results');
        resultsDiv.innerHTML = `<div class="col-span-full" style="text-align:center;padding:40px 0;color:var(--text-muted);font-size:0.9rem;">正在搜索各资源站…</div>`;
        const searchResultsCount = document.getElementById('searchResultsCount');
        if (searchResultsCount) searchResultsCount.textContent = 0;

        const total = selectedAPIs.length;
        let settled = 0;
        let renderTimer = null;
        let urlUpdated = false;

        const updateUrlOnce = () => {
            if (urlUpdated) return;
            urlUpdated = true;
            try {
                window.history.pushState(
                    { search: query },
                    `搜索: ${query} - WDTV`,
                    `/s=${encodeURIComponent(query)}`
                );
                document.title = `搜索: ${query} - WDTV`;
            } catch (e) {
                console.error('更新浏览器历史失败:', e);
            }
        };

        // 节流渲染：250ms 合并一次 DOM 重建，避免每个源到达都触发重排
        const renderProgressive = () => {
            renderTimer = null;
            if (seq !== searchSeq) return; // 已被更新的搜索取代，丢弃本次渲染
            const div = document.getElementById('results');
            if (!div) return;
            const filtered = lastSearchResults.filter(item => !isBlockedByTypeFilter(item));
            const progressHtml = settled < total
                ? `<div class="col-span-full" style="text-align:center;padding:16px 0;color:var(--text-muted);font-size:0.85rem;">已搜索 ${settled}/${total} 个源，正在加载其余结果…</div>`
                : '';
            div.innerHTML = filtered.map(buildResultCard).join('') + progressHtml;
            const count = document.getElementById('searchResultsCount');
            if (count) count.textContent = filtered.length;

            // 首批结果已经渲染出来，立即关闭遮罩，避免遮罩盖住已可见的内容
            if (filtered.length > 0) hideLoading();
        };
        const scheduleProgressiveRender = () => {
            if (renderTimer) return;
            renderTimer = setTimeout(renderProgressive, 250);
        };

        // 从所有选中的API源搜索；10 分钟内失败过的源延后 2 秒发起，让稳定源先出结果
        const searchPromises = selectedAPIs.map(apiId => {
            const kick = (typeof isSourceUnhealthy === 'function' && isSourceUnhealthy(apiId))
                ? new Promise(resolve => setTimeout(resolve, 2000))
                : Promise.resolve();
            return kick
                .then(() => searchByAPIAndKeyWord(apiId, query))
                .then(results => {
                    if (seq !== searchSeq) return []; // 已被更新的搜索取代
                    settled++;
                    if (Array.isArray(results) && results.length > 0) {
                        lastSearchResults = lastSearchResults.concat(results);
                        updateUrlOnce();
                    }
                    scheduleProgressiveRender();
                    return results;
                })
                .catch(error => {
                    if (seq !== searchSeq) return []; // 已被更新的搜索取代
                    settled++;
                    console.warn(`API ${apiId} 搜索失败:`, error);
                    scheduleProgressiveRender();
                    return [];
                });
        });

        const resultsArray = await Promise.all(searchPromises);

        // 已被更新的搜索取代：丢弃旧结果，不渲染不写缓存
        if (seq !== searchSeq) return;

        // 3) 全部完成：合并、排序、最终渲染
        let allResults = [];
        resultsArray.forEach(results => {
            if (Array.isArray(results) && results.length > 0) {
                allResults = allResults.concat(results);
            }
        });

        if (renderTimer) {
            clearTimeout(renderTimer);
            renderTimer = null;
        }

        // 对搜索结果进行排序：按名称优先，名称相同时按接口源排序
        allResults.sort((a, b) => {
            // 首先按照视频名称排序
            const nameCompare = (a.vod_name || '').localeCompare(b.vod_name || '');
            if (nameCompare !== 0) return nameCompare;

            // 如果名称相同，则按照来源排序
            return (a.source_name || '').localeCompare(b.source_name || '');
        });

        // 如果没有结果
        if (!allResults || allResults.length === 0) {
            resultsDiv.innerHTML = `
                <div class="col-span-full">
                    <div class="empty-state-glass">
                        <svg class="mx-auto h-12 w-12" style="color: var(--text-muted);" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                  d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <h3 class="mt-2 text-lg font-medium" style="color: var(--text-color);">没有找到匹配的结果</h3>
                        <p class="mt-1 text-sm" style="color: var(--text-muted);">请尝试其他关键词或更换数据源</p>
                    </div>
                </div>
            `;
            return;
        }

        updateUrlOnce();

        // 保存本次搜索结果，用于同名筛选，并写入会话缓存
        lastSearchResults = allResults;
        currentNameFilter = '';
        populateNameFilter(allResults);
        renderFilteredSearchResults();

        try {
            sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), results: allResults }));
        } catch (e) { /* 缓存写入失败不影响结果展示 */ }
    } catch (error) {
        if (seq !== searchSeq) return; // 已被更新的搜索取代，静默丢弃
        console.error('搜索错误:', error);
        if (error.name === 'AbortError') {
            showToast('搜索请求超时，请检查网络连接', 'error');
        } else {
            showToast('搜索请求失败，请稍后重试', 'error');
        }
    } finally {
        // 只有最新一次搜索才能关闭遮罩，避免旧搜索的收尾关掉新搜索的遮罩
        if (seq === searchSeq) hideLoading();
    }
}

// 同名影视筛选：保存最近一次搜索结果与当前筛选的名称
let lastSearchResults = [];
let currentNameFilter = '';

// 转义结果卡片中使用的HTML特殊字符
function escapeResultText(text) {
    return (text || '').toString()
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// 从备注/标题中提取画质标签（按清晰度从高到低优先匹配）
function extractQualityTag(texts) {
    const text = texts.filter(Boolean).join(' ');
    const rules = [
        [/4K|2160[Pp]/, '4K'],
        [/1080[PpIi]?|1080/, '1080P'],
        [/蓝光|Blu-?Ray|\bBD\b/, '蓝光'],
        [/超清/, '超清'],
        [/高清/, '高清'],
        [/\bHD\b/, 'HD'],
        [/720[Pp]/, '720P'],
        [/标清/, '标清'],
        [/\bT[SC]\b|抢先|枪版/, '抢先'],
    ];
    for (const [re, tag] of rules) {
        if (re.test(text)) return tag;
    }
    return '';
}

// 构建单个搜索结果卡片
function buildResultCard(item) {
    const safeId = item.vod_id ? item.vod_id.toString().replace(/[^\w-]/g, '') : '';
    const safeName = escapeResultText(item.vod_name);
    const sourceCode = item.source_code || '';

    // 修改为与首页豆瓣卡片一致的垂直布局
    const hasCover = item.vod_pic && item.vod_pic.startsWith('http');
    const coverUrl = hasCover ? item.vod_pic : 'https://via.placeholder.com/300x450?text=无封面';
    const safeTypeName = escapeResultText(item.type_name);
    const safeSourceName = escapeResultText(item.source_name);
    // 源方备注（常含清晰度标注，如 "HD国语"、"1080P"、"蓝光" 等）
    const safeRemarks = escapeResultText(item.vod_remarks);
    // 画质标签：从备注/标题中提取（如 4K、1080P、蓝光、HD）
    const qualityTag = extractQualityTag([item.vod_remarks, item.vod_name]);

    return `
        <div class="douban-card flex flex-col cursor-pointer"
             onclick="showDetails('${safeId}','${safeName}','${sourceCode}')"
             onmouseenter="prefetchDetail('${safeId}','${sourceCode}')">
            <div class="douban-card-image">
                <img src="${coverUrl}" alt="${safeName}"
                     onerror="this.onerror=null; this.src='https://via.placeholder.com/300x450?text=无封面'; this.classList.add('object-contain');"
                     loading="lazy" referrerpolicy="no-referrer">
                <div class="absolute inset-0" style="background: linear-gradient(to top, rgba(0,0,0,0.6), transparent 50%); pointer-events: none;"></div>
                ${qualityTag ? `<div class="wdtv-quality-badge">${qualityTag}</div>` : ''}
                <div class="absolute bottom-2 left-2 right-2 flex items-center justify-between gap-1.5">
                    ${safeSourceName ? `
                    <div class="douban-rate-badge truncate min-w-0" title="${safeSourceName}">
                        ${safeSourceName}
                    </div>
                    ` : ''}
                    ${safeTypeName ? `
                    <div class="douban-rate-badge truncate shrink-0" style="padding: 0.25rem 0.5rem;">
                        ${safeTypeName}
                    </div>
                    ` : ''}
                </div>
            </div>
            <div class="douban-card-title-area">
                <button onclick="event.stopPropagation(); showDetails('${safeId}','${safeName}','${sourceCode}')"
                        class="text-sm font-medium truncate w-full transition"
                        style="color: #1d1d1f; background: transparent; border: none; cursor: pointer; padding: 0;"
                        title="${safeName}">
                    ${safeName}
                </button>
                ${safeRemarks ? `
                <div class="wdtv-remarks-badge" title="${safeRemarks}">
                    ${safeRemarks}
                </div>
                ` : ''}
            </div>
        </div>
    `;
}

// 屏蔽过滤规则：localStorage键名 -> 匹配影视类型的关键词
const BLOCK_FILTER_RULES = {
    blockAIManhuaEnabled: ['AI漫剧', '漫剧'],
    blockShortDramaEnabled: ['短剧']
};

// 判断某条结果是否命中启用的屏蔽规则
function isBlockedByTypeFilter(item) {
    const typeName = (item.type_name || '').toString();
    if (!typeName) return false;
    return Object.entries(BLOCK_FILTER_RULES).some(([key, keywords]) => {
        if (localStorage.getItem(key) !== 'true') return false;
        return keywords.some(kw => typeName.includes(kw));
    });
}

// 根据当前名称筛选与屏蔽规则渲染搜索结果
function renderFilteredSearchResults() {
    const resultsDiv = document.getElementById('results');
    if (!resultsDiv) return;

    const filtered = lastSearchResults.filter(item => {
        if (currentNameFilter && (item.vod_name || '').trim() !== currentNameFilter) return false;
        if (isBlockedByTypeFilter(item)) return false;
        return true;
    });

    if (filtered.length === 0 && lastSearchResults.length > 0) {
        resultsDiv.innerHTML = `
            <div class="col-span-full" style="text-align:center;padding:40px 0;color:var(--text-muted);font-size:0.9rem;">
                当前筛选条件下没有可显示的结果
            </div>
        `;
    } else {
        resultsDiv.innerHTML = filtered.map(buildResultCard).join('');
    }

    // 更新计数显示
    const searchResultsCount = document.getElementById('searchResultsCount');
    if (searchResultsCount) {
        searchResultsCount.textContent = filtered.length;
    }
}

// 切换屏蔽按钮状态（localStorage持久化），并立即重新渲染列表
function toggleBlockFilter(key) {
    const enabled = localStorage.getItem(key) === 'true';
    localStorage.setItem(key, enabled ? 'false' : 'true');
    updateBlockFilterButtons();
    renderFilteredSearchResults();
}

// 同步屏蔽按钮的高亮状态
function updateBlockFilterButtons() {
    Object.keys(BLOCK_FILTER_RULES).forEach(key => {
        const btn = document.getElementById(key === 'blockAIManhuaEnabled' ? 'blockAIManhuaBtn' : 'blockShortDramaBtn');
        if (btn) {
            btn.classList.toggle('active', localStorage.getItem(key) === 'true');
        }
    });
}

document.addEventListener('DOMContentLoaded', updateBlockFilterButtons);

// 应用同名筛选并重新渲染列表
function applyNameFilter(name, label) {
    currentNameFilter = name || '';
    renderFilteredSearchResults();

    // 更新下拉框按钮显示文本
    const labelEl = document.getElementById('nameDropdownLabel');
    if (labelEl) {
        labelEl.textContent = label || (currentNameFilter || '全部');
    }

    // 更新菜单选中态
    const menu = document.getElementById('nameDropdownMenu');
    if (menu) {
        menu.querySelectorAll('.wdtv-name-dropdown-item').forEach(el => {
            el.classList.toggle('active', (el.dataset.name || '') === currentNameFilter);
        });
    }

    closeNameDropdown();
}

// 展开/收起同名筛选下拉菜单
function toggleNameDropdown(event) {
    event.stopPropagation();
    const menu = document.getElementById('nameDropdownMenu');
    const dropdown = document.getElementById('nameDropdown');
    if (!menu || !dropdown) return;
    menu.classList.toggle('hidden');
    dropdown.classList.toggle('open', !menu.classList.contains('hidden'));
}

// 关闭同名筛选下拉菜单
function closeNameDropdown() {
    const menu = document.getElementById('nameDropdownMenu');
    const dropdown = document.getElementById('nameDropdown');
    if (menu) menu.classList.add('hidden');
    if (dropdown) dropdown.classList.remove('open');
}

// 点击页面其他区域时收起菜单；点击菜单项时应用筛选（事件委托，避免片名特殊字符破坏内联事件）
document.addEventListener('click', (e) => {
    const item = e.target.closest('.wdtv-name-dropdown-item');
    if (item) {
        applyNameFilter(item.dataset.name || '', item.dataset.label || '');
        return;
    }
    const dropdown = document.getElementById('nameDropdown');
    if (dropdown && !dropdown.contains(e.target)) {
        closeNameDropdown();
    }
});

// 填充同名筛选下拉菜单（仅列出存在多个同名结果的名称）
function populateNameFilter(results) {
    const bar = document.getElementById('nameFilterBar');
    const menu = document.getElementById('nameDropdownMenu');
    const labelEl = document.getElementById('nameDropdownLabel');
    if (!bar || !menu) return;

    // 统计同名出现次数
    const nameCount = new Map();
    results.forEach(item => {
        const name = (item.vod_name || '').trim();
        if (!name) return;
        nameCount.set(name, (nameCount.get(name) || 0) + 1);
    });

    // 仅保留同名（出现≥2次）的名称，按数量降序排列
    const dupNames = [...nameCount.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    if (dupNames.length === 0) {
        bar.classList.add('hidden');
        menu.innerHTML = '';
        closeNameDropdown();
        return;
    }

    bar.classList.remove('hidden');
    if (labelEl) labelEl.textContent = '全部';

    const items = [
        { name: '', label: '全部', count: results.length },
        ...dupNames.map(([name, count]) => ({ name, label: name, count }))
    ];
    menu.innerHTML = items.map(({ name, label, count }) => {
        const safeName = escapeResultText(name);
        const safeLabel = escapeResultText(label);
        return `<div class="wdtv-name-dropdown-item" data-name="${safeName}" data-label="${safeLabel}">
                    <span style="overflow:hidden;text-overflow:ellipsis;">${safeLabel}</span>
                    <span class="wdtv-name-dropdown-count">${count}</span>
                </div>`;
    }).join('');
    closeNameDropdown();
}

// 切换清空按钮的显示状态
function toggleClearButton() {
    const searchInput = document.getElementById('searchInput');
    const clearButton = document.getElementById('clearSearchInput');
    if (searchInput.value !== '') {
        clearButton.classList.remove('hidden');
    } else {
        clearButton.classList.add('hidden');
    }
}

// 清空搜索框内容
function clearSearchInput() {
    const searchInput = document.getElementById('searchInput');
    searchInput.value = '';
    const clearButton = document.getElementById('clearSearchInput');
    clearButton.classList.add('hidden');
}

// 劫持搜索框的value属性以检测外部修改
function hookInput() {
    const input = document.getElementById('searchInput');
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

    // 重写 value 属性的 getter 和 setter
    Object.defineProperty(input, 'value', {
        get: function () {
            // 确保读取时返回字符串（即使原始值为 undefined/null）
            const originalValue = descriptor.get.call(this);
            return originalValue != null ? String(originalValue) : '';
        },
        set: function (value) {
            // 显式将值转换为字符串后写入
            const strValue = String(value);
            descriptor.set.call(this, strValue);
            this.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });

    // 初始化输入框值为空字符串（避免初始值为 undefined）
    input.value = '';
}
document.addEventListener('DOMContentLoaded', hookInput);

// 显示详情 - 修改为支持自定义API
async function showDetails(id, vod_name, sourceCode) {
    if (!id) {
        showToast('视频ID无效', 'error');
        return;
    }

    showLoading();
    try {
        // 构建详情请求参数
        const detailOpts = { id, source: sourceCode };

        // 优先使用 hover 预取的详情，未命中再发请求
        let data = getPrefetchedDetail(id, sourceCode);
        if (!data) {
            data = await fetchVideoDetailData(detailOpts);
        }

        const modal = document.getElementById('modal');
        const modalTitle = document.getElementById('modalTitle');
        const modalContent = document.getElementById('modalContent');

        // 显示来源信息
        const sourceName = data.videoInfo && data.videoInfo.source_name ?
            ` <span class="wdtv-modal-source-name">(${data.videoInfo.source_name})</span>` : '';

        // 不对标题进行截断处理，允许完整显示
        modalTitle.innerHTML = `<span class="break-words">${vod_name || '未知视频'}</span>${sourceName}`;
        currentVideoTitle = vod_name || '未知视频';

        if (data.episodes && data.episodes.length > 0) {
            // 构建详情信息 HTML（左封面 + 右信息，无内部滚动）
            let detailInfoHtml = '';
            if (data.videoInfo) {
                // Prepare description text, strip HTML and trim whitespace
                const descriptionText = data.videoInfo.desc ? data.videoInfo.desc.replace(/<[^>]+>/g, '').trim() : '';
                const vi = data.videoInfo;

                const coverHtml = vi.cover ? `
                    <div class="wdtv-detail-cover">
                        <img src="${vi.cover}" alt="" loading="lazy" onerror="this.parentNode.style.display='none'">
                    </div>` : '';

                const metaChips = [vi.type, vi.year, vi.area, vi.remarks].filter(Boolean)
                    .map(v => `<span class="wdtv-detail-chip">${v}</span>`).join('');

                const peopleHtml = (vi.director || vi.actor) ? `
                    <div class="wdtv-detail-people">
                        ${vi.director ? `<div><span class="detail-label">导演:</span><span>${vi.director}</span></div>` : ''}
                        ${vi.actor ? `<div><span class="detail-label">主演:</span><span>${vi.actor}</span></div>` : ''}
                    </div>` : '';

                const descHtml = descriptionText ? `<p class="wdtv-detail-desc">${descriptionText}</p>` : '';

                if (vi.cover || metaChips || peopleHtml || descHtml) {
                    detailInfoHtml = `
                    <div class="wdtv-detail-hero">
                        ${coverHtml}
                        <div class="wdtv-detail-main">
                            ${metaChips ? `<div class="wdtv-detail-meta">${metaChips}</div>` : ''}
                            ${peopleHtml}
                            ${descHtml}
                        </div>
                    </div>
                    `;
                }
            }

            currentEpisodes = data.episodes;
            currentEpisodeIndex = 0;

            modalContent.innerHTML = `
                ${detailInfoHtml}
                <div class="wdtv-episodes-bar">
                    <div class="wdtv-episodes-bar-left">
                        <button onclick="toggleEpisodeOrder('${sourceCode}', '${id}')"
                                class="wdtv-modal-mini-btn">
                            <svg class="w-4 h-4 transform ${episodesReversed ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path>
                            </svg>
                            <span>${episodesReversed ? '正序排列' : '倒序排列'}</span>
                        </button>
                        <span class="episode-stats">共 ${data.episodes.length} 集</span>
                    </div>
                    <button onclick="copyLinks()" class="wdtv-modal-primary-btn">
                        复制链接
                    </button>
                </div>
                <div id="episodesGrid">
                    ${renderEpisodes(vod_name, sourceCode, id)}
                </div>
            `;
        } else {
            modalContent.innerHTML = `
                <div class="text-center py-8">
                    <div class="mb-2" style="color:#e57373;">❌ 未找到播放资源</div>
                    <div class="text-sm" style="color:rgba(180,200,230,0.65);">该视频可能暂时无法播放，请尝试其他视频</div>
                </div>
            `;
        }

        modal.classList.remove('hidden');
    } catch (error) {
        console.error('获取详情错误:', error);
        showToast('获取详情失败，请稍后重试', 'error');
    } finally {
        hideLoading();
    }
}

// 更新播放视频函数，直接跳转到player.html
function playVideo(url, vod_name, sourceCode, episodeIndex = 0, vodId = '') {
    // 获取当前路径作为返回页面
    let currentPath = window.location.href;

    // 确定返回URL的优先级：1. 当前页面(index/首页) 2. referrer 3. 默认首页
    let returnUrl = '';
    if (currentPath.includes('index.html') || currentPath.endsWith('/')) {
        returnUrl = currentPath;
    } else {
        const referrer = document.referrer;
        if (referrer && referrer.trim() !== '') {
            returnUrl = referrer;
        } else {
            returnUrl = '/';
        }
    }

    // 构建播放页面URL，直接跳转到player.html
    let playerUrl = `player.html?id=${vodId || ''}&source=${sourceCode || ''}&url=${encodeURIComponent(url)}&index=${episodeIndex}&title=${encodeURIComponent(vod_name || '')}&returnUrl=${encodeURIComponent(returnUrl)}`;

    // 保存当前状态到localStorage
    try {
        localStorage.setItem('currentVideoTitle', vod_name || '未知视频');
        localStorage.setItem('currentEpisodes', JSON.stringify(currentEpisodes));
        localStorage.setItem('currentEpisodeIndex', episodeIndex);
        localStorage.setItem('currentSourceCode', sourceCode || '');
        localStorage.setItem('lastPlayTime', Date.now());
        localStorage.setItem('lastSearchPage', currentPath);
        localStorage.setItem('lastPageUrl', returnUrl);  // 确保保存返回页面URL
    } catch (e) {
        console.error('保存播放状态失败:', e);
    }

    // 在当前标签页中打开播放页面
    window.location.href = playerUrl;
}

// 弹出播放器页面
function showVideoPlayer(url) {
    // 在打开播放器前，隐藏详情弹窗
    const detailModal = document.getElementById('modal');
    if (detailModal) {
        detailModal.classList.add('hidden');
    }
    // 临时隐藏搜索结果和豆瓣区域，防止高度超出播放器而出现滚动条
    document.getElementById('resultsArea').classList.add('hidden');
    document.getElementById('doubanArea').classList.add('hidden');
    // 在框架中打开播放页面
    videoPlayerFrame = document.createElement('iframe');
    videoPlayerFrame.id = 'VideoPlayerFrame';
    videoPlayerFrame.className = 'fixed w-full h-screen z-40';
    videoPlayerFrame.src = url;
    document.body.appendChild(videoPlayerFrame);
    // 将焦点移入iframe
    videoPlayerFrame.focus();
}

// 关闭播放器页面
function closeVideoPlayer(home = false) {
    videoPlayerFrame = document.getElementById('VideoPlayerFrame');
    if (videoPlayerFrame) {
        videoPlayerFrame.remove();
        // 恢复搜索结果显示
        document.getElementById('resultsArea').classList.remove('hidden');
        // 关闭播放器时也隐藏详情弹窗
        const detailModal = document.getElementById('modal');
        if (detailModal) {
            detailModal.classList.add('hidden');
        }
        // 如果启用豆瓣区域则显示豆瓣区域
        if (localStorage.getItem('doubanEnabled') === 'true') {
            document.getElementById('doubanArea').classList.remove('hidden');
        }
    }
    if (home) {
        // 刷新主页
        window.location.href = '/'
    }
}

// 播放上一集
function playPreviousEpisode(sourceCode) {
    if (currentEpisodeIndex > 0) {
        const prevIndex = currentEpisodeIndex - 1;
        const prevUrl = currentEpisodes[prevIndex];
        playVideo(prevUrl, currentVideoTitle, sourceCode, prevIndex);
    }
}

// 播放下一集
function playNextEpisode(sourceCode) {
    if (currentEpisodeIndex < currentEpisodes.length - 1) {
        const nextIndex = currentEpisodeIndex + 1;
        const nextUrl = currentEpisodes[nextIndex];
        playVideo(nextUrl, currentVideoTitle, sourceCode, nextIndex);
    }
}

// 处理播放器加载错误
function handlePlayerError() {
    hideLoading();
    showToast('视频播放加载失败，请尝试其他视频源', 'error');
}

// 辅助函数用于渲染剧集按钮（使用当前的排序状态）
function renderEpisodes(vodName, sourceCode, vodId) {
    const episodes = episodesReversed ? [...currentEpisodes].reverse() : currentEpisodes;
    return episodes.map((episode, index) => {
        // 根据倒序状态计算真实的剧集索引
        const realIndex = episodesReversed ? currentEpisodes.length - 1 - index : index;
        return `
            <button id="episode-${realIndex}" onclick="playVideo('${episode}','${vodName.replace(/"/g, '&quot;')}', '${sourceCode}', ${realIndex}, '${vodId}')"
                    class="wdtv-episode-btn">
                ${realIndex + 1}
            </button>
        `;
    }).join('');
}

// 复制视频链接到剪贴板
function copyLinks() {
    const episodes = episodesReversed ? [...currentEpisodes].reverse() : currentEpisodes;
    const linkList = episodes.join('\r\n');
    navigator.clipboard.writeText(linkList).then(() => {
        showToast('播放链接已复制', 'success');
    }).catch(err => {
        showToast('复制失败，请检查浏览器权限', 'error');
    });
}

// 切换排序状态的函数
function toggleEpisodeOrder(sourceCode, vodId) {
    episodesReversed = !episodesReversed;
    // 重新渲染剧集区域，使用 currentVideoTitle 作为视频标题
    const episodesGrid = document.getElementById('episodesGrid');
    if (episodesGrid) {
        episodesGrid.innerHTML = renderEpisodes(currentVideoTitle, sourceCode, vodId);
    }

    // 更新按钮文本和箭头方向
    const toggleBtn = document.querySelector(`button[onclick="toggleEpisodeOrder('${sourceCode}', '${vodId}')"]`);
    if (toggleBtn) {
        toggleBtn.querySelector('span').textContent = episodesReversed ? '正序排列' : '倒序排列';
        const arrowIcon = toggleBtn.querySelector('svg');
        if (arrowIcon) {
            arrowIcon.style.transform = episodesReversed ? 'rotate(180deg)' : 'rotate(0deg)';
        }
    }
}

// 从URL导入配置
async function importConfigFromUrl() {
    // 创建模态框元素
    let modal = document.getElementById('importUrlModal');
    if (modal) {
        document.body.removeChild(modal);
    }

    modal = document.createElement('div');
    modal.id = 'importUrlModal';
    modal.className = 'fixed inset-0 flex items-center justify-center z-40';
    modal.style.background = 'rgba(255, 255, 255, 0.5)';
    modal.style.backdropFilter = 'blur(20px) saturate(180%)';
    modal.style.webkitBackdropFilter = 'blur(20px) saturate(180%)';

    modal.innerHTML = `
        <div class="max-w-md w-full max-h-[90vh] overflow-y-auto relative" style="background: rgba(255,255,255,0.85); backdrop-filter: blur(50px) saturate(200%); -webkit-backdrop-filter: blur(50px) saturate(200%); border: 1px solid rgba(255,255,255,0.9); border-radius: 24px; padding: 1.5rem; box-shadow: 0 24px 80px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.95); color: #1d1d1f;">
            <button id="closeUrlModal" style="position: absolute; top: 1rem; right: 1rem; width: 2rem; height: 2rem; border-radius: 9999px; background: rgba(255,255,255,0.7); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.85); color: #6e6e73; font-size: 1.25rem; box-shadow: 0 2px 8px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.95);">&times;</button>

            <h3 style="font-size: 1.25rem; font-weight: 700; color: #1d1d1f; margin-bottom: 1rem;">从URL导入配置</h3>

            <div style="margin-bottom: 1rem;">
                <input type="text" id="configUrl" placeholder="输入配置文件URL"
                       style="width: 100%; padding: 0.5rem 1rem; background: rgba(255,255,255,0.6); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.8); border-radius: 9999px; color: #1d1d1f; outline: none;">
            </div>
            
            <div class="flex justify-end space-x-2">
                <button id="confirmUrlImport" class="ios-primary-button">导入</button>
                <button id="cancelUrlImport" class="ios-secondary-button">取消</button>
            </div>
        </div>`;

    document.body.appendChild(modal);

    // 关闭按钮事件
    document.getElementById('closeUrlModal').addEventListener('click', () => {
        document.body.removeChild(modal);
    });

    // 取消按钮事件
    document.getElementById('cancelUrlImport').addEventListener('click', () => {
        document.body.removeChild(modal);
    });

    // 确认导入按钮事件
    document.getElementById('confirmUrlImport').addEventListener('click', async () => {
        const url = document.getElementById('configUrl').value.trim();
        if (!url) {
            showToast('请输入配置文件URL', 'warning');
            return;
        }

        // 验证URL格式
        try {
            const urlObj = new URL(url);
            if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
                showToast('URL必须以http://或https://开头', 'warning');
                return;
            }
        } catch (e) {
            showToast('URL格式不正确', 'warning');
            return;
        }

        showLoading('正在从URL导入配置...');

        try {
            // 获取配置文件 - 直接请求URL
            const response = await fetch(url, {
                mode: 'cors',
                headers: {
                    'Accept': 'application/json'
                }
            });
            if (!response.ok) throw '获取配置文件失败';

            // 验证响应内容类型
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                throw '响应不是有效的JSON格式';
            }

            const config = await response.json();
            if (config.name !== 'WDTV-Settings') throw '配置文件格式不正确';

            // 验证哈希
            const dataHash = await sha256(JSON.stringify(config.data));
            if (dataHash !== config.hash) throw '配置文件哈希值不匹配';

            // 导入配置
            for (let item in config.data) {
                localStorage.setItem(item, config.data[item]);
            }

            showToast('配置文件导入成功，3 秒后自动刷新本页面。', 'success');
            setTimeout(() => {
                window.location.reload();
            }, 3000);
        } catch (error) {
            const message = typeof error === 'string' ? error : '导入配置失败';
            showToast(`从URL导入配置出错 (${message})`, 'error');
        } finally {
            hideLoading();
            document.body.removeChild(modal);
        }
    });

    // 点击模态框外部关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    });
}

// 配置文件导入功能
async function importConfig() {
    showImportBox(async (file) => {
        try {
            // 检查文件类型
            if (!(file.type === 'application/json' || file.name.endsWith('.json'))) throw '文件类型不正确';

            // 检查文件大小
            if (file.size > 1024 * 1024 * 10) throw new Error('文件大小超过 10MB');

            // 读取文件内容
            const content = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject('文件读取失败');
                reader.readAsText(file);
            });

            // 解析并验证配置
            const config = JSON.parse(content);
            if (config.name !== 'WDTV-Settings') throw '配置文件格式不正确';

            // 验证哈希
            const dataHash = await sha256(JSON.stringify(config.data));
            if (dataHash !== config.hash) throw '配置文件哈希值不匹配';

            // 导入配置
            for (let item in config.data) {
                localStorage.setItem(item, config.data[item]);
            }

            showToast('配置文件导入成功，3 秒后自动刷新本页面。', 'success');
            setTimeout(() => {
                window.location.reload();
            }, 3000);
        } catch (error) {
            const message = typeof error === 'string' ? error : '配置文件格式错误';
            showToast(`配置文件读取出错 (${message})`, 'error');
        }
    });
}

// 配置文件导出功能
async function exportConfig() {
    // 存储配置数据
    const config = {};
    const items = {};

    const settingsToExport = [
        'selectedAPIs',
        'adFilteringEnabled',
        'doubanEnabled',
        'hasInitializedDefaults'
    ];

    // 导出设置项
    settingsToExport.forEach(key => {
        const value = localStorage.getItem(key);
        if (value !== null) {
            items[key] = value;
        }
    });

    // 导出历史记录
    const viewingHistory = localStorage.getItem('viewingHistory');
    if (viewingHistory) {
        items['viewingHistory'] = viewingHistory;
    }

    const searchHistory = localStorage.getItem(SEARCH_HISTORY_KEY);
    if (searchHistory) {
        items[SEARCH_HISTORY_KEY] = searchHistory;
    }

    const times = Date.now().toString();
    config['name'] = 'WDTV-Settings';  // 配置文件名，用于校验
    config['time'] = times;               // 配置文件生成时间
    config['cfgVer'] = '1.0.0';           // 配置文件版本
    config['data'] = items;               // 配置文件数据
    config['hash'] = await sha256(JSON.stringify(config['data']));  // 计算数据的哈希值，用于校验

    // 将配置数据保存为 JSON 文件
    saveStringAsFile(JSON.stringify(config), 'WDTV-Settings_' + times + '.json');
}

// 将字符串保存为文件
function saveStringAsFile(content, fileName) {
    // 创建Blob对象并指定类型
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    // 生成临时URL
    const url = window.URL.createObjectURL(blob);
    // 创建<a>标签并触发下载
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    // 清理临时对象
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}

// 移除Node.js的require语句，因为这是在浏览器环境中运行的
