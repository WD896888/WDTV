// 全局变量
// 默认启用集合：配置里标记 disabled 的源保留用于回溯，但不参与默认选中与搜索。
const enabledAPIKeys = () => Object.keys(API_SITES).filter(k => API_SITES[k] && !API_SITES[k].disabled);
let selectedAPIs = (JSON.parse(localStorage.getItem('selectedAPIs') || 'null') || enabledAPIKeys())
    .filter(k => API_SITES[k] && !API_SITES[k].disabled);

// ===== 源等级（1 首选 / 2 常用 / 3 备用）=====
// 所有源都可分到三级，不再限制固定的 3 个优先源。
// 等级只用于组内来源排序（卡片主条目 / 换源顺序）。
// 搜索结果列表本身只按「片名与搜索词的关联度」排序，等级不影响列表顺序。
const SOURCE_TIER_MAX = (typeof window.SOURCE_TIER_LEVELS === 'number') ? window.SOURCE_TIER_LEVELS : 3;
const SOURCE_TIER_STORAGE_KEY = (typeof SOURCE_TIER_STORAGE === 'string' && SOURCE_TIER_STORAGE)
    ? SOURCE_TIER_STORAGE : 'wdtvSourceTiers';
const LEGACY_SOURCE_PRIORITY_KEY = (typeof LEGACY_SOURCE_PRIORITY_STORAGE === 'string' && LEGACY_SOURCE_PRIORITY_STORAGE)
    ? LEGACY_SOURCE_PRIORITY_STORAGE : 'wdtvSourcePriority';
const TIER_TITLES = { 1: '一级源（首选）', 2: '二级源（常用）', 3: '三级源（备用）' };
const TIER_LEVEL_LABELS = { 1: '一级', 2: '二级', 3: '三级' };
let sourceTierCache = null;

function normalizeSourceTier(value) {
    const n = parseInt(value, 10);
    return (n >= 1 && n <= SOURCE_TIER_MAX) ? n : SOURCE_TIER_MAX;
}

function defaultSourceTier(code) {
    const defaults = window.DEFAULT_SOURCE_TIERS;
    if (defaults && typeof defaults === 'object' && defaults[code] != null) {
        return normalizeSourceTier(defaults[code]);
    }
    return SOURCE_TIER_MAX;
}

function readStoredSourceTiers() {
    try {
        const raw = JSON.parse(localStorage.getItem(SOURCE_TIER_STORAGE_KEY) || 'null');
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    } catch (e) { /* 存储损坏按默认分级处理 */ }
    return null;
}

// 读取所有启用源的分级；没有新存储时先把老版「前三个优先源」迁移为一级源。
function loadSourceTiers() {
    if (sourceTierCache) return sourceTierCache;
    const valid = enabledAPIKeys();
    const validSet = new Set(valid);
    const stored = readStoredSourceTiers();
    const map = Object.create(null);
    let migrated = false;

    if (stored) {
        Object.keys(stored).forEach(k => {
            if (validSet.has(k)) map[k] = normalizeSourceTier(stored[k]);
        });
    } else {
        try {
            const legacy = JSON.parse(localStorage.getItem(LEGACY_SOURCE_PRIORITY_KEY) || '[]');
            if (Array.isArray(legacy) && legacy.length > 0) {
                legacy.forEach(k => {
                    if (typeof k === 'string' && validSet.has(k)) map[k] = 1;
                });
                migrated = true;
            }
        } catch (e) { /* 老存储损坏时直接走默认分级 */ }
    }

    let filled = false;
    valid.forEach(k => {
        if (map[k] == null) {
            map[k] = defaultSourceTier(k);
            filled = true;
        }
    });

    sourceTierCache = map;
    if (!stored || filled) {
        try {
            localStorage.setItem(SOURCE_TIER_STORAGE_KEY, JSON.stringify(map));
            if (migrated) localStorage.removeItem(LEGACY_SOURCE_PRIORITY_KEY);
        } catch (e) { /* 写入失败仅影响下次恢复 */ }
    }
    return map;
}

// 源等级：1 最高，3 最低；未设置的源按默认分级。
function getSourceTier(code) {
    if (!code) return SOURCE_TIER_MAX;
    const key = String(code);
    const map = loadSourceTiers();
    return map[key] != null ? normalizeSourceTier(map[key]) : defaultSourceTier(key);
}

// 四档优先级滑块：0 = 关闭，1-3 = 三/二/一级（滑块越满优先级越高）。
// 内部 tier 1 最高，所以开启时显示值取反（tier1 → 最右满格，tier3 → 第一档）。
function updateTierRange(range, tier) {
    const normalized = (tier === 0 || tier == null) ? 0 : normalizeSourceTier(tier);
    const value = normalized === 0 ? 0 : (SOURCE_TIER_MAX + 1 - normalized);
    range.value = String(value);
    const fill = SOURCE_TIER_MAX > 0 ? (value / SOURCE_TIER_MAX) * 100 : 0;
    range.style.setProperty('--tier-fill', fill + '%');
    range.setAttribute('aria-valuetext', normalized === 0 ? '已关闭' : (TIER_TITLES[normalized] || ''));
}

// 设置单个源的等级并持久化。
function setSourceTier(code, tier) {
    if (!code) return;
    const key = String(code);
    if (enabledAPIKeys().indexOf(key) === -1) return;
    const map = loadSourceTiers();
    map[key] = normalizeSourceTier(tier);
    sourceTierCache = map;
    try {
        localStorage.setItem(SOURCE_TIER_STORAGE_KEY, JSON.stringify(map));
    } catch (e) { /* 写入失败仅影响下次恢复 */ }
}

// 优先级视图滑块：0 = 关闭（移出选中集合），1-3 = 启用并对应三/二/一级。
// 关闭时保留已存等级，重新向右拖动可直接恢复原优先级。
function setSourceEnabled(code, enabled) {
    const key = String(code);
    const idx = selectedAPIs.indexOf(key);
    if (enabled && idx === -1) selectedAPIs.push(key);
    if (!enabled && idx !== -1) selectedAPIs.splice(idx, 1);
    try {
        localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));
    } catch (e) { /* 写入失败仅影响下次恢复 */ }
    updateSelectedApiCount();
}

// ===== 数据源视图：经典视图（默认）/ 优先级视图（仅本次打开设置内临时切换）=====
let sourceView = 'classic';

function getSourceView() {
    return sourceView;
}

// 视图选择不写入 localStorage：下次打开设置固定回到经典视图。
function setSourceView(view) {
    sourceView = view === 'priority' ? 'priority' : 'classic';
    return sourceView;
}

// 同步顶部视图按钮的激活状态与按钮组显隐（优先级视图没有复选框，不提供全选；
// 重置按钮只在优先级视图出现，用于恢复默认分级与选中集合）。
function syncSourceViewUI() {
    const view = getSourceView();
    document.querySelectorAll('.wdtv-view-btn').forEach(btn => {
        const active = btn.getAttribute('data-view') === view;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const actions = document.querySelector('.wdtv-source-actions');
    if (actions) actions.style.display = view === 'classic' ? '' : 'none';
    const resetWrap = document.querySelector('.wdtv-source-reset');
    if (resetWrap) resetWrap.style.display = view === 'priority' ? '' : 'none';
}

function initSourceViewToggle() {
    const buttons = Array.from(document.querySelectorAll('.wdtv-view-btn'));
    if (buttons.length === 0) return;
    buttons.forEach(btn => {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const view = btn.getAttribute('data-view') === 'classic' ? 'classic' : 'priority';
            if (view === getSourceView()) return;
            setSourceView(view);
            syncSourceViewUI();
            initAPICheckboxes();
        });
    });
    syncSourceViewUI();
}

// 同等级源按「本次搜索实测首包耗时」排序；未测到的源使用静态兜底顺序。
// 该耗时只存在内存：每次搜索重新测量，不写 localStorage、不影响源健康度。
const FALLBACK_SPEED_ORDER = ['ffzy', 'zy360', 'mdzy', 'maoyan', 'hhzy', 'jyzy', 'jisu', 'lzi', 'bfzy', 'tyyszy', 'zuid', 'juliang', 'wujin', 'ikun', 'ruyi'];
const sourceSearchLatency = Object.create(null);
function sourceSpeedMs(code) {
    const measured = sourceSearchLatency[String(code || '')];
    if (typeof measured === 'number' && isFinite(measured) && measured > 0) return measured;
    const i = FALLBACK_SPEED_ORDER.indexOf(String(code || ''));
    return i >= 0 ? 500 + i * 250 : 9999;
}

