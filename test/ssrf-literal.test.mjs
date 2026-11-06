// WDTV SSRF 字面量守卫自测（Node ESM，零依赖，不随部署）
// 运行：node --test test/ssrf-literal.test.mjs  或  node test/ssrf-literal.test.mjs
// 测试对象是与线上 functions/proxy/[[path]].js 同一份逻辑的纯函数模块，
// 保证「安全修改零开销、不误伤任何现有源」可回归验证。
import { isBlockedTarget } from '../functions/proxy/_ssrf-literal.mjs';

// ===== 交叉一致性：加载浏览器版 js/source-subscription.js 的 SSRF 守卫 =====
// 该模块是经典 script（IIFE + window 单例），与 Functions 版 _ssrf-literal.mjs 是两份独立实现。
// 用最小 window 桩加载后取 _internals.isBlockedLiteral，与 Functions 版 isBlockedTarget 逐条比对。
const stubWin = { document: { addEventListener() {} } };
globalThis.window = stubWin;
await import('../js/source-subscription.js');
const subMod = stubWin.WDTVSourceSubscriptions || globalThis.WDTVSourceSubscriptions;
const isBlockedLiteral = subMod && subMod._internals && subMod._internals.isBlockedLiteral;
function lit(u) {
  try { return isBlockedLiteral(u); } catch (e) { return 'THREW: ' + e.message; }
}

let pass = 0, fail = 0;
const fails = [];

function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

function check(u) {
  try { return isBlockedTarget(u); } catch (e) { return 'THREW: ' + e.message; }
}

// ---------- 必须拒绝：任务指定的私网 / 保留 IP 字面量 + 非 http(s) 协议 ----------
const BLOCKED = [
  'http://127.0.0.1/',
  'http://169.254.169.254/latest/meta-data/',
  'http://192.168.1.5/x.m3u8',
  'http://10.0.0.1/',
  'http://172.20.1.1/',
  'http://[::1]/',
  'http://[::ffff:192.168.1.1]/',
  'http://2130706433/',
  'file:///etc/passwd',
  'ftp://x/'
];

console.log('\n[1] 必须拒绝：任务指定的黑名单用例');
for (const u of BLOCKED) {
  const r = check(u);
  t('拒绝 ' + u, r === true, String(r));
}

// ---------- 必须放行：WDTV 全部内置源 / 硬编码端点（含 http: 源）----------
const ALLOWED = [
  'https://json.heimuer.xyz/api.php/provide/vod/',
  'http://ffzy5.tv/',
  'https://img9.doubanio.com/view/photo/s_ratio_poster/public/p.jpg',
  'https://danmu.wdmatch1.dpdns.org/zrt1ym8hlfq6',
  'https://api.allorigins.win/raw?url=x'
];

console.log('\n[2] 必须放行：现有源与端点（尤其 http: 必须保留）');
for (const u of ALLOWED) {
  const r = check(u);
  t('放行 ' + u, r === false, String(r));
}

// ---------- 增强：进制/简写整数 IP、IPv6 保留段、云元数据 ----------
console.log('\n[3] 增强：整数/八进制/十六进制/简写 IPv4 与 IPv6 保留段一律拒绝');
const MORE_BLOCKED = [
  'http://0x7f000001/',            // 十六进制整数 → 127.0.0.1
  'http://0177.0.0.1/',            // 八进制 → 127.0.0.1
  'http://127.1/',                 // 简写 → 127.0.0.1
  'http://0.0.0.0/',
  'http://100.64.0.1/',            // CGNAT
  'http://192.0.0.1/',             // IETF 协议分配
  'http://[::]/',                  // 未指定
  'http://[::ffff:7f00:1]/',       // mapped 127.0.0.1
  'http://[fe80::1]/',             // 链路本地
  'http://[fc00::1]/',             // 唯一本地
  'http://[fd00::1]/',
  'http://172.31.255.255/',        // 172.16~31 上边界
  'http://localhost/',
  'http://a.localhost/',
  'javascript:alert(1)',
  'data:text/html,<script>1</script>'
];
for (const u of MORE_BLOCKED) {
  const r = check(u);
  t('拒绝 ' + u, r === true, String(r));
}

