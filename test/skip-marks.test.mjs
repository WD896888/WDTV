// WDTV 片头/中段/片尾跳过标记 自测（Node ESM，零依赖，不随部署）
// 运行：node test/skip-marks.test.mjs
import '../js/skip-marks.js';
import { readFileSync } from 'node:fs';

const S = globalThis.WDTVSkipMarks;
let pass = 0, fail = 0;
const fails = [];

function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
  }
  return o;
}
function seg(type, start, end) { return { type: type, start: start, end: end }; }
function isErr(v) { return typeof v === 'string' && v.length > 0; }

console.log('\n[0] 导出与常量');
{
  t('全局导出存在', !!S && typeof S === 'object');
  const fns = ['normalizeTitle', 'skipMarkKey', 'migrateSkipMarks', 'resolveSegments',
    'findActiveSegment', 'findCrossedEnding', 'validateSegment', 'decideAutoSkip'];
  fns.forEach(function (n) { t('导出函数 ' + n, typeof S[n] === 'function'); });
  t('SEGMENT_TYPES 冻结语义', JSON.stringify(S.SEGMENT_TYPES) === '["opening","middle","ending"]');
  t('SEGMENT_LABELS 中文', S.SEGMENT_LABELS.opening === '片头' && S.SEGMENT_LABELS.middle === '中段' && S.SEGMENT_LABELS.ending === '片尾');
  t('SEGMENT_COLORS 为半透明低饱和 rgba', ['opening', 'middle', 'ending'].every(function (k) {
    return /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0?\.\d+\s*\)$/.test(S.SEGMENT_COLORS[k]);
  }));
  t('阈值常量', S.MIN_SEGMENT_SECONDS === 3 && S.MIN_SEGMENT_GAP_SECONDS === 5 &&
    S.END_GUARD_SECONDS === 2 && S.PROMPT_GUARD_SECONDS === 1 &&
    S.MAX_CONTINUOUS_STEP_SECONDS === 10);
  t('UNKNOWN_TITLE 为空串占位', S.UNKNOWN_TITLE === '');
}

console.log('\n[1] normalizeTitle 归一化 / 幂等 / 非字符串不抛错');
{
  t('大小写 + 空白', S.normalizeTitle('  Hello  World  ') === 'helloworld');
  t('英文标点 / 符号', S.normalizeTitle('A-B_C. D!') === 'abcd');
  t('中文标点 \\p{P}', S.normalizeTitle('片头，！【】。《》？') === '片头');
  t('emoji \\p{S}', S.normalizeTitle('a🎬b') === 'ab');
  t('混合空白标点', S.normalizeTitle('  A ， B ！ C  ') === 'abc');
  const samples = ['  Hello  World  ', '片头，！【】', 'a🎬b', 'A-B_C. D!'];
  samples.forEach(function (x) {
    t('幂等 ' + JSON.stringify(x), S.normalizeTitle(S.normalizeTitle(x)) === S.normalizeTitle(x));
  });
  let threw = false;
  const vals = [null, undefined, 0, 123, true, {}, [], NaN];
  vals.forEach(function (v) {
    try { if (typeof S.normalizeTitle(v) !== 'string') threw = true; }
    catch (e) { threw = true; }
  });
  t('非字符串不抛错且返回字符串', !threw);
  t('null/undefined → 空串', S.normalizeTitle(null) === '' && S.normalizeTitle(undefined) === '');
}

console.log('\n[2] skipMarkKey 主键 / fallback / 占位 / 空 fallback');
{
  t('有效标题 → t: 前缀', S.skipMarkKey('  Hello World！ ', 'src_1') === 't:helloworld');
  t('有效标题忽略 fallback', S.skipMarkKey('Movie', '') === 't:movie');
  t('占位 未知 → fallback', S.skipMarkKey('未知', 'src_1') === 'src_1');
  t('占位 undefined（大小写）→ fallback', S.skipMarkKey('UNDEFINED', 'x') === 'x');
  t('占位 null → fallback', S.skipMarkKey('null', 'x') === 'x');
  t('空白标题 → fallback', S.skipMarkKey('   ', 'x') === 'x');
  t('缺失标题 → fallback', S.skipMarkKey(null, 'x') === 'x');
  t('纯标点标题 → fallback', S.skipMarkKey('!!!', 'x') === 'x');
  t('空 fallback → 空串', S.skipMarkKey('', '') === '');
  t('fallback 为 null → 空串', S.skipMarkKey(null, null) === '');
  t('两类键不串数据', (function () {
    // 标题与 fallback 取同一个字符串，标题键靠 t: 前缀隔离，绝不等于 fallback 键
    const a = S.skipMarkKey('abc', 'abc');
    return a === 't:abc' && a !== 'abc';
  })());
  t('中文标点参与归一', S.skipMarkKey('庆余年，第一季！', 'fb') === 't:庆余年第一季');
}

