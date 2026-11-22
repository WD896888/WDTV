// 批次4：防回归静态契约断言
// 锁住「单一实现」「零查询式代理」「默认关闭」「room 透传」「双副本一致」等不变量。
// 前三批出现过两套 A6 实现、两边重复显隐函数，本文件用于让这类问题直接测试失败。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const count = (s, re) => (s.match(re) || []).length;

const player = read('js/player.js');
const watchParty = read('js/watch-party.js');
const cloudSync = read('js/cloud-sync.js');
const config = read('js/config.js');
const app = read('js/app.js');
const searchJs = read('js/search.js');
const douban = read('js/douban.js');
const playerHtml = read('player.html');
const distHtml = read('deploy-dist/player.html');
const indexHtml = read('index.html');
const versionMap = JSON.parse(read('scripts/version-map.json'));

let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
    if (cond) { pass++; }
    else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? '  | ' + extra : '')); }
}

// ---- 1) A3：错误恢复只有一处，计数外置，无重复实现 ----
t('A3: Hls.Events.ERROR 监听恰好 1 处', count(player, /hls\.on\(Hls\.Events\.ERROR/g) === 1);
t('A3: recoveryState 由纯决策模块回传', player.includes('recoveryState = out.state'));
t('A3: FRAG_LOADED 接 onHealthy', player.includes('R.onHealthy({ state: recoveryState, now: Date.now() })'));
t('A3: 原 errorCount 计数已消除（仅注释提及）', !/let errorCount\s*=/.test(player));
t('A3: 坏缓存自愈保留', player.includes('VideoCache.invalidateFragment(data.frag.url'));
t('A3: ENDED 态 seek 兜底保留', player.includes('__endedSeekKick'));
t('A3: bufferAppendError 独立分支保留', player.includes("data.details === 'bufferAppendError'"));
t('A3: switch-source 不自动弹换源面板',
    !/hls\.on\(Hls\.Events\.ERROR[\s\S]{0,4000}?showSwitchResourceModal\(\)/.test(player));
t('A3: 换源面板仅由用户点击触发（唯一调用点）',
    count(player, /Promise\.resolve\(showSwitchResourceModal\(\)\)/g) === 1);
t('A3: 退避 timer 留在 player.js 闭包', player.includes('}, d.delayMs);'));

// ---- 2) A2：单一自动 seek 入口、默认关闭、共用冷却 ----
t('A2: timeupdate 内 adAutoSkipCheck 调用恰好 1 处', count(player, /try \{ adAutoSkipCheck\(\); \}/g) === 1);
t('A2: 只有 1 个 adAutoSkipCheck 函数定义', count(player, /function adAutoSkipCheck\(\)/g) === 1);
t('A2: decideAutoSkip 调用恰好 1 处', count(player, /S\.decideAutoSkip\(/g) === 1);
t('A2: 总开关关闭时完全零介入', player.includes('if (!adAutoSkipEnabled && !introSkipEnabled) return;'));
t('A2: 两个自动 seek 共用 adSkipLastAt 冷却', player.includes('lastSkipAt: adSkipLastAt'));
t('A2: 片头片尾开关默认开启且接线 PLAYER_CONFIG',
    player.includes('PLAYER_CONFIG.introSkipStorage') &&
    config.includes('introSkipEnabled: true') && config.includes("introSkipStorage: 'wdtvIntroSkipEnabled'"));
t('A2: 12s 撤销窗常量', player.includes('WDTV_SKIP_UNDO_MS = 12000'));
t('A2: 撤销后本集不再跳', player.includes('skipSuppressedThisEpisode.add(state.skipKey)'));
t('A2: 换集清空本集抑制', player.includes('wdtvResetSkipEpisode()') && player.includes('skipSuppressedThisEpisode.clear()'));
t('A2: 手动标记快捷键已移除', !/wdtvHandleSkipShortcut|Shift\+I|skipMiddlePending/.test(player));
t('A2: 程序自动 seek 走统一抑制入口', player.includes('if (applyProgrammaticSeek(v, decision.target))'));
t('A2: 进度恢复走统一抑制入口', player.includes('applyProgrammaticSeek(art.video, savedPosition)'));
t('A2: 换档恢复走统一抑制入口', player.includes('applyProgrammaticSeek(art.video, qualitySwapSeek)'));
t('A2: 用户主动拖进度条未被抑制（不加 applyProgrammaticSeek）',
    player.includes('art.currentTime = clickTime') && !/applyProgrammaticSeek\([^)]*clickTime/.test(player));
t('A2: 色带不逐帧重绘（timeupdate 回调里无 wdtvRenderSkipBand）',
    !/video:timeupdate[\s\S]{0,900}?wdtvRenderSkipBand/.test(player));
t('A2: durationchange 已挂载', player.includes("art.on('video:durationchange'"));
t('A2: resize 监听幂等防累积', player.includes('__wdtvSkipResizeBound'));

// ---- 3) A7-b / B1 ----
t('A7-b: defaultPlaybackRate 恒等已实现', player.includes('defaultPlaybackRate = r'));
t('A7-b: 跳过起播归位与长按临时倍速',
    player.includes('stallRateGuard.active && Math.abs(r - 1) < 0.001') && player.includes('if (longPressBoostActive) return;'));
t('A7-b: canplay 兜底已挂载', player.includes("art.on('video:canplay'"));
t('A7-b: 进度恢复校验 NaN/Infinity', player.includes('if (!Number.isFinite(duration) || duration <= 0) return;'));
t('A7-b: M 键静音已实现', player.includes("e.key === 'm' || e.key === 'M'"));
t('A7-b: Esc 退出全屏已实现', player.includes("e.key === 'Escape'"));
t('A7-b: 进度监听随 video 重建重挂', player.includes('bindProgressListeners(video)'));
t('A7-b: 原 setInterval(waitForVideo,200) 已移除', !player.includes('const waitForVideo = setInterval'));
t('B1: 直接 replaceState 仅 helper 内 1 处', count(player, /window\.history\.replaceState/g) === 1);
t('B1: replaceUrlState 定义 1 处 + 调用 5 处', count(player, /replaceUrlState\(/g) === 6);
t('B1: popstate 监听恰好 1 处', count(player, /addEventListener\('popstate'/g) === 1);
t('B1: room 绝不删除（patch 与 removes 双重保护）', count(player, /k === 'room'/g) === 2);
t('B1: helper 不做 pushState', !/function replaceUrlState[\s\S]{0,800}?pushState/.test(player));
t('B1: douban 双推已去除', count(douban, /history\.pushState/g) === 0);
const goBackBody = (player.match(/function goBack\([\s\S]*?\n\}/) || [''])[0];
t('B1: goBack 不写 URL 状态（无 pushState/replaceState）',
    goBackBody.length > 200 && !/pushState|replaceState/.test(goBackBody));

// ---- 4) 全局约束 ----
t('全局: 不含 LibreTV 查询式代理代码',
    !/\/api\/proxy\?url=/.test(player.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));
const recoverySrc = read('js/playback-recovery.js');
const skipSrc = read('js/skip-marks.js');
t('全局: 新模块 IIFE 包裹（防全局词法 const 重复声明）',
    recoverySrc.includes('(function (g)') && skipSrc.includes('(function (g)') &&
    !/^\s*(?:const|let)\s+\w+\s*=/.test(recoverySrc.replace(/^\/\/[^\n]*\n/gm, '').replace(/^\/\*[\s\S]*?\*\//g, '')));
t('全局: 新模块双环境导出',
    recoverySrc.includes('typeof window !== \'undefined\' ? window : globalThis') &&
    skipSrc.includes('typeof window !== \'undefined\' ? window : globalThis'));
t('全局: 共看抑制桥导出且复用 suppress()',
    /suppressLocalSeek:\s*function\s*\(\s*\)\s*\{\s*suppress\(\);?\s*\}/.test(watchParty));
t('全局: SYNC_LIST_KEYS 含 wdtvSkipMarks', cloudSync.includes("'wdtvSkipMarks'"));
const syncArr = (cloudSync.match(/const SYNC_LIST_KEYS\s*=\s*\[([\s\S]*?)\];/) || [, ''])[1];
t('全局: SYNC_LIST_KEYS 数组实际恰好 13 键', (syncArr.match(/'[^']+'/g) || []).length === 13,
    String((syncArr.match(/'[^']+'/g) || []).length));
t('全局: 数据源订阅键已从云同步列表移除', !/'wdtvSourceSubscriptions'/.test(syncArr));
t('全局: PLAYER_CONFIG 含片头片尾键，且不再暴露数据源地址',
    config.includes('introSkipEnabled: true') && config.includes("skipMarksStorage: 'wdtvSkipMarks'") &&
    !config.includes('skipSourceEndpoint') && !config.includes('skipSourceTimeoutMs'));
t('全局: 首页设置面板已移除片头片尾开关', !indexHtml.includes('skipMarksToggle'));
// v97：数据源订阅与自定义接入全线下线，锁住「页面无入口 + 无运行时注入钩子」两个不变量
t('页面: 数据源订阅入口已整体下线',
    !indexHtml.includes('wdtvSubscriptionUrl') &&
    !indexHtml.includes('wdtvSubscriptionExport') &&
    !indexHtml.includes('js/source-subscription.js') &&
    !app.includes('WDTVSourceSubscriptions'));
t('页面: 自定义源接入钩子已移除且源集合全部内置',
    !indexHtml.includes('js/customer_site.js') &&
    !playerHtml.includes('js/customer_site.js') &&
    !config.includes('window.extendAPISites') &&
    !config.includes('removeAPISitesByPrefix') &&
    config.includes('const API_SITES = {') && config.includes('ffzy: {'));
t('全局: app.js 旧标记读写已移除',
    !app.includes('function wdtvReadSkipMarksStore()') && !app.includes('function wdtvWriteSkipMarksEnabled('));
t('全局: README 不再提供 Shift 标记快捷键',
    ['Shift + I', 'Shift + O', 'Shift + S', 'Shift + E', 'Shift + P'].every(k => !read('README.md').includes(k)));
t('全局: 取数层内置双源且只读（无用户配置、无上传入口）',
    read('js/skip-source.js').includes('/api/skip-marks') &&
    read('js/skip-source.js').includes('/api/skip-marks/introdb') &&
    !read('js/skip-source.js').includes('skipSourceEndpoint') &&
    read('js/skip-source.js').includes("credentials: 'omit'") &&
    read('js/skip-source.js').includes("method: 'GET'") &&
    !/XMLHttpRequest|POST|sendBeacon/.test(read('js/skip-source.js')));

// ---- 5) 双副本与版本登记 ----
// 版本号不写死：以 version-map.json 为单一来源，升版后断言自动跟随
const NEW_ASSETS = ['js/playback-recovery.js', 'js/skip-marks.js', 'js/skip-source.js', 'css/skip-marks.css'];
t('发版: player.html 已引 4 个新资源且 ?v= 与 version-map 一致',
    NEW_ASSETS.every(a => playerHtml.includes(a + '?v=' + versionMap.assets[a])),
    JSON.stringify(NEW_ASSETS.map(a => a + '?v=' + versionMap.assets[a])));
t('发版: 新 script 在 player.js 之前',
    playerHtml.indexOf('js/playback-recovery.js') < playerHtml.indexOf('js/player.js?v=') &&
    playerHtml.indexOf('js/skip-marks.js?v=') < playerHtml.indexOf('js/player.js?v=') &&
    playerHtml.indexOf('js/skip-source.js?v=') < playerHtml.indexOf('js/player.js?v='));
t('发版: version-map 已登记 4 个新资源',
    NEW_ASSETS.every(a => Number.isInteger(versionMap.assets[a]) && versionMap.assets[a] >= 1));
// 镜像同步已由 bump-version.mjs 的 sync/changelog 自动完成，
// 这里把双副本一致性变成 npm test 的强制关卡，防止漏拷后全绿上线。
t('发版: player.html 与 deploy-dist/player.html 逐字节一致', distHtml === playerHtml);

// ---- 6) 本轮 P0 修复的防回归（行为级用例见 ad-filter / skip-marks 测试）----
const adFilter = read('js/ad-filter.js');
const skipMarks = read('js/skip-marks.js');
const adRulesVer = versionMap.internalVersions['js/ad-filter.js:RULES_VERSION'];
t('广告: RULES_VERSION 与 version-map 登记一致',
    new RegExp('var RULES_VERSION = ' + adRulesVer + ';').test(adFilter));
t('广告: 区间完整性按「声明」而非「持续引用」判定',
    /mapDeclHere/.test(adFilter) && /keyDeclHere/.test(adFilter));
t('广告: totalSecs=0 时按分片数兜底触发预算',
    /candSegs \/ ctx\.segCount > DELETE_BUDGET/.test(adFilter));
t('广告: 全局标签行有强制保留保护', /isGlobalLine/.test(adFilter));
t('跳过标记: 占位标题含「未知视频」', skipMarks.includes("'未知视频'"));
// 行为级断言（旧实现是 !/stillInside/.test(源码) 的恒真文本检查，换个变量名恢复第二通路也全绿）：
// 真实加载模块，验证「拖拽大跳落入片尾不自动结束」与「连续小步跨起点才触发」。
const skipSandbox = { console: console, performance: { now: () => 0 } };
vm.createContext(skipSandbox);
vm.runInContext(skipSrc, skipSandbox);
const SM = skipSandbox.WDTVSkipMarks;
const crossBase = {
    now: 6000, lastSkipAt: 0, cooldownMs: 1000, paused: false, duration: 1300,
    position: 1201, isUserSeeking: false, guestActive: false, adRegions: null,
    segments: [{ type: 'ending', start: 1200, end: 1300 }], suppressedKeys: []
};
t('跳过标记(行为): 拖拽大跳落入片尾不自动结束',
    !!SM && SM.decideAutoSkip(Object.assign({}, crossBase, { previousPosition: 100 })) === null);
t('跳过标记(行为): 连续小步跨过片尾起点才触发',
    !!SM && (() => { const r = SM.decideAutoSkip(Object.assign({}, crossBase, { previousPosition: 1199 }));
        return !!r && r.kind === 'mark' && r.target === 1300; })());
t('跳过标记: v3 迁移 outroStart 严格 >0', /rawMark\.outroStart > 0/.test(skipMarks));
// player.js 本轮修复的调用链：全屏宿主 / 片尾撤销 / 退避 timer / 历史收敛
const cssSkip = read('css/skip-marks.css');
t('播放器: 手动标记面板与写入已移除',
    !/wdtvRenderSkipPanel|wdtvToggleSkipPanel|wdtvSaveSkipSegment|wdtv-skip-panel/.test(player + cssSkip));
t('播放器: 低置信度按钮与播放器内开关已接线',
    player.includes("className = 'wdtv-skip-cta'") && player.includes("className = 'wdtv-dm-topbtn wdtv-skip-switch'") &&
    cssSkip.includes('.wdtv-skip-cta') && cssSkip.includes('.wdtv-skip-switch'));
t('播放器: 按钮暂停隐藏、区间已过自动消失',
    /video:pause[\s\S]{0,120}?wdtvHideSkipCta/.test(player) &&
    player.includes('if (!introSkipEnabled || !v || v.paused || v.ended) { wdtvHideSkipCta(); return; }'));
t('播放器: 自动跳只取高置信段',
    player.includes('segments: introSkipEnabled ? wdtvAutoSegments(v.duration) : []'));
t('播放器: 开关改为弹出面板（总开关/两个子开关/时长/保存）',
    player.includes("menu.className = 'wdtv-skip-menu'") &&
    player.includes('data-role="enabled"') && player.includes('function wdtvSkipTimeFieldHtml') &&
    player.includes('data-role="save"') && player.includes('data-role="durations"') &&
    player.includes('data-role="body"') && player.includes('data-role="auto"') &&
    player.includes('data-role="custom"') &&
    !player.includes('data-role="reset"') && !player.includes('恢复自动检测'));
t('播放器: 时长输入为分+秒两组，秒限制 0-59',
    player.includes("data-role=\"' + type + '-min\"") &&
    player.includes("data-role=\"' + type + '-sec\"") &&
    player.includes('max="59"') && player.includes('秒数需在 0–59 之间'));
t('播放器: 分按 1 分、秒按 5 秒微调并处理进位借位',
    player.includes('data-unit="min"') && player.includes('data-unit="sec"') &&
    player.includes('function wdtvStepSkipTime') &&
    player.includes('Math.floor(total / 60)') && player.includes('total % 60'));
t('播放器: 存储仍为秒数，回显按分秒拆分',
    player.includes('wdtvFillSkipTimeInputs') && player.includes('Math.floor(seconds / 60)') &&
    player.includes('store[skipMarksKey] = {'));
t('播放器: 面板点击外部 / Esc 可关闭', player.includes('wdtvSkipMenuOutsideHandler') &&
    player.includes("document.addEventListener('pointerdown', wdtvSkipMenuOutsideHandler, true)") &&
    player.includes("ev.key === 'Escape'"));
t('播放器: 自定义时长按剧键持久化（跨集 / 刷新生效）',
    player.includes('WDTV_SKIP_CUSTOM_STORAGE') && player.includes('store[skipMarksKey]') &&
    config.includes("skipCustomStorage: 'wdtvSkipCustom'"));
t('播放器: 三层开关独立且可同时开启（按类型合并，自定义同类型优先）',
    player.includes('if (!wdtvAutoSkipEnabled && !wdtvCustomSkipEnabled) return [];') &&
    player.includes('const custom = wdtvCustomSkipEnabled ? wdtvCustomSegments(duration) : [];') &&
    player.includes('overridden[s.type] = true') &&
    player.includes('!overridden[s.type]') &&
    player.includes('const merged = custom.concat(auto);') &&
    player.includes('WDTV_SKIP_AUTO_STORAGE') && player.includes('WDTV_SKIP_CUSTOM_ENABLED_STORAGE') &&
    config.includes("skipAutoStorage: 'wdtvSkipAutoEnabled'") &&
    config.includes("skipCustomEnabledStorage: 'wdtvSkipCustomEnabled'") &&
    !config.includes('skipModeStorage') && !player.includes('function wdtvSetSkipMode'));
t('播放器: 旧版模式值一次性迁移到两个子开关，不丢自定义时长',
    player.includes("const WDTV_LEGACY_SKIP_MODE_STORAGE = 'wdtvSkipMode';") &&
    player.includes('function wdtvMigrateSkipSwitches') &&
    player.includes("if (legacy === 'auto' || legacy === 'custom')") &&
    player.includes("localStorage.removeItem(WDTV_LEGACY_SKIP_MODE_STORAGE)") &&
    player.includes('const hasStore = Object.keys(wdtvReadCustomStore()).length > 0;'));
t('播放器: 状态唯一出口（按钮与面板共用同一份文案）',
    player.includes('function wdtvSkipStatus') && player.includes('data-role="status"') &&
    player.includes('el.dataset.state = st.state') &&
    player.includes('statusEl.dataset.state = st.state') &&
    player.includes("'已启用 · 未选择跳过方式'") && player.includes("'仅自动'") &&
    player.includes("'已关闭'") && player.includes('未自动跳过，可手动点击'));
t('播放器: 总开关关闭时主体平滑折叠（class + inert，非置灰）',
    player.includes('function wdtvSetSectionOpen') &&
    player.includes("wdtvSetSectionOpen(menu.querySelector('[data-role=\"body\"]'), introSkipEnabled)") &&
    player.includes("menu.querySelector('[data-role=\"custom-section\"]')") &&
    player.includes("el.setAttribute('inert', '')") &&
    !player.includes('is-disabled'));
t('播放器: 入口为纯图标按钮（无可见文字/徽标）',
    player.includes("btn.className = 'wdtv-dm-topbtn wdtv-skip-switch'") &&
    player.includes('btn.innerHTML = WDTV_SKIP_ICON;') &&
    !player.includes("WDTV_SKIP_ICONS") &&
    !/wdtv-skip-switch[^\n]*<span>/.test(player) &&
    player.includes("el.dataset.hasData") && player.includes("el.dataset.manual") &&
    player.includes("el.setAttribute('aria-label', '跳片头尾设置，当前：' + desc)") &&
    player.includes("el.dataset.tip = '跳片头尾：' + desc") &&
    !player.includes('el.title = \'跳片头尾：\' + desc'));
t('播放器: 面板/工具组内键盘不触发播放器快捷键',
    player.includes("target.closest('.wdtv-skip-menu, .wdtv-dm-topbtns')"));
t('播放器: 自定义段为高置信、复用自动 seek 与撤销',
    read('js/skip-marks.js').includes('autoEligible: true') &&
    player.includes('wdtvAutoSegments(v.duration)'));
t('CSS: 弹出面板含移动端断点且不被裁切',
    cssSkip.includes('.wdtv-skip-menu') && cssSkip.includes('max-height: calc(100% - 96px)') &&
    cssSkip.includes('max-height: calc(100% - 54px - env(safe-area-inset-bottom, 0px))') &&
    cssSkip.includes('overflow-y: auto') &&
    cssSkip.includes('.wdtv-skip-menu__status') && cssSkip.includes('.wdtv-skip-menu__row') &&
    cssSkip.includes('.wdtv-skip-menu__toggle') &&
    !cssSkip.includes('.wdtv-skip-menu__subs') && !cssSkip.includes('.wdtv-skip-menu__modes'));
t('CSS: 开关为 iOS 滑块（单一轨道 + 滑块），折叠用 grid 0fr→1fr',
    cssSkip.includes('.wdtv-skip-menu__track') && cssSkip.includes('.wdtv-skip-menu__thumb') &&
    cssSkip.includes('input:checked ~ .wdtv-skip-menu__track') &&
    cssSkip.includes('grid-template-rows: 0fr') && cssSkip.includes('grid-template-rows: 1fr') &&
    cssSkip.includes('.wdtv-skip-menu__body.is-open'));
t('CSS: 纯图标按钮沿用工具按钮容器并保留 44px 命中区，图标恒为白色',
    cssSkip.includes('.wdtv-skip-switch') && cssSkip.includes('background: transparent') &&
    cssSkip.includes('.wdtv-skip-switch.is-on') && cssSkip.includes('[data-manual="1"]::before') &&
    cssSkip.includes('inset: -6px') && cssSkip.includes('color: rgba(255, 255, 255, 0.92)') &&
    !/\.wdtv-skip-switch[^{]*\{[^}]*var\(--wdtv-skip-accent\)/.test(cssSkip) &&
    cssSkip.includes('width: 38px') && cssSkip.includes('overflow-y: auto'));
t('CSS: 面板滑块开启态用主题强调色，关闭态为灰色',
    cssSkip.includes('--wdtv-skip-accent: #6fa8e8') &&
    cssSkip.includes('input:checked ~ .wdtv-skip-menu__track') &&
    cssSkip.includes('background: var(--wdtv-skip-accent)') &&
    cssSkip.includes('background: rgba(255, 255, 255, 0.14)') &&
    cssSkip.includes('border-color: rgba(111, 168, 232, 0.78)'));
t('CSS: 面板密度收紧（内边距 10/12、行 padding 0、行高仍 44）',
    cssSkip.includes('padding: 10px 12px calc(10px + env(safe-area-inset-bottom, 0px))') &&
    cssSkip.includes('min-height: 44px') &&
    /\.wdtv-skip-menu__row\s*\{[^}]*padding: 0;/.test(cssSkip));
t('播放器: 自动跳过说明文案已移除，DOM 与读屏属性无残留',
    !player.includes('按公共库 / IntroDB 自动识别片头片尾') &&
    !player.includes('自动识别片头片尾') &&
    !player.includes('aria-describedby') &&
    player.includes('hintEl.hidden = !hint || !!(msgEl && !msgEl.hidden)'));
t('播放器: 片尾自动跳过可撤销（换集定时器可取消）',
    /wdtvAutoPlayNextTimer/.test(player) && /wdtvEndingSkipPending/.test(player) &&
    /clearTimeout\(wdtvAutoPlayNextTimer\)/.test(player));
t('播放器: 网络退避 timer 换集可清理', /recoveryRetryTimer/.test(player) && /clearTimeout\(recoveryRetryTimer\)/.test(player));
t('播放器: 观看历史主路径委托 upsertViewingHistory',
    /upsertViewingHistory\(/.test(player) && !/item\.title === currentVideoTitle &&/.test(player));

// ---- 7) 本轮深度审查修复的防回归（行为级用例见各模块 .test.mjs）----
const apiSrc = read('js/api.js');
const shSrc = read('js/source-health.js');
const ifSrc = read('js/image-fallback.js');
const dlSrc = read('js/downloader.js');
const prSrc = read('js/playback-recovery.js');
const ffBody = (apiSrc.match(/async function fetchWithFallback[\s\S]*?\n\}/) || [''])[0];
t('A3: fatal 的 bufferAppendError 不被提前 return 吞掉',
    player.includes("data.details === 'bufferAppendError' && !data.fatal"));
const playerCode = player.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
t('播放器: 恒 false 的 isSwitchingVideo 死标志已移除，改用实例代次保护',
    !/isSwitchingVideo/.test(playerCode) && player.includes('wdtvPlayerGeneration') &&
    player.includes('playerGeneration !== wdtvPlayerGeneration'));
t('广告: 签名与校验侧同源（analyze 用 currentSignature）',
    /var sig = currentSignature\(opts\.storageKey\);/.test(adFilter));
t('广告: 主开关每次从 localStorage 刷新并透传 storageKey',
    player.includes("adFilteringEnabled = localStorage.getItem(storageKey) !== 'false'") &&
    player.includes('storageKey: storageKey'));
t('广告: 下载链路同样透传 storageKey', /storageKey: afKey/.test(dlSrc));
t('A5: 详情链路写回整源成败且探测型调用可跳过',
    apiSrc.includes('const trackHealth = !opts || opts.trackHealth !== false;') &&
    (apiSrc.match(/settleHealth\(true\)/g) || []).length >= 3 && apiSrc.includes('settleHealth(false)'));
t('A5: 请求层不重复写整源成败（避免与 search.js 双计数）',
    ffBody.length > 200 && !/markSourceHealth\(/.test(ffBody));
t('A5: 时长链路 CDN 键不污染源停用阶梯', apiSrc.includes('与采集站源 ID 属不同键空间'));
const writeRawBody = (shSrc.match(/function writeRaw[\s\S]*?\n    \}/) || [''])[0];
t('源健康度: permanent 记录豁免 7 天清理',
    writeRawBody.length > 100 && /permanent/.test(writeRawBody));
t('图片降级: 耗尽时 onfallback 不再被事件派发结果屏蔽',
    /typeof imgEl\.onfallback === 'function'/.test(ifSrc) &&
    !/if \(!fired && typeof imgEl\.onfallback/.test(ifSrc));
t('错误恢复: 导出策略对象已冻结', /Object\.freeze/.test(prSrc));
t('页面: 页级错误兜底已挂载',
    indexHtml.includes("addEventListener('unhandledrejection'") && indexHtml.includes("addEventListener('error'"));

// ---- 8) 搜索结果排序：关联度优先于源优先级 ----
// 搜索接口多按更新时间返回且常混入只沾边的条目；若排序退回「源优先级/到达顺序」，
// 真正要搜的片名会被挤到后面。这里锁住排序入口与比较器的主次关系。
const aggregateSrc = read('js/aggregate.js');
t('搜索: 结果排序走关联度模块且传入当前关键词',
    app.includes('rankGroupsByRelevance(groups, currentSearchQuery') &&
    aggregateSrc.includes('function rankGroupsByRelevance('));
t('搜索: 列表只按关联度排序，源优先级不参与',
    /\(b\.score - a\.score\)\s*\|\|\s*\(a\.idx - b\.idx\)/.test(aggregateSrc) &&
    !/minRank/.test(aggregateSrc));
t('搜索: 源等级仍用于组内选源',
    /function sortGroupItems[\s\S]{0,400}?getSourceTier\(/.test(app));
const openResultCardBody = (app.match(/function openResultCard\([\s\S]*?\n\}/) || [''])[0];
t('搜索: 多源/单源卡片点击统一打开详情',
    openResultCardBody.length > 200 &&
    openResultCardBody.includes('showDetails(') &&
    !app.includes('directPlayBestSource'));
t('搜索: 同视频聚合与渐进去重保留',
    app.includes('function isSameDisplayedGroup') &&
    app.includes('deriveOrderedGroupedResults') &&
    aggregateSrc.includes('function aggregateResults('));
t('搜索: 稳定聚合键与增量渲染已接线',
    aggregateSrc.includes('titleGroupKey: titleGroupKey') &&
    app.includes('function getOrderedSearchGroups(') &&
    app.includes('appendOnly'));
t('页面: 优先级视图重置按钮已接线',
    indexHtml.includes('wdtvSourceResetBtn') &&
    indexHtml.includes('resetSourceSettings') &&
    app.includes('function resetSourceSettings('));
t('搜索: 三级源等级滑块与 UI 已接线',
    config.includes('SOURCE_TIER_LEVELS = 3') &&
    config.includes("SOURCE_TIER_STORAGE = 'wdtvSourceTiers'") &&
    app.includes('function getSourceTier(') &&
    app.includes('function setSourceTier(') &&
    app.includes('wdtv-tier-range') &&
    app.includes('function updateTierRange(') &&
    !indexHtml.includes('wdtv-tier-legend') &&
    !indexHtml.includes('wdtv-tier-chip') &&
    !indexHtml.includes('wdtv-tier-btn'));
t('搜索: 数据源按优先级排序且支持双视图',
    app.includes('function getSourceView(') &&
    app.includes('function setSourceView(') &&
    app.includes('function initSourceViewToggle(') &&
    app.includes('wdtv-source-classic') &&
    app.includes('getSourceTier(a) - getSourceTier(b)') &&
    indexHtml.includes('wdtv-source-view-toggle') &&
    indexHtml.includes('data-view="priority"') &&
    indexHtml.includes('data-view="classic"'));
t('搜索: 旧的固定前三源机制已移除',
    !app.includes('SOURCE_PRIORITY_LIMIT') &&
    !app.includes('getSourcePriority(') &&
    !indexHtml.includes('sourcePriority1') &&
    !indexHtml.includes('wdtv-priority-dropdown'));
// .wsp-panel 是观影空间的常驻内容区（index.html:819），不是弹层；给它加 focus trap 会锁死键盘焦点。
// 这里锁住三个真实弹层的接线，并显式断言不会把常驻区误当弹层。
const panelsBody = (indexHtml.match(/var PANELS = \[[\s\S]*?\];/) || [''])[0];
t('页面: 焦点陷阱覆盖三个真实弹层且不误锁 .wsp-panel',
    panelsBody.length > 50 &&
    ["id:'settingsPanel'", "id:'historyPanel'", "id:'modal'"].every(s => panelsBody.includes(s)) &&
    !/\.wsp-panel/.test(panelsBody));
// ---- 9) 本轮 UI 收敛的防回归（悬浮提示 / 图标 / 房间码 / 下载文案 / 滚动条 / 弹幕 / 共同观影）----
const wdHtml = read('wd.html');
const aboutHtml = read('about.html');
const motionJs = read('js/motion.js');
const motionCss = read('css/motion.css');
const spaceJs = read('js/space.js');
const danmuJs = read('js/danmu.js');
const watchPartyCss = read('css/watch-party.css');
const dlCss = read('css/downloader.css');
const uiJs = read('js/ui.js');
const watchPartyUi = read('js/watch-party-ui.js');
const cloudSyncUi = read('js/cloud-sync-ui.js');
const localServer = read('server.mjs');
const doWorker = read('sync-worker/src/index.js');

// 悬浮提示：全站改用原生 title 语义移除，避免自绘 tip 层与 data-tip 数据源
t('提示: 三个页面均无 data-tip',
    !indexHtml.includes('data-tip') && !playerHtml.includes('data-tip') && !wdHtml.includes('data-tip'));
t('提示: motion.js 不再有 tip 数据源与启动函数',
    !motionJs.includes('mo-tip') && !motionJs.includes('startTips') && !motionJs.includes("setAttribute('data-tip'"));
t('提示: motion.css 无 .mo-tip 样式', !motionCss.includes('.mo-tip'));

// 摄像头图标：单个采集站源已下线，对应相机 path 全仓库源码清零
const CAMERA_PATH = 'M15 10l4.553';
t('图标: player.html / about.html 无摄像头 path',
    !playerHtml.includes(CAMERA_PATH) && !aboutHtml.includes(CAMERA_PATH));
function walkFiles(dir) {
    const out = [];
    for (const name of fs.readdirSync(path.join(root, dir))) {
        const rel = dir + '/' + name;
        const stat = fs.statSync(path.join(root, rel));
        if (stat.isDirectory()) out.push(...walkFiles(rel));
        else out.push(rel);
    }
    return out;
}
const srcDirs = [...walkFiles('js'), ...walkFiles('css')];
t('图标: 全仓库 css/js 源码无摄像头 path',
    srcDirs.every(f => !read(f).includes(CAMERA_PATH)),
    srcDirs.filter(f => read(f).includes(CAMERA_PATH)).join(', '));

// 房间码：只保留双击/长按复制，不再有常驻「复制房间码」按钮
t('房间码: index.html 无复制按钮', !indexHtml.includes('wpCopyInvite') && !indexHtml.includes('复制房间码'));
t('房间码: space.js 无 copyBtn 但保留双击/指针复制',
    !spaceJs.includes('copyBtn') && spaceJs.includes('bindRoomCodeCopy') &&
    spaceJs.includes('dblclick') && spaceJs.includes('pointerdown'));

// 下载入口：播放页动作区（片名行右侧）提供「批量下载」，与首页详情弹窗共用同一批量下载弹窗；
// 播放器右上角不再有下载按钮，旧「下载本集」面板与文案随之清除
t('下载: 视频下方动作区含批量下载入口',
    playerHtml.includes('id="batchDownloadBtn"') &&
    playerHtml.includes('openPlayerBatchDownload(event)') &&
    player.includes('function openPlayerBatchDownload(') &&
    player.includes('openBatchDownloadModal'));
t('下载: 播放器内下载按钮与「下载本集」面板已移除',
    !player.includes('wdtv-dm-dlbtn') &&
    !player.includes('wdtv-dl-panel-btn') &&
    !player.includes('下载本集</span>') &&
    !player.includes('下载本集（MP4）'));

// 数据源优先级重置：按钮 + 回调 + 容器样式三处接线
t('优先级: 重置入口含容器样式与回调',
    indexHtml.includes('wdtvSourceResetBtn') && indexHtml.includes('resetSourceSettings') &&
    app.includes('function resetSourceSettings(') && app.includes('.wdtv-source-reset'));

// 共同观影：输入框聚焦态、消息菜单横排、系统/撤回提示居中
const msgMenuBody = (watchPartyCss.match(/\.wp-msg-menu\s*\{[\s\S]*?\n\}/) || [''])[0];
t('共同观影: 输入框聚焦态已定义', watchPartyCss.includes('.wp-chat .wp-chat-input:focus'));
t('共同观影: 消息菜单横排', msgMenuBody.includes('flex-direction: row'));
t('共同观影: 系统/撤回提示居中',
    /\.wp-msg\.wp-msg-sys\s*\{[\s\S]*?justify-content:\s*center/.test(watchPartyCss));

// 搜索历史拖动 / 搜索结果单卡重排 / 共同观影布局
const orderedGroupsBody = (app.match(/function getOrderedSearchGroups\([\s\S]*?\n\}/) || [''])[0];
t('搜索历史: 拖动绑定与溢出渐隐已接线',
    uiJs.includes('function bindRecentSearchDrag(') && uiJs.includes('recentDragBound') &&
    uiJs.includes('has-overflow') && uiJs.includes('runInertia') &&
    indexHtml.includes('.wdtv-recent.is-dragging') &&
    indexHtml.includes('.wdtv-recent.has-overflow'));
t('搜索: 关联度顺序驱动增量卡片同步',
    orderedGroupsBody.includes('deriveOrderedGroupedResults') &&
    !orderedGroupsBody.includes('searchGroupOrder.forEach') &&
    app.includes('function syncSearchResultCards(') &&
    app.includes('function animateSearchCardMoves(') &&
    app.includes("translate: '0px 0px'") &&
    app.includes('wdtv-card-moving-primary'));
t('搜索: 单卡重排尊重减少动效',
    app.includes("prefers-reduced-motion: reduce") &&
    app.includes("classList.contains('fx-off')"));
// 徽标随成员同排：绿色状态点后面紧跟徽标组（删除复制房间码按钮后不再上移到房间码行）
const wpUiFlat = watchPartyUi.replace(/\s+/g, ' ');
t('共同观影: 房态无复制按钮且房间码可长按复制，徽标与成员同排',
    !watchPartyUi.includes('id="wpCopy"') && !watchPartyUi.includes('>复制房间码<') &&
    watchPartyUi.includes('bindRoomCodeCopy') &&
    watchPartyUi.includes('class="wp-tags"') &&
    // 绿色状态点先出现、徽标组在其后
    wpUiFlat.indexOf('id="wpDot"></span>') >= 0 &&
    wpUiFlat.indexOf('id="wpDot"></span>') < wpUiFlat.indexOf('class="wp-tags"') &&
    !watchPartyUi.includes('wp-top-chips'));
// 房间码与「共同观影」标题同排（房间码在左，标题在右）；M1 同步提示语与徽标同行
t('共同观影: 房间码与标题同排且提示语紧跟徽标',
    watchPartyUi.includes('function syncHeadCode(') &&
    watchPartyUi.includes("document.getElementById('wpCode')") &&
    watchPartyUi.includes('function m1SyncNote(') &&
    watchPartyUi.includes('<span class="wp-peer-note">') &&
    playerHtml.includes('<span class="wp-code" id="wpCode"></span>') &&
    watchPartyCss.includes('.wp-head-id') &&
    watchPartyCss.includes('.wp-peer-note') &&
    // 同步提示语全文只出现一次（M1 小节里不再重复输出）
    (watchPartyUi.match(/你的播放、暂停与进度操作将实时同步给对方/g) || []).length === 1);
t('共同观影: 右键与长按均可开菜单且位于气泡上方',
    watchPartyUi.includes("el.addEventListener('contextmenu'") &&
    /function onMsgPointerDown\(e\)[\s\S]{0,240}?e\.button !== 0/.test(watchPartyUi) &&
    watchPartyUi.includes('menu.dataset.side = side') &&
    watchPartyUi.includes('r.top - mr.height - 10'));
t('共同观影: 引用块无左侧竖条',
    !/\.wp-quote\s*\{[^}]*border-left/.test(watchPartyCss) &&
    !/\.wp-msg\.me \.wp-quote\s*\{[^}]*border-left/.test(watchPartyCss));
// 头像/状态点改为跟随鼠标的磁力摆动（不再有自动摆动动画抢 transform 通道）
t('共同观影: 头像/状态点改用磁力摆动且保留减少动效降级',
    !watchPartyCss.includes('@keyframes wpAvatarSway') &&
    !watchPartyCss.includes('@keyframes wpDotSway') &&
    !/wp-avatar[\s\S]{0,80}?animation:\s*wpAvatarSway/.test(watchPartyCss) &&
    !/\.wp-dot\.on\s*\{[^}]*animation/.test(watchPartyCss) &&
    // 已接入 motion.js 的磁性名单（磁性位移写 transform，动画会顶掉它）
    /MAGNET_SEL[\s\S]{0,900}?\.wp-avatar/.test(motionJs) &&
    /MAGNET_SEL[\s\S]{0,900}?\.wp-dot/.test(motionJs) &&
    watchPartyCss.includes('html.fx-off .wp-avatar') &&
    watchPartyCss.includes('animation: none !important'));
t('共同观影: 播放器轨道与设备分区已接线',
    watchPartyUi.includes('function applyWatchLayout(') &&
    watchPartyUi.includes('main.dataset.wpRail') &&
    watchPartyUi.includes('--wp-player-w') &&
    // 信息区改为一行两区后，轨道分档只剩 narrow 需要单独排版（wide/mid 共用 flex 布局）
    watchPartyCss.includes('data-wp-rail="narrow"') &&
    watchPartyCss.includes('aspect-ratio: var(--wp-player-ar') &&
    watchPartyCss.includes('clamp(320px, 24vw, 400px)'));
t('共同观影: 观影模式播放器尺寸由轨道接管',
    /function applyVideoFitSize\(\)[\s\S]{0,600}?classList\.contains\('wp-watch-mode'\)/.test(player) &&
    watchPartyUi.includes('applyVideoFitSize()'));

// 弹幕：信息窗口 + 剧名变体匹配；详情按钮不再被隐藏
t('弹幕: 播放器信息窗口与匹配信息已接线',
    player.includes('wdtv-dm-info') && player.includes('getMatchInfo') &&
    danmuJs.includes('function getMatchInfo(') && danmuJs.includes('buildTitleCandidates'));
t('弹幕: 详情按钮不再被强制隐藏', !player.includes("detailBtn.style.display = 'none'"));
// 旧片重进：标题级缓存保证即使 episodeId 失效也能直接出弹幕；
// 手动匹配：作废在途链，避免 plugin.load() 复用空 Promise 造成「匹配成功却空白」。
t('弹幕: 旧片秒开与手动匹配重建链路已接线',
    danmuJs.includes('LS_TITLE_KEY') && danmuJs.includes('function saveTitleCache(') &&
    danmuJs.includes('function invalidateInflight()') && danmuJs.includes('invalidateInflight();'));
// 手动匹配列表展示平台全名，不再把采集端代码/来源缩写丢给用户
t('弹幕: 搜索结果展示来源全名而非缩写',
    danmuJs.includes('function sourceDisplayName(') && danmuJs.includes("'tencent': '腾讯视频'") &&
    player.includes('cleanDanmuAnimeTitle(') && player.includes('wdtv-danmu-src-tag') &&
    read('css/player.css').includes('.wdtv-danmu-src-tag') &&
    !indexHtml.includes('爱优腾芒哔'));
// 信息区同样不能把采集端尾巴（from tencent）直接丢给用户；「源」行要带平台全名
t('弹幕: 信息区显示平台全名与去尾巴剧名',
    danmuJs.includes('function cleanAnimeTitle(') && danmuJs.includes('function platformLabelOf(') &&
    danmuJs.includes("platform ? platform + ' · ' + endpoint : endpoint") &&
    player.includes('cleanDanmuAnimeTitle(info.animeTitle)'));
// 显示区域：浅色块代表可用范围，必须从顶部向下画；切换要同步插件 option 并重排已入队弹幕
const dmAreaCss = (read('css/player.css').match(/\.wdtv-dm-area i \{[\s\S]*?\}/) || [''])[0];
t('弹幕: 显示区域图标自顶部填充且切换立即重排',
    /top:\s*0/.test(dmAreaCss) && !/bottom:\s*0/.test(dmAreaCss) &&
    player.includes('function applyDanmuMargin(') && player.includes('plugin.config({ margin: val })') &&
    player.includes('applyDanmuMargin(val);'));

// 滚动条：统一隐藏，移除旧的分区滚动条美化
t('滚动条: 设置面板与下载器旧规则已移除',
    !motionCss.includes('html .wdtv-settings-panel::-webkit-scrollbar') &&
    !dlCss.includes('::-webkit-scrollbar') &&
    !indexHtml.includes('.wdtv-api-scroll::-webkit-scrollbar'));

// 搜索稳定性与同名合并去重
// 共同观影：成员区显示真实头像（房间内互传，不落库）
t('共看: 头像缩略图协议已接线且服务端只转发',
    watchParty.includes("case 'avatar':") &&
    watchParty.includes('function setMyAvatar(') &&
    watchParty.includes('avatarOf:') &&
    watchPartyUi.includes('function memberAvatarHtml(') &&
    watchPartyUi.includes('function loadMyAvatar(') &&
    watchPartyUi.includes('function paintMemberAvatar(') &&
    cloudSync.includes('function getAvatarThumb(') &&
    cloudSync.includes('getAvatarThumb: getAvatarThumb') &&
    // 服务端：限长 + 限定 data:image + 只广播给其他成员（不落库、不进房间状态）
    /case 'avatar'[\s\S]{0,600}?dataUrl\.length > 12000/.test(localServer) &&
    /case 'avatar'[\s\S]{0,600}?dataUrl\.length > 12000/.test(doWorker) &&
    /case 'avatar'[\s\S]{0,900}?roomBroadcast\(room, \{ t: 'avatar'/.test(localServer) &&
    /case 'avatar'[\s\S]{0,900}?this\.broadcast\(\{ t: 'avatar'/.test(doWorker) &&
    // 头像不得进房间持久状态
    !/case 'avatar'[\s\S]{0,900}?room\.state\.[a-zA-Z]*avatar/.test(localServer) &&
    !/case 'avatar'[\s\S]{0,900}?this\.state\.[a-zA-Z]*avatar/.test(doWorker));
t('共看: 信息区一行两区且分设备适配',
    /body\.wp-watch-mode \.wp-main\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap[^}]*align-items:\s*center/.test(watchPartyCss) &&
    /body\.wp-watch-mode \.wp-top\s*\{[^}]*flex:\s*1 1 0/.test(watchPartyCss) &&
    /body\.wp-watch-mode \.wp-sec\s*\{[^}]*margin-left:\s*auto/.test(watchPartyCss) &&
    watchPartyCss.includes('@media (min-width: 900px) and (max-width: 1199px)') &&
    /@media \(max-width: 899px\)[\s\S]{0,1400}?body\.wp-watch-mode \.wp-main\s*\{[^}]*flex-direction:\s*column/.test(watchPartyCss));
t('共看: 房间码与标题同排且字号协调',
    watchPartyCss.includes('.wp-head-id') &&
    /\.wp-head \.wp-code\s*\{[^}]*font-size:\s*18px/.test(watchPartyCss) &&
    /\.wp-head-id\s*\{[^}]*align-items:\s*baseline/.test(watchPartyCss));
// 首页账号：相机角标整体移除（头像本身就是上传入口）
t('账号: 相机角标已移除',
    !cloudSyncUi.includes('wdtv-am-cam') &&
    !read('css/index.css').includes('.wdtv-am-cam'));
t('账号: 昵称中文用演示秋鸿楷、拉丁用 Sriracha',
    /#account-btn\{[\s\S]{0,900}?font-family:'Slideqiuhong','Sriracha','Noto Serif SC'/.test(read('css/index.css')) &&
    /\.wdtv-am-nick\{[\s\S]{0,200}?font-family:'Slideqiuhong','Sriracha','Noto Serif SC'/.test(read('css/index.css')) &&
    /\.wp-name \{[\s\S]{0,240}?font-family: 'Slideqiuhong', 'Sriracha'/.test(watchPartyCss));
t('账号: 秋鸿楷字体表带 swap 且页面已引入',
    // 原包 font.css 缺 font-display（默认 auto 会在字体加载期间把昵称整段藏起来 = FOIT）
    read('css/slideqiuhong.css').includes('font-display: swap') &&
    /url\('https:\/\/cdn\.jsdelivr\.net\/npm\/cn-fontsource-slideqiuhong-regular/.test(read('css/slideqiuhong.css')) &&
    indexHtml.includes('css/slideqiuhong.css?v=1') &&
    playerHtml.includes('css/slideqiuhong.css?v=1') &&
    fs.existsSync(path.join(root, 'scripts', 'build-slideqiuhong-font.mjs')));
// 药丸头像与账号卡片里的头像是同一尺寸、同一块画面；昵称跟着放大
t('账号: 药丸头像 46px、与账号卡片同一取景，昵称同比例',
    /\.wdtv-ab-avatar\{[\s\S]{0,320}?width:46px;height:46px/.test(read('css/index.css')) &&
    /\.wdtv-am-avatar-btn\{[\s\S]{0,400}?width:54px;height:54px/.test(read('css/index.css')) &&
    /\.wdtv-ab-name\{[\s\S]{0,240}?font-size:1rem/.test(read('css/index.css')) &&
    /\.wdtv-ab-avatar img\{[\s\S]{0,120}?object-fit:cover/.test(read('css/index.css')) &&
    /\.wp-avatar \{[\s\S]{0,320}?width: 26px;[\s\S]{0,80}?height: 26px/.test(watchPartyCss) &&
    /\.wp-name \{[\s\S]{0,200}?font-size: 13px/.test(watchPartyCss) &&
    /\.wp-avatar img \{[\s\S]{0,160}?object-fit: cover/.test(watchPartyCss));
// 默认头像 = 透明底素描线稿（只留线条，不再是线性人形剪影，也不要白色圆盘底）
// 线条颜色由 CSS mask + currentColor 决定；小尺寸另有加粗版（同一条线在 26~30px
// 不足 1 个像素，必须按比例加粗，否则首页亮背景上根本看不见）
t('账号: 默认头像是透明底线稿，小尺寸用加粗版',
    !/<rect/.test(read('image/avatar-default.svg')) &&
    !/<rect/.test(read('image/avatar-default-sm.svg')) &&
    /\.wdtv-avatar-def\{[\s\S]{0,300}?mask:url\('\.\.\/image\/avatar-default\.svg'\)/.test(read('css/index.css')) &&
    !/\.wdtv-ab-avatar \.wdtv-avatar-def\{/.test(read('css/index.css')) &&
    /\.wdtv-avatar-def\{[\s\S]{0,200}?center\/92%/.test(read('css/index.css')) &&
    /\.wp-avatar-def \{[\s\S]{0,300}?mask: url\('\.\.\/image\/avatar-default-sm\.svg'\)/.test(watchPartyCss) &&
    cloudSyncUi.includes('wdtv-avatar-def') &&
    watchPartyUi.includes('wp-avatar-def') &&
    !/M20 21v-2a4 4 0 0 0-4-4H8/.test(cloudSyncUi + watchPartyUi) &&
    fs.existsSync(path.join(root, 'image', 'avatar-default.svg')) &&
    fs.existsSync(path.join(root, 'image', 'avatar-default-sm.svg')));
// 药丸里的线稿必须与昵称同一个色阶（继承 #account-btn），不另设更白的颜色，
// 也不加描边晕——否则看起来总比文字亮一档
t('账号: 药丸线稿头像与昵称同色（继承按钮色阶）',
    /\.wdtv-ab-avatar\{[\s\S]{0,900}?color:inherit;/.test(read('css/index.css')) &&
    /#account-btn\{[\s\S]{0,1200}?color:rgba\(236,244,255,0\.72\)/.test(read('css/index.css')) &&
    !/\.wdtv-ab-avatar \.wdtv-avatar-def\{[\s\S]{0,400}?filter:drop-shadow/.test(read('css/index.css')));
// 账号卡片是白底（54px），线稿仍用深墨色，否则白线落在白底上等于消失
t('账号: 卡片线稿用深墨色（白底可见）',
    /\.wdtv-am-avatar-btn\{[\s\S]{0,900}?color:rgba\(30,45,75,0\.72\)/.test(read('css/index.css')));
// 占位节点必须自己裁圆：父级按钮为露出相机角标去掉了 overflow:hidden，
// 方形遮罩不补 border-radius 会把线条漏到圆外（真照片靠 img 的圆角裁）
t('账号: 默认头像节点自带圆形裁切',
    /\.wdtv-avatar-def\{[\s\S]{0,300}?border-radius:50%/.test(read('css/index.css')) &&
    /\.wp-avatar-def \{[\s\S]{0,300}?border-radius: 50%/.test(watchPartyCss));
// 顶部导航：历史按钮与账号药丸同高、同一基线（药丸长高后必须一起对齐）
t('首页: 顶部历史按钮与账号药丸同高对齐',
    /\.wdtv-nav-btn\{[^}]*height:52px;width:52px/.test(indexHtml) &&
    /#account-btn\{[\s\S]{0,600}?height:52px/.test(read('css/index.css')));
// 共看成员头像占位（span 线稿）可被真实头像（img）替换
t('共看: 默认线稿占位可被真实头像覆盖',
    /if \(!av \|\| av\.querySelector\('img'\)\) return;/.test(watchPartyUi) &&
    watchPartyUi.includes("'<span class=\"wp-avatar-def\""));
t('搜索: 稳定渲染入口与摘要增量更新',
    app.includes('getOrderedSearchGroups') && app.includes('appendOnly') &&
    app.includes('updateSearchSummaryOnly') && aggregateSrc.includes('titleGroupKey'));

// 入场观察器：appendChild 移动卡片不得取消观察（否则卡片永远停在 opacity:0，整片结果看不见）
t('搜索: 入场观察器仅在节点真正脱离文档时取消观察',
    motionJs.includes('var observed = new WeakSet();') &&
    motionJs.includes('if (!gone.isConnected)') &&
    motionJs.includes('observed.delete(gone)') &&
    motionJs.includes('observed.has(el)') &&
    !/removedNodes[\s\S]{0,240}?io\.unobserve\(gone\);[\s\S]{0,80}?queued\.delete\(gone\);\s*\}/.test(motionJs));
t('搜索: 入场有看门狗兜底放行（内容不得永远停在 opacity:0）',
    motionJs.includes('function guardTick()') && motionJs.includes('function armGuard()') &&
    motionJs.includes("doc.querySelectorAll('.mo-pending')"));

// 成人/伦理过滤：写死在代码里、默认开启、界面不得出现开关或说明
t('过滤: 成人关键词名单与判定写死在 search.js',
    searchJs.includes('WDTV_ADULT_FILTER_KEYWORDS') &&
    searchJs.includes('function filterAdultSearchItems') &&
    searchJs.includes('function isAdultFilteredItem'));
t('过滤: 四条搜索结果入口都经过成人过滤',
    searchJs.includes('items.push(...filterAdultSearchItems(list))') &&
    searchJs.includes('return filterAdultSearchItems(items).map') &&
    searchJs.includes('.filter(item => !isAdultFilteredItem(item))') &&
    searchJs.includes('const results = filterAdultSearchItems(data.list.map'));
t('过滤: app 最终渲染与会话缓存恢复都兜底过滤',
    app.includes('? filterAdultSearchItems(lastSearchResults) : lastSearchResults') &&
    app.includes('? filterAdultSearchItems(parsed.results) : parsed.results'));
t('过滤: 界面无任何成人过滤开关或描述',
    !/yellowFilter|成人过滤|伦理过滤|屏蔽伦理|屏蔽成人/.test(indexHtml) &&
    !/yellowFilterEnabled/.test(app) && !/yellowFilterEnabled/.test(searchJs));

console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
