// 首页：加载课程列表 + 进度，渲染 NotebookLM 风格卡片
(async function () {
  let courses = [];
  let progress = [];

  try {
    const [coursesRes, progressRes] = await Promise.all([
      fetch('/courses.json'),
      fetch('/api/progress'),
    ]);
    courses = await coursesRes.json();
    progress = progressRes.ok ? await progressRes.json() : [];
  } catch (e) {
    console.warn('[home] load failed', e);
  }

  // file -> progress 映射
  const progressMap = {};
  for (const p of progress) progressMap[p.file] = p;

  // 最近阅读（按 updated_at 排序，取前 4）
  const recent = progress
    .filter((p) => p.updated_at)
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 4)
    .map((p) => ({ ...courses.find((c) => c.file === p.file), ...p }))
    .filter((c) => c.title);

  if (recent.length > 0) {
    document.getElementById('recent-section').hidden = false;
    document.getElementById('recent').innerHTML = recent.map(cardHTML).join('');
  }

  // 全部课程
  const grid = document.getElementById('courses');
  if (courses.length === 0) {
    document.getElementById('empty-hint').hidden = false;
  } else {
    grid.innerHTML = courses
      .map((c) => cardHTML({ ...c, ...progressMap[c.file] }))
      .join('');
  }

  // 搜索
  const search = document.getElementById('search');
  search.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#courses .nb-card').forEach((card) => {
      const text = card.dataset.search;
      card.style.display = !q || text.includes(q) ? '' : 'none';
    });
  });

  // 登出
  document.getElementById('logout-btn').addEventListener('click', async () => {
    if (!confirm('退出登录？')) return;
    try { await fetch('/api/logout', { method: 'POST' }); } catch {}
    location.href = '/login.html';
  });
})();

function cardHTML(c) {
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

  return `
    <a class="nb-card" href="/reader.html?file=${encodeURIComponent(c.file)}"
       style="--accent: ${c.color || '#6750A4'}"
       data-search="${escapeAttr(searchText)}">
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
