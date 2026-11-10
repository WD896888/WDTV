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
// 2026-11-09 更正（重要）：下方 14 个内置源全部保持 2026-11-08 上游原配置，一个都不替换。
//   此前用临时探测脚本判定「暴风资源不能播」并改接其它线路，属误判：暴风的播放地址路径
//   含中文（…/HD国语/index.m3u8），脚本未做百分号编码导致裸请求 404；浏览器会自动编码，
//   编码后直连即返回有效 m3u8 播放清单。「最大资源」等源的单次失败也只是链接/CDN 波动。
//   结论：服务端探测的单次结果不能作为停用或替换用户原有源的依据。
//   原 6 个停用源（黑木耳/卧龙/新华为/华为吧/豆瓣/魔爪）按上游配置保留 disabled 状态与
//   失效原因，便于日后站点恢复时直接启用；它们的域名级复核结果见 .workbuddy/memory/2026-11-09.md。
//   文件末尾 7 个源是「补充线路」，使用独立 key，不占用任何内置源槽位；如不需要，
//   整体删除末尾 7 项即可，内置 14 个源完全不受影响。
// 2026-11-10 更正：数据源订阅与自定义接入入口全线下线，此表即系统全部内置源。
//   原由 js/customer_site.js 运行时合并的「七七资源」已并入表尾（key 不变、源集合不变）；
//   页面不再加载任何外部源配置，也不再暴露运行时注入源的全局钩子。
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
    },

    // ↓ 2026-11-09 新增补充线路：独立 key，不占用上方任何内置源的槽位。
    //   来源为公开采集源清单（ZxxXinI/tvbox 线路表、LunaTV-config 每日健康报告等），
    //   均经「搜索 list>0 + 详情含播放地址 + 播放清单可取」实测。删除以下 6 项即可完整还原内置配置。
    maoyan: {
        api: 'https://api.maoyanapi.top',
        name: '猫眼资源',
        detailMode: 'api'   // 线路表 myzy；搜索 30 条，播放清单双路径有效
    },
    lzi: {
        api: 'https://cj.lziapi.com',
        name: '量子资源',
        detailMode: 'api'   // 线路表 lzi；搜索 20 条，播放清单有效
    },
    jyzy: {
        api: 'https://jyzyapi.com',
        name: '金鹰资源',
        detailMode: 'api'   // 公开播放器源列表；搜索 20 条，播放清单双路径有效
    },
    subo: {
        api: 'https://subocaiji.com',
        name: '速博资源',
        detailMode: 'api'   // 线路表 subocaiji；搜索 20 条，播放清单双路径有效
    },
    hhzy: {
        api: 'https://hhzyapi.com',
        name: '豪华资源',
        detailMode: 'api'   // 线路表 hhzyapi；搜索 20 条，播放清单双路径有效
    },
    ikun: {
        api: 'https://www.ikunzy.com',
        name: 'iKun资源',
        detailMode: 'api'   // 线路表 ikun；库约 6.7 万条，播放清单双路径有效
    },
    // 原 js/customer_site.js 的七七资源：v97 起并入内置（key 与源集合均不变）
    qiqi: {
        api: 'https://www.qiqidys.com/api.php/provide/vod',
        name: '七七资源'
    }
};

// 拼接资源站接口 URL：
//   多数源 api 字段是纯域名（https://json.heimuer.xyz），直接拼接 API_CONFIG 的 path；
//   七七资源等源把完整接口地址填进 api 字段（…/api.php/provide/vod），
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

// 暴露到全局（只读使用：不提供运行时新增/删除源的方法，源集合以本文件为准）
window.API_SITES = API_SITES;
window.applySearchParam = applySearchParam;
window.normalizeRuyiPicUrl = normalizeRuyiPicUrl;

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
