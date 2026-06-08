// 首页：加载课程（静态 courses.json + 用户创建的 /api/courses）+ 进度，渲染卡片
// 并提供「创建课程」（上传 HTML 存入 D1）与删除动态课程的能力。

const MAX_TEXT_BYTES = 1_500_000;   // html / md 存 D1
const MAX_PDF_BYTES = 20_000_000;   // pdf 存 R2
const KIND_ICON = { html: '📘', md: '📝', pdf: '📕' };

let studyProfile = null;   // 「关于」弹窗用：基于你自己的课程数据生成的学习画像

function detectKind(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'md' || ext === 'markdown') return 'md';
  return 'html';
}

async function loadAndRender() {
  let staticCourses = [], dynamic = [], progress = [];
  try {
    const [c1, c2, pr] = await Promise.all([
      fetch('/courses.json').then((r) => (r.ok ? r.json() : [])),
      fetch('/api/courses').then((r) => (r.ok ? r.json() : [])),
      fetch('/api/progress').then((r) => (r.ok ? r.json() : [])),
    ]);
    staticCourses = c1 || [];
    dynamic = c2 || [];
    progress = pr || [];
  } catch (e) {
    console.warn('[home] load failed', e);
  }

  const courses = [...staticCourses, ...dynamic];

  const progressMap = {};
  for (const p of progress) progressMap[p.file] = p;

  // 最近阅读（按 updated_at 排序，取前 4）
  const recent = progress
    .filter((p) => p.updated_at)
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 4)
    .map((p) => ({ ...courses.find((c) => c.file === p.file), ...p }))
    .filter((c) => c.title);

  studyProfile = buildProfile(courses, progress, recent);

  const recentSection = document.getElementById('recent-section');
  if (recent.length > 0) {
    recentSection.hidden = false;
    document.getElementById('recent').innerHTML = recent.map((c) => cardHTML(c)).join('');
  } else {
    recentSection.hidden = true;
  }

  // 全部课程
  const grid = document.getElementById('courses');
  document.getElementById('empty-hint').hidden = courses.length > 0;
  grid.innerHTML = courses
    .map((c) => cardHTML({ ...c, ...progressMap[c.file] }, true))
    .join('');
}

// ========== 搜索 ==========
document.getElementById('search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('#courses .nb-card').forEach((card) => {
    const text = card.dataset.search;
    card.style.display = !q || text.includes(q) ? '' : 'none';
  });
});

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
  settingsMenu.hidden ? openSettings() : closeSettings();
});
// 点菜单内部不关闭（主题分段控件要连点）；点外部 / Esc 关闭
settingsMenu.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => closeSettings());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

// ========== 登出 ==========
document.getElementById('logout-btn').addEventListener('click', async () => {
  closeSettings();
  if (!confirm('退出登录？')) return;
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  location.href = '/login.html';
});

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
  if (p.courseCount === 0) tagline = '一张空白的星图，正等你点亮第一颗星 ✦';
  else if (p.subjectCount >= 3) tagline = '横跨多个领域的探索者 — 你的好奇心没有边界 🚀';
  else if (p.topSubject) tagline = `专注「${p.topSubject}」的深耕者 — 一寸一寸把它啃透 🔬`;
  else tagline = '稳步推进的笔记收藏家 📚';
  document.getElementById('about-tagline').textContent = tagline;

  const stats = [
    { n: p.courseCount, label: '门课程', ic: '📚' },
    { n: p.subjectCount, label: '个学科', ic: '🧭' },
    { n: p.tagCount, label: '个标签', ic: '🏷️' },
    { n: p.readCount, label: '篇在读', ic: '🔖' },
  ];
  document.getElementById('about-stats').innerHTML = stats.map((s) => `
    <div class="about-stat">
      <span class="as-ic">${s.ic}</span>
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

// ========== 删除动态课程（事件委托） ==========
document.getElementById('courses').addEventListener('click', async (e) => {
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

// ========== 创建课程弹窗 ==========
const modal = document.getElementById('create-modal');
const hint = document.getElementById('nc-hint');
const submitBtn = document.getElementById('nc-submit');

function openModal() {
  resetForm();
  modal.hidden = false;
  document.getElementById('nc-title').focus();
}
function closeModal() { modal.hidden = true; }
function resetForm() {
  ['nc-title', 'nc-subject', 'nc-desc'].forEach((id) => (document.getElementById(id).value = ''));
  document.getElementById('nc-file').value = '';
  setTags([]);
  selectIcon('📘');
  setAIStatus('');
  hint.textContent = '支持 HTML / Markdown（≤1.5 MB）或 PDF（≤20 MB）。选好文件后可让 AI 自动填充。';
  hint.classList.remove('err');
}
function setHint(msg, isErr) { hint.textContent = msg; hint.classList.toggle('err', !!isErr); }

document.getElementById('create-btn').addEventListener('click', openModal);
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
    fd.append('file', f, f.name);
    const res = await fetch('/api/courses', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '创建失败');
    closeModal();
    await loadAndRender();
  } catch (e) {
    setHint(e.message || '创建失败，请重试', true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '创建';
  }
});

// ========== 图标点选 + 标签 + AI 智能填充 ==========
// ICONS 必须与后端 functions/api/analyze.js 的 ICONS 一致
const ICONS = [
  '📘', '📗', '📙', '📕', '📓', '📝', '📐', '📊', '📈', '🧮', '🔢', '⚛️',
  '🔬', '🧲', '⚡', '🌊', '🔭', '🧪', '⚗️', '🧬', '💻', '🐍', '🌐', '🤖',
  '🧠', '⚙️', '🏗️', '🚢', '🚀', '🛰️', '🎲', '🗺️', '🌍', '💡', '🎯', '📡',
];
let ncTags = [];

const iconPicker = document.getElementById('nc-icon-picker');
const iconInput = document.getElementById('nc-icon');
const tagsBox = document.getElementById('nc-tags');
const aiBtn = document.getElementById('nc-ai');
const aiStatus = document.getElementById('nc-ai-status');

function renderIconPicker() {
  iconPicker.innerHTML = ICONS
    .map((e) => `<button type="button" class="icon-opt" data-icon="${e}">${e}</button>`)
    .join('');
}
function selectIcon(emoji) {
  if (!emoji) return;
  iconInput.value = emoji;
  iconPicker.querySelectorAll('.icon-opt').forEach((b) => {
    b.classList.toggle('selected', b.dataset.icon === emoji);
  });
}
iconPicker.addEventListener('click', (e) => {
  const b = e.target.closest('.icon-opt');
  if (b) selectIcon(b.dataset.icon);
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
         <span>已读 ${pct}%</span>
       </div>`
    : '';

  const delBtn = (deletable && c.dynamic)
    ? `<button class="nb-del" data-file="${escapeAttr(c.file)}" title="删除课程" aria-label="删除课程">✕</button>`
    : '';

  return `
    <a class="nb-card" href="/reader.html?file=${encodeURIComponent(c.file)}"
       style="--accent: ${c.color || '#6750A4'}"
       data-search="${escapeAttr(searchText)}">
      ${delBtn}
      <span class="nb-card-icon">${escapeHTML(c.icon || '📄')}</span>
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
