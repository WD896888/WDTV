// UI相关函数
function toggleSettings(e) {
    // 阻止事件冒泡，防止触发document的点击事件
    e && e.stopPropagation();
    const panel = document.getElementById('settingsPanel');
    panel.classList.toggle('show');

    // 打开设置面板时若历史面板仍开着，则一并关闭（两个面板不叠显）
    const historyPanel = document.getElementById('historyPanel');
    if (historyPanel && historyPanel.classList.contains('show')) {
        historyPanel.classList.remove('show');
    }
}

// 改进的Toast显示函数 - 支持队列显示多个Toast
const toastQueue = [];
let isShowingToast = false;
// 当前 toast 上挂载的撤销按钮引用（换条时清理，避免普通 toast 残留按钮）
let currentToastActionBtn = null;

function _removeToastAction() {
    const btn = currentToastActionBtn;
    currentToastActionBtn = null;
    if (btn && btn.parentNode && typeof btn.parentNode.removeChild === 'function') {
        try { btn.parentNode.removeChild(btn); } catch (e) { /* 元素可能已被移除 */ }
    }
}

function showToast(message, type = 'error', options) {
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

    // 将新的toast添加到队列（options 可选：{ actionLabel, onAction, duration }）
    toastQueue.push({ message, type, options });

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
    const item = toastQueue.shift();
    const { message } = item;
    const options = item.options || null;

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

    // 换条前清理上一条可能残留的撤销按钮（保证普通 toast 不出现按钮）
    _removeToastAction();

    // 是否带可点击的撤销动作：有 actionLabel 即渲染按钮
    const hasAction = !!(options && typeof options.actionLabel === 'string' && options.actionLabel.length);
    // 展示时长：显式 duration > 有 action 默认 6s > 普通 3s（无 options 时恒为 3s，行为不变）
    let duration = 3000;
    if (options && typeof options.duration === 'number' && isFinite(options.duration) && options.duration > 0) {
        duration = options.duration;
    } else if (hasAction) {
        duration = 6000;
    }

    // 从底部滑入显示
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateX(-50%) translateY(0)';
        });
    });

    // 隐藏并推进到下一条（正常超时 / 点击撤销共用，advanced 防重入）
    let advanced = false;
    function hideAndAdvance() {
        if (advanced) return;
        advanced = true;
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(30px)';
        _removeToastAction();
        // 等待动画完成后显示下一个toast
        setTimeout(() => {
            showNextToast();
        }, 300);
    }

    // 撤销按钮：仅在带 actionLabel 时用 DOM API 追加到 #toast，不改动 #toastMessage 的文本更新逻辑
    if (hasAction) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wdtv-toast-action';
        btn.textContent = String(options.actionLabel);
        // 内联样式沿用 toast 深色玻璃观感：淡边框、无白色描边、无重投影
        btn.style.marginLeft = '14px';
        btn.style.padding = '4px 12px';
        btn.style.borderRadius = '8px';
        btn.style.background = 'rgba(255,255,255,0.08)';
        btn.style.border = '1px solid rgba(200,220,245,0.35)';
        btn.style.color = 'rgba(236,244,255,0.96)';
        btn.style.fontFamily = 'inherit';
        btn.style.fontSize = '13px';
        btn.style.cursor = 'pointer';
        btn.style.boxShadow = 'none';
        btn.style.outline = 'none';
        btn.addEventListener('click', function () {
            // 先执行撤销回调，再立即关闭当前 toast
            if (typeof options.onAction === 'function') {
                try { options.onAction(); } catch (e) { /* 撤销回调异常不阻断关闭 */ }
            }
            hideAndAdvance();
        });
        toast.appendChild(btn);
        currentToastActionBtn = btn;
    }

    // 自动隐藏（普通 3s / 有 action 默认 6s / 显式 duration）
    setTimeout(hideAndAdvance, duration);
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

    // 状态组件接入：WDTVStates 可用时用 loading() 渲染到 #loading 的内容区，
    // 模块未加载则回退原有的 <p> 文本更新（对外行为完全不变）。
    const S = _getStates();
    if (S) {
        S.mount(_loadingHost(loading), S.loading(message));
    } else {
        const messageEl = loading.querySelector('p');
        if (messageEl) messageEl.textContent = message;
    }
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

    // 模块可用时清空状态组件渲染的内容（与 showLoading 使用同一 host）
    const S = _getStates();
    if (S) S.clear(_loadingHost(loading));
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
    // 关闭前归还焦点：若该弹层曾通过 openPanelWithTrap 激活过焦点陷阱
    if (typeof closePanelWithTrap === 'function') closePanelWithTrap('modal');

    const modal = document.getElementById('modal');
    const modalContent = document.getElementById('modalContent');
    if (modal) modal.classList.add('hidden');
    // 清除 iframe 内容
    if (modalContent) {
        const S = _getStates();
        if (S) S.clear(modalContent);
        else modalContent.innerHTML = '';
    }
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

