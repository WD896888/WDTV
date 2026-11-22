// functions/dl-batch.js - Cloudflare Pages Function
// 下载器批量取件接口（与本地 server.mjs 的 POST /dl-batch 同协议，前端无需区分环境）
//
// 为什么需要它：慢源的真实瓶颈是「每个分片一次上游往返」（单片 TTFB ~2s），而浏览器对
// 同一 host 只放行约 6 条 HTTP/1.1 连接。逐片取件时再高的并发也只能跑到 6 路；
// 一次请求取回 K 片、由边缘并发拉上游，6 条连接即可压满带宽（本地实测 0.6 → 1.0+ MB/s）。
//
// 协议（前端 js/downloader.js 的 fetchSegBatch 依赖，勿单方面改动）：
//   请求：POST /dl-batch
//         Content-Type: application/json
//         { "urls": ["https://…/0.ts", …] }   // 最多 BATCH_MAX 条，须为 http(s)
//   响应：200，Body = 各分片字节按请求顺序拼接
//         x-wdtv-status: "200,200,0,200"      // 0 = 该片失败，前端会退回逐片通道重试
//         x-wdtv-size:   "532604,252672,0,229924"
//
// 安全：与 /proxy 同源 Referer 校验 + SSRF 字面量守卫（复用同目录上层 _ssrf-literal.mjs），
// 只允许 http(s)、限制条数与单条/总字节数，避免被当成放大器或打爆 Worker 内存。
import { isBlockedTarget } from './proxy/_ssrf-literal.mjs';

// Workers 每请求内存有限（128MB/isolate），且要留出拼接时的第二份拷贝：
// 6 × 16MB 的极端情况会被总量 32MB 卡掉，剩余项按失败返回给前端逐片重试。
const BATCH_MAX = 6;
const ITEM_MAX = 16 * 1024 * 1024;
const TOTAL_MAX = 32 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function jsonResponse(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }, extra || {})
  });
}

// 与 /proxy 同源的 Referer 校验：带 Referer 且 host 不一致 → 403；无 Referer 放行（PWA/WebView）
function refererAllowed(request, url) {
  const referer = request.headers.get('Referer');
  if (!referer) return true;
  let refererHost = null;
  try { refererHost = new URL(referer).host; } catch (e) { /* 畸形 Referer 视为不同源 */ }
  return refererHost === url.host;
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store'
    }
  });
}

export async function onRequestPost({ request }) {
  const url = new URL(request.url);
  if (!refererAllowed(request, url)) {
    return jsonResponse({ error: 'forbidden' }, 403);
  }

  let body = null;
  try { body = await request.json(); } catch (e) { /* 非法 JSON 走下面的空列表分支 */ }
  const list = (body && Array.isArray(body.urls)) ? body.urls.slice(0, BATCH_MAX) : [];

  const targets = [];
  for (const u of list) {
    if (typeof u !== 'string' || !u) continue;
    let parsed = null;
    try { parsed = new URL(u); } catch (e) { continue; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    if (isBlockedTarget(u)) continue; // SSRF：内网/回环/链路本地一律拒绝
    targets.push(u);
  }
  if (!targets.length) return jsonResponse({ error: 'no valid url' }, 400);

  // 并行拉取：每个分片一个子请求（≤6，远低于 Workers 子请求上限）
  const results = await Promise.all(targets.map(async (target) => {
    const headers = { 'User-Agent': UA };
    // 豆瓣图片 CDN 防盗链：与 /proxy 保持一致
    if (target.includes('doubanio.com') || target.includes('douban.com')) {
      headers['Referer'] = 'https://movie.douban.com/';
    }
    try {
      const resp = await fetch(target, { headers, redirect: 'follow' });
      if (!resp.ok) return { status: resp.status, buf: null, clen: 0 };
      const enc = ((resp.headers.get('content-encoding') || '')).toLowerCase();
      const declared = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
      if (declared > ITEM_MAX) return { status: 0, buf: null, clen: 0 };
      const ab = await resp.arrayBuffer();
      if (ab.byteLength > ITEM_MAX) return { status: 0, buf: null, clen: 0 };
      // 未压缩响应才带上声明长度：前端据此判截断（压缩响应的长度与解压后字节不可比）
      return { status: resp.status, buf: new Uint8Array(ab), clen: enc ? 0 : declared };
    } catch (e) {
      return { status: 0, buf: null, clen: 0 };
    }
  }));

  // 总量上限：超出的按失败返回（前端该片回退逐片通道），避免 OOM
  let total = 0;
  const picked = results.map((r) => {
    if (!r.buf || total + r.buf.byteLength > TOTAL_MAX) return null;
    total += r.buf.byteLength;
    return r.buf;
  });

  const out = new Uint8Array(total);
  let off = 0;
  for (const b of picked) {
    if (!b) continue;
    out.set(b, off);
    off += b.byteLength;
  }

  return new Response(out, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'x-wdtv-status': picked.map((b, k) => (b ? results[k].status : 0)).join(','),
      'x-wdtv-size': picked.map((b) => (b ? b.byteLength : 0)).join(','),
      'x-wdtv-clen': picked.map((b, k) => (b ? (results[k].clen || 0) : 0)).join(','),
      // 同源读取也能读自定义头，但显式声明可让将来跨域调用同样可用
      'access-control-expose-headers': 'x-wdtv-status, x-wdtv-size, x-wdtv-clen'
    }
  });
}
