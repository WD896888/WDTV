import path from 'path';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
// 本地账号 API：mini D1 mock + 云端 handleApi（与 Cloudflare Pages functions 共用同一实现）
import { createMiniD1 } from './functions/api/_mock-d1.mjs';
import { handleApi } from './functions/api/_lib.mjs';

dotenv.config();

// keep-alive 连接池：复用到上游的 TCP/TLS 连接，避免每个分片都重新握手
// （跨境/慢源每次握手可损耗数百毫秒，高并发预取下影响显著）
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  port: process.env.PORT || 8080,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  timeout: parseInt(process.env.REQUEST_TIMEOUT || '30000'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '2'),
  cacheMaxAge: process.env.CACHE_MAX_AGE || '0',
  userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  debug: process.env.DEBUG === 'true'
};

const log = (...args) => {
  if (config.debug) {
    console.log('[DEBUG]', ...args);
  }
};

const app = express();

app.use(cors({
  origin: config.corsOrigin,
  methods: ['GET', 'POST', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// 仅解析 content-type: application/json 的请求体（账号 API 用），不影响 /proxy 流式代理与静态资源
app.use(express.json({ limit: '1mb' }));

// ============================================================
// 双人共同观影：本地房间服务（dev 专用）
// 与 sync-worker（Cloudflare DO）协议对齐的内存实现，使 localhost:8080
// 无需部署云端即可联调共同观影：
//   POST /api/room/create —— JWT 登录 → 生成 6 位房间码 → { code, roomToken }
//   POST /api/room/join   —— JWT 登录 + {code} → 满员/存在性预检 → { code, roomToken, mode, mediaKey, title, hostUid }
//   GET  /api/room/ws     —— WS 升级（roomToken 校验）→ snap/presence/ctl/src/chat/stroke 全协议
// roomToken = base64(uid) + '.' + HMAC-SHA256(AUTH_SECRET, 'room:code:uid')，与 Pages Function 同构
// ============================================================
const ROOM_AUTH_SECRET = process.env.AUTH_SECRET || 'wdtv-dev-secret';
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;
const ROOM_MAX_PEERS = 2;
const rooms = new Map(); // code -> { state, strokes, chatTail, chatSeq, seq, chatLog, members:Set<ws> }

function roomHmacHex(secret, message) {
    return crypto.createHmac('sha256', String(secret)).update(String(message)).digest('hex');
}

function roomConstantTimeEq(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const len = Math.max(a.length, b.length);
    let diff = a.length === b.length ? 0 : 1;
    for (let i = 0; i < len; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

// 校验登录 JWT（HS256，与 functions/api/_lib.mjs verifyJwt 同语义）：成功返回 payload
function roomVerifyJwt(token, secret) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return null;
        const sigBuf = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        if (!roomConstantTimeEq(sigBuf.toString('hex'), roomHmacHex(secret, parts[0] + '.' + parts[1]))) return null;
        const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        if (!payload || typeof payload !== 'object') return null;
        if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;
        return payload;
    } catch {
        return null;
    }
}

function roomRequireAuth(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m) return null;
    return roomVerifyJwt(m[1].trim(), ROOM_AUTH_SECRET);
}

function roomTokenLocal(code, uid) {
    return Buffer.from(String(uid)).toString('base64') + '.' + roomHmacHex(ROOM_AUTH_SECRET, `room:${code}:${uid}`);
}

function roomGenCode() {
    let code = '';
    while (code.length < 6) {
        const buf = crypto.randomBytes(16);
        for (let i = 0; i < buf.length && code.length < 6; i++) {
            if (buf[i] < 248) code += ROOM_ALPHABET[buf[i] % 31];
        }
    }
    return code;
}

function newLocalRoom(code, hostUid, hostName) {
    return {
        state: {
            code, hostUid: String(hostUid), hostName: hostName || '',
            mode: null, mediaKey: '', title: '', url: '', epIndex: 0, levelIndex: null,
            playing: false, time: 0, rate: 1, epoch: 0, shared: false, episodes: null,
        },
        strokes: [],
        chatTail: [],
        chatSeq: 0,
        seq: 0,
        chatLog: new Map(), // uid -> 时间戳数组（限速）
        members: new Set(), // 在线 ws（ws._uid / ws._name）
    };
}

function roomOnline(room) {
    return [...new Set([...room.members].map((w) => w._uid).filter(Boolean))];
}

function roomSend(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch { }
}

function roomBroadcast(room, obj, excludeWs) {
    const raw = JSON.stringify(obj);
    for (const ws of room.members) {
        if (ws === excludeWs) continue;
        try { ws.send(raw); } catch { }
    }
}

app.post('/api/room/create', (req, res) => {
    const payload = roomRequireAuth(req);
    if (!payload || payload.uid === undefined) return res.status(401).json({ error: 'unauthorized' });
    const uid = String(payload.uid);
    let code = '';
    for (let i = 0; i < 5 && !code; i++) {
        const cand = roomGenCode();
        if (!rooms.has(cand)) code = cand;
    }
    if (!code) return res.status(500).json({ error: 'roomCreateFailed' });
    rooms.set(code, newLocalRoom(code, uid, typeof payload.un === 'string' ? payload.un : ''));
    res.json({ code, roomToken: roomTokenLocal(code, uid) });
});

app.post('/api/room/join', (req, res) => {
    const payload = roomRequireAuth(req);
    if (!payload || payload.uid === undefined) return res.status(401).json({ error: 'unauthorized' });
    const code = String((req.body && req.body.code) ?? '').trim().toUpperCase();
    if (!ROOM_CODE_RE.test(code)) return res.status(400).json({ error: 'badRoom' });
    const room = rooms.get(code);
    if (!room) return res.status(404).json({ error: 'badRoom' });
    const uids = roomOnline(room);
    if (uids.length >= ROOM_MAX_PEERS && !uids.includes(String(payload.uid))) {
        return res.status(409).json({ error: 'roomFull' });
    }
    res.json({
        code,
        roomToken: roomTokenLocal(code, String(payload.uid)),
        mode: room.state.mode,
        mediaKey: room.state.mediaKey,
        title: room.state.title,
        hostUid: room.state.hostUid,
    });
});

// 本地房间消息处理（协议与 sync-worker WatchRoom.webSocketMessage 对齐）
function roomOnMessage(room, ws, raw) {
    const text = raw.toString();
    if (text === '{"t":"hb"}') { roomSend(ws, text); return; } // 心跳原样回声（客户端按字面量测 RTT）
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const uid = ws._uid || '';
    const name = ws._name || '';
    if (!uid) return;
    const now = Date.now();
    const st = room.state;

    switch (m.t) {
        case 'share': {
            if (String(uid) !== String(st.hostUid)) return;
            st.shared = !!m.on;
            roomBroadcast(room, { t: 'shared', on: st.shared, by: uid }, null);
            return;
        }
        case 'play':
        case 'pause':
        case 'seek': {
            if (String(uid) !== String(st.hostUid) && !st.shared) return;
            if (m.t === 'play') st.playing = true;
            if (m.t === 'pause') st.playing = false;
            if (typeof m.time === 'number') st.time = m.time;
            if (typeof m.rate === 'number') st.rate = m.rate;
            st.epoch++;
            roomBroadcast(room, { t: 'ctl', kind: m.t, time: st.time, rate: st.rate, playing: st.playing, epoch: st.epoch, at: now, by: uid }, ws);
            return;
        }
        case 'tick': {
            if (String(uid) !== String(st.hostUid)) return;
            const tTime = typeof m.time === 'number' ? m.time : st.time;
            const tRate = typeof m.rate === 'number' && m.rate > 0 ? m.rate : st.rate;
            roomBroadcast(room, { t: 'tickState', time: tTime, rate: tRate, playing: st.playing, epoch: st.epoch, at: now }, ws);
            return;
        }
        case 'pos':
            roomBroadcast(room, { t: 'peerpos', uid, time: m.time, buf: m.buf, at: now }, ws);
            return;
        case 'buf':
            roomBroadcast(room, { t: 'peerbuf', uid, buf: m.buf, cached: m.cached === undefined ? null : m.cached }, ws);
            return;
        case 'src': {
            const v = m.video;
            if (!v || typeof v !== 'object' || !v.mode || typeof v.title !== 'string') return;
            st.mode = v.mode;
            if (v.mediaKey !== undefined) st.mediaKey = String(v.mediaKey);
            if (v.title !== undefined) st.title = String(v.title);
            if (v.url !== undefined) st.url = String(v.url);
            if (v.epIndex !== undefined) st.epIndex = v.epIndex | 0;
            if (v.levelIndex !== undefined) st.levelIndex = v.levelIndex === null ? null : v.levelIndex | 0;
            if (v.episodes !== undefined) st.episodes = Array.isArray(v.episodes) ? v.episodes.slice(0, 500).map(String) : null;
            st.epoch++;
            roomBroadcast(room, { t: 'src', video: { mode: st.mode, mediaKey: st.mediaKey, title: st.title, url: st.url, epIndex: st.epIndex, levelIndex: st.levelIndex, episodes: st.episodes ?? null, name: v.name ?? null, size: v.size ?? null, fp: v.fp ?? null }, epoch: st.epoch, by: uid }, ws);
            return;
        }
        case 'ready': {
            try {
                if (JSON.stringify(m.info ?? null).length > 4096) return;
            } catch { return; }
            roomBroadcast(room, { t: 'ready', uid, info: m.info }, ws);
            return;
        }
        case 'chat': {
            const chatText = String(m.text || '').slice(0, 500);
            if (!chatText) return;
            let log = room.chatLog.get(uid);
            if (!log) { log = []; room.chatLog.set(uid, log); }
            while (log.length && now - log[0] >= 5000) log.shift();
            if (log.length >= 10) return;
            log.push(now);
            const rec = { uid, name, kind: 'user', text: chatText, ts: now, seq: ++room.chatSeq };
            room.chatTail.push(rec);
            while (room.chatTail.length > 100) room.chatTail.shift();
            roomBroadcast(room, { t: 'chat', ...rec }, ws);
            return;
        }
        case 'stroke': {
            const op = m.op;
            if (!op || typeof op !== 'object' || !Array.isArray(op.pts)) return;
            const seq = ++room.seq;
            let target = null;
            for (let i = room.strokes.length - 1; i >= 0; i--) {
                const s = room.strokes[i];
                if (s.id === op.id && s.uid === uid && !s.final) { target = s; break; }
            }
            if (target) {
                for (const p of op.pts) target.pts.push(p);
                target.final = !!op.final;
            } else {
                target = { seq, id: op.id, uid, color: op.color, w: op.w, pts: op.pts, final: !!op.final, mode: op.mode === 'erase' ? 'erase' : 'draw', t: now };
                room.strokes.push(target);
            }
            let bytes = JSON.stringify(room.strokes).length;
            while (room.strokes.length && (room.strokes.length > 600 || bytes > 1500000)) {
                const dropped = room.strokes.shift();
                bytes -= JSON.stringify(dropped).length + 1;
            }
            roomBroadcast(room, { t: 'stroke', op: { id: op.id, color: target.color, w: target.w, pts: op.pts, final: target.final, mode: target.mode }, by: uid, seq }, ws);
            return;
        }
        case 'undo': {
            for (let i = room.strokes.length - 1; i >= 0; i--) {
                if (room.strokes[i].uid === uid) {
                    const removed = room.strokes.splice(i, 1)[0];
                    roomBroadcast(room, { t: 'undo', by: uid, strokeId: removed.id }, ws);
                    break;
                }
            }
            return;
        }
        case 'clear': {
            room.strokes = [];
            room.seq = 0;
            roomBroadcast(room, { t: 'clear', by: uid }, ws);
            return;
        }
        default:
            return;
    }
}

function roomOnClose(room, ws) {
    if (!room.members.delete(ws)) return;
    const rest = [...room.members];
    // 房主离开：剩余首位接任（与 DO 一致）
    if (String(ws._uid) === String(room.state.hostUid) && rest.length) {
        const next = rest[0];
        if (next._uid) room.state.hostUid = next._uid;
        room.state.hostName = next._name || '';
    }
    if (rest.length) {
        const online = roomOnline(room);
        roomBroadcast(room, { t: 'presence', online, count: online.length, hostUid: room.state.hostUid, leave: { uid: ws._uid, name: ws._name || '' } }, null);
    }
    // 本地实现不回收房间：保留状态便于刷新重连（dev 环境重启即清零，可接受）
}

// 本地账号 API：把 /api/* 请求转发给与云端共用的 handleApi（含 mini D1 mock 持久化）
const accountDb = createMiniD1({ file: path.join(__dirname, 'data', 'account-dev.json') });
const accountEnv = () => ({
  WDTV_DB: accountDb,
  AUTH_SECRET: process.env.AUTH_SECRET || 'wdtv-dev-secret',
  ALLOW_REGISTER: process.env.ALLOW_REGISTER || 'true'
});
app.use('/api', async (req, res) => {
  try {
    // req.path 在 /api 挂载点下为相对路径；originalUrl 还原完整 URL 供 handleApi 使用
    const url = new URL(req.originalUrl, 'http://localhost');
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    // 透传客户端请求头（剔除逐跳/传输层头），保证 If-None-Match 等条件请求语义完整；
    // content-length 必须剔除：body 会重新序列化，长度交给 Node 自行计算
    const headers = {};
    const SKIPPED = ['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'expect', 'content-length'];
    for (const [k, v] of Object.entries(req.headers)) {
      if (SKIPPED.includes(k)) continue;
      if (!hasBody && k === 'content-type') continue;
      headers[k] = v;
    }
    const request = new Request(url.href, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined
    });
    const resp = await handleApi(request, accountEnv());
    res.status(resp.status);
    // 逐头透传，跳过传输层头（Node 自行计算 content-length）
    resp.headers.forEach((v, k) => {
      if (!['content-length', 'transfer-encoding'].includes(k)) res.setHeader(k, v);
    });
    res.send(await resp.text());
  } catch (err) {
    console.error('账号 API 错误:', err);
    res.status(500).json({ error: '服务暂时不可用' });
  }
});

function renderPage(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  return content;
}

app.get(['/', '/index.html', '/player.html'], async (req, res) => {
  try {
    let filePath;
    switch (req.path) {
      case '/player.html':
        filePath = path.join(__dirname, 'player.html');
        break;
      default: // '/' 和 '/index.html'
        filePath = path.join(__dirname, 'index.html');
        break;
    }

    // HTML 禁用缓存：保证样式/脚本的版本号热更新能立即到达浏览器
    res.set('Cache-Control', 'no-store');
    const content = renderPage(filePath);
    res.send(content);
  } catch (error) {
    console.error('页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

app.get('/s=:keyword', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'index.html');
    const content = renderPage(filePath);
    res.send(content);
  } catch (error) {
    console.error('搜索页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

function isValidUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const allowedProtocols = ['http:', 'https:'];
    
    // 从环境变量获取阻止的主机名列表
    const blockedHostnames = (process.env.BLOCKED_HOSTS || 'localhost,127.0.0.1,0.0.0.0,::1').split(',');
    
    // 从环境变量获取阻止的 IP 前缀（仅私有网段：172.16.0.0/12 需逐段列出，避免误伤 172.0/15、172.32+ 等公网段）
    const blockedPrefixes = (process.env.BLOCKED_IP_PREFIXES || '192.168.,10.,172.16.,172.17.,172.18.,172.19.,172.20.,172.21.,172.22.,172.23.,172.24.,172.25.,172.26.,172.27.,172.28.,172.29.,172.30.,172.31.').split(',');
    
    if (!allowedProtocols.includes(parsed.protocol)) return false;
    if (blockedHostnames.includes(parsed.hostname)) return false;
    
    for (const prefix of blockedPrefixes) {
      if (parsed.hostname.startsWith(prefix)) return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

app.get('/proxy/:encodedUrl', async (req, res) => {
  try {
    const encodedUrl = req.params.encodedUrl;
    const targetUrl = decodeURIComponent(encodedUrl);

    // 安全验证
    if (!isValidUrl(targetUrl)) {
      return res.status(400).send('无效的 URL');
    }

    log(`代理请求: ${targetUrl}`);

    // 添加请求超时和重试逻辑
    const maxRetries = config.maxRetries;
    let retries = 0;
    
    const makeRequest = async () => {
      try {
        return await axios({
          method: 'get',
          url: targetUrl,
          responseType: 'stream',
          timeout: config.timeout,
          httpAgent,
          httpsAgent,
          headers: {
            'User-Agent': config.userAgent,
            // BYTERANGE 分片：转发客户端 Range 头，上游按区间回 206（与 Cloudflare 版对齐）
            ...(req.headers.range ? { 'Range': req.headers.range } : {}),
            // 豆瓣图片CDN要求携带豆瓣站内Referer，否则按URL确定性返回418/403
            ...(targetUrl.includes('doubanio.com') || targetUrl.includes('douban.com')
              ? { 'Referer': 'https://movie.douban.com/' }
              : {})
          }
        });
      } catch (error) {
        // 仅对网络错误/超时重试；上游已返回HTTP状态码（4xx/5xx）时重试不会成功，只会拖慢响应
        if (retries < maxRetries && !error.response) {
          retries++;
          log(`重试请求 (${retries}/${maxRetries}): ${targetUrl}`);
          return makeRequest();
        }
        throw error;
      }
    };

    const response = await makeRequest();

    // 转发响应头（过滤敏感头）
    const headers = { ...response.headers };
    const sensitiveHeaders = (
      process.env.FILTERED_HEADERS || 
      'content-security-policy,cookie,set-cookie,x-frame-options,access-control-allow-origin'
    ).split(',');
    
    sensitiveHeaders.forEach(header => delete headers[header]);

    // 本地代理缓存策略：点播分片/图片可长缓存；m3u8 播放列表用短缓存
    const upstreamType = (headers['content-type'] || '').toLowerCase();
    headers['cache-control'] = upstreamType.includes('mpegurl')
      ? 'public, max-age=60'
      : 'public, max-age=86400';

    res.set(headers);

    // BYTERANGE 源：上游 206 分区响应原样透传状态码（axios 2xx 视为成功但 res 默认 200）
    if (response.status !== 200) {
      res.status(response.status);
    }

    // 管道传输响应流
    response.data.pipe(res);
  } catch (error) {
    console.error('代理请求错误:', error.message);
    if (error.response) {
      res.status(error.response.status || 500);
      error.response.data.pipe(res);
    } else {
      // 网络层错误（DNS/TCP/超时等）：附上底层原因，便于连接测试诊断
      const bits = [];
      if (error.code) bits.push(`code=${error.code}`);
      if (error.errno) bits.push(`errno=${error.errno}`);
      if (error.syscall) bits.push(`syscall=${error.syscall}`);
      if (error.hostname) bits.push(`host=${error.hostname}`);
      if (error.address) bits.push(`addr=${error.address}`);
      res.status(500).send(`请求失败: ${error.message}${bits.length ? ' | ' + bits.join(' | ') : ''}`);
    }
  }
});

// 静态资源禁用强缓存（css/js 版本号热更新立即生效；视频代理等大流量响应不受影响）
app.use(express.static(path.join(__dirname), {
  maxAge: config.cacheMaxAge,
  setHeaders: (res, filePath) => {
    if (/\.(html|css|js|json|webmanifest)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).send('服务器内部错误');
});

app.use((req, res) => {
  res.status(404).send('页面未找到');
});

// 启动服务器
const server = app.listen(config.port, () => {
  console.log(`服务器运行在 http://localhost:${config.port}`);
  if (config.debug) {
    console.log('调试模式已启用');
    console.log('配置:', { ...config });
  }
});

// 共同观影 WS 升级：/api/room/ws?room=&token=&name= —— 校验 roomToken 后入房
// （uid 以 token 反解覆盖，防伪造；与 Pages Function handleWs + DO handleWs 同语义）
const roomWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== '/api/room/ws') {
    socket.destroy();
    return;
  }
  const code = (url.searchParams.get('room') || '').trim().toUpperCase();
  const token = url.searchParams.get('token') || '';
  let name = (url.searchParams.get('name') || '').trim();
  if (name.length > 32) name = name.slice(0, 32);
  // roomToken 反解 uid：base64(uid) + '.' + hex(HMAC(secret,'room:code:uid'))
  let uid = null;
  try {
    const dot = token.indexOf('.');
    if (dot > 0) {
      const cand = Buffer.from(token.slice(0, dot).replace(/ /g, '+'), 'base64').toString('utf8');
      if (cand && roomConstantTimeEq(token.slice(dot + 1), roomHmacHex(ROOM_AUTH_SECRET, `room:${code}:${cand}`))) uid = cand;
    }
  } catch { }
  if (!ROOM_CODE_RE.test(code) || !uid) {
    // 鉴权失败：与云端一致返回 403 JSON（升级前拒绝）
    socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"error":"authFailed"}');
    socket.destroy();
    return;
  }
  roomWss.handleUpgrade(req, socket, head, (ws) => {
    let room = rooms.get(code);
    if (!room) {
      // 房间不存在：凭有效 token 重入重建（重入者成为房主，与 DO 一致）
      room = newLocalRoom(code, uid, name);
      rooms.set(code, room);
    }
    // 同 uid 替换：旧连接以 4000 关闭（刷新/换标签页重连场景）
    for (const old of [...room.members]) {
      if (old._uid === uid) {
        room.members.delete(old);
        try { old.close(4000, 'replaced'); } catch { }
      }
    }
    // 满员检查（不含正被替换的同 uid 连接）：完成握手后立即以 1013 关闭，客户端感知 roomFull
    if (room.members.size >= ROOM_MAX_PEERS) {
      try { ws.close(1013, 'room full'); } catch { }
      return;
    }
    room.members.add(ws);
    ws._uid = uid;
    ws._name = name;
    ws._code = code;
    ws.on('message', (data) => roomOnMessage(room, ws, data));
    ws.on('close', () => roomOnClose(room, ws));
    ws.on('error', () => { });
    // 入房快照（与 DO snap 同构）
    const online = roomOnline(room);
    roomSend(ws, { t: 'snap', state: room.state, online, strokes: room.strokes, chatTail: room.chatTail });
    roomBroadcast(room, { t: 'presence', online, count: online.length, hostUid: room.state.hostUid, join: { uid, name } }, ws);
  });
});
