// UI相关函数
function toggleSettings(e) {
    // 阻止事件冒泡，防止触发document的点击事件
    e && e.stopPropagation();
    const panel = document.getElementById('settingsPanel');
    panel.classList.toggle('show');
}

// 改进的Toast显示函数 - 支持队列显示多个Toast
const toastQueue = [];
let isShowingToast = false;

function showToast(message, type = 'error') {
    // 首先确保toast元素存在
    let toast = document.getElementById('toast');
    let toastMessage = document.getElementById('toastMessage');

    // 如果toast元素不存在，创建它
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        // 初始隐藏状态：位于底部下方（与播放器恢复提示一致的出场方向）
        toast.style.position = 'fixed';
        toast.style.top = 'auto';
        toast.style.bottom = '20px';
        toast.style.left = '50%';
        toast.style.zIndex = '2147483647';
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(30px)';
        toastMessage = document.createElement('p');
        toastMessage.id = 'toastMessage';
        toast.appendChild(toastMessage);

        document.body.appendChild(toast);
    }

    // 将新的toast添加到队列
    toastQueue.push({ message, type });

    // 如果当前没有显示中的toast，则开始显示
    if (!isShowingToast) {
        showNextToast();
    }
}

function showNextToast() {
    if (toastQueue.length === 0) {
        isShowingToast = false;
        return;
    }

    isShowingToast = true;
    const { message } = toastQueue.shift();

    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toastMessage');

    // 播放器"已从 xx 继续播放"提示同款深色玻璃风格
    toast.style.position = 'fixed';
    toast.style.top = 'auto';
    toast.style.bottom = '20px';
    toast.style.left = '50%';
    toast.style.zIndex = '2147483647';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = '8px';
    toast.style.fontSize = '14px';
    toast.style.fontWeight = '400';
    toast.style.fontFamily = 'inherit';
    toast.style.color = 'rgba(236,244,255,0.96)';
    // 深色半透明基底，保证在浅色/深色页面上都与播放器提示观感一致
    toast.style.background = 'rgba(24, 30, 50, 0.6)';
    toast.style.backdropFilter = 'blur(32px) saturate(1.5)';
    toast.style.webkitBackdropFilter = 'blur(32px) saturate(1.5)';
    toast.style.border = '1px solid rgba(200,220,245,0.42)';
    toast.style.boxShadow = '0 12px 40px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1)';
    toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    toastMessage.textContent = message;

    // 从底部滑入显示
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateX(-50%) translateY(0)';
        });
    });

    // 3秒后自动隐藏
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(30px)';

        // 等待动画完成后显示下一个toast
        setTimeout(() => {
            showNextToast();
        }, 300);
    }, 3000);
}

// 添加显示/隐藏 loading 的函数
let loadingTimeoutId = null;
// loading 所有权令牌：每次 showLoading 递增，用于识别当前 loading 的归属方，
// 防止迟到的异步回调（如搜索的节流渲染器）误关其他流程（如详情弹窗）的 loading
let loadingOwnerSeq = 0;

function showLoading(message = '加载中...') {
    // 清除任何现有的超时
    if (loadingTimeoutId) {
        clearTimeout(loadingTimeoutId);
    }

    const loading = document.getElementById('loading');
    if (!loading) return; // 当前页面无遮罩元素（如部分弹窗场景）时静默跳过

    const messageEl = loading.querySelector('p');
    if (messageEl) messageEl.textContent = message;
    loadingOwnerSeq++;
    loading.classList.add('show');

    // 设置30秒后自动关闭loading，防止无限loading
    loadingTimeoutId = setTimeout(() => {
        hideLoading();
        showToast('操作超时，请稍后重试', 'warning');
    }, 30000);
}

function hideLoading() {
    // 清除超时
    if (loadingTimeoutId) {
        clearTimeout(loadingTimeoutId);
        loadingTimeoutId = null;
    }

    const loading = document.getElementById('loading');
    if (!loading) return;
    loading.classList.remove('show');
}

