// ===== 批次4 A2：片头/中段/片尾跳过标记总开关 =====
// 单一键 wdtvSkipMarks 存 { enabled, marks }，与 player.js / cloud-sync 共用同一结构。
// 读写都容错：脏数据、localStorage 异常一律按「默认关闭」处理，绝不抛错影响首屏。
function wdtvReadSkipMarksStore() {
    try {
        const raw = localStorage.getItem('wdtvSkipMarks');
        if (!raw) return { enabled: false, marks: {} };
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { enabled: false, marks: {} };
        return { enabled: obj.enabled === true, marks: (obj.marks && typeof obj.marks === 'object' && !Array.isArray(obj.marks)) ? obj.marks : {} };
    } catch (e) { return { enabled: false, marks: {} }; }
}
function wdtvReadSkipMarksEnabled() { return wdtvReadSkipMarksStore().enabled; }
function wdtvWriteSkipMarksEnabled(on) {
    try {
        const store = wdtvReadSkipMarksStore();
        store.enabled = !!on;
        store.updatedAt = Date.now();
        localStorage.setItem('wdtvSkipMarks', JSON.stringify(store));
    } catch (e) { /* 存储不可用时静默降级 */ }
}

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

    // 设置广告自动跳过开关初始状态（默认关闭，显式写 false 便于云同步首日生效）
    const adAutoSkipToggle = document.getElementById('adAutoSkipToggle');
    if (adAutoSkipToggle) {
        if (localStorage.getItem(PLAYER_CONFIG.adAutoSkipStorage) === null) {
            localStorage.setItem(PLAYER_CONFIG.adAutoSkipStorage, 'false');
        }
        adAutoSkipToggle.checked = localStorage.getItem(PLAYER_CONFIG.adAutoSkipStorage) === 'true';
    }

    // 批次4 A2：片头/中段/片尾跳过标记总开关（默认关闭）
    // 单一键 wdtvSkipMarks 存 { enabled, marks }；读时保留 marks，缺省视为关闭。
    const skipMarksToggle = document.getElementById('skipMarksToggle');
    if (skipMarksToggle) {
        skipMarksToggle.checked = wdtvReadSkipMarksEnabled();
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

    // 设置卡片画质探测开关初始状态（默认关闭：localStorage 无值时 '=== true' 为 false，不勾选）
    const qualityProbeToggle = document.getElementById('wdtvQualityProbeToggle');
    if (qualityProbeToggle) {
        qualityProbeToggle.checked = localStorage.getItem('wdtvQualityProbeEnabled') === 'true';
    }

    // 设置事件监听器
    setupEventListeners();

    // ===== 批次3 ①：数据源订阅首屏渲染 + 打开站点时检查一次（模块内幂等、静默、不阻塞首屏）=====
    if (window.WDTVSourceSubscriptions) {
        window.WDTVSourceSubscriptions.render();
        window.WDTVSourceSubscriptions.autoRefresh();
    }

    // ===== 批次3 ②：数据源订阅控件事件绑定（document 事件委托，不新增 inline onclick）=====
    (function () {
        var S = window.WDTVSourceSubscriptions;
        if (!S) return;

        function inList(el) {
            return !!(el && el.closest && el.closest('#wdtvSubscriptionList'));
        }
        // 「订阅 / 刷新」唯一按钮 + 输入框回车的统一入口：
        //  输入框有值 → add（不在 list 才添加）+ 立即强制同步该订阅（已在 list 则直接强制同步）；
        //  输入框为空 → 强制刷新全部启用订阅（autoRefresh 的强制版）。
        //  操作结果文案一律不暴露订阅（上游）URL。
        function submitSubscription(inp) {
            var raw = inp ? String(inp.value || '').trim() : '';
            if (raw) {
                S.add(raw);                               // 已在 list 时内部去重返回 false，不重复添加
                if (inp) inp.value = '';
                S.setStatus('正在同步…');
                S.syncOne(raw, { force: true }).then(function (n) {
                    if (n < 0) S.setStatus('同步失败，请稍后重试');   // 地址无效/未入库：通用失败文案
                });
            } else {
                S.setStatus('正在刷新全部订阅…');
                S.autoRefresh({ force: true });
            }
        }

        // 点击：唯一按钮 + 列表内操作按钮
        document.addEventListener('click', function (e) {
            var t = e.target;
            var refreshBtn = (t && t.closest) ? t.closest('#wdtvSubscriptionRefresh') : null;
            if (refreshBtn) {
                submitSubscription(document.getElementById('wdtvSubscriptionUrl'));
                return;
            }
            var actionEl = (t && t.closest) ? t.closest('[data-sub-action]') : null;
            if (!actionEl || !inList(actionEl)) return;
            var action = actionEl.getAttribute('data-sub-action');
            if (!action || action === 'days') return;     // 周期下拉交给 change 处理
            e.preventDefault();
            var url = actionEl.getAttribute('data-sub-url');
            if (!url) return;
            if (action === 'remove') S.remove(url);
            else if (action === 'toggle') {
                var cur = S.list().filter(function (x) { return x.url === url; })[0];
                if (cur) S.setEnabled(url, !cur.enabled);
            }
            else if (action === 'refresh') {
                S.setStatus('正在同步…');
                S.syncOne(url, { force: true }).then(function (n) {
                    if (n < 0) S.setStatus('同步失败，请稍后重试');
                });
            }
            else if (action === 'resume') {
                S.resume(url);
                S.setStatus('正在同步…');
                S.syncOne(url, { force: true }).then(function (n) {
                    if (n < 0) S.setStatus('同步失败，请稍后重试');
                });
            }
        });

        // 变更：条目上的刷新周期下拉
        document.addEventListener('change', function (e) {
            var el = e.target;
            if (el && el.getAttribute && el.getAttribute('data-sub-action') === 'days' && inList(el)) {
                S.setRefreshDays(el.getAttribute('data-sub-url'), parseInt(el.value, 10));
            }
        });

        // 回车：输入框内直接提交
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && e.target && e.target.id === 'wdtvSubscriptionUrl') {
                e.preventDefault();
                submitSubscription(e.target);
            }
        });
    })();
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
        // 源健康度徽章：停用剩余时间 / 长期停用 / 连续失败次数，停用时提供手动恢复
        // 追加在既有 input + label 之后，不改变 checkbox 结构与 updateSelectedAPIs 逻辑
        const healthStatus = (typeof window.getSourceHealthStatus === 'function')
            ? window.getSourceHealthStatus(apiKey) : null;
        if (healthStatus) {
            let badgeText = '';
            let canResume = false;
            if (healthStatus.permanent) {
                badgeText = '长期停用';
                canResume = true;
            } else if (healthStatus.disabled) {
                const mins = Math.max(1, Math.ceil((healthStatus.remainingMs || 0) / 60000));
                badgeText = `停用中 · 剩余 ${mins} 分钟`;
                canResume = true;
            } else if (healthStatus.failCount > 0) {
                badgeText = `连续失败 ${healthStatus.failCount} 次`;
            }
            if (badgeText) {
                const badge = document.createElement('span');
                badge.style.cssText = 'display:inline-flex;align-items:center;gap:4px;'
                    + 'flex-shrink:0;margin-left:6px;padding:1px 6px;border-radius:6px;'
                    + 'background:rgba(140,130,110,0.14);color:var(--text-muted,#9ca3af);'
                    + 'font-size:0.68rem;line-height:1.4;white-space:nowrap;';
                const badgeLabel = document.createElement('span');
                badgeLabel.textContent = badgeText;
                badge.appendChild(badgeLabel);
                if (canResume) {
                    const resumeBtn = document.createElement('button');
                    resumeBtn.type = 'button';
                    resumeBtn.textContent = '恢复';
                    resumeBtn.style.cssText = 'border:0;background:transparent;padding:0 2px;'
                        + 'color:inherit;font-size:inherit;text-decoration:underline;cursor:pointer;';
                    resumeBtn.addEventListener('click', function (e) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (typeof window.resumeSourceHealth === 'function') window.resumeSourceHealth(apiKey);
                        initAPICheckboxes();
                    });
                    badge.appendChild(resumeBtn);
                }
                checkbox.appendChild(badge);
            }
        }
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

    // 广告自动跳过开关事件绑定（默认关）
    const adAutoSkipToggle = document.getElementById('adAutoSkipToggle');
    if (adAutoSkipToggle) {
        adAutoSkipToggle.addEventListener('change', function (e) {
            localStorage.setItem(PLAYER_CONFIG.adAutoSkipStorage, e.target.checked);
        });
    }

    // 批次4 A2：片头/中段/片尾跳过标记开关（与「广告自动跳过」互不影响，默认关）
    const skipMarksToggle = document.getElementById('skipMarksToggle');
    if (skipMarksToggle) {
        skipMarksToggle.addEventListener('change', function (e) {
            wdtvWriteSkipMarksEnabled(e.target.checked);
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

    // 卡片画质探测开关（默认关闭；关闭时立即断开观察器并取消在途探测，恢复零新增请求）
    const qualityProbeToggle = document.getElementById('wdtvQualityProbeToggle');
    if (qualityProbeToggle) {
        qualityProbeToggle.addEventListener('change', function (e) {
            localStorage.setItem('wdtvQualityProbeEnabled', e.target.checked ? 'true' : 'false');
            if (!e.target.checked) cancelQualityProbes();          // 关闭：立即停
            else armQualityProbeForVisibleCards();                 // 开启：对当前页已显示卡片补观察，无需重渲染
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
    // 清理搜索结果与进度提示（同时作废还在等封面尺寸的卡片）
    resetSearchCardMount(document.getElementById('results'));
    const searchProgress = document.getElementById('searchProgress');
    if (searchProgress) {
        searchProgress.textContent = '';
        searchProgress.style.display = 'none';
    }
    document.getElementById('searchInput').value = '';

    // 重置同名筛选状态
    lastSearchResults = [];
    currentNameFilter = '';
    // 重置翻页状态与当前页，收起分页栏
    searchPageState = {};
    searchResultKeys = new Set();
    currentResultPage = 1;
    clearResultsPagination();
    // 重置时长筛选（返回首页视为重新开始）
    durationFilter = { min: 0, max: Infinity };
    durationQueue = [];
    updateDurationFilterButtonState();
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

// 搜索结果翻页状态（分页展示 + 按源补抓后续页，抓取逻辑见 search.js fetchSearchPages）：
//   searchPageState       —— apiId -> { pageCount: 源总页数, fetchedThrough: 已抓到的最大页码 }
//   searchResultKeys      —— 已入列表结果的去重键（source_code_vod_id），翻页补抓时复用
//   currentSearchQuery    —— 本次搜索的关键词（翻页补抓同关键词的后续页）
//   currentSearchCacheKey —— 本次搜索的会话缓存键（补抓后同步更新缓存，避免丢页）
//   currentResultPage     —— 当前展示第几页（1 起）；新搜索/返回首页时重置为 1
//   paginationInFlight    —— 翻页补抓是否进行中（防止连点）
let searchPageState = {};
let searchResultKeys = new Set();
let currentSearchQuery = '';
let currentSearchCacheKey = '';
let currentResultPage = 1;
let paginationInFlight = false;
// 搜索结果每页展示条数（分页栏按此切分，见 config.js API_CONFIG.search.resultsPerPage）
const RESULTS_PER_PAGE = Math.max(1, Number(API_CONFIG.search.resultsPerPage) || 60);

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

    // 新搜索：中断上一轮在途画质探测（开关开启时才有在途任务，关闭时为空操作）
    cancelQualityProbes();

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
        // 每次新搜索先移除上一次残留的源健康度提示条（缓存命中路径不发请求，不重新显示）
        const staleHealthBanner = document.getElementById('sourceHealthBanner');
        if (staleHealthBanner && staleHealthBanner.parentNode) staleHealthBanner.parentNode.removeChild(staleHealthBanner);
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
                    // 恢复翻页状态：缓存命中时若源还有后续页，仍可“加载更多”补抓
                    searchPageState = {};
                    if (parsed.pageState && typeof parsed.pageState === 'object') {
                        Object.keys(parsed.pageState).forEach(id => {
                            const s = parsed.pageState[id];
                            if (s && typeof s.pageCount === 'number' && typeof s.fetchedThrough === 'number') {
                                searchPageState[id] = { pageCount: s.pageCount, fetchedThrough: s.fetchedThrough };
                            }
                        });
                    }
                    searchResultKeys = new Set(lastSearchResults.map(item => `${item.source_code}_${item.vod_id}`));
                    currentSearchQuery = query;
                    currentSearchCacheKey = cacheKey;
                    currentResultPage = 1;
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
        // 重置本次搜索的翻页状态与去重集合，回到第 1 页，并收起上一次搜索残留的分页栏
        searchPageState = {};
        searchResultKeys = new Set();
        currentSearchQuery = query;
        currentSearchCacheKey = cacheKey;
        currentResultPage = 1;
        clearResultsPagination();
        // 丢弃旧搜索遗留的时长探测任务（在途的随 AbortSignal 中断）；
        // 时长缓存与筛选条件保留——换关键词继续搜索时仍按原区间筛选
        durationQueue = [];
        const resultsDiv = document.getElementById('results');
        resetSearchCardMount(resultsDiv); // 清空并作废上一次搜索还在等封面尺寸的卡片
        showSearchSkeleton(resultsDiv, 8); // 真正等待首批结果时填充骨架屏，首张真卡入网格即移除
        const searchResultsCount = document.getElementById('searchResultsCount');
        if (searchResultsCount) searchResultsCount.textContent = 0;

        const total = selectedAPIs.length;
        let settled = 0;
        let renderTimer = null;
        let urlUpdated = false;
        let renderedCount = 0;               // 渐进渲染已追加的卡片数（增量追加，不重建已渲染部分）
        let finalRendered = false;           // 最终排序渲染是否已完成（决定迟到结果的渲染方式）
        // 去重集合用模块级 searchResultKeys（“加载更多”补抓时跨页继续复用）
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
            // 渐进渲染期间只展示第 1 页（分页栏在最终渲染时生成），超出的部分留给翻页
            const visible = Math.min(filtered.length, RESULTS_PER_PAGE);
            if (visible > renderedCount) {
                // 首批：清掉"正在搜索/无结果"占位并重置入队下标；后续批次按原下标接续
                if (renderedCount === 0) {
                    resetSearchCardMount(div);
                    // 卡片要等封面尺寸读到才会出现：第一张真正入网格时再收起遮罩，
                    // 避免遮罩一关露出空网格；本批一张都没能读出来（封面全失败）时，
                    // 队列排空后同样收起，不留死等
                if (loadingOwnerSeq === searchLoadingOwner) {
                    const closeLoading = () => {
                        clearSearchSkeleton(div); // 首张真卡入网格 / 队列排空时移除骨架屏
                        if (loadingOwnerSeq === searchLoadingOwner) hideLoading();
                    };
                    searchCardMount.onFirstMount = closeLoading;
                    searchCardMount.onIdle = closeLoading;
                }
                }
                queueSearchCards(div, filtered.slice(renderedCount, visible), renderedCount);
                renderedCount = visible;
            }
            updateProgressHint(settled < total ? `已搜索 ${settled}/${total} 个源，正在加载其余结果…` : '');
            // 提示条右侧「已就绪 N/M 个源」进度文案（与渐进渲染同步刷新）
            const sourceHealthReady = document.getElementById('sourceHealthReady');
            if (sourceHealthReady) sourceHealthReady.textContent = `已就绪 ${settled}/${total} 个源`;
            const count = document.getElementById('searchResultsCount');
            if (count) count.textContent = filtered.length;
        };
        const scheduleProgressiveRender = () => {
            if (renderTimer) return;
            renderTimer = setTimeout(renderProgressive, 250);
        };

        // 追加结果（同源 source_code+vod_id 去重）；最终渲染完成后改为全量重渲染以正确应用筛选
        const appendResults = (results) => {
            const fresh = results.filter(item => {
                const key = `${item.source_code}_${item.vod_id}`;
                if (searchResultKeys.has(key)) return false;
                searchResultKeys.add(key);
                return true;
            });
            if (fresh.length === 0) return;
            lastSearchResults = lastSearchResults.concat(fresh);
            updateUrlOnce();
            if (finalRendered) {
                // 最终渲染后到达的补页结果：按到达顺序追加到结果池末尾并重渲染当前页。
                // 不做任何重排序——已展示的视频排列保持不动，新视频只出现在后面
                renderFilteredSearchResults();
            }
            else scheduleProgressiveRender();
        };

        searchInProgress = true;

        // 源健康度阶梯停用：已被停用的源直接跳过本次搜索（不发起请求），
        // 结果区顶部显示非阻塞提示条，点击可打开设置面板手动恢复
        const disabledSources = (typeof isSourceUnhealthy === 'function')
            ? selectedAPIs.filter(apiId => isSourceUnhealthy(apiId)) : [];
        if (disabledSources.length > 0) {
            const area = document.getElementById('resultsArea');
            if (area) {
                const banner = document.createElement('div');
                banner.id = 'sourceHealthBanner';
                // 克制样式：半透明低饱和、无白色描边、不遮挡结果
                banner.style.cssText = 'display:flex;align-items:center;justify-content:space-between;'
                    + 'gap:12px;flex-wrap:wrap;margin:0 0 12px;padding:8px 14px;border-radius:8px;'
                    + 'background:rgba(140,130,110,0.12);color:var(--text-muted,#9ca3af);'
                    + 'font-size:0.8rem;line-height:1.5;cursor:pointer;user-select:none;';
                const bannerTip = document.createElement('span');
                bannerTip.textContent = `${disabledSources.length} 个源已临时停用（点击设置恢复）`;
                const bannerReady = document.createElement('span');
                bannerReady.id = 'sourceHealthReady';
                bannerReady.style.cssText = 'opacity:0.85;white-space:nowrap;';
                bannerReady.textContent = `已就绪 0/${total} 个源`;
                banner.appendChild(bannerTip);
                banner.appendChild(bannerReady);
                banner.addEventListener('click', function (e) {
                    // 打开设置面板前刷新徽章，确保显示最新健康状态
                    if (typeof initAPICheckboxes === 'function') initAPICheckboxes();
                    const panel = document.getElementById('settingsPanel');
                    if (typeof toggleSettings === 'function') {
                        if (!panel || !panel.classList.contains('show')) toggleSettings(e);
                        else if (e) { e.preventDefault(); e.stopPropagation(); }
                    }
                });
                area.insertBefore(banner, area.firstChild);
            }
        }

        // 从所有选中的 API 源搜索；已被阶梯停用的源跳过（返回空结果并计入进度，不发起请求）。
        // 第 2 页起由后台补页回调追加（见 search.js searchByAPIAndKeyWord）；
        // 回调第二参数 meta 携带该源总页数与已抓到的最大页码，驱动“加载更多”按钮显隐。
        // searchByAPIAndKeyWord 的调用参数与返回形状保持不变。
        const searchPromises = selectedAPIs.map(apiId => {
            if (disabledSources.indexOf(apiId) !== -1) {
                settled++; // 停用源无需请求，计入已处理，进度照常收敛
                return Promise.resolve([]);
            }
            return searchByAPIAndKeyWord(apiId, query, (additional, meta) => {
                if (seq !== searchSeq) return; // 已被更新的搜索取代
                if (Array.isArray(additional) && additional.length > 0) appendResults(additional);
                // 记录该源翻页状态（补页完成才可知总页数）；无 meta 按“无更多页”处理。
                // 分页栏随渲染更新，这里只需维护状态
                searchPageState[apiId] = (meta && typeof meta.pageCount === 'number')
                    ? { pageCount: meta.pageCount, fetchedThrough: meta.fetchedThrough }
                    : { pageCount: 1, fetchedThrough: 1 };
            }, searchSignal)
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
        // 搜索收尾时刷新提示条进度（覆盖「全部源被停用」导致渐进渲染未触发的场景）
        const finalSourceHealthReady = document.getElementById('sourceHealthReady');
        if (finalSourceHealthReady) finalSourceHealthReady.textContent = `已就绪 ${settled}/${total} 个源`;

        // 3) 全部完成：最终渲染（一次全量重建）。
        // 结果按到达顺序排列（不按名称重排）：后续补页只追加到池尾，
        // 已展示视频的顺序与所在页位置都不会变动
        let allResults = [...lastSearchResults];

        // 批次4 B1：URL 更新提到零结果 return 之前。app.js 是唯一 pushState 入口，
        // 从豆瓣卡片点进 0 结果关键词时若在此 return 前不更新，地址栏会停在旧 /s=。
        // updateUrlOnce 幂等：渐进阶段 appendResults 已写过则这里直接跳过，不会双推。
        updateUrlOnce();

        // 如果没有结果
        if (!allResults || allResults.length === 0) {
            resetSearchCardMount(resultsDiv);
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
            clearResultsPagination();
            return;
        }

        // 保存本次搜索结果，用于同名筛选，并写入会话缓存
        lastSearchResults = allResults;
        currentNameFilter = '';
        populateNameFilter(allResults);
        renderFilteredSearchResults();
        finalRendered = true;
        renderedCount = Math.min(allResults.length, RESULTS_PER_PAGE);

        // 会话缓存写入（大结果集同步 stringify 会阻塞渲染）移出关键路径；
        // pageState 一并写入，5 分钟内缓存命中后仍可继续翻页补抓后续页
        saveSearchPageCache();
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
            clearSearchSkeleton(document.getElementById('results')); // 异常/取消时兜底清骨架
            if (loadingOwnerSeq === searchLoadingOwner) hideLoading();
        }
    }
}

// 同名影视筛选：保存最近一次搜索结果与当前筛选的名称
let lastSearchResults = [];
let currentNameFilter = '';

// 转义结果卡片中使用的HTML特殊字符（文本节点 / 双引号属性上下文）。
// & 必须最先替换：否则后续生成的 &lt; / &quot; / &#39; 会被二次转义成 &amp;lt; 等；
// 补 ' → &#39; 覆盖「属性含单引号」与「值里带 '」的场景。
// 所有调用点传入的都是原始字段或归一模块的原始文本，不存在对已转义值二次转义（不会显示 &amp;lt;）。
function escapeResultText(text) {
    return (text || '').toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
    const fb = window.WDTVImageFallback;
    const original = img.getAttribute('data-original') || '';
    let rawUrl = original;
    try { rawUrl = original ? decodeURIComponent(original) : ''; } catch (e) { rawUrl = original; }
    // 统一降级链（直连 → 豆瓣 img9 归一 → /proxy/ → 占位图）交给模块 apply() 挂载，
    // 不再手写 onerror 逐级回退；耗尽时由 onfallback 切本地占位图。
    if (fb && typeof fb.apply === 'function' && original && !img.dataset.wdtvFallbackChain) {
        img.dataset.wdtvFallbackChain = '1';
        let exhausted = false;
        const toPlaceholder = () => {
            if (exhausted) return;
            exhausted = true;
            img.onerror = null;
            img.src = buildPlaceholderCover(img.getAttribute('alt') || '');
            img.classList.add('object-contain');
        };
        img.onfallback = toPlaceholder;
        // 模块耗尽时既派发 wdtv-image-exhausted 也调 onfallback，两路兜底并用幂等保护
        if (typeof img.addEventListener === 'function') {
            img.addEventListener('wdtv-image-exhausted', toPlaceholder, { once: true });
        }
        try {
            fb.apply(img, rawUrl);
            // 当前 img 已直连失败，apply 首级又是同一个直连 URL：直接推进一级，
            // 既不重复请求刚失败的 URL，也保证 onerror 链一定继续（避免同值 src 不重载卡死）
            if (typeof img.onerror === 'function') img.onerror();
            // 卡片封面原本立即加载，apply 默认补的 loading=lazy 会改变加载时机，这里恢复
            if (typeof img.removeAttribute === 'function') img.removeAttribute('loading');
            return;
        } catch (e) {
            // apply 异常：清标记回退到下方原有逻辑
            delete img.dataset.wdtvFallbackChain;
        }
    }
    // 模块缺失 / 异常：沿用原「直连 → 代理 → 占位图」逻辑
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

// 卡片尺寸已统一为固定 7:10 封面框（见 index.html），图片真实比例只用来决定
// 「铺满」还是「完整显示」：接近 7:10 的铺满裁边，9:16 竖版 / 16:9 横版改用
// object-fit:contain，保证整张图可见且不改变卡片大小。
function markCoverRatio(card, ratio) {
    if (!card) return;
    if (ratio >= 1) card.classList.add('cover-landscape');
    else if (ratio < 0.62) card.classList.add('cover-tall');
    else card.classList.add('cover-portrait');
}

// 封面尺寸兜底：主路径已改为入网格前由 measureCardCover 量好比例（见下方
// "封面尺寸就绪后才入网格"），这里仅处理图片事后重新加载（如代理重试成功）时
// 同步一次朝向类，保证图片填充方式与真实比例一致。
window.handleCoverLoaded = function (img) {
    try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) return;
        markCoverRatio(img.closest('.douban-card'), w / h);
    } catch (e) { /* 尺寸读取失败保持默认填充 */ }
};

// ===== 封面尺寸就绪后才入网格 =====
// 搜索接口只给封面地址、不给宽高。若先按固定比例插进网格、等图片加载完再改
// 比例，就会出现"先横版、加载后变竖版"的跳动（还会把整行顶高）。
// 这里改为：卡片先在文档外构建（其 <img> 会立即开始加载），读到真实宽高、标好
// 填充方式后再插入网格；读不到尺寸（防盗链失败、走完代理仍是占位图、
// 超时）的整条结果直接不展示。
// 插入严格按结果原下标顺序 flush：慢图只会拖住自己后面的卡，不会让后到的卡片
// 插到已展示的卡片前面造成整块位移。
const SEARCH_COVER_MEASURE_TIMEOUT = 5000; // 单张封面测量超时（毫秒），超时按读取失败处理

const searchCardMount = { seq: 0, next: 0, pending: new Map(), container: null, onFirstMount: null, onIdle: null };

// 由卡片 HTML 构建游离节点（不用 <template>：template 内容不加载图片，永远测不到尺寸）
function createResultCardElement(item) {
    const holder = document.createElement('div');
    holder.innerHTML = buildResultCard(item).trim();
    return holder.firstElementChild;
}

// 读取卡片封面真实宽高并标记填充方式，返回是否读取成功
function measureCardCover(cardEl) {
    const img = cardEl.querySelector('.douban-card-image img');
    if (!img) return Promise.resolve(false);
    // 有 data-original 说明这条结果本来有真实封面；没有则是本地占位图（已知 300×450）
    const hasRealCover = !!img.getAttribute('data-original');
    const applySize = () => {
        // 真实封面最终落到 data: 占位图，说明直连与代理都读不到——整条不展示
        if (hasRealCover && img.src.startsWith('data:')) return false;
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) return false;
        markCoverRatio(cardEl, w / h);
        return true;
    };
    if (img.complete && img.naturalWidth) return Promise.resolve(applySize());
    return new Promise(resolve => {
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            img.removeEventListener('load', onLoad);
            resolve(ok ? applySize() : false);
        };
        const onLoad = () => finish(true);
        // 只等 load：直连失败时 handleCoverLoadError 会先换代理、再换占位图，
        // 占位图同样会触发 load，由 applySize 里的 data: 判断兜底；这里不监听 error，
        // 否则首个 error 就会把还能走代理成功的封面判死
        const timer = setTimeout(() => finish(false), SEARCH_COVER_MEASURE_TIMEOUT);
        img.addEventListener('load', onLoad);
        if (img.complete) finish(img.naturalWidth > 0);
    });
}

// 清空网格并作废正在等待尺寸的上一批卡片（换搜索词/筛选/翻页/回首页时调用）
function resetSearchCardMount(container) {
    clearQualityProbeWatch(); // 断开上一批卡片的视口观察并清掉 500ms 待触发计时器
    searchCardMount.seq++;
    searchCardMount.pending.clear();
    searchCardMount.next = 0;
    searchCardMount.container = container || null;
    searchCardMount.onFirstMount = null;
    searchCardMount.onIdle = null;
    if (container) container.innerHTML = '';
}

// 按下标顺序把已测好的卡片插入网格
function flushSearchCardMount() {
    const st = searchCardMount;
    if (!st.container) return;
    for (;;) {
        const entry = st.pending.get(st.next);
        if (!entry || !entry.settled) return;
        st.pending.delete(st.next);
        if (entry.ok) {
            st.container.appendChild(entry.el);
            observeQualityProbeCard(entry.el); // 仅「开关开启 + 最终渲染」时挂视口观察
            if (st.onFirstMount) {
                const cb = st.onFirstMount;
                st.onFirstMount = null;
                st.onIdle = null;
                cb();
            }
        }
        st.next++;
    }
    // 队列里一张都没剩（全部测完/全部失败）：兜底通知一次，避免遮罩一直不关
    if (st.pending.size === 0 && st.onIdle) {
        const cb = st.onIdle;
        st.onIdle = null;
        st.onFirstMount = null;
        cb();
    }
}

// 入队一批结果：卡片先测尺寸，成功且轮到它时才进 DOM
function queueSearchCards(container, items, startIndex) {
    const seq = searchCardMount.seq;
    searchCardMount.container = container;
    items.forEach((item, i) => {
        const index = startIndex + i;
        const el = createResultCardElement(item);
        const entry = { el, settled: false, ok: false };
        searchCardMount.pending.set(index, entry);
        measureCardCover(el).then(ok => {
            if (seq !== searchCardMount.seq) return; // 已被新的渲染取代，丢弃
            entry.settled = true;
            entry.ok = ok;
            flushSearchCardMount();
        });
    });
}

// ===== 批次 2 · A1 跨源同名聚合：渲染层派生视图 =====
// 只把「当前页要展示的扁平结果」派生为分组视图供卡片生成使用；
// lastSearchResults / sessionStorage 缓存 / searchResultKeys 去重 / appendResults
// 全部保持扁平原样。WDTVGroup 缺失时静默降级为「每条一个单源组」，渲染链不中断。
function deriveGroupedResults(flatItems) {
    if (!Array.isArray(flatItems)) return [];
    const Group = window.WDTVGroup;
    if (Group && typeof Group.aggregateResults === 'function') {
        try {
            const groups = Group.aggregateResults(flatItems);
            if (Array.isArray(groups)) return groups;
        } catch (e) { /* 聚合异常降级为单源 */ }
    }
    return flatItems.map(item => ({
        key: `${(item && item.source_code) || ''}_${item && item.vod_id}`,
        name: item && item.vod_name,
        year: undefined,
        items: [item],
        remarks: undefined,
        pic: item && item.vod_pic,
        typeName: item && item.type_name
    }));
}

// 展开面板排序：优先用 WDTVQuality（另一组提供，可能不存在）的画质降序，
// 否则沿用 aggregateResults 已做好的 source_name 升序。模块缺失/异常静默降级，不报错。
function sortGroupItems(items) {
    const Q = window.WDTVQuality;
    if (Q) {
        try {
            // 组内有 item 带画质高度（探测回填）时按高度降序；无数据时退回 sortByQuality，
            // 后者缺少 entries 时按原相对顺序返回（即 aggregateResults 的 source_name 升序）。
            if (typeof Q.heightOf === 'function' &&
                items.some(it => typeof Q.heightOf(it) === 'number')) {
                return items.slice().sort((a, b) =>
                    (Number(Q.heightOf(b)) || 0) - (Number(Q.heightOf(a)) || 0));
            }
            if (typeof Q.sortByQuality === 'function') {
                // 传入画质探测缓存：展开面板下次打开时按已探明的高度降序（无数据时按 source_name 原序）
                const sorted = Q.sortByQuality(items.slice(), qualityProbeEntries);
                if (Array.isArray(sorted)) return sorted;
            }
        } catch (e) { /* 按源名顺序降级 */ }
    }
    return items.slice();
}

// 备注归一（typeof 防御，模块缺失回退原转义文案）
function formatCardRemarks(raw) {
    const R = window.WDTVRemarks;
    if (R && typeof R.formatRemarks === 'function') {
        try { return R.formatRemarks(raw) || ''; } catch (e) { /* 降级 */ }
    }
    return raw == null ? '' : String(raw);
}
function compactCardRemarks(raw) {
    const R = window.WDTVRemarks;
    if (R && typeof R.compactRemarks === 'function') {
        try { return R.compactRemarks(raw) || ''; } catch (e) { /* 降级 */ }
    }
    return raw == null ? '' : String(raw);
}

// 骨架屏：仅在新搜索真正等待首批卡片入网格时填充结果区，首张真卡入网格即移除。
// 结构复用真实卡片类名（7:10 封面框 + 标题文字块），具体样式由 index.html 内联段提供。
function showSearchSkeleton(container, count) {
    if (!container) return;
    const n = Math.max(1, Math.min(count || 8, 12));
    let html = '';
    for (let i = 0; i < n; i++) {
        html += `<div class="douban-card wdtv-skeleton-card" aria-hidden="true">
                    <div class="douban-card-image wdtv-skeleton-cover"></div>
                    <div class="douban-card-title-area wdtv-skeleton-lines">
                        <span class="wdtv-skeleton-line"></span>
                        <span class="wdtv-skeleton-line short"></span>
                    </div>
                  </div>`;
    }
    container.innerHTML = html;
}
function clearSearchSkeleton(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    container.querySelectorAll('.wdtv-skeleton-card').forEach(el => {
        if (el.parentNode) el.parentNode.removeChild(el);
    });
}

// 构建单个搜索结果卡片（兼容两种输入：分组视图 group 或扁平单条 item）
//  - 渐进渲染阶段传扁平 item：包装成单源组，外观与旧版一致（inline onclick 直接开详情）；
//  - 最终渲染阶段传 group：多源显示「N 源」角标 + 展开面板，单源行为不变。
// 卡片 DOM 的 data-key 仍用源内剧级键 ${source_code}_${vod_id}（时长探测定向更新依赖它），
// 与分组键 group.key（规范化片名派生）是两层，互不混用。
function buildResultCard(entry) {
    const group = (entry && Array.isArray(entry.items)) ? entry : {
        key: `${(entry && entry.source_code) || ''}_${entry && entry.vod_id}`,
        name: entry && entry.vod_name,
        year: undefined,
        items: [entry],
        remarks: undefined,
        pic: entry && entry.vod_pic,
        typeName: entry && entry.type_name
    };
    const items = (group.items && group.items.length ? group.items : [{}]).filter(Boolean);
    const primary = items[0] || {};
    const isMulti = items.length > 1;

    const safeId = primary.vod_id ? primary.vod_id.toString().replace(/[^\w-]/g, '') : '';
    const displayName = primary.vod_name || group.name;
    const safeName = escapeResultText(displayName);
    const sourceCode = primary.source_code || '';
    // 内联事件处理器里的单引号 JS 字符串：先做 JS 层转义（' → \x27、\ → \\ 等），
    // 再做 HTML 属性层转义。HTML 会把 &#39; 等实体解码回原字符，单靠 &#39; 放进
    // onclick="...'...'..." 仍会闭合 JS 字符串，故必须在 JS 层用 \x27 转义防注入。
    const jsStringAttr = (v) => escapeResultText(String(v == null ? '' : v)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, '\\x27')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029'));
    const jsName = jsStringAttr(displayName);
    const jsSourceCode = jsStringAttr(sourceCode);
    // 卡片定位键（与去重/时长缓存同格式）：探测完成后按 key 定向更新单张卡片
    const itemKey = `${primary.source_code || ''}_${primary.vod_id}`;

    // 封面：只放行 http(s) 图床地址与本地 data:image 占位图，其余协议（javascript: 等）
    // 一律回退占位图；属性值统一做属性上下文转义（& 先转义，浏览器解码后 URL 不受影响）。
    const placeholder = buildPlaceholderCover(displayName);
    const rawCover = String(primary.vod_pic || '').trim();
    const hasCover = /^https?:\/\//i.test(rawCover);
    // 渲染层再做一次图床域名归一：兼容 5 分钟 sessionStorage 搜索缓存中的旧域名数据
    const normalizedPic = hasCover ? normalizeRuyiPicUrl(rawCover) : '';
    const coverUrl = (hasCover && /^https?:\/\//i.test(String(normalizedPic || '').trim()))
        ? escapeResultText(normalizedPic) : escapeResultText(placeholder);
    // 原始封面地址存入 data 属性（encodeURIComponent 后无特殊字符，可安全内插），
    // 直连加载失败时由 handleCoverLoadError 取用并走降级链
    const coverOriginalAttr = hasCover ? ` data-original="${encodeURIComponent(normalizedPic)}"` : '';
    const safeTypeName = escapeResultText(primary.type_name || group.typeName);
    const safeSourceName = escapeResultText(primary.source_name);
    // 备注归一：多源用组内统一结论，单源用本条文案；模块缺失回退原文（仅转义）
    const remarksRaw = group.remarks || (primary && primary.vod_remarks) || '';
    const safeRemarks = escapeResultText(formatCardRemarks(remarksRaw));
    // 画质徽章：优先用已探明的内存缓存（翻页/筛选/补页整页重渲染后仍显示 1080P/4K，
    // 不退回 HD、不因 qualityProbeSeen 已标记而永不补探）。键形状与 applyQualityProbeResult
    // 写入一致：WDTVQuality.qualityKey = source:vodId（冒号，非 data-key 的下划线格式）。
    // 无有效探测结果（含测不出/失败无 label）时回退原有的备注/标题提取标签。
    const fallbackQualityTag = extractQualityTag([primary.vod_remarks, displayName]);
    const Q = window.WDTVQuality;
    let badgeState = '', badgeLabel = '', badgeTip = '';
    if (Q && qualityProbeEntries && typeof Q.qualityKey === 'function' &&
        typeof Q.isQualityEntryFresh === 'function' && typeof Q.describeQualityBadge === 'function') {
        const cacheKey = Q.qualityKey(primary.source_code || '', primary.vod_id || '');
        const probeEntry = qualityProbeEntries[cacheKey];
        if (probeEntry && Q.isQualityEntryFresh(probeEntry)) {
            // 第二参按条目「正在探测」状态传：探测中为 loading 态
            const probing = isQualityProbeProbing(primary.source_code || '', primary.vod_id || '');
            const desc = Q.describeQualityBadge(probeEntry, probing);
            if (desc) {
                badgeState = desc.state || desc.kind || '';
                badgeLabel = desc.label || '';
                badgeTip = desc.title || '';
            }
        }
    }
    // 失败 / 未知态：徽章可点「重试」（清 seen 后重新入队探测）
    const retryable = (badgeState === 'failed' || badgeState === 'unknown');
    const retryAttr = retryable ? ' data-quality-retry="1"' : '';
    let qualityBadgeHtml = '';
    if (badgeLabel && badgeState) {
        const tip = badgeTip ? ` title="${escapeResultText(badgeTip)}"` : '';
        qualityBadgeHtml = `<div class="wdtv-quality-badge wdtv-quality-probed" data-quality-state="${escapeResultText(badgeState)}"${retryAttr}${tip}>${escapeResultText(badgeLabel)}</div>`;
    } else if (badgeState === 'loading' || retryable) {
        qualityBadgeHtml = `<div class="wdtv-quality-badge wdtv-quality-probed" data-quality-state="${escapeResultText(badgeState)}"${retryAttr}>${badgeState === 'loading' ? '探测中…' : '未测到'}</div>`;
    } else if (fallbackQualityTag) {
        qualityBadgeHtml = `<div class="wdtv-quality-badge">${fallbackQualityTag}</div>`;
    }
    // 时长徽章：仅探测过的视频有值；未探测时元素保留但隐藏，探测完成后定向填充
    const durSec = getCachedDuration(primary);

    // 多源展开面板：每行一个来源，点击打开该源详情（复用 showDetails / hover 预取缓存），
    // 行点击 stopPropagation 防止连带触发整卡的展开/收起。
    const panelRows = isMulti ? sortGroupItems(items).map(it => {
        const sid = it.vod_id ? it.vod_id.toString().replace(/[^\w-]/g, '') : '';
        const rid = escapeResultText(sid);
        const rname = escapeResultText(it.vod_name || group.name);
        const rcode = escapeResultText(it.source_code || '');
        const rsource = escapeResultText(it.source_name || it.source_code || '未知来源');
        const rremarks = escapeResultText(compactCardRemarks(it.vod_remarks));
        const rquality = extractQualityTag([it.vod_remarks, it.vod_name]);
        return `
            <div class="wdtv-group-source" role="button" tabindex="0"
                 data-vod-id="${rid}" data-source-code="${rcode}" data-vod-name="${rname}"
                 title="${rsource}${rremarks ? ' · ' + rremarks : ''}">
                <span class="wdtv-group-source-name">${rsource}</span>
                ${rremarks ? `<span class="wdtv-group-source-remarks">${rremarks}</span>` : ''}
                <span class="wdtv-quality-badge">${rquality}</span>
            </div>`;
    }).join('') : '';

    // 多源不输出 inline onclick（展开/收起走 document 事件委托）；单源保留原有直接开详情。
    // 片名 / 来源码统一用 jsName / jsSourceCode（JS 字符串层已转义），杜绝单引号注入。
    // 点「重试」徽章时不要连带触发整卡 inline onclick 打开详情弹窗（重试逻辑走 document 委托）。
    const retryClickGuard = `if(event.target.closest&&event.target.closest('.wdtv-quality-badge[data-quality-retry]'))return;`;
    const clickAttr = isMulti ? '' : ` onclick="${retryClickGuard}showDetails('${safeId}','${jsName}','${jsSourceCode}')"`;
    const titleBtnClick = isMulti ? '' : ` onclick="event.stopPropagation(); showDetails('${safeId}','${jsName}','${jsSourceCode}')"`;

    return `
        <div class="douban-card flex flex-col cursor-pointer" data-key="${escapeResultText(itemKey)}"
             data-group-card="1" data-group-key="${escapeResultText(group.key)}"
             role="button" tabindex="0"${isMulti ? ' data-group-multi="1" aria-expanded="false"' : ''}${clickAttr}
             onmouseenter="prefetchDetail('${safeId}','${jsSourceCode}')">
            <div class="douban-card-image">
                <img src="${coverUrl}" alt="${safeName}"${coverOriginalAttr}
                     onload="handleCoverLoaded(this)"
                     onerror="handleCoverLoadError(this)"
                     referrerpolicy="no-referrer">
                <div class="absolute inset-0" style="background: linear-gradient(to top, rgba(0,0,0,0.6), transparent 50%); pointer-events: none;"></div>
                ${qualityBadgeHtml}
                ${isMulti ? `<div class="wdtv-group-badge">${items.length} 源</div>` : ''}
                <div class="wdtv-duration-badge"${durSec ? '' : ' style="display:none"'}>${durSec ? formatDuration(durSec) : ''}</div>
                <div class="absolute bottom-2 left-2 right-2 flex items-center justify-between gap-1.5">
                    ${safeSourceName ? `
                    <div class="douban-rate-badge truncate min-w-0" title="${safeSourceName}">
                        ${safeSourceName}
                    </div>
                    ` : ''}
                    ${safeTypeName ? `
                    <div class="douban-rate-badge truncate shrink-0" style="padding: 0.25rem 0.5rem; margin-left: auto;">
                        ${safeTypeName}
                    </div>
                    ` : ''}
                </div>
            </div>
            <div class="douban-card-title-area">
                <button${titleBtnClick}
                        class="text-sm font-medium truncate w-full transition"
                        style="color: #1d1d1f; background: transparent; border: none; cursor: pointer; padding: 0; font-size: 0.8rem; line-height: 1.25;"
                        title="${safeName}">
                    ${safeName}
                </button>
                ${safeRemarks ? `
                <div class="wdtv-remarks-badge" title="${safeRemarks}">${safeRemarks}</div>
                ` : ''}
            </div>
            ${isMulti ? `<div class="wdtv-group-panel" style="display:none">${panelRows}</div>` : ''}
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

// 当前筛选（同名筛选 + 屏蔽规则 + 时长区间）后的结果列表（分页与计数共用）
function getFilteredSearchResults() {
    const blockedKeywords = getBlockedTypeRuleKeywords();
    return lastSearchResults.filter(item => {
        if (currentNameFilter && (item.vod_name || '').trim() !== currentNameFilter) return false;
        if (isBlockedByTypeFilter(item, blockedKeywords)) return false;
        if (!isDurationMatch(item)) return false; // 已探明且不在时长区间内
        return true;
    });
}

// 根据当前名称筛选与屏蔽规则渲染「当前页」搜索结果，并刷新分页栏
function renderFilteredSearchResults() {
    const resultsDiv = document.getElementById('results');
    if (!resultsDiv) return;

    const filtered = getFilteredSearchResults();
    // 批次 2 / 必修 A1：先在「全部筛选结果」上派生分组，再按「组数」切页展示。
    // 这样跨第 60/61 条边界的同名条目合并进同一张卡（5 源而非 2 源/3 源），屏幕按组计数；
    // 扁平池 lastSearchResults / searchResultKeys 去重 / appendResults / 补抓仍按条推进。
    const groups = deriveGroupedResults(filtered);
    const totalPages = Math.max(1, Math.ceil(groups.length / RESULTS_PER_PAGE));
    if (currentResultPage > totalPages) currentResultPage = totalPages;
    const start = (currentResultPage - 1) * RESULTS_PER_PAGE;
    const pageGroups = groups.slice(start, start + RESULTS_PER_PAGE);
    // 当前页组展平回扁平条目：供时长探测 enqueueDurationProbes 与筛选计数使用，
    // 入参语义与旧版「当前页扁平 pageItems」一致（不改变 enqueueDurationProbes 形状）。
    const pageItems = [];
    pageGroups.forEach(g => {
        if (g && Array.isArray(g.items)) g.items.forEach(it => { if (it) pageItems.push(it); });
    });
    armQualityProbeRender(pageGroups); // 稳定的整页渲染入口：开关开启时建立 group.key -> items 映射

    if (pageItems.length === 0 && lastSearchResults.length > 0) {
        resetSearchCardMount(resultsDiv); // 同时作废上一页还在等封面尺寸的卡片
        resultsDiv.innerHTML = `
            <div class="col-span-full" style="text-align:center;padding:40px 0;color:var(--text-muted);font-size:0.9rem;">
                当前筛选条件下没有可显示的结果
            </div>
        `;
    } else {
        // 整页重建：卡片测好封面尺寸后才按顺序入网格（见 queueSearchCards）
        resetSearchCardMount(resultsDiv);
        queueSearchCards(resultsDiv, pageGroups, 0);
    }

    // 更新计数显示（筛选后的总条数，非组数 / 当前页条数）；标题补充「共 N 条」消歧，
    // 不改 HTML 结构，仅设置 title 属性。
    const searchResultsCount = document.getElementById('searchResultsCount');
    if (searchResultsCount) {
        searchResultsCount.textContent = filtered.length;
        searchResultsCount.title = `共 ${filtered.length} 条结果`;
    }

    renderResultsPagination(totalPages);

    // 时长筛选激活时：对当前页未探测的结果入队探测（探测完成定向更新卡片，
    // 全部探完后再整页重渲染归一化分页）
    if (isDurationFilterActive()) enqueueDurationProbes(pageItems);
}

// ===== 搜索结果分页（按页展示 + 按源补抓后续页）=====
// 首次搜索每源最多抓 maxPages 页（见 config.js），结果按到达顺序进入结果池；
// 前端按 resultsPerPage 切分页码展示。翻到尚未加载到的页时按源补抓后续页
// （每源每次最多 loadMorePages 页），所有源抓尽后分页栏不再扩展。

// 是否还有源的后续页未抓取
function hasMoreSourcePages() {
    return Object.keys(searchPageState).some(id => {
        const s = searchPageState[id];
        return !!s && s.pageCount > s.fetchedThrough;
    });
}

// 清空并隐藏分页栏
function clearResultsPagination() {
    const bar = document.getElementById('resultsPagination');
    if (!bar) return;
    bar.innerHTML = '';
    bar.style.display = 'none';
    bar.classList.remove('loading');
}

// 翻页补抓进行中的视觉状态（禁止连点 + 信息位提示）
function setPaginationLoading(loading) {
    const bar = document.getElementById('resultsPagination');
    if (!bar) return;
    bar.classList.toggle('loading', !!loading);
    const info = bar.querySelector('.wdtv-page-info');
    if (info) info.textContent = loading ? '加载中…' : (info.dataset.text || '');
}

// 渲染分页栏：页码信息 + 上一页 + 页码（多页时空隙用省略号收敛）+ 下一页
function renderResultsPagination(totalPages) {
    const bar = document.getElementById('resultsPagination');
    if (!bar) return;

    const more = hasMoreSourcePages();
    if (totalPages <= 1 && !more) { clearResultsPagination(); return; }
    bar.style.display = '';
    bar.classList.remove('loading');

    const page = currentResultPage;
    const info = `第 ${page} / ${totalPages} 页`;

    // 页码序列：始终含首页；页数多时当前页 ±2，其余空隙用省略号
    const seq = [1];
    if (totalPages > 7 && page > 4) seq.push('…');
    const winStart = Math.max(2, page - 2);
    const winEnd = Math.min(totalPages - 1, page + 2);
    for (let i = winStart; i <= winEnd; i++) seq.push(i);
    if (totalPages > 7 && page < totalPages - 3) seq.push('…');
    if (totalPages > 1) seq.push(totalPages);

    let html = `<span class="wdtv-page-info" data-text="${info}">${info}</span>`;
    html += `<button type="button" class="wdtv-page-btn wdtv-page-nav" onclick="goToResultPage(${page - 1})"${page <= 1 ? ' disabled' : ''}>上一页</button>`;
    seq.forEach(it => {
        if (it === '…') {
            html += `<span class="wdtv-page-ellipsis">…</span>`;
            return;
        }
        html += `<button type="button" class="wdtv-page-btn${it === page ? ' active' : ''}" onclick="goToResultPage(${it})">${it}</button>`;
    });
    // 已在最后一页但源还有后续页时，“下一页”保持可点（点击即补抓并前进）
    const nextDisabled = page >= totalPages && !more;
    html += `<button type="button" class="wdtv-page-btn wdtv-page-nav" onclick="goToResultPage(${page + 1})"${nextDisabled ? ' disabled' : ''}>下一页</button>`;
    bar.innerHTML = html;
}

// 跳转到指定页：目标页超出已加载结果时，先按源补抓后续页再展示
async function goToResultPage(pageNum) {
    const target = Math.max(1, parseInt(pageNum, 10) || 1);
    // 展示层按「组」切页（与 renderFilteredSearchResults 一致）。
    // 补抓/loadMore 仍按扁平结果推进：ensureResultsForPage 的 needed = 目标页 * RESULTS_PER_PAGE
    // 用的是扁平条数，翻页只是展示层按组切，两者互不干扰。目标展示页超出当前组页数且源还有
    // 后续页时，换算成「下一扁平页」补抓，补抓可能带来新组从而扩展展示页。
    const displayPages = Math.max(1, Math.ceil(deriveGroupedResults(getFilteredSearchResults()).length / RESULTS_PER_PAGE));

    if (target > displayPages && hasMoreSourcePages()) {
        const flatNextPage = Math.ceil(getFilteredSearchResults().length / RESULTS_PER_PAGE) + 1;
        const ok = await ensureResultsForPage(flatNextPage);
        if (!ok) return; // 已被新搜索取代，放弃本次跳转
    }

    // 抓取后组页数可能已增长；目标仍超界时收敛到最后一页
    const totalPages = Math.max(1, Math.ceil(deriveGroupedResults(getFilteredSearchResults()).length / RESULTS_PER_PAGE));
    currentResultPage = Math.min(target, totalPages);
    renderFilteredSearchResults();
    scrollToResultsTop();
}

// 补抓源后续页，直到已加载结果足够覆盖目标页（或所有源抓尽/无新结果入库）
async function ensureResultsForPage(targetPage) {
    if (paginationInFlight) return false;
    const needed = targetPage * RESULTS_PER_PAGE;
    const seq = searchSeq; // 迟到结果若已被新搜索取代则丢弃
    const signal = activeSearchController ? activeSearchController.signal : null;
    const batchPages = Math.max(1, Number(API_CONFIG.search.loadMorePages) || 1);

    paginationInFlight = true;
    setPaginationLoading(true);
    try {
        let guard = 0;
        while (getFilteredSearchResults().length < needed && hasMoreSourcePages() && guard++ < 10) {
            const targets = Object.keys(searchPageState).filter(id => {
                const s = searchPageState[id];
                return s && s.pageCount > s.fetchedThrough;
            });
            if (targets.length === 0) break;

            const batches = await Promise.all(targets.map(async id => {
                const s = searchPageState[id];
                const from = s.fetchedThrough + 1;
                const to = Math.min(s.pageCount, from + batchPages - 1);
                // fetchedThrough 为连续成功前缀的最大页码：某页抓取失败时指针停在该页之前，
                // 下次翻页会重试，避免失败页被永久跳过（见 search.js fetchSearchPages）
                const { items, fetchedThrough } = await fetchSearchPages(id, currentSearchQuery, from, to, signal);
                return { id, items, fetchedThrough };
            }));

            if (seq !== searchSeq) return false; // 新搜索已开始，丢弃本批结果

            let appended = 0;
            batches.forEach(({ id, items, fetchedThrough }) => {
                const s = searchPageState[id];
                if (s) s.fetchedThrough = Math.max(s.fetchedThrough, fetchedThrough);
                const fresh = (items || []).filter(item => {
                    const key = `${item.source_code}_${item.vod_id}`;
                    if (searchResultKeys.has(key)) return false;
                    searchResultKeys.add(key);
                    return true;
                });
                if (fresh.length > 0) {
                    // 按到达顺序追加到池尾：不做重排序，已有视频的排列保持不变
                    lastSearchResults = lastSearchResults.concat(fresh);
                    appended += fresh.length;
                }
            });

            if (appended === 0) break; // 没有新结果入库（抓取失败或已到底），避免空转
            saveSearchPageCache(); // 会话缓存同步更新（含翻页状态）
        }
        return true;
    } finally {
        paginationInFlight = false;
        if (seq === searchSeq) {
            setPaginationLoading(false);
            renderFilteredSearchResults(); // 补抓后重渲染（页数与当前页内容可能已变化）
        }
    }
}

// 翻页后把结果区顶部滚入视野
function scrollToResultsTop() {
    try {
        const area = document.getElementById('resultsArea');
        if (area && area.scrollIntoView) area.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { /* 滚动失败不影响翻页 */ }
}

// 会话缓存写入（含翻页状态）：首次搜索完成与翻页补抓后共用
function saveSearchPageCache() {
    if (!currentSearchCacheKey) return;
    runWhenIdle(() => {
        try {
            sessionStorage.setItem(currentSearchCacheKey, JSON.stringify({
                ts: Date.now(),
                results: lastSearchResults,
                pageState: searchPageState
            }));
        } catch (e) { /* 缓存写入失败不影响结果展示 */ }
    });
}

// ===== 视频时长探测与区间筛选 =====
// 搜索接口不返回时长：需要先拉详情拿播放地址，再解析 m3u8 分片累加得出
// （见 api.js fetchM3u8Duration / fetchMediaDurationByVideo）。为控制请求量：
//   - 仅探测「当前页可见」且未探测过的结果（翻页时按需扩展）；
//   - 并发 3，hover 预取过的详情直接复用，省一次详情请求；
//   - 以第一集时长作为该视频时长（系列剧集时长相近，逐集探测成本过高）；
//   - 探测失败记 -1（不反复重试拖死源站）；新搜索发起时在途探测随 AbortSignal 中断。
const durationCache = new Map();            // `${source}_${vod_id}` -> 秒；-1=失败；-2=探测中
const DURATION_CACHE_MAX = 500;
const DURATION_PROBE_CONCURRENCY = 3;
let durationFilter = { min: 0, max: Infinity };  // 秒；max=Infinity 表示不限
let durationQueue = [];
let durationProbeActive = 0;

function durationKeyOf(item) { return `${item.source_code || ''}_${item.vod_id}`; }

function isDurationFilterActive() {
    return durationFilter.min > 0 || durationFilter.max < Infinity;
}

// 已探明的时长（秒）；未探测/探测中/失败一律返回 null
function getCachedDuration(item) {
    const v = durationCache.get(durationKeyOf(item));
    return (typeof v === 'number' && v > 0) ? v : null;
}

// 秒 -> "m:ss" / "h:mm:ss"
function formatDuration(sec) {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// 解析时长输入："mm:ss" / "hh:mm:ss" / 纯秒数；空或非法返回 null
function parseDurationInput(str) {
    const s = (str || '').trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const parts = s.split(':');
    if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^\d{1,3}$/.test(p))) return null;
    const nums = parts.map(Number);
    if (nums.length === 2) return nums[0] * 60 + nums[1];
    return nums[0] * 3600 + nums[1] * 60 + nums[2];
}

// 时长是否落在筛选区间内（未探明/探测中暂不排除，探明后定向隐藏）
function isDurationMatch(item) {
    if (!isDurationFilterActive()) return true;
    const v = durationCache.get(durationKeyOf(item));
    if (typeof v !== 'number' || v <= 0) return true;
    return v >= durationFilter.min && v <= durationFilter.max;
}

// 探测入队：仅未探测过的项；已在队列/探明的跳过
function enqueueDurationProbes(items) {
    if (!isDurationFilterActive() || !Array.isArray(items)) return;
    const seq = searchSeq;
    const signal = activeSearchController ? activeSearchController.signal : null;
    let queued = 0;
    items.forEach(item => {
        const key = durationKeyOf(item);
        if (durationCache.has(key)) return;
        durationCache.set(key, -2); // 占位：探测中
        durationQueue.push({ item, key, seq, signal });
        queued++;
    });
    if (queued > 0) {
        updateDurationProbeProgress();
        pumpDurationProbes();
    }
}

// 探测泵：保持 DURATION_PROBE_CONCURRENCY 个在途；旧搜索的任务直接丢弃
function pumpDurationProbes() {
    while (durationProbeActive < DURATION_PROBE_CONCURRENCY && durationQueue.length > 0) {
        const task = durationQueue.shift();
        if (task.seq !== searchSeq) continue;
        durationProbeActive++;
        probeItemDuration(task).finally(() => {
            durationProbeActive--;
            // 队列与在途都清空（且仍属当前搜索）：整页重渲染一次，归一化分页与计数。
            // 注意必须在这里判断——probeItemDuration 内部 finally 执行时本次任务还没计数
            if (task.seq === searchSeq && durationQueue.length === 0 && durationProbeActive === 0) {
                renderFilteredSearchResults();
            }
            pumpDurationProbes();
        });
    }
}

async function probeItemDuration({ item, key, seq, signal }) {
    try {
        // hover 预取过的详情直接复用
        let detail = getPrefetchedDetail(String(item.vod_id), item.source_code);
        if (!detail) {
            detail = await fetchVideoDetailData({ id: String(item.vod_id), source: item.source_code, signal });
        }
        if (seq !== searchSeq) return; // 新搜索已开始，丢弃
        let seconds = null;
        if (detail && detail.code === 200 && Array.isArray(detail.episodes) && detail.episodes.length > 0) {
            const url = detail.episodes[0];
            if (/\.m3u8([?#]|$)/i.test(url)) {
                seconds = await fetchM3u8Duration(url, 0, signal);
            } else {
                seconds = await fetchMediaDurationByVideo(url);
            }
        }
        durationCache.set(key, (typeof seconds === 'number' && seconds > 0) ? Math.round(seconds) : -1);
    } catch (e) {
        if (e && e.name === 'AbortError') return; // 被新搜索中断：不写缓存，下次可重探
        durationCache.set(key, -1);
    } finally {
        trimDurationCache();
        if (seq === searchSeq) {
            updateDurationCard(key);
            updateDurationProbeProgress();
        }
    }
}

// 探测完成：只更新对应卡片（时长徽章 + 区间外隐藏），不整页重渲染，避免图片闪烁
function updateDurationCard(key) {
    const card = document.querySelector(`#results .douban-card[data-key="${cssEscapeAttr(key)}"]`);
    if (!card) return;
    const value = durationCache.get(key);
    const badge = card.querySelector('.wdtv-duration-badge');
    if (badge) {
        if (typeof value === 'number' && value > 0) {
            badge.textContent = formatDuration(value);
            badge.style.display = '';
        } else {
            badge.style.display = 'none';
        }
    }
    if (isDurationFilterActive() && typeof value === 'number' && value > 0) {
        card.style.display = (value >= durationFilter.min && value <= durationFilter.max) ? '' : 'none';
    } else {
        card.style.display = '';
    }
    // 同步计数（探测结果会改变区间内条数）
    const countEl = document.getElementById('searchResultsCount');
    if (countEl) countEl.textContent = getFilteredSearchResults().length;
}

// data-key 属性选择器转义（key 由 source_code + vod_id 组成，通常安全，仍做兜底）
function cssEscapeAttr(value) {
    return String(value).replace(/["\\]/g, '\\$&');
}

// ===== 批次 2 · A6 卡片画质探测（默认关闭；开启后才有网络请求）=====
// 开关关闭时：不创建队列、不创建 IntersectionObserver、不发任何请求。
// 开关开启时：卡片进视口延迟 500ms 入队 → 队列(并发≤2/每批≤8) → 解析 m3u8 master
// 的 RESOLUTION 短边 → 只定向更新徽章与内存缓存，不整页重渲染。
const QUALITY_PROBE_STORAGE = 'wdtvQualityProbeEnabled';
const QUALITY_PROBE_DELAY_MS = 500;           // 进视口后延迟入队（快速滚过不触发）
const QUALITY_PROBE_FETCH_TIMEOUT_MS = 4000;  // 单条探测总预算（详情 + 播放列表文本）
const QUALITY_PROBE_MAX_BYTES = 64 * 1024;    // 播放列表只读前 64KB

let qualityProbeEntries = {};                  // 内存缓存（mergeQualityEntries 维护，不写 sessionStorage）
let qualityProbeQueue = null;                 // 单例队列，懒创建
let qualityProbeObserver = null;              // 单例观察器，懒创建
let qualityProbeArmed = false;                // 仅「最终/筛选/翻页/缓存命中」整页渲染时为 true
let qualityProbeSession = null;               // 本轮搜索的 AbortController（新搜索/关开关时中断在途）
const qualityProbeTimers = new Map();         // el -> 500ms 延迟 timer
const qualityProbePageItems = new Map();      // data-group-key -> 组内 items
const qualityProbeSeen = new Set();           // 本轮已 push 过的 ${source_code}_${vod_id}，避免重渲染重复探测
const qualityProbeProbing = new Set();        // 正在探测的 ${source_code}_${vod_id}，供 loading 徽章

function isQualityProbeProbing(sourceKey, vodId) {
    return qualityProbeProbing.has(String(sourceKey || '') + '_' + String(vodId || ''));
}

function isQualityProbeEnabled() {
    return localStorage.getItem(QUALITY_PROBE_STORAGE) === 'true';
}

// 断开观察器与所有待触发计时器；不动已在队列里的请求（由 session abort / queue.cancel 收尾）
function clearQualityProbeWatch() {
    qualityProbeTimers.forEach(timer => clearTimeout(timer));
    qualityProbeTimers.clear();
    if (qualityProbeObserver) {
        qualityProbeObserver.disconnect();
        qualityProbeObserver = null;
    }
}

// 开关关闭 / 新搜索：完全停止本轮探测（撤观察 + settle 在途 + abort 在飞 fetch）
function cancelQualityProbes() {
    clearQualityProbeWatch();
    qualityProbeArmed = false;
    if (qualityProbeQueue) {
        const keys = [];
        qualityProbePageItems.forEach(items => items.forEach(it =>
            keys.push(`${(it && it.source_code) || ''}_${it && it.vod_id}`)));
        if (keys.length) { try { qualityProbeQueue.cancel(keys); } catch (e) { /* noop */ } }
    }
    qualityProbePageItems.clear();
    qualityProbeSeen.clear();
    qualityProbeProbing.clear();
    if (qualityProbeSession) {
        try { qualityProbeSession.abort(); } catch (e) { /* noop */ }
        qualityProbeSession = null;
    }
}

// 稳定的整页渲染入口：重建 group.key -> items 映射，并允许挂视口观察。
// 开关关闭时第一行即 return —— 连映射与 session 都不建，零额外开销。
function armQualityProbeRender(pageGroups) {
    qualityProbePageItems.clear();
    qualityProbeArmed = isQualityProbeEnabled();
    if (!qualityProbeArmed) return;
    if (!qualityProbeSession || qualityProbeSession.signal.aborted) {
        qualityProbeSession = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    }
    (Array.isArray(pageGroups) ? pageGroups : []).forEach(g => {
        if (g && Array.isArray(g.items)) qualityProbePageItems.set(String(g.key), g.items);
    });
}

// 开关刚开启、当前页已经渲染完时：不重渲染（避免封面重测闪烁），直接对已在 DOM 的卡片补观察。
// 用与 renderFilteredSearchResults 相同的切页逻辑重建 group.key -> items 映射，保证与卡片 data-group-key 一致。
function armQualityProbeForVisibleCards() {
    qualityProbeArmed = isQualityProbeEnabled();
    if (!qualityProbeArmed) return;
    // 搜索进行中不补观察：与 hover 预取「搜索中不预取」一致，避免搜索期间手动开开关立刻入队探测
    // 挤占连接池；等最终渲染完成由 armQualityProbeRender 接管。typeof 守卫兼容 Node 自测环境。
    if (typeof searchInProgress !== 'undefined' && searchInProgress) return;
    if (!qualityProbeSession || qualityProbeSession.signal.aborted) {
        qualityProbeSession = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    }
    qualityProbePageItems.clear();
    // 与 renderFilteredSearchResults 相同的「先派生分组、再按组切页」逻辑，
    // 保证 group.key -> items 映射与卡片 data-group-key 一致。
    const groups = deriveGroupedResults(getFilteredSearchResults());
    const start = (currentResultPage - 1) * RESULTS_PER_PAGE;
    groups.slice(start, start + RESULTS_PER_PAGE).forEach(g => {
        if (g && Array.isArray(g.items)) qualityProbePageItems.set(String(g.key), g.items);
    });
    const cards = document.querySelectorAll('#results .douban-card[data-group-card]');
    for (let i = 0; i < cards.length; i++) observeQualityProbeCard(cards[i]);
}

// 单例观察器：仅当开关开启且处于最终渲染时才可能被创建
function ensureQualityProbeObserver() {
    if (qualityProbeObserver) return qualityProbeObserver;
    if (typeof IntersectionObserver === 'undefined') return null;
    qualityProbeObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            const el = entry.target;
            if (entry.isIntersecting) {
                if (qualityProbeTimers.has(el)) return;
                const timer = setTimeout(() => {
                    qualityProbeTimers.delete(el);
                    if (!el.isConnected || !isQualityProbeEnabled()) return; // 卡片已重建 / 期间关了开关
                    if (qualityProbeObserver) qualityProbeObserver.unobserve(el); // 置位后断开
                    enqueueQualityProbeFromCard(el);
                }, QUALITY_PROBE_DELAY_MS);
                qualityProbeTimers.set(el, timer);
            } else {
                const timer = qualityProbeTimers.get(el);
                if (timer) { clearTimeout(timer); qualityProbeTimers.delete(el); } // 快速滚过不触发
            }
        });
    }, { rootMargin: '120px' });
    return qualityProbeObserver;
}

