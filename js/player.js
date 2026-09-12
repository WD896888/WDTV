const selectedAPIs = JSON.parse(localStorage.getItem('selectedAPIs') || '[]');

// 改进返回功能
// 判断一个URL是否指向播放页本身：播放页不能作为"返回"目标，
// 否则会出现"点返回却回到上一个播放页"的错误体验
function isPlayerPageUrl(u) {
    if (!u) return false;
    try {
        const parsed = new URL(u, window.location.origin);
        return parsed.pathname.toLowerCase().includes('player.html');
    } catch (e) {
        return String(u).toLowerCase().includes('player.html');
    }
}

function goBack(event) {
    // 防止默认链接行为
    if (event) event.preventDefault();
    
    // 1. 优先检查URL参数中的returnUrl（进入播放器前的页面）
    const urlParams = new URLSearchParams(window.location.search);
    const returnUrl = urlParams.get('returnUrl');
    
    if (returnUrl && !isPlayerPageUrl(returnUrl)) {
        // URLSearchParams.get 已解码一次；再解码一次以兼容旧流程的双重编码，失败则原样使用
        let returnTarget = returnUrl;
        try { returnTarget = decodeURIComponent(returnUrl); } catch (e) { }
        window.location.href = returnTarget;
        return;
    }
    
    // 2. 检查localStorage中保存的lastPageUrl（若被历史数据污染成播放页地址则跳过）
    const lastPageUrl = localStorage.getItem('lastPageUrl');
    if (lastPageUrl && lastPageUrl !== window.location.href && !isPlayerPageUrl(lastPageUrl)) {
        window.location.href = lastPageUrl;
        return;
    }
    
    // 3. 检查是否是从搜索页面进入的播放器
    const referrer = document.referrer;
    
    // 检查 referrer 是否包含搜索参数
    if (referrer && (referrer.includes('/s=') || referrer.includes('?s='))) {
        // 如果是从搜索页面来的，返回到搜索页面
        window.location.href = referrer;
        return;
    }
    
    // 4. 如果是在iframe中打开的，尝试关闭iframe
    if (window.self !== window.top) {
        try {
            // 尝试调用父窗口的关闭播放器函数
            window.parent.closeVideoPlayer && window.parent.closeVideoPlayer();
            return;
        } catch (e) {
            console.error('调用父窗口closeVideoPlayer失败:', e);
        }
    }
    
    // 5. 无法确定上一页，则返回首页
    if (!referrer || referrer === '') {
        window.location.href = '/';
        return;
    }
    
    // 6. 以上都不满足，使用默认行为：返回上一页
    window.history.back();
}

// 页面加载时保存当前URL到localStorage，作为返回目标
window.addEventListener('load', function () {
    // 保存"进入播放器前的页面"作为返回目标。
    // 注意：播放页内部跳转（如换源 switchToResource）后 referrer 仍是 player.html，
    // 绝不能用它覆盖真实的来源页面，否则返回会回到上一个播放页
    const entryParams = new URLSearchParams(window.location.search);
    const entryReturnUrl = entryParams.get('returnUrl');
    if (entryReturnUrl && !isPlayerPageUrl(entryReturnUrl)) {
        // 跳转方显式传入的返回地址以它为准；兼容旧流程的双重编码，解码失败则原样保存
        let savedTarget = entryReturnUrl;
        try { savedTarget = decodeURIComponent(entryReturnUrl); } catch (e) { }
        localStorage.setItem('lastPageUrl', savedTarget);
    } else if (document.referrer && document.referrer !== window.location.href && !document.referrer.includes('player.html')) {
        localStorage.setItem('lastPageUrl', document.referrer);
    }

    // 提取当前URL中的重要参数，以便在需要时能够恢复当前页面
    const urlParams = new URLSearchParams(window.location.search);
    const videoId = urlParams.get('id');
    const sourceCode = urlParams.get('source');

    if (videoId && sourceCode) {
        // 保存当前播放状态，以便其他页面可以返回
        localStorage.setItem('currentPlayingId', videoId);
        localStorage.setItem('currentPlayingSource', sourceCode);
    }
});


// =================================
// ============== PLAYER ==========
// =================================
// 全局变量
let currentVideoTitle = '';
let currentEpisodeIndex = 0;
let art = null; // 用于 ArtPlayer 实例
let currentHls = null; // 跟踪当前HLS实例
let resolutionBadgeEl = null; // 播放器下方分辨率显示元素
let playingLevelBitrate = null; // 当前实际播放档位的声明码率（bps，null 表示未知/单档位/非HLS）
let measuredLevelBitrate = null; // 实测媒体码率（分片字节/时长估算，bps）：单档源常无声明 BANDWIDTH，用它兜底显示
let qualityMenuAdded = false; // 是否已添加清晰度切换菜单
let currentEpisodes = [];
// 集名（源站「集名$URL」的集名，与 currentEpisodes 按 index 对齐；缺失时降级为「第N集」）
let currentEpisodeNames = [];
let episodesReversed = false;
// 集数排序与时长检测状态（与首页详情弹窗同款，跨页面持久化保持一致体验）
let sortMode = 'default';          // 'default' 默认排序；'variety' 综艺排序
let varietyNumberMode = 'group';   // 'group' 新集数；'original' 原集数；'both' 双显
let varietyThresholdMinutes = 60;  // 综艺排序的时长分组线（分钟）
// 集数展示布局：'grid' 数字方块（默认）；'list' 详细列表（完整集名，每行一条）
let episodeViewMode = localStorage.getItem('episodeViewMode') === 'list' ? 'list' : 'grid';
const episodeDurationCache = new Map(); // 集数地址 -> { status: 'detecting'|'done'|'fail', seconds }
let durationDetectRunning = false;
let autoplayEnabled = true; // 默认开启自动连播
let videoHasEnded = false; // 跟踪视频是否已经自然结束
let isUserSeeking = false; // 用户是否正在拖拽进度条（拖到结尾触发的 ended 不应自动连播）
let userClickedPosition = null; // 记录用户点击的位置
let shortcutHintTimeout = null; // 用于控制快捷键提示显示时间
let adFilteringEnabled = true; // 默认开启广告过滤
const RACE_HEDGE_STORAGE = 'wdtvRaceHedge'; // 关键路径竞速兜底开关（流量下直连慢但在流时代理并行竞速；默认关闭）
let currentVideoUrl = ''; // 记录当前实际的视频URL
let baseEpisodeUrl = ''; // 当前集的原始地址（进度/历史键基准，不随清晰度目录切换变化）
let syntheticTiers = []; // 单档源探测到的同级清晰度目录 [{ label, url, kbps, height }]
let qualitySwapSeek = null; // 清晰度目录切换后待恢复的播放位置
let tierProbeToken = 0; // 探测竞态令牌：换集/换源后旧探测结果作废
let tierSettingsMenuAdded = false; // 设置面板（齿轮）是否已添加探测档位清晰度菜单
let bitrateSettingsMenuAdded = false; // 设置面板（齿轮）是否已添加画质模式菜单
let speedSettingsMenuAdded = false; // 设置面板（齿轮）是否已添加长按倍速/区域菜单
let tierProbeInfo = null; // 最近一次探测结果摘要 { host, probed, trials, real }（面板透出探测透明度）
const tierZeroToastHosts = new Set(); // 本页会话内已弹过"0 档可用"提示的源主机（避免每集重复打扰）
let longPressBoostActive = false; // 长按临时倍速进行中（临时速度不写入全局记忆）
// 通用卡顿降速保护：seek 跳到未缓冲区/加载卡顿（waiting）/换集起播时倍速>1 则降为 1x，
// 恢复纯由已缓存媒体秒数判定（无时间兜底，跨源分片时长差异免疫）：后 12 秒已缓存 →
// 立即恢复原倍速；后 7 秒 → 无级降到原倍速的一半过渡；不足 7 秒 → 保持 1x 等缓存追上
let stallRateGuard = { active: false, rate: 1, half: false };
let suppressNextClick = false;    // 长按/滑动手势结束后拦截下一次 click，避免误触发暂停/播放
let playerLocked = false;         // 播放器锁定中（锁后屏蔽手势/点击，仅解锁按钮可交互）
const isWebkit = (typeof window.webkitConvertPointFromPageToNode === 'function')

// ===== 事件监听器防重复绑定（换集不销毁 video 时防止监听器无限累积） =====
// 已绑定"错误提示隐藏"监听的 video 元素集合
const errorListenerVideos = new WeakSet();
// 错误提示元素缓存（timeupdate 高频回调里不再每次 getElementById）
let cachedErrorEl = null;
function getErrorEl() {
    if (!cachedErrorEl || !cachedErrorEl.isConnected) {
        cachedErrorEl = document.getElementById('error');
    }
    return cachedErrorEl;
}

// 绑定"播放后隐藏错误提示"监听（同一 video 元素只绑一次）
function ensureErrorHideListeners(video) {
    if (errorListenerVideos.has(video)) return;
    errorListenerVideos.add(video);
    video.addEventListener('playing', function () {
        videoPlaybackStarted = true;
        const errEl = getErrorEl();
        if (errEl) errEl.style.display = 'none';
    });
    video.addEventListener('timeupdate', function () {
        if (video.currentTime > 1) {
            const errEl = getErrorEl();
            if (errEl) errEl.style.display = 'none';
        }
    });
}

// 视频是否已开始播放（模块级：换集/换实例时重置，供错误处理判断）
let videoPlaybackStarted = false;

// 页面加载
document.addEventListener('DOMContentLoaded', function () {
    initializePageContent();
});

// 初始化页面内容
function initializePageContent() {

    // 解析URL参数
    const urlParams = new URLSearchParams(window.location.search);
    let videoUrl = urlParams.get('url');
    const title = urlParams.get('title');
    const sourceCode = urlParams.get('source');
    let index = parseInt(urlParams.get('index') || '0');
    const episodesList = urlParams.get('episodes'); // 从URL获取集数信息
    const savedPosition = parseInt(urlParams.get('position') || '0'); // 获取保存的播放位置
    // 解决历史记录问题：检查URL是否是player.html开头的链接
    // 如果是，说明这是历史记录重定向，需要解析真实的视频URL
    if (videoUrl && videoUrl.includes('player.html')) {
        try {
            // 尝试从嵌套URL中提取真实的视频链接
            const nestedUrlParams = new URLSearchParams(videoUrl.split('?')[1]);
            // 从嵌套参数中获取真实视频URL
            const nestedVideoUrl = nestedUrlParams.get('url');
            // 检查嵌套URL是否包含播放位置信息
            const nestedPosition = nestedUrlParams.get('position');
            const nestedIndex = nestedUrlParams.get('index');
            const nestedTitle = nestedUrlParams.get('title');

            if (nestedVideoUrl) {
                videoUrl = nestedVideoUrl;

                // 更新当前URL参数
                const url = new URL(window.location.href);
                if (!urlParams.has('position') && nestedPosition) {
                    url.searchParams.set('position', nestedPosition);
                }
                if (!urlParams.has('index') && nestedIndex) {
                    url.searchParams.set('index', nestedIndex);
                }
                if (!urlParams.has('title') && nestedTitle) {
                    url.searchParams.set('title', nestedTitle);
                }
                // 替换当前URL
                window.history.replaceState({}, '', url);
            } else {
                showError('历史记录链接无效，请返回首页重新访问');
            }
        } catch (e) {
        }
    }

    // 保存当前视频URL
    currentVideoUrl = videoUrl || '';
    baseEpisodeUrl = currentVideoUrl; // 原始集地址：清晰度目录切换不改写此基准

    // 从localStorage获取数据
    currentVideoTitle = title || localStorage.getItem('currentVideoTitle') || '未知视频';
    currentEpisodeIndex = index;

    // 设置自动连播开关状态
    autoplayEnabled = localStorage.getItem('autoplayEnabled') !== 'false'; // 默认为true
    document.getElementById('autoplayToggle').checked = autoplayEnabled;

    // 获取广告过滤设置
    adFilteringEnabled = localStorage.getItem(PLAYER_CONFIG.adFilteringStorage) !== 'false'; // 默认为true

    // 初始化整集后台缓存模块（IndexedDB + hls loader 读写穿透 + LRU + 缓存管理器）
    VideoCache.init({
        getVideoKey: () => currentVideoUrl,
        getVideoMeta: () => ({
            title: currentVideoTitle || '未知视频',
            episodeLabel: getEpisodeDisplayName(currentEpisodeIndex),
            sourceName: (typeof API_SITES !== 'undefined' && sourceCode && API_SITES[sourceCode])
                ? API_SITES[sourceCode].name : (sourceCode || '')
        }),
        getPlaybackPosition: () => (art && art.video) ? art.video.currentTime : 0,
        getEvictMode: () => (localStorage.getItem('cacheEvictMode') === 'never' ? 'never' : 'lru'),
        getAutoCache: () => localStorage.getItem(PLAYER_CONFIG.autoCacheStorage) !== 'false',
        getRaceHedge: () => localStorage.getItem(RACE_HEDGE_STORAGE) === 'true',
        getPlaybackRunway: () => {
            // 播放"真实秒"缓冲余量 = 媒体秒余量 / 倍速；暂停返回 Infinity（预取全速）。
            // VideoCache 据此动态收缩预取并发额度：余量充足并行预取、濒临卡顿全部让路
            try {
                if (!art || !art.video) return Infinity;
                const v = art.video;
                if (v.paused) return Infinity;
                const rate = Math.max(0.25, v.playbackRate || 1);
                const t = v.currentTime;
                let end = 0;
                for (let i = 0; i < v.buffered.length; i++) {
                    if (v.buffered.start(i) <= t && t <= v.buffered.end(i)) end = v.buffered.end(i);
                }
                return Math.max(0, (end - t) / rate);
            } catch (e) { return 10; }
        },
        onProgress: (s) => {
            try { updateCacheProgressBar(s); } catch (e) { }
            if (typeof cacheProgressHook === 'function') {
                try { cacheProgressHook(s); } catch (e) { }
            }
        },
        toast: (msg, type) => { if (typeof showToast === 'function') showToast(msg, type); }
    });

    // 立即登记当前视频缓存键：让随后的惰性巡检能保护当前播放的集不被误淘汰
    try { VideoCache.setVideoKey(currentVideoUrl); } catch (e) { }
    // 惰性兜底巡检：页面加载即对账 + 淘汰 + 重试失败删除（不依赖播放行为），并启动 15 分钟低频定时兜底
    try { VideoCache.housekeep(); } catch (e) { }

    // 监听自动连播开关变化
    document.getElementById('autoplayToggle').addEventListener('change', function (e) {
        autoplayEnabled = e.target.checked;
        localStorage.setItem('autoplayEnabled', autoplayEnabled);
    });

    // 流量竞速兜底开关已移至首页设置面板"功能开关"（app.js 接线）；
    // 播放侧仅通过 getRaceHedge 每次分片加载时实时读取 localStorage，无需本地开关

    // 优先使用URL传递的集数信息，否则从localStorage获取
    try {
        if (episodesList) {
            // 如果URL中有集数数据，优先使用它
            currentEpisodes = JSON.parse(decodeURIComponent(episodesList));

        } else {
            // 否则从localStorage获取
            currentEpisodes = JSON.parse(localStorage.getItem('currentEpisodes') || '[]');

        }

        // 集名：优先 URL names= 参数（与 episodes= 同格式），否则 localStorage；长度须与集数对齐
        const namesParam = urlParams.get('names');
        const parsedNames = namesParam
            ? JSON.parse(decodeURIComponent(namesParam))
            : JSON.parse(localStorage.getItem('currentEpisodeNames') || '[]');
        currentEpisodeNames = (Array.isArray(parsedNames) && parsedNames.length === currentEpisodes.length)
            ? parsedNames : [];

        // 检查集数索引是否有效，如果无效则调整为0
        if (index < 0 || (currentEpisodes.length > 0 && index >= currentEpisodes.length)) {
            // 如果索引太大，则使用最大有效索引
            if (index >= currentEpisodes.length && currentEpisodes.length > 0) {
                index = currentEpisodes.length - 1;
            } else {
                index = 0;
            }

            // 更新URL以反映修正后的索引
            const newUrl = new URL(window.location.href);
            newUrl.searchParams.set('index', index);
            window.history.replaceState({}, '', newUrl);
        }

        // 更新当前索引为验证过的值
        currentEpisodeIndex = index;

        episodesReversed = localStorage.getItem('episodesReversed') === 'true';
    } catch (e) {
        currentEpisodes = [];
        currentEpisodeNames = [];
        currentEpisodeIndex = 0;
        episodesReversed = false;
    }

    // 读取来自首页的排序方式与已检测时长，播放页与详情页保持一致展示
    try {
        sortMode = localStorage.getItem('episodeSortMode') === 'variety' ? 'variety' : 'default';
        const savedNumMode = localStorage.getItem('varietyNumberMode');
        if (['group', 'original', 'both'].includes(savedNumMode)) varietyNumberMode = savedNumMode;
        const savedThreshold = parseInt(localStorage.getItem('varietyThresholdMinutes'), 10);
        if (isFinite(savedThreshold) && savedThreshold > 0) varietyThresholdMinutes = savedThreshold;
        (JSON.parse(localStorage.getItem('episodeDurationCache') || '[]') || []).forEach(([url, info]) => {
            // 中断残留的 detecting 状态视为未检测
            if (url && info && (info.status === 'done' || info.status === 'fail')) {
                episodeDurationCache.set(url, info);
            }
        });
    } catch (e) {
        console.warn('读取排序/时长状态失败:', e);
    }

    // 设置页面标题
    document.title = currentVideoTitle + ' - WDTV播放器';
    document.getElementById('videoTitle').textContent = currentVideoTitle;

    // 初始化播放器
    if (videoUrl) {
        initPlayer(videoUrl);
    } else {
        showError('无效的视频链接');
    }

    // 渲染源信息
    renderResourceInfoBar();

    // 更新集数信息
    updateEpisodeInfo();

    // 渲染集数列表
    renderEpisodes();

    // 初始化排序工具栏控件状态
    initSortControlStates();

    // 综艺排序下若还有未检测的集数，自动继续检测（详情页未完成时无缝衔接）
    // 避让起播：优先等播放开始 15s 后再启动检测；15s 内无播放则直接启动（不与起播抢带宽）
    if (sortMode === 'variety' && currentEpisodes.length > 0) {
        const hasMissing = currentEpisodes.some(url => {
            const info = episodeDurationCache.get(url);
            return !info || info.status !== 'done';
        });
        if (hasMissing) deferDurationDetectionForPlayback();
    }

    // 更新排序按钮状态
    updateOrderButton();

    // 添加对进度条的监听，确保点击准确跳转
    setTimeout(() => {
        setupProgressBarPreciseClicks();
    }, 1000);

    // 添加键盘快捷键事件监听
    document.addEventListener('keydown', handleKeyboardShortcuts);

    // 添加页面离开事件监听，保存播放位置
    window.addEventListener('beforeunload', saveCurrentProgress);

    // 新增：页面隐藏（切后台/切标签）时也保存
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') {
            saveCurrentProgress();
        }
    });

    // 视频暂停时也保存
    const waitForVideo = setInterval(() => {
        if (art && art.video) {
            art.video.addEventListener('pause', saveCurrentProgress);

            // 播放进度变化时节流保存（10s 一次，写历史为轻量瘦身后开销可控）
            let lastSave = 0;
            art.video.addEventListener('timeupdate', function() {
                const now = Date.now();
                if (now - lastSave > 10000) { // 每10秒最多保存一次
                    saveCurrentProgress();
                    lastSave = now;
                }
            });

            clearInterval(waitForVideo);
        }
    }, 200);
}

// 处理键盘快捷键
function handleKeyboardShortcuts(e) {
    // 忽略输入框中的按键事件
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Alt + 左箭头 = 上一集
    if (e.altKey && e.key === 'ArrowLeft') {
        if (currentEpisodeIndex > 0) {
            playPreviousEpisode();
            showShortcutHint('上一集', 'left');
            e.preventDefault();
        }
    }

    // Alt + 右箭头 = 下一集
    if (e.altKey && e.key === 'ArrowRight') {
        if (currentEpisodeIndex < currentEpisodes.length - 1) {
            playNextEpisode();
            showShortcutHint('下一集', 'right');
            e.preventDefault();
        }
    }

    // 左箭头 = 快退
    if (!e.altKey && e.key === 'ArrowLeft') {
        if (art && art.currentTime > 5) {
            art.currentTime -= 5;
            showShortcutHint('快退', 'left');
            e.preventDefault();
        }
    }

    // 右箭头 = 快进
    if (!e.altKey && e.key === 'ArrowRight') {
        if (art && art.currentTime < art.duration - 5) {
            art.currentTime += 5;
            showShortcutHint('快进', 'right');
            e.preventDefault();
        }
    }

    // 上箭头 = 音量+
    if (e.key === 'ArrowUp') {
        if (art && art.volume < 1) {
            art.volume += 0.1;
            showShortcutHint('音量+', 'up');
            e.preventDefault();
        }
    }

    // 下箭头 = 音量-
    if (e.key === 'ArrowDown') {
        if (art && art.volume > 0) {
            art.volume -= 0.1;
            showShortcutHint('音量-', 'down');
            e.preventDefault();
        }
    }

    // 空格 = 播放/暂停
    if (e.key === ' ') {
        if (art) {
            art.toggle();
            showShortcutHint('播放/暂停', 'play');
            e.preventDefault();
        }
    }

    // f 键 = 切换全屏
    if (e.key === 'f' || e.key === 'F') {
        if (art) {
            art.fullscreen = !art.fullscreen;
            showShortcutHint('切换全屏', 'fullscreen');
            e.preventDefault();
        }
    }
}

// 显示快捷键提示
function showShortcutHint(text, direction) {
    const hintElement = document.getElementById('shortcutHint');
    const textElement = document.getElementById('shortcutText');
    const iconElement = document.getElementById('shortcutIcon');

    // 清除之前的超时
    if (shortcutHintTimeout) {
        clearTimeout(shortcutHintTimeout);
    }

    // 设置文本和图标方向
    textElement.textContent = text;

    if (direction === 'left') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path>';
    } else if (direction === 'right') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>';
    }  else if (direction === 'up') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"></path>';
    } else if (direction === 'down') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>';
    } else if (direction === 'fullscreen') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5"></path>';
    } else if (direction === 'play') {
        iconElement.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3l14 9-14 9V3z"></path>';
    }

    // 显示提示
    hintElement.classList.add('show');

    // 两秒后隐藏
    shortcutHintTimeout = setTimeout(() => {
        hintElement.classList.remove('show');
    }, 2000);
}

// =================================
// ===== 分辨率显示与清晰度切换 =====
// =================================

// 高度转清晰度标签，如 1080 -> "1080P"、2160 -> "4K"
function heightToLabel(height) {
    if (!height) return '';
    if (height >= 2160) return '4K';
    if (height >= 1440) return '2K';
    return `${height}P`;
}

// 宽高转分辨率文本，如 "1080P · 1920×1080"
function formatResolutionText(width, height) {
    if (!width || !height) return '';
    const label = heightToLabel(height);
    return label ? `${label} · ${width}×${height}` : `${width}×${height}`;
}

// 码率转显示文本，如 "4.2Mbps" / "850kbps"
function formatBitrateText(bps) {
    if (!bps || bps <= 0) return '';
    return bps >= 1000000 ? `${(bps / 1000000).toFixed(1)}Mbps` : `${Math.round(bps / 1000)}kbps`;
}

// 确保源信息栏中存在分辨率显示元素（不遮挡视频画面）
function ensureResolutionBadge() {
    if (!art) return;
    // 源信息栏可能被重新渲染，元素失效时重新获取
    if (resolutionBadgeEl && resolutionBadgeEl.isConnected) return;
    resolutionBadgeEl = document.getElementById('resolutionInfo');
}

// 更新分辨率显示文本
function updateResolutionBadge(text) {
    if (!resolutionBadgeEl) return;
    if (!text) {
        resolutionBadgeEl.style.display = 'none';
        return;
    }
    resolutionBadgeEl.textContent = text;
    resolutionBadgeEl.style.display = '';
}

// 用 video 元素实际解码的分辨率刷新徽章（最终权威值，与浏览器"统计信息"一致）
// 已知当前播放档位码率时一并显示，如 "1080P · 1920×1080 · 4.2Mbps"
function updateResolutionBadgeFromVideo() {
    if (!art || !art.video) return;
    const w = art.video.videoWidth;
    const h = art.video.videoHeight;
    if (w && h) {
        ensureResolutionBadge(); // 源信息栏可能已被重渲染，元素失效时重新获取
        // 档位码率取值链：LEVEL_SWITCHED 上报的权威声明值 → hls 当前档位声明值 → 分片实测值。
        // 单档媒体清单常没有声明码率，实测兜底保证"码率一定显示"
        let bps = playingLevelBitrate;
        if (!bps && currentHls && currentHls.levels && currentHls.levels.length) {
            const idx = currentHls.currentLevel;
            const lv = idx >= 0 ? currentHls.levels[idx] : null;
            if (lv && lv.bitrate > 0) bps = lv.bitrate;
        }
        if (!bps) bps = measuredLevelBitrate;
        let text = formatResolutionText(w, h);
        const bitrateText = formatBitrateText(bps);
        if (bitrateText) text += ` · ${bitrateText}`;
        updateResolutionBadge(text);
    }
}

// 让播放器容器尺寸贴合视频实际宽高比，消除多余黑边（全屏时交还 CSS 接管）
// 视频元数据未知时按最常见的 16:9 给出紧凑占位，避免加载前出现全宽大黑块
function applyVideoFitSize() {
    const player = document.getElementById('player');
    if (!player) return;
    if (art && (art.fullscreen || art.fullscreenWeb)) {
        player.style.removeProperty('width');
        player.style.removeProperty('height');
        player.style.removeProperty('margin');
        return;
    }
    let ratio = 16 / 9;
    if (art && art.video) {
        const vw = art.video.videoWidth;
        const vh = art.video.videoHeight;
        if (vw && vh) ratio = vw / vh;
    }
    // 基准高度与 CSS 的 60vh 保持一致；宽度按视频比例收缩，超出可用宽度时反向压缩高度，保证无黑边
    // 占位阶段同样应用该尺寸（16:9 假设），安卓竖屏上宽度触顶后高度同步压缩，避免出现全宽大黑块
    const baseH = Math.round(window.innerHeight * 0.6);
    const maxW = player.parentElement ? player.parentElement.clientWidth : window.innerWidth;
    let h = baseH;
    let w = h * ratio;
    if (w > maxW) {
        w = maxW;
        h = w / ratio;
    }
    player.style.setProperty('width', Math.round(w) + 'px', 'important');
    player.style.setProperty('height', Math.round(h) + 'px', 'important');
    player.style.setProperty('margin', '0 auto', 'important');
}
window.addEventListener('resize', applyVideoFitSize);
// 页面加载时立即应用紧凑占位（视频元数据到达后再精确贴合）
applyVideoFitSize();

// 多档清晰度时，向 ArtPlayer 设置面板添加清晰度切换菜单
// 注意：多档判断只看 levels.length（BANDWIDTH 是 master playlist 必填项）。
// 很多采集站的 m3u8 不写 RESOLUTION 声明（levels[].height 为空），
// 但实际各档编码分辨率不同，此时用码率做档位标签。
function setupQualityMenu(levels) {
    if (!art || qualityMenuAdded) return;
    const settingApi = art.setting || art.settings; // 兼容不同版本 ArtPlayer 的设置API命名
    if (!settingApi || typeof settingApi.add !== 'function') return;
    if (!levels || levels.length < 2) return; // 单层m3u8（仅一档）无法切换
    qualityMenuAdded = true;

    // 档位标签：优先用声明的分辨率高度，缺失时用码率，再兜底档位序号
    const levelLabel = (l) => {
        if (l.height) return heightToLabel(l.height);
        if (l.bitrate) return `${Math.round(l.bitrate / 1000)}kbps`;
        return '档位';
    };
    // 排序：按声明高度降序，高度缺失时按码率降序
    const withIndex = levels.map((l, idx) => ({ level: l, idx }));
    withIndex.sort((a, b) =>
        (b.level.height || 0) - (a.level.height || 0) ||
        (b.level.bitrate || 0) - (a.level.bitrate || 0)
    );
    const selector = [{ html: '自动', level: -1, default: true }].concat(
        withIndex.map(({ level, idx }) => ({
            html: levelLabel(level),
            level: idx
        }))
    );
    try {
        settingApi.add({
            html: '清晰度',
            width: 200,
            tooltip: '自动',
            selector,
            onSelect(item) {
                if (currentHls) {
                    currentHls.currentLevel = item.level;
                }
                return item.html;
            }
        });
    } catch (e) {
        qualityMenuAdded = false;
    }
}

// HTTPS 页面无法直接加载 HTTP 视频资源（浏览器混合内容拦截），需经本地代理转发
async function resolvePlayableUrl(videoUrl) {
    if (window.location.protocol === 'https:' && videoUrl.startsWith('http://')) {
        return PROXY_URL + encodeURIComponent(videoUrl);
    }
    return videoUrl;
}

// ===== 同级清晰度目录探测（单档源的多档扩展，"向下兼容"式换档） =====
// 背景：大量采集站的主播放列表只声明一个变体（如 .../index.m3u8 → 2000k/hls/index.m3u8），
// hls.js 因此永远只看到 1 个 level，"源片仅此一档"。但不少 CDN 在同级目录下还挂着
// 其它清晰度目录（500k/1000k/3000k/4000k…，如 2000k/hls/index.m3u8 的兄弟 4000k/）。
// 这里对单档源做目录探测：替换清晰度目录段逐一试探，探到的档位进入"清晰度"菜单；
// 切换 = 整条 URL 换源重建播放器（进度无缝恢复）；探不到的档位自动剔除（向下兼容）。
const TIER_LADDER_STORE_KEY = 'wdtvTierLadderV1'; // 每源主机名 → 档位目录存在性（永久缓存，避免每集重复探测）
const TIER_PREF_PREFIX = 'wdtvTierPref:';         // 每源主机名 → 用户选定档位（换集自动延续）
const TIER_HINT_PREFIX = 'wdtvTierHint:';         // 每源主机名 → "发现更多档位"提示只弹一次

