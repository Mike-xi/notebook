// 首页：加载课程（静态 courses.json + 用户创建的 /api/courses）+ 进度，渲染卡片
// 并提供「创建课程」（上传 HTML 存入 D1）与删除动态课程的能力。

const MAX_TEXT_BYTES = 25_000_000;   // html / md：≤1.4MB 存 D1，超过自动转存 R2，整体上限 25MB
const MAX_PDF_BYTES = 20_000_000;   // pdf 存 R2
const KIND_ICON = { html: '📘', md: '📝', pdf: '📕' };
const COVER_ASSET_VERSION = '20260719b'; // 封面 URL 版本；绕过自定义域的长缓存

let studyProfile = null;       // 「关于」弹窗用：基于你自己的课程数据生成的学习画像
let staticCoursesData = [];     // 静态课程元数据，供「全能问答」随请求带给后端
let allCoursesMap = new Map();  // file -> 课程元数据，深入搜索结果展示用
let activeTab = 'learn';        // 当前 Tab：默认 learn；顺序 learn / explore / play / time / all
                                // （time 不是分类，是「按添加时间分组」的另一种展示，见下方时间视图）
let searchQ = '';               // 即时搜索词（小写）
let totalCourses = 0;           // 课程总数（空状态判断用）
let ncCat = 'learn';            // 创建课程时选择的分类
let isAdmin = false;            // 当前账号是否为管理员（游客只能浏览/使用，不能增删改课程）
let customCovers = {};          // slug -> updated_at；管理员换过封面的卡片，覆盖静态 /assets/covers/
let courseMeta = {};            // file -> {title, description, icon}；「更多选项」里改过的覆盖

// 根据角色显隐管理操作：
// - 「创建/上传」对所有登录用户开放（游客上传进审核队列）
// - 删除/拖拽/编辑手柄仍由 cardHTML 按 isAdmin 不渲染（仅管理员）
// - 「内容审核」入口仅管理员可见
function applyRoleUI() {
  document.body.classList.toggle('is-guest', !isAdmin);
  const cb = document.getElementById('create-btn');
  if (cb) cb.style.display = '';
  const rv = document.getElementById('review-item');
  if (rv) rv.style.display = isAdmin ? '' : 'none';
  if (isAdmin) loadPendingCount();
}

function detectKind(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'md' || ext === 'markdown') return 'md';
  return 'html';
}

async function loadAndRender() {
  let staticCourses = [], dynamic = [], progress = [], order = [], hidden = [], categoryOverrides = {};
  try {
    // index.html 的 <head> 里已经把这几个请求发出去了（window.__nbBoot），直接复用；
    // 首次渲染之后 __nbBoot 会被清掉，后续刷新走正常请求。
    const boot = window.__nbBoot;
    window.__nbBoot = null;
    const req = (key, url, fallback) => {
      const p = boot && boot[key];
      const got = p || fetch(url, { headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      return got.then((v) => (v == null ? fallback : v));
    };
    const [c1, c2, pr, od, me, cv] = await Promise.all([
      req('courses', '/courses.json?v=' + Date.now(), []),   // 时间戳防 ccwu.cc 域 4h 强缓存
      req('dynamic', '/api/courses', []),
      req('progress', '/api/progress', []),
      req('order', '/api/order', { order: [] }),
      req('me', '/api/me', { role: 'guest' }),
      req('covers', '/api/cover?list=1', { covers: {} }),
    ]);
    customCovers = (cv && cv.covers) || {};
    staticCourses = c1 || [];
    dynamic = c2 || [];
    progress = pr || [];
    order = (od && od.order) || [];
    hidden = (od && od.hidden) || [];
    categoryOverrides = (od && od.categories) || {};
    courseMeta = (od && od.meta) || {};
    isAdmin = (me && me.role) === 'admin';
    // 身份广播给设置面板的身份卡（appearance.js）。role: guest / friend / admin
    window.NBMe = me || { role: 'guest', level: 1, name: '访客' };
    window.dispatchEvent(new CustomEvent('nb-me', { detail: window.NBMe }));
    applyRoleUI();
  } catch (e) {
    console.warn('[home] load failed', e);
  }

  // 被删除的静态课程（courses.json 无法物理删除，按隐藏列表过滤）
  const hiddenSet = new Set(hidden);
  const courses = applyOrder([...staticCourses, ...dynamic], order)
    .filter((c) => !hiddenSet.has(c.file))
    .filter((c) => isAdmin || !c.adminOnly);   // 管理员专属课程（如 Xi Pan）对游客隐藏

  // 叠加「拖拽改分类」的覆盖（统一作用于静态/动态课程）
  for (const c of courses) {
    const ov = categoryOverrides[c.file];
    if (ov && ['learn', 'explore', 'play'].includes(ov)) c.category = ov;
  }

  // 叠加「更多选项」里改过的标题/简介/图标（course_meta，见 api/course-meta.js）。
  // 静态课程写在 git 的 courses.json 里改不动，所以统一走这层覆盖。
  for (const c of courses) {
    const m = courseMeta[c.file];
    if (!m) continue;
    if (m.title) c.title = m.title;
    if (m.description) c.description = m.description;
    if (m.icon) c.icon = m.icon;
  }

  const progressMap = {};
  for (const p of progress) progressMap[p.file] = p;

  // 最近阅读（按 updated_at 排序）：经典模式取前 4；
  // 高级模式多取一些，卡堆按分类过滤后每类才有得堆
  const recentLimit = document.documentElement.dataset.ui === 'premium' ? 12 : 4;
  const recent = progress
    .filter((p) => p.updated_at)
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, recentLimit)
    .map((p) => ({ ...courses.find((c) => c.file === p.file), ...p }))
    .filter((c) => c.title);

  staticCoursesData = staticCourses;
  allCoursesMap = new Map(courses.map((c) => [c.file, c]));
  studyProfile = buildProfile(courses, progress, recent);


  // 全部课程
  const grid = document.getElementById('courses');
  totalCourses = courses.length;
  grid.innerHTML = courses
    .map((c) => cardHTML({ ...c, ...progressMap[c.file] }, true))
    .join('');
  applyFilters();
}

// ========== 搜索 ==========
// 输入即时过滤卡片（标题/学科/简介/标签）；按 Enter 走 /api/search 深入搜索（语义 + 全文）
const searchInput = document.getElementById('search');
searchInput.addEventListener('input', (e) => {
  searchQ = e.target.value.trim().toLowerCase();
  applyFilters();
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (q) openDeepSearch(q);
  }
});

// ========== 分类 Tab（All / Learn / Explore / Play）+ 搜索联合过滤 ==========
const homeTabs = document.getElementById('home-tabs');
homeTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  activeTab = btn.dataset.tab || 'all';
  homeTabs.querySelectorAll('.tab').forEach((b) => {
    const on = b === btn;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  applyFilters();
});

// 窄屏分类菜单：手机上 .home-tabs 会折成两行，改成顶栏一个图标 + 下拉。
// 菜单项由 .home-tabs 里的原按钮生成，点一下转发过去 —— 分类状态仍归上面那段管，
// 这里只是个遥控器。代价是手机上没法把课程卡拖到分类标签上改分类了，
// 不过卡片「更多选项」里本来就能改分类，手机上也只有那条路好走。
const CAT_ICONS = { learn: 'bookopen', explore: 'compass', play: 'trophy', time: 'clock', all: 'stack' };
const catsBtn = document.getElementById('cats-btn');
const catsMenu = document.getElementById('cats-menu');
const catsNow = document.getElementById('cats-now');
if (catsBtn && catsMenu) {
  catsMenu.innerHTML = [...homeTabs.querySelectorAll('.tab')].map((t) => `
    <button type="button" class="cat-item" role="menuitem" data-cat-go="${escapeAttr(t.dataset.tab || 'all')}">
      <span class="ic" data-icon="${CAT_ICONS[t.dataset.tab] || 'stack'}" data-icon-size="18"></span>
      <span class="cat-name">${escapeHTML(t.textContent.trim())}</span>
      <span class="ic cat-check" data-icon="check" data-icon-size="16"></span>
    </button>`).join('');
  if (window.NBIconHydrate) NBIconHydrate(catsMenu);

  const closeCats = () => { catsMenu.hidden = true; catsBtn.setAttribute('aria-expanded', 'false'); };
  catsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeSettings();
    closeCreateMenu();
    const open = catsMenu.hidden;
    catsMenu.hidden = !open;
    catsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  catsMenu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-cat-go]');
    if (!item) return;
    const tab = homeTabs.querySelector(`.tab[data-tab="${item.dataset.catGo}"]`);
    if (tab) tab.click();
    closeCats();
  });
  document.addEventListener('click', closeCats);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCats(); });

  // 选中态跟着原 tab 走（含 app.js 启动时恢复上次分类）
  const syncCats = () => {
    const cur = homeTabs.querySelector('.tab.active');
    const key = (cur && cur.dataset.tab) || 'learn';
    if (catsNow) catsNow.textContent = cur ? cur.textContent.trim() : 'Learn';
    catsMenu.querySelectorAll('[data-cat-go]').forEach((b) => b.classList.toggle('on', b.dataset.catGo === key));
  };
  new MutationObserver(syncCats).observe(homeTabs, { attributes: true, subtree: true, attributeFilter: ['class'] });
  syncCats();
}

// ========== 时间视图（Time Tab：按课程加进来的时间分组） ==========
//
// 关键约束：**不能为了排版去重排 DOM**。拖拽排序保存的就是 #courses 里 .nb-card 的
// 先后（见 saveOrder），一旦按时间重排 DOM，管理员随手拖一张卡就会把「时间顺序」
// 当成新的课程顺序写回服务端。所以这里只写 CSS 的 order（网格按 order 摆放，
// DOM 顺序原封不动），分组标题也是同一套 order 里的整行元素。
//
// 时间从哪来：动态课程是 D1 的 created_at；静态课程（courses.json）的 created_at
// 是从 git 历史里挖出来的「该条目首次进入 courses.json 的提交时间」，已写进 json。
const TIME_MODE_KEY = 'nb-time-mode';
let timeMode = (() => {
  try { return localStorage.getItem(TIME_MODE_KEY) === 'term' ? 'term' : 'month'; }
  catch { return 'month'; }
})();
const timeHeads = [];        // 复用的分组标题节点池

const CN_MONTH = (m) => `${m} 月`;

// 自然月分组
function monthGroup(ts) {
  const d = new Date(ts);
  return { key: `m${d.getFullYear()}-${d.getMonth()}`, label: `${d.getFullYear()} 年 ${CN_MONTH(d.getMonth() + 1)}` };
}

// 学期分组（交大作息）：9–1 月秋season、2–6 月春、7–8 月夏季小学期。
// 1 月归到上一年开学的那个秋季学期里，跨年不会被劈成两段。
function termGroup(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  let start, name;
  if (m >= 9) { start = y; name = '秋季学期'; }
  else if (m === 1) { start = y - 1; name = '秋季学期'; }
  else if (m <= 6) { start = y - 1; name = '春季学期'; }
  else { start = y - 1; name = '夏季小学期'; }
  return { key: `t${start}-${name}`, label: `${start}–${start + 1} 学年 · ${name}` };
}