console.log('\n[3] migrateSkipMarks v3→v4 / 透传 / 损坏丢弃 / 默认关闭 / ≤3 段');
{
  const v3 = { enabled: true, marks: { 't:foo': { introEnd: 90, outroStart: 1200, updatedAt: 123 } } };
  const r3 = S.migrateSkipMarks(v3);
  t('v3 顶层 enabled 保留', r3.enabled === true);
  t('v3 生成 2 段', r3.marks['t:foo'] && r3.marks['t:foo'].segments.length === 2);
  t('v3 opening [0,90]', r3.marks['t:foo'] &&
    JSON.stringify(r3.marks['t:foo'].segments[0]) === JSON.stringify(seg('opening', 0, 90)));
  t('v3 ending [1200,-1]', r3.marks['t:foo'] &&
    JSON.stringify(r3.marks['t:foo'].segments[1]) === JSON.stringify(seg('ending', 1200, -1)));
  t('v3 updatedAt 保留', r3.marks['t:foo'].updatedAt === 123);
  t('v3 条目缺省 enabled → true', r3.marks['t:foo'].enabled === true);

  const flat = { 't:flat': { introEnd: 60, outroStart: 900 } };
  const rf = S.migrateSkipMarks(flat);
  t('顶层平铺旧数据也能迁移', rf.marks['t:flat'] && rf.marks['t:flat'].segments.length === 2);
  t('顶层平铺缺省 enabled → false（默认关闭）', rf.enabled === false);

  const v4 = {
    enabled: true,
    marks: { 't:bar': { segments: [seg('opening', 0, 90), seg('middle', 100, 150)], enabled: true, updatedAt: 999 } }
  };
  const r4 = S.migrateSkipMarks(v4);
  t('规范结构透传 enabled/updatedAt', r4.marks['t:bar'].enabled === true && r4.marks['t:bar'].updatedAt === 999);
  t('规范结构透传 2 段', r4.marks['t:bar'].segments.length === 2);
  t('规范结构不修改原对象', JSON.stringify(v4.marks['t:bar'].segments[0]) === JSON.stringify(seg('opening', 0, 90)));

  const bad = {
    enabled: true,
    marks: {
      good: { segments: [seg('opening', 0, 90)], enabled: true, updatedAt: 1 },
      b1: null,
      b2: 42,
      b3: 'str',
      b4: [1, 2],
      b5: { segments: 'not-array' },
      b6: { segments: [seg('nope', 0, 90)] },
      b7: { segments: [seg('opening', NaN, 90)] },
      b8: { segments: [seg('opening', 0, Infinity)] },
      b9: { segments: [seg('opening', 0, '90')] },
      b10: { segments: [seg('opening', 0, 90), seg('middle', 100, NaN)] }
    }
  };
  let threw = false, rb;
  try { rb = S.migrateSkipMarks(bad); } catch (e) { threw = true; }
  t('损坏条目不抛错', !threw);
  t('合法条目保留', !!rb.marks.good && rb.marks.good.segments.length === 1);
  const badKeys = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9'];
  t('全部损坏条目丢弃', badKeys.every(function (k) { return !(k in rb.marks); }), JSON.stringify(Object.keys(rb.marks)));
  // 回归：单段损坏不再丢整条，只跳过损坏段、保留其余有效段
  t('b10 单段损坏保留其余有效段（不再整条丢弃）',
    !!rb.marks.b10 && rb.marks.b10.segments.length === 1 &&
    JSON.stringify(rb.marks.b10.segments[0]) === JSON.stringify(seg('opening', 0, 90)),
    JSON.stringify(rb.marks.b10));
  const partial = {
    enabled: true,
    marks: {
      p: { segments: [seg('opening', 0, 90), seg('middle', NaN, 150), seg('ending', 1200, -1)], enabled: true }
    }
  };
  const rp = S.migrateSkipMarks(partial);
  t('单段损坏保留其余段：3 段坏 1 段 → 保留 2 段',
    !!rp.marks.p && rp.marks.p.segments.length === 2, JSON.stringify(rp.marks.p && rp.marks.p.segments));
  t('保留的是顺序不变的有效段（opening + ending）',
    !!rp.marks.p && rp.marks.p.segments[0].type === 'opening' && rp.marks.p.segments[1].type === 'ending');
  t('全坏（每段都损坏）才丢整条',
    !S.migrateSkipMarks({ marks: { q: { segments: [seg('nope', 0, 90), seg('middle', NaN, 150)] } } }).marks.q);
  t('损坏输入不抛错（null/数组/字符串）', (function () {
    try { S.migrateSkipMarks(null); S.migrateSkipMarks([]); S.migrateSkipMarks('x'); S.migrateSkipMarks(123); return true; }
    catch (e) { return false; }
  })());

  t('缺省 enabled 默认 false', S.migrateSkipMarks({}).enabled === false);
  t('null 输入默认 false', S.migrateSkipMarks(null).enabled === false);
  t('字符串 enabled 默认 false', S.migrateSkipMarks({ enabled: 'true' }).enabled === false);
  t('数字 enabled 默认 false', S.migrateSkipMarks({ enabled: 1 }).enabled === false);
  t('显式 false 保持 false', S.migrateSkipMarks({ enabled: false }).enabled === false);
  t('显式 true 才 true', S.migrateSkipMarks({ enabled: true }).enabled === true);

  const many = {
    enabled: true,
    marks: { k: { segments: [seg('opening', 0, 90), seg('middle', 100, 150), seg('middle', 200, 250), seg('ending', 300, -1)], enabled: true } }
  };
  t('单部剧最多 3 段', S.migrateSkipMarks(many).marks.k.segments.length === 3);
  t('v3 转换最多 2 段', S.migrateSkipMarks({ marks: { k: { introEnd: 90, outroStart: 1200 } } }).marks.k.segments.length === 2);
}