function updateSiteStatus(isAvailable) {
    const statusEl = document.getElementById('siteStatus');
    if (isAvailable) {
        statusEl.innerHTML = '<span class="text-green-500">●</span> 可用';
    } else {
        statusEl.innerHTML = '<span class="text-red-500">●</span> 不可用';
    }
}

function closeModal() {
    document.getElementById('modal').classList.add('hidden');
    // 清除 iframe 内容
    document.getElementById('modalContent').innerHTML = '';
}

// 获取搜索历史的增强版本 - 支持新旧格式
function getSearchHistory() {
    try {
        const data = localStorage.getItem(SEARCH_HISTORY_KEY);
        if (!data) return [];

        const parsed = JSON.parse(data);

        // 检查是否是数组
        if (!Array.isArray(parsed)) return [];

        // 支持旧格式（字符串数组）和新格式（对象数组）
        return parsed.map(item => {
            if (typeof item === 'string') {
                return { text: item, timestamp: 0 };
            }
            return item;
        }).filter(item => item && item.text);
    } catch (e) {
        console.error('获取搜索历史出错:', e);
        return [];
    }
}

// 保存搜索历史的增强版本 - 添加时间戳和最大数量限制，现在缓存2个月
function saveSearchHistory(query) {
    if (!query || !query.trim()) return;

    // 清理输入，防止XSS
    query = query.trim().substring(0, 50).replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let history = getSearchHistory();

    // 获取当前时间
    const now = Date.now();

    // 过滤掉超过2个月的记录（约60天，60*24*60*60*1000 = 5184000000毫秒）
    history = history.filter(item =>
        typeof item === 'object' && item.timestamp && (now - item.timestamp < 5184000000)
    );

    // 删除已存在的相同项
    history = history.filter(item =>
        typeof item === 'object' ? item.text !== query : item !== query
    );

    // 新项添加到开头，包含时间戳
    history.unshift({
        text: query,
        timestamp: now
    });

    // 限制历史记录数量
    if (history.length > MAX_HISTORY_ITEMS) {
        history = history.slice(0, MAX_HISTORY_ITEMS);
    }

    try {
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
        console.error('保存搜索历史失败:', e);
        // 如果存储失败（可能是localStorage已满），尝试清理旧数据
        try {
            localStorage.removeItem(SEARCH_HISTORY_KEY);
            localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history.slice(0, 3)));
        } catch (e2) {
            console.error('再次保存搜索历史失败:', e2);
        }
    }

    renderSearchHistory();
}

// 渲染最近搜索历史的增强版本
function renderSearchHistory() {
    const historyContainer = document.getElementById('recentSearches');
    if (!historyContainer) return;

    const history = getSearchHistory();

    if (history.length === 0) {
        historyContainer.innerHTML = '';
        return;
    }

    // 单行紧凑布局：可横向滚动的历史标签 + 行尾清空按钮
    historyContainer.innerHTML = '';

    history.forEach(item => {
        const tag = document.createElement('button');
        tag.className = 'search-tag flex items-center gap-1';
        const textSpan = document.createElement('span');
        textSpan.textContent = item.text;
        tag.appendChild(textSpan);

        // 添加删除按钮
        const deleteButton = document.createElement('span');
        deleteButton.className = 'pl-1 transition-colors';
        deleteButton.style.color = 'var(--text-muted)';
        deleteButton.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
        deleteButton.onclick = function(e) {
            // 阻止事件冒泡，避免触发搜索
            e.stopPropagation();
            // 删除对应历史记录
            deleteSingleSearchHistory(item.text);
            // 重新渲染搜索历史
            renderSearchHistory();
        };
        tag.appendChild(deleteButton);

        // 添加时间提示（如果有时间戳）
        if (item.timestamp) {
            const date = new Date(item.timestamp);
            tag.title = `搜索于: ${date.toLocaleString()}`;
        }

        tag.onclick = function() {
            document.getElementById('searchInput').value = item.text;
            search();
        };
        historyContainer.appendChild(tag);
    });

    // 行尾清空按钮（图标化，不占整行）
    const clearBtn = document.createElement('button');
    clearBtn.className = 'wdtv-recent-clear';
    clearBtn.setAttribute('aria-label', '清空搜索历史');
    clearBtn.title = '清空搜索历史';
    clearBtn.innerHTML = '<svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
    clearBtn.onclick = function(e) {
        e.stopPropagation();
        clearSearchHistory();
    };
    historyContainer.appendChild(clearBtn);
}

