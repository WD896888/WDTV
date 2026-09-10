/**
 * WDTV 视频下载器（下载引擎 + 下载管理器 + 批量下载弹窗）
 *
 * 能力：
 *  - 解析 m3u8（媒体列表 / 主列表自动选档、AES-128 解密、EXT-X-MAP(fMP4)、BYTERANGE）
 *  - 分片并发下载（IndexedDB 持久化，刷新/关页后可续传），逐分片重试
 *  - 合成保存：TS 直拼；MP4 用 mux.js 转封装（libs/mux-mp4.js，参考 m3u8-downloader 项目同款方案）
 *  - 下载管理器：实时进度 / 速度、暂停继续、重试、保存、删除，跨页签共享状态
 *  - 批量下载弹窗：画质 / 格式选择 + 集数多选
 *
 * 对外 API（window.WDTDownloader）：
 *  enqueue(items) / openManager() / closeManager() / openBatchDownloadModal(opts)
 *  onChange(cb) / getActiveCount() / pauseTask(id) / resumeTask(id) / retryTask(id)
 *  deleteTask(id) / saveTask(id)
 */
(function () {
  'use strict';

  // ===== 常量 =====
  const DB_NAME = 'wdtvDownloads';
  const DB_VERSION = 1;
  const STORE_TASKS = 'tasks';
  const STORE_SEGS = 'segs';
  const STORE_FILES = 'files';

  const SEG_CONCURRENCY = 12;     // 同时下载的分片数（HTTP/2 源可打满带宽；HTTP/1.1 同域浏览器自动排队到 ~6 连接，无害）
  const SEG_RETRIES = 3;          // 单分片重试次数
  const FETCH_TIMEOUT = 20000;    // 连接/响应头超时（毫秒，收到响应头即解除；与整集缓存取件一致）
  const IDLE_TIMEOUT = 20000;     // body 空闲超时：连续 20s 无字节到达才中止（不掐慢速下载，只掐卡死）
  const PERSIST_TICK = 800;       // 任务进度落库节流（毫秒）
  const EMIT_TICK = 300;          // UI 刷新事件节流（毫秒）
  const MANAGER_TICK = 1000;      // 管理器打开时的定时刷新
  const CONTROL_SYNC = 3000;      // 运行中跨页签状态同步间隔
  const SPEED_SAMPLE_MS = 200;    // 网络速度采样节流

  // ===== 移动端适配 =====
  const UA = navigator.userAgent || '';
  const IS_IOS = /iP(hone|ad|od)/i.test(UA) || (UA.includes('Macintosh') && navigator.maxTouchPoints > 1); // iPadOS 桌面 UA 也算
  const IS_ANDROID = /Android/i.test(UA);
  const IS_MOBILE = IS_IOS || IS_ANDROID;
  // 系统分享面板（移动端导出兜底：可“存储到文件”，iOS 上 a[download] 对 Blob 不可靠）
  const SHARE_FILES_OK = IS_MOBILE && typeof navigator.share === 'function' && typeof navigator.canShare === 'function';

  let wakeLock = null;
  function hasActiveDownloads() {
    return tasks.some(t => ['pending', 'downloading', 'merging'].includes(t.state));
  }
  async function updateWakeLock() {
    // 手机锁屏/切后台会冻结 JS 与网络（Doze/页面冻结），下载停滞 → 有活跃任务时保持屏幕常亮
    if (!('wakeLock' in navigator)) return;
    if (document.visibilityState !== 'visible' || !hasActiveDownloads()) {
      if (wakeLock) { try { wakeLock.release(); } catch (e) { } wakeLock = null; }
      return;
    }
    if (wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', updateWakeLock);

  // ===== 模块状态 =====
  const tasks = [];               // 任务内存态（含运行时字段）
  const listeners = new Set();
  const persistTimers = new Map();
  let emitTimer = null;
  let activeRun = null;           // { taskId, ctrl, syncTimer }
  let pumping = false;
  let pumpLockHeld = false;
  let pumpEpoch = 0;              // 调度锁代数：锁被其它页签抢占后旧持锁者据此让位
  let inited = false;

  // ===== 工具函数 =====

  // djb2 哈希：任务 ID 生成（URL + 格式 唯一确定一个任务）
  function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return 'dl' + h.toString(36);
  }

  // 代理前缀：config.js 的 PROXY_URL（const 声明在全局词法作用域，typeof 安全探测）
  function getProxyBase() {
    try {
      if (typeof PROXY_URL === 'string' && PROXY_URL) return PROXY_URL;
    } catch (e) { }
    return '/proxy/';
  }

  // 解包同源代理 URL：/proxy/<encodeURIComponent(目标)> → 内层真实 URL（与 player.js 同逻辑）
  function unwrapProxiedUrl(rawUrl) {
    try {
      const u = new URL(rawUrl, location.href);
      const proxyBase = getProxyBase();
      if (u.origin === location.origin && u.pathname.startsWith(proxyBase)) {
        const inner = decodeURIComponent(u.pathname.slice(proxyBase.length));
        if (/^https?:\/\//i.test(inner)) return inner;
      }
    } catch (e) { }
    return rawUrl;
  }

  // 计算字节格式化
  function fmtBytes(n) {
    if (!isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function fmtDuration(sec) {
    if (!isFinite(sec) || sec <= 0) return '';
    const s = Math.round(sec);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 文件名安全化
  function sanitizeName(s) {
    return String(s || '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '视频';
  }

  function toast(msg, type) {
    try {
      if (typeof showToast === 'function') { showToast(msg, type || 'info'); return; }
    } catch (e) { }
    // 兜底小 toast
    let box = document.getElementById('wdtvDlToast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'wdtvDlToast';
      box.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:4000;'
        + 'padding:9px 18px;border-radius:10px;font-size:13px;color:#e2e9f5;'
        + 'background:rgba(28,40,64,0.92);border:1px solid rgba(151,173,208,0.4);'
        + 'backdrop-filter:blur(18px);box-shadow:0 6px 24px rgba(10,18,32,0.4);transition:opacity .3s;opacity:0;pointer-events:none';
      document.body.appendChild(box);
    }
    box.textContent = msg;
    box.style.opacity = '1';
    clearTimeout(box.__t);
    box.__t = setTimeout(() => { box.style.opacity = '0'; }, 2600);
  }

  // ===== IndexedDB =====

  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_TASKS)) {
          db.createObjectStore(STORE_TASKS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_SEGS)) {
          const s = db.createObjectStore(STORE_SEGS, { keyPath: 'key' });
          s.createIndex('byId', 'id', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_FILES)) {
          db.createObjectStore(STORE_FILES, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('打开下载数据库失败'));
    });
    return dbPromise;
  }

  async function idbTx(store, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const st = tx.objectStore(store);
      let result;
      try { result = fn(st); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(result && result.__val !== undefined ? result.__val : result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('事务中止'));
    });
  }

  // request 包装：把请求结果带出事务（在 oncomplete 前读取 request.result）
  function wrapReq(store, mode, makeReq) {
    const dbP = openDb();
    return dbP.then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = makeReq(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  const idbPut = (store, val) => wrapReq(store, 'readwrite', st => st.put(val));
  const idbGet = (store, key) => wrapReq(store, 'readonly', st => st.get(key));
  const idbDel = (store, key) => wrapReq(store, 'readwrite', st => st.delete(key));
  const idbAll = (store) => wrapReq(store, 'readonly', st => st.getAll());
  const idbGetKey = (store, key) => wrapReq(store, 'readonly', st => st.openKeyCursor(key)); // 有 cursor 即存在

  function segKey(taskId, idx) { return taskId + '\u0000' + idx; }

  async function clearTaskSegs(taskId) {
    // 注意：不能用 openKeyCursor + cur.delete()——key cursor 不支持 delete（InvalidStateError），
    // 会导致清理事务卡死、任务状态永远停在 merging。改为先取全部主键再逐 key 删除。
    const keys = await wrapReq(STORE_SEGS, 'readonly', st => st.index('byId').getAllKeys(IDBKeyRange.only(taskId)));
    if (!keys || !keys.length) return;
    await Promise.all(keys.map(k => idbDel(STORE_SEGS, k)));
  }

  // ===== 网络请求（直连/代理双路自动切换） =====

  // 直连路径健康记忆：某主机直连失败后 10 分钟内跳过直连（与 video-cache.js 同策略）。
  // 移动网络下直连可能整体不可达（运营商网络/CDN 风控/证书异常），若每次取件都先撞一遍
  // 直连超时，会把 12 并发 × 逐分片重试全部拖成慢速失败——表现为"进度长期 0% 后报
  // Failed to fetch"。记忆死路主机后，后续请求直接走代理快路径。
  const DIRECT_HOST_FAIL_MS = 10 * 60 * 1000;
  const directHostFails = new Map(); // host → 直连失败截止时间戳

  function markDirectFail(innerUrl) {
    try { directHostFails.set(new URL(innerUrl).host, Date.now() + DIRECT_HOST_FAIL_MS); } catch (e) { }
  }
  function canTryDirect(innerUrl) {
    try {
      const failUntil = directHostFails.get(new URL(innerUrl).host) || 0;
      return Date.now() >= failUntil;
    } catch (e) { return true; }
  }

  async function fetchWithTimeout(url, asText, signal, onData) {
    const ctrl = new AbortController();
    // 连接/响应头超时：仅覆盖"发起到收到响应头"阶段，收到响应头立即解除。
    // 旧实现把 30s 计时器挂在整次传输上，慢速网络下大清单/大分片的 body 超过 30s 会被
    // 误杀中止（桌面快网从不触发，移动端必现反复中止→重试→直至失败）。
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); throw new DOMException('aborted', 'AbortError'); }
      signal.addEventListener('abort', onAbort);
    }
    try {
      const resp = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
      clearTimeout(timer); // 响应头已到，解除连接阶段超时；body 阶段改由空闲超时监控
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      if (asText || !resp.body) {
        // 文本（清单）与无流式环境：body 小而关键，用空闲超时兜底，
        // 防止"响应头已到但 body 卡死"的连接永不返回
        const bodyTimer = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT);
        try {
          return asText ? await resp.text() : await resp.arrayBuffer();
        } catch (e) {
          if (signal && signal.aborted) throw e;
          if (e && e.name === 'AbortError') {
            throw new Error('清单下载停滞（' + Math.round(IDLE_TIMEOUT / 1000) + 's 无数据），已重试');
          }
          throw e;
        } finally {
          clearTimeout(bodyTimer);
        }
      }
      // 二进制分片：流式读取 + 空闲超时监控。
      // 更早的历史实现用 resp.arrayBuffer() + 总超时——慢速源下载大分片必超时，
      // 反复整片重传永远下不完（全速下载的关键修复）。
      const reader = resp.body.getReader();
      const chunks = [];
      let received = 0;
      let lastDataAt = Date.now();
      const idleTimer = setInterval(() => {
        if (Date.now() - lastDataAt > IDLE_TIMEOUT) ctrl.abort();
      }, 2000);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          lastDataAt = Date.now();
          if (onData) onData(value.length); // 实时上报：速度显示与设备实际流量同步（含重试流量）
        }
      } catch (e) {
        if (Date.now() - lastDataAt > IDLE_TIMEOUT) {
          throw new Error('分片下载停滞（' + Math.round(received / 1024) + 'KB 后无响应），已重试');
        }
        throw e;
      } finally {
        clearInterval(idleTimer);
        try { reader.releaseLock(); } catch (e) { }
      }
      const out = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out.buffer;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  // 双路取件：按 URL 形态自动挑选尝试顺序，逐路切换直至成功。
  //  1) 原始地址：直连优先（快），失败回退同源代理；
  //     - HTTPS 页面取 HTTP 源属混合内容（浏览器必拦），直接跳过直连不浪费尝试；
  //     - 直连死路主机（近期失败过）跳过直连，避免逐分片烧超时。
  //  2) 代理形式（/proxy/<encoded>）：同源代理为主路（与播放路径一致），失败解包直连兜底
  //     ——服务器less 代理出口对部分国内 CDN 会被风控/地域拦截（404/403），此时设备直连反而可达，
  //     旧实现代理一失败任务即告失败，无任何退路。
  async function robustFetch(url, asText, signal, onData) {
    const inner = unwrapProxiedUrl(url);
    const attempts = [];
    if (inner !== url) {
      attempts.push(url);    // 已是代理形式：原样走同源代理
      attempts.push(inner);  // 兜底：解包后直连源站
    } else if (location.protocol.startsWith('http')) {
      const mixed = location.protocol === 'https:' && /^http:\/\//i.test(inner);
      if (!mixed && canTryDirect(inner)) attempts.push(inner);
      attempts.push(getProxyBase() + encodeURIComponent(inner));
    } else {
      attempts.push(inner); // 非网页环境（如本地 file:// 打开）：仅直连
    }
    let firstErr = null;
    for (const u of attempts) {
      try {
        return await fetchWithTimeout(u, asText, signal, onData);
      } catch (e) {
        if (signal && signal.aborted) throw e;
        if (u === inner) markDirectFail(inner); // 直连尝试失败记账（下一次该主机跳过直连）
        if (!firstErr) firstErr = e;
      }
    }
    throw firstErr || new Error('下载请求失败');
  }

  // ===== m3u8 解析 =====

  function hexToBytes(hex) {
    hex = String(hex || '').replace(/^0x/i, '');
    if (hex.length % 2) hex = '0' + hex;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
    const out = new Uint8Array(16);
    out.set(bytes.subarray(0, 16)); // 规范：截取高 128 位
    return out;
  }

  function seqIv(seqNum) {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, seqNum >>> 0);
    return iv;
  }

  // 解析主列表变体
  function parseMaster(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
      const attrs = line.slice('#EXT-X-STREAM-INF'.length);
      const res = /RESOLUTION=(\d+)x(\d+)/.exec(attrs);
      const bw = /BANDWIDTH=(\d+)/.exec(attrs);
      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (!t) continue;
        if (!t.startsWith('#')) { uri = t; i = j; }
        break;
      }
      if (!uri) continue;
      let url = null;
      try { url = new URL(uri, baseUrl).toString(); } catch (e) { continue; }
      variants.push({
        height: res ? parseInt(res[2], 10) : 0,
        bandwidth: bw ? parseInt(bw[1], 10) : 0,
        url
      });
    }
    return variants;
  }

  // 按画质提示挑选变体：高度接近优先，其次码率
  function pickVariant(variants, hint) {
    if (!variants.length) return null;
    if (hint && (hint.height || hint.bandwidth)) {
      let best = variants[0], bestScore = Infinity;
      for (const v of variants) {
        const dh = hint.height ? Math.abs((v.height || 0) - hint.height) : null;
        const score = dh != null ? dh * 10000 + Math.abs((v.bandwidth || 0) - (hint.bandwidth || 0))
          : Math.abs((v.bandwidth || 0) - (hint.bandwidth || 0));
        if (score < bestScore) { bestScore = score; best = v; }
      }
      return best;
    }
    return variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a)); // 默认最高码率
  }

  // 解析媒体列表
  function parseMedia(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const segs = [];
    const keyChanges = []; // { fromIdx, enc } — 支持逐段轮换密钥
    let mediaSeq = 0, duration = 0, map = null;
    let bytLen = 0, bytOff = -1, prevEnd = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSeq = parseInt(line.split(':')[1], 10) || 0;
      } else if (line.startsWith('#EXT-X-KEY')) {
        const method = (/METHOD=([^,\s]+)/.exec(line) || [])[1] || 'NONE';
        const uriM = /URI="([^"]+)"/.exec(line);
        const ivM = /IV=0x([0-9a-fA-F]+)/.exec(line);
        keyChanges.push({
          fromIdx: segs.length,
          enc: {
            method,
            uri: uriM ? new URL(uriM[1], baseUrl).toString() : null,
            iv: ivM ? hexToBytes(ivM[1]) : null
          }
        });
      } else if (line.startsWith('#EXT-X-MAP')) {
        const uriM = /URI="([^"]+)"/.exec(line);
        if (uriM) { try { map = new URL(uriM[1], baseUrl).toString(); } catch (e) { } }
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        const m = /#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/.exec(line);
        if (m) { bytLen = parseInt(m[1], 10) || 0; bytOff = m[2] != null ? parseInt(m[2], 10) : -1; }
      } else if (line.startsWith('#EXTINF:')) {
        const d = parseFloat(line.slice(8));
        if (isFinite(d)) duration += d;
      } else if (!line.startsWith('#')) {
        let url = null;
        try { url = new URL(line, baseUrl).toString(); } catch (e) { }
        if (!url) continue;
        let range = null;
        if (bytLen > 0) {
          const off = bytOff >= 0 ? bytOff : prevEnd;
          range = { start: off, end: off + bytLen - 1 };
          prevEnd = off + bytLen;
          bytLen = 0; bytOff = -1;
        }
        segs.push({ url, range });
      }
    }
    return { segs, keyChanges, map, mediaSeq, duration };
  }

  // 解析下载地址：主列表自动选档（最多两层），返回媒体列表结构
  async function resolvePlaylist(url, hint, signal) {
    let text = await robustFetch(url, true, signal);
    if (!text || !text.trimStart().startsWith('#EXTM3U')) throw new Error('链接不是有效的 m3u8 清单');
    let variants = parseMaster(text, url);
    let listUrl = url; // 最终媒体清单的实际来源 URL（分片/密钥相对路径以此为基准）
    if (variants.length) {
      const picked = pickVariant(variants, hint);
      listUrl = picked.url;
      text = await robustFetch(picked.url, true, signal);
      variants = parseMaster(text, picked.url);
      if (variants.length) throw new Error('嵌套主列表超出支持范围');
    }
    // 注意：分片相对路径必须以"最终媒体清单"的 URL 为基准。
    // 旧实现错用最初传入的 url（主列表地址）：主列表与子清单不在同一目录时
    // （如 .../index.m3u8 → 2000k/hls/index.m3u8），所有分片都会拼到主列表目录下 → 全部 404。
    const media = parseMedia(text, listUrl);
    if (!media.segs.length) throw new Error('清单中没有可下载的视频分片');
    if (media.keyChanges.some(k => k.enc.method === 'SAMPLE-AES')) {
      throw new Error('该视频使用 SAMPLE-AES 加密，暂不支持下载');
    }
    return media;
  }

  // AES-128 解密（WebCrypto，PKCS7 由浏览器自动去除）
  async function decryptAes(data, keyBuf, iv, seqNum) {
    if (data.byteLength === 0 || data.byteLength % 16 !== 0) {
      throw new Error('加密分片长度异常，无法解密');
    }
    const ck = await crypto.subtle.importKey('raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']);
    const ivBytes = iv || seqIv(seqNum);
    return crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, ck, data);
  }

  // ===== 任务模型 =====

  function cleanTask(t) {
    // 持久化字段（剔除运行时字段）
    return {
      id: t.id, title: t.title, episodeLabel: t.episodeLabel, fileName: t.fileName,
      url: t.url, quality: t.quality || '', qualityHint: t.qualityHint || null,
      format: t.format, state: t.state,
      totalFrags: t.totalFrags || 0, doneFrags: t.doneFrags || 0, bytes: t.bytes || 0,
      durationSec: t.durationSec || 0, fileSize: t.fileSize || 0, fileSaved: !!t.fileSaved,
      error: t.error || '', createdAt: t.createdAt, updatedAt: t.updatedAt
    };
  }

  function persistTask(task, immediate) {
    // 已删除的任务禁止一切写回（运行中的 abort 收尾/节流写都会因此被拦，防止 IDB"复活"）
    if (!tasks.includes(task)) return;
    task.updatedAt = Date.now();
    if (immediate) {
      const timer = persistTimers.get(task.id);
      if (timer) { clearTimeout(timer); persistTimers.delete(task.id); }
      idbPut(STORE_TASKS, cleanTask(task)).catch(() => { });
      return;
    }
    if (persistTimers.has(task.id)) return;
    persistTimers.set(task.id, setTimeout(() => {
      persistTimers.delete(task.id);
      idbPut(STORE_TASKS, cleanTask(task)).catch(() => { });
    }, PERSIST_TICK));
  }

  function emit(immediate) {
    if (immediate) { doEmit(); return; }
    if (emitTimer) return;
    emitTimer = setTimeout(() => { emitTimer = null; doEmit(); }, EMIT_TICK);
  }

  function doEmit() {
    updateWakeLock(); // 任务启停/完成时同步保活状态（手机防锁屏冻结下载）
    updateNavBadge();
    listeners.forEach(cb => { try { cb(getPublicStats()); } catch (e) { } });
  }

  function getPublicStats() {
    return {
      active: tasks.filter(t => ['pending', 'downloading', 'paused', 'merging'].includes(t.state)).length,
      done: tasks.filter(t => t.state === 'done').length
    };
  }

  function updateNavBadge() {
    const badge = document.getElementById('downloadsBadge');
    if (!badge) return;
    const s = getPublicStats();
    if (s.active > 0) {
      badge.textContent = s.active > 99 ? '99+' : s.active;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // 入队
  function enqueue(items) {
    let added = 0, dup = 0;
    (Array.isArray(items) ? items : [items]).forEach(it => {
      if (!it || !it.url) return;
      const format = 'mp4'; // 用户定案：只做 MP4 下载
      const id = djb2(it.url + '|' + format);
      const exist = tasks.find(t => t.id === id);
      if (exist && exist.state !== 'error') { dup++; return; } // 已存在（错误任务重下走 retry 或覆盖）
      if (exist) { // 错误任务重复添加 → 视为重试
        exist.state = 'pending'; exist.error = '';
        persistTask(exist, true); added++;
        return;
      }
      const epLabel = it.episodeLabel || '';
      const nameBase = sanitizeName(it.title || '视频');
      const task = {
        id,
        title: it.title || '未知视频',
        episodeLabel: epLabel,
        fileName: sanitizeName(nameBase + (epLabel ? ' ' + epLabel : '')),
        url: it.url,
        quality: it.quality || '默认',
        qualityHint: it.qualityHint || null,
        format,
        state: 'pending',
        totalFrags: 0, doneFrags: 0, bytes: 0,
        durationSec: 0, fileSize: 0, fileSaved: false,
        error: '',
        createdAt: Date.now(), updatedAt: Date.now(),
        // 运行时字段
        speed: 0, _plan: null
      };
      tasks.push(task);
      persistTask(task, true);
      added++;
    });
    emit(true);
    scanAndPump();
    if (added && dup) toast(`已加入下载队列 ${added} 个（${dup} 个已在列表中）`, 'success');
    else if (added) toast(`已加入下载队列（${added} 个任务）`, 'success');
    else if (dup) toast('任务已在下载列表中', 'info');
    return added;
  }

  // ===== 下载执行 =====

  async function hasSeg(taskId, idx) {
    try {
      const cur = await idbGetKey(STORE_SEGS, segKey(taskId, idx));
      return !!cur;
    } catch (e) { return false; }
  }

  async function runTask(task) {
    if (activeRun || pumping) return;
    pumping = true;
    const ctrl = new AbortController();
    const syncTimer = setInterval(async () => {
      // 跨页签控制：任务被删除或被其它页签暂停时中止本页运行
      try {
        const rec = await idbGet(STORE_TASKS, task.id);
        if (!rec || rec.state === 'paused') ctrl.abort();
      } catch (e) { }
    }, CONTROL_SYNC);
    activeRun = { taskId: task.id, ctrl, syncTimer };

    task.error = '';
    task.state = 'downloading';
    task.speed = 0;
    persistTask(task, true); emit(true);

    // 实时网络速度：按"从网络收到的字节"计（含重试流量），与设备实际流量同步。
    // 旧实现按"已完成分片"计——12 并发等分片整体完成才一次性入账，速度长时间为 0
    // 后瞬间爆表（脉冲式），和系统流量统计对不上。
    let netBytes = 0;
    task._netBytes = 0; // 调试口：实时网络字节
    const speedWin = []; // { t, b: netBytes }，5 秒滑动窗口，200ms 采样
    let lastSample = 0;
    let lastEmit = 0;

    const onNetData = (n) => {
      netBytes += n;
      task._netBytes = netBytes;
      const now = Date.now();
      if (now - lastSample < SPEED_SAMPLE_MS) return;
      lastSample = now;
      speedWin.push({ t: now, b: netBytes });
      while (speedWin.length > 2 && now - speedWin[0].t > 5000) speedWin.shift();
      if (speedWin.length >= 2) {
        const first = speedWin[0], last = speedWin[speedWin.length - 1];
        const dt = (last.t - first.t) / 1000;
        if (dt > 0.3) task.speed = Math.max(0, (last.b - first.b) / dt);
      }
      if (now - lastEmit > EMIT_TICK) { lastEmit = now; emit(); }
    };

    // 分片完成：推进进度（doneFrags/bytes 是已落库量，脉冲式属正常语义），速度由 onNetData 负责
    const onProgress = (bytesDelta) => {
      task.doneFrags++;
      task.bytes += bytesDelta;
      persistTask(task);
    };

    try {
      const media = await resolvePlaylist(task.url, task.qualityHint, ctrl.signal);
      if (ctrl.signal.aborted) throw new DOMException('aborted', 'AbortError');

      task.totalFrags = media.segs.length;
      task.durationSec = Math.round(media.duration);
      task._plan = media;
      persistTask(task, true);

      // AES-128 密钥（按 keyChanges 预取，去重）
      const keyCache = new Map(); // uri → ArrayBuffer
      for (const kc of media.keyChanges) {
        if (kc.enc.method === 'AES-128' && kc.enc.uri && !keyCache.has(kc.enc.uri)) {
          const buf = await robustFetch(kc.enc.uri, false, ctrl.signal);
          if (ctrl.signal.aborted) throw new DOMException('aborted', 'AbortError');
          if (!buf || buf.byteLength !== 16) throw new Error('AES 密钥获取失败');
          keyCache.set(kc.enc.uri, buf);
        }
      }

      // 已完成分片对账（续传）
      let done = 0;
      for (let i = 0; i < media.segs.length; i++) {
        if (await hasSeg(task.id, i)) done++;
      }
      task.doneFrags = done;
      if (done >= media.segs.length) {
        await mergeTask(task, media);
        return;
      }

      // 并发下载分片
      let nextIdx = 0;
      let segError = null;

      const worker = async () => {
        while (true) {
          if (ctrl.signal.aborted || segError) return;
          const i = nextIdx++;
          if (i >= media.segs.length) return;
          if (await hasSeg(task.id, i)) { continue; }

          const item = media.segs[i];
          let lastErr = null;
          for (let attempt = 1; attempt <= SEG_RETRIES; attempt++) {
            if (ctrl.signal.aborted) return;
            try {
              let buf = await robustFetch(item.url, false, ctrl.signal, onNetData);
              if (item.range) {
                // 服务器忽略 Range 返回 200 全量时按区间截取
                buf = buf.slice(item.range.start, item.range.end + 1);
              }
              // 该分片适用的加密配置
              let enc = null;
              for (const kc of media.keyChanges) {
                if (i >= kc.fromIdx) enc = kc.enc; else break;
              }
              if (enc && enc.method === 'AES-128') {
                const key = keyCache.get(enc.uri);
                buf = await decryptAes(buf, key, enc.iv, media.mediaSeq + i);
              }
              await idbPut(STORE_SEGS, { key: segKey(task.id, i), id: task.id, idx: i, data: buf, size: buf.byteLength });
              onProgress(buf.byteLength);
              lastErr = null;
              break;
            } catch (e) {
              if (ctrl.signal.aborted) return;
              lastErr = e;
              await new Promise(r => setTimeout(r, 800 * attempt));
            }
          }
          if (lastErr) {
            segError = lastErr;
            return;
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(SEG_CONCURRENCY, media.segs.length) }, worker));

      if (ctrl.signal.aborted) {
        task.state = 'paused';
        persistTask(task, true); emit(true);
        return;
      }
      if (segError) {
        throw segError;
      }

      await mergeTask(task, media);
    } catch (e) {
      if (ctrl.signal.aborted) {
        task.state = 'paused';
      } else {
        task.state = 'error';
        task.error = (e && e.message) ? e.message : '下载失败';
      }
      persistTask(task, true); emit(true);
    } finally {
      clearInterval(syncTimer);
      if (activeRun && activeRun.taskId === task.id) activeRun = null;
      pumping = false;
      task.speed = 0;
      emit();
      // 队列里还有待处理任务则继续
      setTimeout(scanAndPump, 50);
    }
  }

  // ===== 合成与保存 =====

  let muxPromise = null;
  function ensureMuxJs() {
    if (window.muxjs && window.muxjs.Transmuxer) return Promise.resolve();
    if (muxPromise) return muxPromise;
    muxPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'libs/mux-mp4.js';
      s.onload = () => {
        if (window.muxjs && window.muxjs.Transmuxer) resolve();
        else { muxPromise = null; reject(new Error('MP4 转码库加载失败')); }
      };
      s.onerror = () => { muxPromise = null; reject(new Error('MP4 转码库加载失败，请检查网络')); };
      document.head.appendChild(s);
    });
    return muxPromise;
  }

  async function mergeTask(task, media) {
    task.state = 'merging';
    task.speed = 0;
    persistTask(task, true); emit(true);

    // 顺序读出全部分片
    const parts = [];
    if (media.map) {
      // fMP4：先放 init 段，再直拼所有分片
      const initBuf = await robustFetch(media.map, false, null);
      parts.push(initBuf);
      for (let i = 0; i < media.segs.length; i++) {
        const rec = await idbGet(STORE_SEGS, segKey(task.id, i));
        if (!rec || !rec.data) throw new Error('分片数据缺失，请重试');
        parts.push(rec.data);
      }
    } else {
      for (let i = 0; i < media.segs.length; i++) {
        const rec = await idbGet(STORE_SEGS, segKey(task.id, i));
        if (!rec || !rec.data) throw new Error('分片数据缺失，请重试');
        parts.push(rec.data);
      }
    }

    let blob;
    if (task.format === 'ts') {
      blob = new Blob(parts, { type: 'video/MP2T' });
    } else if (media.map) {
      blob = new Blob(parts, { type: 'video/mp4' }); // fMP4 直拼
    } else {
      // TS → MP4 转封装（mux.js，与 m3u8-downloader 参考实现同方案：逐分片转码，首段带 initSegment）
      await ensureMuxJs();
      const out = [];
      for (let i = 0; i < parts.length; i++) {
        const trans = new window.muxjs.Transmuxer({
          keepOriginalTimestamps: true,
          duration: parseInt(task.durationSec || 0, 10)
        });
        trans.on('data', segment => {
          if (i === 0 && segment.initSegment && segment.initSegment.byteLength) {
            const u8 = new Uint8Array(segment.initSegment.byteLength + segment.data.byteLength);
            u8.set(segment.initSegment, 0);
            u8.set(segment.data, segment.initSegment.byteLength);
            out.push(u8);
          } else {
            out.push(segment.data);
          }
        });
        trans.push(new Uint8Array(parts[i]));
        trans.flush();
        parts[i] = null; // 及时释放
      }
      if (!out.length) throw new Error('MP4 转码失败：无有效输出，可改用 TS 格式重新下载');
      blob = new Blob(out, { type: 'video/mp4' });
      out.length = 0; // 尽早释放转封装中间数组，降低移动端内存峰值
    }
    parts.length = 0; // Blob 已独立持有数据，立即释放分片数组（移动端大文件防 OOM）

    if (!blob || !blob.size) throw new Error('合成的文件为空');

    await idbPut(STORE_FILES, { id: task.id, blob, size: blob.size, name: task.fileName, ts: Date.now() });
    await clearTaskSegs(task.id);

    task.state = 'done';
    task.doneFrags = task.totalFrags;
    task.fileSize = blob.size;
    task.fileSaved = false;
    persistTask(task, true); emit(true);

    triggerSave(task);
  }

  // 导出单个已完成任务的文件
  // useShare=true：优先调起系统分享面板（移动端可靠路径，可“存储到文件”/发送到其它 App）
  // useShare=false：直接 a[download] 触发浏览器下载（桌面 / 安卓 Chrome 直落下载目录）
  async function exportTaskFile(task, useShare) {
    let rec;
    try { rec = await idbGet(STORE_FILES, task.id); } catch (e) { }
    if (!rec || !rec.blob) { toast('文件数据缺失，无法导出（任务可能被系统清理）', 'error'); return; }
    const fname = task.fileName + (task.format === 'ts' ? '.ts' : '.mp4');
    if (useShare && SHARE_FILES_OK) {
      try {
        const file = new File([rec.blob], fname, { type: task.format === 'ts' ? 'video/MP2T' : 'video/mp4' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: fname });
          task.fileSaved = true;
          persistTask(task, true);
          toast('已调起系统分享，可选择“存储到文件”保存', 'success');
          return;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return; // 用户取消分享面板，不算失败
        // 其它异常（如低版本不支持文件分享）继续走 a[download] 兜底
      }
    }
    const url = URL.createObjectURL(rec.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
    task.fileSaved = true;
    persistTask(task, true);
    toast(`《${task.title}》${task.episodeLabel || ''} 已开始保存到下载目录`, 'success');
  }

  // 合并完成后的自动导出：桌面/安卓直接触发浏览器下载；
  // iOS 无用户手势时 a[download]/share 都不可靠 → 提示用户到下载管理点「保存」
  function triggerSave(task) {
    if (IS_IOS) {
      task.fileSaved = false;
      persistTask(task, true);
      toast('下载完成！请打开下载管理点「保存」导出到手机', 'success');
      return;
    }
    exportTaskFile(task, false);
  }

  // ===== 任务操作 =====

  function findTask(id) { return tasks.find(t => t.id === id); }

  function pauseTask(id) {
    const t = findTask(id);
    if (!t) return;
    if (activeRun && activeRun.taskId === id) {
      activeRun.ctrl.abort(); // runTask 的 aborted 分支会置 paused
      t.state = 'paused';
      persistTask(t, true); emit(true);
    } else if (['pending', 'downloading'].includes(t.state)) {
      t.state = 'paused';
      persistTask(t, true); emit(true);
    }
  }

  function resumeTask(id) {
    const t = findTask(id);
    if (!t) return;
    if (['paused', 'error'].includes(t.state)) {
      t.state = 'pending';
      t.error = '';
      persistTask(t, true); emit(true);
      scanAndPump();
    }
  }

  function retryTask(id) { resumeTask(id); }

  function deleteTask(id) {
    const t = findTask(id);
    if (t && activeRun && activeRun.taskId === id) activeRun.ctrl.abort();
    const idx = tasks.findIndex(x => x.id === id);
    if (idx !== -1) tasks.splice(idx, 1);
    idbDel(STORE_TASKS, id).catch(() => { });
    clearTaskSegs(id).catch(() => { });
    idbDel(STORE_FILES, id).catch(() => { });
    emit(true);
    toast('已删除下载任务', 'info');
  }

  function saveTask(id) {
    const t = findTask(id);
    if (t && t.state === 'done') exportTaskFile(t, IS_IOS); // iOS 保存 = 系统分享面板；安卓/桌面 = 直接下载
  }

  // 安卓上 a[download] 直落下载目录为主路径；分享面板作为备用导出方式（可发到 VLC/文件管理等）
  function shareTask(id) {
    const t = findTask(id);
    if (t && t.state === 'done') exportTaskFile(t, true);
  }

  async function clearDoneTasks() {
    const doneIds = tasks.filter(t => t.state === 'done').map(t => t.id);
    doneIds.forEach(id => {
      const idx = tasks.findIndex(x => x.id === id);
      if (idx !== -1) tasks.splice(idx, 1);
      idbDel(STORE_TASKS, id).catch(() => { });
      idbDel(STORE_FILES, id).catch(() => { });
    });
    emit(true);
    if (doneIds.length) toast(`已清除 ${doneIds.length} 条完成记录`, 'info');
  }

  // 队列调度：持锁页签负责启动待处理任务
  function scanAndPump() {
    if (pumping || activeRun || !pumpLockHeld) return;
    const next = tasks
      .filter(t => t.state === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (next) runTask(next);
  }

  // ===== 调度锁（Web Locks + 心跳兜底）=====
  // 旧实现只在页面加载时用 ifAvailable 试拿一次锁，拿不到就永不再试：
  // 若当时锁被其它页签占用、而那个页签随后被关闭/冻结，本页签永远无法
  // 获得调度权 —— 队列无人推进，任务永远停在"排队中"。
  // 现在：阻塞式请求排队等锁（持锁页签关闭后浏览器自动移交），另用
  // localStorage 心跳检测"持锁页签被冻结"（锁不释放但心跳停止），
  // 超时后 steal 抢回调度权，旧持锁者醒来凭代数让位。
  const PUMP_LOCK = 'wdtv_downloader_pump';
  const PUMP_BEAT_KEY = 'wdtv_dl_pump_beat';   // 持锁页签心跳 { t, e }
  const PUMP_EPOCH_KEY = 'wdtv_dl_pump_epoch'; // 抢锁代数计数
  const PUMP_STALE_MS = 20000;                 // 心跳超过此时长视为持锁页签已关闭/冻结

  const lsOk = (() => {
    try {
      if (localStorage.getItem(PUMP_EPOCH_KEY) === null) localStorage.setItem(PUMP_EPOCH_KEY, '0');
      return true;
    } catch (e) { return false; }
  })();

  function readBeat() {
    try { return JSON.parse(localStorage.getItem(PUMP_BEAT_KEY) || 'null'); } catch (e) { return null; }
  }
  function readEpoch() {
    try { const n = parseInt(localStorage.getItem(PUMP_EPOCH_KEY) || '0', 10); return isNaN(n) ? 0 : n; } catch (e) { return 0; }
  }
  function writeBeat() {
    try { localStorage.setItem(PUMP_BEAT_KEY, JSON.stringify({ t: Date.now(), e: pumpEpoch })); } catch (e) { }
  }

  // 拿到锁：记下当前代数并开始心跳，持锁至页面关闭
  function holdPumpLock(lock) {
    if (!lock) return; // ifAvailable 未抢到
    pumpLockHeld = true;
    pumpEpoch = readEpoch();
    writeBeat();
    scanAndPump();
    return new Promise(() => { });
  }

  function requestPumpLock(opts) {
    try { return navigator.locks.request(PUMP_LOCK, opts, holdPumpLock); } catch (e) { return Promise.reject(e); }
  }

  function acquirePumpLock() {
    if (!navigator.locks || !navigator.locks.request) { pumpLockHeld = true; scanAndPump(); return; }
    // 阻塞式请求（不加 ifAvailable）：锁被占用时在浏览器内排队，
    // 持锁页签关闭后自动移交到本页签，无需刷新页面
    requestPumpLock({}).catch(() => {
      pumpLockHeld = false;
      setTimeout(() => { requestPumpLock({}).catch(() => { }); }, 2000);
    });
  }

  // 兜底：持锁页签被浏览器冻结（后台省电/内存回收）时锁不会释放但心跳停止——
  // 有待处理任务且心跳过期时抢回调度权，把下载收回到当前活跃页签
  function stealPumpLockIfStale() {
    if (pumpLockHeld || !lsOk || !navigator.locks || !navigator.locks.request) return;
    if (!tasks.some(t => t.state === 'pending')) return;
    const beat = readBeat();
    if (beat && Date.now() - beat.t < PUMP_STALE_MS) return;
    try { localStorage.setItem(PUMP_EPOCH_KEY, String(readEpoch() + 1)); } catch (e) { return; }
    // 先温和尝试：持锁页签其实已关闭时锁已被浏览器释放，普通请求即可拿到；
    // 仍被占用（冻结页签占着锁）才强制抢占
    requestPumpLock({ ifAvailable: true })
      .then(lock => lock === null ? requestPumpLock({ steal: true }).catch(() => { }) : null)
      .catch(() => { });
  }

  // ===== 初始化 =====

  // 跨页签同步：把 IDB 里的最新任务态并入本页内存（不覆盖本页正在运行的任务）
  async function syncFromDb() {
    let recs = [];
    try { recs = await idbAll(STORE_TASKS) || []; } catch (e) { return; }
    const byId = new Map(recs.map(r => [r.id, r]));
    // 更新/新增
    byId.forEach((rec, id) => {
      // 防僵尸：downloading/merging 记录超过 8s 无心跳（运行方节流落库会持续刷新 updatedAt），
      // 说明运行方已消失（崩溃/关页）——转 pending 自动续传，避免永远"下载中"却不动
      if ((rec.state === 'downloading' || rec.state === 'merging') && Date.now() - (rec.updatedAt || 0) > 8000) {
        rec.state = 'pending';
      }
      const local = tasks.find(t => t.id === id);
      if (!local) {
        tasks.push(Object.assign({ speed: 0, _plan: null }, rec));
        return;
      }
      const runningHere = activeRun && activeRun.taskId === id;
      if (runningHere) return; // 本页运行中，以本页实时进度为准
      if ((rec.updatedAt || 0) > (local.updatedAt || 0)) {
        Object.assign(local, rec, { speed: 0, _plan: local._plan || null });
      }
    });
    // 删除（本页未在运行的才移除）
    for (let i = tasks.length - 1; i >= 0; i--) {
      if (!byId.has(tasks[i].id) && !(activeRun && activeRun.taskId === tasks[i].id)) {
        tasks.splice(i, 1);
      }
    }
  }

  async function init() {
    if (inited) return;
    inited = true;
    try {
      const recs = await idbAll(STORE_TASKS) || [];
      recs.forEach(r => {
        // 异常中断恢复：downloading/merging → pending 自动续传
        // （断点续传按分片落库，重启后从已存分片继续；不用 pagehide 落库——
        //  异步写与关页竞态会把旧状态写回 IDB，产生僵尸任务）
        if (r.state === 'downloading' || r.state === 'merging') r.state = 'pending';
        tasks.push(Object.assign({ speed: 0, _plan: null }, r));
      });
    } catch (e) { }
    acquirePumpLock();
    setInterval(async () => {
      // 本页签的调度锁被其它页签抢占（抢锁代数已变）→ 让位，停止调度
      if (pumpLockHeld && readEpoch() !== pumpEpoch) pumpLockHeld = false;
      if (pumpLockHeld) writeBeat(); // 持锁心跳：其它页签据此判断本页签是否存活
      await syncFromDb();
      scanAndPump();
      stealPumpLockIfStale();
    }, 2500);
    scanAndPump();
    emit(true); // 初始化后刷新导航徽标等订阅 UI
  }

  init();

  // ===== 下载管理器 UI =====

  let managerTick = null;

  function ensureManagerDom() {
    if (document.getElementById('wdtvDlManager')) return;
    const root = document.createElement('div');
    root.id = 'wdtvDlManager';
    root.className = 'wdtv-dl-overlay hidden';
    root.innerHTML = `
      <div class="wdtv-dl-manager" role="dialog" aria-label="下载管理">
        <div class="wdtv-dl-header">
          <div class="wdtv-dl-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            下载管理
          </div>
          <button type="button" class="wdtv-dl-close" title="关闭">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="wdtv-dl-list" id="wdtvDlList"></div>
        <div class="wdtv-dl-footer">
          <span class="wdtv-dl-hint">文件保存到浏览器下载目录，任务完成后可重新保存</span>
          <button type="button" class="wdtv-dl-footer-btn" id="wdtvDlClearDone">清除已完成</button>
        </div>
      </div>`;
    document.body.appendChild(root);

    // 移动端提示：下载期间锁屏/切后台会冻结网络，完成后导出方式也不同
    if (IS_MOBILE) {
      const hint = root.querySelector('.wdtv-dl-hint');
      if (hint) hint.textContent = IS_IOS
        ? '下载期间请保持本页面在前台；完成后点「保存」→ 分享面板选「存储到文件」'
        : '下载期间请保持本页面在前台（已自动保持屏幕常亮），文件直存下载目录';
    }

    root.addEventListener('click', (e) => {
      if (e.target === root) { closeManager(); return; }
      const close = e.target.closest('.wdtv-dl-close');
      if (close) { closeManager(); return; }
      if (e.target.closest('#wdtvDlClearDone')) { clearDoneTasks(); return; }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const card = btn.closest('.wdtv-dl-task');
      if (!card) return;
      const id = card.dataset.id;
      const act = btn.dataset.act;
      if (act === 'pause') pauseTask(id);
      else if (act === 'resume') resumeTask(id);
      else if (act === 'retry') retryTask(id);
      else if (act === 'save') saveTask(id);
      else if (act === 'share') shareTask(id);
      else if (act === 'delete') deleteTask(id);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!root.classList.contains('hidden')) closeManager();
        const batch = document.getElementById('wdtvDlBatch');
        if (batch && !batch.classList.contains('hidden')) closeBatchModal();
      }
    });
  }

  function taskStateText(t) {
    switch (t.state) {
      case 'pending': return '排队中';
      case 'downloading': {
        const pct = t.totalFrags ? Math.floor(t.doneFrags / t.totalFrags * 100) : 0;
        const spd = t.speed ? ' · ' + fmtBytes(t.speed) + '/s' : '';
        return `下载中 ${pct}%${spd} · ${fmtBytes(t.bytes)}`;
      }
      case 'paused': {
        const pct = t.totalFrags ? Math.floor(t.doneFrags / t.totalFrags * 100) : 0;
        return `已暂停 ${pct}%`;
      }
      case 'merging': return '正在合成视频文件…';
      case 'done': return `已完成 · ${fmtBytes(t.fileSize)}${t.fileSaved ? '' : ' · 待保存'}`;
      case 'error': return `失败：${t.error || '未知错误'}`;
      default: return t.state;
    }
  }

  function taskActionsHtml(t) {
    const btn = (act, label, cls) => `<button type="button" class="wdtv-dl-act ${cls || ''}" data-act="${act}">${label}</button>`;
    switch (t.state) {
      case 'downloading':
      case 'pending':
        return btn('pause', '暂停');
      case 'paused':
        return btn('resume', '继续') + btn('delete', '删除', 'danger');
      case 'merging':
        return btn('delete', '删除', 'danger');
      case 'done':
        return btn('save', '保存') + (SHARE_FILES_OK ? btn('share', '分享') : '') + btn('delete', '删除', 'danger');
      case 'error':
        return btn('retry', '重试') + btn('delete', '删除', 'danger');
      default:
        return '';
    }
  }

  function renderManager() {
    const list = document.getElementById('wdtvDlList');
    if (!list) return;
    if (!tasks.length) {
      list.innerHTML = '<div class="wdtv-dl-empty">暂无下载任务<br><span>在视频播放界面点击「下载」按钮即可下载本集或多集</span></div>';
      return;
    }
    const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt); // 新任务在前
    list.innerHTML = sorted.map(t => {
      const pct = t.totalFrags ? Math.min(100, Math.floor(t.doneFrags / t.totalFrags * 100)) : (t.state === 'done' ? 100 : 0);
      const dur = fmtDuration(t.durationSec);
      return `
      <div class="wdtv-dl-task state-${t.state}" data-id="${t.id}">
        <div class="wdtv-dl-task-top">
          <span class="wdtv-dl-task-name" title="${escapeHtml(t.title)} ${escapeHtml(t.episodeLabel)}">${escapeHtml(t.title)}${t.episodeLabel ? ' · ' + escapeHtml(t.episodeLabel) : ''}</span>
          <span class="wdtv-dl-task-tags">
            ${t.quality && t.quality !== '默认' ? `<em class="wdtv-dl-tag">${escapeHtml(t.quality)}</em>` : ''}
            <em class="wdtv-dl-tag">${t.format === 'ts' ? 'TS' : 'MP4'}</em>
            ${dur ? `<em class="wdtv-dl-tag dim">${dur}</em>` : ''}
          </span>
        </div>
        <div class="wdtv-dl-task-progress"><div class="wdtv-dl-task-fill state-${t.state}" style="width:${pct}%"></div></div>
        <div class="wdtv-dl-task-bottom">
          <span class="wdtv-dl-task-status state-${t.state}">${escapeHtml(taskStateText(t))}</span>
          <span class="wdtv-dl-task-actions">${taskActionsHtml(t)}</span>
        </div>
      </div>`;
    }).join('');
  }

  function openManager() {
    ensureManagerDom();
    document.getElementById('wdtvDlManager').classList.remove('hidden');
    renderManager();
    if (!managerTick) {
      managerTick = setInterval(async () => {
        await syncFromDb(); // 其它页签的进度/状态变化也实时可见
        renderManager();
      }, MANAGER_TICK);
    }
  }

  function closeManager() {
    const el = document.getElementById('wdtvDlManager');
    if (el) el.classList.add('hidden');
    if (managerTick) { clearInterval(managerTick); managerTick = null; }
  }

  // ===== 批量下载弹窗 =====

  let batchCtx = null; // { opts, selected:Set, qualityIdx, format }

  function ensureBatchDom() {
    if (document.getElementById('wdtvDlBatch')) return;
    const root = document.createElement('div');
    root.id = 'wdtvDlBatch';
    root.className = 'wdtv-dl-overlay hidden';
    root.innerHTML = `
      <div class="wdtv-dl-manager wdtv-dl-batch" role="dialog" aria-label="批量下载">
        <div class="wdtv-dl-header">
          <div class="wdtv-dl-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <span id="wdtvDlBatchTitle">批量下载</span>
          </div>
          <button type="button" class="wdtv-dl-close" title="关闭">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="wdtv-dl-batch-body">
          <div id="wdtvDlBatchQuality" class="wdtv-dl-opt-row"></div>
          <div id="wdtvDlBatchFormat" class="wdtv-dl-opt-row"></div>
          <div class="wdtv-dl-batch-tools">
            <span class="wdtv-dl-opt-label">选择集数</span>
            <span class="wdtv-dl-batch-tools-btns">
              <button type="button" class="wdtv-dl-mini" id="wdtvDlBatchAll">全选</button>
              <button type="button" class="wdtv-dl-mini" id="wdtvDlBatchNone">清空</button>
              <button type="button" class="wdtv-dl-mini" id="wdtvDlBatchCur">仅本集</button>
            </span>
          </div>
          <div class="wdtv-dl-ep-grid" id="wdtvDlBatchGrid"></div>
        </div>
        <div class="wdtv-dl-footer">
          <span class="wdtv-dl-hint" id="wdtvDlBatchHint"></span>
          <button type="button" class="wdtv-dl-confirm" id="wdtvDlBatchConfirm">下载选中</button>
        </div>
      </div>`;
    document.body.appendChild(root);

    root.addEventListener('click', (e) => {
      if (e.target === root) { closeBatchModal(); return; }
      if (e.target.closest('.wdtv-dl-close')) { closeBatchModal(); return; }
      if (!batchCtx) return;
      if (e.target.closest('#wdtvDlBatchAll')) { batchCtx.selected = new Set(batchCtx.opts.episodes.map((_, i) => i)); renderBatchGrid(); return; }
      if (e.target.closest('#wdtvDlBatchNone')) { batchCtx.selected = new Set(); renderBatchGrid(); return; }
      if (e.target.closest('#wdtvDlBatchCur')) {
        batchCtx.selected = new Set(batchCtx.opts.currentEpisodeIndex != null ? [batchCtx.opts.currentEpisodeIndex] : [0]);
        renderBatchGrid(); return;
      }
      const q = e.target.closest('[data-qidx]');
      if (q) { batchCtx.qualityIdx = parseInt(q.dataset.qidx, 10); renderBatchOptions(); return; }
      const f = e.target.closest('[data-fmt]');
      if (f) { batchCtx.format = f.dataset.fmt; renderBatchOptions(); return; }
      const ep = e.target.closest('[data-ep]');
      if (ep) {
        const i = parseInt(ep.dataset.ep, 10);
        if (batchCtx.selected.has(i)) batchCtx.selected.delete(i); else batchCtx.selected.add(i);
        renderBatchGrid();
        return;
      }
      if (e.target.closest('#wdtvDlBatchConfirm')) { confirmBatch(); return; }
    });
  }

  function renderBatchOptions() {
    const qRow = document.getElementById('wdtvDlBatchQuality');
    const fRow = document.getElementById('wdtvDlBatchFormat');
    if (!qRow || !fRow || !batchCtx) return;
    const qs = batchCtx.opts.qualities || [];
    qRow.innerHTML = qs.length > 1
      ? `<span class="wdtv-dl-opt-label">画质</span><span class="wdtv-dl-opt-chips">${qs.map((q, i) =>
        `<button type="button" class="wdtv-dl-chip${i === batchCtx.qualityIdx ? ' active' : ''}" data-qidx="${i}">${escapeHtml(q.label)}</button>`).join('')}</span>`
      : (qs.length === 1 ? `<span class="wdtv-dl-opt-label">画质</span><span class="wdtv-dl-opt-chips"><span class="wdtv-dl-chip static">${escapeHtml(qs[0].label)}</span></span>` : '');
    fRow.innerHTML = `<span class="wdtv-dl-opt-label">格式</span><span class="wdtv-dl-opt-chips">
        <button type="button" class="wdtv-dl-chip${batchCtx.format === 'mp4' ? ' active' : ''}" data-fmt="mp4">MP4（推荐）</button>
        ${IS_IOS ? '' : `<button type="button" class="wdtv-dl-chip${batchCtx.format === 'ts' ? ' active' : ''}" data-fmt="ts">TS 原流</button>`}
      </span>`;
  }

  function renderBatchGrid() {
    const grid = document.getElementById('wdtvDlBatchGrid');
    const hint = document.getElementById('wdtvDlBatchHint');
    const confirm = document.getElementById('wdtvDlBatchConfirm');
    if (!grid || !batchCtx) return;
    const eps = batchCtx.opts.episodes;
    // epNums：由播放器按当前排序方式（默认/综艺/倒序）传入的展示编号；未传时退回位置序号
    const nums = Array.isArray(batchCtx.opts.epNums) ? batchCtx.opts.epNums : null;
    grid.innerHTML = eps.map((_, i) => {
      const info = nums && nums[i];
      const numHtml = info
        ? `<span class="wdtv-dl-ep-num">${escapeHtml(String(info.num))}${info.sub != null ? `<em class="wdtv-dl-ep-sub">(${escapeHtml(String(info.sub))})</em>` : ''}</span>`
        : `<span class="wdtv-dl-ep-num">${i + 1}</span>`;
      // 综艺排序的分组间隔行（独占一行的组标题，视觉上隔开两组）
      const brk = info && info.groupLabel
        ? `<div class="wdtv-dl-ep-break">${escapeHtml(info.groupLabel)}</div>`
        : '';
      return `${brk}<button type="button" class="wdtv-dl-ep${batchCtx.selected.has(i) ? ' selected' : ''}${i === batchCtx.opts.currentEpisodeIndex ? ' current' : ''}" data-ep="${i}">
        ${numHtml}${i === batchCtx.opts.currentEpisodeIndex ? '<em class="wdtv-dl-ep-cur">本集</em>' : ''}
      </button>`;
    }).join('');
    const n = batchCtx.selected.size;
    if (hint) hint.textContent = `已选 ${n} / ${eps.length} 集`;
    if (confirm) confirm.textContent = n ? `下载选中 ${n} 集` : '下载选中';
  }

  function confirmBatch() {
    if (!batchCtx) return;
    const { opts, selected, qualityIdx, format } = batchCtx;
    if (!selected.size) { toast('请先选择要下载的集数', 'info'); return; }
    const qs = opts.qualities || [];
    const q = qs[qualityIdx] || null;
    const mapper = typeof opts.mapEpisodeUrl === 'function' ? opts.mapEpisodeUrl : null;
    // episodeLabels：由播放器按当前排序传入的真实集数标签（原集数），未传时退回位置序号
    const labels = Array.isArray(opts.episodeLabels) ? opts.episodeLabels : null;
    const items = [...selected].sort((a, b) => a - b).map(i => {
      const epUrl = opts.episodes[i];
      let url = epUrl;
      if (mapper) {
        try { url = mapper(epUrl, q) || epUrl; } catch (e) { url = epUrl; }
      }
      const multi = opts.episodes.length > 1;
      return {
        url,
        title: opts.title || '未知视频',
        episodeLabel: multi ? ((labels && labels[i]) || `第${i + 1}集`) : '',
        quality: q ? q.label : '默认',
        qualityHint: q ? (q.hint || null) : null,
        format
      };
    });
    closeBatchModal();
    enqueue(items);
  }

  function openBatchDownloadModal(opts) {
    opts = opts || {};
    if (!Array.isArray(opts.episodes) || !opts.episodes.length) {
      toast('没有可下载的集数', 'info');
      return;
    }
    ensureBatchDom();
    const qualityCount = (opts.qualities || []).length;
    const qualityIdx = Math.max(0, opts.defaultQualityIndex != null ? opts.defaultQualityIndex : 0);
    // 默认全选；超过 30 集时只选当前集，避免误触发大批量任务
    const defaultSel = opts.episodes.length <= 30
      ? new Set(opts.episodes.map((_, i) => i))
      : new Set([opts.currentEpisodeIndex != null ? opts.currentEpisodeIndex : 0]);
    batchCtx = {
      opts,
      selected: defaultSel,
      qualityIdx: Math.min(qualityIdx, Math.max(0, qualityCount - 1)),
      format: 'mp4'
    };
    document.getElementById('wdtvDlBatchTitle').textContent = `批量下载${opts.title ? ' · ' + opts.title : ''}`;
    renderBatchOptions();
    renderBatchGrid();
    document.getElementById('wdtvDlBatch').classList.remove('hidden');
  }

  function closeBatchModal() {
    const el = document.getElementById('wdtvDlBatch');
    if (el) el.classList.add('hidden');
    batchCtx = null;
  }

  // ===== 对外 API =====

  window.WDTDownloader = {
    enqueue,
    openManager,
    closeManager,
    openBatchDownloadModal,
    closeBatchModal,
    pauseTask,
    resumeTask,
    retryTask,
    deleteTask,
    saveTask,
    getActiveCount() { return getPublicStats().active; },
    getStats: getPublicStats,
    // 调试口：读取任务运行时状态（速度/网络字节等，不在持久化字段里）
    _debug() {
      return tasks.map(t => ({
        id: t.id, state: t.state, speed: Math.round(t.speed || 0),
        netBytes: t._netBytes || 0, bytes: t.bytes, doneFrags: t.doneFrags, totalFrags: t.totalFrags
      }));
    },
    onChange(cb) {
      if (typeof cb !== 'function') return () => { };
      listeners.add(cb);
      return () => listeners.delete(cb);
    }
  };
})();
