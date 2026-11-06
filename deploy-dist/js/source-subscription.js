// ============================================================
// 数据源订阅（批次3 · A9，window.WDTVSourceSubscriptions）
// - 浏览器直连优先；失败/CORS 回退同源 /proxy/ 路径式代理（带按小时变化的缓存键，换边缘缓存）
// - 解析 LibreTV-SourceList / TVBOX 配置 / 接口目录 / 裸数组，全部在浏览器端完成，不新增 Functions
// - 源集合按订阅前缀隔离，移除订阅只删该前缀导入的源，保留内置源与手动添加源
// - 零依赖、普通 script（IIFE + window 单例）、所有异常静默降级、不弹 toast（由 UI 层决定）
// - 加载顺序：须在 app.js 之前（index.html 中 source-subscription.js?v=1 位于 app.js?v=36 之前）
// ============================================================
(function (g) {
    'use strict';

    // ===================== 常量 =====================
    var STORAGE_KEY = 'wdtvSourceSubscriptions';   // 与 cloud-sync.js SYNC_LIST_KEYS 一致
    var PROXY_URL = '/proxy/';                     // 与 config.js 一致：路径式，PROXY_URL + encodeURIComponent(url)
    var MAX_VOD = 100;                             // 单次导入点播源上限
    var DIRECT_TIMEOUT_MS = 6000;                 // 直连超时（AbortController）
    var MAX_FAIL_STREAK = 3;                      // 连续失败熔断阈值
    var CONCURRENCY = 2;                           // 刷新并发
    var MAX_PER_RUN = 5;                           // 单次刷新最多订阅数
    var VALID_DAYS = [0, 1, 3, 7, 14, 30];        // 0 = 纯手动，不自动刷新
    var DAY_MS = 86400000;

    // ===================== 运行时状态（仅内存） =====================
    var _status = '';          // 最近一次状态文案（写入 #wdtvSubscriptionStatus）
    var _autoStarted = false;  // autoRefresh 幂等锁：打开站点只检查一次

    // ===================== 通用工具 =====================
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function getEl(id) {
        try { return g.document ? g.document.getElementById(id) : null; } catch (e) { return null; }
    }
    // 空闲调度：不阻塞首屏；测试里若未 mock requestIdleCallback 则退化为 setTimeout(0)
    function schedule(fn) {
        try {
            if (typeof g.requestIdleCallback === 'function') g.requestIdleCallback(fn, { timeout: 1200 });
            else if (typeof g.setTimeout === 'function') g.setTimeout(fn, 0);
            else fn();
        } catch (e) { try { fn(); } catch (e2) {} }
    }
    function hostLabel(u) {
        try { return new URL(u).hostname; } catch (e) { return String(u).slice(0, 32); }
    }
    function normalizeUrl(u) {           // trim + 去尾斜杠
        return typeof u === 'string' ? u.trim().replace(/\/+$/, '') : '';
    }
    function normalizeApi(u) {
        return typeof u === 'string' ? u.trim().replace(/\/+$/, '') : '';
    }
    // djb2 → base36，用于生成稳定的订阅/源 key（参考 LibreTV subKeyPrefix）
    function djb2Hash36(str) {
        var h = 5381;
        for (var i = 0; i < str.length; i++) h = (Math.imul(h, 33) + str.charCodeAt(i)) >>> 0;
        return h.toString(36);
    }
    function subPrefix(url) { return 'sub_' + djb2Hash36(url) + '_'; }
    function hourStamp() {
        var d = new Date();
        function p(n) { return (n < 10 ? '0' : '') + n; }
        return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours());
    }
    // 回退代理时给目标 URL 附加按小时变化的查询参数，换掉 /proxy/ 对 JSON 的 max-age=86400 边缘缓存键，
    // 保证订阅更新最多陈旧 1 小时。直连路径绝不附加此参数。
    function withCacheBuster(url) {
        return url + (url.indexOf('?') >= 0 ? '&' : '?') + '_wdtv=' + hourStamp();
    }

    // ===================== SSRF 字面量守卫 =====================
    // 与 functions/proxy/_ssrf-literal.mjs 同思路（纯同步、零网络、不 import 它）：
    // 只拒绝 localhost / 私网 / 保留 IP 字面量与非 http(s) 协议，绝不误伤任何域名字符串。
    function isBlockedLiteral(targetUrl) {
        if (typeof targetUrl !== 'string' || !targetUrl) return true;
        var parsed;
        try { parsed = new URL(targetUrl); } catch (e) { return true; }
        var protocol = parsed.protocol.toLowerCase();
        if (protocol !== 'http:' && protocol !== 'https:') return true;
        var host = parsed.hostname;
        if (host.charAt(0) === '[' && host.charAt(host.length - 1) === ']') host = host.slice(1, -1);
        host = host.toLowerCase().replace(/\.$/, '');
        if (!host) return true;
        if (host === 'localhost' || /\.localhost$/.test(host)) return true;
        if (host.indexOf(':') >= 0) {                     // IPv6 字面量（域名不含冒号，不会误伤）
            if (host === '::1' || host === '::' ||
                host === '0:0:0:0:0:0:0:1' || host === '0:0:0:0:0:0:0:0') return true;
            var mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i) ||
                         host.match(/^0:0:0:0:0:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
            if (mapped) {
                var hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
                return isBlockedIPv4([(hi >>> 8) & 255, hi & 255, (lo >>> 8) & 255, lo & 255]);
            }
            if (/^fe[89ab]/i.test(host) || /^f[cd]/i.test(host)) return true;
            return false;
        }
        var ipv4 = parseIPv4(host);
        if (ipv4) return isBlockedIPv4(ipv4);
        if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;
        return false;
    }
    function parseIPv4(host) {
        var parts = host.split('.');
        if (parts.length !== 4) return null;
        var out = [];
        for (var i = 0; i < 4; i++) {
            if (!/^\d{1,3}$/.test(parts[i])) return null;
            var n = Number(parts[i]);
            if (n > 255) return null;
            out.push(n);
        }
        return out;
    }
    function isBlockedIPv4(p) {
        var a = p[0], b = p[1], c = p[2];
        if (a === 0) return true;                            // 0.0.0.0/8
        if (a === 10) return true;                           // 10.0.0.0/8
        if (a === 127) return true;                          // 127.0.0.0/8
        if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 CGNAT
        if (a === 169 && b === 254) return true;             // 169.254.0.0/16（含云元数据）
        if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
        if (a === 192 && b === 168) return true;             // 192.168.0.0/16
        if (a === 192 && b === 0 && c === 0) return true;    // 192.0.0.0/24
        if (a >= 224) return true;                           // 组播 / 保留兜底
        return false;
    }
    function isPublicHttp(u) {
        return typeof u === 'string' && /^https?:\/\//i.test(u) && !isBlockedLiteral(u);
    }

    // ===================== JSONC 清洗 =====================
    // 对齐 LibreTV src/lib/tvbox-parser.ts:87-110,137-143：
    //   ① 入口剥 UTF-8 BOM；② 字符串内裸控制字符转合法转义；③ 单引号字符串转成标准 JSON 双引号。
    // 把字符串内 < 0x20 的控制字符（含 \b \f）转成 \n \r \t \b \f \uXXXX，
    // 否则 JSON.parse 会抛 "Bad control character in string literal"。
    function escapeControlChar(c) {
        switch (c) {
            case '\n': return '\\n';
            case '\r': return '\\r';
            case '\t': return '\\t';
            case '\b': return '\\b';
            case '\f': return '\\f';
            default:
                return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
        }
    }
    // 第一遍：去 // 行注释与 /* 块注释（字符串内的 https:// 不误伤），字符串内裸控制字符转义，
    //         并把单引号字符串安全转换为双引号字符串（内部双引号转义、\' 去反斜杠）。
    function stripCommentsAndNewlines(text) {
        var out = '', inStr = false, esc = false, quote = '';
        for (var i = 0; i < text.length; i++) {
            var c = text[i], n = text[i + 1];
            if (inStr) {
                if (esc) {
                    esc = false;
                    // 单引号串里的 \' 是字面单引号，转成双引号串后单引号无需转义，故去掉反斜杠；
                    // 其余转义序列（\" \\ \/ \n \t ...）原样保留，均为合法 JSON 转义。
                    if (quote === "'" && c === "'") { out += "'"; continue; }
                    if (c.charCodeAt(0) < 0x20) { out += escapeControlChar(c); continue; } // 畸形兜底
                    out += '\\' + c;
                    continue;
                }
                if (c === '\\') { esc = true; continue; }   // 延迟到下一字符一起决定输出
                if (c === quote) { inStr = false; out += '"'; continue; } // 统一以双引号收尾
                if (c.charCodeAt(0) < 0x20) {
                    if (c === '\r' && n === '\n') i++;      // CRLF 归一为单个 \n
                    out += escapeControlChar(c === '\r' ? '\n' : c);
                    continue;
                }
                // 单引号串里的字面双引号在目标双引号串中必须转义，否则会提前闭合字符串
                if (quote === "'" && c === '"') { out += '\\"'; continue; }
                out += c;
                continue;
            }
            // 字符串外：单/双引号一律以「双引号字符串」开始（完成单引号 → 双引号转换）
            if (c === '"' || c === "'") { inStr = true; quote = c; out += '"'; continue; }
            if (c === '/' && n === '/') {                 // 行注释（字符串外才会命中，故 https:// 安全）
                i += 2;
                while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
                if (i < text.length) out += text[i];     // 保留一个换行，维持行结构
                continue;
            }
            if (c === '/' && n === '*') {                 // 块注释
                i += 2;
                while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
                i++;
                continue;
            }
            out += c;
        }
        return out;
    }
    // 第二遍：仅在字符串外删除尾随逗号（前瞻到 } 或 ]），不误伤字符串内容。
    // 第一遍已把单引号串统一转成双引号串，这里仍同时认 " 与 ' 作边界（防御性，不改既有能力）。
    function removeTrailingCommas(s) {
        var out = '', inStr = false, esc = false, quote = '';
        for (var i = 0; i < s.length; i++) {
            var c = s[i];
            if (inStr) {
                out += c;
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === quote) inStr = false;
                continue;
            }
            if (c === '"' || c === "'") { inStr = true; quote = c; out += c; continue; }
            if (c === ',') {
                var j = i + 1;
                while (j < s.length && /\s/.test(s[j])) j++;
                if (j < s.length && (s[j] === '}' || s[j] === ']')) continue; // 丢弃尾随逗号
                out += c;
                continue;
            }
            out += c;
        }
        return out;
    }
    function stripJSONC(text) {
        // 入口剥 UTF-8 BOM（\uFEFF），否则 JSON.parse 抛 "Unexpected token"
        var s = String(text == null ? '' : text).replace(/^\uFEFF/, '');
        return removeTrailingCommas(stripCommentsAndNewlines(s));
    }

    // ===================== 格式嗅探 =====================
    // 返回 { vod:[{name,api,detail}], live, skipped, format }；无法识别或混用格式抛错。
    function sniff(data) {
        var vod = [], live = 0, skipped = 0, format = '';
        function push(name, api, detail) {
            vod.push({ name: name || '', api: api || '', detail: detail || '' });
        }
        if (Array.isArray(data)) {
            var hasBase = false, hasUrlOnly = false;
            data.forEach(function (e) {
                if (!e || typeof e !== 'object') return;
                if (e.baseUrl != null && e.baseUrl !== '') hasBase = true;
                else if (e.url != null || e.api != null) hasUrlOnly = true;
            });
            // 接口目录混用 baseUrl 与 url：直接报格式错误，不静默丢一半
            if (hasBase && hasUrlOnly) throw new Error('格式错误：接口目录混用 baseUrl 与 url');
            if (hasBase) {
                format = 'catalog';
                data.forEach(function (e) {
                    if (!e || typeof e !== 'object') { skipped++; return; }
                    if (e.enabled === false) { skipped++; return; }
                    if (!e.baseUrl) { skipped++; return; }
                    push(e.name, e.baseUrl, '');
                });
            } else {
                format = 'array';
                data.forEach(function (e) {
                    if (!e || typeof e !== 'object') { skipped++; return; }
                    push(e.name, e.url || e.api, e.detail);
                });
            }
        } else if (data && typeof data === 'object') {
            if (Array.isArray(data.sources)) {
                format = 'sourcelist';
                live += Array.isArray(data.liveSources) ? data.liveSources.length : 0;
                live += Array.isArray(data.lives) ? data.lives.length : 0;
                data.sources.forEach(function (s) {
                    if (!s || typeof s !== 'object') { skipped++; return; }
                    push(s.name, s.url || s.api, s.detail);
                });
            } else if (Array.isArray(data.sites)) {
                format = 'tvbox';
                live += Array.isArray(data.lives) ? data.lives.length : 0;
                // 对齐 LibreTV tvbox-parser.ts:26-43,383-422：
                //  TVBOX 站点类型 0=XML 1=JSON 3=Spider 4=JSON外链；type=3 一律跳过，
                //  type=1 明确 CMS 直接导入，仅 type 缺失/0/4 才用 Apple CMS 特征正则做 URL 兜底，
                //  其余 type（如 2）跳过。CMS 正则带边界并排除 /at/xml 路径式 XML 通道。
                var SITE_TYPE_JSON = 1, SITE_TYPE_SPIDER = 3;
                var CMS_API_PATTERN = /\/api\.php\/provide\/vod(?![^?#]*\/at\/xml)(?:[/?#]|$)/i;
                data.sites.forEach(function (s) {
                    if (!s || typeof s !== 'object') { skipped++; return; }
                    if (s.searchable === 0 || s.searchable === '0') { skipped++; return; }
                    var u = String(s.api || s.url || '');
                    // type 数值化（兼容字符串写法）；缺失/空/非法 → undefined（等同 LibreTV toNumber）
                    var rawType = s.type;
                    var t = (typeof rawType === 'number' && isFinite(rawType)) ? rawType
                        : (typeof rawType === 'string' && rawType.trim() !== '' && isFinite(Number(rawType))) ? Number(rawType)
                        : undefined;
                    if (t === SITE_TYPE_SPIDER) { skipped++; return; }         // Spider 引擎跳过
                    var eligible = (t === SITE_TYPE_JSON) ||
                        ((t === undefined || t === 0 || t === 4) && CMS_API_PATTERN.test(u));
                    if (!eligible) { skipped++; return; }                      // 仅 CMS 可搜索接口
                    if (/csp_/i.test(u) || /\.(jar|js|py)(\?|$)/i.test(u)) { skipped++; return; } // Spider 特征（保留）
                    if (/\.xml(\?|$)/i.test(u) || /[?&]type=xml/i.test(u)) { skipped++; return; } // XML 接口（保留）
                    if (/\/at\/xml/i.test(u)) { skipped++; return; }          // 路径式 XML /at/xml（新增）
                    push(s.name, u, s.detail || '');
                });
            } else {
                throw new Error('无法识别的订阅格式');
            }
        } else {
            throw new Error('无法识别的订阅格式');
        }
        return { vod: vod, live: live, skipped: skipped, format: format };
    }

    // ===================== 订阅条目持久化 =====================
    function readRaw() {
        try {
            var raw = g.localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            var arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }
    function save(arr) {
        try { g.localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); } catch (e) {}
    }
    function findIndex(arr, url) {
        for (var i = 0; i < arr.length; i++) if (arr[i].url === url) return i;
        return -1;
    }
    // list() 返回深拷贝，避免外部改动污染内存
    function list() {
        return readRaw().map(function (it) {
            return Object.assign({}, it, { counts: Object.assign({}, it.counts || {}) });
        });
    }

    // ===================== selectedAPIs 桥接 =====================
    // localStorage['selectedAPIs'] 为权威；同时尽量同步 app.js 的内存变量（浏览器经典 script 共享全局词法环境）。
    function readSelected() {
        try {
            var raw = g.localStorage.getItem('selectedAPIs');
            var arr = raw ? JSON.parse(raw) : null;
            if (Array.isArray(arr)) return arr.slice();
        } catch (e) {}
        try { return Object.keys(g.API_SITES || {}); } catch (e) { return []; }
    }
    function writeSelected(arr) {
        try { g.localStorage.setItem('selectedAPIs', JSON.stringify(arr)); } catch (e) {}
        // 浏览器：app.js 顶层 `let selectedAPIs` 位于共享全局词法环境，可直接赋值；
        // Node ESM 测试里该绑定不存在，typeof 为 'undefined'，跳过赋值（不抛 ReferenceError）。
        try {
            if (typeof selectedAPIs !== 'undefined' && Array.isArray(selectedAPIs)) {
                selectedAPIs = arr.slice();
            }
        } catch (e) {}
    }

    // ===================== 源集合操作 =====================
    // 删除某订阅前缀导入的源（config.js 提供 removeAPISitesByPrefix；缺失时兜底），
    // 并从 selectedAPIs 移除对应 key；内置源与手动源不受影响。
    function clearImported(prefix) {
        try {
            if (typeof g.removeAPISitesByPrefix === 'function') g.removeAPISitesByPrefix(prefix);
            else if (g.API_SITES && typeof g.API_SITES === 'object') {
                Object.keys(g.API_SITES).forEach(function (k) {
                    if (k.indexOf(prefix) === 0) delete g.API_SITES[k];
                });
            }
        } catch (e) {}
        try {
            var sel = readSelected().filter(function (k) {
                return typeof k !== 'string' || k.indexOf(prefix) !== 0;
            });
            writeSelected(sel);
        } catch (e) {}
    }
    function mergeImportedSites(merged) {
        try {
            if (typeof g.extendAPISites === 'function') g.extendAPISites(merged);
            else if (g.API_SITES && typeof g.API_SITES === 'object') Object.assign(g.API_SITES, merged);
        } catch (e) {}
    }
    // 合并新源后重跑源勾选面板与 DNS 预取，并刷新订阅 UI
    function refreshUI() {
        try { if (typeof g.initAPICheckboxes === 'function') g.initAPICheckboxes(); } catch (e) {}
        try { if (typeof g.prefetchAPISiteDns === 'function') g.prefetchAPISiteDns(); } catch (e) {}
        render();
    }

    // ===================== 网络：直连优先 → 路径式代理回退 =====================
    function tryFetch(url) {
        return new Promise(function (resolve) {
            var opts = { headers: { Accept: 'application/json' } };
            var timer = null;
            try {
                if (typeof g.AbortController === 'function') {
                    var ac = new g.AbortController();
                    opts.signal = ac.signal;
                    if (typeof g.setTimeout === 'function') {
                        timer = g.setTimeout(function () { try { ac.abort(); } catch (e) {} }, DIRECT_TIMEOUT_MS);
                    }
                }
            } catch (e) {}
            function clear() {
                if (timer && typeof g.clearTimeout === 'function') { try { g.clearTimeout(timer); } catch (e) {} }
            }
            var p;
            try { p = g.fetch(url, opts); } catch (e) { clear(); resolve(null); return; }
            Promise.resolve(p)
                .then(function (res) {
                    if (!res || typeof res.text !== 'function') { clear(); resolve(null); return null; }
                    if (res.ok === false || (typeof res.status === 'number' && res.status >= 400)) {
                        var st = (typeof res.status === 'number') ? res.status : 0;
                        // 对齐 LibreTV subscription-sync.ts:54-56：401/503 属鉴权/临时故障，
                        // 不计入连续失败（另加 429 限流）；仍按失败处理，只是不触发 paused。
                        // 用 {transient:true} 标记透传给 fetchSubscriptionText / syncOne，
                        // 其余失败仍 resolve(null)（网络异常、其它非 2xx）。
                        var transient = (st === 401 || st === 429 || st === 503);
                        clear(); resolve(transient ? { transient: true } : null); return null;
                    }
                    return res.text();                 // 不用 res.json()：配置常带注释/尾逗号
                })
                .then(function (t) { clear(); resolve(typeof t === 'string' ? t : null); })
                .catch(function () { clear(); resolve(null); });
        });
    }
    function fetchSubscriptionText(url) {
        return tryFetch(url).then(function (direct) {
            if (typeof direct === 'string') return direct;    // 直连成功（文本）
            var directTransient = !!(direct && direct.transient);
            // 回退：路径式代理 + 按小时变化的缓存键（直连路径不加此参数）
            var proxyUrl = PROXY_URL + encodeURIComponent(withCacheBuster(url));
            return tryFetch(proxyUrl).then(function (proxied) {
                if (typeof proxied === 'string') return proxied;
                // 直连与代理都失败：只要任一次是 401/503/429 临时故障，就标记为不计连续失败
                var err = new Error('订阅拉取失败（直连与代理均不可用）');
                err.transient = directTransient || !!(proxied && proxied.transient);
                throw err;
            });
        });
    }

    // ===================== 并发池 =====================
    function runWithConcurrency(items, limit, worker) {
        return new Promise(function (resolve) {
            var idx = 0, active = 0, done = 0, results = [];
            if (!items.length) { resolve(results); return; }
            function next() {
                while (active < limit && idx < items.length) {
                    let cur = idx++;                 // let：每次迭代独立绑定，避免闭包串位
                    active++;
                    Promise.resolve()
                        .then(function () { return worker(items[cur]); })
                        .catch(function () {})
                        .then(function (r) {
                            results[cur] = r;
                            active--;
                            done++;
                            if (done === items.length) resolve(results);
                            else next();
                        });
                }
            }
            next();
        });
    }

    // ===================== 核心：同步单个订阅 =====================
    // 返回值约定：成功返回本次导入的点播源数 N（>=0）；失败 / 订阅不存在返回 -1。
    // status 文案只写操作结果，绝不暴露订阅（上游）URL 或域名。
    // transient=true（401/503/429 鉴权/临时故障）：仍记录失败状态文案，但按 LibreTV
    // subscription-sync.ts:54-56 的 countFailure:!authFailure 不累加 failStreak、不触发 paused。
    function recordFailure(items, idx, transient) {
        if (!transient) {
            items[idx].failStreak = (items[idx].failStreak || 0) + 1;
            if (items[idx].failStreak >= MAX_FAIL_STREAK) items[idx].paused = true;
        }
        save(items);
        setStatus('同步失败，请稍后重试');
        render();                                   // 失败分支：不调用 extendAPISites，旧源全部保留
        return -1;
    }

    // syncOne 接受原始或规范化 URL：内部归一化，便于 UI 直接把输入框的值传进来。
    // opts.force=true（app.js 手动刷新单个订阅 / resume 后重试）：忽略 paused，允许强制重试不可达上游；
    // 非 force（自动刷新 / 刷新全部默认口径）：跳过已暂停订阅，避免继续打不可达上游。
    // 注：syncOne 本身不做「到期」判断（到期由 autoRefresh/isDue 负责），故 force 在此只影响 paused。
    function syncOne(rawUrl, opts) {
        var force = !!(opts && opts.force);
        var url = normalizeUrl(rawUrl);
        var items = list();
        var idx = findIndex(items, url);
        if (idx < 0) return Promise.resolve(-1);
        if (!force && items[idx].paused) return Promise.resolve(-1);
        return fetchSubscriptionText(url).then(function (text) {
            var parsed;
            try {
                parsed = sniff(JSON.parse(stripJSONC(text)));
            } catch (e) {
                return recordFailure(items, idx);          // 解析/格式错误同样计入失败
            }
            var prefix = subPrefix(url);
            var merged = {}, keys = [], seen = Object.create(null);
            var counts = { vod: 0, live: parsed.live || 0, skipped: parsed.skipped || 0 };
            parsed.vod.forEach(function (s) {
                var api = normalizeApi(s.api);
                if (!api || !isPublicHttp(api)) { counts.skipped++; return; }  // 私网/非 http(s) 字面量拒绝
                if (seen[api]) { counts.skipped++; return; }                   // 去重按 url，先到先得
                if (counts.vod >= MAX_VOD) { counts.skipped++; return; }        // 点播上限 100
                seen[api] = 1;
                var key = prefix + djb2Hash36(api);
                merged[key] = { api: api, name: s.name || hostLabel(api) };
                if (s.detail) merged[key].detail = s.detail;
                keys.push(key);
                counts.vod++;
            });
            // 提交：先清该订阅旧导入源（更新订阅时替换而非累积），再合并新源
            clearImported(prefix);
            mergeImportedSites(merged);
            // 新导入源默认勾选
            try {
                var sel = readSelected();
                keys.forEach(function (k) { if (sel.indexOf(k) < 0) sel.push(k); });
                writeSelected(sel);
            } catch (e) {}
            items[idx].lastSync = Date.now();
            items[idx].failStreak = 0;
            items[idx].paused = false;
            items[idx].counts = counts;
            save(items);
            setStatus('已同步 ' + counts.vod + ' 个点播源');
            refreshUI();
            return counts.vod;
        }, function (err) {
            return recordFailure(items, idx, !!(err && err.transient)); // 直连与代理都失败
        });
    }

    // 手动「刷新全部」= autoRefresh 的强制版：忽略到期/周期判断，对启用订阅同步；
    // 仍遵守并发 2、单次最多 5，不拖慢搜索。汇总结果写入 status（不暴露上游 URL）。
    // 暂停口径折中（与 autoRefresh 一致）：默认跳过连续失败被 paused 的订阅，避免继续打
    // 不可达上游；仅当 force 显式为 true 时才允许刷新 paused 订阅（用户主动强制刷新）。
    // 单个订阅的手动强制刷新走 syncOne(url,{force:true})，语义不受此过滤影响。
    function syncAll(opts) {
        var force = !!(opts && opts.force);
        var urls = list().filter(function (it) {
            return it.enabled && (force || !it.paused);
        }).map(function (it) { return it.url; }).slice(0, MAX_PER_RUN);
        return runWithConcurrency(urls, CONCURRENCY, function (u) {
            return syncOne(u, { force: force });
        }).then(function (results) {
            refreshUI();
            if (!urls.length) {
                setStatus('暂无可刷新的订阅');
            } else if (results.some(function (n) { return typeof n !== 'number' || n < 0; })) {
                setStatus('部分同步失败，请稍后重试');
            } else {
                var total = results.reduce(function (a, b) { return a + (b > 0 ? b : 0); }, 0);
                setStatus('已同步 ' + total + ' 个点播源');
            }
            render();
        });
    }

    function isDue(it) {
        if (it.refreshDays <= 0) return false;
        if (!it.lastSync) return true;
        return (Date.now() - it.lastSync) >= it.refreshDays * DAY_MS;
    }
    // force=true 时直接走 syncAll（手动「刷新全部」，不受幂等锁限制）；
    // 否则：打开站点时检查一次——仅到期、启用、未暂停的订阅；页面不可见/离线跳过；静默不阻塞首屏。
    function autoRefresh(opts) {
        if (opts && opts.force) return syncAll({ force: true });
        if (_autoStarted) return;
        var doc = g.document;
        if (doc && doc.hidden) return;                       // 不可见跳过（不置锁，允许稍后重试）
        if (g.navigator && g.navigator.onLine === false) return;
        _autoStarted = true;
        schedule(function () {
            var d = g.document;
            if (d && d.hidden) { _autoStarted = false; return; }
            if (g.navigator && g.navigator.onLine === false) { _autoStarted = false; return; }
            var due = list().filter(function (it) {
                return it.enabled && it.refreshDays > 0 && !it.paused && isDue(it);
            }).slice(0, MAX_PER_RUN);
            if (!due.length) return;
            runWithConcurrency(due.map(function (it) { return it.url; }), CONCURRENCY, function (u) {
                return syncOne(u, {});
            });
        });
    }

    // ===================== CRUD =====================
    function add(rawUrl, name) {
        var url = normalizeUrl(rawUrl);
        if (!isPublicHttp(url)) return false;               // 校验 ^https?:// 且拒绝私网字面量
        var arr = readRaw();
        if (findIndex(arr, url) >= 0) return false;         // 去重
        arr.push({
            url: url,
            name: name ? String(name).trim().slice(0, 60) : hostLabel(url),
            enabled: true,
            refreshDays: 0,                                 // 默认纯手动，不自动刷新
            lastSync: 0,
            failStreak: 0,
            paused: false,
            counts: { vod: 0, live: 0, skipped: 0 }
        });
        save(arr);
        setStatus('已添加订阅，默认不自动刷新');          // 操作结果不暴露订阅（上游）URL
        render();
        return true;
    }
    function remove(url) {
        var arr = readRaw();
        var i = findIndex(arr, url);
        if (i < 0) return false;
        arr.splice(i, 1);
        save(arr);
        clearImported(subPrefix(url));                     // 按前缀整体移除该订阅导入的源，保留手动源
        setStatus('已移除订阅');
        refreshUI();
        return true;
    }
    function setRefreshDays(url, days) {
        var d = Number(days);
        if (VALID_DAYS.indexOf(d) < 0) d = 0;
        var arr = readRaw(), i = findIndex(arr, url);
        if (i < 0) return false;
        arr[i].refreshDays = d;
        arr[i].failStreak = 0;                              // 改周期重置熔断
        arr[i].paused = false;
        save(arr);
        setStatus('已更新刷新周期');
        render();
        return true;
    }
    function setEnabled(url, bool) {
        var arr = readRaw(), i = findIndex(arr, url);
        if (i < 0) return false;
        arr[i].enabled = !!bool;
        save(arr);
        setStatus(arr[i].enabled ? '已启用订阅' : '已停用订阅');
        render();
        return true;
    }
    function resume(url) {
        var arr = readRaw(), i = findIndex(arr, url);
        if (i < 0) return false;
        arr[i].failStreak = 0;
        arr[i].paused = false;
        save(arr);
        setStatus('已恢复订阅');
        render();
        return true;
    }

    // ===================== 渲染 / 状态 =====================
    function setStatus(text) {
        _status = text || '';
        var el = getEl('wdtvSubscriptionStatus');
        if (el) { try { el.textContent = _status; } catch (e) {} }
    }
    function renderItem(it) {
        var u = esc(it.url), n = esc(it.name || '订阅');
        var days = VALID_DAYS.map(function (d) {
            return '<option value="' + d + '"' + (it.refreshDays === d ? ' selected' : '') + '>' +
                (d === 0 ? '不自动刷新' : d + ' 天') + '</option>';
        }).join('');
        var cnt = it.counts || {};
        var meta = '源 ' + (cnt.vod || 0) + (cnt.live ? ' · 直播 ' + cnt.live : '') +
            (it.lastSync ? ' · 上次 ' + new Date(it.lastSync).toLocaleString() : ' · 未同步');
        var state = it.paused ? ' · 已暂停（连续失败）' : (it.enabled ? '' : ' · 已停用');
        // 普通 <div> 结构即可，外观由 index.html 的 #wdtvSubscriptionList > div / button / select 承载；
        // 条目 div 与内部控件都带 data-sub-url，供 app.js 的 document 事件委托定位。
        return '<div data-sub-url="' + u + '">' +
            '<span>' + n + '<br>' + meta + state + '</span>' +
            '<span>' +
            '<select data-sub-action="days" data-sub-url="' + u + '">' + days + '</select>' +
            '<button type="button" data-sub-action="toggle" data-sub-url="' + u + '">' + (it.enabled ? '停用' : '启用') + '</button>' +
            (it.paused ? '<button type="button" data-sub-action="resume" data-sub-url="' + u + '">恢复</button>' : '') +
            '<button type="button" data-sub-action="refresh" data-sub-url="' + u + '">刷新</button>' +
            '<button type="button" data-sub-action="remove" data-sub-url="' + u + '">移除</button>' +
            '</span></div>';
    }
    function render() {
        var items = list();
        var box = getEl('wdtvSubscriptionList');
        if (box) {
            try {
                box.innerHTML = items.length
                    ? items.map(renderItem).join('')
                    : '<div>暂无订阅，粘贴订阅地址后点「订阅 / 刷新」。</div>';
            } catch (e) {}
        }
        var st = getEl('wdtvSubscriptionStatus');
        if (st) {
            try { st.textContent = _status || (items.length ? '共 ' + items.length + ' 个订阅' : '未添加订阅'); } catch (e) {}
        }
    }

    // 导出当前点播源为 LibreTV-SourceList v2 结构（供「导出数据源」按钮 JSON.stringify 后下载）
    function exportAll() {
        var sources = [];
        try {
            Object.keys(g.API_SITES || {}).forEach(function (k) {
                var s = g.API_SITES[k];
                if (!s || !s.api) return;
                sources.push({ name: s.name || k, url: s.api, detail: s.detail || '', isAdult: false });
            });
        } catch (e) {}
        return { name: 'WDTV 数据源导出', version: 2, sources: sources, liveSources: [] };
    }

    // ===================== 导出 =====================
    g.WDTVSourceSubscriptions = {
        list: list,
        add: add,
        remove: remove,
        setRefreshDays: setRefreshDays,
        setEnabled: setEnabled,
        resume: resume,
        syncOne: syncOne,
        syncAll: syncAll,
        autoRefresh: autoRefresh,
        exportAll: exportAll,
        render: render,
        setStatus: setStatus,
        // 纯函数暴露给零依赖自测（不改变公开语义）
        _internals: {
            stripJSONC: stripJSONC,
            sniff: sniff,
            isBlockedLiteral: isBlockedLiteral,
            isPublicHttp: isPublicHttp,
            withCacheBuster: withCacheBuster,
            hourStamp: hourStamp,
            djb2Hash36: djb2Hash36,
            subPrefix: subPrefix
        }
    };

    // 兜底：app.js 会显式调用 render() + autoRefresh()；若某页面未接入，模块在 DOMContentLoaded 后
    // 自行触发一次（幂等锁保证与 app.js 的调用不重复）。document 事件委托不在此注册，由 app.js 统一绑定。
    try {
        if (g.document && typeof g.document.addEventListener === 'function') {
            g.document.addEventListener('DOMContentLoaded', function () { autoRefresh(); });
        }
    } catch (e) {}
})(typeof window !== 'undefined' ? window : globalThis);