console.log('\n[4] resolveSegments 读取侧校验');
{
  t('ending 的 -1 填成 duration', (function () {
    const r = S.resolveSegments({ enabled: true, segments: [seg('ending', 1200, -1)] }, 1300);
    return r.length === 1 && r[0].end === 1300 && r[0].start === 1200;
  })());
  t('越界 start<0 丢弃', S.resolveSegments({ segments: [seg('opening', -5, 90)] }, 1000).length === 0);
  t('越界 end>duration+0.5 丢弃', S.resolveSegments({ segments: [seg('middle', 100, 2000)] }, 1000).length === 0);
  t('过短 <3s 丢弃', S.resolveSegments({ segments: [seg('middle', 100, 102)] }, 1000).length === 0);
  t('终点贴片尾 <2s 丢弃', S.resolveSegments({ segments: [seg('middle', 100, 999)] }, 1000).length === 0);
  t('ending 段贴片尾豁免保留', S.resolveSegments({ segments: [seg('ending', 900, -1)] }, 1000).length === 1);
  t('非法 type 丢弃', S.resolveSegments({ segments: [seg('nope', 100, 150)] }, 1000).length === 0);
  t('NaN 数值段丢弃', S.resolveSegments({ segments: [seg('middle', NaN, 150)] }, 1000).length === 0);
  t('非 ending 段的 -1 丢弃', S.resolveSegments({ segments: [seg('middle', 100, -1)] }, 1000).length === 0);

  const overlap = { enabled: true, segments: [
    seg('opening', 0, 90),
    seg('middle', 92, 150),   // 与前一区间间隔 2 < 5 → 丢
    seg('middle', 200, 250),  // 间隔 110 → 保留
    seg('middle', 205, 260)   // 与前一区间重叠 → 丢
  ] };
  const ro = S.resolveSegments(overlap, 1000);
  t('重叠/间隔不足丢靠后者', ro.length === 2 && ro[0].start === 0 && ro[1].start === 200, JSON.stringify(ro));
  t('恰好间隔 5s 允许', (function () {
    const r = S.resolveSegments({ segments: [seg('opening', 0, 90), seg('middle', 95, 150)] }, 1000);
    return r.length === 2;
  })());
  t('按 start 升序', (function () {
    const r = S.resolveSegments({ segments: [seg('middle', 200, 250), seg('opening', 0, 90), seg('middle', 100, 150)] }, 1000);
    return r.length === 3 && r[0].start === 0 && r[1].start === 100 && r[2].start === 200;
  })());
  t('duration NaN → []', S.resolveSegments({ segments: [seg('opening', 0, 90)] }, NaN).length === 0);
  t('duration 0 → []', S.resolveSegments({ segments: [seg('opening', 0, 90)] }, 0).length === 0);
  t('duration 负数 → []', S.resolveSegments({ segments: [seg('opening', 0, 90)] }, -1).length === 0);
  t('duration 非数 → []', S.resolveSegments({ segments: [seg('opening', 0, 90)] }, '1000').length === 0);
  t('enabled:false → []', S.resolveSegments({ enabled: false, segments: [seg('opening', 0, 90)] }, 1000).length === 0);
  t('mark 为 null → []', S.resolveSegments(null, 1000).length === 0);
  t('segments 非数组 → []', S.resolveSegments({ segments: 'x' }, 1000).length === 0);
  t('返回普通对象且字段完整', (function () {
    const r = S.resolveSegments({ segments: [seg('opening', 0, 90)] }, 1000);
    return r.length === 1 && Object.keys(r[0]).sort().join(',') === 'end,start,type';
  })());
}

