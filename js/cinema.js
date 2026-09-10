// ============================================================
// 我的影院（收藏）模块
// - 数据层：localStorage 键 myCinemaFavorites，首页/播放页共用
// - 首页 UI：渲染"我的影院"区块（#cinemaArea），点击卡片进详情/播放
// - 播放页仅使用数据层（toggleCinemaFavorite 等），UI 函数自动 no-op
// 依赖（仅首页 UI 需要）：app.js 的 escapeResultText / buildPlaceholderCover /
//   handleCoverLoadError / extractQualityTag / normalizeRuyiPicUrl / showDetails / playVideo，
//   ui.js 的 showToast —— 均在函数内部调用，播放页不会触达
// ============================================================

const CINEMA_FAV_KEY = 'myCinemaFavorites';
const CINEMA_FAV_MAX = 50;

// ---------- 数据层 ----------

function getCinemaFavorites() {
    try {
        const arr = JSON.parse(localStorage.getItem(CINEMA_FAV_KEY) || '[]');
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        return [];
    }
}

function saveCinemaFavorites(list) {
    try {
        localStorage.setItem(CINEMA_FAV_KEY, JSON.stringify(list.slice(0, CINEMA_FAV_MAX)));
    } catch (e) {
        console.error('保存我的影院失败:', e);
    }
}

// djb2 字符串哈希（直链兜底 key 用）
function __cinemaHash(str) {
    let h = 5381;
    for (let i = 0; i < (str || '').length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

// 收藏唯一标识：站点视频用 源+ID；无源直链播放用 URL 哈希
// （对 vodId/sourceCode 做白名单过滤，保证 key 可安全内插进 onclick 属性）
function makeCinemaKey(vodId, sourceCode, directUrl) {
    const vid = String(vodId || '').replace(/[^\w-]/g, '');
    const src = String(sourceCode || '').replace(/[^\w-]/g, '');
    if (vid && src) return `s_${src}_${vid}`;
    return `d_${__cinemaHash(directUrl || '')}`;
}

function isCinemaFavorited(vodId, sourceCode, directUrl) {
    const key = makeCinemaKey(vodId, sourceCode, directUrl);
    return getCinemaFavorites().some(f => f.key === key);
}

// info: { vod_id, source_code, source_name, title, cover, remarks, type_name, year, episodes, directUrl, lastEpisodeIndex }
function addCinemaFavorite(info) {
    if (!info || !info.title) return null;
    const key = makeCinemaKey(info.vod_id, info.source_code, info.directUrl);
    const list = getCinemaFavorites();
    const existingIdx = list.findIndex(f => f.key === key);
    // 已存在则补充缺失的元信息（如封面后补），并置顶
    const merged = existingIdx !== -1 ? { ...list[existingIdx], ...info, key } : { ...info, key };
    merged.timestamp = Date.now();
    if (existingIdx !== -1) list.splice(existingIdx, 1);
    list.unshift(merged);
    saveCinemaFavorites(list);
    return merged;
}

function removeCinemaFavorite(key) {
    saveCinemaFavorites(getCinemaFavorites().filter(f => f.key !== key));
}

// 切换收藏状态，返回 { favorited: boolean }
function toggleCinemaFavorite(info) {
    if (isCinemaFavorited(info.vod_id, info.source_code, info.directUrl)) {
        removeCinemaFavorite(makeCinemaKey(info.vod_id, info.source_code, info.directUrl));
        return { favorited: false };
    }
    addCinemaFavorite(info);
    return { favorited: true };
}

// ---------- 永久化：IndexedDB 镜像 + 自愈恢复 ----------
// localStorage 会被"清除Cookie"/浏览器清理清空，IndexedDB 不受 localStorage.clear() 影响；
// 每次保存双写，启动时若 localStorage 空而镜像尚存则自动恢复，实现刷新/退出重进/清缓存后不丢失

const CINEMA_IDB_DB = 'wdtvCinemaDB';
const CINEMA_IDB_STORE = 'favorites';

function cinemaIdbOpen() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('indexeddb-unavailable')); return; }
        const req = indexedDB.open(CINEMA_IDB_DB, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(CINEMA_IDB_STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('idb-open-failed'));
    });
}

