/**
 * 视频源连接测试模块
 *
 * 功能：在设置面板中一键测试所有视频源（API_SITES）的连接情况。
 * 通过本地代理 /proxy/ 逐源发起真实的搜索 API 请求，完整记录每一阶段的
 * 日志（目标地址、代理地址、鉴权、请求耗时、HTTP 状态、底层错误原因等），
 * 保证仅凭日志即可判断设备无法连接的具体原因。
 */

(function () {
    'use strict';

    // 单源请求超时时间（毫秒）
    const CONN_TIMEOUT = 12000;
    // 最大并发测试数（窗口有限，避免瞬间打满全部源）
    const MAX_CONCURRENT = 3;
    // 测试用的搜索关键词（只关心连通性，不关心返回内容）
    const TEST_QUERY = 'a';

    // ---------- 工具函数 ----------

    function now() {
        return new Date().toLocaleString('zh-CN', { hour12: false });
    }

    // HTML 转义，防止源名 / URL / 错误消息破坏日志布局
    function esc(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // 递归展开错误及其 cause 链，得到可供阅读的多级原因
    function describeError(err) {
        const parts = [];
        let current = err;
        let depth = 0;
        while (current && depth < 6) {
            const bits = [];
            if (current.name) bits.push(current.name);
            if (current.syscall) bits.push('syscall=' + current.syscall);
            if (current.code) bits.push('code=' + current.code);
            if (current.errno !== undefined && current.errno !== null) bits.push('errno=' + current.errno);
            if (current.hostname) bits.push('host=' + current.hostname);
            if (current.address) bits.push('addr=' + current.address);
            if (current.port) bits.push('port=' + current.port);
            const msg = current.message || String(current);
            if (bits.indexOf(msg) === -1) bits.push(msg);
            parts.push(bits.join('  '));
            current = current.cause;
            depth++;
        }
        // 当消息是笼统的 "fetch failed" 时追加提示
        return parts.length ? parts : [String(err)];
    }

    // 诊断 fetch 阶段抛出的异常类型，给出可读结论
    function classifyFetchError(err) {
        if (err && err.name === 'AbortError') {
            return '请求超时（CONN_TIMEOUT=' + CONN_TIMEOUT + 'ms）';
        }
        if (err && err.name === 'TypeError' && /failed|network|load/i.test(err.message || '')) {
            return '浏览器无法建立网络连接（可能：站点不可达 / DNS 解析失败 / 被拦截 / 代理未部署）';
        }
        return '请求过程中发生异常';
    }

    // ---------- DOM 日志渲染 ----------

    function logBox() {
        return document.getElementById('connectionLog');
    }

    function append(html) {
        const box = logBox();
        if (!box) return;
        const div = document.createElement('div');
        div.innerHTML = html;
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
    }

    // ---------- 单源测试 ----------

    // 返回 { key, ok, ms, html, tailHtml }
    async function testSource(key) {
        const api = API_SITES[key];
        const name = api ? api.name : key;
        const apiUrl = `${api.api}${API_CONFIG.search.path}${encodeURIComponent(TEST_QUERY)}`;

        const lines = [];
        const push = (cls, text) => lines.push(`<div class="${cls}">${esc(text)}</div>`);

        push('conn-title', `════ [${name}]（${key}）════`);
        push('conn-meta', `时间: ${now()}`);
        push('conn-meta', `测试方式: 通过本地代理请求搜索接口（${API_CONFIG.search.path}）`);
        push('conn-meta', `目标API地址: ${apiUrl}`);

        // 生成代理地址
        const proxiedUrl = PROXY_URL + encodeURIComponent(apiUrl);
        push('conn-step', `代理地址: ${proxiedUrl}`);

        // 发起请求
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CONN_TIMEOUT);
        const startedAt = performance.now();
        let result;

        try {
            const resp = await fetch(proxiedUrl, {
                headers: API_CONFIG.search.headers,
                signal: controller.signal,
                cache: 'no-store' // 连接测试必须绕过本地缓存
            });
            const elapsed = Math.round(performance.now() - startedAt);
            push('conn-step', `[请求] 代理已响应，HTTP 状态 ${resp.status} ${resp.statusText || ''}，耗时 ${elapsed}ms`);

            const body = await resp.text().catch(() => '');
            const ctype = (resp.headers.get('content-type') || '未知').split(';')[0];
            push('conn-meta', `Content-Type: ${ctype}`);

            if (resp.ok) {
                // 尝试解析 JSON，进一步校验数据格式是否合法
                try {
                    const json = body ? JSON.parse(body) : null;
                    const isOkShape = json && (Array.isArray(json.list) || json.code !== undefined);
                    if (isOkShape) {
                        const len = Array.isArray(json.list) ? json.list.length : 0;
                        push('conn-ok', `[校验] JSON 解析成功，返回条目数 ${len}`);
                    } else {
                        push('conn-warn', `[校验] 返回结构异常（未包含 list/code 字段），响应体前 200 字: ${body.substring(0, 200)}`);
                    }
                } catch (parseErr) {
                    push('conn-warn', `[校验] 响应不是有效 JSON（可能被反代/防火墙改写）: ${describeError(parseErr).join(' / ')}`);
                    push('conn-step', `[校验] 响应体前 ${Math.min(200, body.length)} 字节: ${body.substring(0, 200)}`);
                }
                result = { key, ok: true, ms: elapsed, html: lines.join('') };
            } else {
                // 尝试解析代理返回的错误体
                let proxyMsg = '';
                let details = '';
                try {
                    const errJson = JSON.parse(body);
                    proxyMsg = errJson.error || '';
                    details = (errJson.details && errJson.details.join) ? errJson.details.join('  →  ') : (errJson.details || '');
                } catch (_) {
                    proxyMsg = body.length ? body.substring(0, 300) : '(无错误信息返回)';
                }
                push('conn-fail', `[结果] 代理返回错误状态 ${resp.status}`);
                if (proxyMsg) push('conn-fail', `  代理错误信息: ${proxyMsg}`);
                if (details) push('conn-fail', `  底层详细原因: ${details}`);
                result = { key, ok: false, ms: elapsed, html: lines.join('') };
            }
        } catch (fetchErr) {
            clearTimeout(timer);
            const elapsed = Math.round(performance.now() - startedAt);
            push('conn-fail', `[请求] 异常（耗时 ${elapsed}ms）: ${classifyFetchError(fetchErr)}`);
            const chain = describeError(fetchErr);
            chain.forEach(line => push('conn-fail', `  原因 ${esc(line)}`));
            result = { key, ok: false, ms: elapsed, html: lines.join('') };
        } finally {
            clearTimeout(timer);
        }

        result.html = lines.join('');
        return result;
    }

    // ---------- 串联并发池 ----------

    async function runPool(keys, worker) {
        const total = keys.length;
        let idx = 0;
        let done = 0;
        const results = new Array(total);

        async function nextSlot() {
            while (idx < total) {
                const i = idx++;
                const key = keys[i];
                // 先输出占位日志，提示正在测试
                const api = API_SITES[key];
                append(`<div class="conn-step">⏳ 正在测试 [${esc(api ? api.name : key)}]（${i + 1}/${total}）…</div>`);
                const r = await worker(key);
                results[i] = r;
                done++;
                // 覆盖占位日志：追加完整结果块
                append(r.html);
            }
        }

        const workers = [];
        for (let i = 0; i < Math.min(MAX_CONCURRENT, total); i++) workers.push(nextSlot());
        await Promise.all(workers);
        return results;
    }

    // ---------- 对外接口 ----------

    window.runConnectionTest = async function () {
        const keys = Object.keys(API_SITES || {});
        if (!keys.length) {
            append('<div class="conn-fail">当前没有配置任何视频源，无法测试。</div>');
            return;
        }
        append(`<div class="conn-title">——— 连接测试开始 ———</div>`);
        append(`<div class="conn-meta">共 ${keys.length} 个源 | 并发 ${MAX_CONCURRENT} | 单源超时 ${CONN_TIMEOUT}ms | 开始时间 ${now()}</div>`);

        const results = await runPool(keys, testSource);

        const okCount = results.filter(r => r && r.ok).length;
        const fail = results.filter(r => r && !r.ok);
        const totalMs = results.reduce((s, r) => s + (r && r.ms || 0), 0);

        append(`<div class="conn-title">——— 测试结束 ———</div>`);
        append(`<div class="${okCount === keys.length ? 'conn-ok' : 'conn-fail'}">汇总: ${okCount}/${keys.length} 个源可正常连接</div>`);
        if (fail.length) {
            append(`<div class="conn-fail">连接失败源: ${fail.map(f => API_SITES[f.key].name || f.key).join('、')}</div>`);
            append(`<div class="conn-step">请展开上方对应源的日志，查看“代理错误信息 / 底层详细原因”。</div>`);
        }
        append(`<div class="conn-meta">全部测试完成 | 累计耗时（并行，非累加）参考 ${totalMs}ms | 结束时间 ${now()}</div>`);
        append('<div class="conn-meta">提示：若日志显示“fetch failed / load failed”，通常是设备到当前站点网络不通；若显示鉴权错误，请检查部署的 PASSWORD 是否与本地登录密码一致。</div>');
    };

    window.clearConnectionLog = function () {
        const box = logBox();
        if (box) box.innerHTML = '';
    };

    window.copyConnectionLog = function () {
        const box = logBox();
        if (!box) return;
        const text = box.innerText || '';
        if (!text) return;
        function done() {
            if (window.showToast) showToast('日志已复制', 'success');
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
        } else {
            fallbackCopy(text, done);
        }
    };

    function fallbackCopy(text, done) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            done();
        } catch (e) {
            if (window.showToast) showToast('复制失败，请手动复制', 'error');
        }
    }
})();