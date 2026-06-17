// 首页：加载课程（静态 courses.json + 用户创建的 /api/courses）+ 进度，渲染卡片
// 并提供「创建课程」（上传 HTML 存入 D1）与删除动态课程的能力。

const MAX_TEXT_BYTES = 25_000_000;   // html / md：≤1.4MB 存 D1，超过自动转存 R2，整体上限 25MB
const MAX_PDF_BYTES = 20_000_000;   // pdf 存 R2
const KIND_ICON = { html: '📘', md: '📝', pdf: '📕' };

let studyProfile = null;       // 「关于」弹窗用：基于你自己的课程数据生成的学习画像
let staticCoursesData = [];     // 静态课程元数据，供「全能问答」随请求带给后端
let allCoursesMap = new Map();  // file -> 课程元数据，深入搜索结果展示用
let activeTab = 'all';          // 当前分类 Tab：all / learn / explore / play
let searchQ = '';               // 即时搜索词（小写）
let hasRecent = false;          // 是否存在「最近阅读」
let totalCourses = 0;           // 课程总数（空状态判断用）
let ncCat = 'learn';            // 创建课程时选择的分类
let isAdmin = false;            // 当前账号是否为管理员（游客只能浏览/使用，不能增删改课程）

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
    const [c1, c2, pr, od, me] = await Promise.all([
      fetch('/courses.json').then((r) => (r.ok ? r.json() : [])),
      fetch('/api/courses').then((r) => (r.ok ? r.json() : [])),
      fetch('/api/progress').then((r) => (r.ok ? r.json() : [])),
      fetch('/api/order').then((r) => (r.ok ? r.json() : { order: [] })),
      fetch('/api/me').then((r) => (r.ok ? r.json() : { role: 'guest' })).catch(() => ({ role: 'guest' })),
    ]);
    staticCourses = c1 || [];
    dynamic = c2 || [];
    progress = pr || [];
    order = (od && od.order) || [];
    hidden = (od && od.hidden) || [];
    categoryOverrides = (od && od.categories) || {};
    isAdmin = (me && me.role) === 'admin';
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

  const progressMap = {};
  for (const p of progress) progressMap[p.file] = p;

  // 最近阅读（按 updated_at 排序，取前 4）
  const recent = progress
    .filter((p) => p.updated_at)
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 4)
    .map((p) => ({ ...courses.find((c) => c.file === p.file), ...p }))
    .filter((c) => c.title);

  staticCoursesData = staticCourses;
  allCoursesMap = new Map(courses.map((c) => [c.file, c]));
  studyProfile = buildProfile(courses, progress, recent);

  hasRecent = recent.length > 0;
  if (hasRecent) {
    document.getElementById('recent').innerHTML = recent.map((c) => cardHTML(c)).join('');
  }

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

// 课程卡按「当前 Tab 分类」与「搜索词」联合显隐；Recent 仅在 All 且无搜索时出现
function applyFilters() {
  let visible = 0;
  document.querySelectorAll('#courses .nb-card').forEach((card) => {
    const catOk = activeTab === 'all' || (card.dataset.category || 'learn') === activeTab;
    const sOk = !searchQ || (card.dataset.search || '').includes(searchQ);
    const show = catOk && sOk;
    card.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  document.getElementById('recent-section').hidden = !(hasRecent && activeTab === 'all' && !searchQ);
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
  return c ? `${c.icon || '📄'} ${c.title}` : file;
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

function openSettings() {
  settingsMenu.hidden = false;
  settingsBtn.setAttribute('aria-expanded', 'true');
}
function closeSettings() {
  settingsMenu.hidden = true;
  settingsBtn.setAttribute('aria-expanded', 'false');
}
settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  closeCreateMenu();
  settingsMenu.hidden ? openSettings() : closeSettings();
});
// 点菜单内部不关闭（主题分段控件要连点）；点外部 / Esc 关闭
settingsMenu.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => closeSettings());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

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
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
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
        <span class="rv-icon">${escapeHTML(c.icon || '📄')}</span>
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

