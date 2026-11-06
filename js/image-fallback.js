// =====================================
// WDTV 图片加载降级（零依赖，IIFE + window 单例）
// 本批只提供可复用模块，不改动 app.js handleCoverLoadError / douban.js doubanImageQueue（批次 2 抽取接入）。
//
// 关键：WDTV 代理是「路径式」/proxy/${encodeURIComponent(url)}（见 js/config.js:2 PROXY_URL='/proxy/'），
// LibreTV 的 /api/proxy?url= 查询式在这里会 404，绝对不要照抄。
//
// candidates(url) 降级候选顺序：
//   1) 直连原始 URL
//   2) 豆瓣图床 imgN 域名归一为 img9（参考 js/douban.js:594，各节点防盗链宽严不一）
//   3) /proxy/ 路径式包装（对归一后的 URL；服务端会补豆瓣 Referer）
//   4) 空串 —— 表示已耗尽，调用方据此切占位图
// apply(imgEl, url) 用 onerror 逐级回退；referrerPolicy=no-referrer、默认 loading=lazy。
// 耗尽时派发 wdtv-image-exhausted 自定义事件并调用 imgEl.onfallback(url)（若存在），由调用方渲染占位图。
// =====================================
(function (g) {
    'use strict';

    // 代理基址：默认路径式 /proxy/；兼容 config.js 的 PROXY_URL（try/catch 规避声明前 TDZ）
    function proxyBase() {
        var base = '/proxy/';
        try {
            if (typeof PROXY_URL !== 'undefined' && PROXY_URL) base = PROXY_URL;
        } catch (e) { /* 未声明 / TDZ：用默认 */ }
        if (base.charAt(base.length - 1) !== '/') base += '/';
        return base;
    }

    // 豆瓣 imgN 节点统一改写到 img9（图片路径在各节点通用）
    function normalizeDouban(url) {
        return String(url == null ? '' : url).replace(/\/\/img\d+\.doubanio\.com/gi, '//img9.doubanio.com');
    }

    // 路径式代理包装：/proxy/<encoded>，绝不使用 ?url= 查询式
    function proxyUrl(url) {
        return proxyBase() + encodeURIComponent(String(url == null ? '' : url));
    }

    // 返回降级候选数组（末项为空串，代表占位图回调）
    function candidates(url) {
        var u = String(url == null ? '' : url).trim();
        if (!u) return [];
        var list = [];
        function push(s) {
            if (list.indexOf(s) === -1) list.push(s);
        }
        push(u);                         // 1) 直连
        var norm = normalizeDouban(u);
        if (norm !== u) push(norm);      // 2) 豆瓣 imgN 归一（仅在确有变化时）
        push(proxyUrl(norm));            // 3) /proxy/ 路径式包装
        push('');                        // 4) 耗尽 -> 占位图回调
        return list;
    }

    // 逐级回退：给 img 设置默认属性并挂 onerror 链
    function apply(imgEl, url) {
        var list = candidates(url);
        if (!imgEl || list.length === 0) return list;

        // 默认属性：no-referrer 由调用方策略决定；代理级由服务端补 Referer
        try {
            if (typeof imgEl.setAttribute === 'function') {
                imgEl.setAttribute('referrerpolicy', 'no-referrer');
                if (!imgEl.getAttribute('loading')) imgEl.setAttribute('loading', 'lazy');
            }
            imgEl.referrerPolicy = 'no-referrer';
        } catch (e) { /* 忽略属性设置异常 */ }

        var idx = 0;
        function exhausted() {
            imgEl.onerror = null;
            try {
                if (typeof imgEl.setAttribute === 'function') imgEl.setAttribute('data-wdtv-fallback', 'exhausted');
            } catch (e) { }
            // 事件派发与 onfallback 钩子互不排斥：浏览器环境下两者都要执行，
            // 否则「派发了事件却漏调占位图回调」会让首屏图片一直空白（见文件头 :14 注释）。
            if (typeof g.CustomEvent === 'function' && typeof imgEl.dispatchEvent === 'function') {
                try {
                    imgEl.dispatchEvent(new g.CustomEvent('wdtv-image-exhausted', {
                        bubbles: true, detail: { url: url }
                    }));
                } catch (e) { }
            }
            if (typeof imgEl.onfallback === 'function') imgEl.onfallback(url);
        }

        function setNext() {
            if (idx >= list.length) return;
            var src = list[idx++];
            if (src === '') {
                exhausted();
                return;
            }
            imgEl.src = src;
        }

        imgEl.onerror = function () { setNext(); };
        setNext();
        return list;
    }

    g.WDTVImageFallback = {
        candidates: candidates,
        apply: apply,
        proxyUrl: proxyUrl,
        normalizeDouban: normalizeDouban,
        proxyBase: proxyBase
    };
})(typeof window !== 'undefined' ? window : globalThis);
