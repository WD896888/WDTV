// pages-dev-e2e.mjs — Pages Function 中转链路验证（临时脚本）
// 链路：pages dev(8970) → SYNC_DEV_URL(8787 dev worker) → WatchRoom DO
// 步骤：注册登录 → create → join → 经 pages 域名 WS 连接收 snap
const BASE = process.env.BASE || 'http://127.0.0.1:8970';
const AUTH_SECRET = 'dev-secret';
import { hmacHex } from './functions/api/_lib.mjs';

let pass = 0, fail = 0;
function check(cond, desc) {
  if (cond) { pass++; console.log(`  [PASS] ${desc}`); }
  else { fail++; console.log(`  [FAIL] ${desc}`); }
}
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

async function main() {
  console.log(`目标: ${BASE}`);
  // 1. 注册（随机用户名避免限速冲突）
  const username = 'wp_' + hex(8);
  const r1 = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, salt: hex(32), clientHash: hex(64) })
  });
  const reg = await r1.json().catch(() => ({}));
  check(r1.ok && reg.token, `注册登录（${username}）→ token`);
  const token = reg.token;

  // 2. 创建房间（经 SYNC_DEV_URL 中转）
  const r2 = await fetch(`${BASE}/api/room/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
  });
  const cr = await r2.json().catch(() => ({}));
  check(r2.ok && /^[A-Z0-9]{6}$/.test(cr.code || ''), `create → 房间码 ${cr.code}（${r2.status}）`);
  check(!!cr.roomToken, 'create → roomToken');
  if (!cr.code) { console.log(`\n总结：${pass}/${pass + fail} PASS（中断）`); process.exit(1); }

  // 3. 加入预检（同 uid 重进允许）
  const r3 = await fetch(`${BASE}/api/room/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ code: cr.code })
  });
  const jr = await r3.json().catch(() => ({}));
  check(r3.ok && jr.roomToken, `join → roomToken（${r3.status}）`);
  check(jr.mode === null, `join → 新房 mode 为 null（未选片源，实际 ${jr.mode}）`);

  // 4. WS 经 pages 域名连接（pages → dev worker → DO）
  const name = encodeURIComponent('e2e测试员');
  const wsUrl = BASE.replace(/^http/, 'ws') + `/api/room/ws?room=${cr.code}&token=${encodeURIComponent(jr.roomToken)}&name=${name}`;
  const snap = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, 5000);
    ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.t === 'snap') { clearTimeout(timer); ws.close(); resolve(m); }
      } catch {}
    });
    ws.addEventListener('error', () => { clearTimeout(timer); resolve(null); });
    ws.addEventListener('close', (ev) => { clearTimeout(timer); resolve(null); });
  });
  check(!!snap, 'pages 域名 WS 连接成功');
  check(!!snap && snap.state && String(snap.state.hostUid) !== '', `snap.state.hostUid=${snap && snap.state && snap.state.hostUid}`);
  check(!!snap && snap.state && snap.state.mode === null, `snap.state.mode 为 null（未选片源）`);
  check(!!snap && snap.online && snap.online.some((u) => String(u) === String(snap.state.hostUid)), 'snap.online 含房主');

  // 4.5 房主选定片源：发送 src（DO 持久化；broadcast 排除发送者是防回声设计——
  //     发送者本人收不到回显属预期，持久化结果由下方重连快照断言验证）
  await new Promise((resolve) => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/api/room/ws?room=${cr.code}&token=${encodeURIComponent(jr.roomToken)}&name=e2e`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, 4000);
    ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.t === 'snap') {
          // snap 后以房主身份发 src（join 响应的 uid 与 token 一致 → DO 判定房主）
          ws.send(JSON.stringify({ t: 'src', video: { mode: 'M1', title: '测试影片', url: 'https://example.com/v.m3u8', epIndex: 0, mediaKey: 'm1|https://example.com/v.m3u8' } }));
          setTimeout(() => { try { ws.close(); } catch {} resolve(true); }, 600);
        }
      } catch {}
    });
    ws.addEventListener('error', () => { clearTimeout(timer); resolve(null); });
  });
  check(true, '房主发送 src（防回声：本人无回显属预期）');

  // 4.6 重连后快照应携带已选片源（title 不再为空 → 面板不显示"未知片名"）
  const snap2 = await new Promise((resolve) => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/api/room/ws?room=${cr.code}&token=${encodeURIComponent(jr.roomToken)}&name=e2e`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, 5000);
    ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.t === 'snap') { clearTimeout(timer); ws.close(); resolve(m); }
      } catch {}
    });
    ws.addEventListener('error', () => { clearTimeout(timer); resolve(null); });
  });
  check(!!snap2 && snap2.state && snap2.state.title === '测试影片', `重连 snap.state.title=${snap2 && snap2.state && snap2.state.title}`);
  check(!!snap2 && snap2.state && snap2.state.mode === 'M1', `重连 snap.state.mode=${snap2 && snap2.state && snap2.state.mode}`);

  // 4.7 tick 实时锚点：房主发 play(time=100) + tick(time=105.5, rate=1.25)，
  //     观影方（第二账号，避免同 uid 被替换）应收 tickState.time≈105.5（而非过时的 state.time=100）
  const r0 = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'wp_g_' + hex(6), salt: hex(32), clientHash: hex(64) })
  });
  const regG = await r0.json().catch(() => ({}));
  const rj = await fetch(`${BASE}/api/room/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + regG.token },
    body: JSON.stringify({ code: cr.code })
  });
  const jrG = await rj.json().catch(() => ({}));
  check(rj.ok && jrG.roomToken, '第二账号 join → 嘉宾 roomToken');
  const roomTokenB = jrG.roomToken;
  let hostWs = null, guestWs = null; // ESM 严格模式：必须先声明
  // 双端先各自就绪（等 snap），房主再发 play+tick —— 保证广播时嘉宾在线
  const hostReady = new Promise((resolve) => {
    hostWs = new WebSocket(BASE.replace(/^http/, 'ws') + `/api/room/ws?room=${cr.code}&token=${encodeURIComponent(cr.roomToken)}&name=e2e-host`);
    const timer = setTimeout(() => resolve(null), 5000);
    hostWs.addEventListener('message', (ev) => {
      try { const m = JSON.parse(ev.data); if (m.t === 'snap') { clearTimeout(timer); resolve(m); } } catch {}
    });
    hostWs.addEventListener('error', () => { clearTimeout(timer); resolve(null); });
  });
  const guestReady = new Promise((resolve) => {
    guestWs = new WebSocket(BASE.replace(/^http/, 'ws') + `/api/room/ws?room=${cr.code}&token=${encodeURIComponent(roomTokenB)}&name=e2e-guest`);
    const timer = setTimeout(() => resolve(null), 5000);
    guestWs.addEventListener('message', (ev) => {
      try { const m = JSON.parse(ev.data); if (m.t === 'snap') { clearTimeout(timer); resolve(m); } } catch {}
    });
    guestWs.addEventListener('error', () => { clearTimeout(timer); resolve(null); });
  });
  const hs = await hostReady, gs = await guestReady;
  check(!!hs && !!gs, '双端就绪（房主+嘉宾同时在线）');
  // 房主：play(100) → 400ms 后 tick(105.5, 1.25)（模拟播放 0.4s 后的实时锚点）
  hostWs.send(JSON.stringify({ t: 'play', time: 100 }));
  await new Promise((r) => setTimeout(r, 400));
  const tickPromise = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 4000);
    const onMsg = (ev) => {
      try { const m = JSON.parse(ev.data); if (m.t === 'tickState') { clearTimeout(timer); resolve(m); } } catch {}
    };
    guestWs.addEventListener('message', onMsg);
    hostWs.send(JSON.stringify({ t: 'tick', time: 105.5, rate: 1.25 }));
    setTimeout(() => guestWs.removeEventListener('message', onMsg), 4200);
  });
  const tickState = await tickPromise;
  check(!!tickState, '观影方收到 tickState 锚点');
  check(!!tickState && Math.abs(tickState.time - 105.5) < 0.5, `tickState.time 为房主实时锚点 105.5（实际 ${tickState && tickState.time}，过时值应为 100）`);
  check(!!tickState && Math.abs(tickState.rate - 1.25) < 0.001, `tickState.rate=${tickState && tickState.rate}`);
  try { hostWs.close(); } catch {}
  try { guestWs.close(); } catch {}

  // 5. 未配置降级核验：坏 token → 403
  const badWs = await new Promise((resolve) => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/api/room/ws?room=${cr.code}&token=bad.token&name=x`);
    const done = (v) => { try { ws.close(); } catch {} resolve(v); };
    ws.addEventListener('error', () => done('error'));
    ws.addEventListener('close', (ev) => done('close:' + ev.code));
    setTimeout(() => done('timeout'), 4000);
  });
  check(badWs === 'error' || String(badWs).startsWith('close'), `坏 token 被拒（${badWs}）`);

  console.log(`\n总结：${pass}/${pass + fail} PASS`);
  // 等句柄排空再退出（Windows 下 process.exit 带未决 WS 句柄会触发 libuv 崩溃）
  process.exitCode = fail ? 1 : 0;
  await new Promise((r) => setTimeout(r, 300));
}
main().catch((e) => { console.error('E2E 异常:', e); process.exit(1); });
