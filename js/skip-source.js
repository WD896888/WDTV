// 片头片尾数据取数层（内置多源、只读、不上传）
//   · 公共/众包库：同源 GET /api/skip-marks，由服务端查 D1 公共表（无写入接口）
//   · 第三方库：同源 GET /api/skip-marks/introdb，服务端代理 IntroDB 公开只读接口
//   · 本地历史标记：仅作兼容补齐（旧版用户打过点，不再提供新增入口）
// 所有地址、超时、权重、阈值都写死在本文件，用户无需也无法配置；任何失败静默降级。
(function (g) {
  'use strict';

  var CONFIG = {
    // 高置信门槛（集中配置，便于后续调整）：
    //   1) 至少两个独立来源一致，且累计投票 >= 3、置信度 >= 0.8；
    //   2) 或单一权威来源但投票 >= 5 且置信度 >= 0.9（单一弱证据仍不算）。
    highConfidence: 0.8,
    minVotes: 3,
    minSources: 2,
    strongSingleVotes: 5,
    strongSingleConfidence: 0.9,
    // 只有单一类型（有片头没片尾，或反之）视为部分数据，一律降级为按钮。
    lowConfidenceMax: 0.79,
    // 本地历史标记来自用户亲手打点，保留为强先验（仅类型齐全时自动跳）。
    localConfidence: 0.95,
    // 多源对齐容差（秒）：起止时间都在容差内才算同一条证据，避免把不同剧集误合并。
    alignToleranceSec: 2,
    cacheTtlMs: 10 * 60 * 1000,
    defaultTimeoutMs: 3200
  };

  // 内置数据源（相对同源，默认启用；没有任何用户可配置项）
  var SOURCES = [
    { name: 'public', path: '/api/skip-marks' },
    { name: 'introdb', path: '/api/skip-marks/introdb' }
  ];

  var cache = Object.create(null);

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function clamp01(v) {
    if (!isNum(v)) return 0;
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }

  function sourceList(raw) {
    if (Array.isArray(raw)) {
      return raw.filter(function (x) { return typeof x === 'string' && x; });
    }
    if (typeof raw === 'number' && raw >= 0) return new Array(Math.floor(raw)).fill('s');
    if (typeof raw === 'string' && raw) return raw.split(',').filter(Boolean);
    return [];
  }

  function uniq(list) {
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (!v || seen[v]) continue;
      seen[v] = true;
      out.push(v);
    }
    return out;
  }

  // 把服务端 / 旧本地结构统一成内部段结构；非法段返回 null。
  function normalizeSegment(raw, origin) {
    if (!raw || typeof raw !== 'object') return null;
    var type = raw.type;
    if (type === 'intro' || type === 'outro') type = type === 'intro' ? 'opening' : 'ending';
    if (type !== 'opening' && type !== 'middle' && type !== 'ending') return null;

    var start = isNum(raw.start) ? raw.start : raw.start_sec;
    var end = isNum(raw.end) ? raw.end : raw.end_sec;
    if (!isNum(start) || start < 0) return null;
    if (!isNum(end)) return null;
    if (end !== -1 && !(end > start)) return null;
    if (end === -1 && type !== 'ending') return null;

    var votes = isNum(raw.votes) ? Math.max(0, Math.floor(raw.votes))
      : (isNum(raw.submission_count) ? Math.max(0, Math.floor(raw.submission_count)) : 0);
    var sources = sourceList(raw.sources);
    if (typeof raw.origin === 'string' && raw.origin) sources.push(raw.origin);
    sources = uniq(sources);
    // 只有来源缺失时才用数据源名兜底；数据源名本身不计入「独立来源数」，
    // 避免同一个接口被重复计数而虚高置信度。
    if (!sources.length && origin) sources = [origin];
    var confidence = isNum(raw.confidence) ? clamp01(raw.confidence) : 0.5;

    return {
      type: type,
      start: start,
      end: end,
      confidence: confidence,
      votes: votes,
      sources: sources,
      origin: typeof raw.origin === 'string' && raw.origin ? raw.origin : (origin || 'public'),
      source: typeof raw.source === 'string' && raw.source ? raw.source : (origin || 'public')
    };
  }

  // 服务端返回 {segments:[...]} 或直接数组；同类型只保留证据更强的一条。
  function normalizePayload(payload, origin) {
    var list = [];
    if (Array.isArray(payload)) list = payload;
    else if (payload && Array.isArray(payload.segments)) list = payload.segments;
    else if (payload && payload.data && Array.isArray(payload.data.segments)) list = payload.data.segments;
    else if (payload && payload.data && Array.isArray(payload.data)) list = payload.data;

    var out = [];
    var best = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var seg = normalizeSegment(list[i], origin);
      if (!seg) continue;
      var cur = best[seg.type];
      if (!cur || segmentScore(seg) > segmentScore(cur)) {
        best[seg.type] = seg;
      }
    }
    Object.keys(best).forEach(function (k) { out.push(best[k]); });
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  function segmentScore(s) {
    return (s.sources.length * 1000) + (s.votes * 10) + s.confidence;
  }

  function readLocalSegments(key, storageKey, marksApi) {
    var api = marksApi || g.WDTVSkipMarks;
    if (!api || !key || !storageKey) return [];
    var raw = null;
    try {
      raw = g.localStorage ? g.localStorage.getItem(storageKey) : null;
    } catch (e) {
      raw = null;
    }
    if (!raw) return [];
    var store;
    try {
      store = JSON.parse(raw);
    } catch (e) {
      return [];
    }
    store = api.migrateSkipMarks(store);
    var mark = store && store.marks ? store.marks[key] : null;
    if (!mark || mark.enabled === false || !Array.isArray(mark.segments)) return [];

    var out = [];
    for (var i = 0; i < mark.segments.length; i++) {
      var s = mark.segments[i];
      if (!s || typeof s !== 'object') continue;
      if (s.type !== 'opening' && s.type !== 'middle' && s.type !== 'ending') continue;
      if (!isNum(s.start) || !isNum(s.end)) continue;
      out.push({
        type: s.type,
        start: s.start,
        end: s.end,
        confidence: CONFIG.localConfidence,
        votes: 1,
        sources: ['local'],
        origin: 'local',
        source: 'local'
      });
    }
    return out;
  }

  // 时间轴对齐：同类型、起止都在容差内的视为同一证据，合并来源并取各指标最大值。
  // 对不齐的多组证据按「来源数 → 投票数 → 置信度」选一组，符合冲突时取多来源/高投票。
  function mergeAligned(groups) {
    var byType = Object.create(null);
    for (var gi = 0; gi < groups.length; gi++) {
      var list = groups[gi] || [];
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (!s) continue;
        (byType[s.type] || (byType[s.type] = [])).push(s);
      }
    }

    var out = [];
    Object.keys(byType).forEach(function (type) {
      var clusters = [];
      var list = byType[type];
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        var hit = null;
        for (var c = 0; c < clusters.length; c++) {
          var cl = clusters[c];
          var startDiff = Math.abs(cl.start - s.start);
          var endDiff = (cl.end === -1 || s.end === -1) ? 0 : Math.abs(cl.end - s.end);
          if (startDiff <= CONFIG.alignToleranceSec && endDiff <= CONFIG.alignToleranceSec) {
            hit = cl;
            break;
          }
        }
        if (!hit) {
          clusters.push({
            type: type,
            start: s.start,
            end: s.end,
            confidence: s.confidence,
            votes: s.votes,
            sources: s.sources.slice(),
            origins: [s.origin]
          });
          continue;
        }
        hit.sources = uniq(hit.sources.concat(s.sources));
        hit.origins = uniq(hit.origins.concat([s.origin]));
        hit.votes = Math.max(hit.votes, s.votes);
        hit.confidence = Math.max(hit.confidence, s.confidence);
        // 起止取证据更强（来源多/投票高）的一条，保留其精确时间
        if (segmentScore(s) > segmentScore(hit)) {
          hit.start = s.start;
          hit.end = s.end;
        }
      }

      clusters.sort(function (a, b) { return segmentScore(b) - segmentScore(a); });
      var win = clusters[0];
      if (win) {
        out.push({
          type: type,
          start: win.start,
          end: win.end,
          confidence: win.confidence,
          votes: win.votes,
          sources: win.sources,
          origin: win.origins.indexOf('local') !== -1 && win.origins.length === 1 ? 'local' : win.origins[0],
          source: win.origins.length > 1 ? 'mixed' : win.origins[0]
        });
      }
    });

    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  function isStrongEvidence(seg) {
    if (seg.sources.length >= CONFIG.minSources &&
        seg.votes >= CONFIG.minVotes &&
        seg.confidence >= CONFIG.highConfidence) return true;
    if (seg.sources.length >= 1 &&
        seg.votes >= CONFIG.strongSingleVotes &&
        seg.confidence >= CONFIG.strongSingleConfidence) return true;
    return false;
  }

  // 覆盖度修正（最终唯一判定处）：
  //   · 片头/片尾必须两类齐全，任一缺失一律只给按钮；
  //   · 本地历史标记是用户亲手打点，类型齐全时保留自动跳兼容；
  //   · 其余按集中阈值判定。
  function applyCoverage(segments) {
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < (segments || []).length; i++) {
      var s = segments[i];
      if (!s || typeof s !== 'object') continue;
      var sources = Array.isArray(s.sources) ? s.sources.slice() : [];
      out.push({
        type: s.type,
        start: s.start,
        end: s.end,
        confidence: isNum(s.confidence) ? s.confidence : 0,
        votes: isNum(s.votes) ? s.votes : 0,
        sources: sources,
        origin: typeof s.origin === 'string' ? s.origin : 'public',
        source: typeof s.source === 'string' ? s.source : 'public',
        autoEligible: false
      });
      seen[s.type] = true;
    }

    var complete = !!(seen.opening && seen.ending);
    for (var j = 0; j < out.length; j++) {
      var o = out[j];
      if (!complete) {
        o.autoEligible = false;
        if (o.confidence > CONFIG.lowConfidenceMax) o.confidence = CONFIG.lowConfidenceMax;
        continue;
      }
      if (o.sources.indexOf('local') !== -1) {
        o.autoEligible = true;
      } else {
        o.autoEligible = isStrongEvidence(o);
      }
    }
    return out;
  }

  function finish(segments, source, error, extra) {
    var res = { segments: applyCoverage(segments), source: source, error: error || null };
    if (extra) {
      Object.keys(extra).forEach(function (k) { res[k] = extra[k]; });
    }
    return res;
  }

  function buildUrl(path, opts) {
    var base = g.location && g.location.href ? g.location.href : 'http://localhost/';
    var u;
    try {
      u = new URL(path, base);
    } catch (e) {
      return '';
    }
    var params = {
      key: opts.key,
      title: opts.title,
      season: opts.season,
      episode: opts.episode,
      duration: opts.duration
    };
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      u.searchParams.set(k, String(v));
    });
    return u.toString();
  }

  function fetchJson(url, timeoutMs, fetchImpl) {
    var fn = fetchImpl || g.fetch;
    if (typeof fn !== 'function') return Promise.reject(new Error('fetch unavailable'));
    var timeout = isNum(timeoutMs) && timeoutMs > 0 ? timeoutMs : CONFIG.defaultTimeoutMs;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (ctrl) {
          try { ctrl.abort(); } catch (e) {}
        }
        reject(new Error('timeout'));
      }, timeout);
      Promise.resolve(fn(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: ctrl ? ctrl.signal : undefined
      })).then(function (res) {
        clearTimeout(timer);
        if (!res || !res.ok) {
          reject(new Error('http ' + (res ? res.status : 'unknown')));
          return;
        }
        return res.json().then(resolve, reject);
      }, function (err) {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // 从片名里识别季号（「第N季」/「第N季中文数字」/ Season N），让缓存指纹与服务端查询都带上季集。
  var CN_SEASON = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  function seasonOfTitle(title) {
    var s = String(title || '');
    var m = /第\s*(\d+)\s*季/.exec(s) || /Season\s*(\d+)/i.exec(s);
    if (m) return m[1];
    var cn = /第\s*([一二三四五六七八九十]+)\s*季/.exec(s);
    if (cn && CN_SEASON[cn[1]]) return String(CN_SEASON[cn[1]]);
    return '';
  }

  function cacheKeyOf(o) {
    return [o.title || '', o.season || seasonOfTitle(o.title), o.episode || '', o.duration ? Math.round(o.duration) : ''].join('|');
  }

  function fromCache(key) {
    var hit = cache[key];
    if (!hit) return null;
    if (Date.now() > hit.expires) {
      delete cache[key];
      return null;
    }
    return hit.segments;
  }

  // 远程数据优先；本地历史只补远程缺失的类型，避免同一类型两套时间轴互相干扰。
  function mergeWithLocal(remote, local) {
    var types = Object.create(null);
    (remote || []).forEach(function (s) { types[s.type] = true; });
    var extra = (local || []).filter(function (s) { return !types[s.type]; });
    return mergeAligned([remote || [], extra]);
  }

  // 并发查询所有内置源；单源失败/超时只丢弃该源，不影响其它源与播放。
  function querySources(opts, sources) {
    var tasks = sources.map(function (s) {
      var path = typeof s.path === 'string' ? s.path : s;
      var name = typeof s.name === 'string' ? s.name : 'source';
      var url = buildUrl(path, opts);
      if (!url) return Promise.resolve([]);
      return fetchJson(url, opts.timeoutMs, opts.fetchImpl).then(function (payload) {
        return normalizePayload(payload, name);
      }, function () {
        return [];
      });
    });
    return Promise.all(tasks);
  }

  function resolve(opts) {
    var o = opts || {};
    if (!o.season) o.season = seasonOfTitle(o.title);
    var api = o.marksApi || g.WDTVSkipMarks;
    if (o.enabled === false) {
      return Promise.resolve(finish([], 'disabled', null));
    }

    var local = readLocalSegments(o.key, o.localStorageKey, api);
    var ck = cacheKeyOf(o);
    var cached = fromCache(ck);
    if (cached) {
      return Promise.resolve(finish(mergeWithLocal(cached, local), 'cache', null));
    }

    // 没有有效标题时只读本地历史，避免把「未知视频」发给服务端做无意义匹配。
    if (o.key && String(o.key).indexOf('t:') !== 0) {
      return Promise.resolve(finish(local, local.length ? 'local' : 'none', null));
    }

    var sources = Array.isArray(o.sources) && o.sources.length ? o.sources : SOURCES;
    return querySources(o, sources).then(function (groups) {
      var remote = mergeAligned(groups);
      var merged = mergeWithLocal(remote, local);
      if (remote.length) {
        cache[ck] = { expires: Date.now() + CONFIG.cacheTtlMs, segments: remote };
      }
      var src = remote.length ? (merged.length > remote.length ? 'mixed' : 'remote') : (local.length ? 'local' : 'none');
      return finish(merged, src, null);
    }).then(null, function (err) {
      // 理论上 querySources 已自行吞掉错误；这里再兜一层，保证播放不受影响。
      return finish(local, local.length ? 'local' : 'none', err && err.message ? err.message : 'request failed');
    });
  }

  g.WDTVSkipSource = {
    CONFIG: CONFIG,
    SOURCES: SOURCES,
    resolve: resolve,
    normalizePayload: normalizePayload,
    normalizeSegment: normalizeSegment,
    mergeAligned: mergeAligned,
    applyCoverage: applyCoverage,
    isStrongEvidence: isStrongEvidence,
    readLocalSegments: readLocalSegments,
    clearCache: function () { cache = Object.create(null); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