// 解包同源代理 URL：/proxy/<encodeURIComponent(目标)> → 内层真实 URL；
// 非代理形式（直连播放）原样返回。HTTPS 站点播放 HTTP 源时 hls.js 看到的
// 变体地址是代理形式，档位段（/2000k/）被编码在路径里，必须解包后才能解析。
function unwrapProxiedUrl(rawUrl) {
    try {
        const u = new URL(rawUrl, window.location.href);
        if (u.origin === window.location.origin && u.pathname.startsWith(PROXY_URL)) {
            const inner = decodeURIComponent(u.pathname.slice(PROXY_URL.length));
            if (/^https?:\/\//i.test(inner)) return inner;
        }
    } catch (e) { }
    return rawUrl;
}

// 从 URL 中解析清晰度目录标记（/2000k/ 、/1500kb/ 、/2000k_1080/ 这类段）
// 兼容代理形式：先解包 /proxy/<encoded> 再解析内层真实地址
function parseTierSegment(rawUrl) {
    try {
        const inner = unwrapProxiedUrl(rawUrl);
        const u = new URL(inner);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        const m = u.pathname.match(/\/(\d{2,5})k(b)?(?:_(\d{3,4}))?(?=\/)/i);
        if (!m) return null;
        return {
            host: u.host,
            token: parseInt(m[1], 10),
            suffix: (m[2] || '').toLowerCase(), // '' | 'b'
            height: m[3] ? parseInt(m[3], 10) : null,
            seg: m[0].toLowerCase()
        };
    } catch (e) {
        return null;
    }
}

// 候选清晰度目录（控制探测数量：只探当前档位邻近倍率内的常见值）
const TIER_KBPS_LADDER = [250, 300, 500, 750, 800, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000, 8000];
const TIER_HEIGHT_COMBOS = ['500k_360', '1000k_480', '1000k_720', '1000k_1080', '2000k_720', '2000k_1080', '3000k_1080', '4000k_1080'];

function buildTierCandidateTokens(info) {
    if (info.height) {
        // 带分辨率后缀（2000k_1080 族）：探常见高/低组合
        return TIER_HEIGHT_COMBOS.filter(t => t !== info.seg.slice(1));
    }
    // 纯码率（2000k / 1500kb 族）：只探与当前档位相差 4 倍以内的档位，按接近程度取前 10
    return TIER_KBPS_LADDER
        .filter(k => k !== info.token)
        .filter(k => k >= info.token / 4 && k <= info.token * 4)
        .sort((a, b) => Math.abs(Math.log2(a / info.token)) - Math.abs(Math.log2(b / info.token)))
        .slice(0, 10)
        .map(k => `${k}k${info.suffix}`);
}

function tierUrlWithToken(variantUrl, seg, token) {
    try {
        const inner = unwrapProxiedUrl(variantUrl);
        const wasProxied = inner !== variantUrl; // 走代理播放时，候选档位 URL 须保持代理形式
        const u = new URL(inner);
        // 大小写不敏感替换档位段（URL 可能是 /2000K/ 这类大写形式）
        u.pathname = u.pathname.replace(new RegExp(seg, 'i'), '/' + token);
        const rebuilt = u.toString();
        return wasProxied ? (PROXY_URL + encodeURIComponent(rebuilt)) : rebuilt;
    } catch (e) {
        return null;
    }
}

// 探测单个档位目录：可达且为媒体列表才算存在；返回累计时长用于剔除"试看"样片
async function probeTierUrl(url, token) {
    try {
        const playable = await resolvePlayableUrl(url);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        try {
            const resp = await fetch(playable, { signal: ctrl.signal });
            if (!resp.ok) { console.info(`[tier] ${token}: HTTP ${resp.status}`); return null; }
            const text = await resp.text();
            if (!text || !text.trimStart().startsWith('#EXTM3U')) { console.info(`[tier] ${token}: 非 m3u8 内容`); return null; }
            if (text.includes('#EXT-X-STREAM-INF')) { console.info(`[tier] ${token}: 目录里又嵌主列表，不采信`); return null; } // 档位目录里又嵌主列表的不采信
            const durs = [...text.matchAll(/#EXTINF:([\d.]+)/g)].map(m => parseFloat(m[1]));
            if (!durs.length) { console.info(`[tier] ${token}: 列表无分片`); return null; }
            return durs.reduce((a, b) => a + b, 0);
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        // 超时 AbortError / CORS TypeError(Failed to fetch) / 网络错误 都会走到这里
        console.info(`[tier] ${token}: 请求失败 ${e && e.name || 'Error'}`);
        return null;
    }
}

function loadTierLadder(host) {
    try {
        const all = JSON.parse(localStorage.getItem(TIER_LADDER_STORE_KEY) || '{}');
        return (all[host] && all[host].items) ? all[host] : { items: {}, ts: 0 };
    } catch (e) {
        return { items: {}, ts: 0 };
    }
}

function saveTierLadder(host, ladder) {
    try {
        const all = JSON.parse(localStorage.getItem(TIER_LADDER_STORE_KEY) || '{}');
        all[host] = ladder;
        localStorage.setItem(TIER_LADDER_STORE_KEY, JSON.stringify(all));
    } catch (e) { /* 存储失败不影响探测 */ }
}

function getTierPref(host) {
    try {
        return JSON.parse(localStorage.getItem(TIER_PREF_PREFIX + host) || 'null');
    } catch (e) {
        return null;
    }
}

function saveTierPref(host, tier) {
    try {
        localStorage.setItem(TIER_PREF_PREFIX + host, JSON.stringify({ kbps: tier.kbps, height: tier.height || null }));
    } catch (e) { }
}

// 档位标签：带分辨率后缀用 1080P，否则用声明码率
function tierLabel(kbps, height) {
    return height ? `${height}P` : `${kbps}kbps`;
}

function makeSyntheticTier(info, variantUrl, token, dur) {
    const kbps = parseInt(token, 10);
    const hm = token.toLowerCase().match(/_(\d{3,4})$/);
    const height = hm ? parseInt(hm[1], 10) : null;
    const url = tierUrlWithToken(variantUrl, info.seg, token.toLowerCase());
    if (!url) return null;
    return { label: tierLabel(kbps, height), url, kbps, height, dur: dur || null };
}

// 单档源入口：从 hls.js 解析出的唯一变体地址里找清晰度目录，再探测同级档位
async function maybeStartTierDiscovery() {
    try {
        if (!currentHls || !currentHls.levels || currentHls.levels.length !== 1) return console.info('[tier] 跳过：非单档源，levels=' + (currentHls ? currentHls.levels.length : 'null'));
        if (!art || !art.duration || !isFinite(art.duration) || art.duration < 60) return console.info('[tier] 跳过：时长过短/未知', art && art.duration); // 参照时长过短不探测
        const lv = currentHls.levels[0];
        const variantUrl = (lv.details && lv.details.url) ? lv.details.url : lv.url;
        if (!variantUrl) return console.info('[tier] 跳过：取不到变体地址');
        const info = parseTierSegment(variantUrl);
        if (!info) return console.info('[tier] 跳过：URL 中无清晰度目录段（/NNNk/ 形式）', variantUrl);

        const runId = ++tierProbeToken;
        const refDur = art.duration;
        const ladder = loadTierLadder(info.host);
        const tokens = buildTierCandidateTokens(info);
        let trialCount = 0; // 时长校验剔除的"试看样片"目录数（面板透出，便于确认探测在工作）

        const found = await Promise.all(tokens.map(async token => {
            let ent = ladder.items[token];
            // 命中档位（ok:true）永久缓存；失败档位不落盘、每次重试
            // （旧版本持久化过 ok:false 负缓存，这里一并视为不存在，恢复重试能力）
            if (!ent || !ent.ok) {
                const dur = await probeTierUrl(tierUrlWithToken(variantUrl, info.seg, token), token);
                if (dur) {
                    ent = { ok: true, dur, ts: Date.now() };
                    ladder.items[token] = ent;
                    saveTierLadder(info.host, ladder);
                } else {
                    ent = { ok: false, ts: Date.now() };
                }
            }
            if (runId !== tierProbeToken) return null; // 换集/换源竞态：丢弃过期探测
            if (!ent.ok) return null;
            // 时长校验：与当前集时长差 10% 以内才采信（剔除 CDN 上的"试看"样片目录）
            if (ent.dur && refDur > 0 && ent.dur < refDur * 0.9) { trialCount++; return null; }
            return makeSyntheticTier(info, variantUrl, token, ent.dur);
        }));

        if (runId !== tierProbeToken) return;
        syntheticTiers = found.filter(Boolean).sort((a, b) =>
            (b.height || 0) - (a.height || 0) || b.kbps - a.kbps);
        tierProbeInfo = { host: info.host, probed: tokens.length, trials: trialCount, real: syntheticTiers.length };

        refreshQualityUiForTiers();

        // 0 档可用的透出：每源主机每次会话只弹一次，详情看控制台 [tier] 日志
        if (!syntheticTiers.length && !tierZeroToastHosts.has(info.host)) {
            tierZeroToastHosts.add(info.host);
            showToast(`同级目录已探测 ${tokens.length} 个，未发现可用清晰度档位`, 'error');
        }

        // 自动延续用户在该源的记忆档位；首次发现更多档位时提示一次
        const pref = getTierPref(info.host);
        if (pref) {
            const t = syntheticTiers.find(t => t.kbps === pref.kbps && (t.height || null) === (pref.height || null));
            if (t && t.url !== currentVideoUrl) {
                switchToTier(t, true);
                return;
            }
        } else if (syntheticTiers.length) {
            let hinted = false;
            try { hinted = localStorage.getItem(TIER_HINT_PREFIX + info.host) === '1'; } catch (e) { }
            if (!hinted) {
                try { localStorage.setItem(TIER_HINT_PREFIX + info.host, '1'); } catch (e) { }
                showToast(`检测到更多清晰度档位：${syntheticTiers.map(t => t.label).join(' / ')}，可在设置面板"清晰度"切换`, 'success');
            }
        }
    } catch (e) {
        console.warn('清晰度目录探测失败:', e);
    }
}

// 切换清晰度目录：整条 URL 换源重建（与换集同路径），进度无缝恢复
function switchToTier(tier, auto) {
    if (!art || !tier || !tier.url || tier.url === currentVideoUrl) return;
    const pos = (art && art.video) ? art.video.currentTime : 0;
    currentVideoUrl = tier.url;
    qualitySwapSeek = pos > 1 ? pos : null;
    if (!auto) {
        const info = parseTierSegment(tier.url) || parseTierSegment(baseEpisodeUrl);
        if (info) saveTierPref(info.host, tier);
    }
    initPlayer(tier.url);
}

// 探测完成后刷新清晰度相关 UI（设置面板菜单）
function refreshQualityUiForTiers() {
    setupTierSettingsMenu(); // 把档位挂进设置面板（齿轮）"清晰度"
}

// 设置面板（齿轮）中的清晰度切换菜单（单档源专用，清单解析后立即添加，探测出新档位后原位重建）：
// 真多档主列表由 setupQualityMenu 用 hls 层级切换；此处档位 = 整条 URL 换源重建
function setupTierSettingsMenu() {
    if (!art) return;
    // 真多档主列表已有"清晰度"菜单（hls.currentLevel 原生切换），不重复添加
    if (currentHls && currentHls.levels && currentHls.levels.length >= 2) return;
    const settingApi = art.setting || art.settings; // 兼容不同版本 ArtPlayer 的设置API命名
    if (!settingApi || typeof settingApi.add !== 'function') return;
    const cur = currentVideoUrl;
    const selector = [{ html: '默认', url: baseEpisodeUrl, default: cur === baseEpisodeUrl }]
        .concat(syntheticTiers.map(t => ({ html: t.label, url: t.url, default: t.url === cur })));
    const current = selector.find(s => s.default) || selector[0];
    try {
        const option = {
            name: 'tierQualityMenu',
            html: '清晰度',
            width: 200,
            // 探测跑完但 0 档可用：明确标注"仅此一档"，避免用户误以为功能失灵
            tooltip: (syntheticTiers.length || !tierProbeInfo || !tierProbeInfo.probed)
                ? current.html
                : '仅此一档',
            selector,
            onSelect(item) {
                if (item.url === currentVideoUrl) return item.html; // 已是当前档不重建播放器
                switchToTier({ url: item.url, label: item.html }, false);
                return item.html;
            }
        };
        if (tierSettingsMenuAdded) {
            // 探测出新档位：原位更新（update 保持行位置，清晰度仍紧随画质模式）
            if (typeof settingApi.update === 'function') {
                settingApi.update(option);
            } else {
                // ArtPlayer 旧版无 setting.update：移除后重挂，否则菜单永远停留在"默认"
                try { settingApi.remove('tierQualityMenu'); } catch (e) { }
                settingApi.add(option);
            }
        } else {
            settingApi.add(option);
            tierSettingsMenuAdded = true;
        }
    } catch (e) {
        tierSettingsMenuAdded = false;
    }
}

// 设置面板（齿轮）中的画质模式菜单（自动 ABR / 强制最高锁定最高画质档位）
function setupBitrateSettingsMenu() {
    if (!art || bitrateSettingsMenuAdded) return;
    const settingApi = art.setting || art.settings; // 兼容不同版本 ArtPlayer 的设置API命名
    if (!settingApi || typeof settingApi.add !== 'function') return;
    bitrateSettingsMenuAdded = true;
    const cap = getBitrateCap();
    try {
        settingApi.add({
            html: '画质模式',
            width: 200,
            tooltip: cap === 'max' ? '强制最高' : '自动',
            selector: [
                { html: '自动', cap: 'auto', default: cap !== 'max' },
                { html: '强制最高', cap: 'max', default: cap === 'max' }
            ],
            onSelect(item) {
                const val = item.cap === 'max' ? 'max' : Infinity;
                const prev = getBitrateCap();
                try { localStorage.setItem(BITRATE_CAP_KEY, String(val)); } catch (err) { }
                applyBitrateCap(val);
                // 从"强制最高"（手动锁档）切回自动时，恢复 ABR 自动挡
                try {
                    if (prev === 'max' && val !== 'max' && currentHls) currentHls.currentLevel = -1;
                    else if (currentHls && currentHls.currentLevel === -1) currentHls.nextLevel = -1; // 自动挡下让 hls 立即重新选档
                } catch (err) { }
                return item.html;
            }
        });
    } catch (e) {
        bitrateSettingsMenuAdded = false;
    }
}

// ===== 弹幕（只观看）集成：数据由 js/danmu.js（弹弹play v2 规范客户端）提供 =====
// 约定：弹幕任何异常只 console.warn / 静默，绝不影响播放；不提供任何发送弹幕的 UI

let danmuLastLoadKey = ''; // 插件最近一次发起弹幕加载的集键（判断换集后是否需要重载）

// 弹幕设置可选值（分段/迷你屏控件读取统一走 getDanmuChoice，异常时给默认值；
// 透明度为连续滑杆，走 getDanmuOpacity 不受白名单限制）
const DANMU_FONT_SIZE_CHOICES = [18, 25, 32];                     // 字号（默认 25）
const DANMU_SPEED_CHOICES = [8, 5, 3];                            // 速度：慢 8 / 标准 5 / 快 3
const DANMU_MARGIN_CHOICES = [[0, '0%'], [0, '25%'], [0, '50%']]; // 显示区域：全屏 / 3/4 屏 / 半屏

// 读取弹幕设置原始值：兼容 JSON 序列化值与裸字符串，读不到/异常返回 fallback
function getDanmuRawSetting(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null || raw === '') return fallback;
        try { return JSON.parse(raw); } catch (e) { return raw; }
    } catch (e) {
        return fallback;
    }
}

// 在可选值中取当前设置：存储值不在可选列表内时返回默认值（数组项按 JSON 串比较）
function getDanmuChoice(key, choices, defaultValue) {
    const raw = getDanmuRawSetting(key, null);
    if (raw !== null) {
        const snap = JSON.stringify(raw);
        for (const c of choices) {
            if (JSON.stringify(c) === snap) return c;
        }
    }
    return defaultValue;
}

// 弹幕透明度（连续滑杆值，0.35~1）：不入 getDanmuChoice 白名单，异常/越界回退默认
function getDanmuOpacity() {
    try {
        const raw = JSON.parse(localStorage.getItem('danmuOpacity') || 'null');
        const v = parseFloat(raw);
        if (isFinite(v) && v >= 0.35 && v <= 1) return v;
    } catch (e) { /* 静默 */ }
    return 1;
}

// 弹幕显隐状态（danmuVisible：'false' 为关，默认开）
function isDanmuVisible() {
    try {
        return localStorage.getItem('danmuVisible') !== 'false';
    } catch (e) {
        return true;
    }
}

// 防重叠开关（默认开）
function isDanmuAntiOverlap() {
    return getDanmuChoice('danmuAntiOverlap', [true, false], true) !== false;
}

// 当前集的弹幕加载键（换集/换源跟随判断依据）
function buildDanmuEpisodeKey() {
    return (baseEpisodeUrl || currentVideoUrl || '') + '#' + currentEpisodeIndex;
}

// 插件弹幕数据源：按当前播放上下文自动匹配（同步记录集键，供换集路径判断是否需要重载）
function danmuSourceForPlugin() {
    danmuLastLoadKey = buildDanmuEpisodeKey();
    return window.Danmu.getForPlayer({
        title: currentVideoTitle,
        episodeIndex: currentEpisodeIndex,
        episodeName: getEpisodeDisplayName(currentEpisodeIndex),
        episodeUrl: baseEpisodeUrl,
        totalEpisodes: currentEpisodes.length
    });
}

// 构建弹幕插件数组：插件缺失/总开关关闭时返回空数组；整体 try/catch，失败不影响播放
function buildDanmuPlugins() {
    try {
        if (typeof artplayerPluginDanmuku === 'undefined' || !window.Danmu || !window.Danmu.isEnabled()) return [];
        // 注入单集时长提供者（匹配引擎校验用；setDurationProvider 幂等，重复调用安全）
        window.Danmu.setDurationProvider(function (episodeUrl) {
            const info = episodeDurationCache.get(episodeUrl);
            return (info && info.status === 'done' && typeof info.seconds === 'number') ? info.seconds : null;
        });
        return [artplayerPluginDanmuku({
            // 数据源为异步函数：换集/换源重建实例时随插件初始化自动重新执行（天然跟随换集）
            danmuku: danmuSourceForPlugin,
            emitter: false,            // 只观看不发送（隐藏插件内置发送输入框）
            visible: isDanmuVisible(), // 初始显隐（用户上次选择，默认开）
            antiOverlap: isDanmuAntiOverlap(),
            opacity: getDanmuOpacity(),
            fontSize: getDanmuChoice('danmuFontSize', DANMU_FONT_SIZE_CHOICES, 25),
            speed: getDanmuChoice('danmuSpeed', DANMU_SPEED_CHOICES, 5),
            margin: getDanmuChoice('danmuMargin', DANMU_MARGIN_CHOICES, [0, '25%'])
        })];
    } catch (e) {
        console.warn('弹幕插件初始化失败，已静默跳过：', e);
        return [];
    }
}

// ===== 弹幕右上角按钮组（开关 + 详情）=====
// 开关按钮：点击=开启/关闭弹幕，显隐状态仅由图标斜线表达（沿用 v=121 约定）；
// 详情按钮：点击=打开/收起弹幕详情浮层（setupDanmuQuickPanel），浮层贴其下沿右对齐下拉。
// 按钮组浮于播放器右上角，与控制栏同步显隐（.art-control-show / .art-hover）；
// 手势系统 inInteractiveArea 两处过滤列表已豁免 .wdtv-dm-topbtns。
// 状态刷新直接重绘 innerHTML，不走 controls.update——其内部 remove+add 会丢失自绑监听
const DANMU_ICON_ATTRS_SM = 'viewBox="0 0 24 24" style="width:16px;height:16px;display:block" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const DANMU_ICON_SM = '<svg ' + DANMU_ICON_ATTRS_SM + '><rect x="3" y="5.2" width="18" height="13.6" rx="2.4"/><path d="M7 9.2h6.4M7 12.4h9.8M7 15.6h4.6"/></svg>';
const DANMU_ICON_SM_SLASH = '<svg ' + DANMU_ICON_ATTRS_SM + '><rect x="3" y="5.2" width="18" height="13.6" rx="2.4"/><path d="M7 9.2h6.4M7 12.4h9.8M7 15.6h4.6"/><path d="m4.6 4.4 14.8 15.2"/></svg>';
// 详情按钮图标：弹幕屏幕内嵌调节滑杆（旋钮），表达"弹幕调节/设置"，
// 与播放器原设置齿轮区分，也与开关按钮的弹幕屏幕图标区分
const DANMU_SETTINGS_ICON = '<svg ' + DANMU_ICON_ATTRS_SM + '><rect x="3" y="5.2" width="18" height="13.6" rx="2.4"/><path d="M6.8 9.6h10.4M6.8 14.4h10.4"/><circle cx="13.8" cy="9.6" r="1.8"/><circle cx="9.6" cy="14.4" r="1.8"/></svg>';
// 下载图标：向下箭头 + 底部托盘线
const DL_ICON_SM = '<svg ' + DANMU_ICON_ATTRS_SM + '><path d="M12 4.2v9.3"/><path d="m8.2 10.2 3.8 3.8 3.8-3.8"/><path d="M5.2 19.2h13.6"/></svg>';
// 缓存图标：归档盒（整集存入本地，与下载箭头区分）
const CACHE_ICON_SM = '<svg ' + DANMU_ICON_ATTRS_SM + '><rect x="4" y="4.2" width="16" height="4.6" rx="1"/><path d="M5.6 8.8V18a1.4 1.4 0 0 0 1.4 1.4h10a1.4 1.4 0 0 0 1.4-1.4V8.8"/><path d="M9.8 12.4h4.4"/></svg>';

// 开关按钮内容：visible = 弹幕当前是否显示（斜线图标=关闭）
function danmuTopSwitchHtml(visible) {
    return visible ? DANMU_ICON_SM : DANMU_ICON_SM_SLASH;
}

// 右上角工具按钮容器（弹幕开关/详情 + 下载/缓存 共用）：懒创建，同一播放器实例复用
function ensureTopToolContainer(playerRoot) {
    let wrap = playerRoot.querySelector('.wdtv-dm-topbtns');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'wdtv-dm-topbtns';
        playerRoot.appendChild(wrap);
    }
    return wrap;
}

// 右上角按钮组（常驻，随播放器实例重建）：弹幕开关 + 弹幕详情
function ensureDanmuTopButtons() {
    if (!art) return;
    const playerRoot = art.template.$player || document.querySelector('#player .art-video-player');
    if (!playerRoot || playerRoot.__wdtvDmTopBtns) return;
    playerRoot.__wdtvDmTopBtns = true;
    try {
        try { art.controls.remove('danmuToggle'); } catch (e) { } // 兼容清理：旧控制栏复合按钮
        const wrap = ensureTopToolContainer(playerRoot);
        const swBtn = document.createElement('button');
        swBtn.className = 'wdtv-dm-topbtn wdtv-dm-togglesw';
        swBtn.type = 'button';
        swBtn.title = '开启 / 关闭弹幕';
        swBtn.innerHTML = danmuTopSwitchHtml(isDanmuVisible());
        const detailBtn = document.createElement('button');
        detailBtn.className = 'wdtv-dm-topbtn wdtv-dm-detailbtn';
        detailBtn.type = 'button';
        detailBtn.title = '弹幕详情（显隐 / 数据源 / 透明度 / 字号等）';
        detailBtn.innerHTML = DANMU_SETTINGS_ICON;
        // 顺序（左→右）：弹幕开关、弹幕设置、下载、缓存——缓存/下载的 setup 先行把按钮
        // 追加进容器，弹幕两钮插到最前即得目标顺序
        wrap.insertBefore(detailBtn, wrap.firstChild);
        wrap.insertBefore(swBtn, wrap.firstChild);
        swBtn.addEventListener('click', function () {
            applyDanmuVisible(!isDanmuVisible());
        });
        detailBtn.addEventListener('click', function () {
            try {
                if (danmuPanelEntry) toggleQuickPanel(danmuPanelEntry);
                else if (typeof openDanmuMatchModal === 'function') openDanmuMatchModal(); // 浮层不可用时兜底
            } catch (err) { /* 静默 */ }
        });
        if (danmuPanelEntry) danmuPanelEntry.btn = detailBtn; // 浮层对齐锚点（alignDanmuPanel 用）
    } catch (e) {
        console.warn('弹幕右上角按钮挂载失败：', e);
    }
}

// 当前是否已有可用弹幕数据
function hasDanmuData() {
    return !!(window.Danmu && window.Danmu.getLastDanmuku() && window.Danmu.getLastDanmuku().length);
}

// 右上角按钮状态刷新：状态变化才重绘 innerHTML（避免频繁替换造成悬停/动画闪烁）；
// 浮层打开时同步浮层内容（数据源下拉/开关/分段选中态随事件实时变化）
function refreshDanmuControl() {
    try {
        const root = (art && art.template && art.template.$player) || document.querySelector('#player .art-video-player');
        const swBtn = root && root.querySelector('.wdtv-dm-togglesw');
        if (swBtn) {
            const state = isDanmuVisible() ? 'on' : 'off';
            if (swBtn.dataset.dmState !== state) {
                swBtn.dataset.dmState = state;
                swBtn.innerHTML = danmuTopSwitchHtml(isDanmuVisible());
            }
        }
        syncDanmuPanel();
    } catch (e) { /* 静默 */ }
}

// 显隐总开关：控制栏按钮与设置菜单共用（持久化 danmuVisible，默认开）
function applyDanmuVisible(visible) {
    try { localStorage.setItem('danmuVisible', visible ? 'true' : 'false'); } catch (e) { }
    try {
        const plugin = art && art.plugins && art.plugins.artplayerPluginDanmuku;
        if (plugin) {
            if (visible) plugin.show(); else plugin.hide();
        }
    } catch (e) { /* 静默 */ }
    refreshDanmuControl();
    // 用户反馈：弹幕开关点击时控制栏可能处于隐藏态（图标不可见但按钮可点中），
    // 必须给出屏幕短提示让用户知道切换结果，否则表现为"点了没反应"
    try {
        if (typeof showShortcutHint === 'function') {
            const hasData = window.Danmu && window.Danmu.getLastDanmuku() && window.Danmu.getLastDanmuku().length;
            if (!visible) showShortcutHint('弹幕已关闭');
            else if (hasData) showShortcutHint('弹幕已开启');
            else showShortcutHint('弹幕已开启，等待弹幕库匹配…');
        }
    } catch (e) { /* 静默 */ }
    // 点击后保持控制栏显示，让用户看到按钮图标的开/关状态变化
    try { if (art && art.controls) art.controls.show = true; } catch (e) { }
}

// 把全部弹幕设置实时应用到当前插件实例（透明度/字号/速度/显示区域/防重叠/显隐）
function applyDanmuConfig() {
    refreshDanmuControl();
    try {
        const plugin = art && art.plugins && art.plugins.artplayerPluginDanmuku;
        if (!plugin) return;
        plugin.config({
            opacity: getDanmuOpacity(),
            fontSize: getDanmuChoice('danmuFontSize', DANMU_FONT_SIZE_CHOICES, 25),
            speed: getDanmuChoice('danmuSpeed', DANMU_SPEED_CHOICES, 5),
            margin: getDanmuChoice('danmuMargin', DANMU_MARGIN_CHOICES, [0, '25%']),
            antiOverlap: isDanmuAntiOverlap()
        });
        plugin.reset(); // 插件 config 仅对字号自动重渲染，这里统一 reset 让其余样式立即生效
        if (isDanmuVisible()) plugin.show(); else plugin.hide();
        // 已有弹幕数据时重建渲染：必须无参 load——传参会向现有队列追加造成重复；
        // 无参 load 会清空队列并重新执行数据源函数（danmu.js 命中缓存，零网络请求）
        const last = (window.Danmu && window.Danmu.getLastDanmuku()) || [];
        if (last.length) {
            const reload = plugin.load();
            if (reload && typeof reload.catch === 'function') reload.catch(function () { });
        }
    } catch (e) {
        console.warn('应用弹幕设置失败：', e);
    }
}

// ===== 零重建实时应用（浮层调节专用）=====
// applyDanmuConfig 的 config()+reset()+load() 会清空画面并整队列重建——弹幕"消失重出"。
// 调节场景改走轻量路径：同步插件内部 option（新弹幕/seek/resize/换集自然使用新值），
// 并对运行中弹幕做一次性 style 直改（纯合成写入，无重排无重建，画面全程连续）。
// 关键：运行中弹幕的真身挂在播放器主库弹幕层 .art-danmuku（发射模块 constructor 里
// this.$danmuku = art.template.$danmuku），不是插件自己的 .artplayer-plugin-danmuku
// 设置面板容器（那里只有 apd-* 面板元素，直改它等于什么都没做）！
// 速度/显示区域/防重叠不回溯运行中弹幕（它们继续按旧参数飞完，新弹幕立即按新参数生成）；
// 透明度/字号同时直改运行中弹幕，调节即刻可见。
function applyDanmuSettingLive(key, value) {
    try {
        const plugin = art && art.plugins && art.plugins.artplayerPluginDanmuku;
        const root = art && art.template && art.template.$player;
        if (!plugin || !plugin.option || !root) return;
        plugin.option[key] = value;
        if (key !== 'opacity' && key !== 'fontSize') return;
        const layer = root.querySelector('.art-danmuku') ||
            (art.template && art.template.$danmuku);
        if (!layer) return;
        for (const el of layer.children) {
            if (el.className) continue; // 运行中弹幕元素 className 为空（$ref 复用时被显式清空）
            if (key === 'opacity') el.style.opacity = String(value);
            else el.style.fontSize = value + 'px';
        }
    } catch (e) { /* 静默 */ }
}

// 换集跟随重载：非 WebKit 浏览器换集走 art.switch（不重建实例，插件不会自动重新匹配），
// 元数据到达时检查集键，仍停留在旧集则重载数据源；重建实例路径集键一致，此处为空操作
function reloadDanmukuIfEpisodeChanged() {
    try {
        const plugin = art && art.plugins && art.plugins.artplayerPluginDanmuku;
        if (!plugin || !danmuLastLoadKey) return;
        const key = buildDanmuEpisodeKey();
        if (danmuLastLoadKey === key) return;
        danmuLastLoadKey = key; // 同步更新，避免 loadedmetadata 重复触发重载
        const reload = plugin.load(); // 无参调用：插件清空旧集队列并重新执行数据源函数
        if (reload && typeof reload.catch === 'function') reload.catch(function () { });
    } catch (e) { /* 静默 */ }
}

// ===== 弹幕设置浮层（毛玻璃快捷面板体系：数据源胶囊 / 大开关 / 可视化显示区域 / 分段控件 / 拨杆）=====
// 入口为控制栏复合弹幕按钮的齿轮分区；原设置面板"弹幕"子菜单（列表叠加式）已由本浮层整体替代

let danmuPanelEntry = null; // { key, panel, btn, playerRoot, refresh }：quickPanels 体系注册项

const DANMU_SEG_DEFS = [
    { key: 'danmuFontSize', choices: DANMU_FONT_SIZE_CHOICES, def: 25, labels: { 18: '小', 25: '标准', 32: '大' } },
    { key: 'danmuSpeed', choices: DANMU_SPEED_CHOICES, def: 5, labels: { 8: '慢', 5: '标准', 3: '快' } }
];

function setupDanmuQuickPanel() {
    if (!art) return;
    const playerRoot = art.template.$player || document.querySelector('#player .art-video-player');
    if (!playerRoot || playerRoot.__wdtvDanmuPanel) return;
    playerRoot.__wdtvDanmuPanel = true;

    const panel = document.createElement('div');
    panel.className = 'art-speed-panel wdtv-danmu-panel hidden';
    // 行式紧凑布局（与 player.css 弹幕浮层段落一一对应）：
    // 头行 = 品牌 + 显隐拨杆；行 = 标签 + 控件；底部 = 数据源下拉 + 手动匹配
    panel.innerHTML =
        '<div class="wdtv-dm-head">' +
            '<span class="wdtv-dm-brand">' + DANMU_ICON_SM + '<b>弹幕</b>' +
            '</span>' +
            '<button class="wdtv-dm-sw" data-act="toggle" type="button" title="显示 / 隐藏弹幕"><i></i></button>' +
        '</div>' +
        // 显示区域：三块迷你屏可视化（半屏 / 3/4 屏 / 全屏，data-idx 对应 DANMU_MARGIN_CHOICES 下标）
        '<div class="wdtv-dm-line">' +
            '<span class="wdtv-dm-lb">显示区域</span>' +
            '<div class="wdtv-dm-areas">' +
                '<button class="wdtv-dm-area" data-act="area" data-idx="2" type="button" title="半屏"><i style="height:50%"></i></button>' +
                '<button class="wdtv-dm-area" data-act="area" data-idx="1" type="button" title="3/4 屏"><i style="height:75%"></i></button>' +
                '<button class="wdtv-dm-area" data-act="area" data-idx="0" type="button" title="全屏"><i style="height:100%"></i></button>' +
            '</div>' +
        '</div>' +
        '<div class="wdtv-dm-line">' +
            '<span class="wdtv-dm-lb">字号</span>' +
            '<div class="wdtv-dm-seg" data-key="danmuFontSize"></div>' +
        '</div>' +
        '<div class="wdtv-dm-line">' +
            '<span class="wdtv-dm-lb">速度</span>' +
            '<div class="wdtv-dm-seg" data-key="danmuSpeed"></div>' +
        '</div>' +
        // 透明度：连续滑杆（拖动实时预览）+ 右侧当前值
        '<div class="wdtv-dm-line">' +
            '<span class="wdtv-dm-lb">透明度</span>' +
            '<input class="wdtv-dm-range" id="wdtvDmOpacity" type="range" min="0.35" max="1" step="0.05" value="1">' +
            '<span class="wdtv-dm-rv">100%</span>' +
        '</div>' +
        '<div class="wdtv-dm-line">' +
            '<span class="wdtv-dm-lb">防重叠</span>' +
            '<button class="wdtv-dm-sw" data-act="anti" type="button" style="margin-left:auto" title="同屏弹幕防重叠"><i></i></button>' +
        '</div>' +
        '<div class="wdtv-dm-foot">' +
            // 数据源自定义下拉（原生 select 展开菜单无法换肤，改为与浮层同风格的玻璃面板下拉）：
            // 当前源按钮 + 展开选项列表（data-act 经面板委托分发）
            '<span class="wdtv-dm-selwrap">' +
                '<button class="wdtv-dm-srcsel" data-act="srcpop" type="button" title="选择弹幕数据源">' +
                    '<span class="wdtv-dm-srcval">--</span>' +
                '</button>' +
                '<div class="wdtv-dm-srcpop"></div>' +
            '</span>' +
            '<button class="wdtv-dm-matchbtn" data-act="match" type="button">' +
                '<svg viewBox="0 0 24 24" style="width:14px;height:14px" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.2"/><path d="m20 20-4.4-4.4"/></svg>' +
                '<span>手动匹配</span>' +
            '</button>' +
        '</div>';
    playerRoot.appendChild(panel);

    // 构建两个分段控件（data-val 存 JSON 串，点击时还原比较；data-act/data-key 供委托分发）
    const segEls = [];
    panel.querySelectorAll('.wdtv-dm-seg').forEach(function (segEl) {
        const def = DANMU_SEG_DEFS.find(function (d) { return d.key === segEl.dataset.key; });
        if (!def) return;
        segEl.innerHTML = def.choices.map(function (v) {
            const label = (def.labels[v] !== undefined) ? def.labels[v] : String(v);
            return '<button type="button" data-act="seg" data-key="' + def.key + '" data-val="' + JSON.stringify(v) + '">' + label + '</button>';
        }).join('');
        segEls.push({ el: segEl, def: def });
    });

    // 透明度滑杆：拖动全程零重建实时生效——input 经 rAF 节流调 applyDanmuSettingLive
    //（同步插件 option + 运行中弹幕逐条 style.opacity 直改，纯合成路径无重排），
    // change（松手）落库 + 兜底应用一次 + 刷新面板。不调 plugin.update/reset/load（那会清空画面重建）
    const range = panel.querySelector('.wdtv-dm-range');
    if (range) {
        let rangeRaf = 0;
        const liveApply = function (v) {
            applyDanmuSettingLive('opacity', v);
            const pct = Math.round((v - 0.35) / (1 - 0.35) * 100);
            range.style.setProperty('--dm-fill', pct + '%');
            const rv = panel.querySelector('.wdtv-dm-rv');
            if (rv) rv.textContent = Math.round(v * 100) + '%';
        };
        range.addEventListener('input', function () {
            const v = parseFloat(range.value);
            if (!isFinite(v)) return;
            if (rangeRaf) cancelAnimationFrame(rangeRaf);
            rangeRaf = requestAnimationFrame(function () { rangeRaf = 0; liveApply(v); });
        });
        range.addEventListener('change', function () {
            if (rangeRaf) { cancelAnimationFrame(rangeRaf); rangeRaf = 0; }
            const v = parseFloat(range.value);
            if (!isFinite(v)) return;
            try { localStorage.setItem('danmuOpacity', JSON.stringify(Math.round(v * 100) / 100)); } catch (e) { /* 静默 */ }
            liveApply(v); // 兜底：最后一次 input 的 rAF 可能未及执行
            refreshDanmuControl();
        });
    }

    // 面板动态状态刷新（打开时/设置变化后/danmu:loaded 时调用）
    function refreshDanmuPanel() {
        try {
            const has = hasDanmuData();
            const on = has && isDanmuVisible();
            // 头行：显隐拨杆（未匹配时拨杆禁用，点击主按钮走手动匹配）
            const visSw = panel.querySelector('.wdtv-dm-head .wdtv-dm-sw');
            if (visSw) {
                visSw.classList.toggle('on', on);
                visSw.disabled = !has;
            }
            // 透明度滑杆 + 填充进度 + 当前值
            if (range) {
                const cur = getDanmuOpacity();
                range.value = String(cur);
                const pct = Math.round((cur - 0.35) / (1 - 0.35) * 100);
                range.style.setProperty('--dm-fill', pct + '%');
                const rv = panel.querySelector('.wdtv-dm-rv');
                if (rv) rv.textContent = Math.round(cur * 100) + '%';
            }
            // 数据源自定义下拉：候选变化时重建选项列表 + 按钮回显当前源
            const selwrap = panel.querySelector('.wdtv-dm-selwrap');
            if (selwrap && window.Danmu && window.Danmu.getSourceList) {
                const srcLabel = (window.Danmu.getActiveSourceLabel) ? window.Danmu.getActiveSourceLabel() : '';
                const valEl = selwrap.querySelector('.wdtv-dm-srcval');
                if (valEl) valEl.textContent = srcLabel || '--';
                window.Danmu.getSourceList().then(function (list) {
                    const arr = list || [];
                    const snap = arr.map(function (s) { return s.base; }).join('|');
                    const pop = selwrap.querySelector('.wdtv-dm-srcpop');
                    if (!pop) return;
                    if (pop.dataset.srcSnap !== snap) {
                        pop.dataset.srcSnap = snap;
                        pop.innerHTML = arr.length ? arr.map(function (s) {
                            return '<button class="wdtv-dm-srcopt" data-act="srcpick" type="button" data-base="' + s.base + '">' +
                                '<span class="wdtv-dm-optlb">' + s.label + '</span>' +
                                '<svg class="wdtv-dm-optck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg>' +
                                '</button>';
                        }).join('') : '<span class="wdtv-dm-srcopt wdtv-dm-srcopt-none">暂无可用数据源</span>';
                    }
                    // 兜底轮换可能切换实际生效源：每次刷新都按 base 同步选中态
                    const curBase = (window.Danmu.getActiveSourceBase) ? window.Danmu.getActiveSourceBase() : '';
                    pop.querySelectorAll('.wdtv-dm-srcopt').forEach(function (o) {
                        o.classList.toggle('active', o.dataset.base === curBase);
                    });
                }).catch(function () { /* 静默 */ });
            }
            // 分段选中态
            segEls.forEach(function (s) {
                const cur = getDanmuChoice(s.def.key, s.def.choices, s.def.def);
                s.el.querySelectorAll('button').forEach(function (b) {
                    b.classList.toggle('active', b.dataset.val === JSON.stringify(cur));
                });
            });
            // 显示区域选中态
            const curMargin = getDanmuChoice('danmuMargin', DANMU_MARGIN_CHOICES, [0, '25%']);
            const marginSnap = JSON.stringify(curMargin);
            panel.querySelectorAll('.wdtv-dm-area').forEach(function (b) {
                const idx = parseInt(b.dataset.idx, 10);
                b.classList.toggle('active', JSON.stringify(DANMU_MARGIN_CHOICES[idx]) === marginSnap);
            });
            // 防重叠拨杆
            const antiSw = panel.querySelector('.wdtv-dm-line .wdtv-dm-sw');
            if (antiSw) antiSw.classList.toggle('on', isDanmuAntiOverlap());
        } catch (e) { /* 静默 */ }
    }

    // 事件委托：所有 data-act 分发（点击后 refreshDanmuControl 会级联同步按钮与面板）
    panel.addEventListener('click', function (e) {
        const actEl = e.target.closest('[data-act]');
        if (!actEl) return;
        e.stopPropagation();
        const act = actEl.dataset.act;
        try {
            if (act === 'toggle') {
                applyDanmuVisible(!isDanmuVisible());
            } else if (act === 'match') {
                closeAllQuickPanels();
                openDanmuMatchModal();
            } else if (act === 'area') {
                const idx = parseInt(actEl.dataset.idx, 10);
                if (DANMU_MARGIN_CHOICES[idx]) {
                    const val = DANMU_MARGIN_CHOICES[idx];
                    try { localStorage.setItem('danmuMargin', JSON.stringify(val)); } catch (err) { }
                    // 零重建：新弹幕立即按新区域排布，运行中的不回溯（避免 reset 清空画面）
                    applyDanmuSettingLive('margin', val);
                }
            } else if (act === 'anti') {
                const val = !isDanmuAntiOverlap();
                try { localStorage.setItem('danmuAntiOverlap', JSON.stringify(val)); } catch (err) { }
                applyDanmuSettingLive('antiOverlap', val);
            } else if (act === 'seg') {
                // 字号/速度分段：字号同时直改运行中弹幕；速度仅作用新弹幕（运行中的飞完为止）
                const key = actEl.dataset.key;
                let val = null;
                try { val = JSON.parse(actEl.dataset.val); } catch (err) { }
                if (val !== null && (key === 'danmuFontSize' || key === 'danmuSpeed')) {
                    try { localStorage.setItem(key, JSON.stringify(val)); } catch (err) { }
                    applyDanmuSettingLive(key === 'danmuFontSize' ? 'fontSize' : 'speed', val);
                }
            } else if (act === 'srcpop') {
                // 数据源下拉：展开/收起选项列表
                const wrap = actEl.closest('.wdtv-dm-selwrap');
                if (wrap) wrap.classList.toggle('open');
            } else if (act === 'srcpick') {
                // 选定目标源（selectSource 内部锁定 + 清空旧数据与记忆映射），整链无参 load 重搜当前集。
                // 锁定源对该集无数据时 getForPlayer 会解除锁定轮换兜底（"有弹幕"优先），
                // 因此提示与下拉回显都在重载完成后取实际生效源
                const wrap = actEl.closest('.wdtv-dm-selwrap');
                if (wrap) wrap.classList.remove('open');
                const base = actEl.dataset.base;
                if (base && window.Danmu && window.Danmu.selectSource) {
                    window.Danmu.selectSource(base).then(function (label) {
                        if (typeof showShortcutHint === 'function') showShortcutHint('已选择弹幕源：' + label);
                    }).catch(function () { /* 静默 */ }).finally(function () {
                        (async function () {
                            try {
                                const plugin = art && art.plugins && art.plugins.artplayerPluginDanmuku;
                                if (plugin && typeof plugin.load === 'function') {
                                    const reload = plugin.load();
                                    if (reload && typeof reload.then === 'function') await reload;
                                }
                            } catch (err) { /* 静默 */ }
                            refreshDanmuControl(); // 重载完成后刷新：下拉回显实际生效源（可能已兜底轮换）
                        })();
                    });
                }
            }
        } catch (err) { /* 静默 */ }
        // live 路径不级联刷新（applyDanmuSettingLive 只动插件与弹幕 DOM），这里统一同步按钮与面板
        refreshDanmuControl();
    });

    // 点击面板外任意处收起源选择下拉（面板本体收起由 registerQuickPanel 统一处理）；
    // 仅移除 class 不 preventDefault，不干扰任何点击合成
    const dmSrcWrap = panel.querySelector('.wdtv-dm-selwrap');
    if (dmSrcWrap) {
        document.addEventListener('pointerdown', function (e) {
            if (!dmSrcWrap.classList.contains('open')) return;
            if (dmSrcWrap.contains(e.target)) return;
            dmSrcWrap.classList.remove('open');
        }, true);
    }

    danmuPanelEntry = { key: 'danmu', panel: panel, btn: null, playerRoot: playerRoot, refresh: refreshDanmuPanel, align: alignDanmuPanel };
    registerQuickPanel(danmuPanelEntry); // 点击外部收起/打开其他面板互斥/控制栏隐藏自动收起
    observeControlsHide(playerRoot);
}

// 面板打开状态下实时同步其内容（refreshDanmuControl 级联调用）
function syncDanmuPanel() {
    try {
        if (danmuPanelEntry && danmuPanelEntry.panel && !danmuPanelEntry.panel.classList.contains('hidden')) {
            danmuPanelEntry.refresh();
        }
    } catch (e) { /* 静默 */ }
}

// ===== 手动匹配弹幕弹窗（复用换源 #modal 玻璃容器：番剧列表 → 剧集列表 两级结构） =====

let danmuModalToken = 0;        // 弹窗内异步请求竞态令牌：慢响应不覆盖新状态
let danmuModalLastKeyword = ''; // 弹窗内最近一次搜索关键词（二级「返回」复用，免重复输入）

// 打开手动匹配弹窗（默认关键词 = 当前视频标题，打开即搜索）
function openDanmuMatchModal() {
    const modal = document.getElementById('modal');
    const modalTitle = document.getElementById('modalTitle');
    const modalContent = document.getElementById('modalContent');
    if (!modal || !modalTitle || !modalContent) return;

    modalTitle.textContent = '弹幕匹配';
    modalContent.innerHTML = `
        <div class="wdtv-danmu-match">
            <div class="wdtv-danmu-searchbar">
                <input id="danmuMatchInput" class="wdtv-danmu-input" type="text"
                       placeholder="输入作品名搜索弹幕库" value="${escapeHtml(currentVideoTitle || '')}">
                <button id="danmuMatchSearchBtn" class="wdtv-danmu-btn" type="button">搜索</button>
            </div>
            <div id="danmuMatchStatus" class="wdtv-danmu-status"></div>
            <div id="danmuMatchList" class="wdtv-danmu-list"></div>
        </div>`;
    modal.classList.remove('hidden');

    const input = document.getElementById('danmuMatchInput');
    const searchBtn = document.getElementById('danmuMatchSearchBtn');
    const doSearch = () => {
        const kw = (input.value || '').trim();
        if (kw) renderDanmuAnimeList(kw);
    };
    if (searchBtn) searchBtn.addEventListener('click', doSearch);
    if (input) input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
    });

    // 弹幕模块未加载：弹窗内文字提示即可
    if (!window.Danmu) {
        const statusEl = document.getElementById('danmuMatchStatus');
        if (statusEl) statusEl.textContent = '弹幕模块未加载';
        return;
    }
    doSearch(); // 打开即用默认关键词搜索
}

