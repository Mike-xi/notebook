// 阅读器：全屏 iframe + 悬浮工具栏。HTML 笔记走同源进度/书签；PDF 仅全屏展示。
const params = new URLSearchParams(location.search);
const file = params.get('file');
if (!file) { location.href = '/'; throw new Error('no file'); }

const ext = (file.split('.').pop() || '').toLowerCase();
const kind = ext === 'pdf' ? 'pdf' : (ext === 'md' || ext === 'markdown') ? 'md' : 'html';
const isDynamic = file.startsWith('u-'); // 用户在线创建的课程，正文存 D1/R2
const usesViewer = kind === 'pdf' || kind === 'md'; // 我们自己的 viewer（iframe 内可滚动 + postMessage 联动）

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

// 课程元数据（显示标题、学科）：合并静态 courses.json 与用户创建的 /api/courses
let courseMeta = null;
Promise.all([
  fetch('/courses.json').then((r) => (r.ok ? r.json() : [])),
  fetch('/api/courses').then((r) => (r.ok ? r.json() : [])),
])
  .then(([staticCourses, dynamic]) => {
    const courses = [...(staticCourses || []), ...(dynamic || [])];
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

// 正文来源 URL：动态课程走 Function（html/md 取 D1、pdf 取 R2），静态课程读 /notes/
const sourceURL = isDynamic
  ? (kind === 'pdf' ? `/api/file?file=${encodeURIComponent(file)}` : `/api/course-html?file=${encodeURIComponent(file)}`)
  : `/notes/${encodeURIComponent(file)}`;

// html 直接喂 iframe；pdf/md 走我们自己的 viewer（用 ?src= 指向正文）
iframe.src = usesViewer
  ? `/viewer-${kind}.html?src=${encodeURIComponent(sourceURL)}`
  : sourceURL;

let currentPct = 0;
let saveTimer = null;
let scrollAttached = false;

let inited = false;
function initOnce() { if (inited) return; inited = true; initIframe(); }

iframe.addEventListener('load', () => {
  if (usesViewer) {
    // pdf/md：等 viewer 排好版发来 nb-ready 再初始化；兜底超时防消息丢失
    syncViewerTheme();
    setTimeout(initOnce, 4000);
  } else {
    // html：给图片/公式一点布局时间
    setTimeout(initOnce, 150);
  }
});

// 接收子 viewer 的消息：排版就绪、PDF 大纲
window.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'nb-ready') initOnce();
  else if (d.type === 'nb-outline') { window.__nbOutline = d.items || []; window.dispatchEvent(new CustomEvent('nb-outline-ready')); }
});

async function initIframe() {
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
  applyContentTheme();
  setupContentFeatures();
  // 进入后短暂展示工具栏，随后自动隐藏，营造全屏感
  showBar();
  scheduleHide();
}

// 内容就绪后：构建目录 + 启用高亮（html/md）
function setupContentFeatures() {
  buildTOC();
  if (kind !== 'pdf' && window.NBHighlights) {
    const win = iframe.contentWindow, doc = iframe.contentDocument;
    const root = kind === 'md' ? doc.getElementById('md-content') : (doc && doc.body);
    if (win && doc && root) NBHighlights.init({ doc, win, root, file });
  }
}