function timeHead(grid, i) {
  if (timeHeads[i]) return timeHeads[i];
  const el = document.createElement('div');
  el.className = 'time-head';
  el.innerHTML = '<b></b><em></em><i></i>';
  grid.appendChild(el);
  timeHeads[i] = el;
  return el;
}

function layoutTimeline(on) {
  const grid = document.getElementById('courses');
  if (!grid) return;
  // 课程重新渲染时是整段 innerHTML 覆盖，标题节点会被一起冲掉 —— 池子里留的是
  // 已经脱离文档的孤儿节点，得先丢掉再重建，否则分组标题会整片消失。
  if (timeHeads.length && timeHeads[0].parentElement !== grid) timeHeads.length = 0;
  grid.classList.toggle('by-time', !!on);

  const cards = [...grid.querySelectorAll('.nb-card')];
  if (!on) {
    // 退出时间视图：把 order 全部还原，标题收起来
    cards.forEach((c) => { c.style.order = ''; });
    timeHeads.forEach((h) => { h.hidden = true; });
    return;
  }

  const groupOf = timeMode === 'term' ? termGroup : monthGroup;
  const groups = new Map();
  for (const card of cards) {
    if (card.style.display === 'none') continue;
    const ts = Number(card.dataset.created) || 0;
    const g = ts ? groupOf(ts) : { key: 'unknown', label: '未标注时间' };
    let bucket = groups.get(g.key);
    if (!bucket) { bucket = { label: g.label, ts, cards: [] }; groups.set(g.key, bucket); }
    bucket.ts = Math.max(bucket.ts, ts);
    bucket.cards.push({ card, ts });
  }

  // 组之间按最近的一条排；组内也按时间倒序（新加的排前面）
  const ordered = [...groups.values()].sort((a, b) => b.ts - a.ts);
  let slot = 0;
  ordered.forEach((g, i) => {
    const head = timeHead(grid, i);
    head.hidden = false;
    head.style.order = String(slot++);
    head.querySelector('b').textContent = g.label;
    head.querySelector('em').textContent = `${g.cards.length} 项`;
    g.cards.sort((a, b) => b.ts - a.ts).forEach(({ card }) => { card.style.order = String(slot++); });
  });
  for (let i = ordered.length; i < timeHeads.length; i++) timeHeads[i].hidden = true;
}

document.querySelectorAll('[data-time-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    timeMode = btn.getAttribute('data-time-mode') === 'term' ? 'term' : 'month';
    try { localStorage.setItem(TIME_MODE_KEY, timeMode); } catch {}
    syncTimeModeButtons();
    layoutTimeline(activeTab === 'time');
  });
});
function syncTimeModeButtons() {
  document.querySelectorAll('[data-time-mode]').forEach((b) => {
    const on = b.getAttribute('data-time-mode') === timeMode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
syncTimeModeButtons();


// 课程卡按「当前 Tab 分类」与「搜索词」联合显隐。
// time 是特例：它不筛类别（等同 all），只是把结果按时间分组排版。
function applyFilters() {
  let visible = 0;
  const byTime = activeTab === 'time';
  document.querySelectorAll('#courses .nb-card').forEach((card) => {
    const catOk = activeTab === 'all' || byTime || (card.dataset.category || 'learn') === activeTab;
    const sOk = !searchQ || (card.dataset.search || '').includes(searchQ);
    const show = catOk && sOk;
    card.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  layoutTimeline(byTime);
  const empty = document.getElementById('empty-hint');
  if (totalCourses === 0) {
    empty.hidden = false;
    empty.innerHTML = 'No notebooks here yet — use <b>Create</b> to add one.';
  } else if (visible === 0) {
    empty.hidden = false;
    empty.textContent = searchQ ? 'No notebooks match your search.' : 'Nothing in this category yet.';
  } else {
    empty.hidden = true;
  }
}

// ========== 深入搜索弹窗 ==========
const searchModal = document.getElementById('search-modal');
const srchBody = document.getElementById('srch-body');
const srchQ = document.getElementById('srch-q');

document.getElementById('srch-close').addEventListener('click', () => { searchModal.hidden = true; });
searchModal.addEventListener('click', (e) => { if (e.target === searchModal) searchModal.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !searchModal.hidden) searchModal.hidden = true; });

async function openDeepSearch(q) {
  srchQ.textContent = `“${q}”`;
  srchBody.innerHTML = '<p class="srch-loading">Running semantic and full-text search…</p>';
  searchModal.hidden = false;
  let data = null;
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Search failed');
  } catch (e) {
    srchBody.innerHTML = `<p class="srch-empty">⚠️ ${escapeHTML(e.message || 'Search failed, please retry')}</p>`;
    return;
  }
  renderDeepSearch(q, data || {});
}

function courseLabel(file) {
  const c = allCoursesMap.get(file);
  return c ? `${iconText(c.icon)} ${c.title}` : file;
}

// 在摘录里高亮命中词（先转义，再替换）
function markHit(text, q) {
  const safe = escapeHTML(text);
  const safeQ = escapeHTML(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try { return safe.replace(new RegExp(safeQ, 'gi'), (m) => `<mark>${m}</mark>`); }
  catch { return safe; }
}

function renderDeepSearch(q, data) {
  const semantic = (data.semantic || []).filter((s) => allCoursesMap.has(s.file));
  const keyword = (data.keyword || []).filter((k) => allCoursesMap.has(k.file) && k.count > 0);
  let html = '';
  if (semantic.length) {
    html += '<p class="srch-section-title">Semantic matches</p>';
    html += semantic.map((s) => `
      <a class="srch-item" href="/reader.html?file=${encodeURIComponent(s.file)}&goto=${encodeURIComponent(s.heading)}">
        <span class="srch-item-top">
          <span class="srch-item-course">${escapeHTML(courseLabel(s.file))}</span>
          <span class="srch-item-heading">${escapeHTML(s.heading)}</span>
        </span>
        <span class="srch-item-text">${markHit(s.text, q)}</span>
      </a>`).join('');
  }
  if (keyword.length) {
    html += '<p class="srch-section-title">Full-text matches</p>';
    html += keyword.map((k) => `
      <a class="srch-item" href="/reader.html?file=${encodeURIComponent(k.file)}">
        <span class="srch-item-top">
          <span class="srch-item-course">${escapeHTML(courseLabel(k.file))}</span>
          <span class="srch-item-count">${k.count >= 99 ? '99+' : k.count} hits</span>
        </span>
        <span class="srch-item-text">${markHit(k.snippet, q)}</span>
      </a>`).join('');
  }
  if (!html) {
    html = '<p class="srch-empty">No matches found</p>';
  }
  html += '<p class="srch-foot-tip">Semantic search covers notebooks that have been indexed — open a notebook’s AI chat to index it. Click a semantic result to jump straight to that section.</p>';
  srchBody.innerHTML = html;
}

// ========== 设置菜单（⚙️ 下拉：外观 / 关于 / 退出） ==========
const settingsWrap = document.querySelector('.settings-wrap');
const settingsBtn = document.getElementById('settings-btn');
const settingsMenu = document.getElementById('settings-menu');

// 面板分两屏：root（身份 + 活跃 + 各入口）/ page（外观那一堆滑杆和分段控件）。
// 关掉面板时回到根屏，下次打开不会停在子屏里。
function showPane(name) {
  settingsMenu.dataset.pane = name;
  settingsMenu.querySelectorAll('.sm-pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  settingsMenu.scrollTop = 0;
}
function openSettings() {
  settingsMenu.hidden = false;
  settingsBtn.setAttribute('aria-expanded', 'true');
  loadHeat();          // 首次打开时才去拉热力图，省一个首屏请求
}
function closeSettings() {
  settingsMenu.hidden = true;
  settingsBtn.setAttribute('aria-expanded', 'false');
  showPane('root');
}
settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  closeCreateMenu();
  settingsMenu.hidden ? openSettings() : closeSettings();
});
const pageSettingsBtn = document.getElementById('page-settings-btn');
const pageBackBtn = document.getElementById('page-back');
if (pageSettingsBtn) pageSettingsBtn.addEventListener('click', () => showPane('page'));
if (pageBackBtn) pageBackBtn.addEventListener('click', () => showPane('root'));
// 点菜单内部不关闭（主题分段控件要连点）；点外部 / Esc 关闭
settingsMenu.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => closeSettings());
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // 子屏里按 Esc 先退回根屏，再按一次才关面板
  if (!settingsMenu.hidden && settingsMenu.dataset.pane === 'page') { showPane('root'); return; }
  closeSettings();
});