// 第一级：番剧/剧集搜索结果列表
async function renderDanmuAnimeList(keyword) {
    const statusEl = document.getElementById('danmuMatchStatus');
    const listEl = document.getElementById('danmuMatchList');
    if (!statusEl || !listEl) return;
    const token = ++danmuModalToken;
    danmuModalLastKeyword = keyword;
    listEl.innerHTML = '';
    statusEl.textContent = '搜索中...';
    let animes = [];
    try {
        animes = (await window.Danmu.searchAnime(keyword)) || [];
    } catch (e) {
        animes = []; // 失败静默：弹窗内文字提示，不弹 toast
    }
    const curList = document.getElementById('danmuMatchList');
    const curStatus = document.getElementById('danmuMatchStatus');
    if (!curList || !curStatus || token !== danmuModalToken) return; // 弹窗已关闭或已有新请求
    if (!animes.length) {
        curStatus.textContent = '无匹配结果';
        return;
    }
    // 源标注：手动匹配的三步（搜索/剧集/弹幕）都走当前活跃源，列表来自哪个源要让用户可见，
    // 否则点击失败时无从判断是否该换源重搜
    const srcLabel = (window.Danmu && typeof window.Danmu.getActiveSourceLabel === 'function')
        ? window.Danmu.getActiveSourceLabel() : '';
    curStatus.textContent = `共 ${animes.length} 条结果（数据源：${srcLabel || '未知'}），点击选择作品`;
    curList.innerHTML = animes.map((a, i) => `
        <div class="wdtv-danmu-item" data-anime-index="${i}">
            <div class="wdtv-danmu-item-title">${escapeHtml((a && a.animeTitle) || '未知作品')}</div>
            <div class="wdtv-danmu-item-sub">${escapeHtml((a && a.typeDescription) || '')}</div>
        </div>`).join('');
    curList.onclick = (ev) => {
        const item = ev.target.closest('.wdtv-danmu-item');
        if (!item) return;
        const anime = animes[parseInt(item.dataset.animeIndex, 10)];
        if (anime) renderDanmuEpisodeList(anime);
    };
}

// 第二级：所选作品的剧集列表，点选后加载该集弹幕并按「标题→episodeId」记忆匹配
async function renderDanmuEpisodeList(anime) {
    const statusEl = document.getElementById('danmuMatchStatus');
    const listEl = document.getElementById('danmuMatchList');
    if (!statusEl || !listEl || !anime) return;
    const token = ++danmuModalToken;
    statusEl.textContent = '加载剧集中...';
    listEl.innerHTML = '';
    let bangumi = null;
    try {
        bangumi = await window.Danmu.getBangumi(anime.animeId);
    } catch (e) {
        bangumi = null;
    }
    const curList = document.getElementById('danmuMatchList');
    const curStatus = document.getElementById('danmuMatchStatus');
    if (!curList || !curStatus || token !== danmuModalToken) return;
    const episodes = (bangumi && Array.isArray(bangumi.episodes)) ? bangumi.episodes : [];
    if (!episodes.length) {
        curStatus.textContent = '该作品暂无剧集数据，请换一个结果';
        return;
    }
    curStatus.textContent = `「${anime.animeTitle || '未知作品'}」共 ${episodes.length} 集，点击选择匹配集`;
    curList.innerHTML =
        '<div class="wdtv-danmu-back" id="danmuMatchBack">← 返回搜索结果</div>' +
        episodes.map((ep, i) => `
            <div class="wdtv-danmu-item" data-episode-index="${i}">
                <div class="wdtv-danmu-item-title">${escapeHtml((ep && ep.episodeTitle) || `第${i + 1}集`)}</div>
            </div>`).join('');
    curList.onclick = async (ev) => {
        // 返回上一级（用最近关键词重渲染番剧列表）
        if (ev.target.closest('#danmuMatchBack')) {
            renderDanmuAnimeList(danmuModalLastKeyword || currentVideoTitle || '');
            return;
        }
        const item = ev.target.closest('.wdtv-danmu-item');
        if (!item) return;
        const ep = episodes[parseInt(item.dataset.episodeIndex, 10)];
        if (!ep) return;
        curStatus.textContent = '加载弹幕中...';
        let picked = [];
        try {
            picked = (await window.Danmu.manualSelect({
                episodeId: ep.episodeId,
                animeTitle: anime.animeTitle || '',
                episodeTitle: ep.episodeTitle || ''
            })) || [];
        } catch (e) {
            picked = [];
        }
        // 选择成功：manualSelect 内部派发 danmu:loaded（自动带出控制栏按钮），这里补应用样式配置
        const statusAfter = document.getElementById('danmuMatchStatus');
        if (picked.length) {
            if (typeof closeModal === 'function') closeModal();
            applyDanmuConfig();
        } else if (statusAfter) {
            // 失败含源名与指引：重试需覆盖自建源冷启动（内部已自动退避重试两轮），
            // 仍失败说明该源确实无此集数据——换源后需整链重搜（跨源 ID 不兼容）
            const failSrc = (window.Danmu && typeof window.Danmu.getActiveSourceLabel === 'function')
                ? window.Danmu.getActiveSourceLabel() : '';
            statusAfter.textContent = `该集弹幕加载失败（数据源：${failSrc || '未知'}）。可稍后重试，或到 设置→弹幕→数据源 切换后重新搜索`;
        }
    };
}

