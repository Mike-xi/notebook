// 阅读器：全屏 iframe + 悬浮工具栏。HTML 笔记走同源进度/书签；PDF 仅全屏展示。
const params = new URLSearchParams(location.search);
const file = params.get('file');
if (!file) { location.href = '/'; throw new Error('no file'); }

const isPDF = /\.pdf$/i.test(file);

const iframe = document.getElementById('content');
const docTitleEl = document.getElementById('doc-title');
const docSubjectEl = document.getElementById('doc-subject');
const progressEl = document.getElementById('progress-pct');
const bookmarkBtn = document.getElementById('bookmark-btn');
const bookmarksToggle = document.getElementById('bookmarks-toggle');
const bookmarksPanel = document.getElementById('bookmarks-panel');
const bookmarksList = document.getElementById('bookmarks-list');
const bookmarksEmpty = document.getElementById('bookmarks-empty');
const bar = document.getElementById('reader-bar');
const hotzone = document.getElementById('reader-hotzone');

// PDF：进度/书签无法读取滚动，隐藏相关控件，保持工具栏常驻
if (isPDF) {
  bookmarkBtn.hidden = true;
  bookmarksToggle.hidden = true;
  progressEl.hidden = true;
}

// 课程元数据（显示标题、学科）
let courseMeta = null;
fetch('/courses.json')
  .then((r) => r.json())
  .then((courses) => {
    courseMeta = courses.find((c) => c.file === file);
    if (courseMeta) {
      docTitleEl.textContent = courseMeta.title;
      docSubjectEl.textContent = courseMeta.subject || '';
      document.title = `${courseMeta.title} · 阅读`;
    } else {
      docTitleEl.textContent = file;
    }
  })
  .catch(() => { docTitleEl.textContent = file; });

iframe.src = `/notes/${encodeURIComponent(file)}`;

let currentPct = 0;
let saveTimer = null;
let scrollAttached = false;

iframe.addEventListener('load', () => {
  // 给页面里的图片/数学公式一点时间布局
  setTimeout(initIframe, 150);
});

async function initIframe() {
  if (isPDF) { showBar(); return; }
  const win = iframe.contentWindow;
  const doc = iframe.contentDocument;
  if (!win || !doc) { showBar(); return; }

  // 恢复上次进度
  try {
    const res = await fetch(`/api/progress?file=${encodeURIComponent(file)}`);
    const data = await res.json();
    if (data.scroll_pct > 0) restoreScroll(data.scroll_pct);
  } catch (e) {
    console.warn('[reader] failed to load progress', e);
  }

  // 绑定 scroll 监听（只绑定一次）
  if (!scrollAttached) {
    win.addEventListener('scroll', onScroll, { passive: true });
    // iframe 内鼠标移到顶部 -> 唤出工具栏
    doc.addEventListener('mousemove', (e) => {
      if (e.clientY < 64) showBar();
    }, { passive: true });
    scrollAttached = true;
  }

  updateProgressDisplay();
  // 进入后短暂展示工具栏，随后自动隐藏，营造全屏感
  showBar();
  scheduleHide();
}

function restoreScroll(pct) {
  const win = iframe.contentWindow;
  const doc = iframe.contentDocument;
  if (!win || !doc) return;
  const max = doc.documentElement.scrollHeight - win.innerHeight;
  if (max > 0) win.scrollTo(0, max * pct);
  currentPct = pct;
  lastScrollY = win.scrollY;
}

let lastScrollY = 0;
function onScroll() {
  const win = iframe.contentWindow;
  const doc = iframe.contentDocument;
  if (!win || !doc) return;
  const max = doc.documentElement.scrollHeight - win.innerHeight;
  currentPct = max > 0 ? Math.max(0, Math.min(1, win.scrollY / max)) : 0;
  updateProgressDisplay();

  // 工具栏：下滑隐藏、上滑显示
  const y = win.scrollY;
  if (y > lastScrollY + 6 && y > 120) {
    hideBar();
  } else if (y < lastScrollY - 6) {
    showBar();
  }
  lastScrollY = y;

  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProgress, 1500);
}

function updateProgressDisplay() {
  progressEl.textContent = `${Math.round(currentPct * 100)}%`;
}

async function saveProgress() {
  try {
    await fetch('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, scroll_pct: currentPct }),
    });
  } catch (e) {
    console.warn('[reader] save failed', e);
  }
}

