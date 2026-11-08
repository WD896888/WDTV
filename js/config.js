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
const API_SITES = {
    heimuer: {
        api: 'https://json.heimuer.xyz',
        name: '黑木耳',
        detail: 'https://heimuer.tv',
        detailMode: 'api',  // 实测：详情页被反爬验证页拦截（无法提取 m3u8），标准接口可用
        // 2026-11-08 体检：json.heimuer.xyz 已跳转域名停放页（urldance.com，返回 HTML），
        // detail 域 heimuer.tv TLS 证书链无效；官方渠道未能确认新址，标注停用但保留配置便于回溯。
        disabled: true,
        disabledReason: '域名已跳转停放页，未获官方确认的新地址'
    },
    ffzy: {
        api: 'http://ffzy5.tv',
        name: '非凡影视',
        detail: 'http://ffzy5.tv',
        detailMode: 'api'   // 实测：详情页返回 5xx，标准接口可用；若详情页恢复可改回 'html'（历史集数更全）
    },
    tyyszy: {
        api: 'https://tyyszy.com',
        name: '天涯资源',
        detailMode: 'api',  // 2026-11-08 实测：详情接口正常（plays=7）
        // 该源不认标准 wd= 参数（返回"暂不支持搜索"），只认 keywords=；实测可返回 20 条。
        searchParam: 'keywords'
    },
    zy360: {
        api: 'https://360zy.com',
        name: '360资源',
        detailMode: 'api'
    },
    wolong: {
        api: 'https://wolongzyw.com',
        name: '卧龙资源',
        detailMode: 'api',
        // 2026-11-08 体检：站点返回 Angie WAF 的 JS 挑战页（HTML），代理与直连都无法拿到 JSON。
        disabled: true,
        disabledReason: '接口被 WAF JS 挑战拦截，未获官方确认的新地址'
    },
    cjhw: {
        api: 'https://cjhwba.com',
        name: '新华为',
        detailMode: 'api',
        // 2026-11-08 体检：DNS 解析失败（ENOENT），域名已不存在。
        disabled: true,
        disabledReason: 'DNS 解析失败（ENOENT），域名失效'
    },
    hwba: {
        api: 'https://cjwba.com',
        name: '华为吧资源',
        detailMode: 'api',
        // 2026-11-08 体检：DNS 解析失败（ENOTFOUND），域名已不存在。
        disabled: true,
        disabledReason: 'DNS 解析失败（ENOTFOUND），域名失效'
    },
    jisu: {
        api: 'https://jszyapi.com',
        name: '极速资源',
        detail: 'https://jszyapi.com',
        detailMode: 'auto'  // 实测：接口与详情页稳定性均一般，双路径互为兜底
    },
    dbzy: {
        api: 'https://dbzy.com',
        name: '豆瓣资源',
        detailMode: 'api',
        // 2026-11-08 体检：http 返回「dbzy.com is For Sale」域名出售页，https 连接超时。
        disabled: true,
        disabledReason: '域名已挂牌出售，服务停止'
    },
    bfzy: {
        api: 'https://bfzyapi.com',
        name: '暴风资源',
        detailMode: 'api'   // 实测：搜索与标准接口详情均正常（46集）
    },
    mozhua: {
        api: 'https://mozhuazy.com',
        name: '魔爪资源',
        detailMode: 'api',
        // 2026-11-08 体检：DNS 可解析，但 TCP 连接超时（20s），服务不可达。
        disabled: true,
        disabledReason: '连接超时，服务不可达'
    },
    mdzy: {
        api: 'https://www.mdzyapi.com',
        name: '魔都资源',
        detailMode: 'api'   // 实测：搜索与标准接口详情均正常（74集）
    },
    ruyi: {
        api: 'https://www.ryzyw.com',
        name: '如意资源',
        detailMode: 'api',  // 实测：搜索与详情接口均正常（20 条，含播放地址）
        // 2026-11-08 复检：原地址 cj.rycjapi.com 在本机直连与本地 /proxy/ 均被域名级重置
        // （直连 ECONNRESET 约 130ms，代理回 500 UPSTREAM_FAILED），并非源站停服：
        // 同源官方站 www.ryzyw.com（CNAME 同为 ry.ivipcdn.com、封面图床同为 pic.ry-pic.com）
        // 直连与代理都能返回完整 JSON。故切换到该域名并恢复启用，原址保留便于回溯。
        previousUrl: 'https://cj.rycjapi.com'
    },
    zuid: {
        api: 'https://api.zuidapi.com',
        name: '最大资源',
        detailMode: 'api'
    }
    // 您可以按需添加更多源
};