// 初始化播放器
async function initPlayer(videoUrl) {
    if (!videoUrl) {
        return
    }
    videoUrl = await resolvePlayableUrl(videoUrl);

    // 重建播放器前中止旧集的后台缓存下载（换源/换集由 customType.m3u8 重新拉起）
    try { VideoCache.abortDownload('rebuild'); } catch (e) { }

    // 销毁旧实例
    if (art) {
        art.destroy();
        art = null;
    }
    // 换源/初始化时先回到 16:9 紧凑占位，元数据到达后再贴合真实比例
    applyVideoFitSize();
    resolutionBadgeEl = null;
    playingLevelBitrate = null; // 换源/换集后重置当前播放档位码率
    measuredLevelBitrate = null; // 同步重置实测码率，避免上一集的数值串台
    qualityMenuAdded = false;
    tierSettingsMenuAdded = false; // 设置面板随播放器实例销毁重建，重置探测档位菜单标记
    bitrateSettingsMenuAdded = false; // 同步重置画质模式菜单标记
    speedSettingsMenuAdded = false; // 同步重置长按倍速/区域菜单标记
    playerLocked = false; // 播放器实例重建后解锁（锁定遮罩随旧实例销毁）
    nextManifestPrefetched = false; // 重置下一集预取标志
    nextDanmuPrefetched = false; // 同步重置下一集弹幕预热标志（新集起播 30 秒后预热其下一集）
    // 隐藏上一视频残留的分辨率文本，待新视频加载后重新显示
    const prevResolutionEl = document.getElementById('resolutionInfo');
    if (prevResolutionEl) prevResolutionEl.style.display = 'none';

    // 配置HLS.js选项
    const hlsConfig = {
        debug: false,
        loader: VideoCache.wrapLoader(adFilteringEnabled ? CustomHlsJsLoader : Hls.DefaultConfig.loader),
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90,
        // 更平滑的抗抖动前向缓冲：60s 前向缓冲可吸收源站抖动（Cloudflare 代理实测
        // 吞吐约 2.4Mbps，60s@2Mbps≈15MB，内存可接受）；maxBufferSize 同步放宽避免
        // 成为高码率下 60s 缓冲的第二道闸（3Mbps×60s≈22.5MB，留一倍余量）
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        maxBufferSize: 60 * 1000 * 1000,
        // manifest 解析期间即预取首个分片：起播提前约一个 RTT
        startFragPrefetch: true,
        maxBufferHole: 0.5,
        fragLoadingMaxRetry: 6,
        fragLoadingMaxRetryTimeout: 64000,
        fragLoadingRetryDelay: 1000,
        manifestLoadingMaxRetry: 3,
        manifestLoadingRetryDelay: 1000,
        levelLoadingMaxRetry: 4,
        levelLoadingRetryDelay: 1000,
        startLevel: -1,
        // 初始带宽估计抬高：首屏更快选到合理档位，弱网不至于先锁死低档
        // （配合 abrBandWidthUpFactor=0.7 的保守升档，估高后也会快速回落）
        abrEwmaDefaultEstimate: 2000000,
        abrBandWidthFactor: 0.95,
        abrBandWidthUpFactor: 0.7,
        abrMaxWithRealBitrate: true,
        stretchShortVideoTrack: true,
        appendErrorMaxRetry: 5,  // 增加尝试次数
        liveSyncDurationCount: 3,
        liveDurationInfinity: false
    };

    // ===== 统一替换播放器内置图标 =====
    // 24 视窗线性图标：1.6 描边 / 圆角端点 / currentColor，与全站 heroicons 风格一致
    const ICON_ATTRS = 'viewBox="0 0 24 24" style="width:100%;height:100%" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
    const svgIcon = (inner) => '<svg ' + ICON_ATTRS + '>' + inner + '</svg>';
    const speakerBase = '<path d="M11.5 5.2 7.2 8.8H4.6a.6.6 0 0 0-.6.6v5.2c0 .33.27.6.6.6h2.6l4.3 3.6a.55.55 0 0 0 .9-.42V5.62a.55.55 0 0 0-.9-.42z"/>';
    const playerIcons = {
        play: svgIcon('<path d="M8 5.5v13l10.5-6.5L8 5.5z" fill="currentColor" stroke="currentColor"/>'),
        pause: svgIcon('<rect x="6.6" y="5" width="3.4" height="14" rx="1.3" fill="currentColor" stroke="none"/><rect x="14" y="5" width="3.4" height="14" rx="1.3" fill="currentColor" stroke="none"/>'),
        state: svgIcon('<path d="M8 5.5v13l10.5-6.5L8 5.5z" fill="currentColor" stroke="currentColor"/>'),
        volume: svgIcon(speakerBase + '<path d="M15.4 9.3a3.8 3.8 0 0 1 0 5.4M17.9 7a7.2 7.2 0 0 1 0 10"/>'),
        volumeClose: svgIcon(speakerBase + '<path d="m16 9.8 4.4 4.4M20.4 9.8 16 14.2"/>'),
        setting: svgIcon('<circle cx="12" cy="12" r="3.1"/><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37c1 .608 2.296.07 2.572-1.065z"/>'),
        fullscreenOn: svgIcon('<path d="M15 4h2.5A2.5 2.5 0 0 1 20 6.5V9"/><path d="M9 20H6.5A2.5 2.5 0 0 1 4 17.5V15"/>'),
        fullscreenOff: svgIcon('<path d="M13.25 7H15a2 2 0 0 1 2 2v1.75"/><path d="M10.75 17H9a2 2 0 0 0-2 2v1.75"/>'),
        airplay: svgIcon('<path d="M5.5 16.5H4.4a1.9 1.9 0 0 1-1.9-1.9V6.4c0-1.05.85-1.9 1.9-1.9h15.2c1.05 0 1.9.85 1.9 1.9v8.2c0 1.05-.85 1.9-1.9 1.9h-1.1"/><path d="m12 14.5 4.8 6H7.2l4.8-6z"/>'),
        check: svgIcon('<path d="m5.5 12.5 4.2 4.2 8.8-9.2"/>'),
        arrowLeft: svgIcon('<path d="M14.5 5.5 8 12l6.5 6.5"/>'),
        arrowRight: svgIcon('<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>'),
        switchOn: svgIcon('<rect x="2.8" y="7" width="18.4" height="10" rx="5"/><circle cx="16.2" cy="12" r="2.5" fill="currentColor" stroke="none"/>'),
        switchOff: svgIcon('<rect x="2.8" y="7" width="18.4" height="10" rx="5"/><circle cx="7.8" cy="12" r="2.5" fill="currentColor" stroke="none"/>'),
        error: svgIcon('<circle cx="12" cy="12" r="8.6"/><path d="M12 8v4.6M12 16.1v.1"/>'),
        lock: svgIcon('<rect x="5.5" y="10.5" width="13" height="9.5" rx="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
        unlock: svgIcon('<rect x="5.5" y="10.5" width="13" height="9.5" rx="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2"/>'),
        close: svgIcon('<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>'),
        playbackRate: svgIcon('<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="m12 13.5 3.2-4"/><circle cx="12" cy="13.5" r="1" fill="currentColor" stroke="none"/>'),
        aspectRatio: svgIcon('<rect x="3.5" y="6.5" width="17" height="11" rx="2"/><path d="m9 14 6-6M15 11.5V8h-3.5"/>'),
        config: svgIcon('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>'),
        flip: svgIcon('<path d="M12 3.5v17M8.5 7.5 4.5 12l4 4.5M15.5 7.5l4 4.5-4 4.5"/>'),
        loading: svgIcon('<path d="M12 3.2a8.8 8.8 0 1 1-8.8 8.8"/>')
    };

    // 关闭 ArtPlayer 内置的 双击全屏/移动端双击暂停：双击行为统一由 setupPlayerGestures 接管
    // （左 1/3 双击后退 15 秒、右 1/3 双击快进 15 秒、中间双击移动端播放暂停；
    //   双击全屏放大/缩小机制已移除，全屏仅经控制栏按钮或 F 键），
    // 避免内置 toggle 与自定义处理同时生效造成双重触发（如全屏切两次等于没切）
    try {
        if (typeof Artplayer !== 'undefined') {
            Artplayer.DBCLICK_FULLSCREEN = false;
            Artplayer.MOBILE_DBCLICK_PLAY = false;
        }
    } catch (e) { }

    // Create new ArtPlayer instance
    art = new Artplayer({
        container: '#player',
        url: videoUrl,
        type: 'm3u8',
        title: currentVideoTitle,
        volume: 0.8,
        isLive: false,
        muted: false,
        autoplay: true,
        pip: false, // 按需求移除画中画按钮
        autoSize: false,
        autoMini: false,
        screenshot: false, // 按需求移除截图按钮
        setting: true,
        loop: false,
        flip: false,
        playbackRate: false, // 关闭内置播放速度设置，统一由自定义倍速面板管理
        aspectRatio: false,
        fullscreen: true,
        fullscreenWeb: false, // 按需求移除网页全屏按钮
        subtitleOffset: false,
        miniProgressBar: true,
        mutex: true,
        backdrop: true,
        playsInline: true,
        autoPlayback: false,
        airplay: true,
        hotkey: false,
        // 关闭内置移动端"视频区域横滑 seek"手势：其灵敏度（0.5×时长/屏宽）与下方自定义手势
        // （90秒/屏宽）相互抢进度，导致屏幕提示数值与进度条不一致；禁用后屏幕横滑仅由
        // setupPlayerGestures 处理（松手才 seek），进度条拖动仍用 ArtPlayer 内置的等比映射
        gesture: false,
        theme: '#6a9ae0',
        icons: playerIcons,
        // 弹幕插件（只观看）：构建函数整体 try/catch 保护，插件失败仅告警、不影响播放；
        // 换集/换源重建实例时插件随新实例重新挂载，异步数据源自动按新标题+集数重新匹配
        plugins: buildDanmuPlugins(),
        lang: navigator.language.toLowerCase(),
        moreVideoAttr: {
            crossOrigin: 'anonymous',
        },
        customType: {
            m3u8: function (video, url) {
                // 清理之前的HLS实例
                if (currentHls && currentHls.destroy) {
                    try {
                        currentHls.destroy();
                    } catch (e) {
                    }
                }

                // 创建新的HLS实例
                const hls = new Hls(hlsConfig);
                currentHls = hls;

                // 接入整集后台缓存：登记本集 videoKey（标题/集数）并挂载清单/分片监听
                try {
                    VideoCache.setVideoKey(currentVideoUrl);
                    VideoCache.attachHls(hls);
                } catch (e) { }

                // 跟踪是否已经显示错误
                let errorDisplayed = false;
                // 跟踪是否有错误发生
                let errorCount = 0;
                // 跟踪视频是否出现bufferAppendError
                let bufferAppendErrorCount = 0;

                // 播放/进度监听（WeakSet 防重复绑定：换集不销毁 video 时监听器不再累积）
                videoPlaybackStarted = false;
                ensureErrorHideListeners(video);

                hls.loadSource(url);
                hls.attachMedia(video);

                // hls.js 1.6 ENDED 态回跳卡死兜底：seek 到临近片尾（或播完最后分片）会把流控制器
                // 置为 ENDED，之后往回 seek 时控制器不再拉起取件循环（tick 空转、不发任何请求），
                // 表现为"进度条乱点几下后一直加载、始终无画面"——即使整集已 100% 缓存。
                // 监听 seeking：ENDED 态下强制重启取件循环（startLoad 幂等，重复触发安全）。
                if (!video.__endedSeekKick) {
                    video.__endedSeekKick = true;
                    video.addEventListener('seeking', () => {
                        try {
                            if (currentHls && currentHls.streamController &&
                                currentHls.streamController.state === 'ENDED') {
                                currentHls.streamController.startLoad();
                            }
                        } catch (e) { }
                    }, { passive: true });
                }

                // enable airplay
                // 检查是否已存在source元素，如果存在则更新，不存在则创建
                let sourceElement = video.querySelector('source');
                if (sourceElement) {
                    // 更新现有source元素的URL
                    sourceElement.src = videoUrl;
                } else {
                    // 创建新的source元素
                    sourceElement = document.createElement('source');
                    sourceElement.src = videoUrl;
                    video.appendChild(sourceElement);
                }
                video.disableRemotePlayback = false;

                hls.on(Hls.Events.MANIFEST_PARSED, function (event, data) {
                    // 多档清晰度时添加设置面板切换菜单；单档源立即挂"清晰度（默认）"，
                    // 同级目录探测完成后再原位重建菜单补充档位
                    setupQualityMenu(data && data.levels);
                    setupTierSettingsMenu();
                    // 长按倍速/区域菜单排在清晰度之后（设置面板按添加顺序渲染）
                    addSpeedSettings();
                    // 应用用户设置的画质模式（新 hls 实例需重新钳制）
                    applyBitrateCap(getBitrateCap());
                    // 换源/换档重建 hls 后重新应用倍速带宽/缓冲策略：
                    // 同一 video 元素倍速未变不会触发 ratechange，但新 hls 实例是默认缓冲配置
                    applyRatePlaybackStrategy((art && art.video) ? art.video.playbackRate : 1);
                    video.play().catch(e => {
                    });
                });

                // 注意：不要用 LEVEL_SWITCHED 的 levels[].width/height 刷新徽章——
                // 那是 m3u8 里源方声明的 RESOLUTION，常与实际流不符（ABR 换档后尤其如此）。
                // 徽章统一以 video 元素实际解码分辨率为准（见 video resize 监听）。
                // 但 LEVEL_SWITCHED 的档位索引是权威的：据此取该档声明 BANDWIDTH 作为实时码率显示。
                hls.on(Hls.Events.LEVEL_SWITCHED, function (event, data) {
                    try {
                        const level = currentHls && currentHls.levels && currentHls.levels[data.level];
                        const bps = level && level.bitrate > 0 ? level.bitrate : null;
                        if (bps !== playingLevelBitrate) {
                            playingLevelBitrate = bps;
                            updateResolutionBadgeFromVideo();
                        }
                    } catch (e) { }
                });

                // 实测媒体码率兜底：单档媒体清单常没有声明 BANDWIDTH/码率，
                // 用"分片字节量 / 分片时长"估算真实媒体码率（与网络吞吐无关），EMA 平滑
                hls.on(Hls.Events.FRAG_BUFFERED, function (event, data) {
                    try {
                        const frag = data && data.frag;
                        const stats = frag && frag.stats;
                        const bytes = stats ? (stats.total || stats.loaded || 0) : 0;
                        if (!bytes || !frag.duration || frag.duration <= 0) return;
                        const bps = Math.round(bytes * 8 / frag.duration);
                        // 离群过滤：单分片估算偏差大，EMA 平滑且只在显示文本变化时刷新徽章
                        const smoothed = measuredLevelBitrate == null ? bps : Math.round(measuredLevelBitrate * 0.7 + bps * 0.3);
                        if (formatBitrateText(smoothed) !== formatBitrateText(measuredLevelBitrate)) {
                            measuredLevelBitrate = smoothed;
                            updateResolutionBadgeFromVideo();
                        } else {
                            measuredLevelBitrate = smoothed;
                        }
                    } catch (e) { }
                });

                hls.on(Hls.Events.ERROR, function (event, data) {
                    // 增加错误计数
                    errorCount++;

                    // 处理bufferAppendError
                    if (data.details === 'bufferAppendError') {
                        bufferAppendErrorCount++;
                        // 如果视频已经开始播放，则忽略这个错误
                        if (videoPlaybackStarted) {
                            return;
                        }

                        // 如果出现多次bufferAppendError但视频未播放，尝试恢复
                        if (bufferAppendErrorCount >= 3) {
                            hls.recoverMediaError();
                        }
                    }

                    // 如果是致命错误，且视频未播放
                    if (data.fatal && !videoPlaybackStarted) {
                        // 尝试恢复错误
                        switch (data.type) {
                            case Hls.ErrorTypes.NETWORK_ERROR:
                                hls.startLoad();
                                break;
                            case Hls.ErrorTypes.MEDIA_ERROR:
                                hls.recoverMediaError();
                                break;
                            default:
                                // 仅在多次恢复尝试后显示错误
                                if (errorCount > 3 && !errorDisplayed) {
                                    errorDisplayed = true;
                                    showError('视频加载失败，可能是格式不兼容或源不可用');
                                }
                                break;
                        }
                    }
                });

                // 监听分段加载事件
                hls.on(Hls.Events.FRAG_LOADED, function () {
                });

                // 监听级别加载事件
                hls.on(Hls.Events.LEVEL_LOADED, function () {
                });
            }
        }
    });

    // 移除控制栏内置音量控件（音量改由移动端手势调节，右半屏上下滑）
    try {
        art.controls.remove('volume');
    } catch (e) {
    }

    // 添加分辨率徽章（异常时不能中断播放器初始化流程）
    try {
        ensureResolutionBadge();
        // ABR 自动换档导致解码分辨率变化时，video 元素会触发 resize 事件，据此刷新徽章
        art.video.addEventListener('resize', updateResolutionBadgeFromVideo);
    } catch (e) {
        console.warn('分辨率徽章挂载失败:', e);
    }

    // artplayer 没有 'fullscreenWeb:enter', 'fullscreenWeb:exit' 等事件
    // 所以原控制栏隐藏代码并没有起作用
    // 实际起作用的是 artplayer 默认行为，它支持自动隐藏工具栏
    // 但有一个 bug： 在副屏全屏时，鼠标移出副屏后不会自动隐藏工具栏
    // 下面进一并重构和修复：
    let hideTimer;

    // 隐藏控制栏
    function hideControls() {
        if (art && art.controls) {
            art.controls.show = false;
        }
    }

    // 重置计时器，计时器超时时间与 artplayer 保持一致
    function resetHideTimer() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            hideControls();
        }, Artplayer.CONTROL_HIDE_TIME);
    }

    // 处理鼠标离开浏览器窗口
    function handleMouseOut(e) {
        if (e && !e.relatedTarget) {
            resetHideTimer();
        }
    }

    // 全屏状态切换时注册/移除 mouseout 事件，监听鼠标移出屏幕事件
    // 从而对播放器状态栏进行隐藏倒计时
    function handleFullScreen(isFullScreen, isWeb) {
        if (isFullScreen) {
            document.addEventListener('mouseout', handleMouseOut);
        } else {
            document.removeEventListener('mouseout', handleMouseOut);
            // 退出全屏时清理计时器
            clearTimeout(hideTimer);
        }

        // 进入全屏直接清除贴合尺寸交还 CSS，退出全屏按视频比例恢复
        const fitPlayer = document.getElementById('player');
        if (fitPlayer) {
            if (isFullScreen) {
                fitPlayer.style.removeProperty('width');
                fitPlayer.style.removeProperty('height');
                fitPlayer.style.removeProperty('margin');
            } else {
                applyVideoFitSize();
            }
        }

        if (!isWeb) {
            if (window.screen.orientation && window.screen.orientation.lock) {
                window.screen.orientation.lock('landscape')
                    .then(() => {
                    })
                    .catch((error) => {
                    });
            }
        }
    }

    // 播放器加载完成后初始隐藏工具栏
    art.on('ready', () => {
        hideControls();
    });

    // 全屏模式处理
    art.on('fullscreen', function (isFullScreen) {
        handleFullScreen(isFullScreen, false);
    });

    art.on('video:loadedmetadata', function() {
        videoHasEnded = false; // 视频加载时重置结束标志

        // 弹幕跟随换集：非 WebKit 换集走 art.switch（不重建实例、插件不会自动重新匹配），
        // 元数据到达时若弹幕数据仍停留在旧集则重载；重建实例路径集键一致，此处为空操作
        reloadDanmukuIfEpisodeChanged();

        // 恢复全局记忆的播放倍速（换剧/换集后保持用户上次选定的速度）
        // 倍速>1 时先以 1x 起播（换集加载期不卡顿），待 playing 确认流畅后自动恢复
        if (speedConfig.playbackRate > 1) {
            try {
                stallRateGuard.active = true;
                stallRateGuard.rate = speedConfig.playbackRate;
                stallRateGuard.half = false;
                art.playbackRate = 1;
            } catch (e) {
            }
        }

        // 容器尺寸贴合视频真实宽高比，消除多余黑边
        applyVideoFitSize();

        // 用视频元数据中的真实分辨率刷新徽章（单层m3u8时这是唯一可靠来源）
        ensureResolutionBadge();
        updateResolutionBadgeFromVideo();

        // 清晰度目录切换后的播放位置恢复（换档是整条 URL 重建播放器）
        if (qualitySwapSeek != null) {
            try {
                if (art.duration && art.duration > qualitySwapSeek + 2) art.currentTime = qualitySwapSeek;
            } catch (e) { }
            qualitySwapSeek = null;
        }

        // 单档源（伪主列表/媒体列表）：探测同级清晰度目录，向下兼容补充多档位
        maybeStartTierDiscovery();

        // 优先使用URL传递的position参数
        const urlParams = new URLSearchParams(window.location.search);
        const savedPosition = parseInt(urlParams.get('position') || '0');

        if (savedPosition > 10 && savedPosition < art.duration - 2) {
            // 如果URL中有有效的播放位置参数，直接使用它
            art.currentTime = savedPosition;
            showPositionRestoreHint(savedPosition);
        } else {
            // 否则尝试从本地存储恢复播放进度
            try {
                const progressKey = 'videoProgress_' + getVideoId();
                const progressStr = localStorage.getItem(progressKey);
                if (progressStr && art.duration > 0) {
                    const progress = JSON.parse(progressStr);
                    if (
                        progress &&
                        typeof progress.position === 'number' &&
                        progress.position > 10 &&
                        progress.position < art.duration - 2
                    ) {
                        art.currentTime = progress.position;
                        showPositionRestoreHint(progress.position);
                    }
                }
            } catch (e) {
            }
        }

        // 设置进度条点击监听
        setupProgressBarPreciseClicks();

        // 视频加载成功后，在稍微延迟后将其添加到观看历史
        setTimeout(saveToHistory, 3000);
    })

    // 错误处理
    art.on('video:error', function (error) {
        // 如果正在切换视频，忽略错误
        if (window.isSwitchingVideo) {
            return;
        }

        // 隐藏所有加载指示器
        showError('视频播放失败: ' + (error.message || '未知错误'));
    });

    // 控制栏快捷功能：选集 / 倍速 / 缓存；清晰度与画质模式在设置面板（齿轮）内
    // 画质模式先于清晰度添加（面板按添加顺序渲染，清晰度在其下方）；长按倍速/区域在清单解析后添加
    setupEpisodeControlButton();
    setupRateControlButton();
    setupCacheControlButton();
    setupDownloadControlButton();
    setupCinemaFavoriteButton();
    setupBitrateSettingsMenu();
    // 弹幕设置浮层 + 右上角按钮组（浮层先建好，详情按钮通过 entry 打开它）
    setupDanmuQuickPanel();
    // 右上角弹幕按钮组常驻：开关按钮即时生效，数据加载后由 danmu:loaded 校正确认
    try { ensureDanmuTopButtons(); } catch (e) { }

    // 弹幕加载事件：右上角按钮组与设置浮层同步（弹幕成功加载后刷新按钮与浮层数据源等）。
    // 监听器随实例生命周期：命名函数注册，实例销毁时移除，避免跨实例累积
    const onDanmuLoaded = function () {
        try { ensureDanmuTopButtons(); } catch (e) { }
        // 数据就绪后校正显隐：用户可能在数据尚未就绪时点过开关（show 了也没内容，
        // 且 loaded 到达后插件不会自行按持久化状态刷新），此处强制与 danmuVisible 对齐
        try {
            const plugin = art && art.plugins && art.plugins.artplayerPluginDanmuku;
            if (plugin) {
                if (isDanmuVisible()) { if (plugin.isHide) plugin.show(); }
                else if (!plugin.isHide) plugin.hide();
            }
        } catch (e) { }
        // 数据就绪后刷新复合按钮与设置浮层（按钮状态点/浮层数据源胶囊等随实际命中源同步）
        try { refreshDanmuControl(); } catch (e) { /* 静默 */ }
    };
    const onDanmuUnavailable = function () {
        // 匹配失败不移除按钮（常驻入口）：更新为"未匹配"态（点击打开手动匹配）
        try { refreshDanmuControl(); } catch (e) { }
    };
    window.addEventListener('danmu:loaded', onDanmuLoaded);
    window.addEventListener('danmu:unavailable', onDanmuUnavailable);
    art.on('destroy', function () {
        window.removeEventListener('danmu:loaded', onDanmuLoaded);
        window.removeEventListener('danmu:unavailable', onDanmuUnavailable);
    });

    // 添加长按倍速播放功能（左右热区/倍速可在设置面板自定义，全局记忆）
    setupLongPressSpeedControl();

    // 移动端手势：左半屏上下滑=亮度，右半屏上下滑=音量，横滑=拖动进度（类爱奇艺/腾讯/优酷）
    setupPlayerGestures();
    // 播放器锁定：控制栏锁按钮 + 锁定遮罩 + 左侧解锁悬浮钮
    setupLockButton();
    // 右侧画面按钮：截图/录屏入口（屏幕右侧原锁定钮位置，随控制栏显隐）
    setupPhotoButton();

    // ===== 通用卡顿降速保护 =====
    // 判断 seek 目标（seeking 时 currentTime 已是新位置）是否落在已有缓冲区间内
    function isSeekTargetBuffered(v) {
        try {
            const t = v.currentTime;
            for (let i = 0; i < v.buffered.length; i++) {
                if (t >= v.buffered.start(i) - 0.5 && t < v.buffered.end(i)) return true;
            }
        } catch (e) { }
        return false;
    }
    // 卡顿判定：readyState 低于 HAVE_FUTURE_DATA(3) 表示数据不足以维持连续播放
    function isVideoStalled(v) {
        return v.readyState < 3;
    }
    // 降为 1x 进入保护：seek 预降速 / waiting 卡顿 / 换集起播共用此入口
    function dropTo1xForSmooth(v, rate) {
        stallRateGuard.active = true;
        stallRateGuard.rate = rate;
        stallRateGuard.half = false;
        stallRateGuard.since = Date.now(); // 防抖起点：至少保持 1x 满 1 秒才允许分级恢复
        try { v.playbackRate = 1; } catch (e) { }
    }
    // 结束保护并恢复原倍速；若期间用户手动改了倍速则不覆盖
    function finishStallGuard(v) {
        const rate = stallRateGuard.rate;
        stallRateGuard.active = false;
        stallRateGuard.half = false;
        stallRateGuard.rate = 1; // 清零待恢复倍速，避免残留值遮蔽下一次卡顿的降速判定
        if (v && Math.abs(v.playbackRate - rate) > 0.001) {
            try { v.playbackRate = rate; } catch (e) { }
        }
    }
    // 播放器 MSE 缓冲余量：当前位置之后还能立即连续播放的秒数（卡不卡的真实依据）
    function bufferedAheadSeconds(v) {
        try {
            const t = v.currentTime;
            for (let i = 0; i < v.buffered.length; i++) {
                if (t >= v.buffered.start(i) - 0.5 && t < v.buffered.end(i)) {
                    return v.buffered.end(i) - t;
                }
            }
        } catch (e) { }
        return 0;
    }
    // 精细化恢复评估（timeupdate 驱动）：三级门槛防横跳
    // ① 防抖：降速后至少满 1 秒才评估，避免 waiting→playing 一秒内来回切
    // ② MSE 缓冲余量：半速需 ≥4 秒、全速需 ≥max(6, 2×倍速) 秒（真实"还能播多久"）
    // ③ 磁盘缓存跑道随倍速缩放：半速 ≥7 秒、全速 ≥max(12, 4×倍速) 秒（4x 需 16 秒）
    // 缓存关闭/不可用时只看 MSE 余量；临近片尾（后面内容不足阈值）视为已就绪
    function evaluateStallGuardRestore() {
        if (!stallRateGuard.active) return;
        const v = (art && art.video) ? art.video : null;
        if (!v || v.paused || longPressBoostActive || isVideoStalled(v)) return;
        if (Date.now() - stallRateGuard.since < 1000) return; // 防抖窗口
        const rate = stallRateGuard.rate;
        const fullAhead = Math.max(6, 2 * rate);  // 全速恢复所需 MSE 缓冲余量
        const ahead = bufferedAheadSeconds(v);
        let cachedSec = 0, totalSec = 0, cacheUsable = false;
        try {
            const cs = VideoCache.cachedSecondsAfterPosition();
            cachedSec = cs.cached; totalSec = cs.total;
            const session = VideoCache.getSession();
            cacheUsable = !!(session && session.enabled);
        } catch (e) { }
        // 磁盘缓存跑道阈值随倍速缩放；临近片尾（后面内容不足）视为已就绪
        const fullSec = cacheUsable ? Math.max(12, 4 * rate) : 0;
        const cacheFullOk = !cacheUsable || cachedSec >= fullSec || totalSec < fullSec;
        if (cacheFullOk && ahead >= fullAhead) {
            finishStallGuard(v);
        } else if (!stallRateGuard.half && cacheUsable &&
                   (cachedSec >= 7 || totalSec < 7) && ahead >= 4) {
            // 无级半速过渡：磁盘缓存和 MSE 余量都过半速门槛才启用，避免缓冲不足时提速再卡
            stallRateGuard.half = true;
            try { v.playbackRate = Math.max(1, rate / 2); } catch (e) { }
        }
    }
    // 卡顿开始（waiting）：当前倍速 > 1 则降为 1x；保护中再次卡顿 → 回到 1x 重新分级
    function tryStallRateDrop() {
        const v = (art && art.video) ? art.video : null;
        if (!v || v.paused || longPressBoostActive) return;
        const cur = v.playbackRate;
        if (stallRateGuard.active) {
            // 保护中再次卡顿：回到 1x（半速也回），等恢复播放后重新分级
            stallRateGuard.half = false;
            try { v.playbackRate = 1; } catch (e) { }
        } else if (cur > 1.001) {
            // 非保护状态卡顿（以 active 为准，不能用残留 rate 对比，否则二次卡顿永不降速）
            dropTo1xForSmooth(v, cur);
        }
    }
    art.on('video:waiting', function () {
        try { tryStallRateDrop(); } catch (e) { }
    });
    art.on('video:playing', function () {
        try { tryStallRateRestore(); } catch (e) { }
    });

    // 跟踪用户拖拽状态：seeking 置位，正常播放心跳（timeupdate）复位
    art.on('video:seeking', function () {
        isUserSeeking = true;
        // seek 改变缓存优先级锚点：立即按新位置重新判定 30 秒窗口闸门与取件顺序
        try { VideoCache.notePositionChange(); } catch (e) { }
        // 倍速播放中跳到未缓冲区域：先降为 1x，避免高倍速下起播即卡；
        // 恢复完全由片段缓存判定驱动（无时间兜底）
        try {
            const v = art.video;
            if (!v.paused && !longPressBoostActive && !isSeekTargetBuffered(v)) {
                if (v.playbackRate > 1.001) {
                    dropTo1xForSmooth(v, v.playbackRate);
                } else if (stallRateGuard.active) {
                    // 保护期内再次 seek 未缓冲区：回到 1x（半速也回）重新分级
                    stallRateGuard.half = false;
                    try { v.playbackRate = 1; } catch (e) { }
                }
            }
        } catch (e) { }
    });
    art.on('video:timeupdate', function () {
        isUserSeeking = false;
        // 精细化倍速恢复评估：后 12 秒缓存齐 → 全速恢复；后 7 秒 → 半速过渡（无时间兜底）
        try { evaluateStallGuardRestore(); } catch (e) { }
        // 剩余时长不足 60 秒（或不足 10%）时预取下一集 m3u8 文本，实现无缝连播
        if (art && art.video && isFinite(art.video.duration) && art.video.duration > 0) {
            const remaining = art.video.duration - art.video.currentTime;
            if (remaining < 60 || remaining < art.video.duration * 0.1) {
                prefetchNextEpisodeManifest();
            }
        }
        // 下一集弹幕预热：起播 30 秒后触发一次（后台静默完成搜索/匹配/拉取并写缓存），
        // 换集时缓存命中秒回，消除"换集后弹幕消失"的匹配空窗
        try {
            if (art && art.video && art.video.currentTime > 30) {
                prefetchNextEpisodeDanmu();
            }
        } catch (e) { /* 静默 */ }
    });

    // 倍速变化 → 带宽/缓冲策略（含长按临时倍速）：高倍速让出全部带宽给播放并放大缓冲目标
    art.on('video:ratechange', function () {
        if (!art || !art.video) return;
        // 保护期内用户手动改倍速（不是 1x / 待恢复值 / 半速过渡值）：取消保护，尊重用户选择
        try {
            if (stallRateGuard.active &&
                Math.abs(art.video.playbackRate - 1) > 0.001 &&
                Math.abs(art.video.playbackRate - stallRateGuard.rate) > 0.001 &&
                Math.abs(art.video.playbackRate - stallRateGuard.rate / 2) > 0.001) {
                clearStallSmoothTimer();
                stallRateGuard.active = false;
                stallRateGuard.half = false;
            }
        } catch (e) { }
        applyRatePlaybackStrategy(art.video.playbackRate);
    });

    // 视频播放结束事件
    art.on('video:ended', function () {
        videoHasEnded = true;

        clearVideoProgress();

        // 如果自动播放下一集开启，且确实有下一集（综艺模式按综艺列表顺序判断）
        if (autoplayEnabled && hasNextEpisode()) {
            // 稍长延迟以确保所有事件处理完成
            setTimeout(() => {
                // 用户拖拽到结尾触发的假结束事件不应自动连播
                if (isUserSeeking) {
                    videoHasEnded = false;
                    return;
                }
                playNextEpisode();
                videoHasEnded = false; // 重置标志
            }, 1000);
        } else {
            art.fullscreen = false;
        }
    });

    // 双击/双触 seek（左 1/3 后退 15 秒、右 1/3 快进 15 秒、中间移动端播放暂停）
    // 统一在 setupPlayerGestures 内绑定 art.on('dblclick') + 触摸双击检测（无全屏切换）
}

// ===== 下一集 m3u8 预取（自动连播无缝换集） =====
// 仅预取 manifest 文本（几十 KB），不预下分片，不占用当前集播放带宽；
// 换集时 CustomHlsJsLoader 命中缓存直接以缓存文本回调，省去一次上游往返。
const nextManifestCache = new Map(); // 播放地址 -> m3u8 文本
let nextManifestPrefetched = false;  // 当前集是否已触发过预取（换集时重置）
let nextDanmuPrefetched = false;     // 当前集是否已触发过下一集弹幕预热（换集时重置）

// 下一集弹幕预热：提前完成下一集的搜索/匹配/拉取并写入缓存与记忆映射，
// 换集时 tryMatchAndLoad 缓存命中直接渲染，消除匹配空窗
function prefetchNextEpisodeDanmu() {
    if (nextDanmuPrefetched || !window.Danmu || !window.Danmu.preloadEpisode) return;
    if (!currentEpisodes || !hasNextEpisode()) return;
    const nextIndex = sortMode === 'variety' ? getVarietyNeighborIndex(1) : currentEpisodeIndex + 1;
    if (nextIndex === null || nextIndex === undefined || !currentEpisodes[nextIndex]) return;
    nextDanmuPrefetched = true;
    window.Danmu.preloadEpisode({
        title: currentVideoTitle,
        episodeIndex: nextIndex,
        episodeName: getEpisodeDisplayName(nextIndex),
        episodeUrl: currentEpisodes[nextIndex],
        totalEpisodes: currentEpisodes.length
    }).catch(() => { /* 预热失败不影响换集路径 */ });
}