// 删除单条搜索历史记录
function deleteSingleSearchHistory(query) {
    // 当url中包含删除的关键词时，页面刷新后会自动加入历史记录，导致误认为删除功能有bug。此问题无需修复，功能无实际影响。
    try {
        let history = getSearchHistory();
        // 过滤掉要删除的记录
        history = history.filter(item => item.text !== query);
        console.log('更新后的搜索历史:', history);
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
        console.error('删除单条搜索历史失败:', e);
        showToast('删除单条搜索历史失败', 'error');
    }
}

// 增加清除搜索历史功能
function clearSearchHistory() {
    try {
        localStorage.removeItem(SEARCH_HISTORY_KEY);
        renderSearchHistory();
        showToast('搜索历史已清除', 'success');
    } catch (e) {
        console.error('清除搜索历史失败:', e);
        showToast('清除搜索历史失败:', 'error');
    }
}

// 历史面板相关函数
function toggleHistory(e) {
    if (e) e.stopPropagation();

    const panel = document.getElementById('historyPanel');
    if (panel) {
        panel.classList.toggle('show');

        // 如果打开了历史记录面板，则加载历史数据
        if (panel.classList.contains('show')) {
            loadViewingHistory();
        }

        // 如果设置面板是打开的，则关闭它
        const settingsPanel = document.getElementById('settingsPanel');
        if (settingsPanel && settingsPanel.classList.contains('show')) {
            settingsPanel.classList.remove('show');
        }
    }
}

// 格式化时间戳为友好的日期时间格式
function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    // 小于1小时，显示"X分钟前"
    if (diff < 3600000) {
        const minutes = Math.floor(diff / 60000);
        return minutes <= 0 ? '刚刚' : `${minutes}分钟前`;
    }

    // 小于24小时，显示"X小时前"
    if (diff < 86400000) {
        const hours = Math.floor(diff / 3600000);
        return `${hours}小时前`;
    }

    // 小于7天，显示"X天前"
    if (diff < 604800000) {
        const days = Math.floor(diff / 86400000);
        return `${days}天前`;
    }

    // 其他情况，显示完整日期
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hour = date.getHours().toString().padStart(2, '0');
    const minute = date.getMinutes().toString().padStart(2, '0');

    return `${year}-${month}-${day} ${hour}:${minute}`;
}

// 获取观看历史记录
function getViewingHistory() {
    try {
        const data = localStorage.getItem('viewingHistory');
        return data ? JSON.parse(data) : [];
    } catch (e) {
        console.error('获取观看历史失败:', e);
        return [];
    }
}

