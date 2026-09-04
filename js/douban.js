// 豆瓣热门电影电视剧推荐功能

// 豆瓣标签列表 - 修改为默认标签
let defaultMovieTags = ['热门', '最新', '经典', '豆瓣高分', '冷门佳片', '喜剧', '爱情', '科幻', '悬疑', '恐怖', '治愈'];
let defaultTvTags = ['热门', '美剧', '英剧', '韩剧', '日剧', '国产剧', '港剧', '日本动画', '综艺', '纪录片'];

// 用户标签列表 - 存储用户实际使用的标签（包含保留的系统标签和用户添加的自定义标签）
let movieTags = [];
let tvTags = [];

// 加载用户标签
function loadUserTags() {
    try {
        // 尝试从本地存储加载用户保存的标签
        const savedMovieTags = localStorage.getItem('userMovieTags');
        const savedTvTags = localStorage.getItem('userTvTags');
        
        // 需要移除的标签列表
        const tagsToRemove = ['华语', '欧美', '韩国', '日本', '动作', '日综'];
        
        // 如果本地存储中有标签数据，则使用它
        if (savedMovieTags) {
            movieTags = JSON.parse(savedMovieTags);
            // 过滤掉不需要的标签
            movieTags = movieTags.filter(tag => !tagsToRemove.includes(tag));
        } else {
            // 否则使用默认标签
            movieTags = [...defaultMovieTags];
        }
        
        if (savedTvTags) {
            tvTags = JSON.parse(savedTvTags);
            // 过滤掉不需要的标签
            tvTags = tvTags.filter(tag => !tagsToRemove.includes(tag));
        } else {
            // 否则使用默认标签
            tvTags = [...defaultTvTags];
        }
        
        // 保存过滤后的标签
        saveUserTags();
    } catch (e) {
        console.error('加载标签失败：', e);
        // 初始化为默认值，防止错误
        movieTags = [...defaultMovieTags];
        tvTags = [...defaultTvTags];
    }
}

// 保存用户标签
function saveUserTags() {
    try {
        localStorage.setItem('userMovieTags', JSON.stringify(movieTags));
        localStorage.setItem('userTvTags', JSON.stringify(tvTags));
    } catch (e) {
        console.error('保存标签失败：', e);
        showToast('保存标签失败', 'error');
    }
}

let doubanMovieTvCurrentSwitch = 'movie';
let doubanCurrentTag = '热门';
let doubanPageStart = 0;
const doubanPageSize = 16; // 一次显示的项目数量

// 初始化豆瓣功能
function initDouban() {
    // 设置豆瓣开关的初始状态
    const doubanToggle = document.getElementById('doubanToggle');
    if (doubanToggle) {
        const isEnabled = localStorage.getItem('doubanEnabled') === 'true';
        doubanToggle.checked = isEnabled;
        
        // 添加事件监听 - 样式由 CSS 自动处理
        doubanToggle.addEventListener('change', function(e) {
            const isChecked = e.target.checked;
            localStorage.setItem('doubanEnabled', isChecked);
            
            // 更新显示状态
            updateDoubanVisibility();
        });
        
        // 初始更新显示状态
        updateDoubanVisibility();

        // 滚动到页面顶部
        window.scrollTo(0, 0);
    }

    // 加载用户标签
    loadUserTags();

    // 渲染电影/电视剧切换
    renderDoubanMovieTvSwitch();
    
    // 渲染豆瓣标签
    renderDoubanTags();
    
    // 换一批按钮事件监听
    setupDoubanRefreshBtn();
    
    // 初始加载热门内容
    if (localStorage.getItem('doubanEnabled') === 'true') {
        renderRecommend(doubanCurrentTag, doubanPageSize, doubanPageStart);
    }
}

// 根据设置更新豆瓣区域的显示状态
function updateDoubanVisibility() {
    const doubanArea = document.getElementById('doubanArea');
    if (!doubanArea) return;
    
    const isEnabled = localStorage.getItem('doubanEnabled') === 'true';
    const isSearching = document.getElementById('resultsArea') && 
        !document.getElementById('resultsArea').classList.contains('hidden');
    
    // 只有在启用且没有搜索结果显示时才显示豆瓣区域
    if (isEnabled && !isSearching) {
        doubanArea.classList.remove('hidden');
        // 如果豆瓣结果为空，重新加载
        if (document.getElementById('douban-results').children.length === 0) {
            renderRecommend(doubanCurrentTag, doubanPageSize, doubanPageStart);
        }
    } else {
        doubanArea.classList.add('hidden');
    }
}

