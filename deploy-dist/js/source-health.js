// ============================================================
// WDTV 源健康度「阶梯停用」状态机（window.SourceHealth）
// - 复用既有 localStorage 键 wdtvSourceHealth，不新增键、不进云同步
// - 零依赖普通 script（IIFE + window.*），浏览器与 Node 自测均可引用
// - 设计原则：任何存储异常都静默降级为「未停用」，绝不影响搜索
// - 读-改-写在同一个同步函数内完成，避免同一次搜索多源并发写互相覆盖
// ============================================================
(function (g) {
    'use strict';

    // 与 api.js 保持一致的既有键
    var STORAGE_KEY = 'wdtvSourceHealth';
    // 连续失败达到该次数即触发一次停用升档
    var SOURCE_DISABLE_THRESHOLD = 2;
    // 阶梯时长：第一次 30 分钟、第二次 24 小时，超出阶梯进入长期停用
    var SOURCE_DISABLE_LADDER = [30 * 60 * 1000, 24 * 60 * 60 * 1000];
    // 超过 7 天未更新的记录惰性清理，避免存储无限膨胀
    var STALE_CLEAN_MS = 7 * 24 * 60 * 60 * 1000;

    function now() { return Date.now(); }

    // 读原始存储对象；解析失败 / 存储不可用一律返回 {}
    function readRaw() {
        try {
            var raw = g.localStorage.getItem(STORAGE_KEY);
            var obj = raw ? JSON.parse(raw) : {};
            return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
        } catch (e) {
            return {};
        }
    }

    // 写回存储；顺带清理 7 天未更新的条目；任何异常静默
    function writeRaw(health) {
        try {
            var t = now();
            Object.keys(health).forEach(function (id) {
                var e = health[id];
                // ts 缺失（迁移值 0）不清理，避免误删旧数据；
                // permanent:true 的长期停用记录不受惰性清理影响，必须保留到手动 resume。
                if (e && e.permanent !== true && typeof e.ts === 'number' && e.ts > 0 && (t - e.ts) > STALE_CLEAN_MS) {
                    delete health[id];
                }
            });
            g.localStorage.setItem(STORAGE_KEY, JSON.stringify(health));
        } catch (e) { /* 存储失败不影响请求 */ }
    }

    // 单条记录迁移：补齐新字段。旧数据（只有 ok/ts/direct/dts）绝不产生停用态。
    // 迁移仅在内存中补齐，读路径不写回，避免旧数据被误判停用或抛错。
    function normalize(entry) {
        var e = {};
        if (entry && typeof entry === 'object') {
            Object.keys(entry).forEach(function (k) { e[k] = entry[k]; });
        }
        if (typeof e.ok !== 'number') e.ok = 1;
        if (typeof e.ts !== 'number') e.ts = 0;
        // 新字段缺失时按 ok 初始化：ok===0 视为已有 1 次失败，否则 0
        if (typeof e.failCount !== 'number' || !isFinite(e.failCount) || e.failCount < 0) {
            e.failCount = (e.ok === 0) ? 1 : 0;
        }
        if (typeof e.tier !== 'number' || !isFinite(e.tier) || e.tier < 0) e.tier = 0;
        if (typeof e.disabledUntil !== 'number' || !isFinite(e.disabledUntil) || e.disabledUntil < 0) {
            e.disabledUntil = 0;
        }
        e.permanent = (e.permanent === true);
        return e;
    }

    // 记录一次整源请求成败：
    //   成功 —— 清失败计数与停用态，tier 降一级
    //   失败 —— 累计失败次数，达阈值按当前 tier 升档停用（阶梯时长 / 长期停用）
    // 对齐 LibreTV src/lib/store.ts recordSourceHealth：每次用「新 entry」覆盖旧记录，
    // 停用态字段按需重建（不无条件继承旧 disabledUntil / permanent）。否则停用期满后
    // 残留的过期截止时间会让 interrupted 恒为 true，连击永远无法重新达到阈值升档。
    function record(apiId, ok) {
        if (!apiId) return status(apiId);
        var health = readRaw();            // 读
        var prev = normalize(health[apiId]); // 迁移后的旧记录，仅用于读取连击/等级/停用态
        var t = now();
        var e = {};
        Object.keys(prev).forEach(function (k) { e[k] = prev[k]; });
        e.ts = t;
        e.disabledUntil = 0;              // 默认清除旧停用态，下面按分支决定是否恢复/设置
        e.permanent = false;
        if (ok) {
            e.ok = 1;
            e.failCount = 0;
            e.tier = Math.max(0, prev.tier - 1); // 成功降一级
        } else {
            e.ok = 0;
            // interrupted：停用期已满（连击被「停用 + 恢复」打断）→ failCount 从 1 重新计数；
            // 否则沿用旧连击 +1。对齐 LibreTV store.ts:717-718。
            var interrupted = prev.disabledUntil > 0 && prev.disabledUntil <= t;
            e.failCount = interrupted ? 1 : prev.failCount + 1;
            e.tier = prev.tier;           // 失败不自动升 tier，仅在升档分支 +1
            if (e.failCount >= SOURCE_DISABLE_THRESHOLD) {
                // alreadyDisabled：已长期停用或仍在停用期内 → 保持原等级/截止时间/permanent，
                // 不再升档。正常调用方会跳过停用源，此处仅作防御（connection-test.js 手动
                // 测试停用源会触发）。对齐 LibreTV store.ts:735-740。
                var alreadyDisabled = prev.permanent === true || prev.disabledUntil > t;
                if (alreadyDisabled) {
                    e.tier = prev.tier;
                    e.disabledUntil = prev.disabledUntil;
                    e.permanent = prev.permanent;
                } else if (e.tier < SOURCE_DISABLE_LADDER.length) {
                    e.disabledUntil = t + SOURCE_DISABLE_LADDER[e.tier];
                    e.tier = e.tier + 1;
                } else {
                    e.disabledUntil = 0;
                    e.permanent = true;
                    e.tier = e.tier + 1;
                }
            }
        }
        health[apiId] = e;
        writeRaw(health);                  // 改 + 写（同一同步块）
        return status(apiId);
    }

    // 是否已被停用（含长期停用）；停用期满自动视为未停用；异常降级为 false
    function isDisabled(apiId) {
        if (!apiId) return false;
        try {
            var e = normalize(readRaw()[apiId]);
            if (e.permanent) return true;
            return e.disabledUntil > now();
        } catch (err) {
            return false;
        }
    }

    // 供 UI 使用的状态快照
    // remainingMs：临时停用为剩余毫秒，长期停用为 -1，未停用为 0
    function status(apiId) {
        var e = normalize(readRaw()[apiId]);
        var t = now();
        var disabled = false;
        var until = 0;
        var remainingMs = 0;
        if (e.permanent) {
            disabled = true;
            remainingMs = -1;
        } else if (e.disabledUntil > t) {
            disabled = true;
            until = e.disabledUntil;
            remainingMs = e.disabledUntil - t;
        }
        return {
            disabled: disabled,
            until: until,
            tier: e.tier,
            failCount: e.failCount,
            permanent: e.permanent,
            remainingMs: remainingMs
        };
    }

    // 手动恢复：清所有停用态与失败计数，tier 归零
    function resume(apiId) {
        if (!apiId) return status(apiId);
        var health = readRaw();
        var e = normalize(health[apiId]);
        var t = now();
        e.ok = 1;
        e.ts = t;
        e.failCount = 0;
        e.tier = 0;
        e.disabledUntil = 0;
        e.permanent = false;
        e.manualResumeAt = t;
        health[apiId] = e;
        writeRaw(health);
        return status(apiId);
    }

    // 读取全部记录（每条做内存迁移，返回副本，不写回）
    function readAll() {
        var health = readRaw();
        var out = {};
        try {
            Object.keys(health).forEach(function (id) { out[id] = normalize(health[id]); });
        } catch (e) {
            return {};
        }
        return out;
    }

    // 清除某个源的全部健康记录
    function clear(apiId) {
        if (!apiId) return;
        var health = readRaw();
        if (Object.prototype.hasOwnProperty.call(health, apiId)) {
            delete health[apiId];
            writeRaw(health);
        }
    }

    // ============================================================
    // 导出
    // ============================================================
    g.SourceHealth = {
        SOURCE_DISABLE_THRESHOLD: SOURCE_DISABLE_THRESHOLD,
        SOURCE_DISABLE_LADDER: SOURCE_DISABLE_LADDER,
        STALE_CLEAN_MS: STALE_CLEAN_MS,
        record: record,
        isDisabled: isDisabled,
        status: status,
        resume: resume,
        readAll: readAll,
        clear: clear
    };
})(typeof window !== 'undefined' ? window : globalThis);
