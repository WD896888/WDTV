// WDTV 画质档位模块自测（Node ESM，零依赖，不随部署）
// 运行：node test/quality.test.mjs
import '../js/quality.js';

const A = globalThis.WDTVQuality;
let pass = 0, fail = 0;
const fails = [];

function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

const T = 1_700_000_000_000;
const probe = (height, error) => {
  const e = { from: 'probe', timestamp: T };
  if (height !== undefined) e.height = height;
  if (error !== undefined) e.error = error;
  return e;
};
const play = (height) => ({ height, from: 'play', timestamp: T });
const KEY = 'huang:123';

console.log('\n[1] qualityKey 与常量表');
{
  t('qualityKey 用 : 拼接源与影片', A.qualityKey('s1', 'vod-0') === 's1:vod-0');
  t('qualityKey 容忍 null/undefined', A.qualityKey(null, undefined) === ':');
  t('QUALITY_TTL_MS = 30 天', A.QUALITY_TTL_MS === 30 * 24 * 60 * 60 * 1000);
  t('QUALITY_FAIL_TTL_MS = 2 分钟', A.QUALITY_FAIL_TTL_MS === 2 * 60 * 1000);
  t('QUALITY_MAX_ENTRIES = 400', A.QUALITY_MAX_ENTRIES === 400);
  t('TIER_TOLERANCE = 0.15', A.TIER_TOLERANCE === 0.15);
  t('TIERS 含 4K/2K/1080P/720P/540P/480P/360P',
    A.TIERS.map(x => x.label).join('/') === '4K/2K/1080P/720P/540P/480P/360P');
}

console.log('\n[2] qualityLabel 常见档位');
{
  const cases = [[2160, '4K'], [1440, '2K'], [1080, '1080P'], [720, '720P'], [540, '540P'], [480, '480P'], [360, '360P']];
  for (const [h, label] of cases) t('档位 ' + h + ' → ' + label, A.qualityLabel(h) === label, A.qualityLabel(h));
}

console.log('\n[3] qualityLabel 就近归档（裁边容差）');
{
  t('1924×1040 裁切仍归 1080P', A.qualityLabel(1040) === '1080P', A.qualityLabel(1040));
  t('1030 归 1080P', A.qualityLabel(1030) === '1080P');
  t('1110 归 1080P', A.qualityLabel(1110) === '1080P');
  t('1920×960 归 1080P', A.qualityLabel(960) === '1080P', A.qualityLabel(960));
  t('920 归 1080P', A.qualityLabel(920) === '1080P');
  t('1000 归 1080P', A.qualityLabel(1000) === '1080P');
  t('700 归 720P', A.qualityLabel(700) === '720P');
  t('680 归 720P', A.qualityLabel(680) === '720P');
  t('800 归 720P（不抬 1080P）', A.qualityLabel(800) === '720P');
}

console.log('\n[4] qualityLabel 偏差过大 / 非法高度');
{
  t('144 → 144P（不抬成 360P）', A.qualityLabel(144) === '144P', A.qualityLabel(144));
  t('240 → 240P', A.qualityLabel(240) === '240P');
  t('undefined → undefined', A.qualityLabel(undefined) === undefined);
  t('0 → undefined', A.qualityLabel(0) === undefined);
  t('负数 → undefined', A.qualityLabel(-720) === undefined);
  t('NaN → undefined', A.qualityLabel(NaN) === undefined);
  t('Infinity → undefined', A.qualityLabel(Infinity) === undefined);
  t('字符串 → undefined', A.qualityLabel('1080') === undefined);
  t('null → undefined', A.qualityLabel(null) === undefined);
}