// 只填充搜索框，不执行搜索，让用户自主决定搜索时机
function fillSearchInput(title) {
    if (!title) return;
    
    // 安全处理标题，防止XSS
    const safeTitle = title
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    
    const input = document.getElementById('searchInput');
    if (input) {
        input.value = safeTitle;
        
        // 聚焦搜索框，便于用户立即使用键盘操作
        input.focus();
        
        // 显示一个提示，告知用户点击搜索按钮进行搜索
        showToast('已填充搜索内容，点击搜索按钮开始搜索', 'info');
    }
}

// 填充搜索框并执行搜索
function fillAndSearch(title) {
    if (!title) return;
    
    // 安全处理标题，防止XSS
    const safeTitle = title
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    
    const input = document.getElementById('searchInput');
    if (input) {
        input.value = safeTitle;
        search(); // 使用已有的search函数执行搜索
        
        // 同时更新浏览器URL，使其反映当前的搜索状态
        try {
            // 使用URI编码确保特殊字符能够正确显示
            const encodedQuery = encodeURIComponent(safeTitle);
            // 使用HTML5 History API更新URL，不刷新页面
            window.history.pushState(
                { search: safeTitle }, 
                `搜索: ${safeTitle} - WDTV`, 
                `/s=${encodedQuery}`
            );
            // 更新页面标题
            document.title = `搜索: ${safeTitle} - WDTV`;
        } catch (e) {
            console.error('更新浏览器历史失败:', e);
        }
    }
}

// 填充搜索框，确保豆瓣资源API被选中，然后执行搜索
async function fillAndSearchWithDouban(title) {
    if (!title) return;
    
    // 安全处理标题，防止XSS
    const safeTitle = title
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    
    // 确保豆瓣资源API被选中
    if (typeof selectedAPIs !== 'undefined' && !selectedAPIs.includes('dbzy')) {
        // 在设置中勾选豆瓣资源API复选框
        const doubanCheckbox = document.querySelector('input[id="api_dbzy"]');
        if (doubanCheckbox) {
            doubanCheckbox.checked = true;
            
            // 触发updateSelectedAPIs函数以更新状态
            if (typeof updateSelectedAPIs === 'function') {
                updateSelectedAPIs();
            } else {
                // 如果函数不可用，则手动添加到selectedAPIs
                selectedAPIs.push('dbzy');
                localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));
                
                // 更新选中API计数（如果有这个元素）
                const countEl = document.getElementById('selectedAPICount');
                if (countEl) {
                    countEl.textContent = selectedAPIs.length;
                }
            }
            
            showToast('已自动选择豆瓣资源API', 'info');
        }
    }
    
    // 填充搜索框并执行搜索
    const input = document.getElementById('searchInput');
    if (input) {
        input.value = safeTitle;
        await search(); // 使用已有的search函数执行搜索
        
        // 更新浏览器URL，使其反映当前的搜索状态
        try {
            // 使用URI编码确保特殊字符能够正确显示
            const encodedQuery = encodeURIComponent(safeTitle);
            // 使用HTML5 History API更新URL，不刷新页面
            window.history.pushState(
                { search: safeTitle }, 
                `搜索: ${safeTitle} - WDTV`, 
                `/s=${encodedQuery}`
            );
            // 更新页面标题
            document.title = `搜索: ${safeTitle} - WDTV`;
        } catch (e) {
            console.error('更新浏览器历史失败:', e);
        }

        if (window.innerWidth <= 768) {
          window.scrollTo({
              top: 0,
              behavior: 'smooth'
          });
        }
    }
}

