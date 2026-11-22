// =====================================
// WDTV 分片 PTS 广告探测器（播放 / 下载共用，零依赖异步模块）
// =====================================
// 为什么需要它：采集站的插入式广告与正片同主机、同目录、同编码、同 EXTINF 分布，
// 且每 6 片一个 #EXT-X-DISCONTINUITY（正片自己也带），清单层面完全不可区分——
// 现有 ad-filter.js 的 legalVeto 会把所有区间判为「合法」而一票保留。
//
// 决定性信号：广告是独立编码后拼接进来的，其首帧 PTS 从 0 重新计时；
// 而正片的 PTS 时间线是连续的（**不含广告占用的清单时长**）。
// 实测某巨量源：正片区间首片 PTS 28.64 / 49.96 / ... / 290.12（连续），
// 广告区间首片 PTS 1.48（重置），广告之后的正片 PTS 313.48（接回原时间线）。
//
// 算法：
//   1. 只探测每个 DISCONTINUITY 区间的首片（+ 全片第 0 片作锚点），每片 8KB Range；
//   2. 顺序扫描区间，维护「正片 PTS 游标」：
//      - PTS ≈ 游标 → 正片，游标 += 该区间清单时长；
//      - PTS 远落后游标且接近锚点 → 广告候选，游标不动；
//   3. 候选必须由「下一个正片区间的 PTS 接回游标」确认，否则丢弃（宁可漏删不误伤）。
//
// 成本：22 个区间 = 23 次 8KB Range 请求，并发 6、总上限 48；结果按 URL 缓存。
// 防误伤：单区间不成候选；候选需锚点匹配 + 后向接回确认；fMP4/BYTERANGE 探测失败
//        直接放弃；任何异常返回空 ranges（退回 ad-filter 原有同步过滤）。
// 浏览器挂 window.WDTVPtsAd，Node 经 globalThis 可供零依赖自测引用。
(function (g) {
  'use strict';

  var RULES_VERSION = 1;    // 判定规则版本；变更时结论缓存指纹自动失效
  var PROBE_BYTES = 8192;
  var TIMEOUT_MS = 12000;
  var CONCURRENCY = 20;
  var MAX_PROBES = 48;
  var MATCH_TOL = 2.0;       // 正片 PTS 与游标偏差容忍（秒）
  var RESET_MIN_BACK = 3.0;  // PTS 落后游标超过该值才算重置
  var ANCHOR_TOL = 3.0;      // 广告首帧 PTS 需与锚点（片 0）接近

  // 分片 PTS 缓存：fetchUrl -> { pts|null, ts }（同 URL 免重发 Range）
  var probeCache = new Map();
  var CACHE_TTL = 10 * 60 * 1000;

  // 判定结论缓存：清单指纹 -> { ts, data:{ranges, stats} }
  // 播放探测完写入，下载/再播直接复用——「同一份视频只探一次」。
  // 用 sessionStorage 兜底：同一浏览器标签内 player.html ↔ index.html 跳转也能共享。
  var resultCache = new Map();
  var RESULT_TTL = 30 * 60 * 1000;
  var SS_PREFIX = 'wdtv:ptsad:';

  // 在飞探测：清单指纹 -> Promise。预取与播放同时探测同一清单时共享同一次结果，
  // 杜绝重复发 23 个 Range 请求（也避免两路结果先后写缓存互相覆盖）。
  var inflight = new Map();

  // 清单指纹：对分片 URI 行做 FNV-1a，规避播放(response.url)与下载(base.url)地址形态差异。
  // 带 RULES_VERSION：规则升级后旧结论自动失效。
  function fingerprint(text) {
    var lines = String(text || '').split(/\r?\n/);
    var h = 2166136261, count = 0;
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t || t.charAt(0) === '#') continue;
      count++;
      for (var j = 0; j < t.length; j++) {
        h ^= t.charCodeAt(j);
        h = (h * 16777619) >>> 0;
      }
    }
    return 'r' + RULES_VERSION + ':' + count + ':' + h.toString(36);
  }

  function readResult(fp) {
    var now = Date.now();
    var hit = resultCache.get(fp);
    if (hit && now - hit.ts < RESULT_TTL) return hit.data;
    try {
      if (typeof sessionStorage !== 'undefined') {
        var raw = sessionStorage.getItem(SS_PREFIX + fp);
        if (raw) {
          var rec = JSON.parse(raw);
          if (rec && rec.data && now - rec.ts < RESULT_TTL) {
            resultCache.set(fp, rec);
            return rec.data;
          }
        }
      }
    } catch (e) { }
    return null;
  }

  function writeResult(fp, data) {
    var rec = { ts: Date.now(), data: data };
    resultCache.set(fp, rec);
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(SS_PREFIX + fp, JSON.stringify(rec));
    } catch (e) { /* 容量/隐私模式失败不影响本次复用 */ }
  }

  // ---- PES / TS 首帧时间戳（与 js/downloader.js 的 probeTsFirstDts 同源，改动需同步） ----
  function parsePesTimestamp(b, o) {
    return ((b[o] >> 1) & 0x07) * 0x40000000
      + b[o + 1] * 0x400000
      + (b[o + 2] >> 1) * 0x8000
      + b[o + 3] * 0x80
      + (b[o + 4] >> 1);
  }

  function probeTsFirstDts(u8) {
    if (!u8 || u8.length < 188) return null;
    var video = null, audio = null;
    var len = u8.length;
    var i = 0;
    while (i < len && u8[i] !== 0x47) i++;
    while (i + 188 <= len && (video === null || audio === null)) {
      if (u8[i] !== 0x47) {
        i++;
        while (i < len && u8[i] !== 0x47) i++;
        continue;
      }
      var pusi = (u8[i + 1] & 0x40) !== 0;
      var afc = u8[i + 3] & 0x30;
      if (pusi && (afc & 0x10)) {
        var off = i + 4;
        if (afc & 0x20) off += 1 + u8[i + 4];
        if (off + 14 <= len && u8[off] === 0 && u8[off + 1] === 0 && u8[off + 2] === 1) {
          var sid = u8[off + 3];
          var isVideo = sid >= 0xE0 && sid <= 0xEF;
          var isAudio = sid >= 0xC0 && sid <= 0xDF;
          if (isVideo || isAudio) {
            var flags = u8[off + 7];
            if ((flags & 0xC0) === 0x80 && off + 14 <= len) {
              if (isVideo) video = parsePesTimestamp(u8, off + 9);
              else audio = parsePesTimestamp(u8, off + 9);
            } else if ((flags & 0xC0) === 0xC0 && off + 19 <= len) {
              if (isVideo) video = parsePesTimestamp(u8, off + 14);
              else audio = parsePesTimestamp(u8, off + 9);
            }
          }
        }
      }
      i += 188;
    }
    return video !== null ? video : audio;
  }

  // ---- 清单解析：分片表 + DISCONTINUITY 区间 ----
  function safeUrl(u, base) { try { return new URL(u, base); } catch (e) { return null; } }

  function fetchUrlOf(u, baseUrl) {
    var raw = String(u == null ? '' : u).trim();
    var origin = (typeof location !== 'undefined' && location.origin) ? location.origin : null;
    // /proxy/<encoded> 是本站路径，必须相对 location.origin 解析。
    // 下载链路传入的 baseUrl 是「内层真实地址」（如 https://源站/...），
    // 若拿它当 base，/proxy/... 会被拼到源站域名下 → 探测 404（下载漏广告的根因）。
    if (raw.charAt(0) === '/' && raw.indexOf('/proxy/') === 0) {
      // 有 location（浏览器）用站点 origin；无 location（Node 自测）退回 baseUrl 解析
      return origin ? new URL(raw, origin).href : ((safeUrl(raw, baseUrl) || {}).href || raw);
    }
    var abs = safeUrl(raw, baseUrl);
    if (!abs) return null;
    // 跨域绝对地址改走本站代理，避免 Range 请求被 CORS 拦掉
    if (origin && /^https?:$/i.test(abs.protocol) && abs.origin !== origin) {
      return '/proxy/' + encodeURIComponent(abs.href);
    }
    return abs.href;
  }

  function parseSegments(text, baseUrl) {
    var lines = String(text || '').split(/\r?\n/);
    var segs = [];
    var pendingDur = 0, pendingDisc = false, discLine = -1;
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (t === '#EXT-X-DISCONTINUITY') { pendingDisc = true; discLine = i; }
      else if (t.indexOf('#EXTINF:') === 0) {
        var d = parseFloat(t.slice(8));
        pendingDur = isFinite(d) ? d : 0;
      } else if (t && t.charAt(0) !== '#') {
        segs.push({
          idx: segs.length, line: i, dur: pendingDur,
          discBefore: pendingDisc, discLine: pendingDisc ? discLine : -1,
          fetchUrl: fetchUrlOf(t, baseUrl)
        });
        pendingDur = 0; pendingDisc = false; discLine = -1;
      }
    }
    return segs;
  }

  function intervalsOf(segs) {
    var out = [];
    var open = -1;
    for (var s = 0; s < segs.length; s++) {
      if (!segs[s].discBefore) continue;
      if (open === -1) { open = s; continue; }
      out.push({ from: open, to: s - 1 });
      open = s;
    }
    if (open !== -1) out.push({ from: open, to: segs.length - 1 });
    return out;
  }

  function intervalDur(segs, iv) {
    var sum = 0;
    for (var k = iv.from; k <= iv.to; k++) sum += segs[k].dur || 0;
    return sum;
  }

  // ---- 单分片首帧 PTS 探测（8KB Range + 超时 + 缓存） ----
  function defaultFetcher(url, headers, signal) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('fetch unavailable'));
    return fetch(url, { headers: headers, signal: signal });
  }

  function probeOne(url, opts) {
    var now = Date.now();
    var hit = probeCache.get(url);
    if (hit && now - hit.ts < CACHE_TTL) return Promise.resolve(hit.pts);
    if (!url) return Promise.resolve(null);

    var fetcher = (opts && opts.fetcher) || defaultFetcher;
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = null;
    var p = Promise.resolve().then(function () {
      return fetcher(url, { Range: 'bytes=0-' + (PROBE_BYTES - 1) }, ctrl ? ctrl.signal : undefined);
    }).then(function (res) {
      if (!res || (res.status && res.status !== 200 && res.status !== 206)) throw new Error('bad status');
      return (typeof res.arrayBuffer === 'function') ? res.arrayBuffer() : res;
    }).then(function (buf) {
      var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      var dts = probeTsFirstDts(u8);
      return dts === null ? null : dts / 90000; // 90kHz → 秒
    }).catch(function () { return null; }).then(function (pts) {
      probeCache.set(url, { pts: pts, ts: Date.now() });
      return pts;
    });
    if (ctrl) {
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, TIMEOUT_MS);
      p = p.then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
    }
    return p;
  }

  function mapLimit(items, limit, fn) {
    var results = new Array(items.length);
    var next = 0;
    // 每个 worker 必须「取一个→完成→再取下一个」递归推进；
    // 旧实现在第一次迭代就 return，并发 6 时只处理前 6 个 target，
    // 后面的区间首片永远不被探测（表现为广告只删前半段）。
    function worker() {
      function step() {
        if (next >= items.length) return Promise.resolve();
        var i = next++;
        return Promise.resolve().then(function () { return fn(items[i], i); })
          .then(function (v) { results[i] = v; return step(); })
          .catch(function () { results[i] = null; return step(); });
      }
      return step();
    }
    var n = Math.min(limit, items.length);
    var workers = [];
    for (var k = 0; k < n; k++) workers.push(worker());
    return Promise.all(workers).then(function () { return results; });
  }

  // ---- 主入口：返回需强制删除的分片区间 ----
  // 门面负责三级复用：结论缓存 → 在飞探测 → 真正探测。
  function analyzePts(text, baseUrl, opts) {
    opts = opts || {};
    var empty = { ranges: [], stats: { probed: 0, resets: 0, anchor: null, skipped: false } };
    try {
      if (typeof text !== 'string' || text.indexOf('#EXTINF') === -1) return Promise.resolve(empty);
      var fp = fingerprint(text);
      // ① 结论缓存命中：零网络、零探测
      var cached = readResult(fp);
      if (cached) {
        var hit = { ranges: cached.ranges, stats: cached.stats };
        hit.stats.fromCache = true;
        return Promise.resolve(hit);
      }
      // ② 同一清单已有探测在飞：共享同一个 Promise（预取 vs 播放去重）
      var running = inflight.get(fp);
      if (running) {
        return running.then(function (r) {
          var shared = { ranges: r.ranges, stats: r.stats };
          shared.stats.fromCache = true; // 对后来者而言等价于命中复用
          return shared;
        });
      }
      // ③ 真正探测：登记在飞，结束时无论成功失败都清理
      var task = runPtsAnalysis(text, baseUrl, opts, fp).then(function (r) {
        inflight.delete(fp);
        return r;
      }, function (e) {
        inflight.delete(fp);
        throw e;
      });
      inflight.set(fp, task);
      return task;
    } catch (e) { return Promise.resolve(empty); }
  }

  // ---- 探测主体（不含缓存/去重，由 analyzePts 调度） ----
  function runPtsAnalysis(text, baseUrl, opts, fp) {
    var empty = { ranges: [], stats: { probed: 0, resets: 0, anchor: null, skipped: false } };
    try {
      var segs = parseSegments(text, baseUrl);
      if (segs.length < 8) return Promise.resolve(empty);
      var intervals = intervalsOf(segs);
      // 单个区间不足以判定（可能是合法的编码切换）
      if (intervals.length < 2) return Promise.resolve(empty);

      var targets = [segs[0].fetchUrl];
      for (var i = 0; i < intervals.length && targets.length < MAX_PROBES; i++) {
        targets.push(segs[intervals[i].from].fetchUrl);
      }
      if (targets.length < 3) return Promise.resolve(empty);

      return mapLimit(targets, CONCURRENCY, function (u) { return probeOne(u, opts); })
        .then(function (pts) {
          var anchor = pts[0];
          if (anchor === null || !isFinite(anchor)) {
            empty.stats.skipped = true; // 首片探测失败（fMP4 等）→ 放弃
            return empty;
          }
          var n = intervals.length;
          var ivPts = [];
          for (var k = 0; k < n; k++) ivPts.push(k + 1 < pts.length ? pts[k + 1] : null);

          // 第一遍：标出「PTS 重置且接近锚点」的候选（游标不推进）
          var candidate = new Array(n).fill(false);
          var cursor = anchor;
          for (var a = 0; a < n; a++) {
            var p = ivPts[a];
            if (p === null || !isFinite(p)) continue;
            var off = Math.abs(p - anchor);
            if (p < cursor - RESET_MIN_BACK && off <= ANCHOR_TOL) {
              candidate[a] = true; // 游标不动
            } else {
              cursor = p + intervalDur(segs, intervals[a]);
            }
          }

          // 第二遍：后向接回确认 + 生成删除区间
          var ranges = [];
          var cur = anchor;
          for (var b = 0; b < n; b++) {
            if (candidate[b]) {
              var nxt = -1;
              for (var j = b + 1; j < n; j++) { if (ivPts[j] !== null && !candidate[j]) { nxt = j; break; } }
              var confirmed = nxt !== -1 && Math.abs(ivPts[nxt] - cur) <= MATCH_TOL;
              if (confirmed) {
                ranges.push({ from: intervals[b].from, to: intervals[b].to });
                continue; // 广告不占正片时间线，游标不动
              }
            }
            if (ivPts[b] !== null && isFinite(ivPts[b])) {
              cur = ivPts[b] + intervalDur(segs, intervals[b]);
            }
          }

          var probedCount = pts.filter(function (v) { return v !== null && isFinite(v); }).length;
          var result = {
            ranges: ranges,
            stats: {
              probed: probedCount, resets: ranges.length,
              anchor: Math.round(anchor * 100) / 100, skipped: false
            }
          };
          // 只有「真正完成探测」才写结论缓存：skipped（fMP4/探测失败）不缓存，
          // 避免把「没探到」当成「没有广告」固化，让后续链路还有机会重试。
          if (probedCount >= 3) writeResult(fp, { ranges: ranges, stats: result.stats });
          return result;
        }).catch(function () { return empty; });
    } catch (e) { return Promise.resolve(empty); }
  }

  function clearCache() {
    probeCache.clear();
    resultCache.clear();
    inflight.clear();
    try {
      if (typeof sessionStorage !== 'undefined') {
        var keys = [];
        for (var i = 0; i < sessionStorage.length; i++) {
          var k = sessionStorage.key(i);
          if (k && k.indexOf(SS_PREFIX) === 0) keys.push(k);
        }
        for (var j = 0; j < keys.length; j++) {
          try { sessionStorage.removeItem(keys[j]); } catch (e) { }
        }
      }
    } catch (e) { }
  }

  // 预取入口：提前拿清单并跑探测，把结论写进缓存。调用方在「点击播放前」或
  // 「上一集播放中」触发，等真正起播时 analyzePts 命中结论缓存 → 零等待。
  // playableUrl 必须与播放器 hls.loadSource 的 URL 一致（同一份清单文本才能命中指纹）。
  // 返回 { text, result }；任何失败静默返回 null，绝不影响正常起播。
  function prefetchManifest(playableUrl, opts) {
    opts = opts || {};
    if (!playableUrl) return Promise.resolve(null);
    return Promise.resolve().then(function () {
      if (opts.manifestText) return opts.manifestText;
      return fetch(playableUrl).then(function (r) {
        if (!r || (r.status && !r.ok)) throw new Error('manifest fetch failed');
        return r.text();
      });
    }).then(function (text) {
      if (!text || typeof text !== 'string' || text.indexOf('#EXTM3U') === -1) return null;
      return analyzePts(text, playableUrl, opts).then(function (result) {
        return { text: text, result: result };
      });
    }).catch(function () { return null; });
  }

  g.WDTVPtsAd = {
    RULES_VERSION: 1,
    probeTsFirstDts: probeTsFirstDts,
    analyzePts: analyzePts,
    prefetchManifest: prefetchManifest,
    clearCache: clearCache
  };
})(typeof window !== 'undefined' ? window : globalThis);