console.log('\n[5] mergeQualityEntries 三条优先级');
{
  // 1. 实测压过探测：播放实测覆盖「测不出」
  const afterProbe = A.mergeQualityEntries({}, { [KEY]: probe() }, T);
  t('先探测「测不出」无 height', afterProbe[KEY] && afterProbe[KEY].height === undefined);
  const afterPlay = A.mergeQualityEntries(afterProbe, { [KEY]: play(1080) }, T + 1000);
  t('实测覆盖「测不出」→ 1080 / play', afterPlay[KEY].height === 1080 && afterPlay[KEY].from === 'play');

  // 实测不被后续探测覆盖
  const curPlay = { [KEY]: play(1080) };
  const overwritten = A.mergeQualityEntries(curPlay, { [KEY]: probe(720) }, T + 1000);
  t('实测值不被后续探测覆盖', overwritten[KEY].height === 1080 && overwritten[KEY].from === 'play');

  // 2. 实测之间取较大值
  const up = A.mergeQualityEntries({ [KEY]: play(720) }, { [KEY]: play(1080) }, T + 1000);
  t('实测升级 720→1080 取较大值', up[KEY].height === 1080);
  const notDown = A.mergeQualityEntries(up, { [KEY]: play(540) }, T + 2000);
  t('后来的低档不拉低已知高档', notDown[KEY].height === 1080);

  // 3. 探测之间已有明确档位不被「测不出」抹掉
  const kept = A.mergeQualityEntries({ [KEY]: probe(1080) }, { [KEY]: probe() }, T + 1000);
  t('已有明确档位不被「测不出」抹掉', kept[KEY].height === 1080);

  // 探测升级：后来探到更高档应覆盖旧 probe
  const probeUp = A.mergeQualityEntries({ [KEY]: probe(720) }, { [KEY]: probe(1080) }, T + 1000);
  t('探测到更高档覆盖旧探测值', probeUp[KEY].height === 1080);

  // 回归：合并两条 play 时不再重建对象丢失 error 等额外字段
  const basePlay = { [KEY]: { height: 720, from: 'play', error: 'HTTP 403', source: 'cached', timestamp: T - 1000 } };
  const withExtra = A.mergeQualityEntries(
    basePlay,
    { [KEY]: { height: 1080, from: 'play', error: 'HTTP 500', note: 'fresh', timestamp: T } },
    T + 1000
  );
  t('两条 play 合并仍取较大 height', withExtra[KEY].height === 1080);
  t('两条 play 合并不丢弃 error 字段', typeof withExtra[KEY].error === 'string', JSON.stringify(withExtra[KEY]));
  t('两条 play 合并保留 prev 独有字段 source', withExtra[KEY].source === 'cached');
  t('两条 play 合并保留 incoming 独有字段 note', withExtra[KEY].note === 'fresh');
  t('两条 play 合并刷新 timestamp / from 仍为 play',
    withExtra[KEY].timestamp === T + 1000 && withExtra[KEY].from === 'play');
  t('两条 play 合并返回新对象、不污染入参',
    withExtra[KEY] !== basePlay[KEY] && basePlay[KEY].height === 720);
}

console.log('\n[6] mergeQualityEntries TTL 清理');
{
  // 失败（error）按短 TTL 淘汰；成功与「测不出」（无 error）按长 TTL 保留
  const now = T + A.QUALITY_FAIL_TTL_MS + 1000;
  const merged = A.mergeQualityEntries(
    { failed: probe(undefined, 'HTTP 403'), unknown: probe(), ok: probe(1080) },
    {}, now
  );
  t('失败记录过 FAIL_TTL 被淘汰（允许重试）', merged.failed === undefined);
  t('「测不出」按长 TTL 保留（不反复重探）', merged.unknown !== undefined);
  t('成功按长 TTL 保留', merged.ok !== undefined);
  t('长 TTL 到期后成功也被清掉',
    A.mergeQualityEntries({ ok: probe(1080) }, {}, T + A.QUALITY_TTL_MS + 1000).ok === undefined);

  // 未过期条目保留
  const keep = A.mergeQualityEntries({ other: probe(720) }, { [KEY]: play(1080) }, T + 1000);
  t('未过期条目不丢失', keep.other && keep.other.height === 720 && keep[KEY].height === 1080);
}

console.log('\n[7] mergeQualityEntries 上限淘汰最旧');
{
  const current = {};
  for (let i = 0; i < 400; i++) current['k' + i] = { height: 720, from: 'probe', timestamp: T + i };
  const next = A.mergeQualityEntries(current, { fresh: { height: 1080, from: 'probe', timestamp: T + 9999 } }, T + 9999);
  t('总数封顶 400', Object.keys(next).length === 400, String(Object.keys(next).length));
  t('最旧的 k0 被淘汰', next.k0 === undefined);
  t('新条目保留', next.fresh !== undefined);
}

