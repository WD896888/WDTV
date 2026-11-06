// ============================================================
// 底部导航栏（Dock）模块
// - 圆角矩形玻璃底栏：我的影院 / 影视搜索 / 观影空间 三页面切换
// - 页面切换动画：方向感知滑动 + 淡入淡出 + 轻微缩放（CSS transition，见 index.css .wdtv-page）
// - 指示器（玻璃药丸）随活动项平移/变宽，弹性回弹缓动
// - 每页滚动位置记忆、活动标签 localStorage 持久化（刷新/重进恢复）
// - URL 带搜索参数（/s=xx 或 ?s=xx）时强制回到搜索页，配合 index-page.js 自动搜索
// 依赖：index.html 中 #wdtvDock / #wdtvPages 结构；无外部依赖，播放页不加载本文件
// ============================================================

(function () {
    'use strict';

    const DOCK_TAB_KEY = 'wdtvDockTab';
    // 页面顺序即 Dock 从左到右的顺序（索引决定滑动方向）
    const PAGES = ['cinema', 'search', 'space'];

    const dock = document.getElementById('wdtvDock');
    const pagesWrap = document.getElementById('wdtvPages');
    if (!dock || !pagesWrap) return; // 播放页等无 Dock 环境自动 no-op

    const indicator = document.getElementById('wdtvDockIndicator');
    const splashContent = document.querySelector('.splash-content');
    const scrollMem = {};
    let current = readInitialTab();

    function pageEl(id) { return document.getElementById('page-' + id); }
    function btnEl(id) { return dock.querySelector('.wdtv-dock-btn[data-page="' + id + '"]'); }

    function fxOff() { return document.documentElement.classList.contains('fx-off'); }

    // 初始标签：URL 带搜索参数 → 搜索页；否则读 localStorage；兜底搜索页
    function readInitialTab() {
        try {
            if (window.location.pathname.startsWith('/s=')) return 'search';
            if (new URLSearchParams(window.location.search).get('s')) return 'search';
        } catch (e) { /* URL 解析失败忽略 */ }
        try {
            const saved = localStorage.getItem(DOCK_TAB_KEY);
            if (PAGES.includes(saved)) return saved;
        } catch (e) { /* 存储不可用忽略 */ }
        return 'search';
    }

    // 更新指示器：平移到活动按钮下方并同步宽度（offsetLeft/offsetWidth 相对 Dock 定位）
    function updateIndicator() {
        if (!indicator) return;
        const btn = btnEl(current);
        if (!btn) return;
        indicator.style.width = btn.offsetWidth + 'px';
        indicator.style.transform = 'translateX(' + btn.offsetLeft + 'px)';
    }

    // 切换页面：is-active 类切换 + 方向类重排，动画由 CSS transition 完成
    function switchTab(target, opts) {
        opts = opts || {};
        if (!PAGES.includes(target)) return;
        if (target === current) {
            // 重复点击当前标签：把该页内容平滑滚回顶部
            if (splashContent && splashContent.scrollTop > 0) {
                splashContent.scrollTo({ top: 0, behavior: fxOff() ? 'auto' : 'smooth' });
            }
            updateIndicator();
            return;
        }
        if (opts.noAnim) pagesWrap.classList.add('no-anim');

        // 记住离场页滚动位置，切回时还原
        if (splashContent) scrollMem[current] = splashContent.scrollTop;

        current = target;

        PAGES.forEach(id => {
            const el = pageEl(id);
            if (!el) return;
            const active = id === target;
            el.classList.toggle('is-active', active);
            // 非活动页按其在 Dock 中的相对方位停靠到左侧/右侧，形成方向感知滑动；
            // 活动页必须清掉方位类，否则会停留在 ±7% 偏移处（transition 到不了 0）
            const isLeft = PAGES.indexOf(id) < PAGES.indexOf(target);
            el.classList.toggle('pos-left', !active && isLeft);
            el.classList.toggle('pos-right', !active && !isLeft);
        });
        dock.querySelectorAll('.wdtv-dock-btn').forEach(b => {
            b.classList.toggle('is-active', b.dataset.page === target);
        });

        updateIndicator();

        if (opts.noAnim) {
            // 强制重排后再移除 no-anim，确保初始定位不经动画
            void pagesWrap.offsetWidth;
            pagesWrap.classList.remove('no-anim');
        }

        // 还原目标页滚动位置（等浏览器完成类切换布局后再设置）
        requestAnimationFrame(() => {
            if (splashContent) splashContent.scrollTop = scrollMem[target] || 0;
        });

        try { localStorage.setItem(DOCK_TAB_KEY, target); } catch (e) { /* 忽略 */ }
    }

    // Dock 点击：事件委托，兼容 svg/span 命中
    dock.addEventListener('click', e => {
        const btn = e.target.closest('.wdtv-dock-btn');
        if (btn) switchTab(btn.dataset.page);
    });

    // 视口/字体变化后指示器重新对位（Google Fonts 异步加载会改变按钮宽度）
    window.addEventListener('resize', updateIndicator);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(updateIndicator).catch(() => { });

    // 初始化：无动画地把类状态对齐到恢复的标签（HTML 默认 is-active 在搜索页），
    // 再恢复过渡
    pagesWrap.classList.add('no-anim');
    PAGES.forEach(id => {
        const el = pageEl(id);
        if (!el) return;
        const active = id === current;
        el.classList.toggle('is-active', active);
        el.classList.toggle('pos-left', !active && PAGES.indexOf(id) < PAGES.indexOf(current));
        el.classList.toggle('pos-right', !active && PAGES.indexOf(id) > PAGES.indexOf(current));
    });
    dock.querySelectorAll('.wdtv-dock-btn').forEach(b => {
        b.classList.toggle('is-active', b.dataset.page === current);
    });
    updateIndicator();
    requestAnimationFrame(() => {
        requestAnimationFrame(() => pagesWrap.classList.remove('no-anim'));
    });

    // 供影院空态"去搜索"按钮等外部调用
    window.switchDockTab = switchTab;
})();
