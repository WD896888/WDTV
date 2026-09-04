const selectedAPIs = JSON.parse(localStorage.getItem('selectedAPIs') || '[]');

// 改进返回功能
function goBack(event) {
    // 防止默认链接行为
    if (event) event.preventDefault();
    
    // 1. 优先检查URL参数中的returnUrl
    const urlParams = new URLSearchParams(window.location.search);
    const returnUrl = urlParams.get('returnUrl');
    
    if (returnUrl) {
        // 如果URL中有returnUrl参数，优先使用
        window.location.href = decodeURIComponent(returnUrl);
        return;
    }
    
    // 2. 检查localStorage中保存的lastPageUrl
    const lastPageUrl = localStorage.getItem('lastPageUrl');
    if (lastPageUrl && lastPageUrl !== window.location.href) {
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
    // 保存前一页面URL
    if (document.referrer && document.referrer !== window.location.href) {
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
let qualityMenuAdded = false; // 是否已添加清晰度切换菜单
let currentEpisodes = [];
let episodesReversed = false;
// 集数排序与时长检测状态（与首页详情弹窗同款，跨页面持久化保持一致体验）
let sortMode = 'default';          // 'default' 默认排序；'variety' 综艺排序
let varietyNumberMode = 'group';   // 'group' 新集数；'original' 原集数；'both' 双显
let varietyThresholdMinutes = 60;  // 综艺排序的时长分组线（分钟）
const episodeDurationCache = new Map(); // 集数地址 -> { status: 'detecting'|'done'|'fail', seconds }
let durationDetectRunning = false;
let autoplayEnabled = true; // 默认开启自动连播
let videoHasEnded = false; // 跟踪视频是否已经自然结束
let isUserSeeking = false; // 用户是否正在拖拽进度条（拖到结尾触发的 ended 不应自动连播）
let userClickedPosition = null; // 记录用户点击的位置
let shortcutHintTimeout = null; // 用于控制快捷键提示显示时间
let adFilteringEnabled = true; // 默认开启广告过滤
let currentVideoUrl = ''; // 记录当前实际的视频URL
let longPressBoostActive = false; // 长按临时倍速进行中（临时速度不写入全局记忆）
let suppressNextClick = false;    // 长按结束后拦截下一次 click，避免误触发暂停/播放
const isWebkit = (typeof window.webkitConvertPointFromPageToNode === 'function')
Artplayer.FULLSCREEN_WEB_IN_BODY = true;

// ===== 事件监听器防重复绑定（换集不销毁 video 时防止监听器无限累积） =====
// 已绑定"错误提示隐藏"监听的 video 元素集合
const errorListenerVideos = new WeakSet();
// 已绑定"双击全屏"监听的 video 元素集合
const dblclickVideos = new WeakSet();
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

    // 从localStorage获取数据
    currentVideoTitle = title || localStorage.getItem('currentVideoTitle') || '未知视频';
    currentEpisodeIndex = index;

    // 设置自动连播开关状态
    autoplayEnabled = localStorage.getItem('autoplayEnabled') !== 'false'; // 默认为true
    document.getElementById('autoplayToggle').checked = autoplayEnabled;

    // 获取广告过滤设置
    adFilteringEnabled = localStorage.getItem(PLAYER_CONFIG.adFilteringStorage) !== 'false'; // 默认为true

    // 监听自动连播开关变化
    document.getElementById('autoplayToggle').addEventListener('change', function (e) {
        autoplayEnabled = e.target.checked;
        localStorage.setItem('autoplayEnabled', autoplayEnabled);
    });

    // 优先使用URL传递的集数信息，否则从localStorage获取
    try {
        if (episodesList) {
            // 如果URL中有集数数据，优先使用它
            currentEpisodes = JSON.parse(decodeURIComponent(episodesList));

        } else {
            // 否则从localStorage获取
            currentEpisodes = JSON.parse(localStorage.getItem('currentEpisodes') || '[]');

        }

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
function updateResolutionBadgeFromVideo() {
    if (!art || !art.video) return;
    const w = art.video.videoWidth;
    const h = art.video.videoHeight;
    if (w && h) {
        updateResolutionBadge(formatResolutionText(w, h));
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

// 初始化播放器
async function initPlayer(videoUrl) {
    if (!videoUrl) {
        return
    }
    videoUrl = await resolvePlayableUrl(videoUrl);

    // 销毁旧实例
    if (art) {
        art.destroy();
        art = null;
    }
    // 换源/初始化时先回到 16:9 紧凑占位，元数据到达后再贴合真实比例
    applyVideoFitSize();
    resolutionBadgeEl = null;
    qualityMenuAdded = false;
    nextManifestPrefetched = false; // 重置下一集预取标志
    // 隐藏上一视频残留的分辨率文本，待新视频加载后重新显示
    const prevResolutionEl = document.getElementById('resolutionInfo');
    if (prevResolutionEl) prevResolutionEl.style.display = 'none';

    // 配置HLS.js选项
    const hlsConfig = {
        debug: false,
        loader: adFilteringEnabled ? CustomHlsJsLoader : Hls.DefaultConfig.loader,
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90,
        // 更平滑的抗抖动前向缓冲
        maxBufferLength: 45,
        maxMaxBufferLength: 90,
        maxBufferSize: 30 * 1000 * 1000,
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
        abrEwmaDefaultEstimate: 1500000,
        abrBandWidthFactor: 0.95,
        abrBandWidthUpFactor: 0.7,
        abrMaxWithRealBitrate: true,
        stretchShortVideoTrack: true,
        appendErrorMaxRetry: 5,  // 增加尝试次数
        liveSyncDurationCount: 3,
        liveDurationInfinity: false
    };

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
        pip: true,
        autoSize: false,
        autoMini: false,
        screenshot: true,
        setting: true,
        loop: false,
        flip: false,
        playbackRate: false, // 关闭内置播放速度设置，统一由自定义倍速面板管理
        aspectRatio: false,
        fullscreen: true,
        fullscreenWeb: true,
        subtitleOffset: false,
        miniProgressBar: true,
        mutex: true,
        backdrop: true,
        playsInline: true,
        autoPlayback: false,
        airplay: true,
        hotkey: false,
        theme: '#23ade5',
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
                    // 多档清晰度时添加切换菜单
                    setupQualityMenu(data && data.levels);
                    // 应用用户设置的码率上限（新 hls 实例需重新钳制）
                    applyBitrateCap(getBitrateCap());
                    // 通知清晰度快捷面板刷新（若用户在解析完成前已打开面板）
                    notifyQualityLevelsChanged();
                    video.play().catch(e => {
                    });
                });

                // 注意：不要用 LEVEL_SWITCHED 的 levels[].width/height 刷新徽章——
                // 那是 m3u8 里源方声明的 RESOLUTION，常与实际流不符（ABR 换档后尤其如此）。
                // 徽章统一以 video 元素实际解码分辨率为准（见 video resize 监听）。

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

    // 全屏 Web 模式处理
    art.on('fullscreenWeb', function (isFullScreen) {
        handleFullScreen(isFullScreen, true);
    });

    // 全屏模式处理
    art.on('fullscreen', function (isFullScreen) {
        handleFullScreen(isFullScreen, false);
    });

    art.on('video:loadedmetadata', function() {
        videoHasEnded = false; // 视频加载时重置结束标志

        // 恢复全局记忆的播放倍速（换剧/换集后保持用户上次选定的速度）
        if (speedConfig.playbackRate !== 1) {
            try {
                art.playbackRate = speedConfig.playbackRate;
            } catch (e) {
            }
        }

        // 容器尺寸贴合视频真实宽高比，消除多余黑边
        applyVideoFitSize();

        // 用视频元数据中的真实分辨率刷新徽章（单层m3u8时这是唯一可靠来源）
        ensureResolutionBadge();
        updateResolutionBadgeFromVideo();

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

    // 控制栏快捷功能：倍速 / 清晰度 / 码率
    setupRateControlButton();
    setupQualityControlButton();
    setupBitrateControlButton();
    addSpeedSettings();

    // 添加长按倍速播放功能（左右热区/倍速可在设置面板自定义，全局记忆）
    setupLongPressSpeedControl();

    // 跟踪用户拖拽状态：seeking 置位，正常播放心跳（timeupdate）复位
    art.on('video:seeking', function () { isUserSeeking = true; });
    art.on('video:timeupdate', function () {
        isUserSeeking = false;
        // 剩余时长不足 60 秒（或不足 10%）时预取下一集 m3u8 文本，实现无缝连播
        if (art && art.video && isFinite(art.video.duration) && art.video.duration > 0) {
            const remaining = art.video.duration - art.video.currentTime;
            if (remaining < 60 || remaining < art.video.duration * 0.1) {
                prefetchNextEpisodeManifest();
            }
        }
    });

    // 视频播放结束事件
    art.on('video:ended', function () {
        videoHasEnded = true;

        clearVideoProgress();

        // 如果自动播放下一集开启，且确实有下一集
        if (autoplayEnabled && currentEpisodeIndex < currentEpisodes.length - 1) {
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

    // 添加双击全屏支持（WeakSet 防重复绑定：换集不销毁 video 时不再累积）
    art.on('video:playing', () => {
        if (art.video && !dblclickVideos.has(art.video)) {
            dblclickVideos.add(art.video);
            art.video.addEventListener('dblclick', () => {
                art.fullscreen = !art.fullscreen;
                art.play();
            });
        }
    });
}

// ===== 下一集 m3u8 预取（自动连播无缝换集） =====
// 仅预取 manifest 文本（几十 KB），不预下分片，不占用当前集播放带宽；
// 换集时 CustomHlsJsLoader 命中缓存直接以缓存文本回调，省去一次上游往返。
const nextManifestCache = new Map(); // 播放地址 -> m3u8 文本
let nextManifestPrefetched = false;  // 当前集是否已触发过预取（换集时重置）

function prefetchNextEpisodeManifest() {
    if (nextManifestPrefetched || !autoplayEnabled) return;
    if (!currentEpisodes || currentEpisodeIndex >= currentEpisodes.length - 1) return;
    const nextUrl = currentEpisodes[currentEpisodeIndex + 1];
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

// 更新集数信息
function updateEpisodeInfo() {
    if (currentEpisodes.length > 0) {
        document.getElementById('episodeInfo').textContent = `第 ${currentEpisodeIndex + 1}/${currentEpisodes.length} 集`;
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

// 渲染单个集数按钮（groupNum 为综艺排序下的组内序号）
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

// 综艺排序渲染：时长 ≥ 分组线一组、< 分组线一组（组内保持原顺序，各组单独从 1 编号）
function renderVarietyEpisodes() {
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
        const btns = indices.map((realIndex, pos) =>
            renderEpisodeButton(realIndex, pos + 1, realIndex === currentEpisodeIndex)
        ).join('');
        return `
            <div class="wdtv-variety-section">
                <div class="wdtv-variety-label">${label}（${indices.length} 集）</div>
                <div class="wdtv-variety-grid">${btns}</div>
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
    videoHasEnded = false; // 重置视频结束标志
    nextManifestPrefetched = false; // 重置下一集预取标志，新集临近结尾时再预取其下一集

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

// 播放上一集
function playPreviousEpisode() {
    if (currentEpisodeIndex > 0) {
        playEpisode(currentEpisodeIndex - 1);
    }
}

// 播放下一集
function playNextEpisode() {
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
    updateSortControlStates();
    updateOrderButton();
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

    // 直接设置视频时间
    art.seek(clickTime);
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
    art.seek(clickTime);
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
// 历史记录瘦身后不再内嵌全量 episodes 数组（旧格式最多50条×全量集数达数百KB，每次保存全量序列化造成周期性卡顿），
// 改存集数总数 total；从历史播放时通过 vod_id+source 实时同步最新剧集列表（见 ui.js playFromHistory）
function saveToHistory() {
    // 确保 currentEpisodes 非空且有当前视频URL
    if (!currentEpisodes || currentEpisodes.length === 0 || !currentVideoUrl) {
        return;
    }

    // 尝试从URL中获取参数
    const urlParams = new URLSearchParams(window.location.search);
    const sourceName = urlParams.get('source') || '';
    const sourceCode = urlParams.get('source') || '';
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
    if (sourceName && id_from_params) {
        show_identifier_for_video_info = `${sourceName}_${id_from_params}`;
    } else {
        show_identifier_for_video_info = (currentEpisodes && currentEpisodes.length > 0) ? currentEpisodes[0] : currentVideoUrl;
    }

    // 构建要保存的视频信息对象（瘦身：以 total 代替全量 episodes）
    const videoInfo = {
        title: currentVideoTitle,
        directVideoUrl: currentVideoUrl, // Current episode's direct URL
        url: `player.html?url=${encodeURIComponent(currentVideoUrl)}&title=${encodeURIComponent(currentVideoTitle)}&source=${encodeURIComponent(sourceName)}&source_code=${encodeURIComponent(sourceCode)}&id=${encodeURIComponent(id_from_params || '')}&index=${currentEpisodeIndex}&position=${Math.floor(currentPosition || 0)}`,
        episodeIndex: currentEpisodeIndex,
        total: currentEpisodes.length, // 集数总数
        sourceName: sourceName,
        vod_id: id_from_params || '', // Store the ID from params as vod_id in history item
        sourceCode: sourceCode,
        showIdentifier: show_identifier_for_video_info, // Identifier for the show/series
        timestamp: Date.now(),
        playbackPosition: currentPosition,
        duration: videoDuration
    };

    try {
        const history = JSON.parse(localStorage.getItem('viewingHistory') || '[]');

        // 检查是否已经存在相同的系列记录 (基于标题、来源和 showIdentifier)
        const existingIndex = history.findIndex(item =>
            item.title === videoInfo.title &&
            item.sourceName === videoInfo.sourceName &&
            item.showIdentifier === videoInfo.showIdentifier
        );

        if (existingIndex !== -1) {
            // 存在则更新现有记录的当前集数、时间戳、播放进度和URL等
            const existingItem = history[existingIndex];
            existingItem.episodeIndex = videoInfo.episodeIndex;
            existingItem.timestamp = videoInfo.timestamp;
            existingItem.sourceName = videoInfo.sourceName; // Should be consistent, but update just in case
            existingItem.sourceCode = videoInfo.sourceCode;
            existingItem.vod_id = videoInfo.vod_id;

            // Update URLs to reflect the current episode being watched
            existingItem.directVideoUrl = videoInfo.directVideoUrl; // Current episode's direct URL
            existingItem.url = videoInfo.url; // Player link for the current episode
            existingItem.total = videoInfo.total;

            // 更新播放进度信息
            existingItem.playbackPosition = videoInfo.playbackPosition > 10 ? videoInfo.playbackPosition : (existingItem.playbackPosition || 0);
            existingItem.duration = videoInfo.duration || existingItem.duration;

            // 瘦身：清除旧格式内嵌的全量集数数组
            delete existingItem.episodes;
            delete existingItem.lastSyncTime;

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

// 格式化时间为 mm:ss 格式
function formatTime(seconds) {
    if (isNaN(seconds)) return '00:00';

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);

    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
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

// ===== 控制栏快捷面板系统（倍速 / 清晰度 / 码率共用） =====
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

// 清单解析完成（MANIFEST_PARSED）后通知清晰度面板刷新：
// 用户在解析完成前打开面板时不至于卡在"加载中"
const qualityLevelsChangedHandlers = new Set();
function notifyQualityLevelsChanged() {
    qualityLevelsChangedHandlers.forEach(fn => { try { fn(); } catch (e) { } });
}

// 面板与按钮水平居中对齐（须在面板可见后调用，需要测量宽度）
function alignQuickPanel(panel, btn, playerRoot) {
    // 小屏沿用 CSS 的左右贴边全宽布局
    if (window.matchMedia && window.matchMedia('(max-width: 480px)').matches) {
        panel.style.left = '8px';
        panel.style.right = '8px';
        return;
    }
    const rootRect = playerRoot.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const w = panel.offsetWidth || 100;
    let x = btnRect.left + btnRect.width / 2 - rootRect.left - w / 2;
    x = Math.max(8, Math.min(x, rootRect.width - w - 8));
    panel.style.right = 'auto';
    panel.style.left = x + 'px';
}

// 打开/关闭快捷面板；refresh 在每次打开前重建内容与选中态
function toggleQuickPanel(entry, show) {
    const { panel, btn, playerRoot, refresh } = entry;
    const willShow = typeof show === 'boolean' ? show : panel.classList.contains('hidden');
    if (willShow) {
        closeAllQuickPanels();
        if (refresh) refresh();
        panel.classList.remove('hidden');
        alignQuickPanel(panel, btn, playerRoot); // 先移除 hidden 才能测量宽度
    } else {
        panel.classList.add('hidden');
    }
}

// 点击面板/按钮以外区域时收起所有快捷面板（模块级只注册一次）
if (!window.__wdtvQuickPanelsOutside) {
    window.__wdtvQuickPanelsOutside = true;
    document.addEventListener('pointerdown', (e) => {
        quickPanels.forEach(({ panel, btn }) => {
            if (!panel.classList.contains('hidden') &&
                !panel.contains(e.target) && !btn.contains(e.target)) {
                panel.classList.add('hidden');
            }
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
    padding: '0 12px',
    fontSize: '13px',
    color: 'rgba(222,234,250,0.92)',
    cursor: 'pointer',
    userSelect: 'none'
};

// 控制栏倍速快捷按钮 + 多档倍速面板
function setupRateControlButton() {
    if (!art) return;
    const playerRoot = art.template.$player || document.querySelector('#player .art-video-player');
    if (!playerRoot) return;

    // 按钮文案随当前倍速变化：1x 显示“倍速”，其他显示如“2x”
    const updateButtonLabel = () => {
        const span = playerRoot.querySelector('.rate-btn-text');
        if (span) span.textContent = art.playbackRate && art.playbackRate !== 1 ? formatRate(art.playbackRate) : '倍速';
    };

    const rateButtonEl = art.controls.add({
        name: 'rateQuickButton',
        position: 'right',
        index: 5,
        html: '<span class="rate-btn-text">倍速</span>',
        tooltip: '倍速播放',
        style: QUICK_BTN_STYLE,
        click: () => toggleQuickPanel(rateEntry)
    });

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

// ===== 清晰度快捷按钮（多档位时列出 自动/各分辨率档位） =====
// 清晰度档位标签（与设置面板 setupQualityMenu 同款规则：高度优先，缺失用码率）
function qualityLevelLabel(l, idx) {
    if (l && l.height) return heightToLabel(l.height);
    if (l && l.bitrate) return `${Math.round(l.bitrate / 1000)}kbps`;
    return `档位${idx + 1}`;
}

function setupQualityControlButton() {
    if (!art) return;
    const playerRoot = art.template.$player || document.querySelector('#player .art-video-player');
    if (!playerRoot) return;

    // 按钮文案：手动选定档位后显示档位名，自动档显示“清晰度”
    const updateButtonLabel = () => {
        const span = playerRoot.querySelector('.quality-btn-text');
        if (!span) return;
        let text = '清晰度';
        try {
            if (currentHls && currentHls.levels && currentHls.levels.length >= 2 && currentHls.currentLevel >= 0) {
                text = qualityLevelLabel(currentHls.levels[currentHls.currentLevel], currentHls.currentLevel);
            }
        } catch (e) { /* 保持默认文案 */ }
        span.textContent = text;
    };

    const qualityButtonEl = art.controls.add({
        name: 'qualityQuickButton',
        position: 'right',
        index: 6,
        html: '<span class="quality-btn-text">清晰度</span>',
        tooltip: '分辨率/清晰度切换',
        style: QUICK_BTN_STYLE,
        click: () => toggleQuickPanel(qualityEntry)
    });

    const panel = document.createElement('div');
    panel.className = 'art-speed-panel hidden';
    playerRoot.appendChild(panel);

    panel.addEventListener('click', (e) => {
        const item = e.target.closest('.art-speed-item');
        if (!item || item.dataset.level === undefined || !currentHls) return;
        try { currentHls.currentLevel = parseInt(item.dataset.level, 10); } catch (err) { }
        updateButtonLabel();
        toggleQuickPanel(qualityEntry, false);
    });

    const qualityEntry = {
        key: 'quality', panel, btn: qualityButtonEl, playerRoot,
        refresh() {
            const levels = (currentHls && currentHls.levels) ? currentHls.levels : [];
            if (levels.length === 0) {
                // 清单尚未解析完：显示加载中，MANIFEST_PARSED 后自动刷新
                panel.innerHTML = '<div class="art-speed-item" style="cursor:default;opacity:.6;">清晰度加载中…</div>';
                return;
            }
            if (levels.length < 2) {
                panel.innerHTML = `<div class="art-speed-item" style="cursor:default;opacity:.6;">${qualityLevelLabel(levels[0], 0)}（源片仅此一档）</div>`;
                return;
            }
            const cur = currentHls.currentLevel;
            // 与设置面板同款排序：按声明高度降序，高度缺失时按码率降序
            const withIdx = levels.map((l, idx) => ({ l, idx }))
                .sort((a, b) => (b.l.height || 0) - (a.l.height || 0) || (b.l.bitrate || 0) - (a.l.bitrate || 0));
            panel.innerHTML =
                `<div class="art-speed-item${cur === -1 ? ' active' : ''}" data-level="-1">自动</div>` +
                withIdx.map(({ l, idx }) =>
                    `<div class="art-speed-item${idx === cur ? ' active' : ''}" data-level="${idx}">${qualityLevelLabel(l, idx)}</div>`
                ).join('');
        }
    };
    registerQuickPanel(qualityEntry);
    observeControlsHide(playerRoot);

    // 清单解析完成后若清晰度面板已打开则自动刷新（面板元素随播放器销毁时自动摘除）
    const refreshIfOpen = () => {
        if (!panel.isConnected) { qualityLevelsChangedHandlers.delete(refreshIfOpen); return; }
        if (!panel.classList.contains('hidden')) qualityEntry.refresh();
    };
    qualityLevelsChangedHandlers.add(refreshIfOpen);

    // 换集后 hls 实例重建，刷新按钮文案
    art.on('video:loadedmetadata', updateButtonLabel);
    updateButtonLabel();
}

// ===== 码率快捷按钮（限制 ABR 自动档位的最高码率：省流量/防卡顿） =====
const BITRATE_CAP_OPTIONS = [
    { label: '不限', value: Infinity },
    { label: '500k', value: 500000 },
    { label: '1M', value: 1000000 },
    { label: '2M', value: 2000000 },
    { label: '3M', value: 3000000 },
    { label: '5M', value: 5000000 },
    { label: '8M', value: 8000000 }
];
const BITRATE_CAP_KEY = 'wdtvBitrateCap';

function getBitrateCap() {
    try {
        const raw = localStorage.getItem(BITRATE_CAP_KEY);
        if (raw === null || raw === 'auto') return Infinity;
        const n = Number(raw);
        return isFinite(n) && n > 0 ? n : Infinity;
    } catch (e) { return Infinity; }
}

// 应用码率上限：钳制 ABR 可选的最高档位（手动选定清晰度时不受影响）
function applyBitrateCap(capBps) {
    if (!currentHls || !currentHls.levels || currentHls.levels.length === 0) return;
    if (!isFinite(capBps)) {
        currentHls.autoLevelCapping = -1; // 不限制
        return;
    }
    let capping = -1;
    for (let i = 0; i < currentHls.levels.length; i++) {
        if ((currentHls.levels[i].bitrate || 0) <= capBps) capping = i;
    }
    // 所有档位都高于上限时钳制到最低档
    currentHls.autoLevelCapping = capping >= 0 ? capping : 0;
}

function setupBitrateControlButton() {
    if (!art) return;
    const playerRoot = art.template.$player || document.querySelector('#player .art-video-player');
    if (!playerRoot) return;

    // 按钮文案：不限显示“码率”，限速显示如“≤2M”
    const updateButtonLabel = () => {
        const span = playerRoot.querySelector('.bitrate-btn-text');
        if (!span) return;
        const cap = getBitrateCap();
        span.textContent = isFinite(cap) ? '≤' + (cap >= 1000000 ? (cap / 1000000) + 'M' : Math.round(cap / 1000) + 'k') : '码率';
    };

    const bitrateButtonEl = art.controls.add({
        name: 'bitrateQuickButton',
        position: 'right',
        index: 7,
        html: '<span class="bitrate-btn-text">码率</span>',
        tooltip: '码率上限（自动画质时生效）',
        style: QUICK_BTN_STYLE,
        click: () => toggleQuickPanel(bitrateEntry)
    });

    const panel = document.createElement('div');
    panel.className = 'art-speed-panel hidden';
    playerRoot.appendChild(panel);

    panel.addEventListener('click', (e) => {
        const item = e.target.closest('.art-speed-item');
        if (!item || item.dataset.cap === undefined) return;
        const val = item.dataset.cap === 'auto' ? Infinity : Number(item.dataset.cap);
        try { localStorage.setItem(BITRATE_CAP_KEY, isFinite(val) ? String(val) : 'auto'); } catch (err) { }
        applyBitrateCap(val);
        // 自动档位下让 hls 立即按新上限重新选档
        try { if (currentHls && currentHls.currentLevel === -1) currentHls.nextLevel = -1; } catch (err) { }
        updateButtonLabel();
        toggleQuickPanel(bitrateEntry, false);
    });

    const bitrateEntry = {
        key: 'bitrate', panel, btn: bitrateButtonEl, playerRoot,
        refresh() {
            const cap = getBitrateCap();
            panel.innerHTML = BITRATE_CAP_OPTIONS.map(o => {
                const val = isFinite(o.value) ? String(o.value) : 'auto';
                const active = o.value === cap;
                return `<div class="art-speed-item${active ? ' active' : ''}" data-cap="${val}">${o.label}</div>`;
            }).join('');
        }
    };
    registerQuickPanel(bitrateEntry);
    observeControlsHide(playerRoot);

    art.on('video:loadedmetadata', updateButtonLabel);
    updateButtonLabel();
}

// 设置面板：长按倍速 / 长按区域（可自定义，全局记忆）
function addSpeedSettings() {
    if (!art) return;
    const settingApi = art.setting || art.settings; // 兼容不同版本 ArtPlayer 的设置API命名
    if (!settingApi || typeof settingApi.add !== 'function') return;
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

    // 移动端禁用长按弹出的系统右键菜单，避免干扰长按倍速手势
    playerRoot.oncontextmenu = () => {
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        if (isMobile) return false;
        return true; // 桌面设备允许右键菜单
    };

    // 命中过滤：控件区/设置面板/倍速面板等交互元素上的按压不触发长按
    const inInteractiveArea = (target) => !!(target && target.closest &&
        target.closest('.art-bottom, .art-setting-panel, .art-contextmenu, .art-loading, .art-layer, .art-speed-panel, .art-info'));

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
            showShortcutHint(formatRate(speedConfig.longPressRate), pressSide);
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
    // 使用视频标题和集数索引作为唯一标识
    // If currentVideoUrl is available and more unique, prefer it. Otherwise, fallback.
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

// 测试视频源速率的函数
async function testVideoSourceSpeed(sourceKey, vodId) {
    try {
        const startTime = performance.now();

        // 获取视频详情
        const data = await fetchVideoDetailData({ id: vodId, source: sourceKey });

        if (data.code !== 200 || !data.episodes || data.episodes.length === 0) {
            return { speed: -1, error: '无播放源' };
        }
        
        // 测试第一个播放链接的响应速度
        const firstEpisodeUrl = data.episodes[0];
        if (!firstEpisodeUrl) {
            return { speed: -1, error: '链接无效' };
        }
        
        // 测试视频链接响应时间
        const videoTestStart = performance.now();
        try {
            const videoResponse = await fetch(firstEpisodeUrl, {
                method: 'HEAD',
                mode: 'no-cors',
                cache: 'no-cache',
                signal: AbortSignal.timeout(5000) // 5秒超时
            });
            
            const videoTestEnd = performance.now();
            const totalTime = videoTestEnd - startTime;
            
            // 返回总响应时间（毫秒）
            return { 
                speed: Math.round(totalTime),
                episodes: data.episodes.length,
                error: null 
            };
        } catch (videoError) {
            // 如果视频链接测试失败，只返回API响应时间
            const apiTime = performance.now() - startTime;
            return { 
                speed: Math.round(apiTime),
                episodes: data.episodes.length,
                error: null,
                note: 'API响应' 
            };
        }
        
    } catch (error) {
        return { 
            speed: -1, 
            error: error.name === 'AbortError' ? '超时' : '测试失败' 
        };
    }
}

// 格式化速度显示
function formatSpeedDisplay(speedResult) {
    if (speedResult.speed === -1) {
        return `<span class="speed-indicator error">❌ ${speedResult.error}</span>`;
    }
    
    const speed = speedResult.speed;
    let className = 'speed-indicator good';
    let icon = '🟢';
    
    if (speed > 2000) {
        className = 'speed-indicator poor';
        icon = '🔴';
    } else if (speed > 1000) {
        className = 'speed-indicator medium';
        icon = '🟡';
    }
    
    const note = speedResult.note ? ` (${speedResult.note})` : '';
    return `<span class="${className}">${icon} ${speed}ms${note}</span>`;
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
        const watchUrl = `player.html?id=${vodId}&source=${sourceKey}&url=${encodeURIComponent(targetUrl)}&index=${targetIndex}&title=${encodeURIComponent(currentVideoTitle)}`;
        
        // 保存当前状态到localStorage
        try {
            localStorage.setItem('currentVideoTitle', data.vod_name || '未知视频');
            localStorage.setItem('currentEpisodes', JSON.stringify(data.episodes));
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