// ---------- 关键：不得误伤任何域名字符串 ----------
console.log('\n[4] 关键：不得误伤任何域名字符串（含以私网前缀"看起来像"的域名）');
const MORE_ALLOWED = [
  'http://10.example.com/',          // 不能以 '10.' 前缀误伤
  'http://192.168.example.com/',     // 含字母 → 非 IP 字面量
  'http://172.32.0.1/',              // 172.32 在私网 /12 之外
  'https://fc00.example.com/',       // 不能以 fc/fd 前缀误伤域名
  'https://fd.example.net/x',
  'https://fe80.example.org/',
  'https://100.example.com/',
  'https://169.254.example.com/'
];
for (const u of MORE_ALLOWED) {
  const r = check(u);
  t('放行 ' + u, r === false, String(r));
}

// ---------- 畸形输入：不抛异常、保守拒绝 ----------
console.log('\n[5] 畸形输入：不抛异常、保守拒绝');
for (const u of ['', 'not a url', 'http://', null, undefined, 123, {}]) {
  let threw = false, r;
  try { r = isBlockedTarget(u); } catch (e) { threw = true; }
  t('畸形 ' + String(u) + ' 不抛异常', !threw);
  t('畸形 ' + String(u) + ' 保守拒绝', r === true, String(r));
}

// ---------- [6] 交叉一致性：浏览器版与 Functions 版对同一批 URL 判定一致 ----------
// 两份实现独立（浏览器 IIFE 不 import Functions 模块）。若不一致，以 Functions 版为准修
// js/source-subscription.js。覆盖：私网 IPv4、IPv6 环回、纯数字 host、公网域名、http 与 https。
console.log('\n[6] 交叉一致性：Functions isBlockedTarget 与浏览器 isBlockedLiteral 判定一致');
t('6：成功取到浏览器版 _internals.isBlockedLiteral', typeof isBlockedLiteral === 'function');
const CROSS = [
  // 私网 / 保留 IPv4 字面量（http 与 https）
  'http://10.0.0.1/', 'https://10.0.0.1/x', 'http://127.0.0.1/',
  'https://192.168.1.5/x.m3u8', 'http://169.254.169.254/latest/meta-data/',
  'http://172.20.1.1/', 'http://100.64.0.1/', 'http://192.0.0.1/', 'http://0.0.0.0/',
  // IPv6 环回 / 未指定 / 保留段 / mapped
  'http://[::1]/', 'https://[::1]/', 'http://[::]/',
  'http://[::ffff:127.0.0.1]/', 'http://[::ffff:192.168.1.1]/',
  'http://[fe80::1]/', 'http://[fc00::1]/', 'http://[fd00::1]/',
  // 纯数字 / 十六进制 / 八进制 / 简写整数 IP
  'http://2130706433/', 'https://0x7f000001/', 'http://127.1/', 'http://0177.0.0.1/',
  // localhost 及子域
  'http://localhost/', 'https://a.localhost/x',
  // 公网域名（含「看起来像私网前缀」的域名）+ http 与 https
  'https://example.com/', 'http://ffzy5.tv/', 'https://json.heimuer.xyz/api.php/provide/vod/',
  'http://10.evil.com/', 'https://192.168.example.com/', 'https://172.32.0.1/',
  'https://100.example.com/', 'https://fc00.example.com/', 'https://api.allorigins.win/raw?url=x',
  // 非 http(s) / 畸形 / 非字符串
  'ftp://x/', 'file:///etc/passwd', 'javascript:alert(1)',
  'data:text/html,<script>1</script>', '', 'not a url', 'http://',
  null, undefined, 123, {}
];
let crossMismatch = 0;
for (const u of CROSS) {
  const a = check(u);        // Functions 版：isBlockedTarget
  const b = lit(u);          // 浏览器版：isBlockedLiteral
  const same = a === b && typeof a !== 'string' && typeof b !== 'string';
  if (!same) { crossMismatch++; console.log('MISMATCH ' + String(u) + ' Functions=' + a + ' browser=' + b); }
  t('6：一致 ' + String(u), same, `Functions=${a} browser=${b}`);
}
t('6：交叉用例零不一致（以 Functions 版为准）', crossMismatch === 0, String(crossMismatch));

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
