// WDTV 广告过滤引擎自测（Node ESM，零依赖，不随部署）
// 运行：node test/ad-filter.test.mjs
import '../js/ad-filter.js';

const A = globalThis.WDTVAdFilter;
let pass = 0, fail = 0;
const fails = [];

function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

// ---------- 合成清单工具 ----------
const MAIN = 'https://cdn.example.com/hls/';
const AD = 'https://ad.doubleclick.example.org/ad/';

function segLine(host, path, dur) { return `#EXTINF:${dur},\n${host}${path}`; }

// 构造媒体清单：items = [{host,path,dur}]，discBefore=true 在该分片前插 DISCONTINUITY
function playlist(items, opts = {}) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0'];
  for (const it of items) {
    if (it.disc) lines.push('#EXT-X-DISCONTINUITY');
    if (it.key) lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="${it.key}"`);
    if (it.map) lines.push(`#EXT-X-MAP:URI="${it.map}"`);
    lines.push(`#EXTINF:${it.dur},`);
    lines.push(`${it.host}${it.path}`);
  }
  if (opts.tail) lines.push(...opts.tail);
  if (opts.byterange) lines.splice(4, 0, '#EXT-X-BYTERANGE:1000@0');
  return lines.join('\n');
}

const mainSeg = (n, dur = 10) => ({ host: MAIN, path: `s${n}.ts`, dur });
const adSeg = (n, dur = 4) => ({ host: AD, path: `${n}.ts`, dur, disc: false });

function run(text, base = MAIN + 'index.m3u8', o = { enabled: true }) {
  return A.analyze(text, base, o);
}

// 结构完整性：每个 #EXTINF 行必须紧跟一个非 # 的 URI 行（无悬空 EXTINF）
function noDanglingExtinf(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('#EXTINF:') === 0) {
      const next = lines[i + 1];
      if (!next || next.trim().charAt(0) === '#') return false;
    }
  }
  return true;
}