// 归一化标题：去首尾空白、折叠内部空白、转小写，作为无稳定 ID 时的归并键
function _normTitle(title) {
    return String(title == null ? '' : title).trim().toLowerCase().replace(/\s+/g, ' ');
}

// 弱标识：无 showIdentifier，或缺参时的 title: 回退值（本质没有稳定剧级 ID，等同旧记录）。
// 只有弱标识记录才允许按 title 归并；稳定标识（sourceCode_vodId）必须按 sid 精确匹配，
// 否则不同采集站的同名剧会被误合并、sourceCode 被后写入者覆盖。
function _isWeakShow(item) {
    return !item || !item.showIdentifier || String(item.showIdentifier).indexOf('title:') === 0;
}

// 获取观看历史记录（唯一读取入口，做旧记录兼容）
// 1) 解析失败 / 脏数据不抛错、不白屏；2) 缺字段条目做兜底，绝不丢弃；
// 3) 稳定标识（sourceCode_vodId）按 sid 精确去重，不同源同名剧各自保留（不误合并）；
// 4) 弱标识旧记录（无 sid / title: 回退）才按归一化 title 归并，且同 title 已有稳定记录时丢弃
function getViewingHistory() {
    let raw;
    try {
        raw = JSON.parse(localStorage.getItem('viewingHistory') || '[]');
    } catch (e) {
        return [];
    }
    if (!Array.isArray(raw)) return [];

    const safe = [];
    for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        if (!item || typeof item !== 'object') continue;
        // 字段兜底：旧记录可能缺 showIdentifier / sourceCode / url，补齐以防渲染抛错
        safe.push({
            ...item,
            title: typeof item.title === 'string' ? item.title : String(item.title == null ? '' : item.title),
            url: typeof item.url === 'string' ? item.url : String(item.url == null ? '' : item.url),
            timestamp: item.timestamp || 0
        });
    }

    const stableById = new Map();
    const stableTitleKeys = new Set();
    const legacyByTitle = new Map();
    const merged = [];

    // 第一遍：稳定标识记录按 sid 去重（不同源同名剧各自保留）
    safe.forEach(item => {
        if (_isWeakShow(item)) return;
        stableTitleKeys.add(_normTitle(item.title));
        const pos = stableById.get(item.showIdentifier);
        if (pos == null) {
            stableById.set(item.showIdentifier, merged.length);
            merged.push(item);
        } else if ((item.timestamp || 0) > (merged[pos].timestamp || 0)) {
            merged[pos] = item;
        }
    });

    // 第二遍：弱标识旧记录按 title 归并；同 title 已有稳定记录则丢弃（由稳定记录代表）
    safe.forEach(item => {
        if (!_isWeakShow(item)) return;
        const tk = _normTitle(item.title);
        if (stableTitleKeys.has(tk)) return;
        const pos = legacyByTitle.get(tk);
        if (pos == null) {
            legacyByTitle.set(tk, merged.length);
            merged.push(item);
        } else if ((item.timestamp || 0) > (merged[pos].timestamp || 0)) {
            merged[pos] = item;
        }
    });

    merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return merged;
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

        // 收敛后 viewingHistory 只有唯一写入路径；删除直接读原始存储按 url 过滤，
        // 不经过读取侧的 title 归并视图，避免归并后 url 对不上而删不掉
        // 撤销快照：删除前的完整原始存储（localStorage 返回 JSON 字符串，天然深拷贝）
        const snapshot = localStorage.getItem('viewingHistory');
        const raw = JSON.parse(snapshot || '[]');
        const newHistory = (Array.isArray(raw) ? raw : []).filter(item => item && item.url !== url);

        // 保存回localStorage
        localStorage.setItem('viewingHistory', JSON.stringify(newHistory));

        // 重新加载历史记录显示
        loadViewingHistory();

        // 带「撤销」动作：把删除前的完整快照写回并重绘
        const toast = (typeof window !== 'undefined' && typeof window.showToast === 'function')
            ? window.showToast : showToast;
        toast('已删除该记录', 'success', {
            actionLabel: '撤销',
            onAction: function () {
                if (snapshot === null || snapshot === undefined) localStorage.removeItem('viewingHistory');
                else localStorage.setItem('viewingHistory', snapshot);
                loadViewingHistory();
            }
        });
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

