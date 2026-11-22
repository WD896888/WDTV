// WDTV 分片 PTS 广告探测器自测（Node ESM，零依赖）
// 运行：node test/pts-ad-detector.test.mjs
import '../js/pts-ad-detector.js';
import '../js/ad-filter.js';

const P = globalThis.WDTVPtsAd;
const A = globalThis.WDTVAdFilter;
let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

// ---- 合成 TS 分片：构造一个带 PTS 的 PES 视频包 ----
function encPts(sec) {
  const v = Math.round(sec * 90000);
  return [
    ((v >> 30) & 0x07) << 1 | 1,
    (v >> 22) & 0xFF,
    ((v >> 15) & 0x7F) << 1 | 1,
    (v >> 7) & 0xFF,
    (v & 0x7F) << 1 | 1
  ];
}
function tsWithPts(sec) {
  const b = new Uint8Array(188);
  b[0] = 0x47; b[1] = 0x41; b[2] = 0x00; b[3] = 0x10; // sync, PUSI, PID 0x100, payload only
  const o = 4;
  b[o] = 0; b[o + 1] = 0; b[o + 2] = 1; b[o + 3] = 0xE0; // PES video start
  b[o + 4] = 0; b[o + 5] = 0; b[o + 6] = 0x80; b[o + 7] = 0x80; // PTS only
  b[o + 8] = 5;
  const p = encPts(sec);
  for (let i = 0; i < 5; i++) b[o + 9 + i] = p[i];
  return b;
}

// fake fetcher：url 里编码了 PTS
function fetcher(url) {
  const m = /pts_([\d.]+)/.exec(url || '');
  const sec = m ? parseFloat(m[1]) : 0;
  return Promise.resolve({ status: 206, arrayBuffer: async () => tsWithPts(sec).buffer });
}
function badFetcher() {
  return Promise.resolve({ status: 200, arrayBuffer: async () => new Uint8Array(188).buffer });
}

function segUrl(label, pts) {
  return '/proxy/https%3A%2F%2Fcdn.test%2F' + label + '_pts_' + pts.toFixed(2) + '.ts';
}

// groups = [{segs:[pts...], disc:bool}]，每片 4s
function playlist(groups) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0'];
  groups.forEach(g => {
    if (g.disc) lines.push('#EXT-X-DISCONTINUITY');
    g.segs.forEach(s => {
      lines.push('#EXTINF:4.000000,');
      lines.push(segUrl('s' + lines.length, s));
    });
  });
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