function prefetchNextEpisodeManifest() {
    if (nextManifestPrefetched || !autoplayEnabled) return;
    if (!currentEpisodes || !hasNextEpisode()) return;
    // 综艺模式下按综艺列表顺序预取真正的下一集，保证无缝连播目标与连播一致
    const nextIndex = sortMode === 'variety' ? getVarietyNeighborIndex(1) : currentEpisodeIndex + 1;
    const nextUrl = (nextIndex !== null && nextIndex !== undefined) ? currentEpisodes[nextIndex] : null;
    if (!nextUrl || !/\.m3u8([?#]|$)/i.test(nextUrl)) return; // 仅预取 m3u8
    nextManifestPrefetched = true;
    resolvePlayableUrl(nextUrl).then(playableUrl => {
        if (nextManifestCache.has(playableUrl)) return;
        fetch(playableUrl)
            .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
            .then(text => {
                if (text && text.includes('#EXTM3U')) {
                    nextManifestCache.set(playableUrl, text);
                }
            })
            .catch(() => { /* 预取失败不影响正常连播路径 */ });
    });
}

// 自定义M3U8 Loader用于过滤广告
class CustomHlsJsLoader extends Hls.DefaultConfig.loader {
    constructor(config) {
        super(config);
        const load = this.load.bind(this);
        this.load = function (context, config, callbacks) {
            // 拦截manifest和level请求
            if (context.type === 'manifest' || context.type === 'level') {
                // 命中下一集预取缓存：直接以缓存文本回调，免网络往返
                const cached = nextManifestCache.get(context.url);
                if (cached) {
                    const onSuccess = callbacks.onSuccess;
                    const filtered = filterAdsFromM3U8(cached);
                    const now = performance.now();
                    // 构造 hls.js 期望的 LoadStats 形状：其内部会读取 loading/parsing/buffer
                    // 等嵌套字段做统计计算，形状缺失会抛 TypeError 导致换集失败
                    const stats = {
                        aborted: false,
                        loaded: filtered.length,
                        retry: 0,
                        total: filtered.length,
                        chunkCount: 1,
                        bwEstimate: 0,
                        loading: { start: now, first: now, end: now },
                        parsing: { start: now, end: now },
                        buffer: { start: 0, end: 0 }
                    };
                    setTimeout(() => {
                        onSuccess({ url: context.url, data: filtered }, stats, context);
                    }, 0);
                    return;
                }
                const onSuccess = callbacks.onSuccess;
                callbacks.onSuccess = function (response, stats, context) {
                    // 如果是m3u8文件，处理内容以移除广告分段
                    if (response.data && typeof response.data === 'string') {
                        // 过滤掉广告段 - 实现更精确的广告过滤逻辑
                        response.data = filterAdsFromM3U8(response.data);
                    }
                    return onSuccess(response, stats, context);
                };
            }
            // 执行原始load方法
            load(context, config, callbacks);
        };
    }
}

// 过滤可疑的广告内容（移除 #EXT-X-DISCONTINUITY 不连续标记，掐断广告段拼接）
function filterAdsFromM3U8(m3u8Content) {
    if (!m3u8Content) return '';

    // 按行分割M3U8内容
    const lines = m3u8Content.split('\n');
    const filteredLines = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 只过滤#EXT-X-DISCONTINUITY标识
        if (!line.includes('#EXT-X-DISCONTINUITY')) {
            filteredLines.push(line);
        }
    }

    return filteredLines.join('\n');
}


// 显示错误
function showError(message) {
    // 在视频已经播放的情况下不显示错误
    if (art && art.video && art.video.currentTime > 1) {
        return;
    }
    const errorEl = document.getElementById('error');
    if (errorEl) errorEl.style.display = 'flex';
    const errorMsgEl = document.getElementById('error-message');
    if (errorMsgEl) errorMsgEl.textContent = message;
}

// 集显示名：真实集名优先，无集名降级「第N集」；单集视频返回空串（无需集标签）
function getEpisodeDisplayName(i) {
    if (!Array.isArray(currentEpisodes) || currentEpisodes.length <= 1) return '';
    return (currentEpisodeNames[i] || '').trim() || `第${i + 1}集`;
}

// 更新集数信息
function updateEpisodeInfo() {
    if (currentEpisodes.length > 0) {
        const posText = `第 ${currentEpisodeIndex + 1}/${currentEpisodes.length} 集`;
        const name = (currentEpisodeNames[currentEpisodeIndex] || '').trim();
        // 有真实集名（如「第20251001期回顾特辑」）时显示在集数位置信息前
        document.getElementById('episodeInfo').textContent = name ? `${name}（${posText}）` : posText;
    } else {
        document.getElementById('episodeInfo').textContent = '无集数信息';
    }
}

// 渲染集数按钮列表（排序方式与时长标签与首页详情弹窗同款）
function renderEpisodes() {
    const episodesList = document.getElementById('episodesList');
    if (!episodesList) return;

    if (!currentEpisodes || currentEpisodes.length === 0) {
        episodesList.innerHTML = '<div class="col-span-full text-center text-gray-500 py-8">没有可用的集数</div>';
        return;
    }

    // 综艺排序：按时长分为"X分钟以上 / X分钟以下"两组，各自成块
    if (sortMode === 'variety') {
        episodesList.innerHTML = renderVarietyEpisodes();
        return;
    }

    // 详细列表模式：每行一条，完整显示集名
    if (episodeViewMode === 'list') {
        const rows = currentEpisodes.map((_, i) => i);
        if (episodesReversed) rows.reverse();
        episodesList.innerHTML = `<div class="wdtv-ep-list">` + rows.map((realIndex, pos) =>
            renderEpisodeRow(realIndex, pos + 1, realIndex === currentEpisodeIndex)
        ).join('') + `</div>`;
        return;
    }

    const episodes = episodesReversed ? [...currentEpisodes].reverse() : currentEpisodes;
    let html = '';

    episodes.forEach((episode, index) => {
        // 根据倒序状态计算真实的剧集索引
        const realIndex = episodesReversed ? currentEpisodes.length - 1 - index : index;
        const isActive = realIndex === currentEpisodeIndex;
        html += renderEpisodeButton(realIndex, index + 1, isActive);
    });

    episodesList.innerHTML = html;
}

// 详细列表模式：渲染单行剧集条目（完整集名，不截断；时长右对齐）
function renderEpisodeRow(realIndex, groupNum, isActive) {
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
             onclick="playEpisode(${realIndex})"
             class="wdtv-ep-row${isActive ? ' episode-active' : ''}">
            <span class="ep-row-num">${originalNum}</span>
            <span class="ep-row-name">${escapeHtml(displayName)}</span>
            ${durHtml}
        </div>
    `;
}

// 渲染单个集数按钮（groupNum 为综艺排序下的组内序号）
// 数字方块模式只显示序号（+可选时长），集名只在「剧集信息」详细列表中展示
function renderEpisodeButton(realIndex, groupNum, isActive) {
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
                onclick="playEpisode(${realIndex})"
                class="episode-btn-glass${isActive ? ' episode-active' : ''}">
            ${numHtml}
            ${durHtml}
        </button>
    `;
}

// 综艺排序分组：时长 ≥ 分组线归"X分钟以上"组，其余（含未检测/检测失败）归"X分钟以下"组；
// 组内保持原顺序，检测完成后会实时重排
function getVarietyGroups() {
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
    return { longIdx, shortIdx };
}

// 综艺模式连播邻居：按综艺列表顺序（长组→短组，与集数展示一致）取当前集的上/下一集真实索引；
// direction: 1 下一集 | -1 上一集；无邻居返回 null
function getVarietyNeighborIndex(direction) {
    const { longIdx, shortIdx } = getVarietyGroups();
    const order = longIdx.concat(shortIdx);
    const pos = order.indexOf(currentEpisodeIndex);
    if (pos === -1) return null;
    const neighbor = order[pos + direction];
    return (neighbor === undefined || neighbor === null) ? null : neighbor;
}

// 是否还有下一集（随排序方式变化：综艺模式按综艺列表顺序判断）
function hasNextEpisode() {
    if (!currentEpisodes || currentEpisodes.length === 0) return false;
    if (sortMode === 'variety') return getVarietyNeighborIndex(1) !== null;
    return currentEpisodeIndex < currentEpisodes.length - 1;
}

// 综艺排序渲染：两组按 长组→短组 依次成块，各组单独从 1 编号
function renderVarietyEpisodes() {
    const { longIdx, shortIdx } = getVarietyGroups();

    const buildSection = (label, indices) => {
        if (indices.length === 0) return '';
        // 详细列表模式下分组内也用整行条目，容器换成列表布局
        const isList = episodeViewMode === 'list';
        const items = indices.map((realIndex, pos) =>
            isList
                ? renderEpisodeRow(realIndex, pos + 1, realIndex === currentEpisodeIndex)
                : renderEpisodeButton(realIndex, pos + 1, realIndex === currentEpisodeIndex)
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

// 播放指定集数
function playEpisode(index) {
    // 确保index在有效范围内
    if (index < 0 || index >= currentEpisodes.length) {
        return;
    }

    // 保存当前播放进度（如果正在播放）
    if (art && art.video && !art.video.paused && !videoHasEnded) {
        saveCurrentProgress();
    }

    // 首先隐藏之前可能显示的错误
    const errEl = getErrorEl();
    if (errEl) errEl.style.display = 'none';

    // 获取 sourceCode
    const urlParams2 = new URLSearchParams(window.location.search);
    const sourceCode = urlParams2.get('source_code');

    // 准备切换剧集的URL
    const url = currentEpisodes[index];

    // 更新当前剧集索引
    currentEpisodeIndex = index;
    currentVideoUrl = url;
    baseEpisodeUrl = url;          // 新集的进度键基准
    syntheticTiers = [];           // 新集重置探测档位（loadedmetadata 后重新探测）
    tierProbeInfo = null;          // 新集重置探测摘要（面板提示用）
    tierProbeToken++;              // 作废上一集仍在飞行中的探测
    qualitySwapSeek = null;        // 换集不继承换档恢复位置
    videoHasEnded = false; // 重置视频结束标志
    nextManifestPrefetched = false; // 重置下一集预取标志，新集临近结尾时再预取其下一集
    nextDanmuPrefetched = false; // 同步重置下一集弹幕预热标志

    clearVideoProgress();

    // 更新URL参数（不刷新页面）
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set('index', index);
    currentUrl.searchParams.set('url', url);
    currentUrl.searchParams.delete('position');
    window.history.replaceState({}, '', currentUrl.toString());

    if (isWebkit) {
        initPlayer(url);
    } else {
        resolvePlayableUrl(url).then((switchUrl) => { art.switch = switchUrl; });
    }

    // 更新UI
    updateEpisodeInfo();
    renderEpisodes();

    // 重置用户点击位置记录
    userClickedPosition = null;

    // 三秒后保存到历史记录
    setTimeout(() => saveToHistory(), 3000);
}

// 播放上一集（综艺模式下按综艺列表顺序取上一集）
function playPreviousEpisode() {
    if (sortMode === 'variety') {
        const prev = getVarietyNeighborIndex(-1);
        if (prev !== null) playEpisode(prev);
        return;
    }
    if (currentEpisodeIndex > 0) {
        playEpisode(currentEpisodeIndex - 1);
    }
}

// 播放下一集（综艺模式下按综艺列表顺序取下一集，连播顺序与集数展示一致）
function playNextEpisode() {
    if (sortMode === 'variety') {
        const next = getVarietyNeighborIndex(1);
        if (next !== null) playEpisode(next);
        return;
    }
    if (currentEpisodeIndex < currentEpisodes.length - 1) {
        playEpisode(currentEpisodeIndex + 1);
    }
}

// 切换集数排序
function toggleEpisodeOrder() {
    episodesReversed = !episodesReversed;

    persistEpisodeState();

    // 重新渲染集数列表
    renderEpisodes();

    // 更新排序按钮
    updateOrderButton();
}

// 更新排序按钮状态（文本按钮：切换箭头方向与文字）
function updateOrderButton() {
    const label = document.getElementById('orderToggleLabel');
    const icon = document.getElementById('orderToggleIcon');
    if (label) label.textContent = episodesReversed ? '正序排列' : '倒序排列';
    if (icon) icon.style.transform = episodesReversed ? 'rotate(180deg)' : 'rotate(0deg)';
}

// ===== 排序方式与时长检测（与首页详情弹窗同款） =====

// 持久化排序方式与已检测时长（首页 playVideo 跳转时写入，本页操作时更新）
function persistEpisodeState() {
    try {
        localStorage.setItem('episodesReversed', episodesReversed);
        localStorage.setItem('episodeSortMode', sortMode);
        localStorage.setItem('varietyNumberMode', varietyNumberMode);
        localStorage.setItem('varietyThresholdMinutes', varietyThresholdMinutes);
        localStorage.setItem('episodeDurationCache', JSON.stringify([...episodeDurationCache.entries()]));
    } catch (e) {
        console.warn('保存排序/时长状态失败:', e);
    }
}

// 初始化排序工具栏控件状态（页面载入时调用一次）
function initSortControlStates() {
    const stats = document.getElementById('playerEpisodeStats');
    if (stats) stats.textContent = `共 ${currentEpisodes.length} 集`;
    const thresholdInput = document.getElementById('varietyThresholdInput');
    if (thresholdInput) thresholdInput.value = varietyThresholdMinutes;
    const viewBtn = document.getElementById('episodeViewBtn');
    if (viewBtn) viewBtn.classList.toggle('active', episodeViewMode === 'list');
    updateSortControlStates();
    updateOrderButton();
}

// 切换剧集展示布局（数字方块 ↔ 详细列表），持久化并立即重渲染
function toggleEpisodeView() {
    episodeViewMode = episodeViewMode === 'list' ? 'grid' : 'list';
    try { localStorage.setItem('episodeViewMode', episodeViewMode); } catch (e) { /* 存储失败不影响切换 */ }
    const btn = document.getElementById('episodeViewBtn');
    if (btn) btn.classList.toggle('active', episodeViewMode === 'list');
    renderEpisodes();
}

// 切换排序模式：默认排序 / 综艺排序（下拉框二选一）
function setSortMode(mode) {
    if (mode !== 'default' && mode !== 'variety') return;
    if (sortMode === mode) return;
    sortMode = mode;
    updateSortControlStates();
    renderEpisodes();
    persistEpisodeState();
    // 综艺排序依赖各集时长：进入后自动触发检测（已完成的集数自动跳过），完成后分组实时重排
    if (mode === 'variety') {
        detectEpisodeDurations();
    }
}

// 切换综艺排序下的集数数字显示方式：group 新集数 / original 原集数 / both 双显
function setVarietyNumberMode(mode) {
    if (!['group', 'original', 'both'].includes(mode)) return;
    varietyNumberMode = mode;
    updateSortControlStates();
    renderEpisodes();
    persistEpisodeState();
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
    renderEpisodes();
    persistEpisodeState();
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

// 同步排序控件状态：下拉框标签与选中项、子控件显隐、检测按钮显隐、显示方式激活态
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

// 更新单个集数按钮上的时长显示（默认排序模式下逐集打补丁）
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
function detectEpisodeDurations() {
    if (!currentEpisodes || currentEpisodes.length === 0) return;
    if (durationDetectRunning) return;
    durationDetectRunning = true;
    runDurationDetection().finally(() => { durationDetectRunning = false; });
}

// 页面加载触发的时长检测避让起播：
// 播放开始后再等 15s 启动（不与起播抢带宽/连接）；15s 内一直未播放则直接启动
function deferDurationDetectionForPlayback() {
    let started = false;
    const start = () => {
        if (started) return;
        started = true;
        document.removeEventListener('playing', onPlaying, true);
        detectEpisodeDurations();
    };
    const onPlaying = () => {
        if (started) return;
        clearTimeout(waitTimer);
        // 播放已开始，再给起播缓冲 15s
        waitTimer = setTimeout(start, 15000);
    };
    let waitTimer = setTimeout(start, 15000); // 一直未播放则直接启动
    document.addEventListener('playing', onPlaying, true);
}

async function runDurationDetection() {
    const btn = document.getElementById('detectDurationBtn');
    const label = document.getElementById('detectDurationLabel');
    if (btn) btn.disabled = true;

    let completed = 0;
    const updateProgress = () => {
        if (!label) return;
        label.textContent = completed >= currentEpisodes.length ? '检测完成' : `检测中 ${completed}/${currentEpisodes.length}`;
    };

    // 综艺排序的重排渲染节流（500ms 合并），不再每检测完一集就整体重建列表
    let varietyRenderTimer = null;
    const scheduleVarietyRerender = () => {
        if (varietyRenderTimer) return;
        varietyRenderTimer = setTimeout(() => {
            varietyRenderTimer = null;
            renderEpisodes();
        }, 500);
    };

    const pending = currentEpisodes.map((url, idx) => ({ url, idx }));
    const CONCURRENCY = 2; // 降低并发，减少与播放流抢带宽
    const worker = async () => {
        while (pending.length > 0) {
            const task = pending.shift();
            // 当前正在播放的集不另发请求检测：播放器自身已有精确 duration，直接采信
            if (task.idx === currentEpisodeIndex && art && art.video && isFinite(art.video.duration)) {
                episodeDurationCache.set(task.url, { status: 'done', seconds: art.video.duration });
                completed++;
                continue;
            }
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
            if (sortMode === 'variety') {
                // 综艺排序下时长到齐的集数实时归入对应分组（500ms 节流合并渲染）
                scheduleVarietyRerender();
            } else {
                updateEpisodeDurationDom(task.idx, task.url);
            }
            updateProgress();
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

    if (varietyRenderTimer) {
        clearTimeout(varietyRenderTimer);
        varietyRenderTimer = null;
        renderEpisodes(); // 收尾：确保最后一批评分已渲染
    }

    if (btn) btn.disabled = false;
    let failCount = 0;
    currentEpisodes.forEach(u => {
        const info = episodeDurationCache.get(u);
        if (info && info.status === 'fail') failCount++;
    });
    if (label) label.textContent = failCount > 0 ? '重试失败项' : '检测时长';
    persistEpisodeState();
    if (typeof showToast === 'function') {
        showToast(failCount > 0 ? `时长检测完成，${failCount} 集失败，可再次点击重试` : '时长检测完成', failCount > 0 ? 'error' : 'success');
    }
}

// ===== 进度条准确点击处理 =====
// 进度条点击/触摸处理器（模块级引用稳定，重复 setup 时才能正确移除旧监听，避免累积）
function handleProgressBarClick(e) {
    if (!art || !art.video) return;

    // 计算点击位置相对于进度条的比例
    const rect = e.currentTarget.getBoundingClientRect();
    const percentage = (e.clientX - rect.left) / rect.width;

    // 计算点击位置对应的视频时间
    const duration = art.video.duration;
    let clickTime = percentage * duration;

    // 处理视频接近结尾的情况
    if (duration - clickTime < 1) {
        // 如果点击位置非常接近结尾，稍微往前移一点
        clickTime = Math.min(clickTime, duration - 1.5);
    }

    // 记录用户点击的位置
    userClickedPosition = clickTime;

    // 阻止默认事件传播，避免播放器内部逻辑将视频跳至末尾
    e.stopPropagation();

    // 直接设置视频时间（ArtPlayer 5.x 的 seek 是只写访问器，不能当方法调用）
    art.currentTime = clickTime;
}

// 处理移动端触摸事件
function handleProgressBarTouch(e) {
    if (!art || !art.video || !e.touches[0]) return;

    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const percentage = (touch.clientX - rect.left) / rect.width;

    const duration = art.video.duration;
    let clickTime = percentage * duration;

    // 处理视频接近结尾的情况
    if (duration - clickTime < 1) {
        clickTime = Math.min(clickTime, duration - 1.5);
    }

    // 记录用户点击的位置
    userClickedPosition = clickTime;

    e.stopPropagation();
    // 与进度条等比映射一致（ArtPlayer 5.x 的 seek 是只写访问器，不能当方法调用）
    art.currentTime = clickTime;
}

function setupProgressBarPreciseClicks() {
    // 查找 ArtPlayer 的进度条元素
    const progressBar = document.querySelector('.art-progress');
    if (!progressBar || !art || !art.video) return;

    // 移除可能存在的旧事件监听器（模块级处理器保证引用一致）
    progressBar.removeEventListener('mousedown', handleProgressBarClick);
    progressBar.addEventListener('mousedown', handleProgressBarClick);

    // 在移动端也添加触摸事件支持
    progressBar.removeEventListener('touchstart', handleProgressBarTouch);
    progressBar.addEventListener('touchstart', handleProgressBarTouch);
}

// 在播放器初始化后添加视频到历史记录
// 历史记录内嵌全量 episodes 数组，从历史播放时直接使用（见 ui.js playFromHistory），点击即跳转
function saveToHistory() {
    // 确保 currentEpisodes 非空且有当前视频URL
    if (!currentEpisodes || currentEpisodes.length === 0 || !currentVideoUrl) {
        return;
    }

    // 尝试从URL中获取参数
    const urlParams = new URLSearchParams(window.location.search);
    const sourceCode = urlParams.get('source') || '';
    // sourceName 存友好名称（如 "黑木耳"），sourceCode 存源代码键（如 "heimuer"）
    const sourceName = (typeof API_SITES !== 'undefined' && sourceCode && API_SITES[sourceCode])
        ? API_SITES[sourceCode].name
        : sourceCode;
    const id_from_params = urlParams.get('id'); // Get video ID from player URL (passed as 'id')

    // 获取当前播放进度
    let currentPosition = 0;
    let videoDuration = 0;

    if (art && art.video) {
        currentPosition = art.video.currentTime;
        videoDuration = art.video.duration;
    }

    // Define a show identifier: Prioritize sourceName_id, fallback to first episode URL or current video URL
    let show_identifier_for_video_info;
    if (sourceCode && id_from_params) {
        show_identifier_for_video_info = `${sourceCode}_${id_from_params}`;
    } else {
        show_identifier_for_video_info = (currentEpisodes && currentEpisodes.length > 0) ? currentEpisodes[0] : currentVideoUrl;
    }

    // 构建要保存的视频信息对象
    const videoInfo = {
        title: currentVideoTitle,
        directVideoUrl: currentVideoUrl, // Current episode's direct URL
        url: `player.html?url=${encodeURIComponent(currentVideoUrl)}&title=${encodeURIComponent(currentVideoTitle)}&source=${encodeURIComponent(sourceCode)}&id=${encodeURIComponent(id_from_params || '')}&index=${currentEpisodeIndex}&position=${Math.floor(currentPosition || 0)}`,
        episodeIndex: currentEpisodeIndex,
        episodes: [...currentEpisodes], // 全量剧集列表，历史播放直接使用
        sourceName: sourceName,
        vod_id: id_from_params || '', // Store the ID from params as vod_id in history item
        sourceCode: sourceCode,
        showIdentifier: show_identifier_for_video_info, // Identifier for the show/series
        timestamp: Date.now(),
        playbackPosition: currentPosition,
        duration: videoDuration
    };

    // 同步观看进度到"我的影院"收藏（若已收藏）：首页卡片显示 观看集数：当前/总，单击续播还原进度
    try {
        if (typeof updateCinemaFavoriteProgress === 'function') {
            updateCinemaFavoriteProgress(sourceCode, id_from_params, currentVideoUrl, currentEpisodeIndex, currentPosition);
        }
    } catch (e) { }

    try {
        const history = JSON.parse(localStorage.getItem('viewingHistory') || '[]');

        // 检查是否已经存在相同的系列记录 (基于标题、来源和 showIdentifier)
        const existingIndex = history.findIndex(item =>
            item.title === videoInfo.title &&
            item.sourceCode === videoInfo.sourceCode &&
            item.showIdentifier === videoInfo.showIdentifier
        );

        if (existingIndex !== -1) {
            // 存在则更新现有记录的当前集数、时间戳、播放进度和URL等
            const existingItem = history[existingIndex];
            existingItem.episodeIndex = videoInfo.episodeIndex;
            existingItem.timestamp = videoInfo.timestamp;
            existingItem.sourceName = videoInfo.sourceName;
            existingItem.sourceCode = videoInfo.sourceCode;
            existingItem.vod_id = videoInfo.vod_id;

            // Update URLs to reflect the current episode being watched
            existingItem.directVideoUrl = videoInfo.directVideoUrl; // Current episode's direct URL
            existingItem.url = videoInfo.url; // Player link for the current episode
            existingItem.episodes = videoInfo.episodes;

            // 更新播放进度信息
            existingItem.playbackPosition = videoInfo.playbackPosition > 10 ? videoInfo.playbackPosition : (existingItem.playbackPosition || 0);
            existingItem.duration = videoInfo.duration || existingItem.duration;

            // 移到最前面
            const updatedItem = history.splice(existingIndex, 1)[0];
            history.unshift(updatedItem);
        } else {
            // 添加新记录到最前面
            history.unshift(videoInfo);
        }

        // 限制历史记录数量为50条
        if (history.length > 50) history.splice(50);

        localStorage.setItem('viewingHistory', JSON.stringify(history));
    } catch (e) {
    }
}

// 显示恢复位置提示
function showPositionRestoreHint(position) {
    if (!position || position < 10) return;

    // 创建提示元素
    const hint = document.createElement('div');
    hint.className = 'position-restore-hint';
    hint.innerHTML = `
        <div class="hint-content">
            已从 ${formatTime(position)} 继续播放
        </div>
    `;

    // 添加到播放器容器
    const playerContainer = document.querySelector('.player-container'); // Ensure this selector is correct
    if (playerContainer) { // Check if playerContainer exists
        playerContainer.appendChild(hint);
    } else {
        return; // Exit if container not found
    }

    // 显示提示
    setTimeout(() => {
        hint.classList.add('show');

        // 3秒后隐藏
        setTimeout(() => {
            hint.classList.remove('show');
            setTimeout(() => hint.remove(), 300);
        }, 3000);
    }, 100);
}

// 格式化时间：≥1小时用 h:mm:ss（与播放器进度条一致），否则 mm:ss
function formatTime(seconds) {
    if (isNaN(seconds)) return '00:00';

    const totalSeconds = Math.max(0, Math.floor(seconds));
    const hh = Math.floor(totalSeconds / 3600);
    const mm = Math.floor((totalSeconds % 3600) / 60);
    const ss = totalSeconds % 60;
    const pad = (n) => n.toString().padStart(2, '0');

    return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

// 保存当前播放进度（保存通道：timeupdate 10s 节流 + pause + beforeunload + visibilitychange）
function saveCurrentProgress() {
    if (!art || !art.video) return;
    const currentTime = art.video.currentTime;
    const duration = art.video.duration;
    if (!duration || currentTime < 1) return;

    // 在localStorage中保存进度
    const progressKey = `videoProgress_${getVideoId()}`;
    const progressData = {
        position: currentTime,
        duration: duration,
        timestamp: Date.now()
    };
    try {
        localStorage.setItem(progressKey, JSON.stringify(progressData));
        // --- 新增：同步更新 viewingHistory 中的进度 ---
        try {
            const historyRaw = localStorage.getItem('viewingHistory');
            if (historyRaw) {
                const history = JSON.parse(historyRaw);
                // 用 title + 集数索引唯一标识
                const idx = history.findIndex(item =>
                    item.title === currentVideoTitle &&
                    (item.episodeIndex === undefined || item.episodeIndex === currentEpisodeIndex)
                );
                if (idx !== -1) {
                    // 只在进度有明显变化时才更新，减少写入
                    if (
                        Math.abs((history[idx].playbackPosition || 0) - currentTime) > 2 ||
                        Math.abs((history[idx].duration || 0) - duration) > 2
                    ) {
                        history[idx].playbackPosition = currentTime;
                        history[idx].duration = duration;
                        history[idx].timestamp = Date.now();
                        localStorage.setItem('viewingHistory', JSON.stringify(history));
                    }
                }
            }
        } catch (e) {
        }
    } catch (e) {
    }
}

// =================================
// ==== 倍速控制（快捷面板 + 长按倍速）===
// =================================

// 全局记忆键：跨剧集/跨页面生效（localStorage 同源共享）
const SPEED_CONFIG_KEY = 'wdtvSpeedConfig';
// 快捷倍速面板档位（多档可选）
const RATE_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4];
// 长按倍速可选值
const LONG_PRESS_RATE_OPTIONS = [1.5, 2, 2.5, 3, 3.5, 4];
// 长按触发时长（毫秒）
const LONG_PRESS_DELAY = 500;
// 左右热区宽度各占视频宽度的比例
const LONG_PRESS_ZONE_FRACTION = 1 / 3;

// 读取全局倍速配置（带默认值与合法性校验）
function loadSpeedConfig() {
    const defaults = { longPressZone: 'both', longPressRate: 2, playbackRate: 1 };
    try {
        const saved = JSON.parse(localStorage.getItem(SPEED_CONFIG_KEY) || '{}');
        const cfg = Object.assign({}, defaults, saved || {});
        if (['both', 'left', 'right'].indexOf(cfg.longPressZone) === -1) cfg.longPressZone = 'both';
        cfg.longPressRate = LONG_PRESS_RATE_OPTIONS.indexOf(Number(cfg.longPressRate)) !== -1 ? Number(cfg.longPressRate) : 2;
        cfg.playbackRate = RATE_OPTIONS.indexOf(Number(cfg.playbackRate)) !== -1 ? Number(cfg.playbackRate) : 1;
        return cfg;
    } catch (e) {
        return { longPressZone: 'both', longPressRate: 2, playbackRate: 1 };
    }
}

let speedConfig = loadSpeedConfig();

// 写回全局记忆
function saveSpeedConfig(patch) {
    Object.assign(speedConfig, patch);
    try {
        localStorage.setItem(SPEED_CONFIG_KEY, JSON.stringify(speedConfig));
    } catch (e) {
    }
}

// 倍速显示格式：2 -> "2x"，1.5 -> "1.5x"，0.25 -> "0.25x"
function formatRate(rate) {
    const r = Number(rate) || 1;
    if (r % 1 === 0) return `${r}x`;
    if ((r * 10) % 1 === 0) return `${r.toFixed(1)}x`;
    return `${r.toFixed(2)}x`;
}

function longPressZoneLabel(zone) {
    return zone === 'left' ? '左侧' : zone === 'right' ? '右侧' : '左右两边';
}

// 立即隐藏快捷提示（长按结束时使用）
function hideShortcutHintNow() {
    if (shortcutHintTimeout) {
        clearTimeout(shortcutHintTimeout);
        shortcutHintTimeout = null;
    }
    const el = document.getElementById('shortcutHint');
    if (el) el.classList.remove('show');
}

// ===== 控制栏快捷面板系统（倍速 / 缓存共用） =====
// 面板统一绝对定位于播放器根节点；打开时 JS 计算位置，使其与对应按钮水平居中对齐
const quickPanels = []; // { key, panel, btn, playerRoot, refresh }

function registerQuickPanel(entry) {
    const i = quickPanels.findIndex(p => p.key === entry.key);
    if (i !== -1) quickPanels.splice(i, 1); // 换源重建播放器后丢弃旧实例的注册
    quickPanels.push(entry);
}

function closeAllQuickPanels() {
    quickPanels.forEach(({ panel }) => panel.classList.add('hidden'));
}

// 面板与按钮水平居中对齐（须在面板可见后调用，需要测量宽度）
// 面板为紧凑内容宽度（≤480px 也一样），居中后两端钳制在播放器内，不再全宽拉伸
function alignQuickPanel(panel, btn, playerRoot) {
    const rootRect = playerRoot.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const w = panel.offsetWidth || 100;
    let x = btnRect.left + btnRect.width / 2 - rootRect.left - w / 2;
    x = Math.max(8, Math.min(x, rootRect.width - w - 8));
    panel.style.right = 'auto';
    panel.style.left = x + 'px';
}

// 弹幕/缓存/下载浮层贴各自右上角按钮下沿弹出（右对齐钳制在播放器内；
// 面板为紧凑内容宽度，小屏不再全宽拉伸）
function alignDanmuPanel(panel, btn, playerRoot) {
    const rootRect = playerRoot.getBoundingClientRect();
    let top = 56; // 兜底：按钮未就绪时按按钮组默认位置（top10 + 高30 + 间距16）
    let right = 10;
    if (btn) {
        const btnRect = btn.getBoundingClientRect();
        top = btnRect.bottom - rootRect.top + 8;
        right = rootRect.right - btnRect.right;
    }
    panel.style.top = Math.max(8, top) + 'px';
    panel.style.bottom = 'auto';
    const w = panel.offsetWidth || 260;
    right = Math.max(8, Math.min(right, rootRect.width - w - 8));
    panel.style.left = 'auto';
    panel.style.right = right + 'px';
}

// 打开/关闭快捷面板；refresh 在每次打开前重建内容与选中态；
// entry.align 存在时用自定义对齐（弹幕浮层贴右上角按钮下沿），否则默认水平居中对齐控制栏按钮
function toggleQuickPanel(entry, show) {
    const { panel, btn, playerRoot, refresh } = entry;
    const willShow = typeof show === 'boolean' ? show : panel.classList.contains('hidden');
    if (willShow) {
        closeAllQuickPanels();
        if (refresh) refresh();
        panel.classList.remove('hidden');
        if (entry.align) entry.align(panel, btn, playerRoot); // 先移除 hidden 才能测量宽度
        else alignQuickPanel(panel, btn, playerRoot);
    } else {
        panel.classList.add('hidden');
    }
}

// 点击面板/按钮以外区域时收起所有快捷面板（模块级只注册一次）
if (!window.__wdtvQuickPanelsOutside) {
    window.__wdtvQuickPanelsOutside = true;
    document.addEventListener('pointerdown', (e) => {
        quickPanels.forEach(({ panel, btn }) => {
            if (!panel || panel.classList.contains('hidden')) return;
            if (panel.contains(e.target)) return;
            if (btn && btn.contains(e.target)) return;
            panel.classList.add('hidden');
        });
    }, true);
}

// 控制栏自动隐藏时收起所有快捷面板（每个 playerRoot 只挂一个观察器）
const controlsHideObserved = new WeakSet();
function observeControlsHide(playerRoot) {
    if (controlsHideObserved.has(playerRoot)) return;
    controlsHideObserved.add(playerRoot);
    const mo = new MutationObserver(() => {
        if (playerRoot.classList.contains('art-hide-cursor')) closeAllQuickPanels();
    });
    mo.observe(playerRoot, { attributes: true, attributeFilter: ['class'] });
}

// 快捷按钮通用样式
const QUICK_BTN_STYLE = {
    width: 'auto',
    padding: '0 8px',
    fontSize: '13px',
    color: 'rgba(222,234,250,0.92)',
    cursor: 'pointer',
    userSelect: 'none'
};

// "我的影院"收藏按钮：位于页面集数工具栏首位（与首页详情弹窗同款胶囊风格），不占用播放器控制栏
function setupCinemaFavoriteButton() {
    const chip = document.getElementById('cinemaFavChip');
    if (!chip) return;
    if (typeof isCinemaFavorited !== 'function') return;

    const urlParams = new URLSearchParams(window.location.search);
    const vodId = urlParams.get('id') || '';
    const sourceCode = urlParams.get('source') || '';

    const buildInfo = () => ({
        vod_id: vodId,
        source_code: sourceCode,
        source_name: (typeof API_SITES !== 'undefined' && sourceCode && API_SITES[sourceCode]) ? API_SITES[sourceCode].name : sourceCode,
        title: currentVideoTitle || urlParams.get('title') || '未知视频',
        cover: '',
        remarks: '',
        type_name: '',
        year: '',
        episodes: Array.isArray(currentEpisodes) ? [...currentEpisodes] : [],
        directUrl: currentVideoUrl || '',
        lastEpisodeIndex: currentEpisodeIndex || 0,
        lastPosition: (art && art.video) ? Math.floor(art.video.currentTime || 0) : 0,
        lastDuration: (art && art.video && isFinite(art.video.duration)) ? Math.floor(art.video.duration) : 0
    });

    const refreshChip = () => {
        const faved = isCinemaFavorited(vodId, sourceCode, currentVideoUrl || '');
        chip.classList.toggle('active', faved);
        const heart = chip.querySelector('svg');
        if (heart) heart.setAttribute('fill', faved ? 'currentColor' : 'none');
        const text = chip.querySelector('#cinemaFavChipText');
        if (text) text.textContent = faved ? '已在我的影院' : '加入我的影院';
        chip.title = faved ? '从我的影院移除' : '加入我的影院';
        chip.style.display = '';
    };

    window.toggleCinemaFromPlayer = () => {
        const res = toggleCinemaFavorite(buildInfo());
        refreshChip();
        if (typeof showToast === 'function') showToast(res.favorited ? '已加入我的影院' : '已从我的影院移除', 'success');
        // 新增收藏且有源 ID 时，后台补拉详情回填封面/备注等元信息（不阻塞交互）
        if (res.favorited && vodId && sourceCode && typeof fetchVideoDetailData === 'function') {
            fetchVideoDetailData({ id: vodId, source: sourceCode }).then(d => {
                if (d && d.videoInfo) updateCinemaFavoriteMeta(makeCinemaKey(vodId, sourceCode, ''), d.videoInfo);
            }).catch(() => { });
        }
    };

    // 初始状态同步（已收藏则显示实心心 + 粉色激活态）
    refreshChip();
}

// 控制栏倍速快捷按钮 + 多档倍速面板
// 倍速按钮文案/保护态刷新：进度保护期间显示“进度保护中...”并加呼吸装饰
// （进度保护 = 卡顿/seek 未缓冲区降速后、尚未恢复原倍速的状态）
function refreshRateButtonLabel() {
    const root = (art && art.template && art.template.$player) || document.querySelector('#player .art-video-player');
    if (!root) return;
    const span = root.querySelector('.rate-btn-text');
    if (!span) return;
    const btn = span.closest('.art-control-rateQuickButton') || span.parentElement;
    if (!btn) return;
    if (stallRateGuard.active) {
        span.textContent = '进度保护中...';
        btn.classList.add('rate-guarding');
    } else {
        btn.classList.remove('rate-guarding');
        const r = (art.video && art.video.playbackRate) || 1;
        span.textContent = r !== 1 ? formatRate(r) : '倍速';
    }
}

// ===== 选集快捷按钮（控制栏，倍速左侧）：弹出全部集数网格，点击换集播放 =====
function setupEpisodeControlButton() {
    if (!art) return;
    const playerRoot = art.template.$player || document.querySelector('#player .art-video-player');
    if (!playerRoot) return;
    if (!Array.isArray(currentEpisodes) || currentEpisodes.length < 2) return; // 单集无需选集

    art.controls.add({
        name: 'episodeQuickButton',
        position: 'right',
        index: 4, // 倍速按钮 index 5 → 本按钮排其左侧
        html: '<span class="ep-btn-text">选集</span>',
        tooltip: '选集播放',
        style: QUICK_BTN_STYLE,
        click: () => toggleQuickPanel(epEntry)
    });
    const epButtonEl = art.controls.episodeQuickButton || playerRoot.querySelector('.art-control-episodeQuickButton');
    if (!epButtonEl) return;

    const panel = document.createElement('div');
    panel.className = 'art-speed-panel episode-panel hidden';
    panel.innerHTML = '<div class="wdtv-ep-grid"></div>';
    playerRoot.appendChild(panel);

    // 集数网格：与底部剧集列表同序（默认模式含倒序开关；综艺模式按长/短组顺序）
    function buildEpisodes() {
        let order = currentEpisodes.map((_, i) => i);
        if (sortMode === 'variety') {
            const { longIdx, shortIdx } = getVarietyGroups();
            order = longIdx.concat(shortIdx);
        } else if (episodesReversed) {
            order.reverse();
        }
        panel.querySelector('.wdtv-ep-grid').innerHTML = order.map(ri => {
            const raw = (currentEpisodeNames[ri] || '').trim();
            // 极简：chip 只放纯数字集号，完整集名放 title 悬停提示
            const title = raw ? `第${ri + 1}集 · ${raw}` : `第${ri + 1}集`;
            return `<button class="art-speed-item wdtv-ep-chip${ri === currentEpisodeIndex ? ' active' : ''}" data-ri="${ri}" type="button" title="${escapeHtml(title)}">${ri + 1}</button>`;
        }).join('');
    }

    panel.addEventListener('click', (e) => {
        const chip = e.target.closest('.wdtv-ep-chip[data-ri]');
        if (!chip) return;
        const ri = parseInt(chip.dataset.ri, 10);
        toggleQuickPanel(epEntry, false); // 选不选都收起面板
        if (ri >= 0 && ri < currentEpisodes.length && ri !== currentEpisodeIndex) {
            playEpisode(ri);
        }
    });

    const epEntry = {
        key: 'episode', panel, btn: epButtonEl, playerRoot,
        refresh() {
            buildEpisodes();
            // 打开时把当前集滚动到可视区
            const cur = panel.querySelector('.wdtv-ep-chip.active');
            if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
        }
    };
    registerQuickPanel(epEntry);
    observeControlsHide(playerRoot);
}

function setupRateControlButton() {
    if (!art) return;
    const playerRoot = art.template.$player || document.querySelector('#player .art-video-player');
    if (!playerRoot) return;

    // 按钮文案随当前倍速变化：1x 显示“倍速”，其他显示如“2x”；进度保护期间显示“进度保护中...”
    const updateButtonLabel = () => refreshRateButtonLabel();

    art.controls.add({
        name: 'rateQuickButton',
        position: 'right',
        index: 5,
        html: '<span class="rate-btn-text">倍速</span>',
        tooltip: '倍速播放',
        style: QUICK_BTN_STYLE,
        click: () => toggleQuickPanel(rateEntry)
    });
    // 注意：当前版本 ArtPlayer 的 controls.add 不返回元素，需从 controls 上按名字取回按钮节点
    const rateButtonEl = art.controls.rateQuickButton || playerRoot.querySelector('.art-control-rateQuickButton');
    if (!rateButtonEl) return;

    const panel = document.createElement('div');
    panel.className = 'art-speed-panel hidden';
    panel.innerHTML = RATE_OPTIONS.map(r =>
        `<div class="art-speed-item" data-rate="${r}">${formatRate(r)}</div>`
    ).join('');
    playerRoot.appendChild(panel);

    panel.addEventListener('click', (e) => {
        const item = e.target.closest('.art-speed-item');
        if (!item) return;
        art.playbackRate = parseFloat(item.dataset.rate);
        toggleQuickPanel(rateEntry, false);
    });

    const rateEntry = {
        key: 'rate', panel, btn: rateButtonEl, playerRoot,
        refresh() {
            panel.querySelectorAll('.art-speed-item').forEach(item => {
                item.classList.toggle('active', Math.abs(parseFloat(item.dataset.rate) - art.playbackRate) < 0.001);
            });
        }
    };
    registerQuickPanel(rateEntry);
    observeControlsHide(playerRoot);

    // 倍速变化时：同步按钮文案 + 写入全局记忆（长按临时加速除外）
    art.on('video:ratechange', () => {
        if (!art || !art.video) return;
        updateButtonLabel();
        if (!longPressBoostActive) {
            saveSpeedConfig({ playbackRate: art.video.playbackRate });
        }
    });

    updateButtonLabel();
}

// ===== 倍速播放缓冲策略 =====
// 高倍速（含长按临时倍速）下媒体消耗速度是码率的 N 倍，而代理链路吞吐有限（实测约 2.4Mbps）：
// 按倍速放大 hls.js 前向缓冲目标（媒体秒）——2x 时 60s 缓冲只够 30 真实秒余量，
// 目标不放大则高倍速下缓冲天然偏薄。
// 带宽让路交给 VideoCache 的健康闸门完成（阈值 20s×rate）：缓冲吃紧时后台预加载自动暂停、
// 缓冲充裕时继续向前延伸缓存——不硬冻结预加载，否则高倍速下缓存必然耗尽导致卡顿。
// hls.js 的 maxBufferLength/maxMaxBufferLength/maxBufferSize 均为运行时逐分片读取，直接改 config 即时生效
const RATE_BUFFER_BASE = { len: 60, maxLen: 120, size: 60 * 1000 * 1000 };
function applyRatePlaybackStrategy(rate) {
    rate = Math.max(1, Math.min(rate || 1, 4));
    if (!currentHls || !currentHls.config) return;
    try {
        if (rate > 1) {
            currentHls.config.maxBufferLength = Math.min(240, Math.round(RATE_BUFFER_BASE.len * rate));
            currentHls.config.maxMaxBufferLength = Math.min(480, Math.round(RATE_BUFFER_BASE.maxLen * rate));
            currentHls.config.maxBufferSize = Math.min(150 * 1000 * 1000, Math.round(RATE_BUFFER_BASE.size * rate));
        } else {
            currentHls.config.maxBufferLength = RATE_BUFFER_BASE.len;
            currentHls.config.maxMaxBufferLength = RATE_BUFFER_BASE.maxLen;
            currentHls.config.maxBufferSize = RATE_BUFFER_BASE.size;
        }
    } catch (e) { }
}

// ===== 画质模式（自动 ABR / 强制最高锁定最高画质档位，设置面板内切换） =====
const BITRATE_CAP_KEY = 'wdtvBitrateCap';

// 仅两种模式：'max' 为强制最高，其余（含旧版数值上限残留值）一律视为自动
function getBitrateCap() {
    try {
        return localStorage.getItem(BITRATE_CAP_KEY) === 'max' ? 'max' : Infinity;
    } catch (e) { return Infinity; }
}

// 应用画质模式：'max' 强制锁定最高画质档位，否则恢复 ABR 自动选择（不设上限）
function applyBitrateCap(capBps) {
    if (!currentHls || !currentHls.levels || currentHls.levels.length === 0) return;
    if (capBps === 'max') {
        // 强制最高：锁定到声明分辨率最高（缺失时按声明码率最高）的档位，
        // 与清晰度菜单的排序规则一致；换集重建 hls 后会在 MANIFEST_PARSED 里重新应用
        let best = 0;
        for (let i = 1; i < currentHls.levels.length; i++) {
            const hi = currentHls.levels[i].height || 0;
            const hb = currentHls.levels[best].height || 0;
            if (hi > hb || (hi === hb && (currentHls.levels[i].bitrate || 0) > (currentHls.levels[best].bitrate || 0))) best = i;
        }
        currentHls.currentLevel = best;
        return;
    }
    currentHls.autoLevelCapping = -1; // 自动：不限制 ABR 可选档位
}

// ===== 缓存快捷按钮（整集后台缓存进度 + 暂停/删除 + 管理入口） =====
// 缓存进度钩子：VideoCache.init 的 onProgress 回调转发到这里（setupCacheControlButton 注册）
let cacheProgressHook = null;

// 进度条上的缓存进度层：显示 VideoCache 整集后台缓存的真实覆盖范围
//（区别于白色 MSE 缓冲条——缓冲只反映"已 append 到播放器"的数据，缓存完≠缓冲满）
function updateCacheProgressBar(s) {
    if (!art) return;
    const inner = document.querySelector('#player .art-control-progress-inner');
    if (!inner) return;
    let layer = inner.querySelector('.art-progress-cache');
    if (!layer) {
        layer = document.createElement('div');
        layer.className = 'art-progress-cache';
        inner.insertBefore(layer, inner.firstChild);
    }
    const pct = s && s.percent != null ? s.percent : 0;
    layer.style.width = pct + '%';
    layer.style.display = pct > 0 ? 'block' : 'none';
}

// 字节数格式化（缓存面板用）
function cacheFmtBytes(n) {
    if (!isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function cachePanelStatusText(s) {
    switch (s.state) {
        case 'running': return '后台缓存中…';
        case 'paused': return '已暂停';
        case 'done': return '已全部缓存 ✓';
        case 'failed': return '网络波动中断，30 秒后自动重试…';
        case 'disabled': return '缓存不可用';
        default: return s.totalFrags > 0 ? '未完成（重看本集自动续传）' : '待播放开始';
    }
}

// 按 session 原地更新面板 DOM（不重建，避免打断按钮悬停/点击）
function updateCachePanelDom(panel, s) {
    const fill = panel.querySelector('[data-cf="fill"]');
    if (fill) fill.style.width = (s.percent != null ? s.percent : 0) + '%';
    const st = panel.querySelector('[data-cf="status"]');
    if (st) st.textContent = cachePanelStatusText(s);
    const bytes = panel.querySelector('[data-cf="bytes"]');
    if (bytes) bytes.textContent = cacheFmtBytes(s.downloadedBytes);
    const frags = panel.querySelector('[data-cf="frags"]');
    if (frags) frags.textContent = s.doneFrags + '/' + (s.totalFrags || '?');
    const speed = panel.querySelector('[data-cf="speed"]');
    if (speed) speed.textContent = s.speedBps > 0 ? (s.speedBps / 8 / 1024 / 1024).toFixed(2) + ' MB/s' : '—';
    // 命中观测：hit/entry 接近 = 缓存在服务播放；bypass 偏高 = loader 被绕过（版本过旧/context 形态异常）
    const hits = panel.querySelector('[data-cf="hits"]');
    if (hits) {
        const L = s.loader || { entry: 0, hit: 0, bypass: 0 };
        hits.textContent = L.hit + '/' + L.entry + (L.bypass > 0 ? '（旁路 ' + L.bypass + '）' : '') + ' · v' + (s.version || '?');
    }
    const tg = panel.querySelector('[data-cf="toggle"]');
    if (tg) tg.textContent = s.paused ? '继续' : '暂停';
}

function renderCachePanel(panel) {
    const s = VideoCache.getSession();
    if (!s || !s.enabled) {
        panel.innerHTML = '<div class="cache-row" style="cursor:default;opacity:.7;">'
            + '当前环境不支持本地存储，缓存功能不可用</div>';
        return;
    }
    panel.innerHTML =
        '<div class="cache-row"><span>状态</span><span data-cf="status">' + cachePanelStatusText(s) + '</span></div>'
        + '<div class="cache-progress-track"><div class="cache-progress-fill" data-cf="fill" style="width:'
        + (s.percent != null ? s.percent : 0) + '%"></div></div>'
        + '<div class="cache-row"><span>本集已缓存</span><span data-cf="bytes">' + cacheFmtBytes(s.downloadedBytes) + '</span></div>'
        + '<div class="cache-row"><span>片段</span><span data-cf="frags">' + s.doneFrags + '/' + (s.totalFrags || '?') + '</span></div>'
        + '<div class="cache-row"><span>预取速度</span><span data-cf="speed">' + (s.speedBps > 0 ? (s.speedBps / 8 / 1024 / 1024).toFixed(2) + ' MB/s' : '—') + '</span></div>'
        + '<div class="cache-row"><span>缓存命中</span><span data-cf="hits">—</span></div>'
        + '<div class="cache-row"><span>全部占用</span><span data-cf="total">统计中…</span></div>'
        + '<div class="cache-actions">'
        + '  <div class="cache-btn" data-act="toggle" data-cf="toggle">' + (s.paused ? '继续' : '暂停') + '</div>'
        + '  <div class="cache-btn" data-act="delete">删除本集</div>'
        + '  <div class="cache-btn" data-act="manage">管理全部…</div>'
        + '</div>';
    // 全部占用（对账后的真实总量）
    VideoCache.listEntries().then(list => {
        const span = panel.querySelector('[data-cf="total"]');
        if (span) {
            const total = (list || []).reduce((sum, e) => sum + e.bytes, 0);
            span.textContent = cacheFmtBytes(total);
        }
    }).catch(() => { });
}

function setupCacheControlButton() {
    // 用户设置控制：默认不在播放器控制栏显示缓存按钮（设置面板「显示缓存按钮」开启后才展示）
    if (localStorage.getItem(PLAYER_CONFIG.showCacheButtonStorage) !== 'true') return;
    if (!art) return;
    const playerRoot = art.template.$player || document.querySelector('#player .art-video-player');
    if (!playerRoot) return;

    // 按钮状态：缓存中显示"缓存 xx%"，完成显示"缓存完"，空闲纯图标（极简：无状态文字）
    // 注意 failed 态也必须显示百分比（此前 failed 只显示"缓存"，用户会以为缓存进度凭空消失）
    const updateButtonLabel = (s) => {
        const span = playerRoot.querySelector('.cache-btn-text');
        if (!span) return;
        if (!s) s = VideoCache.getSession();
        let text = '';
        if (s && s.enabled && s.state === 'done') text = '缓存完';
        else if (s && s.enabled && s.percent != null && s.state !== 'disabled') {
            text = s.percent + '%' + (s.state === 'failed' ? '！' : '');
        }
        span.textContent = text;
        span.style.display = text ? '' : 'none';
    };

    // 右上角按钮（缓存 setup 最先执行，appendChild 到容器末尾；下载按钮随后插到它前面）
    const wrap = ensureTopToolContainer(playerRoot);
    const cacheBtn = document.createElement('button');
    cacheBtn.className = 'wdtv-dm-topbtn wdtv-dm-cachebtn';
    cacheBtn.type = 'button';
    cacheBtn.title = '整集后台缓存';
    cacheBtn.innerHTML = CACHE_ICON_SM + '<span class="cache-btn-text" style="display:none"></span>';
    wrap.appendChild(cacheBtn);
    cacheBtn.addEventListener('click', function () {
        try { toggleQuickPanel(cacheEntry); } catch (e) { /* 静默 */ }
    });

    const panel = document.createElement('div');
    panel.className = 'art-speed-panel cache-panel hidden';
    playerRoot.appendChild(panel);

    panel.addEventListener('click', (e) => {
        const btn = e.target.closest('.cache-btn');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'toggle') {
            const s = VideoCache.getSession();
            VideoCache.setPaused(!(s && s.paused));
            const ns = VideoCache.getSession();
            if (ns) updateCachePanelDom(panel, ns);
        } else if (act === 'delete') {
            VideoCache.deleteVideo(currentVideoUrl).then((ok) => {
                if (ok) {
                    if (typeof showToast === 'function') showToast('已删除本集缓存', 'success');
                } else {
                    if (typeof showToast === 'function') showToast('删除失败，请稍后重试', 'error');
                }
                renderCachePanel(panel);
            }).catch(() => { });
        } else if (act === 'manage') {
            VideoCache.openManager();
        }
    });

    const cacheEntry = {
        key: 'cache', panel, btn: cacheBtn, playerRoot,
        align: alignDanmuPanel, // 面板贴右上角按钮下沿下拉
        refresh() { renderCachePanel(panel); }
    };
    registerQuickPanel(cacheEntry);
    observeControlsHide(playerRoot);

    // 进度推送：更新按钮文案；面板打开时原地刷新
    cacheProgressHook = (s) => {
        updateButtonLabel(s);
        if (panel.classList.contains('hidden')) return;
        updateCachePanelDom(panel, s);
    };

    updateButtonLabel();
}

// ===== 下载快捷按钮（画质/格式选择 + 下载本集 / 批量下载 / 下载管理） =====

// 下载画质选项：真多档主列表用 hls 层级；单档源用"默认 + 探测档位"
function getDownloadQualityOptions() {
    const opts = [];
    const levels = (currentHls && currentHls.levels) ? currentHls.levels : [];
    if (levels.length >= 2) {
        levels.forEach((lv, i) => {
            const lvUrl = Array.isArray(lv.url) ? lv.url[0] : lv.url;
            let label;
            if (lv.height) label = lv.height + 'P';
            else if (lv.bitrate) label = Math.round(lv.bitrate / 1000) + 'k';
            else label = '档位' + (i + 1);
            opts.push({
                label,
                mediaUrl: lvUrl || null, // 当前集的媒体清单，直下即可
                hint: { height: lv.height || 0, bandwidth: lv.bitrate || 0 }
            });
        });
        return opts;
    }
    // 单档源：默认（本集原始地址）+ 同级目录探测出的档位
    opts.push({ label: '默认', mediaUrl: baseEpisodeUrl || currentVideoUrl, hint: null, tierToken: null });
    (syntheticTiers || []).forEach(t => {
        const info = parseTierSegment(t.url);
        opts.push({
            label: t.label,
            mediaUrl: t.url,
            hint: null,
            tierToken: info ? (info.token + 'k' + (info.suffix || '') + (info.height ? '_' + info.height : '')) : null
        });
    });
    return opts;
}

// 批量下载的集数地址映射：单档源把当前档位目录替换进每一集；多档源返回原地址（引擎按 hint 选档）
function mapDownloadEpisodeUrl(epUrl, q) {
    if (!q || !q.tierToken) return epUrl;
    const info = parseTierSegment(baseEpisodeUrl);
    if (!info) return epUrl;
    return tierUrlWithToken(epUrl, info.seg, q.tierToken) || epUrl;
}

function setupDownloadControlButton() {
    if (!art) return;
    if (typeof WDTDownloader === 'undefined') return;
    const playerRoot = art.template.$player || document.querySelector('#player .art-video-player');
    if (!playerRoot) return;

    // 选中态（换集/重建播放器后重置为第一项）；格式固定 MP4（用户定案：不做 TS 选项）
    let selQualityIdx = 0;

    // 右上角按钮（缓存 setup 先行把缓存钮 append 到容器末尾，下载钮插到它前面 → 顺序：…下载、缓存）
    const wrap = ensureTopToolContainer(playerRoot);
    const dlBtn = document.createElement('button');
    dlBtn.className = 'wdtv-dm-topbtn wdtv-dm-dlbtn';
    dlBtn.type = 'button';
    dlBtn.title = '下载本集 / 批量下载';
    dlBtn.innerHTML = DL_ICON_SM;
    wrap.insertBefore(dlBtn, wrap.firstChild);
    dlBtn.addEventListener('click', function () {
        try { toggleQuickPanel(dlEntry); } catch (e) { /* 静默 */ }
    });

    const panel = document.createElement('div');
    panel.className = 'art-speed-panel download-panel hidden';
    playerRoot.appendChild(panel);

    const getEpisodeLabel = () =>
        getEpisodeDisplayName(currentEpisodeIndex || 0);

    function downloadCurrent() {
        const opts = getDownloadQualityOptions();
        const q = opts[Math.min(selQualityIdx, opts.length - 1)] || null;
        if (!q || !q.mediaUrl) {
            if (typeof showToast === 'function') showToast('当前视频地址不可用，无法下载', 'error');
            return;
        }
        // 下载本集：直接用已解析的媒体清单地址，无需引擎再选档
        WDTDownloader.enqueue({
            url: q.mediaUrl,
            title: currentVideoTitle || '未知视频',
            episodeLabel: getEpisodeLabel(),
            quality: q.label,
            qualityHint: null,
            format: 'mp4'
        });
        toggleQuickPanel(dlEntry, false);
    }

    function openBatch() {
        const opts = getDownloadQualityOptions();
        // 批量弹窗的集数排列与剧集列表保持一致：
        // 综艺排序 → 长组→短组，编号随综艺集数显示方式（组内新集数/原集数/双显）；
        // 默认排序 → 原顺序（含倒序开关），编号为原集数
        let order = (Array.isArray(currentEpisodes) ? currentEpisodes : []).map((_, i) => i);
        const epNums = [];
        if (sortMode === 'variety') {
            const { longIdx, shortIdx } = getVarietyGroups();
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
                // 组首集打上分组标记，批量弹窗据此插入分组间隔行（与剧集列表的分组标题一致）
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
            episodeLabels: order.map(ri => getEpisodeDisplayName(ri)),
            qualities: opts.map(q => ({ label: q.label, hint: q.hint || null, tierToken: q.tierToken || null })),
            defaultQualityIndex: Math.min(selQualityIdx, Math.max(0, opts.length - 1)),
            mapEpisodeUrl: mapDownloadEpisodeUrl
        });
        toggleQuickPanel(dlEntry, false);
    }

    panel.addEventListener('click', (e) => {
        const qchip = e.target.closest('.wdtv-dl-pchip[data-qidx]');
        if (qchip) {
            selQualityIdx = parseInt(qchip.dataset.qidx, 10);
            refreshPanel();
            return;
        }
        const btn = e.target.closest('.wdtv-dl-panel-btn');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'current') downloadCurrent();
        else if (act === 'batch') openBatch();
        else if (act === 'manage') {
            toggleQuickPanel(dlEntry, false);
            WDTDownloader.openManager();
        }
    });

    function refreshPanel() {
        const opts = getDownloadQualityOptions();
        // 选中项越界保护
        if (selQualityIdx >= opts.length) selQualityIdx = 0;
        const qualityRow = opts.length > 1
            ? `<div class="wdtv-dl-panel-row"><span class="wdtv-dl-panel-label">画质</span><span class="wdtv-dl-panel-chips">`
                + opts.map((q, i) => `<span class="wdtv-dl-pchip${i === selQualityIdx ? ' active' : ''}" data-qidx="${i}">${q.label}</span>`).join('')
                + `</span></div>`
            : (opts.length === 1
                ? `<div class="wdtv-dl-panel-row"><span class="wdtv-dl-panel-label">画质</span><span class="wdtv-dl-panel-chips"><span class="wdtv-dl-pchip active">${opts[0].label}</span></span></div>`
                : '');
        panel.innerHTML = qualityRow
            + `<div class="wdtv-dl-panel-actions">`
                + `<span class="wdtv-dl-panel-btn primary" data-act="current">下载本集（MP4）</span>`
                + (Array.isArray(currentEpisodes) && currentEpisodes.length > 1 ? `<span class="wdtv-dl-panel-btn" data-act="batch">批量下载</span>` : '')
                + `<span class="wdtv-dl-panel-btn" data-act="manage">下载管理</span>`
                + `</div>`;
    }

    const dlEntry = {
        key: 'download', panel, btn: dlBtn, playerRoot,
        align: alignDanmuPanel, // 面板贴右上角按钮下沿下拉
        refresh() { refreshPanel(); }
    };
    registerQuickPanel(dlEntry);
    observeControlsHide(playerRoot);
}

// 设置面板：长按倍速 / 长按区域（可自定义，全局记忆）
function addSpeedSettings() {
    if (!art || speedSettingsMenuAdded) return;
    const settingApi = art.setting || art.settings; // 兼容不同版本 ArtPlayer 的设置API命名
    if (!settingApi || typeof settingApi.add !== 'function') return;
    speedSettingsMenuAdded = true;
    try {
        settingApi.add({
            name: 'longPressRate',
            html: '长按倍速',
            width: 200,
            tooltip: formatRate(speedConfig.longPressRate),
            selector: LONG_PRESS_RATE_OPTIONS.map(r => ({
                html: formatRate(r),
                rate: r,
                default: r === speedConfig.longPressRate
            })),
            onSelect(item) {
                saveSpeedConfig({ longPressRate: item.rate });
                return item.html;
            }
        });
        settingApi.add({
            name: 'longPressZone',
            html: '长按区域',
            width: 200,
            tooltip: longPressZoneLabel(speedConfig.longPressZone),
            selector: [
                { html: '左右两边', zone: 'both', default: speedConfig.longPressZone === 'both' },
                { html: '左侧', zone: 'left', default: speedConfig.longPressZone === 'left' },
                { html: '右侧', zone: 'right', default: speedConfig.longPressZone === 'right' }
            ],
            onSelect(item) {
                saveSpeedConfig({ longPressZone: item.zone });
                return item.html;
            }
        });
    } catch (e) {
        speedSettingsMenuAdded = false;
        console.error('[addSpeedSettings] 添加设置项失败:', e);
    }
}

// 长按倍速播放：按住视频左/右热区触发（区域与倍速可在设置面板调整，全局记忆）
function setupLongPressSpeedControl() {
    if (!art || !art.video) return;

    const playerRoot = art.template.$player || document.querySelector('#player .art-video-player');
    const video = art.video;
    if (!playerRoot) return;

    let pressTimer = null;
    let pressPoint = null;   // 长按起始坐标
    let pressSide = 'right'; // 触发热区方向（用于提示图标）
    let boostApplied = false;

    // 顶部中间"倍速播放中"提示（类爱奇艺/腾讯/优酷：深色胶囊 + 快进图标 + 文案）
    let boostTip = playerRoot.querySelector('.wdtv-boost-tip');
    if (!boostTip) {
        boostTip = document.createElement('div');
        boostTip.className = 'wdtv-boost-tip';
        boostTip.innerHTML =
            '<svg viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M4.5 5.5v13l8.6-6.5-8.6-6.5z" style="fill:currentColor!important" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
            '<path d="M13.4 5.5v13l8.6-6.5-8.6-6.5z" style="fill:currentColor!important" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
            '</svg><span></span>';
        playerRoot.appendChild(boostTip);
    }
    const showBoostTip = () => {
        const span = boostTip.querySelector('span');
        if (span) span.textContent = formatRate(speedConfig.longPressRate) + ' 倍速播放中';
        boostTip.classList.add('show');
    };
    const hideBoostTip = () => boostTip.classList.remove('show');

    // 移动端禁用长按弹出的系统右键菜单，避免干扰长按倍速手势
    playerRoot.oncontextmenu = () => {
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        if (isMobile) return false;
        return true; // 桌面设备允许右键菜单
    };

    // 命中过滤：控件区/设置面板/倍速面板等交互元素上的按压不触发长按
    const inInteractiveArea = (target) => !!(target && target.closest &&
        target.closest('.art-bottom, .art-setting-panel, .art-contextmenu, .art-loading, .art-layer, .art-speed-panel, .art-info, .wdtv-dm-topbtns'));

    // 判断横坐标是否落在配置的触发热区内
    const inTriggerZone = (clientX) => {
        const rect = video.getBoundingClientRect();
        const edge = rect.width * LONG_PRESS_ZONE_FRACTION;
        const x = clientX - rect.left;
        const zone = speedConfig.longPressZone;
        if (zone === 'left') return x <= edge;
        if (zone === 'right') return x >= rect.width - edge;
        return x <= edge || x >= rect.width - edge; // both
    };

    const cancelPress = () => {
        if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
        }
        pressPoint = null;
    };

    const stopBoost = () => {
        if (!boostApplied) return;
        boostApplied = false;
        longPressBoostActive = false;
        suppressNextClick = true; // 长按松开后的 click 不再切换播放/暂停
        try {
            video.playbackRate = speedConfig.playbackRate; // 恢复为用户选定的倍速
        } catch (e) {
        }
        hideBoostTip();
        hideShortcutHintNow();
    };

    playerRoot.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (inInteractiveArea(e.target)) return;
        if (video.paused) return;                 // 暂停状态不触发
        if (!inTriggerZone(e.clientX)) return;    // 仅配置的热区生效

        const rect = video.getBoundingClientRect();
        pressSide = (e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right';
        cancelPress();
        pressPoint = { x: e.clientX, y: e.clientY }; // 注意：需在 cancelPress 之后赋值
        pressTimer = setTimeout(() => {
            pressTimer = null;
            if (!pressPoint || video.paused) return;
            boostApplied = true;
            longPressBoostActive = true;
            try {
                video.playbackRate = speedConfig.longPressRate;
            } catch (err) {
            }
            showBoostTip(); // 顶部中间"2x 倍速播放中"提示
        }, LONG_PRESS_DELAY);
    });

    playerRoot.addEventListener('pointermove', (e) => {
        if (!pressPoint) return;
        // 位移过大视为滑动拖拽，取消长按/结束加速
        if (Math.abs(e.clientX - pressPoint.x) > 18 || Math.abs(e.clientY - pressPoint.y) > 18) {
            stopBoost();
            cancelPress();
        }
    });

    const endPress = () => {
        stopBoost();
        cancelPress();
    };
    playerRoot.addEventListener('pointerup', endPress);
    playerRoot.addEventListener('pointercancel', endPress);

    // 长按结束后拦截随之而来的 click，避免误触发暂停（捕获阶段先于播放器自身处理）
    playerRoot.addEventListener('click', (e) => {
        if (suppressNextClick) {
            e.stopPropagation();
            e.preventDefault();
            suppressNextClick = false;
        }
    }, true);

    // 暂停时立即结束长按加速
    video.addEventListener('pause', () => {
        stopBoost();
        cancelPress();
    });
}

// =================================
// == 移动端手势（亮度/音量/进度）===
// =================================

// 亮度记忆键：跨集/跨会话保留用户的屏幕亮度偏好
const GESTURE_BRIGHTNESS_KEY = 'wdtvBrightness';
// 无时长流（部分直播）的横滑 seek 兜底映射：整屏宽度 ≈ ±90 秒（正常情况用 1:1 百分比跟手映射）
const GESTURE_SEEK_SECONDS_PER_WIDTH = 90;
// 上下滑满程（屏幕高度 × 此系数）= 从 0 调到 100%
const GESTURE_VERTICAL_RANGE_FACTOR = 0.65;

function getSavedBrightness() {
    try {
        const v = parseFloat(localStorage.getItem(GESTURE_BRIGHTNESS_KEY));
        return isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
    } catch (e) {
        return 1;
    }
}

function applyVideoBrightness(value) {
    if (!art || !art.video) return;
    art.video.style.filter = value >= 0.99 ? '' : `brightness(${value.toFixed(3)})`;
}

// 手势系统：触摸按下后按初始位移方向判定手势类型并锁定到松手
//   横向位移为主 → 拖动进度（1:1 跟手驱动下方进度条，松手才真正 seek）
//   纵向位移为主 → 起点在左半屏调亮度 / 右半屏调音量（实时生效）
function setupPlayerGestures() {
    if (!art || !art.video) return;
    const playerRoot = art.template.$player || document.querySelector('#player .art-video-player');
    if (!playerRoot || playerRoot.__wdtvGestures) return;
    playerRoot.__wdtvGestures = true;
    const video = art.video;

    // 居中手势提示（亮度/音量/进度共用，深色毛玻璃胶囊，类爱奇艺）
    const hint = document.createElement('div');
    hint.className = 'wdtv-gesture-hint';
    playerRoot.appendChild(hint);
    let hintTimer = null;
    const ICON_ATTRS = 'viewBox="0 0 24 24" style="width:100%;height:100%" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
    const GESTURE_ICONS = {
        sun: `<div class="wdtv-gesture-icon"><svg ${ICON_ATTRS}><circle cx="12" cy="12" r="4"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"/></svg></div>`,
        volume: `<div class="wdtv-gesture-icon"><svg ${ICON_ATTRS}><path d="M11.5 5.2 7.2 8.8H4.6a.6.6 0 0 0-.6.6v5.2c0 .33.27.6.6.6h2.6l4.3 3.6a.55.55 0 0 0 .9-.42V5.62a.55.55 0 0 0-.9-.42z"/><path d="M15.4 9.3a3.8 3.8 0 0 1 0 5.4M17.9 7a7.2 7.2 0 0 1 0 10"/></svg></div>`,
        forward: `<div class="wdtv-gesture-icon"><svg viewBox="0 0 24 24" style="width:100%;height:100%;fill:currentColor!important" stroke="none"><path d="M4.5 5.5v13l8.6-6.5-8.6-6.5z"/><path d="M13.4 5.5v13l8.6-6.5-8.6-6.5z"/></svg></div>`,
        backward: `<div class="wdtv-gesture-icon"><svg viewBox="0 0 24 24" style="width:100%;height:100%;fill:currentColor!important" stroke="none"><path d="M19.5 5.5v13l-8.6-6.5 8.6-6.5z"/><path d="M10.6 5.5v13L2 12l8.6-6.5z"/></svg></div>`
    };
    const showHint = (html) => {
        hint.innerHTML = html;
        hint.classList.add('show');
    };
    const hideHintSoon = (delay) => {
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => hint.classList.remove('show'), delay || 600);
    };

    // ===== 横滑拖动进度：直接驱动播放器下方的进度条（类主流影视 App） =====
    // 机制：拖动期间拦截 ArtPlayer 的 raf setBar 回写与 timeupdate/progress（播放中每帧
    // 会把已播宽度重置回真实进度、时间文字被真实时间刷写），改为内联样式驱动：
    // 已播色带 + 圆点 + "当前时间/总时长"文字全部实时跟随拖动目标；触摸端圆点默认
    // scale(0) 不可见（无 hover），拖动时强制 scale(1) 显示；底栏用类名 + 内联双兜底常显。
    // 松手不闪回：进度条停留在目标位置，art.currentTime 赋值后由相同值的真实进度接管
    let progressBar = null, scrubPlayed = null, scrubIndicator = null, scrubTime = null, scrubBottom = null;
    let scrubActive = false, origEmit = null;
    // 懒查询：播放器 DOM 若在 setup 时未挂载完成，手势开始时再兜底查找一次
    const ensureScrubEls = () => {
        if (!progressBar) {
            progressBar = playerRoot.querySelector('.art-progress') || document.querySelector('.art-progress');
            if (progressBar) {
                scrubPlayed = progressBar.querySelector('.art-progress-played');
                scrubIndicator = progressBar.querySelector('.art-progress-indicator');
                scrubBottom = playerRoot.querySelector('.art-bottom');
                // 进度条左侧"当前时间 / 总时长"文字控件
                scrubTime = playerRoot.querySelector('.art-control-time');
            }
        }
        return !!progressBar;
    };
    const keepControlsVisible = () => {
        try { art.controls.show = true; } catch (e) { } // 正常路径：随 ArtPlayer 显隐逻辑显示底栏
        // 双兜底：不依赖 ArtPlayer 类名/自动隐藏，直接内联强制显示（清除由 stopBarScrub 负责）
        playerRoot.classList.add('wdtv-scrubbing');
        if (scrubBottom) scrubBottom.style.opacity = '1';
        if (progressBar) progressBar.style.transform = 'none';
    };
    const startBarScrub = () => {
        if (!ensureScrubEls()) return false;
        scrubActive = true;
        if (!origEmit) {
            origEmit = art.emit;
            art.emit = function (name, ...args) {
                // 拖动期间拦截三类事件：
                //   setBar:'played' —— raf 每帧把已播宽度/圆点重置回真实进度
                //   video:timeupdate / video:progress —— 时间控件文字被真实时间刷写、触发控制栏自动隐藏
                if (scrubActive && ((name === 'setBar' && args[0] === 'played') ||
                    name === 'video:timeupdate' || name === 'video:progress')) return;
                return origEmit.apply(this, args);
            };
        }
        keepControlsVisible();
        progressBar.classList.add('wdtv-scrub');
        return true;
    };
    const updateBarScrub = (targetTime, pct) => {
        if (!ensureScrubEls()) return;
        keepControlsVisible();
        const duration = video.duration || 0;
        if (!(duration > 0) || !isFinite(targetTime)) return;
        if (!isFinite(pct)) pct = Math.min(Math.max(targetTime / duration, 0), 1);
        pct = Math.min(Math.max(pct, 0), 1);
        const pctStr = `${(pct * 100).toFixed(2)}%`;
        progressBar.style.setProperty('--wdtv-scrub-pct', pctStr);
        // 内联驱动（不依赖外部 CSS 是否生效）
        if (scrubPlayed) scrubPlayed.style.width = pctStr;
        if (scrubIndicator) {
            scrubIndicator.style.left = pctStr;
            scrubIndicator.style.transform = 'scale(1)'; // 触摸端圆点默认 scale(0)，拖动时强制显示
        }
        // 直接改写进度条上的时间文字（timeupdate 已被拦截，不会被打回真实时间）
        if (scrubTime) scrubTime.textContent = `${formatTime(Math.max(targetTime, 0))} / ${formatTime(duration)}`;
    };
    const stopBarScrub = () => {
        scrubActive = false;
        if (origEmit) { art.emit = origEmit; origEmit = null; } // 解除拦截，seek 后由真实进度接管
        playerRoot.classList.remove('wdtv-scrubbing');
        if (progressBar) {
            progressBar.classList.remove('wdtv-scrub');
            progressBar.style.removeProperty('--wdtv-scrub-pct');
            progressBar.style.transform = '';
        }
        if (scrubBottom) scrubBottom.style.opacity = '';
        // 注意：不清除 scrubPlayed/scrubIndicator 的内联 width/left —— 松手后进度条必须
        // 停在拖动目标位置（随后 art.currentTime 赋值，raf/timeupdate 会以相同值接管，
        // 内容未加载完也保持显示）；若复位到拖动前位置会出现"闪回"观感
        if (scrubIndicator) scrubIndicator.style.transform = ''; // 圆点恢复默认显隐策略
    };
    const barHtml = (value) =>
        `<div class="wdtv-gesture-bar"><div class="wdtv-gesture-bar-fill" style="width:${Math.round(value * 100)}%"></div></div>`;

    // 手势会话状态（一次触摸一个会话，类型判定后锁定）
    let touchId = null;
    let startX = 0, startY = 0;
    let gestureType = '';   // '' 未定向 | 'brightness' | 'volume' | 'seek'
    let startValue = 0;     // 亮度/音量起始值
    let startTime = 0;      // 进度手势起点时间（秒）
    let seekTarget = 0;     // 进度手势预览目标时间（秒）
    let moved = false;      // 是否已越过判定阈值（10px）
    let touchStartAt = 0;   // 本次触摸按下时刻（区分单击与长按）
    let lastTapAt = 0;      // 上一次有效点击（tap）时刻（双击检测）

    // 控件区/面板上的触摸不参与手势（进度条拖动、按钮、设置面板等照常工作）
    const inInteractiveArea = (target) => !!(target && target.closest &&
        target.closest('.art-bottom, .art-setting-panel, .art-contextmenu, .art-loading, .art-layer, .art-speed-panel, .art-info, .wdtv-unlock-btn, .wdtv-lock-shield, .wdtv-dm-topbtns'));

    const endGesture = () => {
        if (gestureType === 'seek') {
            // 拖动进度：松手才真正 seek（拖动过程只驱动下方进度条，避免 HLS 频繁拉流卡顿）
            stopBarScrub();
            suppressNextClick = true;
            try {
                if (isFinite(seekTarget)) {
                    const duration = video.duration || 0;
                    const target = duration > 0 ? Math.min(Math.max(seekTarget, 0), duration - 0.5) : seekTarget;
                    if (Math.abs(target - startTime) > 0.3) art.currentTime = target;
                }
            } catch (e) { }
            // 移除覆盖样式后进度条由 ArtPlayer 接管，按 seek 后的真实进度显示
        } else if (gestureType) {
            suppressNextClick = true;
            hideHintSoon(500);
        }
        // 拦截标记短暂有效即可（合成 click 在 touchend 后 ~100ms 内派发），
        // 超时自动清除，避免混合设备上吞掉用户下一次真实的鼠标点击
        setTimeout(() => { if (touchId === null) suppressNextClick = false; }, 350);
        gestureType = '';
        touchId = null;
        moved = false;
    };

    // ===== 双击 seek（左 1/3 后退 15 秒、右 1/3 快进 15 秒、中间移动端播放暂停；无全屏切换） =====
    const DBL_TAP_WINDOW = 350;   // 两次 tap 的最大间隔（毫秒）
    const TAP_MAX_DURATION = 350; // 单次 tap 的最大按压时长（长按倍速不计入）
    const SEEK_STEP_SECONDS = 15;

    // 横向区域判定：左 1/3 = left，右 1/3 = right，中间 = center
    const sideAt = (clientX) => {
        const rect = playerRoot.getBoundingClientRect();
        const rel = clientX - rect.left;
        if (rel < rect.width / 3) return 'left';
        if (rel > rect.width * 2 / 3) return 'right';
        return 'center';
    };

    // 相对当前进度快进/后退，并给出与居中手势提示一致的反馈
    const seekBy = (delta) => {
        const duration = video.duration || 0;
        const current = video.currentTime || 0;
        let target = current + delta;
        target = duration > 0 ? Math.min(Math.max(target, 0), duration - 0.5) : Math.max(target, 0);
        if (Math.abs(target - current) > 0.1) {
            art.currentTime = target;
        }
        const forward = delta > 0;
        showHint(
            `${forward ? GESTURE_ICONS.forward : GESTURE_ICONS.backward}` +
            `<div class="wdtv-gesture-body">` +
            `<span class="wdtv-gesture-seek">${forward ? '快进' : '快退'} ${Math.abs(Math.round(delta))}秒</span>` +
            `<span class="wdtv-gesture-time">${formatTime(target)} / ${duration > 0 ? formatTime(duration) : '--:--'}</span>` +
            `</div>`
        );
        hideHintSoon(700);
    };

    // 鼠标双击（桌面）：ArtPlayer 在 300ms 内收到两次 click 时派发 dblclick 事件
    // 触摸设备上的双击由下方 touchend 检测处理（第二次 touchend 会 preventDefault 拦掉合成
    // click，因此不会重复触发本事件）；桌面双击会先触发一次单击暂停，这里 seek 后补 play
    // 注意：双击放大/退出全屏机制已按需求移除——中间双击不做任何全屏切换，
    // 全屏只能通过控制栏全屏按钮或 F 键触发
    art.on('dblclick', (e) => {
        if (playerLocked) return;
        const x = (e && typeof e.clientX === 'number' && isFinite(e.clientX)) ? e.clientX : null;
        const side = x === null ? 'center' : sideAt(x);
        if (side === 'left') {
            seekBy(-SEEK_STEP_SECONDS);
        } else if (side === 'right') {
            seekBy(SEEK_STEP_SECONDS);
        }
        try { art.play(); } catch (err) { }
        lastTapAt = 0; // 鼠标双击后重置触摸双击计数，避免混合设备连续触发
    });

    playerRoot.addEventListener('touchstart', (e) => {
        if (playerLocked || touchId !== null) return; // 锁定中 / 已有手势会话，忽略多指
        const t = e.changedTouches[0];
        if (!t) return;
        if (inInteractiveArea(e.target)) return;
        suppressNextClick = false; // 新触摸开始：清除上一手势遗留的 click 拦截标记
        touchId = t.identifier;
        startX = t.clientX;
        startY = t.clientY;
        moved = false;
        gestureType = '';
        startTime = video.currentTime || 0;
        touchStartAt = Date.now();
    }, { passive: true });

    playerRoot.addEventListener('touchmove', (e) => {
        if (playerLocked || touchId === null) return;
        let t = null;
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === touchId) { t = e.changedTouches[i]; break; }
        }
        if (!t) return;
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;

        // 未定向：位移超过 10px 后按方向判定手势类型（横滑优先级与纵滑按主方向）
        if (!moved) {
            if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
            moved = true;
            const rect = playerRoot.getBoundingClientRect();
            if (Math.abs(dx) >= Math.abs(dy)) {
                gestureType = 'seek';
                startBarScrub(); // 拖动进度：唤出并驱动下方进度条
            } else {
                gestureType = (t.clientX - rect.left) < rect.width / 2 ? 'brightness' : 'volume';
                startValue = gestureType === 'brightness' ? getSavedBrightness() : (video.volume != null ? video.volume : 0.8);
            }
            clearTimeout(hintTimer);
        }
        // 手势生效期间阻止页面滚动/下拉刷新等浏览器默认行为
        e.preventDefault();

        const rect = playerRoot.getBoundingClientRect();
        if (gestureType === 'brightness') {
            const next = Math.min(1, Math.max(0, startValue - dy / (rect.height * GESTURE_VERTICAL_RANGE_FACTOR)));
            applyVideoBrightness(next);
            try { localStorage.setItem(GESTURE_BRIGHTNESS_KEY, String(next)); } catch (err) { }
            showHint(`${GESTURE_ICONS.sun}<div class="wdtv-gesture-body">${barHtml(next)}<span>亮度 ${Math.round(next * 100)}%</span></div>`);
        } else if (gestureType === 'volume') {
            const next = Math.min(1, Math.max(0, startValue - dy / (rect.height * GESTURE_VERTICAL_RANGE_FACTOR)));
            if (next > 0 && video.muted) {
                try { art.muted = false; } catch (err) { }
            }
            art.volume = next;
            art.notice.show = ''; // 关闭 ArtPlayer 内置"音量: xx%"通知，避免与居中提示重复
            showHint(`${GESTURE_ICONS.volume}<div class="wdtv-gesture-body">${barHtml(next)}<span>音量 ${Math.round(next * 100)}%</span></div>`);
        } else if (gestureType === 'seek') {
            const duration = video.duration || 0;
            // 1:1 跟手：目标进度% = 起始进度% + 手指位移占屏宽比例（拖满一屏 = 走完整集），
            // 进度条圆点位置与 seek 目标完全由同一比例驱动，视觉反馈与手指距离严格对应
            if (duration > 0 && isFinite(duration)) {
                const startPct = Math.min(Math.max(startTime / duration, 0), 1);
                const pct = Math.min(Math.max(startPct + dx / rect.width, 0), 1);
                seekTarget = pct * duration;
                updateBarScrub(seekTarget, pct);
            } else {
                // 无时长流（部分直播）兜底：退回时间制映射，进度条无百分比可标
                seekTarget = Math.max(startTime + dx / rect.width * GESTURE_SEEK_SECONDS_PER_WIDTH, 0);
            }
        }
    }, { passive: false });

    const onTouchEnd = (e) => {
        if (touchId === null) return;
        let found = false;
        let t = null;
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === touchId) { found = true; t = e.changedTouches[i]; break; }
        }
        if (!found) return;
        // 手势已生效：拦截触摸合成的 click（避免误暂停/误切换控制栏）
        if (moved) {
            e.preventDefault();
            suppressNextClick = true;
            lastTapAt = 0; // 滑动手势打断双击计数
        } else if (e.type === 'touchcancel') {
            lastTapAt = 0; // 系统取消的触摸不算点击
        } else if (gestureType === '' && (Date.now() - touchStartAt) < TAP_MAX_DURATION) {
            // 未构成手势的快速点按：做双击检测（区域以第二次点按为准：
            // 左/右 1/3 seek ∓/± 15 秒，中间播放暂停，与桌面双击语义一致）
            const now = Date.now();
            if (lastTapAt && (now - lastTapAt) <= DBL_TAP_WINDOW) {
                // 命中双击：拦截第二次 tap 的合成 click（防 ArtPlayer 重复触发/双击缩放）
                e.preventDefault();
                suppressNextClick = true;
                lastTapAt = 0;
                const side = sideAt(t.clientX);
                if (side === 'left') {
                    seekBy(-SEEK_STEP_SECONDS);
                } else if (side === 'right') {
                    seekBy(SEEK_STEP_SECONDS);
                } else {
                    try { art.toggle(); } catch (err) { }
                }
            } else {
                lastTapAt = now;
            }
        }
        endGesture();
    };
    playerRoot.addEventListener('touchend', onTouchEnd, { passive: false });
    playerRoot.addEventListener('touchcancel', onTouchEnd, { passive: false });

    // 恢复上次的亮度设置（换集/刷新后保持）
    applyVideoBrightness(getSavedBrightness());
}

