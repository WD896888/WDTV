// ============================================================
// test-sync.mjs —— 账号与云同步全链路自测（Node 22+，无第三方依赖）
// 运行方式：node test-sync.mjs
//
// 组成三部分：
//   一、后端 API 直测：import 真实 functions/api/_lib.mjs + _mock-d1.mjs（内存模式），
//       直接构造 Request 调 handleApi 覆盖认证 / 同步 / 头像 / 昵称 / 限速 / 安全语义
//   二、前端 _merge 合并逻辑单元测试：node:vm 沙箱加载 js/cloud-sync.js，直测 CloudSync._merge
//   三、换设备恢复 e2e：两台"设备"各占独立 vm 沙箱（独立 localStorage），共享同一
//       handleApi env；沙箱内 fetch 桩把请求转发给真实后端，形成前端+后端真集成
//
// 断言使用轻量自写计数器，结尾输出 PASS x/总，任一失败以 exit 1 退出
// ============================================================

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { handleApi, signJwt, verifyJwt } from './functions/api/_lib.mjs';
import { createMiniD1 } from './functions/api/_mock-d1.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'wdtv-test-secret-for-sync-suite';
const API_ORIGIN = 'https://api.test';   // 后端直测用
const SB_ORIGIN = 'https://t.local';     // 沙箱内 location.origin，fetch 桩据此拼 URL

// ========================= 断言计数器 =========================

let pass = 0;
let fail = 0;
const failMessages = [];

function assert(cond, msg) {
    if (cond) {
        pass++;
        console.log('  ok - ' + msg);
    } else {
        fail++;
        failMessages.push(msg);
        console.error('  FAIL - ' + msg);
    }
}

function section(title) {
    console.log('\n===== ' + title + ' =====');
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// 轮询等待条件成立（上限 5 秒），用于等待沙箱内部不返回 Promise 的异步流程
async function waitFor(predicate, label, timeoutMs = 5000, stepMs = 25) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        let ok = false;
        try { ok = await predicate(); } catch { ok = false; }
        if (ok) return;
        await sleep(stepMs);
    }
    throw new Error('等待超时: ' + label);
}

// 等待某台设备的 CloudSync 同步结束（syncing=false 且 lastSyncAt>0 且无错误）
async function waitSynced(sb, label) {
    try {
        await waitFor(() => {
            const s = sb.window.CloudSync.getStatus();
            return !s.syncing && s.lastSyncAt > 0 && !s.lastError;
        }, label);
    } catch (e) {
        throw new Error(label + ' 同步未完成，当前状态: ' + JSON.stringify(sb.window.CloudSync.getStatus()));
    }
}

// 生成指定长度的随机 hex 串（测试用假 salt / clientHash）
function hexOf(len) {
    let s = '';
    for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
}

// 深比较（JSON 语义）
function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

// ========================= 共享后端 env（内存 mock 库） =========================

const env = {
    WDTV_DB: createMiniD1(),          // 不传 file：纯内存，全测试共享
    AUTH_SECRET: SECRET,
    ALLOW_REGISTER: 'true'
};

// 后端直测辅助：构造 Request 调真实 handleApi，返回 {status, data, resp}
async function rawApi(method, pathname, opts = {}) {
    const headers = {};
    if (opts.token) headers['authorization'] = 'Bearer ' + opts.token;
    if (opts.ip) headers['cf-connecting-ip'] = opts.ip;
    if (opts.ifNoneMatch) headers['if-none-match'] = opts.ifNoneMatch;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const req = new Request(API_ORIGIN + pathname, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    });
    const resp = await handleApi(req, env);
    let data = null;
    try { data = await resp.json(); } catch { data = null; }
    return { status: resp.status, data, resp };
}

// ========================= vm 沙箱（前端设备模拟） =========================

// Map 实现的 localStorage 桩（含 length / key，满足 collectItems 全量扫描）
function createLocalStorageStub() {
    const map = new Map();
    return {
        map,
        get length() { return map.size; },
        getItem(k) { k = String(k); return map.has(k) ? map.get(k) : null; },
        setItem(k, v) { map.set(String(k), String(v)); },
        removeItem(k) { map.delete(String(k)); },
        key(i) {
            const keys = Array.from(map.keys());
            return i >= 0 && i < keys.length ? keys[i] : null;
        },
        clear() { map.clear(); }
    };
}

let timerSeq = 0;

