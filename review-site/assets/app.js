// 首页：加载课程列表 + 进度，渲染卡片
(async function () {
  const [coursesRes, progressRes] = await Promise.all([
    fetch('/courses.json'),
    fetch('/api/progress'),
  ]);

  const courses = await coursesRes.json();
  const progress = await progressRes.json();

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
  document.getElementById('courses').innerHTML = courses
    .map((c) => cardHTML({ ...c, ...progressMap[c.file] }))
    .join('');

  // 搜索
  const search = document.getElementById('search');
  search.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('.course-card').forEach((card) => {
      const text = card.dataset.search;
      card.style.display = !q || text.includes(q) ? '' : 'none';
    });
  });

  // 登出
  document.getElementById('logout-btn').addEventListener('click', async () => {
    if (!confirm('退出登录？')) return;
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login.html';
  });
})();

function cardHTML(c) {
  const pct = c.scroll_pct ? Math.round(c.scroll_pct * 100) : 0;
  const searchText = [c.title, c.subject, c.description, ...(c.tags || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return `
    <a class="course-card" href="/reader.html?file=${encodeURIComponent(c.file)}"
       style="--accent: ${c.color || 'var(--primary)'}"
       data-search="${escapeAttr(searchText)}">
      <span class="course-tag">${escapeHTML(c.subject || '笔记')}</span>
      <h3>${escapeHTML(c.title)}</h3>
      <p class="course-desc">${escapeHTML(c.description || '')}</p>
      <div class="progress-info">
        <div class="progress-bar"><div style="width: ${pct}%"></div></div>
        <span>${pct > 0 ? `已读 ${pct}%` : '未开始'}</span>
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