// 统一生成剧级标识：优先 sourceCode / source_code，绝不把中文 sourceName 或播放 URL 当 ID。
// 缺参时回退到 title 归一化值（稳定、跨换源不变），而不是 episodes[0] / directVideoUrl。
function _makeShowIdentifier(info) {
    const sourceCode = String(info.sourceCode || info.source_code || '');
    const vodId = String(info.vod_id != null ? info.vod_id : (info.vodId != null ? info.vodId : ''));
    if (sourceCode && vodId) return sourceCode + '_' + vodId;
    const t = _normTitle(info.title);
    return t ? 'title:' + t : '';
}

// viewingHistory 唯一写入入口（收敛 player.js 与 ui.js 两条独立写入路径）
// videoInfo: { title, sourceCode|source_code, vod_id|vodId, sourceName(展示), url, directVideoUrl,
//              episodeIndex, episodes, playbackPosition, duration, timestamp, ... }
// 去重优先级：① 稳定 showIdentifier 相等 ② 归一化 title + sourceCode 相等
//             ③ 仅「弱标识」旧记录（无 sid / title: 回退）按归一化 title 归并
// 稳定标识的新记录只走 ①/② 精确匹配，不同采集站的同名剧各自保留、sourceCode 不被覆盖
// 旧记录不丢弃，命中后升级为统一标识并合并字段；保留上限 50 条
// 返回写入后的记录数组
function upsertViewingHistory(videoInfo) {
    if (!videoInfo || typeof videoInfo !== 'object') return getViewingHistory();
    const title = typeof videoInfo.title === 'string' ? videoInfo.title : String(videoInfo.title == null ? '' : videoInfo.title);
    if (!title.trim()) return getViewingHistory(); // 无标题：明确跳过写入，不用 URL 当 ID

    let history;
    try {
        history = JSON.parse(localStorage.getItem('viewingHistory') || '[]');
    } catch (e) {
        history = [];
    }
    if (!Array.isArray(history)) history = [];
    history = history.filter(item => item && typeof item === 'object');

    const sid = _makeShowIdentifier(videoInfo);
    const titleKey = _normTitle(title);
    const sourceCode = String(videoInfo.sourceCode || videoInfo.source_code || '');

    // 找"同一剧"：优先级 稳定 sid > title+sourceCode > 弱标识旧记录按 title 归并
    let matchIdx = -1;
    if (sid) {
        matchIdx = history.findIndex(item => item.showIdentifier && item.showIdentifier === sid);
    }
    if (matchIdx === -1 && sourceCode) {
        matchIdx = history.findIndex(item =>
            _normTitle(item.title) === titleKey && String(item.sourceCode || '') === sourceCode);
    }
    if (matchIdx === -1) {
        // 第 3 级只用于兼容「弱标识」旧记录：稳定标识的新记录必须靠 sid 精确匹配，
        // 否则不同采集站的同名剧会被误合并成一条、sourceCode 被后写入者覆盖。
        matchIdx = history.findIndex(item =>
            _isWeakShow(item) && _normTitle(item.title) === titleKey);
    }

    const now = Date.now();
    let entry;
    if (matchIdx !== -1) {
        entry = history[matchIdx];
    } else {
        entry = {};
        history.unshift(entry);
        matchIdx = 0;
    }

    // 合并字段：沿用原有字段结构，缺失值不覆盖已有值
    entry.title = title;
    if (sid) {
        // 稳定 ID（sourceCode_vodId）优先升级旧记录；title 回退值不覆盖已有的稳定 ID
        var sidIsFallback = sid.indexOf('title:') === 0;
        if (!sidIsFallback || !entry.showIdentifier) entry.showIdentifier = sid;
    }
    if (videoInfo.sourceName != null) entry.sourceName = videoInfo.sourceName;
    if (sourceCode) entry.sourceCode = sourceCode;
    const vodId = videoInfo.vod_id != null ? videoInfo.vod_id : videoInfo.vodId;
    if (vodId != null && String(vodId) !== '') entry.vod_id = vodId;
    if (videoInfo.url != null) entry.url = videoInfo.url;
    if (videoInfo.directVideoUrl != null) entry.directVideoUrl = videoInfo.directVideoUrl;
    if (videoInfo.episodeIndex !== undefined) entry.episodeIndex = videoInfo.episodeIndex;
    if (videoInfo.episodes && Array.isArray(videoInfo.episodes)) entry.episodes = videoInfo.episodes.slice();
    else if (!Array.isArray(entry.episodes)) entry.episodes = [];
    if (videoInfo.total != null) entry.total = videoInfo.total;
    if (videoInfo.playbackPosition > 10) entry.playbackPosition = videoInfo.playbackPosition;
    else if (entry.playbackPosition == null) entry.playbackPosition = 0;
    if (videoInfo.duration) entry.duration = videoInfo.duration;
    entry.timestamp = videoInfo.timestamp || now;

    // 命中项移到最前
    if (matchIdx !== 0) {
        history.splice(matchIdx, 1);
        history.unshift(entry);
    }

    // 二次去重：稳定标识按 sid 精确去重（不同源同名剧各自保留）；
    // 弱标识旧记录按归一化 title 归并，且同 title 已有稳定记录时丢弃（由稳定记录代表，避免重复）
    const stableById = new Map();
    const stableTitleKeys = new Set();
    const legacyByTitle = new Map();
    const deduped = [];

    // 第一遍：稳定标识记录按 sid 去重
    history.forEach(item => {
        if (_isWeakShow(item)) return;
        stableTitleKeys.add(_normTitle(item.title));
        const pos = stableById.get(item.showIdentifier);
        if (pos == null) {
            stableById.set(item.showIdentifier, deduped.length);
            deduped.push(item);
        } else if ((item.timestamp || 0) > (deduped[pos].timestamp || 0)) {
            deduped[pos] = item;
        }
    });

    // 第二遍：弱标识旧记录按 title 归并；同 title 已有稳定记录则丢弃
    history.forEach(item => {
        if (!_isWeakShow(item)) return;
        const tk = _normTitle(item.title);
        if (stableTitleKeys.has(tk)) return;
        const pos = legacyByTitle.get(tk);
        if (pos == null) {
            legacyByTitle.set(tk, deduped.length);
            deduped.push(item);
        } else if ((item.timestamp || 0) > (deduped[pos].timestamp || 0)) {
            deduped[pos] = item;
        }
    });

    // 按 timestamp 倒序，保证「最近观看」在最前
    deduped.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // 保留上限 50 条
    if (deduped.length > 50) deduped.splice(50);

    try {
        localStorage.setItem('viewingHistory', JSON.stringify(deduped));
    } catch (e) {
        // 存储失败（如配额满）不影响播放流程
    }
    return deduped;
}