function observeQualityProbeCard(el) {
    if (!qualityProbeArmed || !isQualityProbeEnabled()) return; // 关闭/渐进阶段：不创建 observer、不发请求
    const observer = ensureQualityProbeObserver();
    if (observer && el && el.isConnected) observer.observe(el);
}

function enqueueQualityProbeFromCard(el) {
    const queue = getQualityProbeQueue();
    if (!queue) return;
    const gKey = el.getAttribute('data-group-key') || '';
    let items = qualityProbePageItems.get(gKey);
    if ((!items || !items.length) && el.dataset.key) {
        // 降级：映射缺失时从卡片 data-key（${source_code}_${vod_id}）还原单个 item
        const raw = el.dataset.key;
        const i = raw.indexOf('_');
        if (i > 0) items = [{ source_code: raw.slice(0, i), vod_id: raw.slice(i + 1) }];
    }
    if (!items || !items.length) return;
    const fresh = items.filter(it => {
        const k = `${(it && it.source_code) || ''}_${it && it.vod_id}`;
        if (qualityProbeSeen.has(k)) return false;
        qualityProbeSeen.add(k);
        return true;
    });
    if (!fresh.length) return;
    // 批次真正交给 run 时才回调：把这些条目标记为 probing 并定向刷成「探测中」徽章，
    // 排队期间不谎称探测中（WDTVProbeQueue.push 的第二参 onStart）
    const onStart = () => {
        fresh.forEach(it => {
            const sourceKey = String((it && it.source_code) || '');
            const vodId = String((it && it.vod_id) || '');
            qualityProbeProbing.add(sourceKey + '_' + vodId);
            updateQualityProbeBadge(sourceKey, vodId, null, true);
        });
    };
    // 结果在 qualityProbeRun → applyQualityProbeResult 里逐条消费，这里不 await
    queue.push(fresh, onStart).catch(() => {});
}

