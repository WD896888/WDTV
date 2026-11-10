/**
 * WDTV 下载链路纯函数工具（移植自 LibreTV 的错误分类 / 诊断设计）
 *
 * 设计约束：
 *  - 不碰 DOM / fetch / IndexedDB，浏览器与 Node 都能直接加载；
 *    浏览器里挂 globalThis.WDTVDownloadUtils，download.js 通过它调用，
 *    Node 里 test/download-utils.test.mjs 可以真实执行并断言行为。
 *  - 这里只放「决策」不放「流程」：状态码该不该重试、失败该怎么解释，
 *    网络与写盘的副作用仍留在 downloader.js。
 */
(function (root) {
    'use strict';

    // 408 / 429 与全部 5xx 多为源站抖动或限流，值得退避重试；
    // 其余 4xx（404/410/403…）是确定性缺失：采集站常见「m3u8 列全了整集、
    // 服务器上分片却没传完」，重试只会白等，播放器 hls.js 会直接跳过这类分片，
    // 于是表现为「能播、下不了」，应立刻提示换源。
    const RETRYABLE_4XX = [408, 429];

    /**
     * 单个分片 HTTP 状态分类。
     * @returns {{status:number, retryable:boolean, fatal:boolean, message:string}}
     */
    function classifyHttpStatus(status, index) {
        const s = Number(status) || 0;
        const retryable = s >= 500 || RETRYABLE_4XX.indexOf(s) !== -1;
        const fatal = s >= 400 && !retryable;
        return {
            status: s,
            retryable: !fatal,
            fatal: fatal,
            message: fatal
                ? '分片 ' + index + ' 源站缺失（HTTP ' + s + '），该来源无法完整下载，建议更换来源'
                : 'HTTP ' + s
        };
    }

    /** 页面是 HTTPS 而目标是 http:// 时，浏览器按混合内容策略直接拦截 */
    function isMixedContentBlocked(target, pageProtocol) {
        const proto = pageProtocol || (typeof location !== 'undefined' ? location.protocol : '');
        return proto === 'https:' && /^http:\/\//i.test(String(target || ''));
    }

    /**
     * 把浏览器含糊的 fetch 失败翻译成用户能行动的原因。
     * 直连被 CORS / 混合内容 / DNS 拦下时 fetch 只给 `Failed to fetch`，
     * 下载链路不像播放器有多次自动回退，必须把「下一步做什么」讲清楚。
     */
    function describeFetchFailure(url, reason, pageProtocol) {
        const msg = String(reason || '未知错误');
        if (!/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) return msg;
        if (isMixedContentBlocked(url, pageProtocol)) {
            return msg + '——该来源是 HTTP 地址，HTTPS 页面无法直连（混合内容被拦截），建议更换来源';
        }
        return msg + '——无法直连该来源（跨域限制或域名不可达），且代理通道也不可用，建议更换来源';
    }

    /** 清单解析阶段的失败：带上「播放列表」上下文再走同一套诊断 */
    function describePlaylistFailure(url, reason, pageProtocol) {
        return describeFetchFailure(url, '播放列表解析失败：' + String(reason || '未知错误'), pageProtocol);
    }

    /** 存储层错误：浏览器原文 QuotaExceededError 用户看不懂 */
    function describeStorageError(err) {
        const msg = err && err.message ? err.message : String(err);
        return '分片缓存写入失败（浏览器存储空间可能不足）：' + msg;
    }

    /** FS Access 只在安全上下文的 Chromium 系浏览器可用；传 env 便于单测 */
    function isFsAccessSupported(env) {
        const w = env || (typeof window !== 'undefined' ? window : null);
        return !!(w && typeof w.showSaveFilePicker === 'function');
    }

    root.WDTVDownloadUtils = {
        classifyHttpStatus: classifyHttpStatus,
        isMixedContentBlocked: isMixedContentBlocked,
        describeFetchFailure: describeFetchFailure,
        describePlaylistFailure: describePlaylistFailure,
        describeStorageError: describeStorageError,
        isFsAccessSupported: isFsAccessSupported
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