// 2026-11-09 补充线路：老用户 localStorage 的选中集合里没有新增的 6 条独立线路，
// 且可能残留早前误迁移写入的内置停用源 key。用一次性标记清理停用项并补齐新 key，
// 不改动用户对其它源的选择；之后仍完全由用户自行勾选/取消。
const EXTRA_SOURCE_KEYS = ['maoyan', 'jyzy', 'hhzy'];
const EXTRA_SOURCES_KEY = 'wdtvExtraSources_20261109';
if (!localStorage.getItem(EXTRA_SOURCES_KEY)) {
    const cleaned = selectedAPIs.filter(k => API_SITES[k] && !API_SITES[k].disabled);
    const missing = EXTRA_SOURCE_KEYS.filter(k =>
        API_SITES[k] && !API_SITES[k].disabled && cleaned.indexOf(k) === -1);
    selectedAPIs = cleaned.concat(missing);
    localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));
    localStorage.setItem(EXTRA_SOURCES_KEY, '1');
}

// 2026-11-21 新增可搜索源：老用户 selectedAPIs 中补齐，保留用户已取消勾选的既有源。
const EXTRA_SOURCE_KEYS_20261121 = ['bfzy', 'lzi', 'ikun', 'ruyi', 'tyyszy', 'zuid', 'juliang', 'wujin'];
const EXTRA_SOURCES_KEY_20261121 = 'wdtvExtraSources_20261121';
if (!localStorage.getItem(EXTRA_SOURCES_KEY_20261121)) {
    const cleaned = selectedAPIs.filter(k => API_SITES[k] && !API_SITES[k].disabled);
    const missing = EXTRA_SOURCE_KEYS_20261121.filter(k =>
        API_SITES[k] && !API_SITES[k].disabled && cleaned.indexOf(k) === -1);
    selectedAPIs = cleaned.concat(missing);
    localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));
    localStorage.setItem(EXTRA_SOURCES_KEY_20261121, '1');
}

// 2026-11-22 源集合调整：移除黑木耳/速博，新增天涯。一次性清理已移除的 key 并补齐天涯，
// 保留用户对其它源的勾选状态。
const SOURCE_SET_20261122_KEY = 'wdtvSourceSet_20261122';
if (!localStorage.getItem(SOURCE_SET_20261122_KEY)) {
    const cleaned = selectedAPIs.filter(k => API_SITES[k] && !API_SITES[k].disabled);
    if (API_SITES.tyyszy && !API_SITES.tyyszy.disabled && cleaned.indexOf('tyyszy') === -1) {
        cleaned.push('tyyszy');
    }
    selectedAPIs = cleaned;
    localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));
    localStorage.setItem(SOURCE_SET_20261122_KEY, '1');
}

// 2026-11-21 新增最大资源：一次性补入老用户 selectedAPIs，保留其它源勾选状态。
const SOURCE_SET_ZUID_KEY = 'wdtvSourceSet_zuid_20261121';
if (!localStorage.getItem(SOURCE_SET_ZUID_KEY)) {
    const cleaned = selectedAPIs.filter(k => API_SITES[k] && !API_SITES[k].disabled);
    if (API_SITES.zuid && !API_SITES.zuid.disabled && cleaned.indexOf('zuid') === -1) {
        cleaned.push('zuid');
    }
    selectedAPIs = cleaned;
    localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));
    localStorage.setItem(SOURCE_SET_ZUID_KEY, '1');
}

// 2026-11-21 新增巨量、无尽：一次性补入老用户 selectedAPIs，保留其它源勾选状态。
// 茅台已被无尽替换，旧 key 会在 filter(API_SITES) 时自动移除。
const SOURCE_SET_JM_KEY = 'wdtvSourceSet_juliang_wujin_20261121';
if (!localStorage.getItem(SOURCE_SET_JM_KEY)) {
    const cleaned = selectedAPIs.filter(k => API_SITES[k] && !API_SITES[k].disabled);
    ['juliang', 'wujin'].forEach(k => {
        if (API_SITES[k] && !API_SITES[k].disabled && cleaned.indexOf(k) === -1) cleaned.push(k);
    });
    selectedAPIs = cleaned;
    localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));
    localStorage.setItem(SOURCE_SET_JM_KEY, '1');
}

// 2026-11-10 数据源订阅下线：清理老用户本地残留的订阅条目与订阅导入的源 key。
// 源集合自此完全以 config.js 的 API_SITES 为准，页面不再加载订阅模块。
const SUBSCRIPTION_OFF_KEY = 'wdtvSubscriptionsOff_20261110';
if (!localStorage.getItem(SUBSCRIPTION_OFF_KEY)) {
    try {
        localStorage.removeItem('wdtvSourceSubscriptions');
        const builtInOnly = selectedAPIs.filter(k => API_SITES[k]);
        if (builtInOnly.length !== selectedAPIs.length) {
            selectedAPIs = builtInOnly;
            localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));
        }
        localStorage.setItem(SUBSCRIPTION_OFF_KEY, '1');
    } catch (e) { /* localStorage 不可写时静默跳过，不影响看片 */ }
}

// 豆瓣热门推荐默认关闭：旧版本曾默认开启，升级后一次性关闭，之后尊重用户手动开关。
// 必须放在顶层（早于 DOMContentLoaded），确保 douban.js 初始化开关时读到 false。
try {
    if (!localStorage.getItem('wdtvDoubanDefaultOff_v1')) {
        localStorage.setItem('doubanEnabled', 'false');
        localStorage.setItem('wdtvDoubanDefaultOff_v1', '1');
    }
} catch (e) { /* 存储不可用时按默认关闭处理 */ }

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
    // 设置默认API选择（v3 迁移：默认全选所有启用源，已停用源由 filter 自动排除）
    if (!localStorage.getItem('hasInitializedDefaults_v4')) {
        // 默认选中所有可用资源（已停用源不参与）
        selectedAPIs = enabledAPIKeys();
        localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));

        // 默认选中过滤开关
        localStorage.setItem(PLAYER_CONFIG.adFilteringStorage, 'true');

        // 默认关闭豆瓣功能
        localStorage.setItem('doubanEnabled', 'false');

        // 标记已初始化默认值
        localStorage.setItem('hasInitializedDefaults_v4', 'true');
    }

    // 初始化API复选框
    initAPICheckboxes();
    // 数据源视图切换：经典视图（默认）/ 优先级视图（临时调整）
    initSourceViewToggle();

    // 初始化显示选中的API数量
    updateSelectedApiCount();

    // 渲染搜索历史
    renderSearchHistory();

    // 设置广告过滤开关初始状态
    const adFilterToggle = document.getElementById('adFilterToggle');
    if (adFilterToggle) {
        adFilterToggle.checked = localStorage.getItem(PLAYER_CONFIG.adFilteringStorage) !== 'false'; // 默认为true
    }

    // 设置广告自动跳过开关初始状态（默认开启：无值写入 true，仅显式 false 视为关闭）
    // 旧版本首次加载会强制写入 'false'，升级后用一次性迁移键把这类历史默认值改为开启；
    // 迁移完成后用户手动关闭仍会保持关闭。
    if (!localStorage.getItem('wdtvAdAutoSkipDefaultMigrated_v1')) {
        if (localStorage.getItem(PLAYER_CONFIG.adAutoSkipStorage) === null
            || localStorage.getItem(PLAYER_CONFIG.adAutoSkipStorage) === 'false') {
            localStorage.setItem(PLAYER_CONFIG.adAutoSkipStorage, 'true');
        }
        localStorage.setItem('wdtvAdAutoSkipDefaultMigrated_v1', 'true');
    }
    const adAutoSkipToggle = document.getElementById('adAutoSkipToggle');
    if (adAutoSkipToggle) {
        adAutoSkipToggle.checked = localStorage.getItem(PLAYER_CONFIG.adAutoSkipStorage) !== 'false';
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

    // 备用线路切换开关初始状态（默认关闭：关闭时播放页不显示线路按钮）
    const routeSwitchToggle = document.getElementById('routeSwitchToggle');
    if (routeSwitchToggle) {
        routeSwitchToggle.checked = localStorage.getItem('wdtvRouteSwitchEnabled') === 'true';
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

    // 搜索列表画质探测已下线：真实分辨率探测迁移到播放页「换源」面板。

    // 设置事件监听器
    setupEventListeners();

    // 数据源订阅功能已下线（v97）：源集合完全由 config.js 内置维护，
    // 页面不再加载订阅模块，也不再提供任何用户自定义接入数据源的入口。
});