// 失败 / 未知态徽章点击「重试」：清掉该 key 的 seen 标记并重新入队该条目画质探测。
function retryQualityProbeFromCard(card) {
    if (!isQualityProbeEnabled() || !card) return;
    const raw = card.getAttribute('data-key') || '';
    const i = raw.indexOf('_');
    if (i <= 0) return;
    qualityProbeSeen.delete(raw);
    enqueueQualityProbeFromCard(card);
}

function getQualityProbeQueue() {
    if (qualityProbeQueue) return qualityProbeQueue;
    const PQ = window.WDTVProbeQueue;
    if (!PQ || typeof PQ.createProbeQueue !== 'function') return null;
    qualityProbeQueue = PQ.createProbeQueue({
        run: qualityProbeRun,
        concurrency: 2,      // 同时在飞的批次数（run 内串行 → 最多 2 个 HTTP 请求）
        batchSize: 8,        // 每批条目上限
        timeoutMs: 60000     // 8 条 × 4s 串行 + 余量（与 WDTVProbeQueue 默认看门狗一致）
    });
    return qualityProbeQueue;
}

// deps.run(items, onResult, signal)：逐条探测并逐条回传；失败静默、不阻断渲染。
// run 内串行处理，保证「并发 ≤2」是请求级而非仅批次级。
async function qualityProbeRun(items, onResult, signal) {
    const list = Array.isArray(items) ? items : [];
    for (let i = 0; i < list.length; i++) {
        const item = list[i] || {};
        const sourceKey = String(item.source_code || '');
        const vodId = String(item.vod_id || '');
        let result;
        try {
            const height = await probeItemHeight(item, signal);
            // 测不出（无 master / 非 m3u8）：无 height 无 error，quality.js 记为「未知」
            result = (typeof height === 'number' && height > 0)
                ? { sourceKey, vodId, height } : { sourceKey, vodId };
        } catch (e) {
            const aborted = !!(e && (e.name === 'AbortError' || /abort/i.test(e.message || '')));
            result = aborted
                ? { sourceKey, vodId, error: '探测已取消' }
                : { sourceKey, vodId, error: (e && e.message) || '探测失败' };
        }
        onResult(result);                  // 交给队列 settle
        applyQualityProbeResult(result);   // 同步写内存缓存 + 定向更新徽章
    }
}