console.log('\n[5] findActiveSegment 命中窗口');
{
  const segs = [{ type: 'opening', start: 0, end: 90 }, { type: 'middle', start: 100, end: 150 }];
  t('命中第一段', S.findActiveSegment(segs, 50) === segs[0]);
  t('命中第二段', S.findActiveSegment(segs, 120) === segs[1]);
  t('间隙不命中', S.findActiveSegment(segs, 95) === undefined);
  t('起点边界命中（>= start）', S.findActiveSegment(segs, 0) === segs[0]);
  t('PROMPT_GUARD: end-1 处不命中', S.findActiveSegment(segs, 89) === undefined);
  t('PROMPT_GUARD: end-1 前一刻命中', S.findActiveSegment(segs, 88.9) === segs[0]);
  t('NaN position → undefined', S.findActiveSegment(segs, NaN) === undefined);
  t('非数 position → undefined', S.findActiveSegment(segs, '50') === undefined);
  t('undefined position → undefined', S.findActiveSegment(segs, undefined) === undefined);
  t('segments 非数组 → undefined', S.findActiveSegment(null, 50) === undefined);
}

console.log('\n[6] findCrossedEnding 连续播放判定');
{
  const segs = [{ type: 'opening', start: 0, end: 90 }, { type: 'ending', start: 1200, end: 1300 }];
  t('step 2s 跨过片尾起点触发', S.findCrossedEnding(segs, 1199, 1201) === segs[1]);
  t('step 10s 边界触发', S.findCrossedEnding(segs, 1190, 1200) === segs[1]);
  t('step>10s 大跳变不触发', S.findCrossedEnding(segs, 1180, 1201) === undefined);
  t('后退 step 不触发', S.findCrossedEnding(segs, 1205, 1200) === undefined);
  t('零 step 不触发', S.findCrossedEnding(segs, 1200, 1200) === undefined);
  t('负 step 不触发', S.findCrossedEnding(segs, 1210, 1200) === undefined);
  t('未跨过起点不触发', S.findCrossedEnding(segs, 1100, 1102) === undefined);
  t('非 ending 段不触发', S.findCrossedEnding(segs, 89, 91) === undefined);
  t('仅 opening 段无结果', S.findCrossedEnding([{ type: 'opening', start: 0, end: 90 }], 0, 5) === undefined);
  t('NaN 参数 → undefined', S.findCrossedEnding(segs, NaN, 1201) === undefined);
  t('segments 非数组 → undefined', S.findCrossedEnding(null, 1199, 1201) === undefined);
}

console.log('\n[7] validateSegment 写侧校验');
{
  t('合法 opening → null', S.validateSegment(seg('opening', 0, 90), 1300, []) === null);
  t('合法 middle → null', S.validateSegment(seg('middle', 100, 150), 1300, [seg('opening', 0, 90)]) === null);
  t('合法 ending → null', S.validateSegment(seg('ending', 1200, -1), 1300, [seg('opening', 0, 90)]) === null);
  t('opening start≠0 → 中文错误', isErr(S.validateSegment(seg('opening', 10, 90), 1300, [])));
  t('ending end≠-1 → 中文错误', isErr(S.validateSegment(seg('ending', 1200, 1250), 1300, [])));
  t('太短 → 中文错误', isErr(S.validateSegment(seg('middle', 100, 102), 1300, [])));
  t('重叠 → 中文错误', isErr(S.validateSegment(seg('middle', 50, 150), 1300, [seg('opening', 0, 90)])));
  t('间隔 <5s → 中文错误', isErr(S.validateSegment(seg('middle', 92, 150), 1300, [seg('opening', 0, 90)])));
  t('间隔恰好 5s → null', S.validateSegment(seg('middle', 95, 150), 1300, [seg('opening', 0, 90)]) === null);
  t('duration NaN → 中文错误', isErr(S.validateSegment(seg('opening', 0, 90), NaN, [])));
  t('duration<=0 → 允许相对校验（LibreTV 语义）', S.validateSegment(seg('opening', 0, 90), 0, []) === null);
  t('非法 type → 中文错误', isErr(S.validateSegment(seg('nope', 0, 90), 1300, [])));
  t('NaN 时间 → 中文错误', isErr(S.validateSegment(seg('middle', NaN, 150), 1300, [])));
  t('负起点 → 中文错误', isErr(S.validateSegment(seg('middle', -1, 150), 1300, [])));
  t('超出片长 → 中文错误', isErr(S.validateSegment(seg('middle', 100, 2000), 1300, [])));
  t('segment 为 null → 中文错误', isErr(S.validateSegment(null, 1300, [])));
  t('existing 缺省不抛错', S.validateSegment(seg('opening', 0, 90), 1300) === null);
  t('existing 含损坏项不误判', S.validateSegment(seg('middle', 100, 150), 1300, [null, { start: NaN, end: 1 }]) === null);
}