// 加载观看历史并渲染
function loadViewingHistory() {
    const historyList = document.getElementById('historyList');
    if (!historyList) return;

    const history = getViewingHistory();

    if (history.length === 0) {
        historyList.innerHTML = `<div class="text-center py-8" style="color: var(--text-muted);">暂无观看记录</div>`;
        return;
    }

    // 渲染历史记录
    historyList.innerHTML = history.map(item => {
        // 防止XSS
        const safeTitle = item.title
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        // 内联 onclick 的 JS 字符串转义：标题/URL 含单引号或反斜杠时会破坏内联 JS 导致点击无效
        const escJsArg = (s) => String(s == null ? '' : s)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '&quot;');
        const urlArg = escJsArg(item.url);
        const titleArg = escJsArg(safeTitle);

        // 源名称：历史记录中可能存的是源代码键（旧记录）或友好名称（新记录），统一映射为友好名称显示
        const rawSource = item.sourceName || '';
        const displaySource = (typeof API_SITES !== 'undefined' && rawSource && API_SITES[rawSource] && API_SITES[rawSource].name)
            ? API_SITES[rawSource].name
            : rawSource;
        const safeSource = displaySource ?
            displaySource.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') :
            '未知来源';

        const episodeText = item.episodeIndex !== undefined ?
            `第${item.episodeIndex + 1}集` : '';

        // 格式化剧集信息（新记录内嵌 episodes 数组；旧记录存集数总数 total，向后兼容）
        let episodeInfoHtml = '';
        const totalEpisodes = (item.episodes && Array.isArray(item.episodes) && item.episodes.length > 0)
            ? item.episodes.length
            : (item.total || 0);
        if (totalEpisodes > 0) {
            episodeInfoHtml = `<span style="color: var(--text-muted); font-size: 0.75rem;">共${totalEpisodes}集</span>`;
        }

        // 格式化进度信息
        let progressHtml = '';
        if (item.playbackPosition && item.duration && item.playbackPosition > 10 && item.playbackPosition < item.duration * 0.95) {
            const percent = Math.round((item.playbackPosition / item.duration) * 100);
            const formattedTime = formatPlaybackTime(item.playbackPosition);
            const formattedDuration = formatPlaybackTime(item.duration);

            progressHtml = `
                <div class="history-progress">
                    <div class="progress-bar">
                        <div class="progress-filled" style="width:${percent}%"></div>
                    </div>
                    <div class="progress-text">${formattedTime} / ${formattedDuration}</div>
                </div>
            `;
        }

        // 为防止XSS，使用encodeURIComponent编码URL
        const safeURL = encodeURIComponent(item.url);

        // 构建历史记录项HTML，使用设置面板卡片样式
        return `
            <div class="wdtv-history-card cursor-pointer relative group" onclick="playFromHistory('${urlArg}', '${titleArg}', ${item.episodeIndex || 0}, ${item.playbackPosition || 0})">
                <div class="wdtv-hc-header">
                    <div class="wdtv-hc-title">${safeTitle}</div>
                    <button onclick="event.stopPropagation(); deleteHistoryItem('${safeURL}')"
                            class="wdtv-hc-delete-btn"
                            title="删除记录">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
                <div class="wdtv-hc-row">
                    <div class="wdtv-hc-meta">
                        ${episodeText ? `<span class="wdtv-hc-episode">${episodeText}</span>` : ''}
                        ${episodeText ? '<span class="wdtv-hc-sep">·</span>' : ''}
                        <span class="wdtv-hc-source">${safeSource}</span>
                        ${episodeInfoHtml ? '<span class="wdtv-hc-sep">·</span>' : ''}
                        ${episodeInfoHtml}
                    </div>
                </div>
                ${progressHtml}
                <div class="wdtv-hc-time">${formatTimestamp(item.timestamp)}</div>
            </div>
        `;
    }).join('');

    // 检查是否存在较多历史记录，添加底部边距确保底部按钮不会挡住内容
    if (history.length > 5) {
        historyList.classList.add('pb-4');
    }
}

// 格式化播放时间为 mm:ss 格式
function formatPlaybackTime(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00';

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);

    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// 删除单个历史记录项
