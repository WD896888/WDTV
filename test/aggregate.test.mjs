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

// 合成 n 集的 MacCMS 播放列表（# 分隔单集）
function playUrl(n) {
  const segs = [];
  for (let i = 1; i <= n; i++) segs.push('第' + String(i).padStart(2, '0') + '集$https://v.example.com/' + i + '.m3u8');
  return segs.join('#');
}

console.log('\n[1] 同名多源聚合');
{
  const list = [
    item('庆余年', 'zy', { vod_remarks: '全34集', vod_play_url: playUrl(34) }),
    item('庆余年', 'bf', { vod_remarks: '已完结' }),
    item('庆余年', 'hk', { vod_remarks: '全34集', vod_play_url: playUrl(34) })
  ];
  const groups = G.aggregateResults(list);
  t('多源：聚成 1 组', groups.length === 1, JSON.stringify(groups.map(g => g.key)));
  t('多源：组内 3 条', groups[0].items.length === 3);
  t('多源：name 为原始可读片名', groups[0].name === '庆余年');
  t('多源：remarks 汇总为总集数', groups[0].remarks === '全34集', String(groups[0].remarks));
  t('多源：集数取到 34', groups[0].episodes === 34, String(groups[0].episodes));
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

console.log('\n[3] 年份不参与区分（只按片名 + 真实集数）');
{
  const list = [
    item('倚天屠龙记', 'a', { vod_year: '2019' }),
    item('倚天屠龙记', 'b', { vod_year: '2003' }),
    item('倚天屠龙记', 'c', { vod_year: '2019' }),
    item('倚天屠龙记', 'd', {}) // 无年份
  ];
  const groups = G.aggregateResults(list);
  t('年份：不同年份/无年份都合并成 1 组', groups.length === 1, JSON.stringify(groups.map(g => g.key)));
  t('年份：组内 4 条', groups[0].items.length === 4);
  t('年份：key 不含年份', !groups[0].key.includes('2019') && !groups[0].key.includes('2003'));

  const sameCount = G.aggregateResults([
    item('倚天屠龙记', 'a', { vod_year: '2019', vod_play_url: playUrl(40) }),
    item('倚天屠龙记', 'b', { vod_year: '2003', vod_play_url: playUrl(40) })
  ]);
  t('年份不同但真实集数相同：合并 1 组', sameCount.length === 1, JSON.stringify(sameCount.map(g => g.key)));

  const diffCount = G.aggregateResults([
    item('倚天屠龙记', 'a', { vod_year: '2019', vod_play_url: playUrl(50) }),
    item('倚天屠龙记', 'b', { vod_year: '2003', vod_play_url: playUrl(40) })
  ]);
  t('年份不同且真实集数不同：仍合并 1 组', diffCount.length === 1,
    JSON.stringify(diffCount.map(g => g.key)));
  t('年份不同且真实集数不同：组集数取最大值 50', diffCount[0].episodes === 50,
    String(diffCount[0].episodes));
}

console.log('\n[4] 无集数信息：只按片名合并');
{
  const list = [
    item('琅琊榜', 'a', { vod_year: '2015' }),
    item('琅琊榜', 'b', {}),
    item('琅琊榜', 'c', { year: '2015' })
  ];
  const groups = G.aggregateResults(list);
  t('无集数：合并 1 组', groups.length === 1, JSON.stringify(groups.map(g => g.key)));
  t('无集数：组内 3 条', groups[0].items.length === 3);
  t('无集数：episodes 为 undefined', groups[0].episodes === undefined);
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

console.log('\n[11] 真实集数匹配（只认播放列表实际集数）');
{
  t('集数：vod_play_url 单播放组 3 集',
    G.episodeCountOf(item('x', 'a', {
      vod_play_url: '第01集$https://v.example.com/1.m3u8#第02集$https://v.example.com/2.m3u8#第03集$https://v.example.com/3.m3u8'
    })) === 3);
  t('集数：多播放组取最大集数',
    G.episodeCountOf(item('x', 'a', {
      vod_play_url: 'A$https://v.example.com/1.m3u8#B$https://v.example.com/2.m3u8$$$C$https://v.example.com/3.m3u8'
    })) === 2);
  t('集数：非 http 段不算真实集数',
    G.episodeCountOf(item('x', 'a', { vod_play_url: '第01集#第02集$https://v.example.com/2.m3u8' })) === 1);
  t('集数：仅 vod_total 不参与（返回 undefined）',
    G.episodeCountOf(item('x', 'a', { vod_total: '61' })) === undefined);
  t('集数：备注「全34集」不参与（返回 undefined）',
    G.episodeCountOf(item('x', 'a', { vod_remarks: '全34集' })) === undefined);
  t('集数：备注「更新至30集」不参与（返回 undefined）',
    G.episodeCountOf(item('x', 'a', { vod_remarks: '更新至30集' })) === undefined);
  t('集数：无播放列表返回 undefined',
    G.episodeCountOf(item('x', 'a', { vod_remarks: '已完结' })) === undefined);
  t('集数：vod_total 不影响真实集数',
    G.episodeCountOf(item('x', 'a', {
      vod_play_url: 'A$https://v.example.com/1.m3u8#B$https://v.example.com/2.m3u8', vod_total: '9'
    })) === 2);

  const sameCount = G.aggregateResults([
    item('雪中悍刀行', 'a', { vod_year: '2021', vod_play_url: playUrl(38) }),
    item('雪中悍刀行', 'b', { vod_year: '2021', vod_play_url: playUrl(38) })
  ]);
  t('集数相同：同名合并 1 组', sameCount.length === 1 && sameCount[0].items.length === 2,
    JSON.stringify(sameCount.map(g => g.key)));

  const diffCount = G.aggregateResults([
    item('雪中悍刀行', 'a', { vod_year: '2021', vod_play_url: playUrl(38) }),
    item('雪中悍刀行', 'b', { vod_year: '2021', vod_play_url: playUrl(24) })
  ]);
  t('集数不同：同名仍合并 1 组', diffCount.length === 1, JSON.stringify(diffCount.map(g => g.key)));
  t('集数不同：组集数取最大值 38、组内 2 条',
    diffCount[0].episodes === 38 && diffCount[0].items.length === 2,
    String(diffCount[0].episodes) + '/' + diffCount[0].items.length);

  const unknownCount = G.aggregateResults([
    item('雪中悍刀行', 'a', { vod_year: '2021', vod_play_url: playUrl(38) }),
    item('雪中悍刀行', 'b', { vod_year: '2021', vod_remarks: '已完结' })
  ]);
  t('集数未知：并入真实集数桶（1 组）', unknownCount.length === 1 && unknownCount[0].items.length === 2,
    JSON.stringify(unknownCount.map(g => g.key)));
  t('集数未知：组集数为 38', unknownCount[0].episodes === 38);
}

console.log('\n[12] 搜索关联度排序（片名 ↔ 关键词）');
{
  const S = G.scoreRelevance;
  t('关联度：完全一致得满分', S('庆余年', '庆余年') === 10000);
  t('关联度：空白/标点/书名号/全角不影响完全一致',
    S('庆余年', ' 庆 余 年 ') === 10000 &&
    S('Ｉｒｏｎ Ｍａｎ', 'iron-man') === 10000 &&
    S('《庆余年》', '庆余年！') === 10000);
  t('关联度：季数写法归一（第二季 = 2 = 第2季）',
    S('庆余年2', '庆余年第二季') === 10000 &&
    S('庆余年第二季', '庆余年 第2季') === 10000 &&
    S('爱情公寓5', '爱情公寓 第五季') === 10000 &&
    S('the office 2', 'The Office Season 2') === 10000);

  const exact = S('庆余年', '庆余年');
  const prefix = S('庆余年', '庆余年第二季');
  const spin = S('庆余年', '庆余年之风起沧州');
  const contains = S('庆余年', '新庆余年');
  const fuzzy = S('唐探1900', '唐人街探案1900');
  const unrelated = S('庆余年', '大秦赋');
  t('关联度：精确 > 前缀 > 包含 > 模糊 > 无关',
    exact > prefix && prefix > contains && contains > fuzzy && fuzzy > unrelated,
    [exact, prefix, contains, fuzzy, unrelated].join(','));
  t('关联度：同前缀更短的标题更靠前',
    S('庆余年', '庆余年2') > S('庆余年', '庆余年之风起沧州'));
  t('关联度：关键词出现位置越靠前越高',
    S('狂飙', '狂飙人生') > S('狂飙', '全速狂飙'));
  t('关联度：季数版优先于长篇衍生',
    S('庆余年2', '庆余年第二季') > S('庆余年2', '庆余年之风起沧州'));
  t('关联度：只共享一个常用字不误判为相关',
    S('庆余年', '宝庆码头') === 0 && S('庆余年', '年') === 0);
  t('关联度：空关键词/空片名返回 0',
    S('', '庆余年') === 0 && S('庆余年', '') === 0 && S(null, null) === 0);
  t('关联度：关键词是片名前缀（搜第二季命中本片）仍有分数',
    S('庆余年第二季', '庆余年') > 0 && S('庆余年第二季', '庆余年') < exact);

  // 结尾年份：同一部剧只是源站标了上映年份，应接近完全一致，且高于季数/衍生剧
  const yearScore = S('庆余年', '庆余年 2019');
  t('年份：空格/括号/年字三种写法分数一致且接近完全一致',
    yearScore >= 9500 && yearScore < exact &&
    S('庆余年', '庆余年（2019）') === yearScore &&
    S('庆余年', '庆余年2019年') === yearScore);
  t('年份：同年份 > 同季数 > 衍生剧',
    yearScore > S('庆余年', '庆余年第二季') &&
    S('庆余年', '庆余年第二季') > S('庆余年', '庆余年之帝王业'));
  t('年份：查询带年份时 同年 > 无年份 > 不同年份',
    S('庆余年 2019', '庆余年 2019') === 10000 &&
    S('庆余年 2019', '庆余年') > S('庆余年 2019', '庆余年 2018') &&
    S('庆余年 2019', '庆余年 2018') > S('庆余年 2019', '庆余年之帝王业'));
  t('年份：片头年份/纯年份片名不被误当成后缀标注',
    S('庆余年', '1917：逆战') === 0 &&
    S('1942', '1942') === 10000 &&
    S('2001太空漫游', '2001太空漫游') === 10000);

  // 数字：阿拉伯 / 中文 / 大写中文 / 罗马 / Season / S 各种写法必须等价
  t('数字：各种季数写法等价',
    S('庆余年2', '庆余年 第2季') === 10000 &&
    S('庆余年2', '庆余年 第二季') === 10000 &&
    S('庆余年2', '庆余年 Ⅱ') === 10000 &&
    S('庆余年2', '庆余年 第Ⅱ季') === 10000 &&
    S('庆余年2', '庆余年 二') === 10000 &&
    S('庆余年2', '庆余年 二季') === 10000 &&
    S('庆余年II', '庆余年 第2季') === 10000 &&
    S('爱情公寓5', '爱情公寓 S5') === 10000 &&
    S('爱情公寓5', '爱情公寓 第五季') === 10000 &&
    S('the office 2', 'The Office Season 2') === 10000);
  t('数字：大写/金融中文数字（壹贰叁肆伍陆柒捌玖拾）等价',
    S('庆余年3', '庆余年叁') === 10000 &&
    S('庆余年3', '庆余年 第叁季') === 10000 &&
    S('庆余年3', '庆余年 叁季') === 10000 &&
    S('庆余年3', '庆余年 叁') === 10000 &&
    S('庆余年10', '庆余年拾') === 10000 &&
    S('庆余年12', '庆余年拾贰') === 10000 &&
    S('庆余年12', '庆余年 拾贰季') === 10000 &&
    S('庆余年12', '庆余年 第拾贰季') === 10000 &&
    S('庆余年23', '庆余年贰拾叁') === 10000 &&
    S('庆余年23', '庆余年貳拾叁') === 10000 &&
    S('庆余年伍', '庆余年5') === 10000 &&
    S('庆余年柒', '庆余年7') === 10000 &&
    S('庆余年玖', '庆余年9') === 10000 &&
    S('庆余年陆', '庆余年6') === 10000 &&
    S('庆余年', '庆余年拾') > S('庆余年', '庆余年之帝王业'));
  t('数字：大写/繁体字形在片名中与简体等价',
    S('三国演义', '叁国演义') === 10000 &&
    S('万里归途', '萬里归途') === 10000 &&
    S('陆小凤', '陸小凤') === 10000 &&
    S('伍佰', '伍佰') === 10000);
  t('年份：中文大写逐位年份等价',
    S('庆余年 2024', '庆余年 贰零贰肆') === 10000 &&
    S('庆余年', '庆余年 贰零贰肆') === S('庆余年', '庆余年 2024') &&
    S('庆余年', '庆余年 贰零贰肆年') === S('庆余年', '庆余年 2024年'));

  // 权重：同剧 > 同季 > 同剧语言/版本标签 > 衍生剧
  t('权重：完全一致 > 同年份 > 同季数 > 同季语言版 > 衍生剧',
    S('庆余年', '庆余年') > yearScore &&
    yearScore > S('庆余年', '庆余年第二季') &&
    S('庆余年', '庆余年第二季') > S('庆余年', '庆余年第二季粤语') &&
    S('庆余年', '庆余年第二季粤语') > S('庆余年', '庆余年之帝王业'));
  t('权重：同剧预告/解说仍高于前缀衍生剧',
    S('庆余年', '庆余年[电影解说]') > S('庆余年', '庆余年之帝王业') &&
    S('庆余年', '庆余年 第二季[预告片]') > S('庆余年', '庆余年之帝王业'));
  t('权重：查询带季数时 同季 > 总入口 > 其它季 > 衍生剧',
    S('庆余年 第二季', '庆余年 第二季') >
    S('庆余年 第二季', '庆余年') &&
    S('庆余年 第二季', '庆余年') >
    S('庆余年 第二季', '庆余年 第一季') &&
    S('庆余年 第二季', '庆余年 第一季') >
    S('庆余年 第二季', '庆余年之帝王业'));

  // 中文数字结尾按季数处理，但不能误伤成语/年份式片名
  t('权重：中文数字结尾按季数处理，成语片名不误伤',
    S('庆余年', '庆余年二') === S('庆余年', '庆余年第二季') &&
    S('庆余年', '庆余年二') > S('庆余年', '庆余年之帝王业') &&
    S('庆余年', '独一无二') === 0 &&
    S('独一无二', '独一无二') === 10000 &&
    S('一九四二', '一九四二') === 10000 &&
    S('庆余年', '一九四二') === 0);
  t('权重：罗马数字不误伤普通单词',
    S('庆余年', 'Civil') === 0 &&
    S('庆余年', 'Rocky IV') === 0 &&
    S('Rocky IV', 'Rocky IV') === 10000);
  t('权重：续作带副标题仍高于版本/解说（数字在副标题前）',
    S('碟中谍', '碟中谍8：最终清算') > S('碟中谍', '碟中谍[电影解说]') &&
    S('流浪地球', '流浪地球2：再次冒险') > S('流浪地球', '流浪地球之大夏战狼') &&
    S('流浪地球', '流浪地球2：再次冒险') < S('流浪地球', '流浪地球2') &&
    S('流浪地球', '流浪地球3（上）') > S('流浪地球', '流浪地球之大夏战狼') &&
    S('庆余年', '庆余年2之少年风流') > S('庆余年', '庆余年之少年风流'));
  t('权重：数字开头的正常片名不被误拆',
    S('7号房的礼物', '7号房的礼物') === 10000 &&
    S('五月天', '五月天') === 10000 &&
    S('12怒汉', '12怒汉') === 10000 &&
    S('云上', '云上') === 10000 &&
    S('叁', '叁') === 10000 &&
    S('万万没想到', '万万没想到') === 10000 &&
    S('庆余年', '7号房的礼物') === 0 &&
    S('庆余年', '五月天') === 0 &&
    S('庆余年', '叁') === 0);
  t('权重：标签剥离后露出的数字仍按季数处理',
    S('庆余年', '庆余年2粤语') === S('庆余年', '庆余年第二季粤语') &&
    S('庆余年', '庆余年2粤语') > S('庆余年', '庆余年之帝王业') &&
    S('庆余年', '庆余年2019全集') > S('庆余年', '庆余年第二季') &&
    S('avhd', 'avhd') === 10000);
  t('权重：纯标签/纯年份片名不会被拆空',
    S('第二季', '第二季') === 10000 &&
    S('高清', '高清') === 10000 &&
    S('2019', '2019') === 10000);

  const list = [
    item('庆余年之风起沧州', 'ffzy'),
    item('庆余年之帝王业', 'ffzy'),
    item('庆余年 第二季', 'ffzy'),
    item('庆余年 2019', 'lzi'),
    item('庆余年', 'jisu'),
    item('庆余年 Ⅱ', 'mdzy'),
    item('狂飙', 'mdzy')
  ];
  const groups = G.aggregateResults(list);
  const before = groups.map(g => g.name).join('|');
  const ranked = G.rankGroupsByRelevance(groups, '庆余年');
  t('排序：精确匹配第一、带年份第二',
    ranked[0].name === '庆余年' && ranked[1].name === '庆余年 2019',
    ranked.map(g => g.name).join(' / '));
  t('排序：季数写法变体合并为同一组且紧跟前列',
    ranked[2].name === '庆余年 第二季' && ranked[2].items.length === 2,
    ranked.map(g => g.name).join(' / '));
  t('排序：衍生剧排在所有同剧标记之后、无关结果沉底',
    ranked[3].name === '庆余年之帝王业' &&
    ranked[4].name === '庆余年之风起沧州' &&
    ranked[ranked.length - 1].name === '狂飙',
    ranked.map(g => g.name).join(' / '));
  t('排序：不修改入参数组顺序', groups.map(g => g.name).join('|') === before);

  // 同视频聚合不因排序而拆散：多源同名仍是一张卡，且源优先级不再影响列表顺序
  const multiGroups = G.aggregateResults([
    item('庆余年', 'jisu', { vod_play_url: playUrl(46) }),
    item('庆余年', 'ffzy', { vod_play_url: playUrl(46) }),
    item('狂飙', 'ffzy')
  ]);
  const multiRanked = G.rankGroupsByRelevance(multiGroups, '庆余年');
  t('聚合：排序后同视频组仍保留全部来源，优先级不参与列表排序',
    multiRanked[0].name === '庆余年' &&
    multiRanked[0].items.length === 2 &&
    multiRanked[1].name === '狂飙');

  const tieGroups = G.aggregateResults([
    item('庆余年', 'jisu', { vod_play_url: playUrl(40) }),
    item('庆余年', 'ffzy', { vod_play_url: playUrl(46) })
  ]);
  t('排序：同名不同集数合并为 1 组 2 条',
    tieGroups.length === 1 && tieGroups[0].items.length === 2,
    JSON.stringify(tieGroups.map(g => g.key)));
  t('排序：合并后组内按 source_name 排序', tieGroups[0].items.map(i => i.source_name).join(',') === 'ffzy,jisu',
    tieGroups[0].items.map(i => i.source_name).join(','));
  t('排序：合并后组集数取最大值 46', tieGroups[0].episodes === 46, String(tieGroups[0].episodes));

  const stableGroups = G.aggregateResults([
    item('庆余年', 'a', { vod_play_url: playUrl(40) }),
    item('庆余年', 'b', { vod_play_url: playUrl(46) })
  ]);
  t('排序：同分保持稳定且组内按 source_name 排序',
    stableGroups.length === 1 && stableGroups[0].items.map(i => i.source_name).join(',') === 'a,b');
  t('排序：空分组/畸形入参不抛错',
    Array.isArray(G.rankGroupsByRelevance(null, '庆余年')) &&
    G.rankGroupsByRelevance([null, {}], '庆余年').length === 2);
}

console.log('\n[13] 稳定聚合键（片名 + 季数 + 内容标签）');
{
  const one = (list) => G.aggregateResults(list);

  t('第一季等同无季：庆余年 + 庆余年第一季 → 1 组',
    one([item('庆余年', 'a'), item('庆余年第一季', 'b')]).length === 1);
  t('第二季独立：庆余年 + 庆余年第二季 → 2 组',
    one([item('庆余年', 'a'), item('庆余年第二季', 'b')]).length === 2);

  t('特别篇/特别版归为同一内容 → 1 组',
    one([item('某剧特别篇', 'a'), item('某剧特别版', 'b')]).length === 1);
  t('特别篇与正片保持独立 → 2 组',
    one([item('某剧特别篇', 'a'), item('某剧', 'b')]).length === 2);

  t('动态漫/动态漫画归为同一内容 → 1 组',
    one([item('某剧动态漫', 'a'), item('某剧动态漫画', 'b')]).length === 1);
  t('动态漫与正片保持独立 → 2 组',
    one([item('某剧动态漫', 'a'), item('某剧', 'b')]).length === 2);

  t('上/下部是不同内容 → 2 组',
    one([item('某剧 上', 'a'), item('某剧 下', 'b')]).length === 2);

  const huge = one([
    item('某剧', 'a', { vod_play_url: playUrl(40) }),
    item('某剧', 'b', { vod_play_url: playUrl(265) })
  ]);
  t('同名 40 集 + 265 集合并 1 组且 episodes=265',
    huge.length === 1 && huge[0].episodes === 265 && huge[0].items.length === 2,
    String(huge.length) + '/' + String(huge[0] && huge[0].episodes));
}

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
