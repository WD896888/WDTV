// =====================================
// WDTV 画质档位模块（纯函数 + 常量，零依赖）
// =====================================
// 画质信息不在 CMS 搜索接口里，只存在于 m3u8 的 #EXT-X-STREAM-INF（RESOLUTION）
// 或播放器解码后的 videoHeight。本模块只负责：
//   1) 高度 → 档位命名（就近归档，容忍采集站裁边）
//   2) 探测 / 实测结论的缓存合并（三条优先级 + TTL + 上限淘汰）
//   3) 徽章四态与汇总口径（纯数据，不含任何 React / HTML）
//   4) 供聚合面板做画质降序的两个辅助函数
// 不碰存储、不发请求、不读 DOM：缓存介质与探测执行均由调用方决定。
//
// QualityEntry 形状：{ height?: number; from: 'play'|'probe'; error?: string; timestamp: number }
//   - 有 height            → 成功
//   - 无 height 无 error   → 「测不出 / 未知」（源站本来不给信息，不可重试，长 TTL 保留）
//   - 有 error             → 「失败 / 未探到」（多为瞬时抖动，可重试，短 TTL 淘汰）
//
// 浏览器挂 window.WDTVQuality，Node 经 globalThis 供零依赖自测引用。
(function (g) {
  'use strict';

  var QUALITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 成功 / 测不出：源站换片源概率低
  var QUALITY_FAIL_TTL_MS = 2 * 60 * 1000;         // 失败：瞬时问题，短 TTL 给重试留机会
  var QUALITY_MAX_ENTRIES = 400;                    // 按「源 + 影片」计，防无上限膨胀
  var TIER_TOLERANCE = 0.15;                        // 档位容差（见 qualityLabel 注释）

  // 档位表：高度 → 标签（就近取档）。4K/2K 与 1080P 分开，避免 1440 被误标成 1080P。
  var TIERS = [
    { height: 2160, label: '4K' },
    { height: 1440, label: '2K' },
    { height: 1080, label: '1080P' },
    { height: 720, label: '720P' },
    { height: 540, label: '540P' },
    { height: 480, label: '480P' },
    { height: 360, label: '360P' }
  ];

  // 缓存键：按「源 + 影片」，同一源的不同剧画质不同，不能按源整体记录。
  // 分隔用 ':'（与 LibreTV 参考实现一致）；probe-queue 内部键用 '_'，两者服务不同 Map，互不依赖。
  function qualityKey(sourceKey, vodId) {
    return String(sourceKey == null ? '' : sourceKey) + ':' + String(vodId == null ? '' : vodId);
  }

  /**
   * 高度 → 展示标签：就近取档。
   * 采集站常把 1920×1080 裁成 1924×1040，严格「必须 ≥ 档位值」会把 1040 打成 720P；
   * 15% 容差覆盖常见裁边与等比缩放（960 距 1080 差 11%），又挡住反向误判（144 不会抬成 360P）。
   * 偏差超过 15% 的按原样展示（144 → '144P'）。非法 / NaN / undefined / ≤0 返回 undefined。
   */
  function qualityLabel(height) {
    if (typeof height !== 'number' || !isFinite(height) || height <= 0) return undefined;
    var best;
    for (var i = 0; i < TIERS.length; i++) {
      var tier = TIERS[i];
      var value = tier.height;
      if (Math.abs(value - height) > value * TIER_TOLERANCE) continue;
      if (!best || Math.abs(value - height) < Math.abs(best.height - height)) best = tier;
    }
    return best ? best.label : String(height) + 'P';
  }

  /** 失败原因短标签：徽章就地显示「未测到·超时」比只藏在 tooltip 里有用（触屏无 hover）。 */
  function failureReasonLabel(error) {
    if (!error) return undefined;
    // 传输层失败要排在「超时」之前：这类文案本身带「多为网关超时」的解释，先匹配超时会指错因
    if (/中断|断开|送达|网关拦截/.test(error)) return '连接中断';
    if (String(error).indexOf('超时') !== -1) return '超时';
    if (/HTTP (401|403)/.test(error)) return '防盗链';
    if (/HTTP 5\d\d|\(5\d\d\)/.test(error)) return '网关异常';
    if (String(error).indexOf('未找到播放资源') !== -1) return '无资源';
    if (String(error).indexOf('无效') !== -1) return '源无效';
    return undefined;
  }

  /**
   * 条目是否仍在有效期内（写入清理与读取过滤的唯一入口）。
   * 成功与「测不出」按长 TTL；失败（error）按短 TTL，过期后允许重试。
   */
  function isQualityEntryFresh(entry, now) {
    if (!entry || typeof entry !== 'object') return false;
    var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
    var ttl = entry.error ? QUALITY_FAIL_TTL_MS : QUALITY_TTL_MS;
    return t - entry.timestamp < ttl;
  }

  /**
   * 把新结果合并进画质缓存（纯函数）。四条规则：
   * 1. 实测(play) 压过探测(probe)——m3u8 写的是源站「声明」值，解码出来的才是真的；
   * 2. 实测之间取较大 height——ABR 常先选低档再升档，取最大才不被起播档位低估；
   * 3. 探测之间已有明确档位时，不被「测不出」（无 height）抹掉；
   * 4. 顺带按 TTL 清理过期条目；超过 QUALITY_MAX_ENTRIES 按 timestamp 淘汰最旧。
   *
   * @param current 现有缓存 Record<key, QualityEntry>
   * @param incoming 本次新结果 Record<key, QualityEntry>
   * @param now      可选，注入当前时间便于单测（默认 Date.now()）
   */
  function mergeQualityEntries(current, incoming, now) {
    var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
    var base = (current && typeof current === 'object') ? current : {};
    var inc = (incoming && typeof incoming === 'object') ? incoming : {};
    var next = {};
    var k;
    var own = Object.prototype.hasOwnProperty;

    for (k in base) {
      if (!own.call(base, k)) continue;
      if (isQualityEntryFresh(base[k], t)) next[k] = base[k];
    }
    for (k in inc) {
      if (!own.call(inc, k)) continue;
      var value = inc[k];
      if (!value || typeof value !== 'object') continue;
      var prev = next[k];
      if (prev && prev.from === 'play') {
        if (value.from !== 'play') continue;                 // 实测不被后续探测覆盖
        // 在已有 play 记录的副本上更新，保留 prev / incoming 的 error 等额外字段，
        // 避免重建只有 3 个字段的对象时丢字段（见文件头 QualityEntry 形状注释）。
        var merged = {};
        var pk;
        for (pk in prev) { if (own.call(prev, pk)) merged[pk] = prev[pk]; }
        for (pk in value) { if (own.call(value, pk)) merged[pk] = value[pk]; }
        var best = Math.max(prev.height || 0, value.height || 0);
        merged.from = 'play';
        merged.height = best || undefined;
        merged.timestamp = t;
        next[k] = merged;
        continue;
      }
      if (prev && prev.from === 'probe' && value.from === 'probe' &&
          prev.height !== undefined && value.height === undefined) {
        continue;                                            // 已有明确档位不被「测不出」抹掉
      }
      next[k] = value;
    }

    var keys = Object.keys(next);
    var overflow = keys.length - QUALITY_MAX_ENTRIES;
    if (overflow > 0) {
      var oldest = keys.slice().sort(function (a, b) {
        return (next[a].timestamp || 0) - (next[b].timestamp || 0);
      });
      for (var i = 0; i < overflow; i++) delete next[oldest[i]];
    }
    return next;
  }

  /**
   * 画质徽章四态，返回普通对象（不含 React / HTML）：
   *   probing 优先 → loading；无 entry → undefined（尚未探测，不渲染）；
   *   有 height → value；无 height 无 error → unknown（灰、不可重试）；
   *   有 error → failed（可重试、带失败原因）。
   * 兼容字段：state === kind，tooltip === title，便于调用方按任一命名取用。
   */
  function describeQualityBadge(entry, probing) {
    if (probing) {
      var loadingTip = '正在探测画质…';
      return { state: 'loading', kind: 'loading', title: loadingTip, tooltip: loadingTip, retryable: false };
    }
    if (!entry) return undefined;

    var label = qualityLabel(entry.height);
    if (label) {
      var valueTip = entry.from === 'play'
        ? '播放实测的真实分辨率（' + entry.height + 'P）'
        : '解析播放列表得到的档位（' + entry.height + 'P）';
      return { state: 'value', kind: 'value', label: label, title: valueTip, tooltip: valueTip, retryable: false };
    }
    if (entry.error) {
      var reason = failureReasonLabel(entry.error);
      var failTip = '本次没测到画质：' + entry.error + '。' + (reason === '超时'
        ? '多半是网络抖动或源站响应慢，点击重试'
        : '点击可重试，也可以直接播放，播放后会自动记录实测分辨率');
      return {
        state: 'failed', kind: 'failed', label: '未测到', reason: reason,
        title: failTip, tooltip: failTip, retryable: true
      };
    }
    var unknownTip = '单码率或直链，播放列表里没有画质信息；播放一次后会记录实测分辨率';
    return { state: 'unknown', kind: 'unknown', title: unknownTip, tooltip: unknownTip, retryable: false };
  }

  /**
   * 一组来源的画质汇总：取最高档，统计命中 / 失败 / 总数。
   * 传入 undefined 的条目（尚未探测）不计入 total，避免进度分母虚高。
   * 兼容字段：label === best（最高档标签，无可用高度时为 undefined）。
   */
  function summarizeQuality(entries) {
    var list;
    if (Array.isArray(entries)) list = entries;
    else if (entries && typeof entries === 'object') list = Object.keys(entries).map(function (k) { return entries[k]; });
    else list = [];

    var bestHeight;
    var known = 0, failed = 0, total = 0;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || typeof e !== 'object') continue;
      total += 1;
      if (typeof e.height === 'number' && isFinite(e.height) && e.height > 0) {
        known += 1;
        if (bestHeight === undefined || e.height > bestHeight) bestHeight = e.height;
      } else if (e.error) {
        failed += 1;
      }
    }
    var label = qualityLabel(bestHeight);
    return { label: label, best: label, known: known, failed: failed, total: total };
  }

  /**
   * 码率 → 推断高度：部分源站 master playlist 只给 BANDWIDTH 不给 RESOLUTION。
   * 入参单位为 bps（HLS BANDWIDTH / hls.js level.bitrate，与 player.js 一致），
   * 分层取自常见转码参数，仅供档位标识使用。非法 / 过小返回 240。
   */
  function inferHeightFromBitrate(bps) {
    var v = Number(bps);
    var tiers = [
      [20000000, 4320], [10000000, 2160], [5000000, 1080],
      [3000000, 720], [1500000, 540], [800000, 480], [400000, 360]
    ];
    if (!isFinite(v)) return 240;
    for (var i = 0; i < tiers.length; i++) {
      if (v >= tiers[i][0]) return tiers[i][1];
    }
    return 240;
  }

  /**
   * 从「画质载体」取出可比较的高度数字（正整数），无有效高度返回 undefined。
   * 兼容：QualityEntry 本身、带 entry/qualityEntry/quality 嵌套的搜索项、直接带
   * height/qualityHeight/videoHeight 的搜索项。任何非对象输入都不抛错。
   */
  function heightOf(x) {
    if (!x || typeof x !== 'object') return undefined;
    var candidates = [x, x.entry, x.qualityEntry, x.quality];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!c || typeof c !== 'object') continue;
      var fields = [c.height, c.qualityHeight, c.videoHeight];
      for (var j = 0; j < fields.length; j++) {
        var h = fields[j];
        if (typeof h === 'number' && isFinite(h) && h > 0) return h;
      }
    }
    return undefined;
  }

  /**
   * 聚合展开面板的画质降序：返回新数组（不改原数组）。
   * - 每个 item 的高度优先取 heightOf(item)，否则查 entries（兼容 ':' 与 '_' 两种键格式，
   *   以及 item.qualityKey / item.key 直给）。
   * - 有高度的按降序排前，无高度的按原相对顺序排后（稳定）。
   * - entries 缺失（null/undefined/非对象）时按原序返回，不抛错；空对象同样不虚报排序。
   */
  function sortByQuality(items, entries) {
    var list = Array.isArray(items) ? items.slice() : [];
    if (!list.length) return list;
    var map = (entries && typeof entries === 'object') ? entries : null;
    if (!map) return list;

    function lookupKey(item) {
      if (!item || typeof item !== 'object') return undefined;
      if (item.qualityKey && map[item.qualityKey]) return item.qualityKey;
      if (item.key && map[item.key]) return item.key;
      var sc = item.source_code != null ? item.source_code
        : (item.source && item.source.key != null ? item.source.key : item.sourceKey);
      var vid = item.vod_id != null ? item.vod_id
        : (item.id != null ? item.id : item.vodId);
      if (sc == null || vid == null) return undefined;
      var cands = [qualityKey(sc, vid), String(sc) + '_' + String(vid)];
      for (var i = 0; i < cands.length; i++) if (map[cands[i]]) return cands[i];
      return undefined;
    }

    var decorated = list.map(function (item, idx) {
      var h = heightOf(item);
      var key = lookupKey(item);
      if (key && h === undefined) h = heightOf(map[key]);
      return { item: item, idx: idx, h: (typeof h === 'number' && isFinite(h) && h > 0) ? h : undefined };
    });
    decorated.sort(function (a, b) {
      if (a.h === undefined && b.h === undefined) return a.idx - b.idx;
      if (a.h === undefined) return 1;
      if (b.h === undefined) return -1;
      if (b.h !== a.h) return b.h - a.h;
      return a.idx - b.idx;
    });
    return decorated.map(function (d) { return d.item; });
  }

  // =====================================
  // 导出
  // =====================================
  g.WDTVQuality = {
    QUALITY_TTL_MS: QUALITY_TTL_MS,
    QUALITY_FAIL_TTL_MS: QUALITY_FAIL_TTL_MS,
    QUALITY_MAX_ENTRIES: QUALITY_MAX_ENTRIES,
    TIER_TOLERANCE: TIER_TOLERANCE,
    TIERS: TIERS,
    qualityKey: qualityKey,
    qualityLabel: qualityLabel,
    describeQualityBadge: describeQualityBadge,
    mergeQualityEntries: mergeQualityEntries,
    summarizeQuality: summarizeQuality,
    inferHeightFromBitrate: inferHeightFromBitrate,
    failureReasonLabel: failureReasonLabel,
    isQualityEntryFresh: isQualityEntryFresh,
    heightOf: heightOf,
    sortByQuality: sortByQuality
  };
})(typeof window !== 'undefined' ? window : globalThis);
