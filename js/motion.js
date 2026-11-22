/* =====================================================================
   WDTV 动效运行时 · 原生样式净化器
   ---------------------------------------------------------------------
   与 css/motion.css 成对使用，5 个页面共用。零依赖、零构建，IIFE +
   双环境导出（浏览器挂 window，Node 测试挂 globalThis），只暴露
   window.WDTVMotion。

   职责边界：只做表现层。不读写业务状态、不发请求、不改数据流。
   唯一的例外是把原生 title / window.confirm 换成项目质感的等价物，
   行为语义保持一一对应。

   性能红线：逐帧只写 transform / opacity；精细指针效果共用单个 rAF，
   静止即自动停表；触屏与 reduced-motion / html.fx-off 下整块不初始化。

   优雅降级：入场用的 .mo-pending 只由本文件添加。本文件若未加载或
   抛错，内容本就完全可见，不会出现永久空白。
   ===================================================================== */
(function (g) {
    'use strict';

    var doc = g.document;
    var root = doc && doc.documentElement;

    var mqFine = g.matchMedia ? g.matchMedia('(hover: hover) and (pointer: fine)') : null;
    var mqReduce = g.matchMedia ? g.matchMedia('(prefers-reduced-motion: reduce)') : null;

    function fine() { return !!(mqFine && mqFine.matches); }
    function still() {
        return !!(mqReduce && mqReduce.matches) || !!(root && root.classList.contains('fx-off'));
    }
    function idle(fn) {
        if (g.requestIdleCallback) g.requestIdleCallback(fn, { timeout: 1200 });
        else setTimeout(fn, 1);
    }
    function ready(fn) {
        if (!doc) return;
        if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', fn, { once: true });
        else fn();
    }
    // ArtPlayer 子树也纳入 title 净化：用户要求全站取消悬浮提示，
    // 因此不再豁免播放器内动态设置的 title。
    function inArt(node) {
        var el = node && (node.nodeType === 1 ? node : node.parentElement);
        return !!(el && el.closest && el.closest('.art-video-player'));
    }

    /* =================================================================
       1. 原生 title 净化器
       删除 title，仅按需补 aria-label（无障碍名兜底）；不产生悬浮提示。
       必须观察 attributes：`el.title = ...` 只改属性、不增删节点，
       childList 观察器捕捉不到（player.js 收藏 chip、watch-party-ui.js 等）。
       ================================================================= */
    function named(el) {
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true;
        if (el.labels && el.labels.length) return true;
        var tag = el.tagName;
        if (tag === 'IMG') return el.hasAttribute('alt');
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
            if (el.getAttribute('placeholder')) return true;
            if (tag === 'INPUT' && /^(hidden|submit|button|reset|image)$/i.test(el.type || '')) return true;
        }
        if ((el.textContent || '').trim()) return true;
        if (el.querySelector('img[alt]:not([alt=""]), [aria-label]')) return true;
        return false;
    }

    function purify(el) {
        if (!el || el.nodeType !== 1) return;
        var raw = el.getAttribute('title');
        if (raw === null) return;
        el.removeAttribute('title');
        var text = raw.trim();
        if (!text) return;
        if (!named(el)) el.setAttribute('aria-label', text);
    }

    function scan(node) {
        var el = node && (node.nodeType === 1 ? node : node.parentElement);
        if (!el) return;
        purify(el);
        var list = el.querySelectorAll('[title]');
        for (var i = 0; i < list.length; i++) purify(list[i]);
    }

    function startPurifier() {
        scan(root);
        if (!g.MutationObserver) return;
        new MutationObserver(function (records) {
            for (var i = 0; i < records.length; i++) {
                var r = records[i];
                if (r.type === 'attributes') { purify(r.target); continue; }
                magnetsDirty = true;
                for (var j = 0; j < r.addedNodes.length; j++) {
                    scan(r.addedNodes[j]);
                    adoptLate(r.addedNodes[j]);
                }
            }
        }).observe(root, {
            subtree: true, childList: true, attributes: true, attributeFilter: ['title']
        });
    }

    /* =================================================================
       2. 入场引擎
       MO(childList) 标记 → 一帧一次合并 → IO 进视口 → WAAPI 交错。
       不 hook 任何渲染函数：项目里有「逐张 append」「fragment 整批」
       「innerHTML 全量重绘 + 拖拽重排」三条互不兼容的渲染路径，
       观察容器是唯一能同时覆盖三者的接法。
       ================================================================= */
    // [容器, 条目, 是否观察深层子树]
    var DYNAMIC = [
        ['#cinema-results', '.douban-card', false],
        ['#douban-results', '.douban-card', false],
        ['#results', '.douban-card', false],
        ['#statsGrid', '.stat-card', false],
        ['#userRows', 'tr', false],
        ['#cardWrap', '.ucard', false],
        ['.wdtv-ep-grid', '.wdtv-ep-btn', true],
        ['.config-panel', '.config-item', false]
    ];
    var STATIC = '.abt-hero, .abt-section, .login-card, #adminView .main-card, .mo-doc .wrap > *';
    var MAX_BATCH = 24;

    var io = null;
    var queue = [];
    var queued = new Set();
    var flushRaf = 0;
    var revealDefer = 0;
    // 已被 IO 观察的元素：观察与「取消观察」必须成对，否则元素会永远收不到相交通知。
    // 搜索结果按关联度重排时用 appendChild 移动既有卡片，会产生「先移除后插入」的
    // 同一批变更；若在移除分支无条件 unobserve，卡片就再也不会被观察，
    // 于是永远停在 .mo-pending（opacity:0）——整片搜索结果看不见。
    var observed = new WeakSet();
    // 兜底看门狗：观察器万一没回调，不能让内容永远停在 opacity:0
    var guardTimer = 0;

    function tokens() {
        var cs = g.getComputedStyle(root);
        return {
            enter: parseFloat(cs.getPropertyValue('--mo-enter')) || 420,
            stagger: parseFloat(cs.getPropertyValue('--mo-stagger')) || 45,
            shift: parseFloat(cs.getPropertyValue('--mo-shift')) || 0,
            scale: parseFloat(cs.getPropertyValue('--mo-scale')) || 1,
            ease: (cs.getPropertyValue('--mo-ease') || 'ease').trim()
        };
    }

    function mark(el) {
        if (!el || el.nodeType !== 1) return;
        if (el.classList.contains('wdtv-skeleton-card') || el.getAttribute('aria-hidden') === 'true') return;
        // 已放行过的元素不再处理；仍在等待中的元素允许重复标记（重排会再次触发观察）
        if (el.dataset.moIn === '2') return;
        el.dataset.moIn = '1';
        if (still() || !io) { el.dataset.moIn = '2'; return; }
        el.classList.add('mo-pending');
        el.dataset.moAt = String(Date.now());
        if (!observed.has(el)) { observed.add(el); io.observe(el); }
        armGuard();
    }

    function show(el) {
        el.classList.remove('mo-pending', 'mo-revealing');
        el.dataset.moIn = '2';
        observed.delete(el);
    }

    // 兜底看门狗：每 1.5s 扫一次待入场元素，只放行「已在视口内且挂了超过 2.5s」的。
    // 正常路径由 IO 在数百毫秒内放行；这里只兜住漏观察 / 观察器未回调的极端情况。
    function armGuard() {
        if (guardTimer) return;
        guardTimer = setTimeout(guardTick, 1500);
    }

    function guardTick() {
        guardTimer = 0;
        var pend = doc.querySelectorAll('.mo-pending');
        if (!pend.length) return;
        var now = Date.now();
        var vh = g.innerHeight || 0, vw = g.innerWidth || 0;
        var rescue = [];
        for (var i = 0; i < pend.length; i++) {
            var el = pend[i];
            if (!el.isConnected) continue;
            var at = parseInt(el.dataset.moAt || '0', 10) || 0;
            if (!at || now - at < 2500) continue;
            var r = el.getBoundingClientRect();
            if (r.width < 2 && r.height < 2) continue;
            if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) {
                // 还没滚进视口：重置计时，避免每轮都白取一次 rect（视口外卡片可能长期待入场）
                el.dataset.moAt = String(now);
                continue;
            }
            rescue.push(el);
        }
        if (rescue.length) {
            rescue.forEach(function (el) {
                io.unobserve(el);
                observed.delete(el);
                queued.delete(el);
                enqueue(el);
            });
            kick();
        }
        if (doc.querySelector('.mo-pending')) armGuard();
    }

    function guarded() {
        // 影院编辑/拖拽期：卡片自身有抖动与 FLIP transform，入场会打架。
        return !!(doc.querySelector('.cinema-edit-mode, .cinema-drag-active, .cinema-dragging'));
    }

    function flush() {
        flushRaf = 0;
        var batch = queue;
        queue = [];
        if (!batch.length) return;
        if (still() || guarded()) { batch.forEach(show); return; }
        // dock 换页动画期间整页在位移，延后一帧再入场
        if (doc.querySelector('.wdtv-pages.no-anim')) {
            if (revealDefer++ < 6) { queue = batch.concat(queue); kick(); return; }
            revealDefer = 0;
        }
        var t = tokens();
        var step = fine() ? 12 : 8;
        batch.forEach(function (el, i) {
            if (!el.isConnected) return;
            el.classList.remove('mo-pending');
            if (i >= MAX_BATCH) { show(el); return; }
            el.classList.add('mo-revealing');
            el.dataset.moIn = '2';
            var anim = el.animate([
                { opacity: 0, transform: 'translateY(' + t.shift + 'px) scale(' + t.scale + ')' },
                { opacity: 1, transform: 'none' }
            ], {
                duration: t.enter,
                delay: (i % step) * t.stagger,
                easing: t.ease,
                fill: 'backwards'
            });
            anim.onfinish = function () { el.classList.remove('mo-revealing'); };
            anim.oncancel = function () { el.classList.remove('mo-revealing'); };
        });
    }

    function kick() {
        if (!flushRaf) flushRaf = g.requestAnimationFrame(flush);
    }

    function enqueue(el) {
        if (queued.has(el)) return;
        queued.add(el);
        queue.push(el);
    }

    function attach(pair) {
        var box = doc.querySelector(pair[0]);
        if (!box || box.dataset.moWatch) return false;
        box.dataset.moWatch = '1';
        box.querySelectorAll(pair[1]).forEach(mark);
        if (!g.MutationObserver) return true;
        new MutationObserver(function (records) {
            for (var i = 0; i < records.length; i++) {
                var r = records[i];
                for (var j = 0; j < r.removedNodes.length; j++) {
                    var gone = r.removedNodes[j];
                    if (gone.nodeType !== 1) continue;
                    queued.delete(gone);
                    // 只有真正脱离文档才取消观察。appendChild 移动既有卡片会产生
                    // 「先移除后插入」的同一批变更，节点此时已重新连上文档——
                    // 若此时 unobserve，它就再也不会收到相交通知，卡片永远停在
                    // .mo-pending（opacity:0），整片结果看不见。
                    if (!gone.isConnected) {
                        io.unobserve(gone);
                        observed.delete(gone);
                    }
                }
                for (var k = 0; k < r.addedNodes.length; k++) {
                    var node = r.addedNodes[k];
                    if (node.nodeType !== 1) continue;
                    if (node.matches(pair[1])) mark(node);
                    if (pair[2]) node.querySelectorAll(pair[1]).forEach(mark);
                }
            }
        }).observe(box, { childList: true, subtree: pair[2] });
        return true;
    }

    // 剧集网格等容器由业务脚本后建，boot 时还不存在；由净化器的同一个
    // document 级观察器顺带认领，避免再挂一个全文档 childList 观察器。
    var late = [];
    function adoptLate(node) {
        if (!late.length || !node || node.nodeType !== 1) return;
        for (var i = late.length - 1; i >= 0; i--) {
            var sel = late[i][0];
            if (node.matches(sel) || (node.firstElementChild && node.querySelector(sel))) {
                if (attach(late[i])) late.splice(i, 1);
            }
        }
    }

    function startReveal() {
        if (!g.IntersectionObserver || !Element.prototype.animate) return;
        io = new IntersectionObserver(function (entries) {
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i];
                if (!e.isIntersecting) continue;
                io.unobserve(e.target);
                observed.delete(e.target);
                queued.delete(e.target);
                enqueue(e.target);
            }
            if (queue.length) kick();
        }, { rootMargin: '0px 0px -8% 0px', threshold: 0.01 });

        DYNAMIC.forEach(function (pair) { if (!attach(pair)) late.push(pair); });
        doc.querySelectorAll(STATIC).forEach(mark);
    }

    /* =================================================================
       3. 精细指针效果：聚光 / 磁性 / 视差
       共用单个 rAF，静止即停表。触屏 / reduced-motion / fx-off 不初始化。
       ================================================================= */
    var px = 0, py = 0, pointerIn = false;
    var spot = null;                 // { card, layer, x, y, rect }
    // 全站控件与文本的磁性名单：与首页历史/账号按钮同一手感（reach 72+半径、最大 6px、lerp .2）。
    // 组容器（设置行 / 自动连播 / 分段切换）整体摆，内部控件不再单独摆。
    // 搜索框与每条搜索记录各自独立摆动：横滚标签条只负责滚动，不整条摆；
    // 其上下/左右留白由样式层扩大裁切边界，位移再由 lim 夹取，单个标签也不会被切掉。
    // 标题、slogan、段落、列表行、表格行、聊天气泡与各种叶子文本同手感跟随。
    var MAGNET_SEL = 'button, [role="button"], [role="tab"], [role="switch"], select, summary,' +
        ' input[type="checkbox"], input[type="radio"], input[type="range"], a[href],' +
        ' .wdtv-settings-row, .ep-autoplay, .wdtv-search-glass, .wdtv-douban-toggle,' +
        ' .wdtv-toggle, .switch, label:has(> input[type="checkbox"]), label:has(> input[type="radio"]), label,' +
        ' .douban-card, .wdtv-ep-btn, .stat-card, .side-item, .view-tab, .page-btn, .ucard, .avatar-thumb,' +
        ' .wdtv-history-card, .wdtv-cinema-empty-card,' +
        // 共看房间信息区：成员头像（含内嵌 svg，span:has(*) 匹配不到）与在线状态点
        // 空 span 也匹配不到通用叶子文本规则，需显式入名单才会跟随鼠标磁力摆动。
        ' .wp-avatar, .wp-mavatar, .wp-dot,' +
        ' h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, dt, dd, tr, td, th, .wp-bubble,' +
        ' span:not(:empty):not(:has(*)), strong, b, em, i, small, code,' +
        ' div:not(:empty):not(:has(*))';
    // 加载层 / toast / 提示层自己的 transform 由各自脚本管理，磁性不介入。
    // 播放器整棵子树默认同样豁免：弹幕逐帧增删、进度条与浮层由 ArtPlayer 自己驱动 transform。
    // 只放行控制栏按钮 .art-control：纯 flex 行列，player.css 只过渡 color/opacity、
    // 不写 transform，与磁性位移互不覆盖。
    var MAGNET_SKIP = '#preloader, #toast';
    // 播放器内放行名单：
    //  - .art-control 控制条按钮（剔除 .art-control-progress / -thumbnails，进度条由 ArtPlayer 自绘）
    //  - 右上角工具组、左右侧锁定/解锁/截图按钮
    //  - 二级面板条目：倍速/选集/缓存/下载/弹幕/截图、原生设置、右键菜单、跳片头尾
    // 面板容器本身不入名单：入场动画会写 transform，只让条目各自独立摆。
    var ART_ALLOW = '.art-control:not(.art-control-progress):not(.art-control-thumbnails),' +
        ' .wdtv-dm-topbtn, .wdtv-lock-btn, .wdtv-unlock-btn, .wdtv-photo-btn,' +
        ' .art-speed-item, .art-setting-item, .art-selector-item, .art-contextmenu, .art-info-close,' +
        ' .cache-btn, .wdtv-danmu-btn, .wdtv-danmu-item, .wdtv-danmu-back,' +
        ' .wdtv-dl-panel-btn, .wdtv-dl-pchip,' +
        ' .wdtv-skip-menu__row, .wdtv-skip-menu__field, .wdtv-skip-menu__save,' +
        // 弹幕文本：插件用内联 transform + transition 做横向飞行，磁性改用独立的
        // translate 属性叠加，绝不能写 transform（会打断弹幕自身的位移）。
        ' .art-danmuku [data-mode]';
    var MAGNET_MAX = 4;
    var magnets = [];                // { el, rect, lim, clip, x, y, hold }
    var magnetsDirty = true, lastBuild = 0, lastMeasure = 0;
    var glow = null, gx = 0, gy = 0;
    var fxRaf = 0, rectsDirty = true;
    var fxStarted = false;

    function magnetOk(el) {
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        if (inArt(el) && !el.closest(ART_ALLOW)) return false;
        if (el.isContentEditable) return false;
        if (el.closest(MAGNET_SKIP)) return false;
        var tag = el.tagName;
        if (tag === 'TEXTAREA') return false;
        if (tag === 'INPUT') {
            var ty = (el.type || 'text').toLowerCase();
            // 文本录入框不摆：光标落点与选区不能跟着指针晃
            if (ty !== 'checkbox' && ty !== 'radio' && ty !== 'range' &&
                ty !== 'button' && ty !== 'submit' && ty !== 'reset') return false;
        }
        return true;
    }

    // 归零/退场统一清理：普通元素写 transform，弹幕写独立的 translate。
    // 弹幕的 style.transform 是插件自己的飞行位移，只能清 translate，清 transform 会把弹幕钉住。
    function clearShift(el) {
        el.style.translate = '';
        if (el.closest && el.closest('.art-danmuku')) return;
        el.style.transform = '';
    }

    function buildMagnets() {
        magnetsDirty = false;
        lastBuild = Date.now();
        var byEl = new Map();
        magnets.forEach(function (m) { byEl.set(m.el, m); });
        var keep = [], keptEls = new Set();
        // 裁切祖先：overflow 非 visible 的最近祖先（滚动容器 / 溢出隐藏框）。
        // 按节点 memo，兄弟子树共享同一条祖先链，避免重复 getComputedStyle。
        var clipCache = new Map();
        function clipOf(node) {
            if (!node || node === doc.body || node === doc.documentElement) return null;
            if (clipCache.has(node)) return clipCache.get(node);
            var s = g.getComputedStyle(node);
            var out = (s.overflowX !== 'visible' || s.overflowY !== 'visible') ? node : clipOf(node.parentElement);
            clipCache.set(node, out);
            return out;
        }
        // 播放器控制条按钮不在 MAGNET_SEL 内（该名单以站点控件/文本为主），单独并入；
        // 文档序保证 .art-control 先于其内部叶子文本入名单，嵌套去重会跳过子节点。
        // ART_ALLOW 每项都限定在播放器子树内：页面上同名的类不会因此被误收。
        var artQuery = ART_ALLOW.split(',').map(function (s) {
            return '.art-video-player ' + s.trim();
        }).join(', ');
        var list = doc.querySelectorAll(MAGNET_SEL + ', ' + artQuery);
        for (var i = 0; i < list.length; i++) {
            var el = list[i];
            if (!magnetOk(el)) continue;
            // 弹幕逐帧改 transform，磁性位移改写到独立的 translate 属性上（见 fxTick）
            var sep = !!el.closest('.art-danmuku');
            // querySelectorAll 按文档序：祖先先入名单。祖先已是磁性单元时，
            // 内部控件/文本随整体摆，不叠第二层位移（开关跟着设置行一起摆）。
            var p = el.parentElement, nested = false;
            while (p && p !== doc.body) { if (keptEls.has(p)) { nested = true; break; } p = p.parentElement; }
            if (nested) continue;
            var m = byEl.get(el);
            if (!m) m = { el: el, rect: null, lim: null, clip: null, x: 0, y: 0, hold: false, sep: false };
            m.sep = sep;
            m.clip = clipOf(el.parentElement);
            keep.push(m);
            keptEls.add(el);
        }
        var keepSet = new Set(keep);
        magnets.forEach(function (m) {
            if (!keepSet.has(m)) {
                clearShift(m.el);
                m.el.removeAttribute('data-mo-magnet');
            }
        });
        magnets = keep;
        rectsDirty = true;
    }

    function measure() {
        rectsDirty = false;
        lastMeasure = Date.now();
        var clipRects = new Map();
        var spotDone = false;
        for (var i = 0; i < magnets.length; i++) {
            var m = magnets[i];
            if (!m.el.isConnected) { m.rect = null; m.lim = null; continue; }
            var r = m.el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) { m.rect = null; m.lim = null; continue; }
            // 扣掉自身已施加的位移，缓存「未变换」基准 rect，避免反馈自激
            m.rect = { left: r.left - m.x, top: r.top - m.y, width: r.width, height: r.height };
            // 裁切余量：位移夹在裁切框内，摆到边缘也不被切掉
            if (m.clip && m.clip.isConnected) {
                if (!clipRects.has(m.clip)) clipRects.set(m.clip, m.clip.getBoundingClientRect());
                var c = clipRects.get(m.clip);
                m.lim = {
                    l: Math.max(0, m.rect.left - c.left),
                    r: Math.max(0, c.right - m.rect.left - m.rect.width),
                    t: Math.max(0, m.rect.top - c.top),
                    b: Math.max(0, c.bottom - m.rect.top - m.rect.height)
                };
            } else m.lim = null;
            if (spot && spot.card === m.el) { spot.rect = m.rect; spotDone = true; }
        }
        if (spot && !spotDone) spot.rect = spot.card.getBoundingClientRect();
    }

    function fxTick() {
        fxRaf = 0;
        if (still() || !fine() || doc.hidden) { rest(); return; }
        // 面板开合只改 class、不增删节点：慢速兜底重建，保证新露出的控件入名单
        if (pointerIn && Date.now() - lastBuild > 200 &&
            (magnetsDirty || Date.now() - lastBuild > 1200)) buildMagnets();
        // 面板滑入 / dock 换页等不产生 scroll 的位移也会让 rect 过期：慢心跳兜底重测
        if (pointerIn && Date.now() - lastMeasure > 400) rectsDirty = true;
        if (rectsDirty) measure();
        var busy = false;

        if (spot) {
            var tx = px - spot.rect.left, ty = py - spot.rect.top;
            spot.x += (tx - spot.x) * 0.18;
            spot.y += (ty - spot.y) * 0.18;
            spot.layer.style.transform = 'translate3d(' + spot.x.toFixed(1) + 'px,' + spot.y.toFixed(1) + 'px,0)';
            if (Math.abs(tx - spot.x) > 0.4 || Math.abs(ty - spot.y) > 0.4) busy = true;
        }

        // 候选：reach 内、未按住、未展开菜单；再按距离取最近 MAGNET_MAX 个
        var cand = [];
        if (pointerIn && !guarded()) {
            for (var i = 0; i < magnets.length; i++) {
                var m = magnets[i];
                if (!m.rect || m.hold || m.el.getAttribute('aria-expanded') === 'true') continue;
                // 入场动画进行中整棵子树豁免，避免与 WAAPI 的 transform 打架
                if (m.el.closest('.mo-pending, .mo-revealing')) continue;
                // 弹幕在飞：缓存 rect 400ms 就会落后几十像素，逐帧取实时位置
                if (m.sep) {
                    var rr = m.el.getBoundingClientRect();
                    m.rect = { left: rr.left - m.x, top: rr.top - m.y, width: rr.width, height: rr.height };
                }
                var cx = m.rect.left + m.rect.width / 2, cy = m.rect.top + m.rect.height / 2;
                var dx = px - cx, dy = py - cy;
                var dist = Math.sqrt(dx * dx + dy * dy);
                // 尺寸补偿封顶：横滚标签条 / 宽标题这类超宽组容器，不封顶会让整条在全屏范围内持续吸附
                var reach = 72 + Math.min(180, Math.max(m.rect.width, m.rect.height) / 2);
                if (dist < reach && dist > 0.01) cand.push({ m: m, d: dist, dx: dx, dy: dy, reach: reach });
            }
            cand.sort(function (a, b) { return a.d - b.d; });
            // 遮挡判定：中心命中的必须是自己或子孙，否则正被浮层/面板/吸顶栏盖住。
            // 用「当前视觉中心」命中，避免位移后命中落空造成激活抖动。
            // 先判定再截断：最近 4 个若全被浮层盖住，名额顺延给第 5、6 个，
            // 否则播放器左侧锁定钮这类被装饰层包围的控件永远轮不到。
            // 命中测试最多 24 次，避免大网格页逐帧上百次 elementFromPoint。
            var kept = [], tested = 0;
            for (var c = 0; c < cand.length && kept.length < MAGNET_MAX && tested < 24; c++) {
                var cm = cand[c].m;
                var ccs = g.getComputedStyle(cm.el);
                if (ccs.pointerEvents === 'none') {
                    // 弹幕文本不可交互也没有命中可言，但它就是要跟随的正文：
                    // 只要当前可见（排除插件池里 visibility:hidden 的复用节点）就收下。
                    if (cm.el.closest('.art-danmuku')) {
                        if (ccs.visibility !== 'hidden') kept.push(cand[c]);
                        continue;
                    }
                    // 播放器内其余装饰层（字幕/遮罩）不占名额：它们本就不可交互，
                    // 又会因下面的「跳过命中」挤掉真正的按钮。
                    if (cm.el.closest('.art-video-player')) continue;
                    // 首页标题/slogan 等装饰文本位于 pointer-events:none 的容器里，
                    // 命中测试永远打不中它们；这类元素没有交互语义，跳过遮挡判定。
                    // 隐藏页（visibility:hidden）仍走命中测试。
                    if (ccs.visibility !== 'hidden') { kept.push(cand[c]); continue; }
                }
                tested++;
                var hit = doc.elementFromPoint(cm.rect.left + cm.rect.width / 2 + cm.x, cm.rect.top + cm.rect.height / 2 + cm.y);
                if (hit && (hit === cm.el || cm.el.contains(hit))) kept.push(cand[c]);
            }
            cand = kept;
        }

        for (var k = 0; k < magnets.length; k++) {
            var mg = magnets[k];
            if (!mg.el.isConnected) continue;
            var mx = 0, my = 0;
            for (var n = 0; n < cand.length; n++) {
                if (cand[n].m === mg) {
                    var pull = (1 - cand[n].d / cand[n].reach) * 6;
                    mx = cand[n].dx / cand[n].d * pull;
                    my = cand[n].dy / cand[n].d * pull;
                    // 裁切余量：位移夹在最近裁切祖先内（滚动条 / overflow:hidden 框），
                    // 贴边的元素宁可少摆，也不摆出裁切边界被切掉。
                    if (cand[n].m.lim) {
                        var lm = cand[n].m.lim;
                        mx = Math.max(-lm.l, Math.min(lm.r, mx));
                        my = Math.max(-lm.t, Math.min(lm.b, my));
                    }
                    break;
                }
            }
            mg.x += (mx - mg.x) * 0.2;
            mg.y += (my - mg.y) * 0.2;
            if (Math.abs(mx - mg.x) > 0.05 || Math.abs(my - mg.y) > 0.05) busy = true;
            else { mg.x = mx; mg.y = my; }
            if (mg.x || mg.y) {
                if (mg.sep) {
                    // 独立的 translate 与插件的 transform: translateX(飞行) 叠加生效
                    mg.el.style.translate = mg.x.toFixed(2) + 'px ' + mg.y.toFixed(2) + 'px';
                } else {
                    mg.el.style.transform = 'translate3d(' + mg.x.toFixed(2) + 'px,' + mg.y.toFixed(2) + 'px,0)';
                }
                if (!mg.el.hasAttribute('data-mo-magnet')) mg.el.setAttribute('data-mo-magnet', '');
            } else if (mg.el.hasAttribute('data-mo-magnet')) {
                // 归零即摘掉内联位移与 will-change，把 :active 按压让回 CSS
                clearShift(mg.el);
                mg.el.removeAttribute('data-mo-magnet');
            }
        }

        if (glow) {
            var want = pointerIn && !modalOpen();
            var wx = want ? (px / g.innerWidth - 0.5) * 12 : 0;
            var wy = want ? (py / g.innerHeight - 0.5) * 12 : 0;
            gx += (wx - gx) * 0.06;
            gy += (wy - gy) * 0.06;
            if (Math.abs(wx - gx) > 0.05 || Math.abs(wy - gy) > 0.05) busy = true;
            else { gx = wx; gy = wy; }
            glow.style.transform = (gx || gy) ? 'translate3d(' + gx.toFixed(2) + 'px,' + gy.toFixed(2) + 'px,0)' : '';
        }

        if (busy) fxRaf = g.requestAnimationFrame(fxTick);
    }

    function fxKick() {
        if (!fxRaf && !still()) fxRaf = g.requestAnimationFrame(fxTick);
    }

    function rest() {
        if (spot) { spot.card.classList.remove('mo-spot-on'); spot = null; }
        magnets.forEach(function (m) {
            m.x = m.y = 0;
            clearShift(m.el);
            m.el.removeAttribute('data-mo-magnet');
        });
        gx = gy = 0;
        if (glow) glow.style.transform = '';
    }

    function modalOpen() {
        return !!doc.querySelector('.wdtv-modal.show, .wdtv-modal-mask.show, .episodes-modal.show, .mo-confirm-scrim, .wp-panel.open');
    }

    function dropSpot() {
        if (!spot) return;
        spot.card.classList.remove('mo-spot-on');
        spot = null;
    }

    function startPointerFX() {
        if (!fine()) return;

        buildMagnets();
        glow = doc.querySelector('.splash-glow');

        doc.addEventListener('pointermove', function (e) {
            if (e.pointerType && e.pointerType !== 'mouse') return;
            px = e.clientX; py = e.clientY; pointerIn = true;
            fxKick();
        }, { passive: true });

        doc.addEventListener('pointerover', function (e) {
            if (e.pointerType && e.pointerType !== 'mouse') return;
            if (still() || guarded() || modalOpen()) { dropSpot(); return; }
            var card = e.target.closest && e.target.closest('.douban-card');
            if (!card || card.classList.contains('wdtv-skeleton-card')) { dropSpot(); return; }
            if (spot && spot.card === card) return;
            dropSpot();
            var layer = card.querySelector('.mo-spot');
            if (!layer) {
                layer = doc.createElement('div');
                layer.className = 'mo-spot';
                card.appendChild(layer);
            }
            var rect = card.getBoundingClientRect();
            spot = { card: card, layer: layer, rect: rect, x: e.clientX - rect.left, y: e.clientY - rect.top };
            layer.style.transform = 'translate3d(' + spot.x + 'px,' + spot.y + 'px,0)';
            card.classList.add('mo-spot-on');
            fxKick();
        }, { passive: true });

        doc.addEventListener('pointerout', function (e) {
            if (!spot) return;
            var to = e.relatedTarget;
            if (to && spot.card.contains(to)) return;
            dropSpot();
            fxKick();
        }, { passive: true });

        doc.addEventListener('pointerdown', function (e) {
            magnets.forEach(function (m) {
                m.hold = m.el.contains(e.target);
                if (m.hold) { m.x = m.y = 0; clearShift(m.el); m.el.removeAttribute('data-mo-magnet'); }
            });
            dropSpot();
        }, { passive: true, capture: true });
        doc.addEventListener('pointerup', function () {
            magnets.forEach(function (m) { m.hold = false; });
            fxKick();
        }, { passive: true, capture: true });
        doc.addEventListener('pointercancel', function () {
            magnets.forEach(function (m) { m.hold = false; });
        }, { passive: true });
        doc.addEventListener('pointerleave', function () { pointerIn = false; dropSpot(); fxKick(); }, { passive: true });

        g.addEventListener('scroll', function () { rectsDirty = true; dropSpot(); fxKick(); }, { passive: true, capture: true });
        g.addEventListener('resize', function () { rectsDirty = true; fxKick(); }, { passive: true });
        doc.addEventListener('transitionend', function () { rectsDirty = true; fxKick(); }, { passive: true, capture: true });
        doc.addEventListener('visibilitychange', function () {
            if (doc.hidden) { if (fxRaf) { g.cancelAnimationFrame(fxRaf); fxRaf = 0; } rest(); }
            else { rectsDirty = true; fxKick(); }
        });
        if (mqReduce && mqReduce.addEventListener) mqReduce.addEventListener('change', function () { if (still()) rest(); });
    }

    /* =================================================================
       4. 文档页：阅读进度 + 方向感知顶栏
       滚动只写 transform；scrollHeight 由 ResizeObserver 缓存。
       ================================================================= */
    function startDoc() {
        if (!doc.body.classList.contains('mo-doc')) return;
        var bar = doc.createElement('div');
        bar.className = 'mo-progress';
        bar.setAttribute('aria-hidden', 'true');
        doc.body.appendChild(bar);

        var topbar = doc.querySelector('.abt-topbar');
        var span = 1, last = 0, hidden = false, raf = 0;

        // about.html 的滚动发生在 #splash 内的 .splash-content（height:100%;overflow-y:auto），
        // window 永远不滚动；analysis.html 才是文档滚动。取真正在滚的那个容器。
        var inner = doc.querySelector('.splash-content');
        var host = null;
        function measureSpan() {
            host = (inner && inner.scrollHeight - inner.clientHeight > 8) ? inner : null;
            span = host
                ? Math.max(1, host.scrollHeight - host.clientHeight)
                : Math.max(1, (doc.documentElement.scrollHeight || 0) - g.innerHeight);
        }
        function paint() {
            raf = 0;
            var y = host ? host.scrollTop : (g.scrollY || doc.documentElement.scrollTop || 0);
            bar.style.transform = 'scaleX(' + Math.min(1, Math.max(0, y / span)).toFixed(4) + ')';
            if (topbar) {
                var down = y > last + 12, up = y < last - 12;
                if (y < 80) { if (hidden) { hidden = false; topbar.classList.remove('mo-bar-hidden'); } }
                else if (down && !hidden) { hidden = true; topbar.classList.add('mo-bar-hidden'); }
                else if (up && hidden) { hidden = false; topbar.classList.remove('mo-bar-hidden'); }
            }
            last = y;
        }
        measureSpan();
        paint();
        function onScroll() { if (!raf) raf = g.requestAnimationFrame(paint); }
        g.addEventListener('scroll', onScroll, { passive: true });
        if (inner) inner.addEventListener('scroll', onScroll, { passive: true });
        g.addEventListener('resize', function () { measureSpan(); onScroll(); }, { passive: true });
        if (g.ResizeObserver) {
            var ro = new ResizeObserver(function () { measureSpan(); });
            ro.observe(doc.body);
            if (inner) ro.observe(inner);
        }
    }

    /* =================================================================
       6. 微交互：收藏心弹簧 / 一次性流光
       ================================================================= */
    function pop(el) {
        if (!el || still() || !el.animate) return;
        el.animate([
            { transform: 'scale(1)' },
            { transform: 'scale(1.22)', offset: 0.42 },
            { transform: 'scale(0.96)', offset: 0.72 },
            { transform: 'scale(1)' }
        ], { duration: fine() ? 320 : 220, easing: 'cubic-bezier(0.3,1.2,0.35,1)' });
    }

    function startMicro() {
        doc.addEventListener('click', function (e) {
            var chip = e.target.closest && e.target.closest('.wdtv-cinema-fav-chip');
            if (!chip) return;
            var heart = chip.querySelector('svg');
            if (heart) { heart.classList.add('mo-heart'); pop(heart); }
        }, { passive: true });

        var glass = doc.querySelector('.wdtv-search-glass');
        if (!glass || still()) return;
        var seen = false;
        try { seen = g.sessionStorage.getItem('wdtvSheen') === '1'; } catch (err) { seen = false; }
        if (seen) return;
        var sheen = doc.createElement('div');
        sheen.className = 'mo-sheen';
        sheen.setAttribute('aria-hidden', 'true');
        glass.appendChild(sheen);
        setTimeout(function () {
            if (still()) { sheen.remove(); return; }
            sheen.classList.add('mo-sheen-run');
            try { g.sessionStorage.setItem('wdtvSheen', '1'); } catch (err) { /* 隐私模式忽略 */ }
            setTimeout(function () { sheen.remove(); }, 1100);
        }, 900);
    }

    /* =================================================================
       7. 里程滚数（wd 统计卡）
       每位一列 0–9，只 translateY —— 不用 textContent 计数，避开重排。
       真值留在 visually-hidden 的 .mo-sr 里，读屏与复制都拿到原数字。
       ================================================================= */
    function reelOf(host) {
        var reel = host.querySelector('.mo-reel');
        if (reel) return reel;
        var sr = doc.createElement('span');
        sr.className = 'mo-sr';
        reel = doc.createElement('span');
        reel.className = 'mo-reel';
        reel.setAttribute('aria-hidden', 'true');
        host.textContent = '';
        host.appendChild(sr);
        host.appendChild(reel);
        return reel;
    }

    function setReel(host, value) {
        if (!host) return;
        var text = String(value == null ? '' : value).trim();
        var sr = host.querySelector('.mo-sr');
        if (still() || !/^\d[\d,\s]*$/.test(text)) {
            // 只在真的变了才写：textContent 赋值即便同值也会替换节点，
            // 会再次触发观察器，形成自激循环。
            if (host.childNodes.length !== 1 || !host.firstChild || host.firstChild.nodeType !== 3 || host.firstChild.data !== text) {
                host.textContent = text;
            }
            return;
        }
        var reel = reelOf(host);
        sr = host.querySelector('.mo-sr');
        if (sr) sr.textContent = text;
        var chars = text.split('');
        if (reel.childElementCount !== chars.length) {
            reel.textContent = '';
            chars.forEach(function (ch) {
                if (!/\d/.test(ch)) {
                    var sep = doc.createElement('span');
                    sep.className = 'mo-reel-sep';
                    sep.textContent = ch;
                    reel.appendChild(sep);
                    return;
                }
                var d = doc.createElement('span');
                d.className = 'mo-reel-d';
                var col = doc.createElement('span');
                col.className = 'mo-reel-col';
                for (var n = 0; n < 10; n++) {
                    var s = doc.createElement('span');
                    s.textContent = String(n);
                    col.appendChild(s);
                }
                d.appendChild(col);
                reel.appendChild(d);
            });
        }
        var dur = fine() ? 600 : 420;
        var digit = 0;
        chars.forEach(function (ch, i) {
            var slot = reel.children[i];
            if (!slot || !/\d/.test(ch)) return;
            var col = slot.firstChild;
            var delay = (digit++) * 60;
            col.style.transition = 'transform ' + dur + 'ms cubic-bezier(0.32,0.72,0.24,1) ' + delay + 'ms';
            g.requestAnimationFrame(function () {
                col.style.transform = 'translateY(-' + ch + 'em)';
            });
        });
    }

    function reelText(host) {
        var sr = host.querySelector('.mo-sr');
        return (sr ? sr.textContent : host.textContent).trim();
    }

    function startReels() {
        var hosts = doc.querySelectorAll('.stat-value');
        if (!hosts.length || !g.MutationObserver) return;
        hosts.forEach(function (host) {
            host.dataset.moRaw = reelText(host);
            new MutationObserver(function () {
                var now = reelText(host);
                // 卷轴自身的 DOM 写入不算数据变化：真值始终等于 moRaw
                if (now === host.dataset.moRaw) return;
                host.dataset.moRaw = now;
                setReel(host, now);
            }).observe(host, { childList: true, characterData: true, subtree: true });
            if (host.dataset.moRaw && host.dataset.moRaw !== '-') setReel(host, host.dataset.moRaw);
        });
    }

    /* =================================================================
       8. 项目质感确认框（替代唯一一处 window.confirm）
       Promise<boolean>，语义与原生一一对应；Esc / 点遮罩 = 取消。
       ================================================================= */
    var ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11"/></svg>';
    var ICON_NO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

    function confirmDialog(message, opts) {
        if (!doc) return Promise.resolve(false);
        var danger = !!(opts && opts.danger);
        return new Promise(function (resolve) {
            var back = doc.activeElement;
            var scrim = doc.createElement('div');
            scrim.className = 'mo-confirm-scrim';
            var box = doc.createElement('div');
            box.className = 'mo-confirm-box';
            box.setAttribute('role', 'alertdialog');
            box.setAttribute('aria-modal', 'true');
            var p = doc.createElement('div');
            p.textContent = message;
            box.appendChild(p);
            var actions = doc.createElement('div');
            actions.className = 'mo-confirm-actions';
            var no = doc.createElement('button');
            no.type = 'button';
            no.className = 'mo-confirm-btn';
            no.setAttribute('aria-label', '取消');
            no.innerHTML = ICON_NO;
            var yes = doc.createElement('button');
            yes.type = 'button';
            yes.className = 'mo-confirm-btn mo-primary' + (danger ? ' mo-danger' : '');
            yes.setAttribute('aria-label', '确定');
            yes.innerHTML = ICON_OK;
            actions.appendChild(no);
            actions.appendChild(yes);
            box.appendChild(actions);
            scrim.appendChild(box);
            doc.body.appendChild(scrim);
            g.requestAnimationFrame(function () { scrim.classList.add('mo-on'); });
            yes.focus();

            function done(v) {
                doc.removeEventListener('keydown', onKey, true);
                scrim.classList.remove('mo-on');
                setTimeout(function () { scrim.remove(); }, still() ? 0 : 220);
                if (back && back.focus) try { back.focus(); } catch (err) { /* 节点可能已移除 */ }
                resolve(v);
            }
            function onKey(e) {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
                else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
                else if (e.key === 'Tab') {
                    e.preventDefault();
                    (doc.activeElement === yes ? no : yes).focus();
                }
            }
            doc.addEventListener('keydown', onKey, true);
            no.addEventListener('click', function () { done(false); });
            yes.addEventListener('click', function () { done(true); });
            scrim.addEventListener('click', function (e) { if (e.target === scrim) done(false); });
        });
    }

    /* =================================================================
       9. 氛围颗粒：静态贴图，零逐帧成本
       有 #splash 时插进背景层（辉光之上、内容之下），否则插进 body。
       不用 body::after —— watch-party.css 已占用该伪元素。
       ================================================================= */
    function startGrain() {
        if (doc.querySelector('.mo-grain')) return;
        var layer = doc.createElement('div');
        layer.className = 'mo-grain';
        layer.setAttribute('aria-hidden', 'true');
        var host = doc.getElementById('splash') || doc.body;
        host.appendChild(layer);
    }

    /* =================================================================
       启动
       ================================================================= */
    function boot() {
        try {
            startReveal();
            startDoc();
            startMicro();
            startGrain();
            idle(function () {
                try {
                    startPointerFX();
                    startReels();
                } catch (err) { releaseAll(); }
            });
        } catch (err) {
            releaseAll();
        }
    }

    // 任何一步失败都不能把内容留在 opacity:0
    function releaseAll() {
        if (!doc) return;
        doc.querySelectorAll('.mo-pending').forEach(function (el) {
            el.classList.remove('mo-pending', 'mo-revealing');
        });
        doc.querySelectorAll('[data-mo-magnet]').forEach(function (el) {
            clearShift(el);
            el.removeAttribute('data-mo-magnet');
        });
    }

    if (doc) {
        startPurifier();
        ready(boot);
        g.addEventListener('pagehide', function () {
            if (fxRaf) g.cancelAnimationFrame(fxRaf);
            if (flushRaf) g.cancelAnimationFrame(flushRaf);
        });
    }

    g.WDTVMotion = {
        version: 1,
        purify: scan,
        pop: pop,
        reel: setReel,
        confirm: confirmDialog,
        releaseAll: releaseAll,
        fine: fine,
        still: still
    };
})(typeof window !== 'undefined' ? window : globalThis);