function cinemaIdbPut(list) {
    return cinemaIdbOpen().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(CINEMA_IDB_STORE, 'readwrite');
        tx.objectStore(CINEMA_IDB_STORE).put(list, 'list');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error || new Error('idb-put-failed')); };
    })).catch(() => { /* 镜像失败不影响主流程 */ });
}

function cinemaIdbGet() {
    return cinemaIdbOpen().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(CINEMA_IDB_STORE, 'readonly');
        const req = tx.objectStore(CINEMA_IDB_STORE).get('list');
        req.onsuccess = () => { db.close(); resolve(Array.isArray(req.result) ? req.result : null); };
        req.onerror = () => { db.close(); reject(req.error || new Error('idb-get-failed')); };
    })).catch(() => null);
}

// 申请持久化存储：降低浏览器在存储压力下自动清掉站点数据的概率
try {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
        navigator.storage.persisted().then(p => { if (!p) navigator.storage.persist(); }).catch(() => { });
    }
} catch (e) { }

// 自愈恢复：localStorage 无收藏但 IndexedDB 镜像尚存 → 恢复并重渲染
function cinemaSelfHeal() {
    if (getCinemaFavorites().length > 0) return;
    cinemaIdbGet().then(list => {
        if (Array.isArray(list) && list.length > 0) {
            try { localStorage.setItem(CINEMA_FAV_KEY, JSON.stringify(list)); } catch (e) { }
            updateCinemaVisibility();
            if (typeof showToast === 'function') showToast('已从本地备份恢复我的影院', 'success');
        }
    });
}

// 播放页后台补拉详情后，回填封面/备注等元信息（不改变置顶顺序）
function updateCinemaFavoriteMeta(key, meta) {
    if (!key || !meta) return;
    const list = getCinemaFavorites();
    const item = list.find(f => f.key === key);
    if (!item) return;
    ['cover', 'remarks', 'type_name', 'year', 'source_name'].forEach(field => {
        if (meta[field] && !item[field]) item[field] = meta[field];
    });
    saveCinemaFavorites(list);
}

// 观看进度同步：播放页观看时更新已收藏条目的"当前集数"、"上次观看秒数"与"总时长"
// （首页卡片显示 历史观看 集数 + 时长；单击卡片续播时从 lastPosition 回退 10 秒处还原）
function updateCinemaFavoriteProgress(sourceCode, vodId, directUrl, episodeIndex, position, duration) {
    const key = makeCinemaKey(vodId, sourceCode, directUrl);
    const list = getCinemaFavorites();
    const item = list.find(f => f.key === key);
    if (!item) return;
    item.lastEpisodeIndex = parseInt(episodeIndex, 10) || 0;
    item.lastPosition = Math.max(0, Math.floor(parseInt(position, 10) || 0));
    const dur = Math.floor(parseInt(duration, 10) || 0);
    if (dur > 0) item.lastDuration = dur;
    saveCinemaFavorites(list);
}

// ---------- 详情弹窗收藏按钮（首页） ----------

