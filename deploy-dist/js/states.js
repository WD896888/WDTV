// =====================================
// WDTV 状态组件基础（零依赖，IIFE + window 单例）
// 提供 Spinner / Loading / EmptyState / ErrorState 四个返回 HTML 字符串的纯函数，
// 以及 mount / clear 两个轻量 DOM 辅助。本批只建模块，不接入任何页面。
//
// 语义参考 LibreTV src/components/states.tsx：
//   - Spinner 三档尺寸 sm / md / lg，可选 tone 色调
//   - EmptyState 两种变体 boxed / plain
//   - ErrorState 的 onRetry 这里只输出 data 属性（data-wdtv-retry），回调由调用方事件委托处理
// 配色由 css/states.css 用项目深色玻璃变量（--glass-bg / --glass-border）承载，
// 此处只输出结构类名，不硬编码浅色值、不加白色描边、不加重投影。
// =====================================
(function (g) {
    'use strict';

    // HTML 转义：所有用户可控文本都经此函数再插入字符串，避免 innerHTML XSS
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // class 名安全化：只允许字母数字下划线连字符
    function cls(s) {
        return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]/g, '');
    }

    var SIZE_SET = { sm: true, md: true, lg: true };
    var VARIANT_SET = { boxed: true, plain: true };

    // 旋转指示器：三档尺寸 + 可选色调
    function spinner(size, tone) {
        var s = SIZE_SET[size] ? size : 'md';
        var t = cls(tone) || 'default';
        return '<span class="wdtv-state-spinner wdtv-state-spinner--' + s +
            ' wdtv-state-tone--' + t + '" role="status" aria-label="加载中"></span>';
    }

    // 加载态：spinner + 文案
    function loading(label) {
        return '<div class="wdtv-state-loading" role="status" aria-live="polite">' +
            spinner('md') +
            '<span class="wdtv-state-loading__label">' + esc(label == null ? '加载中...' : label) + '</span>' +
            '</div>';
    }

    // 空态：boxed（玻璃卡片）/ plain（纯文本）两变体
    function empty(title, description, variant) {
        var v = VARIANT_SET[variant] ? variant : 'boxed';
        var icon = '<svg class="wdtv-state-empty__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 7l9-4 9 4-9 4-9-4z"></path>' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 7v10l9 4 9-4V7"></path>' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 11v10"></path>' +
            '</svg>';
        return '<div class="wdtv-state-empty wdtv-state-empty--' + v + '">' +
            icon +
            '<div class="wdtv-state-empty__title">' + esc(title == null ? '暂无内容' : title) + '</div>' +
            (description ? '<div class="wdtv-state-empty__desc">' + esc(description) + '</div>' : '') +
            '</div>';
    }

    // 错误态：onRetry 以 data 属性暴露，调用方在容器上做事件委托
    function error(message, retryLabel) {
        var rl = retryLabel == null ? '重试' : retryLabel;
        var icon = '<svg class="wdtv-state-error__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v4m0 4h.01"></path>' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path>' +
            '</svg>';
        return '<div class="wdtv-state-error" role="alert">' +
            icon +
            '<div class="wdtv-state-error__message">' + esc(message == null ? '出错了，请稍后重试' : message) + '</div>' +
            '<button type="button" class="wdtv-state-error__retry" data-wdtv-retry="1" data-retry-label="' + esc(rl) + '">' +
            esc(rl) + '</button>' +
            '</div>';
    }

    // 容器解析：接受元素或选择器字符串；document 不可用时返回 null
    function resolve(container) {
        if (!container) return null;
        if (typeof container === 'string') {
            return (typeof document !== 'undefined' && document.querySelector)
                ? document.querySelector(container) : null;
        }
        return container;
    }

    // 轻量 DOM 辅助：写入 HTML / 清空
    function mount(container, html) {
        var el = resolve(container);
        if (!el) return null;
        el.innerHTML = String(html == null ? '' : html);
        return el;
    }

    function clear(container) {
        var el = resolve(container);
        if (!el) return null;
        el.innerHTML = '';
        return el;
    }

    g.WDTVStates = {
        spinner: spinner,
        loading: loading,
        empty: empty,
        error: error,
        mount: mount,
        clear: clear,
        _esc: esc
    };
})(typeof window !== 'undefined' ? window : globalThis);
