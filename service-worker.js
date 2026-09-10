// WDTV Service Worker：静态资源运行时缓存
// 之前的空壳实现"不使用缓存"已升级为双策略运行时缓存，目标：
//   老用户二次访问近乎零等待（CSS/JS/图片直接命中本地缓存，不再逐个走网络），
//   弱网/离线时页面仍可打开（HTML 有缓存兜底）。
//
// 安全性说明：全部静态资源都带 ?v=N 版本号（发版即换 URL），
// 缓存条目按完整 URL（含查询串）隔离，不会出现"改了代码但浏览器拿到旧缓存"。
//
// 策略（仅限同源 GET，绝不触碰 /proxy/* 视频代理流——下载器与播放器的
// 流式数据由 video-cache.js 自行管理，SW 不得拦截）：
//   1. 版本化静态资源（/css/ /js/ /libs/ /image/ /bg-canvas.* /manifest.json）：
//      Stale-While-Revalidate —— 立即用缓存响应 + 后台静默更新
//   2. HTML 页面（导航请求 / *.html）：Network-First —— 保证入口页面最新，失败回退缓存
// v2（2026-09-08）：激活时清空全部旧缓存——彻底消灭"蜂窝网下网络优先失败回退旧 HTML →
// 旧 HTML 引用旧 ?v= → 命中旧 JS 缓存"的整链陈旧回退，保证播放端缓存修复真实到达设备
// v3（2026-09-10）：再次升级缓存版本——底栏玻璃样式多轮调整期间，v2 的 stale-while-revalidate
// 首次加载仍回旧缓存，用户会看到"改了没生效"；激活时清空全部旧缓存，确保样式即时到达
// v4（2026-09-10）：右上角账号区重构（设置/下载按钮 → 账号药丸+下拉菜单），升级缓存版本确保
// index.html/css/js 新资源即时到达
// v5（2026-09-10）：播放器锁定/解锁按钮统一移到屏幕左侧，升级缓存版本确保 player.css 新样式即时到达
// v6（2026-09-10）：右侧新增截图/录屏画面按钮（player.css/js 更新），升级缓存版本确保新功能即时到达
// v7（2026-09-10）：截图/录屏入口改为控制栏原生图标按钮（倍速/下载/缓存同款交互），升级缓存版本
// v8（2026-09-10）：画面按钮移回屏幕右侧垂直居中（锁定钮原位置）；录屏格式改为 MP4 优先（不支持时回退 WebM）
// v9（2026-09-10）：修复录屏成片开头/结尾出现几秒重复帧的问题——改用 canvas 手动帧模式（captureStream(0)+requestFrame），
//                   仅在视频正在播放且解码帧更新时才产帧，暂停/缓冲区间不再产生任何帧
// v10（2026-09-10）：修复画面选项面板打开时先坠到下方再跳回居中的问题——speedPanelIn 动画的 to{transform:none}
//                    覆盖了定位用的 translateY(-50%)，改为专属入场动画（全程保持 -50% 偏移）
const CACHE_VERSION = 'wdtv-sw-v10';
const ASSET_CACHE = `wdtv-assets-${CACHE_VERSION}`;
const PAGE_CACHE = `wdtv-pages-${CACHE_VERSION}`;

// 版本化静态资源匹配规则（按 pathname 匹配，查询串 ?v=N 不影响）
const ASSET_PATH_PATTERNS = [
    /^\/css\//,
    /^\/js\//,
    /^\/libs\//,
    /^\/image\//,
    /^\/bg-canvas\.(jpg|png)$/,
    /^\/manifest\.json$/
];

self.addEventListener('install', event => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(
            names
                .filter(n => n.startsWith('wdtv-') && n !== ASSET_CACHE && n !== PAGE_CACHE)
                .map(n => caches.delete(n))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    let url;
    try {
        url = new URL(request.url);
    } catch (e) {
        return;
    }
    // 只处理同源请求（Google Fonts 等第三方由浏览器自身缓存策略处理）
    if (url.origin !== self.location.origin) return;
    // 视频/图片代理流绝不缓存（播放器分片、下载器、时长检测都走这里）
    if (url.pathname.startsWith('/proxy/')) return;
    // 账号/同步 API 一律走网络，绝不缓存（动态鉴权数据）
    if (url.pathname.startsWith('/api/')) return;

    // --- HTML 页面：Network-First，失败回退缓存（离线兜底） ---
    if (request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
        event.respondWith((async () => {
            const cache = await caches.open(PAGE_CACHE);
            try {
                const fresh = await fetch(request);
                if (fresh && fresh.ok) {
                    // put 前克隆：响应体只能消费一次
                    cache.put(request, fresh.clone());
                }
                return fresh;
            } catch (e) {
                const cached = await cache.match(request, { ignoreSearch: true });
                return cached || Response.error();
            }
        })());
        return;
    }

    // --- 版本化静态资源：Stale-While-Revalidate ---
    if (ASSET_PATH_PATTERNS.some(re => re.test(url.pathname))) {
        event.respondWith((async () => {
            const cache = await caches.open(ASSET_CACHE);
            const cached = await cache.match(request);
            // 无论命中与否都发起后台更新（命中时用 waitUntil 挂后台，不阻塞响应）
            const networkUpdate = fetch(request).then(fresh => {
                if (fresh && fresh.ok) {
                    cache.put(request, fresh.clone());
                }
                return fresh;
            }).catch(() => null);

            if (cached) {
                event.waitUntil(networkUpdate);
                return cached;
            }
            // 首次访问：等网络返回（后续访问才会命中缓存）
            const fresh = await networkUpdate;
            return fresh || Response.error();
        })());
    }
});
