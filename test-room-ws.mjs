// ============================================================
// test-room-ws.mjs — 「双人共同观影」WatchRoom Durable Object 协议自测
//
// 用途：对 sync-worker/src/index.js（Worker + WatchRoom DO）做 15 步黑盒协议验证，
//       覆盖创建/查重、入房快照、满员拒绝、房主控制、聊天限速、画笔增量合并、
//       undo、重连恢复、同 uid 替换、房主转移、tick 锚点等契约。
//
// 运行前提：cd sync-worker && npx wrangler dev --port 8787
// 运行方式：node test-room-ws.mjs   （Node 22+，依赖原生 WebSocket / fetch / btoa / crypto.subtle）
//
// 可选环境变量：
//   WS_BASE      默认 ws://127.0.0.1:8787
//   AUTH_SECRET  默认 dev-secret（须与 wrangler dev 的 AUTH_SECRET 一致）
//
// 退出码：全部断言通过 → 0；任一失败 → 1
// ============================================================

import { hmacHex } from './functions/api/_lib.mjs';

// ---------------- 配置 ----------------
const WS_BASE = process.env.WS_BASE || 'ws://127.0.0.1:8787';
const HTTP_BASE = WS_BASE.replace(/^ws/, 'http'); // ws:// → http://、wss:// → https://
const AUTH_SECRET = process.env.AUTH_SECRET || 'dev-secret';

// 房间码：每次运行随机生成（32 字符无易混字母表取 6 位）
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE = Array.from({ length: 6 }, () => ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)]).join('');

// roomToken 本地自签：base64(uid) + '.' + HMAC-SHA256(secret, 'room:code:uid')
// 与 sync-worker/src/index.js 的 verifyRoomToken 校验约定一致
async function makeToken(code, uid) {
  return btoa(String(uid)) + '.' + await hmacHex(AUTH_SECRET, `room:${code}:${uid}`);
}

// ---------------- 断言框架 ----------------
let passCount = 0;
let failCount = 0;

