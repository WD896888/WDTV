// WDTV 画质探测队列自测（Node ESM，零依赖，不随部署）
// 运行：node test/probe-queue.test.mjs
// 说明：run 全部为可控假实现（手动 resolve/reject），计时器用注入的假时钟驱动，
//       不发任何真实网络请求、不依赖真实等待。
import '../js/probe-queue.js';

const A = globalThis.WDTVProbeQueue;
let pass = 0, fail = 0;
const fails = [];

function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

// ---------- 假时钟：完全可控，替代 setTimeout/clearTimeout ----------
function makeClock() {
  let now = 0, seq = 0;
  const tasks = new Map();
  function setTimeout(fn, ms) {
    const id = ++seq;
    tasks.set(id, { at: now + (Number(ms) || 0), fn: fn, seq: id });
    return id;
  }
  function clearTimeout(id) { tasks.delete(id); }
  async function advance(ms) {
    const target = now + (Number(ms) || 0);
    for (;;) {
      let pick = null;
      tasks.forEach((tk, id) => {
        if (tk.at <= target && (!pick || tk.at < pick.tk.at || (tk.at === pick.tk.at && id < pick.id))) {
          pick = { id: id, tk: tk };
        }
      });
      if (!pick) break;
      now = pick.tk.at;
      tasks.delete(pick.id);
      pick.tk.fn();
      await Promise.resolve();
    }
    now = target;
  }
  return { setTimeout, clearTimeout, advance, now: () => now };
}

// 让 async 链（Promise.race / then / finally）全部跑完
async function flush() {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
}
async function tick(clock, ms) {
  if (ms != null) await clock.advance(ms);
  await flush();
}

// ---------- 可控 run 假实现 ----------
function parts(item) {
  return {
    sc: item.source_code != null ? item.source_code : item.sourceKey,
    vid: item.vod_id != null ? item.vod_id : item.vodId
  };
}
function manualRun() {
  const calls = [], gates = [], rejects = [];
  const run = function (batch, onResult) {
    calls.push(batch);
    return new Promise(function (resolve, reject) {
      gates.push(function () {
        for (const it of batch) {
          const p = parts(it);
          onResult({ sourceKey: String(p.sc), vodId: String(p.vid), height: 1080 });
        }
        resolve();
      });
      rejects.push(function (reason) { reject(new Error(reason)); });
    });
  };
  return { run, calls, gates, rejects };
}
function makeItems(count, source) {
  const sc = source || 's1';
  return Array.from({ length: count }, (_, i) => ({ source_code: sc, vod_id: 'vod-' + i }));
}
function makeQueue(clock, overrides) {
  return A.createProbeQueue(Object.assign({
    run: async () => {},
    mergeWindowMs: 50,
    timeoutMs: 20000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  }, overrides || {}));
}

