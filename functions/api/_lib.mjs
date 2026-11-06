// 账号系统 API 共享核心（纯 Web Crypto，无 Workers 专有 API，可在 Node 22 中直接 import）
// 由 functions/api/[[path]].js（Pages Functions）与本地开发服 server.mjs 共用同一实现

// ============================================================
// 基础工具
// ============================================================

// Response 构造（统一 JSON 输出）
export function json(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    });
}

// HMAC-SHA256，返回 hex 字符串
export async function hmacHex(secret, message) {
    const bytes = await hmacRaw(secret, message);
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return hex;
}

// HMAC-SHA256，返回原始字节
async function hmacRaw(secret, message) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(String(secret)),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    return new Uint8Array(sig);
}

// 字符串恒时比较（长度不同也不提前返回）
export function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const len = Math.max(a.length, b.length);
    let diff = a.length === b.length ? 0 : 1;
    for (let i = 0; i < len; i++) {
        // charCodeAt 越界返回 NaN，位运算中被 ToInt32 转为 0
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

// ============================================================
// JWT（HS256）：base64url(header).base64url(payload).base64url(HMAC-SHA256(secret, 前两段))
// ============================================================

function bytesToBase64Url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// UTF-8 安全的 base64url 编码（用户名可能含中文）
function strToBase64Url(str) {
    const bytes = new TextEncoder().encode(str);
    return bytesToBase64Url(bytes);
}

function base64UrlToBytes(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const bin = atob(b64 + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

// 签发 JWT，payloadObj 中 iat/exp 单位为秒
export async function signJwt(payloadObj, secret) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const h = strToBase64Url(JSON.stringify(header));
    const p = strToBase64Url(JSON.stringify(payloadObj));
    const sig = await hmacRaw(secret, `${h}.${p}`);
    return `${h}.${p}.${bytesToBase64Url(sig)}`;
}

// 校验 JWT：恒时比较签名 + 校验 exp，成功返回 payload 对象，失败返回 null
export async function verifyJwt(token, secret) {
    try {
        if (typeof token !== 'string') return null;
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const sigHex = Array.from(base64UrlToBytes(parts[2]), (b) => b.toString(16).padStart(2, '0')).join('');
        const expectHex = Array.from(await hmacRaw(secret, `${parts[0]}.${parts[1]}`), (b) => b.toString(16).padStart(2, '0')).join('');
        if (!constantTimeEqual(sigHex, expectHex)) return null;
        const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])));
        if (!payload || typeof payload !== 'object') return null;
        // exp 必须为未来时间（秒）
        if (typeof payload.exp !== 'number' || Date.now() / 1000 >= payload.exp) return null;
        return payload;
    } catch {
        return null;
    }
}

// ============================================================
// 业务校验
// ============================================================

// 用户名：不限制字符集与最短长度，仅要求非空；上限 64 字符仅为防止异常超大 payload
function isValidUsername(u) {
    return typeof u === 'string' && u.length > 0 && u.length <= 64;
}
// 客户端盐：32 位 hex；客户端哈希：64 位 hex
const SALT_RE = /^[0-9a-f]{32}$/;
const CLIENT_HASH_RE = /^[0-9a-f]{64}$/;
// 头像 dataUrl 前缀与大小上限（300KB）
const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,/;
const AVATAR_MAX = 300000;
// 同步数据上限（500KB）
const SYNC_MAX = 512000;
// 登录限速阈值：10 次失败锁定 10 分钟
const LOGIN_MAX = 10;
const LOGIN_LOCK_MS = 600000;

// 安全读取 JSON body（非法 JSON 返回空对象，交给后续校验报错）
async function readJson(request) {
    try {
        const body = await request.json();
        return body && typeof body === 'object' ? body : {};
    } catch {
        return {};
    }
}

