// WDTV 批次 2 自测（Node ESM，零依赖，不随部署）
// 覆盖：js/remarks.js 备注归一 + js/aggregate.js 跨源同名聚合（纯函数、不改入参）
// 运行：node test/aggregate.test.mjs
import '../js/remarks.js';
import '../js/aggregate.js';

const R = globalThis.WDTVRemarks;
const G = globalThis.WDTVGroup;
let pass = 0, fail = 0;
const fails = [];

function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

// 合成一条 MacCMS 搜索结果（字段与 js/search.js 注入后一致）
let seq = 0;
function item(name, code, extra) {
  seq++;
  return Object.assign({
    vod_name: name,
    vod_id: 'v' + seq,
    source_code: code,
    source_name: code,
    type_name: '电视剧',
    vod_remarks: '',
    vod_pic: 'https://pic.example.com/' + seq + '.jpg'
  }, extra || {});
}

console.log('\n[1] 同名多源聚合');
{
  const list = [
    item('庆余年', 'zy', { vod_remarks: '全34集' }),
    item('庆余年', 'bf', { vod_remarks: '已完结' }),
    item('庆余年', 'hk', { vod_remarks: '更新至30集' })
  ];
  const groups = G.aggregateResults(list);
  t('多源：聚成 1 组', groups.length === 1, JSON.stringify(groups.map(g => g.key)));
  t('多源：组内 3 条', groups[0].items.length === 3);
  t('多源：name 为原始可读片名', groups[0].name === '庆余年');
  t('多源：remarks 汇总为总集数', groups[0].remarks === '全34集', String(groups[0].remarks));
}

console.log('\n[2] 归一化片名（跨标点差异）');
{
  const list = [
    item('摔跤吧!爸爸', 'a'),
    item('摔跤吧！爸爸', 'b'),
    item('摔跤吧 爸爸', 'c')
  ];
  const groups = G.aggregateResults(list);
  t('标点/空白差异：聚成 1 组', groups.length === 1, JSON.stringify(groups.map(g => g.key)));
  t('归一化：三种写法等价', G.normalizeTitle('摔跤吧!爸爸') === G.normalizeTitle('摔跤吧！爸爸')
    && G.normalizeTitle('摔跤吧!爸爸') === G.normalizeTitle('摔跤吧 爸爸'));
  t('归一化：幂等', G.normalizeTitle(G.normalizeTitle('摔 跤!吧')) === G.normalizeTitle('摔 跤!吧'));
  t('归一化：大小写与标点/书名号差异被去掉',
    G.normalizeTitle('《Iron·Man》') === G.normalizeTitle('ironman'));
  t('归一化：不同片名不会误判为相同', G.normalizeTitle('庆余年') !== G.normalizeTitle('琅琊榜'));
}

console.log('\n[3] 年份拆桶（同名翻拍）');
{
  const list = [
    item('倚天屠龙记', 'a', { vod_year: '2019' }),
    item('倚天屠龙记', 'b', { vod_year: '2003' }),
    item('倚天屠龙记', 'c', { vod_year: '2019' }),
    item('倚天屠龙记', 'd', {}) // 无年份
  ];
  const groups = G.aggregateResults(list);
  t('年份：拆成 3 组（2019 / 2003 / 无年份）', groups.length === 3, JSON.stringify(groups.map(g => g.key)));
  const y2019 = groups.find(g => g.year === '2019');
  const y2003 = groups.find(g => g.year === '2003');
  const noYear = groups.find(g => g.year === undefined);
  t('年份：2019 桶含 2 条', !!y2019 && y2019.items.length === 2);
  t('年份：2003 桶含 1 条', !!y2003 && y2003.items.length === 1);
  t('年份：无年份单独成组', !!noYear && noYear.items.length === 1);
  t('年份：各桶 key 互不相同', new Set(groups.map(g => g.key)).size === 3);
}

console.log('\n[4] 仅一个年份：无年份条目并入该桶');
{
  const list = [
    item('琅琊榜', 'a', { vod_year: '2015' }),
    item('琅琊榜', 'b', {}),
    item('琅琊榜', 'c', { year: '2015' })
  ];
  const groups = G.aggregateResults(list);
  t('单年份：只成 1 组', groups.length === 1, JSON.stringify(groups.map(g => g.key)));
  t('单年份：无年份条目并入（3 条）', groups[0].items.length === 3);
  t('单年份：year=2015', groups[0].year === '2015');
}