// 兼容旧调用形态：薄封装，委托给唯一写入入口
function addToViewingHistory(videoInfo) {
    return upsertViewingHistory(videoInfo);
}

// 清空观看历史
function clearViewingHistory() {
    try {
        // 撤销快照：清空前的完整原始存储（JSON 字符串深拷贝）
        const snapshot = localStorage.getItem('viewingHistory');
        localStorage.removeItem('viewingHistory');
        loadViewingHistory(); // 重新加载空的历史记录
        const toast = (typeof window !== 'undefined' && typeof window.showToast === 'function')
            ? window.showToast : showToast;
        toast('观看历史已清空', 'success', {
            actionLabel: '撤销',
            onAction: function () {
                if (snapshot === null || snapshot === undefined) localStorage.removeItem('viewingHistory');
                else localStorage.setItem('viewingHistory', snapshot);
                loadViewingHistory();
            }
        });
    } catch (e) {
        // console.error('清除观看历史失败:', e);
        showToast('清除观看历史失败', 'error');
    }
}

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


// ============================================================
// 观影历史收敛：显式导出到 window
// 浏览器普通 script 下顶层函数本就挂 window，这里再赋相同引用无副作用；
// Node ESM 自测时顶层声明不挂 globalThis，靠此桥暴露（与 ad-filter.js 的 IIFE 导出同构）。
// player.js 跨文件调用 window.upsertViewingHistory。
// ============================================================
(function (g) {
    'use strict';
    g.upsertViewingHistory = upsertViewingHistory;
    g.addToViewingHistory = addToViewingHistory;
    g.getViewingHistory = getViewingHistory;
    g.deleteHistoryItem = deleteHistoryItem;
    g.clearViewingHistory = clearViewingHistory;
})(typeof window !== 'undefined' ? window : globalThis);

