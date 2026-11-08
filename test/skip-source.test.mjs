// WDTV 片头片尾取数层 自测（Node ESM，零依赖，不随部署）
// 运行：node test/skip-source.test.mjs
// 覆盖：内置双源并发、时间轴对齐合并、冲突取舍、置信度两档、部分数据降级、
//       本地历史兼容、超时/失败静默降级、缓存、真实 IntroDB 返回结构。

const store = Object.create(null);
globalThis.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; }
};

await import('../js/skip-marks.js');
await import('../js/skip-source.js');

const SS = globalThis.WDTVSkipSource;
const SM = globalThis.WDTVSkipMarks;
let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}
function setLocalMarks(key, segments) {
  store['wdtvSkipMarks'] = JSON.stringify({
    enabled: true,
    marks: { [key]: { segments: segments, enabled: true, updatedAt: 1 } }
  });
}
// 按 URL 片段路由的 fetch 桩：返回 {ok,json} 或网络错误
function makeFetch(routes) {
  const calls = [];
  const fn = function (url) {
    calls.push(url);
    for (let i = 0; i < routes.length; i++) {
      const frag = routes[i][0];
      if (String(url).indexOf(frag) !== -1) {
        const val = routes[i][1];
        if (val instanceof Error) return Promise.reject(val);
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(val); } });
      }
    }
    return Promise.resolve({ ok: false, status: 404, json: function () { return Promise.resolve({}); } });
  };
  fn.calls = calls;
  return fn;
}
function baseOpts(extra) {
  return Object.assign({
    enabled: true,
    timeoutMs: 100,
    key: 't:测试剧',
    title: '测试剧',
    episode: 1,
    duration: 1300,
    localStorageKey: 'wdtvSkipMarks'
  }, extra || {});
}

console.log('\n[0] 导出与阈值集中配置');
{
  t('全局导出存在', !!SS && typeof SS.resolve === 'function');
  ['normalizePayload', 'normalizeSegment', 'mergeAligned', 'applyCoverage', 'isStrongEvidence', 'readLocalSegments'].forEach(function (n) {
    t('导出函数 ' + n, typeof SS[n] === 'function');
  });
  t('高置信阈值集中在一处', SS.CONFIG.highConfidence === 0.8 && SS.CONFIG.minVotes === 3 &&
    SS.CONFIG.minSources === 2 && SS.CONFIG.lowConfidenceMax === 0.79 &&
    SS.CONFIG.strongSingleVotes === 5 && SS.CONFIG.strongSingleConfidence === 0.9);
  t('内置两源（公共库 + IntroDB）且无用户可配置地址',
    SS.SOURCES.length === 2 && SS.SOURCES[0].path === '/api/skip-marks' &&
    SS.SOURCES[1].path === '/api/skip-marks/introdb');
}

console.log('\n[1] 结构归一：兼容 intro/outro 与 start_sec/end_sec');
{
  const list = SS.normalizePayload({
    segments: [
      { type: 'intro', start: 6, end: 105, confidence: 1, votes: 2, sources: ['introdb'] },
      { type: 'outro', start_sec: 3252, end_sec: 3320, confidence: 1, submission_count: 1, sources: ['introdb'] },
      { type: 'opening', start: 7, end: 104, confidence: 0.4, votes: 9, sources: ['x'] },
      { type: 'bad', start: 0, end: 10 },
      { type: 'ending', start: 100, end: 50 },
      null
    ]
  }, 'introdb');
  t('intro/outro 映射为 opening/ending', list.length === 2 &&
    list[0].type === 'opening' && list[0].start === 7 && list[1].type === 'ending');
  t('start_sec/end_sec 与 submission_count 被识别', list[1].start === 3252 && list[1].end === 3320 && list[1].votes === 1);
  t('同类型只留证据更强的一条', list[0].sources.indexOf('x') !== -1 || list[0].votes === 9);
}

