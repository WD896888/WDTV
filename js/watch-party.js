// js/watch-party.js —— 双人共同观影客户端核心模块
// 职责：房间连接（REST create/join + WS + 心跳 + 指数退避重连）、信令收发、
//       防回声三道闸（闸1 本地抑制包装 / 闸2 应用远端前抑制 / 闸3 在服务端）、
//       时钟对齐（房主 tick 锚点 + 观影方自纠偏）、聊天（断线待发队列）、共享画布（整笔折线）。
// 契约：消息字段与 sync-worker/src/index.js 的 WatchRoom DO 严格一致；
//       uid 比较一律 String(a) === String(b)（服务端 uid 可能是数字或字符串）。
// 宿主：由 player.js 调 WatchParty.init({getArt,getHls,getVideoKey,getTitle,getEpisode})，
//       art 可能尚未创建，getter 惰性求值；UI/local 模块经事件与 localHooks 协作。
(function () {
  'use strict';

  // ============================================================
  // 常量（与服务端契约 / 设计约束对齐）
  // ============================================================
  var SUPPRESS_MS = 600;      // 防回声抑制窗时长（闸1/闸2 共用）
  var HEARTBEAT_MS = 15000;   // 心跳周期（服务端 setWebSocketAutoResponse 精确配对）
  var TICK_MS = 3000;         // 房主 tick 锚点周期
  var REPORT_MS = 10000;      // pos / buf 上报周期
  var HB_LIT = '{"t":"hb"}';  // 心跳字面量：必须与服务端 autoResponse 请求串精确一致
  var DRAW_MIN_DIST = 0.002;  // 画笔收点最小归一化距离（抗抖动）
  var DRAW_FLUSH_MS = 100;    // 画笔增量批量发送周期
  var CHAT_MAX_LEN = 500;     // 单条聊天最大长度（服务端同限）
  var CHAT_QUEUE_MAX = 20;    // 断线待发聊天队列上限
  var RETRY_BASE_MS = 800;    // 重连退避基数
  var RETRY_CAP_MS = 15000;   // 重连退避封顶
  var TOKEN_KEY_PREFIX = 'wdtvWatchToken:'; // roomToken 持久化键前缀（刷新免 join 直连）
  var WS_BASE_KEY = 'wdtvSyncWsBase';       // 调试用 WS 地址覆盖
  var AUTH_TOKEN_KEY = 'wdtv_auth_token';   // 登录 JWT（与 cloud-sync.js 一致）
  var RECENT_KEY = 'wdtvWatchRecent';       // 最近房间列表（与 space.js 共用 [{code,title,ts}]）

  // ============================================================
  // 运行时状态（单例）
  // ============================================================
  var st = {
    getters: null,            // 宿主取值器 {getArt,getHls,getVideoKey,getTitle,getEpisode}（惰性）
    localHooks: {},           // 本地能力钩子（watch-party-local 注册）：coverageReport/lockLevel/m3Play/m3Exit/applySrcRedirect
    code: null,               // 房间码
    roomToken: null,          // 房间作用域凭证
    ws: null,                 // 当前 WebSocket
    connected: false,
    manualClose: false,       // leave()/error 主动关闭：不再自动重连
    retry: 0,                 // 重连退避指数
    retryTimer: 0,
    hbTimer: 0, tickTimer: 0, reportTimer: 0,
    hbSentAt: 0,              // 最近一次心跳发送时刻（Date.now，测 RTT）
    rtt: null,
    role: null,               // 'host' | 'guest' | null（snap 前未知）
    lastEpoch: 0,             // epoch 乱序保护（ctl 与 src 共用同一计数）
    suppressUntil: 0,         // 防回声抑制窗截止（performance.now 时基）
    room: { mode: null, mediaKey: null, title: null, hostUid: null, playing: false, time: 0, rate: 1 },
    online: [],               // 在线 uid 列表（snap/presence 维护）
    peer: { uid: null, name: null, time: null, buf: null, cached: null },
    readyMap: {},             // String(uid) -> info（对端 M2 覆盖率 / M3 指纹与时长）
    pendingAlign: null,       // {time, playing, rate} 待视频元数据就绪后应用的对齐
    pendingM2Report: null,    // M2 mediaKey：视频未就绪时暂存，对齐成功后补报覆盖率
    autoSrc: false,           // 房主带 room 选片场景：视频就绪且房间无片源时自动发起一次 M1 共看
    m1AutoCount: 0,           // M1→M2 自动升级计数（双方覆盖率 ≥99% 连续 2 次上报）
    playBlocked: false,       // 静音降级也失败（极罕见）：待用户任意点击后重试
    gestureArm: null,         // 一次性全局点击监听（静音恢复声音用）
    shared: false,            // 控制权共享（房主开启）：所有成员均可发送播放控制与选片
    chatQueue: [],            // 断线待发聊天文本
    coveragePercent: null,    // 本端最近一次 M2 覆盖率（buf 上报 cached 字段）
    slowCount: 0,             // 对端连续低缓冲计数
    slowNotified: false,      // 本轮 slowpeer 是否已提示（避免重复打扰）
    wrappedArt: null,         // 已包装 play/pause 的 art 实例（防重复包装 / 换实例重挂）
    origPlay: null,
    origPause: null
  };

  var listeners = Object.create(null); // 事件 -> [cb]

  // ============================================================
  // 事件总线
  // ============================================================
  function on(event, cb) {
    if (typeof event !== 'string' || typeof cb !== 'function') return function () {};
    (listeners[event] || (listeners[event] = [])).push(cb);
    return function () { // 退订函数
      var arr = listeners[event];
      if (!arr) return;
      var i = arr.indexOf(cb);
      if (i !== -1) arr.splice(i, 1);
    };
  }

  function emit(event, payload) {
    var arr = listeners[event];
    if (!arr || !arr.length) return;
    arr.slice().forEach(function (cb) {
      try { cb(payload); } catch (e) { console.warn('[WatchParty] 事件回调异常:', e); }
    });
  }

  // ============================================================
  // 身份与基础工具
  // ============================================================
  function authToken() {
    try { return localStorage.getItem(AUTH_TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  // 解码 JWT payload（base64url → JSON）：uid 数字 / un 昵称兜底
  function jwtPayload() {
    try {
      var tk = authToken();
      if (!tk) return null;
      var parts = tk.split('.');
      if (parts.length < 2) return null;
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var bytes = Uint8Array.from(atob(b64), function (ch) { return ch.charCodeAt(0); });
      return JSON.parse(new TextDecoder('utf-8').decode(bytes));
    } catch (e) { return null; }
  }

  function myUid() {
    var p = jwtPayload();
    return p && p.uid !== undefined ? p.uid : null;
  }

  // 昵称：CloudSync.getStatus() 的 nickname||username 优先，JWT payload.un 兜底
  function myName() {
    try {
      var cs = window.CloudSync;
      if (cs && typeof cs.getStatus === 'function') {
        var s = cs.getStatus();
        var n = s && (s.nickname || s.username);
        if (n) return String(n).slice(0, 32); // 与服务端 MAX_NAME_LEN 对齐
      }
    } catch (e) { }
    var p = jwtPayload();
    var n2 = p && (p.un || p.username);
    return n2 ? String(n2).slice(0, 32) : '用户';
  }

  // WS 基址：调试覆盖（wdtvSyncWsBase，绝对 ws/wss）或同源；http(s) 自动转 ws(s)
  function wsBase() {
    var base = '';
    try { base = localStorage.getItem(WS_BASE_KEY) || ''; } catch (e) { }
    base = String(base).trim();
    if (!base) base = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    if (/^https:\/\//i.test(base)) base = 'wss://' + base.slice(8);
    else if (/^http:\/\//i.test(base)) base = 'ws://' + base.slice(7);
    return base.replace(/\/+$/, '');
  }

  function safeGetter(fn) {
    try { return typeof fn === 'function' ? fn() : null; } catch (e) { return null; }
  }

  function getArt() {
    return st.getters ? safeGetter(st.getters.getArt) : null;
  }

  function artVideo() {
    var a = getArt();
    return a && a.video ? a.video : null;
  }

  // 防回声抑制窗（闸1/闸2 共用实现）
  function suppress() { st.suppressUntil = performance.now() + SUPPRESS_MS; }
  function isSuppressed() { return performance.now() < st.suppressUntil; }

  // 发送 JSON 帧；未连接返回 false（聊天走队列等上层策略）
  function send(obj) {
    try {
      if (st.ws && st.ws.readyState === 1) {
        st.ws.send(JSON.stringify(obj));
        return true;
      }
    } catch (e) { }
    return false;
  }

  // 对端 uid：peer 记录优先，online 中非自己者兜底
  function peerUid() {
    if (st.peer.uid != null && String(st.peer.uid) !== String(myUid())) return st.peer.uid;
    var other = null;
    for (var i = 0; i < st.online.length; i++) {
      if (String(st.online[i]) !== String(myUid())) { other = st.online[i]; break; }
    }
    return other;
  }

  function peerInfo() {
    var pu = peerUid();
    return pu == null ? null : (st.readyMap[String(pu)] || null);
  }

  // URL ?url= 参数是否已等于目标片源（防整页跳转循环）：带参跳回后 player 初始化期间
  // currentVideoUrl 尚未就绪、或清晰度目录探测会改写该值，都会让 getVideoKey 比对失真；
  // 此时绝不能再跳转，改走本地对齐等待
  function urlParamMatches(target) {
    if (!target) return false;
    try {
      var u = new URLSearchParams(location.search).get('url');
      if (!u) return false;
      if (u === target) return true;
      try { return decodeURIComponent(u) === target; } catch (e2) { return false; }
    } catch (e) { return false; }
  }

  // 视频前方缓冲秒数（buffered 末端 - 当前时间）
  function bufferedAhead(v) {
    try {
      var b = v.buffered;
      if (!b || !b.length) return 0;
      var end = 0;
      for (var i = 0; i < b.length; i++) {
        if (b.end(i) > v.currentTime - 0.5 && b.end(i) > end) end = b.end(i);
      }
      return Math.max(0, end - v.currentTime);
    } catch (e) { return 0; }
  }

  // M3 时长兜底：对端 ready info.duration 与本地差 >1s 时按播放百分比换算到本地时长轴
  function m3AlignTarget(remoteTime) {
    if (st.room.mode !== 'M3') return remoteTime;
    var v = artVideo();
    if (!v) return remoteTime;
    var myDur = v.duration || 0;
    var info = peerInfo();
    var peerDur = info && typeof info.duration === 'number' ? info.duration : 0;
    if (myDur > 0 && peerDur > 0 && Math.abs(myDur - peerDur) > 1) {
      return remoteTime / peerDur * myDur;
    }
    return remoteTime;
  }

  // ============================================================
  // 房间 REST：create / join（401/503 等错误码透传给调用方做中文映射）
  // ============================================================
  function requestRoom(path, body) {
    var headers = {};
    var tk = authToken();
    if (tk) headers['Authorization'] = 'Bearer ' + tk;
    if (body) headers['Content-Type'] = 'application/json';
    var init = { method: 'POST', headers: headers };
    if (body) init.body = JSON.stringify(body);
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          // 404 = 房间服务不存在（本地 dev 未启用或线上未部署 sync-worker）→ 给出可操作的指引文案
          if (res.status === 404) throw { code: 'sync_unconfigured' };
          var fallback = res.status === 401 ? 'unauthorized'
            : res.status === 503 ? 'sync_unconfigured'
              : 'roomError';
          throw { code: (data && data.error) || fallback };
        }
        return data || {};
      });
    }, function () {
      throw { code: 'network' };
    });
  }

  function createRoom() {
    return requestRoom('/api/room/create', null).then(function (d) {
      // 建房即自动以当前视频发起 M1（完全无感）：视频已就绪 → 连接成功（onSnap）后立即发起；
      // 未就绪 → onMetadata 时发起。tryAutoSrc 内部有 role/mode/blob 守卫，
      // guest / 已有片源 / M3 本地播放等场景自动跳过。之后由既有机制在双方缓存
      // 覆盖率 ≥99%（连续 2 次上报）时自动无缝升级 M2，全程无需手动点击。
      st.autoSrc = true;
      return { code: d.code, roomToken: d.roomToken };
    });
  }

  function joinRoom(code) {
    var c = String(code == null ? '' : code).trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(c)) return Promise.reject({ code: 'badRoom' });
    return requestRoom('/api/room/join', { code: c }).then(function (d) {
      return {
        code: d.code,
        roomToken: d.roomToken,
        mode: d.mode === undefined ? null : d.mode,
        mediaKey: d.mediaKey === undefined ? null : d.mediaKey,
        title: d.title === undefined ? null : d.title,
        hostUid: d.hostUid === undefined ? null : d.hostUid
      };
    });
  }

  // ============================================================
  // WS 连接管理（心跳 / 指数退避重连）
  // ============================================================
  function connect(code, roomToken) {
    if (!code || !roomToken) return;
    resetRoomState();
    st.code = String(code).trim().toUpperCase();
    st.roomToken = String(roomToken);
    try { localStorage.setItem(TOKEN_KEY_PREFIX + st.code, st.roomToken); } catch (e) { }
    st.manualClose = false;
    closeSocket();
    openSocket();
  }

  function resetRoomState() {
    st.role = null;
    st.shared = false;
    st.lastEpoch = 0;
    st.pendingAlign = null;
    st.pendingM2Report = null;
    // 注意：此处不得清除 st.autoSrc——createRoom 设置 autoSrc=true 后 UI 立即调
    // connect()，若在此清除则 onSnap/onMetadata 时 tryAutoSrc 永远不触发（建房自动
    // 发起 M1 失效的根因）。需要清除的场景均已有显式清除：leave()、房主接任。
    st.m1AutoCount = 0;
    st.coveragePercent = null;
    st.slowCount = 0;
    st.slowNotified = false;
    st.room = { mode: null, mediaKey: null, title: null, hostUid: null };
    st.online = [];
    st.peer = { uid: null, name: null, time: null, buf: null, cached: null };
    st.readyMap = {};
  }

  // 静默关闭当前连接（摘掉事件钩子，避免触发重连逻辑）
  function closeSocket() {
    if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = 0; }
    stopTimers();
    var ws = st.ws;
    st.ws = null;
    if (ws) {
      try {
        ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null;
        ws.close();
      } catch (e) { }
    }
    if (st.connected) {
      st.connected = false;
      emit('status', { connected: false, rtt: st.rtt });
    }
  }

  function openSocket() {
    if (!st.code || !st.roomToken) return;
    // 建新连接前摘掉旧 socket 的事件钩子：旧连接迟到的 close 事件不得清掉
    // 新连接的计时器/引用（否则重连后心跳/tick 全部停摆、还会触发多余重连）
    var old = st.ws;
    if (old) {
      try { old.onopen = null; old.onmessage = null; old.onclose = null; old.onerror = null; } catch (e) { }
      try { old.close(); } catch (e) { }
      st.ws = null;
    }
    // uid 不上 URL：服务端从 roomToken 反解（防伪造）；昵称由 Function 限长透传
    var url = wsBase() + '/api/room/ws?room=' + encodeURIComponent(st.code) +
      '&token=' + encodeURIComponent(st.roomToken) +
      '&name=' + encodeURIComponent(myName());
    var ws;
    try { ws = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
    st.ws = ws;
    ws.onopen = handleOpen;
    ws.onmessage = handleWsMessage;
    ws.onclose = handleClose;
    ws.onerror = function () { try { ws.close(); } catch (e) { } };
  }

  function scheduleReconnect() {
    if (st.manualClose || !st.code || !st.roomToken) return;
    if (st.retryTimer) return;
    // 指数退避 800ms×2^n，封顶 15s；重连成功后由服务端 snap 全量恢复
    var delay = Math.min(RETRY_BASE_MS * Math.pow(2, st.retry), RETRY_CAP_MS);
    st.retry++;
    st.retryTimer = setTimeout(function () {
      st.retryTimer = 0;
      openSocket();
    }, delay);
  }

  // 移动端切后台：定时器冻结、WS 迟早被服务端/网络回收；回到前台时立即探测并
  // 重连，不等退避定时器与关闭事件派发（否则回前台后长时间停留在陈旧界面）。
  // 连接看似存活时先补发一次心跳，尽快刷新服务端会话并测得新 RTT
  function handleVisibilityResume() {
    if (st.manualClose || !st.code || !st.roomToken) return;
    if (st.ws && (st.ws.readyState === 0 || st.ws.readyState === 1)) {
      if (st.ws.readyState === 1) {
        try { st.hbSentAt = Date.now(); st.ws.send(HB_LIT); } catch (e) { }
      }
      return; // 正在握手或已连接：交给常规流程
    }
    if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = 0; }
    st.retry = 0;
    openSocket();
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        try { handleVisibilityResume(); } catch (e) { }
      }
    });
  }

  function handleOpen() {
    st.retry = 0; // 重置退避指数
    st.connected = true;
    emit('status', { connected: true, rtt: st.rtt });
    // 连接首包 hello（服务端忽略未知类型，发出仅为契约完整）
    send({ t: 'hello', ua: String(navigator.userAgent || '').slice(0, 120) });
    try { ensureWrapped(); } catch (e) { } // 任何异常不得中断 startTimers（心跳/tick/上报）
    startTimers();
  }

  function handleClose(ev) {
    stopTimers();
    var was = st.connected;
    st.connected = false;
    st.ws = null;
    if (was) emit('status', { connected: false, rtt: st.rtt });
    // 1013 = 服务端超员拒收（room full）：不重连，交由 UI 提示换房
    if (ev && ev.code === 1013) {
      emit('error', { code: 'roomFull' });
      return;
    }
    if (!st.manualClose) scheduleReconnect();
  }

  function startTimers() {
    stopTimers();
    // 心跳：字面量与 autoResponse 精确配对，零计费不唤醒 DO；回包测 RTT
    st.hbTimer = setInterval(function () {
      try {
        if (st.ws && st.ws.readyState === 1) {
          st.hbSentAt = Date.now();
          st.ws.send(HB_LIT);
        }
      } catch (e) { }
    }, HEARTBEAT_MS);
    // 房主 tick 锚点（仅播放中发送）：携带实时播放位置/倍率——
    // DO 不感知播放进度，锚点必须由房主逐次上报，否则从端会被拉回历史位置
    st.tickTimer = setInterval(function () {
      if (!st.connected || st.role !== 'host') return;
      var v = artVideo();
      if (!v || v.paused || v.ended) return;
      send({ t: 'tick', time: v.currentTime, rate: v.playbackRate });
    }, TICK_MS);
    // pos / buf 周期上报
    st.reportTimer = setInterval(reportLoop, REPORT_MS);
  }

  function stopTimers() {
    if (st.hbTimer) { clearInterval(st.hbTimer); st.hbTimer = 0; }
    if (st.tickTimer) { clearInterval(st.tickTimer); st.tickTimer = 0; }
    if (st.reportTimer) { clearInterval(st.reportTimer); st.reportTimer = 0; }
  }

  function reportLoop() {
    if (!st.connected || !st.role) return; // snap 未到（角色未知）不上报
    var v = artVideo();
    var ahead = v ? bufferedAhead(v) : 0;
    // pos 仅观影方发送（服务端转发 peerpos 给房主展示对端进度）
    if (st.role !== 'host' && v) send({ t: 'pos', time: v.currentTime, buf: ahead });
    // M1/M2 播放中周期性计算本端缓存覆盖率并上报（ready 通道，供自动升级 M2 与进度展示）
    if ((st.room.mode === 'M1' || st.room.mode === 'M2') && st.room.mediaKey) {
      try { if (st.localHooks.coverageReport) st.localHooks.coverageReport(st.room.mediaKey); } catch (e) { }
    }
    // buf 双方发送；M1/M2 附带本端缓存覆盖率
    var cached = (st.room.mode === 'M1' || st.room.mode === 'M2') ? st.coveragePercent : null;
    send({ t: 'buf', buf: ahead, cached: cached === undefined ? null : cached });
    tryAutoUpgradeM2();
  }

  // M1 自动升级 M2（仅房主）：双方缓存覆盖率 ≥99% 连续 2 次上报 → 无缝切换缓存模式
  // （同 URL 重发 src，双方锁档禁 ABR，之后分片命中本地 IndexedDB 不再走网络）
  function tryAutoUpgradeM2() {
    if (st.role !== 'host' || st.room.mode !== 'M1' || !st.connected) return;
    var own = typeof st.coveragePercent === 'number' ? st.coveragePercent : null;
    var pu = peerUid();
    var peerInfo = pu == null ? null : (st.readyMap[String(pu)] || null);
    var peer = peerInfo && typeof peerInfo.percent === 'number' ? peerInfo.percent : null;
    if (own !== null && peer !== null && own >= 99 && peer >= 99) {
      st.m1AutoCount = (st.m1AutoCount || 0) + 1;
      if (st.m1AutoCount >= 2) {
        st.m1AutoCount = 0;
        if (startCoWatch('M2')) {
          emit('toast', { text: '双方缓存已完成，已自动切换到缓存播放（M2）' });
        }
      }
    } else {
      st.m1AutoCount = 0;
    }
  }

  // ============================================================
  // WS 消息分发（S→C）
  // ============================================================
  function handleWsMessage(ev) {
    if (typeof ev.data !== 'string') return;
    if (ev.data === HB_LIT) {
      // 心跳自动回包：测往返时延
      if (st.hbSentAt > 0) st.rtt = Date.now() - st.hbSentAt;
      emit('status', { connected: true, rtt: st.rtt });
      return;
    }
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || typeof m !== 'object' || !m.t) return;
    var recvPerf = performance.now(); // tick 时延补偿基准（消息到达时刻）
    switch (m.t) {
      case 'snap': applySnap(m); break;
      case 'presence': applyPresence(m); break;
      case 'ctl': applyCtl(m); break;
      case 'tickState': applyTick(m, recvPerf); break;
      case 'peerpos': applyPeerPos(m); break;
      case 'peerbuf': applyPeerBuf(m); break;
      case 'ready':
        st.readyMap[String(m.uid)] = m.info || {};
        emit('ready', { uid: m.uid, info: m.info });
        break;
      case 'src': applySrcMsg(m); break;
      case 'shared':
        // 控制权共享开关（房主切换）：guest 端更新本地权限并提示。
        // 服务端全量广播（含房主回显），提示语按「是否本人操作」区分措辞：
        // 房主回显 → 第一人称；嘉宾收到 → 提示其获得/失去控制权
        st.shared = !!m.on;
        emit('shared', { on: st.shared, by: m.by });
        emit('toast', {
          text: m.by !== undefined && String(m.by) === String(myUid())
            ? (m.on ? '已开放控制权：对方也可以控制播放与选片' : '已收回控制权：对方不再能控制播放')
            : (m.on ? '房主已开放控制权：你也可以控制播放与选片' : '房主已收回控制权')
        });
        emit('role', { role: st.role });
        break;
      case 'chat':
        // 对端昵称补充（服务端以连接参数为准，防伪造）
        if (m.uid !== undefined && String(m.uid) === String(peerUid()) && m.name) st.peer.name = m.name;
        emit('chat', m); // kind 'system' 同样透出（UI 负责灰色居中渲染）
        break;
      case 'stroke': canvasRemoteStroke(m); break;
      case 'undo': canvasRemoteUndo(m); break;
      case 'clear': canvasRemoteClear(m); break;
      case 'error':
        // 服务端错误（authFailed 等）：收到即断开且不重连
        emit('error', { code: m.code || 'unknown' });
        st.manualClose = true;
        closeSocket();
        break;
      default: break; // 未知类型忽略
    }
  }

  // 片名回写最近房间列表：建房/入房时未选片，space.js 记录的条目 title 为 null
  // （列表显示「未命名影片」）；此后任意一端首次得知片名（snap 恢复 / src 广播 /
  // 本端发起片源）时补写。仅就地更新已有条目，不新建——列表仍由 hub 的创建/加入产生。
  function touchRecentTitle(code, title) {
    if (!code || !title) return;
    try {
      var raw = localStorage.getItem(RECENT_KEY);
      var list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (it && it.code === code && it.title !== title) {
          it.title = title;
          localStorage.setItem(RECENT_KEY, JSON.stringify(list));
          break;
        }
      }
    } catch (e) { /* 读写失败忽略 */ }
  }

  // ============================================================
  // snap：连接后与重连后统一恢复入口
  // ============================================================
  function applySnap(m) {
    var s = m.state || {};
    st.lastEpoch = typeof s.epoch === 'number' ? s.epoch : 0;
    st.room = {
      mode: s.mode || null,
      mediaKey: s.mediaKey === undefined ? null : s.mediaKey,
      title: s.title === undefined ? null : s.title,
      hostUid: s.hostUid === undefined ? st.room.hostUid : s.hostUid,
      levelIndex: s.levelIndex === undefined ? null : s.levelIndex,
      playing: !!s.playing,
      time: typeof s.time === 'number' ? s.time : 0,
      rate: typeof s.rate === 'number' && s.rate > 0 ? s.rate : 1,
      shared: !!s.shared
    };
    touchRecentTitle(st.code, st.room.title); // 重连/刷新恢复：服务端片名补写最近房间列表
    st.shared = !!s.shared;
    st.role = String(myUid()) === String(st.room.hostUid) ? 'host' : 'guest';
    st.online = Array.isArray(m.online) ? m.online : [];
    var other = peerUid();
    if (other != null) st.peer.uid = other;
    emit('role', { role: st.role });
    // 画布历史重放（重连也全量重置，服务端 strokes 为唯一真相）
    canvasLoadStrokes(m.strokes);
    // 聊天历史回放（UI 侧按 seq 去重；kind system 同样透出）
    if (Array.isArray(m.chatTail)) {
      for (var i = 0; i < m.chatTail.length; i++) emit('chat', m.chatTail[i]);
    }
    emit('snap', {
      state: s,
      online: st.online.slice(),
      strokes: m.strokes || [],
      chatTail: m.chatTail || []
    });
    // 断线期间积压的聊天补发
    flushChatQueue();
    // 片源对齐：url 不同则换片（整页跳转由 UI/local 模块处理）；相同则待元数据就绪后对齐进度
    var cur = null;
    if (s.url) {
      cur = safeGetter(st.getters && st.getters.getVideoKey);
      if ((!cur || cur !== s.url) && !urlParamMatches(s.url)) {
        emit('applySrc', {
          video: {
            mode: s.mode, mediaKey: s.mediaKey, title: s.title, url: s.url,
            epIndex: s.epIndex, levelIndex: s.levelIndex, name: null, size: null, fp: null
          }
        });
      } else {
        st.pendingAlign = {
          time: typeof s.time === 'number' ? s.time : 0,
          playing: !!s.playing,
          rate: typeof s.rate === 'number' && s.rate > 0 ? s.rate : 1
        };
        applyAlignIfReady();
      }
    }
    // M2：本端已就位 → 触发覆盖率上报 + 从端锁清晰度档（local 模块实现）；
    // 视频未就绪（跳转回来初始化中）时暂存 mediaKey，对齐成功后补报
    if (s.mode === 'M2') {
      st.pendingM2Report = s.mediaKey || null;
      if (cur && cur === s.url) {
        st.pendingM2Report = null;
        try { if (st.localHooks.coverageReport) st.localHooks.coverageReport(s.mediaKey); } catch (e) { }
        if (st.role === 'guest' && s.levelIndex !== null && s.levelIndex !== undefined) {
          try { if (st.localHooks.lockLevel) st.localHooks.lockLevel(s.levelIndex); } catch (e) { }
        }
      }
    }
    // 房主选片归来：snap 到达时视频可能已在播 → 尝试自动发起
    tryAutoSrc();
  }

  // 对齐应用：art.video 就绪（readyState>=1）才执行，否则等 onMetadata 再试
  function applyAlignIfReady() {
    if (!st.pendingAlign) return;
    var a = getArt();
    var v = a && a.video;
    if (!a || !v || v.readyState < 1) return;
    var pa = st.pendingAlign;
    st.pendingAlign = null;
    suppress(); // 闸2：应用远端对齐前打抑制窗，避免 seek/play 触发本地事件回环上报
    var target = m3AlignTarget(typeof pa.time === 'number' ? pa.time : 0);
    try { if (Math.abs((v.currentTime || 0) - target) > 0.25) v.currentTime = target; } catch (e) { }
    try { if (pa.rate > 0) v.playbackRate = pa.rate; } catch (e) { }
    try { if (pa.playing) a.play(); else v.pause(); } catch (e) { }
    // 暂停对齐的 seek 可能被 hls 初始 startPosition 逻辑覆盖（嘉宾停在黑屏/错位）：
    // 短延迟后校验实际位置，未命中则重试（≤3 次），确保暂停态也对齐到位
    if (!pa.playing) {
      var tries = 0;
      var verifySeek = function () {
        var vv = artVideo();
        if (!vv || st.pendingAlign || tries >= 3) return; // 已有新对齐任务/退出则放弃
        tries++;
        if (Math.abs(vv.currentTime - target) > 1) {
          try { vv.currentTime = target; } catch (e) { }
          setTimeout(verifySeek, 600);
        }
      };
      setTimeout(verifySeek, 600);
    }
    // M2 覆盖率补报：进房/换片时视频未就绪而暂存的场景（对齐成功即视为本端就位）
    if (st.room.mode === 'M2' && st.pendingM2Report) {
      var mk = st.pendingM2Report;
      st.pendingM2Report = null;
      try { if (st.localHooks.coverageReport) st.localHooks.coverageReport(mk); } catch (e) { }
      if (st.role === 'guest') {
        var hls = safeGetter(st.getters && st.getters.getHls);
        var lv = st.room && st.room.levelIndex;
        if (hls && lv !== null && lv !== undefined) {
          try { if (st.localHooks.lockLevel) st.localHooks.lockLevel(lv); } catch (e) { }
        }
      }
    }
  }

  // player.js 在 video:loadedmetadata 回调里调用：包装检测 + 待定对齐应用
  function onMetadata() {
    ensureWrapped(); // loadedmetadata 是实例就绪可靠信号（换集重建后在此重新包装）
    applyAlignIfReady();
    tryAutoSrc(); // 房主选片归来：视频就绪且房间无片源 → 自动发起共看
  }

  // 自动发起（房主专用）：建房后自动以当前视频发起 M1 共看（无感）；
  // 视频就绪且房间无片源时广播 src。M3 blob / 无视频场景自动跳过
  function tryAutoSrc() {
    if (!st.autoSrc || st.role !== 'host' || !st.connected || st.room.mode) return;
    var url = safeGetter(st.getters && st.getters.getVideoKey);
    if (!url || /^blob:/i.test(url)) return; // M3 本地播放走 startM3 专用通道，不自动广播
    if (startCoWatch('M1')) {
      st.autoSrc = false;
      // 无感设计：自动发起不打扰用户，不发 toast
    }
  }

  // ============================================================
  // presence / peerpos / peerbuf
  // ============================================================
  function applyPresence(m) {
    st.online = Array.isArray(m.online) ? m.online : [];
    if (m.hostUid !== undefined) st.room.hostUid = m.hostUid;
    // 房主变动 → 角色重算（房主断开后剩余成员接任）
    var newRole = String(myUid()) === String(st.room.hostUid) ? 'host' : 'guest';
    if (newRole !== st.role) {
      st.role = newRole;
      st.autoSrc = false; // 选片归来的自动发起只属于原房主场景，接任后不再自动发包
      if (newRole === 'host') emit('toast', { text: '你已成为房主' });
      emit('role', { role: st.role });
    }
    var other = peerUid();
    if (other != null) st.peer.uid = other;
    // 加入/离开提示：UI 同时监听 presence 事件渲染系统行（这里只发事件）
    if (m.join && String(m.join.uid) !== String(myUid())) {
      if (m.join.name) st.peer.name = m.join.name;
      emit('toast', { text: (m.join.name || '对方') + ' 加入了房间' });
    }
    if (m.leave && String(m.leave.uid) !== String(myUid())) {
      emit('toast', { text: (m.leave.name || '对方') + ' 离开了房间' });
    }
    emit('presence', m);
  }

  function applyPeerPos(m) {
    st.peer.uid = m.uid;
    if (typeof m.time === 'number') st.peer.time = m.time;
    if (typeof m.buf === 'number') {
      st.peer.buf = m.buf;
      // 连续 3 次对端缓冲 <5s → 提示房主；恢复 ≥10s 重置计数
      if (m.buf < 5) {
        st.slowCount++;
        if (st.slowCount >= 3 && !st.slowNotified) {
          st.slowNotified = true;
          emit('slowpeer', {});
        }
      } else if (m.buf >= 10) {
        st.slowCount = 0;
        st.slowNotified = false;
      }
    }
    emit('peerpos', m);
  }

  function applyPeerBuf(m) {
    if (String(m.uid) === String(peerUid())) {
      if (typeof m.buf === 'number') st.peer.buf = m.buf;
      st.peer.cached = m.cached === undefined ? null : m.cached;
    }
    emit('peerbuf', m);
  }

  // ============================================================
  // 防回声闸1：监听播放事件上报本地控制（仅房主）。
  // 注意：不能用「包装 art.play/art.pause 方法」实现——ArtPlayer 5 将其定义为
  // 实例上的只读属性，严格模式赋值抛 TypeError 并中断调用链（曾经导致 src 永不广播）。
  // 改用 video:play / video:pause 事件：远端应用指令前已有抑制窗（闸2）保证不回环。
  // ============================================================
  function ensureWrapped() {
    var a = getArt();
    if (!a || typeof a.on !== 'function') return;
    if (a.__wdtvWpWrapped) { st.wrappedArt = a; return; } // 同实例已挂（实例级标记，防重复挂载）
    try {
      a.on('video:play', function () { reportLocalControl('play'); });
      a.on('video:pause', function () { reportLocalControl('pause'); });
      a.on('video:seeking', onLocalSeeking);
      a.on('video:ratechange', onLocalRatechange);
      // 实际开始播放（含用户点击覆盖层恢复）→ 清除 autoplay 拒绝状态与覆盖层
      a.on('video:playing', function () { clearPlayBlock(); });
      a.__wdtvWpWrapped = true;
      st.wrappedArt = a;
    } catch (e) { }
  }

  // leave() 时清理引用；事件监听随 art 实例生命周期销毁，只读方法无需（也无法安全）还原
  function unwrapArt() {
    st.wrappedArt = null;
    st.origPlay = null;
    st.origPause = null;
  }

  // 是否拥有控制权（房主恒有；房主开启共享后所有成员均有）。
  // 未连接房间时恒为 true：正常观影（未建房/未入房）不存在房主控制，
  // 否则 st.role=null && st.shared=false 会让 playEpisode 的换集门禁
  // 在无房间时误判为「无控制权」，集数被永久锁死。
  // 内部调用方（startCoWatch/startM3/onEpisodeSwitch/reportLocalControl 等）
  // 均已自行校验 st.connected，此分支不影响房间内逻辑。
  // 注意：仅开放离散控制（play/pause/seek/src）——tick 锚点仍由原房主独家提供，
  // 避免双方互相纠偏产生振荡；嘉宾的 seek 会经 ctl 同步给房主，锚点自然衔接。
  function hasControl() {
    return !st.connected || st.role === 'host' || st.shared;
  }

  // 纯观看回滚：未拥有控制权的成员本地操作播放器（点播放/暂停/拖进度）会与房间脱轨——
  // 强制拉回最近已知的房间状态（playing/time 由 ctl/tickState 持续维护）
  function forceGuestSync() {
    if (!st.connected || st.role === 'host') return;
    var a = getArt();
    var v = a && a.video;
    if (!a || !v || v.readyState < 1) return;
    suppress();
    if (st.room.playing) {
      var t = typeof st.room.time === 'number' ? st.room.time : v.currentTime;
      try { if (Math.abs(v.currentTime - t) > 0.5) v.currentTime = t; } catch (e) { }
      safePlay(a); // 用户操作本身即手势，play 通常会成功；失败则显示点击恢复覆盖层
    } else {
      try { v.pause(); } catch (e) { }
    }
  }

  // 浏览器 autoplay 策略处理（无感方案）：
  // 无手势页面的 play() 被拒 → 自动静音重试（静音播放不受策略限制）→ 画面立即无感跟播；
  // 声音在用户点击页面任意处时自动恢复（任意点击=手势）。无弹窗、无覆盖层。
  // 静音降级为一次终态：进入后不再重复 toast/重挂监听（防提示反复触发）
  function handlePlayRefusal(a, v) {
    if (st.mutedFallback) return; // 已处于静音降级：静默，不再提示
    st.mutedFallback = true;
    try {
      if (v && !v.muted) {
        v.muted = true; // 静音重试：muted 播放不受 autoplay 策略限制
        var p = a.play();
        if (p && typeof p.catch === 'function') p.catch(function () { });
        st.playBlocked = false;
        armUnmuteOnGesture(v);
        emit('toast', { text: '已同步播放（静音）：点击页面任意处开启声音' });
        return;
      }
    } catch (e) { }
    // 静音也失败（极罕见）：保持暂停，待用户任意点击后重试
    armUnmuteOnGesture(v);
  }

  // 全局一次性点击监听（捕获阶段）：任意点击 = 手势 → 恢复声音并重新尝试同步播放
  function armUnmuteOnGesture(v) {
    if (st.gestureArm) return;
    st.gestureArm = function () {
      document.removeEventListener('pointerdown', st.gestureArm, true);
      st.gestureArm = null;
      try {
        if (v) v.muted = false;
        var a = getArt();
        if (a) {
          // 点击即手势，play 必然放行；直连调用避免再走降级链
          var p = a.play();
          if (p && typeof p.catch === 'function') p.catch(function () { });
        }
      } catch (e) { }
      clearPlayBlock();
      emit('toast', { text: '声音已开启' });
    };
    document.addEventListener('pointerdown', st.gestureArm, true);
  }

  function clearPlayBlock() {
    st.playBlocked = false;
  }

  // 安全播放：play() 被浏览器 autoplay 策略拒绝时自动降级为静音播放（无感跟播）
  function safePlay(a) {
    var v = a && a.video;
    try {
      var p = a.play();
      if (p && typeof p.catch === 'function') {
        p.catch(function () { handlePlayRefusal(a, v); });
      } else if (v && v.paused) {
        // 未返回 promise 的实现：稍后检测仍暂停则降级
        setTimeout(function () { try { if (v.paused) handlePlayRefusal(a, v); } catch (e) { } }, 350);
      }
      return true;
    } catch (e) {
      handlePlayRefusal(a, v);
      return false;
    }
  }

  // 播放事件上报（拥有控制权时）/ 纯观看回滚（无控制权时）——闸1
  // 优先级：抑制窗内的事件是「远端指令的正常回声」→ 静默忽略（绝不回滚，
  // 否则嘉宾应用暂停指令后会被回声立即拉回播放，造成卡着重复播放的循环）
  function reportLocalControl(kind) {
    try {
      if (!st.connected) return;
      if (isSuppressed()) return; // 远端应用回声：静默
      if (!hasControl()) {
        forceGuestSync(); // 用户主动操作但无控制权 → 回滚到房间状态
        return;
      }
      var v = artVideo();
      if (!v) return;
      send({ t: kind, time: v.currentTime, rate: v.playbackRate });
    } catch (e) { }
  }

  function onLocalSeeking() {
    try {
      if (!st.connected) return;
      if (isSuppressed()) return; // 远端 seek 回声：静默
      if (!hasControl()) {
        forceGuestSync(); // 用户主动拖进度但无控制权 → 回滚
        return;
      }
      var v = artVideo();
      if (!v) return;
      send({ t: 'seek', time: v.currentTime, rate: v.playbackRate });
    } catch (e) { }
  }

  function onLocalRatechange() {
    try {
      if (!hasControl() || !st.connected || isSuppressed()) return;
      var v = artVideo();
      if (!v) return;
      send({ t: 'seek', time: v.currentTime, rate: v.playbackRate });
    } catch (e) { }
  }

  // ============================================================
  // 播放同步：ctl 应用（观影方）与 tick 纠偏
  // ============================================================
  function applyCtl(m) {
    if (typeof m.epoch !== 'number' || m.epoch <= st.lastEpoch) return; // epoch 乱序保护
    st.lastEpoch = m.epoch;
    suppress(); // 闸2：应用远端指令前打抑制窗
    var a = getArt();
    var v = a && a.video;
    if (!v || v.readyState < 1) {
      // 本端视频尚未就绪（跳转加载中/缓冲）：不能丢弃指令——缓存为待对齐状态，
      // loadedmetadata 后由 applyAlignIfReady 自动对齐，否则"房主先播、我后加载完"会永久脱轨
      st.pendingAlign = {
        time: typeof m.time === 'number' ? m.time : 0,
        playing: !!m.playing,
        rate: typeof m.rate === 'number' && m.rate > 0 ? m.rate : 1
      };
      return;
    }
    if (typeof m.rate === 'number' && m.rate > 0) {
      try { v.playbackRate = m.rate; } catch (e) { }
    }
    var target = m3AlignTarget(typeof m.time === 'number' ? m.time : 0);
    var who = st.peer.name || '对方';
    if (m.kind === 'pause') {
      try { v.pause(); } catch (e) { }
      if (Math.abs(v.currentTime - target) > 0.25) {
        try { v.currentTime = target; } catch (e) { }
      }
      // 维护房间状态快照：pause 分支同样更新（漏更新会让纯观看回滚误判房主仍在播）
      st.room.playing = false;
      st.room.time = target;
      if (typeof m.rate === 'number' && m.rate > 0) st.room.rate = m.rate;
      emit('toast', { text: who + ' 已暂停' });
    } else if (m.kind === 'play' || m.kind === 'seek') {
      // 起播/seek 必须精确对齐到房主位置（0.25s 内才容忍差值）——
      // 否则开局即不同步，且后续 tick 纠偏是渐进的，要很久才追平
      if (Math.abs(v.currentTime - target) > 0.25) {
        try { v.currentTime = target; } catch (e) { }
      }
      try { if (m.playing) { safePlay(a); } else v.pause(); } catch (e) { }
      // 维护房间状态快照（纯观看回滚 forceGuestSync 的数据源）
      st.room.playing = !!m.playing;
      st.room.time = typeof m.time === 'number' ? m.time : st.room.time;
      st.room.rate = typeof m.rate === 'number' && m.rate > 0 ? m.rate : st.room.rate;
      emit('toast', { text: m.kind === 'seek' ? (who + ' 拖动了进度') : (who + (m.playing ? ' 开始播放' : ' 已暂停')) });
    }
  }

  // tickState：观影方自纠偏（保持房主权威：<0.25s 不动 / 软倍速 / >1.5s 硬 seek）。
  // 纠偏倍率以房主 rate 为基准（房主开 1.5 倍速时从端应围绕 1.5 波动，而非回落到 1）
  function applyTick(m, recvPerf) {
    if (!st.connected || st.role === 'host' || isSuppressed()) return;
    var v = artVideo();
    if (!v || v.readyState < 1) {
      // 本端视频未就绪：把房主锚点缓存为待对齐状态，加载完成后自动追上（不丢同步）
      if (m.playing) {
        st.pendingAlign = {
          time: typeof m.time === 'number' ? m.time : 0,
          playing: true,
          rate: typeof m.rate === 'number' && m.rate > 0 ? m.rate : 1
        };
      }
      return;
    }
    if (v.paused || v.ended) {
      // 房主在播而本地停着：追到锚点并恢复播放。
      // 若浏览器 autoplay 策略已拒绝过 play()，不再反复 seek+play（会造成 loading 循环），
      // 改由覆盖层引导用户点击（点击即手势，恢复后自动继续同步）
      if (st.playBlocked) return;
      suppress();
      var t0 = m3AlignTarget(typeof m.time === 'number' ? m.time : 0);
      try { v.currentTime = t0; } catch (e) { }
      safePlay(a);
      return;
    }
    var hostRate = typeof m.rate === 'number' && m.rate > 0 ? m.rate : 1;
    var hostNow = (typeof m.time === 'number' ? m.time : 0) + (performance.now() - recvPerf) / 1000;
    hostNow = m3AlignTarget(hostNow); // M3 时长不一致时换算到本地时长轴
    // 维护房间状态快照（纯观看回滚数据源）
    st.room.playing = true;
    st.room.time = hostNow;
    st.room.rate = hostRate;
    var drift = hostNow - v.currentTime;
    if (Math.abs(drift) < 0.25) {
      // 已对齐：若处于纠偏倍速则恢复正常速率（房主设定的 rate）
      if (Math.abs(v.playbackRate - hostRate) > 0.01 && v.playbackRate >= hostRate * 0.94 && v.playbackRate <= hostRate * 1.06) {
        try { v.playbackRate = hostRate; } catch (e) { }
      }
    } else if (Math.abs(drift) <= 1.5) {
      // 轻度漂移：围绕房主倍率渐进追平（±6%，避免画面跳变）
      try { v.playbackRate = Math.min(hostRate * 1.06, Math.max(hostRate * 0.94, hostRate * (1 + drift * 0.2))); } catch (e) { }
    } else {
      // 严重漂移：抑制后硬 seek
      suppress();
      try { v.currentTime = hostNow; } catch (e) { }
    }
  }

  // ============================================================
  // 片源（src）广播与观影方应用
  // ============================================================
  function applySrcMsg(m) {
    if (typeof m.epoch !== 'number' || m.epoch <= st.lastEpoch) return; // 与 ctl 共用 epoch
    st.lastEpoch = m.epoch;
    var v = m.video || {};
    if (v.mode) st.room.mode = v.mode;
    if (v.mediaKey !== undefined) st.room.mediaKey = v.mediaKey;
    if (v.title !== undefined) st.room.title = v.title;
    if (v.levelIndex !== undefined) st.room.levelIndex = v.levelIndex;
    touchRecentTitle(st.code, st.room.title); // 对端选片/换集广播：片名补写最近房间列表
    emit('src', { video: v });
    if (String(m.by) === String(myUid())) return; // 自己广播的（服务端不回显，防御）
    if (v.mode === 'M3') {
      // M3：与对端就绪上报的文件指纹比对
      var info = peerInfo();
      if (info && info.fp && v.fp && String(info.fp) === String(v.fp)) {
        emit('toast', { text: '双方文件一致，开始同步' });
      } else {
        emit('toast', { text: '请选择与房主相同的本地文件' });
      }
      return;
    }
    var cur = safeGetter(st.getters && st.getters.getVideoKey);
    if ((!cur || cur !== v.url) && !urlParamMatches(v.url)) {
      // 观影方换片源：交由 UI/local 模块做整页跳转（携带 room 码，跳回后 snap 对齐）；
      // URL 已携带同一片源时不跳转（防循环），等待视频就绪后由房主 ctl/tick 对齐
      emit('applySrc', { video: v });
    } else if (v.mode === 'M2') {
      try { if (st.localHooks.coverageReport) st.localHooks.coverageReport(v.mediaKey); } catch (e) { }
      if (st.role === 'guest' && v.levelIndex !== null && v.levelIndex !== undefined) {
        try { if (st.localHooks.lockLevel) st.localHooks.lockLevel(v.levelIndex); } catch (e) { }
      }
    }
  }

  // ============================================================
  // 房主操作：startCoWatch / startM3 / hostPlay
  // ============================================================
  function startCoWatch(mode) {
    if (!hasControl() || !st.connected) return false;
    var m = mode === 'M2' ? 'M2' : 'M1';
    var url = safeGetter(st.getters && st.getters.getVideoKey);
    if (!url) return false;
    var hls = safeGetter(st.getters && st.getters.getHls);
    // 稳定标识用 baseEpisodeUrl（清晰度目录探测不改写它）：
    // mediaKey 基于基准地址，避免探测改写 currentVideoUrl 后双方一致性校验全部失配
    var base = safeGetter(st.getters && st.getters.getBaseVideoKey) || url;
    var eps = safeGetter(st.getters && st.getters.getEpisodes);
    ensureWrapped(); // 房主开始共看：确保本地动作可被捕获上报
    var video = {
      mode: m,
      title: safeGetter(st.getters && st.getters.getTitle) || '',
      url: url,
      epIndex: safeGetter(st.getters && st.getters.getEpisode) || 0,
      // 集数列表随片源同步：对方跳转时写入其 localStorage，保证对方剧集栏与换集可用
      episodes: Array.isArray(eps) && eps.length ? eps.slice(0, 500) : null,
      mediaKey: (m === 'M2' ? 'm2|' : 'm1|') + base,
      // M2 锁档：携带房主当前 HLS 档位，从端关闭 ABR 锁定同一档
      levelIndex: (m === 'M2' && hls && typeof hls.currentLevel === 'number' && hls.currentLevel >= 0) ? hls.currentLevel : null
    };
    if (!send({ t: 'src', video: video })) return false;
    // 服务端 broadcast 排除发送者（闸3）：本地自行更新房间态并通知 UI
    st.room.mode = video.mode;
    st.room.mediaKey = video.mediaKey;
    st.room.title = video.title;
    st.room.levelIndex = video.levelIndex;
    touchRecentTitle(st.code, video.title); // 带片发起 M1/M2：片名补写最近房间列表
    emit('src', { video: video });
    // M2 语义：锁定清晰度档禁 ABR——房主本端同样生效（此前仅从端锁定）
    if (m === 'M2' && video.levelIndex !== null && video.levelIndex !== undefined) {
      try { if (st.localHooks.lockLevel) st.localHooks.lockLevel(video.levelIndex); } catch (e) { }
    }
    return true;
  }

  // 换集广播（player.js playEpisode 触发）：复用 src 通道——换集即片源切换，
  // 携带完整集数列表，对方整页跟随到对应集（剧集栏经 localStorage 同步保持可用）。
  // 共享控制下双方均可触发；自动连播/上一集/下一集均经 playEpisode，天然覆盖。
  function onEpisodeSwitch(index) {
    try {
      if (!hasControl() || !st.connected || isSuppressed()) return;
      var url = safeGetter(st.getters && st.getters.getVideoKey);
      if (!url) return;
      var eps = safeGetter(st.getters && st.getters.getEpisodes);
      var base = safeGetter(st.getters && st.getters.getBaseVideoKey) || url;
      var video = {
        mode: st.room.mode === 'M2' ? 'M2' : 'M1',
        title: safeGetter(st.getters && st.getters.getTitle) || '',
        url: url,
        epIndex: typeof index === 'number' ? index : 0,
        episodes: Array.isArray(eps) && eps.length ? eps.slice(0, 500) : null,
        mediaKey: (st.room.mode === 'M2' ? 'm2|' : 'm1|') + base
      };
      if (!send({ t: 'src', video: video })) return;
      st.room.mode = video.mode;
      st.room.mediaKey = video.mediaKey;
      st.room.title = video.title;
      touchRecentTitle(st.code, video.title); // 换集：片名补写最近房间列表（同名不同源时纠偏）
      emit('src', { video: video });
    } catch (e) { }
  }

  // M3 开播：先本地 Blob 播放（local 模块），成功后广播 src（url 不携带，避免服务端存入 'null'）
  function startM3(file, fp) {
    if (!hasControl() || !st.connected) return Promise.reject({ code: 'notHost' });
    if (!file || !fp) return Promise.reject({ code: 'badFile' });
    var r;
    try {
      r = st.localHooks.m3Play ? st.localHooks.m3Play(file) : null;
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.resolve(r).then(function (ok) {
      if (ok === false) throw { code: 'm3PlayFailed' }; // Blob 播放失败（art.switch 异常等），不广播 src
      var video = {
        mode: 'M3',
        title: safeGetter(st.getters && st.getters.getTitle) || file.name || '',
        mediaKey: 'm3|' + fp,
        name: file.name || '',
        size: file.size || 0,
        fp: fp
      };
      if (!send({ t: 'src', video: video })) throw { code: 'disconnected' };
      st.room.mode = 'M3';
      st.room.mediaKey = video.mediaKey;
      st.room.title = video.title;
      touchRecentTitle(st.code, video.title); // M3 本地文件：片名补写最近房间列表
      emit('src', { video: video });
      return true;
    });
  }

  // M2/M3 门禁通过后开始播放：经包装的 art.play() 自动触发 ctl 上报
  function hostPlay() {
    ensureWrapped();
    var a = getArt();
    if (!a) return;
    safePlay(a);
  }

  // ============================================================
  // 聊天（≤500 字；断线入待发队列，重连 snap 后补发）
  // ============================================================
  function sendChat(text) {
    var t = String(text == null ? '' : text).trim();
    if (!t || t.length > CHAT_MAX_LEN) return false;
    if (st.connected && st.ws && st.ws.readyState === 1) {
      return send({ t: 'chat', text: t });
    }
    // 断线：入待发队列（超限淘汰最旧），返回 true 维持"已发送"语义（UI 置灰由其决定）
    if (st.code) {
      if (st.chatQueue.length >= CHAT_QUEUE_MAX) st.chatQueue.shift();
      st.chatQueue.push(t);
      return true;
    }
    return false;
  }

  function flushChatQueue() {
    while (st.chatQueue.length && st.connected && st.ws && st.ws.readyState === 1) {
      send({ t: 'chat', text: st.chatQueue.shift() });
    }
  }

  // 就绪上报（M2 覆盖率 / M3 指纹）：watch-party-local 经此发送；percent 记录为 buf 上报数据源
  function sendReady(info) {
    if (info && typeof info === 'object' && typeof info.percent === 'number') {
      st.coveragePercent = info.percent;
    }
    return send({ t: 'ready', info: info });
  }

  // ============================================================
  // 共享画布 CanvasLayer（整笔折线模型，支持撤销 / 清空 / 中途进房重放）
  // ============================================================
  var canvasLayer = {
    host: null,       // 挂载容器（.art-video-player）
    canvasEl: null,
    ctx: null,
    enabled: false,   // 画笔开关（false 时 pointer-events:none 穿透；对端笔迹仍会同步显示）
    mode: 'draw',     // 'draw' 画笔 | 'erase' 橡皮擦（随 op 同步到对端）
    color: '#ff4d4f',
    width: 3,
    strokes: [],      // {id, by, color, w, pts:[[x,y]...], final, mode}，坐标归一化 0~1
    localActive: null, // 正在绘制的本地笔
    pendingPts: [],   // 待批量发送的增量点
    flushTimer: 0,
    drawQueue: [],    // rAF 绘制队列 [{stroke, from}]（不在消息回调里直接画）
    rafId: 0,
    ro: null,         // ResizeObserver（容器尺寸/全屏变化重绘）
    dpr: 1
  };

  function canvasMount() {
    if (canvasLayer.canvasEl) return true;
    var a = getArt();
    var v = a && a.video;
    if (!a || !v) return false;
    var host = null;
    try {
      host = a.$player || (v.closest && v.closest('.art-video-player')) || v.parentElement;
    } catch (e) { host = null; }
    if (!host) return false;
    var el = document.createElement('canvas');
    el.style.position = 'absolute';
    el.style.inset = '0';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.zIndex = '55'; // 层级夹缝：高于视频(10)/弹幕(30)/遮罩(50)，低于控制栏(60)/设置(90)——
    // 画笔开启时拦截视频区手势，但不挡播放器按钮（此前取 60 与 .art-bottom 同层且后挂载，控制栏全被盖住无法点击）
    el.style.pointerEvents = 'none'; // 常态穿透：不挡双击 seek 等手势
    host.appendChild(el);
    canvasLayer.host = host;
    canvasLayer.canvasEl = el;
    canvasLayer.ctx = el.getContext('2d');
    // 画笔启用时阻断一切穿透手势：ArtPlayer 单击切播放/暂停、双击左右 1/3 ±15s seek、
    // 冒泡到根元素的任何点击——否则画画的点击会触发视频跳进度并广播"拖动了进度"给对方
    var block = function (e) {
      if (!canvasLayer.enabled) return; // 停用态不拦截（元素本身 pointer-events:none 收不到）
      e.preventDefault();
      e.stopPropagation();
    };
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave',
      'mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchmove', 'touchend',
      'click', 'dblclick', 'contextmenu'].forEach(function (t) {
        el.addEventListener(t, block);
      });
    // 绘制 handler（同元素注册于 block 之后：block 阻断向播放器的传播，绘制照常工作）
    el.addEventListener('pointerdown', canvasPointerDown);
    el.addEventListener('pointermove', canvasPointerMove);
    el.addEventListener('pointerup', canvasPointerEnd);
    el.addEventListener('pointercancel', canvasPointerEnd);
    el.addEventListener('pointerleave', canvasPointerEnd);
    if (typeof ResizeObserver !== 'undefined') {
      canvasLayer.ro = new ResizeObserver(function () { canvasResize(); });
      canvasLayer.ro.observe(host);
    }
    canvasResize();
    return true;
  }

  function canvasDestroy() {
    canvasStopFlush();
    if (canvasLayer.rafId) { cancelAnimationFrame(canvasLayer.rafId); canvasLayer.rafId = 0; }
    if (canvasLayer.ro) {
      try { canvasLayer.ro.disconnect(); } catch (e) { }
      canvasLayer.ro = null;
    }
    if (canvasLayer.canvasEl) {
      try { canvasLayer.canvasEl.remove(); } catch (e) { }
      canvasLayer.canvasEl = null;
    }
    canvasLayer.ctx = null;
    canvasLayer.host = null;
    canvasLayer.strokes = [];
    canvasLayer.localActive = null;
    canvasLayer.pendingPts = [];
    canvasLayer.drawQueue = [];
    canvasLayer.enabled = false;
  }

  function canvasSetEnabled(b) {
    if (b) {
      if (!canvasLayer.canvasEl && !canvasMount()) {
        // 播放器未就绪的内部兜底提示（主提示仍走事件体系）
        try { if (typeof window.showToast === 'function') window.showToast('播放器尚未就绪，稍后再试'); } catch (e) { }
        return;
      }
      canvasLayer.enabled = true;
      canvasLayer.canvasEl.style.pointerEvents = 'auto'; // 画笔开启：捕获指针
      canvasLayer.canvasEl.style.touchAction = 'none';
    } else {
      canvasLayer.enabled = false;
      if (canvasLayer.localActive) canvasPointerEnd(); // 收尾进行中的笔
      if (canvasLayer.canvasEl) {
        canvasLayer.canvasEl.style.pointerEvents = 'none';
        canvasLayer.canvasEl.style.touchAction = '';
      }
    }
  }

  function canvasResize() {
    var c = canvasLayer.canvasEl;
    var host = canvasLayer.host;
    if (!c || !host) return;
    var w = host.clientWidth || 0;
    var h = host.clientHeight || 0;
    if (w < 1 || h < 1) return;
    canvasLayer.dpr = Math.min(window.devicePixelRatio || 1, 2); // dpr 封顶 2，控制重绘开销
    c.width = Math.round(w * canvasLayer.dpr);
    c.height = Math.round(h * canvasLayer.dpr);
    canvasRedrawAll();
  }

  // 清空并重放全部笔迹（resize / undo / clear / snap 后）
  function canvasRedrawAll() {
    var c = canvasLayer.canvasEl;
    var ctx = canvasLayer.ctx;
    if (!c || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    for (var i = 0; i < canvasLayer.strokes.length; i++) {
      canvasPaint(canvasLayer.strokes[i], 0);
    }
  }

  // 绘制 stroke 的 [from, end] 段（from=0 且单点时画圆点）；
  // mode='erase' 为橡皮擦：destination-out 擦除已绘内容（露出视频画面），重放顺序保证效果一致
  function canvasPaint(stroke, from) {
    var ctx = canvasLayer.ctx;
    var c = canvasLayer.canvasEl;
    if (!ctx || !c || !stroke || !stroke.pts || !stroke.pts.length) return;
    var W = c.clientWidth;
    var H = c.clientHeight;
    if (W < 1 || H < 1) return;
    var pts = stroke.pts;
    ctx.save();
    ctx.setTransform(canvasLayer.dpr, 0, 0, canvasLayer.dpr, 0, 0);
    ctx.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0] * W, pts[0][1] * H, Math.max(stroke.w / 2, 0.5), 0, Math.PI * 2);
      ctx.fill();
    } else {
      var start = Math.max(0, Math.min(from, pts.length - 2));
      ctx.beginPath();
      ctx.moveTo(pts[start][0] * W, pts[start][1] * H);
      for (var i = start + 1; i < pts.length; i++) {
        ctx.lineTo(pts[i][0] * W, pts[i][1] * H);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function canvasQueuePaint(stroke, from) {
    canvasLayer.drawQueue.push({ stroke: stroke, from: from });
    if (!canvasLayer.rafId) {
      canvasLayer.rafId = requestAnimationFrame(function () {
        canvasLayer.rafId = 0;
        var q = canvasLayer.drawQueue;
        canvasLayer.drawQueue = [];
        for (var i = 0; i < q.length; i++) canvasPaint(q[i].stroke, q[i].from);
      });
    }
  }

  // 指针坐标 → 归一化（0~1，双方分辨率/宽高比无关），保留 4 位小数降低载荷
  function canvasNormPoint(e) {
    var c = canvasLayer.canvasEl;
    if (!c) return null;
    var r = c.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    var x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    var y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    return [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000];
  }

  function canvasPointerDown(e) {
    if (!canvasLayer.enabled || canvasLayer.localActive) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var p = canvasNormPoint(e);
    if (!p) return;
    e.preventDefault();
    try { canvasLayer.canvasEl.setPointerCapture(e.pointerId); } catch (err) { }
    var erasing = canvasLayer.mode === 'erase';
    // 整笔折线：一笔一个 id（服务端按 id 聚合增量，undo 按笔删）
    canvasLayer.localActive = {
      id: String(myUid() == null ? 'anon' : myUid()) + '-' +
        Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      by: myUid(),
      color: canvasLayer.color,
      w: erasing ? Math.max(14, canvasLayer.width * 4) : canvasLayer.width,
      pts: [p],
      final: false,
      mode: canvasLayer.mode
    };
    canvasLayer.strokes.push(canvasLayer.localActive);
    canvasLayer.pendingPts = [p];
    canvasPaint(canvasLayer.localActive, 0); // 首点即时可见
    canvasStartFlush();
  }

  function canvasPointerMove(e) {
    var s = canvasLayer.localActive;
    if (!s) return;
    var p = canvasNormPoint(e);
    if (!p) return;
    var last = s.pts[s.pts.length - 1];
    var dx = p[0] - last[0];
    var dy = p[1] - last[1];
    if (Math.sqrt(dx * dx + dy * dy) < DRAW_MIN_DIST) return; // 距离过滤抗抖动
    s.pts.push(p);
    canvasLayer.pendingPts.push(p);
    canvasPaint(s, s.pts.length - 2); // 新段立即本地绘制
    e.preventDefault();
  }

  function canvasPointerEnd() {
    var s = canvasLayer.localActive;
    if (!s) return;
    canvasLayer.localActive = null;
    canvasStopFlush();
    s.final = true;
    var pts = canvasLayer.pendingPts;
    canvasLayer.pendingPts = [];
    send({ t: 'stroke', op: { id: s.id, color: s.color, w: s.w, pts: pts, final: true, mode: s.mode } });
  }

  function canvasStartFlush() {
    canvasStopFlush();
    canvasLayer.flushTimer = setInterval(function () {
      var s = canvasLayer.localActive;
      if (!s || !canvasLayer.pendingPts.length) return;
      var pts = canvasLayer.pendingPts;
      canvasLayer.pendingPts = [];
      // 100ms 批量增量：每段约 110B，画布带宽 ≈ 8.8kbps
      send({ t: 'stroke', op: { id: s.id, color: s.color, w: s.w, pts: pts, final: false, mode: s.mode } });
    }, DRAW_FLUSH_MS);
  }

  function canvasStopFlush() {
    if (canvasLayer.flushTimer) {
      clearInterval(canvasLayer.flushTimer);
      canvasLayer.flushTimer = 0;
    }
  }

  // snap 历史重放：服务端 strokes（uid 字段）映射为本地模型（by 字段）；
  // 对端笔迹自动显示——画布层未挂载时尝试挂载（共享画布语义：内容始终同步可见）
  function canvasLoadStrokes(arr) {
    canvasLayer.strokes = (Array.isArray(arr) ? arr : [])
      .filter(function (s) { return s && s.id && Array.isArray(s.pts); })
      .map(function (s) {
        return { id: s.id, by: s.uid, color: s.color, w: s.w, pts: s.pts.slice(), final: !!s.final, mode: s.mode === 'erase' ? 'erase' : 'draw' };
      });
    if (!canvasLayer.canvasEl && canvasLayer.strokes.length) canvasMount();
    if (canvasLayer.canvasEl) canvasRedrawAll();
  }

  // 远端笔迹增量：按 id 追加（无则新建），rAF 批量绘制新段；
  // 本端未开画布也自动挂载显示（共享内容始终可见，绘制开关仅控制本端输入）
  function canvasRemoteStroke(m) {
    var op = m && m.op;
    if (!op || !op.id || !Array.isArray(op.pts)) return;
    if (!canvasLayer.canvasEl) canvasMount();
    var s = null;
    for (var i = canvasLayer.strokes.length - 1; i >= 0; i--) {
      if (canvasLayer.strokes[i].id === op.id) { s = canvasLayer.strokes[i]; break; }
    }
    if (!s) {
      s = { id: op.id, by: m.by, color: op.color, w: op.w, pts: [], final: false, mode: op.mode === 'erase' ? 'erase' : 'draw' };
      canvasLayer.strokes.push(s);
    }
    // 增量连线起点必须是「旧末点」（from-1）：否则每批多点增量之间都会漏画
    // 「旧末点 → 第一个新点」一段，对端看到的就是断续虚线（本地逐点连线无此问题）
    var from = s.pts.length;
    for (var j = 0; j < op.pts.length; j++) s.pts.push(op.pts[j]);
    s.final = !!op.final;
    if (op.pts.length && s.pts.length) canvasQueuePaint(s, from > 0 ? from - 1 : 0);
  }

  function canvasRemoteUndo(m) {
    var id = m && m.strokeId;
    if (!id) return;
    for (var i = 0; i < canvasLayer.strokes.length; i++) {
      if (canvasLayer.strokes[i].id === id) {
        canvasLayer.strokes.splice(i, 1);
        if (canvasLayer.canvasEl) canvasRedrawAll();
        return;
      }
    }
  }

  function canvasRemoteClear() {
    canvasLayer.strokes = [];
    if (canvasLayer.canvasEl) canvasRedrawAll();
  }

  // 本地撤销：删自己最后一笔并广播（服务端按 by 删最后一笔，广播 undo{strokeId}）
  function canvasUndoLocal() {
    for (var i = canvasLayer.strokes.length - 1; i >= 0; i--) {
      if (String(canvasLayer.strokes[i].by) === String(myUid())) {
        canvasLayer.strokes.splice(i, 1);
        if (canvasLayer.canvasEl) canvasRedrawAll();
        break;
      }
    }
    send({ t: 'undo' });
  }

  function canvasClearLocal() {
    canvasLayer.strokes = [];
    if (canvasLayer.canvasEl) canvasRedrawAll();
    send({ t: 'clear' });
  }

  var canvasApi = {
    setEnabled: canvasSetEnabled,
    isEnabled: function () { return canvasLayer.enabled; },
    setColor: function (c) { if (c) { canvasLayer.color = String(c); canvasLayer.mode = 'draw'; } },
    setWidth: function (w) { var n = Number(w); if (n > 0) canvasLayer.width = n; },
    setMode: function (m) { if (m === 'erase' || m === 'draw') canvasLayer.mode = m; },
    getMode: function () { return canvasLayer.mode; },
    undo: canvasUndoLocal,
    clear: canvasClearLocal
  };

  // ============================================================
  // 退出清理
  // ============================================================
  function leave() {
    st.manualClose = true;
    // M3 进行中退出：通知本地模块恢复原集 / 恢复预取（Blob 回收由其负责）
    if (st.room.mode === 'M3') {
      try { if (st.localHooks.m3Exit) st.localHooks.m3Exit(); } catch (e) { }
    }
    closeSocket();
    unwrapArt();      // 解包 art.play/pause，还原原引用
    canvasDestroy();  // 清画布 DOM 与监听
    if (st.code) {
      try { localStorage.removeItem(TOKEN_KEY_PREFIX + st.code); } catch (e) { }
    }
    st.autoSrc = false;
    resetRoomState();
    st.chatQueue = [];
    st.rtt = null;
    st.hbSentAt = 0;
    st.code = null;
    st.roomToken = null;
  }

  // ============================================================
  // 查询接口
  // ============================================================
  function isActive() {
    return { connected: st.connected, code: st.code, role: st.role };
  }

  function roomState() {
    return {
      code: st.code,
      role: st.role,
      shared: st.shared,
      mode: st.room.mode,
      mediaKey: st.room.mediaKey,
      title: st.room.title,
      state: st.connected ? 'connected' : (st.code ? 'connecting' : 'idle'),
      peer: {
        uid: st.peer.uid,
        name: st.peer.name,
        time: st.peer.time,
        buf: st.peer.buf
      },
      readyMap: Object.assign({}, st.readyMap)
    };
  }

  // ============================================================
  // 公开 API（window.WatchParty；后续 watch-party-local / ui 模块依赖此签名）
  // ============================================================
  var WatchParty = {
    // 初始化：立即返回 controller；getter 惰性求值（art 可能尚未创建）
    init: function (opts) {
      st.getters = opts && typeof opts === 'object' ? opts : {};
      return WatchParty;
    },
    on: on,
    createRoom: createRoom,   // Promise<{code, roomToken}>；reject {code}
    joinRoom: joinRoom,       // Promise<{code, roomToken, mode, mediaKey, title, hostUid}>
    connect: connect,         // (code, roomToken)：create/join 成功后或刷新恢复时调用
    leave: leave,
    isActive: isActive,       // {connected, code, role}
    startCoWatch: startCoWatch, // host 专用 'M1'|'M2'：从 getters 构造并广播 src
    startM3: startM3,         // host 专用：本地 m3Play 成功后广播 src {mode:'M3',...}
    hostPlay: hostPlay,       // M2/M3 门禁通过后开始播放（经包装触发 ctl）
    sendChat: sendChat,       // ≤500 字；断线入待发队列返回 true
    uid: myUid,               // 当前登录 uid（UI 判定消息左右/成员身份）
    name: myName,             // 当前昵称（UI 乐观渲染自己的消息）
    sendReady: sendReady,     // 就绪上报（M2 覆盖率 / M3 指纹，watch-party-local 使用）
    canvas: canvasApi,        // {setEnabled,isEnabled,setColor,setWidth,undo,clear}
    onMetadata: onMetadata,   // player.js 在 video:loadedmetadata 里调用
    onEpisodeSwitch: onEpisodeSwitch, // player.js 在 playEpisode 里调用（共享控制下换集广播）
    setLocalHooks: function (hooks) {
      if (hooks && typeof hooks === 'object') Object.assign(st.localHooks, hooks);
    },
    env: function () { return st.getters || {}; }, // 宿主 getter（getArt/getHls/getVideoKey/getTitle/getEpisode），供 local/ui 模块惰性使用
    setAutoSrc: function (b) { st.autoSrc = !!b; tryAutoSrc(); }, // 房主 URL ?room= 选片场景开关（UI initFromUrl 设置）
    setShared: function (on) {
      // 房主切换控制权共享；仅房主可发（服务端强制）。本地乐观更新+回显双保险
      if (String(st.role) !== 'host') return false;
      var ok = send({ t: 'share', on: !!on });
      if (ok) {
        st.shared = !!on;
        emit('shared', { on: st.shared, by: myUid() });
      }
      return ok;
    },
    hasControl: hasControl,   // 是否拥有控制权（房主或共享开启）
    roomState: roomState      // 供 UI 渲染
  };

  if (typeof window !== 'undefined') window.WatchParty = WatchParty;
})();