// 创建一台"设备"沙箱：独立 localStorage + fetch 桩转发到真实 handleApi
function createSandbox(name, sharedEnv) {
    const ls = createLocalStorageStub();
    const sandbox = {
        __name: name,
        localStorage: ls,
        navigator: { userAgent: 'wdtv-vm-test' },
        document: { hidden: false, addEventListener() {}, removeEventListener() {} },
        location: { protocol: 'https:', origin: SB_ORIGIN, host: 't.local', hostname: 't.local' },
        console,
        TextEncoder,
        TextDecoder,
        crypto: globalThis.crypto,
        btoa,
        atob,
        // 定时器桩：不真正调度，保证防抖/轮询不干扰测试时序
        setTimeout: () => ++timerSeq,
        clearTimeout: () => {},
        setInterval: () => ++timerSeq,
        clearInterval: () => {}
    };
    sandbox.window = { addEventListener() {}, removeEventListener() {} };

    // fetch 桩：把沙箱内 /api/... 请求转发给真实 handleApi（前端+后端真集成）。
    // __authOverride 用于把 Bearer 令牌换成垃圾串，验证 401 自动清会话链路。
    sandbox.fetch = async function (url, opts = {}) {
        let headers = opts.headers;
        const override = sandbox.__authOverride;
        if (override && headers && headers['Authorization']) {
            headers = Object.assign({}, headers, { Authorization: 'Bearer ' + override });
        }
        const req = new Request(SB_ORIGIN + url, {
            method: opts.method || 'GET',
            headers,
            body: opts.body
        });
        return handleApi(req, sharedEnv);
    };

    const code = fs.readFileSync(path.join(__dirname, 'js', 'cloud-sync.js'), 'utf8');
    vm.runInNewContext(code, sandbox, { filename: 'js/cloud-sync.js' });
    if (!sandbox.window || !sandbox.window.CloudSync) {
        throw new Error('沙箱 ' + name + ' 未挂载 window.CloudSync');
    }
    return sandbox;
}

function lsRead(sb, key) {
    const raw = sb.localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
}

// ========================= 主流程 =========================