// 单条探测：详情里的 m3u8 → /proxy/ 路径式拉文本前 64KB → 解析 RESOLUTION 短边
//（首集非 m3u8 时再试中间集，最多 2 次额外尝试；无 RESOLUTION 时用 BANDWIDTH 反推）。
// queueSignal(队列批次) + session(新搜索/关开关) + 4s 定时器三者都联动到同一个 controller。
async function probeItemHeight(item, queueSignal) {
    const id = String((item && item.vod_id) || '');
    const source = String((item && item.source_code) || '');
    if (!id || !source) return undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUALITY_PROBE_FETCH_TIMEOUT_MS);
    const sessionSignal = qualityProbeSession ? qualityProbeSession.signal : null;
    const onQueueAbort = () => controller.abort();
    const onSessionAbort = () => controller.abort();
    if (queueSignal) {
        if (queueSignal.aborted) controller.abort();
        else queueSignal.addEventListener('abort', onQueueAbort, { once: true });
    }
    if (sessionSignal) {
        if (sessionSignal.aborted) controller.abort();
        else sessionSignal.addEventListener('abort', onSessionAbort, { once: true });
    }
    try {
        // 优先复用 hover 预取详情，省一次详情请求；未命中才发（同样受 controller.signal 约束）
        // trackHealth:false —— 画质探测失败不应计入源健康度停用阶梯（与主代理 api.js 改动配合）
        let detail = getPrefetchedDetail(id, source);
        if (!detail) detail = await fetchVideoDetailData({ id, source, signal: controller.signal, trackHealth: false });
        const episodes = (detail && Array.isArray(detail.episodes)) ? detail.episodes : [];
        if (!episodes.length) return undefined;
        // 首集优先；首集非 m3u8（或拉不到文本）时再试中间一集，最多 2 次额外尝试
        const picks = [0];
        if (episodes.length > 1) {
            const mid = Math.floor(episodes.length / 2);
            if (mid !== 0 && picks.indexOf(mid) === -1) picks.push(mid);
            const late = Math.floor(episodes.length * 3 / 4);
            if (picks.length < 3 && late !== 0 && picks.indexOf(late) === -1) picks.push(late);
        }
        let text = '';
        for (let p = 0; p < picks.length; p++) {
            const first = String(episodes[picks[p]] || '');
            if (!first || !/\.m3u8([?#]|$)/i.test(first)) continue; // 非 m3u8 → 换下一集
            // 相对地址转绝对（参考 api.js resolveM3u8Url）
            let url = first;
            try { url = new URL(first, window.location.href).href; } catch (e) { url = first; }
            // 路径式 /proxy/${encodeURIComponent(url)}，绝不照抄 /api/proxy?url= 查询式
            const proxyUrl = PROXY_URL + encodeURIComponent(url);
            text = await fetchPlaylistPrefix(proxyUrl, controller.signal);
            if (text) break;
        }
        if (!text) return undefined;
        // master 列表：解析 #EXT-X-STREAM-INF 的 RESOLUTION=WxH，取短边（源站常把宽高写反），多档取最大短边
        const re = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)[xX](\d+)/g;
        let m, best;
        while ((m = re.exec(text)) !== null) {
            const shortSide = Math.min(Number(m[1]), Number(m[2]));
            if (shortSide > 0 && (best === undefined || shortSide > best)) best = shortSide;
        }
        // RESOLUTION 解析失败时，若 master 只给 BANDWIDTH，用码率反推高度（入参单位 bps）
        if (best === undefined) {
            const Q = window.WDTVQuality;
            if (Q && typeof Q.inferHeightFromBitrate === 'function') {
                const brRe = /#EXT-X-STREAM-INF:[^\n]*BANDWIDTH=(\d+)/gi;
                let bm, maxBitrate;
                while ((bm = brRe.exec(text)) !== null) {
                    const v = Number(bm[1]);
                    if (isFinite(v) && (maxBitrate === undefined || v > maxBitrate)) maxBitrate = v;
                }
                if (maxBitrate !== undefined) best = Q.inferHeightFromBitrate(maxBitrate);
            }
        }
        return best; // undefined = 无 master / 测不出（不引入 TS 版 SPS 解析）
    } finally {
        clearTimeout(timer);
        if (queueSignal) queueSignal.removeEventListener('abort', onQueueAbort);
        if (sessionSignal) sessionSignal.removeEventListener('abort', onSessionAbort);
    }
}

// 只读前 64KB 播放列表文本；支持 ReadableStream 提前 cancel，避免整段下载拖慢页面
async function fetchPlaylistPrefix(url, signal) {
    const resp = await fetch(url, { signal });
    if (!resp || !resp.ok) return '';
    if (resp.body && typeof resp.body.getReader === 'function') {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let text = '', received = 0;
        try {
            while (received < QUALITY_PROBE_MAX_BYTES) {
                const chunk = await reader.read();
                if (chunk.done) break;
                // 单个 chunk 可能超过剩余预算：按剩余字节截断，文本严格不超过 64KB
                const remaining = QUALITY_PROBE_MAX_BYTES - received;
                const value = chunk.value;
                const bytes = (typeof value.subarray === 'function' && value.length > remaining)
                    ? value.subarray(0, remaining) : value;
                text += decoder.decode(bytes, { stream: true });
                received += bytes.length;
                if (received >= QUALITY_PROBE_MAX_BYTES) break;
            }
            text += decoder.decode(); // flush 多字节字符
        } finally {
            try { reader.cancel(); } catch (e) { /* noop */ }
        }
        return text;
    }
    const all = await resp.text();
    return all.slice(0, QUALITY_PROBE_MAX_BYTES);
}

// 结果消费：mergeQualityEntries 维护内存缓存；只定向更新对应卡片徽章，不整页重渲染
function applyQualityProbeResult(result) {
    const Q = window.WDTVQuality;
    if (!Q || !result) return;
    const sourceKey = String(result.sourceKey || '');
    const vodId = String(result.vodId || '');
    // 探测结束：清 probing 标记（取消/中断同样要清，避免徽章永久停在「探测中」）
    qualityProbeProbing.delete(sourceKey + '_' + vodId);
    if (result.error && /取消|abort/i.test(result.error)) return; // 取消/中断不写缓存、不改徽章
    if (!sourceKey || !vodId) return;
    const cacheKey = (typeof Q.qualityKey === 'function')
        ? Q.qualityKey(sourceKey, vodId) : (sourceKey + ':' + vodId);
    const entry = { from: 'probe', timestamp: Date.now() };
    if (typeof result.height === 'number' && isFinite(result.height) && result.height > 0) {
        entry.height = result.height;
    } else if (result.error) {
        entry.error = String(result.error);
    }
    // 测不出（无 height 无 error）：quality.js 语义为「未知」，长 TTL 保留、不重试
    const incoming = {};
    incoming[cacheKey] = entry;
    qualityProbeEntries = (typeof Q.mergeQualityEntries === 'function')
        ? Q.mergeQualityEntries(qualityProbeEntries, incoming)
        : Object.assign({}, qualityProbeEntries, incoming);
    updateQualityProbeBadge(sourceKey, vodId, entry, false);
}

// 用现有 [data-key] 定向更新（参考 updateDurationCard）：只改文本/类，绝不整页重渲染。
// 多源组内非主 item 的 data-key 与主卡不一致，其结果仅进缓存，供展开面板下次打开按高度降序。
function updateQualityProbeBadge(sourceKey, vodId, entry, probing) {
    const Q = window.WDTVQuality;
    const card = document.querySelector(
        `#results .douban-card[data-key="${cssEscapeAttr(sourceKey + '_' + vodId)}"]`);
    if (!card) return;
    // 第二参按条目「正在探测」状态传：probing=true 时 describeQualityBadge 返回 loading 态
    const desc = (Q && typeof Q.describeQualityBadge === 'function')
        ? Q.describeQualityBadge(entry, !!probing) : null;
    if (!desc) return;
    const state = desc.state || desc.kind || 'value';
    const label = desc.label
        || (state === 'loading' ? '探测中…' : '')
        || ((state === 'failed' || state === 'unknown') ? '未测到' : '');
    if (!label) return; // 其余态无 label：保留原 extractQualityTag 文案，不抹掉
    let badge = card.querySelector('.wdtv-quality-badge');
    if (!badge) {
        badge = document.createElement('div');
        badge.className = 'wdtv-quality-badge';
        const image = card.querySelector('.douban-card-image');
        if (!image) return;
        image.appendChild(badge);
    }
    badge.textContent = label;                    // 文本
    badge.classList.add('wdtv-quality-probed');   // 类：标记为探测结果
    badge.setAttribute('data-quality-state', state);
    // 失败 / 未知态：标记可点「重试」；其余态清掉标记
    if (state === 'failed' || state === 'unknown') badge.setAttribute('data-quality-retry', '1');
    else if (typeof badge.removeAttribute === 'function') badge.removeAttribute('data-quality-retry');
    if (desc.title) badge.title = desc.title;
}

// 探测进度提示（复用搜索进度条位置）
function updateDurationProbeProgress() {
    const el = document.getElementById('searchProgress');
    if (!el) return;
    const pending = durationQueue.length + durationProbeActive;
    if (pending > 0) {
        el.textContent = `时长探测中… 剩余 ${pending} 个`;
        el.style.display = '';
    } else {
        el.textContent = '';
        el.style.display = 'none';
    }
}

// 探测缓存容量控制（Map 保持插入序，超量淘汰最早的）
function trimDurationCache() {
    while (durationCache.size > DURATION_CACHE_MAX) {
        const oldest = durationCache.keys().next().value;
        durationCache.delete(oldest);
    }
}

// ===== 时长筛选 UI =====
function toggleDurationFilterPop(event) {
    if (event) event.stopPropagation();
    const pop = document.getElementById('durationFilterPop');
    if (!pop) return;
    if (pop.classList.contains('hidden')) {
        // 先按按钮实际位置定位再展示：窄屏下工具栏会换行，按钮可能不在行尾，
        // 默认的 right:0 锚定会让浮层向左冲出屏幕
        positionDurationPop();
        pop.classList.remove('hidden');
    } else {
        pop.classList.add('hidden');
    }
}

// 浮层定位：贴在按钮下方，水平方向钳制在视口内。
// 优先与按钮左缘对齐；右侧超出时改右缘对齐；仍超出则贴视口左缘。
// （绝对定位的偏移父级是 .wdtv-duration-filter，需把视口坐标换算过去）
function positionDurationPop() {
    const pop = document.getElementById('durationFilterPop');
    const wrap = document.getElementById('durationFilter');
    const btn = document.getElementById('durationFilterBtn');
    if (!pop || !wrap || !btn || typeof btn.getBoundingClientRect !== 'function') return;

    const vw = (document.documentElement && document.documentElement.clientWidth) || window.innerWidth || 360;
    const margin = 8;
    const btnRect = btn.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const popW = pop.offsetWidth || 252;

    let left = btnRect.left;
    if (left + popW > vw - margin) left = btnRect.right - popW;
    if (left < margin) left = margin;

    pop.style.left = (left - wrapRect.left) + 'px';
    pop.style.right = 'auto';
}

function closeDurationFilterPop() {
    const pop = document.getElementById('durationFilterPop');
    if (pop) pop.classList.add('hidden');
}

// 应用时长区间筛选：立即按已有探测结果过滤，并对当前页未探测项入队探测
// （renderFilteredSearchResults 末尾会按当前页入队，这里只负责状态与重渲染）
function applyDurationFilter() {
    const min = parseDurationInput(document.getElementById('durationMinInput').value);
    const max = parseDurationInput(document.getElementById('durationMaxInput').value);
    if (min != null && max != null && max < min) {
        showToast('最长时长不能小于最短时长', 'warning');
        return;
    }
    durationFilter = { min: min || 0, max: max == null ? Infinity : max };
    closeDurationFilterPop();
    updateDurationFilterButtonState();
    renderFilteredSearchResults();
}

// 清除时长筛选：丢弃未执行的探测，恢复全部显示
function clearDurationFilter() {
    durationFilter = { min: 0, max: Infinity };
    durationQueue = [];
    const minInput = document.getElementById('durationMinInput');
    const maxInput = document.getElementById('durationMaxInput');
    if (minInput) minInput.value = '';
    if (maxInput) maxInput.value = '';
    closeDurationFilterPop();
    updateDurationFilterButtonState();
    renderFilteredSearchResults();
    updateDurationProbeProgress();
}

// 工具栏按钮激活态（有筛选条件时高亮）
function updateDurationFilterButtonState() {
    const btn = document.getElementById('durationFilterBtn');
    if (btn) btn.classList.toggle('active', isDurationFilterActive());
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
// 同时处理：时长筛选快捷预设（填入并应用）、时长浮层外部点击收起
document.addEventListener('click', (e) => {
    const item = e.target.closest('.wdtv-name-dropdown-item');
    if (item) {
        applyNameFilter(item.dataset.name || '', item.dataset.label || '');
        return;
    }
    // 时长筛选快捷预设：回填输入框并立即应用
    const preset = e.target.closest('.wdtv-duration-presets button');
    if (preset) {
        const minInput = document.getElementById('durationMinInput');
        const maxInput = document.getElementById('durationMaxInput');
        if (minInput) minInput.value = preset.dataset.min ? formatDuration(Number(preset.dataset.min)) : '';
        if (maxInput) maxInput.value = preset.dataset.max ? formatDuration(Number(preset.dataset.max)) : '';
        applyDurationFilter();
        return;
    }
    const dropdown = document.getElementById('nameDropdown');
    if (dropdown && !dropdown.contains(e.target)) {
        closeNameDropdown();
    }
    // 时长筛选浮层：点击浮层外部收起
    const durFilter = document.getElementById('durationFilter');
    if (durFilter && !durFilter.contains(e.target)) {
        closeDurationFilterPop();
    }
});

// ===== 批次 2 · A1/A7-a 分组卡片交互（document 事件委托，不新增 inline onclick）=====
// 多源卡片：整卡/角标/标题点击展开或收起来源面板；面板行点击打开对应源详情
// （复用 showDetails 既有 hover 预取缓存，不触发额外批量请求）。
// 单源卡片保留原有 inline onclick 直接开详情，这里不干预，避免重复触发。
document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target || !target.closest) return;
    const card = target.closest('.douban-card[data-group-card]');
    if (!card) return;
    // A6：失败 / 未知态徽章点「重试」→ 清 seen 后重新入队该条目画质探测
    const retryBadge = target.closest('.wdtv-quality-badge[data-quality-retry="1"]');
    if (retryBadge && card.contains(retryBadge)) {
        e.stopPropagation();
        e.preventDefault();
        retryQualityProbeFromCard(card);
        return;
    }
    const row = target.closest('.wdtv-group-source');
    if (row && card.contains(row)) {
        e.stopPropagation(); // 防止连带触发整卡的展开/收起
        const id = row.getAttribute('data-vod-id') || '';
        const name = row.getAttribute('data-vod-name') || '';
        const code = row.getAttribute('data-source-code') || '';
        if (id && code && typeof showDetails === 'function') showDetails(id, name, code);
        return;
    }
    // 单源卡片由 inline onclick 处理，不在此重复；仅多源卡片切换展开面板
    if (card.getAttribute('data-group-multi') === '1') {
        const panel = card.querySelector('.wdtv-group-panel');
        if (panel) {
            const open = panel.style.display !== 'none';
            panel.style.display = open ? 'none' : '';
            card.setAttribute('aria-expanded', open ? 'false' : 'true');
        }
    }
});

