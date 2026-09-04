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
    version: '1.0.3'
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
        detailMode: 'api'   // 实测：详情页被反爬验证页拦截（无法提取 m3u8），标准接口可用
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
        detailMode: 'api'   // 实测：搜索接口已返回"暂不支持搜索"，源基本失效
    },
    zy360: {
        api: 'https://360zy.com',
        name: '360资源',
        detailMode: 'api'
    },
    wolong: {
        api: 'https://wolongzyw.com',
        name: '卧龙资源',
        detailMode: 'api'
    },
    cjhw: {
        api: 'https://cjhwba.com',
        name: '新华为',
        detailMode: 'api'
    },
    hwba: {
        api: 'https://cjwba.com',
        name: '华为吧资源',
        detailMode: 'api'
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
        detailMode: 'api'
    },
    bfzy: {
        api: 'https://bfzyapi.com',
        name: '暴风资源',
        detailMode: 'api'   // 实测：搜索与标准接口详情均正常（46集）
    },
    mozhua: {
        api: 'https://mozhuazy.com',
        name: '魔爪资源',
        detailMode: 'api'
    },
    mdzy: {
        api: 'https://www.mdzyapi.com',
        name: '魔都资源',
        detailMode: 'api'   // 实测：搜索与标准接口详情均正常（74集）
    },
    ruyi: {
        api: 'https://cj.rycjapi.com',
        name: '如意资源',
        detailMode: 'api'   // 实测：搜索与标准接口详情均正常（74集）
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

// 暴露到全局
window.API_SITES = API_SITES;
window.extendAPISites = extendAPISites;


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
        maxPages: 2, // 最大获取页数（过大时每个源会放大数十倍请求量，拖慢整体搜索）
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
    adFilteringStorage: 'adFilteringEnabled' // 存储广告过滤设置的键名
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
