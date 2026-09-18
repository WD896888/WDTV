// 双人共同观影房间 API 入口（Pages Functions 文件路由 /api/room/[[path]]）
// 路由：
//   POST /api/room/create —— 登录后创建房间：生成 6 位房间码 → 实时层 /__create 查重（碰撞换码重试 ≤5）→ { code, roomToken }
//   POST /api/room/join   —— 登录 + body {code} → 实时层 /__info 预检 → { code, roomToken, mode, mediaKey, title, hostUid }
//   GET  /api/room/ws     —— WS 升级：校验房间码与 roomToken → 透传升级请求（DO 完成 101 握手）
// 鉴权设计（与账号系统一致，复用 _lib.mjs，不复制代码）：
//   create/join 走 Authorization: Bearer JWT（requireAuth）；
//   ws 无法携带请求头，改用房间作用域凭证 roomToken = btoa(uid) + '.' + hmacHex(AUTH_SECRET, 'room:code:uid')，
//   由 create/join 签发、verifyRoomToken 恒时校验，WS URL 不暴露长期 JWT；
//   uid 以 token 反解为准（覆盖客户端自报），昵称 name 由客户端连接时附上，Function 仅限长与转码后透传。
// 实时层选择：生产走 env.WATCH_ROOM（独立 Worker sync-worker 的 WatchRoom Durable Object 绑定）；
//   本地联调（绑定缺失但 SYNC_DEV_URL 已设）把内部调用转发到开发 worker；两者皆缺 → 503 sync_unconfigured。
import { requireAuth, hmacHex, constantTimeEqual, json } from '../_lib.mjs';

// 房间码字母表：31 字符（去除易混淆的 I L O 0 1 V），6 位空间约 8.9 亿
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;
const MAX_CREATE_RETRY = 5;
const MAX_NAME_LEN = 32;

// 生成 6 位房间码：crypto.getRandomValues + 拒绝采样（buf[i] < 248 才取模），消除 256 % 31 的模偏差
function genRoomCode() {
    const buf = new Uint8Array(16);
    let code = '';
    while (code.length < 6) {
        crypto.getRandomValues(buf);
        for (let i = 0; i < buf.length && code.length < 6; i++) {
            if (buf[i] < 248) code += ALPHABET[buf[i] % 31];
        }
    }
    return code;
}

// roomToken：房间作用域一次性凭证（uid 明文可逆 + 恒时 HMAC 校验，不含长期 JWT）
async function roomToken(env, code, uid) {
    return btoa(String(uid)) + '.' + (await hmacHex(env.AUTH_SECRET, `room:${code}:${uid}`));
}

// 校验 roomToken：成功返回 token 内的 uid，失败返回 null
async function verifyRoomToken(env, code, token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
        const uid = atob(parts[0]);
        if (!uid) return null;
        const expect = await hmacHex(env.AUTH_SECRET, `room:${code}:${uid}`);
        return constantTimeEqual(parts[1], expect) ? uid : null;
    } catch {
        return null;
    }
}

// DO 调用封装：按房间码取 WatchRoom 实例 stub；未配置返回 null
function roomStub(env, code) {
    return env.WATCH_ROOM ? env.WATCH_ROOM.get(env.WATCH_ROOM.idFromName(code)) : null;
}

// 实时层是否可达（DO 绑定或本地开发 worker 二者其一）
function syncReady(env) {
    return Boolean(env.WATCH_ROOM || env.SYNC_DEV_URL);
}

// 实时层内部调用（/__create、/__info）：优先 DO 绑定（受信），否则转发本地开发 worker（带内部密钥）；均不可达返回 null
async function callInternal(env, code, pathname, body) {
    const init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': env.AUTH_SECRET },
        body: JSON.stringify(body),
    };
    if (env.WATCH_ROOM) {
        return roomStub(env, code).fetch('https://do' + pathname, init);
    }
    if (env.SYNC_DEV_URL) {
        return fetch(env.SYNC_DEV_URL.replace(/\/+$/, '') + pathname, init);
    }
    return null;
}

// POST /api/room/create：JWT 登录 → 生成房间码 → /__create 查重（碰撞换码重试 ≤5）→ { code, roomToken }
async function handleCreate(request, env) {
    const payload = await requireAuth(request, env);
    if (!payload) return json({ error: 'unauthorized' }, 401);
    if (!syncReady(env)) return json({ error: 'sync_unconfigured' }, 503);
    const uid = payload.uid;
    const name = typeof payload.un === 'string' ? payload.un : '';
    for (let i = 0; i < MAX_CREATE_RETRY; i++) {
        const code = genRoomCode();
        const res = await callInternal(env, code, '/__create', { code, uid, name });
        if (!res) return json({ error: 'sync_unconfigured' }, 503);
        const data = await res.json().catch(() => ({}));
        if (data && data.created) return json({ code, roomToken: await roomToken(env, code, uid) });
        // {created:false} → 房间码碰撞，换码重试
    }
    return json({ error: 'roomCreateFailed' }, 500);
}

