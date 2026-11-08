// =====================================
// WDTV 片头 / 中段 / 片尾跳过标记（纯计算模块）
// =====================================
// 批次 4 · A2。本模块只接收普通对象、返回普通对象：
//   不触碰页面元素、不读写本地存储、不发请求、不设定时器、不依赖外部模块。
//   存储读写、界面渲染、事件绑定全部由 js/player.js 负责。
//   顶层必须用立即执行函数包裹：js/player.js 是 6443 行非包裹式顶层经典脚本，
//   多个经典 script 共享同一份全局词法环境，本模块若在顶层声明同名绑定会直接报语法错。
//
// 导出：浏览器挂到 window 单例；Node 测试经全局对象上的同名属性取得。
// 结构参考：js/ad-filter.js:18 与 :684-694。
// =====================================
(function (g) {
  'use strict';

  // ---- 常量 ----
  var SEGMENT_TYPES = ['opening', 'middle', 'ending'];
  // 半透明低饱和色，与 css/skip-marks.css 中色带颜色保持一致
  var SEGMENT_COLORS = {
    opening: 'rgba(122,158,198,0.32)',
    middle: 'rgba(178,156,112,0.30)',
    ending: 'rgba(138,166,150,0.32)'
  };
  var SEGMENT_LABELS = { opening: '片头', middle: '中段', ending: '片尾' };
  var UNKNOWN_TITLE = '';
  var MIN_SEGMENT_SECONDS = 3;
  var MIN_SEGMENT_GAP_SECONDS = 5;
  var END_GUARD_SECONDS = 2;
  var PROMPT_GUARD_SECONDS = 1;
  var MAX_CONTINUOUS_STEP_SECONDS = 10;

  // ---- 内部工具 ----
  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }
  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  // 轻量标题归一：与 danmu.js:88 的私有 bigram 近似匹配无关，
  // 这里只折叠大小写、空白、标点和符号，用于生成稳定存储键。
  function normalizeTitle(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '');
  }

  // 占位 / 无效标题：空白、纯标点、以及常见占位串都视为「标题缺失」
  // player.js 的标题缺省值是「未知视频」，必须一起排除，
  // 否则所有无标题影片共用 t:未知视频，A 剧的片头标记会套到 B 剧。
  var PLACEHOLDER_TITLES = ['未知', '未知视频', 'undefined', 'null'];
  function hasValidTitle(title) {
    if (title == null) return false;
    var s = String(title).trim().toLowerCase();
    if (!s) return false;
    if (PLACEHOLDER_TITLES.indexOf(s) !== -1) return false;
    if (!normalizeTitle(title)) return false;
    return true;
  }

  // 标题键带 't:' 前缀，fallback 键为 `${sourceCode}_${id}` 形态（不含冒号前缀）。
  // 两类键的命名空间天然隔离：即便某标题归一后恰好等于 source_id，
  // 标题键仍是 't:source_id'，不会与 fallback 键串数据。
  function skipMarkKey(title, fallback) {
    if (hasValidTitle(title)) return 't:' + normalizeTitle(title);
    return fallback == null ? UNKNOWN_TITLE : String(fallback);
  }

  // ---- migrateSkipMarks ----
  // 段结构校验：只查结构合法性，写侧业务规则交给 validateSegment，
  // 读取侧区间规则交给 resolveSegments。
  function validSegmentShape(seg) {
    if (!isPlainObject(seg)) return false;
    if (SEGMENT_TYPES.indexOf(seg.type) === -1) return false;
    if (!isFiniteNumber(seg.start) || !isFiniteNumber(seg.end)) return false;
    if (seg.start < 0) return false;
    if (seg.end === -1) return seg.type === 'ending';
    return seg.end > seg.start;
  }

  // 单条剧目标记归一化；整条损坏时返回 null（丢弃且不抛错）
  function normalizeMark(rawMark) {
    if (!isPlainObject(rawMark)) return null;
    var segs = null;
    if (Array.isArray(rawMark.segments)) {
      segs = [];
      // 单部剧最多 3 段，多余段忽略；损坏段只跳过、保留其余有效段（全坏才丢整条）
      for (var i = 0; i < rawMark.segments.length && segs.length < 3; i++) {
        var s = rawMark.segments[i];
        if (!validSegmentShape(s)) continue;
        segs.push({ type: s.type, start: s.start, end: s.end });
      }
    } else if ('introEnd' in rawMark || 'outroStart' in rawMark) {
      // v3 旧形态 { introEnd, outroStart } → opening [0,introEnd] + ending [outroStart,-1]
      segs = [];
      if (isFiniteNumber(rawMark.introEnd) && rawMark.introEnd > 0) {
        segs.push({ type: 'opening', start: 0, end: rawMark.introEnd });
      }
      // outroStart=0 是脏数据/占位值，迁移后会变成「整集片尾」误跳正片
      if (isFiniteNumber(rawMark.outroStart) && rawMark.outroStart > 0) {
        segs.push({ type: 'ending', start: rawMark.outroStart, end: -1 });
      }
      if (!segs.length) return null;
    } else {
      return null;
    }
    if (!segs.length) return null;
    return {
      segments: segs,
      // 条目级：只有显式 false 才关闭；缺省视为该条标记启用
      enabled: rawMark.enabled === false ? false : true,
      updatedAt: isFiniteNumber(rawMark.updatedAt) ? rawMark.updatedAt : 0
    };
  }

  function migrateSkipMarks(raw) {
    var out = { enabled: false, marks: {} };
    if (!isPlainObject(raw)) return out;
    // 顶层开关缺省一律视为 false（默认关闭），只有显式 true 才开启
    out.enabled = raw.enabled === true;
    // 规范结构走 raw.marks 容器；旧数据若把剧条目平铺在顶层则退回顶层遍历
    var src = isPlainObject(raw.marks) ? raw.marks : raw;
    var keys = Object.keys(src);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (typeof k !== 'string' || !k) continue;
      var m = normalizeMark(src[k]);
      if (m) out.marks[k] = m;
    }
    return out;
  }

  // ---- resolveSegments ----
  // 读取侧校验，返回按 start 升序的已解析段；不修改入参。
  function resolveSegments(mark, duration) {
    if (!isPlainObject(mark)) return [];
    if (mark.enabled === false) return [];
    if (!isFiniteNumber(duration) || duration <= 0) return [];
    if (!Array.isArray(mark.segments)) return [];

    var candidates = [];
    for (var i = 0; i < mark.segments.length; i++) {
      var s = mark.segments[i];
      if (!isPlainObject(s)) continue;
      if (SEGMENT_TYPES.indexOf(s.type) === -1) continue;
      if (!isFiniteNumber(s.start) || !isFiniteNumber(s.end)) continue;
      var start = s.start;
      var end = s.end;
      if (end === -1) {
        if (s.type !== 'ending') continue; // 只有片尾允许 -1 哨兵
        end = duration;                    // 片尾的 -1 填成片长
      }
      if (start < 0) continue;                                   // 越界：起点为负
      if (end > duration + 0.5) continue;                        // 越界：终点超出片长
      if (end - start < MIN_SEGMENT_SECONDS) continue;            // 过短
      if (duration - start < END_GUARD_SECONDS) continue;         // 起点贴片尾
      // 终点贴片尾：片尾段本身即代表片尾、终点就是片长，予以豁免
      if (s.type !== 'ending' && duration - end < END_GUARD_SECONDS) continue;
      var resolved = { type: s.type, start: start, end: end };
      // 取数层附加的置信度字段在时间轴解析时保留，供自动跳/按钮分流使用。
      if (isFiniteNumber(s.confidence)) resolved.confidence = s.confidence;
      if (isFiniteNumber(s.votes)) resolved.votes = s.votes;
      if (s.autoEligible === true) resolved.autoEligible = true;
      if (typeof s.source === 'string') resolved.source = s.source;
      candidates.push(resolved);
    }
    if (!candidates.length) return [];
    candidates.sort(function (a, b) { return a.start - b.start; });

    // 与前一区间重叠或间隔不足：按 start 升序保留靠前者，丢靠后者
    var result = [];
    var lastEnd = -Infinity;
    for (var j = 0; j < candidates.length; j++) {
      var c = candidates[j];
      if (c.start - lastEnd < MIN_SEGMENT_GAP_SECONDS) continue;
      result.push(c);
      lastEnd = c.end;
    }
    return result;
  }

  // ---- findActiveSegment ----
  function findActiveSegment(segments, position) {
    if (!Array.isArray(segments)) return undefined;
    if (!isFiniteNumber(position)) return undefined;
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (!isPlainObject(s) || !isFiniteNumber(s.start) || !isFiniteNumber(s.end)) continue;
      if (position >= s.start && position < s.end - PROMPT_GUARD_SECONDS) return s;
    }
    return undefined;
  }

  // ---- findCrossedEnding ----
  // 仅「连续播放跨过片尾起点」时触发；拖进度条大跳变（step > 10s）绝不触发。
  function findCrossedEnding(segments, previous, current) {
    if (!Array.isArray(segments)) return undefined;
    if (!isFiniteNumber(previous) || !isFiniteNumber(current)) return undefined;
    var step = current - previous;
    if (!(step > 0 && step <= MAX_CONTINUOUS_STEP_SECONDS)) return undefined;
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (!isPlainObject(s) || s.type !== 'ending' || !isFiniteNumber(s.start)) continue;
      if (s.start > previous && s.start <= current) return s;
    }
    return undefined;
  }

  // ---- validateSegment ----
  // 写侧校验：返回中文错误文案，合法返回 null。
  function validateSegment(segment, duration, existing) {
    // HLS 元数据未就绪时 duration 可能是 0/负数：LibreTV 语义是「只做相对校验」，
    // 不应直接拒绝标记；只有非有限数才判无效。
    if (!isFiniteNumber(duration)) return '视频时长无效';
    var knownDuration = duration > 0;
    if (!isPlainObject(segment)) return '片段数据无效';
    if (SEGMENT_TYPES.indexOf(segment.type) === -1) return '片段类型无效';
    if (!isFiniteNumber(segment.start) || !isFiniteNumber(segment.end)) return '片段时间无效';
    var start = segment.start;
    var end = segment.end;
    if (start < 0) return '片段起点不能为负';
    if (segment.type === 'opening' && start !== 0) return '片头必须从 0 秒开始';
    if (segment.type === 'ending' && end !== -1) return '片尾必须标记到片尾（end = -1）';
    var realEnd = end === -1 ? (knownDuration ? duration : Number.POSITIVE_INFINITY) : end;
    if (knownDuration && realEnd > duration + 0.5) return '片段超出视频时长';
    if (realEnd - start < MIN_SEGMENT_SECONDS) {
      return '片段时长不足 ' + MIN_SEGMENT_SECONDS + ' 秒';
    }
    if (Array.isArray(existing)) {
      for (var i = 0; i < existing.length; i++) {
        var e = existing[i];
        if (!isPlainObject(e) || !isFiniteNumber(e.start) || !isFiniteNumber(e.end)) continue;
        var eEnd = e.end === -1 ? (knownDuration ? duration : Number.POSITIVE_INFINITY) : e.end;
        // 两区间距离：<=0 表示重叠，>0 表示间隔
        var distance = Math.max(start, e.start) - Math.min(realEnd, eEnd);
        if (distance < MIN_SEGMENT_GAP_SECONDS) {
          return '与已有片段重叠或间隔不足 ' + MIN_SEGMENT_GAP_SECONDS + ' 秒';
        }
      }
    }
    return null;
  }

  // ---- 自定义片头/片尾时长（用户显式设定，最高优先级）----
  // 存的是「秒数」而非具体片段时间：opening=片头时长，ending=片尾时长。
  // 校验规则集中在此，player.js 只负责读写存储与展示错误文案。
  var CUSTOM_MIN_SECONDS = 3;      // 与 MIN_SEGMENT_SECONDS 对齐，太短无意义且会被 resolveSegments 丢弃
  var CUSTOM_MIN_GAP_SECONDS = 5;  // 与 MIN_SEGMENT_GAP_SECONDS 对齐，片头与片尾之间至少留正片

  // 返回 { ok, opening, ending, error }：
  //   opening/ending 为 null 表示该项未设置（留空 / 0）；
  //   error 为中文提示，ok=false 时不得写入存储；
  //   片长未知（duration 非正）时只做绝对校验，保存后等元数据就绪再生效。
  function normalizeCustomDurations(input, duration) {
    var o = isPlainObject(input) ? input : {};
    var known = isFiniteNumber(duration) && duration > 0;
    var out = { ok: true, opening: null, ending: null, error: null };
    var names = ['opening', 'ending'];
    var labels = { opening: '片头', ending: '片尾' };
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var raw = o[name];
      if (raw == null || raw === '') continue;
      var n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!isFiniteNumber(n)) {
        out.ok = false;
        out.error = labels[name] + '时长必须是数字';
        return out;
      }
      if (n < 0) {
        out.ok = false;
        out.error = labels[name] + '时长不能为负数';
        return out;
      }
      if (n === 0) continue; // 0 与留空同义：不设置该项
      n = Math.round(n);
      if (n < CUSTOM_MIN_SECONDS) {
        out.ok = false;
        out.error = labels[name] + '时长至少 ' + CUSTOM_MIN_SECONDS + ' 秒';
        return out;
      }
      if (known && n > duration - CUSTOM_MIN_SECONDS) {
        out.ok = false;
        out.error = labels[name] + '时长不能超过片长（需预留 ' + CUSTOM_MIN_SECONDS + ' 秒）';
        return out;
      }
      out[name] = n;
    }
    if (known && out.opening && out.ending &&
        out.opening + out.ending > duration - CUSTOM_MIN_GAP_SECONDS) {
      out.ok = false;
      out.error = '片头 + 片尾需小于片长 ' + CUSTOM_MIN_GAP_SECONDS + ' 秒';
      return out;
    }
    return out;
  }

  // 把自定义秒数展开为统一段结构：片头 0→N，片尾 (片长−N)→片长。
  // 用户显式设定视为高置信（autoEligible=true），走自动跳过并保留撤销。
  // 片长未知（元数据未就绪）时返回空数组，待 durationchange 后自然生效。
  function buildCustomSegments(custom, duration) {
    if (!isPlainObject(custom)) return [];
    if (!isFiniteNumber(duration) || duration <= 0) return [];
    var out = [];
    var opening = custom.opening;
    var ending = custom.ending;
    if (isFiniteNumber(opening) && opening >= CUSTOM_MIN_SECONDS && opening <= duration - CUSTOM_MIN_SECONDS) {
      out.push({
        type: 'opening', start: 0, end: opening,
        confidence: 1, votes: 0, sources: ['custom'], origin: 'custom', source: 'custom',
        autoEligible: true
      });
    }
    if (isFiniteNumber(ending) && ending >= CUSTOM_MIN_SECONDS && ending <= duration - CUSTOM_MIN_SECONDS) {
      out.push({
        type: 'ending', start: duration - ending, end: duration,
        confidence: 1, votes: 0, sources: ['custom'], origin: 'custom', source: 'custom',
        autoEligible: true
      });
    }
    return out;
  }

  // ---- decideAutoSkip ----
  // 供 js/player.js 的 adAutoSkipCheck 复用的统一决策：广告区与标记段共用
  // 同一套冷却 / 避让，且一次调用最多产出一个 seek 目标，避免两套自动 seek 循环。
  // 纯函数：只读入参、不改入参数组、不读写任何外部状态。
  function hasSuppressed(keys, key) {
    if (keys == null) return false;
    if (typeof keys.has === 'function') return keys.has(key) === true;
    if (Array.isArray(keys)) return keys.indexOf(key) !== -1;
    return false;
  }

  function decideAutoSkip(input) {
    var o = isPlainObject(input) ? input : {};
    var duration = o.duration;
    var position = o.position;
    var cooldown = (isFiniteNumber(o.cooldownMs) && o.cooldownMs >= 0) ? o.cooldownMs : 1000;
    var now = isFiniteNumber(o.now) ? o.now : 0;
    var lastSkipAt = isFiniteNumber(o.lastSkipAt) ? o.lastSkipAt : -Infinity;

    // 统一避让（与原 adAutoSkipCheck 对齐）
    if (o.paused) return null;
    if (!isFiniteNumber(duration) || duration <= 0) return null;
    if (o.isUserSeeking) return null;
    if (!isFiniteNumber(position)) return null;
    if (position < 0.5) return null;
    if (position > duration - 0.5) return null;
    if (o.guestActive) return null;
    if (now - lastSkipAt < cooldown) return null;

    // 优先级 1：既有广告区（命中窗口沿用原逻辑的 0.25s 容差）
    if (Array.isArray(o.adRegions)) {
      for (var i = 0; i < o.adRegions.length; i++) {
        var r = o.adRegions[i];
        if (!isPlainObject(r) || !isFiniteNumber(r.start) || !isFiniteNumber(r.end)) continue;
        if (!(position >= r.start - 0.25 && position < r.end - 0.25)) continue;
        var adKey = 'ad:' + r.start;
        if (hasSuppressed(o.suppressedKeys, adKey)) continue;
        return {
          target: r.end,
          reason: '自动跳过广告区',
          kind: 'ad',
          skipKey: adKey
        };
      }
    }

    // 优先级 2：跳过标记段
    if (Array.isArray(o.segments)) {
      var prev = o.previousPosition;
      for (var j = 0; j < o.segments.length; j++) {
        var s = o.segments[j];
        if (!isPlainObject(s) || !isFiniteNumber(s.start) || !isFiniteNumber(s.end)) continue;
        if (!(position >= s.start && position < s.end - PROMPT_GUARD_SECONDS)) continue;
        // 片尾段只在「连续播放跨过片尾起点」时触发（0 < step <= 10s）。
        // 不再保留「已在片尾内继续播放」第二通路：用户拖进度条落进片尾段内部后，
        // 下一帧 previousPosition 已变成落点，旧的第二通路会立刻命中并把观众
        // 强行送到片尾 / 下一集。未提供 previousPosition 时沿用普通区间命中。
        if (s.type === 'ending' && isFiniteNumber(prev)) {
          if (!findCrossedEnding([s], prev, position)) continue;
        }
        var markKey = s.type + ':' + s.start;
        if (hasSuppressed(o.suppressedKeys, markKey)) continue;
        return {
          target: s.end,
          reason: '自动跳过' + (SEGMENT_LABELS[s.type] || '标记片段'),
          kind: 'mark',
          skipKey: markKey
        };
      }
    }
    return null;
  }

  // =====================================
  // 导出
  // =====================================
  g.WDTVSkipMarks = {
    SEGMENT_TYPES: SEGMENT_TYPES,
    SEGMENT_COLORS: SEGMENT_COLORS,
    SEGMENT_LABELS: SEGMENT_LABELS,
    UNKNOWN_TITLE: UNKNOWN_TITLE,
    MIN_SEGMENT_SECONDS: MIN_SEGMENT_SECONDS,
    MIN_SEGMENT_GAP_SECONDS: MIN_SEGMENT_GAP_SECONDS,
    END_GUARD_SECONDS: END_GUARD_SECONDS,
    PROMPT_GUARD_SECONDS: PROMPT_GUARD_SECONDS,
    MAX_CONTINUOUS_STEP_SECONDS: MAX_CONTINUOUS_STEP_SECONDS,
    normalizeTitle: normalizeTitle,
    skipMarkKey: skipMarkKey,
    migrateSkipMarks: migrateSkipMarks,
    resolveSegments: resolveSegments,
    findActiveSegment: findActiveSegment,
    findCrossedEnding: findCrossedEnding,
    validateSegment: validateSegment,
    normalizeCustomDurations: normalizeCustomDurations,
    buildCustomSegments: buildCustomSegments,
    decideAutoSkip: decideAutoSkip
  };
})(typeof window !== 'undefined' ? window : globalThis);