async function main() {
  console.log('\n[1] probeTsFirstDts 合成 PTS 解析');
  {
    const dts = P.probeTsFirstDts(tsWithPts(290.12));
    t('首帧 DTS 解析正确', dts !== null && Math.abs(dts / 90000 - 290.12) < 0.05, String(dts));
  }

  P.clearCache();
  console.log('\n[2] 正片 PTS 连续（无广告）→ 零删除');
  {
    const groups = [];
    for (let k = 0; k < 8; k++) groups.push({ disc: k > 0, segs: [1.48 + k * 8, 5.48 + k * 8] });
    const text = playlist(groups);
    const r = await P.analyzePts(text, 'http://localhost/m.m3u8', { fetcher });
    t('无广告：零删除区间', r.ranges.length === 0, JSON.stringify(r.ranges));
    t('无广告：探测到了区间', r.stats.probed >= 7, JSON.stringify(r.stats));
  }

  P.clearCache();
  console.log('\n[3] 真实形态：中段插入两段广告（PTS 重置到锚点）→ 精确命中');
  {
    const groups = [
      { disc: false, segs: [1.48, 5.48, 9.48] },
      { disc: true, segs: [13.48, 17.48, 21.48] },
      // 广告1：PTS 重置到 1.48
      { disc: true, segs: [1.48, 5.48, 9.48] },
      // 广告后正片：PTS 接回正片时间线 25.48（跳过广告占的清单时长）
      { disc: true, segs: [25.48, 29.48, 33.48] },
      { disc: true, segs: [37.48, 41.48, 45.48] },
      // 广告2
      { disc: true, segs: [1.48, 5.48, 9.48] },
      { disc: true, segs: [49.48, 53.48, 57.48] }
    ];
    const text = playlist(groups);
    const r = await P.analyzePts(text, 'http://localhost/m.m3u8', { fetcher });
    t('命中 2 段广告', r.ranges.length === 2, JSON.stringify(r.ranges));
    if (r.ranges.length === 2) {
      t('广告1 = 区间2', r.ranges[0].from === 6 && r.ranges[0].to === 8, JSON.stringify(r.ranges[0]));
      t('广告2 = 区间5', r.ranges[1].from === 15 && r.ranges[1].to === 17, JSON.stringify(r.ranges[1]));
    }
    const out = A.analyze(text, 'http://localhost/m.m3u8', { enabled: true, forceDeleteRanges: r.ranges });
    const remaining = (out.text.match(/\.ts/g) || []).length;
    t('重建后剩 15 片（原 21 删 6）', remaining === 15, String(remaining));
    t('输出带 v3 签名', /^#WDTV-ADF:v3$/m.test(out.text));
  }

  P.clearCache();
  console.log('\n[4] 尾部单区间重置（无后向确认）→ 不删（防误伤）');
  {
    const groups = [
      { disc: false, segs: [1.48, 5.48, 9.48] },
      { disc: true, segs: [13.48, 17.48, 21.48] },
      { disc: true, segs: [1.48, 5.48, 9.48] }
    ];
    const r = await P.analyzePts(playlist(groups), 'http://localhost/m.m3u8', { fetcher });
    t('未确认的候选不删', r.ranges.length === 0, JSON.stringify(r.ranges));
  }

  P.clearCache();
  console.log('\n[5] 非锚点 PTS 跳变（非法编码切换）→ 不删（防误伤）');
  {
    const groups = [
      { disc: false, segs: [1.48, 5.48, 9.48] },
      { disc: true, segs: [13.48, 17.48, 21.48] },
      { disc: true, segs: [500.48, 504.48, 508.48] },
      { disc: true, segs: [25.48, 29.48, 33.48] }
    ];
    const r = await P.analyzePts(playlist(groups), 'http://localhost/m.m3u8', { fetcher });
    t('非锚点跳变不删', r.ranges.length === 0, JSON.stringify(r.ranges));
  }

  P.clearCache();
  console.log('\n[6] 探测失败（首片无 PES）→ 放弃');
  {
    const groups = [];
    for (let k = 0; k < 4; k++) groups.push({ disc: k > 0, segs: [1.48 + k * 12, 5.48 + k * 12, 9.48 + k * 12] });
    const r = await P.analyzePts(playlist(groups), 'http://localhost/m.m3u8', { fetcher: badFetcher });
    t('首片探测失败：skipped', r.stats.skipped === true && r.ranges.length === 0, JSON.stringify(r.stats));
  }

  P.clearCache();
  console.log('\n[7] 下载链路：baseUrl 是内层真实地址 + 分片是 /proxy/ 形态 → 仍能探测');
  {
    // 下载器 makePlaylistBase().url 返回内层真实地址（源站域名），
    // 而清单分片是本站 /proxy/<encoded>。旧实现用 baseUrl 解析 /proxy/ 会拼到源站域名 → 404。
    const groups = [
      { disc: false, segs: [1.48, 5.48, 9.48] },
      { disc: true, segs: [13.48, 17.48, 21.48] },
      { disc: true, segs: [1.48, 5.48, 9.48] }, // 广告
      { disc: true, segs: [25.48, 29.48, 33.48] } // 接回
    ];
    let sawBadOrigin = false;
    const dlFetcher = (url) => {
      if (/^https:\/\/origin\.test\/proxy\//.test(url)) sawBadOrigin = true;
      return fetcher(url);
    };
    // 模拟浏览器 location（Node 默认无）
    const savedLoc = globalThis.location;
    globalThis.location = { origin: 'http://localhost:8080' };
    const r = await P.analyzePts(playlist(groups), 'https://origin.test/path/m.m3u8', { fetcher: dlFetcher });
    if (savedLoc === undefined) delete globalThis.location; else globalThis.location = savedLoc;
    t('未拼到源站域名', sawBadOrigin === false);
    t('下载链路仍能识别广告', r.ranges.length === 1 && r.ranges[0].from === 6, JSON.stringify(r.ranges));
  }

  P.clearCache();
  console.log('\n[8] 播放探测后下载复用结论：零重探、ranges 一致');
  {
    const groups = [
      { disc: false, segs: [1.48, 5.48, 9.48] },
      { disc: true, segs: [13.48, 17.48, 21.48] },
      { disc: true, segs: [1.48, 5.48, 9.48] }, // 广告
      { disc: true, segs: [25.48, 29.48, 33.48] }
    ];
    const text = playlist(groups);
    let fetchCount = 0;
    const countingFetcher = (url) => { fetchCount++; return fetcher(url); };
    // 第一次：播放探测（baseUrl 是 response.url 形态）
    const first = await P.analyzePts(text, 'http://localhost:8080/proxy/https%3A%2F%2Fsrc%2Fm.m3u8', { fetcher: countingFetcher });
    const firstCount = fetchCount;
    // 第二次：下载复用（baseUrl 换成内层源站形态，地址不同但清单内容相同）
    fetchCount = 0;
    const second = await P.analyzePts(text, 'https://src.test/public/m.m3u8', { fetcher: countingFetcher });
    t('首次确实探测了分片', firstCount > 0, String(firstCount));
    t('下载端零重探', fetchCount === 0, String(fetchCount));
    t('复用命中标记', second.stats.fromCache === true, JSON.stringify(second.stats));
    t('ranges 与播放一致', JSON.stringify(second.ranges) === JSON.stringify(first.ranges),
      JSON.stringify(second.ranges) + ' vs ' + JSON.stringify(first.ranges));
  }

  P.clearCache();
  console.log('\n[9] 并发探测同一清单：in-flight 去重，只发一次 Range');
  {
    const groups = [
      { disc: false, segs: [1.48, 5.48, 9.48] },
      { disc: true, segs: [13.48, 17.48, 21.48] },
      { disc: true, segs: [1.48, 5.48, 9.48] },
      { disc: true, segs: [25.48, 29.48, 33.48] }
    ];
    const text = playlist(groups);
    let fetchCount = 0;
    const countingFetcher = (url) => { fetchCount++; return fetcher(url); };
    // 同时发起两个探测（模拟预取与播放并发）
    const [a, b] = await Promise.all([
      P.analyzePts(text, 'http://a.test/m.m3u8', { fetcher: countingFetcher }),
      P.analyzePts(text, 'http://b.test/m.m3u8', { fetcher: countingFetcher })
    ]);
    t('只探测一次（去重）', fetchCount === 4, 'fetch 次数=' + fetchCount + '（锚点+3区间）');
    t('两者 ranges 一致', JSON.stringify(a.ranges) === JSON.stringify(b.ranges));
    t('后来者标记 fromCache', b.stats.fromCache === true, JSON.stringify(b.stats));
  }

  P.clearCache();
  console.log('\n[10] prefetchManifest 预取后 analyzePts 零重探');
  {
    const groups = [
      { disc: false, segs: [1.48, 5.48, 9.48] },
      { disc: true, segs: [13.48, 17.48, 21.48] },
      { disc: true, segs: [1.48, 5.48, 9.48] },
      { disc: true, segs: [25.48, 29.48, 33.48] }
    ];
    const text = playlist(groups);
    let fetchCount = 0;
    const countingFetcher = (url) => { fetchCount++; return fetcher(url); };
    // 预取：传 manifestText 让它免 fetch，只做探测
    const prefetched = await P.prefetchManifest('http://localhost/m.m3u8', { manifestText: text, fetcher: countingFetcher });
    t('预取产出结论', prefetched && prefetched.result && prefetched.result.ranges.length === 1,
      JSON.stringify(prefetched && prefetched.result));
    const afterPrefetch = fetchCount;
    // 真正播放：同清单再调 analyzePts，应命中结论缓存
    fetchCount = 0;
    const played = await P.analyzePts(text, 'http://other/m.m3u8', { fetcher: countingFetcher });
    t('播放零重探', fetchCount === 0, String(fetchCount));
    t('播放命中 fromCache', played.stats.fromCache === true);
    t('播放 ranges 与预取一致', JSON.stringify(played.ranges) === JSON.stringify(prefetched.result.ranges));
  }

  console.log('\n========================================');
  console.log(`结果：${pass} 通过，${fail} 失败`);
  if (fail) { console.log('失败用例：' + fails.join('、')); process.exit(1); }
}
main();