console.log('\n[2] 覆盖度与置信度：两类齐全才可能自动跳');
{
  const bothStrong = SS.applyCoverage([
    { type: 'opening', start: 0, end: 90, confidence: 0.95, votes: 8, sources: ['a', 'b'], origin: 'public' },
    { type: 'ending', start: 1200, end: 1300, confidence: 0.95, votes: 8, sources: ['a', 'b'], origin: 'public' }
  ]);
  t('两类 + 多来源高投票 → 自动', bothStrong.every(function (s) { return s.autoEligible === true; }));

  const weak = SS.applyCoverage([
    { type: 'opening', start: 0, end: 90, confidence: 0.95, votes: 1, sources: ['a'], origin: 'public' },
    { type: 'ending', start: 1200, end: 1300, confidence: 0.95, votes: 1, sources: ['a'], origin: 'public' }
  ]);
  t('两类 + 单一弱证据 → 只给按钮', weak.every(function (s) { return s.autoEligible === false; }));

  const singleStrong = SS.applyCoverage([
    { type: 'opening', start: 0, end: 90, confidence: 0.95, votes: 6, sources: ['introdb'], origin: 'introdb' },
    { type: 'ending', start: 1200, end: 1300, confidence: 0.95, votes: 6, sources: ['introdb'], origin: 'introdb' }
  ]);
  t('两类 + 单一权威来源（投票 6 / 置信 0.95）→ 自动', singleStrong.every(function (s) { return s.autoEligible === true; }));

  const partial = SS.applyCoverage([
    { type: 'opening', start: 0, end: 90, confidence: 0.99, votes: 9, sources: ['a', 'b', 'c'], origin: 'public' }
  ]);
  t('只有片头 → 降级按钮且置信度封顶', partial[0].autoEligible === false &&
    partial[0].confidence <= SS.CONFIG.lowConfidenceMax);

  const localBoth = SS.applyCoverage([
    { type: 'opening', start: 0, end: 90, confidence: 0.95, votes: 1, sources: ['local'], origin: 'local' },
    { type: 'ending', start: 1200, end: 1300, confidence: 0.95, votes: 1, sources: ['local'], origin: 'local' }
  ]);
  t('本地完整历史 → 保留自动跳兼容', localBoth.every(function (s) { return s.autoEligible === true; }));

  const localOne = SS.applyCoverage([
    { type: 'opening', start: 0, end: 90, confidence: 0.95, votes: 1, sources: ['local'], origin: 'local' }
  ]);
  t('本地只有片头 → 按钮', localOne[0].autoEligible === false);
}

console.log('\n[3] 多源对齐：秒级容差合并 / 冲突取多来源高投票');
{
  const aligned = SS.mergeAligned([
    [
      { type: 'opening', start: 0, end: 31, confidence: 0.9, votes: 1, sources: ['public'], origin: 'public' },
      { type: 'ending', start: 1353, end: 1400, confidence: 0.9, votes: 1, sources: ['public'], origin: 'public' }
    ],
    [
      { type: 'opening', start: 1, end: 30, confidence: 0.95, votes: 6, sources: ['introdb'], origin: 'introdb' },
      { type: 'ending', start: 1354, end: 1399, confidence: 0.95, votes: 6, sources: ['introdb'], origin: 'introdb' }
    ]
  ]);
  t('容差内同一片段被合并为一条', aligned.length === 2);
  t('合并后来源去重为两个', aligned[0].sources.length === 2 &&
    aligned[0].sources.indexOf('public') !== -1 && aligned[0].sources.indexOf('introdb') !== -1);

  const mergedCoverage = SS.applyCoverage(aligned);
  t('两源一致 → 可自动跳', mergedCoverage.every(function (s) { return s.autoEligible === true; }));

  const conflict = SS.mergeAligned([
    [
      { type: 'opening', start: 0, end: 30, confidence: 0.7, votes: 2, sources: ['public'], origin: 'public' }
    ],
    [
      { type: 'opening', start: 20, end: 90, confidence: 0.9, votes: 9, sources: ['introdb'], origin: 'introdb' }
    ]
  ]);
  t('超出容差视为两组冲突，只保留一组', conflict.length === 1 && conflict[0].start === 20);

  const conflict2 = SS.mergeAligned([
    [
      { type: 'opening', start: 0, end: 30, confidence: 0.7, votes: 2, sources: ['a', 'b'], origin: 'public' },
      { type: 'opening', start: 60, end: 90, confidence: 0.99, votes: 20, sources: ['c'], origin: 'introdb' }
    ]
  ]);
  t('冲突时来源数优先于投票数', conflict2.length === 1 && conflict2[0].start === 0);

  const misalignedEnd = SS.mergeAligned([
    [
      { type: 'ending', start: 1200, end: 1300, confidence: 0.9, votes: 4, sources: ['a'], origin: 'public' },
      { type: 'ending', start: 1200, end: 1400, confidence: 0.9, votes: 4, sources: ['b'], origin: 'introdb' }
    ]
  ]);
  t('起止任一项超出容差不合并', misalignedEnd[0].sources.length === 1);
}

