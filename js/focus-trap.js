// =====================================
// WDTV 焦点陷阱（零依赖，IIFE + window 单例）
// 参考 LibreTV src/components/use-focus-trap.ts 的 FOCUSABLE 选择器与循环策略。
// create(container) 返回 { activate(), deactivate() }：
//   - activate：记忆 document.activeElement，focus 容器内首个可见可聚焦元素
//   - Tab / Shift+Tab 在容器内循环；不可见元素用 getClientRects().length > 0 过滤
//   - Esc 不在此处理（由调用方决定）；keydown 监听用 capture，deactivate 时移除
//   - deactivate：归还焦点到打开前的元素
// 无 document 环境（如 Node 自测）下所有方法安全 no-op，不抛错。
// =====================================
(function (g) {
    'use strict';

    // LibreTV / focus-trap 通用可聚焦选择器
    var FOCUSABLE = [
        'a[href]',
        'area[href]',
        'input:not([disabled]):not([type="hidden"])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        'button:not([disabled])',
        'iframe',
        'object',
        'embed',
        'audio[controls]',
        'video[controls]',
        'summary',
        '[contenteditable]:not([contenteditable="false"])',
        '[tabindex]:not([tabindex="-1"])'
    ].join(', ');

    function toEl(c) {
        if (!c) return null;
        if (typeof c === 'string') {
            return (typeof document !== 'undefined' && document.querySelector)
                ? document.querySelector(c) : null;
        }
        return c;
    }

    // 容器内可见且可聚焦的元素列表
    function focusable(container) {
        if (!container || typeof container.querySelectorAll !== 'function') return [];
        var nodes = container.querySelectorAll(FOCUSABLE);
        var out = [];
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            if (el.disabled) continue;
            if (el.getAttribute && el.getAttribute('tabindex') === '-1') continue;
            // 不可见元素（display:none / 尺寸为 0）不参与循环
            if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) continue;
            out.push(el);
        }
        return out;
    }

    function create(container) {
        var root = toEl(container);
        var doc = (typeof document !== 'undefined') ? document : null;
        var previous = null;
        var active = false;

        function onKeydown(e) {
            if (!active || !root || !doc || !e || e.key !== 'Tab') return;
            var list = focusable(root);
            if (list.length === 0) {
                e.preventDefault();
                return;
            }
            var first = list[0];
            var last = list[list.length - 1];
            var cur = doc.activeElement;
            var inside = !!(cur && typeof root.contains === 'function' && root.contains(cur));

            if (!inside) {
                // 焦点已跑出容器：拉回边界
                e.preventDefault();
                (e.shiftKey ? last : first).focus();
            } else if (e.shiftKey && cur === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && cur === last) {
                e.preventDefault();
                first.focus();
            }
            // Esc 不在这里处理，交给调用方
        }

        function activate() {
            if (active || !root || !doc) return;
            active = true;
            previous = doc.activeElement;
            var list = focusable(root);
            if (list.length) list[0].focus();
            doc.addEventListener('keydown', onKeydown, true);
        }

        function deactivate() {
            if (!active) return;
            active = false;
            if (doc && doc.removeEventListener) doc.removeEventListener('keydown', onKeydown, true);
            if (previous && typeof previous.focus === 'function') {
                try { previous.focus(); } catch (err) { /* 元素可能已被移除 */ }
            }
            previous = null;
        }

        return { activate: activate, deactivate: deactivate };
    }

    g.WDTVFocusTrap = {
        FOCUSABLE: FOCUSABLE,
        create: create,
        _focusable: focusable
    };
})(typeof window !== 'undefined' ? window : globalThis);