function deleteHistoryItem(encodedUrl) {
    try {
        // 解码URL
        const url = decodeURIComponent(encodedUrl);

        // 获取当前历史记录
        const history = getViewingHistory();

        // 过滤掉要删除的项
        const newHistory = history.filter(item => item.url !== url);

        // 保存回localStorage
        localStorage.setItem('viewingHistory', JSON.stringify(newHistory));

        // 重新加载历史记录显示
        loadViewingHistory();

        // 显示成功提示
        showToast('已删除该记录', 'success');
    } catch (e) {
        console.error('删除历史记录项失败:', e);
        showToast('删除记录失败', 'error');
    }
}

// 从历史记录播放：直接使用历史记录中保存的剧集列表，点击后立即跳转播放页
function playFromHistory(url, title, episodeIndex, playbackPosition = 0) {
    try {
        let episodesList = [];
        let historyItem = null;
        let singleEpisodeFallback = false;

        // 检查viewingHistory，查找匹配的项
        const historyRaw = localStorage.getItem('viewingHistory');
        if (historyRaw) {
            const history = JSON.parse(historyRaw);
            historyItem = history.find(item => item.url === url);
            if (historyItem && historyItem.episodes && Array.isArray(historyItem.episodes) && historyItem.episodes.length > 0) {
                episodesList = historyItem.episodes;
            }
        }

        // 历史记录无内嵌剧集列表时，退化为单集播放（直接播放该集地址），避免误用其他视频的集数数据
        if (episodesList.length === 0 && historyItem && historyItem.directVideoUrl) {
            episodesList = [historyItem.directVideoUrl];
            singleEpisodeFallback = true;
        }

        // 将剧集列表保存到localStorage，播放器页面会读取它
        if (episodesList.length > 0) {
            localStorage.setItem('currentEpisodes', JSON.stringify(episodesList));
            // 历史记录未存集名，必须清空，避免残留上一部视频的集名与集数错位显示
            localStorage.setItem('currentEpisodeNames', JSON.stringify([]));
        }

        // 保存当前页面URL作为返回地址
        let currentPath;
        if (window.location.pathname.startsWith('/player.html')) {
            currentPath = localStorage.getItem('lastPageUrl') || '/';
        } else {
            currentPath = window.location.origin + window.location.pathname + window.location.search;
        }
        localStorage.setItem('lastPageUrl', currentPath);

        // 构造播放器URL
        let playerUrl;
        // source 参数必须传源代码键（如 heimuer），播放页据此查询 API_SITES；友好名称在显示时再映射
        const sourceCodeForUrl = historyItem ?
            (historyItem.sourceCode || historyItem.sourceName || '') :
            (new URLSearchParams(new URL(url, window.location.origin).search)).get('source');
        const idForUrl = historyItem ? historyItem.vod_id : '';
        const indexForUrl = singleEpisodeFallback ? 0 : (episodeIndex || 0);

        if (url.includes('player.html')) {
            // 检测到嵌套播放链接，解析真实URL
            try {
                const nestedUrl = new URL(url, window.location.origin);
                const nestedParams = nestedUrl.searchParams;
                const realVideoUrl = nestedParams.get('url') || url;

                playerUrl = `player.html?url=${encodeURIComponent(realVideoUrl)}&title=${encodeURIComponent(title)}&index=${indexForUrl}&position=${Math.floor(playbackPosition || 0)}&returnUrl=${encodeURIComponent(currentPath)}`;
                if (sourceCodeForUrl) playerUrl += `&source=${encodeURIComponent(sourceCodeForUrl)}`;
                if (idForUrl) playerUrl += `&id=${encodeURIComponent(idForUrl)}`;
            } catch (e) {
                playerUrl = `player.html?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}&index=${indexForUrl}&position=${Math.floor(playbackPosition || 0)}&returnUrl=${encodeURIComponent(currentPath)}`;
                if (sourceCodeForUrl) playerUrl += `&source=${encodeURIComponent(sourceCodeForUrl)}`;
                if (idForUrl) playerUrl += `&id=${encodeURIComponent(idForUrl)}`;
            }
        } else {
            const playUrl = new URL(url, window.location.origin);
            if (!playUrl.searchParams.has('index') && indexForUrl > 0) {
                playUrl.searchParams.set('index', indexForUrl);
            }
            playUrl.searchParams.set('position', Math.floor(playbackPosition || 0).toString());
            playUrl.searchParams.set('returnUrl', encodeURIComponent(currentPath));
            if (sourceCodeForUrl) playUrl.searchParams.set('source', sourceCodeForUrl);
            if (idForUrl) playUrl.searchParams.set('id', idForUrl);
            playerUrl = playUrl.toString();
        }

        // 直接整页跳转到播放页（与首页点击视频的 playVideo 机制一致）
        // 不用 showVideoPlayer 的 iframe 方式：首页历史面板 z-index 高于 iframe 会遮挡，
        // 且重复点击会堆叠多个播放器实例导致页面卡死
        window.location.href = playerUrl;
    } catch (e) {
        const simpleUrl = `player.html?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}&index=${episodeIndex}`;
        window.location.href = simpleUrl;
    }
}