console.log('\n[8] isQualityEntryFresh');
{
  t('成功在 TTL 内为 fresh', A.isQualityEntryFresh(probe(1080), T + A.QUALITY_TTL_MS - 1) === true);
  t('成功过 TTL 为 stale', A.isQualityEntryFresh(probe(1080), T + A.QUALITY_TTL_MS + 1) === false);
  t('失败过短 TTL 为 stale', A.isQualityEntryFresh(probe(undefined, 'HTTP 403'), T + A.QUALITY_FAIL_TTL_MS + 1) === false);
  t('失败在短 TTL 内仍 fresh', A.isQualityEntryFresh(probe(undefined, 'HTTP 403'), T + A.QUALITY_FAIL_TTL_MS - 1) === true);
  t('null 条目不 fresh 且不抛', A.isQualityEntryFresh(null, T) === false);
}

console.log('\n[9] describeQualityBadge 四态');
{
  t('probing 优先 → loading', A.describeQualityBadge(play(720), true).state === 'loading');
  t('loading retryable=false', A.describeQualityBadge(undefined, true).retryable === false);
  t('无 entry → undefined（不显示）', A.describeQualityBadge(undefined, false) === undefined);

  const value = A.describeQualityBadge(play(1080));
  t('有 height → value / 1080P', value.state === 'value' && value.label === '1080P');
  t('value tooltip 说明实测来源', value.tooltip.includes('实测') && value.tooltip === value.title);
  t('value state 与 kind 一致', value.state === value.kind);

  const unknown = A.describeQualityBadge(probe());
  t('无 height 无 error → unknown', unknown.state === 'unknown');
  t('unknown 不可重试', unknown.retryable === false);
  t('unknown tooltip 说明单码率', unknown.tooltip.includes('单码率'));

  const failed = A.describeQualityBadge(probe(undefined, 'HTTP 403'));
  t('有 error → failed / 未测到', failed.state === 'failed' && failed.label === '未测到');
  t('failed 可重试', failed.retryable === true);
  t('failed tooltip 带原始错误', failed.tooltip.includes('HTTP 403'));
  t('failed 带失败原因短标签', failed.reason === '防盗链');

  t('失败但带高度时按 value 展示', A.describeQualityBadge({ height: 720, from: 'probe', error: 'HTTP 500', timestamp: T }).state === 'value');
}

console.log('\n[10] summarizeQuality 空输入与混合');
{
  const empty = A.summarizeQuality([]);
  t('空输入：label/best 为 undefined', empty.label === undefined && empty.best === undefined);
  t('空输入：不虚报统计', empty.known === 0 && empty.failed === 0 && empty.total === 0);

  const mix = A.summarizeQuality([probe(720), probe(1080), probe(), probe(undefined, 'HTTP 403')]);
  t('取最高档 1080P', mix.label === '1080P' && mix.best === '1080P');
  t('命中/失败/总数 = 2/1/4', mix.known === 2 && mix.failed === 1 && mix.total === 4, JSON.stringify(mix));

  const withUndef = A.summarizeQuality([probe(720), undefined, undefined]);
  t('undefined 条目不计入分母', withUndef.total === 1 && withUndef.known === 1, JSON.stringify(withUndef));

  const allUnknown = A.summarizeQuality([probe(), probe()]);
  t('全测不出：无 best 但 total 计入', allUnknown.label === undefined && allUnknown.total === 2);

  const mixed = A.summarizeQuality([probe(720), play(2160)]);
  t('实测/探测混合取较大 → 4K', mixed.label === '4K');

  const obj = A.summarizeQuality({ a: probe(720), b: play(1080) });
  t('传入对象映射也能统计', obj.label === '1080P' && obj.total === 2);
}

