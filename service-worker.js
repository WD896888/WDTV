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
// v11（2026-09-12）：弹幕按钮拆分（控制栏复合按钮 → 右上角开关+详情幽灵按钮）+ 弹幕浮层改右上角下拉，
//                    升级缓存版本清空旧缓存，确保 player.html/css/js 新版本即时到达
// v12（2026-09-22）：修复录屏严重缺陷——移动端 captureStream 改固定帧率 30（requestFrame 时间戳在
//                    WebKit/国产内核不可靠导致成片仅 1 秒）、录制画布接入 DOM、跨域污染预检；
//                    停止后回写 MP4/WebM 容器时长元数据（修复缩略图预览时长显示 0~2 秒）；
//                    升级缓存版本清空旧缓存，确保 player.js 修复即时到达
// v13（2026-09-22）：修复安卓录屏严重卡顿/掉帧（不降画质）——移动端优先元素直捕
//                    video.captureStream()（原生管线直供编码器，去掉 canvas 逐帧绘制/GPU 回读/
//                    双份捕获负载，MP4 直录可用时走硬件编码器），canvas 绘制降为兜底路径；
//                    WebM 兜底时移动端优先 VP8（libvpx 软编成本约为 VP9 的 1/3）。分辨率/帧率/
//                    码率不变，桌面行为不变。升级缓存版本确保修复即时到达
// v14（2026-09-25）：共同观影画布工具条重构——单行紧凑布局（去预览点/分隔线），
//                    升级缓存版本确保新样式即时到达
// v15（2026-09-25）：画布层 z-index 60→55（修复画笔开启后播放器控制栏/设置面板被盖住无法点击）；
//                    点画笔默认蓝色+中等粗细并切回画笔模式。升级缓存版本确保修复即时到达
// v16（2026-09-25）：画笔按钮恢复开合切换（第二次点击收起选色面板）；
//                    工具栏尺寸 em 化+断点缩放（桌面13/手机14/平板15px 基准字号）
// v17（2026-09-25）：选色/粗细后面板保持展开（选中态即时可见，不再"点了没反应"）；
//                    画笔按钮仅在橡皮切回时重置蓝·中等，平时开合面板保留选择；
//                    二级面板背景改为与一级 dock 同款玻璃，样式统一
// v18（2026-09-25）：弹幕匹配引擎大修（一步式/锁源拉弹幕/脏记忆自愈/同集链复用）；
//                    升级缓存版本强制清空旧 danmu.js 缓存——stale-while-revalidate 曾把
//                    旧脚本当新版本 URL 的响应供应，导致新逻辑不生效
// v19（2026-09-29）：弹幕两修——comment 拉取 12s→45s（冷启动聚合 25s+ 永远被掐断）；
//                    danmuku 插件 load() 注入代次护栏（换集时旧链 resolve 清空新弹幕）
// v20（2026-09-29）：弹幕再两修——记忆映射/弹幕缓存版本校验字段 v2↔v 不匹配（缓存永不命中，
//                    预热/手动匹配全部失效）；manualSelect 重试循环成功判断误查 raw.comments
// v21（2026-09-29）：弹幕冷构建重试窗口 4s/12s→4s/12s/25s/40s——实测冷集 404 构建需 30~120s，
//                    旧窗口放弃过早转轮换源，重试风暴触发 429，自动加载恒失败只能手动
// v22（2026-09-29）：账号系统修复——登录 401 不再被前端误报为"登录已过期"（仅携带 token 的
//                    请求 401 才清会话）；用户名大小写不敏感。cloud-sync.js 升 ?v=2，
//                    升级缓存版本清空旧脚本缓存，确保修复即时到达所有设备
// v23（2026-09-29）：共同观影三栏最低尺寸自适应——缓存/操作子列保底 240px（进度条/选片
//                    卡片一排完整展示），视口 <900px 放不下三栏时自动切手机竖向堆叠。
//                    watch-party.css 升 ?v=41，升级缓存版本确保新样式即时到达（否则
//                    stale-while-revalidate 会持续回旧缓存，用户看到"改了没生效"）
// v24（2026-09-30）：M1 信息区瘦身——「搜索换片/切换缓存」双卡撤下：搜索换片入口上移到
//                    头部工具条（仅 M1 + 有控制权时显示，openWpSearchModal 同链路）；
//                    切换缓存按钮删除（双方缓存 ≥99% 自动无缝切 M2，无需手动触发）。
//                    watch-party-ui.js 升 ?v=39，升级缓存版本确保新脚本即时到达
// v25（2026-09-30）：本地缓存进度条默认隐藏——头部工具条新增「缓存」开关（M1 期间所有人
//                    可见，本地显示偏好不涉及控制权），勾选才显示 M1 双方缓存进度；
//                    覆盖率上报与自动切 M2 不受开关影响。watch-party-ui.js 升 ?v=40，
//                    升级缓存版本确保新脚本即时到达
// v26（2026-09-30）：信息区纵向节奏统一——紧凑间距规则（房态块/影片块/提示文本/房间码
//                    字号）从 ≥900px 提为观影模式全局，≤899px 堆叠不再回落宽松基础值；
//                    空 peer-hint 不再占位（去 min-height + :empty 隐藏，消除成员区下
//                    方 16px 空洞）；头部 padding-bottom 10→6、堆叠 #wpInline 上边距
//                    10→6。watch-party.css 升 ?v=42，升级缓存版本确保新样式即时到达
// v27（2026-09-30）：还原 v26 的全部间距调整（实测过挤，回到原节奏）：密度规则回到
//                    ≥900px 块内、peer-hint 恢复 min-height 16 占位、头部 padding 与
//                    堆叠 #wpInline 上边距恢复原值。watch-party.css 升 ?v=43，
//                    升级缓存版本确保还原样式即时到达
// v28（2026-09-30）：工具栏按钮一眼可读——撤销「≤1099px 隐藏文字标签」，观影模式内嵌壳
//                    ≥641px 恒显图标+文字（仅抽屉壳 340px 定宽与 ≤640px 手机窄屏保留
//                    纯图标，title 提示仍在）；搜索换片按钮文案「搜索」→「换片」更直白。
//                    watch-party.css 升 ?v=44、watch-party-ui.js 升 ?v=41，升级缓存版本
// v29（2026-09-30）：删除 M1 缓存进度块内「双方缓存完成后将自动切换到缓存播放（M2）」
//                    提示文本（房主/Guest 两变体一并移除，自动切换行为本身不变）。
//                    watch-party-ui.js 升 ?v=42，升级缓存版本确保新脚本即时到达
// v30（2026-09-30）：聊天发送按钮改半透明玻璃风格——原近实心蓝底白字与界面玻璃语言
//                    不符；改为蓝色玻璃族（bg 0.16/border 0.4 + backdrop 模糊），
//                    与工具开关激活态同族。watch-party.css 升 ?v=45，升级缓存版本
// v31（2026-09-30）：发送按钮蓝色换更年轻的浅蓝（天空蓝 rgb(88,195,255)，比主色
//                    #4aa8ff 更亮更轻快）。watch-party.css 升 ?v=46，升级缓存版本
// v32（2026-09-30）：首页观影空间 Hub 界面减负——头部改横向紧凑布局，创建/加入房间
//                    操作区上移至首屏焦点位，三个模式介绍卡压缩为底部一行图标徽章
//                    （完整说明移入悬停提示 title），移动端不再需要长距离下滑找按钮。
//                    index.css 升 ?v=26，升级缓存版本确保新样式即时到达
// v33（2026-09-30）：观影空间界面彻底重构为「双面板式」——品牌头 + 创建/加入两张并排
//                    玻璃面板（创建=主按钮蓝，加入=6 格分段房间码输入，支持粘贴分填/
//                    退格回跳/回车直达），最近房间改横向滚动胶囊，三模式介绍压缩为
//                    底部一行小字脚注（悬停看完整说明）。旧 wdtv-hub-* 结构与样式全部
//                    移除，新增 wsp-* 类族；space.js 适配分段码输入升 ?v=3，
//                    index.css 升 ?v=27，升级缓存版本确保新资源即时到达
// v34（2026-09-30）：观影空间二轮简化——创建/加入由双栏并排改为上下全宽横条：
//                    创建做成「整卡即按钮」（图标+文案+右端加号钮，悬停加号转蓝旋转），
//                    加入卡内置 6 格分段码，输满 6 位自动加入（移除提交按钮，回车
//                    仍可触发，加 joining 防重入，404 失败自动清格）；三种观影方式
//                    改为 details 二级折叠菜单（默认收起，展开看三条带图标说明）。
//                    index.css 升 ?v=28、space.js 升 ?v=4，升级缓存版本确保即时到达
// v35（2026-09-30）：创建房间卡升级为「蓝色渐变玻璃主行动卡」——与下方中性灰的加入卡
//                    拉开主次层级：蓝调渐变底 + 蓝边框光 + 蓝色投影，图标位放大为 48px
//                    白玻璃、标题加粗提亮带微光、右端加号钮增大至 40px 白玻璃（悬停旋转
//                    放大）。index.css 升 ?v=29，升级缓存版本确保新样式即时到达
// v36（2026-09-30）：创建卡布局重设计——移除右端「+」圆钮（横条+加号易误读为普通
//                    添加条目），改为：56px 白玻璃银幕图标主视觉 + 图标右上角小加号
//                    角标（主体是房间、角标才是新建）+ 右端轻量 chevron 通行箭头
//                    （卡片式 CTA「前往」语义，悬停右移）。标题加大、内边距加厚，
//                    整卡更有主行动分量。index.css 升 ?v=30，升级缓存版本
// v37（2026-09-30）：创建动作彻底回归按钮语义——去掉卡片外壳，改为大号实心渐变
//                    胶囊 CTA 按钮（加号图标 +「创建房间」居中、字重 600、宽字距），
//                    悬停提亮上浮、按压回缩；按钮下方一行居中说明小字。加入房间保持
//                    中性输入卡形态，按钮/表单语义分明。index.css 升 ?v=31
// v38（2026-09-30）：创建 CTA 按钮回归淡色透明玻璃——实心渐变蓝改为淡蓝半透明底
//                    （rgba(106,154,224,.14)）+ backdrop 模糊 + 淡蓝边框，去掉重投影，
//                    悬停仅底色加深一档；与加入卡同族玻璃语言，仅以淡蓝色调区分主次。
//                    index.css 升 ?v=32，升级缓存版本确保新样式即时到达
// v39（2026-09-30）：删除观影空间品牌头左侧图标（纯文字居中）；修复加入卡房间码
//                    输入格显示不完整——flex 均分改 grid 六等分（input 固有宽度不再
//                    参与分配导致挤压截断），格宽 100% 自适应、字号 clamp 防溢出。
//                    index.css 升 ?v=33，升级缓存版本确保新样式即时到达
// v40（2026-09-30）：房间码格子由深色底改为半透明淡白玻璃（rgba(255,255,255,.07)，
//                    聚焦加深至 .12），与加入卡玻璃底同族；index.css 升 ?v=34，
//                    升级缓存版本确保新样式即时到达
// v41（2026-09-30）：最近房间由横向滚动胶囊改为竖向列表——整行圆角条目
//                    （房间码靠左、片名伸展省略、时间右对齐），去掉横向滚动条。
//                    index.css 升 ?v=35，升级缓存版本确保新样式即时到达
// v42（2026-09-30）：观影空间标题改为与我的影院页头同惯例的左对齐小节标题
//                    （1.2rem 粗体 sans + 右侧副文案），消除与居中网站大标题
//                    「WDTV」垂直叠放的双居中混乱感。index.css 升 ?v=36
// v43（2026-09-30）：复制邀请链接全部改为复制 6 位房间码（不再复制网站链接）——
//                    观影空间创建结果区（space.js 升 ?v=5、按钮/提示文案更新）与
//                    播放页共看面板（watch-party-ui.js 升 ?v=43，「复制邀请」按钮
//                    改「复制房间码」）。升级缓存版本确保新脚本即时到达
// v44（2026-09-30）：选片入口卡片去掉副标题——「搜索影片」旁「在线共看」、「我的影院」
//                    旁「收藏选片」、「本地文件」旁「M3 共看」全部移除（srcCard 支持
//                    无副标题渲染）；「以此片发起/缓存发起」两个带片源入口保持不变。
//                    watch-party-ui.js 升 ?v=44，升级缓存版本确保新脚本即时到达
// v45（2026-09-30）：本地文件共看区块删除「双方需选择同一个本地文件」提示——该文案
//                    在未选择本地文件前不应出现；本端状态行仅在实际选过文件
//                    （指纹校验中/本端已就绪）后才渲染。watch-party-ui.js 升 ?v=45
// v46（2026-09-30）：账号界面未上传头像时的占位由昵称首字文本改为无背景人物剪影
//                    图标（复用 personIconHtml）——右上角药丸与账号卡片两处同步；
//                    移除首字占位死样式与 firstLetter 死函数。cloud-sync-ui.js 升 ?v=5
// v47（2026-09-30）：播放页共看面板成员气泡由「首字 + 彩色圆底」改为无背景人形剪影
//                    图标（与账号界面占位同形状）；等待加入的对端剪影淡显。
//                    watch-party-ui.js 升 ?v=46、watch-party.css 升 ?v=47
// v48（2026-09-30）：聊天输入行改为玻璃胶囊——发送按钮内嵌输入框右端（圆形纸飞机
//                    图标钮），不再是独立摆放的文字按钮；聚焦高亮由外壳 focus-within
//                    承担。watch-party-ui.js 升 ?v=47、watch-party.css 升 ?v=48
// v49（2026-09-30）：聊天发送钮去掉常驻蓝色圆底（仅悬浮时轻微显底作反馈），
//                    图标右侧加 3px 呼吸空隙。watch-party.css 升 ?v=49
// v50（2026-09-30）：聊天发送纸飞机与右缘间距加大（按钮右内边距 3px→7px）。
//                    watch-party.css 升 ?v=50
// v51（2026-10-14）：取消"网络卡顿自动降画质"（ABR）机制——播放始终锁定最高画质档：
//                    移除 hlsConfig ABR 参数与画质模式菜单（自动/强制最高），MANIFEST_PARSED
//                    改经 lockHighestLevel() 锁最高档；清晰度菜单去掉"自动"项默认选中最高档；
//                    单档源探测到更高档位时自动切换（每源提示一次）；共看解锁档位改为重新
//                    钳最高档而非恢复 ABR。player.js 升 ?v=150、watch-party-local.js 升 ?v=7，
//                    升级缓存版本清空旧缓存，确保新逻辑即时到达
// v52（2026-10-14）：播放器锁定态左侧解锁钮改为自动隐藏——锁定后显示约 3 秒即淡出，
//                    点击画面/鼠标移动经过随时唤出（不可见→可见时脉冲提示），解锁/换集
//                    清除计时器；锁定 toast 补充唤出提示。player.js 升 ?v=151、
//                    player.css 升 ?v=101，升级缓存版本清空旧缓存，确保新逻辑即时到达
// v53（2026-10-14）：修复长按侧边倍速期间上下滑动误触发音量/亮度调节——手势会话新增
//                    boostGestureSuppressed 标记：倍速进行中即屏蔽本会话随后的全部
//                    滑动手势（音量/亮度/进度），倍速取消后的剩余滑程也不再触发，
//                    需松手重新触摸方可手势调节。player.js 升 ?v=152，
//                    升级缓存版本清空旧缓存，确保新逻辑即时到达
// v54（2026-10-14）：多机制融合广告过滤——新增 js/ad-filter.js 共享引擎（播放/下载共用）：
//                    DISCONTINUITY 区间评分 + URL 黑名单 + SCTE35/CUE 标准标记三层检测，
//                    分片级移除广告区间（缝点保留 DISCONTINUITY）；防误伤硬规则（40% 删除
//                    预算、剩余分片下限、fMP4 MAP/KEY 依赖、BYTERANGE 禁删、合法区间一票
//                    否决、异常回退原文）；清单输出注入 #WDTV-ADF 版本标记，VideoCache
//                    双路径签名校验实现缓存自愈；新增「广告自动跳过」开关（默认关）。
//                    player.js 升 ?v=153、video-cache.js ?v=95、downloader.js ?v=21、
//                    config.js ?v=15、app.js ?v=24、cloud-sync.js ?v=3，
//                    升级缓存版本清空旧缓存，确保新链路即时到达
// v55（2026-10-14）：广告缝合点预热——中插广告移除后重印时间戳的源会留时间线空洞，hls.js
//                    跳空洞前现取"缝合点后首个分片"在网络慢时有一次可见卡顿。新增
//                    VideoCache.warmFrags（清单解析后立即把该分片抓入 IDB，完整性校验+
//                    在途去重+失败静默）与 player.js warmAdSeamFrags（LEVEL_LOADED 时按
//                    输出时间轴定位，限幅 4 个）。player.js 升 ?v=154、video-cache.js
//                    升 ?v=96，升级缓存版本清空旧缓存，确保新链路即时到达
// v56（2026-10-15）：观影空间视觉修正三连（均 index.css）——①「观影空间」标题与
//                    「我的影院」页头同高：.wdtv-space 由 padding+垂直居中改为
//                    margin:32px 上顶 + align-items:flex-start，遵循全站页头惯例；
//                    ②「支持的观影方式」由边框卡片改为底部居中弱化脚注（去卡片/
//                    图标方块，小字号低饱和，区别于最近房间胶囊）；③交互件悬浮不再
//                    提亮白色边框、点击不显焦点环（.wsp-cta/.wsp-panel--join/.wsp-btn/
//                    .wsp-recent-chip/.wsp-modes-summary，含摘要行去掉 hover 白底）。
//                    index.css 升 ?v=37，升级缓存版本确保新样式即时到达
// v57（2026-10-16）：修复「支持的观影方式」展开后排法不一——三条目原用 flex-wrap
//                    按内容长度随机换行（短的挤一行、长的折成图标/标题/描述三行）。
//                    改为统一结构：图标+标题基线对齐一行、描述固定第二行（条目
//                    nowrap + 内容区 column 布局），三条目排法一致。index.css 升 ?v=38，
//                    升级缓存版本确保新样式即时到达
// v58（2026-10-16）：修复「观影空间」与「我的影院」标题在页面切换时对不齐——两页容器
//                    原用 margin:32px 上顶，margin 折叠依赖页面流内状态：非活动页
//                    （绝对定位）时 32px 不再向外折叠，切换动画中离场页标题突然低
//                    32px。改为上边距统一交给 .wdtv-header 的 margin-bottom:32px，
//                    两页容器自身不再上顶（.wdtv-cinema margin:0 auto 32px、
//                    .wdtv-space margin:0 0 8px），活动/非活动/切换中各态标题同高。
//                    index.css 升 ?v=39，升级缓存版本确保新样式即时到达
// v59（2026-10-19）：搜索结果卡片改为「封面尺寸就绪后才入网格」——搜索接口只返回封面
//                    地址、不返回宽高，原实现先按 16:9 + 占 3 列插入、图片 onload 后再改
//                    比例与跨度，出现「未加载时横版、加载完变竖版」的跳动。现改为卡片先在
//                    文档外构建、用自身 <img> 读出真实宽高并写好 aspect-ratio 与
//                    cover-portrait/cover-landscape 后，再按结果原下标顺序插入网格；封面
//                    读不到（直连+代理均失败、超时、回退占位图）的整条结果不展示。
//                    首批卡片入网格 / 队列排空后再收起 loading 遮罩。app.js 升 ?v=31
// v60（2026-10-19）：搜索结果网格改为自适应列数——旧方案 6 列基础栅格 + 横版占 3 列 /
//                    竖版占 2 列，导致手机与桌面都只有 2~3 列，桌面卡片宽达 380px；且
//                    .douban-card-image 的 max-height:340px 会把海报上下裁掉。现改为
//                    repeat(auto-fill,minmax(160px,1fr))（手机 2 列 / 平板 3~5 列 /
//                    桌面 6 列，≤390px 强制 2 列），去掉跨列与高度封顶，比例钳制放宽到
//                    0.5~3.0，海报按原比例完整显示。index.html 内联样式 + app.js 升 ?v=32
// v61（2026-10-19）：搜索结果卡片底部角标行减负——源名（左）/类型（右）留在封面角标行，
//                    源方备注（完结/HD国语/更新至第N集）从角标行移到卡片标题下方单独一行
//                    （白色实底胶囊 + 深蓝字，不透明底避免被海报颜色吃掉）。角标行不再
//                    三项挤一行互相截断。app.js 升 ?v=33
// v62（2026-10-19）：搜索结果卡片统一尺寸 + 备注纯文字——封面框固定 7:10（不再按图片
//                    真实比例撑高卡片），标题区固定 47px（无备注的卡片同样占位），
//                    整行卡片等高；接近 7:10 的封面铺满，9:16/16:9 的改用 contain
//                    完整显示。备注取消白色胶囊底，只留浅色小字。app.js 升 ?v=34
// v63（2026-11-05）：批次1：观看历史双写路径收敛(G0) + 源健康度阶梯停用(A5) + 状态组件/焦点陷阱/图片降级基础(A4) + 代理层零开销安全加固(S1-S5) + 版本号单一来源(A11)；ui.js/api.js/player.js/app.js/search.js/connection-test.js 升 ?v=；升级缓存版本确保新资源即时到达
// v64（2026-11-05）：批次2：跨源同名卡片聚合 + 备注归一(A1)、画质探测队列与徽章(A6, 默认关闭零新增请求)、明暗主题无首屏闪烁(A10)、状态组件/焦点陷阱/图片降级链接入(A4)、卡片键盘可达与骨架屏(A7-a)；app.js/douban.js/ui.js/cloud-sync.js/theme.js/probe-queue.js 升 ?v=；修复队列自定义 keyOf 时结果反查内部键失败（probe-queue 加 waitKeys 反查表 + 回归用例）；删除重复的 A6 实现只保留一套；升级缓存版本确保新资源即时到达
// v65（2026-11-05）：批次3：数据源订阅(A9, 直连优先 + /proxy/ 路径式兜底 + 小时级缓存键规避 + 三格式嗅探) 与首页推荐增源(A8, 60s 榜单直连 / Bangumi 可选默认关闭)；B1 URL 状态子集顺延至批次4；不新增 Functions、不改 CF 部署结构；config.js/index-page.js/cloud-sync.js/app.js/douban.js 升 ?v=；升级缓存版本确保新资源即时到达
// v66（2026-11-05）：批次4：A3 播放错误恢复抽离(纯决策+退避换源)、A7-b 倍速跨集保持/进度恢复兜底/M+Esc、B1 URL 状态局部子集(popstate+room透传+豆瓣双推去重)、A2 片头中段片尾跳过标记(默认关，与广告跳过共用冷却，12s撤销)；新增 playback-recovery.js/skip-marks.js/skip-marks.css ?v=1；player.js/watch-party.js/config.js/app.js/douban.js/cloud-sync.js 升 ?v=；升级缓存版本确保新资源即时到达
// v67（2026-11-06）：深度审查修复——广告引擎修代理解包/AES-128 误判/零时长预算/签名注入/全局行保护（RULES_VERSION=2）；A2 修重标顺序、全屏撤销条、片尾拖拽误跳与撤销；源健康度补齐停用期满连击重置；订阅 JSONC/TVBOX/暂停与临时失败；搜索结果 XSS 加固；A1 分组前置、A6 徽章回填、A8 禁用源零请求；主题三页生效、OPTIONS 预检零上游开销、本地代理同步 S1-S5；测试护栏去永真断言并补行为级回归；升级缓存版本确保新资源即时到达
// v68（2026-11-06）：二次深度审查修复（以当前代码为准）：广告签名与缓存校验侧同源、主开关按 localStorage 刷新；播放器 fatal bufferAppendError 不再被提前 return 吞掉、恒 false 的 isSwitchingVideo 改用实例代次保护；详情链路写回源健康度且探测可跳过、permanent 停用记录豁免 7 天清理；云同步跳过标记/订阅键改字段级合并并提示超限裁剪、封面协议白名单、外部 signal 联动、SSRF 双实现一致性用例、代理追加最终重定向 URL 校验、本地代理对齐 S4 与错误码、连接测试兼容新旧错误体；A4 删除/清空历史可撤销、确认弹窗焦点落取消、页级错误兜底、焦点陷阱补 MutationObserver、图片降级接入 apply、toggleSettings 收敛单定义；A6 失败徽章可重试/loading/BANDWIDTH 反推/中间集兜底/看门狗 60s；主题三页与 apply 同步 data-theme；_mock-d1 去掉顶层 node:fs 静态 import；修复 7 处恒真断言并补行为级回归；收口补修 app.js 封面降级 apply 后主动推进一级，避免同值 src 不重载卡死（app.js ?v=42）；升级缓存版本确保新资源即时到达。未部署
// v69（2026-11-08）：移除设置中的明暗主题切换，界面固定深色；三页预绘制脚本改为强制 dark
//                    并清理旧版 wdtvTheme 残留，下线 js/theme.js 与云同步主题键；升级缓存版本确保新资源即时到达
// v70（2026-11-08）：设置面板隐藏弹幕设置分组，播放器隐藏弹幕设置入口，弹幕按默认值正常运行；升级缓存版本确保新资源即时到达
// v71（2026-11-08）：设置面板更新广告过滤与广告自动跳过说明文案；升级缓存版本确保新资源即时到达
// v72（2026-11-08）：片头片尾跳过改为播放器内单开关：默认开启，高置信自动跳、低置信/部分数据显示按钮，移除手动标记与设置页入口，新增只读取数层；升级缓存版本确保新资源即时到达
// v73（2026-11-08）：片头片尾跳过收尾：播放器开关文案精简，按钮点击验证与移动端触控尺寸校准；升级缓存版本确保新资源即时到达
// v74（2026-11-08）：片头片尾改为内置双源：公共 D1 只读表 + IntroDB 公开接口服务端代理，多源时间轴对齐合并与置信度分级；升级缓存版本确保新资源即时到达
// v75（2026-11-08）：取数层超时与失败降级微调：外部接口约 3s 预算，未命中短缓存；升级缓存版本确保新资源即时到达
// v76（2026-11-08）：片名季号识别支持中文数字（第二季），缓存指纹与服务端查询带季集；升级缓存版本确保新资源即时到达
// v77（2026-11-08）：跳片头尾改为弹出面板，支持按剧自定义片头/片尾时长；升级缓存版本确保新资源即时到达
// v78（2026-11-08）：跳片头尾面板改分秒输入，自动识别与自定义模式互斥，按钮四态与响应式重构；升级缓存版本确保新资源即时到达
// v79（2026-11-08）：跳片头尾改为总开关+自动/自定义两个独立子开关（可同时开启，同类型自定义优先），入口改纯图标按钮并强化响应式与低置信提示；升级缓存版本确保新资源即时到达
// v80（2026-11-08）：跳片头尾：自动数据圆点仅在自动识别有可用段时点亮，自定义段不误标；升级缓存版本确保新资源即时到达
// v81（2026-11-08）：播放器「跳片头尾」面板视觉重构：白色图标、iOS 滑块、平滑折叠；升级缓存版本确保新资源即时到达
// v82（2026-11-08）：跳片头尾面板：收紧垂直密度、滑块恢复主题蓝、移除自动识别说明；升级缓存版本确保新资源即时到达
// v83（2026-11-08）：画面内跳过片头/片尾按钮改为透明玻璃质感（白 8% 底 + 16px 模糊 + 白色细描边）；升级缓存版本确保新资源即时到达
// v84（2026-11-08）：数据源体检：7 个失效源标注停用并保留历史配置，天涯资源适配 keywords 搜索参数；升级缓存版本确保新资源即时到达
// v85（2026-11-08）：修复本地代理 gzip 解压后 content-length 截断导致如意详情 JSON 不完整；如意资源切换同源可用域 www.ryzyw.com 并恢复启用；升级缓存版本确保新资源即时到达
// v86（2026-11-08）：修复首页豆瓣热门「管理标签」弹窗被 #splash 层级遮挡导致点击无反应，并补充 Esc 关闭；升级缓存版本确保新资源即时到达
// v87（2026-11-08）：首页标签管理弹窗改为透明玻璃风格：轻量暗化遮罩、半透明白卡片、白色文字层级、玻璃态标签/输入框/按钮，并适配移动端安全区与内部滚动；升级缓存版本确保新资源即时到达
// v88（2026-11-08）：标签管理弹窗改为白色磨砂玻璃 + 深色文字：高透白色卡片、深色标题与中性灰说明、统一 10px 圆角控件、深色主按钮与纯文字次按钮，去掉内发光/渐变/多重描边；升级缓存版本确保新资源即时到达
// v89（2026-11-08）：标签管理弹窗次按钮去除残留磨砂底，保持纯文字样式；升级缓存版本确保新资源即时到达
// v90（2026-11-08）：标签管理弹窗改为复用首页豆瓣卡片 token：蓝灰透明玻璃底、var(--glass-border) 描边、10px 卡片圆角、var(--pale) 文字，药丸/输入框/按钮分别对齐豆瓣标签、订阅输入框与刷新按钮样式；升级缓存版本确保新资源即时到达
// v91（2026-11-09）：数据源大体检：原 6 个停用源（黑木耳/卧龙/新华为/华为吧/豆瓣/魔爪）经官方站与公开配置多轮探测确认服务终止，槽位改接猫眼/量子/金鹰/速博/豪华/百度六条三路径实测可用线路，14 个源全部恢复可用；config.js 升 ?v=26；升级缓存版本确保新资源即时到达
// v92（2026-11-09）：数据源恢复收口：老用户 localStorage 选中集合一次性补齐 6 个恢复槽位，不覆盖用户对其它源的选择；app.js 升 ?v=44；升级缓存版本确保新资源即时到达
// v93（2026-11-09）：播放链路复核修正：百度资源 api.apibdzy.com 搜索可用但 5 条播放地址均取不到清单，mozhua 槽位改接 iKun 资源 www.ikunzy.com（播放清单直连与生产代理均有效）；config.js 升 ?v=27；升级缓存版本确保新资源即时到达
// v94（2026-11-09）：播放链路复核收口：暴风资源播放 CDN 抽样 6 部仅 1 部可取清单，bfzy 槽位改接电影天堂 caiji.dyttzyapi.com（搜索三路径可用、播放清单直连有效）；config.js 升 ?v=28；升级缓存版本确保新资源即时到达
// v95（2026-11-09）：恢复原有数据源配置（用户指正）：播放地址路径含中文时临时探测脚本未做百分号编码导致 404 误判，暴风资源从未失效；内置 14 个源全部还原为 2026-11-08 上游原配置，新增线路改用独立 key 作补充、不占用任何原有槽位；老用户选中集合一次性清理停用项并补齐新增 key；config.js 升 ?v=29、app.js 升 ?v=45；升级缓存版本确保新资源即时到达
// v96（2026-11-10）：下载器移植 LibreTV 设计：新增 js/download-utils.js 纯函数模块（4xx 确定性缺片快速失败+建议换源、混合内容/CORS/配额不足可读诊断）；合成改逐片流式写出，单集下载在用户手势内取 FS Access 句柄边转封装边写盘（不聚合 Blob、不占 IDB），批量/不支持时回退；格式统一只留 MP4（移除批量弹窗无效的 TS 选项）；新增 test/download-utils.test.mjs 39 项行为单测。js/downloader.js 升 ?v=23；升级缓存版本确保新资源即时到达
// v97（2026-11-10）：数据源订阅与自定义接入入口全线下线，源集合完全内置：设置面板删除订阅输入/列表/状态/导出 JSON 与订阅样式，index.html 不再加载 source-subscription.js 与 customer_site.js；app.js 移除订阅渲染、自动刷新与事件委托并清理老用户订阅残留；七七资源并入 config.js 内置表（源集合不变），移除 extendAPISites/removeAPISitesByPrefix 运行时注入源钩子；cloud-sync 移除订阅同步键；README 与静态契约同步更新；config.js/app.js/ui.js/cloud-sync.js/cloud-sync-ui.js/index-page.js/modals.css 升 ?v=；升级缓存版本确保新资源即时到达
// v98（2026-11-10）：隐私政策页 about.html 改版为首页同款风格——移除 Tailwind/浅色 styles.css，接入首页同款背景层（光晕、bg-canvas 背景图、雨幕、玻璃水波涟漪、雾气、preloader）与「动态效果」开关；新增 css/site-bg.css?v=1、css/about.css?v=1、js/site-fx.js?v=1（镜像首页内联 FX，首页本身不改动）；升级缓存版本确保新页面与新资源即时到达
// v99（2026-11-10）：隐私政策页组件按用户要求改为首页豆瓣卡片同款「几乎全透明」样式（深蓝玻璃 / 白色磨砂玻璃两版均被否）——信息块、邮箱按钮、分隔线统一 rgba(155,180,218,0.06) + 1px var(--glass-border) + 10px 圆角，去掉 backdrop-filter / 白边 / 内高光 / 投影；顶栏改透明无底，hover 沿用 .douban-card 的 rgba(80,128,176,0.2) + var(--accent) 反馈；删除 #splash::after 暗化层，文字保持 #2a3a5c 深色层级与首页蓝色渐变标题；css/about.css 升 ?v=5；升级缓存版本确保新资源即时到达
// v100（2026-11-10）：设置面板移除「一般功能」里的「清除Cookie」功能项及其 clearLocalStorage() 实现（含确认弹窗 / 清空 localStorage 与全部 Cookie / 倒计时刷新），不再提供清空 Cookie 的入口；ui.js 升 ?v=18；升级缓存版本确保新资源即时到达
// v101（2026-11-10）：首页主视觉标题改为「你看过的电影，不只是电影」，副句按语义分三行排版、窄屏回流为一段，浏览器标签标题同步呼应；改动仅在 index.html 文案与内联样式，外部 css/js 的 ?v= 不变；升级缓存版本清空旧页面缓存，避免老用户离线回退到旧首页 HTML
// v102（2026-11-10）：应用户要求回退 v101——首页标题恢复为「WDTV / 自由观影，畅享精彩」原文案与原样式（index.html 与 v100 状态一致）；仍升级缓存版本清空页面缓存，确保所有用户立即拿到回退后的首页
// v103（2026-11-10）：隐私政策页字体/文字层级改回复用首页体系——about.html 引入与首页完全相同的外部 CSS 栈（styles/index/modals/downloader/states）与 Google Fonts，正文用 'Noto Sans SC' 300 + var(--text-primary)/rgba(224,234,248,0.9) 浅色细字 + 首页弹窗标题同款深色阴影（加一层紧实描边适配明亮水雾），主标题/副标题/分区标题/卡片标题分别照抄 .wdtv-title / .wdtv-slogan / .wdtv-douban-header h2 / .wdtv-panel-header h3；组件保持 .douban-card 的 0.06 极淡透明；首页设置面板「隐私政策」按钮去掉 wdtv-secondary，与「视频缓存管理」按钮样式统一；css/about.css 升 ?v=7；升级缓存版本确保新资源即时到达
// v104（2026-11-11）：不降画质/特效的渲染性能优化——① 首页内联 FX 与 js/site-fx.js 同步改造：水波 renderWater 在小端设备用 Uint32Array 一次写入 RGBA（数值验证逐字节等价，同时删掉从未被使用的 gx 与每像素 3 次数组写）、stepWater 预计算相位查表、雨幕渐变色按雨滴预生成字符串、两条 rAF 在页面隐藏时真正 cancel 并在 visibilitychange / 动态效果开关切回时恢复；② 去掉 #splash 对纯色背景毫无视觉作用的 30px 全屏高斯模糊（保留 saturate/brightness 与 Backdrop Root，内部玻璃层采样边界不变），.splash-glow 加 will-change:filter,opacity 让 58s 呼吸动画走合成器；③ 首页 27 个自有 JS 统一 defer（defer 保证按文档顺序执行，依赖链不变；Tailwind Play CDN 保持同步以免首屏无样式闪烁）；④ 动态海报图补 decoding="async"。js/app.js 升 ?v=47、douban.js ?v=18、cinema.js ?v=18、watch-party-ui.js ?v=48、site-fx.js ?v=2、site-bg.css ?v=2；升级缓存版本确保新资源即时到达
// v105（2026-11-11）：清理未接通的雾气擦除层（#gw-fogwipe）——该 canvas 继承 .gw-ly{pointer-events:none}，4 个 pointer 监听器永远不触发；retarget('bg') 从不初始化它，≤900px 手机端完全不可见；redrawFog 还会在每次 resize 做 5 次全屏绘制并常驻一张 dpr2 约 33MB 纹理。删除 index.html / about.html 的 DOM、首页内联样式与 css/site-bg.css 的规则、两处 FX 的 paintHaze/redrawFog/renderWipeStroke/wipeSegLive/blotch/fogPt 及监听器和 retarget 的 fog 分支，视觉无可察觉损失。另修 bfcache 状态机：pageshow(persisted) 里只 add('gw-exit') 且全项目无 remove，导致从播放器 history.back() 返回后 #gw-slot 永久 opacity:0（背景图/水波消失）且 idleNow() 永久跳过渲染；改为 remove 并重启 FX。css/site-bg.css 升 ?v=3、js/site-fx.js 升 ?v=3；升级缓存版本确保新资源即时到达
// v106（2026-11-11）：补齐 player.html —— 此前所有性能优化只覆盖首页内联 FX 与 js/site-fx.js，播放器页面一直是独立的旧版实现。① 播放器内联 FX 同步：renderWater 小端 Uint32 快路径（数值逐字节等价）+ 删掉从未使用的 gx、stepWater 相位查表、雨幕渐变色按雨滴预生成、makeOut/buildPhases、gwRafId + visibilitychange 真正休眠（旧版 loop 无条件排队、切后台也不停）、idleNow 增加 #modal 检查让弹层打开时冻结背景，雨幕同样加 rafId 休眠；② 清掉 player.html 残留的雾气层（DOM / CSS / 整段 fog 代码，上轮清理只覆盖了首页与 about.html）；③ #splash 去掉对纯色背景无效的 blur(30px)（保留 saturate/brightness 与 Backdrop Root）、.splash-glow 加 will-change:filter,opacity；④ 新增弹层打开时暂停 splash-glow 动画与 backdrop-filter 的两条规则（与首页一致）；⑤ 三个页面加 bg-canvas.jpg 的 preload，让首屏背景图更早到位。本轮只改 HTML，外部 css/js 的 ?v= 不变；升级缓存版本清空旧页面缓存，确保播放器页面立即拿到新内联脚本
// v107（2026-11-11）：① 静态资源缓存分级——带 ?v=N 的 css/js/libs 改 Cache-First（命中即返回，不再发起后台 fetch），不带版本号的 bg-canvas.jpg / image/* / manifest.json 保留 SWR。此前统一 SWR 让每次导航在全部命中缓存时仍发 33 个后台请求（27 JS + 5 CSS + 1 库），与字体/封面图/搜索 API 抢连接；项目 URL 带版本号即内容永不变，后台更新纯属浪费，忘升 ?v= 由 SW 版本升级清空 wdtv-* 缓存兜住。② 删除 3 个从未被 CSS 引用的 Google 字体族（Great Vibes / Pinyon Script / Spectral），减少 @font-face 规则与 CSSOM 体积，视觉零变化。③ .wdtv-loading:not(.show) *{animation-play-state:paused}，停掉隐藏遮罩里常驻的 spinner 无限动画（visibility:hidden 只跳绘制、动画时间线仍在 tick）。④ 三处 preloader 显示时机同步：不再等 window.load，改为 DOMContentLoaded + 背景图就绪取较晚 + 120ms 淡出，1.5s 兜底；淡出时背景已就位不露纯色底，首屏可交互明显提前。libs/ 下 5 处脚本引用补 ?v=1 使其一并走 Cache-First（mux-mp4.js 为按需动态注入、不在导航路径）；js/site-fx.js 升 ?v=4；升级缓存版本清空旧缓存，确保新策略与新脚本即时生效
// v108（2026-11-12）：修复播放器页面滑动回归卡顿（v106/v107 引入，首页不受影响）。根因：① player.html 新加的 body:has(#modal:not(.hidden)) 两条规则让 body 样式依赖后代状态，播放器页面弹幕/控制栏/剧集列表持续增删 DOM 时反复触发整棵 body 子树样式失效（首页 DOM 变化稀疏所以无感）；其中 backdrop-filter:none 还会让 #splash 的 Backdrop Root 反复消失/重建，弹层内滚动时全屏背景重新合成。② .wdtv-loading:not(.show) * 的后代通配选择器放大每次 DOM 变化的匹配成本。③ 滚动时 #splash 的 pointermove 无条件触发 stir → toSim 每次调用 pane.getBoundingClientRect() 造成强制同步布局、每次最多 6 次 poke，且 pane 模式监听缺 passive。修复：删掉两条 :has()，改用只观察 #modal class 的 MutationObserver 切换 body.fx-frozen 普通类（失效范围从整棵子树收窄到一个属性），且不再移除 backdrop-filter；loading 规则收窄到具体 spinner；player.html FX 缓存 paneRect、pointer 监听全部加 passive、内容区拖动不再驱动水波（点击涟漪保留）。仅 index.html / player.html / service-worker.js 变动，外部 css/js ?v= 不变；升级缓存版本清空旧页面缓存
// v109（2026-11-12）：修复播放页「手指脱手后的惯性滚动比拖动时更卡」。根因：① 结构性——css/player.css 的 body,html{height:100%!important} 叠加 body.player-page-bg{overflow-x:hidden}（隐含 overflow-y:auto）把实际滚动容器从 viewport 挪到 body；首页是 html{overflow-y:scroll} 且 body 高度 auto，走 compositor 快速滚动。播放页 body 滚动容器再叠 #splash 全屏 fixed + backdrop-filter（Backdrop Root），滚动更容易被降级到主线程路径。② 帧预算——idleNow() 只查 document.hidden 与 #modal，滚动/fling 完全不冻结；惯性期间水波 rAF（手机 bg 模式约 8.6 万格，每帧 2×stepWater + renderWater + putImageData + 全屏 drawImage）、雨幕 rAF、.splash-glow 的 58s filter 动画每帧重绘全屏渐变，再叠加视频解码、弹幕 DOM、控制栏状态，主线程被占满。③ v108 的 fxOnContent 让内容区拖动跳过 stir() 的 poke，拖动阶段负载更低，反而放大了「脱手后没有 pointermove、rAF 仍满速」的反差。④ 感知层——惯性位移由衰减曲线连续推进，掉一帧下一帧位移突增；拖动位移由手指决定，掉帧只是跟手略迟，故同样掉帧数体感差得多。修复：player.html 新增滚动活跃检测（scroll/wheel/touch 全部 passive，scroll 用捕获阶段以覆盖弹层/剧集列表等内部滚动容器），维护 __fxScrollHold 时间戳；水波与雨幕 loop 在活跃期跳过重算并保留上一帧，停止后从当前高度场继续（last=ts 防 dt 突变，无跳变）；光晕呼吸动画改单个元素内联 animationPlayState，仅在状态切换时写一次。纯点击（无 touchmove）不触发冻结，点击涟漪保持即时。不动 CSS 层叠、不引入后代选择器、不移除 backdrop-filter，首页内联 FX 与 js/site-fx.js 均不改。结构性根因（把滚动容器还给 viewport，需 overflow-x:clip 与 body height:auto）会改变 flex 压缩行为，本轮不擅改，留待真机布局回归后再做。仅 player.html / service-worker.js 变动，外部 css/js ?v= 不变；升级缓存版本清空旧页面缓存
const CACHE_VERSION = 'wdtv-sw-v109';
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

    // --- 静态资源：带 ?v=N 的走 Cache-First，未版本化的保留 SWR ---
    // 原理：本项目所有 css/js/libs 都带内容式版本号，发版即换 URL，URL 不变则内容永远不变，
    // 命中缓存后再发一次后台 fetch 是 100% 浪费（一次导航约 33 个请求），还会与字体/封面图/
    // 搜索 API 抢连接。不带版本的 bg-canvas.jpg / image/* / manifest.json 仍可能原地更新，保留 SWR。
    if (ASSET_PATH_PATTERNS.some(re => re.test(url.pathname))) {
        const versioned = /(?:\?|&)v=/.test(url.search);
        event.respondWith((async () => {
            const cache = await caches.open(ASSET_CACHE);
            const cached = await cache.match(request);
            if (cached && versioned) return cached;
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
            // 首次访问 / 升级缓存版本后：等网络返回（后续访问才会命中缓存）
            const fresh = await networkUpdate;
            return fresh || Response.error();
        })());
    }
});
