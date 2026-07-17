// 高级前端（Premium UI）引擎：Dock 顶栏放大、课程卡 3D 倾斜/全息、Recent 卡堆轮换。
// React Bits 的 Dock / ProfileCard / CardSwap 三个组件的 vanilla 移植（本站无构建、无框架）。
// 视觉规则全部在 premium.css，由 <html data-ui="premium"> 门控；本文件负责 DOM 重组与动效。
// 「界面风格」偏好存 localStorage(nb-ui-level)，切换后刷新生效（首屏内联脚本先行设 data-ui）。

(function () {
  'use strict';

  var KEY = 'nb-ui-level';
  var level = (function () {
    try { return localStorage.getItem(KEY) === 'classic' ? 'classic' : 'premium'; }
    catch (e) { return 'premium'; }
  })();

  // ---------- 设置里的「界面风格」分段控件（两种模式都要能切） ----------
  function wireLevelSetting() {
    document.querySelectorAll('[data-ui-set]').forEach(function (btn) {
      var on = btn.getAttribute('data-ui-set') === level;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.addEventListener('click', function () {
        var next = btn.getAttribute('data-ui-set');
        if (next === level) return;
        try { localStorage.setItem(KEY, next); } catch (e) {}
        location.reload();
      });
    });
  }

  var canHover = matchMedia('(hover: hover) and (pointer: fine)').matches;
  var reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Dock 顶栏（React Bits <Dock/> 移植） ----------
  var TAB_ICONS = { learn: 'bookopen', explore: 'compass', play: 'trophy', all: 'stack' };

  function buildDock() {
    var topbar = document.querySelector('.topbar');
    var right = document.querySelector('.topbar-right');
    if (!topbar || !right || !window.NBIcon) return null;

    topbar.classList.add('dockbar');
    var panel = document.createElement('div');
    panel.className = 'dock-panel';
    panel.style.position = 'relative';
    panel.setAttribute('role', 'toolbar');
    panel.setAttribute('aria-label', 'Dock');

    // 分类 proxy 瓦片：点击转发给隐藏的 .home-tabs 原按钮，分类状态仍由 app.js 管
    var tabsBar = document.getElementById('home-tabs');
    if (tabsBar) {
      tabsBar.querySelectorAll('.tab').forEach(function (tab) {
        var t = tab.dataset.tab;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dock-item dock-tab';
        btn.dataset.tab = t;
        btn.setAttribute('data-label', tab.textContent.trim());
        btn.innerHTML = NBIcon(TAB_ICONS[t] || 'stack', { size: 20 });
        btn.addEventListener('click', function () { tab.click(); });
        panel.appendChild(btn);
      });
      var sep = document.createElement('span');
      sep.className = 'dock-sep';
      panel.appendChild(sep);

      // 激活态跟随原 tab 的 class 变化（含 app.js 启动时恢复上次分类）
      var syncTabs = function () {
        tabsBar.querySelectorAll('.tab').forEach(function (tab) {
          var mine = panel.querySelector('.dock-tab[data-tab="' + tab.dataset.tab + '"]');
          if (!mine) return;
          mine.classList.toggle('active', tab.classList.contains('active'));
          mine.classList.toggle('drop-target', tab.classList.contains('drop-target'));
        });
      };
      new MutationObserver(syncTabs).observe(tabsBar, { attributes: true, subtree: true, attributeFilter: ['class'] });
      syncTabs();
    }

    // 原顶栏控件搬进 dock，事件监听随节点保留
    var moves = [
      [document.querySelector('.search-wrap'), '搜索'],
      [document.getElementById('omni-btn'), 'Ask AI'],
      [document.querySelector('.create-wrap'), '创建'],
      [document.querySelector('.settings-wrap'), '设置'],
    ];
    moves.forEach(function (m) {
      var el = m[0];
      if (!el) return;
      el.classList.add('dock-item');
      el.setAttribute('data-label', m[1]);
      panel.appendChild(el);
    });

    topbar.appendChild(panel);

    // 下拉菜单挂到 body：玻璃面板的 backdrop-filter 会劫持子级 fixed 定位
    // 的包含块（手机端菜单曾被困在瓦片里变成窄条），脱离后由 JS 按锚点定位。
    // 事件监听随节点走，app.js 的开合/外点关闭逻辑不受影响。
    [
      [document.getElementById('settings-menu'), document.getElementById('settings-btn')],
      [document.getElementById('create-menu'), document.getElementById('create-btn')],
    ].forEach(function (pair) {
      var menu = pair[0], anchor = pair[1];
      if (!menu || !anchor) return;
      menu.classList.add('dock-menu-detached');
      document.body.appendChild(menu);
      new MutationObserver(function () {
        if (menu.hidden) return;
        if (matchMedia('(max-width: 700px)').matches) {
          menu.style.top = '';
          menu.style.right = '';
          menu.style.left = '';
        } else {
          var r = anchor.getBoundingClientRect();
          menu.style.top = (r.bottom + 14) + 'px';
          menu.style.right = Math.max(12, window.innerWidth - r.right) + 'px';
          menu.style.left = 'auto';
        }
      }).observe(menu, { attributes: true, attributeFilter: ['hidden'] });
    });

    wireSearchExpand(panel);
    if (canHover && !reduceMotion) magnify(panel);
    return panel;
  }

  // 搜索瓦片展开/收起；输入框原节点原监听（过滤 + Enter 深搜）不动
  function wireSearchExpand(panel) {
    var wrap = panel.querySelector('.search-wrap');
    var input = document.getElementById('search');
    if (!wrap || !input) return;
    wrap.addEventListener('click', function () {
      if (wrap.classList.contains('expanded')) return;
      wrap.classList.add('expanded');
      setTimeout(function () { input.focus(); }, 120);
    });
    wrap.addEventListener('focusout', function (e) {
      if (wrap.contains(e.relatedTarget)) return;
      if (!input.value) wrap.classList.remove('expanded');
    });
  }

  // 鼠标邻近放大：三角衰减目标值 + rAF 弹簧插值（对应 Dock 的 spring 手感）。
  // 除缩放外还带「推开」：邻近瓦片按彼此的膨胀量横向让位，杜绝相互交叠。
  // will-change 只在这里（桌面 hover 场景）由 JS 设置，settle 归位后清掉，
  // 避免劫持子级 fixed 菜单的包含块（见 premium.css 注释）。
  function magnify(panel) {
    var MAG = 0.32;       // 最大放大比例增量
    var DIST = 140;       // 影响半径 px
    var items = Array.prototype.filter.call(panel.children, function (el) {
      return el.classList.contains('dock-item');
    });
    var state = items.map(function () { return { cur: 1, tgt: 1 }; });
    var mx = Infinity, hovering = false, running = false;

    function anyMenuOpen() {
      var cm = document.getElementById('create-menu');
      var sm = document.getElementById('settings-menu');
      return (cm && !cm.hidden) || (sm && !sm.hidden);
    }

    function frame() {
      var panelLeft = panel.getBoundingClientRect().left;
      var settled = !hovering;
      var freeze = anyMenuOpen();
      items.forEach(function (el, i) {
        var s = state[i];
        var searchOpen = el.classList.contains('expanded');
        if (hovering && !freeze && !searchOpen) {
          var center = panelLeft + el.offsetLeft + el.offsetWidth / 2;
          var d = Math.abs(mx - center);
          s.tgt = 1 + MAG * Math.max(0, 1 - d / DIST);
        } else {
          s.tgt = 1;
        }
        s.cur += (s.tgt - s.cur) * 0.28;
        if (Math.abs(s.tgt - s.cur) > 0.002) settled = false;
        else s.cur = s.tgt;
      });
      items.forEach(function (el, i) {
        var s = state[i];
        // 推开量：所有其他瓦片膨胀宽度的一半，按方向叠加
        var push = 0;
        items.forEach(function (other, j) {
          if (j === i) return;
          var grow = (state[j].cur - 1) * other.offsetWidth * 0.55;
          push += i > j ? grow : -grow;
        });
        if (s.cur === 1 && Math.abs(push) < 0.3) {
          el.style.transform = '';
          el.style.willChange = '';
        } else {
          el.style.transform = 'translate(' + push.toFixed(2) + 'px, ' + (-(s.cur - 1) * 12).toFixed(2) + 'px) scale(' + s.cur.toFixed(3) + ')';
          el.style.willChange = 'transform';
        }
      });
      if (settled) { running = false; return; }
      requestAnimationFrame(frame);
    }
    function start() {
      if (running) return;
      running = true;
      requestAnimationFrame(frame);
    }
    panel.addEventListener('mousemove', function (e) { mx = e.clientX; hovering = true; start(); });
    panel.addEventListener('mouseleave', function () { hovering = false; start(); });
  }

  // ---------- 课程卡 3D 倾斜 + 全息（React Bits <ProfileCard/> 移植，网格轻量版） ----------
  function cardTilt() {
    if (!canHover || reduceMotion) return;
    var active = null;   // { el, px, py, tpx, tpy, holo, tholo }
    var running = false;

    function frame() {
      if (!active) { running = false; return; }
      var a = active;
      a.px += (a.tpx - a.px) * 0.22;
      a.py += (a.tpy - a.py) * 0.22;
      a.holo += (a.tholo - a.holo) * 0.15;
      var st = a.el.style;
      st.setProperty('--px', a.px.toFixed(2) + '%');
      st.setProperty('--py', a.py.toFixed(2) + '%');
      st.setProperty('--rx', (((a.px - 50) / 50) * 9).toFixed(2) + 'deg');
      st.setProperty('--ry', ((-(a.py - 50) / 50) * 8).toFixed(2) + 'deg');
      st.setProperty('--lift', (a.tholo ? -4 : 0) + 'px');
      st.setProperty('--holo', a.holo.toFixed(3));
      // 归位后清掉内联变量，卡片回到纯 CSS 默认态
      if (!a.tholo && a.holo < 0.01 && Math.abs(a.px - 50) < 0.3 && Math.abs(a.py - 50) < 0.3) {
        ['--px', '--py', '--rx', '--ry', '--lift', '--holo'].forEach(function (v) { st.removeProperty(v); });
        active = null;
        running = false;
        return;
      }
      requestAnimationFrame(frame);
    }
    function start() {
      if (running) return;
      running = true;
      requestAnimationFrame(frame);
    }

    document.addEventListener('pointermove', function (e) {
      var card = e.target.closest ? e.target.closest('.card-grid .nb-card') : null;
      if (card) {
        if (!active || active.el !== card) {
          if (active && active.el !== card) resetVars(active.el);
          active = { el: card, px: 50, py: 50, holo: 0, tpx: 50, tpy: 50, tholo: 1 };
        }
        var r = card.getBoundingClientRect();
        active.tpx = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
        active.tpy = Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100));
        active.tholo = 1;
        start();
      } else if (active) {
        active.tpx = 50; active.tpy = 50; active.tholo = 0;
        start();
      }
    }, { passive: true });

    function resetVars(el) {
      ['--px', '--py', '--rx', '--ry', '--lift', '--holo'].forEach(function (v) { el.style.removeProperty(v); });
    }
  }

  // ---------- 程序化封面：没有预生成 webp 的课程（动态上传）现场画一张 ----------
  // 风格对齐 AI 封面：深底 + 课程主色光斑 + 半透明绸带；种子取文件名，稳定不闪变。
  function paintCovers(root) {
    (root || document).querySelectorAll('.nb-card-cover.noimg img').forEach(function (img) {
      var cover = img.parentElement;
      var card = img.closest('.nb-card');
      if (!card || cover.dataset.painted) return;
      cover.dataset.painted = '1';
      var accent = (card.style.getPropertyValue('--accent') || '#6750A4').trim();
      var seed = 7, key = card.dataset.file || '';
      for (var i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) >>> 0;
      var rnd = function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

      var W = 512, H = 288;
      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      var ctx = cv.getContext('2d');
      var bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, '#1a1524');
      bg.addColorStop(1, '#120e1a');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      ctx.filter = 'blur(36px)';
      var hues = [accent, accent, 'rgba(120,160,255,0.9)', 'rgba(210,120,255,0.85)'];
      for (var b = 0; b < 4; b++) {
        ctx.globalAlpha = 0.26 + rnd() * 0.22;
        ctx.fillStyle = hues[b];
        ctx.beginPath();
        ctx.ellipse(rnd() * W, rnd() * H, 60 + rnd() * 110, 45 + rnd() * 70, rnd() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.filter = 'blur(10px)';
      ctx.strokeStyle = '#ffffff';
      for (var r = 0; r < 2; r++) {
        ctx.globalAlpha = 0.10 + rnd() * 0.08;
        ctx.lineWidth = 20 + rnd() * 26;
        ctx.beginPath();
        ctx.moveTo(-40, rnd() * H);
        ctx.bezierCurveTo(W * 0.3, rnd() * H, W * 0.65, rnd() * H, W + 40, rnd() * H);
        ctx.stroke();
      }
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      img.src = cv.toDataURL('image/png');
      cover.classList.remove('noimg');
    });
  }
  // 封面 404 随时可能发生（含以后异步重渲染），捕获阶段统一接住补画
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.tagName === 'IMG' && t.closest && t.closest('.nb-card-cover')) {
      setTimeout(function () { paintCovers(t.closest('.card-grid, .swap-stage, .deck-stage') || document); }, 0);
    }
  }, true);

  // ---------- 全屏翻阅模式：点击卡堆进入，滚轮/拖动翻卡，点击进入课程 ----------
  var openDeck = (function () {
    var overlay = null, stage = null, counter = null;
    var cards = [], pos = 0, target = 0, running = false, snapTimer = null, isOpen = false;

    function build() {
      overlay = document.createElement('div');
      overlay.id = 'deck-overlay';
      overlay.hidden = true;
      stage = document.createElement('div');
      stage.className = 'deck-stage';
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'deck-close';
      closeBtn.setAttribute('aria-label', '退出翻阅');
      closeBtn.innerHTML = NBIcon('close', { size: 20 });
      counter = document.createElement('div');
      counter.className = 'deck-counter';
      overlay.appendChild(stage);
      overlay.appendChild(closeBtn);
      overlay.appendChild(counter);
      document.body.appendChild(overlay);

      closeBtn.addEventListener('click', close);
      stage.addEventListener('click', function (e) { if (e.target === stage) close(); });
      overlay.addEventListener('wheel', function (e) {
        e.preventDefault();
        target += e.deltaY * 0.0032;
        clamp();
        // 停轮 150ms 后吸附到最近一张，翻页手感而非无级滑动
        if (snapTimer) clearTimeout(snapTimer);
        snapTimer = setTimeout(function () { target = Math.round(target); clamp(); start(); }, 150);
        start();
      }, { passive: false });

      // 触屏/笔：竖向拖动翻卡
      var dragY = null;
      overlay.addEventListener('pointerdown', function (e) { dragY = e.clientY; });
      overlay.addEventListener('pointermove', function (e) {
        if (dragY === null || e.buttons === 0) return;
        target += (dragY - e.clientY) * 0.012;
        dragY = e.clientY;
        clamp();
        start();
      });
      overlay.addEventListener('pointerup', function () {
        dragY = null;
        target = Math.round(target);
        clamp();
        start();
      });
    }

    function clamp() { target = Math.max(0, Math.min(cards.length - 1, target)); }

    // 测试探针（只读）
    try {
      Object.defineProperty(window, '__deck', {
        value: { get pos() { return pos; }, get target() { return target; }, get running() { return running; }, get n() { return cards.length; } },
        configurable: true,
      });
    } catch (e) {}

    function onKey(e) {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { target = Math.min(cards.length - 1, Math.round(target) + 1); start(); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { target = Math.max(0, Math.round(target) - 1); start(); }
    }

    function render() {
      var n = cards.length;
      for (var i = 0; i < n; i++) {
        var o = i - pos, st = cards[i].style, x, y, z, op, zi;
        if (o >= 0) {
          // 队列中：向右上叠远
          x = o * 54; y = -o * 34; z = -o * 80;
          op = o > 7 ? Math.max(0, 1 - (o - 7)) : 1;
          zi = 900 - Math.round(o * 10);
        } else {
          // 已翻过：向左下滑出并淡出
          x = o * 260; y = -o * 150; z = 40;
          op = Math.max(0, 1 + o * 0.7);
          zi = 990;
        }
        var s = 1 + Math.max(0, 1 - Math.abs(o)) * 0.05;
        st.transform = 'translate3d(calc(-50% + ' + x.toFixed(1) + 'px), calc(-50% + ' + y.toFixed(1) + 'px), ' + z.toFixed(1) + 'px) skewY(5deg) scale(' + s.toFixed(3) + ')';
        st.opacity = op.toFixed(3);
        st.zIndex = String(zi);
        st.visibility = op <= 0 ? 'hidden' : 'visible';
      }
      counter.innerHTML = '<b>' + (Math.min(cards.length, Math.max(1, Math.round(pos) + 1))) + '</b> / ' + cards.length +
        ' · 滚轮翻阅 · 点击进入 · Esc 退出';
    }

    function frame() {
      if (!isOpen) { running = false; return; }
      pos += (target - pos) * (reduceMotion ? 1 : 0.2);
      if (Math.abs(target - pos) < 0.01) pos = target;
      render();
      if (pos === target) { running = false; return; }
      requestAnimationFrame(frame);
    }
    function start() {
      if (running || !isOpen) return;
      running = true;
      requestAnimationFrame(frame);
    }

    function close() {
      isOpen = false;
      overlay.classList.remove('open');
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      setTimeout(function () { overlay.hidden = true; stage.innerHTML = ''; cards = []; }, 230);
    }

    return function open(startFile, tab) {
      if (!overlay) build();
      // 从主网格克隆课程卡（含封面/进度），按当前分类过滤，剔除管理控件与倾斜残留
      paintCovers(document.getElementById('courses'));
      stage.innerHTML = '';
      cards = [];
      var startIdx = 0;
      document.querySelectorAll('#courses .nb-card').forEach(function (orig) {
        if (tab && tab !== 'all' && (orig.dataset.category || 'learn') !== tab) return;
        var c = orig.cloneNode(true);
        c.querySelectorAll('.nb-del, .nb-edit, .nb-drag').forEach(function (b) { b.remove(); });
        c.style.display = '';
        ['--px', '--py', '--rx', '--ry', '--lift', '--holo'].forEach(function (v) { c.style.removeProperty(v); });
        var idx = cards.length;
        if (startFile && c.dataset.file === startFile) startIdx = idx;
        c.addEventListener('click', function (e) {
          // 只有最前面那张可点进课程；点后面的卡是「把它翻上来」
          if (Math.abs(idx - pos) > 0.5) {
            e.preventDefault();
            target = idx;
            clamp();
            start();
          }
        });
        stage.appendChild(c);
        cards.push(c);
      });
      if (!cards.length) return;
      pos = target = startIdx;
      isOpen = true;
      overlay.hidden = false;
      render();
      requestAnimationFrame(function () { overlay.classList.add('open'); });
      document.addEventListener('keydown', onKey);
      document.body.style.overflow = 'hidden';
    };
  })();

  // ---------- Recent 卡堆（React Bits <CardSwap/> 移植） ----------
  function cardSwap() {
    var section = document.getElementById('recent-section');
    var stage = document.getElementById('recent');
    if (!section || !stage) return;

    var timer = null, swapping = false, order = [], cards = [];
    var small = matchMedia('(max-width: 700px)').matches;
    var DX = small ? 26 : 46, DY = small ? 18 : 32, DZ = small ? 48 : 72, SKEW = 5, DELAY = 4600;
    var SPRING = 'cubic-bezier(0.32, 1.3, 0.45, 1)';

    function slotTransform(i, dropY) {
      var x = i * DX, y = -i * DY + (dropY || 0), z = -i * DZ;
      return 'translate3d(calc(-50% + ' + x + 'px), calc(-50% + ' + y + 'px), ' + z + 'px) skewY(' + SKEW + 'deg)';
    }
    function place(el, i) {
      el.style.transition = 'none';
      el.style.transform = slotTransform(i);
      el.style.zIndex = String(cards.length - i);
    }

    function activeTab() {
      var t = document.querySelector('.home-tabs .tab.active');
      return (t && t.dataset.tab) || 'learn';
    }

    // 问候语：Claude 首页式的一句话，随分类/进入时刻变化
    function greetingText(frontTitle) {
      var h = new Date().getHours();
      var hi = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
      var t = '《' + frontTitle + '》';
      var pool = [
        hi + '，Xi。接着看' + t + '？',
        'Hello, Xi — 从' + t + '继续？',
        hi + '，Xi。' + t + '就差一口气了',
        '欢迎回来。今天先翻两页' + t + '？',
        hi + '。' + t + '在等你收尾',
      ];
      return pool[Math.floor(Math.random() * pool.length)];
    }

    // 逐字入场（React Bits SplitText 移植：无 GSAP，CSS transition + 逐字 delay）
    function renderGreeting(frontCard) {
      var copy = section.querySelector('.hero-copy');
      if (!copy) {
        copy = document.createElement('div');
        copy.className = 'hero-copy';
        copy.innerHTML = '<h2></h2><p>点击卡堆展开本分类全部课程，滚轮翻阅、点击进入。</p>';
        section.insertBefore(copy, stage);
      }
      var h2 = copy.querySelector('h2');
      var titleEl = frontCard && frontCard.querySelector('.nb-card-title');
      var text = greetingText(((titleEl && titleEl.textContent) || '笔记').trim());
      h2.classList.remove('st-in');
      h2.innerHTML = '';
      Array.from(text).forEach(function (ch, i) {
        var sp = document.createElement('span');
        sp.className = 'st-ch';
        sp.textContent = ch === ' ' ? ' ' : ch;
        sp.style.transitionDelay = (i * 32) + 'ms, ' + (i * 32) + 'ms';
        h2.appendChild(sp);
      });
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { h2.classList.add('st-in'); });
      });
    }

    function setup() {
      paintCovers(section);
      var tab = activeTab();
      var all = Array.prototype.slice.call(stage.querySelectorAll('.nb-card'));
      var mine = all.filter(function (c) {
        return tab === 'all' || (c.dataset.category || 'learn') === tab;
      });
      all.forEach(function (c) { c.style.display = mine.indexOf(c) === -1 ? 'none' : ''; });
      cards = mine.slice(0, 4);
      stop();
      if (!cards.length) { section.style.display = 'none'; return; }
      section.style.display = '';
      section.classList.add('hero-swap');
      stage.classList.remove('card-grid');
      stage.classList.add('swap-stage');
      renderGreeting(cards[0]);
      // 点卡堆 → 全屏翻阅当前分类（拦截卡片自身的 <a> 跳转）
      if (!stage.__deckWired) {
        stage.__deckWired = true;
        stage.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          var front = cards[order[0]];
          openDeck(front ? front.dataset.file : null, activeTab());
        }, true);
      }
      order = cards.map(function (_, i) { return i; });
      cards.forEach(place);
      if (cards.length >= 2) restart();
    }

    function swap() {
      if (swapping || document.hidden || order.length < 2 || reduceMotion) return;
      swapping = true;
      var front = order[0], rest = order.slice(1);
      var el = cards[front];

      // ① 最前卡先坠落
      el.style.transition = 'transform 0.55s cubic-bezier(0.55, 0, 0.85, 0.35)';
      el.style.transform = slotTransform(0, 520);

      // ② 其余卡依次晋位（弹簧曲线）
      setTimeout(function () {
        rest.forEach(function (idx, i) {
          var c = cards[idx];
          c.style.transition = 'transform 0.65s ' + SPRING + ' ' + (i * 90) + 'ms';
          c.style.zIndex = String(cards.length - i);
          c.style.transform = slotTransform(i);
        });
      }, 240);

      // ③ 坠落卡压到最底再弹回队尾槽位
      setTimeout(function () {
        el.style.zIndex = '1';
        el.style.transition = 'transform 0.65s ' + SPRING;
        el.style.transform = slotTransform(cards.length - 1);
      }, 430);

      setTimeout(function () {
        cards.forEach(function (c) { c.style.transitionDelay = ''; });
        order = rest.concat(front);
        swapping = false;
      }, 1250);
    }

    function restart() {
      stop();
      timer = setInterval(swap, DELAY);
    }
    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
    }
    stage.addEventListener('mouseenter', stop);
    stage.addEventListener('mouseleave', function () {
      if (section.classList.contains('hero-swap') && cards.length >= 2) restart();
    });

    // app.js 异步渲染/以后重渲染 Recent 时（innerHTML 替换）重建卡堆
    new MutationObserver(function (muts) {
      if (muts.some(function (m) { return m.type === 'childList'; })) setup();
    }).observe(stage, { childList: true });
    // 切分类 → 重建为当前分类的卡堆 + 换一句问候
    var tabsBar = document.getElementById('home-tabs');
    if (tabsBar) {
      new MutationObserver(function () { setup(); })
        .observe(tabsBar, { attributes: true, subtree: true, attributeFilter: ['class'] });
    }
    setup();
  }

  // ---------- 启动 ----------
  function init() {
    wireLevelSetting();
    if (level !== 'premium') return;
    buildDock();
    cardTilt();
    cardSwap();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
