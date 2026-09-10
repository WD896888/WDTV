/**
 * WDTV 视频整集后台缓存模块
 * - IndexedDB 存储（frags 分片 / texts 清单文本 / meta 元数据）
 * - hls.js loader 读写穿透（命中本地秒回，未命中走网络并回写）
 * - 后台顺序下载器（自动缓存整集，播放缓冲不足时自动让路）
 * - LRU 淘汰（保留最近 3 个 + 超过 3 天未访问自动删除 + 3GB 上限；配额吃紧时激进淘汰保证当前集可缓存）
 * - 惰性兜底巡检 housekeep()：任意页面加载即可对账 + 淘汰 + 重试失败删除（不依赖播放行为），并带低频定时兜底
 * - 全局缓存管理器（对账重建列表，杜绝"缓存了但看不见"的孤儿占用；删除失败明确提示）
 *
 * 独立 IIFE，无外部依赖；player.html 与 index.html 均可引入。
 * 播放页通过 VideoCache.init()/wrapLoader()/attachHls() 接入；
 * 任意页面可通过 VideoCache.openManager() 打开缓存管理弹窗。
 */
(function () {
    'use strict';

    // ===== 常量 =====
    var DB_NAME = 'wdtv-video-cache';
    var DB_VERSION = 1;
    var VC_VERSION = 92; // 构建版本（跟随 ?v= 递增）：缓存面板可见，用于确认设备实际运行的构建
    var STORE_FRAGS = 'frags';
    var STORE_TEXTS = 'texts';
    var STORE_META = 'meta';

    var CACHE_KEEP_VIDEOS = 3;                          // LRU：保留最近缓存的视频数
    var CACHE_MAX_TOTAL_BYTES = 3 * 1024 * 1024 * 1024; // 3GB 软上限
    var CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;     // 缓存最长保留时长：超过 3 天未访问自动删除
    var HOUSEKEEP_INTERVAL_MS = 15 * 60 * 1000;         // 兜底巡检间隔（不依赖播放行为）
    var AGGRESSIVE_BYTE_RATIO = 0.7;                    // 配额吃紧时的激进淘汰目标（降到上限的 70%，保证当前集可缓存）
    var WINDOW_SECONDS = 30;                            // 播放位置后 30 秒窗口（整集缓存的闸门）
    var PREFETCH_CONCURRENCY_MAX = 12;                  // 预取最大并行分片数：与整集下载器（12 并发）完全一致。
                                                        // 预取顺序 = 播放位置向后排（30s 窗口优先），命中即秒播，
                                                        // 并发越高缓存越快跑到播放前面，倍速播放越流畅；
                                                        // IDB 写入经 metaChain 串行化，并发只体现在网络层；
                                                        // 实际并发仍随播放缓冲余量动态收缩（见 targetConcurrency）
    var BUFFER_PAUSE_AHEAD = 20;                        // 播放缓冲前方不足 20s 时暂停下载
    var FRAG_DIRECT_TTFB_MS = 6000;                     // 直连首字节看门狗：连接建立阶段（DNS+TCP+TLS+首字节）限时 6s，
                                                        // 超时判定"连不上"回退代理。蜂窝网冷启动普遍 >3.5s，旧版按
                                                        // 总时长 3.5s 掐会误杀可用直连，把整个会话锁进跨境代理导致卡顿
    var FRAG_DIRECT_STALL_MS = 10000;                   // 直连停滞看门狗：已出流后连续 10s 无新字节才判连接僵死；
                                                        // 一旦首字节到达即不再限制总时长，慢但在流的连接允许跑完
    var FRAG_FETCH_TIMEOUT_MS = 20000;                  // 单分片预取总超时：仅用于响应头阶段；出流后由 PUMP_FETCH_IDLE_MS 接管
    var PUMP_FETCH_IDLE_MS = 20000;                     // 泵取件空闲看门狗：出流后连续 20s 无新字节才中止（慢但在流不掐，防蜂窝网误杀）
    var PUMP_RETRY_DELAY_MS = 1 * 1000;                 // 泵失败态自愈间隔：连续失败停转 1s 后自动重试；
                                                        // 极短退避仅防瞬时失败错误的热循环空转，缓存近乎不间断
    var DIRECT_HOST_FAIL_MS = 60 * 1000;                // 直连失败主机记忆时长：60 秒后自动重探直连（网络变化时立即清零）
    var DIRECT_HOST_TTFB_RETRY_MS = 20 * 1000;          // TTFB 超时的黑名单时长：多为蜂窝冷启动建连慢，短记忆尽快重探直连
    var PUMP_WAIT_MAX_MS = 5000;                        // 播放等待预取在途同分片的上限：超时则走网络路径自行加载
                                                        // （仅余量健康时等待；余量偏低直接跳过等待走直连+竞速）
    var PREWARM_INTERVAL_MS = 60 * 1000;                // 同 host 建连预热节流间隔
    // ---- 关键路径竞速兜底（设置开关，默认关闭；localStorage 键 wdtvRaceHedge）----
    // 开关开 = 播放分片"直连+代理立即双路并行、先到先用"（无条件，无视黑名单/余量）：
    // 流畅度绝对优先，接受双倍流量；始终双管道并行，无单腿省流量机制（软偏置已移除）。
    // 开关关 = 直连优先、失败回退代理，不竞速。
    var RACE_RUNWAY_MAX_S = 20;                         // 余量低于该真实秒数时跳过单飞合并等待（速度优先）
    var PROGRESS_THROTTLE_MS = 400;                     // 进度回调节流
    var MAX_TEXT_CHARS = 2 * 1024 * 1024;               // 清单文本缓存上限
    var TEXT_MEM_CACHE_MAX = 20;                        // 清单文本内存缓存条数
    var FAKE_CACHED_SPEED_BPS = 3 * 1000 * 1000;        // 命中回调的合成加载速率：贴近真实链路吞吐（实测约2.4Mbps）。
                                                        // 若虚高（如8Mbps）会喂高 hls.js ABR 带宽估计 → 自动切到更高清
                                                        // 晰度档 → 该档分片未缓存/真实带宽撑不住 → 卡顿 → 降档 → 再升档…
                                                        // 形成 ABR 振荡；3Mbps 配合升档系数0.7可稳定锁在当前档
    var DOWNLOAD_FAIL_LIMIT = 5;                        // 连续失败次数上限
    var EVICT_EVERY_N_WRITES = 25;                      // 每 N 次写穿透触发一次 LRU 检查

    // ===== 模块状态 =====
    var state = {
        inited: false,
        disabled: false,
        db: null,
        opts: {},
        currentKey: null,
        cachedFragKeys: new Set(),  // 当前 videoKey 已缓存的分片完整键
        inflightPlayback: new Set(),// 播放器正在网络加载的分片键（下载器避让）
        textMemCache: new Map(),    // url -> 清单文本（热点免 IDB）
        session: defaultSession(),
        abortCtrl: newAbortCtrl(),
        builtClasses: new WeakMap(),
        pendingReads: new Map(),
        speedWindow: [],            // 近 10s 预取字节样本 {t, bytes}（速度统计）
        metaMem: null,              // 当前 videoKey 的 meta 内存副本
        seedPromise: null,          // 已缓存键集合预载 promise（rebuildQueue 需等待）
        toastShownDisabled: false,
        writesSinceEvict: 0,
        failedDeletes: new Set(),   // 自动删除失败的 videoKey（等待巡检重试）
        pumpInflight: new Map(),    // key -> 预取在途下载 promise（播放单飞合并：等它落库而非重复建连）
        loaderStats: { entry: 0, hit: 0, bypass: 0 } // loader 观测：进入/命中/旁路计数（面板可见，验证缓存是否真在服务播放）
    }
    var dbPromise = null;
    var metaPromise = null;
    var metaChain = Promise.resolve();
    var flushTimer = null;
    var notifyTimer = null;
    var housekeepTimer = null;
    var deleteFailToastAt = 0;

    function defaultSession() {
        return {
            state: 'idle',           // idle | running | done | failed
            paused: false,
            total: 0,
            frags: [],               // 当前清晰度分片列表（含解析好的 start/end 时间）
            levelKeys: new Set(),    // 当前清晰度全部分片键
            levelCached: new Set(),  // 其中已缓存的键
            downloading: new Set(),  // 下载器在途分片键
            inflight: 0,
            failStreak: 0,
            failedAt: 0             // 进入 failed 态的时间戳（PUMP_RETRY_DELAY_MS 后自动复活）
        };
    }

    function newAbortCtrl() {
        return (typeof AbortController !== 'undefined') ? new AbortController() : null;
    }
    function isAborted() {
        return !state.abortCtrl || state.abortCtrl.signal.aborted;
    }

    // ===== 通用工具 =====
    function toast(msg, type) {
        var cb = state.opts.toast;
        if (typeof cb === 'function') { try { cb(msg, type); return; } catch (e) { } }
        if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
            try { window.showToast(msg, type); } catch (e) { }
        }
    }

    function isQuotaError(e) {
        if (!e) return false;
        return e.name === 'QuotaExceededError' || /quota/i.test(String(e.message || e));
    }

    // 设置开关：自动缓存（默认开启）。关闭时新会话默认挂起，可在缓存面板手动"继续"
    function autoCacheEnabled() {
        if (typeof state.opts.getAutoCache === 'function') {
            try { return state.opts.getAutoCache() !== false; } catch (e) { }
        }
        return true;
    }

    function fmtBytes(n) {
        if (!isFinite(n) || n <= 0) return '0 B';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
        return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    function fmtTime(ts) {
        if (!ts) return '';
        var d = new Date(ts);
        function p(x) { return (x < 10 ? '0' : '') + x; }
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ===== 键格式 =====
    // 分片：'f\0' + videoKey + '\0' + url [+ '\0' + rs '-' re]
    // 文本：'t\0' + url
    // 范围归一化：hls.js 1.6+ 非 BYTERANGE 分片的请求 context 会带 rangeStart=0/rangeEnd=0，
    // 而 details.fragments（预取队列来源）的 rangeStart 是 undefined——两者语义相同（无范围）
    // 但键形式不同（…url\00-0 vs …url），播放与预取将永远互相读不到对方的缓存。
    // 这里统一折叠：0/0（或 0/缺省）视为无范围；真实 BYTERANGE（如 0-999）原样保留。
    function normRangeValues(rs, re) {
        if (rs == null) return [null, null];
        if (rs === 0 && (re == null || re === 0)) return [null, null];
        return [rs, re != null ? re : null];
    }
    function fragmentKey(url, rs, re) {
        var norm = normRangeValues(rs, re);
        var k = 'f\u0000' + (state.currentKey || '') + '\u0000' + url;
        if (norm[0] != null) k += '\u0000' + norm[0] + '-' + (norm[1] != null ? norm[1] : '');
        return k;
    }
    function textKey(url) {
        return 't\u0000' + url;
    }

    // ===== IndexedDB 存储层 =====
    function ensureDB() {
        if (state.db) return Promise.resolve(state.db);
        if (dbPromise) return dbPromise;
        if (typeof indexedDB === 'undefined') return Promise.reject(new Error('no-idb'));
        dbPromise = new Promise(function (resolve, reject) {
            var req;
            try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(STORE_FRAGS)) {
                    var sf = db.createObjectStore(STORE_FRAGS, { keyPath: 'k' });
                    sf.createIndex('videoKey', 'videoKey', { unique: false });
                    // vsize 复合索引用于零成本对账：getAllKeys 只读键路径，不反序列化 ArrayBuffer
                    sf.createIndex('vsize', ['videoKey', 'size'], { unique: false });
                }
                if (!db.objectStoreNames.contains(STORE_TEXTS)) {
                    var st = db.createObjectStore(STORE_TEXTS, { keyPath: 'k' });
                    st.createIndex('videoKey', 'videoKey', { unique: false });
                    st.createIndex('vsize', ['videoKey', 'size'], { unique: false });
                }
                if (!db.objectStoreNames.contains(STORE_META)) {
                    db.createObjectStore(STORE_META, { keyPath: 'videoKey' });
                }
            };
            req.onsuccess = function () { state.db = req.result; resolve(req.result); };
            req.onerror = function () { reject(req.error || new Error('idb-open-failed')); };
            req.onblocked = function () { reject(new Error('idb-blocked')); };
        }).catch(function (e) { throw e; }); // 失败同样缓存（隐私模式等场景避免反复重试打开）
        return dbPromise;
    }

    function idbReq(r) {
        return new Promise(function (resolve, reject) {
            r.onsuccess = function () { resolve(r.result); };
            r.onerror = function () { reject(r.error || new Error('idb-error')); };
        });
    }

    function txWrite(db, stores, fn) {
        return new Promise(function (resolve, reject) {
            var tx;
            try { tx = db.transaction(stores, 'readwrite'); fn(tx); } catch (e) { reject(e); return; }
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error || new Error('tx-error')); };
            tx.onabort = function () { reject(tx.error || new Error('tx-abort')); };
        });
    }

    // 加载（必要时创建）当前 videoKey 的 meta
    function ensureMetaLoaded() {
        if (!state.currentKey) return Promise.reject(new Error('no-key'));
        if (state.metaMem && state.metaMem.videoKey === state.currentKey) return Promise.resolve(state.metaMem);
        if (metaPromise) return metaPromise;
        metaPromise = ensureDB().then(function (db) {
            return idbReq(db.transaction(STORE_META).objectStore(STORE_META).get(state.currentKey));
        }).then(function (m) {
            if (!m) {
                var vm = null;
                try { vm = typeof state.opts.getVideoMeta === 'function' ? state.opts.getVideoMeta() : null; } catch (e) { }
                vm = vm || {};
                m = {
                    videoKey: state.currentKey,
                    title: vm.title || '未知内容',
                    episodeLabel: vm.episodeLabel || '',
                    sourceName: vm.sourceName || '',
                    bytes: 0,
                    frags: 0,
                    total: 0,
                    lastAccess: Date.now(),
                    updated: Date.now()
                };
            }
            state.metaMem = m;
            return m;
        }).finally(function () { metaPromise = null; });
        return metaPromise;
    }

    function touchMeta() {
        if (state.metaMem) {
            state.metaMem.lastAccess = Date.now();
            flushMeta();
        }
    }

    // meta 变更串行化写库（避免并发丢失更新）
    function metaWriteTx(fn) {
        var p = metaChain.then(function () {
            return ensureMetaLoaded().then(function (base) {
                return fn(base);
            });
        });
        metaChain = p.catch(function () { });
        return p;
    }

    function putFragTx(rec) {
        // 快路径：meta 以内存副本为基准增量更新，省去每分片一次 meta 读库
        // （metaMem 由 setVideoKey 预载，写入链串行保证基准总是最新）；未就绪时走读库兜底
        function doWrite(base) {
            var updated = Object.assign({}, base, {
                bytes: base.bytes + rec.size,
                frags: base.frags + 1,
                lastAccess: Date.now(),
                updated: Date.now()
            });
            return ensureDB().then(function (db) {
                return txWrite(db, [STORE_FRAGS, STORE_META], function (tx) {
                    tx.objectStore(STORE_FRAGS).put(rec);
                    tx.objectStore(STORE_META).put(updated);
                }).then(function () {
                    state.metaMem = updated;
                    // 速度统计：滑动 10s 窗口（供缓存面板展示"预取速度"）
                    var nowTs = Date.now();
                    state.speedWindow.push({ t: nowTs, bytes: rec.size });
                    while (state.speedWindow.length && nowTs - state.speedWindow[0].t > 10000) {
                        state.speedWindow.shift();
                    }
                    state.writesSinceEvict++;
                    if (state.writesSinceEvict >= EVICT_EVERY_N_WRITES) {
                        state.writesSinceEvict = 0;
                        evictIfNeeded();
                    }
                });
            });
        }
        if (state.metaMem && state.metaMem.videoKey === state.currentKey) {
            var p = metaChain.then(function () {
                return doWrite(state.metaMem);
            });
            metaChain = p.catch(function () { });
            return p;
        }
        return metaWriteTx(doWrite);
    }

    function putTextTx(key, url, text) {
        return metaWriteTx(function (base) {
            var rec = { k: key, videoKey: state.currentKey, url: url, data: text, size: text.length, ts: Date.now() };
            var updated = Object.assign({}, base, {
                bytes: base.bytes + rec.size,
                lastAccess: Date.now(),
                updated: Date.now()
            });
            return ensureDB().then(function (db) {
                return txWrite(db, [STORE_TEXTS, STORE_META], function (tx) {
                    tx.objectStore(STORE_TEXTS).put(rec);
                    tx.objectStore(STORE_META).put(updated);
                }).then(function () {
                    state.metaMem = updated;
                });
            });
        });
    }

    function flushMeta() {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (!state.metaMem || !state.db) return;
        var m = Object.assign({}, state.metaMem);
        var db = state.db;
        txWrite(db, [STORE_META], function (tx) {
            tx.objectStore(STORE_META).put(m);
        }).catch(function () { });
    }
    function scheduleFlush() {
        if (!flushTimer) flushTimer = setTimeout(function () { flushTimer = null; flushMeta(); }, 3000);
    }

    function collectPrimaryKeys(db, store, indexName, keyValue) {
        return new Promise(function (resolve, reject) {
            var out = [];
            var req = db.transaction(store).objectStore(store).index(indexName).openKeyCursor(keyValue);
            req.onsuccess = function () {
                var cur = req.result;
                if (!cur) { resolve(out); return; }
                out.push(cur.primaryKey);
                cur.continue();
            };
            req.onerror = function () { reject(req.error); };
        });
    }

    function deleteVideoEntries(key, db) {
        return Promise.all([
            collectPrimaryKeys(db, STORE_FRAGS, 'videoKey', key),
            collectPrimaryKeys(db, STORE_TEXTS, 'videoKey', key)
        ]).then(function (res) {
            return txWrite(db, [STORE_FRAGS, STORE_TEXTS, STORE_META], function (tx) {
                res[0].forEach(function (k) { tx.objectStore(STORE_FRAGS).delete(k); });
                res[1].forEach(function (k) { tx.objectStore(STORE_TEXTS).delete(k); });
                tx.objectStore(STORE_META).delete(key);
            });
        });
    }

    // LRU + 时间 + 配额淘汰（永不淘汰当前正在播放的视频）
    // 淘汰策略由设置项控制：'lru'（默认）| 'never'（不自动删除，仅提示手动清理）
    // 'lru' 时依次执行三条规则：
    //   1) 只保留最近缓存的 3 个视频，更旧的删除
    //   2) 超过 3 天未访问的一律删除（防止"3 个以内就一直留着"）
    //   3) 总量超过 3GB 时从最旧开始删，直到回到上限内（保证当前集始终有空间继续缓存）
    // aggressive=true（配额写满触发）：解除"保留 3 个"的数量保护，并把目标降到上限的 70%，
    //   从最旧开始删（当前播放的仍受保护），确保当前影视一定能继续缓存
    function evictIfNeeded(aggressive) {
        try {
            if (typeof state.opts.getEvictMode === 'function' && state.opts.getEvictMode() === 'never') {
                return Promise.resolve(); // 用户选择不自动删除
            }
        } catch (e) { }
        return ensureDB().then(function (db) {
            return idbReq(db.transaction(STORE_META).objectStore(STORE_META).getAll());
        }).then(function (metas) {
            if (!metas || metas.length === 0) return;
            metas.sort(function (a, b) { return (b.lastAccess || 0) - (a.lastAccess || 0); });
            var cur = state.currentKey;
            var now = Date.now();
            var byteLimit = aggressive ? Math.floor(CACHE_MAX_TOTAL_BYTES * AGGRESSIVE_BYTE_RATIO) : CACHE_MAX_TOTAL_BYTES;
            var total = metas.reduce(function (s, m) { return s + (m.bytes || 0); }, 0);
            var victims = [];
            if (!aggressive) {
                metas.forEach(function (m, i) {
                    if (m.videoKey === cur || victims.indexOf(m.videoKey) !== -1) return;
                    if (i >= CACHE_KEEP_VIDEOS) { victims.push(m.videoKey); return; }
                    if (now - (m.lastAccess || m.updated || 0) > CACHE_MAX_AGE_MS) victims.push(m.videoKey);
                });
                // 扣除已入选淘汰名单的字节，容量判断基于"本批删除完成后"的实际总量，避免过度删除
                victims.forEach(function (k) {
                    for (var j = 0; j < metas.length; j++) {
                        if (metas[j].videoKey === k) { total -= (metas[j].bytes || 0); break; }
                    }
                });
            }
            for (var i = metas.length - 1; i >= 0 && total > byteLimit; i--) {
                var vk = metas[i].videoKey;
                if (vk === cur || victims.indexOf(vk) !== -1) continue;
                victims.push(vk);
                total -= (metas[i].bytes || 0);
            }
            var chain = Promise.resolve();
            victims.forEach(function (k) {
                if (k === cur) return;
                chain = chain.then(function () {
                    return deleteVideoEntries(k, state.db).then(function () {
                        state.failedDeletes.delete(k);
                    }).catch(function () {
                        // 删除失败不再静默：登记待重试 + 限频提示，等巡检兜底重试
                        state.failedDeletes.add(k);
                        notifyDeleteFailure();
                    });
                });
            });
            return chain;
        }).catch(function () { });
    }

    // 删除失败提示（限频 60 秒一次，避免连发刷屏）
    function notifyDeleteFailure() {
        var now = Date.now();
        if (now - deleteFailToastAt < 60000) return;
        deleteFailToastAt = now;
        toast('部分缓存自动清理失败，稍后将自动重试', 'warning');
    }

    // 重试此前失败的删除（housekeep 巡检时调用）
    function retryFailedDeletes() {
        if (!state.failedDeletes.size || !state.db) return Promise.resolve();
        var keys = Array.from(state.failedDeletes);
        var chain = Promise.resolve();
        keys.forEach(function (k) {
            chain = chain.then(function () {
                return deleteVideoEntries(k, state.db).then(function () {
                    state.failedDeletes.delete(k);
                }).catch(function () { });
            });
        });
        return chain;
    }

    // ===== 惰性兜底巡检：不依赖播放行为，任意页面加载即可执行 =====
    // 顺序：重试失败删除 → 对账修正列表 → 常规淘汰；同时启动低频定时巡检（页面长开时兜底）
    function housekeep() {
        scheduleHousekeep();
        if (state.disabled) return Promise.resolve();
        return ensureDB().then(function () {
            return retryFailedDeletes();
        }).then(function () {
            return reconcile();
        }).then(function () {
            return evictIfNeeded(false);
        }).catch(function () { });
    }

    function scheduleHousekeep() {
        if (housekeepTimer) return;
        housekeepTimer = setTimeout(function () {
            housekeepTimer = null;
            housekeep();
        }, HOUSEKEEP_INTERVAL_MS);
    }

    // ===== 对账（防孤儿核心）：以 vsize 复合索引的真实键统计为准修正 meta =====
    // 注意：必须用 openKeyCursor（cursor.key = 复合键数组，零值反序列化）；
    // index.getAllKeys() 返回的是主键字符串，不能用于按 videoKey/size 统计
    function tallyVsize(db, store) {
        return new Promise(function (resolve, reject) {
            var out = [];
            var req = db.transaction(store).objectStore(store).index('vsize').openKeyCursor();
            req.onsuccess = function () {
                var cur = req.result;
                if (!cur) { resolve(out); return; }
                out.push(cur.key); // [videoKey, size]
                cur.continue();
            };
            req.onerror = function () { reject(req.error); };
        });
    }

    function reconcile() {
        return ensureDB().then(function (db) {
            return Promise.all([
                tallyVsize(db, STORE_FRAGS),
                tallyVsize(db, STORE_TEXTS),
                idbReq(db.transaction(STORE_META).objectStore(STORE_META).getAll())
            ]).then(function (arr) {
                var fragKeys = arr[0] || [], textKeys = arr[1] || [], metaList = arr[2] || [];
                var groups = new Map(); // videoKey -> { bytes, count }
                function acc(keys) {
                    for (var i = 0; i < keys.length; i++) {
                        var pair = keys[i];
                        var vk = pair[0], size = pair[1] || 0;
                        var g = groups.get(vk);
                        if (!g) { g = { bytes: 0, count: 0 }; groups.set(vk, g); }
                        g.bytes += size;
                        g.count++;
                    }
                }
                acc(fragKeys);
                acc(textKeys);

                var byKey = new Map();
                metaList.forEach(function (m) { byKey.set(m.videoKey, m); });
                var allKeys = new Set(Array.from(groups.keys()));
                metaList.forEach(function (m) { allKeys.add(m.videoKey); });

                var result = [];
                var writes = [];
                allKeys.forEach(function (vk) {
                    var g = groups.get(vk);
                    if (!g) {
                        // 空壳 meta（无任何实际数据）：当前会话保留，其余清理
                        if (vk !== state.currentKey) writes.push({ type: 'delMeta', key: vk });
                        return;
                    }
                    var m = byKey.get(vk);
                    var entry = {
                        videoKey: vk,
                        title: (m && m.title) || '未知内容',
                        episodeLabel: (m && m.episodeLabel) || '',
                        sourceName: (m && m.sourceName) || '',
                        bytes: g.bytes,
                        fragCount: g.count,
                        total: (m && m.total) || 0,
                        lastAccess: (m && m.lastAccess) || 0,
                        isCurrent: vk === state.currentKey
                    };
                    entry.complete = entry.total > 0 && g.count >= entry.total;
                    // 实际有、meta 无 → 补建（用户要求：任何占用必须可见可清理）
                    // meta 数值漂移 → 修正
                    if (!m || m.bytes !== g.bytes || m.frags !== g.count) {
                        var mm = m ? Object.assign({}, m) : {
                            videoKey: vk,
                            title: entry.title,
                            episodeLabel: '',
                            sourceName: '',
                            bytes: 0, frags: 0, total: 0,
                            lastAccess: Date.now(), updated: Date.now()
                        };
                        mm.bytes = g.bytes;
                        mm.frags = g.count;
                        mm.updated = Date.now();
                        writes.push({ type: 'putMeta', meta: mm });
                    }
                    result.push(entry);
                });

                if (writes.length) {
                    var chain = ensureDB().then(function (db2) {
                        return txWrite(db2, [STORE_META], function (tx) {
                            var store = tx.objectStore(STORE_META);
                            writes.forEach(function (w) {
                                if (w.type === 'putMeta') store.put(w.meta);
                                else store.delete(w.key);
                            });
                        });
                    });
                    // 同步更新内存副本，避免旧值覆盖
                    writes.forEach(function (w) {
                        if (w.type === 'putMeta' && state.metaMem && w.meta.videoKey === state.metaMem.videoKey) {
                            state.metaMem = w.meta;
                        }
                    });
                    result.sort(function (a, b) { return (b.lastAccess || 0) - (a.lastAccess || 0); });
                    return chain.then(function () { return result; });
                }
                result.sort(function (a, b) { return (b.lastAccess || 0) - (a.lastAccess || 0); });
                return result;
            });
        });
    }

    // ===== 进度通知（节流 + 尾随） =====
    function notifyProgress(force) {
        if (force) {
            if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null; }
            fireNotify();
            return;
        }
        if (notifyTimer) return;
        notifyTimer = setTimeout(function () { notifyTimer = null; fireNotify(); }, PROGRESS_THROTTLE_MS);
    }
    function fireNotify() {
        var cb = state.opts.onProgress;
        if (typeof cb === 'function') {
            try { cb(getSession()); } catch (e) { }
        }
    }

    // ===== 下载会话（位置优先级取件模型） =====
    // 缓存顺序（用户规则）：
    //   1) 优先缓存当前观看位置后 30 秒窗口内缺失的分片
    //   2) 窗口全部入库（闸门打开）后才允许整集缓存：从窗口末尾继续向后，直到本集末尾
    //   3) 本集"后面"全部缓存完后，才回头就近补齐当前位置之前的遗漏
    //   严禁：后面内容没缓存完就去缓存前面/开头的内容（用户可能跳着看，seek 后按新位置重新判定）
    function rebuildQueue(fragments, playlistUrl) {
        // 等待已缓存键集合种子加载完成，避免把已缓存分片误判为未缓存重复下载
        if (state.seedPromise) {
            state.seedPromise.then(function () { rebuildQueue(fragments, playlistUrl); }).catch(function () { });
            return;
        }
        var s = state.session;
        if (!state.currentKey || !fragments || !fragments.length) return;
        // 相对分片地址的解析基准：所属媒体清单的真实 URL（代理形式先解包成源站地址，
        // 否则相对路径会被拼到 /proxy/ 目录下产生双重路径）
        var base = playlistUrl ? unwrapProxiedUrl(playlistUrl) : null;
        s.levelKeys = new Set();
        s.levelCached = new Set();
        s.frags = [];
        var t = 0;
        for (var i = 0; i < fragments.length; i++) {
            var f = fragments[i];
            var url = f && f.url;
            if (!url) continue;
            // 异常形态兜底：相对地址分片按清单目录补全为绝对地址（正常情况下 hls.js 已绝对化）
            if (!/^https?:\/\//i.test(url) && !/^\/proxy\//i.test(url) && base) {
                try { url = new URL(url, base).toString(); } catch (e) { }
            }
            var normFragRange = normRangeValues(f.rangeStart, f.rangeEnd);
            var rs = normFragRange[0];
            var re = normFragRange[1];
            var key = fragmentKey(url, rs, re);
            var dur = (f.duration != null && isFinite(f.duration)) ? f.duration
                : (f.end != null && f.start != null && isFinite(f.end) && isFinite(f.start)) ? (f.end - f.start) : 0;
            var start = (f.start != null && isFinite(f.start)) ? f.start : t;
            var end = (f.end != null && isFinite(f.end)) ? f.end : (start + dur);
            t = end;
            s.levelKeys.add(key);
            if (state.cachedFragKeys.has(key)) s.levelCached.add(key);
            s.frags.push({ key: key, url: url, rs: rs, re: re, start: start, end: end });
        }
        s.total = s.levelKeys.size;
        if (state.metaMem && state.metaMem.total !== s.total) {
            state.metaMem.total = s.total;
            state.metaDirty = true;
            scheduleFlush();
        }
        // done 不再是永久终态：换档（手动切清晰度 / ABR 自动升降档 / 画质模式切换）会把
        // levelKeys 整体重建为新档分片集合。旧档的 done 若不重开泵，新档除"播放路过写穿"
        // 的分片外全部缺失，而面板却按 done 短路恒显 100%（假 100%）——表现为"整集已缓存
        // 完成 ✓"，但 seek 到未缓冲区（回开头/远处）时缓存未命中、回退网络慢加载，与显示
        // 直接矛盾。故：done 且新档仍有缺失 → 重开泵按既有位置优先级补齐（paused 仍尊重）；
        // 新档已完整 → 保持 done 零扰动。failed 态不在此处重开（由泵循环 1s 复活逻辑接管）。
        if (s.state === 'idle' || s.state === 'running' ||
            (s.state === 'done' && s.levelCached.size < s.levelKeys.size)) {
            s.state = 'running';
            pump();
        }
        if (s.frags.length) prewarmHost(s.frags[0].url); // 清单到手立即预热源站建连（蜂窝网首连 1~6s）
        notifyProgress(true);
    }

    function playbackPosition() {
        try {
            if (typeof state.opts.getPlaybackPosition === 'function') {
                var p = state.opts.getPlaybackPosition();
                if (isFinite(p) && p >= 0) return p;
            }
        } catch (e) { }
        return 0;
    }

    // 按位置优先级挑下一个要下载的分片；无任务（或闸门关闭且窗口缺失分片都在播放加载中）返回 null
    function pickNext() {
        var s = state.session;
        var list = s.frags;
        if (!list || !list.length || !state.currentKey) return null;
        var pos = playbackPosition();
        var winEnd = pos + WINDOW_SECONDS;
        var i, f, key;

        // 阶段一：当前观看位置后 30 秒窗口（必须最优先，闸门未开时仅允许下载这里）
        for (i = 0; i < list.length; i++) {
            f = list[i];
            if (f.end <= pos) continue;
            if (f.start >= winEnd) break;
            key = f.key;
            if (state.cachedFragKeys.has(key)) continue;
            if (state.inflightPlayback.has(key) || s.downloading.has(key)) continue; // 播放正在加载/下载器在途
            return f;
        }

        // 闸门：后 30 秒窗口必须全部已缓存，否则严禁整集缓存
        for (i = 0; i < list.length; i++) {
            f = list[i];
            if (f.end <= pos) continue;
            if (f.start >= winEnd) break;
            if (!state.cachedFragKeys.has(f.key)) return null; // 窗口未缓存完 → 禁止向后/向前缓存
        }

        // 阶段二：窗口之后继续向后缓存，直到本集末尾（升序）
        for (i = 0; i < list.length; i++) {
            f = list[i];
            if (f.start < winEnd) continue;
            key = f.key;
            if (state.cachedFragKeys.has(key)) continue;
            if (state.inflightPlayback.has(key) || s.downloading.has(key)) continue;
            return f;
        }

        // 阶段三：后面已全部缓存完 → 就近向前检测并补齐当前位置之前的遗漏（降序）
        for (i = list.length - 1; i >= 0; i--) {
            f = list[i];
            if (f.end > pos) continue;
            key = f.key;
            if (state.cachedFragKeys.has(key)) continue;
            if (state.inflightPlayback.has(key) || s.downloading.has(key)) continue;
            return f;
        }
        return null;
    }

    // 预取并发额度：按播放"真实秒"缓冲余量动态收缩（runway = 媒体秒余量 / 倍速）。
    // 暂停或余量充足 → 最高并行全速预取；余量走低 → 收缩但永不归零。
    // 旧版"濒临卡顿全让路(0)"在高延迟网络（蜂窝）形成死亡螺旋：余量低→停预取→
    // 播放只能串行取件（hls 主路径一次一个分片，单连接 TTFB 高）→ 补充速度追不上
    // 消耗 → 余量永远起不来 → 持续卡顿；WiFi 单连接足够快会自愈，掩盖了问题。
    // 余量不足时唯一能把余量拉起来的恰恰是并行预取（写透后播放秒读缓存）。
    // 保底从 3 上调至 5：泵的分片经 inflightPlayback 排除 + 单飞合并，永远不会与
    // 播放器正在取的分片重复，加并发不抢"同一个分片"，只摊薄管道份额——保底 5 在
    // 恢复速度与播放关键分片的带宽份额（1/(N+1)）之间取平衡，弱网仍有界不失控。
    function targetConcurrency() {
        var runway;
        try {
            runway = typeof state.opts.getPlaybackRunway === 'function' ? state.opts.getPlaybackRunway() : 20;
        } catch (e) { runway = 20; }
        if (!isFinite(runway) || runway >= 30) return PREFETCH_CONCURRENCY_MAX; // 暂停/余量充足：全速预取
        if (runway >= 12) return 10;
        if (runway >= 6) return 6;
        return 5; // 濒临卡顿：保底窗口预取，帮助余量回升
    }

    // 预取节奏定时器：缓冲余量随播放持续变化，仅靠"下载完成/seek"触发 pump 不够——
    // 余量跌到 0 让路后再回升时，需要有人重新拉起取件。1.5s 轮询开销可忽略
    var pumpLoopTimer = null;
    function startPumpLoop() {
        if (pumpLoopTimer) return;
        pumpLoopTimer = setInterval(function () {
            if (state.disabled || !state.inited) return;
            var s = state.session;
            // failed 态也必须进 pump：复活判断在 pump 内部，若在这里拦截，
            // 全部在途请求错误返回后无人再触发 pump，失败态会卡死远超退避时长
            if (!s.paused && (s.state === 'running' || s.state === 'idle' || s.state === 'failed')) pump();
        }, 1500);
    }

    function pump() {
        var s = state.session;
        if (state.disabled) return;
        // 失败态自愈：连续失败停转 PUMP_RETRY_DELAY_MS(1s) 后自动复活重试
        //（网络波动造成的批量失败不该让缓存长期停摆；配额导致的失败会同时置 paused，不会走到这里）
        if (s.state === 'failed' && !s.paused && s.failedAt && Date.now() - s.failedAt > PUMP_RETRY_DELAY_MS) {
            s.state = 'running';
            s.failStreak = 0;
            s.failedAt = 0;
        }
        var cap = targetConcurrency();
        while (!s.paused && s.state !== 'failed' && !isAborted() && s.inflight < cap) {
            // 必须 let：finally 回调异步执行，var 共享绑定会删错 key（历史隐患）
            let item = pickNext();
            if (!item) { maybeFinish(); return; }
            s.inflight++;
            s.downloading.add(item.key);
            let p = runDownload(item).finally(function () {
                s.inflight--;
                s.downloading.delete(item.key);
                state.pumpInflight.delete(item.key);
                maybeFinish();
                notifyProgress();
                pump();
            });
            // 记录在途 promise：播放 loader 对同分片缓存未命中时等待它落库（单飞合并），
            // 而不是自己再建一条连接重复下载（蜂窝网高 TTFB 下双重浪费 + 抢关键路径带宽）
            state.pumpInflight.set(item.key, p);
        }
    }

    function maybeFinish() {
        var s = state.session;
        if (s.inflight || s.paused || s.state !== 'running') return;
        if (s.total > 0 && s.levelCached.size >= s.total) {
            s.state = 'done';
            flushMeta();
            toast('本集已全部缓存完成 ✓', 'success');
            notifyProgress(true);
        }
    }

    // ===== 直连加速（镜像整集下载器 robustFetch 思路） =====
    // 采集站分片 CDN 国内直连通常远快于 Cloudflare 跨境代理；预取与播放未命中缓存时
    // 均先试直连源站，CORS/混合内容/网络失败自动回退代理路径。
    // 按主机记忆直连失败（死源 10 分钟内不再试直连），避免反复空等拖慢取件
    var directHostFails = new Map(); // host -> 直连失败截止时间戳

    function unwrapProxiedUrl(rawUrl) {
        var out = rawUrl;
        // 循环解包：防御 /proxy//proxy/… 嵌套包装与双重编码（解出一层后仍是代理形式则继续）
        for (var i = 0; i < 3; i++) {
            try {
                var u = new URL(out, location.href);
                if (u.origin === location.origin && u.pathname.indexOf('/proxy/') === 0) {
                    var inner = decodeURIComponent(u.pathname.slice('/proxy/'.length));
                    if (/^https?:\/\//i.test(inner)) { out = inner; continue; }
                    // 双重编码形态：内层仍是 %xx 编码的绝对地址
                    var dec = decodeURIComponent(inner);
                    if (dec !== inner && /^https?:\/\//i.test(dec)) { out = dec; continue; }
                }
            } catch (e) { }
            break;
        }
        return out;
    }

    // 折叠绝对 URL 路径中连续重复的目录段（/url_8/url_8/ → /url_8/）。
    // 来源：绝对地址分片被再次当作相对路径拼接（清单双层解析/代理双重写）产生的双重路径，
    // 这类 URL 源站一律 404/中止（日志中的 ERR_ABORTED）。
    // 仅处理 http(s) 绝对地址；相对路径原样返回。
    function collapseDupPath(url) {
        if (!/^https?:\/\//i.test(url)) return url;
        try {
            var u = new URL(url);
            var before = u.pathname;
            var collapsed = before;
            while (true) {
                // 大小写敏感匹配：URL 路径区分大小写，双重路径由同一逻辑生成必然同形
                var next = collapsed.replace(/\/([^/]+)\/\1(?=\/|$)/g, '/$1');
                if (next === collapsed) break;
                collapsed = next;
            }
            if (collapsed !== before) u.pathname = collapsed;
            return u.toString();
        } catch (e) { return url; }
    }

    function isHostBlocked(url) {
        try {
            var failUntil = directHostFails.get(new URL(unwrapProxiedUrl(url)).host) || 0;
            return Date.now() < failUntil;
        } catch (e) { return false; }
    }

    function markDirectFail(url, failMs) {
        var ms = failMs || DIRECT_HOST_FAIL_MS;
        try { directHostFails.set(new URL(unwrapProxiedUrl(url)).host, Date.now() + ms); } catch (e) { }
    }

    // 建连预热：提前完成 DNS+TCP+TLS（收到响应头即中止，不消耗分片带宽）。
    // 蜂窝网首连要 1~6s，预热后真实分片请求直接复用连接池/DNS 缓存/TLS 会话票据，
    // 首字节看门狗不再被冷启动吃掉。按 host 节流。
    var prewarmTracker = new Map(); // host -> 上次预热截止时间戳
    function prewarmHost(url) {
        var inner = unwrapProxiedUrl(url);
        try {
            var u = new URL(inner, location.href);
            if (u.origin === location.origin) return; // 同源（本地文件等）无需预热
            if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
            var now = Date.now();
            if ((prewarmTracker.get(u.host) || 0) > now) return;
            prewarmTracker.set(u.host, now + PREWARM_INTERVAL_MS);
            var xhr = new XMLHttpRequest();
            try { xhr.open('GET', u.href, true); xhr.responseType = 'arraybuffer'; } catch (e) { return; }
            xhr.onreadystatechange = function () {
                if (xhr.readyState >= 2) { // HEADERS_RECEIVED：建连已完成，目的达到
                    try { xhr.abort(); } catch (e) { }
                }
            };
            setTimeout(function () { try { xhr.abort(); } catch (e) { } }, 5000); // 兜底中止
            xhr.send();
        } catch (e) { }
    }

    function prewarmCurrentHost() {
        try {
            var frags = state.session && state.session.frags;
            if (frags && frags.length && frags[0].url) prewarmHost(frags[0].url);
        } catch (e) { }
    }

    // ===== 关键路径竞速兜底（设置开关默认关闭）=====
    // 场景：直连"慢但在流"（停滞看门狗不触发），缓冲被拖干。触发时代理并行竞速，
    // 先到先用。竞速期间始终双管道并行、赢家产生后立即掐掉输家，
    // 无单腿省流量机制（软偏置已按用户要求整体移除）。
    var raceWinToastShown = false; // 竞速首次获胜的提示只弹一次（用户可见反馈）
    var raceTriggerToastShown = false; // 竞速首次触发的提示只弹一次（可观测性：区分"没触发"和"触发了没赢"）

    function raceHedgeEnabled() {
        try {
            return typeof state.opts.getRaceHedge === 'function' && state.opts.getRaceHedge() === true;
        } catch (e) { return false; }
    }

    function runwaySeconds() {
        try {
            var r = typeof state.opts.getPlaybackRunway === 'function' ? state.opts.getPlaybackRunway() : Infinity;
            return isFinite(r) ? r : Infinity;
        } catch (e) { return Infinity; }
    }

    // 网络环境变化（WiFi↔流量切换、断网恢复）时直连可达性会整体翻转，
    // 清空失败记忆立即重探直连，避免旧网络下的黑名单拖累新网络；
    // 同时重新预热建连（蜂窝网切换后 IP/链路全变，旧连接全部作废）
    function resetDirectFails() {
        if (directHostFails.size) directHostFails.clear();
        prewarmCurrentHost();
    }
    try {
        window.addEventListener('online', resetDirectFails);
        var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (conn && typeof conn.addEventListener === 'function') {
            conn.addEventListener('change', resetDirectFails);
        }
    } catch (e) { }

    // 流感知直连取分片（替代旧版"总时长 3.5s 看门狗"）：
    // - 首字节看门狗：连接建立阶段限时 FRAG_DIRECT_TTFB_MS，超时判"连不上"→ 失败
    // - 停滞看门狗：出流后连续 FRAG_DIRECT_STALL_MS 无新字节才判连接僵死 → 失败
    // 首字节到达后不再限制总时长：慢但在流的连接（蜂窝网常见）允许跑完，
    // 由 hls.js ABR 自行降档适配带宽，而不是误杀直连锁进更慢的跨境代理
    function directXhrLoad(url, headers, responseType, onSuccess, onFail) {
        var xhr = new XMLHttpRequest();
        var startTs = performance.now();
        var firstByteAt = 0;
        var settled = false;
        var stallTimer = null;
        function clearTimers() {
            clearTimeout(ttfbTimer);
            if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        }
        var ttfbTimer = setTimeout(function () {
            if (settled || firstByteAt) return;
            settled = true;
            try { xhr.abort(); } catch (e) { }
            clearTimers();
            onFail('ttfb');
        }, FRAG_DIRECT_TTFB_MS);
        function armStall() {
            if (stallTimer) clearTimeout(stallTimer);
            stallTimer = setTimeout(function () {
                if (settled) return;
                settled = true;
                try { xhr.abort(); } catch (e) { }
                clearTimers();
                onFail('stall');
            }, FRAG_DIRECT_STALL_MS);
        }
        try { xhr.open('GET', url, true); xhr.responseType = responseType || 'arraybuffer'; } catch (e) { onFail('network'); return xhr; }
        if (headers) for (var h in headers) { try { xhr.setRequestHeader(h, headers[h]); } catch (e) { } }
        xhr.onprogress = function () {
            if (settled) return;
            if (!firstByteAt) {
                firstByteAt = performance.now();
                clearTimeout(ttfbTimer);
            }
            armStall();
        };
        xhr.onload = function () {
            if (settled) return;
            settled = true;
            clearTimers();
            if (xhr.status >= 200 && xhr.status < 300) {
                var endTs = performance.now();
                var data = xhr.response;
                var size = data ? (data.byteLength != null ? data.byteLength : data.length) : 0;
                // stats 形状与 serveFromCache 一致：hls.js 读取 loading 嵌套字段做 ABR 采样，缺失会抛 TypeError
                var stats = {
                    aborted: false,
                    loaded: size,
                    retry: 0,
                    total: size,
                    chunkCount: 1,
                    bwEstimate: 0,
                    loading: { start: startTs, first: firstByteAt || endTs, end: endTs },
                    parsing: { start: endTs, end: endTs },
                    buffer: { start: 0, end: 0 }
                };
                onSuccess({ url: url, data: data }, stats);
            } else {
                onFail('http' + xhr.status);
            }
        };
        xhr.onerror = function () {
            if (settled) return;
            settled = true;
            clearTimers();
            onFail('network');
        };
        xhr.onabort = function () {
            // 看门狗主动 abort（已 settled）或上层 loader.abort()（seek/换档，静默丢弃）
            if (settled) return;
            settled = true;
            clearTimers();
        };
        try { xhr.send(); } catch (e) {
            if (!settled) { settled = true; clearTimers(); onFail('network'); }
        }
        return xhr;
    }

    // 带空闲看门狗 + 会话中止联动的单次 fetch：
    // 原实现为 FRAG_FETCH_TIMEOUT_MS 总超时——蜂窝网等慢速链路上，12 路并发摊薄带宽后单连接
    // 只剩几十 KB/s，大分片远超 20s 才能下完 → "慢但在流"的连接被误杀 → 直连失败记账 → 黑名单
    // → 转更慢的代理 → 连续失败 → 泵停转（面板百分比消失、网速归零、缓存永远追不上播放）。
    // 改为：响应头阶段限时 FRAG_FETCH_TIMEOUT_MS；出流后只要字节持续到达就无总限，
    // 连续 PUMP_FETCH_IDLE_MS 无新字节才判卡死中止（与整集下载器的 IDLE_TIMEOUT 策略一致）。
    // 返回兼容 Response 形状（ok/status/arrayBuffer），调用方无感。
    function fetchWithTimeout(url, headers) {
        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        if (ctrl && state.abortCtrl && !state.abortCtrl.signal.aborted) {
            try {
                state.abortCtrl.signal.addEventListener('abort', function () {
                    try { ctrl.abort(); } catch (e) { }
                }, { once: true });
            } catch (e) { }
        }
        var headerTimer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, FRAG_FETCH_TIMEOUT_MS) : null;
        function clearTimers() { if (headerTimer) { clearTimeout(headerTimer); headerTimer = null; } }
        return fetch(url, { signal: ctrl ? ctrl.signal : state.abortCtrl.signal, headers: headers, credentials: 'omit' })
            .then(function (res) {
                if (!res.ok) {
                    clearTimers();
                    var httpErr = new Error('HTTP ' + res.status);
                    httpErr.status = res.status;
                    throw httpErr;
                }
                // 无流式读取能力（老浏览器）→ 退回总超时语义
                if (!res.body || typeof res.body.getReader !== 'function') {
                    var legacyTimer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, FRAG_FETCH_TIMEOUT_MS) : null;
                    return res.arrayBuffer().then(function (buf) {
                        return { ok: true, status: res.status, arrayBuffer: function () { return Promise.resolve(buf); } };
                    }).finally(function () { if (legacyTimer) clearTimeout(legacyTimer); });
                }
                clearTimers();
                var idleTimer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, PUMP_FETCH_IDLE_MS) : null;
                function armIdle() {
                    if (idleTimer) { clearTimeout(idleTimer); idleTimer = setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, PUMP_FETCH_IDLE_MS); }
                }
                var reader = res.body.getReader();
                var chunks = [];
                var received = 0;
                var settled = false;
                return new Promise(function (resolve, reject) {
                    function finish() {
                        if (settled) return;
                        settled = true;
                        if (idleTimer) clearTimeout(idleTimer);
                        var buf = new Uint8Array(received);
                        var off = 0;
                        for (var i = 0; i < chunks.length; i++) { buf.set(chunks[i], off); off += chunks[i].length; }
                        resolve({
                            ok: true,
                            status: res.status,
                            arrayBuffer: function () { return Promise.resolve(buf.buffer); }
                        });
                    }
                    function readNext() {
                        if (settled) return;
                        reader.read().then(function (r) {
                            if (settled) return;
                            if (r.done) { finish(); return; }
                            chunks.push(r.value);
                            received += r.value.length;
                            armIdle();
                            readNext();
                        }, function (e) {
                            if (settled) return;
                            settled = true;
                            if (idleTimer) clearTimeout(idleTimer);
                            reject(e);
                        });
                    }
                    readNext();
                });
            }, function (e) {
                clearTimers();
                throw e;
            });
    }

    // 泵失败态登记：约 2s 后由泵循环自动复活重试（缓存近乎不间断）
    function markPumpFailed(s) {
        if (s.state === 'running') {
            s.state = 'failed';
            s.failedAt = Date.now();
        }
    }

    function runDownload(item) {
        var s = state.session;
        // 本下载所属会话的中止控制器：换集/换源时 setVideoKey→abortDownload 会 abort 旧控制器
        // 并换上新控制器——此后本下载的重试若继续用新控制器，会变成僵尸下载
        // （蜂窝网上 12 路僵尸代理请求最长各占 20s+，把细管道挤死 → 新集泵/播放批量失败）
        var myCtrl = state.abortCtrl;
        // 会话已切换或本控制器已中止：立即终止，不重试、不计失败
        function isSessionGone() {
            return myCtrl !== state.abortCtrl || myCtrl.signal.aborted;
        }
        // 并发额度（targetConcurrency）已在 pump 入口统一把关：余量不足时不会再启动新取件，
        // 已在途的少量请求让其自然完成（避免反复中止造成 churn）
        return (function () {
            if (isAborted()) return Promise.resolve(); // 主动中止：不计失败
            if (s.paused || s.state === 'failed') return Promise.resolve(); // 暂停/失败时丢弃，恢复后由 pickNext 重新挑起
            if (state.cachedFragKeys.has(item.key)) return Promise.resolve();
            var headers = item.rs != null
                ? { Range: 'bytes=' + item.rs + '-' + (item.re != null ? (item.re - 1) : '') }
                : undefined;
            // 直连优先（两种 URL 形态统一）：
            // - /proxy/ 形式：解包源站直连 → 回退代理 URL
            // - 源站绝对地址（清单直连获取的常态）：URL 本身即直连 → 回退 /proxy/ 包装（此前无兜底）
            // unwrap 循环解包嵌套/双重编码代理；collapseDupPath 折叠"绝对地址被再拼一次"产生的
            // 连续重复目录段（…/url_8/url_8/xxx.ts），这类双重路径源站必然 404/中止（ERR_ABORTED）
            // 注意：代理形态判定必须基于解包结果而非折叠结果，两者互不干扰
            var rawUnwrapped = unwrapProxiedUrl(item.url);
            var unwrapped = collapseDupPath(rawUnwrapped);
            var attempts;
            if (rawUnwrapped !== item.url) {
                attempts = isHostBlocked(item.url) ? [item.url] : [unwrapped, item.url];
            } else if (/^https?:\/\//i.test(item.url)) {
                var directUrl = collapseDupPath(item.url);
                if (isHostBlocked(item.url)) {
                    attempts = ['/proxy/' + encodeURIComponent(item.url)];
                } else if (directUrl !== item.url) {
                    attempts = [directUrl, item.url, '/proxy/' + encodeURIComponent(directUrl)];
                } else {
                    attempts = [item.url, '/proxy/' + encodeURIComponent(item.url)];
                }
            } else {
                attempts = [item.url];
            }
            function attemptFetch(i) {
                var url = attempts[i];
                if (isSessionGone()) return Promise.reject(new Error('session-switched'));
                return fetchWithTimeout(url, headers).then(function (res) {
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    return res;
                }).catch(function (e) {
                    if (isAborted() || isSessionGone()) throw e; // 会话已切换：立即终止，不做下一段尝试
                    if (i === 0 && attempts.length > 1) markDirectFail(item.url); // 直连失败记账
                    if (i + 1 < attempts.length) return attemptFetch(i + 1);
                    throw e;
                });
            }
            return attemptFetch(0).then(function (res) {
                return res.arrayBuffer().then(function (buf) {
                    // 少数源对 Range 返回 200 全量内容时截取对应区间，保证缓存内容正确
                    if (item.rs != null && res.status === 200 && item.re != null && buf.byteLength > item.re) {
                        buf = buf.slice(item.rs, item.re);
                    }
                    return putFragSafe(item.key, item.url, item.rs, item.re, buf).then(function (ok) {
                        if (ok) {
                            s.failStreak = 0;
                            state.cachedFragKeys.add(item.key);
                            if (s.levelKeys.has(item.key)) s.levelCached.add(item.key);
                        } else {
                            s.failStreak++;
                            markPumpFailed(s);
                        }
                    });
                });
            });
        })().catch(function () {
            // 会话已切换（换集）：旧下载的中止/失败不计入任何会话的失败统计
            if (isAborted() || isSessionGone()) return;
            s.failStreak++;
            markPumpFailed(s);
        });
    }

    function putFragSafe(key, url, rs, re, buf) {
        var rec = {
            k: key, videoKey: state.currentKey, url: url,
            rs: rs != null ? rs : null, re: re != null ? re : null,
            data: buf, size: buf.byteLength, ts: Date.now()
        };
        return putFragTx(rec).then(function () { return true; }).catch(function (e) {
            if (isQuotaError(e)) {
                // 配额吃紧：激进淘汰（解除"保留3个"保护、目标降到70%）腾出空间，保证当前集能继续缓存
                return evictIfNeeded(true).then(function () {
                    return putFragTx(rec).then(function () { return true; }).catch(function (e2) {
                        if (isQuotaError(e2)) {
                            state.session.state = 'failed';
                            state.session.paused = true;
                            toast('存储空间不足，后台缓存已暂停', 'warning');
                            notifyProgress(true);
                        }
                        return false;
                    });
                });
            }
            return false;
        });
    }

    function downloadGiveUp() {
        var s = state.session;
        markPumpFailed(s);
    }

    // ===== loader（读写穿透） =====
    // 清单文本缓存有效期：manifest 短（保证服务端/上游修复能在数小时内生效，自愈坏清单）；
    // level（VOD 媒体列表）内容不变，可长效缓存
    var MANIFEST_TTL_MS = 6 * 60 * 60 * 1000;      // 6 小时
    var LEVEL_TTL_MS = 7 * 24 * 60 * 60 * 1000;    // 7 天

    function loaderKey(type, ctx) {
        if (type === 'fragment') {
            return fragmentKey(ctx.url, ctx.rangeStart != null ? ctx.rangeStart : null,
                ctx.rangeEnd != null ? ctx.rangeEnd : null);
        }
        return textKey(ctx.url);
    }

    function cachedRead(key, type) {
        if (type !== 'fragment') {
            var url = key.slice(2);
            var mem = state.textMemCache.get(url);
            if (mem !== undefined) return Promise.resolve({ data: mem, size: mem.length });
        }
        var ck = type + '|' + key;
        if (state.pendingReads.has(ck)) return state.pendingReads.get(ck);
        var p = ensureDB().then(function (db) {
            var store = type === 'fragment' ? STORE_FRAGS : STORE_TEXTS;
            return idbReq(db.transaction(store).objectStore(store).get(key));
        }).then(function (rec) {
            if (rec && type !== 'fragment' && typeof rec.data === 'string') {
                // 过期保护：清单文本不允许永久命中。
                // 历史故障期（如代理旧版把多档主列表折叠成单档）写入的坏清单若永久缓存，
                // 即使服务端修复也永远命中坏数据（表现为"源片仅此一档"）。
                // manifest 短 TTL 自愈；level（VOD 媒体列表）内容不变可长效。
                var ttl = type === 'manifest' ? MANIFEST_TTL_MS : LEVEL_TTL_MS;
                if (!rec.ts || Date.now() - rec.ts > ttl) return undefined;
                textMemCacheSet(rec.url || key.slice(2), rec.data);
            }
            return rec; // undefined = 未命中
        }).finally(function () { state.pendingReads.delete(ck); });
        state.pendingReads.set(ck, p);
        return p;
    }

    function textMemCacheSet(url, text) {
        if (state.textMemCache.has(url)) state.textMemCache.delete(url);
        state.textMemCache.set(url, text);
        while (state.textMemCache.size > TEXT_MEM_CACHE_MAX) {
            state.textMemCache.delete(state.textMemCache.keys().next().value);
        }
    }

    // 命中回调：hls.js 对缺失字段/0 时长敏感（会抛 TypeError），必须给完整 LoadStats；
    // 合成加载时长按 FAKE_CACHED_SPEED_BPS 折算，避免 0 耗时命中把 ABR 带宽估计拉爆到顶档
    function serveFromCache(rec, context, callbacks) {
        var now = performance.now();
        var size = rec.size != null ? rec.size
            : (typeof rec.data === 'string' ? rec.data.length : (rec.data ? rec.data.byteLength : 0));
        var dur = Math.max(5, (size / FAKE_CACHED_SPEED_BPS) * 1000);
        var stats = {
            aborted: false,
            loaded: size,
            retry: 0,
            total: size,
            chunkCount: 1,
            bwEstimate: FAKE_CACHED_SPEED_BPS,
            loading: { start: now - dur, first: now - dur, end: now },
            parsing: { start: now, end: now },
            buffer: { start: 0, end: 0 }
        };
        setTimeout(function () {
            try { callbacks.onSuccess({ url: context.url, data: rec.data }, stats, context); } catch (e) { }
        }, 0);
    }

    // 写穿透：网络加载成功后入库。分片数据必须先同步拷贝（hls.js 可能随即 detach 原 buffer）
    function writeThrough(key, type, context, data) {
        if (state.disabled || !state.currentKey) return Promise.resolve();
        if (type === 'fragment') {
            if (!data || !data.byteLength) return Promise.resolve();
            if (state.cachedFragKeys.has(key)) return Promise.resolve();
            var copy = data.slice(0);
            var normRecRange = normRangeValues(context.rangeStart, context.rangeEnd);
            return putFragTx({
                k: key, videoKey: state.currentKey, url: context.url,
                rs: normRecRange[0], re: normRecRange[1], data: copy, size: copy.byteLength, ts: Date.now()
            }).then(function () {
                state.cachedFragKeys.add(key);
                var s = state.session;
                if (s.levelKeys.has(key)) s.levelCached.add(key);
                // 播放加载写入的分片可能正好补完 30 秒窗口（闸门打开）→ 立即重新取件
                notifyProgress();
                pump();
            }).catch(function () { });
        }
        if (typeof data !== 'string' || !data) return Promise.resolve();
        // level 清单仅缓存 VOD（含 ENDLIST）；master manifest 不含 ENDLIST 但内容静态，直接缓存
        if (type === 'level' && data.indexOf('#EXT-X-ENDLIST') === -1) return Promise.resolve();
        if (data.length > MAX_TEXT_CHARS) return Promise.resolve();
        if (state.textMemCache.get(context.url) === data) return Promise.resolve();
        return putTextTx(key, context.url, data).then(function () {
            textMemCacheSet(context.url, data);
        }).catch(function () { });
    }

    function wrapLoader(Base) {
        if (!Base || state.disabled) return Base;
        if (state.builtClasses.has(Base)) return state.builtClasses.get(Base);
        var Cls = (function () {
            try {
                return class VideoCacheLoader extends Base {
                    constructor(config) {
                        super(config);
                        var self = this;
                        var lower = this.load.bind(this); // 捕获 super 安装的 load（可能是广告过滤包装）
                        // 直连 XHR 挂在实例上：hls.js abort（seek/换档）时一并中止，避免僵尸连接
                        var baseAbort = this.abort.bind(this);
                        this.abort = function () {
                            if (self.__directXhr) {
                                try { self.__directXhr.abort(); } catch (e) { }
                                self.__directXhr = null;
                            }
                            return baseAbort();
                        };
                        this.load = function (context, cfg, callbacks) {
                            var t = null;
                            try { t = context && context.type; } catch (e) { }
                            // hls.js 1.6+ 分片 context 不再携带 type 字段（键为 frag|part|responseType|url|...），
                            // 旧逻辑 `context.type === 'fragment'` 永远不成立 → 分片加载全部静默绕过本层：
                            // 缓存永不命中、直连竞速/看门狗全失效（表现为"整集缓存完成仍卡顿、seek 每次数秒"，
                            // WiFi 快网掩盖、蜂窝网暴露）。用 context.frag（分片 context 特有）兜底识别。
                            if (!t && context && context.frag) t = 'fragment';
                            if (t !== 'manifest' && t !== 'level' && t !== 'fragment'
                                || !callbacks || typeof callbacks.onSuccess !== 'function') {
                                state.loaderStats.bypass++;
                                return lower(context, cfg, callbacks);
                            }
                            state.loaderStats.entry++;
                            var key = null;
                            try { key = loaderKey(t, context); } catch (e) { }
                            if (!key) return lower(context, cfg, callbacks);
                            var isFrag = t === 'fragment';
                            // 缓存读取 + 单飞合并：未命中但预取下载器同分片在途时，
                            // 等它落库（上限 PUMP_WAIT_MAX_MS）后直接读缓存秒回，
                            // 避免播放与预取对同一分片重复建连下载（蜂窝网高 TTFB 下双重浪费）
                            function readCacheCoalesced() {
                                return cachedRead(key, t).then(function (rec) {
                                    if (rec || !isFrag) return rec;
                                    var p = state.pumpInflight.get(key);
                                    if (!p) return rec;
                                    // 余量健康才值得等预取在途落库；余量偏低（<RACE_RUNWAY_MAX_S 真实秒）
                                    // 时速度优先——跳过等待直接走直连+竞速路径，否则蜂窝网上预取的
                                    // 慢速直连会拖住播放，且期间竞速层完全不工作（"无感"场景之一）
                                    if (runwaySeconds() < RACE_RUNWAY_MAX_S) return rec;
                                    return Promise.race([
                                        p.catch(function () { return null; }),
                                        new Promise(function (resolve) { setTimeout(function () { resolve(null); }, PUMP_WAIT_MAX_MS); })
                                    ]).then(function () {
                                        return cachedRead(key, t).catch(function () { return undefined; });
                                    });
                                });
                            }
                            readCacheCoalesced().then(function (rec) {
                                if (rec) { state.loaderStats.hit++; serveFromCache(rec, context, callbacks); return; }
                                if (isFrag && state.currentKey) state.inflightPlayback.add(key);
                                var baseOnSuccess = callbacks.onSuccess;
                                var baseOnError = callbacks.onError;
                                var inflightDone = false;
                                function finishInflight() {
                                    if (isFrag && !inflightDone) {
                                        inflightDone = true;
                                        state.inflightPlayback.delete(key);
                                    }
                                }
                                // 成功包装：写穿透入库后回传 hls 核心；ctx/response.url 统一回写为
                                // 原始代理 URL，保证核心侧状态与缓存键一致（直连改写对核心透明）
                                function makeSuccessWrapper() {
                                    return function (response, stats, ctx) {
                                        finishInflight();
                                        try { writeThrough(key, t, context, response && response.data); } catch (e) { }
                                        try { if (response && typeof response === 'object' && response.url !== context.url) response.url = context.url; } catch (e) { }
                                        return baseOnSuccess(response, stats, context);
                                    };
                                }
                                function makeErrorWrapper() {
                                    return function () {
                                        finishInflight();
                                        if (typeof baseOnError === 'function') return baseOnError.apply(null, arguments);
                                    };
                                }
                                // 清单/level 不改写（m3u8 必须经代理逐行重写）→ 原路径
                                if (!isFrag) {
                                    callbacks.onSuccess = makeSuccessWrapper();
                                    callbacks.onError = function () {
                                        finishInflight();
                                        if (typeof baseOnError === 'function') return baseOnError.apply(null, arguments);
                                    };
                                    lower(context, cfg, callbacks);
                                    return;
                                }
                                // 分片路由（两种 URL 形态统一，都进入流感知层）：
                                // - /proxy/ 形式（清单经代理获取）：直连=解包源站地址，代理=原 URL
                                // - 源站绝对地址（清单直连获取的常态）：直连=URL 本身，代理=/proxy/ 包装。
                                //   此前该形态完全绕过流感知层（旧 canTryDirect 对非代理形式恒 false），
                                //   看门狗与竞速兜底对其从未生效——"开关开了没区别"的根因
                                var rawUnwrappedFrag = unwrapProxiedUrl(context.url);
                                var isProxiedForm = rawUnwrappedFrag !== context.url;
                                var unwrappedFrag = collapseDupPath(rawUnwrappedFrag);
                                var proxyUrl;
                                if (isProxiedForm) {
                                    proxyUrl = context.url;
                                } else if (/^https?:\/\//i.test(context.url)) {
                                    proxyUrl = '/proxy/' + encodeURIComponent(unwrappedFrag);
                                } else {
                                    // 非绝对地址（异常形态）：保持原路径
                                    callbacks.onSuccess = makeSuccessWrapper();
                                    callbacks.onError = function () {
                                        finishInflight();
                                        if (typeof baseOnError === 'function') return baseOnError.apply(null, arguments);
                                    };
                                    lower(context, cfg, callbacks);
                                    return;
                                }
                                var proxyCtx = isProxiedForm ? context : Object.assign({}, context, { url: proxyUrl });
                                // 竞速模式（开关开）：黑名单不得锁死播放的直连机会——预取泵的直连失败
                                // 会把 host 拉黑，若黑名单也拦播放，竞速将被静默跳过（"开了没区别"根因之二）。
                                // 竞速模式不做任何单腿短路：始终双管道并行（软偏置机制已移除）
                                var raceOn = raceHedgeEnabled();
                                if (!raceOn && isHostBlocked(context.url)) {
                                    callbacks.onSuccess = makeSuccessWrapper();
                                    callbacks.onError = function () {
                                        finishInflight();
                                        if (typeof baseOnError === 'function') return baseOnError.apply(null, arguments);
                                    };
                                    lower(proxyCtx, cfg, callbacks);
                                    return;
                                }
                                // 直连阶段（流感知 XHR）：看门狗只掐"连不上/传输僵死"，慢但在流允许跑完。
                                // 竞速模式（开关开）：直连+代理【立即】双路并行、先到先用——无条件，
                                // 不等观察窗口、不看余量、无视黑名单（黑名单只约束预取泵，
                                // 若它同时锁死播放直连，竞速会被静默跳过）。
                                //   双管道始终并行、赢家产生后立即掐掉输家。非竞速模式（开关关）：
                                //   直连失败回退代理，不竞速。
                                var settled = false;      // 最终结果已定（成功/全路失败）
                                var proxyStarted = false; // 代理腿已发起（竞速或直连失败兜底）
                                var raced = false;        // 本次代理属竞速（决定偏置与提示）
                                var directDone = false;   // 直连已终结（成功或失败）
                                var proxyDone = false;
                                function killDirect() {
                                    if (self.__directXhr) {
                                        try { self.__directXhr.abort(); } catch (e) { }
                                        self.__directXhr = null;
                                    }
                                }
                                function settleError(err, stats) {
                                    if (settled) { finishInflight(); return; }
                                    settled = true;
                                    finishInflight();
                                    if (typeof baseOnError === 'function') return baseOnError(err, stats, context);
                                }
                                function startProxy() {
                                    if (proxyStarted) return;
                                    proxyStarted = true;
                                    raced = raceOn;
                                    if (raced && !raceTriggerToastShown) { // 首次竞速给用户可见反馈
                                        raceTriggerToastShown = true;
                                        toast('流量竞速兜底：直连+代理双路竞速进行中', 'success');
                                    }
                                    lower(proxyCtx, cfg, (function () {
                                        var cbs = Object.assign({}, callbacks);
                                        cbs.onSuccess = function (response, stats, ctx) {
                                            proxyDone = true;
                                            if (settled) return;
                                            killDirect(); // 掐掉直连输家（迟到回调由 settled 拦截）
                                            if (raced && !raceWinToastShown) {
                                                raceWinToastShown = true;
                                                toast('流量竞速兜底已生效：代理路径率先送达', 'success');
                                            }
                                            settled = true;
                                            makeSuccessWrapper()(response, stats, context);
                                        };
                                        cbs.onError = function (err, ctx2, stats2) {
                                            proxyDone = true;
                                            if (stats2 && stats2.aborted) { finishInflight(); return; } // hls 主动中止或被 winner 掐掉
                                            if (!directDone) return; // 竞速输家：直连仍在跑，静默等直连结果
                                            settleError(err, stats2);
                                        };
                                        return cbs;
                                    })());
                                }
                                var normCtxRange = normRangeValues(context.rangeStart, context.rangeEnd);
                                var rangeHeaders = normCtxRange[0] != null
                                    ? { Range: 'bytes=' + normCtxRange[0] + '-' + (normCtxRange[1] != null ? (normCtxRange[1] - 1) : '') }
                                    : null;
                                self.__directXhr = directXhrLoad(
                                    unwrappedFrag,
                                    rangeHeaders,
                                    context.responseType,
                                    function (response, stats) {
                                        if (settled) return;
                                        settled = true; // 先置位：输家迟到回调全部拦截
                                        self.__directXhr = null;
                                        if (proxyStarted) {
                                            try { baseAbort(); } catch (e) { } // 掐掉竞速输家（代理）
                                        }
                                        makeSuccessWrapper()(response, stats, context);
                                    },
                                    function (reason) {
                                        directDone = true;
                                        if (settled) return;
                                        // TTFB 超时多为蜂窝冷启动建连慢（DNS+TCP+TLS 首连贵），
                                        // 短记忆 20s 尽快重探直连；stall/网络/HTTP 错误按常规时长记忆
                                        markDirectFail(context.url, reason === 'ttfb' ? DIRECT_HOST_TTFB_RETRY_MS : DIRECT_HOST_FAIL_MS);
                                        if (!proxyStarted) startProxy();
                                        else if (proxyDone) settleError(new Error('direct ' + reason + ' + proxy failed'), { aborted: false });
                                        // else 竞速代理仍在途 → 等它的结果
                                    }
                                );
                                if (raceOn) startProxy(); // 竞速模式：代理腿立即并行，不等直连出结果
                            }).catch(function () {
                                // 本地读失败 → 纯网络，绝不影响播放
                                lower(context, cfg, callbacks);
                            });
                        };
                    }
                };
            } catch (e) {
                return Base;
            }
        })();
        state.builtClasses.set(Base, Cls);
        return Cls;
    }

    // ===== 对外 API =====
    function init(opts) {
        state.opts = Object.assign({}, state.opts, opts || {});
        return ensureDB().then(function () {
            state.disabled = false;
        }).catch(function () {
            state.disabled = true;
        }).then(function () {
            state.inited = true;
            startPumpLoop(); // 预取节奏定时器：并发额度随播放缓冲余量周期性重估
            if (state.disabled) {
                if (!state.toastShownDisabled) {
                    state.toastShownDisabled = true;
                    toast('当前环境不支持离线缓存，已降级为普通播放', 'warning');
                }
                return;
            }
            try {
                if (navigator.storage && navigator.storage.persist && navigator.storage.persist()) {
                    navigator.storage.persist().catch(function () { });
                }
            } catch (e) { }
            notifyProgress(true);
        });
    }

    function setVideoKey(key) {
        if (state.disabled || !key) return;
        if (state.currentKey === key) { touchMeta(); return; }
        abortDownload('episode');
        state.currentKey = key;
        state.cachedFragKeys = new Set();
        state.metaMem = null;
        state.session = defaultSession();
        // 自动缓存关闭时默认挂起后台下载（rebuildQueue 的 pump 因 paused 直接让路）
        if (!autoCacheEnabled()) state.session.paused = true;
        notifyProgress(true);
        // 异步预载：已缓存键集合 + meta（续传场景立即显示已缓存比例）
        state.seedPromise = ensureDB().then(function (db) {
            return collectPrimaryKeys(db, STORE_FRAGS, 'videoKey', key);
        }).then(function (keys) {
            if (state.currentKey === key) state.cachedFragKeys = new Set(keys || []);
        }).catch(function () { });
        state.seedPromise.then(function () { state.seedPromise = null; });
        ensureMetaLoaded().then(function () {
            touchMeta();
            evictIfNeeded();
            notifyProgress(true);
        }).catch(function () { });
    }

    function attachHls(hls) {
        if (!hls || state.disabled || hls.__vcAttached) return;
        var H = window.Hls;
        if (!H || !H.Events) return;
        hls.__vcAttached = true;
        hls.on(H.Events.MANIFEST_PARSED, function () {
            touchMeta();
            evictIfNeeded();
        });
        hls.on(H.Events.LEVEL_LOADED, function (evt, data) {
            try {
                var d = data && data.details;
                if (!d || !d.fragments || !d.fragments.length) return;
                // 只跟随实际加载/播放的档位：多档位 VOD 下 hls.js 起播阶段会加载全部档位的清单，
                // 每份清单都触发一次 LEVEL_LOADED。若按"最后到达的清单"重建队列，泵会缓存一个
                // 播放器根本没在播的档位——缓存面板显示 100%，实际播放档位却大量未命中，
                // 蜂窝网表现为"整集缓存完成仍持续卡顿加载"。以 hls.loadLevel（正在取件的档位）
                // 为准；-1 时退回 currentLevel，再退回事件自带的 level（保持旧行为）。
                var evtLevel = (data.level != null) ? data.level : data.id;
                var target = (typeof hls.loadLevel === 'number' && hls.loadLevel >= 0) ? hls.loadLevel
                    : (typeof hls.currentLevel === 'number' && hls.currentLevel >= 0) ? hls.currentLevel
                    : evtLevel;
                if (evtLevel != null && target != null && evtLevel !== target) return;
                rebuildQueue(d.fragments, d.url);
            } catch (e) { }
        });
        hls.on(H.Events.LEVEL_SWITCHED, function (evt, data) {
            try {
                var lv = hls.levels && hls.levels[data && data.level];
                if (lv && lv.details && lv.details.fragments && lv.details.fragments.length) {
                    rebuildQueue(lv.details.fragments, lv.details.url);
                }
            } catch (e) { }
        });
    }

    function getSession() {
        if (!state.inited) return null;
        var s = state.session;
        var total = s.levelKeys.size || (state.metaMem && state.metaMem.total) || 0;
        // 百分比按真实缺失计算：100 只允许出现在"当前档确实完整"时。
        // 旧版 done 短路恒显 100 是假 100% 根因：换档后新档大量缺失仍显示"已全部缓存"
        var levelComplete = total > 0 && s.levelKeys.size > 0 && s.levelCached.size >= s.levelKeys.size;
        var percent = null;
        if (state.disabled) percent = null;
        else if (levelComplete) percent = 100;
        else if (total > 0) percent = Math.min(100, Math.round(s.levelCached.size / total * 100));
        // 预取速度（bps，10s 滑动窗口；无样本时为 0）
        var speedBps = 0;
        var nowTs = Date.now();
        while (state.speedWindow.length && nowTs - state.speedWindow[0].t > 10000) {
            state.speedWindow.shift();
        }
        if (state.speedWindow.length >= 2) {
            var bytes = 0;
            for (var i = 0; i < state.speedWindow.length; i++) bytes += state.speedWindow[i].bytes;
            var span = (nowTs - state.speedWindow[0].t) / 1000;
            if (span > 0.5) speedBps = Math.round(bytes * 8 / span);
        }
        // 对外状态同步纠偏：内部 done 但当前档实际未完整（换档后旧档 done 残留）→ 按缓存中上报，
        // 避免按钮/面板显示"已全部缓存 ✓"而实际缺片
        var outState = state.disabled ? 'disabled' : (s.paused ? 'paused' : s.state);
        if (outState === 'done' && !levelComplete) outState = 'running';
        return {
            enabled: !state.disabled,
            state: outState,
            paused: !!s.paused,
            percent: percent,
            doneFrags: s.levelCached.size,
            totalFrags: total,
            downloadedBytes: state.metaMem ? state.metaMem.bytes : 0,
            speedBps: speedBps,
            version: VC_VERSION,
            loader: { entry: state.loaderStats.entry, hit: state.loaderStats.hit, bypass: state.loaderStats.bypass }
        };
    }

    function setPaused(paused) {
        var s = state.session;
        s.paused = !!paused;
        if (!s.paused) {
            s.failStreak = 0;
            if (s.state === 'failed') s.state = 'running';
            pump();
        }
        notifyProgress(true);
    }

    function abortDownload(reason) {
        var s = state.session;
        if (state.abortCtrl) { try { state.abortCtrl.abort(); } catch (e) { } }
        state.abortCtrl = newAbortCtrl();
        s.downloading = new Set();
        s.inflight = 0;
        if (s.state === 'running' || s.state === 'failed') s.state = 'idle';
        notifyProgress(true);
    }

    // 播放位置变化（seek）后重新锚定缓存优先级：seek 会关闭/打开窗口闸门，需立即重新取件
    function notePositionChange() {
        if (state.disabled) return;
        pump();
    }

    function deleteVideo(key) {
        return ensureDB().then(function (db) {
            return deleteVideoEntries(key, db).then(function () {
                if (key === state.currentKey) {
                    abortDownload('delete');
                    state.cachedFragKeys = new Set();
                    state.metaMem = null;
                    state.session = defaultSession();
                    notifyProgress(true);
                }
                return true;
            });
        }).catch(function () { return false; });
    }

    function clearAll() {
        return ensureDB().then(function (db) {
            return txWrite(db, [STORE_FRAGS, STORE_TEXTS, STORE_META], function (tx) {
                tx.objectStore(STORE_FRAGS).clear();
                tx.objectStore(STORE_TEXTS).clear();
                tx.objectStore(STORE_META).clear();
            }).then(function () {
                abortDownload('clear');
                state.cachedFragKeys = new Set();
                state.metaMem = null;
                state.session = defaultSession();
                notifyProgress(true);
                return true;
            });
        }).catch(function () { return false; });
    }

    function listEntries() {
        if (state.disabled) return Promise.resolve([]);
        return reconcile().catch(function () { return []; });
    }

    // ===== 全局缓存管理器（自包含弹窗，任意页面可用） =====
    var mgr = null;        // { overlay, listEl, summaryEl, entries }
    var mgrTimer = null;

    function ensureManagerDom() {
        if (mgr) return;
        // 样式与影视详情弹窗（.wdtv-modal）一致：透明玻璃 + 高斯模糊
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;'
            + 'z-index:2147483000;background:rgba(200,220,245,0.25);';
        overlay.innerHTML =
            '<div data-vc-box style="background:rgba(200,220,245,0.13);backdrop-filter:blur(32px) saturate(1.5);-webkit-backdrop-filter:blur(32px) saturate(1.5);'
            + 'border:1px solid rgba(200,220,245,0.42);box-shadow:0 24px 80px rgba(0,0,0,0.3),inset 0 1px 0 rgba(255,255,255,0.1);'
            + 'color:rgba(236,244,255,0.96);border-radius:20px;padding:22px 28px;width:min(600px,94vw);max-height:90vh;'
            + 'display:flex;flex-direction:column;font-family:\'Noto Sans SC\',\'Microsoft YaHei\',sans-serif;">'
            + '  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-shrink:0;">'
            + '    <div style="font-family:Cormorant Garamond,serif;font-size:1.35rem;font-weight:300;letter-spacing:0.1em;'
            + 'color:rgba(222,234,250,0.92);text-shadow:0 1px 8px rgba(0,0,0,0.58),0 0 16px rgba(0,0,0,0.22);">视频缓存管理</div>'
            + '    <button data-vc-close style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;'
            + 'border-radius:8px;background:transparent;border:none;color:rgba(222,234,250,0.92);cursor:pointer;'
            + 'transition:all 0.2s;font-size:1.4rem;line-height:1;">×</button>'
            + '  </div>'
            + '  <div data-vc-summary style="font-size:0.85rem;color:rgba(200,220,245,0.75);margin-bottom:12px;flex-shrink:0;">统计中…</div>'
            + '  <div data-vc-list style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;min-height:140px;'
            + 'padding-right:2px;overscroll-behavior:contain;scrollbar-width:none;"></div>'
            + '  <div style="display:flex;gap:8px;margin-top:14px;flex-shrink:0;">'
            + '    <button data-vc-clear style="flex:1;padding:9px;border-radius:10px;border:1px solid rgba(255,255,255,0.28);'
            + 'background:rgba(255,255,255,0.12);color:#ffb0b0;font-size:0.82rem;cursor:pointer;transition:all 0.2s;">清空全部缓存</button>'
            + '    <button data-vc-close style="flex:1;padding:9px;border-radius:10px;border:1px solid rgba(255,255,255,0.28);'
            + 'background:rgba(255,255,255,0.12);color:rgba(236,244,255,0.92);font-size:0.82rem;cursor:pointer;transition:all 0.2s;">关闭</button>'
            + '  </div>'
            + '</div>'
            + '<style>[data-vc-close]:hover{color:#fff !important;background:rgba(255,255,255,0.22) !important}'
            + '[data-vc-del]:hover{background:rgba(255,255,255,0.22) !important;border-color:rgba(255,160,160,0.45) !important}'
            + '[data-vc-clear]:hover{background:rgba(255,255,255,0.22) !important;border-color:rgba(255,160,160,0.45) !important}'
            + '[data-vc-list]::-webkit-scrollbar{display:none}</style>';
        document.body.appendChild(overlay);
        mgr = {
            overlay: overlay,
            box: overlay.querySelector('[data-vc-box]'),
            summaryEl: overlay.querySelector('[data-vc-summary]'),
            listEl: overlay.querySelector('[data-vc-list]'),
            entries: []
        };
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) { closeManager(); return; }
            if (e.target.closest('[data-vc-close]')) { closeManager(); return; }
            var del = e.target.closest('[data-vc-del]');
            if (del) {
                var idx = parseInt(del.getAttribute('data-vc-del'), 10);
                var entry = mgr.entries[idx];
                if (entry) {
                    deleteVideo(entry.videoKey).then(function (ok) {
                        if (ok) toast('已删除缓存：' + entry.title, 'success');
                        else toast('删除失败，请稍后重试', 'error');
                        refreshManager();
                    });
                }
                return;
            }
            if (e.target.closest('[data-vc-clear]')) {
                if (window.confirm('确定清空全部视频缓存？已缓存的 ' + mgr.entries.length + ' 个视频将被删除。')) {
                    clearAll().then(function (ok) {
                        if (ok) toast('已清空全部视频缓存', 'success');
                        else toast('清空失败，请稍后重试', 'error');
                        refreshManager();
                    });
                }
            }
        });
        if (!window.__vcEscBound) {
            window.__vcEscBound = true;
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && mgr && mgr.overlay.style.display === 'flex') closeManager();
            });
        }
    }

    function closeManager() {
        if (!mgr) return;
        mgr.overlay.style.display = 'none';
        if (mgrTimer) { clearInterval(mgrTimer); mgrTimer = null; }
    }

    function refreshManager() {
        if (!mgr || mgr.overlay.style.display !== 'flex') return;
        reconcile().then(function (entries) {
            if (!mgr || mgr.overlay.style.display !== 'flex') return;
            mgr.entries = entries || [];
            renderManager();
        }).catch(function () {
            if (mgr) mgr.summaryEl.textContent = '缓存存储不可用（可能处于隐私模式或存储被禁用）';
        });
    }

    function entryStatusText(entry) {
        var s = getSession();
        if (entry.isCurrent && s && s.enabled && (s.state === 'running' || s.state === 'paused') && s.percent != null) {
            return (s.state === 'paused' ? '已暂停 ' : '缓存中 ') + s.percent + '%';
        }
        if (entry.complete) return '已完成 ✓';
        if (entry.total > 0) return '未完成 ' + entry.fragCount + '/' + entry.total + ' 段';
        return entry.fragCount + ' 段';
    }

    function renderManager() {
        var entries = mgr.entries;
        var totalBytes = entries.reduce(function (s, e) { return s + e.bytes; }, 0);
        var quotaText = '';
        if (navigator.storage && navigator.storage.estimate) {
            navigator.storage.estimate().then(function (est) {
                if (est && est.quota && mgr && mgr.overlay.style.display === 'flex') {
                    mgr.summaryEl.textContent = '共 ' + entries.length + ' 个视频 · 已占用 ' + fmtBytes(totalBytes)
                        + '（浏览器配额约 ' + fmtBytes(est.quota) + '）';
                }
            }).catch(function () { });
        }
        mgr.summaryEl.textContent = '共 ' + entries.length + ' 个视频 · 已占用 ' + fmtBytes(totalBytes);
        if (!entries.length) {
            mgr.listEl.innerHTML = '<div style="text-align:center;color:rgba(222,234,250,0.7);padding:36px 0;font-size:13px;">'
                + '暂无缓存内容<br><span style="font-size:11.5px;">播放视频时会自动在后台缓存整集</span></div>';
            return;
        }
        var html = '';
        entries.forEach(function (entry, i) {
            html += '<div style="border:1px solid rgba(255,255,255,0.32);background:rgba(255,255,255,0.14);'
                + 'border-radius:12px;padding:10px 12px;display:flex;align-items:center;gap:10px;">'
                + '  <div style="flex:1;min-width:0;">'
                + '    <div style="font-size:13.5px;color:rgba(236,244,255,0.96);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'
                + esc(entry.title)
                + (entry.episodeLabel ? '<span style="font-size:11px;color:rgba(200,220,245,0.8);margin-left:6px;">' + esc(entry.episodeLabel) + '</span>' : '')
                + '<span style="font-size:11px;color:rgba(200,220,245,0.68);margin-left:6px;flex-shrink:0;">· ' + esc(entry.sourceName || '未知来源') + '</span>'
                + '    </div>'
                + '    <div style="font-size:11.5px;color:rgba(200,220,245,0.72);margin-top:3px;">'
                + entryStatusText(entry) + ' · ' + fmtBytes(entry.bytes)
                + (entry.lastAccess ? ' · ' + fmtTime(entry.lastAccess) : '')
                + '    </div>'
                + '  </div>'
                + '  <button data-vc-del="' + i + '" style="flex-shrink:0;padding:6px 12px;border-radius:9px;border:1px solid rgba(255,255,255,0.28);'
                + 'background:rgba(255,255,255,0.12);color:#ffb0b0;font-size:12px;cursor:pointer;transition:all 0.2s;">删除</button>'
                + '</div>';
        });
        mgr.listEl.innerHTML = html;
    }

    function openManager() {
        ensureManagerDom();
        mgr.overlay.style.display = 'flex';
        refreshManager();
        if (!mgrTimer) mgrTimer = setInterval(function () {
            if (!mgr || mgr.overlay.style.display !== 'flex') { if (mgrTimer) { clearInterval(mgrTimer); mgrTimer = null; } return; }
            refreshManager();
        }, 2000);
    }

    // 统计当前播放位置之后紧邻分片的缓存媒体秒数（供倍速精细化恢复使用）；
    // 返回 { cached: 已缓存秒数, total: 位置之后全部分片总秒数 }，
    // total 小于阈值说明临近片尾、后面没多少内容了，调用方可视为已就绪
    function cachedSecondsAfterPosition() {
        if (state.disabled || !state.currentKey) return { cached: 0, total: 0 };
        var s = state.session;
        var list = s.frags;
        if (!list || !list.length) return { cached: 0, total: 0 };
        var pos = playbackPosition();
        var cached = 0, total = 0;
        for (var i = 0; i < list.length; i++) {
            var f = list[i];
            if (f.start <= pos) continue; // 跳过当前正在播放及之前的分片
            var dur = (f.end - f.start) || 0;
            total += dur;
            if (state.cachedFragKeys.has(f.key)) cached += dur;
        }
        return { cached: cached, total: total };
    }

    // ===== 导出 =====
    window.VideoCache = {
        init: init,
        version: VC_VERSION,
        wrapLoader: wrapLoader,
        attachHls: attachHls,
        setVideoKey: setVideoKey,
        getSession: getSession,
        setPaused: setPaused,
        abortDownload: abortDownload,
        notePositionChange: notePositionChange,
        cachedSecondsAfterPosition: cachedSecondsAfterPosition,
        deleteVideo: deleteVideo,
        clearAll: clearAll,
        listEntries: listEntries,
        housekeep: housekeep,
        openManager: openManager,
        closeManager: closeManager
    };
})();