console.log('\n[8] 纯函数：不修改入参 / 模块形态静态检查');
{
  const raw = {
    enabled: true,
    marks: { k: { segments: [seg('opening', 0, 90), seg('ending', 1200, -1)], enabled: true, updatedAt: 7 } }
  };
  const before = JSON.stringify(raw);
  S.migrateSkipMarks(raw);
  t('migrateSkipMarks 不修改入参（深比较）', JSON.stringify(raw) === before);

  const mark = { enabled: true, segments: [seg('ending', 1200, -1), seg('opening', 0, 90)] };
  const beforeMark = JSON.stringify(mark);
  S.resolveSegments(mark, 1300);
  t('resolveSegments 不修改入参（含不排序原数组）', JSON.stringify(mark) === beforeMark);

  const segList = [Object.freeze(seg('opening', 0, 90))];
  S.findActiveSegment(segList, 50);
  S.findCrossedEnding(segList, 0, 5);
  t('find* 不修改入参', segList.length === 1 && segList[0].start === 0);

  const existing = [Object.freeze(seg('opening', 0, 90))];
  S.validateSegment(Object.freeze(seg('middle', 100, 150)), 1300, existing);
  t('validateSegment 不修改入参', existing.length === 1 && existing[0].end === 90);

  const frozenRaw = deepFreeze({
    enabled: true,
    marks: { k: { segments: [seg('opening', 0, 90), seg('ending', 1200, -1)], enabled: true, updatedAt: 7 } }
  });
  const frozenMark = deepFreeze({ enabled: true, segments: [seg('opening', 0, 90)] });
  let threw = false;
  try {
    S.migrateSkipMarks(frozenRaw);
    S.resolveSegments(frozenMark, 1300);
    S.findActiveSegment(deepFreeze([seg('opening', 0, 90)]), 50);
    S.findCrossedEnding(deepFreeze([seg('ending', 1200, 1300)]), 1199, 1201);
    S.validateSegment(deepFreeze(seg('opening', 0, 90)), 1300, deepFreeze([]));
  } catch (e) { threw = true; }
  t('深度冻结入参下全部函数不抛错', !threw);

  const src = readFileSync(new URL('../js/skip-marks.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n').trim();
  t('模块顶层是立即执行函数（IIFE）包裹', code.indexOf('(function') === 0, code.slice(0, 40));
  t('IIFE 双环境导出收尾', /typeof window !== 'undefined' \? window : globalThis/.test(src));
  t('无顶层 import/export', !/^\s*(import|export)\b/m.test(src));
  t('不触碰页面元素', !/\bdocument\b/.test(src));
  t('不读写本地存储', !/\blocalStorage\b|\bsessionStorage\b/.test(src));
  t('不设定时器', !/\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b/.test(src));
  t('不发请求', !/\bfetch\s*\(|\bXMLHttpRequest\b/.test(src) && src.indexOf('/api/proxy?url=') === -1);
  t('Node 环境下经全局对象取到导出', typeof globalThis.WDTVSkipMarks === 'object');
}

console.log('\n[回归] 占位标题隔离 / v3 迁移脏数据');
{
  t('回归：player.js 缺省标题「未知视频」走 fallback 键',
    S.skipMarkKey('未知视频', 'ffzy_123') === 'ffzy_123', S.skipMarkKey('未知视频', 'ffzy_123'));
  t('回归：不同影片的无标题记录互不串标记',
    S.skipMarkKey('未知视频', 'ffzy_1') !== S.skipMarkKey('未知视频', 'ffzy_2'));
  const dirty = S.migrateSkipMarks({ enabled: true, marks: { k: { introEnd: 0, outroStart: 0 } } });
  t('回归：outroStart=0 不迁移成整集片尾',
    !dirty.marks.k || !dirty.marks.k.segments || dirty.marks.k.segments.length === 0,
    JSON.stringify(dirty.marks.k));
}

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