// 定义合并方法
function extendAPISites(newSites) {
    Object.assign(API_SITES, newSites);
}

// 拼接资源站接口 URL：
//   内置源 api 字段是纯域名（https://json.heimuer.xyz），直接拼接 API_CONFIG 的 path；
//   自定义源（customer_site）常把完整接口地址填进 api 字段（…/api.php/provide/vod），
//   此时再拼 path 会出现 …/provide/vod/api.php/provide/vod/?ac=… 双重路径（ERR_ABORTED）。
//   检测到 base 已包含接口路径时只补查询串。
function buildVodApiUrl(apiBase, path) {
    if (!apiBase) return path;
    const base = String(apiBase).replace(/\/+$/, '');
    const qIdx = path.indexOf('?');
    const barePath = (qIdx >= 0 ? path.slice(0, qIdx) : path).replace(/\/+$/, '');
    const query = qIdx >= 0 ? path.slice(qIdx) : '';
    if (barePath && base.toLowerCase().endsWith(barePath.toLowerCase())) {
        return base + query;
    }
    return base + path;
}

// 个别内置源不支持标准 wd= 搜索参数（天涯资源只认 keywords=）。
// 仅在源配置显式声明 searchParam 时替换 path 里的 wd=，默认源行为完全不变。
function applySearchParam(path, site) {
    const param = site && site.searchParam;
    if (!param || param === 'wd' || typeof path !== 'string') return path;
    return path.replace(/([?&])wd=/, '$1' + param + '=');
}

// 如意资源封面图床域名归一：
// 其旧图床 ps.ryzypics.com DNS 解析异常（AAAA 记录指向 Facebook 网段，IPv4/IPv6 均无法连通），
// 实测同样的 /upload/... 资源路径在 pic.ry-pic.com 全部可用（返回文件字节级一致）；
// ry-pic.com 裸域也统一归一到 pic.ry-pic.com。
// 与豆瓣封面 img9 域名改写（见 douban.js）同理，在数据层修正，搜索/详情/换源列表统一生效
function normalizeRuyiPicUrl(url) {
    if (!url || typeof url !== 'string') return url || '';
    return url.replace(/\/\/(?:ps\.ryzypics\.com|ry-pic\.com)\//i, '//pic.ry-pic.com/');
}

// 暴露到全局
window.API_SITES = API_SITES;
window.extendAPISites = extendAPISites;
window.applySearchParam = applySearchParam;
window.normalizeRuyiPicUrl = normalizeRuyiPicUrl;

// 数据源订阅（批次3）：按 key 前缀整体移除某订阅导入的源。
// 订阅导入的源 key 形如 sub_<订阅hash>_<源hash>，移除/重新同步订阅时用前缀一次性清理，
// 不影响 extendAPISites 的合并语义，也不触碰内置源与手动添加的源（customer_site）。
window.removeAPISitesByPrefix = function (prefix) {
    if (!prefix) return 0;
    var removed = 0;
    Object.keys(API_SITES).forEach(function (key) {
        if (key.indexOf(prefix) === 0) {
            delete API_SITES[key];
            removed++;
        }
    });
    return removed;
};


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
        maxPages: 3,
        loadMorePages: 3, // 翻页补抓时每源最多抓取的页数
        resultsPerPage: 60, // 搜索结果每页展示条数（前端分页栏按此切分）
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
    adAutoSkipEnabled: false, // 低置信度可疑广告区域播放时自动 seek 跳过（默认关闭）
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