// 添加观看历史 - 确保每个视频标题只有一条记录
// IMPORTANT: videoInfo passed to this function should include a 'showIdentifier' property
// (ideally `${sourceName}_${vod_id}`), 'sourceName', and 'vod_id'.
function addToViewingHistory(videoInfo) {
    try {
        const history = getViewingHistory();

        // Ensure videoInfo has a showIdentifier
        if (!videoInfo.showIdentifier) {
            if (videoInfo.sourceName && videoInfo.vod_id) {
                videoInfo.showIdentifier = `${videoInfo.sourceName}_${videoInfo.vod_id}`;
            } else {
                // Fallback if critical IDs are missing for the preferred identifier
                videoInfo.showIdentifier = (videoInfo.episodes && videoInfo.episodes.length > 0) ? videoInfo.episodes[0] : videoInfo.directVideoUrl;
                // console.warn(`addToViewingHistory: videoInfo for "${videoInfo.title}" was missing sourceName or vod_id for preferred showIdentifier. Generated fallback: ${videoInfo.showIdentifier}`);
            }
        }

        const existingIndex = history.findIndex(item =>
            item.title === videoInfo.title &&
            item.sourceName === videoInfo.sourceName &&
            item.showIdentifier === videoInfo.showIdentifier // Strict check using the determined showIdentifier
        );

        if (existingIndex !== -1) {
            // Exact match with showIdentifier: Update existing series entry
            const existingItem = history[existingIndex];
            existingItem.episodeIndex = videoInfo.episodeIndex;
            existingItem.timestamp = Date.now();
            existingItem.sourceName = videoInfo.sourceName || existingItem.sourceName;
            existingItem.sourceCode = videoInfo.sourceCode || existingItem.sourceCode;
            existingItem.vod_id = videoInfo.vod_id || existingItem.vod_id;
            existingItem.directVideoUrl = videoInfo.directVideoUrl || existingItem.directVideoUrl;
            existingItem.url = videoInfo.url || existingItem.url;
            existingItem.playbackPosition = videoInfo.playbackPosition > 10 ? videoInfo.playbackPosition : (existingItem.playbackPosition || 0);
            existingItem.duration = videoInfo.duration || existingItem.duration;

            if (videoInfo.episodes && Array.isArray(videoInfo.episodes) && videoInfo.episodes.length > 0) {
                if (!existingItem.episodes ||
                    !Array.isArray(existingItem.episodes) ||
                    existingItem.episodes.length !== videoInfo.episodes.length ||
                    !videoInfo.episodes.every((ep, i) => ep === existingItem.episodes[i])) {
                    existingItem.episodes = [...videoInfo.episodes];
                    // console.log(`更新 (addToViewingHistory) "${videoInfo.title}" 的剧集数据: ${videoInfo.episodes.length}集`);
                }
            }

            history.splice(existingIndex, 1);
            history.unshift(existingItem);
            // console.log(`更新历史记录 (addToViewingHistory): "${videoInfo.title}", 第 ${videoInfo.episodeIndex !== undefined ? videoInfo.episodeIndex + 1 : 'N/A'} 集`);
        } else {
            // No exact match: Add as a new entry
            const newItem = {
                ...videoInfo, // Includes the showIdentifier we ensured is present
                timestamp: Date.now()
            };

            if (videoInfo.episodes && Array.isArray(videoInfo.episodes)) {
                newItem.episodes = [...videoInfo.episodes];
            } else {
                newItem.episodes = [];
            }

            history.unshift(newItem);
            // console.log(`创建新的历史记录 (addToViewingHistory): "${videoInfo.title}", Episode: ${videoInfo.episodeIndex !== undefined ? videoInfo.episodeIndex + 1 : 'N/A'}`);
        }

        // 限制历史记录数量为50条
        const maxHistoryItems = 50;
        if (history.length > maxHistoryItems) {
            history.splice(maxHistoryItems);
        }

        // 保存到本地存储
        localStorage.setItem('viewingHistory', JSON.stringify(history));
    } catch (e) {
        // console.error('保存观看历史失败:', e);
    }
}