// 阅读器工具栏唤出灵敏度（存 localStorage，reader.js 读取；数值=上滑触发阈值 px）
const BAR_REVEAL_KEY = 'nb-bar-reveal';
const BAR_REVEAL_DEFAULT = 14;
function syncBarRevealButtons() {
  const raw = localStorage.getItem(BAR_REVEAL_KEY);
  // 'off'=永久（全关）、'min'=隐藏（收起+返回键）为非数值档，原样匹配；其余按数值阈值
  const cur = (raw === 'off' || raw === 'min') ? raw : String(parseInt(raw, 10) || BAR_REVEAL_DEFAULT);
  document.querySelectorAll('[data-bar-reveal]').forEach((btn) => {
    const on = btn.getAttribute('data-bar-reveal') === cur;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
document.querySelectorAll('[data-bar-reveal]').forEach((btn) => {
  btn.addEventListener('click', () => {
    localStorage.setItem(BAR_REVEAL_KEY, btn.getAttribute('data-bar-reveal'));
    syncBarRevealButtons();
  });
});
syncBarRevealButtons();

// ========== 登出 ==========
document.getElementById('logout-btn').addEventListener('click', async () => {
  closeSettings();
  if (!confirm('退出登录？')) return;
  try { await window.NBTheme?.flush?.(); } catch {}
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  localStorage.removeItem('nb-theme');
  localStorage.removeItem('nb-background');
  location.href = '/login.html';
});

// ========== 内容审核（仅管理员 / 三级） ==========
const reviewModal = document.getElementById('review-modal');
const reviewBody = document.getElementById('review-body');
const reviewItem = document.getElementById('review-item');
const reviewBadge = document.getElementById('review-badge');

// 拉取待审数量，更新设置菜单上的角标
async function loadPendingCount() {
  if (!reviewBadge) return;
  try {
    const r = await fetch('/api/review');
    if (!r.ok) return;
    const d = await r.json();
    const n = (d.pending || []).length;
    reviewBadge.textContent = n > 99 ? '99+' : String(n);
    reviewBadge.hidden = n === 0;
  } catch {}
}

function openReview() {
  closeSettings();
  reviewModal.hidden = false;
  loadReview();
}

async function loadReview() {
  reviewBody.innerHTML = '<p class="rv-loading">加载中…</p>';
  let data;
  try {
    const r = await fetch('/api/review');
    data = await r.json();
    if (!r.ok) throw new Error(data.error || '加载失败');
  } catch (e) {
    reviewBody.innerHTML = `<p class="rv-empty">⚠️ ${escapeHTML(e.message || '加载失败')}</p>`;
    return;
  }
  const list = data.pending || [];
  if (!list.length) {
    reviewBody.innerHTML = '<p class="rv-empty">暂无待审核的内容 🎉</p>';
    return;
  }
  const kindLabel = (k) => ({ html: 'HTML', md: 'Markdown', pdf: 'PDF' }[k] || k);
  reviewBody.innerHTML = list.map((c) => {
    const when = c.created_at ? new Date(c.created_at).toLocaleString('zh-CN', { hour12: false }) : '';
    return `
      <div class="rv-card" data-file="${escapeAttr(c.file)}">
        <span class="rv-icon">${isImgIcon(c.icon) ? iconImgHTML(c.icon, 26) : escapeHTML(c.icon || '📄')}</span>
        <div class="rv-info">
          <h4>${escapeHTML(c.title)}</h4>
          <p class="rv-meta">${escapeHTML(c.subject || '未填学科')} · ${kindLabel(c.kind)} · ${escapeHTML(when)}</p>
          ${c.description ? `<p class="rv-desc">${escapeHTML(c.description)}</p>` : ''}
        </div>
        <div class="rv-actions">
          <a class="rv-btn rv-preview" href="/reader.html?file=${encodeURIComponent(c.file)}" target="_blank" rel="noopener">预览</a>
          <button class="rv-btn rv-approve" data-file="${escapeAttr(c.file)}">通过</button>
          <button class="rv-btn rv-reject" data-file="${escapeAttr(c.file)}">拒绝</button>
        </div>
      </div>`;
  }).join('');
}

async function reviewAction(file, action) {
  try {
    const r = await fetch('/api/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, action }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || '操作失败');
    toast(action === 'approve' ? '已通过，已加入课程' : '已拒绝并删除');
    await loadReview();
    await loadPendingCount();
    if (action === 'approve') await loadAndRender();
  } catch (e) {
    alert(e.message || '操作失败，请重试');
  }
}

if (reviewItem) reviewItem.addEventListener('click', openReview);
if (reviewModal) {
  reviewBody.addEventListener('click', (e) => {
    const ap = e.target.closest('.rv-approve');
    const rj = e.target.closest('.rv-reject');
    if (ap) return reviewAction(ap.dataset.file, 'approve');
    if (rj) { if (confirm('拒绝并删除这个提交？此操作不可恢复。')) reviewAction(rj.dataset.file, 'reject'); }
  });
  document.getElementById('review-close').addEventListener('click', () => { reviewModal.hidden = true; });
  reviewModal.addEventListener('click', (e) => { if (e.target === reviewModal) reviewModal.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !reviewModal.hidden) reviewModal.hidden = true; });
}

// ========== 全能问答（基于全部课程 + 日志，布局沿用课程内对话） ==========
const omniPanel = document.getElementById('omni-panel');
const omniMsgs = document.getElementById('omni-msgs');
const omniInput = document.getElementById('omni-input');
const omniForm = document.getElementById('omni-form');
const omniModel = document.getElementById('omni-model');
let omniBusy = false;
let omniModelsLoaded = false;

function loadOmniModels() {
  if (omniModelsLoaded || !omniModel) return;
  omniModelsLoaded = true;
  fetch('/api/omni').then((r) => (r.ok ? r.json() : null)).then((d) => {
    const models = d && Array.isArray(d.models) ? d.models : [];
    if (!models.length) { omniModel.closest('.chat-model-bar')?.setAttribute('hidden', ''); return; }
    omniModel.innerHTML = models.map((m) =>
      `<option value="${escapeAttr(m.id)}">${escapeHTML(m.label)}${m.hint ? '　·　' + escapeHTML(m.hint) : ''}</option>`
    ).join('');
    const saved = localStorage.getItem('nb-chat-model');
    if (saved && models.some((m) => m.id === saved)) omniModel.value = saved;
  }).catch(() => {});
}
if (omniModel) {
  omniModel.addEventListener('change', () => localStorage.setItem('nb-chat-model', omniModel.value));
}

let omniHistLoaded = false;
async function loadOmniHistory() {
  if (omniHistLoaded) return;
  omniHistLoaded = true;
  try {
    const r = await fetch('/api/chat-history?scope=omni');
    const d = await r.json().catch(() => ({}));
    const msgs = (d && d.messages) || [];
    if (msgs.length) {
      const hintEl = document.getElementById('omni-hint');
      if (hintEl) hintEl.remove();
      for (const m of msgs) omniAppend(m.role === 'assistant' ? 'ai' : 'user', m.content);
    }
  } catch {}
}

function openOmni() {
  loadOmniModels();
  loadOmniHistory();
  omniPanel.hidden = false;
  setTimeout(() => omniInput && omniInput.focus(), 30);
}
document.getElementById('omni-btn').addEventListener('click', () => {
  omniPanel.hidden ? openOmni() : (omniPanel.hidden = true);
});
document.getElementById('omni-close').addEventListener('click', () => { omniPanel.hidden = true; });

const omniClearBtn = document.getElementById('omni-clear');
if (omniClearBtn) {
  omniClearBtn.addEventListener('click', async () => {
    if (!confirm('清空全能问答的对话历史？')) return;
    try { await fetch('/api/chat-history', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'omni' }) }); } catch {}
    omniMsgs.innerHTML = '<p class="chat-hint" id="omni-hint">我了解你所有的课程、阅读进度，以及上传 / 登录等操作记录。问我「我都上传过哪些笔记」「最近读到哪了」「把概率和 Python 的重点对比一下」都可以。</p>';
  });
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !omniPanel.hidden) omniPanel.hidden = true; });

function omniAppend(role, text, thinking) {
  const hintEl = document.getElementById('omni-hint');
  if (hintEl) hintEl.remove();
  const wrap = document.createElement('div');
  wrap.className = 'chat-msg ' + role + (thinking ? ' thinking' : '');
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  if (role === 'ai' && !thinking && window.renderMarkdown) {
    bubble.classList.add('md');
    bubble.innerHTML = window.renderMarkdown(text);
  } else {
    bubble.textContent = text;
  }
  wrap.appendChild(bubble);
  omniMsgs.appendChild(wrap);
  omniMsgs.scrollTop = omniMsgs.scrollHeight;
  return wrap;
}
function omniGrow() { omniInput.style.height = 'auto'; omniInput.style.height = Math.min(omniInput.scrollHeight, 120) + 'px'; }
omniInput.addEventListener('input', omniGrow);
omniInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); omniSend(); }
});
omniForm.addEventListener('submit', (e) => { e.preventDefault(); omniSend(); });

async function omniSend() {
  const q = omniInput.value.trim();
  if (!q || omniBusy) return;
  omniAppend('user', q);
  omniInput.value = ''; omniGrow();
  omniBusy = true;
  const thinking = omniAppend('ai', '思考中…', true);
  try {
    const statics = (staticCoursesData || []).map((c) => ({ title: c.title, subject: c.subject, description: c.description }));
    const res = await fetch('/api/omni', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, model: omniModel ? omniModel.value : undefined, staticCourses: statics }),
    });
    const d = await res.json().catch(() => ({}));
    thinking.remove();
    if (!res.ok) throw new Error(d.error || '请求失败');
    omniAppend('ai', d.answer || '(没有得到回答)');
  } catch (e) {
    thinking.remove();
    omniAppend('ai', '⚠️ ' + (e.message || '请求失败'));
  } finally {
    omniBusy = false;
  }
}

// ========== 关于 / 学习画像 ==========
const aboutModal = document.getElementById('about-modal');

function openAbout() {
  closeSettings();
  renderAbout();
  aboutModal.hidden = false;
}
document.getElementById('about-close').addEventListener('click', () => { aboutModal.hidden = true; });
aboutModal.addEventListener('click', (e) => { if (e.target === aboutModal) aboutModal.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !aboutModal.hidden) aboutModal.hidden = true; });

// 从课程数据（你自己创建的，无隐私）提炼一个学习画像
function buildProfile(courses, progress, recent) {
  const subjects = {};
  const tagSet = new Set();
  for (const c of courses) {
    const s = (c.subject || '').trim();
    if (s) subjects[s] = (subjects[s] || 0) + 1;
    for (const t of (c.tags || [])) { const tt = String(t).trim(); if (tt) tagSet.add(tt); }
  }
  const subjectList = Object.entries(subjects).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const readCount = (progress || []).filter((p) => (p.scroll_pct || 0) > 0.02).length;
  const maxPct = (progress || []).reduce((m, p) => Math.max(m, p.scroll_pct || 0), 0);
  return {
    courseCount: courses.length,
    subjectList,
    subjectCount: subjectList.length,
    tagCount: tagSet.size,
    readCount,
    maxPct: Math.round(maxPct * 100),
    topSubject: subjectList[0] || '',
    recentTitle: (recent && recent[0] && recent[0].title) || '',
  };
}

function renderAbout() {
  const p = studyProfile || { courseCount: 0, subjectList: [], subjectCount: 0, tagCount: 0, readCount: 0, maxPct: 0, topSubject: '', recentTitle: '' };

  // 一句话人设（确定性，按数据挑模板，纯鼓励、不涉隐私）
  let tagline;
  if (p.courseCount === 0) tagline = '一张空白的星图，正等你点亮第一颗星';
  else if (p.subjectCount >= 3) tagline = '横跨多个领域的探索者 — 你的好奇心没有边界';
  else if (p.topSubject) tagline = `专注「${p.topSubject}」的深耕者 — 一寸一寸把它啃透`;
  else tagline = '稳步推进的笔记收藏家';
  document.getElementById('about-tagline').textContent = tagline;

  const aic = (n) => (window.NBIcon ? NBIcon(n, { size: 20 }) : '');
  const stats = [
    { n: p.courseCount, label: '门课程', ic: 'stack' },
    { n: p.subjectCount, label: '个学科', ic: 'compass' },
    { n: p.tagCount, label: '个标签', ic: 'tag' },
    { n: p.readCount, label: '篇在读', ic: 'bookopen' },
  ];
  document.getElementById('about-stats').innerHTML = stats.map((s) => `
    <div class="about-stat">
      <span class="as-ic">${aic(s.ic)}</span>
      <span class="as-n">${s.n}</span>
      <span class="as-label">${s.label}</span>
    </div>`).join('');

  const block = document.getElementById('about-subjects-block');
  if (p.subjectList.length) {
    block.hidden = false;
    document.getElementById('about-subjects').innerHTML =
      p.subjectList.slice(0, 12).map((s) => `<span class="about-chip">${escapeHTML(s)}</span>`).join('');
  } else {
    block.hidden = true;
  }

  // 结语：基于真实数据，给点正反馈
  let note;
  if (p.courseCount === 0) {
    note = '点右上角「＋ 创建课程」上传第一份笔记，我就能帮你把它整理成可检索、可对话的复习资料。';
  } else {
    const bits = [];
    bits.push(`你已经在这里收藏了 ${p.courseCount} 门课程`);
    if (p.recentTitle) bits.push(`最近在翻《${p.recentTitle}》`);
    else if (p.topSubject) bits.push(`「${p.topSubject}」是你投入最多的方向`);
    if (p.maxPct >= 80) bits.push('已经有笔记被你读到接近尾声，这份坚持很难得');
    else if (p.readCount > 0) bits.push('保持这个节奏，知识会一点点沉淀下来');
    note = bits.join('，') + '。';
  }
  document.getElementById('about-note').textContent = note;
}