console.log('\n[5] 单条成组 / 组内按 source_name 排序 / key 稳定');
{
  const single = G.aggregateResults([item('独行月球', 'only')]);
  t('单条：也成 1 组', single.length === 1 && single[0].items.length === 1);

  const list = [item('三体', 'C'), item('三体', 'A'), item('三体', 'B')];
  const g = G.aggregateResults(list)[0];
  t('排序：组内按 source_name 升序', g.items.map(i => i.source_name).join(',') === 'A,B,C',
    g.items.map(i => i.source_name).join(','));

  const again = G.aggregateResults(list)[0];
  t('key：同一输入两次调用稳定', g.key === again.key);
  t('key：不含易变 URL', !/https?:\/\//.test(g.key));
  t('key：不含源内剧级键', !g.key.includes('v') || !/_v\d/.test(g.key));
  const other = G.aggregateResults([item('三体2', 'A')])[0];
  t('key：不同片名 key 不同', g.key !== other.key);
}

console.log('\n[6] 空数组 / 非数组 / 畸形 item 不抛错');
{
  t('空数组：返回空', Array.isArray(G.aggregateResults([])) && G.aggregateResults([]).length === 0);
  t('非数组：null 返回空', G.aggregateResults(null).length === 0);
  t('非数组：undefined 返回空', G.aggregateResults(undefined).length === 0);
  let ok = true, out;
  try {
    out = G.aggregateResults([null, undefined, {}, { vod_name: null }, { vod_name: '!!!' }, 42]);
  } catch (e) { ok = false; console.log('  抛出：' + e.message); }
  t('畸形 item：不抛异常', ok);
  t('畸形 item：仍返回数组', ok && Array.isArray(out));
}

console.log('\n[7] formatRemarks 归一（全N集 / 更新至N / 已完结 / 原样）');
{
  const cases = [
    ['全34集', '全34集'],
    ['共24集', '全24集'],
    ['24集全', '全24集'],
    ['更新至12集', '更新至12集'],
    ['第12集', '更新至12集'],
    ['12集', '更新至12集'],
    ['已完结', '已完结'],
    ['完结', '已完结'],
    ['全集', '已完结'],
    ['HD国语', 'HD国语'],
    ['正片', '正片']
  ];
  cases.forEach(([raw, want]) => {
    t('归一：' + raw + ' → ' + want, R.formatRemarks(raw) === want, String(R.formatRemarks(raw)));
  });
  t('归一：空返回 undefined', R.formatRemarks('') === undefined && R.formatRemarks(undefined) === undefined && R.formatRemarks(null) === undefined);
  t('归一：幂等（二次调用结果不变）', cases.every(([raw]) => {
    const once = R.formatRemarks(raw);
    return R.formatRemarks(once) === once;
  }));
  t('归一：数字入参不抛', R.formatRemarks(34) === '34');
}

console.log('\n[8] compactRemarks 紧凑备注');
{
  t('紧凑：更新至1277集 → 1277 集', R.compactRemarks('更新至1277集') === '1277 集');
  t('紧凑：全34集 → 34 集', R.compactRemarks('全34集') === '34 集');
  t('紧凑：单集不显示集数', R.compactRemarks('全1集') === undefined);
  t('紧凑：非集数备注原样', R.compactRemarks('HD国语') === 'HD国语');
  t('紧凑：空返回 undefined', R.compactRemarks('') === undefined);
}

console.log('\n[9] inferGroupRemarks 优先级（总集数 > 完结 > 进度）');
{
  t('优先级：总集数压过完结/进度', R.inferGroupRemarks(['全34集', '已完结', '更新至12集']) === '全34集');
  t('多个总集数取最大', R.inferGroupRemarks(['全30集', '全34集', '全28集']) === '全34集');
  t('完结压过进度', R.inferGroupRemarks(['已完结', '更新至12集']) === '已完结');
  t('仅进度 → 更新至N集', R.inferGroupRemarks(['更新至12集', '更新至8集']) === '更新至12集');
  t('仅非集数文案 → 取 fallback', R.inferGroupRemarks(['HD国语', '正片']) === 'HD国语');
  t('空数组 → undefined', R.inferGroupRemarks([]) === undefined);
  t('全空文案 → undefined', R.inferGroupRemarks([undefined, '', null]) === undefined);
  t('非数组入参不抛', R.inferGroupRemarks(null) === undefined);
}

console.log('\n[10] 扁平数组不被修改（长度 / 顺序 / 元素引用）');
{
  const a = item('狂飙', 'C', { vod_remarks: '全39集' });
  const b = item('狂飙', 'A');
  const c = item('狂飙', 'B');
  const list = [a, b, c];
  const lenBefore = list.length;
  const orderBefore = list.slice();
  const groups = G.aggregateResults(list);
  t('入参：长度不变', list.length === lenBefore);
  t('入参：顺序不变', list.every((it, i) => it === orderBefore[i]));
  t('入参：元素引用不变', list[0] === a && list[1] === b && list[2] === c);
  t('分组：items 是新数组（非入参本身）', groups[0].items !== list);
  t('分组：items 元素仍为原引用', groups[0].items.every(it => list.indexOf(it) !== -1));
  t('二次聚合结果一致', G.aggregateResults(list)[0].key === groups[0].key);
}

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