// 渲染电影/电视剧切换器
function renderDoubanMovieTvSwitch() {
    // 获取切换按钮元素
    const movieToggle = document.getElementById('douban-movie-toggle');
    const tvToggle = document.getElementById('douban-tv-toggle');

    if (!movieToggle ||!tvToggle) return;

    movieToggle.addEventListener('click', function() {
        if (doubanMovieTvCurrentSwitch !== 'movie') {
            // 更新按钮样式 - 使用 active 类
            movieToggle.classList.add('active');
            tvToggle.classList.remove('active');
            
            doubanMovieTvCurrentSwitch = 'movie';
            doubanCurrentTag = '热门';

            // 重新加载豆瓣内容
            renderDoubanTags(movieTags);

            // 换一批按钮事件监听
            setupDoubanRefreshBtn();
            
            // 初始加载热门内容
            if (localStorage.getItem('doubanEnabled') === 'true') {
                renderRecommend(doubanCurrentTag, doubanPageSize, doubanPageStart);
            }
        }
    });
    
    // 电视剧按钮点击事件
    tvToggle.addEventListener('click', function() {
        if (doubanMovieTvCurrentSwitch !== 'tv') {
            // 更新按钮样式 - 使用 active 类
            tvToggle.classList.add('active');
            movieToggle.classList.remove('active');
            
            doubanMovieTvCurrentSwitch = 'tv';
            doubanCurrentTag = '热门';

            // 重新加载豆瓣内容
            renderDoubanTags(tvTags);

            // 换一批按钮事件监听
            setupDoubanRefreshBtn();
            
            // 初始加载热门内容
            if (localStorage.getItem('doubanEnabled') === 'true') {
                renderRecommend(doubanCurrentTag, doubanPageSize, doubanPageStart);
            }
        }
    });
}

// 渲染豆瓣标签选择器
function renderDoubanTags(tags) {
    const tagContainer = document.getElementById('douban-tags');
    if (!tagContainer) return;
    
    // 确定当前应该使用的标签列表
    const currentTags = doubanMovieTvCurrentSwitch === 'movie' ? movieTags : tvTags;
    
    // 清空标签容器
    tagContainer.innerHTML = '';

    // 先添加标签管理按钮 - 玻璃药丸风格
    const manageBtn = document.createElement('button');
    manageBtn.className = 'douban-tag flex items-center';
    manageBtn.innerHTML = '<span class="flex items-center"><svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg>管理标签</span>';
    manageBtn.onclick = function() {
        showTagManageModal();
    };
    tagContainer.appendChild(manageBtn);

    // 添加所有标签 - 玻璃药丸风格
    currentTags.forEach(tag => {
        const btn = document.createElement('button');
        // 使用统一的 douban-tag 类，选中状态用 active 修饰
        btn.className = 'douban-tag' + (tag === doubanCurrentTag ? ' active' : '');
        btn.textContent = tag;
        
        btn.onclick = function() {
            if (doubanCurrentTag !== tag) {
                doubanCurrentTag = tag;
                doubanPageStart = 0;
                renderRecommend(doubanCurrentTag, doubanPageSize, doubanPageStart);
                renderDoubanTags();
            }
        };

        tagContainer.appendChild(btn);
    });

    // 标签行为单行横向滚动，确保选中标签在可视范围内
    const activeBtn = tagContainer.querySelector('.douban-tag.active');
    if (activeBtn && activeBtn.scrollIntoView) {
        activeBtn.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }
}

// 设置换一批按钮事件
function setupDoubanRefreshBtn() {
    // 修复ID，使用正确的ID douban-refresh 而不是 douban-refresh-btn
    const btn = document.getElementById('douban-refresh');
    if (!btn) return;
    
    btn.onclick = function() {
        doubanPageStart += doubanPageSize;
        if (doubanPageStart > 9 * doubanPageSize) {
            doubanPageStart = 0;
        }
        
        renderRecommend(doubanCurrentTag, doubanPageSize, doubanPageStart);
    };
}

function fetchDoubanTags() {
    const movieTagsTarget = `https://movie.douban.com/j/search_tags?type=movie`
    fetchDoubanData(movieTagsTarget)
        .then(data => {
            movieTags = data.tags;
            if (doubanMovieTvCurrentSwitch === 'movie') {
                renderDoubanTags(movieTags);
            }
        })
        .catch(error => {
            console.error("获取豆瓣热门电影标签失败：", error);
        });
    const tvTagsTarget = `https://movie.douban.com/j/search_tags?type=tv`
    fetchDoubanData(tvTagsTarget)
       .then(data => {
            tvTags = data.tags;
            if (doubanMovieTvCurrentSwitch === 'tv') {
                renderDoubanTags(tvTags);
            }
        })
       .catch(error => {
            console.error("获取豆瓣热门电视剧标签失败：", error);
        });
}