// ========== 更换卡片封面（仅管理员） ==========
// 上传前在浏览器里压成 640x360 webp：尺寸统一、体积从几 MB 降到几十 KB，
// 也绕开了 Workers 端没有图片处理能力的限制。
async function shrinkCover(file, w = 640, h = 360) {
  const bmp = await createImageBitmap(file);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const scale = Math.max(w / bmp.width, h / bmp.height);   // 按 cover 裁切，不留白边
  const dw = bmp.width * scale, dh = bmp.height * scale;
  ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
  if (bmp.close) bmp.close();
  // 注意：不支持 webp 编码的浏览器（Safari 16 以下）会静默回退成 PNG，
  // 所以 mime 一律以 blob.type 为准，不能写死 image/webp
  const blob = await new Promise((r) => cv.toBlob(r, 'image/webp', 0.86));
  if (!blob) throw new Error('图片编码失败');
  return blob;
}

// 自定义图标：正方形、留白不裁切（logo 类图片裁掉边就认不出来了）
async function shrinkIcon(file, size = 160) {
  const bmp = await createImageBitmap(file);
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d');
  const scale = Math.min(size / bmp.width, size / bmp.height);
  const dw = bmp.width * scale, dh = bmp.height * scale;
  ctx.drawImage(bmp, (size - dw) / 2, (size - dh) / 2, dw, dh);
  if (bmp.close) bmp.close();
  const blob = await new Promise((r) => cv.toBlob(r, 'image/webp', 0.9));
  if (!blob) throw new Error('图片编码失败');
  return blob;
}

