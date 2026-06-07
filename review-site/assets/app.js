// 首页：加载课程（静态 courses.json + 用户创建的 /api/courses）+ 进度，渲染卡片
// 并提供「创建课程」（上传 HTML 存入 D1）与删除动态课程的能力。

const MAX_TEXT_BYTES = 1_500_000;   // html / md 存 D1
const MAX_PDF_BYTES = 20_000_000;   // pdf 存 R2
const KIND_ICON = { html: '📘', md: '📝', pdf: '📕' };

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

// ========== 登出 ==========
document.getElementById('logout-btn').addEventListener('click', async () => {
  if (!confirm('退出登录？')) return;
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  location.href = '/login.html';
});

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
  document.getElementById('nc-icon').value = '📘';
  document.getElementById('nc-file').value = '';
  hint.textContent = '支持 HTML / Markdown（≤1.5 MB）或 PDF（≤20 MB）。';
  hint.classList.remove('err');
}
function setHint(msg, isErr) { hint.textContent = msg; hint.classList.toggle('err', !!isErr); }

document.getElementById('create-btn').addEventListener('click', openModal);
document.getElementById('nc-cancel').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden) closeModal();
});

// 选文件后：按类型提示大小上限，并自动配一个默认图标（若用户没改过）
document.getElementById('nc-file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const kind = detectKind(f.name);
  const max = kind === 'pdf' ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
  const label = { html: 'HTML', md: 'Markdown', pdf: 'PDF' }[kind];
  setHint(`已选 ${label}（${(f.size / 1e6).toFixed(2)} MB / 上限 ${(max / 1e6).toFixed(1)} MB）`, f.size > max);
  const iconEl = document.getElementById('nc-icon');
  if (!iconEl.value || ['📘', '📝', '📕'].includes(iconEl.value)) iconEl.value = KIND_ICON[kind];
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
loadAndRender();
