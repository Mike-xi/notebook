// 阅读器：iframe 同源 -> 直接拿 contentWindow/contentDocument
const params = new URLSearchParams(location.search);
const file = params.get('file');
if (!file) { location.href = '/'; throw new Error('no file'); }

const iframe = document.getElementById('content');
const docTitleEl = document.getElementById('doc-title');
const docSubjectEl = document.getElementById('doc-subject');
const progressEl = document.getElementById('progress-pct');
const bookmarkBtn = document.getElementById('bookmark-btn');
const bookmarksToggle = document.getElementById('bookmarks-toggle');
const bookmarksPanel = document.getElementById('bookmarks-panel');
const bookmarksList = document.getElementById('bookmarks-list');
const bookmarksEmpty = document.getElementById('bookmarks-empty');

// 课程元数据（用于显示标题、学科）
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
  });

iframe.src = `/notes/${file}`;

let currentPct = 0;
let saveTimer = null;
let scrollAttached = false;

iframe.addEventListener('load', () => {
  // 给页面里的图片/数学公式一点时间布局
  setTimeout(initIframe, 150);
});

async function initIframe() {
  const win = iframe.contentWindow;
  const doc = iframe.contentDocument;
  if (!win || !doc) return;

  // 恢复上次进度
  try {
    const res = await fetch(`/api/progress?file=${encodeURIComponent(file)}`);
    const data = await res.json();
    if (data.scroll_pct > 0) {
      restoreScroll(data.scroll_pct);
    }
  } catch (e) {
    console.warn('[reader] failed to load progress', e);
  }

  // 绑定 scroll 监听（只绑定一次）
  if (!scrollAttached) {
    win.addEventListener('scroll', onScroll, { passive: true });
    scrollAttached = true;
  }

  updateProgressDisplay();
}

function restoreScroll(pct) {
  const win = iframe.contentWindow;
  const doc = iframe.contentDocument;
  if (!win || !doc) return;
  const max = doc.documentElement.scrollHeight - win.innerHeight;
  if (max > 0) win.scrollTo(0, max * pct);
  currentPct = pct;
}

function onScroll() {
  const win = iframe.contentWindow;
  const doc = iframe.contentDocument;
  if (!win || !doc) return;
  const max = doc.documentElement.scrollHeight - win.innerHeight;
  currentPct = max > 0 ? Math.max(0, Math.min(1, win.scrollY / max)) : 0;
  updateProgressDisplay();

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

// ========== 书签 ==========
bookmarkBtn.addEventListener('click', () => {
  showBookmarkPrompt();
});

bookmarksToggle.addEventListener('click', () => {
  const open = !bookmarksPanel.hidden;
  if (open) {
    bookmarksPanel.hidden = true;
  } else {
    bookmarksPanel.hidden = false;
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

// 自定义 prompt 弹框（比浏览器原生好看）
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
    // 如果面板开着，刷新
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

// 关闭书签面板的全局快捷键
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !bookmarksPanel.hidden) {
    bookmarksPanel.hidden = true;
  }
});

function escapeHTML(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHTML(s); }