// ============================================================
// 批次 2：状态组件 / 焦点陷阱 可选接入
// 全部 typeof 防御式：js/states.js / js/focus-trap.js 未加载时回退原有行为，绝不抛错。
// toggleSettings 已收敛为单一定义（含关闭历史面板），由 HTML 事件层挂接。
// ============================================================

// 防御式读取 WDTVStates（浏览器挂 window，Node ESM 自测挂 globalThis）
function _getStates() {
    var S = (typeof window !== 'undefined' ? window.WDTVStates : null) ||
            (typeof globalThis !== 'undefined' ? globalThis.WDTVStates : null);
    return (S && typeof S.loading === 'function' && typeof S.clear === 'function' && typeof S.mount === 'function') ? S : null;
}

function _getFocusTrap() {
    var FT = (typeof window !== 'undefined' ? window.WDTVFocusTrap : null) ||
             (typeof globalThis !== 'undefined' ? globalThis.WDTVFocusTrap : null);
    return (FT && typeof FT.create === 'function') ? FT : null;
}

// loading 内容区：优先 .wdtv-loading-content，保留 #loading 遮罩骨架与 .show 切换
function _loadingHost(loading) {
    try {
        if (loading && typeof loading.querySelector === 'function') {
            const content = loading.querySelector('.wdtv-loading-content');
            if (content) return content;
        }
    } catch (e) { /* 回退到 loading 本身 */ }
    return loading;
}

// ---- 通用弹层焦点陷阱：Map<panelId, trap> + Esc 监听 ----
const panelTraps = new Map();        // panelId -> trap（模块不可用时存 null，仅作"已打开"标记）
const panelEscHandlers = new Map();  // panelId -> keydown handler
const panelOpenOrder = [];           // 打开顺序，用于判断"最后打开的弹层"

