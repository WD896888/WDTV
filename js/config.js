// 全局常量配置
const PROXY_URL = '/proxy/';    // 适用于 Cloudflare, Netlify (带重写), Vercel (带重写)
// const HOPLAYER_URL = 'https://hoplayer.com/index.html';
const SEARCH_HISTORY_KEY = 'videoSearchHistory';
const MAX_HISTORY_ITEMS = 5;

// 网站信息配置
const SITE_CONFIG = {
    name: 'WDTV',
    url: 'https://libretv.is-an.org',
    description: '免费在线视频搜索与观看平台',
    logo: 'https://images.icon-icons.com/38/PNG/512/retrotv_5520.png',
    version: '1.0.8'
};

// API站点配置
// detailMode：每个源详情获取方式的显式配置（不依赖运行时猜测）
//   'api'  —— 仅标准接口（api.php/provide/vod?ac=videolist&ids=），默认值，适用于未配置 detail 字段的源
//   'html' —— 仅详情页 HTML 解析（detail 字段域名 + 正则提取 m3u8）
//   'auto' —— 标准接口优先，失败自动回退详情页解析
// 配置依据为实测结果；源站行为变化时请以实测为准调整
//
// 2026-11-21：接入 15 个源；主线路默认使用大陆优先 / m3u8 专用 JSON，
//   备用线路写在 routes（详情请求可按 routeId 切换），playFrom 为可播放的播放源标识。
// 天涯（tyyszy）官方 API 关闭了关键词搜索，改用站点搜索页（HTML 分页）+ 标准 API 取详情。
// 最大资源（zuid）官方 API 忽略 wd，改用站点 suggest 接口（limit=2000）+ 标准 API 取详情。
// 无尽（wujin）标准 JSON 搜索/详情；播放地址强制走 /proxy/，规避播放域名 DNS 污染与换域名。
// 黑木耳（heimuer）与速博（subo）域名当前不可达/被停放，已移除。
// XML / SeaCMS / 海洋CMS 接口不作为线路接入，只接 JSON 可播线路。
const API_SITES = {
    tyyszy: {
        api: 'https://ty.tyyszy5.com/api.php/provide/vod/',
        name: '天涯资源',
        detailMode: 'api',
        playFrom: ['tym3u8'],
        primaryLabel: '大陆优先 JSON',
        // 官方 API 已关闭关键词搜索：?ac=videolist&wd= 返回「暂不支持搜索」。
        // 改用站点搜索页（HTML，30 条/页，支持分页），详情仍走标准 API ?ac=videolist&ids=。
        searchMode: 'html',
        searchUrl: 'https://tyyszyapi.com/index.php/vod/search/page/{page}/wd/{query}.html',
        routes: [
            { id: 'json-general', label: '通用 JSON', api: 'https://tyyszyapi.com/api.php/provide/vod/' }
        ]
    },
    zuid: {
        api: 'https://api.zuidapi.com/api.php/provide/vod/from/zuidam3u8/',
        name: '最大资源',
        detailMode: 'api',
        playFrom: ['zuidam3u8'],
        primaryLabel: '切片 JSON',
        // 官方 API 忽略 wd 搜索参数，改用站点 suggest 接口；limit=2000 一次取回全部匹配。
        searchMode: 'suggest',
        searchUrl: 'https://api.zuidapi.com/index.php/ajax/suggest?mid=1&wd={query}&limit=2000',
        routes: [
            { id: 'full-main', label: '全量 JSON', api: 'https://api.zuidapi.com/api.php/provide/vod/' }
        ]
    },
    juliang: {
        api: 'https://api.juliang.live/api/provide/vod/from/jlm3u8/at/json/',
        name: '巨量资源',
        detailMode: 'api',
        playFrom: ['jlm3u8', 'jlplayer'],
        primaryLabel: '智能线路切片 JSON',
        // 分片 CDN（c1.ddbbffcdn.com 等）直连会被 DNS/网络拦截，播放地址统一走 /proxy/；
        // 本地代理会把清单里的相对/绝对分片地址一并改写为代理地址。
        proxyPlay: true,
        routes: [
            { id: 'full-main', label: '综合全量 JSON', api: 'https://api.juliang.live/api/provide/vod/' }
        ]
    },
    wujin: {
        api: 'https://api.wujinapi.com/api.php/provide/vod/from/wjm3u8/',
        name: '无尽资源',
        detailMode: 'api',
        playFrom: ['wjm3u8'],
        primaryLabel: '切片 JSON',
        // 无尽播放域名会换；强制走本地/服务端 /proxy/，避免直连域名 DNS 污染或换域名后播不了。
        proxyPlay: true,
        routes: [
            { id: 'full-main', label: '主站全量 JSON', api: 'https://api.wujinapi.com/api.php/provide/vod/' },
            { id: 'full-domestic', label: '国内备用全量 JSON（低频）', api: 'https://wjzyapi.com/api.php/provide/vod/' }
        ]
    },
    bfzy: {
        api: 'https://apibfzy.com/api.php/provide/vod/from/bfzym3u8/',
        name: '暴风资源',
        detailMode: 'api',
        playFrom: ['bfzym3u8'],
        primaryLabel: '主站切片 JSON',
        routes: [
            { id: 'full-main', label: '主站全量 JSON', api: 'https://apibfzy.com/api.php/provide/vod/' },
            { id: 'm3u8-backup', label: '备用主机切片 JSON', api: 'https://bfzyapi.com/api.php/provide/vod/from/bfzym3u8/' },
            { id: 'full-backup', label: '备用主机全量 JSON', api: 'https://bfzyapi.com/api.php/provide/vod/' }
        ]
    },
    lzi: {
        api: 'https://lzzyapi.com/api.php/provide/vod/from/lzm3u8/',
        name: '量子资源',
        detailMode: 'api',
        playFrom: ['lzm3u8', 'liangzi'],
        primaryLabel: '主站切片 JSON',
        // 播放 CDN（v.cdnlz28.com）在本机 DNS 被污染到 127.0.0.1；播放地址统一走 /proxy/，
        // 由本地代理用固定 IP + 原始 Host 回源（见 server.mjs 的 LOCAL_PROXY_HOST_REWRITES）。
        proxyPlay: true,
        routes: [
            { id: 'full-main', label: '主站全量 JSON', api: 'https://lzzyapi.com/api.php/provide/vod/' },
            { id: 'cloud-main', label: '主站云播 JSON', api: 'https://lzzyapi.com/api.php/provide/vod/from/liangzi/' },
            { id: 'm3u8-backup', label: '备用主机切片 JSON', api: 'https://cj.lziapi.com/api.php/provide/vod/from/lzm3u8/' },
            { id: 'full-backup', label: '备用主机全量 JSON', api: 'https://cj.lziapi.com/api.php/provide/vod/' }
        ]
    },
    ikun: {
        api: 'https://ikunzyapi.com/api.php/provide/vod/from/ikm3u8/',
        name: 'iKun资源',
        detailMode: 'api',
        playFrom: ['ikm3u8'],
        primaryLabel: '采集主站切片 JSON',
        // 播放 CDN（bfikuncdn.com）在本机 DNS 被污染到 127.0.0.1；播放地址统一走 /proxy/，
        // 由本地代理用固定 IP + 原始 Host 回源（与 API 主机的 CDN 兜底同一机制）。
        proxyPlay: true,
        routes: [
            { id: 'full-main', label: '采集主站全量 JSON', api: 'https://ikunzyapi.com/api.php/provide/vod/' },
            { id: 'full-official', label: '官网同结构全量 JSON', api: 'https://www.ikunzy.com/api.php/provide/vod/' }
        ]
    },
    ruyi: {
        api: 'https://cj.rycjapi.com/api.php/provide/vod/from/rym3u8/',
        name: '如意资源',
        detailMode: 'api',
        playFrom: ['rym3u8', 'ruyi'],
        primaryLabel: '采集站切片 JSON',
        routes: [
            { id: 'full-main', label: '采集站全量 JSON', api: 'https://cj.rycjapi.com/api.php/provide/vod/' },
            { id: 'cloud-main', label: '采集站云播 JSON', api: 'https://cj.rycjapi.com/api.php/provide/vod/from/ruyi/at/json/' }
        ]
    },
    ffzy: {
        api: 'https://api.ffzyapi.com/api.php/provide/vod/from/ffm3u8/',
        name: '非凡影视',
        detailMode: 'api',
        playFrom: ['ffm3u8', 'feifan'],
        primaryLabel: '主采集站切片 JSON',
        routes: [
            { id: 'full-main', label: '主采集站全量 JSON', api: 'https://api.ffzyapi.com/api.php/provide/vod/' },
            { id: 'm3u8-cj', label: '备用采集站切片 JSON', api: 'https://cj.ffzyapi.com/api.php/provide/vod/from/ffm3u8/' },
            { id: 'full-cj', label: '备用采集站全量 JSON', api: 'https://cj.ffzyapi.com/api.php/provide/vod/' },
            { id: 'm3u8-mirror', label: '站点镜像切片 JSON', api: 'https://ffzy5.tv/api.php/provide/vod/from/ffm3u8/' },
            { id: 'full-mirror', label: '站点镜像全量 JSON', api: 'https://ffzy5.tv/api.php/provide/vod/' }
        ]
    },
    zy360: {
        api: 'https://360zyzz.com/api.php/provide/vod',
        name: '360资源',
        detailMode: 'api',
        playFrom: ['360zy'],
        primaryLabel: '帮助页主接口 JSON（全量）',
        routes: [
            { id: 'full-official', label: '官网 JSON', api: 'https://360zy.com/api.php/provide/vod' }
        ]
    },
    jisu: {
        api: 'https://jszyapi.com/api.php/provide/vod/from/jsm3u8/at/json/',
        name: '极速资源',
        detailMode: 'api',
        playFrom: ['jsm3u8', 'jsyun'],
        primaryLabel: '主站切片 JSON',
        routes: [
            { id: 'full-main', label: '主站全量 JSON', api: 'https://jszyapi.com/api.php/provide/vod/' },
            { id: 'cloud-main', label: '主站云播 JSON', api: 'https://jszyapi.com/api.php/provide/vod/from/jsyun/at/json/' }
        ]
    },
    mdzy: {
        api: 'https://www.mdzyapi.com/api.php/provide/vod/from/modum3u8/',
        name: '魔都资源',
        detailMode: 'api',
        playFrom: ['modum3u8'],
        primaryLabel: '主站切片 JSON',
        routes: [
            { id: 'full-main', label: '主站全量 JSON', api: 'https://www.mdzyapi.com/api.php/provide/vod/' },
            { id: 'm3u8-mirror', label: '镜像采集切片 JSON', api: 'https://caiji.moduapi.cc/api.php/provide/vod/from/modum3u8/' },
            { id: 'full-mirror', label: '镜像采集全量 JSON', api: 'https://caiji.moduapi.cc/api.php/provide/vod/' }
        ]
    },
    maoyan: {
        api: 'https://api.maoyanapi.top/api.php/provide/vod/from/mym3u8/at/json/',
        name: '猫眼资源',
        detailMode: 'api',
        playFrom: ['mym3u8'],
        primaryLabel: '主接口切片 JSON',
        routes: [
            { id: 'full-main', label: '主接口全量 JSON', api: 'https://api.maoyanapi.top/api.php/provide/vod' }
        ]
    },
    jyzy: {
        api: 'https://jyzyapi.com/api.php/provide/vod/from/jinyingm3u8/at/json/',
        name: '金鹰资源',
        detailMode: 'api',
        playFrom: ['jinyingm3u8', 'jinyingyun'],
        primaryLabel: '标准切片 JSON',
        routes: [
            { id: 'full-main', label: '标准全量 JSON', api: 'https://jyzyapi.com/api.php/provide/vod/' },
            { id: 'full-old', label: '旧路径全量 JSON', api: 'https://jyzyapi.com/provide/vod/' },
            { id: 'm3u8-old', label: '旧路径切片 JSON', api: 'https://jyzyapi.com/provide/vod/from/jinyingm3u8/' },
            { id: 'cloud-main', label: '标准云播 JSON', api: 'https://jyzyapi.com/api.php/provide/vod/from/jinyingyun/at/json/' }
        ]
    },
    hhzy: {
        api: 'https://hhzyapi.com/api.php/provide/vod/from/hhm3u8/at/json/',
        name: '豪华资源',
        detailMode: 'api',
        playFrom: ['hhm3u8', 'hhyun'],
        primaryLabel: '主站切片 JSON',
        routes: [
            { id: 'full-main', label: '主站全量 JSON', api: 'https://hhzyapi.com/api.php/provide/vod' },
            { id: 'cloud-main', label: '主站云播 JSON', api: 'https://hhzyapi.com/api.php/provide/vod/from/hhyun/at/json' }
        ]
    }
};