// 豆瓣数据会话缓存：相同 type+tag+pageStart 10 分钟内直接复用，免远程往返
const DOUBAN_CACHE_PREFIX = 'wdtvDoubanCache_';
const DOUBAN_CACHE_TTL = 10 * 60 * 1000;

async function fetchDoubanDataCached(url) {
    const cacheKey = DOUBAN_CACHE_PREFIX + url; // url 已含 type/tag/page_limit/page_start 参数
    try {
        const raw = sessionStorage.getItem(cacheKey);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && Date.now() - parsed.ts < DOUBAN_CACHE_TTL) return parsed.data;
        }
    } catch (e) { /* 缓存读取失败继续请求 */ }

    const data = await fetchDoubanData(url);
    try {
        sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data }));
    } catch (e) { /* 缓存写入失败不影响展示 */ }
    return data;
}

// 渲染热门推荐内容
function renderRecommend(tag, pageLimit, pageStart) {
    const container = document.getElementById("douban-results");
    if (!container) return;

    const target = `https://movie.douban.com/j/search_subjects?type=${doubanMovieTvCurrentSwitch}&tag=${tag}&sort=recommend&page_limit=${pageLimit}&page_start=${pageStart}`;

    // 请求期间渲染骨架屏占位，消除空白与"换一批"僵持
    renderDoubanSkeleton(container);

    // 使用通用请求函数（带会话缓存）
    fetchDoubanDataCached(target)
        .then(data => {
            renderDoubanCards(data, container);
        })
        .catch(error => {
            console.error("获取豆瓣数据失败：", error);
            container.innerHTML = `
                <div class="col-span-full">
                    <div class="empty-state-glass">
                        <div style="color: #ff453a; font-size: 1.1rem; font-weight: 500;">❌ 获取豆瓣数据失败，请稍后重试</div>
                        <div style="color: var(--text-muted); font-size: 0.875rem; margin-top: 0.5rem;">提示：使用VPN可能有助于解决此问题</div>
                    </div>
                </div>
            `;
        });
}

// 渲染灰底占位骨架卡（数量与一页一致，配合 CSS 脉动动画）
function renderDoubanSkeleton(container) {
    let html = '';
    for (let i = 0; i < doubanPageSize; i++) {
        html += `
            <div class="douban-card flex flex-col" aria-hidden="true">
                <div class="douban-card-image wdtv-skeleton"></div>
                <div class="douban-card-title-area">
                    <div class="wdtv-skeleton wdtv-skeleton-text"></div>
                </div>
            </div>
        `;
    }
    container.innerHTML = html;
}

async function fetchDoubanData(url) {
    // 添加超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
    
    // 设置请求选项，包括信号和头部
    const fetchOptions = {
        signal: controller.signal,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Referer': 'https://movie.douban.com/',
            'Accept': 'application/json, text/plain, */*',
        }
    };

    try {
        const proxiedUrl = PROXY_URL + encodeURIComponent(url);
            
        // 尝试直接访问（豆瓣API可能允许部分CORS请求）
        const response = await fetch(proxiedUrl, fetchOptions);
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        
        return await response.json();
    } catch (err) {
        console.error("豆瓣 API 请求失败（直接代理）：", err);
        
        // 失败后尝试备用方法：作为备选
        const fallbackUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
        
        try {
            const fallbackResponse = await fetch(fallbackUrl);
            
            if (!fallbackResponse.ok) {
                throw new Error(`备用API请求失败! 状态: ${fallbackResponse.status}`);
            }
            
            const data = await fallbackResponse.json();
            
            // 解析原始内容
            if (data && data.contents) {
                return JSON.parse(data.contents);
            } else {
                throw new Error("无法获取有效数据");
            }
        } catch (fallbackErr) {
            console.error("豆瓣 API 备用请求也失败：", fallbackErr);
            throw fallbackErr; // 向上抛出错误，让调用者处理
        }
    }
}