// =================================
// ====== 播放器锁定（手势锁）=======
// =================================
// 类爱奇艺/腾讯/优酷：锁定后隐藏控制栏并屏蔽一切手势/点击，仅对侧解锁悬浮钮可交互
// 左右对称悬浮锁钮：右侧=锁定入口（随控制栏显隐），左侧=解锁（锁定时常显），均为简洁线性图标
function setupLockButton() {
    if (!art) return;
    const playerRoot = art.template.$player || document.querySelector('#player .art-video-player');
    if (!playerRoot || playerRoot.__wdtvLock) return;
    playerRoot.__wdtvLock = true;

    const ICON_ATTRS = 'viewBox="0 0 24 24" style="width:100%;height:100%" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
    // 简洁线性挂锁图标（含锁孔小竖线；开启态锁环一端翘起），无底座圆圈
    const lockSvg = `<svg ${ICON_ATTRS}><rect x="5" y="11" width="14" height="9.5" rx="2.2"/><path d="M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11"/><path d="M12 14.5v2.5"/></svg>`;
    const unlockSvg = `<svg ${ICON_ATTRS}><rect x="5" y="11" width="14" height="9.5" rx="2.2"/><path d="M8.5 11V7.5a3.5 3.5 0 0 1 6.9-.9"/><path d="M12 14.5v2.5"/></svg>`;

    // 锁定遮罩：透明覆盖层，挡住播放器内一切交互（控制栏/面板/视频点击/手势）
    let shield = playerRoot.querySelector('.wdtv-lock-shield');
    if (!shield) {
        shield = document.createElement('div');
        shield.className = 'wdtv-lock-shield';
        playerRoot.appendChild(shield);
    }

    // 右侧锁定悬浮钮：与左侧解锁钮左右对称，控制栏显示时才出现（不常驻遮挡画面）
    // 图标按用户要求与解锁钮互换：锁定钮显示开启锁图形，解锁钮显示闭合锁图形（功能不变）
    let lockBtn = playerRoot.querySelector('.wdtv-lock-btn');
    if (!lockBtn) {
        lockBtn = document.createElement('div');
        lockBtn.className = 'wdtv-lock-btn';
        lockBtn.title = '锁定播放器';
        lockBtn.innerHTML = unlockSvg;
        playerRoot.appendChild(lockBtn);
    }

    // 左侧解锁悬浮钮：锁定时常显，点按解锁
    let unlockBtn = playerRoot.querySelector('.wdtv-unlock-btn');
    if (!unlockBtn) {
        unlockBtn = document.createElement('div');
        unlockBtn.className = 'wdtv-unlock-btn';
        unlockBtn.title = '解锁播放器';
        unlockBtn.innerHTML = lockSvg;
        playerRoot.appendChild(unlockBtn);
    }

    // 遮罩上点一下：闪烁解锁钮提示位置（用户找不到解锁钮时的引导）
    shield.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        unlockBtn.classList.remove('pulse');
        void unlockBtn.offsetWidth; // 重启动画
        unlockBtn.classList.add('pulse');
    });
    // 阻断冒泡到播放器的事件（手势、长按倍速、显示控制栏的 mousemove/touch 逻辑）
    ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'pointermove', 'pointerup',
        'mousedown', 'mousemove', 'mouseup', 'dblclick', 'contextmenu'].forEach(type => {
            shield.addEventListener(type, (e) => { e.stopPropagation(); }, { passive: false });
        });

    unlockBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        unlockPlayerGestures();
    });
    ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'contextmenu'].forEach(type => {
        unlockBtn.addEventListener(type, (e) => e.stopPropagation());
    });

    lockBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        lockPlayerGestures();
    });
    ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'contextmenu'].forEach(type => {
        lockBtn.addEventListener(type, (e) => e.stopPropagation());
    });

    // 锁定钮跟随控制栏显隐（art-control-show 为控制栏可见标志，鼠标悬停 art-hover 同理），锁定时常隐
    const syncLockBtn = () => {
        if (playerLocked) {
            lockBtn.style.display = 'none';
            return;
        }
        const controlsVisible = playerRoot.classList.contains('art-control-show') || playerRoot.classList.contains('art-hover');
        lockBtn.style.display = controlsVisible ? 'flex' : 'none';
    };
    new MutationObserver(syncLockBtn).observe(playerRoot, { attributes: true, attributeFilter: ['class'] });
    syncLockBtn();

    // 锁定/解锁实现挂到 playerRoot（与实例同生命周期，换集重建后自动重置）
    playerRoot.lockGestures = () => {
        playerLocked = true;
        playerRoot.classList.add('wdtv-locked');
        closeAllQuickPanels();
        try { art.controls.show = false; } catch (e) { }
        shield.style.display = 'block';
        unlockBtn.style.display = 'flex';
        lockBtn.style.display = 'none';
    };
    playerRoot.unlockGestures = () => {
        playerLocked = false;
        playerRoot.classList.remove('wdtv-locked');
        shield.style.display = 'none';
        unlockBtn.style.display = 'none';
        try { art.controls.show = true; } catch (e) { }
        lockBtn.style.display = 'flex'; // 解锁时控制栏随之显示，锁定钮同步出现
    };

    shield.style.display = 'none';
    unlockBtn.style.display = 'none';
    syncLockBtn();
}

