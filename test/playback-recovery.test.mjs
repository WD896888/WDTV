// WDTV 播放错误恢复决策层自测（Node ESM，零依赖，不随部署）
// 运行：node test/playback-recovery.test.mjs
import { readFileSync } from 'node:fs';
import '../js/playback-recovery.js';

const R = globalThis.WDTVPlaybackRecovery;
const src = readFileSync(new URL('../js/playback-recovery.js', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const fails = [];

function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

function zeroState() {
  return { networkRetries: 0, mediaRecoveries: 0, lastActionAt: 0 };
}
const NOW0 = () => 0;

function noThrow(fn) {
  try { fn(); return true; } catch (e) { return false; }
}

console.log('\n[1] 导出 API 与常量');
{
  t('R 已挂载到全局', !!R && typeof R === 'object');
  t('HLS_ERROR_NETWORK === networkError', R.HLS_ERROR_NETWORK === 'networkError');
  t('HLS_ERROR_MEDIA === mediaError', R.HLS_ERROR_MEDIA === 'mediaError');
  t('HARD_FAIL_DETAILS 三个键', R.HARD_FAIL_DETAILS.manifestParsingError === 1 &&
    R.HARD_FAIL_DETAILS.manifestIncompatibleCodecsError === 1 &&
    R.HARD_FAIL_DETAILS.levelEmptyError === 1, JSON.stringify(R.HARD_FAIL_DETAILS));
  const d = R.DEFAULT_POLICY;
  t('DEFAULT_POLICY 字段值', d.maxNetworkRetries === 3 && d.maxMediaRecoveries === 2 &&
    d.baseDelayMs === 800 && d.maxDelayMs === 8000 && d.healthyQuietMs === 3000, JSON.stringify(d));
  t('onFatal 是函数', typeof R.onFatal === 'function');
  t('onHealthy 是函数', typeof R.onHealthy === 'function');
  t('describeHlsError 是函数', typeof R.describeHlsError === 'function');

  // 回归：导出的决策常量必须冻结，外部改写不得污染 onFatal / normalizePolicy 的结果
  t('DEFAULT_POLICY 已冻结（Object.isFrozen）', Object.isFrozen(R.DEFAULT_POLICY));
  t('HARD_FAIL_DETAILS 已冻结（Object.isFrozen）', Object.isFrozen(R.HARD_FAIL_DETAILS));
  let pThrew = false;
  try { R.DEFAULT_POLICY.maxNetworkRetries = 99; } catch (e) { pThrew = true; }
  t('外部改写 DEFAULT_POLICY 被拒绝（严格模式抛错或严格无效）',
    pThrew || R.DEFAULT_POLICY.maxNetworkRetries === 3);
  t('改写后 maxNetworkRetries 仍为 3', R.DEFAULT_POLICY.maxNetworkRetries === 3);
  let hThrew = false;
  try { R.HARD_FAIL_DETAILS.fragLoadError = 1; } catch (e) { hThrew = true; }
  t('外部无法向 HARD_FAIL_DETAILS 注入新的硬失败键',
    hThrew || R.HARD_FAIL_DETAILS.fragLoadError === undefined);
  t('冻结后 onFatal 硬失败判定行为不变',
    R.onFatal({ type: 'networkError', details: 'manifestParsingError', state: zeroState(), now: NOW0 }).decision.action === 'switch-source');
  t('冻结后 onFatal 正常网络重试行为不变',
    R.onFatal({ type: 'networkError', details: 'fragLoadError', state: zeroState(), now: NOW0 }).decision.action === 'retry');
}

console.log('\n[2] 格式硬失败 → switch-source，计数不变');
{
  for (const details of ['manifestParsingError', 'manifestIncompatibleCodecsError', 'levelEmptyError']) {
    const s = zeroState();
    const r = R.onFatal({ type: 'networkError', details, state: s, now: NOW0 });
    t('硬失败 ' + details + ' → switch-source', r.decision.action === 'switch-source');
    t('硬失败 ' + details + ' 原因含中文', /格式无法解析|解析/.test(r.decision.reason), r.decision.reason);
    t('硬失败 ' + details + ' 计数不变', r.state.networkRetries === 0 && r.state.mediaRecoveries === 0, JSON.stringify(r.state));
    t('硬失败 ' + details + ' 返回新 state 对象', r.state !== s);
  }
  const r = R.onFatal({ type: 'mediaError', details: 'manifestParsingError', state: zeroState(), now: NOW0 });
  t('硬失败判定优先于 type', r.decision.action === 'switch-source' && r.state.mediaRecoveries === 0);
}

console.log('\n[3] mediaError 恢复链（用返回 state 串联）');
{
  let s = zeroState();
  const r1 = R.onFatal({ type: 'mediaError', details: 'bufferAppendError', state: s, now: NOW0 });
  t('media 第1次 recover-media', r1.decision.action === 'recover-media');
  t('media 第1次 swapAudio:false', r1.decision.swapAudio === false);
  t('media 第1次 attempt:1', r1.decision.attempt === 1);
  t('media 第1次 state.mediaRecoveries=1', r1.state.mediaRecoveries === 1);
  t('media 第1次 reason 为中文', typeof r1.decision.reason === 'string' && r1.decision.reason.length > 0);

  const r2 = R.onFatal({ type: 'mediaError', details: 'bufferAppendError', state: r1.state, now: NOW0 });
  t('media 第2次 recover-media', r2.decision.action === 'recover-media');
  t('media 第2次 swapAudio:true', r2.decision.swapAudio === true);
  t('media 第2次 attempt:2', r2.decision.attempt === 2);
  t('media 第2次 state.mediaRecoveries=2', r2.state.mediaRecoveries === 2);

  const r3 = R.onFatal({ type: 'mediaError', details: 'bufferAppendError', state: r2.state, now: NOW0 });
  t('media 第3次 switch-source', r3.decision.action === 'switch-source');
  t('media 第3次 原因含多次恢复无效', /多次恢复无效|解码/.test(r3.decision.reason), r3.decision.reason);
}

console.log('\n[4] networkError 指数退避与上限换源');
{
  let s = zeroState();
  const delays = [];
  const attempts = [];
  let fourth;
  for (let i = 0; i < 4; i++) {
    const r = R.onFatal({ type: 'networkError', details: 'fragLoadError', state: s, now: NOW0 });
    s = r.state;
    if (r.decision.action === 'retry') {
      delays.push(r.decision.delayMs);
      attempts.push(r.decision.attempt);
    } else {
      fourth = r.decision;
    }
  }
  t('退避序列严格 [800,1600,3200]', JSON.stringify(delays) === '[800,1600,3200]', JSON.stringify(delays));
  t('attempt 序列 [1,2,3]', JSON.stringify(attempts) === '[1,2,3]', JSON.stringify(attempts));
  t('第4次 switch-source', !!fourth && fourth.action === 'switch-source');
  t('换源原因含「3 次」', !!fourth && /3 次/.test(fourth.reason), fourth && fourth.reason);

  const bigPolicy = Object.assign({}, R.DEFAULT_POLICY, { maxNetworkRetries: 10 });
  let s2 = zeroState();
  const delays2 = [];
  for (let i = 0; i < 6; i++) {
    const r = R.onFatal({ type: 'networkError', details: 'fragLoadError', state: s2, now: NOW0, policy: bigPolicy });
    s2 = r.state;
    if (r.decision.action === 'retry') delays2.push(r.decision.delayMs);
  }
  t('封顶：所有 delayMs ≤ 8000', delays2.every((x) => x <= 8000), JSON.stringify(delays2));
  t('封顶：出现 8000', delays2.indexOf(8000) !== -1, JSON.stringify(delays2));
}

console.log('\n[5] onHealthy 静默窗（可注入 now 推进）');
{
  let clock = 0;
  const now = () => clock;
  const s = { networkRetries: 2, mediaRecoveries: 1, lastActionAt: 0 };
  clock = 2999;
  const h1 = R.onHealthy({ state: s, now });
  t('2999ms 不清零（计数保留）', h1.networkRetries === 2 && h1.mediaRecoveries === 1, JSON.stringify(h1));
  t('2999ms 返回新对象', h1 !== s);
  clock = 3000;
  const h2 = R.onHealthy({ state: s, now });
  t('3000ms 计数归零', h2.networkRetries === 0 && h2.mediaRecoveries === 0, JSON.stringify(h2));
  t('3000ms 返回新对象', h2 !== s);
  t('归零不影响原 state', s.networkRetries === 2 && s.mediaRecoveries === 1);

  const qPolicy = Object.assign({}, R.DEFAULT_POLICY, { healthyQuietMs: 100 });
  clock = 99;
  const q1 = R.onHealthy({ state: s, now, policy: qPolicy });
  t('注入 quietMs=100：99ms 不清零', q1.networkRetries === 2);
  clock = 100;
  const q2 = R.onHealthy({ state: s, now, policy: qPolicy });
  t('注入 quietMs=100：100ms 归零', q2.networkRetries === 0);
}

console.log('\n[6] 状态外置与源码约束');
{
  const a = zeroState();
  const b = zeroState();
  const ra = R.onFatal({ type: 'networkError', details: 'fragLoadError', state: a, now: NOW0 });
  const rb = R.onFatal({ type: 'networkError', details: 'fragLoadError', state: b, now: NOW0 });
  t('两次独立 state 互不干扰', ra.decision.attempt === 1 && rb.decision.attempt === 1);
  t('独立 state 返回不同对象', ra.state !== rb.state);

  const frozen = Object.freeze({ networkRetries: 1, mediaRecoveries: 0, lastActionAt: 0 });
  let fr, threw = false;
  try {
    fr = R.onFatal({ type: 'networkError', details: 'fragLoadError', state: frozen, now: NOW0 });
  } catch (e) { threw = true; }
  t('冻结 state 调用不抛错', !threw);
  t('onFatal 不修改传入 state', frozen.networkRetries === 1 && fr && fr.state.networkRetries === 2, JSON.stringify(frozen));
  t('onFatal 返回 state 非入参引用', fr && fr.state !== frozen);

  const frozen2 = Object.freeze(zeroState());
  t('硬失败分支不改冻结入参', noThrow(() => R.onFatal({ type: 'other', details: 'levelEmptyError', state: frozen2, now: NOW0 })));
  t('onHealthy 不改冻结入参', noThrow(() => R.onHealthy({ state: frozen2, now: NOW0 })));

  t('源码无 setTimeout', !src.includes('setTimeout'));
  t('源码无 class 关键字', !/\bclass\s/.test(src));
  t('源码无 dispose', !src.includes('dispose'));
  t('源码无模块级计数变量', !/^\s*(var|let|const)\s+\w+\s*=\s*0\s*;/m.test(src));
}

console.log('\n[7] 未知类型兜底与非致命忽略');
{
  const u = R.onFatal({ type: 'someWeirdError', details: 'whatever', state: zeroState(), now: NOW0 });
  t('未知 type → switch-source', u.decision.action === 'switch-source');
  t('未知 type 原因含中文', typeof u.decision.reason === 'string' && /[\u4e00-\u9fa5]/.test(u.decision.reason), u.decision.reason);
  t('未知 type 计数不变', u.state.networkRetries === 0 && u.state.mediaRecoveries === 0);

  const f = R.onFatal({ type: 'networkError', details: 'fragLoadError', fatal: false, state: zeroState(), now: NOW0 });
  t('fatal:false → ignore', f.decision.action === 'ignore');
  t('fatal:false 计数不变', f.state.networkRetries === 0 && f.state.mediaRecoveries === 0);

  const ig = R.onFatal({ type: 'mediaError', details: 'bufferAppendError', ignore: true, state: zeroState(), now: NOW0 });
  t('ignore:true → ignore', ig.decision.action === 'ignore');
  t('ignore:true 计数不变', ig.state.mediaRecoveries === 0);

  const def = R.onFatal({ type: 'networkError', details: 'fragLoadError', state: zeroState(), now: NOW0 });
  t('fatal 缺省按致命处理', def.decision.action === 'retry' && def.decision.attempt === 1);
}

console.log('\n[8] describeHlsError 中文映射');
{
  t('manifestLoadTimeOut → 超时', /超时/.test(R.describeHlsError('networkError', 'manifestLoadTimeOut')), R.describeHlsError('networkError', 'manifestLoadTimeOut'));
  t('manifestParsingError → 解析', /解析/.test(R.describeHlsError('networkError', 'manifestParsingError')));
  t('bufferAppendError → 解码', /解码/.test(R.describeHlsError('mediaError', 'bufferAppendError')));
  t('fragLoadError → 加载', /加载/.test(R.describeHlsError('networkError', 'fragLoadError')));
  t('mediaError 空 details → 媒体解码错误', R.describeHlsError('mediaError', '') === '媒体解码错误');
  t('networkError 空 details → 视频加载失败', R.describeHlsError('networkError', '') === '视频加载失败');
  const unk = R.describeHlsError('otherError', 'xyz');
  t('未知 details 给通用文案', typeof unk === 'string' && unk.length > 0 && /播放错误/.test(unk), unk);
  t('返回值均为字符串', typeof R.describeHlsError('x', 'y') === 'string');
  t('各种入参不抛错', noThrow(() => {
    R.describeHlsError('networkError', 'manifestLoadError');
    R.describeHlsError('mediaError', 'bufferStalledError');
    R.describeHlsError('', '');
    R.describeHlsError();
    R.describeHlsError(null, null);
    R.describeHlsError('toString', 'constructor');
  }));
}

console.log('\n[9] 顶层 IIFE 与源码约束');
{
  t('源码以 (function 开头', src.trimStart().startsWith('(function'));
  t('无顶层 import/export', !/^\s*(import|export)\b/m.test(src));
  t('双环境导出尾部范式', /typeof window\s*!==\s*'undefined'\s*\?\s*window\s*:\s*globalThis/.test(src));
  t('源码无 /api/proxy?url=', !src.includes('/api/proxy?url='));
  t('Node 下挂到 globalThis', R === globalThis.WDTVPlaybackRecovery);
}

console.log('\n[10] 缺省参数健壮性');
{
  let r1, r2, r3, r4;
  t('onFatal 缺省 state/policy/now 不抛', noThrow(() => { r1 = R.onFatal({ type: 'networkError', details: 'fragLoadError' }); }));
  t('onFatal 缺省 → retry attempt 1', r1 && r1.decision.action === 'retry' && r1.decision.attempt === 1);
  t('onFatal({}) 不抛', noThrow(() => { r2 = R.onFatal({}); }));
  t('onFatal({}) → switch-source', r2 && r2.decision.action === 'switch-source');
  t('onFatal() 不抛', noThrow(() => R.onFatal()));
  t('onHealthy({}) 不抛', noThrow(() => { r3 = R.onHealthy({}); }));
  t('onHealthy({}) → 全 0 state', r3 && r3.networkRetries === 0 && r3.mediaRecoveries === 0);
  t('onHealthy() 不抛', noThrow(() => { r4 = R.onHealthy(); }));
  t('onHealthy() → 全 0 state', r4 && r4.networkRetries === 0);
  t('describeHlsError 无参不抛', noThrow(() => R.describeHlsError()));
}

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