// 源等级（1 首选 / 2 常用 / 3 备用）：所有源都可分级，不再是固定 3 个优先源。
// 等级只用于组内来源排序与「点击多源聚合卡片直接播放」；搜索结果列表仍按片名关联度排序。
const SOURCE_TIER_LEVELS = 3;
const SOURCE_TIER_STORAGE = 'wdtvSourceTiers';
// 老版本「前三个优先源」存储键：仅用于一次性迁移，迁移后删除。
const LEGACY_SOURCE_PRIORITY_STORAGE = 'wdtvSourcePriority';
// 默认分级：一级为天涯、暴风；二级为巨量、如意、非凡、量子；未列出的源默认三级。
const DEFAULT_SOURCE_TIERS = {
    tyyszy: 1, bfzy: 1,
    juliang: 2, ruyi: 2, ffzy: 2, lzi: 2
};

// 拼接资源站接口 URL：
//   多数源 api 字段是完整采集地址（https://tyyszyapi.com/api.php/provide/vod/），
//   直接拼接 API_CONFIG 的 path 会出现双重路径；
//   另一些源把完整接口地址填进 api 字段（…/api.php/provide/vod、
//   …/from/jsm3u8/at/json/、旧路径 …/provide/vod/ 等），此时再拼 path 会出现
//   …/provide/vod/api.php/provide/vod/?ac=… 双重路径（ERR_ABORTED）。
//   检测到 base 已包含 /provide/vod（后接 / 或结尾）时只补查询串（保留原始尾斜杠，
//   直接拼 ?ac=…，避免 …/at/json//?ac=… 这类重复斜杠）。
function buildVodApiUrl(apiBase, path) {
    if (!apiBase) return path;
    const raw = String(apiBase);
    const base = raw.replace(/\/+$/, '');
    const qIdx = path.indexOf('?');
    const query = qIdx >= 0 ? path.slice(qIdx) : '';
    if (/\/provide\/vod(?:\/|$)/i.test(base)) {
        return raw + query;
    }
    return base + path;
}