console.log('\n[4] resolve：内置双源并发 + 静默降级 + 缓存');
{
  SS.clearCache();
  delete store['wdtvSkipMarks'];
  const disabledFetch = makeFetch([]);
  const off = await SS.resolve(baseOpts({ enabled: false, fetchImpl: disabledFetch }));
  t('开关关闭 → 零请求、空列表', off.segments.length === 0 && off.source === 'disabled' && disabledFetch.calls.length === 0);

  SS.clearCache();
  const fallback = await SS.resolve(baseOpts({
    key: 'source_123', title: '未知视频', fetchImpl: makeFetch([])
  }));
  t('标题无效（fallback 键）→ 不请求、不抛错', fallback.segments.length === 0 && fallback.source === 'none');

  SS.clearCache();
  const bothFetch = makeFetch([
    ['introdb', {
      segments: [
        { type: 'opening', start: 0, end: 31, confidence: 1, votes: 6, sources: ['introdb'], origin: 'introdb' },
        { type: 'ending', start: 1353, end: 1400, confidence: 1, votes: 6, sources: ['introdb'], origin: 'introdb' }
      ]
    }],
    ['/api/skip-marks', {
      segments: [
        { type: 'opening', start: 1, end: 30, confidence: 0.8, votes: 4, sources: ['wdtv'], origin: 'wdtv' },
        { type: 'ending', start: 1354, end: 1399, confidence: 0.8, votes: 4, sources: ['wdtv'], origin: 'wdtv' }
      ]
    }]
  ]);
  const hit = await SS.resolve(baseOpts({ key: 't:双源剧', title: '双源剧', fetchImpl: bothFetch }));
  t('双源并发请求（两次）', bothFetch.calls.length === 2);
  t('双源对齐合并后自动跳', hit.segments.length === 2 && hit.segments.every(function (s) { return s.autoEligible === true; }));
  t('合并后来源包含两个数据源', hit.segments[0].sources.length === 2);

  const cached = await SS.resolve(baseOpts({ key: 't:双源剧', title: '双源剧', fetchImpl: bothFetch }));
  t('同片名+季集+片长二次查询走缓存', cached.source === 'cache' && bothFetch.calls.length === 2);

  SS.clearCache();
  const seasonFetch = makeFetch([]);
  await SS.resolve(baseOpts({ key: 't:某剧第二季', title: '某剧 第二季', episode: 3, fetchImpl: seasonFetch }));
  t('片名中的季号进入请求参数', seasonFetch.calls.length === 2 &&
    seasonFetch.calls.every(function (u) { return u.indexOf('season=2') !== -1; }));

  SS.clearCache();
  const oneFetch = makeFetch([
    ['introdb', { segments: [{ type: 'opening', start: 5, end: 92, confidence: 1, votes: 1, sources: ['introdb'] }] }],
    ['/api/skip-marks', { segments: [] }]
  ]);
  const one = await SS.resolve(baseOpts({ key: 't:单片头', title: '单片头', fetchImpl: oneFetch }));
  t('只有片头 → 按钮档、不自动', one.segments.length === 1 && one.segments[0].autoEligible === false);

  SS.clearCache();
  const failFetch = makeFetch([
    ['introdb', new Error('network down')],
    ['/api/skip-marks', new Error('db down')]
  ]);
  const allFail = await SS.resolve(baseOpts({ key: 't:全失败', title: '全失败', fetchImpl: failFetch }));
  t('全部失败 → 空列表、不抛错、error 为空', allFail.segments.length === 0 && allFail.error === null);

  SS.clearCache();
  const slowFetch = function () { return new Promise(function () { }); };
  const timeout = await SS.resolve(baseOpts({ key: 't:超时', title: '超时', timeoutMs: 20, fetchImpl: slowFetch }));
  t('超时 → 空列表、不抛错', timeout.segments.length === 0);

  SS.clearCache();
  setLocalMarks('t:本地补齐', [{ type: 'ending', start: 1200, end: -1 }]);
  const fillFetch = makeFetch([
    ['introdb', { segments: [{ type: 'opening', start: 0, end: 31, confidence: 1, votes: 6, sources: ['introdb'] }] }],
    ['/api/skip-marks', { segments: [] }]
  ]);
  const filled = await SS.resolve(baseOpts({ key: 't:本地补齐', title: '本地补齐', fetchImpl: fillFetch }));
  t('远程只有片头 + 本地片尾 → 两类齐全', filled.segments.length === 2 &&
    filled.segments[0].type === 'opening' && filled.segments[1].type === 'ending');
}

