// 片头片尾只读服务端接口自测（Node ESM，零依赖，不随部署）
// 运行：node test/skip-api.test.mjs
// 覆盖：IntroDB 真实返回结构解析、IMDb 标题解析、D1 公共表命中、
//       全部失败静默降级、POST 被拒绝（无上传入口）。

import { handleApi } from '../functions/api/_lib.mjs';

let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

const realFetch = globalThis.fetch;
let calls = [];
function stubFetch(routes) {
  calls = [];
  globalThis.fetch = async function (url) {
    calls.push(String(url));
    for (const [frag, value] of routes) {
      if (String(url).indexOf(frag) !== -1) {
        if (value instanceof Error) throw value;
        return { ok: true, status: 200, json: async () => value };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
function fakeDb(rows) {
  return {
    prepare() {
      return { bind() { return { all: async () => ({ results: rows }) }; } };
    }
  };
}
async function call(path, env) {
  const res = await handleApi(new Request('http://localhost' + path), env || {});
  const body = await res.json();
  return { status: res.status, body };
}

console.log('\n[1] 第三方源：IMDb 解析 + IntroDB 真实返回结构');
{
  stubFetch([
    ['suggestion/x/', { d: [
      { id: 'tt0386676', l: 'The Office', qid: 'tvSeries', y: 2005 },
      { id: 'tt9999999', l: 'Unrelated', qid: 'feature', y: 2020 }
    ] }],
    ['api.introdb.app/segments', {
      imdb_id: 'tt0386676', media_type: 'tv', is_movie: false, season: 1, episode: 1,
      intro: { start_sec: 0, end_sec: 31, confidence: 1, submission_count: 1 },
      recap: null,
      outro: { start_sec: 1353, end_sec: 1400, confidence: 1, submission_count: 1 },
      post_credits: null, no_intro: false, no_recap: false, no_outro: false
    }]
  ]);
  const r = await call('/api/skip-marks/introdb?title=The%20Office&episode=1');
  t('HTTP 200 且命中 tt0386676', r.status === 200 && r.body.imdb_id === 'tt0386676');
  t('解析出片头 0-31 与片尾 1353-1400', r.body.segments.length === 2 &&
    r.body.segments[0].type === 'opening' && r.body.segments[0].start === 0 && r.body.segments[0].end === 31 &&
    r.body.segments[1].type === 'ending' && r.body.segments[1].start === 1353);
  t('携带来源与投票数', r.body.segments[0].sources.indexOf('introdb') !== -1 &&
    r.body.segments[0].votes === 1 && r.body.segments[0].confidence === 1);
  t('请求参数按季集拼接', calls.some((u) => u.indexOf('season=1') !== -1 && u.indexOf('episode=1') !== -1));
}

console.log('\n[2] 第三方源：中文片名可解析（陈情令 → The Untamed）');
{
  stubFetch([
    ['suggestion/x/', { d: [{ id: 'tt10554898', l: 'The Untamed', qid: 'tvSeries', y: 2019 }] }],
    ['api.introdb.app/segments', {
      imdb_id: 'tt10554898', intro: null, recap: null, outro: null, post_credits: null,
      no_intro: false, no_recap: false, no_outro: false
    }]
  ]);
  const r = await call('/api/skip-marks/introdb?title=' + encodeURIComponent('陈情令 第01集') + '&episode=1');
  t('中文标题命中 IMDb', r.status === 200 && r.body.imdb_id === 'tt10554898');
  t('无片头片尾数据 → 空列表、无异常', Array.isArray(r.body.segments) && r.body.segments.length === 0);
}

console.log('\n[3] 公共库：D1 只读命中');
{
  const rows = [
    { title_key: 't:theoffice', title: 'The Office', season: 1, episode: 1, segment_type: 'opening', start_sec: 0, end_sec: 31, votes: 5, sources: 'wdtv', origin: 'wdtv', confidence: 0.9 },
    { title_key: 't:theoffice', title: 'The Office', season: 1, episode: 1, segment_type: 'ending', start_sec: 1353, end_sec: 1400, votes: 5, sources: 'wdtv', origin: 'wdtv', confidence: 0.9 },
    { title_key: 't:theoffice', title: 'The Office', season: 1, episode: 2, segment_type: 'opening', start_sec: 0, end_sec: 30, votes: 5, sources: 'wdtv', origin: 'wdtv', confidence: 0.9 }
  ];
  const r = await call('/api/skip-marks?title=The%20Office&episode=1', { WDTV_DB: fakeDb(rows) });
  t('HTTP 200 db:true', r.status === 200 && r.body.db === true);
  t('按集过滤后命中两段', r.body.segments.length === 2 &&
    r.body.segments[0].type === 'opening' && r.body.segments[1].type === 'ending');
  t('公共库段带来源与投票', r.body.segments[0].sources.indexOf('wdtv') !== -1 && r.body.segments[0].votes === 5);

  const r2 = await call('/api/skip-marks?key=t%3Atheoffice&episode=2', { WDTV_DB: fakeDb(rows) });
  t('仅传 key 也能查询且第 2 集只返回片头', r2.body.segments.length === 1 && r2.body.segments[0].end === 30);
}

console.log('\n[4] 全部失败：静默降级为空');
{
  stubFetch([
    ['suggestion/x/', new Error('network down')],
    ['api.introdb.app/segments', new Error('network down')]
  ]);
  const r = await call('/api/skip-marks/introdb?title=NoSuchShow123&episode=1');
  t('外部全失败 → 200 空列表、不抛 500', r.status === 200 && r.body.segments.length === 0);

  const r2 = await call('/api/skip-marks?title=NoSuchShow123&episode=1', {});
  t('D1 未绑定 → 200 空列表 db:false', r2.status === 200 && r2.body.segments.length === 0 && r2.body.db === false);

  const r3 = await call('/api/skip-marks?title=NoSuchShow123&episode=1', {
    WDTV_DB: { prepare() { throw new Error('no such table: skip_marks_public'); } }
  });
  t('表不存在（旧库未建表）→ 200 空列表、不抛 500', r3.status === 200 && r3.body.segments.length === 0);
}

console.log('\n[5] 只读约束：不提供上传/写入');
{
  const res = await handleApi(new Request('http://localhost/api/skip-marks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ segments: [] })
  }), {});
  t('POST /api/skip-marks → 405', res.status === 405);
  const res2 = await handleApi(new Request('http://localhost/api/skip-marks/introdb', { method: 'PUT' }), {});
  t('PUT /api/skip-marks/introdb → 405', res2.status === 405);
}

globalThis.fetch = realFetch;

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