// 清理某弹层的 trap / Esc 监听 / 顺序记录（不改动面板 DOM 显示状态）
function _disposePanelTrap(panelId) {
    const trap = panelTraps.get(panelId);
    if (trap && typeof trap.deactivate === 'function') {
        try { trap.deactivate(); } catch (e) { /* 忽略 */ }
    }
    panelTraps.delete(panelId);

    const h = panelEscHandlers.get(panelId);
    if (h) {
        if (typeof document !== 'undefined' && document && typeof document.removeEventListener === 'function') {
            try { document.removeEventListener('keydown', h, true); } catch (e) { /* 忽略 */ }
        }
        panelEscHandlers.delete(panelId);
    }

    const idx = panelOpenOrder.indexOf(panelId);
    if (idx !== -1) panelOpenOrder.splice(idx, 1);
}

function openPanelWithTrap(panelId) {
    if (!panelId) return;
    // 重复打开：先清理旧 trap（只动 trap，不动 DOM，避免误关刚打开的面板）
    if (panelTraps.has(panelId)) _disposePanelTrap(panelId);

    const panel = (typeof document !== 'undefined' && document && typeof document.getElementById === 'function')
        ? document.getElementById(panelId) : null;

    const FT = _getFocusTrap();
    let trap = null;
    if (FT && panel) {
        try {
            trap = FT.create(panel);
            if (trap && typeof trap.activate === 'function') trap.activate();
        } catch (e) { trap = null; }
    }
    panelTraps.set(panelId, trap);

    // Esc 由 WDTVFocusTrap 不处理：仅当该弹层是最后打开的才关闭，
    // 且只调用 closePanelWithTrap，不触发关闭动作以外的副作用。
    if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
        const escHandler = function (e) {
            if (!e || (e.key !== 'Escape' && e.key !== 'Esc')) return;
            if (panelOpenOrder.length && panelOpenOrder[panelOpenOrder.length - 1] === panelId) {
                closePanelWithTrap(panelId);
            }
        };
        document.addEventListener('keydown', escHandler, true);
        panelEscHandlers.set(panelId, escHandler);
    }

    const idx = panelOpenOrder.indexOf(panelId);
    if (idx !== -1) panelOpenOrder.splice(idx, 1);
    panelOpenOrder.push(panelId);
}

function closePanelWithTrap(panelId) {
    if (!panelId) return;
    _disposePanelTrap(panelId);
    // 通用关闭：show 体系面板（settingsPanel/historyPanel 等）移除 show class；
    // hidden / removeChild 体系（#modal 等）为 no-op，由各自关闭逻辑负责。
    if (typeof document !== 'undefined' && document && typeof document.getElementById === 'function') {
        const panel = document.getElementById(panelId);
        if (panel && panel.classList && typeof panel.classList.remove === 'function') {
            try { panel.classList.remove('show'); } catch (e) { /* 忽略 */ }
        }
    }
}

// 空态 / 错误态输出到 #modalContent：仅在确实无实质内容时渲染，绝不覆盖正常详情。
// 模块未加载时 no-op；kind === 'error' 走 error()，否则 empty()。
function renderModalState(kind, title, description) {
    const S = _getStates();
    if (!S || typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return;
    const box = document.getElementById('modalContent');
    if (!box) return;
    let hasContent = false;
    try {
        hasContent = (typeof box.innerHTML === 'string' && box.innerHTML.trim().length > 0) ||
                     (typeof box.childElementCount === 'number' && box.childElementCount > 0);
    } catch (e) { /* 视作无内容 */ }
    if (hasContent) return;
    S.mount(box, kind === 'error' ? S.error(title) : S.empty(title, description));
}

// 显式导出到 window（浏览器普通 script 顶层函数本就挂 window；
// Node ESM 自测时靠此桥暴露，与上方 viewingHistory 导出同构）
(function (g) {
    'use strict';
    g.openPanelWithTrap = openPanelWithTrap;
    g.closePanelWithTrap = closePanelWithTrap;
    g.renderModalState = renderModalState;
})(typeof window !== 'undefined' ? window : globalThis);