console.log('\n[11] failureReasonLabel / inferHeightFromBitrate');
{
  t('HTTP 403 → 防盗链', A.failureReasonLabel('HTTP 403') === '防盗链');
  t('超时 → 超时', A.failureReasonLabel('画质探测超时') === '超时');
  t('未找到播放资源 → 无资源', A.failureReasonLabel('未找到播放资源') === '无资源');
  t('连接中断 → 连接中断', A.failureReasonLabel('探测连接中途被断开（多为网关超时）') === '连接中断');
  t('请求失败 (502) → 网关异常', A.failureReasonLabel('请求失败 (502)') === '网关异常');
  t('无法归类不硬造标签', A.failureReasonLabel('fetch failed') === undefined);
  t('undefined → undefined', A.failureReasonLabel(undefined) === undefined);

  t('inferHeightFromBitrate(6_000_000) → 1080', A.inferHeightFromBitrate(6_000_000) === 1080);
  t('inferHeightFromBitrate(12_000_000) → 2160', A.inferHeightFromBitrate(12_000_000) === 2160);
  t('inferHeightFromBitrate(800_000) → 480', A.inferHeightFromBitrate(800_000) === 480);
  t('inferHeightFromBitrate(0) → 240', A.inferHeightFromBitrate(0) === 240);
  t('inferHeightFromBitrate(NaN) → 240（不抛）', A.inferHeightFromBitrate(NaN) === 240);
}

console.log('\n[12] heightOf 容错');
{
  t('直接 QualityEntry', A.heightOf({ height: 1080 }) === 1080);
  t('嵌套 entry', A.heightOf({ entry: { height: 720 } }) === 720);
  t('qualityHeight 别名', A.heightOf({ qualityHeight: 540 }) === 540);
  t('videoHeight 别名', A.heightOf({ videoHeight: 480 }) === 480);
  t('无高度 → undefined', A.heightOf({ from: 'probe' }) === undefined);
  t('null / 数字 / 字符串不抛', A.heightOf(null) === undefined && A.heightOf(5) === undefined && A.heightOf('x') === undefined);
}

console.log('\n[13] sortByQuality 降序 / 缺失 entries 不抛错');
{
  const items = [
    { source_code: 's1', vod_id: 'a' },
    { source_code: 's1', vod_id: 'b' },
    { source_code: 's1', vod_id: 'c' },
    { source_code: 's1', vod_id: 'd' }
  ];
  // colon 键（qualityKey）与 underscore 键混合都能查到
  const entries = {
    's1:a': { height: 720, from: 'probe', timestamp: T },
    's1_b': { height: 2160, from: 'probe', timestamp: T },
    's1:c': { height: 1080, from: 'probe', timestamp: T }
    // d 无结果
  };
  const sorted = A.sortByQuality(items, entries);
  t('返回新数组且长度不变', sorted.length === 4 && sorted !== items);
  t('画质降序：4K(2160) → 1080P → 720P → 未知(原序垫底)',
    sorted.map(x => x.vod_id).join(',') === 'b,c,a,d', sorted.map(x => x.vod_id).join(','));
  t('原数组未被改动', items.map(x => x.vod_id).join(',') === 'a,b,c,d');

  // 缺失 entries：按原序返回、不抛错
  let noThrow = true;
  let r1, r2, r3;
  try {
    r1 = A.sortByQuality(items);
    r2 = A.sortByQuality(items, null);
    r3 = A.sortByQuality(items, {});
  } catch (e) { noThrow = false; }
  t('entries 缺失/空对象不抛错', noThrow);
  t('entries 缺失按原序返回', r1.map(x => x.vod_id).join(',') === 'a,b,c,d');
  t('entries 为 null 按原序返回', r2.map(x => x.vod_id).join(',') === 'a,b,c,d');
  t('entries 为空对象按原序返回', r3.map(x => x.vod_id).join(',') === 'a,b,c,d');

  // item 自带高度也能排序
  const embedded = A.sortByQuality(
    [{ vod_id: 'x', height: 480 }, { vod_id: 'y', height: 2160 }, { vod_id: 'z' }],
    { stub: { height: 1, from: 'probe', timestamp: T } }
  );
  t('item 自带高度参与降序', embedded.map(x => x.vod_id).join(',') === 'y,x,z', embedded.map(x => x.vod_id).join(','));

  // 非数组 items / 异常元素不抛
  let edgeOk = true;
  try {
    A.sortByQuality(null, entries);
    A.sortByQuality([null, undefined, 5, items[0]], entries);
  } catch (e) { edgeOk = false; }
  t('非数组 / 异常元素不抛', edgeOk);
}

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