// D1 未绑定视为服务不可用（抛出后由顶层 catch 统一转 500）
function ensureDb(env) {
    if (!env || !env.WDTV_DB) throw new Error('WDTV_DB not configured');
}

function str(v) {
    return typeof v === 'string' ? v : '';
}

// 是否开放注册（显式 "false" 才关闭）
function allowRegister(env) {
    return env.ALLOW_REGISTER !== 'false';
}

// ============================================================
// AUTH_SECRET 统一获取（关键一致性保证）
// ============================================================
// AUTH_SECRET 同时决定 JWT 签名与密码哈希（password_hash = HMAC(secret, clientHash)）。
// 一旦取值发生变化（例如从未设置 secret 变为已设置），所有已签发 token 与全部账号
// 密码哈希立即失效，表现为"所有账号都无法登录，只能重新注册"。
// 历史隐患：Pages 上未配置 secret 时 env.AUTH_SECRET 为 undefined，会被 String()
// 隐式转成 "undefined" 当密钥——与本地 server.mjs 的默认值不一致，且日后补设
// secret 时全部账号静默报废。统一回退到固定默认值可消除跨环境不一致；
// 生产环境仍应显式配置强随机 AUTH_SECRET（/api/config 的 authSecretSet 可自检）。
export const DEFAULT_AUTH_SECRET = 'wdtv-dev-secret';

// 每个 isolate 只告警一次，避免刷日志
let warnedDefaultSecret = false;

export function authSecret(env) {
    const s = env && env.AUTH_SECRET;
    if (typeof s === 'string' && s.length > 0) return s;
    if (!warnedDefaultSecret) {
        warnedDefaultSecret = true;
        console.warn('[wdtv] AUTH_SECRET 未配置，正在使用公开默认值，生产环境请立即通过 wrangler pages secret put AUTH_SECRET 设置强随机密钥');
    }
    return DEFAULT_AUTH_SECRET;
}

// 登录限速表：key = ip|username小写，值 = { count, lockUntil }（模块级，单实例内有效）
const loginAttempts = new Map();

// 从 Authorization: Bearer <jwt> 解出 payload，失败返回 null
export async function requireAuth(request, env) {
    const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
    if (!m) return null;
    return verifyJwt(m[1].trim(), authSecret(env));
}

// ============================================================
// 路由处理
// ============================================================

// GET /api/auth/salt?username=X：查 users 表；不存在或参数非法时返回一致的假 salt，避免用户名枚举
async function handleSalt(url, env) {
    ensureDb(env);
    // 去首尾空白：换设备输入时易带入不可见字符
    const username = (url.searchParams.get('username') || '').trim();
    if (isValidUsername(username)) {
        // COLLATE NOCASE：用户名大小写不敏感（手机键盘常自动大写首字母，避免换设备登录查不到用户）
        const row = await env.WDTV_DB.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').bind(username).first();
        if (row) return json({ salt: row.salt, allowRegister: allowRegister(env) });
    }
    const fakeSalt = await hmacHex(authSecret(env), 'wdtv-fake-salt');
    return json({ salt: fakeSalt, allowRegister: allowRegister(env) });
}

