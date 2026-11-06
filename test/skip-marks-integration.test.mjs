// WDTV decideAutoSkip 运行时契约自测（Node ESM，零依赖，不随部署）
// 只用 mock 输入，不加载 js/player.js；运行：node test/skip-marks-integration.test.mjs
import '../js/skip-marks.js';

const S = globalThis.WDTVSkipMarks;
let pass = 0, fail = 0;
const fails = [];

function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

function seg(type, start, end) { return { type: type, start: start, end: end }; }
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
  }
  return o;
}
// 返回形状契约：null 或单个 { target, reason, kind:'ad'|'mark', skipKey }
function shape(r) {
  if (r === null) return true;
  return !!r && typeof r === 'object' && !Array.isArray(r) &&
    typeof r.target === 'number' && Number.isFinite(r.target) &&
    typeof r.reason === 'string' && r.reason.length > 0 &&
    (r.kind === 'ad' || r.kind === 'mark') &&
    typeof r.skipKey === 'string' && r.skipKey.length > 0 &&
    Object.keys(r).length === 4;
}

// 基准：position=50 同时落在广告区 [45,60] 与片头段 [0,90) 内
const BASE = {
  now: 6000, lastSkipAt: 0, cooldownMs: 1000,
  paused: false, duration: 1000, position: 50, isUserSeeking: false,
  guestActive: false,
  adRegions: [{ start: 45, end: 60 }],
  segments: [seg('opening', 0, 90), seg('middle', 100, 150)],
  suppressedKeys: []
};

console.log('\n[1] 一次调用最多一个 seek 目标 / 广告区优先于标记段');
{
  const r = S.decideAutoSkip(BASE);
  t('返回单个合法形状', shape(r), JSON.stringify(r));
  t('不是数组（不会返回多目标）', !!r && !Array.isArray(r));
  t('广告区与标记段同时命中时优先 ad', !!r && r.kind === 'ad');
  t('ad 目标取 r.end', !!r && r.target === 60);
  t('ad 的 skipKey 形如 ad:start', !!r && r.skipKey === 'ad:45');
  t('reason 为中文字符串', !!r && typeof r.reason === 'string' && r.reason.length > 0);
  t('恰好四个字段', !!r && ['target', 'reason', 'kind', 'skipKey'].every(function (k) { return k in r; }));
}

console.log('\n[2] 1s 冷却（与既有广告自动跳过共用）');
{
  t('首次命中', S.decideAutoSkip(BASE) !== null);
  t('连续两次 now 差 <1000 → 第二次返回 null',
    S.decideAutoSkip(Object.assign({}, BASE, { now: 6500, lastSkipAt: 6000 })) === null);
  t('满 1000ms 后恢复',
    S.decideAutoSkip(Object.assign({}, BASE, { now: 7000, lastSkipAt: 6000 })) !== null);
  t('自定义 cooldownMs=2000 生效',
    S.decideAutoSkip(Object.assign({}, BASE, { cooldownMs: 2000, now: 7000, lastSkipAt: 6000 })) === null);
  t('cooldownMs=0 关闭冷却',
    S.decideAutoSkip(Object.assign({}, BASE, { cooldownMs: 0, now: 6100, lastSkipAt: 6000 })) !== null);
  t('冷却未过时两类区域都不产生目标',
    S.decideAutoSkip(Object.assign({}, BASE, { now: 6100, lastSkipAt: 6000 })) === null);
  t('缺省 now/lastSkipAt 不抛错且可命中',
    S.decideAutoSkip(Object.assign({}, BASE, { now: undefined, lastSkipAt: undefined })) !== null);
}

console.log('\n[3] 统一避让：任一命中均不 seek');
{
  const guards = [
    ['paused', { paused: true }],
    ['isUserSeeking', { isUserSeeking: true }],
    ['position < 0.5', { position: 0.4 }],
    ['position > duration-0.5', { position: 999.6 }],
    ['guestActive（共看 guest）', { guestActive: true }],
    ['duration NaN', { duration: NaN }],
    ['duration 0', { duration: 0 }],
    ['duration 负数', { duration: -1 }],
    ['duration 非数值', { duration: '1000' }],
    ['position 缺失', { position: undefined }],
    ['cooldown 未过', { now: 6100, lastSkipAt: 6000 }]
  ];
  guards.forEach(function (g) {
    t('避让 ' + g[0], S.decideAutoSkip(Object.assign({}, BASE, g[1])) === null);
  });
}

console.log('\n[4] 撤销抑制 skipKey');
{
  const hit = S.decideAutoSkip(Object.assign({}, BASE, { adRegions: null }));
  t('无广告区时命中标记段', !!hit && hit.kind === 'mark' && hit.target === 90);
  t('mark 的 skipKey 形如 type:start', !!hit && hit.skipKey === 'opening:0');
  const key = hit && hit.skipKey;
  t('Set 抑制后不再返回该段（无其它命中则 null）',
    S.decideAutoSkip(Object.assign({}, BASE, { adRegions: null, suppressedKeys: new Set([key]) })) === null);
  t('Array 抑制同样生效',
    S.decideAutoSkip(Object.assign({}, BASE, { adRegions: null, suppressedKeys: [key] })) === null);

  // 两个重叠广告区同时命中：抑制首段后继续找下一个
  const twoAds = Object.assign({}, BASE, {
    adRegions: [{ start: 40, end: 60 }, { start: 45, end: 70 }],
    segments: []
  });
  const a1 = S.decideAutoSkip(twoAds);
  t('两个广告区命中取第一个', !!a1 && a1.target === 60 && a1.skipKey === 'ad:40');
  const a2 = S.decideAutoSkip(Object.assign({}, twoAds, { suppressedKeys: new Set(['ad:40']) }));
  t('抑制该段后继续找下一个', !!a2 && a2.target === 70 && a2.skipKey === 'ad:45');
  t('全部抑制 → null',
    S.decideAutoSkip(Object.assign({}, twoAds, { suppressedKeys: ['ad:40', 'ad:45'] })) === null);
  t('suppressedKeys 为 null 不抛错',
    S.decideAutoSkip(Object.assign({}, BASE, { suppressedKeys: null })) !== null);
}