// POST /api/room/join：JWT 登录 + body {code} → /__info 预检 → { code, roomToken, mode, mediaKey, title, hostUid }
async function handleJoin(request, env) {
    const payload = await requireAuth(request, env);
    if (!payload) return json({ error: 'unauthorized' }, 401);
    if (!syncReady(env)) return json({ error: 'sync_unconfigured' }, 503);
    let body = {};
    try {
        body = await request.json();
        if (!body || typeof body !== 'object') body = {};
    } catch {
        body = {};
    }
    const code = String(body.code ?? '').trim().toUpperCase();
    if (!ROOM_CODE_RE.test(code)) return json({ error: 'badRoom' }, 400);
    const res = await callInternal(env, code, '/__info', { code });
    if (!res) return json({ error: 'sync_unconfigured' }, 503);
    const info = await res.json().catch(() => ({}));
    if (!info || !info.exists) return json({ error: 'badRoom' }, 404);
    const uids = Array.isArray(info.uids) ? info.uids : [];
    // 已满但本人 uid 在座 → 允许（同 uid 换标签页/重连重进）
    if (info.full && !uids.some((u) => String(u) === String(payload.uid))) {
        return json({ error: 'roomFull' }, 409);
    }
    return json({
        code,
        roomToken: await roomToken(env, code, payload.uid),
        mode: info.mode ?? null,
        mediaKey: info.mediaKey ?? null,
        title: info.title ?? null,
        hostUid: info.hostUid ?? null,
    });
}

// GET /api/room/ws：WS 升级请求，校验 roomToken 后透传（uid/name 以 query 附上，token 即凭证）
async function handleWs(request, env) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return json({ error: 'badRequest' }, 400);
    }
    const url = new URL(request.url);
    const code = (url.searchParams.get('room') || '').trim().toUpperCase();
    const token = url.searchParams.get('token') || '';
    if (!ROOM_CODE_RE.test(code)) return json({ error: 'badRoom' }, 400);

    const uid = await verifyRoomToken(env, code, token);
    if (!uid) return json({ error: 'authFailed' }, 403);

    // 昵称由客户端连接 URL 附上（客户端本地已知），Function 只限长，DO 侧按 query 读取
    let name = (url.searchParams.get('name') || '').trim();
    if (name.length > MAX_NAME_LEN) name = name.slice(0, MAX_NAME_LEN);

    // 重写 query：uid 以 token 反解覆盖（防伪造），统一字符串（/__create 存的 hostUid 亦为字符串）
    const search = new URLSearchParams();
    search.set('room', code);
    search.set('uid', uid);
    if (name) search.set('name', name);
    search.set('token', token);

    if (env.WATCH_ROOM) {
        // 原样透传升级请求（含 Upgrade 头，DO 完成 101 握手），仅重写 query：uid 以 token 反解覆盖，防伪造；
        // pathname 必须重写为 /ws（DO 侧按 /ws 路由，入站是 /api/room/ws）
        const doUrl = new URL(request.url);
        doUrl.search = search.toString();
        doUrl.pathname = '/ws';
        return roomStub(env, code).fetch(new Request(doUrl, request));
    }
    if (env.SYNC_DEV_URL) {
        // 本地联调：转发到开发 worker 的 /ws（保留 method/headers/升级语义）
        const devUrl = env.SYNC_DEV_URL.replace(/\/+$/, '') + '/ws?' + search.toString();
        return fetch(new Request(devUrl, request));
    }
    return json({ error: 'sync_unconfigured' }, 503);
}

// 主入口：路由分发 + 统一异常兜底
export async function onRequest(context) {
    return handleRoomApi(context.request, context.env);
}

async function handleRoomApi(request, env) {
    try {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;
        if (path === '/api/room/create' && method === 'POST') return await handleCreate(request, env);
        if (path === '/api/room/join' && method === 'POST') return await handleJoin(request, env);
        if (path === '/api/room/ws' && method === 'GET') return await handleWs(request, env);
        return json({ error: 'notFound' }, 404);
    } catch {
        // 任何异常统一对外表现为服务内部错误，不泄露细节
        return json({ error: 'roomInternal' }, 500);
    }
}