// 清空观看历史
function clearViewingHistory() {
    try {
        localStorage.removeItem('viewingHistory');
        loadViewingHistory(); // 重新加载空的历史记录
        showToast('观看历史已清空', 'success');
    } catch (e) {
        // console.error('清除观看历史失败:', e);
        showToast('清除观看历史失败', 'error');
    }
}

// 更新toggleSettings函数以处理历史面板互动
const originalToggleSettings = toggleSettings;
toggleSettings = function(e) {
    if (e) e.stopPropagation();

    // 原始设置面板切换逻辑
    originalToggleSettings(e);

    // 如果历史记录面板是打开的，则关闭它
    const historyPanel = document.getElementById('historyPanel');
    if (historyPanel && historyPanel.classList.contains('show')) {
        historyPanel.classList.remove('show');
    }
};

// 点击外部关闭历史面板
document.addEventListener('DOMContentLoaded', function() {
    document.addEventListener('click', function(e) {
        const historyPanel = document.getElementById('historyPanel');
        const historyButton = document.querySelector('button[onclick="toggleHistory(event)"]');

        if (historyPanel && historyButton &&
            !historyPanel.contains(e.target) &&
            !historyButton.contains(e.target) &&
            historyPanel.classList.contains('show')) {
            historyPanel.classList.remove('show');
        }
    });
});