// 关闭页面时用 sendBeacon 兜底保存
window.addEventListener('beforeunload', () => {
  if (!isPDF && currentPct > 0) {
    const blob = new Blob(
      [JSON.stringify({ file, scroll_pct: currentPct })],
      { type: 'application/json' }
    );
    navigator.sendBeacon('/api/progress', blob);
  }
});

// ========== 工具栏显隐 ==========
let hideTimer = null;
let barHovered = false;

function showBar() {
  clearTimeout(hideTimer);
  bar.classList.remove('hidden');
}
function hideBar() {
  if (isPDF || barHovered) return;
  if (!bookmarksPanel.hidden) return;
  bar.classList.add('hidden');
}
function scheduleHide() {
  if (isPDF) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideBar, 2500);
}

bar.addEventListener('mouseenter', () => { barHovered = true; showBar(); });
bar.addEventListener('mouseleave', () => { barHovered = false; scheduleHide(); });
hotzone.addEventListener('mouseenter', showBar);
// 父页面鼠标移动（工具栏区域之外的边缘）也能唤出
document.addEventListener('mousemove', (e) => {
  if (e.clientY < 64) showBar();
}, { passive: true });

// ========== 书签 ==========
bookmarkBtn.addEventListener('click', () => { showBookmarkPrompt(); });

bookmarksToggle.addEventListener('click', () => {
  if (!bookmarksPanel.hidden) {
    bookmarksPanel.hidden = true;
  } else {
    bookmarksPanel.hidden = false;
    showBar();
    loadBookmarks();
  }
});

document.getElementById('panel-close').addEventListener('click', () => {
  bookmarksPanel.hidden = true;
});

async function loadBookmarks() {
  try {
    const res = await fetch(`/api/bookmarks?file=${encodeURIComponent(file)}`);
    const items = await res.json();
    renderBookmarks(items);
  } catch (e) {
    console.warn('[reader] failed to load bookmarks', e);
  }
}

function renderBookmarks(items) {
  if (!items || items.length === 0) {
    bookmarksList.innerHTML = '';
    bookmarksEmpty.hidden = false;
    return;
  }
  bookmarksEmpty.hidden = true;
  bookmarksList.innerHTML = items
    .map((b) => `
      <li>
        <button class="bm-jump" data-pct="${b.scroll_pct}">
          <span>${escapeHTML(b.title)}</span>
          <span class="bm-pct">${Math.round(b.scroll_pct * 100)}%</span>
        </button>
        <button class="bm-del" data-id="${b.id}" title="删除">✕</button>
      </li>
    `).join('');
}

bookmarksList.addEventListener('click', async (e) => {
  const jumpBtn = e.target.closest('.bm-jump');
  if (jumpBtn) {
    const pct = parseFloat(jumpBtn.dataset.pct);
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (!win || !doc) return;
    const max = doc.documentElement.scrollHeight - win.innerHeight;
    if (max > 0) win.scrollTo({ top: max * pct, behavior: 'smooth' });
    return;
  }

  const delBtn = e.target.closest('.bm-del');
  if (delBtn) {
    e.stopPropagation();
    const id = parseInt(delBtn.dataset.id);
    if (!confirm('删除这个书签？')) return;
    await fetch('/api/bookmarks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    loadBookmarks();
  }
});

// 自定义 prompt 弹框
function showBookmarkPrompt() {
  const defaultTitle = `位置 ${Math.round(currentPct * 100)}%`;
  const overlay = document.createElement('div');
  overlay.className = 'bm-prompt-overlay';
  overlay.innerHTML = `
    <div class="bm-prompt">
      <h3>添加书签</h3>
      <input type="text" id="bm-input" value="${escapeAttr(defaultTitle)}" autofocus>
      <div class="btn-row">
        <button class="btn-cancel" type="button">取消</button>
        <button class="btn-confirm" type="button">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#bm-input');
  input.select();

  const close = () => overlay.remove();
  const confirm = async () => {
    const title = input.value.trim() || defaultTitle;
    close();
    await fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, title, scroll_pct: currentPct }),
    });
    if (!bookmarksPanel.hidden) loadBookmarks();
  };

  overlay.querySelector('.btn-cancel').addEventListener('click', close);
  overlay.querySelector('.btn-confirm').addEventListener('click', confirm);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirm();
    if (e.key === 'Escape') close();
  });
}

// 快捷键：Esc 关书签面板 / 返回
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!bookmarksPanel.hidden) { bookmarksPanel.hidden = true; return; }
  }
});

function escapeHTML(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHTML(s); }
