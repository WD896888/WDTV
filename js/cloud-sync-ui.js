/*
 * 右上角账号区 UI（零依赖）
 * 依赖契约：window.CloudSync（见 js/cloud-sync.js）
 * 结构（index.html）：#account-btn 药丸（头像+昵称）→ #accountMenu 下拉菜单
 *   - #accountCardBody：本文件动态渲染（账号卡片 + 登录/注册表单 + 立即同步行）
 *   - #downloads-btn / #accountMenuSettings / #accountMenuLogout：静态菜单项
 *     （下载管理点击绑定在 index-page.js；设置项代理 toggleSettings；退出项由本文件管理）
 * 样式：账号区玻璃样式在 css/index.css；本文件不再注入样式。
 */
(function () {
    'use strict';

    // 内部 UI 状态（与 CloudSync 的 status 分离，仅保存表单/交互态）
    var state = {
        menuOpen: false,           // 下拉菜单是否展开
        tab: 'login',              // 未登录表单当前 Tab：login | register
        submitting: false,         // 登录/注册提交中
        error: '',                 // 表单错误信息（来自 CloudSync 抛出的中文 Error）
        usernameDraft: '',         // 保留用户名输入，避免状态刷新时丢失
        registerAllowed: null,     // null = 未知；由 isRegisterAllowed() 异步获取
        regAllowedFetching: false,
        editingNick: false,        // 是否处于昵称行内编辑态
        nickDraft: '',
        avatarDataUrl: null,       // 已拉取的头像 dataURL
        avatarFetchingFor: null,   // 正在/已经拉取头像的版本号，防止重复请求
        processingAvatar: false,   // 头像读取/压缩/上传中
        logoutArmed: false,        // 退出登录二次确认（行内确认，不用 confirm()）
        logoutTimer: null
    };

    /* ============================ 工具函数 ============================ */

    // HTML 转义，防止用户名/昵称等内容注入
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // 小眼睛图标：visible=false 为闭眼（密码态），true 为睁眼（明文态）
    function eyeIconHtml(visible) {
        var eyePath = 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z';
        var pupil = '<circle cx="12" cy="12" r="3"/>';
        if (visible) {
            return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
                + '<path d="' + eyePath + '"/>' + pupil + '</svg>';
        }
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="' + eyePath + '"/>' + pupil + '<line x1="4" y1="4" x2="20" y2="20"/></svg>';
    }

    // 人形占位图标（未登录头像）
    function personIconHtml(cls) {
        return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    }

    // 相机角标（换头像提示）
    function camIconHtml() {
        return '<span class="wdtv-am-cam"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></span>';
    }

    // 铅笔图标（编辑昵称）
    function pencilIconHtml() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
    }

    // 同步图标（立即同步行）
    function syncIconHtml() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">'
            + '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>'
            + '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
    }

    // 统一提示：优先使用全局 showToast（ui.js），不存在时降级 console.warn
    function toast(msg, type) {
        if (typeof window.showToast === 'function') {
            try { window.showToast(msg, type); return; } catch (e) { /* 落到 console */ }
        }
        console.warn('[cloud-sync-ui]', msg);
    }

    // 安全读取 CloudSync 状态
    function safeGetStatus() {
        try { return window.CloudSync.getStatus() || {}; } catch (e) { return {}; }
    }

    // 取昵称/用户名首字作为头像占位
    function firstLetter(s) {
        var str = String(s || '').trim();
        if (!str) return '客';
        return str.charAt(0).toUpperCase();
    }

    // 相对时间：上次同步距今
    function relativeTime(ts) {
        var t = Number(ts);
        if (!isFinite(t) || t <= 0) return '';
        if (t < 1e12) t *= 1000; // 兼容秒级时间戳
        var diff = Date.now() - t;
        if (diff < 0) diff = 0;
        var min = Math.floor(diff / 60000);
        if (min < 1) return '刚刚';
        if (min < 60) return min + ' 分钟前';
        var hour = Math.floor(min / 60);
        if (hour < 24) return hour + ' 小时前';
        return Math.floor(hour / 24) + ' 天前';
    }

    // DOMContentLoaded 后执行；若文档已就绪则立即执行
    function ready(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn);
        } else {
            fn();
        }
    }

    /* ============================ 菜单开合 ============================ */

    function getMenu() { return document.getElementById('accountMenu'); }
    function getBtn() { return document.getElementById('account-btn'); }

    function openMenu() {
        var menu = getMenu();
        if (!menu || state.menuOpen) return;
        // 打开账号菜单时收起其它已展开面板，避免叠层遮挡
        var sp = document.getElementById('settingsPanel');
        if (sp) sp.classList.remove('show');
        var hp = document.getElementById('historyPanel');
        if (hp) hp.classList.remove('show');
        state.menuOpen = true;
        menu.classList.add('open');
        var btn = getBtn();
        if (btn) btn.setAttribute('aria-expanded', 'true');
    }

    function closeMenu() {
        var menu = getMenu();
        if (!menu || !state.menuOpen) return;
        state.menuOpen = false;
        menu.classList.remove('open');
        var btn = getBtn();
        if (btn) btn.setAttribute('aria-expanded', 'false');
        // 收起退出确认态
        if (state.logoutArmed) {
            state.logoutArmed = false;
            if (state.logoutTimer) { clearTimeout(state.logoutTimer); state.logoutTimer = null; }
            syncLogoutBtn();
        }
    }

    function toggleMenu(e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        if (state.menuOpen) closeMenu(); else openMenu();
    }

    // 静态菜单项（下载管理/设置/退出登录）事件绑定
    function bindMenuChrome() {
        var btn = getBtn();
        if (btn) btn.addEventListener('click', toggleMenu);

        // 点击菜单与按钮以外区域关闭。
        // 用 pointerdown（按下阶段）而非 click：菜单内 Tab 切换/提交校验/昵称编辑等
        // 会在 click 处理中同步重渲染 DOM，节点脱离文档后 contains(e.target) 会把
        // "菜单内点击"误判为外部点击导致菜单闪关；pointerdown 发生在重渲染之前，判定可靠
        document.addEventListener('pointerdown', function (e) {
            if (!state.menuOpen) return;
            var menu = getMenu();
            if (menu && (menu.contains(e.target) || (btn && btn.contains(e.target)))) return;
            closeMenu();
        });

        // Escape 关闭
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && state.menuOpen) closeMenu();
        });

        // 下载管理项：关闭菜单（打开管理器的逻辑绑定在 index-page.js）
        var dlItem = document.getElementById('downloads-btn');
        if (dlItem) {
            dlItem.addEventListener('click', function () { closeMenu(); });
        }

        // 设置项：关闭菜单并打开设置侧栏
        var settingsItem = document.getElementById('accountMenuSettings');
        if (settingsItem) {
            settingsItem.addEventListener('click', function (e) {
                closeMenu();
                if (typeof window.toggleSettings === 'function') window.toggleSettings(e);
            });
        }

        // 退出登录项（静态节点，文本与显隐由渲染驱动）
        var logoutItem = document.getElementById('accountMenuLogout');
        if (logoutItem) logoutItem.addEventListener('click', onLogout);
    }

    // 同步退出登录按钮文案（行内二次确认）
    function syncLogoutBtn() {
        var logoutItem = document.getElementById('accountMenuLogout');
        if (!logoutItem) return;
        var textEl = logoutItem.querySelector('.wdtv-am-item-text');
        if (textEl) textEl.textContent = state.logoutArmed ? '确认退出？' : '退出登录';
    }

    /* ============================ 渲染 ============================ */

    // 渲染入口：药丸 + 卡片。输入中（表单获得焦点）不整块重绘，避免打断输入
    function render(status, force) {
        if (!status) status = safeGetStatus();
        if (!force) {
            var ae = document.activeElement;
            if (ae && (ae.id === 'wdtvAmUser' || ae.id === 'wdtvAmPass' || ae.id === 'wdtvAmNickInput')) return;
        }
        try {
            renderPill(status);
            renderCard(status);
        } catch (e) {
            // 渲染异常不影响其他功能
            console.warn('[cloud-sync-ui] 渲染失败', e);
        }
    }

    /* ---------- 顶部药丸：头像 + 昵称 ---------- */

    function pillAvatarHtml(status) {
        if (status.loggedIn && state.avatarDataUrl) {
            return '<img src="' + esc(state.avatarDataUrl) + '" alt="">';
        }
        if (status.loggedIn) {
            return '<span class="wdtv-ab-ph">' + esc(firstLetter(status.nickname || status.username)) + '</span>';
        }
        return personIconHtml('');
    }

    function renderPill(status) {
        var nameEl = document.getElementById('wdtvAcctPillName');
        var avEl = document.getElementById('wdtvAcctPillAvatar');
        if (!nameEl || !avEl) return;
        if (status.loggedIn) {
            nameEl.textContent = status.nickname || status.username || '用户';
        } else {
            nameEl.textContent = '未登录';
        }
        avEl.innerHTML = pillAvatarHtml(status);
    }

    /* ---------- 卡片：已登录（头像/昵称/同步状态 + 立即同步行） ---------- */

    function cardAvatarInnerHtml(firstChar) {
        if (state.avatarDataUrl) {
            return '<img src="' + esc(state.avatarDataUrl) + '" alt="头像">';
        }
        return '<span class="wdtv-am-ph">' + esc(firstChar) + '</span>';
    }

    function statusLineHtml(status) {
        var syncing = !!status.syncing;
        var text;
        var cls = 'wdtv-am-status';
        if (syncing) {
            text = '同步中…';
            cls += ' wdtv-am-syncing';
        } else if (status.lastError) {
            text = '同步失败：' + status.lastError;
            cls += ' err';
        } else if (status.lastSyncAt) {
            text = '上次同步：' + relativeTime(status.lastSyncAt);
        } else {
            text = '等待首次同步';
        }
        return '<div class="' + cls + '"><span class="wdtv-am-status-dot"></span><span>' + esc(text) + '</span></div>';
    }

    function renderCardLoggedIn(body, status) {
        var displayName = status.nickname || status.username || '用户';
        var syncing = !!status.syncing;
        var busy = state.processingAvatar;

        var html = '';
        html += '<div class="wdtv-am-card">'
            + '<div class="wdtv-am-card-top">'
            + '<button type="button" class="wdtv-am-avatar-btn" id="wdtvAmAvatarBtn" title="更换头像"'
            + (busy ? ' disabled' : '') + '>'
            + cardAvatarInnerHtml(firstLetter(status.nickname || status.username))
            + camIconHtml()
            + '</button>'
            + '<div class="wdtv-am-userinfo">'
            + '<div class="wdtv-am-nick-row">'
            + '<span class="wdtv-am-nick">' + esc(displayName) + '</span>'
            + (state.editingNick ? '' : '<button type="button" class="wdtv-am-nick-edit-btn" id="wdtvAmNickEditBtn" title="编辑昵称">' + pencilIconHtml() + '</button>')
            + '</div>'
            + '<div class="wdtv-am-username">@' + esc(status.username || '') + '</div>'
            + '</div>'
            + '</div>';

        // 昵称行内编辑
        if (state.editingNick) {
            html += '<div class="wdtv-am-nick-edit">'
                + '<input id="wdtvAmNickInput" type="text" maxlength="20" placeholder="昵称（最多 20 字）" value="' + esc(state.nickDraft) + '">'
                + '<button type="button" class="wdtv-am-mini-btn" id="wdtvAmNickSaveBtn"' + (busy ? ' disabled' : '') + '>保存</button>'
                + '<button type="button" class="wdtv-am-mini-btn ghost" id="wdtvAmNickCancelBtn">取消</button>'
                + '</div>';
        }

        html += statusLineHtml(status);
        html += '</div>';

        // 立即同步行
        html += '<button type="button" class="wdtv-am-item" id="wdtvAmSyncRow"'
            + (syncing || busy ? ' disabled' : '') + '>'
            + syncIconHtml()
            + '<span class="wdtv-am-item-text">' + (syncing ? '同步中…' : '立即同步') + '</span>'
            + '</button>';

        // 隐藏的头像选择控件
        html += '<input type="file" id="wdtvAmAvatarFile" accept="image/*" class="wdtv-acct-hidden">';

        body.innerHTML = html;

        // 事件绑定
        function bind(id, fn) {
            var el = body.querySelector('#' + id);
            if (el) el.addEventListener('click', fn);
        }
        bind('wdtvAmNickEditBtn', function () {
            state.editingNick = true;
            state.nickDraft = status.nickname || '';
            render(null, true);
        });
        bind('wdtvAmNickCancelBtn', function () {
            state.editingNick = false;
            render(null, true);
        });
        bind('wdtvAmNickSaveBtn', saveNickname);
        bind('wdtvAmAvatarBtn', function () {
            var f = body.querySelector('#wdtvAmAvatarFile');
            if (f) f.click();
        });
        bind('wdtvAmSyncRow', onSyncNow);

        var nickInput = body.querySelector('#wdtvAmNickInput');
        if (nickInput) {
            nickInput.addEventListener('input', function () { state.nickDraft = this.value; });
            nickInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); saveNickname(); }
            });
        }
        var fileInput = body.querySelector('#wdtvAmAvatarFile');
        if (fileInput) {
            fileInput.addEventListener('change', function () {
                onAvatarFileSelected(this.files && this.files[0]);
            });
        }
    }

    /* ---------- 卡片：未登录（访客卡片 + 登录/注册表单） ---------- */

    function renderCardLoggedOut(body) {
        var allowReg = state.registerAllowed;
        if (allowReg === false && state.tab === 'register') state.tab = 'login';
        var isReg = state.tab === 'register' && allowReg !== false;

        var html = '';
        // 访客卡片
        html += '<div class="wdtv-am-card">'
            + '<div class="wdtv-am-card-top">'
            + '<span class="wdtv-am-avatar-btn wdtv-am-static">' + personIconHtml('wdtv-am-ph-icon') + '</span>'
            + '<div class="wdtv-am-userinfo">'
            + '<div class="wdtv-am-nick-row"><span class="wdtv-am-nick">未登录</span></div>'
            + '<div class="wdtv-am-username">登录后观影数据跨设备同步</div>'
            + '</div>'
            + '</div>'
            + '</div>';

        // 登录 / 注册表单
        html += '<div class="wdtv-am-form">';
        if (allowReg !== false) {
            html += '<div class="wdtv-am-tabs">'
                + '<button type="button" class="wdtv-am-tab' + (state.tab === 'login' ? ' active' : '') + '" data-tab="login">登录</button>'
                + '<button type="button" class="wdtv-am-tab' + (state.tab === 'register' ? ' active' : '') + '" data-tab="register">注册</button>'
                + '</div>';
        }
        html += '<form id="wdtvAmForm">'
            + '<input class="wdtv-am-input" id="wdtvAmUser" type="text" autocomplete="username" placeholder="用户名" value="' + esc(state.usernameDraft) + '">'
            + '<div class="wdtv-am-passwrap">'
            + '<input class="wdtv-am-input" id="wdtvAmPass" type="password" autocomplete="' + (isReg ? 'new-password' : 'current-password') + '" placeholder="密码">'
            + '<button type="button" class="wdtv-am-eye" id="wdtvAmEye" tabindex="-1" title="显示/隐藏密码" aria-label="显示或隐藏密码">' + eyeIconHtml(false) + '</button>'
            + '</div>'
            + '<div class="wdtv-am-pass-hint">密码框已自动屏蔽中文输入法，请直接用键盘英文输入</div>'
            + '<button type="submit" class="wdtv-am-submit" id="wdtvAmSubmit"' + (state.submitting ? ' disabled' : '') + '>'
            + (state.submitting ? '请稍候…' : (isReg ? '注 册' : '登 录'))
            + '</button>'
            + '</form>';
        if (state.error) {
            html += '<div class="wdtv-am-error">' + esc(state.error) + '</div>';
        }
        html += '<div class="wdtv-am-tip">登录后观影记录、进度与收藏自动跨设备同步</div>';
        html += '</div>';

        body.innerHTML = html;

        // Tab 切换
        var tabs = body.querySelectorAll('.wdtv-am-tab');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].addEventListener('click', function () {
                var tab = this.getAttribute('data-tab');
                if (state.tab === tab) return;
                state.tab = tab;
                state.error = '';
                render(null, true);
            });
        }

        // 保留用户名草稿
        var userInput = body.querySelector('#wdtvAmUser');
        if (userInput) {
            userInput.addEventListener('input', function () { state.usernameDraft = this.value; });
        }

        // 密码明文切换：就地切换 type 与图标，不整块重渲染，避免丢失已输入内容
        var eyeBtn = body.querySelector('#wdtvAmEye');
        var passInput = body.querySelector('#wdtvAmPass');
        if (eyeBtn && passInput) {
            eyeBtn.addEventListener('click', function () {
                var show = passInput.type === 'password';
                passInput.type = show ? 'text' : 'password';
                eyeBtn.innerHTML = eyeIconHtml(show);
                eyeBtn.title = show ? '隐藏密码' : '显示密码';
                passInput.focus();
            });
        }

        // 表单提交（回车也可触发）
        var form = body.querySelector('#wdtvAmForm');
        if (form) form.addEventListener('submit', onSubmitAuth);

        // 异步探测是否允许开放注册（仅探测一次）
        if (allowReg === null && !state.regAllowedFetching) {
            state.regAllowedFetching = true;
            Promise.resolve()
                .then(function () { return window.CloudSync.isRegisterAllowed(); })
                .then(function (v) { state.registerAllowed = v !== false; })
                .catch(function () { state.registerAllowed = true; })
                .then(function () {
                    state.regAllowedFetching = false;
                    var st = safeGetStatus();
                    if (!st.loggedIn) render(st); // 已登录则交由 onChange 驱动
                });
        }
    }

    function renderCard(status) {
        var body = document.getElementById('accountCardBody');
        if (!body) return;
        // 退出登录按钮：登录态显示，未登录隐藏
        var logoutItem = document.getElementById('accountMenuLogout');
        if (logoutItem) {
            if (status.loggedIn) logoutItem.classList.remove('hidden');
            else logoutItem.classList.add('hidden');
        }
        syncLogoutBtn();
        if (status.loggedIn) renderCardLoggedIn(body, status);
        else renderCardLoggedOut(body);
    }

    function onSubmitAuth(e) {
        e.preventDefault();
        if (state.submitting) return;
        var body = document.getElementById('accountCardBody');
        var userInput = body ? body.querySelector('#wdtvAmUser') : null;
        var passInput = body ? body.querySelector('#wdtvAmPass') : null;
        var u = userInput ? userInput.value.trim() : '';
        var p = passInput ? passInput.value : '';
        if (!u || !p) {
            state.error = '请输入用户名和密码';
            render(null, true);
            return;
        }
        state.submitting = true;
        state.error = '';
        state.usernameDraft = u;
        var isReg = state.tab === 'register' && state.registerAllowed !== false;

        // 按钮立即进入加载态，不等待重渲染
        var btn = body ? body.querySelector('#wdtvAmSubmit') : null;
        if (btn) { btn.disabled = true; btn.textContent = '请稍候…'; }

        var action;
        try {
            action = isReg ? window.CloudSync.register(u, p) : window.CloudSync.login(u, p);
        } catch (err) {
            state.submitting = false;
            state.error = err && err.message ? err.message : '操作失败，请稍后再试';
            render(null, true);
            return;
        }
        Promise.resolve().then(function () { return action; }).then(function () {
            state.submitting = false;
            state.usernameDraft = '';
            render(null, true); // 登录成功；onChange 也会驱动重渲染
        }).catch(function (err) {
            state.submitting = false;
            state.error = err && err.message ? err.message : '操作失败，请稍后再试';
            render(null, true);
        });
    }

    /* ---------- 已登录操作：昵称 / 同步 / 退出 ---------- */

    function saveNickname() {
        var val = String(state.nickDraft || '').trim();
        if (!val) { toast('昵称不能为空'); return; }
        if (val.length > 20) { toast('昵称不能超过 20 个字符'); return; }
        var btn = document.querySelector('#wdtvAmNickSaveBtn');
        if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
        Promise.resolve()
            .then(function () { return window.CloudSync.updateNickname(val); })
            .then(function () {
                state.editingNick = false;
                toast('昵称已更新', 'success');
                render(null, true);
            })
            .catch(function (err) {
                if (btn) { btn.disabled = false; btn.textContent = '保存'; }
                toast(err && err.message ? err.message : '昵称更新失败');
            });
    }

    function onSyncNow() {
        var btn = document.querySelector('#wdtvAmSyncRow');
        if (btn) { btn.disabled = true; btn.querySelector('.wdtv-am-item-text').textContent = '同步中…'; }
        Promise.resolve()
            .then(function () { return window.CloudSync.syncNow(); })
            .then(function () {
                toast('同步完成', 'success');
                render(null, true);
            })
            .catch(function (err) {
                render(null, true); // 状态行会展示失败原因
                toast(err && err.message ? err.message : '同步失败');
            });
    }

    // 退出登录：行内二次确认，3 秒内再次点击才执行
    function onLogout() {
        if (!state.logoutArmed) {
            state.logoutArmed = true;
            if (state.logoutTimer) clearTimeout(state.logoutTimer);
            state.logoutTimer = setTimeout(function () {
                state.logoutArmed = false;
                state.logoutTimer = null;
                syncLogoutBtn();
            }, 3000);
            syncLogoutBtn();
            return;
        }
        if (state.logoutTimer) { clearTimeout(state.logoutTimer); state.logoutTimer = null; }
        state.logoutArmed = false;
        try {
            window.CloudSync.logout();
            state.avatarDataUrl = null;
            state.avatarFetchingFor = null;
            state.editingNick = false;
            toast('已退出登录', 'success');
            render(null, true); // onChange 也会触发重渲染
        } catch (e) {
            toast(e && e.message ? e.message : '退出失败');
        }
    }

    /* ---------- 头像：拉取与压缩上传 ---------- */

    // 按版本号拉取头像；同版本只请求一次
    function refreshAvatar(status) {
        var version = status && typeof status.avatarVersion === 'number' ? status.avatarVersion : 0;
        if (state.avatarFetchingFor === version) return;
        state.avatarFetchingFor = version;
        Promise.resolve()
            .then(function () { return window.CloudSync.getAvatarDataUrl(); })
            .then(function (res) {
                state.avatarDataUrl = res && res.dataUrl ? res.dataUrl : null;
                updateAvatarNodes();
            })
            .catch(function () {
                // 拉取失败保持占位符，不影响其他功能
            });
    }

    // 就地更新药丸与卡片两处头像节点，避免整块重渲染打断输入
    function updateAvatarNodes() {
        var status = safeGetStatus();
        var pillAv = document.getElementById('wdtvAcctPillAvatar');
        if (pillAv) pillAv.innerHTML = pillAvatarHtml(status);
        var cardBtn = document.getElementById('wdtvAmAvatarBtn');
        if (cardBtn) {
            cardBtn.innerHTML = cardAvatarInnerHtml(firstLetter(status.nickname || status.username)) + camIconHtml();
        } else {
            render();
        }
    }

    function readAsDataUrl(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result)); };
            reader.onerror = function () { reject(new Error('读取图片失败')); };
            reader.readAsDataURL(file);
        });
    }

    function loadImage(src) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () { resolve(img); };
            img.onerror = function () { reject(new Error('图片解析失败')); };
            img.src = src;
        });
    }

    // 中心裁剪正方形并缩放
    function drawSquare(img, size) {
        var canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext('2d');
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        var side = Math.min(w, h);
        if (!side) throw new Error('图片解析失败');
        ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
        return canvas;
    }

    // 压缩：256px 起，质量 0.85/0.7/0.55 依次降低；仍超 200KB 则缩到 192px 重试
    function compressAvatar(img) {
        var MAX_LEN = 273000; // 约 200KB 的 base64 字符长度
        var sizes = [256, 192];
        var qualities = [0.85, 0.7, 0.55];
        var last = '';
        for (var s = 0; s < sizes.length; s++) {
            var canvas = drawSquare(img, sizes[s]);
            for (var q = 0; q < qualities.length; q++) {
                var url = canvas.toDataURL('image/jpeg', qualities[q]);
                last = url;
                if (url.length <= MAX_LEN) return url;
            }
        }
        return last; // 兜底：192px 最低质量
    }

    function onAvatarFileSelected(file) {
        var input = document.getElementById('wdtvAmAvatarFile');
        if (input) input.value = ''; // 允许重复选择同一文件
        if (!file) return;
        if (file.type && file.type.indexOf('image/') !== 0) {
            toast('请选择图片文件');
            return;
        }
        state.processingAvatar = true;
        render(null, true); // 按钮进入禁用态
        Promise.resolve()
            .then(function () { return readAsDataUrl(file); })
            .then(function (dataUrl) { return loadImage(dataUrl); })
            .then(function (img) { return compressAvatar(img); })
            .then(function (compressed) { return window.CloudSync.uploadAvatarDataUrl(compressed); })
            .then(function (newVersion) {
                state.processingAvatar = false;
                state.avatarDataUrl = null;
                state.avatarFetchingFor = null;
                toast('头像已更新', 'success');
                render(null, true);
                refreshAvatar({ avatarVersion: typeof newVersion === 'number' ? newVersion : 0 });
            })
            .catch(function (err) {
                state.processingAvatar = false;
                render(null, true);
                toast(err && err.message ? err.message : '头像更新失败');
            });
    }

    /* ============================ 初始化 ============================ */

    function onSyncChange(status) {
        try {
            if (status && status.loggedIn) refreshAvatar(status);
            render(status);
        } catch (e) {
            // 忽略单次渲染异常，不影响同步
        }
    }

    function init() {
        try {
            // 播放页等无账号菜单的页面直接跳过
            if (!document.getElementById('accountMenu')) return;
            if (!window.CloudSync || typeof window.CloudSync.onChange !== 'function') {
                console.warn('[cloud-sync-ui] CloudSync 未就绪，跳过账号区初始化');
                return;
            }
            bindMenuChrome();
            window.CloudSync.onChange(onSyncChange);
            var status = safeGetStatus();
            render(status, true);
            if (status.loggedIn) refreshAvatar(status);
        } catch (e) {
            console.warn('[cloud-sync-ui] 初始化失败', e);
        }
    }

    ready(init);
})();
