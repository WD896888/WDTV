// 双人共同观影实时服务（独立 Worker + WatchRoom Durable Object）
// 由 Pages Function（functions/api/room/[[path]].js）经 DO 绑定转发，也可本地直连联调
// 1 房间 = idFromName(房间码) 1 实例；Hibernatable WebSocket + 空闲 2h alarm 整房回收

// ============================================================
// 常量与基础工具
// ============================================================

const MAX_PEERS = 2; // 每房成员上限
const MAX_STROKES = 600; // 画布笔迹上限（笔）
const MAX_CANVAS_BYTES = 1500000; // 画布笔迹上限（序列化字节）
const CHAT_TAIL = 100; // 聊天历史留存条数
const IDLE_TTL_MS = 2 * 60 * 60 * 1000; // 房间空闲回收 TTL
const CHAT_RATE = 10; // 聊天限速条数（每窗口每 uid）
const CHAT_WINDOW_MS = 5000; // 聊天限速窗口
const ACTIVITY_WRITE_MS = 60000; // lastActivity 落盘节流间隔

// Response 构造（统一 JSON 输出）
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// 安静读 JSON body（非法 JSON 返回空对象，交由后续校验兜底）
async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

// 字符串恒时比较（长度不同也不提前返回；与 functions/api/_lib.mjs 同实现）
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    // charCodeAt 越界返回 NaN，位运算中被 ToInt32 转为 0
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// HMAC-SHA256 → hex（roomToken 校验用）
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  let hex = '';
  for (const b of new Uint8Array(sig)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// roomToken 校验：token = base64(uid) + '.' + hex(HMAC-SHA256(secret, 'room:code:uid'))
// 成功返回 uid，失败返回 null；worker 层与 DO 层共用同一实现
async function verifyRoomToken(token, code, secret) {
  try {
    if (typeof token !== 'string' || !token) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    // query 中未编码的 '+' 会被解析成空格，这里还原（合法 base64 不含空格）
    const uid = atob(token.slice(0, dot).replace(/ /g, '+'));
    if (!uid) return null;
    const expect = await hmacHex(secret, `room:${code}:${uid}`);
    if (!constantTimeEqual(token.slice(dot + 1), expect)) return null;
    return uid;
  } catch {
    return null;
  }
}

// 读连接 attachment（Hibernatable WS 挂载的 {uid, name, joinedAt}，失败返回 null）
// 注意：workerd 中读取用 deserializeAttachment()，serializeAttachment(obj) 是只写
function wsAtt(ws) {
  try {
    return ws.deserializeAttachment() || null;
  } catch {
    return null;
  }
}

// 读连接 uid
function wsUid(ws) {
  const a = wsAtt(ws);
  return a && a.uid ? a.uid : '';
}

// 默认房间状态（创建 / 被回收后凭有效 token 重入时初始化）
// 注意 mode 必须为 null：空房间 = 未选片源。若预置 'M1'，客户端 snap 后会误判
// "已在 M1 共看"，跳过「发起共看」入口与自动发起，src 永不广播（title/mediaKey 恒空）
function defaultState(code, hostUid, hostName, now) {
  return {
    code,
    hostUid,
    hostName,
    mode: null,
    mediaKey: '',
    title: '',
    url: '',
    epIndex: 0,
    levelIndex: null,
    playing: false,
    time: 0,
    rate: 1,
    epoch: 0,
    shared: false, // 控制权共享：开启后所有成员均可发送 play/pause/seek/src（tick 仍由原房主独家提供，防双端振荡）
    createdAt: now,
    lastActivity: now,
  };
}

// ============================================================
// Worker 路由：受信内部接口（/__create、/__info）+ WS 代理（/ws）
// ============================================================

// 内部密钥校验：Pages Function 或本地联调直连时必须携带 X-Internal-Secret
function checkInternalSecret(request, env) {
  return constantTimeEqual(request.headers.get('X-Internal-Secret') || '', String(env.AUTH_SECRET || ''));
}

// 转发 POST 到目标房间 DO（worker 自绑定自身导出的 WatchRoom 类）
async function postToRoom(request, env, path) {
  if (!checkInternalSecret(request, env)) return json({ error: 'forbidden' }, 403);
  const body = await readJson(request);
  const stub = env.WATCH_ROOM_SELF.get(env.WATCH_ROOM_SELF.idFromName(String(body.code || '')));
  return stub.fetch(`https://watch-room.local${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/__create') {
        return await postToRoom(request, env, '/__create');
      }
      if (request.method === 'POST' && url.pathname === '/__info') {
        return await postToRoom(request, env, '/__info');
      }
      if (request.method === 'GET' && url.pathname === '/ws') {
        // worker 层先校验 roomToken，再原样透传升级请求（保留 Upgrade 头），DO 内二次校验后完成 101
        const room = url.searchParams.get('room') || '';
        const uid = url.searchParams.get('uid') || '';
        const token = url.searchParams.get('token') || '';
        const tokUid = await verifyRoomToken(token, room, env.AUTH_SECRET);
        if (!room || !uid || !tokUid || tokUid !== uid) return json({ error: 'authFailed' }, 403);
        const stub = env.WATCH_ROOM_SELF.get(env.WATCH_ROOM_SELF.idFromName(room));
        return await stub.fetch(request);
      }
      return json({ error: 'Not Found' }, 404);
    } catch {
      // DO 未绑定等异常统一 500，不泄露内部细节
      return json({ error: 'sync worker error' }, 500);
    }
  },
};

// ============================================================
// WatchRoom Durable Object（1 实例 = 1 房间）
// ============================================================

export class WatchRoom {
  constructor(state, env) {
    this.ctx = state; // DurableObjectState（经典签名）
    this.env = env;
    this.state = null; // 房间权威状态（storage 键 'state'；null = 未创建/已回收）
    this.strokes = []; // 画布笔迹（键 'strokes'，整笔折线模型，支持 undo）
    this.chatTail = []; // 聊天历史（键 'chatTail'）
    this.seq = 0; // 笔迹序号（恢复后取最后一笔，保证单调）
    this.chatSeq = 0; // 聊天序号（重启后允许重复，无碍）
    this.chatLog = new Map(); // 聊天限速：uid -> 时间戳数组（仅内存）
    this._lastTouch = 0; // lastActivity 上次落盘时间（节流）
    // 心跳自动回应：不唤醒 DO、零计费（客户端必须精确发 '{"t":"hb"}'）
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"hb"}', '{"t":"hb"}'));
    // 恢复期阻塞并发，保证后续 fetch / WS 事件看到完整状态
    this.ctx.blockConcurrencyWhile(async () => {
      this.state = (await this.ctx.storage.get('state')) || null;
      this.strokes = (await this.ctx.storage.get('strokes')) || [];
      this.chatTail = (await this.ctx.storage.get('chatTail')) || [];
      this.seq = this.strokes.length ? this.strokes[this.strokes.length - 1].seq : 0;
      this.chatSeq = this.chatTail.length ? this.chatTail[this.chatTail.length - 1].seq : 0;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/__create') return this.handleCreate(request);
    if (request.method === 'POST' && url.pathname === '/__info') return this.handleInfo();
    if (request.method === 'GET' && url.pathname === '/ws') return this.handleWs(request, url);
    return json({ error: 'Not Found' }, 404);
  }

  // 创建房间：已有 state 视为已存在（Pages 侧换码重试）
  async handleCreate(request) {
    if (this.state) return json({ created: false });
    const body = await readJson(request);
    const now = Date.now();
    this.state = defaultState(
      body.code != null ? String(body.code) : '',
      body.uid != null ? String(body.uid) : '', // JWT payload.uid 是数字，统一字符串化
      body.name != null ? String(body.name) : '',
      now
    );
    await this.ctx.storage.put('state', this.state);
    await this.ctx.storage.setAlarm(now + IDLE_TTL_MS);
    return json({ created: true });
  }

  // 加入预检：存在性 / 是否满员 / 房主 / 在线 uid
  handleInfo() {
    if (!this.state) return json({ exists: false });
    const uids = [...new Set(this.ctx.getWebSockets().map(wsUid).filter(Boolean))];
    return json({
      exists: true,
      full: uids.length >= MAX_PEERS,
      hostUid: this.state.hostUid,
      uids,
      mediaKey: this.state.mediaKey,
      mode: this.state.mode,
      title: this.state.title,
    });
  }

  // WS 升级与入房
  async handleWs(request, url) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return json({ error: 'expected websocket' }, 426);
    }
    const room = url.searchParams.get('room') || '';
    const uid = url.searchParams.get('uid') || '';
    const name = url.searchParams.get('name') || '';
    const token = url.searchParams.get('token') || '';
    const tokUid = await verifyRoomToken(token, room, this.env.AUTH_SECRET);
    // 参数齐全 + token 有效 + token 身份与 uid 一致（防冒名）
    if (!room || !uid || !name || !tokUid || tokUid !== uid) return json({ error: 'authFailed' }, 403);

    // 同 uid 替换：旧 socket 以 4000 关闭（刷新页面/换标签页重连场景，不计新成员）
    for (const old of this.ctx.getWebSockets()) {
      const a = wsAtt(old);
      if (a && String(a.uid) === String(uid)) {
        try {
          old.close(4000, 'replaced');
        } catch {}
      }
    }
    // 成员上限（不含正被替换的同 uid 连接）：超员 accept 后立即 1013，客户端从 close 事件感知
    const peers = this.ctx.getWebSockets().filter((s) => {
      const u = wsUid(s);
      return u && u !== uid;
    });
    if (peers.length >= MAX_PEERS) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair); // workerd 的 pair 是 {0: client, 1: server}
      server.accept();
      try {
        server.close(1013, 'room full');
      } catch {}
      return new Response(null, { status: 101, webSocket: client });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ uid, name, joinedAt: Date.now() });

    // 房间被回收后凭有效 token 重入：以当前成员重建房间（重入者成为房主）
    if (!this.state) {
      this.state = defaultState(room, uid, name, Date.now());
      this.persist('state', this.state);
    }

    const online = [...new Set(this.ctx.getWebSockets().map(wsUid).filter(Boolean))];
    // 入房快照：客户端据此直接对齐（含 mode/mediaKey/levelIndex/epoch 与画布、聊天历史）
    this.send(server, { t: 'snap', state: this.state, online, strokes: this.strokes, chatTail: this.chatTail });
    // 向其它成员广播加入（排除发送者，防回声闸3）
    this.broadcast({ t: 'presence', online, count: online.length, hostUid: this.state.hostUid, join: { uid, name } }, server);

    this.state.lastActivity = Date.now();
    this.persist('state', this.state);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let m;
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hb') return; // autoResponse 已处理，理论上不会到这里
    const att = wsAtt(ws);
    const uid = att ? att.uid : '';
    const name = att ? att.name || '' : ''; // 身份取自连接参数，不信任消息内 name（防伪造）
    if (!uid) return;
    const now = Date.now();
    // 刷新活跃时间（节流落盘；空闲回收由 alarm 兜底顺延）
    if (this.state) {
      this.state.lastActivity = now;
      if (now - this._lastTouch > ACTIVITY_WRITE_MS) {
        this._lastTouch = now;
        this.persist('state', this.state);
      }
    }

    switch (m.t) {
      // ---- 控制权共享开关：仅房主可切换，状态持久化（中途进房/刷新经 snap 恢复）----
      //     全量广播（含发送者）：房主本地 shared 状态必须同步，否则重开面板开关会还原
      case 'share': {
        if (!this.state || String(uid) !== String(this.state.hostUid)) return;
        this.state.shared = !!m.on;
        this.state.lastActivity = now;
        this.persist('state', this.state);
        this.broadcast({ t: 'shared', on: this.state.shared, by: uid }, null);
        return;
      }
      // ---- 播放控制：房主恒可用；共享开启后所有成员可用（tick 除外，锚点单一防振荡）----
      case 'play':
      case 'pause':
      case 'seek': {
        if (!this.state) return;
        if (String(uid) !== String(this.state.hostUid) && !this.state.shared) return;
        if (m.t === 'play') this.state.playing = true;
        if (m.t === 'pause') this.state.playing = false;
        if (typeof m.time === 'number') this.state.time = m.time;
        if (typeof m.rate === 'number') this.state.rate = m.rate;
        this.state.epoch++; // epoch 乱序保护：从端丢弃过期 ctl
        this.state.lastActivity = now;
        this.persist('state', this.state);
        this.broadcast({ t: 'ctl', kind: m.t, time: this.state.time, rate: this.state.rate, playing: this.state.playing, epoch: this.state.epoch, at: now, by: uid }, ws);
        return;
      }
      // ---- tick 锚点：仅房主。锚点时间/倍率以房主实时上报为准——
      //      DO 不追踪播放进度，state.time 仅反映最近一次离散控制动作；
      //      若用 state.time 纠偏会把从端拉回历史位置（曾致"播放后不同步"）----
      case 'tick': {
        if (!this.state || String(uid) !== String(this.state.hostUid)) return;
        const tTime = typeof m.time === 'number' ? m.time : this.state.time;
        const tRate = typeof m.rate === 'number' && m.rate > 0 ? m.rate : this.state.rate;
        this.broadcast({ t: 'tickState', time: tTime, rate: tRate, playing: this.state.playing, epoch: this.state.epoch, at: now }, ws);
        return;
      }
      // ---- 从端位置上报 → 转发对端（房主面板展示进度/缓冲）----
      case 'pos':
        this.broadcast({ t: 'peerpos', uid, time: m.time, buf: m.buf, at: now }, ws);
        return;
      // ---- 缓冲/缓存进度上报 → 转发对端（M2 就绪进度、网络徽标数据源）----
      case 'buf':
        this.broadcast({ t: 'peerbuf', uid, buf: m.buf, cached: m.cached === undefined ? null : m.cached }, ws);
        return;
      // ---- 片源选定/更换：房主恒可用；共享开启后所有成员可用，持久化并广播 ----
      case 'src': {
        if (!this.state) return;
        if (String(uid) !== String(this.state.hostUid) && !this.state.shared) return;
        const v = m.video;
        if (!v || typeof v !== 'object' || !v.mode || typeof v.title !== 'string') return;
        const s = this.state;
        s.mode = v.mode;
        if (v.mediaKey !== undefined) s.mediaKey = String(v.mediaKey);
        if (v.title !== undefined) s.title = v.title;
        if (v.url !== undefined) s.url = String(v.url);
        if (v.epIndex !== undefined) s.epIndex = v.epIndex | 0;
        if (v.levelIndex !== undefined) s.levelIndex = v.levelIndex === null ? null : v.levelIndex | 0;
        // 集数列表随片源持久化/广播（对方跳转时经 localStorage 重建剧集栏，共享控制下选集可用）
        if (v.episodes !== undefined) s.episodes = Array.isArray(v.episodes) ? v.episodes.slice(0, 500).map(String) : null;
        s.epoch++;
        s.lastActivity = now;
        this.persist('state', s);
        this.broadcast({ t: 'src', video: { mode: s.mode, mediaKey: s.mediaKey, title: s.title, url: s.url, epIndex: s.epIndex, levelIndex: s.levelIndex, episodes: s.episodes ?? null, name: v.name ?? null, size: v.size ?? null, fp: v.fp ?? null }, epoch: s.epoch, by: uid }, ws);
        return;
      }
      // ---- 就绪上报（M2 覆盖率 / M3 指纹）原样转发，限 4KB ----
      case 'ready': {
        try {
          if (JSON.stringify(m.info ?? null).length > 4096) return;
        } catch {
          return;
        }
        this.broadcast({ t: 'ready', uid, info: m.info }, ws);
        return;
      }
      // ---- 聊天：限速（10 条/5s/uid）+ 落历史（≤100）+ 广播（不回显发送者）----
      case 'chat': {
        const text = String(m.text || '').slice(0, 500);
        if (!text) return;
        let log = this.chatLog.get(uid);
        if (!log) {
          log = [];
          this.chatLog.set(uid, log);
        }
        while (log.length && now - log[0] >= CHAT_WINDOW_MS) log.shift();
        if (log.length >= CHAT_RATE) return; // 超限静默丢弃
        log.push(now);
        // 时间戳字段用 ts：协议中 t 是消息类型，避免 spread 覆盖
        const rec = { uid, name, kind: 'user', text, ts: now, seq: ++this.chatSeq };
        this.chatTail.push(rec);
        while (this.chatTail.length > CHAT_TAIL) this.chatTail.shift();
        this.persist('chatTail', this.chatTail);
        this.broadcast({ t: 'chat', ...rec }, ws);
        return;
      }
      // ---- 画布笔迹：同 id 增量合并 + 双上限修剪 + 持久化 + 转发（mode: draw|erase 橡皮擦）----
      case 'stroke': {
        const op = m.op;
        if (!op || typeof op !== 'object' || !Array.isArray(op.pts)) return;
        const seq = ++this.seq;
        let target = null;
        // 同 uid 同 id 的未完结笔 → pts 追加进原笔（整笔模型，支持 undo），不新增
        for (let i = this.strokes.length - 1; i >= 0; i--) {
          const st = this.strokes[i];
          if (st.id === op.id && st.uid === uid && !st.final) {
            target = st;
            break;
          }
        }
        if (target) {
          for (const p of op.pts) target.pts.push(p);
          target.final = !!op.final;
        } else {
          target = { seq, id: op.id, uid, color: op.color, w: op.w, pts: op.pts, final: !!op.final, mode: op.mode === 'erase' ? 'erase' : 'draw', t: now };
          this.strokes.push(target);
        }
        // 双上限：超笔数或超字节丢最旧
        let bytes = JSON.stringify(this.strokes).length;
        while (this.strokes.length && (this.strokes.length > MAX_STROKES || bytes > MAX_CANVAS_BYTES)) {
          const dropped = this.strokes.shift();
          bytes -= JSON.stringify(dropped).length + 1;
        }
        this.persist('strokes', this.strokes);
        // 只转发本次增量 op，远端对同 id 后续 op 追加渲染（客户端职责）
        this.broadcast({ t: 'stroke', op: { id: op.id, color: target.color, w: target.w, pts: op.pts, final: target.final, mode: target.mode }, by: uid, seq }, ws);
        return;
      }
      // ---- 撤销自己最后一笔 ----
      case 'undo': {
        for (let i = this.strokes.length - 1; i >= 0; i--) {
          if (this.strokes[i].uid === uid) {
            const removed = this.strokes.splice(i, 1)[0];
            this.persist('strokes', this.strokes);
            this.broadcast({ t: 'undo', by: uid, strokeId: removed.id }, ws);
            break;
          }
        }
        return;
      }
      // ---- 清空画布 ----
      case 'clear':
        this.strokes = [];
        this.seq = 0;
        this.persist('strokes', []);
        this.broadcast({ t: 'clear', by: uid }, ws);
        return;
      default:
        return; // 未知类型忽略
    }
  }

  async webSocketClose(ws) {
    const att = wsAtt(ws);
    const rest = this.ctx.getWebSockets().filter((s) => s !== ws);
    // 房主离开：剩余首位自动接任（客户端据 presence.hostUid 提示；uid 比较一律 String 归一）
    if (this.state && att && att.uid && String(att.uid) === String(this.state.hostUid) && rest.length) {
      const next = wsAtt(rest[0]);
      if (next && next.uid) {
        this.state.hostUid = next.uid;
        this.state.hostName = next.name || '';
        this.persist('state', this.state);
      }
    }
    if (rest.length) {
      const online = [...new Set(rest.map(wsUid).filter(Boolean))];
      this.broadcast({ t: 'presence', online, count: online.length, hostUid: this.state ? this.state.hostUid : '', leave: att ? { uid: att.uid, name: att.name || '' } : null });
    } else {
      // 无人在线：安排空闲回收（alarm 时仍无人则 deleteAll）
      await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS);
    }
  }

  async webSocketError(ws) {
    // 错误连接按离开处理（getWebSockets 自动清理，这里只广播与安排回收）
    await this.webSocketClose(ws);
  }

  // 空闲回收：无在座 socket 则整房删除并重置内存态；否则顺延（长映不中断）
  async alarm() {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.state = null;
      this.strokes = [];
      this.chatTail = [];
      this.seq = 0;
      this.chatSeq = 0;
      this.chatLog.clear();
    } else {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS);
    }
  }

  // fire-and-forget 持久化：DO 输入门闩保证同实例事件串行，失败由下次活动覆盖
  persist(key, value) {
    this.ctx.storage.put(key, value).catch(() => {});
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  broadcast(obj, excludeWs) {
    const raw = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excludeWs) continue;
      try {
        ws.send(raw);
      } catch {}
    }
  }
}