console.log('\n[1] 贴片广告（前置区间·外域+广告路径）');
{
  const text = playlist([
    adSeg(1, 4), adSeg(2, 4),
    { ...mainSeg(0), disc: false },
    mainSeg(1), mainSeg(2), mainSeg(3), mainSeg(4), mainSeg(5)
  ]).replace('#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-DISCONTINUITY');
  const r = run(text);
  t('贴片：删除 1 个区间', r.stats.deletedIntervals === 1, JSON.stringify(r.stats));
  t('贴片：广告分片不再出现', !r.text.includes('doubleclick'));
  t('贴片：正片分片保留', r.text.includes('s0.ts') && r.text.includes('s5.ts'));
  t('贴片：输出带 ENDLIST', r.text.includes('#EXT-X-ENDLIST'));
  t('贴片：输出带版本标记', /^#WDTV-ADF:v2$/m.test(r.text));
  t('贴片：removed 记录秒数', r.removed.length === 1 && r.removed[0].secs === 8, JSON.stringify(r.removed));
}

console.log('\n[2] 中插广告（中部区间）');
{
  const text = playlist([
    mainSeg(0), mainSeg(1),
    { ...adSeg(1, 4), disc: true }, adSeg(2, 4),
    { ...mainSeg(2), disc: true },
    mainSeg(3), mainSeg(4), mainSeg(5)
  ]);
  const r = run(text);
  t('中插：删除 1 个区间', r.stats.deletedIntervals === 1);
  t('中插：广告分片不再出现', !r.text.includes('doubleclick'));
  t('中插：正片分片保留', r.text.includes('s0.ts') && r.text.includes('s5.ts'));
}

console.log('\n[3] 三方域名黑名单（无 DISCONTINUITY 标记）');
{
  const text = playlist([
    mainSeg(0), mainSeg(1),
    { host: 'https://ads.example.net', path: 'v/1.ts', dur: 5 },
    { host: 'https://ads.example.net', path: 'v/2.ts', dur: 5 },
    mainSeg(2), mainSeg(3)
  ]);
  const r = run(text);
  t('黑名单：广告分片删除', !r.text.includes('ads.example.net'));
  t('黑名单：正片分片保留', r.text.includes('s0.ts') && r.text.includes('s3.ts'));
  t('黑名单：缝点插入 DISCONTINUITY', (r.text.match(/#EXT-X-DISCONTINUITY\n/g) || []).length >= 1, r.text);
  t('黑名单：removed 原因', r.removed.length === 1 && r.removed[0].reason.includes('blacklist'), JSON.stringify(r.removed));
  t('黑名单：无悬空 EXTINF', noDanglingExtinf(r.text), r.text);
}

console.log('\n[4] 合法编码切换（同 host 同目录同 EXTINF，不得删）');
{
  const text = playlist([
    mainSeg(0), mainSeg(1),
    { ...mainSeg(2), disc: true }, mainSeg(3),
    { ...mainSeg(4), disc: true },
    mainSeg(5), mainSeg(6)
  ]);
  const before = text;
  const r = run(text);
  t('合法：零删除', r.stats.removedSegs === 0 && r.stats.deletedIntervals === 0);
  t('合法：闭合的合法标记保留（未闭合的按既定策略摘除）', (r.text.match(/#EXT-X-DISCONTINUITY\n/g) || []).length === 1);
  t('合法：分片数不变', (r.text.match(/\.ts/g) || []).length === (before.match(/\.ts/g) || []).length);
  t('合法：无可疑区域登记', r.regions.length === 0, JSON.stringify(r.regions));
}

console.log('\n[5] 无广告清单（零改动）');
{
  const text = playlist([mainSeg(0), mainSeg(1), mainSeg(2)]);
  const r = run(text);
  const stripped = r.text.split('\n').filter(l => !/^#WDTV-ADF:/.test(l) && l !== '#EXT-X-ENDLIST').join('\n');
  t('无广告：除标记与 ENDLIST 外零改动', stripped === text, JSON.stringify(stripped));
  t('无广告：无删除无区域', r.removed.length === 0 && r.regions.length === 0);
}

console.log('\n[6a] fMP4：区间含 MAP 且区间后有新 MAP（可删）');
{
  const text = playlist([
    mainSeg(0), mainSeg(1),
    { ...adSeg(1, 4), disc: true, map: 'https://ad.doubleclick.example.org/ad/init.mp4' }, adSeg(2, 4),
    { ...mainSeg(2), disc: true, map: MAIN + 'init.mp4' },
    mainSeg(3), mainSeg(4)
  ]);
  const r = run(text);
  t('6a：广告区间删除', !r.text.includes('doubleclick') && r.stats.removedSegs === 2, JSON.stringify(r.stats));
  t('6a：正片 MAP 保留', r.text.includes(MAIN + 'init.mp4'));
}

console.log('\n[6b] fMP4：区间含 MAP 但区间后无新 MAP（禁删）');
{
  const text = playlist([
    mainSeg(0), mainSeg(1),
    { ...adSeg(1, 4), disc: true, map: 'https://ad.doubleclick.example.org/ad/init.mp4' }, adSeg(2, 4),
    { ...mainSeg(2), disc: true },
    mainSeg(3), mainSeg(4)
  ]);
  const r = run(text);
  t('6b：广告分片保留（依赖未解除）', r.text.includes('doubleclick'), r.text);
  t('6b：零删除', r.stats.removedSegs === 0);
  t('6b：MAP 行保留', r.text.includes('/ad/init.mp4'));
}

console.log('\n[7] 单边 DISCONTINUITY（未闭合，非黑名单主机）');
{
  const neutral = (n, dur = 4) => ({ host: 'https://other.example.net/x/', path: `${n}.ts`, dur });
  const text = playlist([
    mainSeg(0), mainSeg(1),
    { ...neutral(1), disc: true }, neutral(2),
    mainSeg(2), mainSeg(3)
  ]);
  const r = run(text);
  t('单边：分片全部保留', (r.text.match(/\.ts/g) || []).length === 6, r.text);
  t('单边：标记行被摘除', !r.text.includes('#EXT-X-DISCONTINUITY'));
  t('单边：不登记可疑区域', r.regions.length === 0);
}

console.log('\n[7b] 黑名单段落在未闭合区间内（分层叠加：黑名单层独立删除）');
{
  const text = playlist([
    mainSeg(0), mainSeg(1),
    { ...adSeg(1, 4), disc: true }, adSeg(2, 4),
    mainSeg(2), mainSeg(3)
  ]);
  const r = run(text);
  t('7b：黑名单广告段删除', !r.text.includes('doubleclick'), r.text);
  t('7b：正片分片保留', (r.text.match(/\.ts/g) || []).length === 4);
  t('7b：缝点有标记', (r.text.match(/#EXT-X-DISCONTINUITY/g) || []).length >= 1);
}

console.log('\n[8] 异常文本（不抛异常）');
{
  let ok = true;
  try {
    const r1 = run('完全不是清单');
    const r2 = run('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:\n坏行');
    const r3 = run('');
    t('异常：返回字符串', typeof r1.text === 'string' && typeof r2.text === 'string' && typeof r3.text === 'string');
  } catch (e) { ok = false; console.log('  抛出：' + e.message); }
  t('异常：不抛出', ok);
}

console.log('\n[9] 删除预算（广告占 60%）');
{
  const items = [];
  for (let i = 0; i < 4; i++) items.push(mainSeg(i, 10));
  items.push({ ...adSeg(1, 5), disc: true });
  for (let i = 0; i < 12; i++) items.push({ host: AD, path: `a${i}.ts`, dur: 5 });
  items.push({ ...mainSeg(4), disc: true });
  for (let i = 5; i < 8; i++) items.push(mainSeg(i, 10));
  const r = run(playlist(items));
  t('预算：budgetHit 置位', r.stats.budgetHit === true, JSON.stringify(r.stats));
  t('预算：零删除', r.stats.removedSegs === 0);
  t('预算：回退摘标记', !r.text.includes('#EXT-X-DISCONTINUITY'));
  t('预算：正片分片仍在', r.text.includes('s0.ts') && r.text.includes('s7.ts'));
}

console.log('\n[10] 区间 KEY 依赖（区间后无新 KEY，禁删）');
{
  const text = playlist([
    mainSeg(0), mainSeg(1),
    { ...adSeg(1, 4), disc: true, key: 'https://key.example.com/ad.key' }, adSeg(2, 4),
    { ...mainSeg(2), disc: true },
    mainSeg(3), mainSeg(4)
  ]);
  const r = run(text);
  t('KEY：广告分片保留', r.text.includes('doubleclick'));
  t('KEY：KEY 行保留', r.text.includes('key.example.com'));
  t('KEY：零删除', r.stats.removedSegs === 0);
}

console.log('\n[11] DATERANGE SCTE35 标准标记');
{
  const text = playlist([
    mainSeg(0), mainSeg(1),
    { host: AD, path: '1.ts', dur: 5 },
    { host: AD, path: '2.ts', dur: 5 },
    mainSeg(2), mainSeg(3)
  ]).replace('#EXTINF:5,\n' + AD + '1.ts',
    '#EXT-X-DATERANGE:ID="a1",SCTE35-OUT=0xFC302500000000000000,DURATION=10\n#EXTINF:5,\n' + AD + '1.ts')
   .replace('#EXTINF:10,\n' + MAIN + 's2.ts',
    '#EXT-X-DATERANGE:ID="a2",SCTE35-IN=0xFC302500000000000000\n#EXTINF:10,\n' + MAIN + 's2.ts');
  const r = run(text);
  t('SCTE35：广告区间删除', !r.text.includes('doubleclick'), r.text);
  t('SCTE35：删除原因为标准标记', r.removed.length === 1 && r.removed[0].reason.includes('scte35'), JSON.stringify(r.removed));
  t('SCTE35：DATERANGE 行被清理', !r.text.includes('DATERANGE'), r.text);
  t('SCTE35：无悬空 EXTINF', noDanglingExtinf(r.text), r.text);
}

console.log('\n[12] 缓存签名四态（签名与校验侧同源：只读 localStorage）');
{
  const on = run(playlist([mainSeg(0), mainSeg(1)]));
  t('签名：开 → v2', /^#WDTV-ADF:v2$/m.test(on.text));
  t('签名：on 文本匹配当前（Node 默认开）', A.textMatchesCurrentSignature(on.text) === true);
  t('签名：无标记文本不匹配', A.textMatchesCurrentSignature('#EXTM3U\n#EXTINF:10,\nx.ts') === false);
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => 'false' };
  const off = run(playlist([mainSeg(0), mainSeg(1)]));
  t('签名：关 → v2-off', /^#WDTV-ADF:v2-off$/m.test(off.text));
  t('签名：localStorage 关时 off 文本匹配', A.textMatchesCurrentSignature(off.text) === true);
  t('签名：localStorage 关时 on 文本不匹配', A.textMatchesCurrentSignature(on.text) === false);
  // 回归：显式 opts.enabled 与存储冲突时，签名仍按存储生成（旧实现按 opts.enabled 生成，
  // 校验侧只读存储 → 每次命中都删缓存回源）。
  const mismatch = run(playlist([mainSeg(0), mainSeg(1)]), MAIN + 'index.m3u8', { enabled: true });
  t('签名：opts.enabled 与存储冲突时仍按存储生成，不反复回源',
      /^#WDTV-ADF:v2-off$/m.test(mismatch.text) && A.textMatchesCurrentSignature(mismatch.text) === true);
  globalThis.localStorage = saved;
}

console.log('\n[13] BYTERANGE 清单（保守禁删）');
{
  const text = playlist([
    mainSeg(0), mainSeg(1),
    { ...adSeg(1, 4), disc: true }, adSeg(2, 4),
    { ...mainSeg(2), disc: true },
    mainSeg(3), mainSeg(4)
  ], { byterange: true });
  const r = run(text);
  t('BYTERANGE：零删除', r.stats.removedSegs === 0);
  t('BYTERANGE：分片保留', r.text.includes('doubleclick'));
}

console.log('\n[14] DISCONTINUITY-SEQUENCE 行保护');
{
  const text = playlist([
    mainSeg(0), mainSeg(1),
    { ...adSeg(1, 4), disc: true }, adSeg(2, 4),
    { ...mainSeg(2), disc: true },
    mainSeg(3), mainSeg(4)
  ], { tail: ['#EXT-X-DISCONTINUITY-SEQUENCE:2'] });
  const r = run(text);
  t('SEQUENCE：删除路径下保留', r.text.includes('#EXT-X-DISCONTINUITY-SEQUENCE:2'), r.text);
  const legacy = A.legacyStrip(text);
  t('SEQUENCE：legacyStrip 下保留', legacy.includes('#EXT-X-DISCONTINUITY-SEQUENCE:2'));
  t('SEQUENCE：legacyStrip 摘除普通标记', !legacy.includes('#EXT-X-DISCONTINUITY\n'));
}

console.log('\n[15] 可疑区域登记（低置信度，供运行时层）');
{
  const text = playlist([
    mainSeg(0), mainSeg(1), mainSeg(2),
    { ...adSeg(1, 4), disc: true }, adSeg(2, 4),
    { ...mainSeg(3), disc: true },
    mainSeg(4), mainSeg(5), mainSeg(6), mainSeg(7)
  ]);
  // 同 host 广告（仅路径+EXTINF 信号，评分不足删除阈值）→ 保留并登记 region
  const sameHostAd = text.split('\n').map(l => l.replace(/ad\.doubleclick\.example\.org/, 'cdn.example.com')).join('\n');
  const r = run(sameHostAd);
  t('可疑：零删除', r.stats.removedSegs === 0);
  t('可疑：登记 region', r.regions.length >= 1, JSON.stringify(r.regions));
  if (r.regions.length) {
    const rg = r.regions[0];
    t('可疑：region 坐标合理', rg.end > rg.start && rg.start >= 0 && rg.end <= r.stats.totalSecs, JSON.stringify(rg));
  }
}

console.log('\n[16] 边界：主清单（无 EXTINF）零改动仅打标记');
{
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n720/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n1080/index.m3u8';
  const r = run(master);
  const expected = '#EXTM3U\n#WDTV-ADF:v2\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n720/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n1080/index.m3u8';
  t('主清单：除标记外零改动', r.text === expected, JSON.stringify(r.text));
}

console.log('\n[17] 回归：代理解包 / AES-128 / 零时长预算 / 签名注入 / 全局行保护');
{
  const NU = i => `https://cdn.example.com/v/${i}.ts`;
  const AU = i => `https://ads.example.com/ad/${i}.ts`;
  const px = u => '/proxy/' + encodeURIComponent(u);
  const head = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n';
  const mk = (urls, dur) => head + urls.map(u => `#EXTINF:${dur},\n${u}`).join('\n') + '\n#EXT-X-ENDLIST';
  const many = [NU(1), AU(1), AU(2), AU(3), NU(2), NU(3), NU(4), NU(5), NU(6), NU(7), NU(8), NU(9), NU(10), NU(11), NU(12)];

  // ① 路径式代理：绝对 href 剥掉 origin 后必须能解出内层 host
  const proxied = run(mk(many.map(px), 10), 'https://wdtv.pages.dev/play', { enabled: true, proxyPrefix: '/proxy/' });
  t('回归①：代理链路广告被删除', proxied.stats.removedSegs === 3, JSON.stringify(proxied.stats));
  t('回归①：代理链路输出不含广告分片', !proxied.text.includes('ad%2F1') && !proxied.text.includes('ads.example.com'));
  // 收紧：代理编码后分片路径与 host 都应同时存在，旧断言用 || 只要命中一个就通过。
  t('回归①：代理链路正片保留', proxied.text.includes('v%2F1.ts') && proxied.text.includes('cdn.example.com'));

  // ② 头部 AES-128 KEY 只是区间前的持续引用，不应被误判成「区间内新声明」
  const enc = run(head + '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/key.key"\n' + mk(many, 10).slice(head.length), MAIN + 'index.m3u8', { enabled: true });
  t('回归②：AES-128 加密源广告被删除', enc.stats.removedSegs === 3, JSON.stringify(enc.stats));
  t('回归②：不再降级为 map-key-dep', !enc.regions.some(x => x.reason === 'map-key-dep'), JSON.stringify(enc.regions));

  // ③ EXTINF 全 0 时按分片数占比兜底触发 40% 预算
  const zero = run(mk([NU(1), AU(1), AU(2), AU(3), NU(2)], 0), MAIN + 'index.m3u8', { enabled: true });
  t('回归③：totalSecs=0 时预算仍生效', zero.stats.budgetHit === true && zero.stats.removedSegs === 0, JSON.stringify(zero.stats));

  // ④ 首行不是 #EXTM3U 也必须注入签名，否则 video-cache 会每次删缓存回源
  const blank = run('\n' + mk([NU(1), NU(2)], 10), MAIN + 'index.m3u8', { enabled: true });
  const bom = run('\uFEFF' + mk([NU(1), NU(2)], 10), MAIN + 'index.m3u8', { enabled: true });
  t('回归④：首行空行仍带可校验签名', A.textMatchesCurrentSignature(blank.text), JSON.stringify(blank.text.slice(0, 60)));
  t('回归④：BOM 首行仍带可校验签名', A.textMatchesCurrentSignature(bom.text), JSON.stringify(bom.text.slice(0, 60)));

  // ⑤ 全局标签行落在删除区间内必须强制保留
  const withGlobal = head + [
    '#EXTINF:10,', NU(1),
    '#EXTINF:10,', AU(1),
    '#EXT-X-DISCONTINUITY-SEQUENCE:0', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXTINF:10,', AU(2),
    '#EXTINF:10,', NU(2), '#EXTINF:10,', NU(3), '#EXTINF:10,', NU(4),
    '#EXTINF:10,', NU(5), '#EXTINF:10,', NU(6), '#EXT-X-ENDLIST'
  ].join('\n');
  const g = run(withGlobal);
  t('回归⑤：全局行在删除区间内仍保留', g.text.includes('#EXT-X-DISCONTINUITY-SEQUENCE') && g.text.includes('#EXT-X-MEDIA-SEQUENCE'), JSON.stringify(g.text.slice(0, 200)));
  t('回归⑤：仍完成广告删除', g.stats.removedSegs >= 1, JSON.stringify(g.stats));
}

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