// 豆瓣封面加载队列：避免突发并发触发豆瓣CDN限流，限制同时加载的数量并错开启动；
// 直连失败（豆瓣按"URL+Referer"确定性拒绝）时自动回退到本项目代理加载
const doubanImageQueue = {
    items: [],
    active: 0,
    maxActive: 2,
    startGapMs: 200,
    enqueue(img) {
        this.items.push(img);
        this.pump();
    },
    pump() {
        if (this.active >= this.maxActive || this.items.length === 0) return;
        const img = this.items.shift();
        this.active++;
        this.loadOne(img);
        setTimeout(() => this.pump(), this.startGapMs);
    },
    release(img) {
        this.active--;
        this.pump();
    },
    loadOne(img) {
        // 已被后续渲染替换的节点直接跳过
        if (!img.isConnected) {
            this.release(img);
            return;
        }
        const src = img.dataset.cover;
        img.onload = () => {
            img.onload = img.onerror = null;
            this.release(img);
        };
        img.onerror = async () => {
            img.onload = img.onerror = null;
            img.classList.add('object-contain');
            // 豆瓣CDN按"URL+Referer"确定性拒绝（418/403），浏览器无法伪造豆瓣Referer，
            // 重试直连无意义，直接走本项目代理（服务端会补上豆瓣Referer）
            const proxied = PROXY_URL + encodeURIComponent(src);
            img.src = proxied;
            this.release(img);
        };
        img.src = src;
    }
};

// 抽取渲染豆瓣卡片的逻辑到单独函数
function renderDoubanCards(data, container) {
    // 创建文档片段以提高性能
    const fragment = document.createDocumentFragment();
    
    // 如果没有数据
    if (!data.subjects || data.subjects.length === 0) {
        const emptyEl = document.createElement("div");
        emptyEl.className = "col-span-full";
        emptyEl.innerHTML = `
            <div class="empty-state-glass">
                <div style="color: #ff9f0a; font-size: 1.1rem; font-weight: 500;">❌ 暂无数据，请尝试其他分类或刷新</div>
            </div>
        `;
        fragment.appendChild(emptyEl);
    } else {
        // 循环创建每个影视卡片 - 液态玻璃风格
        data.subjects.forEach(item => {
            const card = document.createElement("div");
            card.className = "douban-card flex flex-col";
            
            // 生成卡片内容，确保安全显示（防止XSS）
            const safeTitle = item.title
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
            
            const safeRate = (item.rate || "暂无")
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            
            // 处理图片URL
            // 1. 直接使用豆瓣图片URL（豆瓣CDN要求请求必须携带Referer，禁止no-referrer）
            // 注意：豆瓣各图片节点防盗链宽严不一——img9 容忍外部 Referer，
            // 而 img1/img2/img3 对外部 Referer 返回 403（仅豆瓣自家 Referer 可通过）。
            // 图片路径在各节点通用，因此统一改写到 img9，否则部分封面必然加载失败。
            const originalCoverUrl = (item.cover || '').replace(/\/\/img\d+\.doubanio\.com/, '//img9.doubanio.com');

            // 玻璃风格卡片内容
            card.innerHTML = `
                <div class="douban-card-image cursor-pointer" onclick="fillAndSearchWithDouban('${safeTitle}')">
                    <img alt="${safeTitle}" data-cover="${originalCoverUrl}"
                        loading="lazy">
                    <div class="absolute inset-0" style="background: linear-gradient(to top, rgba(0,0,0,0.6), transparent 50%); pointer-events: none;"></div>
                    <div class="absolute bottom-2 left-2 douban-rate-badge">
                        <span style="color: #ffd60a;">★</span> ${safeRate}
                    </div>
                    <div class="absolute bottom-2 right-2 douban-rate-badge" style="padding: 0.25rem 0.5rem;">
                        <a href="${item.url}" target="_blank" rel="noopener noreferrer" title="在豆瓣查看" onclick="event.stopPropagation();" style="text-decoration: none;">
                            🔗
                        </a>
                    </div>
                </div>
                <div class="douban-card-title-area">
                    <button onclick="fillAndSearchWithDouban('${safeTitle}')"
                            class="text-sm font-medium truncate w-full transition"
                            style="color: #1d1d1f; background: transparent; border: none; cursor: pointer; padding: 0;"
                            title="${safeTitle}">
                        ${safeTitle}
                    </button>
                </div>
            `;
            
            fragment.appendChild(card);
        });
    }
    
    // 清空并添加所有新元素
    container.innerHTML = "";
    container.appendChild(fragment);

    // 通过限流队列加载封面，避免突发并发触发豆瓣CDN的418限流
    container.querySelectorAll('img[data-cover]').forEach(img => doubanImageQueue.enqueue(img));
}