// 安全解析采集接口 JSON：巨量等源的 vod_id 是 18 位整数，直接 JSON.parse 会因
// Number 精度上限（2^53）把 629659042301607941 变成 629659042301608000，
// 再用这个错误 ID 请求详情必然为空（表现为「未找到播放源」）。
// 仅对 ID 类字段的大整数字面量加引号，其余数字保持原类型，避免影响其它源的数据语义。
function parseCmsJsonSafe(text) {
    const raw = String(text == null ? '' : text);
    const safe = raw.replace(/("(?:vod_id(?:_\d+)?|id|type_id|parent_id)"\s*:\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"');
    return JSON.parse(safe);
}

// 个别内置源不支持标准 wd= 搜索参数（天涯资源只认 keywords=）。
// 仅在源配置显式声明 searchParam 时替换 path 里的 wd=，默认源行为完全不变。
function applySearchParam(path, site) {
    const param = site && site.searchParam;
    if (!param || param === 'wd' || typeof path !== 'string') return path;
    return path.replace(/([?&])wd=/, '$1' + param + '=');
}

// 封面图床域名归一（搜索/详情/换源/我的影院统一生效）：
//   1) 如意资源旧图床 ps.ryzypics.com DNS 异常，实测同样 /upload/... 路径在 pic.ry-pic.com 可用；
//      ry-pic.com 裸域也统一归一到 pic.ry-pic.com。
//   2) 暴风资源 p.bfp*.com、量子资源 p.lzp*.com 图床在部分网络被解析到 127.0.0.1，
//      实测采集主机同路径可直接出图（内容随路径变化，不是统一占位图），
//      分别归一到 apibfzy.com / lzzyapi.com，避免列表与详情封面全部退化成占位图。
// 与豆瓣封面 img9 域名改写（见 douban.js）同理，在数据层修正。
function normalizeRuyiPicUrl(url) {
    if (!url || typeof url !== 'string') return url || '';
    return url
        .replace(/\/\/(?:ps\.ryzypics\.com|ry-pic\.com)\//i, '//pic.ry-pic.com/')
        .replace(/\/\/p\.bfp\d*\.com\//i, '//apibfzy.com/')
        .replace(/\/\/p\.lzp\d*\.com\//i, '//lzzyapi.com/');
}

// 源线路：主线路固定 id=primary，备用线路来自 API_SITES[key].routes（默认不参与搜索）。
function getSourceRoutes(source) {
    const site = API_SITES[source];
    if (!site) return [];
    const out = [{ id: 'primary', label: site.primaryLabel || '默认线路', api: site.api }];
    (Array.isArray(site.routes) ? site.routes : []).forEach(function (r) {
        if (r && r.id && r.api && r.id !== 'primary') {
            out.push({ id: r.id, label: r.label || r.id, api: r.api, note: r.note || '' });
        }
    });
    return out;
}

function getSourceRoute(source, routeId) {
    const routes = getSourceRoutes(source);
    if (!routes.length) return null;
    if (!routeId || routeId === 'primary') return routes[0];
    return routes.find(function (r) { return r.id === routeId; }) || routes[0];
}

// 暴露到全局（只读使用：不提供运行时新增/删除源的方法，源集合以本文件为准）
window.API_SITES = API_SITES;
window.applySearchParam = applySearchParam;
window.normalizeRuyiPicUrl = normalizeRuyiPicUrl;
window.getSourceRoutes = getSourceRoutes;
window.getSourceRoute = getSourceRoute;
window.parseCmsJsonSafe = parseCmsJsonSafe;
window.SOURCE_TIER_LEVELS = SOURCE_TIER_LEVELS;
window.SOURCE_TIER_STORAGE = SOURCE_TIER_STORAGE;
window.LEGACY_SOURCE_PRIORITY_STORAGE = LEGACY_SOURCE_PRIORITY_STORAGE;
window.DEFAULT_SOURCE_TIERS = DEFAULT_SOURCE_TIERS;

// 添加聚合搜索的配置选项
const AGGREGATED_SEARCH_CONFIG = {
    enabled: true,             // 是否启用聚合搜索
    timeout: 8000,            // 单个源超时时间（毫秒）
    maxResults: 10000,          // 最大结果数量
    parallelRequests: true,   // 是否并行请求所有源
    showSourceBadges: true    // 是否显示来源徽章
};

// 抽象API请求配置
const API_CONFIG = {
    search: {
        // 修改搜索接口为返回更多详细数据（包括视频封面、简介和播放列表）
        path: '/api.php/provide/vod/?ac=videolist&wd=',
        pagePath: '/api.php/provide/vod/?ac=videolist&wd={query}&pg={page}',
        // 首次搜索每源最多获取页数（第 1 页立即返回，其余在后台并行补抓）。
        // 仅放大该值会让每个源的请求量成倍增加、拖慢整体搜索，因此超出部分不自动抓，
        // 由用户翻页时按需补抓（每源每次最多 loadMorePages 页）。
        maxPages: 5,
        loadMorePages: 5, // 翻页补抓时每源最多抓取的页数
        resultsPerPage: 120, // 搜索结果每页展示条数（前端分页栏按此切分，每页 120 条）
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'application/json'
        }
    },
    detail: {
        // 修改详情接口也使用videolist接口，但是通过ID查询，减少请求次数
        path: '/api.php/provide/vod/?ac=videolist&ids=',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'application/json'
        }
    }
};

// 优化后的正则表达式模式
const M3U8_PATTERN = /\$https?:\/\/[^"'\s]+?\.m3u8/g;

// 添加自定义播放器URL
const CUSTOM_PLAYER_URL = 'player.html'; // 使用相对路径引用本地player.html

// 增加视频播放相关配置
const PLAYER_CONFIG = {
    autoplay: true,
    allowFullscreen: true,
    width: '100%',
    height: '600',
    timeout: 15000,  // 播放器加载超时时间
    filterAds: true,  // 是否启用广告过滤
    autoPlayNext: true,  // 默认启用自动连播功能
    adFilteringEnabled: true, // 默认开启分片广告过滤
    adFilteringStorage: 'adFilteringEnabled', // 存储广告过滤设置的键名
    adAutoSkipEnabled: true, // 低置信度可疑广告区域播放时自动 seek 跳过（默认开启）
    adAutoSkipStorage: 'adAutoSkipEnabled', // 存储广告自动跳过设置的键名
    introSkipEnabled: true, // 播放器内「自动跳过片头片尾」开关，默认开启
    introSkipStorage: 'wdtvIntroSkipEnabled', // 新开关的本地存储键（仅本地，不参与云同步）
    skipMarksStorage: 'wdtvSkipMarks', // 历史标记数据键，仅作为兼容取数，不再写入
    skipCustomStorage: 'wdtvSkipCustom', // 用户自定义片头/片尾时长（按归一化片名，跨剧集生效）
    skipAutoStorage: 'wdtvSkipAutoEnabled', // 子开关：自动跳过（与自定义可同时开启）
    skipCustomEnabledStorage: 'wdtvSkipCustomEnabled', // 子开关：自定义跳过（与自动可同时开启）
    showCacheButtonStorage: 'showCacheButton', // 是否在播放器控制栏显示缓存按钮（默认关闭）
    autoCacheStorage: 'autoCacheEnabled' // 播放时是否自动后台缓存整集（默认开启）
};

// 增加错误信息本地化
const ERROR_MESSAGES = {
    NETWORK_ERROR: '网络连接错误，请检查网络设置',
    TIMEOUT_ERROR: '请求超时，服务器响应时间过长',
    API_ERROR: 'API接口返回错误，请尝试更换数据源',
    PLAYER_ERROR: '播放器加载失败，请尝试其他视频源',
    UNKNOWN_ERROR: '发生未知错误，请刷新页面重试'
};

// 添加进一步安全设置
const SECURITY_CONFIG = {
    enableXSSProtection: true,  // 是否启用XSS保护
    sanitizeUrls: true,         // 是否清理URL
    maxQueryLength: 100,        // 最大搜索长度
    // allowedApiDomains 不再需要，因为所有请求都通过内部代理
};
