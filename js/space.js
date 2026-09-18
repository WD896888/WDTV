/* ================================================================
   WDTV 观影空间 Hub（index.html page-space 第三页）
   - 双人共同观影入口：创建房间 / 加入房间 / 最近房间
   - 依赖：js/ui.js 的 showToast、js/cloud-sync.js 的 CloudSync.getStatus
   - 服务端：POST /api/room/create、POST /api/room/join（JWT 鉴权）
   ================================================================ */
(function () {
  'use strict';

  // ========================= 常量 =========================
  var TOKEN_KEY = 'wdtv_auth_token';            // 登录 JWT（与 cloud-sync.js 一致）
  var RECENT_KEY = 'wdtvWatchRecent';           // 最近房间列表（≤5 条 [{code,title,ts}]）
  var ROOM_TOKEN_PREFIX = 'wdtvWatchToken:';    // 房间作用域凭证键前缀：'wdtvWatchToken:'+code
  var ROOM_CODE_RE = /^[A-Z0-9]{6}$/;           // 房间码格式：6 位大写字母/数字
  var COUNTDOWN_SECONDS = 3;                    // 创建成功后自动进入房间的倒计时

  // DOM 引用（init 时获取）
  var el = {};

  // 倒计时句柄（点任何按钮可取消）
  var countdownTimer = null;
  var countdownLeft = 0;

  // ========================= 小工具 =========================

  function $(id) {
    return document.getElementById(id);
  }

  // toast 提示（ui.js 提供 showToast(message, type)，type: success/error/info）
  function toast(text, type) {
    try {
      if (typeof window.showToast === 'function') window.showToast(text, type || 'info');
    } catch (e) { /* toast 失败不影响主流程 */ }
  }

  // 是否已登录（复用 CloudSync 会话状态）
  function isLoggedIn() {
    try {
      return !!(window.CloudSync && window.CloudSync.getStatus && window.CloudSync.getStatus().loggedIn);
    } catch (e) {
      return false;
    }
  }

  // 未登录引导：弹出账号菜单（登录面板在菜单中），不发任何请求
  function guideLogin() {
    var btn = document.getElementById('account-btn');
    if (btn) {
      try { btn.click(); } catch (e) { /* 忽略点击异常 */ }
    }
    toast('请先登录后再使用观影空间', 'error');
  }

  // 统一请求头（JWT）
  function authHeaders(extra) {
    var headers = { 'Content-Type': 'application/json' };
    var token = null;
    try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* 隐私模式等 */ }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) headers[k] = extra[k];
      }
    }
    return headers;
  }

  // 相对时间：刚刚 / n 分钟前 / n 小时前 / n 天前 / 具体日期
  function relativeTime(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前';
    try {
      return new Date(ts).toLocaleDateString('zh-CN');
    } catch (e) {
      return '';
    }
  }

  // ========================= 最近房间 =========================

  function loadRecent() {
    try {
      var raw = localStorage.getItem(RECENT_KEY);
      var list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return [];
      return list.filter(function (it) {
        return it && typeof it.code === 'string' && ROOM_CODE_RE.test(it.code);
      });
    } catch (e) {
      return [];
    }
  }

  function saveRecent(list) {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5)));
    } catch (e) { /* 写入失败忽略 */ }
  }

  // 新增/置顶最近房间（同码去重，最多 5 条）
  function touchRecent(code, title) {
    var list = loadRecent().filter(function (it) { return it.code !== code; });
    list.unshift({ code: code, title: title || null, ts: Date.now() });
    saveRecent(list);
    renderRecent();
  }

  // 从最近列表移除指定房间码（join 404 房间已过期时调用）
  function removeRecent(code) {
    var list = loadRecent().filter(function (it) { return it.code !== code; });
    saveRecent(list);
    renderRecent();
  }

  // 渲染最近房间列表；为空时隐藏容器
  function renderRecent() {
    if (!el.recentWrap || !el.recentList) return;
    var list = loadRecent();
    if (!list.length) {
      el.recentWrap.hidden = true;
      el.recentList.innerHTML = '';
      return;
    }
    el.recentList.innerHTML = '';
    list.forEach(function (item) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wdtv-hub-recent-item';
      btn.setAttribute('data-code', item.code);

      var codeEl = document.createElement('span');
      codeEl.className = 'wdtv-hub-recent-code';
      codeEl.textContent = item.code;

      var titleEl = document.createElement('span');
      titleEl.className = 'wdtv-hub-recent-name';
      titleEl.textContent = item.title || '未命名影片';
      titleEl.title = item.title || '未命名影片';

      var timeEl = document.createElement('span');
      timeEl.className = 'wdtv-hub-recent-time';
      timeEl.textContent = relativeTime(item.ts);

      btn.appendChild(codeEl);
      btn.appendChild(titleEl);
      btn.appendChild(timeEl);
      btn.addEventListener('click', function () {
        join(item.code);
      });
      el.recentList.appendChild(btn);
    });
    el.recentWrap.hidden = false;
  }

  // ========================= 倒计时 =========================

  // 清除倒计时（点任何 hub 内按钮或离开时调用）
  function clearCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    countdownLeft = 0;
    if (el.countdown) el.countdown.textContent = '';
  }

  // 3 秒倒计时自动跳转 player.html?room=code
  function startCountdown(code) {
    clearCountdown();
    countdownLeft = COUNTDOWN_SECONDS;
    var render = function () {
      if (!el.countdown) return;
      el.countdown.textContent = countdownLeft + ' 秒后自动进入房间…';
    };
    render();
    countdownTimer = setInterval(function () {
      countdownLeft -= 1;
      if (countdownLeft <= 0) {
        clearCountdown();
        window.location.href = 'player.html?room=' + encodeURIComponent(code);
        return;
      }
      render();
    }, 1000);
  }

  // ========================= 创建房间 =========================

  function create() {
    // 登录门禁：未登录直接引导，不发请求
    if (!isLoggedIn()) {
      guideLogin();
      return;
    }
    if (el.createBtn) el.createBtn.disabled = true;
    fetch('/api/room/create', {
      method: 'POST',
      headers: authHeaders()
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data };
      });
    }).then(function (r) {
      if (r.status === 200 && r.data && r.data.code && r.data.roomToken) {
        onCreated(r.data.code, r.data.roomToken);
      } else if (r.status === 401) {
        guideLogin();
      } else if (r.status === 503) {
        toast('实时服务未部署：请先在 sync-worker/ 目录执行 npx wrangler deploy 并配置 AUTH_SECRET（见该目录 wrangler.toml 注释）', 'error');
      } else {
        toast('网络异常，请稍后再试', 'error');
      }
    }).catch(function () {
      toast('网络异常，请稍后再试', 'error');
    }).finally(function () {
      if (el.createBtn) el.createBtn.disabled = false;
    });
  }

  // 创建成功：存凭证 → 记最近 → 展示结果区（房间码 + 邀请链接复制 + 倒计时）
  function onCreated(code, roomToken) {
    try {
      localStorage.setItem(ROOM_TOKEN_PREFIX + code, roomToken);
    } catch (e) { /* 写入失败忽略 */ }
    touchRecent(code, null);

    if (el.roomCode) el.roomCode.textContent = code;
    if (el.createResult) el.createResult.hidden = false;
    startCountdown(code);
    toast('房间已创建', 'success');
  }

  // ========================= 加入房间 =========================

  function join(rawCode) {
    // 登录门禁：未登录直接引导，不发请求
    if (!isLoggedIn()) {
      guideLogin();
      return;
    }
    var code = String(rawCode == null ? '' : rawCode).trim().toUpperCase();
    if (!ROOM_CODE_RE.test(code)) {
      toast('请输入 6 位房间码（字母或数字）', 'error');
      return;
    }
    clearCountdown();
    if (el.joinBtn) el.joinBtn.disabled = true;
    fetch('/api/room/join', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ code: code })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data };
      });
    }).then(function (r) {
      if (r.status === 200 && r.data && r.data.roomToken) {
        try {
          localStorage.setItem(ROOM_TOKEN_PREFIX + code, r.data.roomToken);
        } catch (e) { /* 写入失败忽略 */ }
        // join 响应携带 title 时更新最近房间片名
        touchRecent(code, r.data.title || null);
        window.location.href = 'player.html?room=' + encodeURIComponent(code);
      } else if (r.status === 401) {
        guideLogin();
      } else if (r.status === 400 || r.status === 404) {
        toast('房间不存在或已过期', 'error');
        removeRecent(code);
      } else if (r.status === 409) {
        toast('房间已满（双人房最多 2 人）', 'error');
      } else if (r.status === 503) {
        toast('实时服务未部署：请先在 sync-worker/ 目录执行 npx wrangler deploy 并配置 AUTH_SECRET（见该目录 wrangler.toml 注释）', 'error');
      } else {
        toast('网络异常，请稍后再试', 'error');
      }
    }).catch(function () {
      toast('网络异常，请稍后再试', 'error');
    }).finally(function () {
      if (el.joinBtn) el.joinBtn.disabled = false;
    });
  }

  // ========================= 复制邀请链接 =========================

  function inviteLink(code) {
    return window.location.origin + '/player.html?room=' + encodeURIComponent(code);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () {
        return fallbackCopy(text);
      });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  // 兜底：隐藏 textarea + execCommand（非 https / 旧浏览器）
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function copyInvite() {
    var code = el.roomCode ? el.roomCode.textContent.trim() : '';
    if (!code) return;
    // 点复制即取消倒计时
    clearCountdown();
    copyText(inviteLink(code)).then(function (ok) {
      if (ok) {
        toast('邀请链接已复制，发给对方即可一起看', 'success');
      } else {
        toast('复制失败，请手动复制：' + inviteLink(code), 'error');
      }
    });
  }

  // ========================= 事件绑定 =========================

  function bindEvents() {
    if (el.createBtn) {
      el.createBtn.addEventListener('click', function () {
        clearCountdown();
        create();
      });
    }
    if (el.joinBtn) {
      el.joinBtn.addEventListener('click', function () {
        join(el.joinInput ? el.joinInput.value : '');
      });
    }
    if (el.joinInput) {
      // 输入过滤为大写字母/数字（自动大写显示）
      el.joinInput.addEventListener('input', function () {
        var pos = el.joinInput.selectionEnd;
        el.joinInput.value = el.joinInput.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        try { el.joinInput.setSelectionRange(pos, pos); } catch (e) { /* 忽略 */ }
      });
      // 回车触发加入
      el.joinInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          join(el.joinInput.value);
        }
      });
    }
    if (el.copyBtn) el.copyBtn.addEventListener('click', copyInvite);
    if (el.enterBtn) {
      el.enterBtn.addEventListener('click', function () {
        var code = el.roomCode ? el.roomCode.textContent.trim() : '';
        if (!code) return;
        clearCountdown();
        window.location.href = 'player.html?room=' + encodeURIComponent(code);
      });
    }
  }

  // ========================= 初始化 =========================

  function init() {
    // 共同观影模式导航提示：/index.html?room=CODE 进入即选片场景
    // （从共看面板"搜索影片"跳转而来；选片播放后 playVideo 会透传 room 自动回流房间）
    try {
      var roomParam = new URLSearchParams(window.location.search).get('room');
      if (roomParam && ROOM_CODE_RE.test(String(roomParam).toUpperCase())) {
        setTimeout(function () {
          toast('共同观影模式：选好影片播放后将自动回到房间同步', 'info');
        }, 900);
      }
    } catch (e) { /* 忽略解析异常 */ }

    el = {
      hub: document.querySelector('.wdtv-space-hub'),
      createBtn: $('wpCreateBtn'),
      joinInput: $('wpJoinCode'),
      joinBtn: $('wpJoinBtn'),
      createResult: $('wpCreateResult'),
      roomCode: $('wpRoomCode'),
      copyBtn: $('wpCopyInvite'),
      enterBtn: $('wpEnterRoom'),
      countdown: $('wpCountdown'),
      recentWrap: $('wpRecentWrap'),
      recentList: $('wpRecentList')
    };
    if (!el.hub) return; // 非 index 页或结构缺失，静默退出
    bindEvents();
    renderRecent();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
