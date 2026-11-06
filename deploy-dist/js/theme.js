// =====================================
// WDTV 明暗主题（零依赖，IIFE + window 单例）
// 三态：light | dark | system，存储键 wdtvTheme（localStorage）。
//   - get()      返回存储的三态值（无存储/异常时降级为 'dark'，保持当前默认视觉）
//   - resolved() 返回实际应生效的 light | dark
//   - set(mode)  写入并 apply()
//   - cycle()    light -> dark -> system -> light 循环
//   - apply()    仅切换 <html> 的 dark class、colorScheme 与 data-theme 属性（不引入新 class 体系）
//   - onChange(cb) / dispose() / initialScript()
// 首屏防白闪由 <head> 内联预置脚本（initialScript() 返回的内容）负责；
// 本模块加载时只做一次 apply() 同步，并监听 matchMedia 的 change 事件，
// 除此之外不做任何 DOM 改写。无 document / 无 matchMedia / localStorage 异常
// 时全程安全降级为 dark，绝不抛错。
// =====================================
(function (g) {
    'use strict';

    var KEY = 'wdtvTheme';
    var MODES = ['light', 'dark', 'system'];

    var mqCache;            // undefined 表示尚未探测
    var mqHandler = null;   // { mq, fn, type } 便于 dispose 时解绑
    var listeners = [];

    function getDoc() {
        return (typeof document !== 'undefined' && document) ? document : null;
    }

    function getStore() {
        return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null;
    }

    // 惰性探测 matchMedia；无 matchMedia / 抛错时返回 null（resolved 据此降级 dark）
    function getMQ() {
        if (mqCache !== undefined) return mqCache;
        mqCache = null;
        try {
            if (g && typeof g.matchMedia === 'function') {
                var m = g.matchMedia('(prefers-color-scheme: dark)');
                if (m) mqCache = m;
            }
        } catch (e) { mqCache = null; }
        return mqCache;
    }

    function systemPrefersDark() {
        var mq = getMQ();
        if (!mq) return true; // 无 matchMedia：降级 dark
        try { return !!mq.matches; } catch (e) { return true; }
    }

    function get() {
        try {
            var s = getStore();
            var v = s ? s.getItem(KEY) : null;
            if (MODES.indexOf(v) !== -1) return v;
        } catch (e) { /* localStorage 异常：降级 */ }
        return 'dark';
    }

    function resolved() {
        var m = get();
        if (m === 'light') return 'light';
        if (m === 'dark') return 'dark';
        return systemPrefersDark() ? 'dark' : 'light';
    }

    // 三件事：toggle('dark') + colorScheme + data-theme。
    // data-theme 与 index/player/about 三页 <head> 预绘制脚本保持一致，
    // 否则运行中切换主题后属性会滞后于首屏，按 [data-theme] 写的样式会失效。
    // 无 DOM 时安全 no-op。
    function apply() {
        var isDark = resolved() === 'dark';
        var doc = getDoc();
        if (doc && doc.documentElement) {
            var root = doc.documentElement;
            try {
                if (root.classList && typeof root.classList.toggle === 'function') {
                    root.classList.toggle('dark', isDark);
                }
            } catch (e) { /* 忽略 */ }
            try {
                if (root.style) root.style.colorScheme = isDark ? 'dark' : 'light';
            } catch (e) { /* 忽略 */ }
            try {
                if (typeof root.setAttribute === 'function') {
                    root.setAttribute('data-theme', isDark ? 'dark' : 'light');
                }
            } catch (e) { /* 忽略 */ }
        }
        return isDark ? 'dark' : 'light';
    }

    function notify() {
        var payload = { mode: get(), resolved: resolved() };
        var snapshot = listeners.slice();
        for (var i = 0; i < snapshot.length; i++) {
            try { snapshot[i](payload); } catch (e) { /* 单个订阅者异常不影响其它 */ }
        }
    }

    function set(mode) {
        if (MODES.indexOf(mode) === -1) return get(); // 非法值安全忽略
        try {
            var s = getStore();
            if (s) s.setItem(KEY, mode);
        } catch (e) { /* 存储失败不影响内存态生效 */ }
        apply();
        notify();
        return mode;
    }

    function cycle() {
        var idx = MODES.indexOf(get());
        return set(MODES[(idx + 1) % MODES.length]);
    }

    function onChange(cb) {
        if (typeof cb !== 'function') return function () {};
        listeners.push(cb);
        return function off() {
            var i = listeners.indexOf(cb);
            if (i !== -1) listeners.splice(i, 1);
        };
    }

    // 监听系统主题变化：resolved 随之更新（system 模式下真正生效）
    function bindMQ() {
        if (mqHandler) return;
        var mq = getMQ();
        if (!mq) return;
        var fn = function () { apply(); notify(); };
        try {
            if (typeof mq.addEventListener === 'function') {
                mq.addEventListener('change', fn);
                mqHandler = { mq: mq, fn: fn, type: 'addEventListener' };
            } else if (typeof mq.addListener === 'function') {
                mq.addListener(fn);
                mqHandler = { mq: mq, fn: fn, type: 'addListener' };
            }
        } catch (e) { mqHandler = null; }
    }

    function dispose() {
        if (mqHandler) {
            try {
                if (mqHandler.type === 'addEventListener' && typeof mqHandler.mq.removeEventListener === 'function') {
                    mqHandler.mq.removeEventListener('change', mqHandler.fn);
                } else if (mqHandler.type === 'addListener' && typeof mqHandler.mq.removeListener === 'function') {
                    mqHandler.mq.removeListener(mqHandler.fn);
                }
            } catch (e) { /* 忽略 */ }
            mqHandler = null;
        }
        listeners.length = 0;
    }

    // 供 <head> 内联脚本使用：读 wdtvTheme + matchMedia，立即打 dark class 与 colorScheme。
    // 返回字符串；内容不含 </script>（避免破坏 HTML script 块）。
    function initialScript() {
        return [
            "(function(){try{",
            "var m;try{m=localStorage.getItem('wdtvTheme');}catch(e){}",
            "if(['light','dark','system'].indexOf(m)===-1)m='dark';",
            "var dark=(m==='dark');",
            "if(m==='system'){dark=true;try{if(window.matchMedia&&!window.matchMedia('(prefers-color-scheme: dark)').matches)dark=false;}catch(e){}}",
            "var d=document.documentElement;",
            "d.classList.toggle('dark',dark);",
            "d.style.colorScheme=dark?'dark':'light';",
            "}catch(e){}})();"
        ].join('');
    }

    // 设置面板主题下拉框（index.html 的 #wdtvThemeSelect）。
    // player.html / about.html 没有该控件，静默跳过；Node 自测无 DOM 也不崩。
    function bindSelect() {
        try {
            var doc = g.document;
            if (!doc || typeof doc.getElementById !== 'function') return;
            var attach = function () {
                try {
                    var el = doc.getElementById('wdtvThemeSelect');
                    if (!el) return;
                    el.value = get();
                    if (typeof el.addEventListener === 'function') {
                        el.addEventListener('change', function () {
                            if (el.value) set(el.value);
                        });
                    }
                    onChange(function () {
                        try { el.value = get(); } catch (e) {}
                    });
                } catch (e) {}
            };
            if (doc.readyState === 'loading' && typeof doc.addEventListener === 'function') {
                doc.addEventListener('DOMContentLoaded', attach, { once: true });
            } else {
                attach();
            }
        } catch (e) {}
    }

    // 模块加载：绑定系统主题跟随 + 设置面板控件 + 同步一次当前状态（首屏由预置脚本负责）
    bindMQ();
    bindSelect();
    apply();

    g.WDTVTheme = {
        KEY: KEY,
        MODES: MODES.slice(),
        get: get,
        resolved: resolved,
        set: set,
        cycle: cycle,
        apply: apply,
        onChange: onChange,
        dispose: dispose,
        initialScript: initialScript
    };
})(typeof window !== 'undefined' ? window : globalThis);
