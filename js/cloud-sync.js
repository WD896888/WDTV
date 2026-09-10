// ============================================================
// 云同步 SDK（window.CloudSync）
// - 账号：注册 / 登录 / 登出（PBKDF2-SHA256 本地派生 clientHash，密码永不上传）
// - 数据：localStorage 用户数据双向同步（写入拦截 + 防抖推送 + 定时轮询 + 关页 flush）
// - 设计原则：零侵入、静默容错，任何同步异常都绝不影响正常看片流程
// - 无第三方依赖，经典 script 引入（非模块），全中文注释，无 emoji
// ============================================================

(function () {
    'use strict';

    // ========================= 常量 =========================

    // 需要同步的列表 / 设置键（共 11 个；videoProgress_<id> 通过前缀单独扫描）
    const SYNC_LIST_KEYS = [
        'viewingHistory',
        'myCinemaFavorites',
        'videoSearchHistory',
        'selectedAPIs',
        'adFilteringEnabled',
        'doubanEnabled',
        'autoplayEnabled',
        'cacheEvictMode',
        'userMovieTags',
        'userTvTags',
        'episodeViewMode'
    ];

    const PROGRESS_PREFIX = 'videoProgress_';        // 播放进度键前缀
    const TOKEN_KEY = 'wdtv_auth_token';             // 登录令牌
    const PROFILE_KEY = 'wdtv_auth_profile';         // 用户资料 {username, nickname, avatarVersion}
    const AVATAR_CACHE_KEY = 'wdtv_avatar_cache';    // 头像缓存 {v, dataUrl}
    const META_KEY = 'wdtv_sync_meta';               // 本地写入版本表 {key: 最后写入毫秒}，仅本地使用，不同步

    const MAX_PAYLOAD = 500 * 1024;                  // 上传载荷上限（字节）
    const FLUSH_BODY_LIMIT = 60 * 1024;              // keepalive 请求体安全上限（浏览器硬限约 64KB）
    const PUSH_DEBOUNCE_MS = 15000;                  // 写入后防抖推送间隔
    const POLL_INTERVAL_MS = 15000;                  // 定时轮询推送间隔
    const PUSH_MAX_RETRIES = 2;                      // 409 冲突最大重试次数
    const PBKDF2_ITERATIONS = 200000;                // 密码派生迭代次数

    const VIEWING_HISTORY_MAX = 50;                  // 与应用层 viewingHistory 上限一致
    const SEARCH_HISTORY_MAX = 20;                   // 搜索历史合并后保留条数
    const CINEMA_FAV_MAX = 50;                       // 经 js/cinema.js 核实的 CINEMA_FAV_MAX

    // ========================= 运行时状态（仅内存） =========================

    const state = {
        token: null,             // 登录令牌
        profile: null,           // {username, nickname, avatarVersion}
        lastSyncAt: 0,           // 最近一次推送成功时间
        lastError: null,         // 最近一次同步错误信息
        syncing: false,          // 是否正在同步（防重入）
        lastKnownRevision: 0     // 云端版本号（由 pull / 409 响应更新）
    };

    let avatarMemory = null;         // 头像内存缓存 {dataUrl, avatarVersion}
    let allowRegisterCache = null;   // 注册开关缓存（null 表示未查询过）
    const listeners = [];            // onChange 订阅者
    let pushTimer = null;            // 防抖定时器
    let syncPromise = null;          // syncNow 进行中 Promise（防重入）
    let storageWrapped = false;      // localStorage 包装标志（只包装一次）
    let initialized = false;         // init 标志
    let origSetItem = null;          // 原生 localStorage.setItem 引用
    let origRemoveItem = null;       // 原生 localStorage.removeItem 引用

    // ========================= 基础工具 =========================

    function num(x) {
        const n = Number(x);
        return isFinite(n) ? n : 0;
    }

    function isArray(x) {
        return Object.prototype.toString.call(x) === '[object Array]';
    }

    function readJson(key) {
        try {
            const raw = localStorage.getItem(key);
            if (raw === null || raw === undefined) return null;
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    // 绕过拦截包装的原生写 / 删（供本 SDK 内部与 applyItems 使用，避免递归触发拦截）
    function rawSet(key, value) {
        if (origSetItem) return origSetItem.call(localStorage, key, value);
        return localStorage.setItem(key, value);
    }

    function rawRemove(key) {
        if (origRemoveItem) return origRemoveItem.call(localStorage, key);
        return localStorage.removeItem(key);
    }

    function bytesToHex(bytes) {
        let out = '';
        for (let i = 0; i < bytes.length; i++) {
            out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        }
        return out;
    }

    function hexToBytes(hex) {
        const s = String(hex || '');
        if (s.length === 0 || s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) return null;
        const out = new Uint8Array(s.length / 2);
        for (let i = 0; i < out.length; i++) {
            out[i] = parseInt(s.substr(i * 2, 2), 16);
        }
        return out;
    }

    // ========================= 状态与事件 =========================

    function getStatus() {
        const p = state.profile || {};
        return {
            loggedIn: !!state.token,
            username: p.username || null,
            nickname: p.nickname || null,
            avatarVersion: p.avatarVersion || 0,
            lastSyncAt: state.lastSyncAt,
            lastError: state.lastError,
            syncing: state.syncing,
            allowRegister: null
        };
    }

    // 订阅状态变化（登录 / 登出 / 同步完成 / 失败 / 401），返回退订函数
    function onChange(cb) {
        if (typeof cb !== 'function') return function () { };
        listeners.push(cb);
        return function () {
            const i = listeners.indexOf(cb);
            if (i !== -1) listeners.splice(i, 1);
        };
    }

    function notify() {
        const snapshot = getStatus();
        listeners.slice().forEach(function (cb) {
            try { cb(snapshot); } catch (e) { console.warn('CloudSync onChange 回调异常:', e); }
        });
    }

    // ========================= 会话管理 =========================

    function persistSession() {
        try { rawSet(TOKEN_KEY, state.token || ''); } catch (e) { /* 存储失败静默 */ }
        try {
            rawSet(PROFILE_KEY, state.profile ? JSON.stringify(state.profile) : '');
        } catch (e) { /* 存储失败静默 */ }
    }

    function saveSession(token, resp) {
        state.token = token || null;
        state.profile = {
            username: (resp && resp.username) || '',
            nickname: (resp && resp.nickname) || (resp && resp.username) || '',
            avatarVersion: (resp && num(resp.avatarVersion)) || 0
        };
        persistSession();
    }

    // 清空本地会话（登出与 401 共用；不做任何网络请求，避免递归）
    function clearSession() {
        state.token = null;
        state.profile = null;
        state.lastKnownRevision = 0;
        state.lastSyncAt = 0;
        state.lastError = null;
        avatarMemory = null;
        try { rawRemove(TOKEN_KEY); } catch (e) { /* 静默 */ }
        try { rawRemove(PROFILE_KEY); } catch (e) { /* 静默 */ }
        try { rawRemove(AVATAR_CACHE_KEY); } catch (e) { /* 静默 */ }
    }

    function restoreSession() {
        try {
            const token = localStorage.getItem(TOKEN_KEY);
            const profile = readJson(PROFILE_KEY);
            if (token) state.token = token;
            if (profile && typeof profile === 'object') {
                state.profile = {
                    username: profile.username || '',
                    nickname: profile.nickname || profile.username || '',
                    avatarVersion: num(profile.avatarVersion)
                };
            }
            if (!state.token) state.profile = null;
        } catch (e) {
            console.warn('CloudSync 恢复会话失败:', e);
        }
    }

    function logout() {
        clearSession();
        notify();
    }

    // ========================= 网络请求封装 =========================

    // 统一请求：JSON 头 + Bearer；网络异常统一报错；401 统一清会话并通知（不递归）
    async function request(method, path, body, opts) {
        const options = opts || {};
        const headers = { 'Content-Type': 'application/json' };
        if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
        if (options.ifNoneMatch) headers['If-None-Match'] = options.ifNoneMatch;

        let resp;
        try {
            resp = await fetch(path, {
                method: method,
                headers: headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                keepalive: !!options.keepalive
            });
        } catch (e) {
            throw new Error('网络异常，同步暂不可用');
        }

        if (resp.status === 401) {
            clearSession();
            notify();
            throw new Error('登录已过期，请重新登录');
        }
        return resp;
    }

    // ========================= 密码派生（密码永不上传） =========================

    // PBKDF2-SHA256(password, salt, 200000) -> 64 位 hex 的 clientHash
    async function pbkdf2Hex(password, saltHex) {
        if (typeof crypto === 'undefined' || !crypto.subtle) {
            throw new Error('当前环境不支持安全加密（需要 HTTPS）');
        }
        let saltBytes = hexToBytes(saltHex);
        if (!saltBytes) saltBytes = new TextEncoder().encode(String(saltHex || ''));
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(String(password)),
            'PBKDF2',
            false,
            ['deriveBits']
        );
        const bits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: PBKDF2_ITERATIONS },
            keyMaterial,
            256
        );
        return bytesToHex(new Uint8Array(bits));
    }

    // 16 字节随机盐 -> 32 位 hex
    function randomSalt16() {
        if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
            throw new Error('当前环境不支持安全随机数');
        }
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return bytesToHex(bytes);
    }

    // ========================= 认证接口 =========================

    async function register(username, password) {
        const name = String(username || '').trim();
        if (!name) {
            throw new Error('请输入用户名');
        }
        if (typeof password !== 'string' || password.length < 6) {
            throw new Error('密码至少 6 位');
        }
        const salt = randomSalt16();
        const clientHash = await pbkdf2Hex(password, salt);
        const resp = await request('POST', '/api/auth/register', {
            username: name,
            salt: salt,
            clientHash: clientHash
        });
        const data = await resp.json().catch(function () { return {}; });
        if (!resp.ok) throw new Error(data.error || '注册失败');
        saveSession(data.token, data);
        notify();
        syncNow(); // 登录后立即双向同步（不阻塞注册返回）
        return { username: state.profile.username, nickname: state.profile.nickname, avatarVersion: state.profile.avatarVersion };
    }

    async function login(username, password) {
        const name = String(username || '').trim();
        const saltResp = await request('GET', '/api/auth/salt?username=' + encodeURIComponent(name));
        if (!saltResp.ok) {
            const errData = await saltResp.json().catch(function () { return {}; });
            throw new Error(errData.error || '登录失败');
        }
        const saltData = await saltResp.json().catch(function () { return {}; });
        if (!saltData || !saltData.salt) throw new Error('登录失败');
        const clientHash = await pbkdf2Hex(password, saltData.salt);
        const loginResp = await request('POST', '/api/auth/login', {
            username: name,
            clientHash: clientHash
        });
        const data = await loginResp.json().catch(function () { return {}; });
        if (!loginResp.ok) throw new Error(data.error || '登录失败');
        saveSession(data.token, data);
        notify();
        syncNow(); // 登录后立即双向同步（不阻塞登录返回）
        return { username: state.profile.username, nickname: state.profile.nickname, avatarVersion: state.profile.avatarVersion };
    }

    function isRegisterAllowed() {
        if (allowRegisterCache !== null) return Promise.resolve(allowRegisterCache);
        return request('GET', '/api/config')
            .then(function (resp) {
                if (!resp.ok) return false;
                return resp.json().catch(function () { return {}; }).then(function (data) {
                    allowRegisterCache = !!(data && data.allowRegister);
                    return allowRegisterCache;
                });
            })
            .catch(function (e) {
                // 查询失败不缓存，下次可重试；不抛错影响注册页
                console.warn('CloudSync 查询注册开关失败:', e);
                return false;
            });
    }

    // ========================= 用户资料与头像 =========================

    function updateProfileLocal(patch) {
        state.profile = Object.assign({}, state.profile || {}, patch);
        persistSession();
    }

    async function updateNickname(nickname) {
        if (!state.token) throw new Error('未登录');
        const resp = await request('PUT', '/api/user/profile', { nickname: nickname });
        const data = await resp.json().catch(function () { return {}; });
        if (!resp.ok) throw new Error(data.error || '昵称更新失败');
        updateProfileLocal({ nickname: nickname });
        notify();
        return nickname;
    }

    // 获取头像：内存缓存优先 -> 条件请求（ETag / 304 用本地缓存）-> 无头像返回 {dataUrl:null}
    async function getAvatarDataUrl() {
        if (avatarMemory) return avatarMemory;
        const profile = state.profile;
        if (!state.token || !profile) return { dataUrl: null, avatarVersion: 0 };
        try {
            const etag = '"v' + (profile.avatarVersion || 0) + '"';
            const resp = await request('GET', '/api/user/avatar', undefined, { ifNoneMatch: etag });
            if (resp.status === 304) {
                const cache = readJson(AVATAR_CACHE_KEY);
                if (cache && cache.dataUrl && num(cache.v) === (profile.avatarVersion || 0)) {
                    avatarMemory = { dataUrl: cache.dataUrl, avatarVersion: profile.avatarVersion || 0 };
                    return avatarMemory;
                }
                return { dataUrl: null, avatarVersion: profile.avatarVersion || 0 };
            }
            if (!resp.ok) return { dataUrl: null, avatarVersion: profile.avatarVersion || 0 };
            const data = await resp.json().catch(function () { return {}; });
            if (!data || !data.dataUrl) return { dataUrl: null, avatarVersion: profile.avatarVersion || 0 };
            avatarMemory = { dataUrl: data.dataUrl, avatarVersion: num(data.avatarVersion) || profile.avatarVersion || 0 };
            try {
                rawSet(AVATAR_CACHE_KEY, JSON.stringify({ v: avatarMemory.avatarVersion, dataUrl: data.dataUrl }));
            } catch (e) { /* 缓存写入失败静默 */ }
            return avatarMemory;
        } catch (e) {
            console.warn('CloudSync 获取头像失败:', e);
            return { dataUrl: null, avatarVersion: profile.avatarVersion || 0 };
        }
    }

    async function uploadAvatarDataUrl(dataUrl) {
        if (!state.token) throw new Error('未登录');
        const resp = await request('POST', '/api/user/avatar', { dataUrl: dataUrl });
        const data = await resp.json().catch(function () { return {}; });
        if (!resp.ok) throw new Error(data.error || '头像上传失败');
        const version = num(data.avatarVersion);
        updateProfileLocal({ avatarVersion: version });
        avatarMemory = { dataUrl: dataUrl, avatarVersion: version };
        try {
            rawSet(AVATAR_CACHE_KEY, JSON.stringify({ v: version, dataUrl: dataUrl }));
        } catch (e) { /* 缓存写入失败静默 */ }
        notify();
        return version;
    }

    // ========================= 本地写入版本表（META） =========================

    function readMeta() {
        const meta = readJson(META_KEY);
        return (meta && typeof meta === 'object' && !isArray(meta)) ? meta : {};
    }

    function writeMeta(meta) {
        try { rawSet(META_KEY, JSON.stringify(meta)); } catch (e) { /* 静默 */ }
    }

    function touchMeta(key) {
        const meta = readMeta();
        meta[key] = Date.now();
        writeMeta(meta);
    }

    function clearMeta(key) {
        const meta = readMeta();
        if (Object.prototype.hasOwnProperty.call(meta, key)) {
            delete meta[key];
            writeMeta(meta);
        }
    }

    // ========================= 写入拦截（零侵入核心） =========================

    function isSyncKey(key) {
        return typeof key === 'string' &&
            (SYNC_LIST_KEYS.indexOf(key) !== -1 || key.indexOf(PROGRESS_PREFIX) === 0);
    }

    // 仅包装一次；原调用完成后才做拦截处理，且拦截逻辑全部 try/catch，绝不影响业务
    function wrapStorage() {
        if (storageWrapped) return;
        storageWrapped = true;
        try {
            origSetItem = localStorage.setItem;
            origRemoveItem = localStorage.removeItem;

            localStorage.setItem = function (key, value) {
                // 原调用先行（配额超限等原始异常自然向业务方抛出）
                const result = origSetItem.call(localStorage, key, value);
                try {
                    if (isSyncKey(key)) {
                        touchMeta(String(key));
                        schedulePush();
                    }
                } catch (e) {
                    console.warn('CloudSync 写入拦截处理失败:', e);
                }
                return result;
            };

            localStorage.removeItem = function (key) {
                const result = origRemoveItem.call(localStorage, key);
                try {
                    if (isSyncKey(key)) {
                        touchMeta(String(key));
                        schedulePush();
                    }
                } catch (e) {
                    console.warn('CloudSync 删除拦截处理失败:', e);
                }
                return result;
            };
        } catch (e) {
            console.warn('CloudSync 包装存储失败:', e);
        }
    }

    function schedulePush() {
        try {
            if (pushTimer) clearTimeout(pushTimer);
            pushTimer = setTimeout(function () {
                pushTimer = null;
                try { push(); } catch (e) { /* 静默 */ }
            }, PUSH_DEBOUNCE_MS);
        } catch (e) { /* 静默 */ }
    }

    // ========================= 采集 / 合并 / 应用 =========================

    // 采集本地数据：{[key]: {value: 解析后 JSON 或 null, updatedAt: meta 时间戳或 0}}
    function collectItems() {
        const items = {};
        const meta = readMeta();
        SYNC_LIST_KEYS.forEach(function (key) {
            let raw = null;
            try { raw = localStorage.getItem(key); } catch (e) { raw = null; }
            let value = null;
            if (raw !== null && raw !== undefined) {
                try { value = JSON.parse(raw); } catch (e) { value = null; }
            }
            items[key] = { value: value, updatedAt: num(meta[key]) };
        });
        // 全量扫描播放进度键
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && typeof key === 'string' &&
                    key.indexOf(PROGRESS_PREFIX) === 0 &&
                    !Object.prototype.hasOwnProperty.call(items, key)) {
                    let raw = null;
                    try { raw = localStorage.getItem(key); } catch (e) { raw = null; }
                    let value = null;
                    if (raw !== null && raw !== undefined) {
                        try { value = JSON.parse(raw); } catch (e) { value = null; }
                    }
                    items[key] = { value: value, updatedAt: num(meta[key]) };
                }
            }
        } catch (e) {
            console.warn('CloudSync 扫描进度键失败:', e);
        }
        return items;
    }

    // ---------- 列表合并细则 ----------

    // 观影历史条目标识：优先 showIdentifier，缺失用 title|sourceName
    function viewingId(item) {
        if (!item || typeof item !== 'object') return 'raw:' + JSON.stringify(item);
        if (item.showIdentifier) return 'id:' + String(item.showIdentifier);
        return 't:' + String(item.title || '') + '|' + String(item.sourceName || '');
    }

    // 按 timestamp 较大者去重合并，结果按 timestamp 倒序，截 50 条
    function mergeViewingHistory(a, b) {
        const map = new Map();
        const feed = function (list) {
            (list || []).forEach(function (item) {
                const id = viewingId(item);
                const prev = map.get(id);
                if (!prev || num(item && item.timestamp) > num(prev && prev.timestamp)) map.set(id, item);
            });
        };
        feed(a);
        feed(b);
        const arr = Array.from(map.values());
        arr.sort(function (x, y) { return num(y && y.timestamp) - num(x && x.timestamp); });
        return arr.slice(0, VIEWING_HISTORY_MAX);
    }

    // 搜索历史归一化：旧格式纯字符串转为 {text, timestamp:0}
    function normSearchItem(item) {
        if (typeof item === 'string') return { text: item, timestamp: 0 };
        if (item && typeof item === 'object' && item.text !== null && item.text !== undefined) {
            return { text: String(item.text), timestamp: num(item.timestamp) };
        }
        return null;
    }

    // 按 text 去重合并取 timestamp 较大者，倒序，截 20 条
    function mergeSearchHistory(a, b) {
        const map = new Map();
        const feed = function (list) {
            (list || []).forEach(function (item) {
                const n = normSearchItem(item);
                if (!n) return;
                const prev = map.get(n.text);
                if (!prev || n.timestamp > prev.timestamp) map.set(n.text, n);
            });
        };
        feed(a);
        feed(b);
        const arr = Array.from(map.values());
        arr.sort(function (x, y) { return y.timestamp - x.timestamp; });
        return arr.slice(0, SEARCH_HISTORY_MAX);
    }

    // 收藏进度评分：lastEpisodeIndex * 1e9 + lastPosition
    function favScore(item) {
        if (!item || typeof item !== 'object') return 0;
        return num(item.lastEpisodeIndex) * 1e9 + num(item.lastPosition);
    }

    function favKey(item) {
        if (item && typeof item === 'object' && item.key !== null && item.key !== undefined && item.key !== '') {
            return 'k:' + String(item.key);
        }
        return 'raw:' + JSON.stringify(item);
    }

    // 按 key 取并集；重复取进度更大者（相等保留本地）；本地顺序在前、云端独有追加在后；截上限
    function mergeCinemaFavorites(a, b) {
        const cap = Math.min(CINEMA_FAV_MAX, 200);
        const result = [];
        const pos = new Map();
        (a || []).forEach(function (item) {
            const k = favKey(item);
            if (!pos.has(k)) {
                pos.set(k, result.length);
                result.push(item);
            }
        });
        (b || []).forEach(function (item) {
            const k = favKey(item);
            const idx = pos.get(k);
            if (idx === undefined) {
                pos.set(k, result.length);
                result.push(item);
            } else if (favScore(item) > favScore(result[idx])) {
                result[idx] = item;
            }
        });
        return result.slice(0, cap);
    }

    // 单键合并（双侧都有时）
    function mergeEntry(key, L, C) {
        const lv = L ? L.value : undefined;
        const cv = C ? C.value : undefined;

        if (key === 'viewingHistory' && isArray(lv) && isArray(cv)) {
            return { value: mergeViewingHistory(lv, cv), updatedAt: Math.max(num(L.updatedAt), num(C.updatedAt)) };
        }
        if (key === 'videoSearchHistory' && isArray(lv) && isArray(cv)) {
            return { value: mergeSearchHistory(lv, cv), updatedAt: Math.max(num(L.updatedAt), num(C.updatedAt)) };
        }
        if (key === 'myCinemaFavorites' && isArray(lv) && isArray(cv)) {
            return { value: mergeCinemaFavorites(lv, cv), updatedAt: Math.max(num(L.updatedAt), num(C.updatedAt)) };
        }
        // 播放进度：双侧均有值时按 value.timestamp 较大者胜
        if (key.indexOf(PROGRESS_PREFIX) === 0 && lv && cv) {
            return num(cv.timestamp) > num(lv.timestamp) ? C : L;
        }
        // 其余设置键与 null（删除标记）：updatedAt 严格更大者胜；相等或双方均 0 保留本地
        return num(C.updatedAt) > num(L.updatedAt) ? C : L;
    }

    // 合并本地与云端条目（键集合并集逐键处理；也暴露为 CloudSync._merge 供测试）
    function _merge(localItems, cloudItems) {
        const result = {};
        const local = localItems || {};
        const cloud = cloudItems || {};
        const keys = Object.keys(local);
        Object.keys(cloud).forEach(function (k) {
            if (keys.indexOf(k) === -1) keys.push(k);
        });
        keys.forEach(function (key) {
            const hasL = Object.prototype.hasOwnProperty.call(local, key);
            const hasC = Object.prototype.hasOwnProperty.call(cloud, key);
            const L = hasL ? local[key] : null;
            const C = hasC ? cloud[key] : null;
            let entry = null;
            if (L && !C) entry = L;            // 仅本地存在（含 null 删除标记）
            else if (C && !L) entry = C;       // 仅云端存在（含 null 删除标记）
            else if (L && C) entry = mergeEntry(key, L, C);
            if (entry) result[key] = entry;
        });
        return result;
    }

    // 将合并结果应用到 localStorage：与当前值深度对比（JSON.stringify），不同才写入 / 删除
    // 全部走原生方法，避免递归触发写入拦截；删除的键同时清理本地版本表
    function applyItems(items) {
        if (!items || typeof items !== 'object') return;
        Object.keys(items).forEach(function (key) {
            try {
                const entry = items[key];
                if (!entry || typeof entry !== 'object' ||
                    !Object.prototype.hasOwnProperty.call(entry, 'value')) return;
                const value = entry.value === undefined ? null : entry.value;

                let raw = null;
                try { raw = localStorage.getItem(key); } catch (e) { raw = null; }
                let current = null;
                if (raw !== null && raw !== undefined) {
                    try { current = JSON.parse(raw); } catch (e) { current = raw; }
                }

                if (JSON.stringify(current) === JSON.stringify(value)) return; // 无变化跳过

                if (value === null) {
                    rawRemove(key);
                    clearMeta(key);
                } else {
                    rawSet(key, JSON.stringify(value));
                }
            } catch (e) {
                console.warn('CloudSync 应用数据失败(' + key + '):', e);
            }
        });
    }

    // ========================= 载荷裁剪 =========================

    // 超限时依次裁剪：videoProgress_*（按 timestamp 从旧到新整键删除）-> viewingHistory 尾部 -> myCinemaFavorites 尾部
    function trimPayloadToLimit(payload) {
        const sizeOf = function () {
            try { return JSON.stringify(payload).length; } catch (e) { return Infinity; }
        };
        if (sizeOf() <= MAX_PAYLOAD) return;
        const items = payload.items;

        const progressKeys = Object.keys(items).filter(function (k) {
            return k.indexOf(PROGRESS_PREFIX) === 0;
        }).sort(function (a, b) {
            const ta = items[a] && items[a].value ? num(items[a].value.timestamp) : 0;
            const tb = items[b] && items[b].value ? num(items[b].value.timestamp) : 0;
            return ta - tb;
        });
        for (let i = 0; i < progressKeys.length && sizeOf() > MAX_PAYLOAD; i++) {
            delete items[progressKeys[i]];
        }

        const vh = items.viewingHistory;
        if (vh && isArray(vh.value)) {
            while (vh.value.length > 0 && sizeOf() > MAX_PAYLOAD) vh.value.pop();
        }

        const fav = items.myCinemaFavorites;
        if (fav && isArray(fav.value)) {
            while (fav.value.length > 0 && sizeOf() > MAX_PAYLOAD) fav.value.pop();
        }
    }

    // ========================= 推送与全量同步 =========================

    // 实际执行 PUT /api/sync；409 时以响应 payload+revision 重跑合并后重试（最多 2 次）
    async function runPush(flush) {
        let retries = 0;
        while (true) {
            const payload = { v: 1, items: collectItems() };
            trimPayloadToLimit(payload);
            const bodyStr = JSON.stringify({ payload: payload, baseRevision: state.lastKnownRevision });

            // keepalive 体积硬限约 64KB：超 60KB 时跳过本次 flush，靠下一轮定时上传
            if (flush && bodyStr.length > FLUSH_BODY_LIMIT) {
                console.warn('CloudSync: flush 数据超过安全体积(' + bodyStr.length + 'B)，本次跳过，等待定时上传');
                return;
            }

            const resp = await request('PUT', '/api/sync', {
                payload: payload,
                baseRevision: state.lastKnownRevision
            }, { keepalive: !!flush });

            if (resp.status === 409) {
                if (retries >= PUSH_MAX_RETRIES) throw new Error('同步冲突未能解决');
                retries++;
                const conflict = await resp.json().catch(function () { return {}; });
                state.lastKnownRevision = num(conflict.revision);
                const cloudItems = (conflict.payload && conflict.payload.items) ? conflict.payload.items : {};
                applyItems(_merge(collectItems(), cloudItems));
                continue; // 以合并后的最新本地数据重新上传
            }

            if (!resp.ok) {
                const errData = await resp.json().catch(function () { return {}; });
                throw new Error(errData.error || '同步上传失败');
            }

            const data = await resp.json().catch(function () { return {}; });
            if (data && typeof data.revision === 'number') state.lastKnownRevision = data.revision;
            state.lastSyncAt = Date.now();
            state.lastError = null;
            return;
        }
    }

    // 防抖触发或页面离开时的推送（仅登录态；进行中时跳过，绝不抛错）
    async function push(options) {
        const opts = options || {};
        if (!state.token || state.syncing) return;
        state.syncing = true;
        try {
            await runPush(!!opts.flush);
        } catch (e) {
            state.lastError = (e && e.message) || String(e);
            console.warn('CloudSync 推送失败:', e);
        } finally {
            state.syncing = false;
            notify();
        }
    }

    // 全量同步：拉取云端 -> 合并 -> 应用 -> 推送；幂等，进行中时复用同一 Promise
    function syncNow() {
        if (!state.token) return Promise.resolve();
        if (syncPromise) return syncPromise;
        syncPromise = (async function () {
            state.syncing = true;
            try {
                const resp = await request('GET', '/api/sync');
                if (!resp.ok) {
                    const errData = await resp.json().catch(function () { return {}; });
                    throw new Error(errData.error || '同步下载失败');
                }
                const data = await resp.json().catch(function () { return {}; });
                state.lastKnownRevision = typeof data.revision === 'number' ? data.revision : 0;
                const cloudItems = (data.payload && data.payload.items) ? data.payload.items : {};
                applyItems(_merge(collectItems(), cloudItems));
                await runPush(false); // push 内部使用 baseRevision = 当前 revision
            } catch (e) {
                state.lastError = (e && e.message) || String(e);
                console.warn('CloudSync 同步失败:', e);
            } finally {
                state.syncing = false;
                syncPromise = null;
                notify();
            }
        })();
        return syncPromise;
    }

    // ========================= 初始化与生命周期 =========================

    function startTimers() {
        // 定时轮询推送：页面隐藏、未登录或正在同步时跳过（document.hidden 为 undefined 时按 falsy 处理）
        setInterval(function () {
            try {
                const hidden = typeof document !== 'undefined' && !!document.hidden;
                if (hidden || !state.token || state.syncing) return;
                push();
            } catch (e) { /* 静默 */ }
        }, POLL_INTERVAL_MS);

        // 页面转入后台：flush 推送
        if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('visibilitychange', function () {
                try {
                    if (document.hidden && state.token) push({ flush: true });
                } catch (e) { /* 静默 */ }
            });
        }

        // 页面卸载：flush 推送（keepalive 保证请求发出）
        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('pagehide', function () {
                try { if (state.token) push({ flush: true }); } catch (e) { /* 静默 */ }
            });
            window.addEventListener('beforeunload', function () {
                try { if (state.token) push({ flush: true }); } catch (e) { /* 静默 */ }
            });
        }
    }

    function init() {
        if (initialized) return;
        initialized = true;
        try {
            // file:// 协议或无 localStorage 环境直接跳过
            if (typeof location !== 'undefined' && location.protocol === 'file:') return;
            let ls = null;
            try {
                if (typeof localStorage !== 'undefined' && localStorage) ls = localStorage;
            } catch (e) { ls = null; }
            if (!ls) return;

            restoreSession();
            wrapStorage();
            startTimers();
        } catch (e) {
            console.warn('CloudSync 初始化失败:', e);
        }
    }

    // 脚本加载即执行初始化
    init();

    // ========================= 导出 =========================

    const CloudSync = {
        login: login,
        register: register,
        logout: logout,
        syncNow: syncNow,
        getStatus: getStatus,
        onChange: onChange,
        getAvatarDataUrl: getAvatarDataUrl,
        uploadAvatarDataUrl: uploadAvatarDataUrl,
        updateNickname: updateNickname,
        isRegisterAllowed: isRegisterAllowed,
        _merge: _merge,                       // 供测试
        _collectItems: collectItems,          // 供测试
        _applyItems: applyItems               // 供测试
    };

    if (typeof window !== 'undefined') {
        window.CloudSync = CloudSync;
    }
})();