console.log('\n[5] 与既有广告自动跳过共用冷却 / 优先级不产生第二个 seek');
{
  const both = S.decideAutoSkip(BASE);
  t('同时命中只返回广告区目标', !!both && both.kind === 'ad' && both.target === 60);
  t('不额外产出标记段目标', !!both && Object.keys(both).length === 4 && !Array.isArray(both));
  t('标记段命中形状同样合法', shape(S.decideAutoSkip(Object.assign({}, BASE, { adRegions: null }))));
  const mk = S.decideAutoSkip(Object.assign({}, BASE, { adRegions: null, position: 120 }));
  t('mark 目标取 segment.end', !!mk && mk.kind === 'mark' && mk.target === 150 && mk.skipKey === 'middle:100');
  t('广告区为 null 时退化到标记段', !!mk && mk.kind === 'mark');
}

console.log('\n[6] 入参数组不被修改');
{
  const adRegions = [Object.freeze({ start: 45, end: 60 })];
  const segments = [Object.freeze(seg('opening', 0, 90)), Object.freeze(seg('middle', 100, 150))];
  const beforeAd = JSON.stringify(adRegions);
  const beforeSeg = JSON.stringify(segments);
  const suppressed = new Set(['nothing']);
  const frozenInput = deepFreeze(Object.assign({}, BASE, { adRegions: adRegions, segments: segments, suppressedKeys: suppressed }));
  let threw = false, r;
  try { r = S.decideAutoSkip(frozenInput); } catch (e) { threw = true; }
  t('深度冻结输入不抛错', !threw);
  t('返回形状仍合法', shape(r));
  t('adRegions 深比较未改', JSON.stringify(adRegions) === beforeAd);
  t('segments 深比较未改', JSON.stringify(segments) === beforeSeg);
  t('不改动 suppressedKeys 集合', suppressed.size === 1 && suppressed.has('nothing'));
  t('多次调用结果稳定', JSON.stringify(S.decideAutoSkip(BASE)) === JSON.stringify(S.decideAutoSkip(BASE)));
}

console.log('\n[7] 缺省字段不抛错 / 片尾连续播放判定');
{
  const defaults = [undefined, null, {}, 42, 'x', [], { duration: 1000 }, { duration: 1000, position: 50 }];
  defaults.forEach(function (v, i) {
    let threw = false, r;
    try { r = S.decideAutoSkip(v); } catch (e) { threw = true; }
    t('缺省输入 ' + i + ' 不抛错', !threw);
    t('缺省输入 ' + i + ' 不产生自动跳过（返回 null）', r === null, JSON.stringify(r));
  });
  // 证明 shape() 本身有区分力：旧断言 `shape(r)` 对 r===null 恒真，无法发现返回错误形状。
  t('shape 契约能识别非法决策形状',
      shape({ target: 60, reason: 'x', kind: 'ad', skipKey: 'ad:45' }) === true &&
      shape({ target: '60', reason: 'x', kind: 'ad', skipKey: 'ad:45' }) === false &&
      shape({ target: 60, reason: 'x', kind: 'ad', skipKey: 'ad:45', extra: 1 }) === false);

  const crossingBase = {
    now: 6000, lastSkipAt: 0, cooldownMs: 1000,
    paused: false, duration: 1300, position: 1201, isUserSeeking: false,
    guestActive: false, adRegions: null,
    segments: [seg('ending', 1200, 1300)], suppressedKeys: []
  };
  const c1 = S.decideAutoSkip(Object.assign({}, crossingBase, { previousPosition: 1199 }));
  t('连续播放跨过片尾起点触发', !!c1 && c1.kind === 'mark' && c1.target === 1300 && c1.skipKey === 'ending:1200');
  t('拖进度条大跳变（step>10s）不触发片尾',
    S.decideAutoSkip(Object.assign({}, crossingBase, { previousPosition: 100 })) === null);
  t('拖进度条落入片尾内，下一帧不得自动结束',
    S.decideAutoSkip(Object.assign({}, crossingBase, { position: 1210, previousPosition: 1205 })) === null);
  t('拖后第二帧（prev 已更新为落点）不得自动结束',
    S.decideAutoSkip(Object.assign({}, crossingBase, { position: 1210.25, previousPosition: 1210 })) === null);
  t('未提供 previousPosition 时沿用区间命中', S.decideAutoSkip(crossingBase) !== null);
  t('片尾段被抑制 → null',
    S.decideAutoSkip(Object.assign({}, crossingBase, { suppressedKeys: new Set(['ending:1200']) })) === null);
}

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