async function main() {
    // ----------------------------------------------------------
    // 一、后端 API 直测
    // ----------------------------------------------------------
    section('后端 1：GET /api/config');
    {
        const r = await rawApi('GET', '/api/config');
        assert(r.status === 200 && r.data && r.data.allowRegister === true, 'config 返回 200 且 allowRegister=true');
    }

    section('后端 2：注册校验');
    const S1 = hexOf(32);
    const H1 = hexOf(64);
    const H2 = hexOf(64);
    {
        const ok = await rawApi('POST', '/api/auth/register', { body: { username: 'backenduser', salt: S1, clientHash: H1 } });
        assert(ok.status === 200 && ok.data && typeof ok.data.token === 'string' && ok.data.token.length > 0,
            '合法注册返回 200 且带 token');
        assert(ok.data.username === 'backenduser', '注册响应回带 username');

        const dup = await rawApi('POST', '/api/auth/register', { body: { username: 'backenduser', salt: S1, clientHash: H2 } });
        assert(dup.status === 409, '重名注册返回 409');

        // 用户名限制已移除：短用户名也应注册成功（仅要求非空，上限 64 字符）
        const shortName = await rawApi('POST', '/api/auth/register', { body: { username: 'ab', salt: S1, clientHash: H1 } });
        assert(shortName.status === 200, '短用户名（ab）注册返回 200');

        const emptyName = await rawApi('POST', '/api/auth/register', { body: { username: '', salt: S1, clientHash: H1 } });
        assert(emptyName.status === 400, '空用户名返回 400');

        const noHash = await rawApi('POST', '/api/auth/register', { body: { username: 'backenduser2', salt: S1 } });
        assert(noHash.status === 400, '不传密码派生串（clientHash 缺失）返回 400');

        const badHash = await rawApi('POST', '/api/auth/register', { body: { username: 'backenduser3', salt: S1, clientHash: 'xyz-not-hex' } });
        assert(badHash.status === 400, 'clientHash 非 64 位 hex 返回 400');
    }

    section('后端 3：假 salt 防用户名枚举');
    {
        const real = await rawApi('GET', '/api/auth/salt?username=backenduser');
        assert(real.status === 200 && real.data.salt === S1, '存在用户返回其注册 salt');

        const fake1 = await rawApi('GET', '/api/auth/salt?username=nosuchuser1');
        const fake2 = await rawApi('GET', '/api/auth/salt?username=nosuchuser1');
        assert(fake1.status === 200 && fake2.status === 200, '不存在用户两次查询均 200');
        assert(fake1.data && fake2.data && fake1.data.salt === fake2.data.salt, '不存在用户两次返回相同 salt');
        assert(fake1.data.salt !== S1, '假 salt 与真实用户 salt 不同');
        assert(/^[0-9a-f]{64}$/.test(fake1.data.salt), '假 salt 为 64 位 hex（HMAC 输出）');
    }

    section('后端 4：登录（错误统一 401 不可区分）');
    let loginToken;
    {
        const wrong = await rawApi('POST', '/api/auth/login', { body: { username: 'backenduser', clientHash: H2 } });
        assert(wrong.status === 401 && wrong.data.error === '用户名或密码错误', '存在用户错误密码返回 401');

        const ghost = await rawApi('POST', '/api/auth/login', { body: { username: 'ghostuser1', clientHash: H2 } });
        assert(ghost.status === 401, '不存在用户返回 401');
        assert(ghost.data.error === wrong.data.error, '不存在用户与错误密码的 error 文案完全一致（防枚举）');

        const right = await rawApi('POST', '/api/auth/login', { body: { username: 'backenduser', clientHash: H1 } });
        assert(right.status === 200 && typeof right.data.token === 'string', '正确凭据登录返回 200 且带 token');
        loginToken = right.data.token;
    }

    section('后端 5：JWT 签发与校验');
    {
        const payload = await verifyJwt(loginToken, SECRET);
        assert(payload && payload.un === 'backenduser' && typeof payload.uid === 'number', 'verifyJwt 解出 uid/un');

        const bad = loginToken.slice(0, -1) + (loginToken.endsWith('a') ? 'b' : 'a');
        assert(await verifyJwt(bad, SECRET) === null, '篡改签名的 token 校验为 null');

        const sec = Math.floor(Date.now() / 1000);
        const expired = await signJwt({ uid: 1, un: 'expireduser', iat: sec - 7200, exp: sec - 3600 }, SECRET);
        assert(await verifyJwt(expired, SECRET) === null, 'exp 过期的 token 校验为 null');
    }

    section('后端 6：登录限速（同 IP 同用户名连续失败）');
    {
        const ip = '203.0.113.77';
        const name = 'ratelimituser1';
        let all401 = true;
        for (let i = 0; i < 10; i++) {
            const r = await rawApi('POST', '/api/auth/login', { ip, body: { username: name, clientHash: H2 } });
            if (r.status !== 401) { all401 = false; break; }
        }
        assert(all401, '前 10 次错误密码均为 401');
        const eleventh = await rawApi('POST', '/api/auth/login', { ip, body: { username: name, clientHash: H2 } });
        assert(eleventh.status === 429, '第 11 次返回 429');
    }

    section('后端 7：同步乐观锁（CAS）');
    let syncToken;
    {
        const reg = await rawApi('POST', '/api/auth/register', { body: { username: 'syncuser1', salt: hexOf(32), clientHash: hexOf(64) } });
        syncToken = reg.data.token;

        const payload1 = { v: 1, items: { viewingHistory: { value: [{ title: '旧数据' }], updatedAt: 1 } } };
        const put1 = await rawApi('PUT', '/api/sync', { token: syncToken, body: { payload: payload1, baseRevision: 0 } });
        assert(put1.status === 200 && put1.data.ok === true && put1.data.revision === 1, '首次 PUT baseRevision=0 返回 revision=1');

        const put2 = await rawApi('PUT', '/api/sync', { token: syncToken, body: { payload: payload1, baseRevision: 0 } });
        assert(put2.status === 409 && put2.data.error === 'conflict', '旧版本重复 PUT 返回 409 conflict');
        assert(deepEqual(put2.data.payload, payload1) && put2.data.revision === 1, '409 响应携带云端最新 payload 与 revision');

        const payload2 = { v: 1, items: { viewingHistory: { value: [{ title: '新数据' }], updatedAt: 2 } } };
        const put3 = await rawApi('PUT', '/api/sync', { token: syncToken, body: { payload: payload2, baseRevision: 1 } });
        assert(put3.status === 200 && put3.data.revision === 2, 'PUT baseRevision=1 成功推进到 revision=2');

        const get1 = await rawApi('GET', '/api/sync', { token: syncToken });
        assert(deepEqual(get1.data.payload, payload2) && get1.data.revision === 2, 'GET /api/sync 回读与最后写入一致');

        const reg2 = await rawApi('POST', '/api/auth/register', { body: { username: 'syncuser2', salt: hexOf(32), clientHash: hexOf(64) } });
        const get2 = await rawApi('GET', '/api/sync', { token: reg2.data.token });
        assert(get2.status === 200 && get2.data.payload === null && get2.data.revision === 0, '无数据用户 GET 返回 {payload:null, revision:0}');
    }

    section('后端 8：同步载荷超限 413');
    {
        const big = { v: 1, items: { videoProgress_big: { value: { blob: 'a'.repeat(520000), timestamp: 1 }, updatedAt: 1 } } };
        const r = await rawApi('PUT', '/api/sync', { token: syncToken, body: { payload: big, baseRevision: 2 } });
        assert(r.status === 413, 'payload 超过 512000 字符返回 413');
    }

    section('后端 9：头像上传与 ETag 条件请求');
    {
        const dataUrl = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes-for-test').toString('base64');
        const post = await rawApi('POST', '/api/user/avatar', { token: syncToken, body: { dataUrl } });
        assert(post.status === 200 && post.data.ok === true && post.data.avatarVersion > 0, '合法 dataURL 上传返回 avatarVersion>0');
        const version = post.data.avatarVersion;

        const notMod = await rawApi('GET', '/api/user/avatar', { token: syncToken, ifNoneMatch: '"v' + version + '"' });
        assert(notMod.status === 304, 'If-None-Match 匹配当前版本返回 304');

        const plain = await rawApi('GET', '/api/user/avatar', { token: syncToken });
        assert(plain.status === 200 && plain.data.dataUrl === dataUrl && plain.data.avatarVersion === version,
            '无条件 GET 返回 200 与 dataUrl/avatarVersion');
        assert(plain.resp.headers.get('ETag') === '"v' + version + '"', '响应携带 ETag 头');

        const badType = await rawApi('POST', '/api/user/avatar', { token: syncToken, body: { dataUrl: 'data:text/plain;base64,SGVsbG8=' } });
        assert(badType.status === 400, 'text/plain dataURL 返回 400');

        const tooBig = await rawApi('POST', '/api/user/avatar', { token: syncToken, body: { dataUrl: 'data:image/png;base64,' + 'A'.repeat(300001) } });
        assert(tooBig.status === 400, '超过 300000 字符的 dataURL 返回 400');
    }

    section('后端 10：昵称更新与回读');
    {
        const set = await rawApi('PUT', '/api/user/profile', { token: syncToken, body: { nickname: '测试昵称' } });
        assert(set.status === 200 && set.data.ok === true && set.data.nickname === '测试昵称', '合法昵称 PUT 返回 ok');

        const tooLong = await rawApi('PUT', '/api/user/profile', { token: syncToken, body: { nickname: 'a'.repeat(21) } });
        assert(tooLong.status === 400, '21 字符昵称返回 400');

        const me = await rawApi('GET', '/api/user/me', { token: syncToken });
        assert(me.status === 200 && me.data.nickname === '测试昵称', 'GET me 回读昵称一致');
    }

    section('后端 11：无鉴权 / 坏 token 拒绝');
    {
        const noAuth = await rawApi('GET', '/api/sync');
        assert(noAuth.status === 401, '无 Authorization 访问 /api/sync 返回 401');

        const badToken = await rawApi('GET', '/api/sync', { token: 'not-a-real-jwt-token' });
        assert(badToken.status === 401, 'Bearer 垃圾串返回 401');
    }

    section('后端 12：服务端不存明文凭据');
    {
        const salt = hexOf(32);
        const clientHash = hexOf(64);
        await rawApi('POST', '/api/auth/register', { body: { username: 'hashuser1', salt, clientHash } });
        const row = await env.WDTV_DB.prepare('SELECT * FROM users WHERE username = ?').bind('hashuser1').first();
        assert(row && /^[0-9a-f]{64}$/.test(row.password_hash), 'password_hash 为 64 位 hex（服务端二次加盐哈希）');
        assert(row.password_hash !== clientHash && !row.password_hash.includes(clientHash), 'password_hash 不含 clientHash 原文');
        assert(row.salt === salt, 'salt 按注册原样保存');
    }

    section('后端 13：mock-d1 未识别 SQL 直接 reject');
    {
        let rejected = false;
        try {
            await env.WDTV_DB.prepare('DROP TABLE x').first();
        } catch (e) {
            rejected = true;
        }
        assert(rejected, 'prepare("DROP TABLE x").first() 被 reject');
    }

    // ----------------------------------------------------------
    // 二、前端 _merge 合并逻辑单元测试（vm 沙箱）
    // ----------------------------------------------------------
    section('前端 14-19：_merge 单元测试');
    const sbUnit = createSandbox('unit', env);
    const M = sbUnit.window.CloudSync._merge;
    {
        // 14 观影历史
        let r = M(
            { viewingHistory: { value: [{ showIdentifier: 's1', title: 'A', timestamp: 200, marker: 'local' }], updatedAt: 20 } },
            { viewingHistory: { value: [{ showIdentifier: 's1', title: 'A', timestamp: 100, marker: 'cloud' }], updatedAt: 10 } }
        );
        assert(r.viewingHistory.value.length === 1 && r.viewingHistory.value[0].marker === 'local', '14a 本地条目 timestamp 新 → 取本地');

        r = M(
            { viewingHistory: { value: [{ showIdentifier: 's1', timestamp: 100, marker: 'local' }], updatedAt: 10 } },
            { viewingHistory: { value: [{ showIdentifier: 's1', timestamp: 300, marker: 'cloud' }], updatedAt: 30 } }
        );
        assert(r.viewingHistory.value.length === 1 && r.viewingHistory.value[0].marker === 'cloud', '14b 云端条目 timestamp 新 → 取云端');

        r = M(
            { viewingHistory: { value: [{ showIdentifier: 's1', timestamp: 100 }], updatedAt: 1 } },
            { viewingHistory: { value: [{ showIdentifier: 's2', timestamp: 200 }], updatedAt: 1 } }
        );
        assert(r.viewingHistory.value.length === 2, '14c 不同标识条目并存');

        const local55 = [];
        for (let i = 0; i < 55; i++) local55.push({ showIdentifier: 'k' + i, timestamp: i });
        const cloud5 = [];
        for (let i = 0; i < 5; i++) cloud5.push({ showIdentifier: 'c' + i, timestamp: 1000 + i });
        r = M(
            { viewingHistory: { value: local55, updatedAt: 1 } },
            { viewingHistory: { value: cloud5, updatedAt: 1 } }
        );
        assert(r.viewingHistory.value.length === 50, '14d 合并后超过 50 条截断为 50');
        assert(r.viewingHistory.value[0].showIdentifier === 'c4' && r.viewingHistory.value[49].showIdentifier === 'k10',
            '14e 截断保留 timestamp 最新的 50 条');

        // 15 搜索历史
        r = M(
            { videoSearchHistory: { value: ['oldstr', { text: 'q1', timestamp: 100 }], updatedAt: 1 } },
            { videoSearchHistory: { value: [{ text: 'oldstr', timestamp: 50 }], updatedAt: 1 } }
        );
        assert(r.videoSearchHistory.value.length === 2 &&
            r.videoSearchHistory.value[0].text === 'q1' && r.videoSearchHistory.value[0].timestamp === 100 &&
            r.videoSearchHistory.value[1].text === 'oldstr' && r.videoSearchHistory.value[1].timestamp === 50,
            '15a 新旧格式混用归一化且倒序（纯字符串转为 {text,timestamp:0}）');

        r = M(
            { videoSearchHistory: { value: [{ text: 'q', timestamp: 100 }], updatedAt: 1 } },
            { videoSearchHistory: { value: [{ text: 'q', timestamp: 300 }], updatedAt: 1 } }
        );
        assert(r.videoSearchHistory.value.length === 1 && r.videoSearchHistory.value[0].timestamp === 300,
            '15b 相同 text 取 timestamp 大者');

        const terms = [];
        for (let i = 0; i < 25; i++) terms.push({ text: 't' + i, timestamp: i });
        r = M(
            { videoSearchHistory: { value: terms, updatedAt: 1 } },
            { videoSearchHistory: { value: [{ text: 'cx', timestamp: 1000 }], updatedAt: 1 } }
        );
        assert(r.videoSearchHistory.value.length === 20 && r.videoSearchHistory.value[0].text === 'cx',
            '15c 结果倒序并截断为 20 条');

        // 16 我的影院收藏
        r = M(
            { myCinemaFavorites: { value: [{ key: 'k1', lastEpisodeIndex: 1, lastPosition: 10 }], updatedAt: 1 } },
            { myCinemaFavorites: { value: [{ key: 'k2', lastEpisodeIndex: 2, lastPosition: 20 }], updatedAt: 1 } }
        );
        assert(r.myCinemaFavorites.value.length === 2, '16a 两侧独有收藏条目都保留');

        r = M(
            { myCinemaFavorites: { value: [{ key: 'k1', lastEpisodeIndex: 1, lastPosition: 50 }], updatedAt: 1 } },
            { myCinemaFavorites: { value: [{ key: 'k1', lastEpisodeIndex: 1, lastPosition: 80 }], updatedAt: 1 } }
        );
        assert(r.myCinemaFavorites.value.length === 1 && r.myCinemaFavorites.value[0].lastPosition === 80,
            '16b 相同 key 取 lastPosition 大者');

        r = M(
            { myCinemaFavorites: { value: [{ key: 'k1', lastEpisodeIndex: 2, lastPosition: 0 }], updatedAt: 1 } },
            { myCinemaFavorites: { value: [{ key: 'k1', lastEpisodeIndex: 1, lastPosition: 999999999 }], updatedAt: 1 } }
        );
        assert(r.myCinemaFavorites.value[0].lastEpisodeIndex === 2,
            '16c lastEpisodeIndex 权重（*1e9）高于 lastPosition');

        // 17 播放进度
        r = M(
            { videoProgress_p1: { value: { position: 100, timestamp: 100 }, updatedAt: 5 } },
            { videoProgress_p1: { value: { position: 200, timestamp: 300 }, updatedAt: 1 } }
        );
        assert(r.videoProgress_p1.value.position === 200, '17a 云端 value.timestamp 大 → 云端胜');

        r = M(
            { videoProgress_p1: { value: { position: 200, timestamp: 300 }, updatedAt: 1 } },
            { videoProgress_p1: { value: { position: 100, timestamp: 100 }, updatedAt: 5 } }
        );
        assert(r.videoProgress_p1.value.position === 200, '17b 本地 value.timestamp 大 → 本地胜');

        // 18 设置键
        r = M(
            { autoplayEnabled: { value: true, updatedAt: 100 } },
            { autoplayEnabled: { value: false, updatedAt: 200 } }
        );
        assert(r.autoplayEnabled.value === false, '18a 云端 updatedAt 严格更大 → 覆盖本地');

        r = M(
            { autoplayEnabled: { value: true, updatedAt: 200 } },
            { autoplayEnabled: { value: false, updatedAt: 200 } }
        );
        assert(r.autoplayEnabled.value === true, '18b updatedAt 相等 → 保留本地');

        // 19 null 删除标记
        r = M(
            { doubanEnabled: { value: 'keep', updatedAt: 100 } },
            { doubanEnabled: { value: null, updatedAt: 200 } }
        );
        assert(r.doubanEnabled.value === null, '19a 云端删除标记 updatedAt 更大 → 删除生效');

        r = M(
            { doubanEnabled: { value: null, updatedAt: 300 } },
            { doubanEnabled: { value: 'keep', updatedAt: 100 } }
        );
        assert(r.doubanEnabled.value === null, '19b 本地删除标记 updatedAt 更大 → 删除生效');

        r = M(
            { doubanEnabled: { value: 'local', updatedAt: 300 } },
            { doubanEnabled: { value: null, updatedAt: 100 } }
        );
        assert(r.doubanEnabled.value === 'local', '19c 本地值 updatedAt 更大 → 删除标记失效');
    }

    // ----------------------------------------------------------
    // 三、换设备恢复 e2e（双沙箱共享同一 env）
    // ----------------------------------------------------------
    section('e2e 20：设备 A 注册并上传本地数据');
    const T1 = Date.now();
    const dramaA = {
        title: '剧A', sourceName: 'src1', showIdentifier: 'src1_1', episodeIndex: 2,
        timestamp: T1, episodes: ['e1', 'e2', 'e3'], playbackPosition: 300, duration: 1500
    };
    const sbA = createSandbox('deviceA', env);
    {
        const reg = await sbA.window.CloudSync.register('usera', 'password123');
        assert(reg && reg.username === 'usera', '设备 A 注册成功并返回用户名');
        await waitSynced(sbA, '设备 A 注册后自动同步');

        // 写入五类同步数据（走被拦截包装的 setItem，与真实页面行为一致）
        sbA.localStorage.setItem('viewingHistory', JSON.stringify([dramaA]));
        sbA.localStorage.setItem('videoProgress_v1', JSON.stringify({ position: 300, duration: 1500, timestamp: T1 }));
        sbA.localStorage.setItem('myCinemaFavorites', JSON.stringify([{ key: 's_src1_1', lastEpisodeIndex: 2, lastPosition: 300 }]));
        sbA.localStorage.setItem('videoSearchHistory', JSON.stringify([{ text: 'searchText', timestamp: T1 }]));
        sbA.localStorage.setItem('selectedAPIs', JSON.stringify(['a', 'b']));

        await sbA.window.CloudSync.syncNow();
        await waitSynced(sbA, '设备 A 数据推送');
        const st = sbA.window.CloudSync.getStatus();
        assert(st.lastSyncAt > 0 && !st.lastError, '设备 A syncNow 完成：lastSyncAt>0 且 lastError 为空');
    }

    section('e2e 21：设备 B 换机登录自动恢复');
    const sbB = createSandbox('deviceB', env);
    {
        const login = await sbB.window.CloudSync.login('usera', 'password123');
        assert(login && login.username === 'usera', '设备 B 登录成功');
        await waitSynced(sbB, '设备 B 登录后自动同步');

        const vh = lsRead(sbB, 'viewingHistory');
        assert(Array.isArray(vh) && vh.some((x) => x.title === '剧A' && x.playbackPosition === 300 && x.duration === 1500),
            'B 恢复观影历史：剧A playbackPosition=300 duration=1500');
        const restored = vh.find((x) => x.title === '剧A');
        assert(restored && restored.showIdentifier === 'src1_1' && restored.episodeIndex === 2 &&
            deepEqual(restored.episodes, ['e1', 'e2', 'e3']), 'B 恢复的历史条目字段完整');

        const prog = lsRead(sbB, 'videoProgress_v1');
        assert(prog && prog.position === 300 && prog.duration === 1500, 'B 恢复播放进度 videoProgress_v1.position=300');

        const fav = lsRead(sbB, 'myCinemaFavorites');
        assert(deepEqual(fav, [{ key: 's_src1_1', lastEpisodeIndex: 2, lastPosition: 300 }]), 'B 恢复我的影院收藏一致');

        const sh = lsRead(sbB, 'videoSearchHistory');
        assert(deepEqual(sh, [{ text: 'searchText', timestamp: T1 }]), 'B 恢复搜索历史一致');

        const apis = lsRead(sbB, 'selectedAPIs');
        assert(deepEqual(apis, ['a', 'b']), 'B 恢复 selectedAPIs=[a,b]');
    }

    section('e2e 22：并发冲突 409 与自愈收敛');
    {
        // 记录 B 推送前的云端版本：A 与 B 此刻"基于同一 revision"构造各自的 payload
        const before = await rawApi('GET', '/api/sync', { token: sbA.localStorage.getItem('wdtv_auth_token') });
        const baseRev = before.data.revision;

        // 各自在本地新增一条不同剧集（B 走 SDK syncNow 正常推送，A 稍后手动 PUT 旧版本号）
        const vhA = lsRead(sbA, 'viewingHistory');
        vhA.push({ title: '冲突A', sourceName: 'srcX', showIdentifier: 'srcX_conflictA', timestamp: T1 + 2000, playbackPosition: 10 });
        sbA.localStorage.setItem('viewingHistory', JSON.stringify(vhA));

        const vhB = lsRead(sbB, 'viewingHistory');
        vhB.push({ title: '冲突B', sourceName: 'srcX', showIdentifier: 'srcX_conflictB', timestamp: T1 + 1000, playbackPosition: 20 });
        sbB.localStorage.setItem('viewingHistory', JSON.stringify(vhB));

        // B 先推（成功）
        await sbB.window.CloudSync.syncNow();
        await waitSynced(sbB, '设备 B 冲突场景推送');
        assert(!sbB.window.CloudSync.getStatus().lastError, '设备 B syncNow 正常完成');

        // A 后推（手动 PUT 携带旧 baseRevision → 409）
        const tokenA = sbA.localStorage.getItem('wdtv_auth_token');
        const manual = await rawApi('PUT', '/api/sync', {
            token: tokenA,
            body: { payload: { v: 1, items: sbA.window.CloudSync._collectItems() }, baseRevision: baseRev }
        });
        assert(manual.status === 409 && manual.data.error === 'conflict', 'A 后到 PUT 拿到 409');
        assert(manual.data.revision === baseRev + 1, '409 响应 revision 为云端最新版本');
        const cloudEntry = manual.data.payload && manual.data.payload.items && manual.data.payload.items.viewingHistory;
        const cloudVh = cloudEntry && Array.isArray(cloudEntry.value) ? cloudEntry.value : null;
        assert(Array.isArray(cloudVh) && cloudVh.some((x) => x.showIdentifier === 'srcX_conflictB'),
            '409 响应携带云端最新 payload（含 B 新增条目）');

        // A 重新 syncNow：拉云端合并后重推，实现收敛
        await sbA.window.CloudSync.syncNow();
        await waitSynced(sbA, '设备 A 冲突自愈');
        assert(!sbA.window.CloudSync.getStatus().lastError, '设备 A 冲突自愈推送成功');

        // B 再次同步收敛
        await sbB.window.CloudSync.syncNow();
        await waitSynced(sbB, '设备 B 收敛同步');

        const aVh = lsRead(sbA, 'viewingHistory');
        const bVh = lsRead(sbB, 'viewingHistory');
        assert(aVh.length === bVh.length, '收敛后 A、B 观影历史条数一致（' + aVh.length + ' 条）');
        const idsA = aVh.map((x) => x.showIdentifier);
        const idsB = bVh.map((x) => x.showIdentifier);
        assert(idsA.includes('srcX_conflictA') && idsA.includes('srcX_conflictB') && idsA.includes('src1_1'),
            'A 同时保有双方新增条目与原有条目');
        assert(idsB.includes('srcX_conflictA') && idsB.includes('srcX_conflictB') && idsB.includes('src1_1'),
            'B 同时保有双方新增条目与原有条目');
    }

    section('e2e 23：401 自动清会话');
    {
        // 把 B 设备发出的 Bearer 换成垃圾串（fetch 桩层替换），真实后端返回 401
        sbB.__authOverride = 'garbage-token-for-401-test';
        await sbB.window.CloudSync.syncNow();
        sbB.__authOverride = null;

        const st = sbB.window.CloudSync.getStatus();
        assert(st.loggedIn === false, '收到 401 后 getStatus().loggedIn === false');
        assert(sbB.localStorage.getItem('wdtv_auth_token') === null, '本地令牌已被清除');
        assert(sbB.localStorage.getItem('wdtv_auth_profile') === null, '本地资料已被清除');
    }

    section('e2e 24：云端新设置覆盖本地旧设置');
    {
        // 设备 A 更新 selectedAPIs 并推送
        sbA.localStorage.setItem('selectedAPIs', JSON.stringify(['c', 'd']));
        await sbA.window.CloudSync.syncNow();
        await waitSynced(sbA, '设备 A 设置更新推送');
        assert(!sbA.window.CloudSync.getStatus().lastError, '设备 A 新设置推送成功');

        // 设备 B 重新登录（本地仍持有旧 selectedAPIs），登录后自动同步应被云端覆盖
        const login = await sbB.window.CloudSync.login('usera', 'password123');
        assert(login && login.username === 'usera', '设备 B 重新登录成功');
        await waitSynced(sbB, '设备 B 重新登录自动同步');

        const bApis = lsRead(sbB, 'selectedAPIs');
        const aApis = lsRead(sbA, 'selectedAPIs');
        assert(deepEqual(bApis, aApis) && deepEqual(bApis, ['c', 'd']), 'B 的 selectedAPIs 与 A 一致（[c,d]）');
    }

    // ----------------------------------------------------------
    // 汇总
    // ----------------------------------------------------------
    const total = pass + fail;
    console.log('\n=========================================');
    console.log('PASS ' + pass + '/' + total);
    if (fail > 0) {
        console.log('失败清单:');
        failMessages.forEach((m) => console.log('  - ' + m));
        process.exitCode = 1;
    } else {
        console.log('全部断言通过');
    }
}

main().catch((e) => {
    console.error('测试执行异常中断: ' + (e && e.stack ? e.stack : e));
    console.log('PASS ' + pass + '/' + (pass + fail));
    process.exitCode = 1;
});
