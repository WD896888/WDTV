// =====================================
// WDTV 共享广告过滤引擎（播放 / 下载共用）
// =====================================
// 多机制融合的 HLS 清单广告过滤，目标：用户观看/下载见不到任何广告，且绝不误伤正常内容。
//
// 机制分层（详见实施计划）：
//   a 标准标记层  #EXT-X-DATERANGE(SCTE35-OUT/IN) / #EXT-X-CUE-OUT/IN —— 直接删区间
//   b 区间评分层  DISCONTINUITY 闭合区间 + 强信号评分（host 不一致/路径令牌/EXTINF 偏离/
//                 时长占比/密钥变化/贴片位置）≥ deleteThreshold 才删；合法区间一票否决
//   c 黑名单层    分片 host 命中广告域名正则 → 连续段自成区间删除
//   d 运行时兜底  低置信度可疑区域保留并登记 regions，由播放层（默认关）seek 跳过
//
// 防误伤硬规则：异常整体回退原文；删除预算 40%；剩余分片 ≥2；fMP4 MAP/KEY 依赖检查；
//               BYTERANGE 清单禁删；合法 DISCONTINUITY 一票否决；删区间必留缝点标记。
//
// 缓存失效：输出注入 #WDTV-ADF:<签名> 版本标记（RULES_VERSION 变更即全量失效）。
// 本模块零依赖：浏览器挂 window.WDTVAdFilter，Node 经 globalThis 可供自测引用。
(function (g) {
  'use strict';

  var RULES_VERSION = 2;
  var STORAGE_KEY = 'adFilteringEnabled';
  var MARKER_PREFIX = '#WDTV-ADF:';

  // ---- 可调阈值（改检测规则必须同步 +1 RULES_VERSION，缓存签名随之失效）----
  var DELETE_BUDGET = 0.40;          // 删除总时长/全列表 上限，超过则放弃全部删除回退摘标记
  var DELETE_THRESHOLD = 4;          // 区间评分 ≥ 该值才删除
  var SUSPICIOUS_THRESHOLD = 2;      // 评分 ≥ 该值但不足删除阈值 → 保留分片、摘标记、登记 region
  var MIN_REMAIN_SEGS = 2;           // 删除后剩余分片下限
  var EXTINF_DEVIATION = 0.5;        // 区间 EXTINF 均值偏离全表中位数的比例（超过计分）
  var LEGAL_EXTINF_TOLERANCE = 0.3;  // 合法否决的 EXTINF 偏差容忍
  var DURATION_RATIO_1 = 0.25;       // 区间时长占比 > 25% 计 1 分
  var DURATION_RATIO_2 = 0.5;        // 区间时长占比 > 50% 计 2 分

  // ---- 黑名单（保守：host 级独立触发；path/query 级仅作评分证据）----
  var AD_HOST_RE = /(^|[.-])(ad|ads|adx|adv|advert|adserver|adservice|adsystem|adtech|advertising)([.-]|$)/i;
  var AD_PATH_RE = /\/(ad|ads|adv|advert|adverts|advertisement|advertising|adcode|adx|gg|guanggao|preroll|midroll|postroll)(\/|$)/i;
  var AD_QUERY_RE = /[?&](ad|adid|advert|adurl|adgroup)=/i;

  function isAdHost(host) { return !!host && AD_HOST_RE.test(host); }
  function isAdPath(pq) { return !!pq && (AD_PATH_RE.test(pq) || AD_QUERY_RE.test(pq)); }

  // /proxy/<encodeURIComponent(目标)> → 内层真实 URL；非代理形式原样返回。
  // 入参既可能是清单里的原始行（相对路径），也可能是 new URL(...) 之后的绝对 href。
  // 绝对 href 必须先剥掉 origin 再判前缀，否则永远解包不到内层 host（代理链路广告过滤会整体失效）。
  function unwrapProxied(url, proxyPrefix) {
    if (!url || typeof url !== 'string') return url;
    var p = proxyPrefix || '/proxy/';
    var candidate = url;
    if (candidate.indexOf(p) !== 0) {
      var m = /^https?:\/\/[^/?#]+(\/[^?#]*)/i.exec(candidate);
      if (m) candidate = m[1];
    }
    if (candidate.indexOf(p) === 0) {
      try {
        var inner = decodeURIComponent(candidate.slice(p.length));
        if (/^https?:\/\//i.test(inner)) return inner;
      } catch (e) { }
    }
    return url;
  }

  function safeUrl(u, base) { try { return new URL(u, base); } catch (e) { return null; } }
  function dirOf(pathname) {
    if (!pathname) return '';
    var i = pathname.lastIndexOf('/');
    return i <= 0 ? '/' : pathname.slice(0, i);
  }
  function median(arr) {
    if (!arr || !arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function topKey(counts) {
    var best = null, n = 0;
    for (var k in counts) { if (counts[k] > n) { n = counts[k]; best = k; } }
    return best;
  }
  function extractUri(line) { var m = /URI="([^"]*)"/.exec(line); return m ? m[1] : null; }
  function extractMethod(line) { var m = /METHOD=([^,\s]+)/.exec(line); return m ? m[1] : 'NONE'; }

  // ---- VOD 语义保证（与 player.js ensureVodEndList 同逻辑，自包含以便 Node 自测）----
  function ensureEndList(text) {
    if (!text || text.indexOf('#EXTINF') === -1) return text;
    if (text.indexOf('#EXT-X-ENDLIST') !== -1) return text;
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (t.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) {
        if ((parseInt(t.split(':')[1], 10) || 0) > 0) return text; // 滑动窗口：保留直播语义
      }
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n');
  }

  // 现行 legacy 回退行为：摘除 DISCONTINUITY 标记行（不动 DISCONTINUITY-SEQUENCE）+ 补 ENDLIST
  function legacyStrip(text) {
    if (!text) return '';
    var out = [];
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (l.indexOf('#EXT-X-DISCONTINUITY') === 0 && l.indexOf('#EXT-X-DISCONTINUITY-') !== 0) continue;
      out.push(l);
    }
    return ensureEndList(out.join('\n'));
  }

  // ---- 版本标记（幂等：先移除历史标记再插当前签名）----
  // 不能假定 #EXTM3U 一定在第 0 行：采集站常见首行空行 / BOM / 注释。
  // 找不到 #EXTM3U 时把标记追加到末尾（同样是被 hls.js 忽略的 # 注释行），
  // 保证签名恒定存在，否则 video-cache 双路径会每次判不匹配 → 删缓存回源。
  function stamp(text, sig) {
    if (!text || typeof text !== 'string') return text;
    var lines = text.split(/\r?\n/);
    var out = [];
    var inserted = false;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf(MARKER_PREFIX) === 0) continue;
      out.push(lines[i]);
      if (!inserted && lines[i].trim() === '#EXTM3U') {
        out.push(MARKER_PREFIX + sig);
        inserted = true;
      }
    }
    if (!inserted) out.push(MARKER_PREFIX + sig);
    return out.join('\n');
  }

  function filteringOn(storageKey) {
    try {
      return g.localStorage.getItem(storageKey || STORAGE_KEY) !== 'false';
    } catch (e) { return true; }
  }
  function currentSignature(storageKey) {
    return 'v' + RULES_VERSION + (filteringOn(storageKey) ? '' : '-off');
  }
  function textMatchesCurrentSignature(text, storageKey) {
    if (!text || typeof text !== 'string') return false;
    var m = /^#WDTV-ADF:(.+)$/m.exec(text);
    return !!m && m[1].trim() === currentSignature(storageKey);
  }

  // =====================================
  // 解析：行 → 条目表 + 分片表
  // =====================================
  function parseLines(text, baseUrl, proxyPrefix) {
    var lines = text.split(/\r?\n/);
    var entries = [];
    var segs = [];
    var hasByteRange = false;
    var pendingDur = 0, pendingDisc = false, pendingExtinfLine = -1, lastDiscLine = -1;
    var curKey = null, curMap = null;
    // 声明「出现在本分片的声明块里」的标记。curKey/curMap 是持续生效的引用，
    // 不能拿来判定区间内是否有新声明（AES-128 清单会让所有分片的 keyRef 恒非空）。
    var pendingKeyDecl = false, pendingMapDecl = false;

    for (var idx = 0; idx < lines.length; idx++) {
      var line = lines[idx].trim();
      var e = { i: idx, t: 'tag', raw: lines[idx] };

      if (!line) { entries.push(e); continue; }

      if (line.indexOf('#EXT-X-DISCONTINUITY') === 0 && line.indexOf('#EXT-X-DISCONTINUITY-') !== 0) {
        e.t = 'disc';
        pendingDisc = true;
        lastDiscLine = idx;
      } else if (line.indexOf('#EXT-X-KEY') === 0) {
        e.t = 'key';
        e.uri = extractUri(line);
        e.method = extractMethod(line);
        curKey = { line: idx, uri: e.uri, method: e.method };
        e.keyRef = curKey;
        pendingKeyDecl = true;
      } else if (line.indexOf('#EXT-X-MAP') === 0) {
        e.t = 'map';
        e.uri = extractUri(line);
        curMap = { line: idx, uri: e.uri };
        e.mapRef = curMap;
        pendingMapDecl = true;
      } else if (line.indexOf('#EXT-X-BYTERANGE') === 0) {
        hasByteRange = true;
      } else if (line.indexOf('#EXTINF:') === 0) {
        e.t = 'extinf';
        e.dur = parseFloat(line.slice(8));
        if (!isFinite(e.dur)) e.dur = 0;
        pendingDur = e.dur;
        pendingExtinfLine = idx;
      } else if (line.indexOf('#EXT-X-DATERANGE') === 0 || line.indexOf('#EXT-X-CUE-OUT') === 0 || line.indexOf('#EXT-X-CUE-IN') === 0) {
        e.t = 'cue';
        e.cue = parseCue(line);
      } else if (line.charAt(0) === '#') {
        e.t = 'tag';
      } else {
        // 分片 URI 行
        e.t = 'uri';
        var abs = safeUrl(line, baseUrl);
        var inner = abs ? unwrapProxied(abs.href, proxyPrefix) : null;
        var real = inner ? safeUrl(inner, baseUrl) : null;
        var seg = {
          _idx: segs.length,
          i: idx,
          extinfLine: pendingExtinfLine,
          url: abs ? abs.href : null,
          host: real ? real.host : (abs ? abs.host : null),
          dir: real ? dirOf(real.pathname) : (abs ? dirOf(abs.pathname) : null),
          pq: real ? (real.pathname + real.search) : (abs ? (abs.pathname + abs.search) : ''),
          dur: pendingDur,
          discBefore: pendingDisc,
          discLine: pendingDisc ? lastDiscLine : -1,
          keyRef: curKey,
          mapRef: curMap,
          keyDeclHere: pendingKeyDecl,
          mapDeclHere: pendingMapDecl
        };
        e.seg = seg;
        segs.push(seg);
        pendingDur = 0;
        pendingDisc = false;
        pendingExtinfLine = -1;
        pendingKeyDecl = false;
        pendingMapDecl = false;
      }
      entries.push(e);
    }
    return { lines: lines, entries: entries, segs: segs, hasByteRange: hasByteRange };
  }

  function parseCue(line) {
    if (line.indexOf('#EXT-X-CUE-OUT') === 0) return { dir: 'out' };
    if (line.indexOf('#EXT-X-CUE-IN') === 0) return { dir: 'in' };
    if (/SCTE35-OUT|CUE-OUT/i.test(line)) return { dir: 'out' };
    if (/SCTE35-IN|CUE-IN/i.test(line)) return { dir: 'in' };
    return { dir: 'none' };
  }

  // =====================================
  // 区间识别：标准标记 / DISCONTINUITY 闭合对 / 黑名单连续段
  // =====================================
  function detectIntervals(parsed) {
    var segs = parsed.segs;
    var intervals = [];

    // 1) DISCONTINUITY 闭合对：discBefore 分片开区间，下一个 discBefore 分片闭合
    var openIdx = -1;
    for (var s = 0; s < segs.length; s++) {
      if (!segs[s].discBefore) continue;
      if (openIdx === -1) { openIdx = s; continue; }
      intervals.push(makeDiscInterval(openIdx, s - 1, segs, false));
      openIdx = s;
    }
    if (openIdx !== -1) {
      intervals.push(makeDiscInterval(openIdx, segs.length - 1, segs, true)); // 未闭合
    }

    // 2) 黑名单连续段（unwrapped host 命中）
    var runFrom = -1;
    for (var s2 = 0; s2 <= segs.length; s2++) {
      var ad = s2 < segs.length && isAdHost(segs[s2].host);
      if (ad) { if (runFrom === -1) runFrom = s2; }
      else if (runFrom !== -1) {
        intervals.push(makeBlacklistInterval(runFrom, s2 - 1, segs));
        runFrom = -1;
      }
    }

    // 3) 标准标记（CUE/DATERANGE）
    var openCueLine = -1;
    var unpairedCueLines = [];
    for (var i = 0; i < parsed.entries.length; i++) {
      var e = parsed.entries[i];
      if (e.t !== 'cue' || !e.cue || e.cue.dir === 'none') continue;
      if (e.cue.dir === 'out') {
        if (openCueLine === -1) openCueLine = i;
      } else if (openCueLine !== -1) {
        var from = firstSegIdxAfterLine(segs, openCueLine);
        var to = lastSegIdxBeforeLine(segs, i);
        if (from !== -1 && to >= from) {
          intervals.push({
            kind: 'standard', from: from, to: to,
            openerLine: openCueLine, closerLine: i,
            unpaired: false, hasMap: false, hasKey: false
          });
        }
        openCueLine = -1;
      }
    }
    if (openCueLine !== -1) unpairedCueLines.push(openCueLine); // 未闭合：仅摘元数据行
    parsed._unpairedCueLines = unpairedCueLines;

    return intervals;
  }

  function makeDiscInterval(from, to, segs, unpaired) {
    return {
      kind: 'disc', from: from, to: to,
      openerLine: segs[from].discLine,
      closerLine: (!unpaired && to + 1 < segs.length && segs[to + 1].discBefore) ? segs[to + 1].discLine : -1,
      unpaired: !!unpaired,
      // 只关心「区间内部新出现」的声明；区间前声明、区间内仅被引用是安全的
      hasMap: regionHas(segs, from, to, 'mapDeclHere'),
      hasKey: regionHas(segs, from, to, 'keyDeclHere')
    };
  }

  function makeBlacklistInterval(from, to, segs) {
    return {
      kind: 'blacklist', from: from, to: to,
      openerLine: segs[from].discLine >= 0 ? segs[from].discLine : -1,
      closerLine: -1,
      unpaired: false,
      hasMap: regionHas(segs, from, to, 'mapDeclHere'),
      hasKey: regionHas(segs, from, to, 'keyDeclHere')
    };
  }

  function regionHas(segs, from, to, field) {
    for (var k = from; k <= to; k++) { if (segs[k][field]) return true; }
    return false;
  }
  function firstSegIdxAfterLine(segs, line) {
    for (var k = 0; k < segs.length; k++) { if (segs[k].i > line) return k; }
    return -1;
  }
  function lastSegIdxBeforeLine(segs, line) {
    for (var k = segs.length - 1; k >= 0; k--) { if (segs[k].i < line) return k; }
    return -1;
  }

  // =====================================
  // 评分与决策
  // =====================================
  function buildCtx(parsed) {
    var segs = parsed.segs;
    var hostCount = {}, dirCount = {};
    var durs = [], total = 0;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.host) hostCount[s.host] = (hostCount[s.host] || 0) + 1;
      if (s.dir) dirCount[s.dir] = (dirCount[s.dir] || 0) + 1;
      durs.push(s.dur || 0);
      total += s.dur || 0;
    }
    return {
      majorityHost: topKey(hostCount),
      majorityDir: topKey(dirCount),
      medianDur: median(durs),
      totalSecs: total,
      segCount: segs.length
    };
  }

  function regionAvgDur(segs, from, to) {
    var sum = 0;
    for (var k = from; k <= to; k++) sum += segs[k].dur || 0;
    return sum / (to - from + 1);
  }
  function regionSecs(segs, from, to) {
    var sum = 0;
    for (var k = from; k <= to; k++) sum += segs[k].dur || 0;
    return sum;
  }

  function scoreDiscInterval(iv, parsed, ctx) {
    var segs = parsed.segs;
    var score = 0, signals = [];
    var hostDiff = true, pathHit = false, keyChanged = false;
    var keyBefore = iv.from > 0 ? (segs[iv.from - 1].keyRef || null) : null;

    for (var k = iv.from; k <= iv.to; k++) {
      var s = segs[k];
      if (!s.host || s.host === ctx.majorityHost) hostDiff = false;
      if (isAdPath(s.pq)) pathHit = true;
      if (s.keyRef && (!keyBefore || (s.keyRef.uri || '') !== (keyBefore.uri || '') || s.keyRef.method !== keyBefore.method)) keyChanged = true;
    }
    if (hostDiff) { score += 3; signals.push('host'); }
    if (pathHit) { score += 2; signals.push('path'); }
    if (ctx.medianDur > 0) {
      var avg = regionAvgDur(segs, iv.from, iv.to);
      if (Math.abs(avg - ctx.medianDur) / ctx.medianDur > EXTINF_DEVIATION) { score += 1; signals.push('extinf'); }
    }
    var ratio = ctx.totalSecs > 0 ? regionSecs(segs, iv.from, iv.to) / ctx.totalSecs : 0;
    if (ratio > DURATION_RATIO_2) { score += 2; signals.push('dur50'); }
    else if (ratio > DURATION_RATIO_1) { score += 1; signals.push('dur25'); }
    if (keyChanged) { score += 1; signals.push('key'); }
    if (iv.from === 0 || iv.to === segs.length - 1) { score += 1; signals.push('edge'); }

    iv.score = score;
    iv.signals = signals;
    return score;
  }

  // 合法 DISCONTINUITY 一票否决：host 相同 且 目录相同 且 EXTINF 偏差 ≤ 容忍 且 未命中黑名单 host
  function legalVeto(iv, parsed, ctx) {
    var segs = parsed.segs;
    for (var k = iv.from; k <= iv.to; k++) {
      var s = segs[k];
      if (isAdHost(s.host)) return false;
      if (s.host && s.host !== ctx.majorityHost) return false;
      if (s.dir && s.dir !== ctx.majorityDir) return false;
    }
    if (ctx.medianDur > 0) {
      var avg = regionAvgDur(segs, iv.from, iv.to);
      if (Math.abs(avg - ctx.medianDur) / ctx.medianDur > LEGAL_EXTINF_TOLERANCE) return false;
    }
    return true;
  }

  function downgrade(d, reason) {
    d.action = 'suspicious';
    d.reason = reason;
    d.confidence = Math.min(d.confidence || 0.5, 0.5);
  }

  function decide(iv, parsed, ctx) {
    var segs = parsed.segs;
    var d = {
      kind: iv.kind, from: iv.from, to: iv.to,
      openerLine: iv.openerLine, closerLine: iv.closerLine,
      fromLine: -1, toLine: -1,
      action: 'leave', score: 0, signals: [], confidence: 0, reason: ''
    };

    if (iv.unpaired) {
      d.action = 'unpaired';
      d.reason = 'unpaired-discontinuity';
      d.confidence = 0.3;
      return d;
    }
    if (iv.kind === 'blacklist') {
      d.action = 'delete'; d.reason = 'blacklist-host'; d.confidence = 0.9; d.score = DELETE_THRESHOLD + 1;
    } else if (iv.kind === 'standard') {
      d.action = 'delete'; d.reason = 'scte35-cue'; d.confidence = 0.95; d.score = DELETE_THRESHOLD + 1;
    } else {
      d.score = scoreDiscInterval(iv, parsed, ctx);
      d.signals = iv.signals || [];
      if (legalVeto(iv, parsed, ctx)) {
        d.action = 'leave'; d.reason = 'legal-discontinuity';
        return d;
      }
      if (d.score >= DELETE_THRESHOLD) {
        d.action = 'delete'; d.reason = 'score';
        d.confidence = Math.min(0.9, 0.5 + d.score * 0.05);
      } else if (d.score >= SUSPICIOUS_THRESHOLD) {
        d.action = 'suspicious'; d.reason = 'suspicious';
        d.confidence = 0.4 + d.score * 0.05;
      } else {
        d.action = 'leave'; d.reason = 'low-score';
      }
    }

    if (d.action === 'delete') {
      if (parsed.hasByteRange) { downgrade(d, 'byterange'); return d; }
      if (!checkIntegrity(iv, parsed)) { downgrade(d, 'map-key-dep'); return d; }
    }
    if (d.action === 'delete') {
      d.fromLine = d.openerLine >= 0 ? d.openerLine : segs[d.from].i;
      // 标准标记（CUE/DATERANGE）的闭合行是元数据，随区间一并删除；
      // DISCONTINUITY/黑名单区间的 closer 是缝点标记，必须保留
      d.toLine = (iv.kind === 'standard' && iv.closerLine >= 0) ? iv.closerLine : segs[d.to].i;
    }
    return d;
  }

  // fMP4 依赖：区间含 MAP/KEY 且区间后、下一存活分片前无新声明 → 不可删
  function checkIntegrity(iv, parsed) {
    var segs = parsed.segs;
    var nextSeg = null;
    for (var k = iv.to + 1; k < segs.length; k++) { nextSeg = segs[k]; break; }
    if (!nextSeg) return true; // 尾区间：无后续分片依赖
    for (var L = segs[iv.to].i + 1; L < nextSeg.i; L++) {
      var e = parsed.entries[L];
      if (e.t === 'map' || e.t === 'key') return true; // 已有新声明，区间内声明被取代
    }
    if (iv.hasMap || iv.hasKey) return false;
    return true;
  }

  // =====================================
  // 重建输出
  // =====================================
  // 全局标签行永不随区间删除：这些行落在删除范围内时若被一起删掉，
  // hls.js 会丢失 media/discontinuity 序号（时间戳错乱、音画不同步），
  // downloader 的 mediaSeq 解析同样受影响。
  var GLOBAL_TAG_RE = /^#(?:EXTM3U|EXT-X-(?:VERSION|TARGETDURATION|MEDIA-SEQUENCE|DISCONTINUITY-SEQUENCE|PLAYLIST-TYPE|ENDLIST|INDEPENDENT-SEGMENTS|START|DEFINE|SERVER-CONTROL|PART-INF|SESSION-KEY|CONTENT-STEERING|PRELOAD-HINT|RENDITION-REPORT|SKIP))\b/;
  function isGlobalLine(e) {
    if (!e || e.t === 'uri') return false;
    return GLOBAL_TAG_RE.test(String(e.raw || '').trim());
  }

  function rebuild(parsed, decisions) {
    var deleteLines = {};   // 'delete' 决策覆盖的行（含 opener/EXTINF/URI/内部 MAP·KEY）
    var stripLines = {};    // 'suspicious'/'unpaired' 仅摘标记行
    var i, L;

    decisions.forEach(function (d) {
      if (d.action === 'delete') {
        for (L = d.fromLine; L <= d.toLine; L++) deleteLines[L] = true;
      } else if (d.action === 'suspicious' || d.action === 'unpaired') {
        if (d.openerLine >= 0) stripLines[d.openerLine] = true;
        if (d.closerLine >= 0) stripLines[d.closerLine] = true;
      }
    });
    (parsed._unpairedCueLines || []).forEach(function (line) { stripLines[line] = true; });

    var out = [];
    var gapPending = false;
    for (i = 0; i < parsed.entries.length; i++) {
      var cur = parsed.entries[i];
      // 全局行即便落在删除范围内也强制保留，且不中断 seam 标记的 gapPending 语义
      if (deleteLines[i] && !isGlobalLine(cur)) { gapPending = true; continue; }
      if (stripLines[i] && !isGlobalLine(cur)) continue;
      var e = cur;
      if (e.t === 'uri' && e.seg && gapPending) {
        // 删区间缝点：保证下一存活分片前有 DISCONTINUITY 标记（hls.js/downloader 按显式 splice 处理）
        var last = out.length ? out[out.length - 1] : null;
        var lastIsDisc = last && (last.t === 'disc' || last.t === 'disc-ins');
        if (!lastIsDisc) {
          if (last && last.t === 'extinf' && last.i === e.seg.extinfLine) {
            out.pop(); // 标记须位于 EXTINF 之前
            out.push({ t: 'disc-ins', raw: '#EXT-X-DISCONTINUITY' });
            out.push(parsed.entries[e.seg.extinfLine]);
          } else {
            out.push({ t: 'disc-ins', raw: '#EXT-X-DISCONTINUITY' });
          }
        }
        gapPending = false;
      }
      out.push(e);
    }

    // 输出时间轴：累计 EXTINF → 每个存活分片的输出坐标
    var acc = 0;
    var outCoord = {}; // origSegIdx → {start,end}
    for (i = 0; i < out.length; i++) {
      var it = out[i];
      if (it.t === 'uri' && it.seg) {
        var s0 = acc;
        acc += it.seg.dur || 0;
        outCoord[it.seg._idx] = { start: s0, end: acc };
      }
    }

    var text = out.map(function (it) { return it.raw; }).join('\n');
    return { text: text, outCoord: outCoord, totalSecs: acc };
  }

  // =====================================
  // 主入口
  // =====================================
  function analyze(text, baseUrl, opts) {
    opts = opts || {};
    // 实际生效的开关：opts.enabled 显式优先，否则读 localStorage。
    // 版本签名只由「规则版本 + 主开关存储值」决定，必须与 textMatchesCurrentSignature /
    // currentSignature 同源：校验侧（video-cache.cachedRead 的内存与 IDB 两条路径）只读
    // localStorage，若这里按 opts.enabled 生成签名，显式覆盖开关或云同步在页面会话内改写
    // 存储时两侧会分裂 → 每次命中都删缓存回源，违反「不增加延迟」硬门槛。
    var effectiveOn = (opts.enabled !== undefined) ? (opts.enabled !== false) : filteringOn(opts.storageKey);
    var sig = currentSignature(opts.storageKey);
    var res = {
      text: (typeof text === 'string') ? text : '',
      removed: [], regions: [],
      stats: {
        totalSecs: 0, removedSecs: 0, removedSegs: 0, deletedIntervals: 0,
        keptRegions: 0, budgetHit: false, parseOk: false, url: baseUrl || ''
      }
    };
    if (!text || typeof text !== 'string') return res;

    // 主清单 / 非媒体清单：零改动仅打标记
    if (text.indexOf('#EXTINF') === -1) {
      res.text = stamp(text, sig);
      res.stats.parseOk = true;
      return res;
    }

    try {
      var parsed = parseLines(text, baseUrl, opts.proxyPrefix);
      if (!parsed.segs.length) {
        res.text = stamp(ensureEndList(text), sig);
        res.stats.parseOk = true;
        return res;
      }
      var ctx = buildCtx(parsed);
      res.stats.totalSecs = ctx.totalSecs;
      res.stats.parseOk = true;

      if (!effectiveOn) {
        res.text = stamp(ensureEndList(text), sig);
        return res;
      }

      var intervals = detectIntervals(parsed);
      var decisions = intervals.map(function (iv) { return decide(iv, parsed, ctx); });

      // 合并重叠的 delete 区间（黑名单段可能落在 DISCONTINUITY 区间内）
      var dels = decisions.filter(function (d) { return d.action === 'delete'; })
        .sort(function (a, b) { return a.from - b.from; });
      var merged = [];
      dels.forEach(function (d) {
        var last = merged[merged.length - 1];
        if (last && d.from <= last.to + 1) {
          last.to = Math.max(last.to, d.to);
          last.reasons.push(d.reason);
          last.kinds.push(d.kind);
          last.confidence = Math.max(last.confidence, d.confidence);
          last.closerLine = Math.max(last.closerLine, d.closerLine); // 保留最晚的闭合标记行
        } else {
          merged.push({ from: d.from, to: d.to, reasons: [d.reason], kinds: [d.kind], confidence: d.confidence, openerLine: d.openerLine, closerLine: d.closerLine });
        }
      });

      // 删除预算：EXTINF 全为 0 / 缺失时 totalSecs=0，不能跳过预算检查，
      // 否则 40% 防线形同虚设（实测 5 段可删 3 段）。此时退化为按分片数占比判定。
      var candSecs = 0, candSegs = 0;
      merged.forEach(function (m) {
        candSecs += regionSecs(parsed.segs, m.from, m.to);
        candSegs += m.to - m.from + 1;
      });
      var overBudget = ctx.totalSecs > 0
        ? (candSecs / ctx.totalSecs > DELETE_BUDGET)
        : (ctx.segCount > 0 && candSegs / ctx.segCount > DELETE_BUDGET);
      if (merged.length && overBudget) {
        res.stats.budgetHit = true;
        res.text = stamp(legacyStrip(text), sig);
        return res;
      }

      // 完整性 / 剩余分片（合并后统一校验）
      var unionSegs = 0;
      merged.forEach(function (m) { unionSegs += m.to - m.from + 1; });
      if (merged.length && ctx.segCount - unionSegs < MIN_REMAIN_SEGS) {
        res.stats.budgetHit = true; // 复用标记：放弃删除
        res.text = stamp(legacyStrip(text), sig);
        return res;
      }

      // 合并区间转为行级删除范围
      var finalDeletes = merged.map(function (m) {
        // 起点：优先区间 opener 标记行（DISCONTINUITY/CUE-OUT）；否则从上一存活分片 URI 的下一行
        // 起删（覆盖本区间的 EXTINF/KEY/MAP 声明组，避免悬空 EXTINF 或残留声明污染后续分片）
        var opener = -1;
        for (var k = m.from; k <= m.to; k++) { if (parsed.segs[k].discBefore) { opener = parsed.segs[k].discLine; break; } }
        var fromLine = m.openerLine >= 0 ? m.openerLine : (opener >= 0 ? opener : -1);
        if (fromLine < 0) {
          var prev = m.from > 0 ? parsed.segs[m.from - 1].i : -1;
          if (prev >= 0) fromLine = prev + 1;
          else fromLine = parsed.segs[m.from].extinfLine >= 0 ? parsed.segs[m.from].extinfLine : parsed.segs[m.from].i;
        }
        var toLine = parsed.segs[m.to].i;
        if (m.kinds.indexOf('standard') >= 0) {
          // 标准标记的闭合行（CUE-IN/DATERANGE-IN）是元数据，随区间删除
          if (m.closerLine >= 0) toLine = Math.max(toLine, m.closerLine);
          else {
            for (var L = toLine + 1; L < parsed.entries.length; L++) {
              var ee = parsed.entries[L];
              if (ee.t === 'uri') break;
              if (ee.t === 'cue' && ee.cue && ee.cue.dir === 'in') { toLine = L; break; }
            }
          }
        }
        return {
          action: 'delete', from: m.from, to: m.to,
          fromLine: fromLine,
          toLine: toLine,
          reason: m.reasons.join('+'), confidence: m.confidence
        };
      });
      // 合并区间完整性复查（用合并后的 to 判定后续依赖）
      finalDeletes = finalDeletes.filter(function (d) {
        var iv = { from: d.from, to: d.to, hasMap: regionHas(parsed.segs, d.from, d.to, 'mapDeclHere'), hasKey: regionHas(parsed.segs, d.from, d.to, 'keyDeclHere') };
        if (!checkIntegrity(iv, parsed)) {
          decisions.push({ action: 'suspicious', from: d.from, to: d.to, openerLine: d.fromLine, closerLine: -1, reason: 'map-key-dep', confidence: 0.5, score: 0, signals: [] });
          return false;
        }
        return true;
      });

      var finalDecisions = decisions.filter(function (d) { return d.action !== 'delete'; }).concat(finalDeletes);
      var rebuilt = rebuild(parsed, finalDecisions);

      // removed / regions（输出时间轴坐标）
      finalDeletes.forEach(function (d) {
        var seam = rebuilt.totalSecs;
        for (var k = d.to + 1; k < parsed.segs.length; k++) {
          var c = rebuilt.outCoord[k];
          if (c) { seam = c.start; break; }
        }
        res.removed.push({
          start: seam, end: seam,
          secs: regionSecs(parsed.segs, d.from, d.to),
          segs: d.to - d.from + 1,
          reason: d.reason, confidence: d.confidence
        });
      });
      finalDecisions.forEach(function (d) {
        if (d.action !== 'suspicious') return;
        var cs = rebuilt.outCoord[d.from], ce = rebuilt.outCoord[d.to];
        if (!cs || !ce) return; // 分片已被删除（不应发生）
        res.regions.push({ start: cs.start, end: ce.end, reason: d.reason, confidence: d.confidence });
      });

      res.stats.removedSecs = res.removed.reduce(function (a, r) { return a + r.secs; }, 0);
      res.stats.removedSegs = res.removed.reduce(function (a, r) { return a + r.segs; }, 0);
      res.stats.deletedIntervals = res.removed.length;
      res.stats.keptRegions = res.regions.length;

      res.text = stamp(ensureEndList(rebuilt.text), sig);
      return res;
    } catch (e) {
      // 防误伤硬规则：任何异常 → 原文 + ENDLIST + 标记
      try {
        res.text = stamp(ensureEndList(text), sig);
      } catch (e2) { res.text = text; }
      res.removed = []; res.regions = [];
      res.stats.parseOk = false;
      return res;
    }
  }

  function normalize(text, baseUrl, opts) {
    return analyze(text, baseUrl, opts).text;
  }

  // =====================================
  // 导出
  // =====================================
  g.WDTVAdFilter = {
    RULES_VERSION: RULES_VERSION,
    markerPrefix: MARKER_PREFIX,
    currentSignature: currentSignature,
    textMatchesCurrentSignature: textMatchesCurrentSignature,
    analyze: analyze,
    normalize: normalize,
    legacyStrip: legacyStrip,
    ensureEndList: ensureEndList
  };
})(typeof window !== 'undefined' ? window : globalThis);