let coverPicker = null;
function pickCover(slug, imgEl, btn, onDone) {
  if (!coverPicker) {
    coverPicker = document.createElement('input');
    coverPicker.type = 'file';
    coverPicker.accept = 'image/*';
    coverPicker.style.display = 'none';
    document.body.appendChild(coverPicker);
  }
  coverPicker.value = '';
  coverPicker.onchange = async () => {
    const f = coverPicker.files && coverPicker.files[0];
    if (!f) return;
    if (btn) btn.classList.add('busy');
    try {
      // 先进裁剪框（可平移缩放）；用户取消就什么都不做
      const blob = window.NBCropper
        ? await NBCropper.open(f, { aspect: 16 / 9, out: { w: 640, h: 360 } })
        : await shrinkCover(f);
      const res = await fetch(`/api/cover?slug=${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'image/webp' },
        body: blob,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '上传失败');
      customCovers[slug] = data.updated_at;
      if (imgEl) {
        imgEl.parentElement.classList.remove('noimg');
        imgEl.src = `/api/cover?slug=${encodeURIComponent(slug)}&v=${data.updated_at}`;
      }
      if (btn) btn.dataset.custom = '1';
      if (onDone) onDone(data.updated_at);
    } catch (err) {
      if (err && err.message !== 'cancelled') alert('换封面失败：' + (err.message || err));
    } finally {
      if (btn) btn.classList.remove('busy');
    }
  };
  coverPicker.click();
}

// ========== 课程「更多选项」弹窗（事件委托） ==========
// 卡片上原本有删除/编辑/换封面三个角标，且删除只有部分卡片有；现在统一收进这个
// 弹窗，每张卡都有，卡片角上只留「更多 + 拖动」两个手柄。
document.getElementById('courses').addEventListener('click', (e) => {
  const more = e.target.closest('.nb-more');
  if (!more) return;
  e.preventDefault();
  e.stopPropagation();
  openCourseOptions(more.dataset.file);
});

const EMOJI_PRESETS = [
  '📘', '📗', '📕', '📙', '📓', '📔', '📝', '✏️', '🖊️', '📄',
  '🧮', '📐', '📊', '📈', '🔬', '🔭', '⚗️', '🧪', '🧬', '⚛️',
  '💻', '⌨️', '🖥️', '🧠', '🤖', '🛰️', '🚀', '⚙️', '🔧', '🔌',
  '🌊', '⛵', '🚢', '🛥️', '🐋', '🧭', '🗺️', '🌍', '🌡️', '🧊',
  '🎯', '🎮', '🎲', '🃏', '🏀', '⚽', '🎹', '🎧', '🎬', '🎨',
  '📚', '🏫', '🎓', '💡', '🔍', '⭐', '🔥', '💎', '🏆', '🧩',
];

let courseModal = null;
let coIconPicker = null;

function openCourseOptions(file) {
  const c = allCoursesMap.get(file);
  if (!c) return;
  closeSettings();
  const slug = String(file || '').replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  const coverTs = customCovers[slug];
  const coverURL = coverTs
    ? `/api/cover?slug=${encodeURIComponent(slug)}&v=${coverTs}`
    : `/assets/covers/${slug}.webp?v=${COVER_ASSET_VERSION}`;
  const cat = c.category || 'learn';

  if (!courseModal) {
    courseModal = document.createElement('div');
    courseModal.className = 'modal-overlay';
    courseModal.id = 'course-options';
    document.body.appendChild(courseModal);
    courseModal.addEventListener('click', (e) => {
      if (e.target === courseModal) closeCourseOptions();
    });
  }

  courseModal.innerHTML = `
    <div class="modal co-modal" role="dialog" aria-modal="true" aria-label="课程选项">
      <h3>课程选项</h3>

      <label class="field">
        <span>课程名称</span>
        <input type="text" id="co-title" maxlength="80" autocomplete="off">
      </label>

      <label class="field">
        <span>简介</span>
        <textarea id="co-desc" rows="2" maxlength="160" placeholder="鼠标移到卡片上才会显示"></textarea>
      </label>

      <div class="field">
        <span>分类</span>
        <div class="seg" role="group" aria-label="课程分类">
          <button type="button" class="seg-btn${cat === 'learn' ? ' active' : ''}" data-co-cat="learn">Learn</button>
          <button type="button" class="seg-btn${cat === 'explore' ? ' active' : ''}" data-co-cat="explore">Explore</button>
          <button type="button" class="seg-btn${cat === 'play' ? ' active' : ''}" data-co-cat="play">Play</button>
        </div>
      </div>

      <div class="field">
        <span>封面</span>
        <div class="co-cover">
          <img id="co-cover-img" src="${escapeAttr(coverURL)}" alt="" onerror="this.classList.add('noimg')">
          <div class="co-cover-acts">
            <button type="button" class="btn-soft" id="co-cover-pick">更换封面</button>
            <button type="button" class="btn-soft co-reset" id="co-cover-reset"${coverTs ? '' : ' disabled'}>恢复默认</button>
          </div>
        </div>
      </div>

      <div class="field">
        <span>图标</span>
        <div class="co-icon-row">
          <span class="co-icon-now" id="co-icon-now"></span>
          <button type="button" class="btn-soft" id="co-icon-upload">上传图片</button>
          <button type="button" class="btn-soft co-reset" id="co-icon-reset">恢复默认</button>
        </div>
        <div class="co-emoji" id="co-emoji" role="listbox" aria-label="选择图标">
          ${EMOJI_PRESETS.map((x) => `<button type="button" class="co-em" data-em="${escapeAttr(x)}">${escapeHTML(x)}</button>`).join('')}
        </div>
      </div>

      <div class="modal-actions co-actions">
        <button type="button" class="btn-danger" id="co-delete">删除课程</button>
        <span class="co-spacer"></span>
        <button type="button" class="btn-ghost" id="co-cancel">取消</button>
        <button type="button" class="btn-primary" id="co-save">保存</button>
      </div>
    </div>`;

  const $ = (id) => courseModal.querySelector('#' + id);
  // 输入框里放「当前生效值」；清空并保存＝清掉覆盖、回到原始值
  $('co-title').value = c.title || '';
  $('co-desc').value = c.description || '';

  let pendingIcon = c.icon || '📄';
  let pendingCat = cat;
  function paintIcon() {
    const el = $('co-icon-now');
    if (isIconImage(pendingIcon)) {
      el.innerHTML = `<img src="${escapeAttr(pendingIcon)}" alt="">`;
    } else {
      el.textContent = pendingIcon;
    }
    courseModal.querySelectorAll('.co-em').forEach((b) => {
      b.classList.toggle('on', b.dataset.em === pendingIcon);
    });
  }
  paintIcon();

  courseModal.querySelectorAll('[data-co-cat]').forEach((b) => {
    b.addEventListener('click', () => {
      pendingCat = b.dataset.coCat;
      courseModal.querySelectorAll('[data-co-cat]').forEach((x) => x.classList.toggle('active', x === b));
    });
  });
  courseModal.querySelectorAll('.co-em').forEach((b) => {
    b.addEventListener('click', () => { pendingIcon = b.dataset.em; paintIcon(); });
  });

  $('co-cover-pick').addEventListener('click', () => {
    pickCover(slug, $('co-cover-img'), null, (ts) => {
      $('co-cover-reset').disabled = false;
      $('co-cover-img').classList.remove('noimg');
    });
  });
  $('co-cover-reset').addEventListener('click', async () => {
    if (!confirm('恢复这张卡片的默认封面？')) return;
    try {
      const res = await fetch(`/api/cover?slug=${encodeURIComponent(slug)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      delete customCovers[slug];
      $('co-cover-img').src = `/assets/covers/${slug}.webp?v=${COVER_ASSET_VERSION}`;
      $('co-cover-reset').disabled = true;
    } catch { alert('恢复默认失败，请重试'); }
  });

  // 自定义图标复用封面那张表，slug 加 icon- 前缀，不用另开存储
  $('co-icon-upload').addEventListener('click', () => {
    if (!coIconPicker) {
      coIconPicker = document.createElement('input');
      coIconPicker.type = 'file';
      coIconPicker.accept = 'image/*';
      coIconPicker.style.display = 'none';
      document.body.appendChild(coIconPicker);
    }
    coIconPicker.value = '';
    coIconPicker.onchange = async () => {
      const f = coIconPicker.files && coIconPicker.files[0];
      if (!f) return;
      try {
        // 图标是圆角方块，用 1:1 的圆形取景框裁
        const blob = window.NBCropper
          ? await NBCropper.open(f, { aspect: 1, out: { w: 192, h: 192 }, round: true })
          : await shrinkIcon(f);
        const iconSlug = 'icon-' + slug;
        const res = await fetch(`/api/cover?slug=${encodeURIComponent(iconSlug)}`, {
          method: 'POST',
          headers: { 'Content-Type': blob.type || 'image/webp' },
          body: blob,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '上传失败');
        pendingIcon = `/api/cover?slug=${encodeURIComponent(iconSlug)}&v=${data.updated_at}`;
        paintIcon();
      } catch (err) {
        if (err && err.message !== 'cancelled') alert('上传图标失败：' + (err.message || err));
      }
    };
    coIconPicker.click();
  });
  $('co-icon-reset').addEventListener('click', () => { pendingIcon = ''; paintIcon(); });

  $('co-cancel').addEventListener('click', closeCourseOptions);
  $('co-save').addEventListener('click', async () => {
    const btn = $('co-save');
    btn.disabled = true;
    try {
      const res = await fetch('/api/course-meta', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file,
          title: $('co-title').value,
          description: $('co-desc').value,
          icon: pendingIcon,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '保存失败');
      if (pendingCat !== cat) recategorize(file, pendingCat);
      closeCourseOptions();
      await loadAndRender();
    } catch (err) {
      alert('保存失败：' + (err.message || err));
      btn.disabled = false;
    }
  });

  $('co-delete').addEventListener('click', async () => {
    if (!confirm('删除这个课程？将一并清除它的阅读进度与书签，且不可恢复。')) return;
    try {
      const res = await fetch('/api/courses', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      });
      if (!res.ok) throw new Error();
      closeCourseOptions();
      await loadAndRender();
    } catch { alert('删除失败，请重试'); }
  });

  courseModal.hidden = false;
  courseModal.classList.add('open');
  if (window.NBSegment) NBSegment.enhanceAll(courseModal);
  setTimeout(() => $('co-title').focus(), 30);
  document.addEventListener('keydown', escCourseOptions);
}

// ========== 说明文档 ==========
// 原来这里是「关于」（学习画像）。改成说明文档后，画像挪到文档末尾的按钮里，功能没丢。
const DOC_SECTIONS = [
  {
    icon: 'users', title: '三级身份',
    body: `进站要输密码，密码决定身份，三级权限依次放开：
      <ul>
        <li><b>访客（一级）</b> —— 浏览和使用全部内容；上传的东西要经审核才公开。</li>
        <li><b>好友（二级）</b> —— 与访客权限相同，但自选背景、单词本等数据和访客共用一份。</li>
        <li><b>管理员（三级）</b> —— 可以增删改课程、审核投稿、管理全站；数据单独一份，不与前两级混。</li>
      </ul>
      当前身份显示在设置面板最上方。换密码重新登录即可切换身份。`,
  },
  {
    icon: 'palette', title: '外观与背景',
    body: `都在设置面板的<b>「页面设置」</b>里（点进去是一屏，左上角箭头退回来）：
      <ul>
        <li><b>界面风格</b> —— 「高级」是液态玻璃 Dock、全息卡片、卡堆；「经典」是原版 Material You 界面。</li>
        <li><b>外观</b> —— 跟随系统 / 浅色 / 深色。</li>
        <li><b>页面背景</b> —— 5 套内置着色器（素色、极光、百叶窗、波纹、地形）+ 最多 3 张自己上传的图，一共 8 格。
            鼠标悬停某一格会展开看大图，点一下生效。自选背景按身份分开存：管理员一份，访客与好友共用一份。</li>
        <li><b>浓淡 / 亮度</b> —— 两根滑杆，左边的小图标就是它们的名字（半圆＝浓淡，太阳＝亮度）。
            <b>浓淡 100 + 亮度 50 就是「原图直出」</b>：图怎么传上来就怎么显示，不做任何处理；
            往下调浓淡让背景退到正文后面，亮度以 50 为中点往两边压暗或提亮。新传的图会自动回到这一组数值。</li>
        <li><b>顶栏通透度</b> —— 顶部那条工具栏的玻璃程度，0 到 100 连续可调。越往右越透，同时模糊、折射和边缘高光会一起加重，接近 100 时就是一块通透玻璃。</li>
      </ul>`,
  },
  {
    icon: 'clock', title: '按时间浏览',
    body: `顶部分类标签里的 <b>Time</b> 不是一个分类，而是换一种看法：不分学习/探索/游戏，
      把所有课程按<b>加进来的时间</b>从新到旧排，分组显示。分组粒度在设置 →「页面设置」→「时间视图分组」里切换：
      <ul>
        <li><b>按月份</b> —— 每个自然月一组。</li>
        <li><b>按学期</b> —— 按交大作息分组：9 月–次年 1 月是秋季学期，2–6 月是春季学期，7–8 月是夏季小学期。</li>
      </ul>
      老课程的时间取自它第一次被加进课程表的那次提交，后来上传的取上传时间。这个视图里不能拖动排序（先后由时间决定）。`,
  },
  {
    icon: 'stack', title: '课程卡片',
    body: `<ul>
        <li>鼠标移到卡片上，简介才会逐字翻出来；移开自动收起，网格保持清爽。</li>
        <li>卡片右上角有两个手柄（仅管理员可见）：<b>三条横线</b>打开「更多选项」，<b>六点</b>是拖动排序。</li>
        <li><b>更多选项</b>里可以改课程名、改简介、换分类、换封面、换图标（60 个 emoji 任选，或上传自己的图片），也可以删除课程。
            上传封面和图标时会弹出裁剪框，可以缩放和框选要留下的范围。</li>
        <li>把卡片拖到顶部的分类标签上松手，也能直接改分类。</li>
      </ul>`,
  },
  {
    icon: 'plus', title: '新建与审核',
    body: `右上角 <b>Create</b> 可以上传 HTML / Markdown / PDF，或直接在站内写 Markdown 笔记。
      管理员上传的直接上线；访客与好友上传的先进审核队列，管理员在设置里的「内容审核」通过后才会公开。`,
  },
  {
    icon: 'search', title: '搜索与 AI',
    body: `<ul>
        <li>顶栏搜索框边打边筛；按 <b>回车</b> 进全文搜索，会搜进每篇笔记的正文。</li>
        <li><b>AI</b> 按钮是跨全部笔记的问答，回答会带出处。对话记录按身份分开存。</li>
      </ul>`,
  },
  {
    icon: 'bookopen', title: '阅读器',
    body: `打开任意课程即进入阅读器，阅读进度和书签自动云端同步。
      <ul>
        <li><b>工具栏唤出</b> —— 设置里那一档决定顶部工具栏多容易被唤出来：灵敏（鼠标靠近 4px 就出来）、适中（14px）、隐藏（只留一个返回键）、永久（彻底不显示，用浏览器返回）。</li>
        <li><b>阅读偏好</b>（字号、行距、暖光）只对当前这一篇生效，并会同步到云端。</li>
        <li><b>分享</b> —— 生成的是只读链接：拿到链接的人不用登录就能看这一篇的全文、主题和阅读设置，但看不到你其它笔记，也回不到笔记库。必须设有效期（最长一年），到期链接失效。</li>
      </ul>`,
  },
  {
    icon: 'bookopen', title: '各页面的说明',
    body: `云盘、Xi Pan、留言板、下载中心这些页面右上角都有一个<b>「说明」</b>按钮 ——
      原先散在页面上的灰色小字（审核规则、挂载地址、可见范围…）都收进去了，需要时点开看，平时不占版面。`,
  },
  {
    icon: 'clock', title: '登录活跃',
    body: `设置面板身份卡下面那块方格是<b>登录活跃</b>，一格一天，颜色越深当天来得越多（登录 + 当天首访都算）。
      右上角切<b>年 / 月</b>两种看法：
      <ul>
        <li><b>年</b> —— 过去一整年，一列一周。装不下所以可以横向滚：手机直接手指滑，电脑用鼠标滚轮或按住拖。</li>
        <li><b>月</b> —— 摊成日历，格子上直接写日期，可以往前翻月份。</li>
      </ul>
      管理员看到的是全站合计，访客与好友只看自己那一级。`,
  },
  {
    icon: 'download', title: '下载中心',
    body: `探索里的<b>下载中心</b>有两条路：
      <ul>
        <li><b>云端转存</b> —— 粘一个直链，服务器替你去下，文件直接落进云盘，页面关掉照跑，回头从云盘取。
            大家共用一条通道，所以按身份限速：速度、单文件大小、每日总量、同时任务数都由管理员在那一页调；
            访客与好友转进公共云盘的文件同样要过内容审核。</li>
        <li><b>本地下载器</b> —— 一个 38 KB 的小包，装到自己电脑上跑（要 Python 3 和 aria2），
            16 线程直连、断点续传、HuggingFace 链接下完自动校验 sha256。几个 G 的大件走这条。</li>
      </ul>`,
  },
  {
    icon: 'list', title: '登录日志与隐私',
    body: `设置里的<b>「登录日志」</b>记两种事，用「方式」列区分：
      <ul>
        <li><b>登录</b> —— 真的输了一次密码。</li>
        <li><b>访问</b> —— 已经登录过的设备当天第一次打开站点。会话能撑 30 天，手机大多只在这一类里出现，
            所以光看「登录」会以为手机从来没上过站。同一台设备一天只记一条。</li>
      </ul>
      每条记录带身份、设备（手机/平板/电脑 + 浏览器和系统）、位置和时间。
      管理员看得到全部身份的记录并附 <b>IP</b>；访客与好友只看得到自己那一级的，且<b>不下发 IP</b>。
      位置精确到城市。学习画像等统计只用你自己的课程数据生成，不上报第三方。`,
  },
];

let docsModal = null;
function openDocs() {
  closeSettings();
  if (!docsModal) {
    docsModal = document.createElement('div');
    docsModal.className = 'modal-overlay';
    docsModal.id = 'docs-modal';
    document.body.appendChild(docsModal);
    docsModal.addEventListener('click', (e) => { if (e.target === docsModal) closeDocs(); });
  }
  docsModal.innerHTML = `<div class="modal doc-modal" role="dialog" aria-modal="true" aria-label="说明文档">
      <div class="doc-head">
        <h3><span class="ic" data-icon="bookopen" data-icon-size="19"></span> 说明文档</h3>
        <button type="button" class="icon-btn" data-doc-close aria-label="关闭"><span class="ic" data-icon="close" data-icon-size="18"></span></button>
      </div>
      <div class="doc-body">
        ${DOC_SECTIONS.map((s) => `<section class="doc-sec">
          <h4><span class="ic" data-icon="${s.icon}" data-icon-size="16"></span>${escapeHTML(s.title)}</h4>
          <div class="doc-text">${s.body}</div>
        </section>`).join('')}
      </div>
      <div class="modal-actions co-actions">
        <button type="button" class="btn-soft" id="doc-profile">看看我的学习画像</button>
        <span class="co-spacer"></span>
        <button type="button" class="btn-ghost" data-doc-close>关闭</button>
      </div>
    </div>`;
  docsModal.hidden = false;
  if (window.NBIconHydrate) NBIconHydrate(docsModal);
  docsModal.querySelectorAll('[data-doc-close]').forEach((b) => b.addEventListener('click', closeDocs));
  docsModal.querySelector('#doc-profile').addEventListener('click', () => { closeDocs(); openAbout(); });
  document.addEventListener('keydown', escDocs);
}
function escDocs(e) { if (e.key === 'Escape') closeDocs(); }
function closeDocs() {
  if (!docsModal) return;
  docsModal.hidden = true;
  document.removeEventListener('keydown', escDocs);
}
const docsBtn = document.getElementById('docs-btn');
if (docsBtn) docsBtn.addEventListener('click', openDocs);

// ========== 登录活跃热力图（设置面板） ==========
// 一格一天，深浅按当天「登录 + 访问」的次数。数据走 /api/logins?heat=1 ——
// 那边读的是 activity_days 按天计数表，不是 logs（logs 只留 30 天，撑不起一整年）。
// 日期一律按北京时间：把时间戳 +8h 之后只读 UTC 字段，跟服务端的分天口径对齐。
const heatBox = document.getElementById('login-heat');
let heatState = 'idle';           // idle / loading / done
const DAY_MS = 86400e3;
const bjDate = (ts) => new Date(ts + 8 * 3600e3);
const bjKey = (d) => d.toISOString().slice(0, 10);

const HEAT_VIEW_KEY = 'nb-heat-view';
let heatData = null;              // 拉回来的原始数据，切视图时不再请求
let heatView = 'year';            // year（一年方格）/ month（当月日历）
let heatMonth = null;             // 月视图当前月份的 1 号（按北京时间的 UTC 字段）

async function loadHeat() {
  if (!heatBox || heatState !== 'idle') return;
  heatState = 'loading';
  heatBox.innerHTML = '<p class="heat-note">读取中…</p>';
  let heat = null;
  try {
    const res = await fetch('/api/logins?heat=1&limit=1', { headers: { Accept: 'application/json' } });
    const d = res.ok ? await res.json() : null;
    heat = d && d.heat;
  } catch {}
  if (!heat) { heatState = 'idle'; heatBox.innerHTML = '<p class="heat-note">读取失败，重开一次设置再试</p>'; return; }
  heatState = 'done';
  heatData = heat;
  renderHeat();
}

const lvlOf = (n, peak) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / peak) * 4)));

