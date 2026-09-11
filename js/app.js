// 全局变量
let selectedAPIs = JSON.parse(localStorage.getItem('selectedAPIs') || 'null') || Object.keys(API_SITES); // 默认选中所有资源

// 添加当前播放的集数索引
let currentEpisodeIndex = 0;
// 添加当前视频的所有集数
let currentEpisodes = [];
// 当前视频的集名（源站「集名$URL」的集名，与 currentEpisodes 按 index 对齐；缺失时降级为「第N集」）
let currentEpisodeNames = [];
// 添加当前视频的标题
let currentVideoTitle = '';
// 全局变量用于倒序状态
let episodesReversed = false;
// 当前详情上下文（用于重渲染集数区域）
let currentDetailSource = '';
let currentDetailId = '';
// 当前详情的 videoInfo（封面/备注等元信息，供"我的影院"收藏按钮取用）
let currentDetailVideoInfo = null;
// 集数排序模式：'default' 默认排序（配合正序/倒序）；'variety' 综艺排序（按时长分两组）
let sortMode = 'default';
// 综艺排序下的集数数字显示方式：'group' 新集数（组内重编号，默认）；'original' 原集数；'both' 双显
let varietyNumberMode = 'group';
// 集数展示布局：'grid' 数字方块（默认）；'list' 详细列表（完整集名，每行一条）
let episodeViewMode = localStorage.getItem('episodeViewMode') === 'list' ? 'list' : 'grid';
// 综艺排序的时长分组线（分钟），屏幕上可自由调整
let varietyThresholdMinutes = 60;

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

    // 设置缓存按钮显示开关初始状态（默认关闭）
    const cacheBtnToggle = document.getElementById('cacheBtnToggle');
    if (cacheBtnToggle) {
        cacheBtnToggle.checked = localStorage.getItem(PLAYER_CONFIG.showCacheButtonStorage) === 'true';
    }

    // 设置自动缓存开关初始状态（默认开启：播放时后台自动缓存整集）
    const autoCacheToggle = document.getElementById('autoCacheToggle');
    if (autoCacheToggle) {
        autoCacheToggle.checked = localStorage.getItem(PLAYER_CONFIG.autoCacheStorage) !== 'false';
    }

    // 设置流量竞速兜底开关初始状态（默认关闭：开启后播放分片直连过慢时代理并行竞速）
    const raceHedgeToggle = document.getElementById('raceHedgeToggle');
    if (raceHedgeToggle) {
        raceHedgeToggle.checked = localStorage.getItem('wdtvRaceHedge') === 'true';
    }

    // 设置自动删除缓存开关初始状态（默认开启，超过3个自动删除最早）
    const cacheEvictToggle = document.getElementById('cacheEvictToggle');
    if (cacheEvictToggle) {
        cacheEvictToggle.checked = localStorage.getItem('cacheEvictMode') !== 'never';
    }

    // 设置弹幕功能开关初始状态（默认开启：与 danmu.js 读取约定一致，仅 'false' 视为关闭）
    const danmuToggle = document.getElementById('danmuToggle');
    if (danmuToggle) {
        danmuToggle.checked = localStorage.getItem('danmuEnabled') !== 'false';
    }

    // 设置弹幕 API 地址输入框初始值（空字符串 = 走默认端点）
    const danmuCustomApiInput = document.getElementById('danmuCustomApiInput');
    if (danmuCustomApiInput) {
        danmuCustomApiInput.value = localStorage.getItem('danmuCustomApi') || '';
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
    // 回车搜索（防抖：连续回车只执行最后一次）
    document.getElementById('searchInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            debouncedSearch();
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

    // 缓存按钮显示开关事件绑定
    const cacheBtnToggle = document.getElementById('cacheBtnToggle');
    if (cacheBtnToggle) {
        cacheBtnToggle.addEventListener('change', function (e) {
            localStorage.setItem(PLAYER_CONFIG.showCacheButtonStorage, e.target.checked);
        });
    }

    // 自动缓存开关事件绑定
    const autoCacheToggle = document.getElementById('autoCacheToggle');
    if (autoCacheToggle) {
        autoCacheToggle.addEventListener('change', function (e) {
            localStorage.setItem(PLAYER_CONFIG.autoCacheStorage, e.target.checked);
        });
    }

    // 流量竞速兜底开关事件绑定（键名与播放器 player.js 的 RACE_HEDGE_STORAGE 一致，实时生效）
    const raceHedgeToggle = document.getElementById('raceHedgeToggle');
    if (raceHedgeToggle) {
        raceHedgeToggle.addEventListener('change', function (e) {
            localStorage.setItem('wdtvRaceHedge', e.target.checked ? 'true' : 'false');
            showToast(e.target.checked ? '已开启流量竞速兜底：直连过慢时自动代理竞速' : '已关闭流量竞速兜底', 'success');
        });
    }

    // 自动删除缓存开关：开启 = 超过3个自动删除最早（lru），关闭 = 不自动删除（never）
    const cacheEvictToggle = document.getElementById('cacheEvictToggle');
    if (cacheEvictToggle) {
        cacheEvictToggle.addEventListener('change', function () {
            localStorage.setItem('cacheEvictMode', cacheEvictToggle.checked ? 'lru' : 'never');
        });
    }

    // 弹幕功能开关事件绑定（写入 'true'/'false'，与 danmu.js「!== 'false' 视为开启」的读取约定一致）
    const danmuToggle = document.getElementById('danmuToggle');
    if (danmuToggle) {
        danmuToggle.addEventListener('change', function (e) {
            localStorage.setItem('danmuEnabled', e.target.checked ? 'true' : 'false');
            showToast(e.target.checked ? '已开启弹幕功能' : '已关闭弹幕功能', 'success');
        });
    }

    // 弹幕 API 地址输入框：change/blur 时 trim 后写入（danmu.js getCustomApi 亦会自行 trim 与去尾斜杠），
    // 值有变化才保存；清空则移除键走默认端点
    const danmuCustomApiInput = document.getElementById('danmuCustomApiInput');
    if (danmuCustomApiInput) {
        let lastSavedDanmuApi = (localStorage.getItem('danmuCustomApi') || '').trim();
        const saveDanmuCustomApi = function () {
            const val = danmuCustomApiInput.value.trim();
            if (val === lastSavedDanmuApi) return;
            lastSavedDanmuApi = val;
            if (val) {
                localStorage.setItem('danmuCustomApi', val);
                showToast('弹幕 API 地址已保存', 'success');
            } else {
                localStorage.removeItem('danmuCustomApi');
                showToast('已清空弹幕 API 地址，将走默认端点', 'success');
            }
        };
        danmuCustomApiInput.addEventListener('change', saveDanmuCustomApi);
        danmuCustomApiInput.addEventListener('blur', saveDanmuCustomApi);
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
    // 清理搜索结果与进度提示
    document.getElementById('results').innerHTML = '';
    const searchProgress = document.getElementById('searchProgress');
    if (searchProgress) {
        searchProgress.textContent = '';
        searchProgress.style.display = 'none';
    }
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

    // 恢复"我的影院"区块显示
    if (typeof updateCinemaVisibility === 'function') {
        updateCinemaVisibility();
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
    // 搜索进行中不预取，避免挤占搜索请求连接池
    if (searchInProgress) return;

    const run = async () => {
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
    };

    // 空闲时再预取，进一步降低对交互与在途请求的干扰
    if ('requestIdleCallback' in window) requestIdleCallback(() => run());
    else setTimeout(run, 200);
}

// 读取预取的详情（命中返回数据，未命中返回 null）
function getPrefetchedDetail(id, sourceCode) {
    return detailPrefetchCache.get(`${sourceCode}_${id}`) || null;
}

// 搜索序号：连续搜索时丢弃旧搜索的迟到的渲染/结果，防止遮罩与内容错位
let searchSeq = 0;
// 当前搜索会话的请求控制器：新搜索发起时 abort 旧搜索的全部在途请求
let activeSearchController = null;
// 搜索是否进行中（全部源就绪前暂停 hover 预取，避免挤占搜索连接池）
let searchInProgress = false;

// 搜索触发防抖：连续触发（回车/按钮）只执行最后一次
let searchDebounceTimer = null;
function debouncedSearch() {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
        searchDebounceTimer = null;
        search();
    }, 300);
}

// 空闲调度：写操作等非关键任务移出关键路径，避免阻塞渲染与交互
function runWhenIdle(fn) {
    if ('requestIdleCallback' in window) requestIdleCallback(() => fn());
    else setTimeout(fn, 50);
}

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

    // abort 旧搜索的全部在途请求，避免新旧搜索互相抢连接拖慢彼此
    if (activeSearchController) activeSearchController.abort();
    activeSearchController = new AbortController();
    const searchSignal = activeSearchController.signal;

    showLoading();
    // 捕获本次搜索的 loading 所有权令牌：迟到的渲染回调只允许关闭归属自己的 loading，
    // 避免搜索期间用户点击卡片打开详情后，迟到结果渲染把详情的 loading 误关
    const searchLoadingOwner = loadingOwnerSeq;

    try {
        // 保存搜索历史（写 localStorage + 重建历史 DOM）移出关键路径，空闲时执行
        runWhenIdle(() => saveSearchHistory(query));

        // 显示结果区域，调整搜索区域（缓存/渐进两条路径共用）
        document.getElementById('searchArea').classList.remove('flex-1');
        document.getElementById('searchArea').classList.add('mb-8');
        document.getElementById('resultsArea').classList.remove('hidden');
        const doubanArea = document.getElementById('doubanArea');
        if (doubanArea) {
            doubanArea.classList.add('hidden');
        }
        // 搜索时隐藏"我的影院"区块（返回首页时由 resetSearchArea 恢复）
        if (typeof updateCinemaVisibility === 'function') {
            updateCinemaVisibility();
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
                    // 隐藏可能残留的搜索进度提示
                    const progressEl = document.getElementById('searchProgress');
                    if (progressEl) {
                        progressEl.textContent = '';
                        progressEl.style.display = 'none';
                    }
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
        resultsDiv.innerHTML = '';
        const searchResultsCount = document.getElementById('searchResultsCount');
        if (searchResultsCount) searchResultsCount.textContent = 0;

        const total = selectedAPIs.length;
        let settled = 0;
        let renderTimer = null;
        let urlUpdated = false;
        let renderedCount = 0;               // 渐进渲染已追加的卡片数（增量追加，不重建已渲染部分）
        let finalRendered = false;           // 最终排序渲染是否已完成（决定迟到结果的渲染方式）
        const seenKeys = new Set();          // 同源 source_code+vod_id 去重（第1/2页可能重复）
        const blockedKeywords = getBlockedTypeRuleKeywords(); // 本次搜索期间屏蔽规则不变，一次读入

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

        // 进度提示独立于结果列表容器（不参与卡片追加，避免重建）
        const updateProgressHint = (text) => {
            const el = document.getElementById('searchProgress');
            if (!el) return;
            el.textContent = text || '';
            el.style.display = text ? '' : 'none';
        };
        updateProgressHint('正在搜索各资源站…');

        // 节流渲染：250ms 合并一次；只追加新增卡片，已渲染的图片不闪烁、不重复请求
        const renderProgressive = () => {
            renderTimer = null;
            if (seq !== searchSeq) return; // 已被更新的搜索取代，丢弃本次渲染
            const div = document.getElementById('results');
            if (!div) return;
            const filtered = lastSearchResults.filter(item => !isBlockedByTypeFilter(item, blockedKeywords));
            if (filtered.length > renderedCount) {
                if (renderedCount === 0) div.innerHTML = ''; // 清掉"正在搜索/无结果"占位
                div.insertAdjacentHTML('beforeend', filtered.slice(renderedCount).map(buildResultCard).join(''));
                renderedCount = filtered.length;
            }
            updateProgressHint(settled < total ? `已搜索 ${settled}/${total} 个源，正在加载其余结果…` : '');
            const count = document.getElementById('searchResultsCount');
            if (count) count.textContent = filtered.length;

            // 首批结果已经渲染出来，立即关闭遮罩，避免遮罩盖住已可见的内容
            // 仅当 loading 仍归属本次搜索时才关闭：用户若已点击卡片打开详情，
            // 此处不能再关（迟到的补页结果触发的渲染不得误关详情的 loading）
            if (filtered.length > 0 && loadingOwnerSeq === searchLoadingOwner) hideLoading();
        };
        const scheduleProgressiveRender = () => {
            if (renderTimer) return;
            renderTimer = setTimeout(renderProgressive, 250);
        };

        // 追加结果（同源 source_code+vod_id 去重）；最终渲染完成后改为全量重渲染以正确应用筛选
        const appendResults = (results) => {
            const fresh = results.filter(item => {
                const key = `${item.source_code}_${item.vod_id}`;
                if (seenKeys.has(key)) return false;
                seenKeys.add(key);
                return true;
            });
            if (fresh.length === 0) return;
            lastSearchResults = lastSearchResults.concat(fresh);
            updateUrlOnce();
            if (finalRendered) renderFilteredSearchResults();
            else scheduleProgressiveRender();
        };

        searchInProgress = true;

        // 从所有选中的API源搜索；10 分钟内失败过的源延后 2 秒发起，让稳定源先出结果
        // 第 2 页起由后台补页回调追加（见 search.js searchByAPIAndKeyWord）
        const searchPromises = selectedAPIs.map(apiId => {
            const kick = (typeof isSourceUnhealthy === 'function' && isSourceUnhealthy(apiId))
                ? new Promise(resolve => setTimeout(resolve, 2000))
                : Promise.resolve();
            return kick
                .then(() => searchByAPIAndKeyWord(apiId, query, additional => {
                    if (seq !== searchSeq) return; // 已被更新的搜索取代
                    appendResults(additional);
                }, searchSignal))
                .then(results => {
                    if (seq !== searchSeq) return []; // 已被更新的搜索取代
                    settled++;
                    if (Array.isArray(results) && results.length > 0) {
                        appendResults(results);
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
        searchInProgress = false;

        if (renderTimer) {
            clearTimeout(renderTimer);
            renderTimer = null;
        }
        updateProgressHint('');

        // 3) 全部完成：合并、排序、最终渲染（一次全量重建，排序需要）
        // lastSearchResults 已含第1页与已到达的第2页结果（appendResults 已去重），直接在其上排序
        let allResults = [...lastSearchResults];

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
        finalRendered = true;

        // 会话缓存写入（大结果集同步 stringify 会阻塞渲染）移出关键路径
        runWhenIdle(() => {
            try {
                sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), results: allResults }));
            } catch (e) { /* 缓存写入失败不影响结果展示 */ }
        });
    } catch (error) {
        if (seq !== searchSeq) return; // 已被更新的搜索取代，静默丢弃
        console.error('搜索错误:', error);
        if (error.name === 'AbortError') {
            showToast('搜索请求超时，请检查网络连接', 'error');
        } else {
            showToast('搜索请求失败，请稍后重试', 'error');
        }
    } finally {
        // 只有最新一次搜索才能关闭遮罩，避免旧搜索的收尾关掉新搜索的遮罩；
        // 且仅当 loading 仍归属本次搜索时才关闭——渐进渲染期间用户可能已点击
        // 卡片打开详情（loading 已移交详情流程），此时不得误关详情的 loading
        if (seq === searchSeq) {
            searchInProgress = false;
            if (loadingOwnerSeq === searchLoadingOwner) hideLoading();
        }
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

// 本地占位图：内联 SVG data URI（深色底 + 片名首字），不依赖外部占位图服务（慢且常挂）
function buildPlaceholderCover(title) {
    // 首字符去除引号/尖括号等会破坏 data URI 与 HTML 属性的字符
    const ch = (((title || '').trim().charAt(0)) || '剧').replace(/['"\\&<>]/g, '') || '剧';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#20293e"/><text x="150" y="262" font-family="sans-serif" font-size="128" fill="#41506e" text-anchor="middle">${ch}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// 封面加载失败统一回退：浏览器直连源站图床可能被防盗链/网络环境拦截
// （如如意资源 pic.ry-pic.com，部分网络下直连全部失败），先经本地代理重试
// （服务端转发不受浏览器环境限制），代理仍失败才退回本地占位图。
// 与 douban.js 豆瓣封面的"直连失败走代理"策略保持一致
window.handleCoverLoadError = function (img) {
    const original = img.getAttribute('data-original') || '';
    if (!img.dataset.proxyTried && original) {
        img.dataset.proxyTried = '1';
        try {
            img.src = PROXY_URL + encodeURIComponent(decodeURIComponent(original));
            return;
        } catch (e) { /* 解码失败直接走占位图 */ }
    }
    img.onerror = null;
    img.src = buildPlaceholderCover(img.getAttribute('alt') || '');
    img.classList.add('object-contain');
};

// 构建单个搜索结果卡片
function buildResultCard(item) {
    const safeId = item.vod_id ? item.vod_id.toString().replace(/[^\w-]/g, '') : '';
    const safeName = escapeResultText(item.vod_name);
    const sourceCode = item.source_code || '';

    // 修改为与首页豆瓣卡片一致的垂直布局
    const hasCover = item.vod_pic && item.vod_pic.startsWith('http');
    // 渲染层再做一次图床域名归一：兼容 5 分钟 sessionStorage 搜索缓存中的旧域名数据
    const normalizedPic = hasCover ? normalizeRuyiPicUrl(item.vod_pic) : item.vod_pic;
    const placeholder = buildPlaceholderCover(item.vod_name);
    const coverUrl = hasCover ? normalizedPic : placeholder;
    // 原始封面地址存入 data 属性（encodeURIComponent 后无特殊字符，可安全内插），
    // 直连加载失败时由 handleCoverLoadError 取用并走代理重试
    const coverOriginalAttr = hasCover ? ` data-original="${encodeURIComponent(normalizedPic)}"` : '';
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
                <img src="${coverUrl}" alt="${safeName}"${coverOriginalAttr}
                     onerror="handleCoverLoadError(this)"
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

// 一次性读取当前启用的屏蔽关键词（渲染循环内复用，避免每条结果都读 localStorage）
function getBlockedTypeRuleKeywords() {
    const keywords = [];
    Object.entries(BLOCK_FILTER_RULES).forEach(([key, kws]) => {
        if (localStorage.getItem(key) === 'true') keywords.push(...kws);
    });
    return keywords;
}

// 判断某条结果是否命中启用的屏蔽规则；cachedKeywords 为预读的关键词列表（可选）
function isBlockedByTypeFilter(item, cachedKeywords) {
    const typeName = (item.type_name || '').toString();
    if (!typeName) return false;
    const keywords = cachedKeywords || getBlockedTypeRuleKeywords();
    return keywords.some(kw => typeName.includes(kw));
}

// 根据当前名称筛选与屏蔽规则渲染搜索结果
function renderFilteredSearchResults() {
    const resultsDiv = document.getElementById('results');
    if (!resultsDiv) return;

    const blockedKeywords = getBlockedTypeRuleKeywords();
    const filtered = lastSearchResults.filter(item => {
        if (currentNameFilter && (item.vod_name || '').trim() !== currentNameFilter) return false;
        if (isBlockedByTypeFilter(item, blockedKeywords)) return false;
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
// 加载动画最短稳定显示时长：保证遮罩淡入完成且 spinner 可见后再切换到详情弹窗，
// 避免预取命中时 loading 一闪而过造成页面"闪一下"
const DETAIL_MIN_LOADING_MS = 420;
// 详情请求序列号：快速连点不同卡片时，仅最新一次点击允许渲染弹窗/关闭 loading
let detailSeq = 0;

async function showDetails(id, vod_name, sourceCode) {
    if (!id) {
        showToast('视频ID无效', 'error');
        return;
    }

    const seq = ++detailSeq;
    const loadingStart = Date.now();
    // 补足最短 loading 时长（不足则等待剩余时间）
    const settleMinLoading = async () => {
        const remaining = DETAIL_MIN_LOADING_MS - (Date.now() - loadingStart);
        if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
    };

    showLoading();
    // 捕获本次详情请求的 loading 所有权令牌
    const detailLoadingOwner = loadingOwnerSeq;
    try {
        // 构建详情请求参数
        const detailOpts = { id, source: sourceCode };

        // 优先使用 hover 预取的详情，未命中再发请求
        let data = getPrefetchedDetail(id, sourceCode);
        if (!data) {
            data = await fetchVideoDetailData(detailOpts);
        }
        if (seq !== detailSeq) return; // 已有更新的点击，放弃本次渲染

        const modal = document.getElementById('modal');
        const modalTitle = document.getElementById('modalTitle');
        const modalContent = document.getElementById('modalContent');

        // 记录当前详情元信息，供"我的影院"收藏按钮读取封面/备注等
        currentDetailVideoInfo = (data && data.videoInfo) ? data.videoInfo : null;

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
                        <img src="${vi.cover}" alt="" loading="lazy"
                             data-original="${encodeURIComponent(vi.cover)}"
                             onerror="handleCoverLoadError(this)">
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
            // 集名与集数按 index 对齐；长度不一致/未提供时置空，渲染层降级为「第N集」
            currentEpisodeNames = (Array.isArray(data.episodeNames) && data.episodeNames.length === data.episodes.length)
                ? data.episodeNames : [];
            currentEpisodeIndex = 0;
            currentDetailSource = sourceCode;
            currentDetailId = id;

            // 综艺排序下集数数字显示方式的激活态
            const numModeBtnCls = m => varietyNumberMode === m ? ' active' : '';

            modalContent.innerHTML = `
                ${detailInfoHtml}
                <div class="wdtv-episodes-bar">
                    <div class="wdtv-episodes-bar-left">
                        <span id="cinemaFavBtnWrap" style="display:inline-flex">${getCinemaModalBtnHtml(id, sourceCode)}</span>
                        <button type="button" onclick="openDetailBatchDownload(event)" class="wdtv-modal-mini-btn"
                                title="多选集数批量下载到本地">
                            <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16"></path>
                            </svg>
                            <span>批量下载</span>
                        </button>
                        <div id="sortModeDropdown" class="wdtv-name-dropdown">
                            <button type="button" class="wdtv-name-dropdown-toggle" onclick="toggleSortDropdown(event)">
                                <span id="sortModeLabel">${sortMode === 'variety' ? '综艺排序' : '默认排序'}</span>
                                <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                            </button>
                            <div id="sortModeMenu" class="wdtv-name-dropdown-menu hidden">
                                <div class="wdtv-sort-dropdown-item${sortMode === 'default' ? ' active' : ''}" data-mode="default"><span>默认排序</span></div>
                                <div class="wdtv-sort-dropdown-item${sortMode === 'variety' ? ' active' : ''}" data-mode="variety"><span>综艺排序</span></div>
                            </div>
                        </div>
                        <span id="defaultSortControls" class="wdtv-sort-subcontrols${sortMode === 'default' ? '' : ' hidden'}">
                            <button onclick="toggleEpisodeOrder('${sourceCode}', '${id}')"
                                    class="wdtv-modal-mini-btn">
                                <svg class="w-4 h-4 transform ${episodesReversed ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path>
                                </svg>
                                <span>${episodesReversed ? '正序排列' : '倒序排列'}</span>
                            </button>
                        </span>
                        <span id="varietySortControls" class="wdtv-sort-subcontrols${sortMode === 'variety' ? '' : ' hidden'}">
                            <button data-nummode="group" onclick="setVarietyNumberMode('group')"
                                    class="wdtv-modal-mini-btn num-mode${numModeBtnCls('group')}">新集数</button>
                            <button data-nummode="original" onclick="setVarietyNumberMode('original')"
                                    class="wdtv-modal-mini-btn num-mode${numModeBtnCls('original')}">原集数</button>
                            <button data-nummode="both" onclick="setVarietyNumberMode('both')"
                                    class="wdtv-modal-mini-btn num-mode${numModeBtnCls('both')}">双显</button>
                            <span class="wdtv-threshold-label" title="按时长划分两组的分界线">分组线
                                <span id="thresholdDropdown" class="wdtv-name-dropdown wdtv-inline-dropdown">
                                    <span class="wdtv-name-dropdown-toggle wdtv-threshold-toggle" onclick="toggleThresholdDropdown(event)">
                                        <input id="varietyThresholdInput" type="number" min="1" step="1"
                                               value="${varietyThresholdMinutes}" onchange="setVarietyThreshold(this.value)"
                                               onclick="event.stopPropagation()" class="wdtv-threshold-input"
                                               title="输入自定义分组线（分钟），回车生效">分钟
                                        <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                                    </span>
                                    <div id="thresholdDropdownMenu" class="wdtv-name-dropdown-menu hidden"></div>
                                </span>
                            </span>
                        </span>
                        <button id="detectDurationBtn" onclick="detectEpisodeDurations()" class="wdtv-modal-mini-btn${sortMode === 'variety' ? ' hidden' : ''}">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                            </svg>
                            <span id="detectDurationLabel">检测时长</span>
                        </button>
                        <button id="episodeViewBtn" onclick="toggleEpisodeView()" class="wdtv-modal-mini-btn${episodeViewMode === 'list' ? ' active' : ''}"
                                title="切换剧集布局：数字方块 / 详细列表（显示完整集名）">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
                            </svg>
                            <span>剧集信息</span>
                        </button>
                        <span class="episode-stats">共 ${data.episodes.length} 集</span>
                    </div>
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

        // loading 稳定显示达标后再切换到详情弹窗，弹窗淡入与遮罩淡出平滑衔接
        await settleMinLoading();
        if (seq !== detailSeq) return;
        modal.classList.remove('hidden');
    } catch (error) {
        console.error('获取详情错误:', error);
        await settleMinLoading();
        if (seq !== detailSeq) return;
        showToast('获取详情失败，请稍后重试', 'error');
    } finally {
        // 仅当 loading 仍归属本次详情请求时才关闭；
        // 期间若已发起新搜索等新流程（令牌已转移），则由新流程接管 loading
        if (seq === detailSeq && loadingOwnerSeq === detailLoadingOwner) hideLoading();
    }
}

// 详情弹窗批量下载：把当前详情的集数多选入队（下载引擎 js/downloader.js，默认画质 + 弹窗内选格式）
function openDetailBatchDownload(event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    if (typeof WDTDownloader === 'undefined') {
        showToast('下载功能未加载，请刷新页面', 'error');
        return;
    }
    if (!Array.isArray(currentEpisodes) || !currentEpisodes.length) {
        showToast('没有可下载的集数', 'info');
        return;
    }
    // 集数排列与详情弹窗的剧集列表保持一致（与播放页 openBatch 同款逻辑）：
    // 综艺排序 → 长组→短组 + 组标题间隔行；默认排序 → 原顺序（含倒序开关）
    let order = currentEpisodes.map((_, i) => i);
    const epNums = [];
    if (sortMode === 'variety') {
        const thresholdSec = varietyThresholdMinutes * 60;
        const longIdx = [];
        const shortIdx = [];
        currentEpisodes.forEach((url, i) => {
            const info = episodeDurationCache.get(url);
            if (info && info.status === 'done' && isFinite(info.seconds) && info.seconds >= thresholdSec) {
                longIdx.push(i);
            } else {
                shortIdx.push(i);
            }
        });
        order = longIdx.concat(shortIdx);
        const groupPos = new Map();
        longIdx.forEach((ri, p) => groupPos.set(ri, p + 1));
        shortIdx.forEach((ri, p) => groupPos.set(ri, p + 1));
        order.forEach((ri, pos) => {
            const g = groupPos.get(ri), o = ri + 1;
            let info;
            if (varietyNumberMode === 'group') info = { num: g };
            else if (varietyNumberMode === 'both') info = { num: g, sub: o };
            else info = { num: o };
            // 组首集打上分组标记，批量弹窗据此插入分组间隔行
            if (longIdx.length && shortIdx.length) {
                if (pos === 0) info.groupLabel = `${varietyThresholdMinutes}分钟以上`;
                else if (pos === longIdx.length) info.groupLabel = `${varietyThresholdMinutes}分钟以下`;
            }
            epNums.push(info);
        });
    } else {
        if (episodesReversed) order.reverse();
        order.forEach(ri => epNums.push({ num: ri + 1 }));
    }
    const curDisplay = order.indexOf(currentEpisodeIndex);
    WDTDownloader.openBatchDownloadModal({
        title: currentVideoTitle || '未知视频',
        episodes: order.map(ri => currentEpisodes[ri]),
        currentEpisodeIndex: curDisplay !== -1 ? curDisplay : (currentEpisodeIndex || 0),
        epNums,
        // 批量下载标签用真实集名，无集名时降级为「第N集」
        episodeLabels: order.map(ri => (currentEpisodeNames[ri] || '').trim() || `第${ri + 1}集`),
        qualities: [],
        mapEpisodeUrl: null
    });
}

// 更新播放视频函数，直接跳转到player.html
// resumePosition：续播起始秒数（我的影院单击续播用，从上次进度回退 10 秒后传入）
function playVideo(url, vod_name, sourceCode, episodeIndex = 0, vodId = '', resumePosition = 0) {
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

    // 构建播放页面URL，直接跳转到player.html（resumePosition>0 时附带续播位置）
    let playerUrl = `player.html?id=${vodId || ''}&source=${sourceCode || ''}&url=${encodeURIComponent(url)}&index=${episodeIndex}&title=${encodeURIComponent(vod_name || '')}&returnUrl=${encodeURIComponent(returnUrl)}`;
    if (resumePosition > 0) {
        playerUrl += `&position=${Math.floor(resumePosition)}`;
    }

    // 保存当前状态到localStorage
    try {
        localStorage.setItem('currentVideoTitle', vod_name || '未知视频');
        localStorage.setItem('currentEpisodes', JSON.stringify(currentEpisodes));
        // 集名与集数同步传给播放页；缺失时写空数组，播放页降级为「第N集」
        localStorage.setItem('currentEpisodeNames', JSON.stringify(Array.isArray(currentEpisodeNames) ? currentEpisodeNames : []));
        localStorage.setItem('currentEpisodeIndex', episodeIndex);
        localStorage.setItem('currentSourceCode', sourceCode || '');
        localStorage.setItem('lastPlayTime', Date.now());
        localStorage.setItem('lastSearchPage', currentPath);
        localStorage.setItem('lastPageUrl', returnUrl);  // 确保保存返回页面URL
        // 同步排序方式与已检测时长，播放页保持与详情页一致的展示
        localStorage.setItem('episodesReversed', episodesReversed);
        localStorage.setItem('episodeSortMode', sortMode);
        localStorage.setItem('varietyNumberMode', varietyNumberMode);
        localStorage.setItem('varietyThresholdMinutes', varietyThresholdMinutes);
        localStorage.setItem('episodeDurationCache', JSON.stringify([...episodeDurationCache.entries()]));
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
    const cinemaArea = document.getElementById('cinemaArea');
    if (cinemaArea) cinemaArea.classList.add('hidden');
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
        // 恢复"我的影院"区块显示
        if (typeof updateCinemaVisibility === 'function') {
            updateCinemaVisibility();
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

// 辅助函数用于渲染剧集按钮（使用当前的排序状态，附带已检测的时长）
function renderEpisodes(vodName, sourceCode, vodId) {
    // 综艺排序：按时长分为"60分钟以上 / 60分钟以下"两组，各自成块
    if (sortMode === 'variety') {
        return renderVarietyEpisodes(vodName, sourceCode, vodId);
    }
    // 详细列表模式：每行一条，完整显示集名
    if (episodeViewMode === 'list') {
        const rows = currentEpisodes.map((_, i) => i);
        if (episodesReversed) rows.reverse();
        return `<div class="wdtv-ep-list">` + rows.map((realIndex, pos) =>
            renderEpisodeRow(vodName, sourceCode, vodId, realIndex, pos + 1)
        ).join('') + `</div>`;
    }
    const episodes = episodesReversed ? [...currentEpisodes].reverse() : currentEpisodes;
    return episodes.map((episode, index) => {
        // 根据倒序状态计算真实的剧集索引
        const realIndex = episodesReversed ? currentEpisodes.length - 1 - index : index;
        return renderEpisodeButton(vodName, sourceCode, vodId, realIndex, index + 1);
    }).join('');
}

// 切换剧集展示布局（数字方块 ↔ 详细列表），持久化并立即重渲染
function toggleEpisodeView() {
    episodeViewMode = episodeViewMode === 'list' ? 'grid' : 'list';
    try { localStorage.setItem('episodeViewMode', episodeViewMode); } catch (e) { /* 存储失败不影响切换 */ }
    const btn = document.getElementById('episodeViewBtn');
    if (btn) btn.classList.toggle('active', episodeViewMode === 'list');
    const grid = document.getElementById('episodesGrid');
    if (grid) grid.innerHTML = renderEpisodes(currentVideoTitle, currentDetailSource, currentDetailId);
}

// 详细列表模式：渲染单行剧集条目（完整集名，不截断；时长右对齐）
function renderEpisodeRow(vodName, sourceCode, vodId, realIndex, groupNum) {
    const episode = currentEpisodes[realIndex];
    const originalNum = realIndex + 1;
    const rawName = (currentEpisodeNames[realIndex] || '').trim();
    const displayName = rawName || `第 ${originalNum} 集`;

    const durInfo = episodeDurationCache.get(episode);
    let durHtml = '';
    if (durInfo && durInfo.status === 'done' && isFinite(durInfo.seconds)) {
        durHtml = `<span class="ep-dur">${formatEpisodeDuration(durInfo.seconds)}</span>`;
    } else if (durInfo && durInfo.status === 'detecting') {
        durHtml = `<span class="ep-dur ep-dur-detecting">···</span>`;
    } else if (durInfo && durInfo.status === 'fail') {
        durHtml = `<span class="ep-dur ep-dur-fail">--</span>`;
    }

    return `
        <div id="episode-${realIndex}" role="button" tabindex="0"
             title="${escapeHtml(rawName ? `第 ${originalNum} 集 · ${rawName}` : `第 ${originalNum} 集`)}"
             onclick="playVideo('${episode}','${vodName.replace(/"/g, '&quot;')}', '${sourceCode}', ${realIndex}, '${vodId}')"
             class="wdtv-ep-row">
            <span class="ep-row-num">${originalNum}</span>
            <span class="ep-row-name">${escapeHtml(displayName)}</span>
            ${durHtml}
        </div>
    `;
}

// 渲染单个集数按钮（groupNum 为综艺排序下的组内序号，仅综艺排序使用）
// 数字方块模式只显示序号（+可选时长），集名只在「剧集信息」详细列表中展示
function renderEpisodeButton(vodName, sourceCode, vodId, realIndex, groupNum) {
    const episode = currentEpisodes[realIndex];
    const originalNum = realIndex + 1;

    // 集数数字显示方式（仅综艺排序区分；默认排序恒为原集数）
    let numHtml;
    if (sortMode === 'variety') {
        if (varietyNumberMode === 'group') {
            numHtml = `<span class="ep-num" title="组内第 ${groupNum} 集 · 原第 ${originalNum} 集">${groupNum}</span>`;
        } else if (varietyNumberMode === 'both') {
            // 大数字为新排序序号，括号内小数字为原序号
            numHtml = `<span class="ep-num" title="组内第 ${groupNum} 集 · 原第 ${originalNum} 集">${groupNum}<em class="ep-num-g">(${originalNum})</em></span>`;
        } else {
            numHtml = `<span class="ep-num" title="原第 ${originalNum} 集 · 组内第 ${groupNum} 集">${originalNum}</span>`;
        }
    } else {
        numHtml = `<span class="ep-num">${originalNum}</span>`;
    }

    const durInfo = episodeDurationCache.get(episode);
    let durHtml = '';
    if (durInfo && durInfo.status === 'done' && isFinite(durInfo.seconds)) {
        durHtml = `<span class="ep-dur">${formatEpisodeDuration(durInfo.seconds)}</span>`;
    } else if (durInfo && durInfo.status === 'detecting') {
        durHtml = `<span class="ep-dur ep-dur-detecting">···</span>`;
    } else if (durInfo && durInfo.status === 'fail') {
        durHtml = `<span class="ep-dur ep-dur-fail">--</span>`;
    }

    return `
        <button id="episode-${realIndex}"
                onclick="playVideo('${episode}','${vodName.replace(/"/g, '&quot;')}', '${sourceCode}', ${realIndex}, '${vodId}')"
                class="wdtv-episode-btn">
            ${numHtml}
            ${durHtml}
        </button>
    `;
}

// 综艺排序渲染：按时长分为"X分钟以上 / X分钟以下"两组（阈值可调），组内保持原有先后顺序，各组单独从 1 编号
function renderVarietyEpisodes(vodName, sourceCode, vodId) {
    const thresholdSec = varietyThresholdMinutes * 60;
    const longIdx = [];
    const shortIdx = [];
    currentEpisodes.forEach((url, i) => {
        const info = episodeDurationCache.get(url);
        if (info && info.status === 'done' && isFinite(info.seconds) && info.seconds >= thresholdSec) {
            longIdx.push(i);
        } else {
            shortIdx.push(i); // 未检测/检测失败的集数暂归入"X分钟以下"组，检测完成后实时重排
        }
    });

    const buildSection = (label, indices) => {
        if (indices.length === 0) return '';
        // 详细列表模式下分组内也用整行条目，容器换成列表布局
        const isList = episodeViewMode === 'list';
        const items = indices.map((realIndex, pos) =>
            isList
                ? renderEpisodeRow(vodName, sourceCode, vodId, realIndex, pos + 1)
                : renderEpisodeButton(vodName, sourceCode, vodId, realIndex, pos + 1)
        ).join('');
        const body = isList ? `<div class="wdtv-ep-list">${items}</div>` : `<div class="wdtv-variety-grid">${items}</div>`;
        return `
            <div class="wdtv-variety-section">
                <div class="wdtv-variety-label">${label}（${indices.length} 集）</div>
                ${body}
            </div>
        `;
    };

    return buildSection(`${varietyThresholdMinutes}分钟以上`, longIdx) + buildSection(`${varietyThresholdMinutes}分钟以下`, shortIdx);
}

// ===== 各集时长检测 =====
// 缓存：集数地址 -> { status: 'detecting'|'done'|'fail', seconds }
const episodeDurationCache = new Map();

// 更新单个集数按钮上的时长显示（弹窗已切换到其他视频时跳过）
function updateEpisodeDurationDom(realIndex, episodeUrl) {
    if (!currentEpisodes || currentEpisodes[realIndex] !== episodeUrl) return;
    const btn = document.getElementById(`episode-${realIndex}`);
    if (!btn) return;
    const old = btn.querySelector('.ep-dur');
    if (old) old.remove();
    const info = episodeDurationCache.get(episodeUrl);
    if (!info) return;
    const span = document.createElement('span');
    if (info.status === 'done' && isFinite(info.seconds)) {
        span.className = 'ep-dur';
        span.textContent = formatEpisodeDuration(info.seconds);
    } else if (info.status === 'detecting') {
        span.className = 'ep-dur ep-dur-detecting';
        span.textContent = '···';
    } else if (info.status === 'fail') {
        span.className = 'ep-dur ep-dur-fail';
        span.textContent = '--';
    } else {
        return;
    }
    btn.appendChild(span);
}

// 检测全部集数时长（并发限制，逐集更新到按钮上；点击重试时仅重测失败项）
// 综艺排序进入时也会自动调用，running 标志防止重复触发
let durationDetectRunning = false;
function detectEpisodeDurations() {
    if (!currentEpisodes || currentEpisodes.length === 0) return;
    if (durationDetectRunning) return;
    durationDetectRunning = true;
    runDurationDetection().finally(() => { durationDetectRunning = false; });
}

async function runDurationDetection() {
    const episodesRef = currentEpisodes;
    const btn = document.getElementById('detectDurationBtn');
    const label = document.getElementById('detectDurationLabel');
    if (btn) btn.disabled = true;

    let completed = 0;
    const updateProgress = () => {
        if (currentEpisodes !== episodesRef || !label) return;
        label.textContent = completed >= episodesRef.length ? '检测完成' : `检测中 ${completed}/${episodesRef.length}`;
    };

    const pending = episodesRef.map((url, idx) => ({ url, idx }));
    const CONCURRENCY = 3;
    const worker = async () => {
        while (pending.length > 0) {
            const task = pending.shift();
            const cached = episodeDurationCache.get(task.url);
            if (!cached || cached.status !== 'done') {
                episodeDurationCache.set(task.url, { status: 'detecting' });
                updateEpisodeDurationDom(task.idx, task.url);
                let seconds = null;
                try {
                    if (/\.m3u8([?#]|$)/i.test(task.url)) {
                        seconds = await fetchM3u8Duration(task.url);
                    } else {
                        seconds = await fetchMediaDurationByVideo(task.url);
                    }
                } catch (err) {
                    console.warn('单集时长检测异常:', task.url, err);
                    seconds = null;
                }
                episodeDurationCache.set(task.url, seconds != null
                    ? { status: 'done', seconds }
                    : { status: 'fail' });
            }
            completed++;
            if (currentEpisodes === episodesRef) {
                if (sortMode === 'variety') {
                    // 综艺排序下每检测完一集即整体重排，时长到齐的集数实时归入对应分组
                    rerenderEpisodesGrid();
                } else {
                    updateEpisodeDurationDom(task.idx, task.url);
                }
                updateProgress();
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

    if (currentEpisodes === episodesRef) {
        if (btn) btn.disabled = false;
        let failCount = 0;
        episodesRef.forEach(u => {
            const info = episodeDurationCache.get(u);
            if (info && info.status === 'fail') failCount++;
        });
        if (label) label.textContent = failCount > 0 ? '重试失败项' : '检测时长';
        showToast(failCount > 0 ? `时长检测完成，${failCount} 集失败，可再次点击重试` : '时长检测完成', failCount > 0 ? 'error' : 'success');
    }
}

// 重新渲染集数区域（使用当前详情上下文）
function rerenderEpisodesGrid() {
    const episodesGrid = document.getElementById('episodesGrid');
    if (episodesGrid) {
        episodesGrid.innerHTML = renderEpisodes(currentVideoTitle, currentDetailSource, currentDetailId);
    }
}

// 切换排序模式：默认排序 / 综艺排序（下拉框二选一）
function setSortMode(mode) {
    if (mode !== 'default' && mode !== 'variety') return;
    if (sortMode === mode) return;
    sortMode = mode;
    updateSortControlStates();
    rerenderEpisodesGrid();
    // 综艺排序依赖各集时长：进入后自动触发检测（已完成的集数自动跳过），完成后分组实时重排
    if (mode === 'variety') {
        detectEpisodeDurations();
    }
}

// 切换综艺排序下的集数数字显示方式：original 原集数 / group 新集数 / both 双显
function setVarietyNumberMode(mode) {
    if (!['original', 'group', 'both'].includes(mode)) return;
    varietyNumberMode = mode;
    updateSortControlStates();
    rerenderEpisodesGrid();
}

// 调整综艺排序的时长分组线（分钟），立即按新阈值重新分组
function setVarietyThreshold(value) {
    const minutes = parseInt(value, 10);
    if (!isFinite(minutes) || minutes <= 0) {
        // 无效输入时恢复为当前生效值
        syncThresholdUI();
        return;
    }
    applyThresholdMinutes(minutes);
}

// 应用分组线（分钟）：同步输入框显示并重新分组；菜单开着时刷新其高亮项
function applyThresholdMinutes(minutes) {
    if (!isFinite(minutes) || minutes <= 0 || minutes === varietyThresholdMinutes) {
        syncThresholdUI();
        return;
    }
    varietyThresholdMinutes = minutes;
    syncThresholdUI();
    const menu = document.getElementById('thresholdDropdownMenu');
    if (menu && !menu.classList.contains('hidden')) menu.innerHTML = buildThresholdMenuHtml();
    rerenderEpisodesGrid();
}

// 同步分组线输入框的显示
function syncThresholdUI() {
    const input = document.getElementById('varietyThresholdInput');
    if (input) input.value = varietyThresholdMinutes;
}

// 展开/收起排序模式下拉菜单
function toggleSortDropdown(event) {
    event.stopPropagation();
    const menu = document.getElementById('sortModeMenu');
    const dropdown = document.getElementById('sortModeDropdown');
    if (!menu || !dropdown) return;
    menu.classList.toggle('hidden');
    dropdown.classList.toggle('open', !menu.classList.contains('hidden'));
    closeThresholdDropdown();
}

// 关闭排序模式下拉菜单
function closeSortDropdown() {
    const menu = document.getElementById('sortModeMenu');
    const dropdown = document.getElementById('sortModeDropdown');
    if (menu) menu.classList.add('hidden');
    if (dropdown) dropdown.classList.remove('open');
}

// 展开/收起分组线下拉菜单（每次展开时重建以同步激活态，并滚动定位到当前值）
function toggleThresholdDropdown(event) {
    event.stopPropagation();
    const menu = document.getElementById('thresholdDropdownMenu');
    const dropdown = document.getElementById('thresholdDropdown');
    if (!menu || !dropdown) return;
    menu.innerHTML = buildThresholdMenuHtml();
    menu.classList.toggle('hidden');
    const opening = !menu.classList.contains('hidden');
    dropdown.classList.toggle('open', opening);
    closeSortDropdown();
    if (opening) {
        const activeItem = menu.querySelector('.wdtv-sort-dropdown-item.active');
        if (activeItem) menu.scrollTop = activeItem.offsetTop - menu.clientHeight / 2;
    }
}

// 关闭分组线下拉菜单
function closeThresholdDropdown() {
    const menu = document.getElementById('thresholdDropdownMenu');
    const dropdown = document.getElementById('thresholdDropdown');
    if (menu) menu.classList.add('hidden');
    if (dropdown) dropdown.classList.remove('open');
}

// 分组线下拉菜单：1~360 分钟逐分钟列出（精确到每一分钟），超出范围的自定义值附加到末尾
const THRESHOLD_MENU_MAX = 360;
function buildThresholdMenuHtml() {
    const max = Math.max(THRESHOLD_MENU_MAX, varietyThresholdMinutes);
    let html = '';
    for (let m = 1; m <= max; m++) {
        html += `<div class="wdtv-sort-dropdown-item${m === varietyThresholdMinutes ? ' active' : ''}" data-threshold="${m}"><span>${m}</span></div>`;
    }
    return html;
}

// 下拉菜单点击委托：选择排序模式 / 选择分组线；点击菜单外区域时收起
document.addEventListener('click', (e) => {
    const sortItem = e.target.closest('#sortModeMenu .wdtv-sort-dropdown-item');
    if (sortItem) {
        closeSortDropdown();
        setSortMode(sortItem.dataset.mode);
        return;
    }
    const thresholdItem = e.target.closest('#thresholdDropdownMenu .wdtv-sort-dropdown-item');
    if (thresholdItem) {
        closeThresholdDropdown();
        applyThresholdMinutes(parseInt(thresholdItem.dataset.threshold, 10));
        return;
    }
    const sortDd = document.getElementById('sortModeDropdown');
    if (sortDd && !sortDd.contains(e.target)) closeSortDropdown();
    const thDd = document.getElementById('thresholdDropdown');
    if (thDd && !thDd.contains(e.target)) closeThresholdDropdown();
});

// 同步排序控件状态：下拉框标签与选中项、子控件显隐、检测按钮显隐、显示方式激活态、分组线显示
function updateSortControlStates() {
    const sortLabel = document.getElementById('sortModeLabel');
    if (sortLabel) sortLabel.textContent = sortMode === 'variety' ? '综艺排序' : '默认排序';
    document.querySelectorAll('#sortModeMenu .wdtv-sort-dropdown-item').forEach(el => {
        el.classList.toggle('active', el.dataset.mode === sortMode);
    });

    const defCtl = document.getElementById('defaultSortControls');
    const varCtl = document.getElementById('varietySortControls');
    if (defCtl) defCtl.classList.toggle('hidden', sortMode !== 'default');
    if (varCtl) varCtl.classList.toggle('hidden', sortMode !== 'variety');

    // 综艺排序进入时自动检测，手动检测按钮仅在默认排序下显示
    const detectBtn = document.getElementById('detectDurationBtn');
    if (detectBtn) detectBtn.classList.toggle('hidden', sortMode === 'variety');

    document.querySelectorAll('#varietySortControls .num-mode').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.nummode === varietyNumberMode);
    });

    syncThresholdUI();
}

// 切换排序状态的函数
function toggleEpisodeOrder(sourceCode, vodId) {
    episodesReversed = !episodesReversed;
    // 重新渲染剧集区域
    rerenderEpisodesGrid();

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

// 移除Node.js的require语句，因为这是在浏览器环境中运行的
