/* =====================================================================
   WDTV 站点背景动效（首页同款）
   ---------------------------------------------------------------------
   镜像自 index.html 底部的内联脚本：preloader 淡出、RAIN 雨幕、
   GLASS CANVAS 水波涟漪 / 雨滴落水、rain 可见性同步。
   首页仍使用内联版本（保持不变），about.html 等静态页引用本脚本。

   依赖的 DOM（与 index.html 背景层结构一一对应）：
     #preloader、#rain-container、#splash、.splash-glow、#gw-ripple-bg、
     #gw-slot > #gw-pane > .gw-img / #gw-ripple / .gw-grade-* / .gw-frost / .gw-depth
   依赖的背景图：bg-canvas.jpg（失败回退 bg-canvas.png）。

   维护约定：首页内联 FX 脚本若有调整，请同步本文件。
   ===================================================================== */
(function () {
  'use strict';

  /* ---------- Preloader ---------- */
  (function () {
    function reveal() {
      var pre = document.getElementById('preloader');
      if (!pre || pre._done) return;
      pre._done = true;
      pre.classList.add('fade-out');
      setTimeout(function () { if (pre.parentNode) pre.parentNode.removeChild(pre); }, 1500);
    }
    /* 显示时机：不再等 window.load（要等全部脚本/字体/图片完成，慢网下遮罩盖数秒）。
       改为 DOM 就绪 + 首屏背景图就绪二者取晚，淡出时背景已就位、不露出纯色底；
       1.5s 兜底避免极慢网一直遮着，scheduled 保证只调度一次。 */
    var domReady = document.readyState !== 'loading', bgReady = false, scheduled = false;
    function maybe() { if (domReady && bgReady && !scheduled) { scheduled = true; setTimeout(reveal, 120); } }
    if (!domReady) document.addEventListener('DOMContentLoaded', function () { domReady = true; maybe(); });
    var probe = new Image();
    probe.onload = probe.onerror = function () { bgReady = true; maybe(); };
    probe.src = 'bg-canvas.jpg';
    setTimeout(function () { domReady = true; bgReady = true; maybe(); }, 1500);
  })();

  /* ---------- Rain ---------- */
  (function () {
    var box = document.getElementById('rain-container');
    if (!box) return;
    var cv = document.createElement('canvas');
    box.appendChild(cv);
    var ctx = cv.getContext('2d');
    var dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    var W = 0, H = 0;
    function R(a, b) { return a + Math.random() * (b - a); }
    var WIND = 24;
    var drops = [];
    function reset(d) {
      d.z = R(0.35, 1); d.x = Math.random() * W; d.v = (380 + R(0, 320)) * d.z;
      d.y = -R(0.05, 1.2) * d.v; d.w = 1.8 + d.z * 0.8; d.wf = R(0.8, 1.2);
      /* 渐变色只取决于 d.z（生命周期内固定），预先算好字符串，
         避免每帧为 45 滴各做 3 次 toFixed + 字符串拼接（约 2700 次/秒）。 */
      var a = 0.18 + 0.26 * d.z;
      d.g0 = 'rgba(200,220,242,0)';
      d.g1 = 'rgba(208,225,245,' + (a * 0.55).toFixed(3) + ')';
      d.g2 = 'rgba(218,232,250,' + Math.min(0.5, a * 1.15).toFixed(3) + ')';
      d.fill = 'rgba(224,238,252,' + Math.min(0.45, a * 0.9).toFixed(3) + ')';
    }
    function size() {
      W = window.innerWidth; H = window.innerHeight;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      drops.length = 0;
      for (var i = 0; i < 45; i++) { var d = {}; reset(d); drops.push(d); }
    }
    var last = 0, rafId = null, rainHeld = false;
    function fxOff() { return document.documentElement.classList.contains('fx-off'); }
    function loop(ts) {
      if (fxOff() || document.hidden) { rafId = null; return; }
      rafId = requestAnimationFrame(loop);
      var mo = document.getElementById('modal');
      if (mo && !mo.classList.contains('hidden')) {
        if (!rainHeld) { ctx.clearRect(0, 0, W, H); rainHeld = true; }
        last = ts; return;
      }
      rainHeld = false;
      var dt = Math.min(0.05, (ts - last) / 1000 || 0.016); last = ts;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H); ctx.lineCap = 'round';
      for (var i = 0; i < drops.length; i++) {
        var d = drops[i]; var wz = WIND * d.z * d.wf; d.y += d.v * dt; d.x += wz * dt;
        if (d.x > W + 30) d.x -= W + 60;
        var len = Math.min(72, d.v * 0.1);
        if (d.y - len > H) { reset(d); continue; }
        if (d.y < -40) continue;
        var tx = d.x - wz * (len / d.v), ty = d.y - len;
        var g = ctx.createLinearGradient(tx, ty, d.x, d.y);
        g.addColorStop(0, d.g0);
        g.addColorStop(0.62, d.g1);
        g.addColorStop(1, d.g2);
        ctx.strokeStyle = g; ctx.lineWidth = d.w;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(d.x, d.y); ctx.stroke();
        ctx.fillStyle = d.fill;
        ctx.beginPath(); ctx.arc(d.x, d.y, d.w * 0.55, 0, 6.2832); ctx.fill();
      }
    }
    function startRain() { if (rafId == null && !fxOff() && !document.hidden) rafId = requestAnimationFrame(loop); }
    function stopRain() { if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } }
    window.__fxRain = startRain;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopRain(); else startRain();
    });
    window.addEventListener('resize', size);
    size(); startRain();
  })();

  /* ---------- Glass canvas: water ripple ---------- */
  (function () {
    var slot = document.getElementById('gw-slot');
    var pane = document.getElementById('gw-pane');
    var rcv = document.getElementById('gw-ripple');
    var bgcv = document.getElementById('gw-ripple-bg');
    var sp = document.getElementById('splash');
    if (!slot || !pane || !rcv || !bgcv) return;
    var rctx = rcv.getContext('2d');
    var bgctx = bgcv.getContext('2d');
    var dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1)), bscale = dpr;
    function R(a, b) { return a + Math.random() * (b - a); }
    var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var mqSmall = window.matchMedia ? window.matchMedia('(max-width:900px)') : { matches: false };
    var W = 0, H = 0, img = null; var REFRACT_OK = true;
    var SW = 0, SH = 0, h1 = null, h2 = null, bgData = null, outImg = null, dst32 = null;
    var phaseA = null, phaseB = null;
    /* 小端设备用 Uint32Array 一次写入 RGBA 四通道，省掉每像素 3 次数组写入；
       大端设备回退逐字节路径，两条路径产出的字节序列完全一致。 */
    var LE = (function () { var b = new Uint8Array(4); new Uint32Array(b.buffer)[0] = 1; return b[0] === 1; })();
    var rippleScale = 1;
    var sim = document.createElement('canvas'), simCtx = null;
    var RIPPLE_MAG = 1.5;
    var MOUSE_MAG = 2;
    var MOUSE_STR_MAG = 1.4;
    var DAMP = 0.9855, REFRACT = 2.0, LIGHT = 10, STEP = 1 / 30;
    function poke(cx, cy, str, rad) {
      rad = rad * rippleScale * RIPPLE_MAG; cx |= 0; cy |= 0;
      var r2 = rad * rad, R0 = Math.ceil(rad);
      for (var y = -R0; y <= R0; y++) {
        for (var x = -R0; x <= R0; x++) {
          var px = cx + x, py = cy + y;
          if (px < 1 || py < 1 || px >= SW - 1 || py >= SH - 1) continue;
          var f = (x * x + y * y) / r2; if (f > 1) continue;
          h1[py * SW + px] += str * (0.5 + 0.5 * Math.cos(Math.PI * Math.sqrt(f)));
        }
      }
    }
    var swT = 0;
    var SIN_TABLE = new Float32Array(1024);
    for (var i = 0; i < 1024; i++) SIN_TABLE[i] = Math.sin(i / 1024 * Math.PI * 2);
    function fastSin(x) { x = x % (Math.PI * 2); if (x < 0) x += Math.PI * 2; return SIN_TABLE[(x / (Math.PI * 2) * 1024) | 0]; }
    function buildPhases() {
      phaseA = new Float32Array(SW); phaseB = new Float32Array(SW);
      for (var x = 0; x < SW; x++) { phaseA[x] = x * 0.05; phaseB[x] = -x * 0.023; }
    }
    function makeOut() {
      outImg = simCtx.createImageData(SW, SH);
      dst32 = LE ? new Uint32Array(outImg.data.buffer) : null;
    }
    function stepWater() {
      swT += 0.0333;
      var tA = swT * 0.7, tB = swT * 0.43;
      for (var y = 1; y < SH - 1; y++) {
        var i = y * SW + 1;
        var a0 = tA + y * 0.021, b0 = tB + y * 0.041;
        for (var x = 1; x < SW - 1; x++, i++) {
          h2[i] = ((h1[i - 1] + h1[i + 1] + h1[i - SW] + h1[i + SW]) * 0.5 - h2[i]) * DAMP
            + 0.0024 * fastSin(a0 + phaseA[x])
            + 0.0019 * fastSin(b0 + phaseB[x]);
        }
      }
      var t = h1; h1 = h2; h2 = t;
    }
    function renderWater() {
      var ctx = (mode === 'bg') ? bgctx : rctx;
      var GAIN = (mode === 'bg') ? 150 * RIPPLE_MAG : 330 * RIPPLE_MAG,
        CAP = (mode === 'bg') ? 110 * RIPPLE_MAG : 165 * RIPPLE_MAG;
      var h = h1;
      if (dst32) {
        /* 小端打包 RGBA：亮色 0xFFEEE0 / 暗色 0x2C160A，alpha 占高 8 位。
           省掉原实现里每格 2 次乘法、2 次数组读（gx 未被使用）与 4 次字节写。 */
        for (var y = 0; y < SH; y++) {
          var row = y * SW;
          var yuOff = (y > 0 ? y - 1 : y) * SW, ydOff = (y < SH - 1 ? y + 1 : y) * SW;
          for (var x = 0; x < SW; x++) {
            var a = (h[yuOff + x] - h[ydOff + x]) * GAIN;
            var q;
            if (a >= 0) { q = a * 0.18; dst32[row + x] = ((((q > CAP ? CAP : q) | 0) << 24) | 0xFFEEE0) >>> 0; }
            else { q = -a * 0.1; dst32[row + x] = ((((q > CAP ? CAP : q) | 0) << 24) | 0x2C160A) >>> 0; }
          }
        }
      } else {
        var dst = outImg.data;
        for (var y2 = 0; y2 < SH; y2++) {
          var row2 = y2 * SW;
          var yuOff2 = (y2 > 0 ? y2 - 1 : y2) * SW, ydOff2 = (y2 < SH - 1 ? y2 + 1 : y2) * SW;
          for (var x2 = 0; x2 < SW; x2++) {
            var di = (row2 + x2) * 4;
            var a2 = (h[yuOff2 + x2] - h[ydOff2 + x2]) * GAIN;
            if (a2 >= 0) { a2 = a2 * 0.18; dst[di] = 224; dst[di + 1] = 238; dst[di + 2] = 255; dst[di + 3] = (a2 > CAP ? CAP : a2) | 0; }
            else { a2 = -a2 * 0.1; dst[di] = 10; dst[di + 1] = 22; dst[di + 2] = 44; dst[di + 3] = (a2 > CAP ? CAP : a2) | 0; }
          }
        }
      }
      simCtx.putImageData(outImg, 0, 0);
      var rs = (mode === 'bg') ? bscale : dpr;
      ctx.setTransform(rs, 0, 0, rs, 0, 0); ctx.imageSmoothingEnabled = true;
      ctx.clearRect(0, 0, W, H); ctx.drawImage(sim, 0, 0, W, H);
    }
    var rainT = R(0.6, 1.6), ambT = R(1.5, 3);
    function rhythm(dt) {
      rainT -= dt;
      if (rainT <= 0) { rainT = R(0.9, 2.4); spawnDrop(R(0.8, 1.5)); if (Math.random() < 0.18) spawnDrop(R(0.5, 0.9)); }
      ambT -= dt;
      if (ambT <= 0) { ambT = R(2.5, 5.5); poke(R(2, SW - 2), R(2, SH - 2), R(0.25, 0.55), 3); }
    }
    var drops = [], plips = [];
    function spawnDrop(str) {
      var sx = R(2, SW - 2), sy = R(2, SH - 2);
      var px = sx / SW * W, py = sy / SH * H;
      var fall = H * R(0.34, 0.52);
      var dur = R(0.3, 0.42), vx = R(-8, 14);
      drops.push({ x: px - vx * dur, y: py - fall, ty: py, sx: sx, sy: sy, str: str, v: fall / dur, vx: vx, w: 1.0 + str * 0.35 });
    }
    function updateDrops(dt, ctx) {
      for (var i = drops.length - 1; i >= 0; i--) {
        var d = drops[i]; d.x += d.vx * dt; d.y += d.v * dt;
        if (d.y >= d.ty) {
          poke(d.sx, d.sy, d.str * 1.15, 1.6); poke(d.sx, d.sy, -d.str * 0.4, 3.2);
          plips.push({ x: d.x, y: d.ty, t: 0.22 }); drops.splice(i, 1); continue;
        }
        var len = Math.min(26, d.v * 0.045);
        var tx = d.x - d.vx * (len / d.v), ty = d.y - len;
        var g = ctx.createLinearGradient(tx, ty, d.x, d.y);
        g.addColorStop(0, 'rgba(214,229,248,0)');
        g.addColorStop(0.7, 'rgba(206,223,246,0.42)');
        g.addColorStop(1, 'rgba(232,243,255,0.8)');
        ctx.strokeStyle = g; ctx.lineWidth = d.w; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(d.x, d.y); ctx.stroke();
      }
      for (var j = plips.length - 1; j >= 0; j--) {
        var p = plips[j]; p.t -= dt;
        if (p.t <= 0) { plips.splice(j, 1); continue; }
        var a = p.t / 0.22;
        ctx.strokeStyle = 'rgba(228,241,255,' + (0.45 * a).toFixed(3) + ')'; ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.2 + (1 - a) * 5, 0, 6.2832); ctx.stroke();
        ctx.fillStyle = 'rgba(236,246,255,' + (0.55 * a * a).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.4 * a + 0.3, 0, 6.2832); ctx.fill();
      }
    }
    var stirPts = {};
    function toSim(e) {
      if (mode === 'pane') {
        var r = pane.getBoundingClientRect();
        if (r.width < 2 || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return null;
        return { x: (e.clientX - r.left) / r.width * SW, y: (e.clientY - r.top) / r.height * SH };
      }
      return { x: e.clientX / W * SW, y: e.clientY / H * SH };
    }
    function stir(e) {
      if (!(e.buttons & 1)) return;
      if (!tgtOk || idleNow()) return;
      var p = toSim(e); if (!p) return;
      var lp = stirPts[e.pointerId];
      if (!lp) { stirPts[e.pointerId] = { x: p.x, y: p.y }; return; }
      var dx = p.x - lp.x, dy = p.y - lp.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1.15) return;
      var steps = Math.min(6, Math.ceil(d / 1.5));
      var s = Math.min(0.55, 0.12 + d * 0.05);
      for (var i = 1; i <= steps; i++) poke(lp.x + dx * i / steps, lp.y + dy * i / steps, s * MOUSE_STR_MAG, 1.7 * MOUSE_MAG);
      lp.x = p.x; lp.y = p.y;
    }
    function tap(e) {
      if (!tgtOk || idleNow()) return;
      var p = toSim(e); if (!p) return;
      stirPts[e.pointerId] = { x: p.x, y: p.y };
      poke(p.x, p.y, 2.0 * MOUSE_STR_MAG, 2.8 * MOUSE_MAG);
    }
    function lift(e) { delete stirPts[e.pointerId]; }
    function onContent(e) {
      var t = e.target;
      return !!(t && t.closest && t.closest('.abt-shell'));
    }
    function bgBlank(e) {
      var t = e.target;
      if (!t || t === sp || t === slot || t === pane) return true;
      if (t.closest && (t.closest('#searchArea') || t.closest('#doubanArea') || t.closest('#resultsArea') ||
        t.closest('#cinemaEmpty') || t.closest('.wsp-stage') || t.closest('.wdtv-dock') ||
        t.closest('.wdtv-modal-overlay') || t.closest('.wdtv-disclaimer-modal') ||
        t.closest('.wdtv-history-panel') || t.closest('.wdtv-settings-panel') ||
        t.closest('#chat-mini') || t.closest('.abt-shell'))) return false;
      return true;
    }
    if (sp && !REDUCED) {
      var gwTouch = {};
      sp.addEventListener('pointerdown', function (e) {
        if (mode !== 'bg') return;
        var ok = bgBlank(e); gwTouch[e.pointerId] = ok;
        if (ok) tap(e);
      }, { passive: true });
      sp.addEventListener('pointermove', function (e) { if (mode === 'bg' && gwTouch[e.pointerId] !== false) stir(e); }, { passive: true });
      sp.addEventListener('pointerup', function (e) { lift(e); delete gwTouch[e.pointerId]; }, { passive: true });
      sp.addEventListener('pointercancel', function (e) { lift(e); delete gwTouch[e.pointerId]; }, { passive: true });
      sp.addEventListener('pointerleave', function (e) { lift(e); delete gwTouch[e.pointerId]; }, { passive: true });
    }
    /* 雾气绘制与擦除逻辑、4 个指针监听器已移除：该 canvas 继承 .gw-ly 的
       pointer-events:none，命中测试永远跳过它，擦雾交互不可达；手机 bg 模式也从不
       初始化它（完全不可见），且每次 resize 还会做 5 次全屏绘制。 */
    function gridFit() {
      var targetW = Math.min(800, Math.max(200, Math.round(W / 2)));
      SW = Math.max(200, targetW); SH = Math.max(100, Math.round(SW * H / W));
      rippleScale = 1;
      sim.width = SW; sim.height = SH; simCtx = sim.getContext('2d');
      h1 = new Float32Array(SW * SH); h2 = new Float32Array(SW * SH);
      buildPhases();
      stepAcc = 0; stirPts = {};
      if (drops) drops.length = 0;
      if (plips) plips.length = 0;
    }
    function rebuildBg() {
      if (!img) return false;
      var iw = img.naturalWidth, ih = img.naturalHeight;
      if (!iw || !ih) return false;
      var scale = Math.max(W / iw, H / ih);
      var sw = W / scale, sh = H / scale;
      var sx = (iw - sw) / 2, sy = (ih - sh) / 2;
      var tmp = document.createElement('canvas');
      tmp.width = SW; tmp.height = SH;
      var tc = tmp.getContext('2d');
      tc.drawImage(img, sx, sy, sw, sh, 0, 0, SW, SH);
      try { bgData = tc.getImageData(0, 0, SW, SH); REFRACT_OK = true; slot.classList.remove('gw-gloss'); }
      catch (_) { bgData = null; REFRACT_OK = false; slot.classList.add('gw-gloss'); }
      makeOut();
      return true;
    }
    function retarget(m) {
      if (m === 'pane') {
        var r = pane.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        W = r.width; H = r.height;
        rcv.width = Math.round(W * dpr); rcv.height = Math.round(H * dpr);
        gridFit(); return rebuildBg();
      }
      W = window.innerWidth; H = window.innerHeight;
      if (W < 2 || H < 2) return false;
      bscale = Math.min(dpr, 1.5);
      bgcv.width = Math.round(W * bscale); bgcv.height = Math.round(H * bscale);
      gridFit(); makeOut();
      for (var k = 0; k < 3; k++) poke(R(2, SW - 2), R(2, SH - 2), R(0.5, 1.1), 2);
      return true;
    }
    var mode = null, tgtOk = false, shownP = false, shownB = false;
    function computeMode() { return mqSmall.matches ? 'bg' : 'pane'; }
    function idleNow() {
      if (document.hidden) return true;
      if (slot.classList.contains('gw-exit')) return true;
      var m = document.getElementById('modal');
      if (m && !m.classList.contains('hidden')) return true;
      return false;
    }
    var last = 0, stepAcc = 0, gwRafId = null;
    function gwStart() {
      if (gwRafId != null) return;
      if (document.documentElement.classList.contains('fx-off') || document.hidden) return;
      gwRafId = requestAnimationFrame(loop);
    }
    function gwStop() { if (gwRafId != null) { cancelAnimationFrame(gwRafId); gwRafId = null; } }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) gwStop(); else gwStart();
    });
    function loop(ts) {
      if ((sp && sp.classList.contains('hidden')) || document.documentElement.classList.contains('fx-off') || document.hidden) { gwRafId = null; return; }
      gwRafId = requestAnimationFrame(loop);
      var m = computeMode();
      if (m !== mode) {
        mode = m; tgtOk = retarget(m);
        if (m !== 'bg') { bgcv.classList.remove('on'); shownB = false; }
      }
      if (!tgtOk || idleNow()) { last = ts; return; }
      var raw = (ts - last) / 1000 || 0.016; last = ts;
      var dt = Math.min(0.05, raw);
      var tdt = Math.min(2, raw);
      rhythm(tdt);
      stepAcc += dt;
      var n = 0;
      while (stepAcc >= STEP && n < 2) { stepWater(); stepAcc -= STEP; n++; }
      renderWater();
      updateDrops(dt, (mode === 'bg') ? bgctx : rctx);
      if (mode === 'pane') { if (!shownP) { shownP = true; slot.classList.add('gw-rippling'); } }
      else if (!shownB) { shownB = true; bgcv.classList.add('on'); }
    }
    if (window.ResizeObserver) new ResizeObserver(function () { if (mode === 'pane') tgtOk = retarget('pane'); }).observe(pane);
    window.addEventListener('resize', function () { if (!gwIsTyping() && mode) tgtOk = retarget(mode); });
    (function probe(names) {
      if (!names.length) return;
      var name = names.shift(); var im = new Image();
      im.onload = function () {
        img = im;
        if (REDUCED) { mode = 'pane'; if (retarget('pane')) { renderWater(); slot.classList.add('gw-rippling'); } return; }
        if (mode === 'pane') tgtOk = retarget('pane');
      };
      im.onerror = function () { probe(names); };
      im.src = name;
    })(['bg-canvas.jpg', 'bg-canvas.png']);
    (function probeBg(names) {
      if (!names.length) return;
      var name = names.shift(); var im = new Image();
      im.onload = function () {
        var el = document.getElementById('gw-img');
        if (el) el.style.backgroundImage = 'url("' + name + '")';
        if (im.naturalWidth > 0 && im.naturalHeight > 0) {
          document.documentElement.style.setProperty('--gw-ar', (im.naturalWidth / im.naturalHeight).toFixed(6));
        }
        slot.classList.add('gw-has-img');
      };
      im.onerror = function () { probeBg(names); };
      im.src = name;
    })(['bg-canvas.jpg', 'bg-canvas.png']);
    if (sp && !REDUCED) {
      sp.addEventListener('pointerdown', function (e) { if (mode === 'pane' && !onContent(e)) tap(e); });
      sp.addEventListener('pointermove', function (e) { if (mode === 'pane' && !onContent(e)) stir(e); });
      sp.addEventListener('pointerup', lift);
      sp.addEventListener('pointercancel', lift);
      sp.addEventListener('pointerleave', lift);
    }
    if (!REDUCED) gwStart();

    /* 软键盘修复（与首页一致）：背景层在键盘弹起期间锁定高度、反向平移 */
    var gwTyping = false, gwBaseH = window.innerHeight;
    function gwIsTyping() { var ae = document.activeElement; return !!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')); }
    function gwUnlock() { gwTyping = false; slot.style.height = ''; slot.style.transform = ''; }
    function gwVvFix() {
      var off = 0;
      if (gwTyping && window.visualViewport) off = Math.round(window.visualViewport.offsetTop > 0 ? window.visualViewport.offsetTop : 0);
      slot.style.transform = off ? ('translate3d(0,' + off + 'px,0)') : '';
    }
    var gwPollT = null;
    function gwPollStop() { if (gwPollT) { clearInterval(gwPollT); gwPollT = null; } }
    document.addEventListener('focusin', function (e) {
      var t = e.target;
      if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) return;
      if (!gwTyping) { gwTyping = true; slot.style.height = gwBaseH + 'px'; }
      gwVvFix(); gwPollStop();
      var n = 0;
      gwPollT = setInterval(function () { gwVvFix(); if (++n > 10 || !gwTyping) gwPollStop(); }, 120);
    });
    document.addEventListener('focusout', function () {
      gwPollStop();
      setTimeout(function () { if (!gwIsTyping()) gwTyping = false; }, 60);
      setTimeout(function () { if (!gwIsTyping() && !window.visualViewport) gwUnlock(); }, 400);
    });
    window.addEventListener('resize', function () {
      if (!gwIsTyping()) { gwBaseH = window.innerHeight; if (slot.style.height) gwUnlock(); }
      gwVvFix();
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () { if (!gwTyping && slot.style.height) gwUnlock(); gwVvFix(); });
      window.visualViewport.addEventListener('scroll', gwVvFix);
    }
    window.__fxGlass = gwStart;
  })();

  /* ---------- Rain visibility（preloader 淡出后显示雨幕） ---------- */
  (function () {
    var rc = document.getElementById('rain-container');
    if (!rc) return;
    function show() { rc.classList.add('rain-visible'); }
    var pl = document.getElementById('preloader');
    if (!pl || pl.classList.contains('fade-out')) { show(); return; }
    var obs = new MutationObserver(function () {
      if (pl.classList.contains('fade-out')) { show(); obs.disconnect(); }
    });
    obs.observe(pl, { attributes: true, attributeFilter: ['class'] });
  })();

  /* 动态效果开关切回「开启」时恢复两条动画循环：首页由 app.js 调用
     __fxRain/__fxGlass，静态页没有该脚本，用 class 观察器统一兜底。两者均有幂等守卫。 */
  (function () {
    if (!window.MutationObserver) return;
    function resume() {
      if (document.hidden || document.documentElement.classList.contains('fx-off')) return;
      if (typeof window.__fxRain === 'function') window.__fxRain();
      if (typeof window.__fxGlass === 'function') window.__fxGlass();
    }
    new MutationObserver(resume).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  })();

  /* ---------- bfcache：从前进/后退恢复时复位背景层 ---------- */
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    var splashContent = document.querySelector('.splash-content');
    if (splashContent) splashContent.style.pointerEvents = '';
    var slot = document.getElementById('gw-slot');
    if (slot) {
      /* 旧实现只 add('gw-exit') 且无 remove，会让背景层永久 opacity:0；
         这里显式清掉退出态，并重启水波循环（idleNow 依赖该 class 判断是否渲染）。 */
      slot.classList.remove('gw-exit');
      if (typeof window.__fxGlass === 'function') window.__fxGlass();
    }
    if (typeof window.__fxRain === 'function') window.__fxRain();
  });
})();
