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
t('B1: replaceUrlState 定义 1 处 + 调用 4 处', count(player, /replaceUrlState\(/g) === 5);
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
    config.includes('qiqi: {') && config.includes("name: '七七资源'"));
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
    player.includes('el.title = \'跳片头尾：\' + desc'));
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
// .wsp-panel 是观影空间的常驻内容区（index.html:819），不是弹层；给它加 focus trap 会锁死键盘焦点。
// 这里锁住三个真实弹层的接线，并显式断言不会把常驻区误当弹层。
const panelsBody = (indexHtml.match(/var PANELS = \[[\s\S]*?\];/) || [''])[0];
t('页面: 焦点陷阱覆盖三个真实弹层且不误锁 .wsp-panel',
    panelsBody.length > 50 &&
    ["id:'settingsPanel'", "id:'historyPanel'", "id:'modal'"].every(s => panelsBody.includes(s)) &&
    !/\.wsp-panel/.test(panelsBody));
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail) { console.log('失败用例：' + fails.join(' | ')); process.exit(1); }