function lockPlayerGestures() {
    if (!art) return;
    const playerRoot = art.template.$player || document.querySelector('#player .art-video-player');
    if (playerRoot && playerRoot.lockGestures) {
        playerRoot.lockGestures();
        if (typeof showToast === 'function') showToast('播放器已锁定', 'success');
    }
}

function unlockPlayerGestures() {
    if (!art) return;
    const playerRoot = art.template.$player || document.querySelector('#player .art-video-player');
    if (playerRoot && playerRoot.unlockGestures) {
        playerRoot.unlockGestures();
        if (typeof showToast === 'function') showToast('播放器已解锁', 'success');
    }
}

// =================================
// == 右侧画面按钮：截图 / 录屏 ====
// =================================
// 位于锁定钮原先的位置（屏幕右侧垂直居中），随控制栏显隐。
// 点击弹出两个选项：
//   1) 提取当前画面：canvas 逐像素绘制 video 解码帧，PNG（无损）导出，尺寸=视频原始分辨率
//   2) 录制屏幕画面：捕获视频解码流（原生 captureStream 优先，含音频；兜底 canvas 逐帧绘制），
//      MediaRecorder 高码率录制，画面为视频原分辨率、无任何 UI 覆盖
let screenRec = null; // 进行中的录屏 { rec, chunks, cleanup }

// 生成保存文件名：标题_第N集_类型_日期时间.ext（过滤文件系统非法字符）
function buildMediaFileName(kind, ext) {
    const safe = String(currentVideoTitle || '视频').replace(/[\\/:*?"<>|]/g, ' ').trim() || '视频';
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `${safe}_第${(currentEpisodeIndex || 0) + 1}集_${kind}_${ts}.${ext}`;
}

// ===== 录制导出的移动端适配（对齐 downloader.js 的处理方式）=====
// a[download] 的 blob: 资源 Content-Type 取 Blob 内部类型——带 codecs 参数的 MIME 会让
// 安卓内核（X5/夸克/UC 等）下载管理器报「下载失败: bad base-64」，故 onstop 用干净 base MIME
// 建 Blob（与剧集合并 Blob 同类）。导出策略：安卓/桌面停止录制后自动导出（同剧集 triggerSave
// 无手势 a[download] 可靠）；iOS 系统限制无手势 share/a[download] 均不可靠 → 入库下载管理器
// 由用户点「保存」；下载器不可用时兜底：相机面板「保存录制文件」入口（真实手势导出）。
const REC_UA = navigator.userAgent || '';
const REC_IS_MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(REC_UA) ||
    (REC_UA.includes('Macintosh') && navigator.maxTouchPoints > 1); // iPadOS 桌面 UA 也算移动端
const REC_IS_IOS = /iP(hone|ad|od)/i.test(REC_UA) || (REC_UA.includes('Macintosh') && navigator.maxTouchPoints > 1);
let pendingRecording = null; // { blob, filename, type } 待保存录制文件（移动端）

// 导出媒体文件（录屏/截图通用）：移动端优先 navigator.share 系统分享面板（可"存储到文件"，
// 与下载器分享按钮同路径），分享不可用/异常（用户取消除外）回退 a[download]；桌面直接 a[download]
// 注意 File 类型必须用干净 base MIME（video/mp4），带 codecs 参数（video/mp4;codecs=avc1...）
// 会让部分移动端 canShare 判 false 而掉进 a[download]，随后被内核拦截报「下载失败: bad base-64」
// 返回 true = 已完成导出交付（分享完成或已触发下载）；false = 用户取消分享面板
async function exportRecordedBlob(entry) {
    const mimeBase = (String(entry.type || '').split(';')[0]) || 'video/mp4';
    if (REC_IS_MOBILE) {
        try {
            const file = new File([entry.blob], entry.filename, { type: mimeBase });
            if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: entry.filename });
                return true;
            }
        } catch (e) {
            if (e && e.name === 'AbortError') return false; // 用户取消分享面板
            // 其它异常（无手势 NotAllowedError、低版本不支持文件分享等）回退 a[download]
        }
    }
    downloadBlob(entry.blob, entry.filename);
    return true;
}

// 录制文件入库到下载管理器：复用下载器现成的导出链路（triggerSave/exportTaskFile：
// 安卓桌面=自动 a[download]、iOS 保存=系统分享面板），与剧集下载完全同一套可靠实现
// opts.autoExport=true：入库后立即自动导出（安卓/桌面无手势 a[download] 可靠，同剧集合并完成行为）
// 返回 true = 入库成功；false = 下载器不可用/存储失败（调用方走 exportRecordedBlob 兜底）
async function saveRecordingToDownloader(entry, opts) {
    if (!window.WDTDownloader || typeof window.WDTDownloader.addLocalFile !== 'function') return false;
    const base = String(entry.filename || '').replace(/\.[a-z0-9]+$/i, '') || '录屏';
    const fmt = /\.webm$/i.test(entry.filename) ? 'webm' : 'mp4';
    const task = await window.WDTDownloader.addLocalFile(entry.blob, base, Object.assign({ format: fmt, quality: '本机录制' }, opts || {}));
    return !!task;
}

// 通过临时 <a download> 触发浏览器下载（blob 由调用方负责 revoke）
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// 提取当前画面：绘制视频原始分辨率帧，PNG 无损导出
function captureVideoScreenshot() {
    const video = (art && art.video) ? art.video : null;
    if (!video || !video.videoWidth || video.readyState < 2) {
        if (typeof showToast === 'function') showToast('视频尚未加载出画面，请稍后再试', 'error');
        return;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    let ctx;
    try {
        ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, w, h); // 原始解码帧（不含 CSS 亮度等滤镜，即视频原画面）
    } catch (e) {
        if (typeof showToast === 'function') showToast('截图失败：视频源不允许读取画面', 'error');
        return;
    }
    try {
        canvas.toBlob(async blob => {
            if (!blob || !blob.size) {
                if (typeof showToast === 'function') showToast('截图失败：画面数据为空', 'error');
                return;
            }
            // 移动端同样经分享面板导出（a[download] 在 X5/夸克等内核报 bad base-64）；
            // 入口为用户点按 + toBlob 毫秒级完成，手势激活仍有效
            const delivered = await exportRecordedBlob({
                blob,
                filename: buildMediaFileName('截图', 'png'),
                type: 'image/png'
            });
            if (typeof showToast === 'function') {
                if (delivered) showToast(`保存完成（PNG 无损 ${w}×${h}）`, 'success');
                else showToast('已取消保存分享面板', 'info');
            }
        }, 'image/png');
    } catch (e) {
        // 跨域资源未带 CORS 头时 toBlob 抛 SecurityError（播放端已走同源代理，正常不会触发）
        if (typeof showToast === 'function') showToast('截图失败：视频源不允许读取画面', 'error');
    }
}