// A7-a：卡片 role=button + tabIndex=0 已可聚焦；Enter/Space 复用点击语义
// （card.click() 触发 inline onclick 或上面的 click 委托），无需重复存 id/name/source。
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const el = e.target;
    if (!el || !el.closest) return;
    const row = el.closest('.wdtv-group-source');
    if (row && el === row) { e.preventDefault(); row.click(); return; }
    const card = el.closest('.douban-card[data-group-card]');
    if (card && el === card) { e.preventDefault(); card.click(); }
});

// 窗口尺寸变化（如手机旋转）时，重新定位打开着的时长筛选浮层，防止冲出视口
window.addEventListener('resize', () => {
    const pop = document.getElementById('durationFilterPop');
    if (pop && !pop.classList.contains('hidden')) positionDurationPop();
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

        // 标题与来源名一律用 textContent 构造子节点：vod_name 来自卡片内联事件参数
        // （HTML 实体会被解码回原文），直接 innerHTML 会形成存储型 XSS，这里不再拼接任何 HTML 字符串。
        // 保留 break-words / wdtv-modal-source-name 两个类名，结构与旧版一致。
        modalTitle.textContent = '';
        const titleSpan = document.createElement('span');
        titleSpan.className = 'break-words';
        titleSpan.textContent = vod_name || '未知视频';
        modalTitle.appendChild(titleSpan);
        if (data.videoInfo && data.videoInfo.source_name) {
            modalTitle.appendChild(document.createTextNode(' '));
            const srcSpan = document.createElement('span');
            srcSpan.className = 'wdtv-modal-source-name';
            srcSpan.textContent = '(' + data.videoInfo.source_name + ')';
            modalTitle.appendChild(srcSpan);
        }
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
            // 空态组件接入：先清空再用 renderModalState 渲染规范空态；
            // states.js 未加载（renderModalState 为 no-op）时回退原有手写空态，行为不退化。
            modalContent.innerHTML = '';
            if (typeof renderModalState === 'function') {
                renderModalState('empty', '未找到播放资源', '该视频可能暂时无法播放，请尝试其他视频');
            }
            if (!modalContent.innerHTML.trim() && !modalContent.childElementCount) {
                modalContent.innerHTML = `
                    <div class="text-center py-8">
                        <div class="mb-2" style="color:#e57373;">❌ 未找到播放资源</div>
                        <div class="text-sm" style="color:rgba(180,200,230,0.65);">该视频可能暂时无法播放，请尝试其他视频</div>
                    </div>
                `;
            }
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

    // 双人共同观影：首页带 room 参数（从共看面板"搜索影片"进入）→ 播放跳转透传，
    // 回到播放页后 watch-party 自动重连房间并发起同步
    try {
        const wpRoom = new URLSearchParams(window.location.search).get('room');
        if (wpRoom && /^[A-Za-z0-9]{6}$/.test(wpRoom)) {
            playerUrl += `&room=${encodeURIComponent(wpRoom.toUpperCase())}`;
        }
    } catch (e) { }

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