// 源健康度徽章：优先级视图内联在源名右侧，经典视图放在勾选项右侧。
function appendSourceHealthBadge(container, apiKey, inline) {
    const healthStatus = (typeof window.getSourceHealthStatus === 'function')
        ? window.getSourceHealthStatus(apiKey) : null;
    if (!healthStatus) return;
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
    if (!badgeText) return;
    const badge = document.createElement('span');
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:4px;'
        + (inline ? 'flex-shrink:0;margin-left:6px;' : 'align-self:flex-start;margin-top:2px;')
        + 'padding:1px 6px;border-radius:6px;'
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
    container.appendChild(badge);
}

// 数据源列表：
//   classic  —— 经典双列视图（默认）：一排两个源，无滑块，顺序同样按优先级（关闭沉底）；
//   priority —— 临时优先级视图：每行一个源 + 0-3 四档滑块（0 关闭），按等级排序。
function initAPICheckboxes() {
    const container = document.getElementById('apiCheckboxes');
    if (!container) return;
    container.innerHTML = '';

    const keys = Object.keys(API_SITES).filter(k => API_SITES[k] && !API_SITES[k].disabled);
    const view = getSourceView();

    // 两种视图共用同一优先级顺序：启用的源按 1→3 级在前，关闭（滑块 0）的源沉底，
    // 同等级保持 API_SITES 原始顺序。
    const order = Object.create(null);
    keys.forEach((k, i) => { order[k] = i; });
    const sortedKeys = keys.slice().sort((a, b) =>
        ((selectedAPIs.includes(a) ? 0 : 1) - (selectedAPIs.includes(b) ? 0 : 1)) ||
        (getSourceTier(a) - getSourceTier(b)) || (order[a] - order[b]));

    if (view === 'classic') {
        const grid = document.createElement('div');
        grid.className = 'grid grid-cols-2 gap-2';
        sortedKeys.forEach(apiKey => {
            const api = API_SITES[apiKey];
            const item = document.createElement('div');
            item.className = 'flex items-center wdtv-source-classic';
            item.setAttribute('data-api-row', apiKey);

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.id = 'api_' + apiKey;
            input.className = 'form-checkbox text-blue-600 wdtv-source-check';
            input.checked = selectedAPIs.includes(apiKey);
            input.setAttribute('data-api', apiKey);
            input.addEventListener('change', updateSelectedAPIs);
            item.appendChild(input);

            const label = document.createElement('label');
            label.className = 'ml-1 text-xs text-gray-600 truncate';
            label.setAttribute('for', input.id);
            label.textContent = api.name || apiKey;
            item.appendChild(label);
            appendSourceHealthBadge(item, apiKey, true);
            grid.appendChild(item);
        });
        container.appendChild(grid);
        syncSourceViewUI();
        return;
    }

    // 优先级视图：一级在前，同等级保持 API_SITES 原始顺序；关闭（滑块 0）的源沉底。
    const list = document.createElement('div');
    list.className = 'wdtv-source-list';
    sortedKeys.forEach(apiKey => {
        const api = API_SITES[apiKey];
        const enabled = selectedAPIs.includes(apiKey);
        const tier = enabled ? getSourceTier(apiKey) : 0;

        const row = document.createElement('div');
        row.className = 'wdtv-source-row' + (enabled ? '' : ' is-off');
        row.setAttribute('data-tier', String(tier));
        row.setAttribute('data-api-row', apiKey);

        const head = document.createElement('div');
        head.className = 'wdtv-source-head';
        const name = document.createElement('span');
        name.className = 'wdtv-source-name';
        name.textContent = api.name || apiKey;
        head.appendChild(name);
        appendSourceHealthBadge(head, apiKey, true);

        const level = document.createElement('span');
        level.className = 'wdtv-source-level';
        level.textContent = tier === 0 ? '关闭' : TIER_LEVEL_LABELS[tier];
        head.appendChild(level);
        row.appendChild(head);

        // 四档滑块：0 = 关闭，1-3 = 三/二/一级优先级，滑块占满整行
        const sliderBox = document.createElement('div');
        sliderBox.className = 'wdtv-source-slider';

        const range = document.createElement('input');
        range.type = 'range';
        range.className = 'wdtv-tier-range';
        range.min = '0';
        range.max = String(SOURCE_TIER_MAX);
        range.step = '1';
        range.setAttribute('data-api-tier', apiKey);
        range.setAttribute('aria-label', (api.name || apiKey) + ' 启用与优先级');
        updateTierRange(range, tier);
        range.addEventListener('input', function () {
            const value = parseInt(range.value, 10) || 0;
            const isEnabled = value > 0;
            const nextTier = isEnabled ? (SOURCE_TIER_MAX + 1 - value) : 0;
            if (isEnabled) setSourceTier(apiKey, nextTier);
            setSourceEnabled(apiKey, isEnabled);
            row.setAttribute('data-tier', String(nextTier));
            row.classList.toggle('is-off', !isEnabled);
            level.textContent = nextTier === 0 ? '关闭' : TIER_LEVEL_LABELS[nextTier];
            updateTierRange(range, nextTier);
        });
        range.addEventListener('change', function () {
            // 松手后按新优先级重排列表，并重渲染当前搜索结果（组内主源可能变化）
            if (getSourceView() === 'priority') {
                const scrollTop = container.scrollTop;
                const prevRects = new Map();
                container.querySelectorAll('.wdtv-source-row').forEach(row => {
                    prevRects.set(row.getAttribute('data-api-row'), row.getBoundingClientRect());
                });
                initAPICheckboxes();
                container.scrollTop = scrollTop;
                animateSourceReorder(container, prevRects);
            }
            if (lastSearchResults.length > 0) renderFilteredSearchResults();
        });
        sliderBox.appendChild(range);

        // 0-3 刻度：小字号低对比，只作等级参照，不抢滑块视觉
        const scale = document.createElement('div');
        scale.className = 'wdtv-tier-scale';
        scale.setAttribute('aria-hidden', 'true');
        for (let i = 0; i <= SOURCE_TIER_MAX; i++) {
            const tick = document.createElement('span');
            tick.textContent = String(i);
            scale.appendChild(tick);
        }
        sliderBox.appendChild(scale);

        row.appendChild(sliderBox);
        list.appendChild(row);
    });
    container.appendChild(list);
    syncSourceViewUI();
}

// 优先级重排动画（FLIP）：重渲染前记录每行位置，渲染后让移动的行从旧位置
// 平滑滑到新位置，避免等级变化时列表瞬间跳变。
function animateSourceReorder(container, prevRects) {
    if (!prevRects || prevRects.size === 0) return;
    container.querySelectorAll('.wdtv-source-row').forEach(row => {
        const prev = prevRects.get(row.getAttribute('data-api-row'));
        if (!prev || typeof row.animate !== 'function') return;
        const offsetY = prev.top - row.getBoundingClientRect().top;
        if (Math.abs(offsetY) < 0.5) return;
        row.animate(
            [
                { transform: 'translateY(' + offsetY + 'px)' },
                { transform: 'translateY(0)' }
            ],
            {
                duration: 380,
                easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)'
            }
        );
    });
}

// 更新选中的API列表
function updateSelectedAPIs() {
    // 获取所有API复选框（配置层已停用的源不可勾选，天然排除）
    const builtInApiCheckboxes = document.querySelectorAll('#apiCheckboxes input:checked:not(:disabled)');

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

// 全选或取消全选 API（经典视图的复选框列表）
function selectAllAPIs(selectAll = true) {
    const checkboxes = document.querySelectorAll('#apiCheckboxes input[type="checkbox"]');

    checkboxes.forEach(checkbox => {
        // 配置层停用/健康度禁用的源不参与全选
        if (checkbox.disabled) {
            checkbox.checked = false;
            return;
        }
        checkbox.checked = selectAll;
    });

    updateSelectedAPIs();
}

// 优先级视图的「重置」：清空源分级与老版优先源存储，恢复默认分级与默认选中集合。
function resetSourceSettings() {
    sourceTierCache = null;
    try {
        localStorage.removeItem(SOURCE_TIER_STORAGE_KEY);
        localStorage.removeItem(LEGACY_SOURCE_PRIORITY_KEY);
    } catch (e) { /* 存储不可用时只影响持久化，不影响本次会话 */ }
    selectedAPIs = enabledAPIKeys();
    try {
        localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));
    } catch (e) { /* 写入失败仅影响下次恢复 */ }
    const keys = enabledAPIKeys();
    if (window.SourceHealth && typeof window.SourceHealth.clear === 'function') {
        keys.forEach(k => {
            try { window.SourceHealth.clear(k); } catch (e) { /* 单源清理失败不影响其它源 */ }
        });
    }
    initAPICheckboxes();
    updateSelectedApiCount();
    if (lastSearchResults.length > 0) renderFilteredSearchResults();
    if (typeof showToast === 'function') showToast('数据源已恢复默认状态', 'success');
}

