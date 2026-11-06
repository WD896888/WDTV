(function (g) {
  'use strict';

  // 播放错误恢复：纯决策层，状态由调用方持有并回传。
  // 本模块不持有任何可变计数、不设定时器、不碰 DOM/存储/网络，
  // 所有副作用（延时重试、hls 实例操作）由 player.js 闭包负责。
  // 双环境导出：浏览器挂 window，Node 测试挂 globalThis。

  var HLS_ERROR_NETWORK = 'networkError';
  var HLS_ERROR_MEDIA = 'mediaError';

  // 格式/编码层面的硬失败，退避重试无意义，直接换源。
  // 冻结导出常量：外部拿到的是只读引用，避免被改写后污染 isHardFail / normalizePolicy 的决策。
  var HARD_FAIL_DETAILS = Object.freeze({
    manifestParsingError: 1,
    manifestIncompatibleCodecsError: 1,
    levelEmptyError: 1
  });

  var DEFAULT_POLICY = Object.freeze({
    maxNetworkRetries: 3,
    maxMediaRecoveries: 2,
    baseDelayMs: 800,
    maxDelayMs: 8000,
    healthyQuietMs: 3000
  });

  // 常见 hls 错误详情 → 中文短文案
  var DETAIL_MESSAGES = {
    manifestLoadError: '视频加载失败',
    manifestLoadTimeOut: '视频源连接超时',
    manifestParsingError: '播放列表解析失败',
    manifestIncompatibleCodecsError: '播放列表编码格式不兼容',
    levelLoadError: '视频清晰度列表加载失败',
    levelLoadTimeOut: '视频清晰度列表加载超时',
    levelEmptyError: '播放列表为空，无可播放的清晰度',
    fragLoadError: '视频分片加载失败',
    fragLoadTimeOut: '视频分片加载超时',
    fragParsingError: '视频分片解析失败',
    fragDecryptError: '视频分片解密失败',
    keyLoadError: '解密密钥加载失败',
    keyLoadTimeOut: '解密密钥加载超时',
    bufferAppendError: '媒体解码错误',
    bufferStalledError: '缓冲不足，播放卡顿',
    bufferFullError: '缓冲区已满',
    remuxAllocError: '媒体重封装失败',
    internalException: '播放器内部错误',
    internalAborted: '播放已中断'
  };

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function numOr(v, def) {
    return isFiniteNumber(v) ? v : def;
  }

  function normalizeState(s) {
    s = s || {};
    return {
      networkRetries: numOr(s.networkRetries, 0),
      mediaRecoveries: numOr(s.mediaRecoveries, 0),
      lastActionAt: numOr(s.lastActionAt, 0)
    };
  }

  function copyState(s) {
    return {
      networkRetries: s.networkRetries,
      mediaRecoveries: s.mediaRecoveries,
      lastActionAt: s.lastActionAt
    };
  }

  function normalizePolicy(p) {
    p = p || {};
    var d = DEFAULT_POLICY;
    return {
      maxNetworkRetries: numOr(p.maxNetworkRetries, d.maxNetworkRetries),
      maxMediaRecoveries: numOr(p.maxMediaRecoveries, d.maxMediaRecoveries),
      baseDelayMs: numOr(p.baseDelayMs, d.baseDelayMs),
      maxDelayMs: numOr(p.maxDelayMs, d.maxDelayMs),
      healthyQuietMs: numOr(p.healthyQuietMs, d.healthyQuietMs)
    };
  }

  // now 可为数字、返回数字的函数，或缺省（取当前时间）。
  function resolveNow(now) {
    if (typeof now === 'function') return numOr(now(), Date.now());
    if (isFiniteNumber(now)) return now;
    return Date.now();
  }

  function isHardFail(details) {
    return !!details && Object.prototype.hasOwnProperty.call(HARD_FAIL_DETAILS, details);
  }

  function onFatal(opts) {
    opts = opts || {};
    var state = normalizeState(opts.state);
    var policy = normalizePolicy(opts.policy);
    var ts = resolveNow(opts.now);

    // 非致命错误：忽略，不改变任何状态。
    if (opts.fatal === false || opts.ignore === true) {
      return {
        decision: { action: 'ignore', reason: '非致命错误，忽略处理' },
        state: copyState(state)
      };
    }

    // 格式硬失败：退避无意义，直接换源，计数不变。
    if (isHardFail(opts.details)) {
      return {
        decision: { action: 'switch-source', reason: '播放列表格式无法解析，重试无意义' },
        state: copyState(state)
      };
    }

    if (opts.type === HLS_ERROR_MEDIA) {
      if (state.mediaRecoveries >= policy.maxMediaRecoveries) {
        return {
          decision: { action: 'switch-source', reason: '媒体解码错误多次恢复无效' },
          state: copyState(state)
        };
      }
      var mediaAttempt = state.mediaRecoveries + 1;
      return {
        decision: {
          action: 'recover-media',
          swapAudio: mediaAttempt >= 2,
          attempt: mediaAttempt,
          reason: '媒体解码错误，尝试恢复'
        },
        state: {
          networkRetries: state.networkRetries,
          mediaRecoveries: mediaAttempt,
          lastActionAt: ts
        }
      };
    }

    if (opts.type === HLS_ERROR_NETWORK) {
      if (state.networkRetries >= policy.maxNetworkRetries) {
        return {
          decision: {
            action: 'switch-source',
            reason: '网络错误已重试 ' + policy.maxNetworkRetries + ' 次仍未恢复'
          },
          state: copyState(state)
        };
      }
      var attempt = state.networkRetries + 1;
      var delayMs = Math.min(
        policy.baseDelayMs * Math.pow(2, attempt - 1),
        policy.maxDelayMs
      );
      return {
        decision: {
          action: 'retry',
          delayMs: delayMs,
          attempt: attempt,
          reason: '网络错误，退避重试'
        },
        state: {
          networkRetries: attempt,
          mediaRecoveries: state.mediaRecoveries,
          lastActionAt: ts
        }
      };
    }

    // 未知致命类型：兜底换源。
    return {
      decision: { action: 'switch-source', reason: '未知的致命错误，切换视频源' },
      state: copyState(state)
    };
  }

  function onHealthy(opts) {
    opts = opts || {};
    var state = normalizeState(opts.state);
    var policy = normalizePolicy(opts.policy);
    var ts = resolveNow(opts.now);

    // 静默窗内：防「重试刚成功的瞬间噪声」误清零，计数保持不变。
    if (ts - state.lastActionAt < policy.healthyQuietMs) {
      return copyState(state);
    }
    // 静默窗外：播放链路确实恢复，计数归零。
    return {
      networkRetries: 0,
      mediaRecoveries: 0,
      lastActionAt: state.lastActionAt
    };
  }

  function describeHlsError(type, details) {
    if (details && Object.prototype.hasOwnProperty.call(DETAIL_MESSAGES, details)) {
      return DETAIL_MESSAGES[details];
    }
    if (type === HLS_ERROR_MEDIA) return '媒体解码错误';
    if (type === HLS_ERROR_NETWORK) return '视频加载失败';
    return '播放错误' + (details ? '（' + details + '）' : '');
  }

  g.WDTVPlaybackRecovery = {
    HLS_ERROR_NETWORK: HLS_ERROR_NETWORK,
    HLS_ERROR_MEDIA: HLS_ERROR_MEDIA,
    HARD_FAIL_DETAILS: HARD_FAIL_DETAILS,
    DEFAULT_POLICY: DEFAULT_POLICY,
    onFatal: onFatal,
    onHealthy: onHealthy,
    describeHlsError: describeHlsError
  };
})(typeof window !== 'undefined' ? window : globalThis);