function __cinemaHeartSvg(filled) {
    return `<svg viewBox="0 0 24 24" width="14" height="14" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
}

function getCinemaModalBtnHtml(vodId, sourceCode) {
    const safeId = String(vodId || '').replace(/[^\w-]/g, '');
    const safeSource = String(sourceCode || '').replace(/[^\w-]/g, '');
    const favorited = isCinemaFavorited(safeId, safeSource, '');
    // 复用弹窗工具栏 wdtv-modal-mini-btn 胶囊风格，仅以心形填充/玫瑰色区分收藏态
    return `
        <button type="button" class="wdtv-modal-mini-btn wdtv-cinema-fav-chip${favorited ? ' active' : ''}"
                onclick="toggleCinemaFromModal('${safeId}','${safeSource}')">
            ${__cinemaHeartSvg(favorited)}
            <span>${favorited ? '已在我的影院' : '加入我的影院'}</span>
        </button>
    `;
}

// 弹窗内点击收藏/取消（vodId/sourceCode 来自当前详情弹窗）
function toggleCinemaFromModal(vodId, sourceCode) {
    if (!vodId || !sourceCode) return;
    // 从当前详情全局状态取元信息（showDetails 渲染时写入；仅在与当前详情一致时使用）
    const matched = String(typeof currentDetailId !== 'undefined' ? currentDetailId : '') === String(vodId) &&
        String(typeof currentDetailSource !== 'undefined' ? currentDetailSource : '') === String(sourceCode);
    const vi = matched && typeof currentDetailVideoInfo !== 'undefined' ? currentDetailVideoInfo : null;
    const info = {
        vod_id: vodId,
        source_code: sourceCode,
        source_name: (vi && vi.source_name) || (typeof API_SITES !== 'undefined' && API_SITES[sourceCode] ? API_SITES[sourceCode].name : sourceCode),
        title: (typeof currentVideoTitle !== 'undefined' && currentVideoTitle) || '未知视频',
        cover: (vi && vi.cover) || '',
        remarks: (vi && vi.remarks) || '',
        type_name: (vi && vi.type) || '',
        year: (vi && vi.year) || '',
        episodes: (typeof currentEpisodes !== 'undefined' && Array.isArray(currentEpisodes)) ? [...currentEpisodes] : [],
        directUrl: '',
        lastEpisodeIndex: 0
    };
    const res = toggleCinemaFavorite(info);
    if (typeof showToast === 'function') {
        showToast(res.favorited ? '已加入我的影院' : '已从我的影院移除', 'success');
    }
    // 原地更新按钮状态
    const wrap = document.getElementById('cinemaFavBtnWrap');
    if (wrap) wrap.innerHTML = getCinemaModalBtnHtml(vodId, sourceCode);
    // 同步刷新背景中的影院区块
    updateCinemaVisibility();
}

// ---------- 首页影院区块 ----------

function buildCinemaCard(fav) {
    const safeName = escapeResultText(fav.title);
    const hasCover = fav.cover && fav.cover.startsWith('http');
    const normalizedPic = hasCover ? normalizeRuyiPicUrl(fav.cover) : '';
    const coverUrl = hasCover ? normalizedPic : buildPlaceholderCover(fav.title);
    const coverOriginalAttr = hasCover ? ` data-original="${encodeURIComponent(normalizedPic)}"` : '';
    const safeRemarks = escapeResultText(fav.remarks || '');
    const safeSourceName = escapeResultText(fav.source_name || '');
    const qualityTag = extractQualityTag([fav.remarks, fav.title]);
    const key = fav.key || '';
    // 卡片底部徽章："历史观看" + 集数进度 + 观看时长/总时长
    const total = Array.isArray(fav.episodes) ? fav.episodes.length : 0;
    const current = total ? Math.min((parseInt(fav.lastEpisodeIndex, 10) || 0) + 1, total) : 0;
    const lastPos = parseInt(fav.lastPosition, 10) || 0;
    const lastDur = parseInt(fav.lastDuration, 10) || 0;
    let progressText = '历史观看';
    if (total) progressText += ` ${current}/${total}`;
    if (lastDur > 0) progressText += ` · ${fmtCinemaDur(lastPos)}/${fmtCinemaDur(lastDur)}`;

    return `
        <div class="douban-card flex flex-col cursor-pointer" data-key="${key}"
             onpointerdown="cinemaCardDown(event,'${key}')"
             onpointerup="cinemaCardUp(event,'${key}')"
             onclick="cinemaCardClick(event,'${key}')"
             onpointercancel="cinemaCardCancel(event)"
             onpointerleave="cinemaCardCancel(event)"
             ondragstart="return false"
             oncontextmenu="cinemaCardContextMenu(event,'${key}')">
            <div class="douban-card-image">
                <img src="${coverUrl}" alt="${safeName}"${coverOriginalAttr}
                     draggable="false"
                     onerror="handleCoverLoadError(this)"
                     loading="lazy" referrerpolicy="no-referrer">
                <div class="absolute inset-0" style="background: linear-gradient(to top, rgba(0,0,0,0.6), transparent 50%); pointer-events: none;"></div>
                ${qualityTag ? `<div class="wdtv-quality-badge">${qualityTag}</div>` : ''}
                ${safeSourceName ? `
                <div class="absolute bottom-2 left-2 right-2 flex items-center justify-between gap-1.5">
                    <div class="douban-rate-badge truncate min-w-0" title="${safeSourceName}">
                        ${safeSourceName}
                    </div>
                </div>
                ` : ''}
            </div>
            <div class="douban-card-title-area">
                <button class="text-sm font-medium truncate w-full transition"
                        style="color: #1d1d1f; background: transparent; border: none; cursor: pointer; padding: 0;"
                        title="${safeName}（按住或右键打开菜单）">
                    ${safeName}
                </button>
                <div class="wdtv-remarks-badge" title="${progressText}">
                    ${progressText}
                </div>
            </div>
        </div>
    `;
}

function renderCinemaArea() {
    const grid = document.getElementById('cinema-results');
    const count = document.getElementById('cinemaCount');
    if (!grid) return;
    const favs = getCinemaFavorites();
    grid.innerHTML = favs.map(buildCinemaCard).join('');
    // 空态卡片：无收藏时显示引导（搜索页/影院页分离后影院内容常驻其页面内）
    const empty = document.getElementById('cinemaEmpty');
    if (empty) empty.classList.toggle('hidden', favs.length > 0);
    if (count) count.textContent = favs.length > 0 ? `${favs.length} 部收藏` : '';
}

// 显隐规则：影院已作为底栏独立页面（#page-cinema），区块常驻其页面内，不再随搜索状态隐藏；
// 此函数仅负责内容渲染、空态切换与兜底移除 hidden（保留函数名兼容 app.js 等既有调用点）
function updateCinemaVisibility() {
    const area = document.getElementById('cinemaArea');
    if (area) area.classList.remove('hidden');
    renderCinemaArea();
}

// ---------- 影院卡片交互：按住=右键菜单（查看详情/移动卡片/删除卡片），移动卡片=桌面图标式编辑拖动 ----------

const CINEMA_PRESS_MS = 300;
const cinemaPress = { timer: null, moveHandler: null, upHandler: null, cancelHandler: null, card: null, fired: false, moved: false };
const cinemaDrag = { active: false, startX: 0, startY: 0, offX: 0, offY: 0, touchBlock: null, onMove: null, onUp: null, rafPending: false, lastEv: null };

// 秒数 → mm:ss / h:mm:ss
function fmtCinemaDur(sec) {
    sec = Math.max(0, Math.floor(parseInt(sec, 10) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function isCinemaEditMode() {
    const area = document.getElementById('cinemaArea');
    return !!(area && area.classList.contains('cinema-edit-mode'));
}

// 按下卡片：编辑模式直接进入拖动；普通模式按住 300ms 弹出菜单（移动超 10px 视为滚动，取消）
// 注意：这里绝不能 preventDefault —— 会抑制浏览器合成的 click 兼容事件，部分移动端浏览器
// /WebView 上 pointerup 也可能丢失，导致短按点击完全失效（典型表现：从播放页返回首页后
// 点击影院卡片没有任何反应）；短按跳转统一交给 cinemaCardClick 处理
function cinemaCardDown(e, key) {
    e.stopPropagation();
    // 右键/中键不参与短按点击与长按计时（右键由 contextmenu 处理）
    if (e.button !== undefined && e.button !== 0) return;
    closeCinemaContextMenu();
    const card = e.currentTarget;
    if (isCinemaEditMode()) {
        startCinemaDrag(e, card);
        return;
    }
    cinemaCardClearPress();
    cinemaPress.fired = false;
    cinemaPress.moved = false;
    const sx = e.clientX, sy = e.clientY;
    cinemaPress.card = card;
    cinemaPress.timer = setTimeout(() => {
        cinemaPress.timer = null;
        cinemaPress.fired = true;
        cinemaCardClearPress();
        openCinemaContextMenu(key, sx, sy);
    }, CINEMA_PRESS_MS);
    cinemaPress.moveHandler = (ev) => {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) {
            cinemaPress.moved = true;
            cinemaCardClearPress();
        }
    };
    cinemaPress.upHandler = () => cinemaCardClearPress();
    card.addEventListener('pointermove', cinemaPress.moveHandler);
    card.addEventListener('pointerup', cinemaPress.upHandler);
    card.addEventListener('pointercancel', cinemaPress.upHandler);
}

function cinemaCardCancel() {
    cinemaCardClearPress();
}

// 松开卡片：只负责结束长按计时。短按跳转统一在 click 事件里处理——
// click 由浏览器在"按下并松开且未发生滚动取消"后合成，是移动端最可靠的点击信号；
// 依赖 pointerup 跳转会在部分设备上因 pointer 事件丢失而无响应
function cinemaCardUp(e, key) {
    if (e.button !== undefined && e.button !== 0) return;
    cinemaCardCancel(e);
}

// 短按点击（click）：无 PointerEvent 支持的环境（老 WebView）也会触发；
// 长按弹菜单后的 click（本次按压 ≥300ms）与拖动超过 10px 的 click 不视为短按
function cinemaCardClick(e, key) {
    if (cinemaPress.fired) { cinemaPress.fired = false; return; }
    if (cinemaPress.moved) { cinemaPress.moved = false; return; }
    openCinemaItem(key);
}

// 鼠标右键：弹出与"按住"相同的菜单（屏蔽浏览器原生右键菜单）
function cinemaCardContextMenu(e, key) {
    e.preventDefault();
    e.stopPropagation();
    cinemaCardClearPress();
    closeCinemaContextMenu();
    openCinemaContextMenu(key, e.clientX, e.clientY);
}

function cinemaCardClearPress() {
    if (cinemaPress.timer) { clearTimeout(cinemaPress.timer); cinemaPress.timer = null; }
    if (cinemaPress.card) {
        const card = cinemaPress.card;
        if (cinemaPress.moveHandler) card.removeEventListener('pointermove', cinemaPress.moveHandler);
        if (cinemaPress.upHandler) {
            card.removeEventListener('pointerup', cinemaPress.upHandler);
            card.removeEventListener('pointercancel', cinemaPress.upHandler);
        }
        cinemaPress.card = null;
        cinemaPress.moveHandler = null;
        cinemaPress.upHandler = null;
    }
}

// ---------- 编辑模式（手机桌面图标式）：卡片抖动，直接拖动交换位置 ----------

function enterCinemaEditMode() {
    closeCinemaContextMenu();
    const area = document.getElementById('cinemaArea');
    if (!area || area.classList.contains('cinema-edit-mode')) return;
    area.classList.add('cinema-edit-mode');
    const header = area.querySelector('.wdtv-douban-header');
    if (header && !document.getElementById('cinemaEditBar')) {
        const bar = document.createElement('div');
        bar.id = 'cinemaEditBar';
        bar.className = 'wdtv-cinema-edit-bar';
        bar.innerHTML = `<span>拖动卡片可调整顺序</span><button type="button" onclick="exitCinemaEditMode()">完成</button>`;
        header.after(bar);
    }
}

function exitCinemaEditMode() {
    const area = document.getElementById('cinemaArea');
    if (!area) return;
    area.classList.remove('cinema-edit-mode');
    const bar = document.getElementById('cinemaEditBar');
    if (bar) bar.remove();
    persistCinemaOrder();
}

// ---------- 拖动交换排序 ----------

function startCinemaDrag(e, card) {
    if (cinemaDrag.active) return;
    cinemaDrag.active = true;
    cinemaDrag.startX = e.clientX;
    cinemaDrag.startY = e.clientY;
    const rect = card.getBoundingClientRect();
    cinemaDrag.offX = e.clientX - rect.left;
    cinemaDrag.offY = e.clientY - rect.top;
    card.classList.add('cinema-dragging');
    if (card.setPointerCapture) { try { card.setPointerCapture(e.pointerId); } catch (err) { } }
    try { card.style.touchAction = 'none'; } catch (err) { }
    // 拖动期间阻止触摸滚动
    cinemaDrag.touchBlock = (ev) => { if (cinemaDrag.active) ev.preventDefault(); };
    document.addEventListener('touchmove', cinemaDrag.touchBlock, { passive: false });
    cinemaDrag.onMove = (ev) => moveCinemaDrag(ev, card);
    cinemaDrag.onUp = () => endCinemaDrag(card);
    card.addEventListener('pointermove', cinemaDrag.onMove);
    card.addEventListener('pointerup', cinemaDrag.onUp);
    card.addEventListener('pointercancel', cinemaDrag.onUp);
}

function moveCinemaDrag(ev, card) {
    // 同步处理（浏览器本身会把 pointermove 合并到每帧一次，无需 rAF 节流；
    // rAF 在标签页失焦/后台时完全不触发，会导致拖动饿死）
    const dx = ev.clientX - cinemaDrag.startX, dy = ev.clientY - cinemaDrag.startY;
    card.style.transform = `translate(${dx}px, ${dy}px) scale(1.05)`;
    card.style.zIndex = '60';

    // 第一步：用"被拖卡片的视觉中心"找到重叠的目标卡片
    const before = card.getBoundingClientRect();
    const cx = before.left + before.width / 2;
    const cy = before.top + before.height / 2;
    const stack = document.elementsFromPoint ? document.elementsFromPoint(cx, cy) : [];
    let over = null;
    for (const el of stack) {
        const c = el.closest ? el.closest('#cinema-results .douban-card') : null;
        if (c && c !== card) { over = c; break; }
    }
    if (!over) return;

    // 第二步（防震荡关键）：中线穿越规则——只有被拖卡片中心越过目标卡片的"中心线"才交换。
    // 若在目标刚碰到边缘就交换（重叠 ~40%），换位后目标就贴在旁边，随机拖动会在边界处
    // 反复横跳；中线规则让换回必须拖过整整一格，形成真正的半格死区。
    const oRect = over.getBoundingClientRect();
    const oCX = oRect.left + oRect.width / 2;
    const oCY = oRect.top + oRect.height / 2;
    // 主轴判定：被拖中心与目标同行 → 比较 X 中线；不同行（上/下一行）→ 比较 Y 中线
    const inRowBand = cy >= oRect.top && cy <= oRect.bottom;
    const pastMid = inRowBand ? cx >= oCX : cy >= oCY;
    const overIsAfter = !!(card.compareDocumentPosition(over) & Node.DOCUMENT_POSITION_FOLLOWING);
    const needSwap = overIsAfter ? pastMid : !pastMid;
    if (!needSwap) return;

    // 方向判断：over 在 card 之后 → card 插到 over 之后；反之插到 over 之前
    if (overIsAfter) over.after(card);
    else over.before(card);

    // 关键补偿：DOM 插入改变了卡片布局原点，若直接清零位移卡片会瞬移到新槽位。
    // 按布局差量补偿 translate，使卡片视觉位置始终钉在指针下——任意方向/斜向拖动都不跳。
    const after = card.getBoundingClientRect();
    const ndx = dx + (before.left - after.left);
    const ndy = dy + (before.top - after.top);
    card.style.transform = `translate(${ndx}px, ${ndy}px) scale(1.05)`;
    cinemaDrag.startX = ev.clientX - ndx;
    cinemaDrag.startY = ev.clientY - ndy;
}

function endCinemaDrag(card) {
    if (!cinemaDrag.active) return;
    cinemaDrag.active = false;
    cinemaDrag.rafPending = false;
    cinemaDrag.lastEv = null;
    card.classList.remove('cinema-dragging');
    card.style.zIndex = '';
    try { card.style.touchAction = ''; } catch (err) { }
    card.removeEventListener('pointermove', cinemaDrag.onMove);
    card.removeEventListener('pointerup', cinemaDrag.onUp);
    card.removeEventListener('pointercancel', cinemaDrag.onUp);
    document.removeEventListener('touchmove', cinemaDrag.touchBlock);
    const area = card.closest('#cinemaArea');
    if (area) area.classList.remove('cinema-drag-active');
    // 落手动画：卡片平滑滑入最终槽位（不瞬跳）
    card.style.transition = 'transform 0.18s ease';
    card.style.transform = '';
    setTimeout(() => { card.style.transition = ''; }, 220);
    // DOM 顺序已是最终态，仅持久化、不重绘（保留落手动画）
    persistCinemaOrder(false);
}

// 按当前 DOM 顺序持久化收藏排序（rerender=false 时不重绘，供落手动画使用）
function persistCinemaOrder(rerender) {
    const grid = document.getElementById('cinema-results');
    if (!grid) return;
    const order = Array.from(grid.querySelectorAll('.douban-card')).map(c => c.dataset.key);
    const favs = getCinemaFavorites();
    favs.sort((a, b) => {
        const ia = order.indexOf(a.key), ib = order.indexOf(b.key);
        return (ia === -1 ? 9999 : ia) - (ib === -1 ? 9999 : ib);
    });
    saveCinemaFavorites(favs);
    if (rerender !== false) renderCinemaArea();
}

// ---------- 短按右键菜单 ----------

function openCinemaContextMenu(key, x, y) {
    closeCinemaContextMenu();
    const menu = document.createElement('div');
    menu.id = 'cinemaContextMenu';
    menu.className = 'wdtv-cinema-ctx-menu';
    menu.innerHTML = `
        <div class="wdtv-cinema-ctx-item" data-act="details">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
            <span>查看详情</span>
        </div>
        <div class="wdtv-cinema-ctx-item" data-act="move">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"></path></svg>
            <span>移动卡片</span>
        </div>
        <div class="wdtv-cinema-ctx-item danger" data-act="remove">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            <span>删除卡片</span>
        </div>
    `;
    document.body.appendChild(menu);
    const mw = menu.offsetWidth || 150, mh = menu.offsetHeight || 130;
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - mw - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - mh - 8)) + 'px';
    // 菜单内的按下不触发全局关闭
    menu.addEventListener('pointerdown', ev => ev.stopPropagation());
    menu.addEventListener('click', ev => {
        const item = ev.target.closest('.wdtv-cinema-ctx-item');
        if (!item) return;
        const act = item.dataset.act;
        closeCinemaContextMenu();
        if (act === 'details') openCinemaDetails(key);
        else if (act === 'move') enterCinemaEditMode();
        else if (act === 'remove') removeCinemaItem(key);
    });
    // 点击菜单外关闭（延迟挂载，避免触发它的那次 pointerdown 立即关闭）
    setTimeout(() => { document.addEventListener('pointerdown', cinemaCtxDocClose); }, 0);
}

function cinemaCtxDocClose() {
    closeCinemaContextMenu();
}

function closeCinemaContextMenu() {
    const m = document.getElementById('cinemaContextMenu');
    if (m) m.remove();
    document.removeEventListener('pointerdown', cinemaCtxDocClose);
}

// 查看详情：与搜索结果卡片一致，实时拉取详情弹窗（避免收藏的集数直链失效）
function openCinemaDetails(key) {
    const fav = getCinemaFavorites().find(f => f.key === key);
    if (!fav) {
        if (typeof showToast === 'function') showToast('该收藏已不存在', 'info');
        updateCinemaVisibility();
        return;
    }
    if (fav.vod_id && fav.source_code) {
        showDetails(String(fav.vod_id), fav.title || '', fav.source_code);
    } else if (fav.directUrl) {
        // 无源直链收藏没有详情可拉，回退为直接播放该直链
        const idx = parseInt(fav.lastEpisodeIndex, 10) || 0;
        playVideo(fav.directUrl, fav.title || '', fav.source_code || '', idx, fav.vod_id || '');
    } else {
        if (typeof showToast === 'function') showToast('该收藏缺少播放信息，请重新搜索收藏', 'error');
        removeCinemaFavorite(key);
        updateCinemaVisibility();
    }
}

function removeCinemaItem(key) {
    removeCinemaFavorite(key);
    if (typeof showToast === 'function') showToast('已从我的影院移除', 'success');
    updateCinemaVisibility();
}

// 短按点击卡片直接跳转播放：
// - 无任何观看记录 → 直接进入第一集
// - 有观看记录 → 续播上次观看的集数，进度回退 10 秒还原（刚开头 ≤10s 或已看完 ≥95% 则从头播）
// 优先使用收藏时缓存的集数直链；无列表的直链收藏直接播直链；站点收藏缺列表时回退详情弹窗实时拉取

// 续播回退秒数：从上次记录位置往前退 10 秒，方便衔接上一段剧情
const CINEMA_RESUME_REWIND_SECONDS = 10;

function openCinemaItem(key) {
    const fav = getCinemaFavorites().find(f => f.key === key);
    if (!fav) {
        if (typeof showToast === 'function') showToast('该收藏已不存在', 'info');
        updateCinemaVisibility();
        return;
    }
    const total = Array.isArray(fav.episodes) ? fav.episodes.length : 0;
    const lastPos = parseInt(fav.lastPosition, 10) || 0;
    const lastDur = parseInt(fav.lastDuration, 10) || 0;
    const hasHistory = lastPos > 0 || lastDur > 0;
    // 无观看记录 → 第一集；有记录 → 上次集数（越界回落到最后一集）
    let idx = hasHistory ? (parseInt(fav.lastEpisodeIndex, 10) || 0) : 0;
    if (total > 0) idx = Math.min(idx, total - 1);
    // 续播位置：上次进度回退 10 秒；回退后落在开头、或已接近片尾（≥95%）则从头播
    let resumePos = hasHistory ? Math.max(0, lastPos - CINEMA_RESUME_REWIND_SECONDS) : 0;
    if (resumePos > 0 && lastDur > 0 && resumePos >= lastDur * 0.95) resumePos = 0;

    const title = fav.title || '';
    const sourceCode = fav.source_code || '';
    const vodId = fav.vod_id || '';

    // 有缓存集数列表 → 直接跳播（同步全局集数列表，播放页才能正确显示/切换集数）
    if (total > 0) {
        try { currentEpisodes = [...fav.episodes]; } catch (e) { }
        playVideo(fav.episodes[idx], title, sourceCode, idx, vodId, resumePos);
        return;
    }
    // 无列表：直链收藏直接播该直链
    if (fav.directUrl) {
        playVideo(fav.directUrl, title, sourceCode, 0, vodId, resumePos);
        return;
    }
    // 站点收藏但无缓存集数列表 → 回退详情弹窗实时拉取
    openCinemaDetails(key);
}

// 初始化：脚本位于页面末尾，DOM 已就绪（播放页无 #cinemaArea，自动 no-op）
updateCinemaVisibility();
// 永久化自愈：localStorage 被清空但 IndexedDB 镜像尚存时恢复收藏（异步，不阻塞首屏）
cinemaSelfHeal();