function toggleSettings(e) {
    const settingsPanel = document.getElementById('settingsPanel');
    if (!settingsPanel) return;

    if (settingsPanel.classList.contains('show')) {
        settingsPanel.classList.remove('show');
    } else {
        // 优先级视图只是临时调整：每次打开设置都恢复默认的经典视图
        if (getSourceView() !== 'classic') {
            setSourceView('classic');
            initAPICheckboxes();
        }
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

    // 备用线路切换开关：写入 'true'/'false'，播放页按此决定是否显示「线路」按钮
    const routeSwitchToggle = document.getElementById('routeSwitchToggle');
    if (routeSwitchToggle) {
        routeSwitchToggle.addEventListener('change', function (e) {
            const on = !!e.target.checked;
            localStorage.setItem('wdtvRouteSwitchEnabled', on ? 'true' : 'false');
            showToast(on ? '已开启备用线路切换：播放页显示线路按钮' : '已关闭备用线路切换', 'success');
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
    // 清理搜索结果与进度提示（同时作废上一批渲染回调）
    resetSearchCardMount(document.getElementById('results'));
    const searchProgress = document.getElementById('searchProgress');
    if (searchProgress) {
        searchProgress.textContent = '';
        searchProgress.style.display = 'none';
    }
    document.getElementById('searchInput').value = '';

    // 重置同名筛选状态
    lastSearchResults = [];
    resetSearchGroupOrder();
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
const RESULTS_PER_PAGE = Math.max(1, Number(API_CONFIG.search.resultsPerPage) || 120);

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
                    lastSearchResults = (typeof filterAdultSearchItems === 'function')
                        ? filterAdultSearchItems(parsed.results) : parsed.results;
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
                    // 恢复上次停留的页码（渲染函数会对超界页码做 clamp）
                    currentResultPage = Math.max(1, parseInt(parsed.page, 10) || 1);
                    // 隐藏可能残留的搜索进度提示
                    const progressEl = document.getElementById('searchProgress');
                    if (progressEl) {
                        progressEl.textContent = '';
                        progressEl.style.display = 'none';
                    }
                    populateNameFilter(lastSearchResults);
                    resetSearchGroupOrder();
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
        // 新搜索开始：丢弃上一轮尚未执行的 silent 补页重排
        if (silentReorderTimer) {
            clearTimeout(silentReorderTimer);
            silentReorderTimer = null;
        }
        resetSearchGroupOrder();
        Object.keys(sourceSearchLatency).forEach(k => { delete sourceSearchLatency[k]; });
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
        resetSearchCardMount(resultsDiv); // 清空并作废上一次搜索的渲染回调
        renderedGroupsByKey.clear(); // 丢弃上一次搜索的组缓存，避免旧组 key 被误命中
        showSearchSkeleton(resultsDiv, 8); // 真正等待首批结果时填充骨架屏，首张真卡入网格即移除
        const searchResultsCount = document.getElementById('searchResultsCount');
        if (searchResultsCount) searchResultsCount.textContent = 0;

        const total = selectedAPIs.length;
        let settled = 0;
        let renderTimer = null;
        let urlUpdated = false;
        let renderedCount = 0;               // 渐进渲染已追加的卡片（组）数（增量追加，不重建已渲染部分）
        const progressiveShownGroups = [];   // 首屏已显示的组，用于逐条匹配去重
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

        // 节流渲染：250ms 合并一次；新增结果先与已显示组做「片名 + 年份 + 集数」匹配，
        // 匹配上只更新组数据、不再插入重复卡片，已渲染的图片不闪烁、不重复请求。
        const renderProgressive = () => {
            renderTimer = null;
            if (seq !== searchSeq) return; // 已被更新的搜索取代，丢弃本次渲染
            const div = document.getElementById('results');
            if (!div) return;
            const filtered = lastSearchResults.filter(item => !isBlockedByTypeFilter(item, blockedKeywords));
            // 渐进阶段同样先聚合再展示：同一视频的后续源直接并入已显示卡片，
            // 不再出现「先显示重复卡、全部加载完才合并」的视觉跳变
            const groups = getOrderedSearchGroups(filtered);
            // 渐进渲染期间只展示第 1 页（分页栏在最终渲染时生成），超出的部分留给翻页
            const pageGroups = groups.slice(0, RESULTS_PER_PAGE);
            pageGroups.forEach(g => {
                if (!g) return;
                const key = String(g.key);
                // 按「片名 + 年份 + 集数」匹配已显示卡片。不单纯比 group.key：
                // 集数从无到有时 key 会变化，但仍是同一张卡，不能再出现第二张
                const hit = progressiveShownGroups.find(shown => isSameDisplayedGroup(shown, g));
                if (hit) {
                    // 已显示组集数原先未知时用新结果补全，后续不同集数才能继续拆开
                    if (!hit.episodes && g.episodes) hit.episodes = g.episodes;
                    // 只刷新点击取源数据：旧卡片 key 也指向合并后的组
                    renderedGroupsByKey.set(String(hit.key), g);
                    renderedGroupsByKey.set(key, g);
                    return;
                }
                if (progressiveShownGroups.length >= RESULTS_PER_PAGE) return; // 首页已满，留给最终渲染
                progressiveShownGroups.push(g);
                renderedGroupsByKey.set(key, g);
            });
            // 展示组 = 当前页中已进入已显示集合的组（稳定 key 判断，兼容 isSameDisplayedGroup）
            const shownKeys = new Set(progressiveShownGroups.map(g => String(g.key)));
            const displayGroups = pageGroups.filter(g => g && shownKeys.has(String(g.key)));
            if (renderedCount === 0) {
                // 首批：清掉"正在搜索/无结果"占位并重置渲染
                resetSearchCardMount(div);
                // 第一张卡插入后立即收起遮罩并移除骨架屏；整批插入完成后再兜底触发一次
                if (loadingOwnerSeq === searchLoadingOwner) {
                    const closeLoading = () => {
                        clearSearchSkeleton(div); // 首张真卡入网格 / 整批完成时移除骨架屏
                        if (loadingOwnerSeq === searchLoadingOwner) hideLoading();
                    };
                    searchCardMount.onFirstMount = closeLoading;
                    searchCardMount.onIdle = closeLoading;
                }
            }
            // 关联度顺序同步：复用已渲染卡片，新卡先追加到末尾，再以单卡位移动画上移
            syncSearchResultCards(div, displayGroups, { prune: false });
            renderedCount = div.querySelectorAll('.douban-card[data-group-key]').length;
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

        // 追加结果（同源 source_code+vod_id 去重）；最终渲染完成后可按 silent 选择
        // 只刷新计数/分页（源补页）或整页重渲染（需要重新排序/筛选时）。
        const appendResults = (results, opts) => {
            const silent = !!(opts && opts.silent);
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
                // 最终渲染后到达的补页结果：并入结果池后按需刷新。
                if (silent) {
                    // 第 1 页、无同名/时长筛选时，补页可能带来更高关联度的结果：
                    // 防抖做一次增量重排（保留已渲染卡片），让新卡上移并同步计数/分页；
                    // 其余筛选状态只刷新摘要，避免打断用户当前筛选。
                    if (currentResultPage === 1 && !currentNameFilter && !isDurationFilterActive()) {
                        if (silentReorderTimer) clearTimeout(silentReorderTimer);
                        silentReorderTimer = setTimeout(() => {
                            silentReorderTimer = null;
                            if (seq !== searchSeq) return; // 已被更新的搜索取代
                            renderFilteredSearchResults({ appendOnly: true });
                        }, 280);
                    } else {
                        updateSearchSummaryOnly();
                    }
                } else {
                    renderFilteredSearchResults();
                }
            }
            else scheduleProgressiveRender();
        };

        // 只刷新结果计数与分页栏（不重建卡片）：源补页追加后使用
        const updateSearchSummaryOnly = () => {
            const filtered = getFilteredSearchResults();
            const groups = getOrderedSearchGroups(filtered);
            const totalPages = Math.max(1, Math.ceil(groups.length / RESULTS_PER_PAGE));
            const countEl = document.getElementById('searchResultsCount');
            if (countEl) countEl.textContent = filtered.length;
            renderResultsPagination(totalPages);
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
            const sourceStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            return searchByAPIAndKeyWord(apiId, query, (additional, meta) => {
                if (seq !== searchSeq) return; // 已被更新的搜索取代
                if (Array.isArray(additional) && additional.length > 0) appendResults(additional, { silent: true });
                // 记录该源翻页状态（补页完成才可知总页数）；无 meta 按“无更多页”处理。
                // 分页栏随渲染更新，这里只需维护状态
                searchPageState[apiId] = (meta && typeof meta.pageCount === 'number')
                    ? { pageCount: meta.pageCount, fetchedThrough: meta.fetchedThrough }
                    : { pageCount: 1, fetchedThrough: 1 };
            }, searchSignal)
                .then(results => {
                    if (seq !== searchSeq) return []; // 已被更新的搜索取代
                    const endedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                    sourceSearchLatency[apiId] = Math.max(1, Math.round(endedAt - sourceStartedAt));
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
        // 结果池保持到达顺序，展示顺序按「搜索词关联度 → 到达顺序」派生
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
        renderFilteredSearchResults({
            appendOnly: progressiveShownGroups.length > 0 && currentResultPage === 1
        });
        finalRendered = true;

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
// 最终渲染后 silent 补页的重排防抖计时器（见 appendResults）
let silentReorderTimer = null;

// ===== 搜索会话的展示顺序 =====
// 直接使用关联度排序结果：后台补页/新源到达后，高关联度的新组可以上移，
// 已渲染卡片由 syncSearchResultCards 以单卡位移动画过渡，不整页重建。
// searchGroupOrder / searchGroupOrderSet 同步为本次关联度顺序，供点击回查等场景复用。
let searchGroupOrder = [];
let searchGroupOrderSet = new Set();
function resetSearchGroupOrder() {
    searchGroupOrder = [];
    searchGroupOrderSet = new Set();
}
function getOrderedSearchGroups(flatItems) {
    const groups = deriveOrderedGroupedResults(flatItems);
    searchGroupOrder = groups.map(g => String(g && g.key));
    searchGroupOrderSet = new Set(searchGroupOrder);
    return groups;
}

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

// ===== 真实画质（播放器实测解码分辨率，按 source_id 落库）=====
// 播放页测得真实高度后写入 localStorage（格式兼容 {height, ts} 或直接数字），
// 首页卡片/聚合面板优先展示实测值，探测结果不得覆盖。
const MEASURED_QUALITY_STORAGE = 'wdtvMeasuredQuality';
const MEASURED_QUALITY_MAX = 300;
const measuredQualityEntries = new Map(); // `${source}_${id}` -> height(number)

(function loadMeasuredQualityEntries() {
    try {
        const raw = JSON.parse(localStorage.getItem(MEASURED_QUALITY_STORAGE) || '{}');
        if (!raw || typeof raw !== 'object') return;
        Object.keys(raw).forEach(k => {
            const v = raw[k];
            const h = (v && typeof v === 'object') ? v.height : v;
            if (typeof h === 'number' && isFinite(h) && h > 0) measuredQualityEntries.set(k, h);
        });
    } catch (e) { /* 存储损坏按空处理 */ }
})();

function getMeasuredQualityHeight(source, id) {
    if (source == null || id == null) return undefined;
    const v = measuredQualityEntries.get(String(source) + '_' + String(id));
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : undefined;
}

function persistMeasuredQualityEntries() {
    try {
        const obj = {};
        measuredQualityEntries.forEach((h, k) => { obj[k] = h; });
        localStorage.setItem(MEASURED_QUALITY_STORAGE, JSON.stringify(obj));
    } catch (e) { /* 写入失败不影响本次展示 */ }
}

// 播放器实测回写：更新内存/本地缓存，并定向更新当前页对应卡片徽章
window.addEventListener('wdtv-quality-measured', function (e) {
    const d = (e && e.detail) || {};
    const source = String(d.source || d.source_code || d.sourceCode || '');
    const id = String(d.id || d.vod_id || d.vodId || '');
    const height = Number(d.height || d.videoHeight || d.qualityHeight);
    if (!source || !id || !isFinite(height) || height <= 0) return;
    const key = source + '_' + id;
    if (!measuredQualityEntries.has(key) && measuredQualityEntries.size >= MEASURED_QUALITY_MAX) {
        const oldest = measuredQualityEntries.keys().next().value;
        measuredQualityEntries.delete(oldest);
    }
    measuredQualityEntries.set(key, height);
    persistMeasuredQualityEntries();

    // 当前页没有该卡（已翻页/已筛选）时只存缓存
    const card = document.querySelector(`#results .douban-card[data-key="${cssEscapeAttr(key)}"]`);
    if (!card) return;
    const image = card.querySelector('.douban-card-image');
    if (!image) return;
    let badge = card.querySelector('.wdtv-quality-badge');
    if (!badge) {
        badge = document.createElement('div');
        image.appendChild(badge);
    }
    const Q = window.WDTVQuality;
    const label = (Q && typeof Q.qualityLabel === 'function')
        ? Q.qualityLabel(height) : (height + 'P');
    badge.textContent = label || (height + 'P');
    badge.className = 'wdtv-quality-badge wdtv-quality-probed';
    badge.setAttribute('data-quality-state', 'measured');
    if (typeof badge.removeAttribute === 'function') badge.removeAttribute('data-quality-retry');
});

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

// 封面尺寸兜底：卡片插入后由 <img onload> 读取真实比例，这里在图片事后重新加载
// （如代理重试成功）时同步一次朝向类，保证图片填充方式与真实比例一致。
window.handleCoverLoaded = function (img) {
    try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) return;
        markCoverRatio(img.closest('.douban-card'), w / h);
    } catch (e) { /* 尺寸读取失败保持默认填充 */ }
};

// ===== 搜索结果卡片立即入网格 =====
// 卡片构建后立即追加进网格（图片比例由 handleCoverLoaded 异步修正），不再等待封面
// 尺寸、也不会因封面读取失败丢弃结果。首张插入后同步触发 onFirstMount（收起遮罩/
// 骨架屏），整批插入完成后触发 onIdle；用 seq 保证旧渲染的迟到回调不干扰新渲染。
const searchCardMount = { seq: 0, container: null, onFirstMount: null, onIdle: null };

// 由卡片 HTML 构建游离节点
function createResultCardElement(item) {
    const holder = document.createElement('div');
    holder.innerHTML = buildResultCard(item).trim();
    return holder.firstElementChild;
}

// 清空网格并作废上一批渲染的回调（换搜索词/筛选/翻页/回首页时调用）
function resetSearchCardMount(container) {
    clearQualityProbeWatch(); // 断开上一批卡片的视口观察并清掉 500ms 待触发计时器
    searchCardMount.seq++;
    searchCardMount.container = container || null;
    searchCardMount.onFirstMount = null;
    searchCardMount.onIdle = null;
    if (container) container.innerHTML = '';
}

// 立即插入一批结果：每张卡建好即 append，随后挂画质探测观察
function queueSearchCards(container, items, startIndex) {
    const seq = searchCardMount.seq;
    searchCardMount.container = container;
    const list = Array.isArray(items) ? items : [];
    list.forEach((item, i) => {
        if (seq !== searchCardMount.seq) return; // 已被新的渲染取代，丢弃
        const el = createResultCardElement(item);
        container.appendChild(el);
        if (i === 0) {
            const firstCb = searchCardMount.onFirstMount;
            searchCardMount.onFirstMount = null;
            if (typeof firstCb === 'function') firstCb();
        }
    });
    if (seq !== searchCardMount.seq) return;
    const idleCb = searchCardMount.onIdle;
    searchCardMount.onIdle = null;
    if (typeof idleCb === 'function') idleCb();
}

// ===== 关联度增量重排：复用已渲染卡片 + 单卡多段位移动画 =====
// 动画使用 CSS 独立属性 translate（不是 transform）：motion.js 的磁性效果会写
// style.transform，两者叠加互不覆盖。所有动画对象挂在 el.__wdtvReorderAnim 上，
// 下一轮重排前统一 cancel，使 translate 立即归零后再测量基准位置。
function cancelSearchCardMove(el) {
    if (!el) return;
    const anim = el.__wdtvReorderAnim;
    if (anim) {
        el.__wdtvReorderAnim = null;
        try { anim.cancel(); } catch (e) { /* 已结束或不可取消 */ }
    }
    el.classList.remove('wdtv-card-moving', 'wdtv-card-moving-primary');
    el.style.zIndex = '';
}

function animateSearchCardMoves(container, firstRects, lastRects, newKeys, targetKeys) {
    if (!container || !firstRects || !lastRects) return;
    // 减少动效 / 动态效果关闭：直接落位（节点顺序已更新）
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (typeof document !== 'undefined' && document.documentElement &&
        document.documentElement.classList.contains('fx-off')) return;

    const targetIndex = new Map();
    (Array.isArray(targetKeys) ? targetKeys : []).forEach((k, i) => {
        targetIndex.set(String(k), i);
    });
    const newKeySet = new Set((Array.isArray(newKeys) ? newKeys : []).map(k => String(k)));

    const cards = container.querySelectorAll('.douban-card[data-group-key]');
    const moves = [];
    cards.forEach(card => {
        const key = card.getAttribute('data-group-key');
        if (key == null) return;
        const k = String(key);
        const first = firstRects.get(k);
        const last = lastRects.get(k);
        if (!first || !last) return;
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        moves.push({
            el: card,
            key: k,
            dx: dx,
            dy: dy,
            rank: targetIndex.has(k) ? targetIndex.get(k) : 9999
        });
    });
    if (moves.length === 0) return;

    // 主移动卡片：优先新卡中目标名次最靠前者；没有新卡时选向上位移最大的一张
    let primary = null;
    moves.forEach(m => {
        if (!newKeySet.has(m.key) || !targetIndex.has(m.key)) return;
        if (!primary || m.rank < primary.rank) primary = m;
    });
    if (!primary) {
        moves.forEach(m => {
            // dy = 旧 top - 新 top：> 0 表示卡片向上移动
            if (m.dy > 1 && (!primary || m.dy > primary.dy)) primary = m;
        });
    }

    moves.forEach(m => {
        const isPrimary = m === primary;
        const isNew = newKeySet.has(m.key);
        const movedUp = m.dy > 1;
        // 只让「真正上移的主角卡/新卡」播放位移动画；其余被挤开的卡片直接落位，
        // 避免整页卡片一起滑动造成“全量重排”的观感。
        if (!isPrimary && !isNew && !movedUp) return;
        if (typeof m.el.animate !== 'function') return;
        cancelSearchCardMove(m.el);
        m.el.classList.add('wdtv-card-moving');
        if (isPrimary) m.el.classList.add('wdtv-card-moving-primary');
        m.el.style.zIndex = isPrimary ? '3' : '2';

        // 主卡 4 段 waypoint 缓入缓出；其余卡片 2 段短促让位
        const frames = isPrimary
            ? [
                { translate: m.dx + 'px ' + m.dy + 'px', offset: 0 },
                { translate: (m.dx * 0.45) + 'px ' + (m.dy * 0.38) + 'px', offset: 0.42 },
                { translate: (m.dx * 0.10) + 'px ' + (m.dy * 0.05) + 'px', offset: 0.76 },
                { translate: '0px 0px', offset: 1 }
            ]
            : [
                { translate: m.dx + 'px ' + m.dy + 'px', offset: 0 },
                { translate: '0px 0px', offset: 1 }
            ];
        const timing = {
            duration: isPrimary ? 520 : 240,
            // 让位卡片按目标名次错开，最多 100ms
            delay: isPrimary ? 0 : Math.min(100, Math.max(0, m.rank * 8)),
            easing: isPrimary ? 'cubic-bezier(.22,.68,.16,1)' : 'cubic-bezier(.32,.72,.24,1)',
            fill: 'backwards'
        };

        let anim;
        try {
            anim = m.el.animate(frames, timing);
        } catch (e) {
            cancelSearchCardMove(m.el);
            return;
        }
        m.el.__wdtvReorderAnim = anim;
        const cleanup = () => {
            // 旧动画迟到的 cancel 事件不得清掉新一轮动画的类与 z-index
            if (m.el.__wdtvReorderAnim && m.el.__wdtvReorderAnim !== anim) return;
            m.el.__wdtvReorderAnim = null;
            m.el.classList.remove('wdtv-card-moving', 'wdtv-card-moving-primary');
            m.el.style.zIndex = '';
        };
        anim.onfinish = cleanup;
        anim.oncancel = cleanup;
    });
}

// 按目标组顺序同步卡片：已有卡按 data-group-key 复用，缺失卡追加到末尾后再整体排序，
// 以 first/last rect 差播放单卡位移动画。prune=false 时旧卡保留在目标卡之后
// （渐进阶段维持「已显示 + 末尾追加」），prune=true 时移除不在目标中的旧卡。
function syncSearchResultCards(container, groups, opts) {
    if (!container || !Array.isArray(groups) || groups.length === 0) return { added: 0 };
    const prune = !!(opts && opts.prune);
    const seq = searchCardMount.seq;
    searchCardMount.container = container;

    const targetGroups = new Map();
    const targetKeys = [];
    groups.forEach(g => {
        if (!g) return;
        const key = String(g.key);
        if (targetGroups.has(key)) return;
        targetGroups.set(key, g);
        targetKeys.push(key);
        renderedGroupsByKey.set(key, g);
    });
    if (targetKeys.length === 0) return { added: 0 };

    // 追加前先记录旧卡（含不在目标里的卡），用于 prune=false 时保持末尾顺序
    const oldCards = Array.prototype.slice.call(container.querySelectorAll('.douban-card[data-group-key]'));
    const cardByKey = new Map();
    oldCards.forEach(card => {
        const key = card.getAttribute('data-group-key');
        if (key == null) return;
        const k = String(key);
        if (!cardByKey.has(k)) cardByKey.set(k, card);
    });

    let added = 0;
    let firstMountDone = false;
    const newKeys = [];
    for (let i = 0; i < targetKeys.length; i++) {
        if (seq !== searchCardMount.seq) return { added: added }; // 已被新的渲染取代
        const key = targetKeys[i];
        if (cardByKey.has(key)) continue;
        const g = targetGroups.get(key);
        if (!g) continue;
        const card = createResultCardElement(g);
        if (!card) continue;
        container.appendChild(card);
        if (seq !== searchCardMount.seq) return { added: added };
        cardByKey.set(key, card);
        newKeys.push(key);
        added++;
        if (!firstMountDone) {
            firstMountDone = true;
            const firstCb = searchCardMount.onFirstMount;
            searchCardMount.onFirstMount = null;
            if (typeof firstCb === 'function') firstCb();
        }
    }

    const idleCb = searchCardMount.onIdle;
    searchCardMount.onIdle = null;
    if (typeof idleCb === 'function') idleCb();

    // 取消上一轮重排动画，确保 measure 时 translate 已归零
    const currentCards = Array.prototype.slice.call(container.querySelectorAll('.douban-card[data-group-key]'));
    currentCards.forEach(card => cancelSearchCardMove(card));

    // first：追加后、排序前的布局位置
    const firstRects = new Map();
    currentCards.forEach(card => {
        const key = card.getAttribute('data-group-key');
        if (key == null) return;
        const k = String(key);
        if (!firstRects.has(k)) firstRects.set(k, card.getBoundingClientRect());
    });

    const targetSet = new Set();
    const targetCards = [];
    targetKeys.forEach(key => {
        const card = cardByKey.get(key);
        if (card && card.parentNode === container) {
            targetCards.push(card);
            targetSet.add(card);
        }
    });
    const leftover = [];
    oldCards.forEach(card => {
        if (!targetSet.has(card) && card.parentNode === container) leftover.push(card);
    });

    if (prune) {
        leftover.forEach(card => {
            if (card.parentNode === container) container.removeChild(card);
        });
    }
    // 目标卡按关联度顺序重排；prune=false 时旧卡保持原 DOM 顺序跟在目标卡之后
    targetCards.forEach(card => container.appendChild(card));
    if (!prune) leftover.forEach(card => container.appendChild(card));

    // last：排序后的布局位置（含保留在末尾的旧卡，让位动画一并播放）
    const lastRects = new Map();
    const finalCards = container.querySelectorAll('.douban-card[data-group-key]');
    finalCards.forEach(card => {
        const key = card.getAttribute('data-group-key');
        if (key == null) return;
        const k = String(key);
        if (!lastRects.has(k)) lastRects.set(k, card.getBoundingClientRect());
    });

    animateSearchCardMoves(container, firstRects, lastRects, newKeys, targetKeys);
    return { added: added };
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
        items: [item],
        remarks: undefined,
        pic: item && item.vod_pic,
        typeName: item && item.type_name
    }));
}

// 派生分组后按「搜索词关联度」排序（WDTVGroup.rankGroupsByRelevance）：
// 各源搜索接口大多按更新时间返回，且可能混入大量只沾边的条目，若直接按到达顺序
// 或源等级排列，真正要搜的片名会被挤到后面。列表排序只看关联度，
// 同分时按进入结果池的先后保持稳定；源等级只用于组内选源。
function deriveOrderedGroupedResults(flatItems) {
    const groups = deriveGroupedResults(flatItems);
    const Group = window.WDTVGroup;
    let ordered = null;
    if (Group && typeof Group.rankGroupsByRelevance === 'function') {
        try {
            ordered = Group.rankGroupsByRelevance(groups, currentSearchQuery);
        } catch (e) { /* 排序模块异常时退回原顺序，不影响结果展示 */ }
    }
    if (!Array.isArray(ordered)) {
        // 聚合模块缺失时保持结果池到达顺序，保证渲染链不中断
        ordered = groups;
    }
    ordered.forEach(g => {
        // 组内条目仍按源等级排序：卡片主条目（封面/来源徽章）取 items[0]
        if (g && Array.isArray(g.items)) g.items = sortGroupItems(g.items);
    });
    return ordered;
}

// 当前页已渲染的分组（group.key -> group），供卡片点击回查聚合组使用
let renderedGroupsByKey = new Map();

// 渐进渲染去重：判断新聚合组与已显示卡片是否同一个视频。
// 优先比较稳定聚合键（titleGroupKey：片名 + 季数 + 内容标签），集数不参与；
// key 缺失时退回比较片名，避免旧调用方（只传片名的扁平项）失效。
function isSameDisplayedGroup(a, b) {
    if (!a || !b) return false;
    if (a.key && b.key) return String(a.key) === String(b.key);
    const Group = window.WDTVGroup;
    if (Group && typeof Group.titleGroupKey === 'function') {
        return Group.titleGroupKey(a.name) === Group.titleGroupKey(b.name);
    }
    const norm = (Group && typeof Group.normalizeTitle === 'function')
        ? Group.normalizeTitle
        : (s => String(s == null ? '' : s).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''));
    return norm(a.name) === norm(b.name);
}

// 组内选源排序：先按源等级（1 首选 → 3 备用），同等级再按本次搜索实测速度。
// 卡的第一个条目即组内主源（封面/来源徽章与换源面板的首选）。
function sortGroupItems(items) {
    return (Array.isArray(items) ? items.slice() : []).sort((a, b) => {
        const ra = getSourceTier(a && a.source_code);
        const rb = getSourceTier(b && b.source_code);
        if (ra !== rb) return ra - rb;
        return sourceSpeedMs(a && a.source_code) - sourceSpeedMs(b && b.source_code);
    });
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
    // 卡片不再显示来源/画质/源数量/时长角标；多源与单源卡点击统一打开详情窗口。
    const remarksRaw = group.remarks || (primary && primary.vod_remarks) || '';
    const safeRemarks = escapeResultText(formatCardRemarks(remarksRaw));
    const jsGroupKey = jsStringAttr(group.key || itemKey);
    const openClick = ` onclick="openResultCard('${jsGroupKey}')"`;
    const openTitleClick = ` onclick="event.stopPropagation(); openResultCard('${jsGroupKey}')"`;

    return `
        <div class="douban-card flex flex-col cursor-pointer" data-key="${escapeResultText(itemKey)}"
             data-group-card="1" data-group-key="${escapeResultText(group.key)}"
             role="button" tabindex="0"${openClick}
             onmouseenter="prefetchDetail('${safeId}','${jsSourceCode}')">
            <div class="douban-card-image">
                <img src="${coverUrl}" alt="${safeName}"${coverOriginalAttr}
                     onload="handleCoverLoaded(this)"
                     onerror="handleCoverLoadError(this)"
                     referrerpolicy="no-referrer">
                <div class="absolute inset-0" style="background: linear-gradient(to top, rgba(0,0,0,0.6), transparent 50%); pointer-events: none;"></div>
            </div>
            <div class="douban-card-title-area">
                <button${openTitleClick}
                        class="text-sm font-medium truncate w-full transition"
                        style="color: #1d1d1f; background: transparent; border: none; cursor: pointer; padding: 0; font-size: 0.8rem; line-height: 1.25;">
                    ${safeName}
                </button>
                ${safeRemarks ? `
                <div class="wdtv-remarks-badge">${safeRemarks}</div>
                ` : ''}
            </div>
        </div>
    `;
}

// 点击搜索结果卡片：单源/多源统一打开详情窗口，由用户选集数。
// 点击前先把整个聚合组写入 wdtvCurrentSources，播放页换源面板可直接复用。
function openResultCard(groupKey) {
    const group = renderedGroupsByKey.get(String(groupKey || ''));
    if (!group || !Array.isArray(group.items) || group.items.length === 0) return;
    const item = group.items[0] || {};
    try {
        const payload = {
            title: item.vod_name || group.name || '',
            ts: Date.now(),
            savedAt: Date.now(),
            items: group.items.map(it => ({
                vod_id: it.vod_id,
                source_code: it.source_code,
                source_name: it.source_name || it.source_code,
                vod_name: it.vod_name || group.name,
                vod_pic: it.vod_pic || '',
                vod_remarks: it.vod_remarks || '',
                // 播放列表原样带上：播放页换源面板据此做「真实集数」匹配
                vod_play_url: it.vod_play_url || ''
            })),
            current: { source_code: item.source_code, vod_id: item.vod_id }
        };
        localStorage.setItem('wdtvCurrentSources', JSON.stringify(payload));
    } catch (e) { /* 存储不可用时播放页会回退到全源搜索 */ }
    if (!item.vod_id || !item.source_code) return;
    if (typeof showDetails === 'function') {
        showDetails(item.vod_id, item.vod_name || group.name || '', item.source_code);
    }
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
    // 成人过滤已写死在 search.js 的数据入口；这里再兜一层，确保任何结果都不过界面开关
    const sourceResults = (typeof filterAdultSearchItems === 'function')
        ? filterAdultSearchItems(lastSearchResults) : lastSearchResults;
    return sourceResults.filter(item => {
        if (currentNameFilter && (item.vod_name || '').trim() !== currentNameFilter) return false;
        if (isBlockedByTypeFilter(item, blockedKeywords)) return false;
        if (!isDurationMatch(item)) return false; // 已探明且不在时长区间内
        return true;
    });
}

// 根据当前名称筛选与屏蔽规则渲染「当前页」搜索结果，并刷新分页栏。
// options.appendOnly：用于渐进渲染后的收尾/补页——保留已渲染卡片，
// 按当前页关联度顺序复用并重排（新卡先追加再位移到目标名次），
// 避免整页重建导致已加载封面闪烁，同时让合并后的组数据生效。
function renderFilteredSearchResults(options) {
    const appendOnly = !!(options && options.appendOnly);
    const resultsDiv = document.getElementById('results');
    if (!resultsDiv) return;

    const filtered = getFilteredSearchResults();
    // 批次 2 / 必修 A1：先在「全部筛选结果」上派生分组，再按「组数」切页展示。
    // 这样跨分页边界的同名条目合并进同一张卡（5 源而非 2 源/3 源），屏幕按组计数；
    // 扁平池 lastSearchResults / searchResultKeys 去重 / appendResults / 补抓仍按条推进。
    const groups = getOrderedSearchGroups(filtered);
    const totalPages = Math.max(1, Math.ceil(groups.length / RESULTS_PER_PAGE));
    if (currentResultPage > totalPages) currentResultPage = totalPages;
    const start = (currentResultPage - 1) * RESULTS_PER_PAGE;
    const pageGroups = groups.slice(start, start + RESULTS_PER_PAGE);
    // 当前页分组索引：卡片点击时按 data-group-key 回查聚合组
    renderedGroupsByKey.clear();
    pageGroups.forEach(g => {
        if (g) renderedGroupsByKey.set(String(g.key), g);
    });
    // 当前页组展平回扁平条目：供时长探测 enqueueDurationProbes 与筛选计数使用，
    // 入参语义与旧版「当前页扁平 pageItems」一致（不改变 enqueueDurationProbes 形状）。
    const pageItems = [];
    pageGroups.forEach(g => {
        if (g && Array.isArray(g.items)) g.items.forEach(it => { if (it) pageItems.push(it); });
    });
    if (pageItems.length === 0 && lastSearchResults.length > 0) {
        resetSearchCardMount(resultsDiv); // 同时作废上一页的渲染回调
        resultsDiv.innerHTML = `
            <div class="col-span-full" style="text-align:center;padding:40px 0;color:var(--text-muted);font-size:0.9rem;">
                当前筛选条件下没有可显示的结果
            </div>
        `;
    } else if (appendOnly && resultsDiv.querySelector('.douban-card[data-group-key]')) {
        // 增量收尾：不清空、不重建；按关联度顺序复用已渲染卡片并重排，
        // 缺失组追加后由单卡位移动画落到目标名次（prune 移除已不在当前页的旧卡）。
        syncSearchResultCards(resultsDiv, pageGroups, { prune: true });
    } else {
        // 整页重建：卡片构建后立即入网格（见 queueSearchCards）
        resetSearchCardMount(resultsDiv);
        queueSearchCards(resultsDiv, pageGroups, 0);
    }

    // 更新计数显示（筛选后的总条数，非组数 / 当前页条数）
    const searchResultsCount = document.getElementById('searchResultsCount');
    if (searchResultsCount) {
        searchResultsCount.textContent = filtered.length;
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
    const displayPages = Math.max(1, Math.ceil(getOrderedSearchGroups(getFilteredSearchResults()).length / RESULTS_PER_PAGE));

    if (target > displayPages && hasMoreSourcePages()) {
        const flatNextPage = Math.ceil(getFilteredSearchResults().length / RESULTS_PER_PAGE) + 1;
        const ok = await ensureResultsForPage(flatNextPage);
        if (!ok) return; // 已被新搜索取代，放弃本次跳转
    }

    // 抓取后组页数可能已增长；目标仍超界时收敛到最后一页
    const totalPages = Math.max(1, Math.ceil(getOrderedSearchGroups(getFilteredSearchResults()).length / RESULTS_PER_PAGE));
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
                pageState: searchPageState,
                page: currentResultPage
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

// ===== 批次 2 · A6 卡片画质探测（默认开启；关闭后零新增请求）=====
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
    return localStorage.getItem(QUALITY_PROBE_STORAGE) !== 'false';
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
    const groups = (typeof getOrderedSearchGroups === 'function')
        ? getOrderedSearchGroups(getFilteredSearchResults())
        : deriveOrderedGroupedResults(getFilteredSearchResults());
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
            try {
                const p = reader.cancel();
                if (p && typeof p.catch === 'function') p.catch(function () { });
            } catch (e) { /* noop */ }
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
    // 已有播放器实测高度：探测结果不得覆盖（徽章与缓存保持实测）
    if (typeof getMeasuredQualityHeight(sourceKey, vodId) === 'number') return;
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
    // 已有播放器实测高度：忽略探测结果覆盖，徽章保持实测
    if (typeof getMeasuredQualityHeight(sourceKey, vodId) === 'number') return;
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
    if (!label) return; // 其余态无 label：保留卡片原有徽章内容
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

// ===== 分组卡片交互 =====
// 整卡点击统一由 buildResultCard 的 inline onclick → openResultCard 处理：
// 单源/多源卡都打开详情窗口。这里只处理卡片内动态徽章
// （画质探测重试）等局部交互，避免与整卡点击重复触发。
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

// 详情展示增强：按「封面优先、文本长度优先」从同聚合组其它源中挑最丰富的一份
// videoInfo 用于详情弹窗展示（集数/播放仍使用当前点击源的 episodes）。
function detailInfoScore(vi) {
    if (!vi || typeof vi !== 'object') return -1;
    const desc = String(vi.desc || '').replace(/<[^>]+>/g, '').trim();
    const meta = [vi.director, vi.actor, vi.year, vi.area, vi.remarks, vi.type]
        .map(v => String(v || '')).join('');
    const cover = /^https?:\/\//i.test(String(vi.cover || '').trim()) ? 1000 : 0;
    return cover + desc.length + meta.length * 0.5;
}

async function enrichDetailVideoInfo(data, currentId, currentSource, title) {
    if (!data) return data;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('wdtvCurrentSources') || 'null'); } catch (e) { saved = null; }
    const items = (saved && Array.isArray(saved.items)) ? saved.items : [];
    const others = items.filter(it => it && it.vod_id && it.source_code
        && !(String(it.vod_id) === String(currentId) && String(it.source_code) === String(currentSource)))
        .slice(0, 5);
    if (others.length === 0) return data;
    const currentVi = data.videoInfo || null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2800);
    try {
        const candidates = await Promise.all(others.map(async (it) => {
            try {
                const d = await fetchVideoDetailData({
                    id: String(it.vod_id),
                    source: it.source_code,
                    signal: controller.signal,
                    trackHealth: false
                });
                return d && d.videoInfo ? d.videoInfo : null;
            } catch (e) {
                return null;
            }
        }));
        let best = currentVi;
        let bestScore = detailInfoScore(currentVi);
        candidates.forEach(vi => {
            const s = detailInfoScore(vi);
            if (s > bestScore) { best = vi; bestScore = s; }
        });
        if (best && best !== currentVi) {
            data.videoInfo = Object.assign({}, currentVi || {}, best, {
                source_name: (currentVi && currentVi.source_name) || best.source_name || ''
            });
        }
    } finally {
        clearTimeout(timer);
    }
    return data;
}

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

        // 详情展示内容增强：同一聚合组的其它源若有更完整封面/简介，则优先展示最丰富的那份。
        try { data = await enrichDetailVideoInfo(data, id, sourceCode, vod_name); } catch (e) { /* 增强失败不影响原详情 */ }
        if (seq !== detailSeq) return;

        // 详情接口偶尔不返回 vod_pic：回退到搜索结果已保存的同源条目封面，
        // 避免列表有封面、点开详情却只剩文字占位。
        try {
            if (data && data.videoInfo && !String(data.videoInfo.cover || '').trim()) {
                const saved = JSON.parse(localStorage.getItem('wdtvCurrentSources') || 'null');
                const items = (saved && Array.isArray(saved.items)) ? saved.items : [];
                const hit = items.find(it => it && String(it.vod_id) === String(id)
                    && String(it.source_code) === String(sourceCode) && it.vod_pic);
                if (hit && hit.vod_pic) data.videoInfo.cover = normalizeRuyiPicUrl(hit.vod_pic);
            }
        } catch (e) { /* 封面回退失败不影响详情展示 */ }

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
                        <img src="${escapeResultText(vi.cover)}" alt="${escapeResultText(vod_name || '')}"
                             loading="lazy" decoding="async" referrerpolicy="no-referrer"
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
                        <button type="button" onclick="openDetailBatchDownload(event)" class="wdtv-modal-mini-btn">
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
                            <span class="wdtv-threshold-label">分组线
                                <span id="thresholdDropdown" class="wdtv-name-dropdown wdtv-inline-dropdown">
                                    <span class="wdtv-name-dropdown-toggle wdtv-threshold-toggle" onclick="toggleThresholdDropdown(event)">
                                        <input id="varietyThresholdInput" type="number" min="1" step="1"
                                               value="${varietyThresholdMinutes}" onchange="setVarietyThreshold(this.value)"
                                               onclick="event.stopPropagation()" class="wdtv-threshold-input">分钟
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
                        <button id="episodeViewBtn" onclick="toggleEpisodeView()" class="wdtv-modal-mini-btn${episodeViewMode === 'list' ? ' active' : ''}">
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
    // 返回地址即当前页；若当前已在播放页（大小写不敏感）则回首页，避免返回自身
    let returnUrl = '/';
    try {
        const href = window.location.href || '';
        if (!/player\.html/i.test(href)) returnUrl = href;
    } catch (e) {
        returnUrl = '/';
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
        localStorage.setItem('lastSearchPage', window.location.href);
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
            numHtml = `<span class="ep-num">${groupNum}</span>`;
        } else if (varietyNumberMode === 'both') {
            // 大数字为新排序序号，括号内小数字为原序号
            numHtml = `<span class="ep-num">${groupNum}<em class="ep-num-g">(${originalNum})</em></span>`;
        } else {
            numHtml = `<span class="ep-num">${originalNum}</span>`;
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