// POST /api/auth/register：body { username, salt, clientHash }
async function handleRegister(request, env) {
    if (!allowRegister(env)) return json({ error: '注册已关闭' }, 403);
    ensureDb(env);
    const body = await readJson(request);
    const username = str(body.username).trim();
    const salt = str(body.salt);
    const clientHash = str(body.clientHash);
    if (!isValidUsername(username) || !SALT_RE.test(salt) || !CLIENT_HASH_RE.test(clientHash)) {
        return json({ error: '用户名或密码格式不正确' }, 400);
    }
    // 大小写不敏感查重，防止注册出仅大小写不同的重复账号
    const exist = await env.WDTV_DB.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').bind(username).first();
    if (exist) return json({ error: '用户名已被占用' }, 409);
    // 存库的是服务端加盐哈希：AUTH_SECRET 再包一层 clientHash，泄露数据库也拿不到原始凭据
    const now = Date.now();
    const res = await env.WDTV_DB
        .prepare('INSERT INTO users (username, salt, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(username, salt, await hmacHex(authSecret(env), clientHash), null, now)
        .run();
    const uid = res.meta.last_row_id;
    const sec = Math.floor(now / 1000);
    const token = await signJwt({ uid, un: username, iat: sec, exp: sec + 30 * 86400 }, authSecret(env));
    return json({ token, username, nickname: null, avatarVersion: 0 });
}

// POST /api/auth/login：body { username, clientHash }，带限速；错误统一 401 不泄露细节
async function handleLogin(request, env) {
    ensureDb(env);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const body = await readJson(request);
    const username = str(body.username).trim();
    const clientHash = str(body.clientHash);
    const key = `${ip}|${username.toLowerCase()}`;
    const now = Date.now();
    let rec = loginAttempts.get(key);
    if (!rec) {
        rec = { count: 0, lockUntil: 0 };
        loginAttempts.set(key, rec);
    }
    if (now < rec.lockUntil) return json({ error: '尝试次数过多，请 10 分钟后再试' }, 429);

    // COLLATE NOCASE：大小写不敏感匹配，登录成功后以库中规范用户名签发 token
    const row =
        isValidUsername(username) && CLIENT_HASH_RE.test(clientHash)
            ? await env.WDTV_DB.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').bind(username).first()
            : null;
    const expected = row ? await hmacHex(authSecret(env), clientHash) : '';
    if (!row || !constantTimeEqual(row.password_hash, expected)) {
        // 失败计数，达到阈值锁定 10 分钟
        rec.count++;
        if (rec.count >= LOGIN_MAX) {
            rec.lockUntil = now + LOGIN_LOCK_MS;
            rec.count = 0;
        }
        return json({ error: '用户名或密码错误' }, 401);
    }
    loginAttempts.delete(key);

    const avatarRow = await env.WDTV_DB.prepare('SELECT data, updated_at FROM avatars WHERE user_id = ?').bind(row.id).first();
    const sec = Math.floor(now / 1000);
    const token = await signJwt({ uid: row.id, un: row.username, iat: sec, exp: sec + 30 * 86400 }, authSecret(env));
    return json({
        token,
        username: row.username,
        nickname: row.display_name ?? null,
        avatarVersion: avatarRow ? avatarRow.updated_at : 0,
    });
}

// GET /api/user/me
async function handleMe(request, env, payload) {
    ensureDb(env);
    const row = await env.WDTV_DB.prepare('SELECT * FROM users WHERE username = ?').bind(payload.un).first();
    const avatarRow = await env.WDTV_DB.prepare('SELECT data, updated_at FROM avatars WHERE user_id = ?').bind(payload.uid).first();
    return json({
        username: payload.un,
        nickname: row ? (row.display_name ?? null) : null,
        avatarVersion: avatarRow ? avatarRow.updated_at : 0,
    });
}

// PUT /api/user/profile：body { nickname }，trim 后 0-20 字符，空串=清除
async function handleProfile(request, env, payload) {
    ensureDb(env);
    const body = await readJson(request);
    const nickname = str(body.nickname).trim();
    if (nickname.length > 20) return json({ error: '昵称最多 20 个字符' }, 400);
    await env.WDTV_DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(nickname === '' ? null : nickname, payload.uid).run();
    return json({ ok: true, nickname });
}

// POST /api/user/avatar：body { dataUrl }
async function handleAvatarPost(request, env, payload) {
    ensureDb(env);
    const body = await readJson(request);
    const dataUrl = str(body.dataUrl);
    if (!AVATAR_RE.test(dataUrl) || dataUrl.length > AVATAR_MAX) {
        return json({ error: '头像格式或大小不符合要求' }, 400);
    }
    const ts = Date.now();
    await env.WDTV_DB
        .prepare('INSERT INTO avatars (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
        .bind(payload.uid, dataUrl, ts)
        .run();
    return json({ ok: true, avatarVersion: ts });
}

// GET /api/user/avatar：带 ETag，If-None-Match 匹配返回 304
async function handleAvatarGet(request, env, payload) {
    ensureDb(env);
    const row = await env.WDTV_DB.prepare('SELECT data, updated_at FROM avatars WHERE user_id = ?').bind(payload.uid).first();
    if (!row) return json({ dataUrl: null, avatarVersion: 0 });
    const etag = `"v${row.updated_at}"`;
    if ((request.headers.get('If-None-Match') || '') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return json({ dataUrl: row.data, avatarVersion: row.updated_at }, 200, { ETag: etag, 'Cache-Control': 'no-store' });
}

// GET /api/sync
async function handleSyncGet(env, payload) {
    ensureDb(env);
    const row = await env.WDTV_DB.prepare('SELECT payload, revision FROM user_data WHERE user_id = ?').bind(payload.uid).first();
    if (!row) return json({ payload: null, revision: 0 });
    return json({ payload: JSON.parse(row.payload), revision: row.revision });
}

// PUT /api/sync：body { payload, baseRevision }，以 revision 做乐观锁（CAS）
async function handleSyncPut(request, env, payload) {
    ensureDb(env);
    const body = await readJson(request);
    const data = body.payload;
    const baseRevision = body.baseRevision;
    const strData = typeof data === 'object' && data !== null ? JSON.stringify(data) : '';
    if (!strData || strData.length > SYNC_MAX) return json({ error: '同步数据过大' }, 413);
    if (!Number.isInteger(baseRevision) || baseRevision < 0) return json({ error: '请求参数不正确' }, 400);
    const ts = Date.now();
    const uid = payload.uid;

    // 首次写入（客户端基于空数据）：直接 INSERT revision=1
    if (baseRevision === 0) {
        const exist = await env.WDTV_DB.prepare('SELECT payload, revision FROM user_data WHERE user_id = ?').bind(uid).first();
        if (!exist) {
            try {
                await env.WDTV_DB
                    .prepare('INSERT INTO user_data (user_id, payload, revision, updated_at) VALUES (?, ?, ?, ?)')
                    .bind(uid, strData, 1, ts)
                    .run();
                return json({ ok: true, revision: 1 });
            } catch {
                // 并发竞争撞主键：回落到下面的更新路径，由 CAS 结果决定成败
            }
        }
    }

    // 乐观锁更新：仅当数据库 revision 等于客户端 baseRevision 时生效
    const res = await env.WDTV_DB
        .prepare('UPDATE user_data SET payload = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?')
        .bind(strData, ts, uid, baseRevision)
        .run();
    if (!res.meta.changes) {
        // 版本冲突：回传服务端当前数据让客户端合并
        const cur = await env.WDTV_DB.prepare('SELECT payload, revision FROM user_data WHERE user_id = ?').bind(uid).first();
        return json(
            { error: 'conflict', payload: cur ? JSON.parse(cur.payload) : null, revision: cur ? cur.revision : 0 },
            409
        );
    }
    return json({ ok: true, revision: baseRevision + 1 });
}

// ============================================================
// 管理端（X-Admin-Key 鉴权）
// ============================================================

// 管理端密钥校验：X-Admin-Key 与 env.ADMIN_KEY 恒时比较
// 返回 'ok' | 'disabled'（未配置 ADMIN_KEY，管理接口关闭）| 'denied'（密钥不符）
function adminAuth(request, env) {
    const key = env && env.ADMIN_KEY;
    if (typeof key !== 'string' || key.length === 0) return 'disabled';
    const provided = request.headers.get('X-Admin-Key') || '';
    return constantTimeEqual(provided, key) ? 'ok' : 'denied';
}

// GET /api/admin/users：全量账号列表（绝不返回 salt 与 password_hash）
async function handleAdminUsers(env) {
    ensureDb(env);
    const rows =
        (await env.WDTV_DB.prepare('SELECT id, username, display_name, created_at FROM users ORDER BY id').all()).results || [];
    const users = [];
    for (const u of rows) {
        const d = await env.WDTV_DB.prepare('SELECT revision, updated_at FROM user_data WHERE user_id = ?').bind(u.id).first();
        const a = await env.WDTV_DB.prepare('SELECT updated_at FROM avatars WHERE user_id = ?').bind(u.id).first();
        users.push({
            id: u.id,
            username: u.username,
            nickname: u.display_name ?? null,
            createdAt: u.created_at,
            revision: d ? d.revision : 0,
            syncUpdatedAt: d ? d.updated_at : 0,
            hasAvatar: !!a,
            avatarUpdatedAt: a ? a.updated_at : 0,
        });
    }
    return json({ users });
}

// GET /api/admin/avatar?userId=N：读取指定账号上传的头像（dataUrl，带 ETag 304）
async function handleAdminAvatar(request, url, env) {
    ensureDb(env);
    const userId = Number(url.searchParams.get('userId'));
    if (!Number.isInteger(userId) || userId <= 0) return json({ error: '参数不正确' }, 400);
    const row = await env.WDTV_DB.prepare('SELECT data, updated_at FROM avatars WHERE user_id = ?').bind(userId).first();
    if (!row) return json({ dataUrl: null, updatedAt: 0 });
    const etag = `"v${row.updated_at}"`;
    if ((request.headers.get('If-None-Match') || '') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return json({ dataUrl: row.data, updatedAt: row.updated_at }, 200, { ETag: etag, 'Cache-Control': 'no-store' });
}

// POST /api/admin/reset-password：body { userId, salt, clientHash }
// 管理页在浏览器端用新密码 PBKDF2 派生 clientHash 后提交，服务端与注册同规二次加盐存储
async function handleAdminResetPassword(request, env) {
    ensureDb(env);
    const body = await readJson(request);
    const userId = Number(body.userId);
    const salt = str(body.salt);
    const clientHash = str(body.clientHash);
    if (!Number.isInteger(userId) || userId <= 0 || !SALT_RE.test(salt) || !CLIENT_HASH_RE.test(clientHash)) {
        return json({ error: '参数不正确' }, 400);
    }
    const target = await env.WDTV_DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
    if (!target) return json({ error: '用户不存在' }, 404);
    await env.WDTV_DB
        .prepare('UPDATE users SET salt = ?, password_hash = ? WHERE id = ?')
        .bind(salt, await hmacHex(authSecret(env), clientHash), userId)
        .run();
    return json({ ok: true });
}

// POST /api/admin/delete-user：body { userId }，连同同步数据与头像一并删除
// 删除后该账号已签发的 token 由受保护路由的"用户存活校验"立即失效（无需等 30 天过期）
async function handleAdminDeleteUser(request, env) {
    ensureDb(env);
    const body = await readJson(request);
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) return json({ error: '参数不正确' }, 400);
    const target = await env.WDTV_DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
    if (!target) return json({ error: '用户不存在' }, 404);
    await env.WDTV_DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
    await env.WDTV_DB.prepare('DELETE FROM user_data WHERE user_id = ?').bind(userId).run();
    await env.WDTV_DB.prepare('DELETE FROM avatars WHERE user_id = ?').bind(userId).run();
    return json({ ok: true });
}

// GET /api/admin/user-data?userId=N：读取指定账号的同步数据
async function handleAdminUserData(url, env) {
    ensureDb(env);
    const userId = Number(url.searchParams.get('userId'));
    if (!Number.isInteger(userId) || userId <= 0) return json({ error: '参数不正确' }, 400);
    const target = await env.WDTV_DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
    if (!target) return json({ error: '用户不存在' }, 404);
    const row = await env.WDTV_DB.prepare('SELECT payload, revision, updated_at FROM user_data WHERE user_id = ?').bind(userId).first();
    let payload = null;
    if (row) {
        try { payload = JSON.parse(row.payload); } catch { payload = null; }
    }
    return json({ payload, revision: row ? row.revision : 0, updatedAt: row ? row.updated_at : 0 });
}

// ============================================================
// 主入口
// ============================================================

// API 主入口：路由分发 + 统一异常兜底
export async function handleApi(request, env) {
    try {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // ---- 管理端接口（X-Admin-Key 鉴权；未配置 ADMIN_KEY 时全部关闭）----
        if (path.startsWith('/api/admin/')) {
            const auth = adminAuth(request, env);
            if (auth === 'disabled') return json({ error: '管理接口未启用' }, 403);
            if (auth === 'denied') return json({ error: '管理密钥不正确' }, 403);
            if (path === '/api/admin/users' && method === 'GET') return await handleAdminUsers(env);
            if (path === '/api/admin/user-data' && method === 'GET') return await handleAdminUserData(url, env);
            if (path === '/api/admin/avatar' && method === 'GET') return await handleAdminAvatar(request, url, env);
            if (path === '/api/admin/reset-password' && method === 'POST') return await handleAdminResetPassword(request, env);
            if (path === '/api/admin/delete-user' && method === 'POST') return await handleAdminDeleteUser(request, env);
            return json({ error: 'Not Found' }, 404);
        }

        // ---- 公开接口 ----
        // /api/config：注册开关 + 部署自检（db: D1 是否绑定；authSecretSet: 是否已配置
        // 强随机 AUTH_SECRET——false 表示正在使用公开默认值，存在安全风险，请尽快设置）
        if (path === '/api/config' && method === 'GET') {
            return json({
                allowRegister: allowRegister(env),
                db: !!(env && env.WDTV_DB),
                authSecretSet: !!(env && typeof env.AUTH_SECRET === 'string' && env.AUTH_SECRET.length > 0)
            });
        }
        if (path === '/api/auth/salt' && method === 'GET') {
            return await handleSalt(url, env);
        }
        if (path === '/api/auth/register' && method === 'POST') {
            return await handleRegister(request, env);
        }
        if (path === '/api/auth/login' && method === 'POST') {
            return await handleLogin(request, env);
        }

        // ---- 需鉴权接口 ----
        if (
            (path === '/api/user/me' && method === 'GET') ||
            (path === '/api/user/profile' && method === 'PUT') ||
            (path === '/api/user/avatar' && (method === 'GET' || method === 'POST')) ||
            (path === '/api/sync' && (method === 'GET' || method === 'PUT'))
        ) {
            const payload = await requireAuth(request, env);
            if (!payload) return json({ error: '登录已过期，请重新登录' }, 401);
            // 用户存活校验：账号被管理员删除后立即踢下线（JWT 本身 30 天有效，不能等过期）
            const alive = await env.WDTV_DB.prepare('SELECT id FROM users WHERE id = ?').bind(payload.uid).first();
            if (!alive) return json({ error: '登录已过期，请重新登录' }, 401);
            if (path === '/api/user/me') return await handleMe(request, env, payload);
            if (path === '/api/user/profile') return await handleProfile(request, env, payload);
            if (path === '/api/user/avatar') {
                return method === 'POST'
                    ? await handleAvatarPost(request, env, payload)
                    : await handleAvatarGet(request, env, payload);
            }
            return method === 'PUT' ? await handleSyncPut(request, env, payload) : await handleSyncGet(env, payload);
        }

        return json({ error: 'Not Found' }, 404);
    } catch {
        // 任何异常（含 D1 未绑定）统一对外表现为服务暂不可用，不泄露内部细节
        return json({ error: '服务暂时不可用' }, 500);
    }
}