// 清除本地存储缓存并刷新页面
function clearLocalStorage() {
    // 确保模态框在页面上只有一个实例
    let modal = document.getElementById('messageBoxModal');
    if (modal) {
        document.body.removeChild(modal);
    }

    // 创建模态框元素
    modal = document.createElement('div');
    modal.id = 'messageBoxModal';
    modal.className = 'fixed inset-0 flex items-center justify-center z-40';
    modal.style.background = 'rgba(255, 255, 255, 0.5)';
    modal.style.backdropFilter = 'blur(20px) saturate(180%)';
    modal.style.webkitBackdropFilter = 'blur(20px) saturate(180%)';

    modal.innerHTML = `
        <div class="max-w-md w-full max-h-[90vh] overflow-y-auto relative" style="background: rgba(255,255,255,0.85); backdrop-filter: blur(50px) saturate(200%); -webkit-backdrop-filter: blur(50px) saturate(200%); border: 1px solid rgba(255,255,255,0.8); border-radius: 24px; padding: 1.5rem; box-shadow: 0 24px 80px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.95);">
            <button id="closeBoxModal" style="position: absolute; top: 1rem; right: 1rem; width: 2rem; height: 2rem; border-radius: 9999px; background: rgba(255,255,255,0.6); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.8); color: #6e6e73; font-size: 1.25rem;">&times;</button>

            <h3 style="font-size: 1.25rem; font-weight: 700; color: #ff453a; margin-bottom: 1rem;">警告</h3>

            <div>
                <div style="font-size: 0.875rem; font-weight: 500; color: #1d1d1f;">确定要清除页面缓存吗？</div>
                <div style="font-size: 0.875rem; font-weight: 500; color: #1d1d1f; margin-bottom: 1rem;">此功能会删除你的观看记录、自定义 API 接口和 Cookie，<span style="color: #ff453a; font-weight: 700;">此操作不可恢复！</span><span style="color: #1d1d1f;">（"我的影院"收藏会保留）</span></div>
                <div class="flex justify-end space-x-2">
                    <button id="confirmBoxModal" class="ios-primary-button" style="padding: 0.3rem 1rem; font-size: 0.875rem;">确定</button>
                    <button id="cancelBoxModal" class="ios-secondary-button" style="padding: 0.3rem 1rem; font-size: 0.875rem;">取消</button>
                </div>
            </div>
        </div>`;

    // 添加模态框到页面
    document.body.appendChild(modal);

    // 添加事件监听器 - 关闭按钮
    document.getElementById('closeBoxModal').addEventListener('click', function () {
        document.body.removeChild(modal);
    });

    // 添加事件监听器 - 确定按钮
    document.getElementById('confirmBoxModal').addEventListener('click', function () {
        // "我的影院"收藏为本地永久数据，清除缓存时保留（IndexedDB 另有镜像可自愈）
        let cinemaBackup = null;
        try { cinemaBackup = localStorage.getItem('myCinemaFavorites'); } catch (e) { }

        // 清除所有localStorage数据
        localStorage.clear();

        // 恢复我的影院收藏
        if (cinemaBackup) {
            try { localStorage.setItem('myCinemaFavorites', cinemaBackup); } catch (e) { }
        }

        // 清除所有cookie
        const cookies = document.cookie.split(";");
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i];
            const eqPos = cookie.indexOf("=");
            const name = eqPos > -1 ? cookie.substr(0, eqPos).trim() : cookie.trim();
            document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
        }

        modal.innerHTML = `
            <div class="max-w-md w-full max-h-[90vh] overflow-y-auto relative" style="background: rgba(255,255,255,0.85); backdrop-filter: blur(50px) saturate(200%); -webkit-backdrop-filter: blur(50px) saturate(200%); border: 1px solid rgba(255,255,255,0.8); border-radius: 24px; padding: 1.5rem; box-shadow: 0 24px 80px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.95);">
                <button id="closeBoxModal" style="position: absolute; top: 1rem; right: 1rem; width: 2rem; height: 2rem; border-radius: 9999px; background: rgba(255,255,255,0.6); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.8); color: #6e6e73; font-size: 1.25rem;">&times;</button>

                <h3 style="font-size: 1.25rem; font-weight: 700; color: #1d1d1f; margin-bottom: 1rem;">提示</h3>

                <div style="margin-bottom: 1rem;">
                    <div style="font-size: 0.875rem; font-weight: 500; color: #1d1d1f; margin-bottom: 1rem;">页面缓存和Cookie已清除，<span id="countdown">3</span> 秒后自动刷新本页面。</div>
                </div>
            </div>`;

        let countdown = 3;
        const countdownElement = document.getElementById('countdown');

        const countdownInterval = setInterval(() => {
            countdown--;
            if (countdown >= 0) {
                countdownElement.textContent = countdown;
            } else {
                clearInterval(countdownInterval);
                window.location.reload();
            }
        }, 1000);
    });

    // 添加事件监听器 - 取消按钮
    document.getElementById('cancelBoxModal').addEventListener('click', function () {
        document.body.removeChild(modal);
    });

    // 添加事件监听器 - 点击模态框外部关闭
    modal.addEventListener('click', function (e) {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    });
}
