/**
 * WDTV 批量取件客户端（服务端多连接）
 *
 * 背景：慢源的真实瓶颈是「每个分片一次上游往返」（单片 TTFB ~2s），而浏览器对同一 host
 * 只放行约 6 条 HTTP/1.1 连接。逐片取件时并发再高也只能跑满 6 路；一次请求取回 K 片、
 * 由服务端并发拉上游，6 条连接即可压满带宽（本地实测 0.6 → 1.0+ MB/s）。
 *
 * 服务端实现（协议必须一致，勿单方面改动）：
 *   - 本地/自建：server.mjs 的 POST /dl-batch
 *   - Cloudflare Pages：functions/dl-batch.js
 *   请求 { urls: [...] }（≤6 条，http(s)）
 *   响应 body = 各分片字节按序拼接；响应头
 *     x-wdtv-status: "200,200,0,…"   0/非 2xx = 该片失败 → 调用方退回逐片通道
 *     x-wdtv-size:   "532604,…"      各片字节数（切分依据）
 *     x-wdtv-clen:   "532604,…"      上游声明长度（可选，用于截断校验；0=未知）
 *
 * 使用方：js/downloader.js（整集下载）、js/video-cache.js（播放缓存预取）。
 * 页面里必须先于这两个脚本加载。
 */
(function (root) {
    'use strict';

    var ENDPOINT = '/dl-batch';
    var MAX_URLS = 6;
    var TIMEOUT_MS = 45000;
    // 服务端没有该接口（线上旧部署 / 未部署 Functions）→ 本页会话内永久停用，
    // 调用方据此退回逐片通道；避免每个批次都白撞一次 404。
    var unavailable = false;

    function proxyPath() {
        try {
            var p = (typeof PROXY_URL === 'string' && PROXY_URL) ? PROXY_URL : '/proxy/';
            return new URL(p, location.href).pathname || p;
        } catch (e) { return '/proxy/'; }
    }

    // 判定是否为同源代理地址 /proxy/<encodeURIComponent(绝对地址)>（内层必须是 http(s)）
    function isProxyForm(u) {
        try {
            var url = new URL(u, location.href);
            if (url.origin !== location.origin) return false;
            var pb = proxyPath();
            if (url.pathname.indexOf(pb) !== 0) return false;
            return /^https?:\/\//i.test(decodeURIComponent(url.pathname.slice(pb.length)));
        } catch (e) { return false; }
    }

    function unwrap(u) {
        try {
            var url = new URL(u, location.href);
            var pb = proxyPath();
            var inner = decodeURIComponent(url.pathname.slice(pb.length));
            if (/^https?:\/\//i.test(inner)) return inner;
        } catch (e) { }
        return u;
    }

    // 批量接口只认「上游真实地址」：代理形态必须先解包，否则服务端会回头再请求自己
    function batchUrlOf(u) {
        return isProxyForm(u) ? unwrap(u) : u;
    }

    function supported() { return !unavailable; }
    function disable() { unavailable = true; }

    function parseNums(raw) {
        if (!raw) return [];
        return String(raw).split(',').map(function (s) { return parseInt(s, 10) || 0; });
    }

    function abortError() {
        try { return new DOMException('aborted', 'AbortError'); } catch (e) { return new Error('aborted'); }
    }

    /**
     * 一次取回多片。
     * @param {string[]} urls 分片地址（原样传入，代理形态会自动解包）
     * @param {{signal?:AbortSignal, onData?:(n:number)=>void}} opts
     * @returns {Promise<Array<{buf:ArrayBuffer, clen:number}|null>>} null = 该片失败
     */
    function fetchBatch(urls, opts) {
        opts = opts || {};
        var signal = opts.signal || null;
        var onData = (typeof opts.onData === 'function') ? opts.onData : null;
        if (unavailable) return Promise.reject(new Error('批量取件已停用'));
        var list = (urls || []).slice(0, MAX_URLS);
        if (!list.length) return Promise.resolve([]);

        if (typeof fetch !== 'function') return Promise.reject(new Error('批量取件不可用（无 fetch）'));
        var ctrl = new AbortController();
        var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, TIMEOUT_MS);
        function onAbort() { try { ctrl.abort(); } catch (e) { } }
        if (signal) {
            if (signal.aborted) {
                clearTimeout(timer);
                return Promise.reject(abortError());
            }
            try { signal.addEventListener('abort', onAbort, { once: true }); } catch (e) { }
        }

        return fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ urls: list.map(batchUrlOf) }),
            signal: ctrl.signal,
            credentials: 'omit'
        }).then(function (resp) {
            if (!resp.ok) {
                var err = new Error('批量取件接口不可用（HTTP ' + resp.status + '）');
                // 404/405/501 = 服务端根本没有这个接口 → 永久停用；其余（超时/5xx）只算本批失败
                if (resp.status === 404 || resp.status === 405 || resp.status === 501) {
                    err.permanent = true;
                    unavailable = true;
                }
                throw err;
            }
            var statuses = parseNums(resp.headers.get('x-wdtv-status'));
            var sizes = parseNums(resp.headers.get('x-wdtv-size'));
            var clens = parseNums(resp.headers.get('x-wdtv-clen'));
            return resp.arrayBuffer().then(function (ab) {
                if (onData) { try { onData(ab.byteLength); } catch (e) { } }
                var out = [];
                var off = 0;
                for (var i = 0; i < list.length; i++) {
                    var size = sizes[i] > 0 ? sizes[i] : 0;
                    var okItem = statuses[i] >= 200 && statuses[i] < 300 && size > 0 && off + size <= ab.byteLength;
                    out.push(okItem ? { buf: ab.slice(off, off + size), clen: clens[i] || 0 } : null);
                    off += size;
                }
                return out;
            });
        }).finally(function () {
            clearTimeout(timer);
            if (signal) { try { signal.removeEventListener('abort', onAbort); } catch (e) { } }
        });
    }

    root.WDTVSegBatch = {
        MAX_URLS: MAX_URLS,
        supported: supported,
        disable: disable,
        batchUrlOf: batchUrlOf,
        fetch: fetchBatch
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
