// WDTV 源健康度「阶梯停用」状态机自测（Node ESM，零依赖，不随部署）
// 风格对齐 test/ad-filter.test.mjs：自定义断言 + 失败时 process.exit(1)
// 运行：node test/source-health.test.mjs  或  node scripts/run-tests.mjs
import '../js/source-health.js';

// ---------- mock localStorage（source-health.js 顶层不读存储，静态 import 后注入即可） ----------
const store = new Map();
const goodStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    clear: () => { store.clear(); }
};

// ---------- 可控时钟：源健康度按 Date.now() 计算停用截止 ----------
const REAL_NOW = Date.now;
let fakeNow = 1700000000000;
Date.now = () => fakeNow;

function reset() {
    store.clear();
    fakeNow = 1700000000000;
    globalThis.localStorage = goodStorage;
}
function advance(ms) { fakeNow += ms; }

const SH = globalThis.SourceHealth;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
    if (cond) { pass++; console.log('  ok  ' + name); }
    else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}
function eq(actual, expected, name) {
    t(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

console.log('\n[1] 模块导出与常量');
{
    t('SourceHealth 挂到 globalThis', !!(SH && typeof SH === 'object'));
    ['record', 'isDisabled', 'status', 'resume', 'readAll', 'clear'].forEach(fn => {
        t('导出 ' + fn, typeof SH[fn] === 'function');
    });
    eq(SH.SOURCE_DISABLE_THRESHOLD, 2, 'SOURCE_DISABLE_THRESHOLD=2');
    t('阶梯=[30min,24h]',
        SH.SOURCE_DISABLE_LADDER[0] === 30 * MIN && SH.SOURCE_DISABLE_LADDER[1] === 24 * HOUR);
    eq(SH.STALE_CLEAN_MS, 7 * 24 * HOUR, 'STALE_CLEAN_MS=7d');
}

console.log('\n[2] 连续失败 2 次 → 停用 30 分钟');
{
    reset();
    SH.record('srcA', false);
    let s = SH.status('srcA');
    eq(s.disabled, false, '第 1 次失败不停用');
    eq(s.failCount, 1, '第 1 次失败 failCount=1');
    SH.record('srcA', false);
    s = SH.status('srcA');
    eq(s.disabled, true, '连续失败 2 次应停用');
    eq(s.permanent, false, '非长期停用');
    eq(s.tier, 1, 'tier=1');
    t('剩余约 30 分钟', s.remainingMs > 29 * MIN && s.remainingMs <= 30 * MIN, `remainingMs=${s.remainingMs}`);
    eq(SH.isDisabled('srcA'), true, 'isDisabled=true');
}

console.log('\n[3] 停用期满自动恢复');
{
    reset();
    SH.record('srcA', false);
    SH.record('srcA', false);
    eq(SH.isDisabled('srcA'), true, '停用中');
    advance(30 * MIN + 1000);
    eq(SH.isDisabled('srcA'), false, '超过 30 分钟自动恢复');
    eq(SH.status('srcA').remainingMs, 0, 'remainingMs=0');
}

// 阶梯语义（对齐 LibreTV store.ts:717-718 / 735-740）：
// 每上升一档，都必须经历「停用期满 + 重新连续失败 2 次」；停用期内再失败不升档。
// 这样偶发抖动的源不会被连接测试的连续点击一路推到 permanent。
function driveUpOneTier(id, afterMs) {
    advance(afterMs);
    SH.record(id, false);   // 期满后第 1 次：interrupted → 连击重置为 1，给宽限
    SH.record(id, false);   // 第 2 次：才升档
}

console.log('\n[4] 停用期满后重新累计 2 次失败 → 24 小时；停用期内失败不升档');
{
    reset();
    SH.record('srcB', false);
    SH.record('srcB', false);                 // tier=1 / 30min
    advance(30 * MIN + 1000);
    SH.record('srcB', false);                 // 期满第 1 次：给宽限
    const mid = SH.status('srcB');
    eq(mid.disabled, false, '期满后第 1 次失败不立刻停用');
    eq(mid.failCount, 1, '期满后连击重置为 1');
    eq(mid.tier, 1, '仍停留在 tier=1');
    SH.record('srcB', false);                 // 第 2 次 → tier=2 / 24h
    const s = SH.status('srcB');
    eq(s.disabled, true, '仍停用');
    eq(s.permanent, false, '非长期停用');
    eq(s.tier, 2, 'tier=2');
    t('剩余约 24 小时', s.remainingMs > 23 * HOUR && s.remainingMs <= 24 * HOUR, `remainingMs=${s.remainingMs}`);
    SH.record('srcB', false);                 // alreadyDisabled 防御
    eq(SH.status('srcB').tier, 2, '停用期内继续失败不升档');
}

console.log('\n[5] 第三次「期满 + 重新累计」→ permanent，isDisabled 恒为 true');
{
    reset();
    SH.record('srcC', false);
    SH.record('srcC', false);                 // tier=1 / 30min
    driveUpOneTier('srcC', 30 * MIN + 1000); // tier=2 / 24h
    driveUpOneTier('srcC', 24 * HOUR + 1000);// tier=3 / permanent
    const s = SH.status('srcC');
    eq(s.permanent, true, 'permanent=true');
    eq(s.disabled, true, 'disabled=true');
    eq(s.tier, 3, 'tier=3');
    eq(SH.isDisabled('srcC'), true, 'isDisabled=true');
    eq(s.remainingMs, -1, 'remainingMs=-1');
    advance(30 * 24 * HOUR);
    eq(SH.isDisabled('srcC'), true, '时间推进也不自动恢复');
}

console.log('\n[6] 成功一次 → 降一级并恢复（含从 permanent 恢复）');
{
    reset();
    SH.record('srcD', false);
    SH.record('srcD', false);
    driveUpOneTier('srcD', 30 * MIN + 1000);
    driveUpOneTier('srcD', 24 * HOUR + 1000);
    let s = SH.status('srcD');
    eq(s.permanent, true, '构造出 permanent');
    eq(s.tier, 3, 'tier=3');
    SH.record('srcD', true);
    s = SH.status('srcD');
    eq(s.disabled, false, '成功恢复');
    eq(s.permanent, false, '清 permanent');
    eq(s.failCount, 0, 'failCount 归零');
    eq(s.tier, 2, '降一级 tier=2');
}

console.log('\n[7] resume() 手动立即恢复');
{
    reset();
    SH.record('srcE', false);
    SH.record('srcE', false);
    SH.record('srcE', false);
    SH.record('srcE', false);
    eq(SH.isDisabled('srcE'), true, '恢复前停用');
    SH.resume('srcE');
    const s = SH.status('srcE');
    eq(s.disabled, false, 'disabled=false');
    eq(s.permanent, false, 'permanent=false');
    eq(s.failCount, 0, 'failCount=0');
    eq(s.tier, 0, 'tier=0');
    eq(s.remainingMs, 0, 'remainingMs=0');
    eq(SH.isDisabled('srcE'), false, 'isDisabled=false');
}

console.log('\n[8] 旧数据（只有 ok/ts）不抛错、不判停用，且可继续参与状态机');
{
    reset();
    let threw = false;
    try {
        store.set('wdtvSourceHealth', JSON.stringify({
            legacyOk: { ok: 1, ts: fakeNow, direct: 1, dts: fakeNow },
            legacyFail: { ok: 0, ts: fakeNow }
        }));
        SH.readAll();
    } catch (e) { threw = true; }
    eq(threw, false, '读取旧数据不抛错');
    eq(SH.isDisabled('legacyOk'), false, '旧成功记录不判停用');
    eq(SH.isDisabled('legacyFail'), false, '旧失败记录不判停用');
    const sOk = SH.status('legacyOk');
    eq(sOk.disabled, false, 'status.disabled=false');
    eq(sOk.tier, 0, 'tier 迁移为 0');
    eq(sOk.failCount, 0, 'ok=1 迁移 failCount=0');
    const sFail = SH.status('legacyFail');
    eq(sFail.failCount, 1, 'ok=0 迁移 failCount=1');
    eq(sFail.tier, 0, 'tier=0');
    SH.record('legacyFail', false);
    eq(SH.isDisabled('legacyFail'), true, '迁移后第 2 次失败正常触发停用');
}

console.log('\n[9] 存储异常静默降级为「未停用」，读写绝不抛错');
{
    reset();
    globalThis.localStorage = {
        getItem() { throw new Error('storage boom'); },
        setItem() { throw new Error('storage boom'); },
        removeItem() { throw new Error('storage boom'); }
    };
    let threw = false;
    try {
        SH.record('bad', false);
        SH.status('bad');
        SH.resume('bad');
        SH.clear('bad');
        SH.readAll();
    } catch (e) { threw = true; }
    eq(threw, false, '存储异常不抛错');
    eq(SH.isDisabled('bad'), false, '异常时降级为未停用');
    eq(SH.status('bad').failCount, 0, 'failCount=0');
    globalThis.localStorage = goodStorage; // 恢复，避免影响后续
}

console.log('\n[10] 多源写不互相覆盖（读-改-写同一同步块），单存储键');
{
    reset();
    SH.record('src1', false);
    SH.record('src2', false);
    SH.record('src3', true);
    SH.record('src1', false);
    const all = SH.readAll();
    eq(all.src1.failCount, 2, 'src1 两次失败');
    eq(all.src2.failCount, 1, 'src2 一次失败');
    eq(all.src3.failCount, 0, 'src3 成功');
    eq(SH.isDisabled('src1'), true, 'src1 已停用');
    eq(SH.isDisabled('src2'), false, 'src2 未停用');
    const raw = JSON.parse(store.get('wdtvSourceHealth'));
    t('三条记录都在 wdtvSourceHealth 单键内',
        JSON.stringify(Object.keys(raw).sort()) === JSON.stringify(['src1', 'src2', 'src3']),
        JSON.stringify(Object.keys(raw)));
}

console.log('\n[11] readAll() 返回迁移副本、不写回存储；clear() 删除记录');
{
    reset();
    store.set('wdtvSourceHealth', JSON.stringify({ x: { ok: 1, ts: fakeNow } }));
    const before = store.get('wdtvSourceHealth');
    const all = SH.readAll();
    eq(all.x.tier, 0, 'readAll 迁移 tier=0');
    eq(all.x.failCount, 0, 'readAll 迁移 failCount=0');
    eq(store.get('wdtvSourceHealth'), before, 'readAll 不写回存储');
    SH.record('gone', false);
    SH.record('gone', false);
    eq(SH.isDisabled('gone'), true, 'gone 已停用');
    SH.clear('gone');
    eq(SH.isDisabled('gone'), false, 'clear 后未停用');
    eq(SH.readAll().gone, undefined, '记录已删除');
}

console.log('\n[12] 长期停用后继续失败保持终态');
{
    reset();
    SH.record('stuck', false);
    SH.record('stuck', false);
    driveUpOneTier('stuck', 30 * MIN + 1000);
    driveUpOneTier('stuck', 24 * HOUR + 1000);
    eq(SH.status('stuck').permanent, true, '构造出 permanent');
    for (let i = 0; i < 3; i++) SH.record('stuck', false);
    const s = SH.status('stuck');
    eq(s.permanent, true, 'permanent 终态保持');
    eq(s.tier, 3, '终态等级不再上升');
    eq(SH.isDisabled('stuck'), true, 'isDisabled 仍为 true');
}

console.log('\n[13] 7 天惰性清理：permanent 长期停用记录不被误删（回归）');
{
    reset();
    const K = 'wdtvSourceHealth';
    const eightDays = 8 * 24 * HOUR;
    const old = fakeNow - eightDays; // 8 天前，已超过 STALE_CLEAN_MS(7d)
    store.set(K, JSON.stringify({
        permOld: { ok: 0, ts: old, failCount: 2, tier: 3, disabledUntil: 0, permanent: true },
        staleOld: { ok: 1, ts: old, failCount: 0, tier: 0, disabledUntil: 0, permanent: false }
    }));
    SH.record('trigger', true); // 触发另一源 record() 以驱动 writeRaw 的清理
    const raw = JSON.parse(store.get(K));
    t('8 天前的 permanent 记录在触发清理后仍存在',
        raw.permOld !== undefined && raw.permOld.permanent === true, JSON.stringify(raw.permOld));
    t('该 permanent 记录仍判为停用', SH.isDisabled('permOld') === true);
    t('8 天前的非 permanent 旧记录仍被清理', raw.staleOld === undefined, JSON.stringify(Object.keys(raw)));
    t('触发记录已写入', raw.trigger !== undefined);
}

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
Date.now = REAL_NOW;
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
