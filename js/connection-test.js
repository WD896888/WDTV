/**
 * 视频源连接测试模块 v2
 *
 * 测试维度与真实使用链路对齐：
 *  1) 搜索接口：直连 + 本地代理双路径各测一次（真实搜索为直连优先、失败回退代理）
 *  2) 详情接口：按 config.js 各源 detailMode 配置测试（api=标准接口 / html=详情页解析 / auto=双路径），
 *     用于暴露"搜索正常但详情拿不到集数"的源站劣化（反爬页 / 5xx 等）
 *  3) 判定收紧：HTTP 200 但返回 HTML/风控页、无 list 数组的错误体、可提取集数为 0 → 判失败
 *  4) 超时/网络错误自动重试 1 次（HTTP 状态码错误不重试，重试无意义）
 *  5) 测试结果写入源健康度（与 search.js 的"失败源延后发起"策略联动）
 */

(function () {
    'use strict';

    // 代理路径单请求超时（代理函数冷启动 + 源站响应，给足余量）
    const PROXY_TIMEOUT = 12000;
    // 直连路径单请求超时（与真实详情直连预算 4s 接近，给点余量）
    const DIRECT_TIMEOUT = 6000;
    // 最大并发测试数（避免瞬间打满全部源导致代理限流互相干扰）
    const MAX_CONCURRENT = 3;
    // 测试用的搜索关键词（真实高频词，避免超短词触发风控或空结果）
    const TEST_QUERY = '爱情';
    // 超时/网络错误自动重试 1 次
    const RETRY_ONCE = true;

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
        return parts.length ? parts : [String(err)];
    }

    // 诊断 fetch 阶段抛出的异常类型，给出可读结论
    function classifyFetchError(err) {
        if (err && err.name === 'AbortError') {
            return '请求超时';
        }
        if (err && err.name === 'TypeError' && /failed|network|load/i.test(err.message || '')) {
            return '浏览器无法建立网络连接（可能：站点不可达 / DNS 解析失败 / 被拦截）';
        }
        return '请求过程中发生异常: ' + (err && err.message || err);
    }

    // 带重试的 fetch：仅超时/网络异常重试 1 次（HTTP 状态码错误不重试）
    // 成功返回 { resp, elapsed, retried }；重试耗尽后 throw { err, elapsed, retried }
    async function fetchWithRetry(url, options, timeoutMs) {
        const maxAttempt = RETRY_ONCE ? 1 : 0;
        let lastErr = null;
        let lastElapsed = 0;
        for (let attempt = 0; attempt <= maxAttempt; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            const startedAt = performance.now();
            try {
                const resp = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
                clearTimeout(timer);
                return { resp, elapsed: Math.round(performance.now() - startedAt), retried: attempt > 0 };
            } catch (err) {
                clearTimeout(timer);
                lastErr = err;
                lastElapsed = Math.round(performance.now() - startedAt);
                const retryable = err && (err.name === 'AbortError' || err instanceof TypeError);
                if (!retryable || attempt === maxAttempt) {
                    throw { err: lastErr, elapsed: lastElapsed, retried: attempt > 0 };
                }
            }
        }
        // 理论不可达
        throw { err: lastErr, elapsed: lastElapsed, retried: true };
    }

    // 搜索响应统一判定（收紧版）：
    //   'ok'    —— HTTP 2xx + 合法 JSON + list 为非空数组
    //   'empty' —— HTTP 2xx + 合法 JSON + list 为空数组（连通但无结果）
    //   'fail'  —— 非 2xx / 响应非 JSON（风控页、跳转页）/ JSON 无 list 数组（含 code 错误体）
    function judgeSearchResponse(resp, body) {
        if (!resp.ok) return { verdict: 'fail', detail: `HTTP ${resp.status} ${resp.statusText || ''}` };
        let json = null;
        try {
            json = body ? JSON.parse(body) : null;
        } catch (e) {
            const head = (body || '').replace(/\s+/g, ' ').trim().substring(0, 60);
            return { verdict: 'fail', detail: `HTTP 200 但响应不是 JSON（可能为风控/跳转页）: ${head}` };
        }
        if (!json || typeof json !== 'object') {
            return { verdict: 'fail', detail: '响应体不是 JSON 对象' };
        }
        if (Array.isArray(json.list)) {
            if (json.list.length > 0) return { verdict: 'ok', json, detail: `返回 ${json.list.length} 条结果` };
            return { verdict: 'empty', json, detail: 'JSON 结构有效但结果数为 0' };
        }
        return { verdict: 'fail', detail: `JSON 结构异常（无 list 数组，code=${json.code} ${json.msg || ''}）`.trim() };
    }

    // 提取标准接口详情的集数（与 api.js fetchVideoDetailData 同逻辑）
    function extractEpisodeCount(vod) {
        if (!vod) return 0;
        let eps = [];
        if (vod.vod_play_url) {
            eps = vod.vod_play_url.split('$$$')[0].split('#').map(e => {
                const p = e.split('$');
                return p.length > 1 ? p[1] : '';
            }).filter(u => u && (u.startsWith('http://') || u.startsWith('https://')));
        }
        if (!eps.length && vod.vod_content) {
            eps = (vod.vod_content.match(/\$https?:\/\/[^"'\s]+?\.m3u8/g) || []).map(l => l.slice(1));
        }
        return eps.length;
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

    // 返回 { key, ok, searchOk, detailOk, ms, html }（detailOk: true/false/null=未测）
    async function testSource(key) {
        const api = API_SITES[key];
        const name = api ? api.name : key;
        const detailMode = (api && api.detailMode) || 'api';
        const searchUrl = `${api.api}${API_CONFIG.search.path}${encodeURIComponent(TEST_QUERY)}`;

        const lines = [];
        const push = (cls, text) => lines.push(`<div class="${cls}">${esc(text)}</div>`);
        const startedAt = performance.now();

        push('conn-title', `════ [${name}]（${key}） detailMode=${detailMode} ════`);
        push('conn-meta', `时间: ${now()}`);

        let directOk = false;
        let proxyOk = false;
        let searchJson = null;

        // ===== 阶段一：搜索接口 · 直连 =====
        push('conn-step', `[搜索·直连] ${searchUrl}`);
        try {
            const { resp, elapsed, retried } = await fetchWithRetry(searchUrl, {
                headers: API_CONFIG.search.headers,
                cache: 'no-store'
            }, DIRECT_TIMEOUT);
            const body = await resp.text().catch(() => '');
            const j = judgeSearchResponse(resp, body);
            directOk = j.verdict === 'ok';
            const tag = j.verdict === 'ok' ? '✓' : (j.verdict === 'empty' ? '⚠' : '✗');
            push(j.verdict === 'ok' ? 'conn-ok' : (j.verdict === 'empty' ? 'conn-warn' : 'conn-fail'),
                `[搜索·直连] ${tag} HTTP ${resp.status} ${elapsed}ms${retried ? '（重试后）' : ''} - ${j.detail}`);
            if (j.json) searchJson = j.json;
        } catch (e) {
            push('conn-fail', `[搜索·直连] ✗ ${classifyFetchError(e.err)}（耗时 ${e.elapsed}ms${e.retried ? '，已重试' : ''}）`);
            describeError(e.err).forEach(l => push('conn-fail', `  原因 ${esc(l)}`));
        }

        // ===== 阶段一：搜索接口 · 代理 =====
        const proxiedSearchUrl = PROXY_URL + encodeURIComponent(searchUrl);
        push('conn-step', `[搜索·代理] ${proxiedSearchUrl}`);
        try {
            const { resp, elapsed, retried } = await fetchWithRetry(proxiedSearchUrl, {
                headers: API_CONFIG.search.headers,
                cache: 'no-store'
            }, PROXY_TIMEOUT);
            const body = await resp.text().catch(() => '');
            const j = judgeSearchResponse(resp, body);
            proxyOk = j.verdict === 'ok';
            const tag = j.verdict === 'ok' ? '✓' : (j.verdict === 'empty' ? '⚠' : '✗');
            push(j.verdict === 'ok' ? 'conn-ok' : (j.verdict === 'empty' ? 'conn-warn' : 'conn-fail'),
                `[搜索·代理] ${tag} HTTP ${resp.status} ${elapsed}ms${retried ? '（重试后）' : ''} - ${j.detail}`);
            if (!searchJson && j.json) searchJson = j.json;
        } catch (e) {
            push('conn-fail', `[搜索·代理] ✗ ${classifyFetchError(e.err)}（耗时 ${e.elapsed}ms${e.retried ? '，已重试' : ''}）`);
        }

        const searchOk = directOk || proxyOk;
        push(searchOk ? 'conn-ok' : 'conn-fail',
            `[搜索小结] 直连${directOk ? '✓' : '✗'} / 代理${proxyOk ? '✓' : '✗'} → ${searchOk ? '搜索可用' + (directOk ? '' : '（将走代理）') : '搜索不可用'}`);

        // ===== 阶段二：详情链路（按 detailMode 配置；搜索拿到结果才测）=====
        let detailOk = null; // null=未测/跳过

        if (searchJson && Array.isArray(searchJson.list) && searchJson.list.length > 0) {
            const vodId = String(searchJson.list[0].vod_id || '');
            push('conn-meta', `[详情测试] 使用搜索结果首个 vod_id=${vodId}（detailMode=${detailMode}）`);

            // --- A) 标准接口详情（'api' / 'auto'；复刻真实链路：直连优先，失败回退代理）---
            if (detailMode === 'api' || detailMode === 'auto') {
                const dUrl = `${api.api}${API_CONFIG.detail.path}${vodId}`;
                let ok = false;
                let note = '';
                // 直连
                try {
                    const { resp, elapsed, retried } = await fetchWithRetry(dUrl, {
                        headers: API_CONFIG.detail.headers,
                        cache: 'no-store'
                    }, DIRECT_TIMEOUT);
                    const jd = await resp.json().catch(() => null);
                    if (resp.ok && jd && Array.isArray(jd.list) && jd.list.length > 0) {
                        const eps = extractEpisodeCount(jd.list[0]);
                        ok = eps > 0;
                        note = ok ? `✓ 直连 HTTP ${resp.status} ${elapsed}ms，可提取 ${eps} 集`
                                  : `✗ 接口返回数据但无法提取集数（play_url 为空）`;
                    } else if (resp.ok) {
                        note = `✗ 直连 HTTP ${resp.status}，返回 list 为空或结构异常`;
                    } else {
                        note = `✗ 直连 HTTP ${resp.status}`;
                    }
                } catch (e) {
                    note = `✗ 直连 ${classifyFetchError(e.err)}（${e.elapsed}ms）`;
                }
                // 直连未拿到 → 代理（与真实 fetchDetailData 行为一致）
                if (!ok) {
                    try {
                        const { resp, elapsed, retried } = await fetchWithRetry(PROXY_URL + encodeURIComponent(dUrl), {
                            headers: API_CONFIG.detail.headers,
                            cache: 'no-store'
                        }, PROXY_TIMEOUT);
                        const jd = await resp.json().catch(() => null);
                        if (resp.ok && jd && Array.isArray(jd.list) && jd.list.length > 0) {
                            const eps = extractEpisodeCount(jd.list[0]);
                            ok = eps > 0;
                            note = ok ? `✓ 代理 HTTP ${resp.status} ${elapsed}ms，可提取 ${eps} 集`
                                      : `✗ 代理返回数据但无法提取集数（play_url 为空）`;
                        } else if (resp.ok) {
                            note = `✗ 代理 HTTP ${resp.status}，返回 list 为空或结构异常`;
                        } else {
                            note = `✗ 代理 HTTP ${resp.status}`;
                        }
                    } catch (e) {
                        note += `；✗ 代理 ${classifyFetchError(e.err)}`;
                    }
                }
                push(ok ? 'conn-ok' : 'conn-fail', `[详情·标准接口] ${note}`);
                if (ok) detailOk = true;
                else if (detailOk === null) detailOk = false;
            }

            // --- B) 详情页 HTML 解析（'html' / 'auto'；真实链路仅走代理）---
            if ((detailMode === 'html' || detailMode === 'auto') && api.detail) {
                const hUrl = `${api.detail}/index.php/vod/detail/id/${vodId}.html`;
                let ok = false;
                let note = '';
                try {
                    const { resp, elapsed, retried } = await fetchWithRetry(PROXY_URL + encodeURIComponent(hUrl), {
                        headers: API_CONFIG.detail.headers,
                        cache: 'no-store'
                    }, PROXY_TIMEOUT);
                    const body = await resp.text().catch(() => '');
                    if (resp.ok) {
                        const m = body.match(/\$https?:\/\/[^"'\s]+?\.m3u8/g) || [];
                        ok = m.length > 0;
                        note = ok ? `✓ 代理 HTTP ${resp.status} ${elapsed}ms，正则提取 ${m.length} 个 m3u8`
                                  : `✗ HTTP ${resp.status} 但页面无 m3u8 特征（可能被反爬验证页拦截），正文 ${body.length}B`;
                    } else {
                        note = `✗ HTTP ${resp.status}`;
                    }
                } catch (e) {
                    note = `✗ ${classifyFetchError(e.err)}`;
                }
                push(ok ? 'conn-ok' : 'conn-fail', `[详情·页面解析] ${note}`);
                if (ok) detailOk = true;
                else if (detailOk === null) detailOk = false;
            }
        } else {
            push('conn-warn', `[详情测试] 搜索无结果，跳过详情链路测试`);
        }

        // ===== 结果汇总与源健康度联动 =====
        if (typeof window.markSourceHealth === 'function') {
            window.markSourceHealth(key, searchOk);
        }

        const elapsedTotal = Math.round(performance.now() - startedAt);
        push('conn-meta', `[本源结论] 搜索:${searchOk ? '可用' : '不可用'}  详情:${detailOk === null ? '未测' : (detailOk ? '可用' : '不可用')}  总耗时 ${elapsedTotal}ms`);

        return { key, ok: searchOk, searchOk, detailOk, ms: elapsedTotal, html: lines.join('') };
    }

    // ---------- 串联并发池 ----------

    async function runPool(keys, worker) {
        const total = keys.length;
        let idx = 0;
        const results = new Array(total);

        async function nextSlot() {
            while (idx < total) {
                const i = idx++;
                const key = keys[i];
                const api = API_SITES[key];
                append(`<div class="conn-step">⏳ 正在测试 [${esc(api ? api.name : key)}]（${i + 1}/${total}）…</div>`);
                const r = await worker(key);
                results[i] = r;
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
        append(`<div class="conn-meta">共 ${keys.length} 个源 | 并发 ${MAX_CONCURRENT} | 搜索词 "${TEST_QUERY}" | 测试项: 搜索（直连+代理）、详情（按各源 detailMode） | 开始时间 ${now()}</div>`);

        const results = await runPool(keys, testSource);

        const searchOkList = results.filter(r => r && r.searchOk);
        const searchFail = results.filter(r => r && !r.searchOk);
        const detailTested = results.filter(r => r && r.detailOk !== null);
        const detailOkList = detailTested.filter(r => r.detailOk);
        const detailBad = detailTested.filter(r => !r.detailOk);

        append(`<div class="conn-title">——— 测试结束 ———</div>`);
        append(`<div class="${searchOkList.length === keys.length ? 'conn-ok' : 'conn-fail'}">汇总: 搜索可用 ${searchOkList.length}/${keys.length} 个源</div>`);
        if (detailTested.length) {
            append(`<div class="${detailBad.length ? 'conn-warn' : 'conn-ok'}">详情链路: ${detailOkList.length}/${detailTested.length} 个已测源可提取集数</div>`);
        }
        if (searchFail.length) {
            append(`<div class="conn-fail">搜索失败源: ${searchFail.map(f => API_SITES[f.key].name || f.key).join('、')}</div>`);
        }
        if (detailBad.length) {
            append(`<div class="conn-warn">⚠ 搜索可用但详情拿不到集数（点击详情会无集数）: ${detailBad.map(f => API_SITES[f.key].name || f.key).join('、')}</div>`);
            append(`<div class="conn-step">此类源建议调整 config.js 中对应源的 detailMode 配置（如由 'html' 改 'api'）。</div>`);
        }
        append(`<div class="conn-meta">提示：直连✗ 代理✓ 表示源站对本机直连做了限制，搜索会自动走代理，不影响使用；两者都✗ 通常表示源已失效。测试结果已写入源健康度，失败源在搜索时会自动延后。</div>`);
        append(`<div class="conn-meta">全部测试完成 | 结束时间 ${now()}</div>`);
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