function renderHeat() {
  if (!heatData) return;
  if (heatView === 'month') renderHeatMonth(heatData);
  else renderHeatYear(heatData);
}

function renderHeatYear(heat) {
  const end = bjDate(Date.now());
  // 起点：往前 span-1 天，再退到那一周的周日，凑成整列
  const rough = new Date(end.getTime() - ((heat.span || 371) - 1) * DAY_MS);
  const start = new Date(rough.getTime() - rough.getUTCDay() * DAY_MS);
  const peak = Math.max(1, heat.max || 0);

  const cells = [];
  const months = [];
  let col = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
    const d = new Date(t);
    const key = bjKey(d);
    const n = heat.days[key] || 0;
    cells.push(`<i class="hc l${lvlOf(n, peak)}" style="grid-column:${col + 1};grid-row:${d.getUTCDay() + 1}" title="${key} · ${n} 次"></i>`);
    // 每月 1 号所在的那一列打一个月份标
    if (d.getUTCDate() === 1) months.push(`<em class="hm" style="grid-column:${col + 1} / span 5">${d.getUTCMonth() + 1}月</em>`);
    if (d.getUTCDay() === 6) col++;
  }

  heatBox.innerHTML = `<div class="heat-top">
      <span>过去一年 <b>${heat.total || 0}</b> 次</span>
      <span class="heat-legend">少<i class="hc l0"></i><i class="hc l1"></i><i class="hc l2"></i><i class="hc l3"></i><i class="hc l4"></i>多</span>
    </div>
    <div class="heat-scroll"><div class="heat-grid" style="grid-template-columns:repeat(${col + 1}, var(--hc, 9px))">${cells.join('')}${months.join('')}</div></div>`;
  // 最新的一周在最右边，默认滚到底
  const scroller = heatBox.querySelector('.heat-scroll');
  if (scroller) { scroller.scrollLeft = scroller.scrollWidth; wireHeatDrag(scroller); }
}

// 月视图：一整月摊成日历。年视图那一格只有 9px，具体是哪天全靠 title 悬停，
// 手机上根本悬不了 —— 这一屏格子大到能直接写日期。
function renderHeatMonth(heat) {
  const today = bjDate(Date.now());
  const firstOfThis = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  if (!heatMonth) heatMonth = firstOfThis;
  // 数据只有过去 span 天，再往前翻没意义
  const oldest = new Date(today.getTime() - ((heat.span || 371) - 1) * DAY_MS);
  const earliest = new Date(Date.UTC(oldest.getUTCFullYear(), oldest.getUTCMonth(), 1));
  const y = heatMonth.getUTCFullYear(), m = heatMonth.getUTCMonth();
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const lead = heatMonth.getUTCDay();
  const peak = Math.max(1, heat.max || 0);

  let sum = 0;
  const cells = ['日', '一', '二', '三', '四', '五', '六'].map((w) => `<em class="hw">${w}</em>`);
  for (let i = 0; i < lead; i++) cells.push('<span class="hd pad"></span>');
  for (let day = 1; day <= days; day++) {
    const d = new Date(Date.UTC(y, m, day));
    const key = bjKey(d);
    const future = d.getTime() > today.getTime();
    const n = future ? 0 : (heat.days[key] || 0);
    sum += n;
    const isToday = key === bjKey(today);
    cells.push(`<span class="hd l${future ? 0 : lvlOf(n, peak)}${isToday ? ' today' : ''}" title="${key} · ${n} 次">${day}</span>`);
  }

  const prevOK = new Date(Date.UTC(y, m - 1, 1)).getTime() >= earliest.getTime();
  const nextOK = new Date(Date.UTC(y, m + 1, 1)).getTime() <= firstOfThis.getTime();
  heatBox.innerHTML = `<div class="heat-top">
      <span class="heat-nav">
        <button type="button" data-heat-step="-1" ${prevOK ? '' : 'disabled'} aria-label="上一月">${window.NBIcon ? NBIcon("caretleft", { size: 14 }) : "‹"}</button>
        <b>${y} 年 ${m + 1} 月</b>
        <button type="button" data-heat-step="1" ${nextOK ? '' : 'disabled'} aria-label="下一月">${window.NBIcon ? NBIcon("caretright", { size: 14 }) : "›"}</button>
      </span>
      <span>本月 <b>${sum}</b> 次</span>
    </div>
    <div class="heat-cal">${cells.join('')}</div>`;
  heatBox.querySelectorAll('[data-heat-step]').forEach((b) => b.addEventListener('click', () => {
    heatMonth = new Date(Date.UTC(y, m + Number(b.dataset.heatStep), 1));
    renderHeat();
  }));
}

// 桌面端没有横向滚轮，鼠标滚上去只会把整个设置面板往下滚 —— 把竖滚轮换算成
// 横向滚动，再补一个按住拖动。手机的手指滑动是浏览器原生的，不用管。
function wireHeatDrag(el) {
  el.addEventListener('wheel', (e) => {
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 0) return;
    // 已经滚到头就把滚轮还给外层面板，不然停在热力图上会卡住整页滚动
    if ((dx < 0 && el.scrollLeft <= 0) || (dx > 0 && el.scrollLeft >= max - 1)) return;
    e.preventDefault();
    el.scrollLeft += dx;
  }, { passive: false });

  let down = false, startX = 0, startLeft = 0, moved = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;              // 触摸交给原生惯性滚动
    down = true; moved = false;
    startX = e.clientX; startLeft = el.scrollLeft;
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 3) { moved = true; el.setPointerCapture(e.pointerId); }
    el.scrollLeft = startLeft - dx;
  });
  const up = () => { down = false; el.classList.remove('dragging'); };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('click', (e) => { if (moved) { e.preventDefault(); e.stopPropagation(); } }, true);
}

// 年 / 月视图切换（存本机，下次打开还是这一屏）
(function initHeatViews() {
  const box = document.getElementById('heat-views');
  if (!box) return;
  const saved = localStorage.getItem(HEAT_VIEW_KEY);
  heatView = saved === 'month' ? 'month' : 'year';
  const sync = () => box.querySelectorAll('[data-heat-view]').forEach((b) => {
    const on = b.dataset.heatView === heatView;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  sync();
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-heat-view]');
    if (!btn || btn.dataset.heatView === heatView) return;
    heatView = btn.dataset.heatView;
    localStorage.setItem(HEAT_VIEW_KEY, heatView);
    heatMonth = null;               // 每次切回月视图都从当月看起
    sync();
    renderHeat();
  });
})();