// 重置到首页
function resetToHome() {
    resetSearchArea();
    updateDoubanVisibility();
}

// 加载豆瓣首页内容
document.addEventListener('DOMContentLoaded', initDouban);

// 显示标签管理模态框
function showTagManageModal() {
    // 确保模态框在页面上只有一个实例
    let modal = document.getElementById('tagManageModal');
    if (modal) {
        document.body.removeChild(modal);
    }
    
    // 创建模态框元素
    modal = document.createElement('div');
    modal.id = 'tagManageModal';
    modal.className = 'fixed inset-0 flex items-center justify-center z-40';
    modal.style.background = 'rgba(255, 255, 255, 0.5)';
    modal.style.backdropFilter = 'blur(20px) saturate(180%)';
    modal.style.webkitBackdropFilter = 'blur(20px) saturate(180%)';

    // 当前使用的标签类型和默认标签
    const isMovie = doubanMovieTvCurrentSwitch === 'movie';
    const currentTags = isMovie ? movieTags : tvTags;
    const defaultTags = isMovie ? defaultMovieTags : defaultTvTags;

    // 模态框内容 - 液态玻璃风格
    modal.innerHTML = `
        <div class="max-w-md w-full max-h-[90vh] overflow-y-auto relative" style="background: rgba(255,255,255,0.85); backdrop-filter: blur(50px) saturate(200%); -webkit-backdrop-filter: blur(50px) saturate(200%); border: 1px solid rgba(255,255,255,0.8); border-radius: 24px; padding: 1.5rem; box-shadow: 0 24px 80px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.95);">
            <button id="closeTagModal" style="position: absolute; top: 1rem; right: 1rem; width: 2rem; height: 2rem; border-radius: 9999px; background: rgba(255,255,255,0.6); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.8); color: #6e6e73; font-size: 1.25rem; transition: all 0.2s;">&times;</button>

            <h3 style="font-size: 1.25rem; font-weight: 700; color: #1d1d1f; margin-bottom: 1rem;">标签管理 (${isMovie ? '电影' : '电视剧'})</h3>

            <div style="margin-bottom: 1rem;">
                <div class="flex justify-between items-center mb-2">
                    <h4 style="font-size: 1rem; font-weight: 500; color: #1d1d1f;">标签列表</h4>
                    <button id="resetTagsBtn" class="settings-mini-button">恢复默认标签</button>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4" id="tagsGrid">
                    ${currentTags.length ? currentTags.map(tag => {
                        // "热门"标签不能删除
                        const canDelete = tag !== '热门';
                        return `
                            <div style="background: rgba(255,255,255,0.6); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.8); color: #1d1d1f; padding: 0.4rem 0.75rem; border-radius: 9999px; font-size: 0.875rem; font-weight: 500; display: flex; justify-content: space-between; align-items: center;" class="group">
                                <span>${tag}</span>
                                ${canDelete ?
                                    `<button class="delete-tag-btn opacity-0 group-hover:opacity-100 transition-opacity"
                                        style="color: #ff453a; background: transparent; border: none; cursor: pointer; padding: 0 0.25rem;"
                                        data-tag="${tag}">✕</button>` :
                                    `<span style="color: #6e6e73; font-size: 0.7rem; font-style: italic; opacity: 0;" class="group-hover:opacity-100 transition-opacity">必需</span>`
                                }
                            </div>
                        `;
                    }).join('') :
                    `<div class="col-span-full text-center py-4" style="color: #6e6e73;">无标签，请添加或恢复默认</div>`}
                </div>
            </div>

            <div style="border-top: 1px solid rgba(0,0,0,0.08); padding-top: 1rem;">
                <h4 style="font-size: 1rem; font-weight: 500; color: #1d1d1f; margin-bottom: 0.75rem;">添加新标签</h4>
                <form id="addTagForm" class="flex items-center">
                    <input type="text" id="newTagInput" placeholder="输入标签名称..."
                           style="flex: 1; background: rgba(255,255,255,0.6); backdrop-filter: blur(20px); color: #1d1d1f; border: 1px solid rgba(255,255,255,0.8); border-radius: 9999px; padding: 0.5rem 1rem; outline: none;">
                    <button type="submit" class="ios-primary-button ml-2">添加</button>
                </form>
                <p style="font-size: 0.75rem; color: #6e6e73; margin-top: 0.5rem;">提示：标签名称不能为空，不能重复，不能包含特殊字符</p>
            </div>
        </div>
    `;
    
    // 添加模态框到页面
    document.body.appendChild(modal);
    
    // 焦点放在输入框上
    setTimeout(() => {
        document.getElementById('newTagInput').focus();
    }, 100);
    
    // 添加事件监听器 - 关闭按钮
    document.getElementById('closeTagModal').addEventListener('click', function() {
        document.body.removeChild(modal);
    });
    
    // 添加事件监听器 - 点击模态框外部关闭
    modal.addEventListener('click', function(e) {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    });
    
    // 添加事件监听器 - 恢复默认标签按钮
    document.getElementById('resetTagsBtn').addEventListener('click', function() {
        resetTagsToDefault();
        showTagManageModal(); // 重新加载模态框
    });
    
    // 添加事件监听器 - 删除标签按钮
    const deleteButtons = document.querySelectorAll('.delete-tag-btn');
    deleteButtons.forEach(btn => {
        btn.addEventListener('click', function() {
            const tagToDelete = this.getAttribute('data-tag');
            deleteTag(tagToDelete);
            showTagManageModal(); // 重新加载模态框
        });
    });
    
    // 添加事件监听器 - 表单提交
    document.getElementById('addTagForm').addEventListener('submit', function(e) {
        e.preventDefault();
        const input = document.getElementById('newTagInput');
        const newTag = input.value.trim();
        
        if (newTag) {
            addTag(newTag);
            input.value = '';
            showTagManageModal(); // 重新加载模态框
        }
    });
}