async function main() {
  console.log('\n[1] 导出与工厂形态');
  {
    t('WDTVProbeQueue.createProbeQueue 是函数', typeof A.createProbeQueue === 'function');
    const clock = makeClock();
    const q = makeQueue(clock);
    t('工厂返回 push / cancel', typeof q.push === 'function' && typeof q.cancel === 'function');
    const q2 = makeQueue(clock);
    t('多次调用得到独立队列', q !== q2);
    t('defaultKeyOf 用 source_code_vod_id', A.defaultKeyOf({ source_code: 's1', vod_id: 'vod-0' }) === 's1_vod-0');
  }

  console.log('\n[2] 同时在飞不超过 concurrency，单批不超过 batchSize');
  {
    const clock = makeClock();
    const m = manualRun();
    const q = makeQueue(clock, { run: m.run, concurrency: 2, batchSize: 8 });
    const done = q.push(makeItems(20));
    await tick(clock, 50);
    t('只放出 2 个请求（并发上限）', m.calls.length === 2, String(m.calls.length));
    t('第 1 批封顶 8 条', m.calls[0] && m.calls[0].length === 8);
    t('第 2 批封顶 8 条', m.calls[1] && m.calls[1].length === 8);
    m.gates[0](); m.gates[1]();
    await flush();
    await tick(clock, 50);
    t('剩余 4 条合成最后一批', m.calls.length === 3 && m.calls[2].length === 4, JSON.stringify(m.calls.map(c => c.length)));
    m.gates[2]();
    await flush();
    const out = await done;
    t('20 个键全部拿到结果', Object.keys(out).length === 20, String(Object.keys(out).length));
    t('每个结果 height=1080', Object.values(out).every(r => r.height === 1080));
  }

  console.log('\n[3] 同 key 重复入队只发一次，双方共享结果');
  {
    const clock = makeClock();
    const m = manualRun();
    const q = makeQueue(clock, { run: m.run });
    const item = makeItems(1)[0];
    const first = q.push([item]);
    const second = q.push([{ source_code: item.source_code, vod_id: item.vod_id }]);
    await tick(clock, 50);
    t('只发 1 次请求', m.calls.length === 1, String(m.calls.length));
    t('请求只带 1 条', m.calls[0] && m.calls[0].length === 1);
    m.gates[0]();
    await flush();
    const a = await first, b = await second;
    t('双方共享同一结果（键为内部键）', a['s1_vod-0'] && a['s1_vod-0'].height === 1080);
    t('第二个 push 结果一致', b['s1_vod-0'] && b['s1_vod-0'].height === 1080);
  }

  console.log('\n[4] 单批失败只影响该批，队列继续工作');
  {
    const clock = makeClock();
    const m = manualRun();
    const q = makeQueue(clock, { run: m.run, concurrency: 1, batchSize: 2 });
    const failing = q.push(makeItems(2));
    await tick(clock, 50);
    m.rejects[0]('boom');
    await flush();
    const f = await failing;
    t('失败批两条均为「探测失败」', f['s1_vod-0'].error === '探测失败' && f['s1_vod-1'].error === '探测失败', JSON.stringify(f));
    const next = q.push([{ source_code: 's2', vod_id: 'other' }]);
    await tick(clock, 50);
    t('队列未被前一批异常卡死（第 2 次 run）', m.calls.length === 2, String(m.calls.length));
    m.gates[1]();
    await flush();
    const n = await next;
    t('后续批次正常成功', n['s2_other'] && n['s2_other'].height === 1080);
  }

  console.log('\n[5] run 同步抛错也按失败收尾（不崩队列）');
  {
    const clock = makeClock();
    const run = function () { throw new Error('sync boom'); };
    const q = makeQueue(clock, { run });
    const done = q.push(makeItems(2));
    await tick(clock, 50);
    const out = await done;
    t('同步抛错 → 「探测失败」', out['s1_vod-0'].error === '探测失败' && out['s1_vod-1'].error === '探测失败', JSON.stringify(out));
  }

  console.log('\n[6] 服务端提前关流（未回结果）按「已取消」收尾');
  {
    const clock = makeClock();
    let calls = 0;
    const run = async function () { calls++; /* 直接 resolve，不回调任何 onResult */ };
    const q = makeQueue(clock, { run });
    const done = q.push(makeItems(2));
    await tick(clock, 50);
    const out = await done;
    t('run 被调用一次', calls === 1, String(calls));
    t('未回结果 → 「探测已取消」', out['s1_vod-0'].error === '探测已取消' && out['s1_vod-1'].error === '探测已取消', JSON.stringify(out));
  }

  console.log('\n[7] cancel 对尚未发出的键：立即返回取消结论且不发请求');
  {
    const clock = makeClock();
    const m = manualRun();
    const q = makeQueue(clock, { run: m.run });
    const done = q.push(makeItems(1));
    q.cancel(['s1_vod-0']);
    await tick(clock, 60);
    t('未发出键被 cancel 后不发请求', m.calls.length === 0, String(m.calls.length));
    const out = await done;
    t('立即返回「探测已取消」结论', out['s1_vod-0'] && out['s1_vod-0'].error === '探测已取消', JSON.stringify(out));
  }

  console.log('\n[8] cancel 容忍 qualityKey 的 ":" 形式键');
  {
    const clock = makeClock();
    const m = manualRun();
    const q = makeQueue(clock, { run: m.run });
    const done = q.push(makeItems(1));
    q.cancel(['s1:vod-0']);
    await tick(clock, 60);
    t(': 形式键同样不发请求', m.calls.length === 0);
    const out = await done;
    t(': 形式 cancel 返回取消结论', out['s1_vod-0'] && out['s1_vod-0'].error === '探测已取消');
  }

  console.log('\n[9] 看门狗：批次挂起时按「探测超时」收尾并释放并发槽位');
  {
    const clock = makeClock();
    let calls = 0;
    const run = function () { calls++; return new Promise(() => {}); }; // 永不 resolve
    const q = makeQueue(clock, { run, concurrency: 1, timeoutMs: 1000, mergeWindowMs: 50 });
    const first = q.push(makeItems(1));
    await tick(clock, 50);
    t('第 1 批已发出', calls === 1, String(calls));
    await tick(clock, 1000);
    const f = await first;
    t('按「探测超时」收尾', f['s1_vod-0'] && f['s1_vod-0'].error === '探测超时', JSON.stringify(f));
    const second = q.push([{ source_code: 's1', vod_id: 'vod-9' }]);
    await tick(clock, 50);
    t('槽位已释放：第 2 批能正常发出', calls === 2, String(calls));
    await tick(clock, 1000);
    const s = await second;
    t('第 2 批同样按超时收尾', s['s1_vod-9'] && s['s1_vod-9'].error === '探测超时', JSON.stringify(s));
  }

  console.log('\n[10] onStart 只在批次真正发出时回调一次，排队期间不回调');
  {
    const clock = makeClock();
    const m = manualRun();
    const q = makeQueue(clock, { run: m.run });
    let n = 0;
    const onStart = () => { n++; };
    const done = q.push(makeItems(3), onStart);
    t('入队瞬间不回调（不谎称探测中）', n === 0, String(n));
    await tick(clock, 50);
    t('真正发出后回调一次（3 键共用一个回调）', n === 1, String(n));
    m.gates[0]();
    await flush();
    const out = await done;
    t('结果正常返回', out['s1_vod-0'] && out['s1_vod-0'].height === 1080);
  }

  console.log('\n[11] 同一键被两处入队：两边 onStart 都通知，但只发一次请求');
  {
    const clock = makeClock();
    const m = manualRun();
    const q = makeQueue(clock, { run: m.run });
    let a = 0, b = 0;
    const pa = q.push(makeItems(1), () => { a++; });
    const pb = q.push(makeItems(1), () => { b++; });
    await tick(clock, 50);
    t('只发一次请求', m.calls.length === 1, String(m.calls.length));
    t('两边 onStart 各收到一次', a === 1 && b === 1, a + '/' + b);
    m.gates[0]();
    await flush();
    const ra = await pa, rb = await pb;
    t('双方都拿到结果', ra['s1_vod-0'].height === 1080 && rb['s1_vod-0'].height === 1080);
  }

  console.log('\n[12] 批次发出前被 cancel：onStart 不回调');
  {
    const clock = makeClock();
    const m = manualRun();
    const q = makeQueue(clock, { run: m.run });
    let n = 0;
    const done = q.push(makeItems(1), () => { n++; });
    q.cancel(['s1_vod-0']);
    await tick(clock, 60);
    t('发出前 cancel：onStart 不回调', n === 0, String(n));
    t('发出前 cancel：不发请求', m.calls.length === 0);
    const out = await done;
    t('返回取消结论', out['s1_vod-0'] && out['s1_vod-0'].error === '探测已取消');
  }

  console.log('\n[13] 空入队不产生请求');
  {
    const clock = makeClock();
    const m = manualRun();
    const q = makeQueue(clock, { run: m.run });
    const out = await q.push([]);
    t('空入队解析为 {}', Object.keys(out).length === 0 && JSON.stringify(out) === '{}', JSON.stringify(out));
    await tick(clock, 60);
    t('空入队不产生请求', m.calls.length === 0, String(m.calls.length));
  }

  console.log('\n[14] 结果形状与自定义 keyOf');
  {
    const clock = makeClock();
    const m = manualRun();
    const keyOf = (item) => 'K_' + item.vod_id;
    const q = makeQueue(clock, { run: m.run, keyOf });
    const done = q.push(makeItems(2));
    await tick(clock, 50);
    m.gates[0]();
    await flush();
    const out = await done;
    t('自定义 keyOf 生效（返回键以其结果为准）', !!out['K_vod-0'] && !!out['K_vod-1'], JSON.stringify(out));
    const r = out['K_vod-0'];
    t('结果形状含 sourceKey / vodId / height', r && r.sourceKey === 's1' && r.vodId === 'vod-0' && r.height === 1080, JSON.stringify(r));
    t('结果不含 item 引用（纯数据）', r && r.item === undefined);
  }

  console.log('\n[15] 合并窗口：同轮多次 push 合成一个请求');
  {
    const clock = makeClock();
    const m = manualRun();
    const q = makeQueue(clock, { run: m.run, mergeWindowMs: 50 });
    const p1 = q.push(makeItems(2));
    const p2 = q.push(makeItems(2, 's2'));
    await tick(clock, 10);
    t('合并窗口未到时一个请求都没发', m.calls.length === 0, String(m.calls.length));
    await tick(clock, 40);
    t('窗口到点后 4 条合成 1 个请求', m.calls.length === 1 && m.calls[0].length === 4, JSON.stringify(m.calls.map(c => c.length)));
    m.gates[0]();
    await flush();
    const [r1, r2] = await Promise.all([p1, p2]);
    // 旧断言只防 null/undefined，返回 {wrong:1} 也能通过；这里校验结果按入队键回传且互不串台。
    t('两次 push 都完成且各自按 key 拿回 height 结果',
        !!r1 && !!r2 &&
        r1['s1_vod-0'] && r1['s1_vod-0'].height === 1080 &&
        r1['s1_vod-1'] && r1['s1_vod-1'].height === 1080 &&
        r2['s2_vod-0'] && r2['s2_vod-0'].height === 1080 &&
        r2['s2_vod-1'] && r2['s2_vod-1'].height === 1080 &&
        r1['s2_vod-0'] === undefined && r2['s1_vod-0'] === undefined,
        JSON.stringify([r1, r2]));
  }

  console.log('\n[16] 自定义 keyOf 只读 item.key（app.js A6 接入形态）：结果仍能对回内部键');
  {
    const clock = makeClock();
    const calls = [], gates = [];
    const run = function (batch, onResult) {
      calls.push(batch);
      return new Promise(function (resolve) {
        gates.push(function () {
          for (const it of batch) {
            // 与 app.js runProbe 一致：结果只带 sourceKey/vodId，不带 item.key
            onResult({ sourceKey: it.sourceCode, vodId: it.vodId, height: 1080 });
          }
          resolve();
        });
      });
    };
    const keyOf = (it) => it.key; // 读不懂结果对象（结果里没有 key 字段）
    const q = makeQueue(clock, { run, keyOf });
    const done = q.push([{ key: 's1_vod-0', sourceCode: 's1', vodId: 'vod-0' }]);
    await tick(clock, 50);
    t('请求已发出', calls.length === 1, String(calls.length));
    gates[0]();
    await flush();
    const out = await done;
    t('结果按内部键 s1_vod-0 返回（键不是 undefined）', !!out['s1_vod-0'], JSON.stringify(out));
    t('结果带正确 height=1080', out['s1_vod-0'] && out['s1_vod-0'].height === 1080);
    t('未被误判为「探测已取消」', out['s1_vod-0'] && !out['s1_vod-0'].error);
    t('sourceKey/vodId 保持正确', out['s1_vod-0'] && out['s1_vod-0'].sourceKey === 's1' && out['s1_vod-0'].vodId === 'vod-0');
  }
}

main().then(() => {
  console.log('\n========================================');
  console.log(`结果：${pass} 通过，${fail} 失败`);
  if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
}).catch((e) => {
  console.error('测试执行异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
