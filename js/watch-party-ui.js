// js/watch-party-ui.js —— 双人共同观影房内面板 UI
// 职责：正常模式 = 工具栏入口按钮 + 玻璃抽屉面板（原版交互）；
//       观影模式（进入房间）= 右侧悬浮玻璃面板 #wpInline 常驻呈现全部功能
//       （剧集区折叠为「剧集选单」按钮并入资源信息栏顶替「切换资源」位置；
//        面板内 聊天区占主导 + 房间信息/操作区可折叠 + 底部纤薄工具行）；
//       四态渲染（idle / connecting / room / error）、M1/M2/M3 操作区、
//       聊天（本地乐观渲染 + seq 去重 + 未读红点）、共享画布工具条、邀请链接复制。
// 依赖：window.WatchParty（js/watch-party.js，defer 顺序保证先于本模块执行）；
//       window.WatchLocal 见 lp()（js/watch-party-local.js，可缺席，全部特性检测）；
//       window.CloudSync.getStatus().loggedIn（登录门禁）；window.showToast（js/ui.js）。
// 原则：未建房零请求零行为（所有网络调用只在用户操作或 URL ?room= 恢复后发生）。
(function () {
  'use strict';

  // ============================================================
  // 基础工具
  // ============================================================
  function wp() { return window.WatchParty || null; }          // 核心模块（可能尚未就绪）
  function lp() { return window.WatchPartyLocal || null; }     // 本地能力模块（可缺席）

  function $(sel, root) { return (root || document).querySelector(sel); }

  // HTML 转义（聊天文本 / 昵称 / 片名等全部经过此处）
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg) {
    try { if (typeof window.showToast === 'function') window.showToast(msg); } catch (e) { }
  }

  // 服务端 t 为毫秒时间戳（秒级时间戳兜底 ×1000）
  function fmtTime(t) {
    var ms = typeof t === 'number' && t > 0 ? (t < 1e12 ? t * 1000 : t) : Date.now();
    var d = new Date(ms);
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
  }

  // 成员气泡色板：uid 哈希到固定 6 色
  var AVATAR_COLORS = ['#ff5a5a', '#ffb020', '#41d08a', '#4aa8ff', '#b06aff', '#ff8fb8'];
  function hashColor(uid) {
    var s = String(uid == null ? '?' : uid), h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function firstChar(name) {
    var s = String(name || '').trim();
    return s ? s.charAt(0) : '?';
  }

  function isLoggedIn() {
    try {
      var cs = window.CloudSync;
      return !!(cs && typeof cs.getStatus === 'function' && cs.getStatus().loggedIn);
    } catch (e) { return false; }
  }

  // 错误码 → 中文文案（create/join REST 与 WS error 事件共用）
  var ERR_TEXT = {
    unauthorized: '请先登录后再使用共同观影',
    sync_unconfigured: '实时服务未配置：需先部署 sync-worker 实时服务',
    badRoom: '房间不存在或房间码无效',
    roomFull: '房间已满（仅支持 2 人）',
    roomCreateFailed: '创建房间失败，请稍后重试',
    network: '网络异常，请检查连接后重试',
    authFailed: '登录凭证已失效，请重新登录',
    roomError: '房间服务异常，请稍后重试',
    notHost: '仅房主可执行该操作',
    badFile: '文件无效',
    disconnected: '连接已断开',
    unknown: '发生未知错误'
  };

  // ============================================================
  // UI 运行时状态
  // ============================================================
  var ui = {
    panel: null, cardBody: null,          // 内嵌卡片（观影模式）
    drawer: null, drawerBody: null,       // 侧滑抽屉（正常模式，原版交互）
    closeBtn: null, entryBtn: null,
    body: null, main: null, msgs: null,   // 当前活动渲染容器及其子区
    open: false,          // 抽屉展开状态
    unread: 0,            // 抽屉收起时的未读消息数
    fileInput: null, cbar: null,
    error: null,          // 错误态错误码（非 null 时面板渲染错误视图）
    busy: false,          // create/join 请求进行中
    prefillCode: '',      // URL ?room= 预填加入输入框
    lastVideo: null,      // 最近一次 src/snap 的片源 {mode,url,title}
    online: 0,            // 在线人数（snap/presence 维护）
    lastPeerCached: null, // 对端最近一次 buf 上报的覆盖率（peerbuf 事件）
    lastRtt: null,        // 最近一次心跳 RTT（status 事件）
    ownM3File: null,      // 本端已选 M3 文件（房主 startM3 需要 File 对象）
    ownM3Fp: null,        // 本端文件指纹
    ownM3Checking: false, // 指纹计算中
    cinemaOpen: false,    // 我的影院选片层（列表）
    cinemaEpFav: null,    // 已展开集数选择的收藏项
    m2Timer: 0,           // M2 覆盖率轮询（3s，值变化才重渲染）
    chatLog: [],          // 聊天记录（重建 DOM 时回放）
    seenSeq: {},          // 服务端 seq 去重（断线重连历史回放不重复）
    roomSig: '',         // 房内主区渲染签名（相同则跳过，避免重渲染丢状态）
    lockNotified: false, // 纯观看锁定提示去重
    restoreWatch: false  // 刷新/后台归来恢复中：连接期间保持观影模式布局（消除两段式闪变）
  };

  var CANVAS_COLORS = ['#ff5a5a', '#ffb020', '#41d08a', '#4aa8ff', '#b06aff', '#ffffff'];
  var CANVAS_SIZES = [2, 4, 7];

  // ============================================================
  // 双壳渲染：正常模式 = 工具栏「共同观影」入口按钮 + 右侧滑出抽屉（原版交互）；
  // 观影模式（已进入房间）= 页面内嵌卡片 #wpInline 常驻呈现全部功能
  // ============================================================

  // 内嵌面板（观影模式）：#wpInline 由 player.html 提供，缺席时动态兜底创建
  function ensurePanel() {
    // 注意：不得因 ui.panel 已存在而提前 return——p.hidden = false 必须每次执行。
    // 此前只在首次执行，一旦经历过 applyWatchModeLayout(false)（退出/错误/断开
    // 重渲染）把面板置 hidden，之后重连进房面板永久隐藏：body.wp-watch-mode 在，
    // #wpInline 不显示，页面只剩一个视频（后台归来"所有按钮消失只剩视频"的根源）
    var p = ui.panel || document.getElementById('wpInline');
    if (!p) {
      // 兜底：宿主页未提供面板容器（旧版缓存页面）时动态创建到源信息栏之后
      p = document.createElement('div');
      p.id = 'wpInline';
      p.className = 'wp-inline player-container mb-2';
      p.innerHTML = '<div class="wp-head"><span class="wp-title">共同观影</span>' +
        '<button type="button" class="wp-info-toggle" title="收起房间信息">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>' +
        '</button></div>' +
        '<div class="wp-body"></div>';
      var anchor = document.getElementById('episodesToggleRow');
      if (anchor && anchor.parentElement) anchor.insertAdjacentElement('afterend', p);
      else document.body.appendChild(p);
    }
    if (!$('.wp-body', p)) {
      p.innerHTML = '<div class="wp-head"><span class="wp-title">共同观影</span>' +
        '<button type="button" class="wp-info-toggle" title="收起房间信息">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>' +
        '</button></div><div class="wp-body"></div>';
    }
    // 头部信息折叠按钮（宿主页提供或兜底创建，二选一绑定一次）
    var tgl = $('.wp-info-toggle', p);
    if (tgl && !tgl._wpBound) {
      tgl._wpBound = true;
      tgl.addEventListener('click', toggleInfoCollapse);
    }
    p.hidden = false; // 进入房间视图：无条件恢复常驻显示，功能无需按钮开合
    ui.panel = p;
    ui.cardBody = $('.wp-body', p);
  }

  // 房间信息区折叠/展开：收起后聊天区独占面板（信息区仅是收窄，可随时再展开）
  function toggleInfoCollapse() {
    if (!ui.panel) return;
    var collapsed = ui.panel.classList.toggle('wp-info-collapsed');
    var t = $('.wp-info-toggle', ui.panel);
    if (t) t.title = collapsed ? '展开房间信息' : '收起房间信息';
  }

  // 侧滑抽屉（正常模式）：原版玻璃面板（桌面右侧滑出 / 移动端底部抽屉）
  function ensureDrawer() {
    if (ui.drawer) return;
    var p = document.createElement('div');
    p.className = 'wp-panel';
    p.innerHTML =
      '<div class="wp-head">' +
        '<span class="wp-title">共同观影</span>' +
        '<button type="button" class="wp-close" title="收起面板">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="wp-body"></div>';
    document.body.appendChild(p);
    ui.drawer = p;
    ui.drawerBody = $('.wp-body', p);
    ui.closeBtn = $('.wp-close', p);
    ui.closeBtn.addEventListener('click', closePanel);
  }

  function showDrawer() {
    ensureDrawer();
    ui.open = true;
    ui.drawer.classList.add('open');
  }

  function openPanel() {
    showDrawer();
    ui.unread = 0;
    updateBadge();
    render();
  }

  function closePanel() {
    ui.open = false;
    if (ui.drawer) ui.drawer.classList.remove('open');
  }

  function togglePanel() {
    if (ui.open) closePanel();
    else openPanel();
  }

  // 未读红点：挂在工具栏入口按钮角标（抽屉收起时可见）
  function updateBadge() {
    if (!ui.entryBtn) return;
    var b = $('.wp-badge', ui.entryBtn);
    if (!b) return;
    if (ui.unread > 0) {
      b.textContent = ui.unread > 99 ? '99+' : String(ui.unread);
      b.hidden = false;
    } else {
      b.textContent = '';
      b.hidden = true;
    }
  }

  // 渲染目标切换：切容器时主区/聊天区引用随之失效（renderRoom 内按 contains 判定重建壳）
  function useDrawerBody() {
    ensureDrawer();
    if (ui.body !== ui.drawerBody) { ui.body = ui.drawerBody; ui.main = null; ui.msgs = null; ui.roomSig = ''; }
  }
  function useCardBody() {
    ensurePanel();
    if (ui.body !== ui.cardBody) { ui.body = ui.cardBody; ui.main = null; ui.msgs = null; ui.roomSig = ''; }
  }

  // 观影模式布局切换：connected 后 body.wp-watch-mode 生效（剧集按钮行保留原位、
  // 共同观影 UI 呈现为页面右栏）并收起创建/加入抽屉（功能已由右栏承载，抽屉
  // 若不关闭会残留上一视图——曾致"一直显示房间码+连接中"）；正常观影恢复原版布局
  function applyWatchModeLayout(inRoom) {
    try { document.body.classList.toggle('wp-watch-mode', !!inRoom); } catch (e) { }
    // html 同步类：观影模式（桌面）锁定页面滚动（css html.wp-watch-mode）
    try { document.documentElement.classList.toggle('wp-watch-mode', !!inRoom); } catch (e) { }
    if (inRoom) {
      closePanel(); // 抽屉使命完成（create/join 已成功），关闭防残留旧视图
      // 同步清空抽屉内残留的连接中/旧视图，杜绝任何路径重开抽屉时闪现过期内容
      if (ui.drawerBody && ui.body === ui.drawerBody) ui.drawerBody.innerHTML = '';
    } else {
      if (ui.panel) ui.panel.hidden = true; // 恢复原版界面：隐藏面板
      // 退出观影态：无条件解除纯观看锁定与视频拦截层。错误/断开路径不经过
      // syncLockUI（只在房内渲染时调用），漏清会让页面残留"剧集区隐藏+入口
      // 按钮 hidden"的空壳——观感即"所有界面按钮消失，只剩视频"
      try { document.body.classList.remove('wp-guest-locked'); } catch (e) { }
      try {
        var envL = wp() ? wp().env() : null;
        var aL = envL && typeof envL.getArt === 'function' ? envL.getArt() : null;
        var hostL = aL && (aL.$player || (aL.video && aL.video.closest('.art-video-player')));
        var shieldL = hostL && hostL.querySelector('.wp-guest-shield');
        if (shieldL) shieldL.remove();
      } catch (e) { }
      // 退出观影模式时收起可能开着的剧集弹窗（弹窗仅观影模式下有样式，收起防残留）
      try { if (typeof closeEpisodesModal === 'function') closeEpisodesModal(); } catch (e) { }
    }
  }

  // 总渲染分发：error / idle / connecting → 抽屉（正常模式）；room → 内嵌卡片（观影模式）
  function render() {
    if (!wp()) return;
    var rs = wp().roomState();
    if (!rs.code) ui.restoreWatch = false; // 已彻底退出：恢复标记失效
    // 恢复中（有 code、WS 未连上）同样视为观影态：刷新/后台归来重连期间保持
    // 观影模式布局，避免"先完整渲染普通界面 → 连上后按钮瞬间全部消失"的
    // 两段式跳变（移动端后台归来的主诉之一）
    var inRoom = rs.state === 'connected' || (!!ui.restoreWatch && rs.state === 'connecting');
    applyWatchModeLayout(inRoom);
    if (ui.error) {
      useDrawerBody();
      renderError();
      if (!ui.open) showDrawer(); // 观影中断线等错误：展开抽屉呈现错误信息
      return;
    }
    if (!rs.code) { useDrawerBody(); renderIdle(); }
    else if (rs.state !== 'connected') { useDrawerBody(); renderConnecting(rs); }
    else { useCardBody(); renderRoom(rs); }
  }

  // ============================================================
  // idle 视图（未建房）：登录门禁 → 创建 / 加入
  // ============================================================
  function renderIdle() {
    stopM2Timer();
    var html;
    if (!isLoggedIn()) {
      html = '<div class="wp-idle">' +
        '<p class="wp-hint wp-hint-center">共同观影需要登录后使用</p>' +
        '<button type="button" class="wp-btn wp-btn-primary wp-btn-block" id="wpGoLogin">去首页登录</button>' +
        '<p class="wp-hint wp-hint-center">player 页无账号入口，登录完成后回到本页即可</p>' +
      '</div>';
    } else if (ui.busy) {
      html = '<div class="wp-idle"><p class="wp-hint wp-hint-center">' +
        (ui.busy === 'create' ? '正在创建房间...' : '正在加入房间...') + '</p></div>';
    } else {
      html = '<div class="wp-idle">' +
        '<button type="button" class="wp-btn wp-btn-primary wp-btn-block" id="wpCreate">创建房间</button>' +
        '<div class="wp-divider"><span>或</span></div>' +
        '<div class="wp-join-row">' +
          '<input id="wpJoinInput" class="wp-join-input" type="text" maxlength="6" placeholder="房间码" autocomplete="off" spellcheck="false">' +
          '<button type="button" class="wp-btn wp-btn-primary" id="wpJoin" disabled>加入</button>' +
        '</div>' +
      '</div>';
    }
    ui.body.innerHTML = html;
    var goLogin = $('#wpGoLogin', ui.body);
    if (goLogin) goLogin.addEventListener('click', function () { location.href = '/'; });
    var create = $('#wpCreate', ui.body);
    if (create) create.addEventListener('click', onCreate);
    var input = $('#wpJoinInput', ui.body);
    var join = $('#wpJoin', ui.body);
    if (input && join) {
      if (ui.prefillCode) {
        input.value = ui.prefillCode;
        join.disabled = input.value.length !== 6;
      }
      input.addEventListener('input', function () {
        input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        join.disabled = input.value.length !== 6;
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && input.value.length === 6) onJoin();
      });
      try { input.focus(); } catch (e) { }
    }
    if (join) join.addEventListener('click', onJoin);
  }

  function onCreate() {
    var w = wp();
    if (!w || ui.busy) return;
    ui.busy = 'create';
    render();
    w.createRoom().then(function (d) {
      ui.busy = false;
      resetChat();
      w.connect(d.code, d.roomToken); // joinRoom/createRoom 均不自动连接，由 UI 调 connect
      render();
    }).catch(function (err) {
      ui.busy = false;
      showError((err && err.code) || 'roomError');
    });
  }

  function onJoin() {
    var w = wp();
    var input = $('#wpJoinInput', ui.body);
    if (!w || ui.busy || !input) return;
    var code = input.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) { toast('请输入 6 位房间码'); return; }
    ui.busy = 'join';
    render();
    w.joinRoom(code).then(function (d) {
      ui.busy = false;
      ui.prefillCode = '';
      resetChat();
      w.connect(d.code, d.roomToken);
      render();
    }).catch(function (err) {
      ui.busy = false;
      showError((err && err.code) || 'roomError');
    });
  }

  // ============================================================
  // connecting 视图（已 create/join，WS 未 snap）
  // ============================================================
  function renderConnecting(rs) {
    stopM2Timer();
    ui.body.innerHTML = '<div class="wp-idle">' +
      '<div class="wp-code-row wp-code-row-center"><span class="wp-code">' + esc(rs.code) + '</span></div>' +
      '<p class="wp-hint wp-hint-center">连接中<span class="wp-dots"><i>.</i><i>.</i><i>.</i></span></p>' +
      '<button type="button" class="wp-btn wp-btn-ghost wp-btn-block" id="wpCancel">取消</button>' +
    '</div>';
    $('#wpCancel', ui.body).addEventListener('click', function () {
      wp().leave();
      render();
    });
  }

  // ============================================================
  // room 视图：壳（主区 + 工具行 + 聊天区）只建一次，主区按签名局部重渲染。
  // 排列：房间信息/操作区（可折叠）→ 紧凑工具条（剧集/画布/共享控制/退出）→ 聊天区
  // ============================================================
  // 工具行图标（剧集选单 / 画布 / 共享控制 / 退出房间，紧凑图标条）
  var TOOL_ICONS = {
    episodes: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    canvas: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6"/>',
    leave: '<path d="M15 3h4a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>'
  };
  function toolBtn(icon, title) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + icon + '</svg>';
  }

  // 工具条挂载：与头部「共同观影」标题同一行（wp-title 与折叠按钮之间）。
  // DOM 一次创建、事件一次绑定（_wpHeadBound 防重复）；重进房间复用
  function mountHeadTools() {
    var head = ui.panel ? ui.panel.querySelector('.wp-head') : document.querySelector('#wpInline .wp-head');
    if (!head) return;
    var tools = document.getElementById('wpHeadTools');
    if (!tools) {
      tools = document.createElement('div');
      tools.id = 'wpHeadTools';
      tools.className = 'wp-head-tools';
      tools.innerHTML =
        '<button type="button" class="wp-tool-btn" id="wpEpisodesBtn" title="剧集选单">' +
          toolBtn(TOOL_ICONS.episodes) + '<span>剧集</span></button>' +
        '<label class="wp-tool-btn wp-tool-toggle" id="wpCanvasWrap" title="画布涂鸦：双方可同步绘画">' +
          '<input type="checkbox" id="wpCanvasToggle">' +
          toolBtn(TOOL_ICONS.canvas) + '<span>画布</span></label>' +
        '<label class="wp-tool-btn wp-tool-toggle" id="wpShareWrap" hidden title="开放后对方也可以控制播放与选片">' +
          '<input type="checkbox" id="wpShareToggle">' +
          toolBtn(TOOL_ICONS.share) + '<span>共享</span></label>' +
        '<button type="button" class="wp-tool-btn wp-tool-danger" id="wpLeave" title="退出房间">' +
          toolBtn(TOOL_ICONS.leave) + '<span>退出</span></button>';
      var toggle = head.querySelector('.wp-info-toggle');
      if (toggle) head.insertBefore(tools, toggle);
      else head.appendChild(tools);
      // 事件只绑一次
      var epBtn = $('#wpEpisodesBtn', tools);
      if (epBtn) epBtn.addEventListener('click', function () {
        try { if (typeof toggleEpisodesModal === 'function') toggleEpisodesModal(); } catch (e) { }
      });
      $('#wpCanvasToggle', tools).addEventListener('change', function () {
        setCanvas(this.checked);
      });
      $('#wpShareToggle', tools).addEventListener('change', function () {
        var w = wp();
        if (!w) return;
        if (!w.setShared(this.checked)) {
          this.checked = !this.checked; // 仅房主可切换（服务端强制），失败回填
          toast('仅房主可以切换控制权共享');
        }
      });
      $('#wpLeave', tools).addEventListener('click', onLeave);
    }
    tools.hidden = false;
  }

  function renderRoom(rs) {
    // 壳不存在（首次进房 / 从其他视图切回）时重建，聊天区从 chatLog 回放
    if (!ui.main || !ui.body.contains(ui.main)) {
      stopM2Timer();
      ui.body.innerHTML =
        '<div id="wpMain" class="wp-main"></div>' +
        '<div class="wp-chat">' +
          '<div id="wpMsgs" class="wp-msgs"></div>' +
          '<div class="wp-chat-input-row">' +
            '<input id="wpChatInput" class="wp-chat-input" type="text" maxlength="500" placeholder="说点什么...（回车发送）">' +
            '<button type="button" class="wp-send" id="wpSend">发送</button>' +
          '</div>' +
        '</div>';
      ui.main = $('#wpMain', ui.body);
      ui.msgs = $('#wpMsgs', ui.body);
      $('#wpSend', ui.body).addEventListener('click', sendChatMsg);
      $('#wpChatInput', ui.body).addEventListener('keydown', function (e) {
        if (e.key === 'Enter') sendChatMsg();
      });
      mountHeadTools(); // 工具条挂到头部「共同观影」标题同一行
      ui.roomSig = ''; // 强制主区重渲染
      // 回放既有聊天记录
      for (var i = 0; i < ui.chatLog.length; i++) appendMsgDom(ui.chatLog[i]);
      scrollChat();
    }
    renderMain(rs);
    syncShareUI(rs);
    syncLockUI(rs);
    syncCanvasUI(canvasOn());
    updatePeerHint();
  }

  // 共享控制开关同步：仅房主可见可点；状态随 snap/shared 广播回填（工具条位于面板头部）
  function syncShareUI(rs) {
    var wrap = document.getElementById('wpShareWrap');
    if (wrap) wrap.hidden = rs.role !== 'host';
    var t = document.getElementById('wpShareToggle');
    if (t) {
      if (t.checked !== !!rs.shared) t.checked = !!rs.shared;
      t.disabled = rs.role !== 'host';
      if (wrap) wrap.classList.toggle('on', !!rs.shared);
    }
  }

  // 纯观看锁定：未拥有控制权（未开共享）时禁用播放器控制类 UI——
  // 控制栏（播放按钮/进度条/全部控件）与集数列表置灰不可点，视频区由透明拦截层挡住
  // 单击切播放/双击±15s seek 手势（键盘绕过由 watch-party 的 forceGuestSync 回滚兜底）。
  // 保留共同观影入口、音量与全屏的视觉可见性；共享开启或退出房间即解除。
  // 注意：锁定 class 必须挂 body——集数列表/工具条与播放器容器是平级 DOM，
  // 挂在 .art-video-player 上时后代选择器匹配不到集数区（曾致锁定完全失效）
  function syncLockUI(rs) {
    // 锁定状态先按房间状态无条件计算并落到 body：此前 toggle 挂在 if (host) 内，
    // 播放器尚未就绪（art 缺席）时跳过维护，锁定类会残留到退出/出错之后，
    // 造成剧集区与入口按钮被永久隐藏（页面只剩视频）
    var lock = !!rs && rs.state === 'connected' && !canControl(rs);
    try { document.body.classList.toggle('wp-guest-locked', lock); } catch (e) { }
    try {
      var w = wp();
      var env = w && w.env();
      var a = env && typeof env.getArt === 'function' ? env.getArt() : null;
      var host = a && (a.$player || (a.video && a.video.closest('.art-video-player')));
      if (host) {
        if (lock) {
          // 剧集选单弹窗开着时一并收起（换集由房主控制）
          try { if (typeof closeEpisodesModal === 'function') closeEpisodesModal(); } catch (e) { }
          var shield = host.querySelector('.wp-guest-shield');
          if (!shield) {
            shield = document.createElement('div');
            shield.className = 'wp-guest-shield';
            host.appendChild(shield);
          }
        } else {
          var oldShield = host.querySelector('.wp-guest-shield');
          if (oldShield) oldShield.remove();
        }
      }
    } catch (e) { }
    if (lock !== ui.lockNotified) {
      ui.lockNotified = lock;
      if (lock) toast('观影模式：播放由房主控制，可开启聊天与画布互动');
    }
  }

  // 主区签名：相关字段均不变则跳过重渲染（聊天输入焦点 / 滚动不受影响）
  function renderMain(rs) {
    var cov = covSig(rs);
    var sig = [rs.state, rs.role, rs.shared ? 's' : '', rs.mode, rs.peer && rs.peer.uid, rs.peer && rs.peer.name,
      ui.online, cov, ui.ownM3File ? 'f' : '', ui.ownM3Fp ? 'p' : '', ui.ownM3Checking ? 'c' : ''].join('|');
    if (sig === ui.roomSig) return;
    ui.roomSig = sig;
    var h = topHtml(rs);
    if (ui.cinemaOpen && canControl(rs)) {
      h += cinemaHtml();
      ui.main.innerHTML = h;
      cinemaBind();
      return;
    }
    if (rs.mode === 'M1') h += m1Html(rs);
    else if (rs.mode === 'M2') h += m2Html(rs, rs.role);
    else if (rs.mode === 'M3') h += m3Html(rs, rs.role);
    else h += idleSrcHtml(rs, rs.role);
    ui.main.innerHTML = h;
    bindMain(rs);
    // M1/M2 视图均需轮询刷新缓存进度（自动升级 M2 的进度展示）
    if (rs.mode === 'M1' || rs.mode === 'M2') startM2Timer();
    else stopM2Timer();
  }

  // M2/M1 覆盖率签名（整数值变化才触发重渲染）
  function covSig(rs) {
    if (rs.mode !== 'M1' && rs.mode !== 'M2') return '-';
    var own = ownCoverage();
    var peer = peerReady(rs);
    var ownPct = own && typeof own.percent === 'number' ? Math.round(own.percent) : 'x';
    var peerPct = peer && typeof peer.percent === 'number' ? Math.round(peer.percent)
      : (typeof ui.lastPeerCached === 'number' ? Math.round(ui.lastPeerCached) : 'x');
    return ownPct + '/' + peerPct;
  }

  // 顶区：房间码 + 复制邀请 + 成员气泡 + 状态点 + 角色/模式徽标
  function topHtml(rs) {
    var w = wp();
    var meUid = w.uid();
    var meName = w.name() || '我';
    var hasPeer = rs.peer && rs.peer.uid != null && ui.online > 1;
    var peerName = hasPeer ? (rs.peer.name || '对方') : '等待加入';
    var connCls = rs.state === 'connected' ? 'on' : (rs.state === 'connecting' ? 'mid' : 'off');
    var rttTitle = rs.state === 'connected' && ui.lastRtt != null
      ? 'RTT ' + ui.lastRtt + 'ms' : '未测得';
    return '<div class="wp-top">' +
      '<div class="wp-code-row">' +
        '<span class="wp-code">' + esc(rs.code) + '</span>' +
        '<button type="button" class="wp-btn wp-btn-ghost wp-btn-sm" id="wpCopy">复制邀请</button>' +
      '</div>' +
      '<div class="wp-members">' +
        '<span class="wp-member">' +
          '<span class="wp-avatar" style="background:' + hashColor(meUid) + '">' + esc(firstChar(meName)) + '</span>' +
          '<span class="wp-name">' + esc(meName) + '</span>' +
        '</span>' +
        '<span class="wp-member">' +
          '<span class="wp-avatar" style="background:' + (hasPeer ? hashColor(rs.peer.uid) : 'rgba(155,180,218,0.3)') + '">' +
            (hasPeer ? esc(firstChar(peerName)) : '?') + '</span>' +
          '<span class="wp-name">' + esc(peerName) + '</span>' +
        '</span>' +
        '<span class="wp-dot ' + connCls + '" id="wpDot" title="' + esc(rttTitle) + '"></span>' +
        '<span class="wp-chip">' + (rs.role === 'host' ? '房主' : '观影中') + '</span>' +
        '<span class="wp-chip">' + modeBadge(rs.mode) + '</span>' +
        (rs.shared ? '<span class="wp-chip wp-chip-share" title="控制权共享已开启：双方均可控制播放与选片">共享控制</span>' : '') +
      '</div>' +
      '<div class="wp-peer-hint" id="wpPeerHint"></div>' +
    '</div>';
  }

  function modeBadge(mode) {
    return mode === 'M1' ? 'M1 在线' : mode === 'M2' ? 'M2 缓存' : mode === 'M3' ? 'M3 本地' : '未选片源';
  }

  // 是否拥有控制权（房主恒有；共享开启后所有成员均有）——UI 发起/选片入口的判定
  function canControl(rs) {
    return (rs && (rs.role === 'host' || rs.shared)) || false;
  }

  // 选片入口卡片网格（图标 + 标题 + 副标题，紧凑并排）
  function srcCard(id, icon, title, sub, extraCls) {
    return '<button type="button" class="wp-src-card ' + (extraCls || '') + '" id="' + id + '">' +
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + icon + '</svg>' +
      '<span class="wp-src-card-title">' + title + '</span>' +
      '<span class="wp-src-card-sub">' + sub + '</span>' +
    '</button>';
  }
  var SRC_ICONS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    cinema: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5l5 2.5-5 2.5z"/>',
    file: '<path d="M4 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M11 12.5l3.5 2-3.5 2z"/>',
    play: '<path d="M7 5.5v13l11-6.5z"/>',
    cache: '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>'
  };

  // ---------- idle 无片源：选片三入口（搜索 / 影院 / 本地文件）并排卡片 ----------
  function idleSrcHtml(rs, role) {
    var w = wp();
    var env = w.env();
    var hasVideo = false;
    try { hasVideo = !!(env && typeof env.getVideoKey === 'function' && env.getVideoKey()); } catch (e) { }
    var h = '<div class="wp-sec"><div class="wp-sec-title">发起共看</div>';
    if (canControl(rs)) {
      if (hasVideo) {
        // 已有片源：在线 / 缓存双发起入口并排
        h += '<div class="wp-src-grid wp-src-grid-2">' +
          srcCard('wpStartM1', SRC_ICONS.play, '以此片发起', '在线共看 M1', 'wp-src-primary') +
          srcCard('wpStartM2', SRC_ICONS.cache, '缓存发起', '预缓存 M2', '') +
          '</div>' +
          '<p class="wp-hint wp-hint-center">当前播放的影片将同步给对方</p>';
      } else {
        // 无片源：搜索 / 影院 / 本地文件三入口一行并排
        h += '<div class="wp-src-grid">' +
          srcCard('wpGoSearch', SRC_ICONS.search, '搜索影片', '在线共看', 'wp-src-primary') +
          srcCard('wpPickCinema', SRC_ICONS.cinema, '我的影院', '收藏选片', '') +
          srcCard('wpM3Pick', SRC_ICONS.file, '本地文件', 'M3 共看', '') +
          '</div>' +
          '<p class="wp-hint wp-hint-center">选片后立即开播并自动同步给对方</p>';
      }
    } else {
      h += '<p class="wp-hint">等待房主选片并发起共看，你也可以先选择本地文件</p>' +
        '<div class="wp-src-grid">' +
        srcCard('wpM3Pick', SRC_ICONS.file, '本地文件', 'M3 共看', '') +
        '</div>';
    }
    h += m3Html(rs, role, true);
    h += '</div>';
    return h;
  }

  // ---------- 我的影院选片层：收藏列表 → 集数选择 → 同页播放并自动发起 ----------
  function cinemaHtml() {
    var h = '<div class="wp-sec"><div class="wp-sec-title">从我的影院选择</div>';
    h += '<button type="button" class="wp-btn wp-btn-ghost wp-btn-sm" id="wpCinemaBack">返回</button>';
    if (!ui.cinemaEpFav) {
      var favs = [];
      try { if (typeof getCinemaFavorites === 'function') favs = getCinemaFavorites() || []; } catch (e) { }
      if (!favs.length) {
        h += '<p class="wp-hint wp-hint-center">我的影院还没有收藏<br>可点上方「搜索影片」去首页收藏</p>';
      } else {
        h += '<div class="wp-cinema-list">';
        for (var i = 0; i < favs.length; i++) {
          var f = favs[i];
          var epCount = Array.isArray(f.episodes) ? f.episodes.length : 0;
          var sub = epCount > 0 ? ('共 ' + epCount + ' 集') : '直链影片';
          h += '<button type="button" class="wp-cinema-item" data-k="' + esc(f.key || '') + '">' +
            (f.cover ? '<img class="wp-cinema-cover" src="' + esc(f.cover) + '" alt="">' : '<span class="wp-cinema-cover wp-cinema-cover-ph"></span>') +
            '<span class="wp-cinema-meta"><span class="wp-cinema-title">' + esc(f.title || '未知影片') + '</span>' +
            '<span class="wp-cinema-sub">' + esc(sub) + '</span></span></button>';
        }
        h += '</div>';
      }
    } else {
      var fav = ui.cinemaEpFav;
      var eps = Array.isArray(fav.episodes) ? fav.episodes : [];
      h += '<p class="wp-film-name">' + esc(fav.title || '未知影片') + '</p>';
      if (eps.length) {
        h += '<div class="wp-ep-grid">';
        for (var j = 0; j < eps.length; j++) {
          h += '<button type="button" class="wp-ep-chip" data-i="' + j + '">' + (j + 1) + '</button>';
        }
        h += '</div>';
      } else if (fav.directUrl) {
        h += '<button type="button" class="wp-btn wp-btn-primary wp-btn-block" id="wpCinemaDirect">播放直链并发起共看</button>';
      } else {
        h += '<p class="wp-hint">该收藏没有可播放的地址</p>';
      }
    }
    h += '</div>';
    return h;
  }

  function cinemaBind() {
    var back = $('#wpCinemaBack', ui.main);
    if (back) back.addEventListener('click', function () {
      ui.cinemaOpen = false; ui.cinemaEpFav = null; ui.roomSig = ''; render();
    });
    var items = ui.main.querySelectorAll('.wp-cinema-item');
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener('click', function () {
        var k = this.getAttribute('data-k');
        var favs = (typeof getCinemaFavorites === 'function') ? getCinemaFavorites() : [];
        for (var j = 0; j < favs.length; j++) {
          if (String(favs[j].key) === String(k)) { ui.cinemaEpFav = favs[j]; break; }
        }
        ui.roomSig = ''; render();
      });
    }
    var chips = ui.main.querySelectorAll('.wp-ep-chip');
    for (var c = 0; c < chips.length; c++) {
      chips[c].addEventListener('click', function () {
        playCinemaEp(parseInt(this.getAttribute('data-i'), 10) || 0);
      });
    }
    var direct = $('#wpCinemaDirect', ui.main);
    if (direct) direct.addEventListener('click', function () { playCinemaEp(0); });
  }

  // 选定影片/集数：同页换源播放（保留 room 参数）→ 立即以该片发起共看
  function playCinemaEp(idx) {
    var fav = ui.cinemaEpFav;
    if (!fav) return;
    var url = (Array.isArray(fav.episodes) && fav.episodes[idx]) || fav.directUrl;
    if (!url) { toast('该集没有可播放的地址'); return; }
    var w = wp();
    var played = false;
    try { played = window.WDTVPlayDirect(url, fav.title || '共看影片', idx); } catch (e) { }
    if (!played) { toast('播放器未就绪，请稍后再试'); return; }
    ui.cinemaOpen = false; ui.cinemaEpFav = null;
    setTimeout(function () {
      try {
        if (!w.startCoWatch('M1')) toast('已开始播放，但发起共看失败：请检查连接');
      } catch (e) { }
    }, 0);
  }

  // ============================================================
  // 房间内搜索选片弹窗：复用换源玻璃弹窗 #modal，
  // 搜索各采集源 → 结果网格 → 点选后取详情 → 同页起播并发起 M1 共看
  // ============================================================
  function wpSearchSources() {
    // 复用播放页已选源列表；为空时回退全部内置源
    var keys = [];
    try { keys = (typeof selectedAPIs !== 'undefined' && selectedAPIs) ? selectedAPIs.slice() : []; } catch (e) { }
    if (!keys.length) {
      try { keys = Object.keys(typeof API_SITES !== 'undefined' ? API_SITES : {}); } catch (e) { }
    }
    return keys.filter(function (k) {
      try { return !!(typeof API_SITES !== 'undefined' && API_SITES[k] && !API_SITES[k].disabled); } catch (e) { return false; }
    });
  }

  function openWpSearchModal() {
    var modal = document.getElementById('modal');
    var title = document.getElementById('modalTitle');
    var content = document.getElementById('modalContent');
    if (!modal || !title || !content) { toast('弹窗组件未就绪，请刷新页面'); return; }
    title.textContent = '搜索影片 · 房间内选片';
    content.innerHTML =
      '<div class="wp-search-wrap">' +
        '<div class="wp-url-row">' +
          '<input id="wpSearchInput" class="wp-url-input" type="text" placeholder="输入影视名称，如：东宫" autocomplete="off" spellcheck="false">' +
          '<button type="button" class="wp-btn wp-btn-primary" id="wpSearchGo">搜索</button>' +
        '</div>' +
        '<p class="wp-hint">点选影片后立即在房间内开播，并自动同步给对方（首集）</p>' +
        '<div id="wpSearchResults"><p class="wp-hint wp-hint-center">输入名称开始搜索</p></div>' +
      '</div>';
    modal.classList.remove('hidden');
    var go = document.getElementById('wpSearchGo');
    var input = document.getElementById('wpSearchInput');
    if (go) go.addEventListener('click', doWpSearch);
    if (input) {
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doWpSearch(); });
      try { input.focus(); } catch (e) { }
    }
  }

  function doWpSearch() {
    var input = document.getElementById('wpSearchInput');
    var box = document.getElementById('wpSearchResults');
    var kw = ((input && input.value) || '').trim();
    if (!kw) { toast('请输入影视名称'); return; }
    if (!box) return;
    var sources = wpSearchSources();
    if (!sources.length || typeof searchByAPIAndKeyWord !== 'function') {
      box.innerHTML = '<p class="wp-hint wp-hint-center">没有可用的搜索源，请在首页设置中勾选采集源</p>';
      return;
    }
    box.innerHTML = '<p class="wp-hint wp-hint-center">正在搜索「' + esc(kw) + '」...</p>';
    ui.searchSeq = (ui.searchSeq || 0) + 1; // 竞态防护：仅采纳最后一次搜索结果
    var seq = ui.searchSeq;
    var jobs = sources.map(function (k) {
      return searchByAPIAndKeyWord(k, kw).then(function (list) {
        return { key: k, list: (list || []).slice(0, 6) };
      }).catch(function () { return { key: k, list: [] }; });
    });
    Promise.all(jobs).then(function (groups) {
      if (seq !== ui.searchSeq) return; // 已有更新的搜索，丢弃
      renderSearchResults(groups, kw);
    });
  }

  function renderSearchResults(groups, kw) {
    var box = document.getElementById('wpSearchResults');
    if (!box) return;
    var flat = [];
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i] || {};
      for (var j = 0; j < (g.list || []).length; j++) {
        var it = g.list[j];
        if (!it || !it.vod_id) continue;
        flat.push({
          source: g.key,
          id: String(it.vod_id),
          name: it.vod_name || '未知影片',
          pic: it.vod_pic || '',
          sub: it.source_name || (typeof API_SITES !== 'undefined' && API_SITES[g.key] ? API_SITES[g.key].name : g.key),
          remark: it.vod_remarks || ''
        });
      }
    }
    if (!flat.length) {
      box.innerHTML = '<p class="wp-hint wp-hint-center">未找到与「' + esc(kw) + '」相关的影片，换个关键词试试</p>';
      return;
    }
    var h = '<div class="wp-sr-grid">';
    for (var n = 0; n < flat.length && n < 36; n++) {
      var r = flat[n];
      h += '<button type="button" class="wp-sr-item" data-s="' + esc(r.source) + '" data-i="' + esc(r.id) + '">' +
        '<span class="wp-sr-cover">' +
          (r.pic
            ? '<img src="' + esc(r.pic) + '" alt="" loading="lazy" onerror="this.style.display=\'none\';this.parentNode.classList.add(\'wp-sr-cover-ph\')">'
            : '') +
        '</span>' +
        '<span class="wp-sr-name">' + esc(r.name) + '</span>' +
        '<span class="wp-sr-sub">' + esc(r.sub) + (r.remark ? ' · ' + esc(r.remark) : '') + '</span>' +
      '</button>';
    }
    h += '</div>';
    box.innerHTML = h;
    var items = box.querySelectorAll('.wp-sr-item');
    for (var m = 0; m < items.length; m++) {
      items[m].addEventListener('click', function () {
        pickWpSearchResult(this.getAttribute('data-s'), this.getAttribute('data-i'));
      });
    }
  }

  // 选定搜索结果：拉详情 → 同步剧集列表到播放器 → 同页起播首集 → 发起 M1 共看
  function pickWpSearchResult(sourceCode, vodId) {
    var content = document.getElementById('modalContent');
    if (!content) return;
    content.innerHTML = '<p class="wp-hint wp-hint-center">正在获取影片信息...</p>';
    fetchVideoDetailData({ id: vodId, source: sourceCode }).then(function (data) {
      var eps = data && Array.isArray(data.episodes) ? data.episodes : [];
      if (!eps.length) {
        toast('该影片没有可播放的资源，换一个试试');
        content.innerHTML = '<p class="wp-hint wp-hint-center">该影片没有可播放的资源，请重新选择</p>';
        return;
      }
      // fetchVideoDetailData 返回 { episodes, episodeNames, videoInfo: { title, ... } }
      var name = (data && data.videoInfo && data.videoInfo.title) || '共看影片';
      // 同步播放器剧集上下文：换集弹窗/连播/共看 src 广播（getEpisodes）都依赖这些全局状态
      try {
        if (typeof currentEpisodes !== 'undefined') currentEpisodes = eps;
        if (typeof currentEpisodeNames !== 'undefined') {
          currentEpisodeNames = (Array.isArray(data.episodeNames) && data.episodeNames.length === eps.length)
            ? data.episodeNames : [];
        }
        if (typeof currentSourceCode !== 'undefined') currentSourceCode = sourceCode;
        localStorage.setItem('currentEpisodes', JSON.stringify(eps));
        localStorage.setItem('currentEpisodeNames', JSON.stringify((typeof currentEpisodeNames !== 'undefined') ? currentEpisodeNames : []));
        localStorage.setItem('currentSourceCode', sourceCode);
        localStorage.setItem('lastPlayTime', Date.now());
      } catch (e) { }
      var played = false;
      try { played = window.WDTVPlayDirect(eps[0], name, 0); } catch (e) { }
      try { if (typeof closeModal === 'function') closeModal(); } catch (e) { }
      if (!played) { toast('播放器未就绪，请稍后再试'); return; }
      try { if (typeof renderEpisodes === 'function') renderEpisodes(); } catch (e) { }
      var w = wp();
      setTimeout(function () {
        try {
          if (!w.startCoWatch('M1')) toast('已开始播放，但发起共看失败：请检查连接');
        } catch (e) { }
      }, 0);
    }).catch(function (err) {
      console.error('房间内选片获取详情失败:', err);
      toast('获取影片信息失败，请稍后重试');
      content.innerHTML = '<p class="wp-hint wp-hint-center">获取影片信息失败，请重新选择</p>';
    });
  }

  // ---------- M1：在线共看 ----------
  function m1Html(rs) {
    var w = wp();
    var env = w.env();
    var cur = null;
    try { cur = env && typeof env.getVideoKey === 'function' ? env.getVideoKey() : null; } catch (e) { }
    var roomUrl = ui.lastVideo && ui.lastVideo.url;
    var title = rs.title || (ui.lastVideo && ui.lastVideo.title) || '未知片名';
    var h = '<div class="wp-sec"><div class="wp-sec-title">当前影片（M1 在线共看）</div>' +
      '<p class="wp-film-name">' + esc(title) + '</p>';
    // 双方本地缓存进度：双方 ≥99% 后房主自动无缝切换 M2 缓存模式（零网络流量）
    var own = ownCoverage();
    var peer = peerReady(rs);
    var ownPct = own && typeof own.percent === 'number' ? Math.round(own.percent) : null;
    var peerPct = peer && typeof peer.percent === 'number' ? Math.round(peer.percent)
      : (typeof ui.lastPeerCached === 'number' ? Math.round(ui.lastPeerCached) : null);
    if (ownPct !== null || peerPct !== null) {
      h += '<div class="wp-sec-title">本地缓存进度</div>' + progHtml('我', ownPct) + progHtml('对方', peerPct);
      h += rs.role === 'host'
        ? '<p class="wp-hint">双方缓存完成后将自动切换到缓存播放（M2），抗卡顿零流量</p>'
        : '<p class="wp-hint">双方缓存完成后房主将切换到缓存播放（M2）</p>';
    }
    if (canControl(rs)) {
      h += '<div class="wp-src-grid">' +
        srcCard('wpSearchSwitch', SRC_ICONS.search, '搜索换片', '在线选片', 'wp-src-primary') +
        srcCard('wpSwitchM2', SRC_ICONS.cache, '切换缓存', '预缓存 M2', '') +
        '</div>';
      if (cur && roomUrl && String(cur) !== String(roomUrl)) {
        h += '<button type="button" class="wp-btn wp-btn-primary wp-btn-block" id="wpSwitchM1">更换为当前影片</button>';
      }
      h += '<p class="wp-hint">' + (rs.role === 'host' ? '你的播放、暂停与进度操作将实时同步给对方' : '控制权已共享：你的操作将实时同步给对方') + '</p>';
    } else {
      h += '<p class="wp-hint">正在同步观看对方分享的影片，播放由房主控制</p>';
    }
    h += '</div>';
    return h;
  }

  // ---------- M2：预缓存共看 ----------
  function m2Html(rs, role) {
    var own = ownCoverage();
    var peer = peerReady(rs);
    // mismatch 判定改用基准地址（coverageReport 内以 base 校验，随 ready.mismatch 透出）——
    // currentVideoUrl 会随清晰度探测漂移，不能作为"同一集"的判据
    var mismatch = !!(own && own.mismatch);
    var peerMismatch = !!(peer && peer.mismatch);
    var ownPct = own && typeof own.percent === 'number' ? Math.round(own.percent) : null;
    var peerPct = peer && typeof peer.percent === 'number' ? Math.round(peer.percent)
      : (typeof ui.lastPeerCached === 'number' ? Math.round(ui.lastPeerCached) : null);
    var h = '<div class="wp-sec"><div class="wp-sec-title">缓存就绪度（M2 预缓存共看）</div>';
    h += progHtml('我', ownPct) + progHtml('对方', peerPct);
    if (mismatch || peerMismatch) {
      h += '<p class="wp-err-line">双方不是同一集，无法进入缓存共看（可改用在线模式）</p>';
    }
    if (canControl(rs)) {
      var can = ownPct !== null && peerPct !== null && ownPct >= 99 && peerPct >= 99 && !mismatch && !peerMismatch;
      var reason = '';
      if (!can) {
        if (mismatch || peerMismatch) reason = '';
        else if (peerPct === null) reason = '等待对方上报缓存进度';
        else reason = '缓存未完成：我 ' + (ownPct === null ? '?' : ownPct) + '%，对方 ' + peerPct + '%';
      }
      h += '<button type="button" class="wp-btn wp-btn-primary wp-btn-block" id="wpM2Start"' + (can ? '' : ' disabled') + '>开始同步播放</button>';
      if (reason) h += '<p class="wp-hint">' + esc(reason) + '</p>';
    } else {
      h += '<p class="wp-hint">等待房主开始同步播放</p>';
    }
    h += '</div>';
    return h;
  }

  function progHtml(label, pct) {
    var v = pct === null ? 0 : Math.max(0, Math.min(100, pct));
    return '<div class="wp-prog">' +
      '<div class="wp-prog-label"><span>' + esc(label) + '</span><span>' +
      (pct === null ? '统计中' : v + '%') + '</span></div>' +
      '<div class="wp-prog-bar"><div class="wp-prog-fill" style="width:' + v + '%"></div></div>' +
    '</div>';
  }

  // 本端 M2 覆盖率：读 local 模块缓存的最近一次 coverageReport 快照（同步 getter；
  // 不做 videoKey 比对——currentVideoUrl 会随清晰度探测漂移，快照始终描述"当前正在播的视频"）
  function ownCoverage() {
    try {
      var local = lp();
      if (local && local.lastCoverage && typeof local.lastCoverage.percent === 'number') {
        return local.lastCoverage;
      }
    } catch (e) { }
    return null;
  }

  // 对端就绪信息（readyMap 按对端 uid 取）
  function peerReady(rs) {
    var pk = rs && rs.peer && rs.peer.uid != null ? String(rs.peer.uid) : null;
    if (pk == null || !rs.readyMap) return null;
    return rs.readyMap[pk] || null;
  }

  // ---------- M3：本地文件共看 ----------
  // compact=true（idle 三入口场景）：入口卡片已提供 wpM3Pick，此处只渲染状态与操作
  function m3Html(rs, role, compact) {
    var local = lp();
    var hasLocal = !!(local && typeof local.selectFile === 'function');
    var peer = peerReady(rs);
    var ownFp = ui.ownM3Fp;
    var fpKnown = !!(ownFp && peer && peer.fp);
    var fpOk = fpKnown && String(ownFp) === String(peer.fp);
    var fpBad = fpKnown && !fpOk;
    var h = '<div class="wp-sec"><div class="wp-sec-title">本地文件共看（M3）</div>';
    if (!hasLocal) h += '<p class="wp-hint">本地播放模块未加载，本地共看不可用</p>';
    if (!compact) {
      h += '<button type="button" class="wp-btn wp-btn-ghost wp-btn-block" id="wpM3Pick">' +
        (ui.ownM3File ? '已选：' + esc(ui.ownM3File.name) + '（点击重选）' : '选择本地视频文件') + '</button>';
    } else if (ui.ownM3File) {
      h += '<p class="wp-hint">已选：' + esc(ui.ownM3File.name) + '</p>';
    }
    h += '<p class="wp-hint">' +
      (ui.ownM3Checking ? '指纹校验中...' : (ownFp ? '本端文件已就绪' : '双方需选择同一个本地文件')) + '</p>' +
      (peer && peer.fp ? '<p class="wp-hint">对方文件已就绪' + (peer.name ? '：' + esc(peer.name) : '') + '</p>' : '');
    if (fpOk) h += '<div class="wp-fp ok">文件一致</div>';
    else if (fpBad) h += '<div class="wp-fp bad">双方文件不一致</div>';
    if (rs.mode === 'M3') {
      h += '<button type="button" class="wp-btn wp-btn-ghost wp-btn-block" id="wpM3Exit">退出本地模式</button>';
    } else if (canControl(rs)) {
      var can = !!(hasLocal && ui.ownM3File && ownFp && peer && peer.fp && fpOk);
      h += '<button type="button" class="wp-btn wp-btn-primary wp-btn-block" id="wpM3Start"' + (can ? '' : ' disabled') + '>开始同步播放</button>';
    }
    h += '</div>';
    return h;
  }

  // ---------- 主区事件绑定 ----------
  function bindMain(rs) {
    var copy = $('#wpCopy', ui.main);
    if (copy) copy.addEventListener('click', function () { copyInvite(rs.code); });
    var s1 = $('#wpStartM1', ui.main);
    if (s1) s1.addEventListener('click', function () { doStartCoWatch('M1'); });
    var sw = $('#wpSwitchM1', ui.main);
    if (sw) sw.addEventListener('click', function () { doStartCoWatch('M1'); });
    var s2 = $('#wpStartM2', ui.main);
    if (s2) s2.addEventListener('click', function () { doStartCoWatch('M2'); });
    var sw2 = $('#wpSwitchM2', ui.main);
    if (sw2) sw2.addEventListener('click', function () { doStartCoWatch('M2'); });
    var goSearch = $('#wpGoSearch', ui.main);
    if (goSearch) goSearch.addEventListener('click', function () {
      openWpSearchModal(); // 房间内搜索弹窗选片（不再跳首页）
    });
    var searchSwitch = $('#wpSearchSwitch', ui.main);
    if (searchSwitch) searchSwitch.addEventListener('click', openWpSearchModal);
    var pick = $('#wpPickCinema', ui.main);
    if (pick) pick.addEventListener('click', function () {
      ui.cinemaOpen = true; ui.cinemaEpFav = null; ui.roomSig = ''; render();
    });
    var m2s = $('#wpM2Start', ui.main);
    if (m2s) m2s.addEventListener('click', doHostPlay);
    var pickF = $('#wpM3Pick', ui.main);
    if (pickF) pickF.addEventListener('click', pickFile);
    var m3s = $('#wpM3Start', ui.main);
    if (m3s) m3s.addEventListener('click', doStartM3);
    var m3e = $('#wpM3Exit', ui.main);
    if (m3e) m3e.addEventListener('click', doM3Exit);
  }

  function doStartCoWatch(mode) {
    var w = wp();
    if (!w) return;
    var ok = false;
    try { ok = w.startCoWatch(mode); } catch (e) { }
    if (!ok) toast(mode === 'M2' ? '发起失败：请确认已连接且已开始播放' : '发起失败：请确认已连接且正在播放');
  }

  function doHostPlay() {
    var w = wp();
    if (!w) return;
    try { w.hostPlay(); } catch (e) { }
  }

  function doStartM3() {
    var w = wp();
    if (!w || !ui.ownM3File || !ui.ownM3Fp) return;
    var rs = w.roomState();
    var peer = peerReady(rs);
    if (!peer || !peer.fp || String(peer.fp) !== String(ui.ownM3Fp)) return;
    w.startM3(ui.ownM3File, ui.ownM3Fp).catch(function (err) {
      toast(ERR_TEXT[(err && err.code)] || '本地播放启动失败');
    });
  }

  function doM3Exit() {
    var local = lp();
    if (local && typeof local.m3Exit === 'function') {
      try { local.m3Exit(); } catch (e) { }
    } else {
      toast('本地播放模块未加载');
    }
  }

  // ---------- M3 文件选择（隐藏 input，复用实例） ----------
  function pickFile() {
    if (!ui.fileInput) {
      var fi = document.createElement('input');
      fi.type = 'file';
      fi.accept = 'video/*';
      fi.style.display = 'none';
      document.body.appendChild(fi);
      fi.addEventListener('change', function () {
        var f = fi.files && fi.files[0];
        fi.value = '';
        if (f) onPickM3File(f);
      });
      ui.fileInput = fi;
    }
    ui.fileInput.click();
  }

  function onPickM3File(file) {
    var local = lp();
    ui.ownM3File = file;
    ui.ownM3Fp = null;
    ui.ownM3Checking = false;
    if (!local || typeof local.selectFile !== 'function') {
      // 降级：本地播放模块缺席，仅提示（指纹与 Blob 播放均依赖该模块）
      toast('本地播放模块未加载，无法进行本地共看');
    } else {
      try { local.selectFile(file); } catch (e) { }
      if (typeof local.fileFingerprint === 'function') {
        ui.ownM3Checking = true;
        local.fileFingerprint(file).then(function (fp) {
          ui.ownM3Fp = fp;
          ui.ownM3Checking = false;
          ui.roomSig = '';
          render();
        }).catch(function () {
          ui.ownM3Checking = false;
          ui.roomSig = '';
          render();
        });
      }
    }
    ui.roomSig = '';
    render();
  }

  // ============================================================
  // 错误视图
  // ============================================================
  function showError(code) {
    ui.error = code;
    try { if (wp()) wp().leave(); } catch (e) { } // 错误即断开：清理半连接状态与本地凭证
    stopM2Timer();
    hideCanvasBar();
    render();
  }

  function renderError() {
    var code = ui.error;
    var text = ERR_TEXT[code] || (ERR_TEXT.unknown + '（' + String(code) + '）');
    var extra = code === 'sync_unconfigured'
      ? '<p class="wp-hint wp-hint-center">部署指引：在 sync-worker 目录执行 npx wrangler deploy 并重新部署 Pages</p>'
      : '';
    ui.body.innerHTML = '<div class="wp-idle">' +
      '<p class="wp-err-line">' + esc(text) + '</p>' + extra +
      '<button type="button" class="wp-btn wp-btn-ghost wp-btn-block" id="wpErrBack">返回</button>' +
    '</div>';
    $('#wpErrBack', ui.body).addEventListener('click', function () {
      ui.error = null;
      render();
    });
  }

  // ============================================================
  // 退出房间
  // ============================================================
  function onLeave() {
    var w = wp();
    if (w) { try { w.leave(); } catch (e) { } }
    // 解除纯观看锁定
    try { document.body.classList.remove('wp-guest-locked'); } catch (e) { }
    try {
      var env = w && w.env();
      var a = env && typeof env.getArt === 'function' ? env.getArt() : null;
      var host = a && (a.$player || (a.video && a.video.closest('.art-video-player')));
      if (host) host.classList.remove('wp-guest-locked');
      var oldShield = host && host.querySelector('.wp-guest-shield');
      if (oldShield) oldShield.remove();
    } catch (e) { }
    resetChat();
    ui.lastVideo = null;
    ui.online = 0;
    ui.lastPeerCached = null;
    ui.ownM3File = null;
    ui.ownM3Fp = null;
    ui.ownM3Checking = false;
    ui.cinemaOpen = false;
    ui.cinemaEpFav = null;
    ui.roomSig = '';
    stopM2Timer();
    hideCanvasBar();
    render();
  }

  // ============================================================
  // 聊天：本地乐观渲染 + seq 去重 + 系统行
  // ============================================================
  function resetChat() {
    ui.chatLog = [];
    ui.seenSeq = {};
    ui.unread = 0;
    updateBadge();
    if (ui.msgs && ui.body && ui.body.contains(ui.msgs)) ui.msgs.innerHTML = '';
  }

  function sendChatMsg() {
    var input = $('#wpChatInput', ui.body);
    if (!input) return;
    var text = input.value.trim().slice(0, 500);
    if (!text) return;
    var w = wp();
    var ok = false;
    try { ok = w.sendChat(text); } catch (e) { }
    if (!ok) { toast('发送失败：未加入房间'); return; }
    // 服务端不回显本人消息（闸3）：本地乐观渲染，重连历史回放时按文本匹配合并
    var item = { uid: w.uid(), name: w.name() || '我', kind: 'user', text: text, t: Date.now(), optimistic: true, matched: false };
    ui.chatLog.push(item);
    appendMsgDom(item);
    scrollChat();
    input.value = '';
  }

  function onChatMsg(m) {
    if (!m || typeof m.text !== 'string') return;
    var w = wp();
    var myUid = w ? w.uid() : null;
    if (m.seq !== undefined && m.seq !== null) {
      if (ui.seenSeq[m.seq]) return;
      ui.seenSeq[m.seq] = true;
    }
    var mine = myUid != null && m.uid !== undefined && String(m.uid) === String(myUid);
    if (mine && m.kind !== 'system') {
      // 本人消息只会来自历史回放：与乐观渲染的同文本消息合并，避免重复
      for (var i = 0; i < ui.chatLog.length; i++) {
        var it = ui.chatLog[i];
        if (it.optimistic && !it.matched && it.text === m.text) {
          it.matched = true;
          it.seq = m.seq;
          if (m.t) it.t = m.t;
          return;
        }
      }
    }
    var item = { uid: m.uid, name: m.name, kind: m.kind === 'system' ? 'system' : 'user', text: m.text, t: m.t };
    ui.chatLog.push(item);
    appendMsgDom(item);
    scrollChat();
    // 抽屉收起（正常模式）时累计未读；观影模式聊天常驻内嵌面板，无需未读
    if (!ui.open && !document.body.classList.contains('wp-watch-mode') && !mine && item.kind === 'user') {
      ui.unread++;
      updateBadge();
    }
  }

  // 本地系统行（加入/离开，presence 事件驱动；服务端系统消息走 chat kind=system）
  function pushSystem(text) {
    var item = { kind: 'system-local', text: text, t: Date.now() };
    ui.chatLog.push(item);
    appendMsgDom(item);
    scrollChat();
  }

  function msgHtml(m) {
    if (m.kind === 'system' || m.kind === 'system-local') {
      return '<div class="wp-msg wp-msg-sys"><span>' + esc(m.text) + '</span></div>';
    }
    var w = wp();
    var mine = w && w.uid() != null && m.uid !== undefined && String(m.uid) === String(w.uid());
    var name = m.name || (mine ? '我' : '对方');
    return '<div class="wp-msg ' + (mine ? 'me' : 'peer') + '">' +
      '<span class="wp-mavatar" style="background:' + hashColor(m.uid) + '">' + esc(firstChar(name)) + '</span>' +
      '<div class="wp-msg-col">' +
        '<span class="wp-msg-meta">' + esc(name) + ' ' + esc(fmtTime(m.ts || m.t)) + '</span>' +
        '<div class="wp-bubble">' + esc(m.text) + '</div>' +
      '</div>' +
    '</div>';
  }

  function appendMsgDom(m) {
    if (!ui.msgs || !ui.body || !ui.body.contains(ui.msgs)) return; // 壳未建：仅存 chatLog，稍后回放
    var d = document.createElement('div');
    d.innerHTML = msgHtml(m);
    if (d.firstChild) ui.msgs.appendChild(d.firstChild);
  }

  function scrollChat() {
    if (ui.msgs && ui.body && ui.body.contains(ui.msgs)) {
      ui.msgs.scrollTop = ui.msgs.scrollHeight;
    }
  }

  // ============================================================
  // 复制邀请链接（clipboard + execCommand 兜底）
  // ============================================================
  function copyInvite(code) {
    var link = location.origin + '/player.html?room=' + encodeURIComponent(code);
    var done = function () { toast('邀请链接已复制'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done, function () { fallbackCopy(link, done); });
    } else {
      fallbackCopy(link, done);
    }
  }

  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) {
      toast('复制失败，请手动复制：' + text);
    }
  }

  // ============================================================
  // 共享画布工具条（player 容器内浮动，底部居中，控制栏上方）
  // ============================================================
  function canvasOn() {
    var w = wp();
    try { return !!(w && w.canvas && w.canvas.isEnabled()); } catch (e) { return false; }
  }

  function ensureCanvasBar() {
    if (ui.cbar) return;
    var bar = document.createElement('div');
    bar.className = 'wp-canvas-bar';
    var h = '';
    for (var i = 0; i < CANVAS_COLORS.length; i++) {
      h += '<span class="wp-canvas-dot" data-c="' + CANVAS_COLORS[i] + '" style="background:' + CANVAS_COLORS[i] + '"></span>';
    }
    h += '<span class="wp-canvas-sep"></span>';
    for (var j = 0; j < CANVAS_SIZES.length; j++) {
      var d = CANVAS_SIZES[j] + 4; // 视觉直径：6/8/11
      h += '<span class="wp-canvas-size" data-w="' + CANVAS_SIZES[j] + '" style="width:' + d + 'px;height:' + d + 'px"></span>';
    }
    h += '<span class="wp-canvas-sep"></span>' +
      '<button type="button" class="wp-canvas-btn" data-act="erase" title="橡皮擦">' +
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20H9L4.5 15.5a2 2 0 0 1 0-2.8l8.2-8.2a2 2 0 0 1 2.8 0l5 5a2 2 0 0 1 0 2.8L14 19"/><path d="M8.5 11.5l5 5"/></svg>' +
        '<span>擦</span>' +
      '</button>' +
      '<button type="button" class="wp-canvas-btn" data-act="undo">撤销</button>' +
      '<button type="button" class="wp-canvas-btn" data-act="clear">清空</button>' +
      '<button type="button" class="wp-canvas-btn" data-act="close">关闭</button>';
    bar.innerHTML = h;
    bar.addEventListener('click', function (e) {
      var t = e.target;
      var w = wp();
      if (!w || !w.canvas) return;
      var dot = t.closest ? t.closest('.wp-canvas-dot') : null;
      if (dot) {
        ui.cColor = dot.getAttribute('data-c');
        try { w.canvas.setColor(ui.cColor); w.canvas.setMode('draw'); } catch (err) { }
        markCanvasActive();
        return;
      }
      var size = t.closest ? t.closest('.wp-canvas-size') : null;
      if (size) {
        ui.cWidth = Number(size.getAttribute('data-w')) || 4;
        try { w.canvas.setWidth(ui.cWidth); } catch (err) { }
        markCanvasActive();
        return;
      }
      var btn = t.closest ? t.closest('.wp-canvas-btn') : null;
      if (btn) {
        var act = btn.getAttribute('data-act');
        if (act === 'erase') {
          // 橡皮与画笔互斥：再点一次切回画笔
          var toErase = w.canvas.getMode() !== 'erase';
          try { w.canvas.setMode(toErase ? 'erase' : 'draw'); } catch (err) { }
          markCanvasActive();
        }
        else if (act === 'undo') { try { w.canvas.undo(); } catch (err) { } }
        else if (act === 'clear') { try { w.canvas.clear(); } catch (err) { } }
        else if (act === 'close') { setCanvas(false); }
      }
    });
    document.body.appendChild(bar);
    ui.cbar = bar;
    if (ui.cColor === undefined) ui.cColor = CANVAS_COLORS[0];
    if (ui.cWidth === undefined) ui.cWidth = 4;
    try { wp().canvas.setColor(ui.cColor); wp().canvas.setWidth(ui.cWidth); } catch (e) { }
    markCanvasActive();
  }

  // 工具条选中态：颜色/粗细高亮 + 橡皮激活态（橡皮模式时颜色点半透明）
  function markCanvasActive() {
    if (!ui.cbar) return;
    var w = wp();
    var mode = '';
    try { mode = w && w.canvas ? w.canvas.getMode() : 'draw'; } catch (e) { }
    var dots = ui.cbar.querySelectorAll('.wp-canvas-dot');
    for (var i = 0; i < dots.length; i++) {
      var isCur = mode !== 'erase' && dots[i].getAttribute('data-c') === ui.cColor;
      dots[i].classList.toggle('active', isCur);
      dots[i].style.opacity = mode === 'erase' ? '0.35' : '';
    }
    var sizes = ui.cbar.querySelectorAll('.wp-canvas-size');
    for (var j = 0; j < sizes.length; j++) {
      sizes[j].classList.toggle('active', Number(sizes[j].getAttribute('data-w')) === ui.cWidth);
    }
    var eraser = ui.cbar.querySelector('[data-act="erase"]');
    if (eraser) eraser.classList.toggle('active', mode === 'erase');
  }

  // 挂载进播放器容器（随全屏移动）；播放器未就绪则退化为 body 固定定位
  function mountCanvasBar() {
    if (!ui.cbar) return;
    var host = null;
    try {
      var env = wp().env();
      var a = env && typeof env.getArt === 'function' ? env.getArt() : null;
      host = a && (a.$player || (a.video && a.video.closest('.art-video-player'))) || null;
    } catch (e) { host = null; }
    if (host && ui.cbar.parentElement !== host) {
      host.appendChild(ui.cbar);
      ui.cbar.classList.remove('wp-canvas-bar--fixed');
    } else if (!host && ui.cbar.parentElement !== document.body) {
      document.body.appendChild(ui.cbar);
      ui.cbar.classList.add('wp-canvas-bar--fixed');
    }
  }

  function setCanvas(on) {
    var w = wp();
    if (!w || !w.canvas) return;
    try { w.canvas.setEnabled(on); } catch (e) { }
    syncCanvasUI(canvasOn()); // 以实际状态回填开关（播放器未就绪时内部会提示）
  }

  function syncCanvasUI(on) {
    var t = document.getElementById('wpCanvasToggle');
    if (t && t.checked !== on) t.checked = on;
    var wrap = t ? t.closest('.wp-tool-toggle') : null;
    if (wrap) wrap.classList.toggle('on', !!on);
    if (on) {
      ensureCanvasBar();
      mountCanvasBar();
      if (ui.cbar) ui.cbar.classList.add('show');
    } else {
      hideCanvasBar();
    }
  }

  function hideCanvasBar() {
    if (ui.cbar) ui.cbar.classList.remove('show');
  }

  // ============================================================
  // 动态小更新（不整块重渲染）：状态点 / 对端缓冲提示 / M2 轮询
  // ============================================================
  function updateDot() {
    var d = document.getElementById('wpDot');
    if (!d) return;
    var w = wp();
    if (!w) return;
    var rs = w.roomState();
    var cls = rs.state === 'connected' ? 'on' : (rs.state === 'connecting' ? 'mid' : 'off');
    d.className = 'wp-dot ' + cls;
    d.title = rs.state === 'connected' && ui.lastRtt != null ? 'RTT ' + ui.lastRtt + 'ms' : '未测得';
  }

  function updatePeerHint() {
    var el = document.getElementById('wpPeerHint');
    if (!el) return;
    var w = wp();
    var buf = w ? (w.roomState().peer || {}).buf : null;
    el.textContent = typeof buf === 'number' ? '对方缓冲 ' + Math.round(buf) + 's' : '';
  }

  function startM2Timer() {
    if (ui.m2Timer) return;
    ui.m2Timer = setInterval(function () {
      var w = wp();
      if (!w) return;
      var mode = w.roomState().mode;
      if (mode !== 'M1' && mode !== 'M2') { stopM2Timer(); return; }
      ui.roomSig = ''; // 覆盖率变化时由签名比对触发重渲染
      render();
    }, 3000);
  }

  function stopM2Timer() {
    if (ui.m2Timer) {
      clearInterval(ui.m2Timer);
      ui.m2Timer = 0;
    }
  }

  // ============================================================
  // 事件订阅（WatchParty.on）
  // ============================================================
  function bindEvents() {
    var w = wp();
    if (!w) return;
    w.on('status', function (s) {
      if (s && typeof s.rtt === 'number') ui.lastRtt = s.rtt;
      updateDot();
    });
    w.on('snap', function (p) {
      if (p && p.state && p.state.url) {
        ui.lastVideo = { mode: p.state.mode || null, url: p.state.url, title: p.state.title || null };
      }
      if (p && Array.isArray(p.online)) ui.online = p.online.length;
      ui.roomSig = '';
      render();
    });
    w.on('presence', function (m) {
      if (m && Array.isArray(m.online)) ui.online = m.online.length;
      var myUid = w.uid();
      if (m && m.join && myUid != null && String(m.join.uid) !== String(myUid)) {
        pushSystem((m.join.name || '对方') + ' 加入了房间');
      }
      if (m && m.leave && myUid != null && String(m.leave.uid) !== String(myUid)) {
        pushSystem((m.leave.name || '对方') + ' 离开了房间');
      }
      ui.roomSig = '';
      render();
    });
    w.on('chat', onChatMsg);
    w.on('ready', function () { ui.roomSig = ''; render(); });
    w.on('src', function (p) {
      if (p && p.video) ui.lastVideo = p.video;
      ui.roomSig = '';
      render();
    });
    w.on('role', function () { ui.roomSig = ''; render(); });
    w.on('shared', function (p) { if (p && p.by !== undefined) pushSystem(p.on ? '房主开放了控制权：双方均可控制播放与选片' : '房主收回了控制权'); ui.roomSig = ''; render(); });
    w.on('applySrc', onApplySrc);
    w.on('toast', function (p) { if (p && p.text) toast(p.text); });
    w.on('slowpeer', function () { toast('对方网络较慢，播放可能不同步'); });
    w.on('peerpos', updatePeerHint);
    w.on('peerbuf', function (m) {
      if (m && typeof m.cached === 'number') ui.lastPeerCached = m.cached;
      updatePeerHint();
    });
    w.on('error', function (p) { showError((p && p.code) || 'unknown'); });
  }

  // 观影方换片源整页跳转：本地模块在场时由其 applySrcRedirect 负责，否则 UI 兜底
  function onApplySrc(p) {
    var v = p && p.video;
    if (!v || !v.url) return;
    if (lp()) return;
    // 防循环：URL 已携带同一片源（刚跳回、player 初始化中）→ 不再跳转
    try {
      var cur = new URLSearchParams(location.search).get('url');
      if (cur && (cur === v.url || decodeURIComponent(cur) === v.url)) return;
    } catch (e) { }
    // 集数列表预写 localStorage（跳转后 player 重建剧集栏，共享控制下对方换集可用）
    if (v.episodes && v.episodes.length) {
      try { localStorage.setItem('currentEpisodes', JSON.stringify(v.episodes)); } catch (e) { }
    }
    var code = '';
    try { code = wp().roomState().code || ''; } catch (e) { }
    location.href = '/player.html?url=' + encodeURIComponent(v.url) +
      '&index=' + encodeURIComponent(v.epIndex || 0) +
      (v.title ? '&title=' + encodeURIComponent(v.title) : '') +
      (code ? '&room=' + encodeURIComponent(code) : '');
  }

  // ============================================================
  // URL ?room= 接入：有本地 token 直接重连，否则展开 idle 加入流程（预填码）
  // ============================================================
  function initFromUrl() {
    var code = '';
    try {
      var m = /[?&]room=([A-Za-z0-9]+)/.exec(location.search);
      code = m ? m[1].toUpperCase() : '';
    } catch (e) { }
    if (!/^[A-Z0-9]{6}$/.test(code)) return;
    ui.prefillCode = code;
    var w = wp();
    if (!w) return;
    var token = null;
    try { token = localStorage.getItem('wdtvWatchToken:' + code); } catch (e) { }
    if (token) {
      resetChat();
      w.setAutoSrc(true); // 房主 URL ?room= 选片归来：视频就绪后自动发起共看（guest 角色内部自动拦截）
      w.connect(code, token);
      // 刷新/后台归来恢复：立刻进入观影模式布局，占位"恢复连接"提示——
      // 消除"先完整渲染普通界面 → 连上后剧集区/页脚/入口瞬间全部消失"的
      // 两段式闪变；连接成功后 renderRoom 会用真实房间 UI 覆盖占位，
      // 恢复失败由 showError 收回普通布局并展开抽屉显示错误
      ui.restoreWatch = true;
      try {
        document.body.classList.add('wp-watch-mode');
        document.documentElement.classList.add('wp-watch-mode');
      } catch (e) { }
      try {
        var pel = document.getElementById('wpInline');
        if (pel) {
          pel.hidden = false;
          var pb = pel.querySelector('.wp-body');
          if (pb) {
            pb.innerHTML = '<p class="wp-hint wp-hint-center">正在恢复房间连接...</p>' +
              '<button type="button" class="wp-btn wp-btn-ghost wp-btn-block" id="wpRestoreCancel">取消恢复</button>';
            var cbtn = document.getElementById('wpRestoreCancel');
            if (cbtn) cbtn.addEventListener('click', function () {
              try { if (wp()) wp().leave(); } catch (e) { }
              render();
            });
          }
        }
      } catch (e) { }
    }
    // 展开抽屉：无 token 显示加入流程（房间码已预填）。
    // 嘉宾点击「加入」按钮会产生手势激活——这是浏览器 autoplay 放行的前提
    // （自动加入会让嘉宾全程无手势，播放被策略静默拒绝）。有 token 时不再展开：
    // 观影模式布局已占位，恢复成功直接呈现房间 UI，失败由错误视图自动展开抽屉
    if (!token) openPanel();
  }

  // ============================================================
  // 全局入口：player.js 触点 5 调用（幂等）。正常模式在剧集工具栏挂
  // 「共同观影」入口按钮（点击开合抽屉）；观影模式下按钮由 CSS 隐藏
  // ============================================================
  function setupWatchPartyButton() {
    var bar = document.getElementById('playerEpisodesBar');
    if (!bar || bar.querySelector('.wp-entry-btn')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wp-entry-btn';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="2" y="4" width="20" height="13" rx="2"/>' +
        '<path d="M8 21h8M12 17v4"/>' +
        '<circle cx="9" cy="10.5" r="1.8"/>' +
        '<path d="M14.5 9a2.2 2.2 0 0 1 0 3"/>' +
      '</svg>' +
      '<span>共同观影</span>' +
      '<span class="wp-badge" hidden></span>';
    btn.addEventListener('click', togglePanel);
    var anchor = document.getElementById('cinemaFavChip');
    if (anchor && anchor.parentElement === bar) anchor.insertAdjacentElement('afterend', btn);
    else bar.insertBefore(btn, bar.firstChild);
    ui.entryBtn = btn;
  }

  // ============================================================
  // 启动：订阅事件 + URL 恢复 + 入口按钮兜底挂载（player.js 未调用时保证可用）
  // ============================================================
  bindEvents();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setupWatchPartyButton();
      initFromUrl();
    });
  } else {
    setupWatchPartyButton();
    initFromUrl();
  }

  // 供 player.js 触点 5 调用
  window.setupWatchPartyButton = setupWatchPartyButton;
})();