console.log('\n[5] 两档跳转场景矩阵（取数 → 时间轴解析 → 自动/按钮分流）');
{
  const dur = 1300;
  function classify(list) {
    const resolved = SM.resolveSegments({ segments: list, enabled: true }, dur);
    return {
      resolved: resolved,
      auto: resolved.filter(function (s) { return s.autoEligible === true; }),
      prompt: resolved.filter(function (s) { return s.autoEligible !== true; })
    };
  }

  const high = classify(SS.applyCoverage([
    { type: 'opening', start: 0, end: 90, confidence: 0.95, votes: 8, sources: ['a', 'b'], origin: 'public' },
    { type: 'ending', start: 1200, end: 1300, confidence: 0.95, votes: 8, sources: ['a', 'b'], origin: 'public' }
  ]));
  t('高置信 → 全部进入自动档', high.auto.length === 2 && high.prompt.length === 0);
  const dHigh = SM.decideAutoSkip({ position: 1, duration: dur, segments: high.auto, previousPosition: 0, now: 10000, lastSkipAt: 0 });
  t('高置信 → 播到 1s 自动跳到片头终点 90s', !!dHigh && dHigh.target === 90);

  const low = classify(SS.applyCoverage([
    { type: 'opening', start: 0, end: 90, confidence: 0.5, votes: 1, sources: ['a'], origin: 'public' },
    { type: 'ending', start: 1200, end: 1300, confidence: 0.5, votes: 1, sources: ['a'], origin: 'public' }
  ]));
  t('低置信 → 自动档为空、只留按钮档', low.auto.length === 0 && low.prompt.length === 2);
  const dLow = SM.decideAutoSkip({ position: 1, duration: dur, segments: low.auto, previousPosition: 0, now: 10000, lastSkipAt: 0 });
  t('低置信 → 不自动 seek', dLow === null);

  const none = classify(SS.applyCoverage([]));
  t('无数据 → 两档都为空、不抛错', none.auto.length === 0 && none.prompt.length === 0);

  const dSuppressed = SM.decideAutoSkip({
    position: 1, duration: dur, segments: high.auto, suppressedKeys: ['opening:0'],
    previousPosition: 0, now: 10000, lastSkipAt: 0
  });
  t('撤销后本集不再自动跳该段', dSuppressed === null);
}

console.log('\n[6] 真实 IntroDB 返回结构（2026-11 实测抓取）');
{
  // 实际 GET https://api.introdb.app/segments?imdb_id=tt0386676&season=1&episode=1
  const real = {
    imdb_id: 'tt0386676', media_type: 'tv', is_movie: false, season: 1, episode: 1,
    intro: { start_sec: 0, end_sec: 31, start_ms: 0, end_ms: 31000, confidence: 1, submission_count: 1 },
    recap: null,
    outro: { start_sec: 1353, end_sec: 1400, start_ms: 1353000, end_ms: 1400000, confidence: 1, submission_count: 1 },
    post_credits: null, no_intro: false, no_recap: false, no_outro: false
  };
  const segs = SS.normalizePayload({ segments: [
    { type: 'opening', start: real.intro.start_sec, end: real.intro.end_sec, confidence: real.intro.confidence, votes: real.intro.submission_count, sources: ['introdb'] },
    { type: 'ending', start: real.outro.start_sec, end: real.outro.end_sec, confidence: real.outro.confidence, votes: real.outro.submission_count, sources: ['introdb'] }
  ] }, 'introdb');
  const cov = SS.applyCoverage(segs);
  t('真实结构解析出片头 0-31 / 片尾 1353-1400', cov.length === 2 &&
    cov[0].start === 0 && cov[0].end === 31 && cov[1].start === 1353 && cov[1].end === 1400);
  t('单次提交的单一来源 → 按钮档（不自动）', cov.every(function (s) { return s.autoEligible === false; }));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