// 在支持的容器格式里挑选 MediaRecorder mimeType：按用户要求优先 MP4（H.264/AAC，浏览器直录无需转码），不支持时回退 WebM
function pickRecorderMime() {
    const candidates = [
        'video/mp4;codecs=avc1.640028,mp4a.40.2',
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8,opus',
        'video/webm'
    ];
    for (const m of candidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
}

function startVideoRecording() {
    const video = (art && art.video) ? art.video : null;
    if (!video || !video.videoWidth || video.readyState < 2) {
        if (typeof showToast === 'function') showToast('视频尚未加载出画面，请稍后再试', 'error');
        return;
    }
    if (!window.MediaRecorder) {
        if (typeof showToast === 'function') showToast('当前浏览器不支持录屏', 'error');
        return;
    }
    if (screenRec) return; // 已在录制中
    pendingRecording = null; // 新录制开始：丢弃未保存的旧录制，释放内存（面板刷新由 record 选项处理）

    const w = video.videoWidth;
    const h = video.videoHeight;
    let rafId = 0;

    // ===== 画面捕获：canvas 手动帧模式（captureStream(0) + requestFrame）=====
    // 为什么不直接 video.captureStream()？
    //   Chrome 中 video 元素暂停/缓冲时，其捕获流的视频轨会以设定帧率"持续重复输出最后一帧"
    //   （为 WebRTC 保持轨道活跃的设计行为）。而本播放器点击视频画面即切换播放/暂停——
    //   用户开始/停止录制前点到画面唤控制栏的那几秒，暂停帧会被 MediaRecorder 如实录成定格画面，
    //   这正是成片开头/结尾出现几秒重复帧的根源。
    // 手动帧模式原理：canvas.captureStream(0) 只在 requestFrame() 被调用时产出一帧，
    //   本回调仅在"视频正在播放且 currentTime 前进（真正有新解码画面）"时绘制+产帧。
    //   暂停/缓冲/卡顿区间不产生任何帧 → 成片时间轴直接跳过该区间，不再出现重复帧。
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    let canvasStream;
    try {
        canvasStream = canvas.captureStream(0); // 0 = 手动帧模式
    } catch (e) {
        try { canvasStream = canvas.captureStream(60); } catch (e2) {
            if (typeof showToast === 'function') showToast('录屏失败：视频源不允许捕获画面', 'error');
            return;
        }
    }
    const vTrack = canvasStream.getVideoTracks()[0];
    const manualFrame = typeof vTrack.requestFrame === 'function'; // 固定帧率兜底时为 false

    let lastTs = -1;
    const draw = () => {
        rafId = requestAnimationFrame(draw);
        if (video.paused || video.ended || video.readyState < 2) return; // 无新画面：不绘制、不产帧
        if (video.currentTime === lastTs) return; // 解码帧未更新（源帧率低于刷新率）：不重复产帧
        lastTs = video.currentTime;
        try { ctx.drawImage(video, 0, 0, w, h); } catch (e) { stopVideoRecording(); return; }
        if (manualFrame) vTrack.requestFrame(); // 手动模式下此刻才真正产出一帧
    };
    draw();

    // ===== 音频：取媒体元素捕获流的音频轨（暂停时同样无样本，与画面自然对齐）；拿不到则无声录制 =====
    // 注意：只取 audioTracks，不用其视频轨（避免上面的定格问题）
    let audioTracks = [];
    let srcStream = null;
    try {
        srcStream = video.captureStream ? video.captureStream()
            : (video.mozCaptureStream ? video.mozCaptureStream() : null);
        if (srcStream) audioTracks = srcStream.getAudioTracks();
    } catch (e) { srcStream = null; }
    const stream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
    const hasAudio = audioTracks.length > 0;

    // 原画面高码率：按分辨率给足码率（1080P≈16Mbps、4K 上限 50Mbps），尽量保留原始画质
    const bitrate = Math.min(50 * 1000 * 1000, Math.max(10 * 1000 * 1000, Math.round(w * h * 8)));
    const mime = pickRecorderMime();
    let rec;
    try {
        rec = new MediaRecorder(stream, mime ? {
            mimeType: mime,
            videoBitsPerSecond: bitrate,
            audioBitsPerSecond: 192000
        } : { videoBitsPerSecond: bitrate });
    } catch (e) {
        if (typeof showToast === 'function') showToast('当前浏览器无法启动录制', 'error');
        cancelAnimationFrame(rafId);
        return;
    }

    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = () => {
        cleanupRecording();
        if (typeof showToast === 'function') showToast('录屏出错，已终止', 'error');
    };
    rec.onstop = async () => {
        const type = mime || 'video/webm';
        // 关键：Blob 必须用干净 base MIME！MediaRecorder 的 mime 带 codecs 参数
        // （video/mp4;codecs=avc1...），a[download] 下载 blob: 资源时浏览器下载管理器
        // 拿到的 Content-Type 就是 Blob 内部类型，带参数的 MIME 会让安卓内核
        // （X5/夸克/UC 等）解析失败报「下载失败: bad base-64」——剧集下载的合并 Blob
        // 全是干净类型（video/mp4）所以正常，录屏是全项目唯一带 codecs 的 Blob
        const mimeBase = (type.split(';')[0]) || 'video/mp4';
        const blob = new Blob(chunks, { type: mimeBase });
        const ext = mimeBase.indexOf('mp4') !== -1 ? 'mp4' : 'webm';
        if (blob.size > 0) {
            const entry = { blob, filename: buildMediaFileName('录屏', ext), type: mimeBase };
            if (REC_IS_MOBILE && !REC_IS_IOS) {
                // 安卓/桌面移动端：停止录制即自动导出（无感保存）——入库下载管理器留底 +
                // 立即触发 a[download]（与剧集合并完成的自动导出完全同一可靠路径，MIME 已干净）
                const stored = await saveRecordingToDownloader(entry, { autoExport: true });
                if (stored) {
                    if (typeof showToast === 'function') showToast(`录制完成！视频已自动保存到下载目录（${ext.toUpperCase()} ${w}×${h}）`, 'success');
                } else {
                    // 兜底：下载器不可用/存储失败 → 相机面板「保存录制文件」入口（用户点按时导出）
                    pendingRecording = entry;
                    if (typeof showToast === 'function') showToast('录制完成！请点右侧相机按钮，选「保存录制文件」导出', 'info');
                }
            } else if (REC_IS_IOS) {
                // iOS：系统限制无手势时 share/a[download] 均不可靠 → 入库管理器，用户点「保存」
                const stored = await saveRecordingToDownloader(entry);
                if (stored) {
                    if (typeof showToast === 'function') showToast('录制完成！请打开下载管理点「保存」导出到手机', 'success');
                } else {
                    pendingRecording = entry;
                    if (typeof showToast === 'function') showToast('录制完成！请点右侧相机按钮，选「保存录制文件」导出', 'info');
                }
            } else {
                // 桌面：直接 a[download] 导出（无 blob 拦截问题）
                exportRecordedBlob(entry).then(delivered => {
                    if (delivered && typeof showToast === 'function') showToast(`保存完成（${ext.toUpperCase()} ${w}×${h} 高码率）`, 'success');
                });
            }
        } else {
            if (typeof showToast === 'function') showToast('录屏内容为空，未保存', 'error');
        }
        cleanupRecording();
    };

    // 播放到结尾（video ended）时自动停止并保存
    const onVideoEnded = () => stopVideoRecording();
    video.addEventListener('ended', onVideoEnded);

    const cleanup = () => {
        cancelAnimationFrame(rafId);
        video.removeEventListener('ended', onVideoEnded);
        try { stream.getTracks().forEach(t => t.stop()); } catch (e) { }
        if (srcStream) { try { srcStream.getTracks().forEach(t => t.stop()); } catch (e) { } } // 停掉元素捕获流的全部轨道（含未并入的旧视频轨）
        screenRec = null;
        const pr = (art && art.template && art.template.$player) || document.querySelector('#player .art-video-player');
        if (pr && pr.__wdtvPhotoRefresh) pr.__wdtvPhotoRefresh();
    };

    rec.start(1000); // 每秒收集一次数据块，停止时可完整保存已录内容
    screenRec = { rec, cleanup };
    // 开始提示：无声 / 非 MP4 时给出说明，正常时显示规格
    const notes = [];
    if (!hasAudio) notes.push('无声（浏览器未开放音频捕获）');
    if (mime && mime.indexOf('mp4') === -1) notes.push('WebM 格式（浏览器不支持 MP4 直录）');
    if (notes.length && typeof showToast === 'function') {
        showToast('开始录制（' + notes.join('，') + '）', 'info');
    } else if (typeof showToast === 'function') {
        showToast(`开始录制（MP4 原画 ${w}×${h}）`, 'success');
    }
    const pr0 = (art && art.template && art.template.$player) || document.querySelector('#player .art-video-player');
    if (pr0 && pr0.__wdtvPhotoRefresh) pr0.__wdtvPhotoRefresh();
}

function stopVideoRecording() {
    if (!screenRec) return;
    try { screenRec.rec.stop(); } // onstop 内完成保存与清理
    catch (e) { screenRec.cleanup(); }
}

function cleanupRecording() {
    if (screenRec) screenRec.cleanup();
}

// 右侧画面按钮：截图/录屏入口，位于屏幕右侧垂直居中（锁定钮原先的位置），随控制栏显隐
// 悬浮钮图标与控制栏原生图标同尺寸（21px），点击弹出两个选项（毛玻璃面板，与播放器面板同款视觉）
function setupPhotoButton() {
    if (!art) return;
    const playerRoot = art.template.$player || document.querySelector('#player .art-video-player');
    if (!playerRoot || playerRoot.__wdtvPhoto) return;
    playerRoot.__wdtvPhoto = true;

    // 相机线性图标：与控制栏原生图标同尺寸同风格（stroke 1.6）
    const SVG_ATTRS = 'viewBox="0 0 24 24" style="width:100%;height:100%" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
    const photoSvg = `<svg ${SVG_ATTRS}><rect x="2.8" y="6.2" width="18.4" height="14" rx="2.6"/><circle cx="12" cy="12.8" r="3.5"/><path d="M8.5 6.2l1.2-2h4.6l1.2 2"/></svg>`;
    const shotSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5.5" width="17" height="13.5" rx="2.2"/><circle cx="12" cy="12" r="3.3"/><path d="M8.4 5.5l1-1.7h5.2l1 1.7"/></svg>`;
    const recSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="6"/></svg>`;
    const saveRecSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10.5"/><path d="M7.5 10.5l4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/></svg>`;

    let photoBtn = playerRoot.querySelector('.wdtv-photo-btn');
    if (!photoBtn) {
        photoBtn = document.createElement('div');
        photoBtn.className = 'wdtv-photo-btn';
        photoBtn.title = '截图 / 录屏';
        photoBtn.innerHTML = photoSvg;
        playerRoot.appendChild(photoBtn);
    }

    // 选项面板：毛玻璃样式与播放器快捷面板同款，固定出现在按钮左侧垂直居中
    let panel = playerRoot.querySelector('.wdtv-photo-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.className = 'art-speed-panel wdtv-photo-panel hidden';
        panel.innerHTML =
            `<div class="art-speed-item wdtv-photo-item" data-action="screenshot">${shotSvg}<span>提取当前画面</span></div>` +
            `<div class="art-speed-item wdtv-photo-item" data-action="record">${recSvg}<span>录制屏幕画面</span></div>` +
            `<div class="art-speed-item wdtv-photo-item" data-action="save-rec" style="display:none">${saveRecSvg}<span>保存录制文件</span></div>`;
        playerRoot.appendChild(panel);
    }

    // 选项状态刷新：录制中第二项显示“停止录制”并标红，悬浮钮同步变红；
    // 有待保存录制文件时显示第三项「保存录制文件」
    const refreshPhotoPanel = () => {
        const recItem = panel.querySelector('[data-action="record"]');
        if (recItem) {
            recItem.classList.toggle('recording', !!screenRec);
            const span = recItem.querySelector('span');
            if (span) span.textContent = screenRec ? '停止录制' : '录制屏幕画面';
        }
        const saveItem = panel.querySelector('[data-action="save-rec"]');
        if (saveItem) saveItem.style.display = pendingRecording ? '' : 'none';
        photoBtn.classList.toggle('recording', !!screenRec);
    };
    playerRoot.__wdtvPhotoRefresh = refreshPhotoPanel;

    photoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const willShow = panel.classList.contains('hidden');
        closeAllQuickPanels();
        if (willShow) {
            refreshPhotoPanel();
            panel.classList.remove('hidden');
        }
    });
    // 阻断冒泡到播放器（手势/长按倍速/控制栏唤起逻辑）
    ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'contextmenu'].forEach(type => {
        photoBtn.addEventListener(type, (e) => e.stopPropagation());
    });

    panel.addEventListener('click', async (e) => {
        const item = e.target.closest('.wdtv-photo-item');
        if (!item) return;
        e.stopPropagation();
        const action = item.dataset.action;
        if (action === 'screenshot') {
            captureVideoScreenshot();
            panel.classList.add('hidden');
        } else if (action === 'record') {
            if (screenRec) stopVideoRecording();
            else startVideoRecording();
            refreshPhotoPanel();
            panel.classList.add('hidden');
        } else if (action === 'save-rec') {
            // 移动端导出入口（对齐下载器「分享」按钮）：真实用户点按手势内调起系统分享面板，
            // 可选"存储到文件"；分享不可用时回退 a[download]
            if (!pendingRecording) return;
            const entry = pendingRecording;
            const delivered = await exportRecordedBlob(entry);
            if (delivered) {
                pendingRecording = null; // 已交付：释放内存
                if (typeof showToast === 'function') showToast('保存完成（可在系统分享面板选"存储到文件"）', 'success');
            } else if (typeof showToast === 'function') {
                showToast('已取消保存分享面板', 'info');
            }
            refreshPhotoPanel();
            panel.classList.add('hidden');
        }
    });

    // 面板注册进快捷面板体系：锁定/打开其他面板时自动关闭，点击外部自动收起
    registerQuickPanel({ key: 'photo', panel, btn: photoBtn, playerRoot, refresh: refreshPhotoPanel });

    // 显隐与控制栏同步（art-control-show/art-hover 为控制栏可见标志），锁定时常隐
    const syncPhotoBtn = () => {
        if (playerLocked) {
            photoBtn.style.display = 'none';
            panel.classList.add('hidden');
            return;
        }
        const controlsVisible = playerRoot.classList.contains('art-control-show') || playerRoot.classList.contains('art-hover');
        photoBtn.style.display = controlsVisible ? 'flex' : 'none';
        if (!controlsVisible) panel.classList.add('hidden');
    };
    new MutationObserver(syncPhotoBtn).observe(playerRoot, { attributes: true, attributeFilter: ['class'] });
    syncPhotoBtn();
}

// 清除视频进度记录
function clearVideoProgress() {
    const progressKey = `videoProgress_${getVideoId()}`;
    try {
        localStorage.removeItem(progressKey);
    } catch (e) {
    }
}

// 获取视频唯一标识
function getVideoId() {
    // 优先用原始集地址作为唯一标识：清晰度目录切换会改写 currentVideoUrl，
    // 若用它做键，同一集不同清晰度的播放进度会互相割裂
    if (baseEpisodeUrl) {
        return `${encodeURIComponent(baseEpisodeUrl)}`;
    }
    if (currentVideoUrl) {
        return `${encodeURIComponent(currentVideoUrl)}`;
    }
    return `${encodeURIComponent(currentVideoTitle)}_${currentEpisodeIndex}`;
}

// 支持在iframe中关闭播放器
function closeEmbeddedPlayer() {
    try {
        if (window.self !== window.top) {
            // 如果在iframe中，尝试调用父窗口的关闭方法
            if (window.parent && typeof window.parent.closeVideoPlayer === 'function') {
                window.parent.closeVideoPlayer();
                return true;
            }
        }
    } catch (e) {
        console.error('尝试关闭嵌入式播放器失败:', e);
    }
    return false;
}

function renderResourceInfoBar() {
    // 获取容器元素
    const container = document.getElementById('resourceInfoBarContainer');
    if (!container) {
        console.error('找不到资源信息卡片容器');
        return;
    }
    
    // 获取当前视频 source_code
    const urlParams = new URLSearchParams(window.location.search);
    const currentSource = urlParams.get('source') || '';
    
    // 显示临时加载状态
    container.innerHTML = `
      <div class="resource-info-bar-left flex">
        <span>加载中...</span>
        <span class="resource-info-bar-videos">-</span>
      </div>
      <button class="resource-switch-btn flex" id="switchResourceBtn" onclick="showSwitchResourceModal()">
        <span class="resource-switch-icon">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 4v16m0 0l-6-6m6 6l6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
        切换资源
      </button>
    `;

    // 查找当前源名称
    let resourceName = currentSource
    if (currentSource && API_SITES[currentSource]) {
        resourceName = API_SITES[currentSource].name;
    }

    container.innerHTML = `
      <div class="resource-info-bar-left flex">
        <span>${resourceName}</span>
        <span class="resource-info-bar-videos">${currentEpisodes.length} 个视频</span>
        <span id="resolutionInfo" class="resource-info-bar-resolution" style="display:none"></span>
      </div>
      <button class="resource-switch-btn flex" id="switchResourceBtn" onclick="showSwitchResourceModal()">
        <span class="resource-switch-icon">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 4v16m0 0l-6-6m6 6l6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
        切换资源
      </button>
    `;
}

// ===== 换源测速增强：实测码率 + 实测吞吐 =====
// 背景：采集站全是单档流，客户端无法降码率；换到码率更低的源是唯一真正降低
// 带宽需求的路。这里在按需测速时对首分片做 Range 流式探测：
//   预估码率 = 首分片完整大小 × 8 / EXTINF 时长（大小从 206 Content-Range 总量读取，不必下完整片）
//   实测吞吐 = 流式读取首分片（读满 256KB 或 8s 先到为准，扣除首字节延迟后的稳态速率）
// 徽章按 吞吐/码率 比值给出"流畅/勉强/必卡"判断，用户据此换到低码率源。

const SPEED_PROBE_MAX_BYTES = 256 * 1024; // 吞吐测量读满 256KB 即提前收手（cancel 流）
const SPEED_PROBE_MIN_BYTES = 128 * 1024; // 有效吞吐样本下限（低于此视为噪声样本）
const SPEED_PROBE_TIMEOUT_MS = 8000;      // 单次分片探测硬超时
const SOURCE_PROBE_PLAYLIST_TIMEOUT_MS = 6000; // m3u8 拉取超时

// 测速结果会话内缓存：同一源重复点击不再探测（网络状况变化重新进页面后自然失效）
const sourceSpeedProbeCache = new Map();

// 拉取文本（带超时）：失败返回 null
async function fetchProbeText(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || SOURCE_PROBE_PLAYLIST_TIMEOUT_MS);
    try {
        const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
        if (!resp.ok) return null;
        return await resp.text();
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// 拉取 m3u8 文本：直连优先（与 https 源实际播放路径一致），失败回退代理（与 http 源实际路径一致）
async function fetchM3u8ProbeText(innerUrl) {
    const direct = await resolvePlayableUrl(innerUrl);
    let text = await fetchProbeText(direct);
    if (text && text.trimStart().startsWith('#EXTM3U')) return text;
    const proxied = PROXY_URL + encodeURIComponent(innerUrl);
    if (direct !== proxied) {
        text = await fetchProbeText(proxied);
        if (text && text.trimStart().startsWith('#EXTM3U')) return text;
    }
    return null;
}

// 解析 m3u8 内 URI 行为绝对地址：兼容绝对 http(s)、站点绝对路径（含代理重写形式）、相对路径
function resolveProbeUrl(uri, baseUrl) {
    try {
        return new URL(uri, baseUrl).toString();
    } catch (e) {
        return null;
    }
}

// 从 m3u8 文本提取首个 URI 行及其 EXTINF 时长：
// 主列表 → { fragUrl: 变体地址, extinf: null }（调用方下钻一层）
// 媒体列表 → { fragUrl: 首分片地址, extinf: 秒数 }
function parseFirstUriFromM3u8(text, baseUrl) {
    let pendingInf = null;
    for (const raw of text.split(/\r?\n/)) {
        const t = raw.trim();
        if (!t) continue;
        if (t.startsWith('#EXTINF:')) {
            const v = parseFloat(t.slice(8));
            pendingInf = isFinite(v) ? v : null;
            continue;
        }
        if (t.startsWith('#')) continue; // 其余标签（KEY/MAP 等）跳过
        const abs = resolveProbeUrl(t, baseUrl);
        if (!abs) continue;
        return { fragUrl: abs, extinf: (pendingInf && pendingInf > 0) ? pendingInf : null };
    }
    return null;
}

// 首分片定位：集地址（或主列表）→ 媒体列表 → 首个 EXTINF+分片，最多下钻两层
async function probeSourcePlaylist(episodeUrl) {
    let url = episodeUrl;
    for (let depth = 0; depth < 2; depth++) {
        const text = await fetchM3u8ProbeText(url);
        if (!text) return null;
        const parsed = parseFirstUriFromM3u8(text, url);
        if (!parsed) return null;
        if (parsed.extinf != null) return parsed; // 媒体列表：拿到首分片
        url = parsed.fragUrl; // 主列表：下钻首个变体
    }
    return null;
}

// 单次 Range 流式探测：返回 { throughputBps, sizeBytes }
// sizeBytes = 分片完整大小（206 取 Content-Range 总量；200 取 Content-Length；拿不到为 null）
async function rangeProbeOnce(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SPEED_PROBE_TIMEOUT_MS);
    let bytes = 0, firstByteAt = 0, lastByteAt = 0, done = false, total = null;
    try {
        const resp = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'Range': 'bytes=0-' + (SPEED_PROBE_MAX_BYTES - 1) },
            cache: 'no-store'
        });
        if (!resp.ok && resp.status !== 206) return null;
        const cr = resp.headers.get('content-range'); // bytes 0-262143/2345678
        if (cr) {
            const m = cr.match(/\/(\d+)/);
            if (m) total = parseInt(m[1], 10);
        }
        if (total == null && resp.status === 200) {
            const cl = resp.headers.get('content-length');
            if (cl) total = parseInt(cl, 10);
        }
        const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
        if (!reader) return { throughputBps: null, sizeBytes: total };
        while (bytes < SPEED_PROBE_MAX_BYTES) {
            const chunk = await reader.read();
            if (chunk.done) { done = true; break; }
            if (!firstByteAt) firstByteAt = performance.now(); // 扣除建连/TTFB，只计稳态段
            bytes += chunk.value.length;
            lastByteAt = performance.now();
        }
        if (!done) { try { await reader.cancel(); } catch (e) { } }
    } catch (e) {
        // 超时 abort / 网络错误：用已收到的读数兜底（finally 统一计算）
    } finally {
        clearTimeout(timer);
    }
    const elapsed = (lastByteAt - firstByteAt) / 1000;
    const throughputBps = (bytes >= SPEED_PROBE_MIN_BYTES && elapsed > 0.05)
        ? Math.round((bytes * 8) / elapsed) : null;
    if (throughputBps == null && total == null) return null;
    return { throughputBps, sizeBytes: total };
}

// 分片探测入口：直连优先，失败回退代理
async function probeFragmentStats(innerUrl) {
    const direct = await resolvePlayableUrl(innerUrl);
    const proxied = PROXY_URL + encodeURIComponent(innerUrl);
    let r = await rangeProbeOnce(direct);
    if (!r && direct !== proxied) r = await rangeProbeOnce(proxied);
    return r;
}

// 测试视频源速率：接口延迟 + m3u8 首分片探测（实测码率/吞吐）
async function testVideoSourceSpeed(sourceKey, vodId) {
    const cacheKey = sourceKey + ':' + vodId;
    if (sourceSpeedProbeCache.has(cacheKey)) return sourceSpeedProbeCache.get(cacheKey);
    const result = await measureSourceSpeed(sourceKey, vodId);
    if (result.speed !== -1) sourceSpeedProbeCache.set(cacheKey, result); // 仅成功结果入缓存，失败可重试
    return result;
}

async function measureSourceSpeed(sourceKey, vodId) {
    try {
        const startTime = performance.now();

        // 获取视频详情
        const data = await fetchVideoDetailData({ id: vodId, source: sourceKey });

        if (data.code !== 200 || !data.episodes || data.episodes.length === 0) {
            return { speed: -1, error: '无播放源' };
        }

        const firstEpisodeUrl = data.episodes[0];
        if (!firstEpisodeUrl) {
            return { speed: -1, error: '链接无效' };
        }

        // 首分片探测：m3u8 → 首分片（得码率+吞吐）；非 m3u8（mp4 直链）→ 仅吞吐
        let extinf = null;
        let probe = null;
        if (/\.m3u8(\?|#|$)/i.test(firstEpisodeUrl)) {
            const frag = await probeSourcePlaylist(firstEpisodeUrl);
            if (frag && frag.fragUrl) {
                extinf = frag.extinf;
                probe = await probeFragmentStats(frag.fragUrl);
            }
        }
        if (!probe) {
            probe = await probeFragmentStats(firstEpisodeUrl);
        }

        const apiMs = Math.round(performance.now() - startTime);
        if (!probe) {
            // 探测全失败：退回接口响应时间口径
            return { speed: apiMs, episodes: data.episodes.length, error: null, note: 'API响应' };
        }

        // 预估码率：首分片完整大小 × 8 / EXTINF 时长（时长 0.5~60s 之外的异常值不采信）
        const bitrateBps = (probe.sizeBytes && extinf && extinf >= 0.5 && extinf <= 60)
            ? Math.round((probe.sizeBytes * 8) / extinf) : null;

        return {
            speed: apiMs,
            episodes: data.episodes.length,
            error: null,
            bitrateBps,
            throughputBps: probe.throughputBps
        };
    } catch (error) {
        return {
            speed: -1,
            error: error.name === 'AbortError' ? '超时' : '测试失败'
        };
    }
}

// 格式化速度显示：有码率+吞吐时按比值判断流畅度（换源决策核心指标），否则退回延迟口径
function formatSpeedDisplay(speedResult) {
    if (speedResult.speed === -1) {
        return `<span class="speed-indicator error">❌ ${speedResult.error}</span>`;
    }

    const speed = speedResult.speed;
    const bitrateBps = speedResult.bitrateBps || null;
    const throughputBps = speedResult.throughputBps || null;
    const note = speedResult.note ? ` (${speedResult.note})` : '';

    // 完整口径：码率 + 吞吐 → 比值判断（吞吐需明显大于码率才能持续缓冲，<1.05 倍必卡）
    if (bitrateBps && throughputBps) {
        const ratio = throughputBps / bitrateBps;
        let className = 'good', icon = '🟢', verdict = '流畅';
        if (ratio < 1.05) { className = 'poor'; icon = '🔴'; verdict = '必卡'; }
        else if (ratio < 1.6) { className = 'medium'; icon = '🟡'; verdict = '勉强'; }
        const tip = `预估码率 ${formatProbeBps(bitrateBps)}｜实测吞吐 ${formatProbeBps(throughputBps)}（约 ${ratio.toFixed(1)} 倍）｜接口延迟 ${speed}ms｜${verdict}`;
        return `<span class="speed-indicator ${className}" title="${tip}">${icon} ${formatProbeBps(bitrateBps)}</span>`;
    }

    // 仅有码率：吞吐探测失败，中性展示
    if (bitrateBps) {
        const tip = `预估码率 ${formatProbeBps(bitrateBps)}｜实测吞吐不可用｜接口延迟 ${speed}ms`;
        return `<span class="speed-indicator medium" title="${tip}">⚪ ${formatProbeBps(bitrateBps)}</span>`;
    }

    // 仅有吞吐（mp4 直链或分片大小未知）：按绝对吞吐粗判 + 延迟兜底
    if (throughputBps) {
        const cls = throughputBps >= 3e6 ? 'good' : (throughputBps >= 1.5e6 ? 'medium' : 'poor');
        const tip = `实测吞吐 ${formatProbeBps(throughputBps)}（码率未知）｜接口延迟 ${speed}ms`;
        return `<span class="speed-indicator ${cls}" title="${tip}">⏱ ${speed}ms</span>`;
    }

    // 兜底：旧延迟口径
    let className = 'speed-indicator good';
    let icon = '🟢';

    if (speed > 2000) {
        className = 'speed-indicator poor';
        icon = '🔴';
    } else if (speed > 1000) {
        className = 'speed-indicator medium';
        icon = '🟡';
    }

    return `<span class="${className}">${icon} ${speed}ms${note}</span>`;
}

// bps → 显示文本（<1Mbps 用 kbps）
function formatProbeBps(bps) {
    if (!bps || bps <= 0) return '未知';
    return bps >= 1e6 ? (bps / 1e6).toFixed(1) + 'Mbps' : Math.round(bps / 1e3) + 'kbps';
}

async function showSwitchResourceModal() {
    const urlParams = new URLSearchParams(window.location.search);
    const currentSourceCode = urlParams.get('source');
    const currentVideoId = urlParams.get('id');

    const modal = document.getElementById('modal');
    const modalTitle = document.getElementById('modalTitle');
    const modalContent = document.getElementById('modalContent');

    modalTitle.innerHTML = `<span class="break-words">${currentVideoTitle}</span>`;
    modalContent.innerHTML = '<div style="text-align:center;padding:20px;color:#6e6e73;grid-column:1/-1;">正在加载资源列表...</div>';
    modal.classList.remove('hidden');

    // 搜索（渲染候选列表必需）
    const resourceOptions = selectedAPIs.map((curr) => {
        if (API_SITES[curr]) {
            return { key: curr, name: API_SITES[curr].name };
        }
        return { key: curr, name: '未知资源' };
    });
    let allResults = {};
    await Promise.all(resourceOptions.map(async (opt) => {
        let queryResult = await searchByAPIAndKeyWord(opt.key, currentVideoTitle);
        if (queryResult.length == 0) {
            return
        }
        // 优先取完全同名资源，否则默认取第一个
        let result = queryResult[0]
        queryResult.forEach((res) => {
            if (res.vod_name == currentVideoTitle) {
                result = res;
            }
        })
        allResults[opt.key] = result;
    }));

    // 按需测速：不再打开弹窗即对全部候选并发测速（与播放流抢带宽），
    // 列表项提供"测速"按钮，用户点击单个源才发起该源的详情+测速请求
    const sortedResults = Object.entries(allResults).sort(([keyA, resultA], [keyB, resultB]) => {
        // 当前播放的源放在最前面，其余保持源配置顺序
        const isCurrentA = String(keyA) === String(currentSourceCode) && String(resultA.vod_id) === String(currentVideoId);
        const isCurrentB = String(keyB) === String(currentSourceCode) && String(resultB.vod_id) === String(currentVideoId);
        if (isCurrentA && !isCurrentB) return -1;
        if (!isCurrentA && isCurrentB) return 1;
        return 0;
    });

    // 渲染资源列表
    let html = '<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 p-4">';

    for (const [sourceKey, result] of sortedResults) {
        if (!result) continue;

        // 修复 isCurrentSource 判断，确保类型一致
        const isCurrentSource = String(sourceKey) === String(currentSourceCode) && String(result.vod_id) === String(currentVideoId);
        const sourceName = resourceOptions.find(opt => opt.key === sourceKey)?.name || '未知资源';

        html += `
            <div class="relative group ${isCurrentSource ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:scale-105 transition-transform'}"
                 ${!isCurrentSource ? `onclick="switchToResource('${sourceKey}', '${result.vod_id}')"` : ''}>
                <div class="aspect-[2/3] rounded-lg overflow-hidden bg-gray-100 relative">
                    <img src="${result.vod_pic}"
                         alt="${result.vod_name}"
                         class="w-full h-full object-cover"
                         onerror="this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjNjY2IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHJlY3QgeD0iMyIgeT0iMyIgd2lkdGg9IjE4IiBoZWlnaHQ9IjE4IiByeD0iMiIgcnk9IjIiPjwvcmVjdD48cGF0aCBkPSJNMjEgMTV2NGEyIDIgMCAwIDEtMiAySDVhMiAyIDAgMCAxLTItMnYtNCI+PC9wYXRoPjxwb2x5bGluZSBwb2ludHM9IjE3IDggMTIgMyA3IDgiPjwvcG9seWxpbmU+PHBhdGggZD0iTTEyIDN2MTIiPjwvcGF0aD48L3N2Zz4='">

                    <!-- 速率显示在图片右上角：默认未测速，点击测速按钮后填充 -->
                    <div class="absolute top-1 right-1 speed-badge" id="speed-badge-${sourceKey}">
                        <span class="speed-indicator" style="opacity:.75;">未测速</span>
                    </div>
                </div>
                <div class="mt-2">
                    <div class="text-xs font-medium text-gray-800 truncate">${result.vod_name}</div>
                    <div class="text-[10px] text-gray-500 truncate">${sourceName}</div>
                    <div class="text-[10px] text-gray-400 mt-1 flex items-center justify-between gap-1">
                        <span id="speed-episodes-${sourceKey}"></span>
                        <button type="button" class="wdtv-speed-test-btn"
                                onclick="event.stopPropagation(); testSourceSpeedOnClick('${sourceKey}', '${result.vod_id}')">测速</button>
                    </div>
                </div>
                ${isCurrentSource ? `
                    <div class="absolute inset-0 flex items-center justify-center">
                        <div class="bg-blue-500 bg-opacity-90 rounded-lg px-2 py-0.5 text-xs text-white font-medium">
                            当前播放
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }

    html += '</div>';
    modalContent.innerHTML = html;
}

// 换源弹窗按需测速：用户点击单个源的"测速"按钮时才发起该源的详情+测速请求
async function testSourceSpeedOnClick(sourceKey, vodId) {
    const badge = document.getElementById(`speed-badge-${sourceKey}`);
    if (badge) badge.innerHTML = '<span class="speed-indicator" style="opacity:.75;">⏳ 测速中…</span>';
    const speedResult = await testVideoSourceSpeed(sourceKey, vodId);
    if (badge) badge.innerHTML = formatSpeedDisplay(speedResult);
    const epEl = document.getElementById(`speed-episodes-${sourceKey}`);
    if (epEl && speedResult.episodes) epEl.textContent = `${speedResult.episodes}集`;
}

// 切换资源的函数
async function switchToResource(sourceKey, vodId) {
    // 关闭模态框
    document.getElementById('modal').classList.add('hidden');
    
    showLoading();
    try {
        // 获取视频详情
        const data = await fetchVideoDetailData({ id: vodId, source: sourceKey });

        if (!data.episodes || data.episodes.length === 0) {
            showToast('未找到播放资源', 'error');
            hideLoading();
            return;
        }

        // 获取当前播放的集数索引
        const currentIndex = currentEpisodeIndex;
        
        // 确定要播放的集数索引
        let targetIndex = 0;
        if (currentIndex < data.episodes.length) {
            // 如果当前集数在新资源中存在，则使用相同集数
            targetIndex = currentIndex;
        }
        
        // 获取目标集数的URL
        const targetUrl = data.episodes[targetIndex];
        
        // 构建播放页面URL
        // 换源是播放页→播放页的整页跳转，必须透传返回目标（进入播放器前的页面），
        // 否则新播放页无 returnUrl，返回时会错误地回到上一个播放页
        const playerParams = new URLSearchParams(window.location.search);
        const storedLastPage = localStorage.getItem('lastPageUrl');
        const returnTarget = playerParams.get('returnUrl') || (!isPlayerPageUrl(storedLastPage) ? storedLastPage : '') || '/';
        let watchUrl = `player.html?id=${vodId}&source=${sourceKey}&url=${encodeURIComponent(targetUrl)}&index=${targetIndex}&title=${encodeURIComponent(currentVideoTitle)}&returnUrl=${encodeURIComponent(returnTarget)}`;
        
        // 保存当前状态到localStorage
        try {
            localStorage.setItem('currentVideoTitle', data.vod_name || '未知视频');
            localStorage.setItem('currentEpisodes', JSON.stringify(data.episodes));
            // 换源后集名跟随新源（长度须与集数对齐，否则置空降级「第N集」）
            localStorage.setItem('currentEpisodeNames', JSON.stringify(
                (Array.isArray(data.episodeNames) && data.episodeNames.length === data.episodes.length)
                    ? data.episodeNames : []
            ));
            localStorage.setItem('currentEpisodeIndex', targetIndex);
            localStorage.setItem('currentSourceCode', sourceKey);
            localStorage.setItem('lastPlayTime', Date.now());
        } catch (e) {
            console.error('保存播放状态失败:', e);
        }

        // 跳转到播放页面
        window.location.href = watchUrl;
        
    } catch (error) {
        console.error('切换资源失败:', error);
        showToast('切换资源失败，请稍后重试', 'error');
    } finally {
        hideLoading();
    }
}