// 单条断言：打印 PASS/FAIL 并计数
function check(cond, desc) {
  if (cond) {
    passCount++;
    console.log(`  [PASS] ${desc}`);
  } else {
    failCount++;
    console.log(`  [FAIL] ${desc}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- WS 测试客户端 ----------------
class WSClient {
  constructor(code, uid, name) {
    this.code = code;
    this.uid = String(uid);
    this.name = name;
    this.ws = null;
    this.opened = false; // socket 已 open
    this.closed = false; // socket 已 close
    this.closeCode = null;
    this.messages = []; // 收到的全部 JSON 消息（按到达顺序）
    this._msgWaiters = []; // next() 等待者
    this._closeWaiters = []; // waitClose() 等待者
  }

  // 建立连接；open 或 close 任一发生即返回（供「满员被拒」等不会产生 snap 的场景使用）
  async connect() {
    const token = await makeToken(this.code, this.uid);
    const url = `${WS_BASE}/ws?room=${this.code}&uid=${this.uid}&name=${encodeURIComponent(this.name)}&token=${encodeURIComponent(token)}`;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.addEventListener('open', () => {
        this.opened = true;
        done();
      });
      ws.addEventListener('message', (ev) => {
        let m = null;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!m || typeof m !== 'object') return;
        this.messages.push(m);
        // 唤醒已命中的等待者
        this._msgWaiters = this._msgWaiters.filter((w) => {
          const hit = this.messages.slice(w.from).find(w.pred);
          if (hit) {
            clearTimeout(w.timer);
            w.resolve(hit);
            return false;
          }
          return true;
        });
      });
      ws.addEventListener('close', (ev) => {
        this.closed = true;
        this.closeCode = ev.code;
        for (const w of this._closeWaiters) w.resolve(ev.code);
        this._closeWaiters = [];
        // 连接已断，未决的消息等待者全部放行（resolve null）
        for (const w of this._msgWaiters) {
          clearTimeout(w.timer);
          w.resolve(null);
        }
        this._msgWaiters = [];
        done();
      });
      ws.addEventListener('error', () => done()); // error 之后通常伴随 close
    });
  }

  // 常规入房：等待连接建立 + 第一条 snap，返回 snap 消息
  async open() {
    await this.connect();
    if (!this.opened) throw new Error(`uid=${this.uid} 连接未建立（closeCode=${this.closeCode}）`);
    const snap = await this.next((m) => m.t === 'snap', 3000);
    if (!snap) throw new Error(`uid=${this.uid} 未在时限内收到 snap`);
    return snap;
  }

  // 等待第一条满足 pred 的消息：先扫 fromIndex 起的积压，未命中则等新消息；超时返回 null
  next(pred, timeoutMs = 2000, fromIndex = 0) {
    const hit = this.messages.slice(fromIndex).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const w = { pred, from: fromIndex, resolve, timer: 0 };
      w.timer = setTimeout(() => {
        this._msgWaiters = this._msgWaiters.filter((x) => x !== w);
        resolve(null);
      }, timeoutMs);
      this._msgWaiters.push(w);
    });
  }

  // 等待连接关闭并返回 close code（已关闭则立即返回；超时返回 null）
  waitClose(timeoutMs = 2000) {
    if (this.closed) return Promise.resolve(this.closeCode);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this._closeWaiters.push({
        resolve: (c) => {
          clearTimeout(timer);
          resolve(c);
        },
      });
    });
  }

  // 记录消息基线（配合 next(pred, timeout, fromIndex) 排除本步骤之前的旧消息）
  mark() {
    return this.messages.length;
  }

  send(obj) {
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {}
  }

  close(code = 1000) {
    try {
      this.ws.close(code);
    } catch {}
  }
}

// ---------------- 被测连接 ----------------
let ws1 = null; // 房主 uid=101
let ws2 = null; // 嘉宾 uid=202（第 12 步后指向重连实例）
let ws3 = null; // 第三人 uid=303（应被拒）
let ws1b = null; // 第 13 步替换 ws1 的同 uid 连接
let ws1c = null; // 第 14 步房主转移后的 101 重连
const clients = []; // 全部连接，结束时统一关闭

// ---------------- 步骤 1-15 ----------------

// 1. 创建/查重
async function step1() {
  const body = JSON.stringify({ code: CODE, uid: '101', name: '房主' });
  const r1 = await fetch(`${HTTP_BASE}/__create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': AUTH_SECRET },
    body,
  });
  const j1 = await r1.json().catch(() => ({}));
  check(j1.created === true, `首次创建返回 created:true（HTTP ${r1.status}）`);
  const r2 = await fetch(`${HTTP_BASE}/__create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': AUTH_SECRET },
    body,
  });
  const j2 = await r2.json().catch(() => ({}));
  check(j2.created === false, '同码重复创建返回 created:false');
}

// 2. 房主入房：校验 snap 快照
async function step2() {
  ws1 = new WSClient(CODE, '101', '房主');
  clients.push(ws1);
  const snap = await ws1.open();
  check(snap.t === 'snap', 'ws1 入房收到 snap');
  check(String(snap.state && snap.state.hostUid) === '101', 'snap.state.hostUid === "101"（String 比较）');
  check(Array.isArray(snap.online) && snap.online.map(String).includes('101'), 'snap.online 含 "101"');
  check(Array.isArray(snap.strokes) && snap.strokes.length === 0, 'snap.strokes 为空数组');
  check(Array.isArray(snap.chatTail) && snap.chatTail.length === 0, 'snap.chatTail 为空数组');
}

// 3. 嘉宾入房：本人收 snap，房主收 presence(join)
async function step3() {
  const base = ws1.mark();
  ws2 = new WSClient(CODE, '202', '访客');
  clients.push(ws2);
  const snap = await ws2.open();
  check(snap.t === 'snap', 'ws2 入房收到 snap');
  const p = await ws1.next((m) => m.t === 'presence' && m.join && m.join.uid === '202', 2000, base);
  check(!!p, 'ws1 收到 presence 且 join.uid === "202"');
}

// 4. 第三人被拒：房已满（2 人），close code 应为 1013
async function step4() {
  ws3 = new WSClient(CODE, '303', '路人');
  clients.push(ws3);
  await ws3.connect(); // 该连接不会收到 snap，open/close 任一发生即返回
  const c = await ws3.waitClose(2000);
  check(c === 1013, `第三人被拒，close code === 1013（实际 ${c}）`);
}

// 5. 房主控制广播：play → 对端收 ctl
async function step5() {
  const base = ws2.mark();
  ws1.send({ t: 'play', time: 120, rate: 1 });
  const ctl = await ws2.next((m) => m.t === 'ctl', 2000, base);
  check(!!ctl && ctl.kind === 'play', 'ws2 收到 ctl.kind === "play"');
  check(!!ctl && ctl.time === 120 && ctl.playing === true, `ctl.time === 120 且 playing === true（实际 time=${ctl && ctl.time}）`);
  check(!!ctl && typeof ctl.epoch === 'number' && ctl.epoch >= 1, `ctl.epoch >= 1（实际 ${ctl && ctl.epoch}）`);
}

// 6. 非房主控制丢弃：ws2 的 play 不应产生任何广播
async function step6() {
  const base = ws1.mark();
  ws2.send({ t: 'play', time: 999 });
  await sleep(500);
  const leaked = ws1.messages.slice(base).some((m) => m.t === 'ctl');
  check(!leaked, '500ms 内 ws1 未收到任何 ctl（非房主指令被丢弃）');
}

// 7. 聊天：转发对端、不回显发送者
async function step7() {
  const base1 = ws1.mark();
  const base2 = ws2.mark();
  ws2.send({ t: 'chat', text: '你好' });
  const chat = await ws1.next((m) => m.t === 'chat', 2000, base1);
  check(!!chat && chat.name === '访客' && chat.text === '你好', 'ws1 收到 chat{name:"访客", text:"你好"}');
  await sleep(400);
  const echo = ws2.messages.slice(base2).some((m) => m.t === 'chat');
  check(!echo, '400ms 内 ws2 未收到自己的聊天回显');
}

// 8. 聊天限速：5s 窗口内第 11 条起静默丢弃
async function step8() {
  const base = ws2.mark();
  for (let i = 1; i <= 12; i++) ws1.send({ t: 'chat', text: `限速测试 #${i}` });
  await sleep(800); // 等全部消息处理完毕再统计
  const n = ws2.messages.slice(base).filter((m) => m.t === 'chat').length;
  check(n === 10, `限速生效：ws2 恰好收到 10 条（实际 ${n}）`);
}

// 9. 画布笔迹：起笔 → 同 id 增量合并 → 转发
// 契约说明：DO 的增量合并只作用于「同 uid 同 id 且未完结(final=false)」的笔；
// 若首笔直接 final:true，同 id 增量会被当成新的一笔（无法验证合并路径），
// 因此起笔用 final:false、收笔增量带 final:true，与真实客户端绘制流程一致。
async function step9() {
  const base = ws2.mark();
  ws1.send({ t: 'stroke', op: { id: 's1', color: '#ff0000', w: 3, pts: [[0.1, 0.1], [0.2, 0.2]], final: false } });
  const st1 = await ws2.next((m) => m.t === 'stroke', 2000, base);
  check(!!st1 && st1.by === '101', 'ws2 收到第一笔 stroke，by === "101"');
  check(!!st1 && st1.op && Array.isArray(st1.op.pts) && st1.op.pts.length === 2, '第一笔 op.pts 长度为 2');
  ws1.send({ t: 'stroke', op: { id: 's1', pts: [[0.3, 0.3]], final: true } });
  const st2 = await ws2.next((m) => m.t === 'stroke' && m.op && Array.isArray(m.op.pts) && m.op.pts.length === 1, 2000, base);
  check(!!st2 && st2.op.pts[0][0] === 0.3 && st2.op.pts[0][1] === 0.3, 'ws2 收到第二条增量 stroke（pts=[[0.3,0.3]]）');
  check(!!st2 && st2.op.final === true, '收笔增量后 op.final === true');
}

// 10. pos 转发：从端位置上报 → 对端收 peerpos
async function step10() {
  const base = ws1.mark();
  ws2.send({ t: 'pos', time: 5, buf: 3 });
  const pp = await ws1.next((m) => m.t === 'peerpos', 2000, base);
  check(!!pp && String(pp.uid) === '202' && pp.time === 5 && pp.buf === 3, 'ws1 收到 peerpos{uid:"202", time:5, buf:3}');
}

// 11. undo：撤销自己（ws1）的最后一笔 s2
async function step11() {
  const base = ws2.mark();
  ws1.send({ t: 'stroke', op: { id: 's2', color: '#00ff00', w: 2, pts: [[0, 0]], final: true } });
  const st = await ws2.next((m) => m.t === 'stroke' && m.op && m.op.id === 's2', 2000, base);
  check(!!st, 'ws1 先补画一笔 s2（ws2 已收到 stroke 广播）');
  ws1.send({ t: 'undo' });
  const ud = await ws2.next((m) => m.t === 'undo', 2000, base);
  check(!!ud && String(ud.by) === '101' && ud.strokeId === 's2', 'ws2 收到 undo{by:"101", strokeId:"s2"}');
}

// 12. 重连快照恢复：同 uid 重入，聊天与画布状态完整
async function step12() {
  ws2.close();
  await sleep(150); // 留时间让服务端处理离场广播
  const ws2b = new WSClient(CODE, '202', '访客');
  clients.push(ws2b);
  const snap = await ws2b.open();
  check(snap.t === 'snap', '同 uid 重连收到 snap');
  check(Array.isArray(snap.chatTail) && snap.chatTail.some((c) => c && c.text === '你好'), 'snap.chatTail 含「你好」');
  check(
    Array.isArray(snap.strokes) && snap.strokes.length === 1,
    `snap.strokes 恰好 1 笔（实际 ${Array.isArray(snap.strokes) ? snap.strokes.length : '非数组'}）`
  );
  const s1 = Array.isArray(snap.strokes) ? snap.strokes[0] : null;
  check(
    !!s1 && s1.id === 's1' && Array.isArray(s1.pts) && s1.pts.some((p) => p[0] === 0.3 && p[1] === 0.3),
    '该笔 id 为 s1 且 pts 已合并含 [0.3,0.3]'
  );
  ws2 = ws2b; // 后续步骤使用重连后的连接
}

// 13. 同 uid 替换：新 101 入房挤掉旧 ws1（close 4000），在线数回到 2
async function step13() {
  const base = ws2.mark();
  ws1b = new WSClient(CODE, '101', '房主B');
  clients.push(ws1b);
  const snap = await ws1b.open(); // 服务端会先以 4000 关闭旧 ws1 再接受新连接
  check(snap.t === 'snap', 'ws1b（同 uid 101）入房收到 snap');
  const c = await ws1.waitClose(2000);
  check(c === 4000, `旧 ws1 被替换关闭，close code === 4000（实际 ${c}）`);
  const p = await ws2.next((m) => m.t === 'presence' && m.count === 2 && m.join && m.join.uid === '101', 2000, base);
  check(!!p, 'ws2 收到 presence.count === 2（join uid 101）');
}

// 14. 房主转移：ws1b 离开 → ws2 接任；随后 ws2 的控制指令应生效
async function step14() {
  const base = ws2.mark();
  ws1b.close();
  const p = await ws2.next(
    (m) => m.t === 'presence' && m.leave && m.leave.uid === '101' && String(m.hostUid) === '202',
    2000,
    base
  );
  check(!!p, `ws1b 离开后 ws2 收到 presence 且 hostUid === "202"（实际 ${p ? p.hostUid : '超时'}）`);
  ws2.send({ t: 'play', time: 60 }); // 新房主发出的控制指令
  await sleep(100);
  ws1c = new WSClient(CODE, '101', '房主C'); // 同时在线保持 ≤2（ws2 + ws1c）
  clients.push(ws1c);
  const snap = await ws1c.open();
  check(String(snap.state && snap.state.hostUid) === '202', '新连接 snap.state.hostUid === "202"');
  check(snap.state && snap.state.playing === true, 'snap.state.playing === true（ws2 的 play 已生效）');
}

// 15. tick 锚点：房主广播 tickState，不回显发送者
async function step15() {
  const baseC = ws1c.mark();
  const base2 = ws2.mark();
  // tick 锚点 = 房主实时上报的 time/rate（DO 不追踪播放进度，state.time 仅为最近控制动作）
  ws2.send({ t: 'tick', time: 55.5, rate: 1.25 });
  const ts = await ws1c.next((m) => m.t === 'tickState', 2000, baseC);
  check(!!ts, '其它连接（ws1c）收到 tickState');
  check(!!ts && Math.abs(ts.time - 55.5) < 0.001, `tickState 锚点为房主实时 time=55.5（实际 ${ts && ts.time}）`);
  check(!!ts && Math.abs(ts.rate - 1.25) < 0.001, `tickState.rate 为房主实时倍率 1.25（实际 ${ts && ts.rate}）`);
  check(!!ts && [ts.time, ts.playing, ts.epoch, ts.at].every((v) => v !== undefined), 'tickState 含 time/playing/epoch/at 字段');
  await sleep(300);
  const echo = ws2.messages.slice(base2).some((m) => m.t === 'tickState');
  check(!echo, '发送者 ws2 未收到 tickState 回显');
}

// 16. 控制权共享：房主开启后嘉宾可发播放控制与 src；关闭后恢复房主权威
async function step16() {
  // 当前 ws2 是房主（步骤 14 转移）——先把共享关掉（确认默认拒绝），再开启验证，最后关闭复原
  ws2.send({ t: 'share', on: true });
  const sh = await ws1c.next((m) => m.t === 'shared' && m.on === true, 2000);
  check(!!sh, '房主开启共享 → 广播 shared{on:true}');
  // 嘉宾（ws2 即房主……本轮用 ws1c 作为"另一成员"发送）发送播放控制应被接受
  ws1c.send({ t: 'play', time: 70 });
  const ctl = await ws2.next((m) => m.t === 'ctl' && m.kind === 'play', 2000);
  check(!!ctl && ctl.time === 70, `共享后成员发送 play 被接受并广播（time=${ctl && ctl.time}）`);
  // 成员发送 src 也应被接受
  ws1c.send({ t: 'src', video: { mode: 'M1', title: '共享选片', url: 'https://example.com/s.m3u8' } });
  const srcB = await ws2.next((m) => m.t === 'src', 2000);
  check(!!srcB && srcB.video && srcB.video.title === '共享选片', '共享后成员发送 src 被接受并广播');
  // 房主关闭共享 → 成员控制被恢复拒绝
  ws2.send({ t: 'share', on: false });
  await ws1c.next((m) => m.t === 'shared' && m.on === false, 2000);
  const base2 = ws2.mark();
  ws1c.send({ t: 'play', time: 999 });
  await sleep(500);
  const leaked = ws2.messages.slice(base2).some((m) => m.t === 'ctl');
  check(!leaked, '关闭共享后成员发送 play 被服务端丢弃');
}

// ---------------- 主流程 ----------------
const steps = [
  ['1. 创建/查重', step1],
  ['2. 房主入房（snap 快照）', step2],
  ['3. 嘉宾入房（presence 广播）', step3],
  ['4. 第三人被拒（1013）', step4],
  ['5. 房主控制广播（ctl）', step5],
  ['6. 非房主控制丢弃', step6],
  ['7. 聊天收发（不回显发送者）', step7],
  ['8. 聊天限速（10 条/5s）', step8],
  ['9. 画布笔迹（增量合并转发）', step9],
  ['10. pos 转发（peerpos）', step10],
  ['11. undo 撤销', step11],
  ['12. 重连快照恢复', step12],
  ['13. 同 uid 替换（close 4000）', step13],
  ['14. 房主转移', step14],
  ['15. tick 锚点', step15],
  ['16. 控制权共享', step16],
];

async function main() {
  console.log(`房间码: ${CODE}    目标: ${HTTP_BASE}    AUTH_SECRET: ${AUTH_SECRET ? '已设置' : '未设置'}`);
  for (const [name, fn] of steps) {
    console.log(`\n── 步骤 ${name} ──`);
    try {
      await fn();
    } catch (e) {
      check(false, `步骤执行异常：${e && e.message}`);
    }
    await sleep(80); // 步骤间隔，避免限速/时序抖动
  }
  // 收尾：关闭全部连接
  for (const c of clients) {
    try {
      c.close();
    } catch {}
  }
  console.log(`\n===== 总结：${passCount}/${passCount + failCount} PASS =====`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('测试框架异常：', e);
  process.exit(1);
});
