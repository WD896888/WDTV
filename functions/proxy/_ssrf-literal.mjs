// functions/proxy/_ssrf-literal.mjs
// SSRF 字面量守卫：纯同步、零网络往返、零阻塞 I/O 的目标主机黑名单判断。
//
// 为什么是独立模块：
//   - 下划线 `_` 前缀：Cloudflare Pages Functions 不会把该模块注册为路由，
//     可被同目录的 [[path]].js 以相对路径 import（项目 functions/api/_lib.mjs 已有同样用法）。
//   - ESM 具名导出 + 零 import：可被 test/ssrf-literal.test.mjs 用 Node 直接 import 做零依赖自测，
//     线上运行与测试验证的是同一份逻辑，不存在两份实现需要手工同步的问题。
//
// 为什么只判断「字面量」（约束：安全修改不得影响任何现有源、不得降低观看速度、不得造成延迟或卡顿）：
//   - CF Workers 无 node:dns，禁止 DNS 查询；也不得新增 KV/D1 读取或任何 fetch 前置 I/O。
//   - 已核实 WDTV 全部内置源 / 硬编码端点均为域名、无 IP 直连，故域名一律放行，绝不误伤。
//   - WHATWG URL 解析器会把十进制 / 八进制 / 十六进制整数 IP（2130706433 / 0x7f000001 /
//     0177.0.0.1）、IPv4 简写（127.1）以及 IPv4-mapped IPv6 自动规范化，
//     因此无需自行实现进制转换，也无需 `new URL('http://'+host)` 的二次解析。
//   - 协议白名单保留 http:（ffzy5.tv 等内置源使用 http:）。

/**
 * 目标 URL 是否应被拒绝（true = 拦截 / false = 放行）。
 * 入参为 getTargetUrlFromPath() 返回的目标 URL 字符串。
 * 畸形 / 非字符串 / 非 http(s) 协议一律保守拒绝，但绝不误伤任何域名字符串。
 */
export function isBlockedTarget(targetUrl) {
    // 1) 解析 + 协议白名单：畸形 URL 与非 http/https 协议一律拒绝
    if (typeof targetUrl !== 'string' || !targetUrl) return true;
    let parsed;
    try {
        parsed = new URL(targetUrl);
    } catch (e) {
        return true;
    }
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') return true;

    // 2) hostname 归一化：去掉 IPv6 方括号、结尾点，统一小写
    let host = parsed.hostname;
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    host = host.toLowerCase().replace(/\.$/, '');
    if (!host) return true;

    // 3) 保留主机名
    if (host === 'localhost' || host.endsWith('.localhost')) return true;

    // 4) IPv6 字面量（必含冒号；域名不含冒号，故此处不会误伤任何域名字符串）
    if (host.includes(':')) {
        // 环回 / 未指定地址（压缩与非压缩写法）
        if (host === '::1' || host === '::' ||
            host === '0:0:0:0:0:0:0:1' || host === '0:0:0:0:0:0:0:0') return true;

        // IPv4-mapped IPv6：WHATWG URL 一律规范成 ::ffff:hhhh:hhhh
        // 把两组十六进制还原为点分十进制，再走 IPv4 私网判断
        const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i) ||
                       host.match(/^0:0:0:0:0:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
        if (mapped) {
            const hi = parseInt(mapped[1], 16);
            const lo = parseInt(mapped[2], 16);
            return isBlockedIPv4([(hi >>> 8) & 255, hi & 255, (lo >>> 8) & 255, lo & 255]);
        }

        // 链路本地 fe80::/10、唯一本地 fc00::/7（fc / fd）
        // 已限定 host 含 ':'，前缀判断不会误伤普通域名
        if (/^fe[89ab]/i.test(host) || /^f[cd]/i.test(host)) return true;

        // 其它 IPv6（公网）放行
        return false;
    }

    // 5) IPv4 字面量：仅接受严格的四段十进制。
    //    注意：WHATWG URL 已把整数 / 八进制 / 十六进制 / 简写字面量规范成标准 a.b.c.d，
    //    故此处直接判断即可；含字母的域名一律进不了这里（parseIPv4 返回 null）。
    const ipv4 = parseIPv4(host);
    if (ipv4) return isBlockedIPv4(ipv4);

    // 6) URL 解析器未能规范化的纯数字 / 十六进制整数主机（防御纵深，保守拒绝）。
    //    合法公网源均为含字母的域名字符串，纯数字 host 不会是它们。
    if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;

    // 7) 其余一律视为域名，放行（零误伤 WDTV 全部内置源）
    return false;
}

// 严格四段十进制 IPv4 → [a, b, c, d]；不是 IPv4 字面量返回 null
function parseIPv4(host) {
    const parts = host.split('.');
    if (parts.length !== 4) return null;
    const out = [];
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const n = Number(part);
        if (n > 255) return null;
        out.push(n);
    }
    return out;
}

// 私网 / 保留 IPv4 段判断（输入为四段数字数组）
function isBlockedIPv4(p) {
    const [a, b, c] = p;
    if (a === 0) return true;                            // 0.0.0.0/8 本网络（含 0.0.0.0）
    if (a === 10) return true;                           // 10.0.0.0/8 私网
    if (a === 127) return true;                          // 127.0.0.0/8 环回
    if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 CGNAT
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16 链路本地（含云元数据）
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12 私网
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16 私网
    if (a === 192 && b === 0 && c === 0) return true;    // 192.0.0.0/24 IETF 协议分配
    if (a >= 224) return true;                           // 组播 / 保留 / 广播兜底（公网源不会命中）
    return false;
}