// ========== 登录日志 ==========
// 三级都能看：管理员看全部身份，一二级只看自己那一级（后端过滤，见 api/logins.js）。
// 管理员那一级额外带 IP，一二级的返回里 ip 是空串。
let loginsModal = null;
// 日志里设备类型对应的图标（服务端 deviceKind：phone / tablet / desktop）
const DEV_ICON = { phone: 'phone', tablet: 'tablet', desktop: 'laptop' };
function fmtWhen(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function openLogins() {
  closeSettings();          // 不关的话高级界面里菜单(z-index 130)会压在弹窗上
  if (!loginsModal) {
    loginsModal = document.createElement('div');
    loginsModal.className = 'modal-overlay';
    loginsModal.id = 'logins-modal';
    document.body.appendChild(loginsModal);
    loginsModal.addEventListener('click', (e) => { if (e.target === loginsModal) closeLogins(); });
  }
  loginsModal.innerHTML = `<div class="modal lg-modal" role="dialog" aria-modal="true" aria-label="登录日志">
    <h3>登录日志</h3><p class="lg-loading">正在读取…</p></div>`;
  loginsModal.hidden = false;
  document.addEventListener('keydown', escLogins);

  let data;
  try {
    const res = await fetch('/api/logins?limit=120', { headers: { Accept: 'application/json' } });
    data = res.ok ? await res.json() : null;
  } catch { data = null; }

  const box = loginsModal.querySelector('.lg-modal');
  if (!data) {
    box.innerHTML = `<h3>登录日志</h3><p class="lg-loading">读取失败，请稍后重试。</p>
      <div class="modal-actions co-actions"><span class="co-spacer"></span>
      <button type="button" class="btn-ghost" data-lg-close>关闭</button></div>`;
    box.querySelectorAll('[data-lg-close]').forEach((b) => b.addEventListener('click', closeLogins));
    return;
  }

  const ip = !!data.canSeeIp;
  const rows = data.items.map((it) => `<tr>
      <td><span class="lg-kind lg-k-${it.kind === 'visit' ? 'visit' : 'login'}">${it.kind === 'visit' ? '访问' : '登录'}</span></td>
      <td><span class="lg-role lg-${escapeAttr(it.role)}">${escapeHTML(it.roleName)}</span></td>
      <td class="lg-dev"><span class="lg-devic ic" data-icon="${DEV_ICON[it.deviceKind] || 'laptop'}" data-icon-size="14"></span>${escapeHTML(it.device)}</td>
      <td>${escapeHTML(it.place)}${ip ? `<em class="lg-ip">${escapeHTML(it.ip || '—')}</em>` : ''}</td>
      <td class="lg-when">${escapeHTML(fmtWhen(it.at))}</td>
    </tr>`).join('');
  box.innerHTML = `<h3>登录日志</h3>
    <p class="lg-scope">${data.scope === 'all' ? '管理员视角：全部身份的记录' : '只显示你这一级身份的记录'}</p>
    <div class="lg-wrap">
      <table class="lg-table">
        <thead><tr><th>方式</th><th>身份</th><th>设备</th><th>位置${ip ? ' / IP' : ''}</th><th>时间</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="lg-empty">还没有记录</td></tr>'}</tbody>
      </table>
    </div>
    <div class="modal-actions co-actions"><span class="co-spacer"></span>
      <button type="button" class="btn-ghost" data-lg-close>关闭</button></div>`;
  if (window.NBIconHydrate) NBIconHydrate(box);
  box.querySelectorAll('[data-lg-close]').forEach((b) => b.addEventListener('click', closeLogins));
}
function escLogins(e) { if (e.key === 'Escape') closeLogins(); }
function closeLogins() {
  if (!loginsModal) return;
  loginsModal.hidden = true;
  document.removeEventListener('keydown', escLogins);
}
const loginsBtn = document.getElementById('logins-btn');
if (loginsBtn) loginsBtn.addEventListener('click', openLogins);

function escCourseOptions(e) { if (e.key === 'Escape') closeCourseOptions(); }
function closeCourseOptions() {
  if (!courseModal) return;
  courseModal.classList.remove('open');
  courseModal.hidden = true;
  document.removeEventListener('keydown', escCourseOptions);
}

// ========== 课程排序（拖拽，鼠标 + 触屏） ==========
// 顺序按 file 持久化到 /api/order；未在已存顺序中的（如新建课程）排在最前。
function applyOrder(list, order) {
  if (!Array.isArray(order) || !order.length) return list;
  const idx = new Map(order.map((f, i) => [f, i]));
  // 稳定排序：已知项按存档顺序；未知项（新课程）置顶且保持默认相对次序
  return list
    .map((c, i) => ({ c, i, k: idx.has(c.file) ? idx.get(c.file) : -1 }))
    .sort((a, b) => (a.k - b.k) || (a.i - b.i))
    .map((x) => x.c);
}

const coursesGrid = document.getElementById('courses');
let dragState = null;
let dragOverTab = null;        // 拖拽中悬停的分类 Tab（拖到 Tab 上松手即改分类）
let suppressClickUntil = 0;

function clearTabDropHighlight() {
  document.querySelectorAll('#home-tabs .tab.drop-target, .dock-tab.drop-target').forEach((t) => t.classList.remove('drop-target'));
}

let toastT = null;
function toast(msg) {
  let el = document.getElementById('nb-toast');
  if (!el) { el = document.createElement('div'); el.id = 'nb-toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 2200);
}

// 拖动课程卡到某个 Tab → 改该课程分类（乐观更新 + 写后端覆盖表）
function recategorize(file, cat) {
  const card = coursesGrid.querySelector('.nb-card[data-file="' + file + '"]');
  if (!card || (card.dataset.category || 'learn') === cat) return;
  card.dataset.category = cat;
  applyFilters();
  const label = { learn: 'Learn', explore: 'Explore', play: 'Play' }[cat] || cat;
  toast('Moved to ' + label);
  fetch('/api/category', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, category: cat }),
  }).catch(() => {});
}

function persistOrder() {
  const order = Array.from(coursesGrid.querySelectorAll('.nb-card'))
    .map((el) => el.dataset.file)
    .filter(Boolean);
  fetch('/api/order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order }),
  }).catch(() => {});
}

coursesGrid.addEventListener('pointerdown', (e) => {
  if (e.button != null && e.button > 0) return;          // 仅主键/触摸
  if (activeTab === 'time') return;                      // 时间视图的先后由时间决定，不接受手动排序
  const handle = e.target.closest('.nb-drag');
  if (!handle) return;
  const card = handle.closest('.nb-card');
  if (!card) return;
  e.preventDefault();

  const rect = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add('nb-card-ghost');
  Object.assign(ghost.style, {
    position: 'fixed', left: rect.left + 'px', top: rect.top + 'px',
    width: rect.width + 'px', height: rect.height + 'px',
    margin: '0', pointerEvents: 'none', zIndex: '200',
  });
  document.body.appendChild(ghost);
  card.classList.add('nb-card-placeholder');
  document.body.classList.add('sorting');

  dragState = { card, ghost, offX: e.clientX - rect.left, offY: e.clientY - rect.top, moved: false };
  try { handle.setPointerCapture(e.pointerId); } catch {}
});

window.addEventListener('pointermove', (e) => {
  if (!dragState) return;
  const { ghost, card } = dragState;
  dragState.moved = true;
  ghost.style.left = (e.clientX - dragState.offX) + 'px';
  ghost.style.top = (e.clientY - dragState.offY) + 'px';

  const under = document.elementFromPoint(e.clientX, e.clientY);

  // 拖到分类 Tab 上：高亮该 Tab，本次不参与网格重排（松手时改分类）。
  // 高级界面下经典分类条隐藏、由 Dock 瓦片（.dock-tab）代行，两者都算目标
  const tabEl = under && under.closest ? under.closest('#home-tabs .tab, .dock-tab') : null;
  clearTabDropHighlight();
  if (tabEl && tabEl.dataset.tab && tabEl.dataset.tab !== 'all' && tabEl.dataset.tab !== 'time') {
    dragOverTab = tabEl.dataset.tab;
    tabEl.classList.add('drop-target');
    return;
  }
  dragOverTab = null;

  const target = under && under.closest('.nb-card');
  if (target && target !== card && target.parentElement === coursesGrid && target.style.display !== 'none') {
    const r = target.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // 网格：先按行（Y），同一行内再按列（X）判断插入到目标前/后
    const after = (e.clientY > cy + 6) || (Math.abs(e.clientY - cy) <= r.height / 2 && e.clientX > cx);
    coursesGrid.insertBefore(card, after ? target.nextSibling : target);
  }
});

function endDrag() {
  if (!dragState) return;
  const { ghost, card, moved } = dragState;
  ghost.remove();
  card.classList.remove('nb-card-placeholder');
  document.body.classList.remove('sorting');
  const tabTarget = dragOverTab;
  dragOverTab = null;
  clearTabDropHighlight();
  dragState = null;
  if (tabTarget) {
    suppressClickUntil = Date.now() + 350;
    if (moved) persistOrder();
    recategorize(card.dataset.file, tabTarget);
    return;
  }
  if (moved) { suppressClickUntil = Date.now() + 350; persistOrder(); }
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

// 拖动手柄/刚拖完时，吞掉卡片的点击导航
coursesGrid.addEventListener('click', (e) => {
  if (e.target.closest('.nb-drag') || Date.now() < suppressClickUntil) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

// ========== 创建课程弹窗 ==========
const modal = document.getElementById('create-modal');
const hint = document.getElementById('nc-hint');
const submitBtn = document.getElementById('nc-submit');

function openModal() {
  resetForm();
  // 游客上传需经管理员审核，提前告知
  if (!isAdmin) {
    hint.textContent = '游客上传的内容会进入审核队列，管理员（三级）通过后才会公开显示。';
  }
  modal.hidden = false;
  document.getElementById('nc-title').focus();
}
function closeModal() { modal.hidden = true; }
function resetForm() {
  ['nc-title', 'nc-subject', 'nc-desc'].forEach((id) => (document.getElementById(id).value = ''));
  document.getElementById('nc-file').value = '';
  setTags([]);
  selectIcon('📘');
  selectCat('learn');
  setAIStatus('');
  hint.textContent = '支持 HTML / Markdown（≤25 MB，大网页自动转存）或 PDF（≤20 MB）。选好文件后可让 AI 自动填充。';
  hint.classList.remove('err');
}
function setHint(msg, isErr) { hint.textContent = msg; hint.classList.toggle('err', !!isErr); }

// Create 按钮：下拉两路（上传文件 / 写 Markdown 笔记）
const createBtn = document.getElementById('create-btn');
const createMenu = document.getElementById('create-menu');
function openCreateMenu() { createMenu.hidden = false; createBtn.setAttribute('aria-expanded', 'true'); }
function closeCreateMenu() { createMenu.hidden = true; createBtn.setAttribute('aria-expanded', 'false'); }
createBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  closeSettings();
  createMenu.hidden ? openCreateMenu() : closeCreateMenu();
});
createMenu.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', closeCreateMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCreateMenu(); });
document.getElementById('cm-upload').addEventListener('click', () => { closeCreateMenu(); openModal(); });

document.getElementById('nc-cancel').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden) closeModal();
});

// 选文件后：按类型提示大小上限，先给个默认类型图标，再自动触发 AI 填充
document.getElementById('nc-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const kind = detectKind(f.name);
  const max = kind === 'pdf' ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
  const label = { html: 'HTML', md: 'Markdown', pdf: 'PDF' }[kind];
  setHint(`已选 ${label}（${(f.size / 1e6).toFixed(2)} MB / 上限 ${(max / 1e6).toFixed(1)} MB）`, f.size > max);
  if (['📘', '📝', '📕'].includes(iconInput.value)) selectIcon(KIND_ICON[kind]);
  if (f.size <= max) runAIFill(false);
});