// 添加标签
function addTag(tag) {
    // 安全处理标签名，防止XSS
    const safeTag = tag
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    
    // 确定当前使用的是电影还是电视剧标签
    const isMovie = doubanMovieTvCurrentSwitch === 'movie';
    const currentTags = isMovie ? movieTags : tvTags;
    
    // 检查是否已存在（忽略大小写）
    const exists = currentTags.some(
        existingTag => existingTag.toLowerCase() === safeTag.toLowerCase()
    );
    
    if (exists) {
        showToast('标签已存在', 'warning');
        return;
    }
    
    // 添加到对应的标签数组
    if (isMovie) {
        movieTags.push(safeTag);
    } else {
        tvTags.push(safeTag);
    }
    
    // 保存到本地存储
    saveUserTags();
    
    // 重新渲染标签
    renderDoubanTags();
    
    showToast('标签添加成功', 'success');
}

// 删除标签
function deleteTag(tag) {
    // 热门标签不能删除
    if (tag === '热门') {
        showToast('热门标签不能删除', 'warning');
        return;
    }
    
    // 确定当前使用的是电影还是电视剧标签
    const isMovie = doubanMovieTvCurrentSwitch === 'movie';
    const currentTags = isMovie ? movieTags : tvTags;
    
    // 寻找标签索引
    const index = currentTags.indexOf(tag);
    
    // 如果找到标签，则删除
    if (index !== -1) {
        currentTags.splice(index, 1);
        
        // 保存到本地存储
        saveUserTags();
        
        // 如果当前选中的是被删除的标签，则重置为"热门"
        if (doubanCurrentTag === tag) {
            doubanCurrentTag = '热门';
            doubanPageStart = 0;
            renderRecommend(doubanCurrentTag, doubanPageSize, doubanPageStart);
        }
        
        // 重新渲染标签
        renderDoubanTags();
        
        showToast('标签删除成功', 'success');
    }
}

// 重置为默认标签
function resetTagsToDefault() {
    // 确定当前使用的是电影还是电视剧
    const isMovie = doubanMovieTvCurrentSwitch === 'movie';
    
    // 重置为默认标签
    if (isMovie) {
        movieTags = [...defaultMovieTags];
    } else {
        tvTags = [...defaultTvTags];
    }
    
    // 设置当前标签为热门
    doubanCurrentTag = '热门';
    doubanPageStart = 0;
    
    // 保存到本地存储
    saveUserTags();
    
    // 重新渲染标签和内容
    renderDoubanTags();
    renderRecommend(doubanCurrentTag, doubanPageSize, doubanPageStart);
    
    showToast('已恢复默认标签', 'success');
}