// ========== 笔记正文暗色 ==========
// 用户上传的 HTML 笔记自带浅色配色，深色模式下用「整体反相 + 媒体二次反相」
// 这一经典手法把任意页面渲染成可读的暗色（图片/视频/canvas 不被反相）。
const DARK_CONTENT_CSS = `
  html.nb-dark-invert { filter: invert(0.92) hue-rotate(180deg); background:#111418 !important; }
  html.nb-dark-invert img, html.nb-dark-invert video, html.nb-dark-invert picture,
  html.nb-dark-invert canvas, html.nb-dark-invert svg image,
  html.nb-dark-invert [data-no-invert] { filter: invert(1) hue-rotate(180deg); }
`;
function applyContentTheme() {
  if (usesViewer) { syncViewerTheme(); return; } // md/pdf 由各自 viewer 处理
  const doc = iframe.contentDocument;
  if (!doc || !doc.documentElement) return;
  let style = doc.getElementById('nb-dark-style');
  if (!style) {
    style = doc.createElement('style');
    style.id = 'nb-dark-style';
    style.textContent = DARK_CONTENT_CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }
  const dark = window.NBTheme && window.NBTheme.effective === 'dark';
  doc.documentElement.classList.toggle('nb-dark-invert', !!dark);
}
function syncViewerTheme() {
  const win = iframe.contentWindow;
  if (!win) return;
  const eff = window.NBTheme ? window.NBTheme.effective : 'light';
  try { win.postMessage({ type: 'nb-theme', effective: eff }, location.origin); } catch {}
}
window.addEventListener('nb-theme-change', applyContentTheme);

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
  if (currentPct > 0) {
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
  if (barHovered) return;
  if (!bookmarksPanel.hidden) return;
  bar.classList.add('hidden');
}
function scheduleHide() {
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
    document.getElementById('toc-panel').hidden = true; // 互斥：开书签即收目录
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

// ========== 目录 TOC ==========
const tocToggle = document.getElementById('toc-toggle');
const tocPanel = document.getElementById('toc-panel');
const tocList = document.getElementById('toc-list');
const tocEmpty = document.getElementById('toc-empty');
let tocItems = [];

function buildTOC() {
  tocItems = [];
  if (usesViewer) {
    // pdf/md：用 viewer 经 postMessage 上报的大纲
    (window.__nbOutline || []).forEach((it) => {
      tocItems.push({
        title: it.title, level: it.level || 0,
        disabled: kind === 'pdf' ? !it.page : !it.id,
        jump: kind === 'pdf'
          ? () => postToViewer({ type: 'nb-goto-page', page: it.page })
          : () => postToViewer({ type: 'nb-goto-id', id: it.id }),
      });
    });
  } else {
    // html：从笔记 DOM 抽取 h1-h3
    const doc = iframe.contentDocument;
    if (doc) {
      doc.querySelectorAll('h1, h2, h3').forEach((h) => {
        const title = (h.textContent || '').trim();
        if (!title) return;
        tocItems.push({
          title, level: parseInt(h.tagName[1], 10) - 1,
          jump: () => { try { h.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { h.scrollIntoView(); } },
        });
      });
    }
  }
  renderTOC();
}

function renderTOC() {
  const usable = tocItems.filter((t) => !t.disabled).length;
  tocToggle.hidden = usable === 0;
  if (!tocItems.length) { tocList.innerHTML = ''; tocEmpty.hidden = false; return; }
  tocEmpty.hidden = true;
  tocList.innerHTML = tocItems.map((t, i) =>
    `<li><button class="toc-item lvl-${t.level}" data-i="${i}"${t.disabled ? ' disabled' : ''}>${escapeHTML(t.title)}</button></li>`
  ).join('');
}

tocList.addEventListener('click', (e) => {
  const btn = e.target.closest('.toc-item');
  if (!btn || btn.disabled) return;
  const it = tocItems[parseInt(btn.dataset.i, 10)];
  if (it && it.jump) it.jump();
  if (window.innerWidth < 640) tocPanel.hidden = true;
});

tocToggle.addEventListener('click', () => {
  if (!tocPanel.hidden) { tocPanel.hidden = true; return; }
  bookmarksPanel.hidden = true;
  tocPanel.hidden = false;
  showBar();
});
document.getElementById('toc-close').addEventListener('click', () => { tocPanel.hidden = true; });

function postToViewer(msg) {
  const win = iframe.contentWindow;
  if (win) { try { win.postMessage(msg, location.origin); } catch {} }
}

// 快捷键：Esc 关面板 / 返回
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!tocPanel.hidden) { tocPanel.hidden = true; return; }
    if (!bookmarksPanel.hidden) { bookmarksPanel.hidden = true; return; }
  }
});

function escapeHTML(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHTML(s); }