document.getElementById('about-btn').addEventListener('click', () => {
  closeSettings();
  renderAbout();
  aboutModal.hidden = false;
});
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

// ========== 删除 / 编辑动态课程（事件委托） ==========
document.getElementById('courses').addEventListener('click', async (e) => {
  const edit = e.target.closest('.nb-edit');
  if (edit) {
    e.preventDefault();
    e.stopPropagation();
    location.href = `/editor.html?file=${encodeURIComponent(edit.dataset.file)}`;
    return;
  }
  const del = e.target.closest('.nb-del');
  if (!del) return;
  e.preventDefault();
  e.stopPropagation();
  if (!confirm('删除这个课程？将一并清除它的阅读进度与书签，且不可恢复。')) return;
  try {
    const res = await fetch('/api/courses', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: del.dataset.file }),
    });
    if (!res.ok) throw new Error();
    await loadAndRender();
  } catch {
    alert('删除失败，请重试');
  }
});

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
  document.querySelectorAll('#home-tabs .tab.drop-target').forEach((t) => t.classList.remove('drop-target'));
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

  // 拖到顶部分类 Tab 上：高亮该 Tab，本次不参与网格重排（松手时改分类）
  const tabEl = under && under.closest ? under.closest('#home-tabs .tab') : null;
  clearTabDropHighlight();
  if (tabEl && tabEl.dataset.tab && tabEl.dataset.tab !== 'all') {
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

  // 删除/编辑/拖动排序均为管理操作：游客（isAdmin=false）一律不渲染这些控件
  const delBtn = (deletable && isAdmin && !isLinkCard)
    ? `<button class="nb-del" data-file="${escapeAttr(c.file)}" title="删除课程" aria-label="删除课程">${ic('close', 16)}</button>`
    : '';

  // 站内创建/上传的 Markdown 课程可直接进编辑器改
  const editBtn = (deletable && isAdmin && c.dynamic && c.kind === 'md')
    ? `<button class="nb-edit" data-file="${escapeAttr(c.file)}" title="编辑笔记" aria-label="编辑笔记">${ic('edit', 15)}</button>`
    : '';

  // 主网格（deletable=true）的卡片可拖动排序；「最近阅读」不可；游客不可
  const dragHandle = (deletable && isAdmin)
    ? `<button type="button" class="nb-drag" title="拖动排序" aria-label="拖动排序">${ic('drag', 16)}</button>`
    : '';

  // 图标：支持图片（.svg/.png 等，如三国杀课程）或 emoji
  const iconStr = c.icon || '📄';
  const iconHTML = /\.(svg|png|jpe?g|webp)$/i.test(iconStr)
    ? `<img class="nb-card-icon" src="${escapeAttr(iconStr)}" alt="" style="width:38px;height:38px;object-fit:contain;border-radius:9px">`
    : `<span class="nb-card-icon">${escapeHTML(iconStr)}</span>`;

  // 普通课程进阅读器；link 卡（云盘）直接跳到目标页面
  const href = c.link ? c.link : `/reader.html?file=${encodeURIComponent(c.file)}`;

  return `
    <a class="nb-card" href="${escapeAttr(href)}"
       style="--accent: ${c.color || '#6750A4'}"
       data-file="${escapeAttr(c.file)}"
       data-category="${escapeAttr(c.category || 'learn')}"
       data-search="${escapeAttr(searchText)}">
      ${dragHandle}${delBtn}${editBtn}
      ${iconHTML}
      <div class="nb-card-body">
        <span class="nb-card-subject">${escapeHTML(c.subject || '笔记')}</span>
        <h3 class="nb-card-title">${escapeHTML(c.title)}</h3>
        <p class="nb-card-meta">${escapeHTML(c.description || '')}</p>
        ${progressBlock}
      </div>
    </a>
  `;
}

function escapeHTML(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) {
  return escapeHTML(s).replace(/`/g, '&#96;');
}

// 启动
renderIconPicker();
selectIcon('📘');
loadAndRender();