submitBtn.addEventListener('click', async () => {
  const title = document.getElementById('nc-title').value.trim();
  const f = document.getElementById('nc-file').files[0];
  if (!title) return setHint('请填写课程名称', true);
  if (!f) return setHint('请选择一个文件', true);
  const kind = detectKind(f.name);
  const max = kind === 'pdf' ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
  if (f.size > max) {
    return setHint(`文件太大（${(f.size / 1e6).toFixed(2)} MB），上限 ${(max / 1e6).toFixed(1)} MB`, true);
  }

  submitBtn.disabled = true;
  submitBtn.textContent = '创建中…';
  try {
    const fd = new FormData();
    fd.append('title', title);
    fd.append('subject', document.getElementById('nc-subject').value.trim());
    fd.append('description', document.getElementById('nc-desc').value.trim());
    fd.append('icon', document.getElementById('nc-icon').value.trim());
    fd.append('tags', JSON.stringify(ncTags));
    fd.append('kind', kind);
    fd.append('category', ncCat);
    fd.append('file', f, f.name);
    const res = await fetch('/api/courses', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '创建失败');
    closeModal();
    if (data.pending) {
      // 游客上传：进入审核队列，不会立即出现在列表，给出提示即可
      toast('已提交，等待管理员审核');
    } else {
      await loadAndRender();
    }
  } catch (e) {
    setHint(e.message || '创建失败，请重试', true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '创建';
  }
});

// ========== 图标点选 + 标签 + AI 智能填充 ==========
// ICONS 必须与后端 functions/api/analyze.js 的 ICONS 一致（只用广泛支持的单字/VS16 emoji，不用 ZWJ 组合，避免老系统显示豆腐块）
const ICONS = [
  // 书 / 笔记 / 书写
  '📘', '📗', '📙', '📕', '📓', '📔', '📒', '📚', '📖', '📝', '✏️', '🖊️',
  // 纸张 / 整理
  '📄', '📑', '📋', '🔖', '🏷️', '📌', '📎', '🗂️',
  // 数学
  '📐', '📏', '🧮', '🔢', '📊', '📈', '📉', '➗',
  // 物理
  '⚛️', '🧲', '⚡', '🌊', '🔭', '🌡️', '🔋', '💥', '🪐', '⚖️',
  // 化学 / 生物
  '🧪', '⚗️', '🧬', '🔬', '🧫', '🦠', '🌱', '🌿', '🍃',
  // 地理 / 天文 / 航天
  '🌍', '🌎', '🌏', '🗺️', '🧭', '🌌', '🛰️', '☄️',
  // 工程 / 工具 / 机械
  '⚙️', '🏗️', '🔧', '🔩', '🛠️', '🔨', '🧰', '🏭', '🚢', '🚀', '✈️', '⚓',
  // 计算机 / 信息
  '💻', '🖥️', '⌨️', '🖱️', '💾', '🌐', '🤖', '🧠', '📡', '📱', '🔌', '🐍',
  // 艺术 / 音乐 / 语言
  '🎨', '🎭', '🎵', '🎼', '🎻', '🎹', '🗣️', '💬', '🔤', '📷',
  // 经济 / 医学
  '💰', '💵', '💳', '🏦', '🩺', '💊', '💉',
  // 学习 / 益智 / 杂项
  '💡', '🎯', '🎲', '🧩', '♟️', '🎮', '🏆', '🎓', '📅', '⏰', '🔑',
];
let ncTags = [];

const iconPicker = document.getElementById('nc-icon-picker');
const iconInput = document.getElementById('nc-icon');
const tagsBox = document.getElementById('nc-tags');
const aiBtn = document.getElementById('nc-ai');
const aiStatus = document.getElementById('nc-ai-status');

function renderIconPicker() {
  iconPicker.innerHTML = ICONS
    .map((e) => `<button type="button" class="icon-opt" data-emoji="${e}">${e}</button>`)
    .join('');
}
function selectIcon(emoji) {
  if (!emoji) return;
  iconInput.value = emoji;
  iconPicker.querySelectorAll('.icon-opt').forEach((b) => {
    b.classList.toggle('selected', b.dataset.emoji === emoji);
  });
}
iconPicker.addEventListener('click', (e) => {
  const b = e.target.closest('.icon-opt');
  if (b) selectIcon(b.dataset.emoji);
});

// 分类选择（创建课程：Learn / Explore / Play）
const catSeg = document.getElementById('nc-cat');
function selectCat(cat) {
  ncCat = ['learn', 'explore', 'play'].includes(cat) ? cat : 'learn';
  catSeg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.cat === ncCat));
}
catSeg.addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn');
  if (b) selectCat(b.dataset.cat);
});

function renderTags() {
  if (!ncTags.length) {
    tagsBox.innerHTML = '<span class="tag-empty">选文件后由 AI 生成，或留空</span>';
    return;
  }
  tagsBox.innerHTML = ncTags
    .map((t, i) => `<span class="tag-chip">${escapeHTML(t)}<button type="button" data-i="${i}" aria-label="移除">×</button></span>`)
    .join('');
}
function setTags(arr) {
  ncTags = (arr || []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6);
  renderTags();
}
tagsBox.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  ncTags.splice(Number(b.dataset.i), 1);
  renderTags();
});

function setAIStatus(msg, isErr) {
  aiStatus.textContent = msg || '';
  aiStatus.classList.toggle('err', !!isErr);
}

// 抽取正文纯文本（html 去标签，md 原样），交给 AI 分析
function extractText(raw, kind) {
  if (kind === 'html') {
    try {
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      doc.querySelectorAll('script,style,noscript').forEach((el) => el.remove());
      return (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
    } catch {
      return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  return String(raw).replace(/\s+/g, ' ').trim();
}

// 调 /api/analyze 让 AI 填学科/简介/标签/图标。force=true 时覆盖已填内容（重新填充按钮）
async function runAIFill(force = false) {
  const f = document.getElementById('nc-file').files[0];
  const title = document.getElementById('nc-title').value.trim();
  if (!f && !title) { setAIStatus('先填课程名或选个文件', true); return; }
  const kind = f ? detectKind(f.name) : 'html';

  let excerpt = '';
  if (f && kind !== 'pdf') {
    try { excerpt = extractText(await f.text(), kind).slice(0, 4000); } catch {}
  }

  aiBtn.disabled = true;
  setAIStatus('AI 分析中…');
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title || (f ? f.name.replace(/\.[^.]+$/, '') : ''), kind, excerpt }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || '分析失败');

    const subjEl = document.getElementById('nc-subject');
    const descEl = document.getElementById('nc-desc');
    if (d.subject && (force || !subjEl.value.trim())) subjEl.value = d.subject;
    if (d.description && (force || !descEl.value.trim())) descEl.value = d.description;
    if (Array.isArray(d.tags) && d.tags.length) setTags(d.tags);
    if (d.icon) selectIcon(d.icon);
    setAIStatus(kind === 'pdf' ? '✓ 已按课程名填充（PDF 暂不读正文）' : '✓ 已填充，可手动调整');
  } catch (e) {
    setAIStatus(e.message || '分析失败，可手动填写', true);
  } finally {
    aiBtn.disabled = false;
  }
}
aiBtn.addEventListener('click', () => runAIFill(true));

// ========== 卡片模板 ==========
function cardHTML(c, deletable = false) {
  const pct = c.scroll_pct ? Math.round(c.scroll_pct * 100) : 0;
  const searchText = [c.title, c.subject, c.description, ...(c.tags || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const progressBlock = pct > 0
    ? `<div class="nb-progress">
         <div class="nb-progress-bar"><i style="width:${pct}%"></i></div>
         <span>${pct}% read</span>
       </div>`
    : '';

  const ic = (n, s) => (window.NBIcon ? NBIcon(n, { size: s }) : '');

  // link 卡（如「云盘」）是固定入口，不提供删除/编辑，避免误隐藏
  const isLinkCard = !!c.link;

  // 管理操作统一收进「更多选项」弹窗（重命名/简介/封面/图标/删除），
  // 卡片上只留两个手柄：更多 + 拖动。游客（isAdmin=false）两个都不渲染。
  const moreBtn = (deletable && isAdmin)
    ? `<button type="button" class="nb-more" data-file="${escapeAttr(c.file)}" title="更多选项" aria-label="更多选项">${ic('list', 15)}</button>`
    : '';

  // 主网格（deletable=true）的卡片可拖动排序；游客不可
  const dragHandle = (deletable && isAdmin)
    ? `<button type="button" class="nb-drag" title="拖动排序" aria-label="拖动排序">${ic('drag', 16)}</button>`
    : '';

  // 图标：支持图片（站内地址或 .svg/.png 等，如三国杀课程）或 emoji
  const iconStr = c.icon || '📄';
  const iconHTML = isIconImage(iconStr)
    ? `<img class="nb-card-icon" src="${escapeAttr(iconStr)}" alt="" style="width:38px;height:38px;object-fit:contain;border-radius:9px">`
    : `<span class="nb-card-icon">${escapeHTML(iconStr)}</span>`;

  // 普通课程进阅读器；link 卡（云盘）直接跳到目标页面
  const href = c.link ? c.link : `/reader.html?file=${encodeURIComponent(c.file)}`;

  // 封面图（仅高级界面显示，经典模式 CSS 隐藏）：默认 /assets/covers/<file去扩展名>.webp；
  // 管理员换过的走 /api/cover（URL 带 updated_at，改一次换一个地址，天然绕开缓存）。
  // 两者都加载失败时退回卡片自带的 accent 渐变底。
  const coverSlug = String(c.file || '').replace(/\.[a-z0-9]+$/i, '');
  const coverTs = customCovers[coverSlug.toLowerCase()];
  const coverURL = coverTs
    ? `/api/cover?slug=${encodeURIComponent(coverSlug.toLowerCase())}&v=${coverTs}`
    : `/assets/covers/${escapeAttr(coverSlug)}.webp?v=${COVER_ASSET_VERSION}`;
  // 换封面也搬进了「更多选项」弹窗，卡片角上不再单独放按钮
  const coverBlock = `<div class="nb-card-cover" aria-hidden="true"><img src="${escapeAttr(coverURL)}" alt="" loading="lazy" onerror="this.parentElement.classList.add('noimg')"></div>`;

  return `
    <a class="nb-card" href="${escapeAttr(href)}"
       style="--accent: ${c.color || '#6750A4'}"
       data-file="${escapeAttr(c.file)}"
       data-category="${escapeAttr(c.category || 'learn')}"
       data-created="${Number(c.created_at) || 0}"
       data-search="${escapeAttr(searchText)}">
      ${coverBlock}
      ${moreBtn}${dragHandle}
      ${iconHTML}
      <div class="nb-card-body">
        <span class="nb-card-subject">${escapeHTML(c.subject || '笔记')}</span>
        <h3 class="nb-card-title">${escapeHTML(c.title)}</h3>
        <p class="nb-card-meta">${foldHTML(c.description || '')}</p>
        ${progressBlock}
      </div>
    </a>
  `;
}

// 图标可能是 emoji，也可能是图片：站内路径（/assets/... 或 /api/cover?...）都算图片
function isIconImage(s) {
  const v = String(s || '');
  return v.startsWith('/') || /\.(svg|png|jpe?g|webp|gif)$/i.test(v);
}

// 简介的折叠文字：中文逐字折、拉丁按词折（按字母切会把单词拆散、读不出来）。
// 每片带 --i 序号，CSS 用它算 transition-delay，做出逐个翻下来的效果。
function foldHTML(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const parts = raw.match(/[A-Za-z0-9][A-Za-z0-9@._#/+-]*|\s+|[\s\S]/g) || [];
  let i = 0;
  return parts.map((p) => {
    if (/^\s+$/.test(p)) return '<span class="fw"> </span>';
    return `<span class="fc" style="--i:${i++}">${escapeHTML(p)}</span>`;
  }).join('');
}

function escapeHTML(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) {
  return escapeHTML(s).replace(/`/g, '&#96;');
}
// 图标可能是 emoji，也可能是图片路径（.svg/.png 等，如游戏类课程）
function isImgIcon(ic) { return typeof ic === 'string' && /\.(svg|png|jpe?g|webp)$/i.test(ic); }
function iconImgHTML(ic, size, cls) { return `<img${cls ? ` class="${cls}"` : ''} src="${escapeAttr(ic)}" alt="" style="width:${size}px;height:${size}px;object-fit:contain;border-radius:${Math.round(size / 4)}px;vertical-align:middle">`; }
// 纯文本场景（标题/标签里）图片图标退化为占位 emoji
function iconText(ic) { return isImgIcon(ic) ? '🎮' : (ic || '📄'); }

// 启动
renderIconPicker();
selectIcon('📘');
loadAndRender();
