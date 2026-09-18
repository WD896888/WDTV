// ============================================================
// WDTV 双人共同观影 · 本地数据源插件（watch-party-local）
// 职责：
//   M2 —— 预缓存覆盖率校验（VideoCache.coverageOf，缺失时 listEntries 兜底估算）与清晰度锁档
//   M3 —— 本地文件采样指纹（SHA-256，头/中/尾 3×1MB）与 Blob URL 原生播放 / 退出恢复原集
// 对接（js/watch-party.js）：
//   - 文件加载即 setLocalHooks({coverageReport, lockLevel, m3Play, m3Exit, applySrcRedirect})
//   - env() 惰性取宿主 getter {getArt,getHls,getVideoKey,getTitle,getEpisode}
//   - 监听 'src'（M2 自动补覆盖率 / M3 记录确认开播信号）、'applySrc'（观影方带参整页跳转）、
//         'ready'（对端 M3 时长/指纹学习；权威副本在 watch-party.readyMap，此处仅本地缓存）
// 防御：VideoCache / art / hls / crypto.subtle 全部存在性检测 + try/catch，任何异常不阻断主流程。
// 依赖：零第三方依赖。
// ============================================================
(function () {
  'use strict';

  // ----- 常量 -----
  var FP_CHUNK = 1024 * 1024;       // 指纹采样段：1MB
  var FP_HALF = FP_CHUNK / 2;       // 中段偏移：512KB
  var FP_SMALL_FILE = 3 * FP_CHUNK; // ≤3MB 只取单段（0..size 整读）
  var COV_DEBOUNCE_MS = 1500;       // 覆盖率上报去重窗：同 mediaKey 近距离重复触发合并为一次

  // ----- 模块状态 -----
  var m3BlobUrl = null;        // 当前 M3 Blob URL
  var m3File = null;           // 本端已选本地文件
  var m3Fp = null;             // 本端已选文件指纹
  var m3Active = false;        // 本端是否已进入 M3 Blob 播放
  var m3DurationSentFp = null; // 已补报过时长的文件指纹（每文件只补报一次）
  var lastM3Src = null;        // 最近收到的 M3 src（确认开播信号；未播提示由 watch-party 内置 toast 承担）
  var prevUrl = null;          // 进入 M3 前的原集地址（m3Exit 恢复用）
  var levelLocked = false;     // M2 是否已锁清晰度档
  var lastCoverage = null;     // 最近一次 M2 覆盖率 {videoKey, percent, cached, total, mismatch?}
  var covKey = null;           // 覆盖率去重：上次请求的 mediaKey
  var covAt = 0;               // 覆盖率去重：上次请求时刻
  var peerM3 = {};             // String(uid) -> {fp,duration,name,size}（对端 M3 就绪本地副本）

  // ============================================================
  // 基础工具（宿主与全局对象一律惰性、防御式访问）
  // ============================================================
  function wp() { return window.WatchParty || null; }

  function env() {
    try {
      var w = wp();
      return (w && typeof w.env === 'function' && w.env()) || {};
    } catch (e) { return {}; }
  }

  function callGetter(name) {
    try {
      var f = env()[name];
      return typeof f === 'function' ? f() : null;
    } catch (e) { return null; }
  }

  function getArt() { return callGetter('getArt'); }
  function getHls() { return callGetter('getHls'); }

  function getVideoKey() {
    var k = callGetter('getVideoKey');
    return k == null ? '' : String(k);
  }

  // 稳定基准地址（baseEpisodeUrl）：清晰度目录探测不改写它，用作房间内"同一集"的判定标识；
  // currentVideoUrl 会随探测漂移，只用作缓存键查询
  function getBaseKey() {
    var k = callGetter('getBaseVideoKey');
    return k == null ? '' : String(k);
  }

  function sendReady(info) {
    try {
      var w = wp();
      return w && typeof w.sendReady === 'function' ? w.sendReady(info) : false;
    } catch (e) { return false; }
  }

  function vcache() { return window.VideoCache || null; }

  function roomCode() {
    try {
      var w = wp();
      var rs = w && typeof w.roomState === 'function' ? w.roomState() : null;
      return rs && rs.code ? String(rs.code) : '';
    } catch (e) { return ''; }
  }

  function revokeBlob() {
    if (!m3BlobUrl) return;
    try { URL.revokeObjectURL(m3BlobUrl); } catch (e) { }
    m3BlobUrl = null;
  }

  // ============================================================
  // M3：文件采样指纹（SHA-256）
  // 采样：头/中/尾三段各 1MB（中段起点 max(0, floor(size/2)-512KB)，
  //       尾段起点 max(0, size-1MB)；size≤3MB 只取 0..size 单段），
  // 拼接头 'wdtv-fp|size|ext' 后整体 digest，hex 取前 32 字符。
  // ============================================================
  function fileFingerprint(file) {
    return new Promise(function (resolve, reject) {
      try {
        if (!file || typeof file.size !== 'number' || !(file.size >= 0) || typeof file.slice !== 'function') {
          reject(new Error('badFile'));
          return;
        }
        var size = file.size;
        var name = String(file.name || '');
        var dot = name.lastIndexOf('.');
        var ext = (dot > -1 && dot < name.length - 1) ? name.slice(dot + 1).toLowerCase() : '';
        var head = 'wdtv-fp|' + size + '|' + ext;
        var parts;
        if (size <= FP_SMALL_FILE) {
          parts = [{ p: 0, len: size }];
        } else {
          parts = [
            { p: 0, len: FP_CHUNK },
            { p: Math.max(0, Math.floor(size / 2) - FP_HALF), len: FP_CHUNK },
            { p: Math.max(0, size - FP_CHUNK), len: FP_CHUNK }
          ];
        }
        var bufs = [];
        var idx = 0;

        function digestAll() {
          try {
            var subtle = window.crypto && window.crypto.subtle;
            if (!subtle || typeof subtle.digest !== 'function') {
              reject(new Error('crypto.subtle 不可用（需 HTTPS/localhost 环境）'));
              return;
            }
            var headBytes = new TextEncoder().encode(head);
            var total = headBytes.length;
            for (var k = 0; k < bufs.length; k++) total += bufs[k].byteLength;
            var all = new Uint8Array(total);
            var off = 0;
            all.set(headBytes, off); off += headBytes.length;
            for (var k2 = 0; k2 < bufs.length; k2++) {
              all.set(new Uint8Array(bufs[k2]), off);
              off += bufs[k2].byteLength;
            }
            subtle.digest('SHA-256', all).then(function (hash) {
              try {
                var arr = new Uint8Array(hash);
                var hex = '';
                for (var j = 0; j < arr.length; j++) hex += (arr[j] < 16 ? '0' : '') + arr[j].toString(16);
                resolve(hex.slice(0, 32));
              } catch (e) { reject(e); }
            }, reject);
          } catch (e) { reject(e); }
        }

        function readNext() {
          if (idx >= parts.length) { digestAll(); return; }
          var seg = parts[idx++];
          try {
            file.slice(seg.p, seg.p + seg.len).arrayBuffer().then(function (buf) {
              bufs.push(buf);
              readNext();
            }, reject);
          } catch (e) { reject(e); }
        }

        readNext();
      } catch (e) { reject(e); }
    });
  }

  // ============================================================
  // M3：选文件入口（UI 模块调用）
  // 计算指纹 → 上报就绪 ready{kind:'m3', fp, size, name, duration:0}
  // → host 由 UI 经 WatchParty.startM3(file, fp) 触发 m3Play 并广播 src；
  //   guest（及角色未知时）就绪即播（文件选中即播），等待房主 src 作确认开播信号。
  // ============================================================
  function selectFile(file) {
    if (!file) return Promise.reject({ code: 'badFile' });
    return fileFingerprint(file).then(function (fp) {
      m3File = file;
      m3Fp = fp;
      m3DurationSentFp = null; // 重新选文件：时长需重新补报
      sendReady({ kind: 'm3', fp: fp, size: file.size || 0, name: file.name || '', duration: 0 });
      var role = null;
      try {
        var w = wp();
        var rs = w && typeof w.roomState === 'function' ? w.roomState() : null;
        role = rs ? rs.role : null;
      } catch (e) { }
      if (role !== 'host') m3Play(file);
      return fp;
    });
  }

  // 时长补报：M3 Blob 元数据就绪后发第二次 ready（供对端按百分比对齐，字段名与
  // watch-party.js m3AlignTarget 读取的 info.duration 严格一致）
  function onM3LoadedMetadata() {
    try {
      if (!m3Active || !m3Fp || m3DurationSentFp === m3Fp) return;
      var a = getArt();
      var v = a && a.video;
      var d = v ? Number(v.duration) : NaN;
      if (isFinite(d) && d > 0) {
        m3DurationSentFp = m3Fp;
        sendReady({
          kind: 'm3', fp: m3Fp,
          size: m3File ? (m3File.size || 0) : 0,
          name: m3File ? (m3File.name || '') : '',
          duration: d
        });
      }
    } catch (e) { }
  }

  // 同一 art 实例只挂一次时长探测（实例重建后随新实例重挂）
  function attachDurationProbe(a) {
    if (!a || typeof a.on !== 'function' || a.__wdtvM3Probe) return;
    try {
      a.on('video:loadedmetadata', onM3LoadedMetadata);
      a.__wdtvM3Probe = true;
    } catch (e) { }
  }

  // ============================================================
  // M3：Blob 播放（watch-party.startM3 经 localHooks.m3Play 调用）
  // 成功 return true；失败 return false（Blob/状态做回收，不抛出阻断主流程）
  // ============================================================
  function m3Play(file) {
    try {
      if (!file) return false;
      if (!prevUrl) prevUrl = getVideoKey() || null; // 切换前记录原集
      revokeBlob(); // 释放旧 Blob（重复选择文件场景）
      var url;
      try { url = URL.createObjectURL(file); } catch (e) { return false; }
      if (!url) return false;
      m3BlobUrl = url;
      m3File = file;
      m3Active = false;
      try { window.WDTVNoAutoplay = true; } catch (e) { } // 拦截自动连播（player.js video:ended 检查）
      try {
        var vc = vcache();
        if (vc && typeof vc.setPaused === 'function') vc.setPaused(true); // 停预取泵
      } catch (e) { }
      var a = getArt();
      var ok = false;
      if (a) {
        try { a.switch = m3BlobUrl; ok = true; } catch (e) { ok = false; }
        if (!ok && typeof a.switchUrl === 'function') {
          try { a.switchUrl(m3BlobUrl); ok = true; } catch (e) { }
        }
      }
      if (!ok) {
        revokeBlob(); // 播放切换失败：回收 Blob，保持指纹/文件记录供对端比对
        return false;
      }
      m3Active = true;
      attachDurationProbe(a);
      return true;
    } catch (e) { return false; }
  }

  // ============================================================
  // M3：退出（watch-party.leave() 在 mode==='M3' 时于清理前调用；
  // 亦可由 UI 直接调用）。回收 Blob、恢复预取与自动连播、解锁档位、恢复原集。
  // ============================================================
  function m3Exit() {
    revokeBlob();
    m3File = null;
    m3Fp = null;
    m3Active = false;
    m3DurationSentFp = null;
    lastM3Src = null;
    try { window.WDTVNoAutoplay = false; } catch (e) { }
    try {
      var vc = vcache();
      if (vc && typeof vc.setPaused === 'function') vc.setPaused(false);
    } catch (e) { }
    unlockLevel();
    var target = prevUrl;
    prevUrl = null;
    if (!target) return;
    var a = getArt();
    var ok = false;
    if (a) {
      try { a.switch = target; ok = true; } catch (e) { ok = false; } // m3u8 走 player 已配置的 customType 链路
      if (!ok && typeof a.switchUrl === 'function') {
        try { a.switchUrl(target); ok = true; } catch (e) { }
      }
    }
    if (ok) return;
    // 恢复失败兜底：带 room 码整页跳回（roomState().code 在 leave() 清理前仍有效）
    try {
      var code = roomCode();
      location.href = 'player.html?url=' + encodeURIComponent(target) +
        (code ? '&room=' + encodeURIComponent(code) : '');
    } catch (e) { }
  }

  // ============================================================
  // M2：清晰度锁档 / 解锁
  // lockLevel：无该层（levels.length <= levelIndex）返回 false，由调用方 toast 回退
  // unlockLevel：currentLevel=-1 恢复 ABR（hls.js 的 autoLevelEnabled 为只读 getter，
  //              赋值在严格模式会抛错，单独 try/catch 吞掉即可，-1 赋值已生效）
  // ============================================================
  function lockLevel(levelIndex) {
    try {
      var hls = getHls();
      if (!hls) return false;
      var idx = Number(levelIndex);
      if (!isFinite(idx) || idx < 0) return false;
      var levels = hls.levels;
      if (!levels || !levels.length || levels.length <= idx) return false;
      try { hls.currentLevel = idx; } catch (e) { return false; }
      try { hls.autoLevelEnabled = false; } catch (e) { } // 只读属性：由 currentLevel 赋值等效关闭 ABR
      levelLocked = true;
      return true;
    } catch (e) { return false; }
  }

  function unlockLevel() {
    if (!levelLocked) return;
    levelLocked = false;
    try {
      var hls = getHls();
      if (!hls) return;
      try { hls.currentLevel = -1; } catch (e) { }
      try { hls.autoLevelEnabled = true; } catch (e) { }
    } catch (e) { }
  }

  // ============================================================
  // M2/M1：覆盖率上报（watch-party snap/src 命中同集时经 localHooks 调用，UI 亦可直接调用）
  // 一致性判定改用稳定基准地址（base）而非 currentVideoUrl——后者会被清晰度目录探测改写，
  // 曾致"双方都缓存完了却显示 0"。base 不一致（真的换了片子）才置 mismatch。
  // 覆盖率查询按 currentVideoUrl（缓存键）；未命中时按片名在缓存清单兜底匹配
  // （跨会话/跨档位的分片键漂移场景）。
  // ============================================================
  function coverageReport(mediaKey) {
    // 去重：同 mediaKey 近距离重复触发（远端 src 时 watch-party 与本模块监听各触发一次）合并
    var now = Date.now();
    if (mediaKey != null && String(mediaKey) === String(covKey) && now - covAt < COV_DEBOUNCE_MS) {
      return Promise.resolve(lastCoverage);
    }
    covKey = mediaKey;
    covAt = now;

    var videoKey = getVideoKey();
    var baseKey = getBaseKey();
    var mk = String(mediaKey == null ? '' : mediaKey);
    var expected = (/^m[12]\|/.test(mk) ? mk.slice(3) : baseKey);
    if (mediaKey != null && expected !== baseKey) {
      // 基准地址不一致 = 真的换了片子：零覆盖率 + mismatch 标记（UI 据此提示，禁入 M2）
      lastCoverage = { videoKey: videoKey, baseKey: baseKey, percent: 0, cached: 0, total: 0, mismatch: true };
      sendReady({ kind: 'm2', videoKey: videoKey, baseKey: baseKey, percent: 0, cached: 0, total: 0, mismatch: true });
      return Promise.resolve(lastCoverage);
    }

    var title = callGetter('getTitle') || '';
    var vc = vcache();
    if (vc && typeof vc.coverageOf === 'function') {
      // 首选：VideoCache.coverageOf 纯读导出（缓存键 = currentVideoUrl）
      return Promise.resolve().then(function () { return vc.coverageOf(videoKey); })
        .then(function (cov) {
          // 未命中（跨会话/跨档位的键漂移）→ 按片名兜底匹配缓存清单
          if (cov && cov.percent > 0 && cov.cached > 0) return finish(cov);
          return fallbackEntries(videoKey, title).then(function (fb) {
            return finish(fb && fb.cached > 0 ? fb : cov);
          });
        })
        .catch(function () { return fallbackEntries(videoKey, title).then(finish); });
    }
    return fallbackEntries(videoKey, title).then(finish);

    function finish(cov) {
      try {
        cov = cov || {};
        var cached = typeof cov.cached === 'number' ? cov.cached : 0;
        var total = typeof cov.total === 'number' ? cov.total : 0;
        var percent = typeof cov.percent === 'number'
          ? Math.max(0, Math.min(100, Math.round(cov.percent)))
          : (total > 0 ? Math.max(0, Math.min(100, Math.round(cached / total * 100))) : 0);
        lastCoverage = { videoKey: videoKey, baseKey: baseKey, percent: percent, cached: cached, total: total };
        // watch-party.sendReady 会读取 info.percent 作为 buf 上报的 cached 数据源
        sendReady({ kind: 'm2', videoKey: videoKey, baseKey: baseKey, percent: percent, cached: cached, total: total });
        return lastCoverage;
      } catch (e) { return null; }
    }
  }

  // 兜底估算：listEntries() 找缓存条目——先精确 videoKey，未命中再按片名（title）匹配
  //（title 与 currentVideoTitle 同源，跨会话/跨清晰度档位稳定），取其 fragCount/total 折算覆盖率
  function fallbackEntries(videoKey, title) {
    var vc = vcache();
    if (!vc || typeof vc.listEntries !== 'function' || (!videoKey && !title)) {
      return Promise.resolve({ cached: 0, total: 0 });
    }
    return Promise.resolve().then(function () { return vc.listEntries(); }).then(function (list) {
      if (Array.isArray(list)) {
        var byTitle = null;
        for (var i = 0; i < list.length; i++) {
          var e = list[i];
          if (String(e.videoKey) === String(videoKey)) return { cached: e.fragCount || 0, total: e.total || 0 };
          // 片名匹配兜底：跨会话/跨档位时分片键漂移，但 meta.title 稳定
          if (!byTitle && title && e.title && String(e.title) === String(title) && (e.total || 0) > 0) {
            byTitle = { cached: e.fragCount || 0, total: e.total || 0 };
          }
        }
        if (byTitle) return byTitle;
      }
      return { cached: 0, total: 0 };
    }).catch(function () { return { cached: 0, total: 0 }; });
  }

  // ============================================================
  // 片源应用（观影方 M1/M2 换片源）：带 room 码整页跳转，跳回后重新 join+snap 对齐
  // 入参名与 player.js 初始化读取一致（url / index；room 供 watch-party 刷新直连）
  // ============================================================
  function applySrcRedirect(video, code) {
    try {
      var v = video || {};
      if (!v.url) return;
      // 防循环双保险：当前地址已携带同一 url 参数（刚跳转回来、player 尚在初始化）→ 不再跳转，
      // 交由 watch-party 的对齐等待机制处理（否则会形成「跳转→snap→再跳转」死循环）
      try {
        var curParam = new URLSearchParams(location.search).get('url');
        if (curParam && (curParam === v.url || decodeURIComponent(curParam) === v.url)) return;
      } catch (e) { }
      // 集数列表预写入对方 localStorage：跳转后 player 从 localStorage 重建剧集栏，
      // 共享控制下对方换集才可用（URL 传参会被 player 的双重解码破坏，故走 localStorage）
      if (v.episodes && v.episodes.length) {
        try { localStorage.setItem('currentEpisodes', JSON.stringify(v.episodes)); } catch (e) { }
      }
      var href = 'player.html?url=' + encodeURIComponent(v.url) +
        '&index=' + (v.epIndex || 0) +
        // title 透传：嘉宾端无房主播放上下文，缺 title 会显示 localStorage 旧片名/"未知视频"
        (v.title ? '&title=' + encodeURIComponent(v.title) : '') +
        (code ? '&room=' + encodeURIComponent(code) : '');
      location.href = href;
    } catch (e) { }
  }

  // ============================================================
  // 信令监听（文件加载即注册；WatchParty 不在场时静默跳过）
  // ============================================================
  function register() {
    var w = wp();
    if (!w || typeof w.on !== 'function') return;

    // 片源广播：M2 与本地同集 → 自动补一次覆盖率上报（房主开播自报 / 刷新与中途加入场景）；
    // M3 → 记录确认开播信号：本端已播则静默，未播提示由 watch-party.applySrcMsg 内置 toast 承担
    w.on('src', function (p) {
      try {
        var v = p && p.video;
        if (!v) return;
        if (v.mode === 'M2') {
          if (v.url && String(v.url) === getVideoKey()) coverageReport(v.mediaKey);
        } else if (v.mode === 'M3') {
          lastM3Src = v;
        }
      } catch (e) { }
    });

    // 片源应用事件（watch-party 在"远端 src url 与本地不同"时发出；本模块自带跳转实现）
    w.on('applySrc', function (p) {
      try { applySrcRedirect(p && p.video, roomCode()); } catch (e) { }
    });

    // 对端就绪上报：学习 M3 {uid, fp, duration, name, size}（时长供百分比对齐，字段名与
    // watch-party.m3AlignTarget 一致；readyMap 为权威，此处仅本地副本）
    w.on('ready', function (p) {
      try {
        var info = p && p.info;
        if (info && info.kind === 'm3' && p.uid != null) {
          peerM3[String(p.uid)] = { fp: info.fp, duration: info.duration, name: info.name, size: info.size };
        }
      } catch (e) { }
    });
  }

  // ============================================================
  // 装配：注册 localHooks + 信令监听，导出公开 API
  // ============================================================
  try {
    var w0 = window.WatchParty;
    if (w0 && typeof w0.setLocalHooks === 'function') {
      w0.setLocalHooks({
        coverageReport: coverageReport,
        lockLevel: lockLevel,
        m3Play: m3Play,
        m3Exit: m3Exit,
        applySrcRedirect: applySrcRedirect
      });
    }
  } catch (e) { }
  register();

  window.WatchPartyLocal = {
    fileFingerprint: fileFingerprint,
    selectFile: selectFile,
    m3Exit: m3Exit,
    lockLevel: lockLevel,
    coverageReport: coverageReport,
    get lastCoverage() { return lastCoverage; }
  };
})();
