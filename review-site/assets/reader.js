// 阅读器：全屏 iframe + 悬浮工具栏。HTML 笔记走同源进度/书签；PDF 仅全屏展示。
// 两种模式：① 普通模式（?file=...，需登录）；② 只读分享模式（?share=<token>&k=<kind>，免登录，
//    凭 token 经 /api/shared 取数，享完整阅读功能但不写入账号、不能回主页）。
const params = new URLSearchParams(location.search);
const shareToken = params.get('share');
const shareMode = !!shareToken;

let file, kind, isDynamic, usesViewer, sourceURL;
if (shareMode) {
  // 分享模式：真实 file 名不暴露在 URL，kind 由 k 提示（正文仍由 token 鉴权，提示被改至多渲染失败）。
  kind = ['html', 'md', 'pdf'].includes(params.get('k')) ? params.get('k') : 'html';
  isDynamic = false;
  usesViewer = kind === 'pdf' || kind === 'md';
  file = 'share:' + shareToken.slice(0, 24); // 仅作 localStorage 键（本地偏好等），不参与取数
  sourceURL = `/api/shared?token=${encodeURIComponent(shareToken)}&raw=1`;
  document.body.classList.add('share-mode');
} else {
  file = params.get('file');
  if (!file) { location.href = '/'; throw new Error('no file'); }
  const ext = (file.split('.').pop() || '').toLowerCase();
  kind = ext === 'pdf' ? 'pdf' : (ext === 'md' || ext === 'markdown') ? 'md' : 'html';
  isDynamic = file.startsWith('u-'); // 用户在线创建的课程，正文存 D1/R2
  usesViewer = kind === 'pdf' || kind === 'md'; // 我们自己的 viewer（iframe 内可滚动 + postMessage 联动）
  // 正文来源 URL：动态课程走 Function（html/md 取 D1、pdf 取 R2），静态课程读 /notes/
  sourceURL = isDynamic
    ? (kind === 'pdf' ? `/api/file?file=${encodeURIComponent(file)}` : `/api/course-html?file=${encodeURIComponent(file)}`)
    : `/notes/${encodeURIComponent(file)}`;
}

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
const chatToggle = document.getElementById('chat-toggle');
const chatPanel = document.getElementById('chat-panel');
const prefsPanel = document.getElementById('prefs-panel');
const moreMenu = { hidden: true };   // 旧「更多」菜单已移除，留空对象兼容历史显隐引用
const gotoTitle = params.get('goto');   // 搜索结果跳转：按小节标题定位

// 课程元数据（显示标题、学科）
let courseMeta = null;
if (shareMode) {
  // 分享模式：标题/学科从 /api/shared 元数据取（无登录态，拿不到 courses.json）
  document.getElementById('rb-ro').hidden = false;
  fetch(`/api/shared?token=${encodeURIComponent(shareToken)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) { docTitleEl.textContent = 'Shared content unavailable'; return; }
      courseMeta = { title: d.title, subject: d.subject };
      docTitleEl.textContent = d.title || 'Shared note';
      docSubjectEl.textContent = d.subject || '';
      document.title = `${d.title || 'Shared note'} · Read-only`;
    })
    .catch(() => { docTitleEl.textContent = 'Shared note'; });
} else {
  // 普通模式：合并静态 courses.json 与用户创建的 /api/courses
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
        document.title = `${courseMeta.title} · Reader`;
      } else {
        docTitleEl.textContent = file;
      }
    })
    .catch(() => { docTitleEl.textContent = file; });
}

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
// PDF 的大纲可能晚于 nb-ready 到达（异步解析），到了就重建一次目录
window.addEventListener('nb-outline-ready', () => { if (inited) { buildTOC(); tryGoto(); } });

async function initIframe() {
  const win = iframe.contentWindow;
  const doc = iframe.contentDocument;
  if (!win || !doc) { showBar(); return; }

  // 先应用阅读偏好（字号/宽度会改变文档高度），再恢复进度，避免恢复位置漂移
  try { await prefsLoaded; } catch {}
  applyReadPrefs();

  // 恢复上次进度（分享模式不读账号进度）
  if (!shareMode) {
    try {
      const res = await fetch(`/api/progress?file=${encodeURIComponent(file)}`);
      const data = await res.json();
      if (data.scroll_pct > 0) restoreScroll(data.scroll_pct);
    } catch (e) {
      console.warn('[reader] failed to load progress', e);
    }
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
  // 上次开着分屏对话的话，恢复它（此时正文已就绪，索引/历史可正常加载）
  if (splitMode && chatPanel.hidden) openChat();
  // 进入后短暂展示工具栏，随后自动隐藏，营造全屏感
  showBar();
  scheduleHide();
}

// 内容就绪后：构建目录 + 启用高亮（html/md）
function setupContentFeatures() {
  buildTOC();
  // 分享模式不启用高亮批注（属个人数据，需写入账号）
  if (!shareMode && kind !== 'pdf' && window.NBHighlights) {
    const win = iframe.contentWindow, doc = iframe.contentDocument;
    const root = kind === 'md' ? doc.getElementById('md-content') : (doc && doc.body);
    if (win && doc && root) NBHighlights.init({ doc, win, root, file, onAskAI: askFromSelection });
  }
  tryGoto();
}

// 搜索结果带 ?goto=小节标题 进来时，目录就绪后跳转一次
let gotoDone = false;
function tryGoto() {
  if (!gotoTitle || gotoDone || !tocItems.length) return;
  gotoDone = true;
  setTimeout(() => jumpToHeading(gotoTitle), 250);   // 等首屏排版/进度恢复稳定
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
// 上滑唤出工具栏所需的阈值（px）；由首页设置写入 localStorage，4=灵敏 / 14=适中 / 36=迟钝
function barRevealThreshold() {
  const v = parseInt(localStorage.getItem('nb-bar-reveal'), 10);
  return Number.isFinite(v) && v > 0 ? v : 14;
}
function onScroll() {
  const win = iframe.contentWindow;
  const doc = iframe.contentDocument;
  if (!win || !doc) return;
  const max = doc.documentElement.scrollHeight - win.innerHeight;
  currentPct = max > 0 ? Math.max(0, Math.min(1, win.scrollY / max)) : 0;
  updateProgressDisplay();

  // 工具栏：下滑隐藏、上滑显示。上滑阈值可在首页设置里调（越大越需快速上滑）
  // 专注模式下滚动不唤出工具栏，只有鼠标移到顶部才显示
  const y = win.scrollY;
  const revealT = barRevealThreshold();
  if (y > lastScrollY + 6 && y > 120) {
    hideBar();
  } else if (y < lastScrollY - revealT && !focusMode) {
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
  if (shareMode) return;   // 分享访客不写入账号进度
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
  if (!shareMode && currentPct > 0) {
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
  if (localStorage.getItem('nb-bar-reveal') === 'off') return;  // 设置里选了「永不」：工具栏永久隐藏
  clearTimeout(hideTimer);
  bar.classList.remove('hidden');
}
function hideBar() {
  if (barHovered) return;
  if (!bookmarksPanel.hidden) return;
  if (chatPanel && !chatPanel.hidden && !splitMode) return;
  if (prefsPanel && !prefsPanel.hidden) return;
  if (moreMenu && !moreMenu.hidden) return;
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

// 「永不」：用户在首页设置里彻底关闭工具栏 → 启动即隐藏，且不再被滚动/悬停唤出
if (localStorage.getItem('nb-bar-reveal') === 'off') {
  bar.classList.add('hidden');
  if (hotzone) hotzone.style.display = 'none';
}

// ========== 书签 ==========
bookmarkBtn.addEventListener('click', () => { showBookmarkPrompt(); });

bookmarksToggle.addEventListener('click', () => {
  if (!bookmarksPanel.hidden) {
    bookmarksPanel.hidden = true;
  } else {
    document.getElementById('toc-panel').hidden = true; // 互斥：开书签即收目录
    closeChatPanel();
    prefsPanel.hidden = true;
    moreMenu.hidden = true;
    bookmarksPanel.hidden = false;
    showBar();
    loadBookmarks();
  }
});

document.getElementById('panel-close').addEventListener('click', () => {
  bookmarksPanel.hidden = true;
});

async function loadBookmarks() {
  if (shareMode) return;
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
        <button class="bm-del" data-id="${b.id}" title="Delete">${window.NBIcon ? NBIcon('close', { size: 15 }) : '✕'}</button>
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
    if (!confirm('Delete this bookmark?')) return;
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
  const defaultTitle = `Position ${Math.round(currentPct * 100)}%`;
  const overlay = document.createElement('div');
  overlay.className = 'bm-prompt-overlay';
  overlay.innerHTML = `
    <div class="bm-prompt">
      <h3>Add bookmark</h3>
      <input type="text" id="bm-input" value="${escapeAttr(defaultTitle)}" autofocus>
      <div class="btn-row">
        <button class="btn-cancel" type="button">Cancel</button>
        <button class="btn-confirm" type="button">Save</button>
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
  closeChatPanel();
  prefsPanel.hidden = true;
  moreMenu.hidden = true;
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
    const sm = document.getElementById('share-modal');
    if (sm && !sm.hidden) { sm.hidden = true; return; }
    if (!prefsPanel.hidden) { prefsPanel.hidden = true; return; }
    if (!chatPanel.hidden) { closeChatPanel(); return; }
    if (!tocPanel.hidden) { tocPanel.hidden = true; return; }
    if (!bookmarksPanel.hidden) { bookmarksPanel.hidden = true; return; }
  }
});

// ========== AI 对话（RAG） ==========
const chatMsgs = document.getElementById('chat-msgs');
const chatInput = document.getElementById('chat-input');
const chatForm = document.getElementById('chat-form');
const chatStatus = document.getElementById('chat-status');
const chatQuoteBox = document.getElementById('chat-quote');
const chatModelSelect = document.getElementById('chat-model');

if (chatModelSelect) {
  // 模型清单由后端 /api/rag/chat 提供（单一数据源），避免前后端写两份导致用到已弃用的模型。
  fetch('/api/rag/chat').then((r) => (r.ok ? r.json() : null)).then((d) => {
    const models = d && Array.isArray(d.models) ? d.models : [];
    if (!models.length) { chatModelSelect.closest('.chat-model-bar')?.setAttribute('hidden', ''); return; }
    chatModelSelect.innerHTML = models.map((m) =>
      `<option value="${escapeAttr(m.id)}">${escapeHTML(m.label)}${m.hint ? '　·　' + escapeHTML(m.hint) : ''}</option>`
    ).join('');
    const saved = localStorage.getItem('nb-chat-model');
    if (saved && models.some((m) => m.id === saved)) chatModelSelect.value = saved;
  }).catch(() => {});
  chatModelSelect.addEventListener('change', () => {
    localStorage.setItem('nb-chat-model', chatModelSelect.value);
  });
}

let ragTriggered = false;     // 是否已尝试建索引（首次开聊时触发）
let ragSupported = true;      // pdf / 无 Vectorize 时为 false
let currentQuote = '';        // 划选带入的上下文
let chatBusy = false;

function setChatStatus(msg) { if (chatStatus) chatStatus.textContent = msg || ''; }

function openChat() {
  if (shareMode) return;   // 分享模式不开放 AI 对话（会动用账号 AI 额度）
  tocPanel.hidden = true;
  bookmarksPanel.hidden = true;
  prefsPanel.hidden = true;
  moreMenu.hidden = true;
  chatPanel.hidden = false;
  showBar();
  if (!ragTriggered) { ragTriggered = true; ensureIndexed(); }
  loadChatHistory();
  setTimeout(() => chatInput && chatInput.focus(), 30);
}

// 关闭对话面板；若在分屏模式，一并退出分屏（否则留下一条空白区）
function closeChatPanel() {
  if (chatPanel.hidden) return;
  chatPanel.hidden = true;
  if (splitMode) setSplit(false);
}

// 载入近一个月的历史对话（仅一次）
let histLoaded = false;
async function loadChatHistory() {
  if (histLoaded || !file || shareMode) return;
  histLoaded = true;
  try {
    const r = await fetch('/api/chat-history?scope=' + encodeURIComponent(file));
    const d = await r.json().catch(() => ({}));
    const msgs = (d && d.messages) || [];
    if (msgs.length) {
      const hintEl = document.getElementById('chat-hint');
      if (hintEl) hintEl.remove();
      for (const m of msgs) appendMsg(m.role === 'assistant' ? 'ai' : 'user', m.content);
    }
  } catch {}
}

chatToggle.addEventListener('click', () => {
  if (!chatPanel.hidden) closeChatPanel(); else openChat();
});
document.getElementById('chat-close').addEventListener('click', closeChatPanel);

const chatClearBtn = document.getElementById('chat-clear');
if (chatClearBtn) {
  chatClearBtn.addEventListener('click', async () => {
    if (!confirm('Clear this notebook’s chat history?')) return;
    try { await fetch('/api/chat-history', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: file }) }); } catch {}
    chatMsgs.innerHTML = '<p class="chat-hint" id="chat-hint">问我这篇笔记里的内容——我会带你定位到大致小节，并参考你的高亮和书签。也可以在正文里划选一段文字再点「Ask AI」。</p>';
  });
}

// 划词 -> 问 AI：打开面板并带入选中文本
function askFromSelection(text) {
  const t = (text || '').trim();
  if (!t) return;
  openChat();
  currentQuote = t;
  chatQuoteBox.hidden = false;
  chatQuoteBox.innerHTML = `<span class="cq-label">Quote</span><span class="cq-text">${escapeHTML(t.slice(0, 140))}${t.length > 140 ? '…' : ''}</span><button class="cq-clear" title="Remove">${window.NBIcon ? NBIcon('close', { size: 14 }) : '✕'}</button>`;
}
chatQuoteBox.addEventListener('click', (e) => { if (e.target.closest('.cq-clear')) clearQuote(); });
function clearQuote() { currentQuote = ''; chatQuoteBox.hidden = true; chatQuoteBox.innerHTML = ''; }

// 输入框：自适应高度 + 回车发送（Shift+Enter 换行）
function autoGrow() { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px'; }
chatInput.addEventListener('input', autoGrow);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
chatForm.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });

async function sendMessage() {
  const q = chatInput.value.trim();
  if (!q || chatBusy) return;
  const quote = currentQuote;
  appendMsg('user', q + (quote ? '　🔖 (re: quote)' : ''));
  chatInput.value = ''; autoGrow(); clearQuote();
  chatBusy = true;
  const thinking = appendMsg('ai', 'Thinking…', null, true);
  try {
    const model = chatModelSelect ? chatModelSelect.value : undefined;
    const res = await fetch('/api/rag/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, question: q, quote, model }),
    });
    const d = await res.json().catch(() => ({}));
    thinking.remove();
    if (!res.ok) throw new Error(d.error || 'Request failed');
    appendMsg('ai', d.answer || '(no answer)', d.sources || []);
  } catch (e) {
    thinking.remove();
    appendMsg('ai', '⚠️ ' + (e.message || 'Request failed'));
  } finally {
    chatBusy = false;
  }
}

function appendMsg(role, text, sources, thinking) {
  const hintEl = document.getElementById('chat-hint');
  if (hintEl) hintEl.remove();
  const wrap = document.createElement('div');
  wrap.className = 'chat-msg ' + role + (thinking ? ' thinking' : '');
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  // AI 回答按 Markdown 渲染；用户消息与「思考中…」保持纯文本
  if (role === 'ai' && !thinking && window.renderMarkdown) {
    bubble.classList.add('md');
    bubble.innerHTML = window.renderMarkdown(text);
  } else {
    bubble.textContent = text;
  }
  wrap.appendChild(bubble);
  if (sources && sources.length) {
    const src = document.createElement('div');
    src.className = 'chat-sources';
    src.innerHTML = '<span class="cs-label">Related sections</span>'
      + sources.map((h) => `<button class="cs-chip" data-h="${escapeAttr(h)}">${escapeHTML(h)}</button>`).join('');
    wrap.appendChild(src);
  }
  chatMsgs.appendChild(wrap);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
  return wrap;
}

// 点「相关位置」标题 -> 复用 TOC 跳转定位
chatMsgs.addEventListener('click', (e) => {
  const chip = e.target.closest('.cs-chip');
  if (chip) jumpToHeading(chip.dataset.h);
});
function jumpToHeading(title) {
  if (!title || !tocItems.length) return;
  let it = tocItems.find((t) => t.title === title);
  if (!it) it = tocItems.find((t) => t.title && (t.title.includes(title) || title.includes(t.title)));
  if (it && it.jump) { it.jump(); showBar(); }
}

// ========== 阅读偏好（字号/行距/宽度/色温，按课程存云端 prefs 表） ==========
const DEFAULT_READ_PREFS = { scale: 100, lh: 0, width: 820, warm: 0 };  // lh=0 表示不覆盖原排版
let readPrefs = { ...DEFAULT_READ_PREFS };
const prefsLoaded = (async () => {
  // 分享模式无账号，读偏好走本地 localStorage（仍可个性化，但不入账号）
  if (shareMode) {
    try {
      const p = JSON.parse(localStorage.getItem('nb-share-prefs') || 'null');
      if (p) for (const k of Object.keys(DEFAULT_READ_PREFS)) if (p[k] != null) readPrefs[k] = p[k];
    } catch {}
    await Promise.resolve();   // 让出一拍，确保下方 const（prefScale 等）已初始化，避免 TDZ
    syncPrefsUI();
    return;
  }
  try {
    const r = await fetch(`/api/prefs?key=${encodeURIComponent('reader:' + file)}`);
    const d = await r.json();
    if (d && d.value) {
      const p = JSON.parse(d.value);
      for (const k of Object.keys(DEFAULT_READ_PREFS)) if (p[k] != null) readPrefs[k] = p[k];
    }
  } catch {}
  syncPrefsUI();
})();

let prefsSaveT = null;
function saveReadPrefs() {
  if (shareMode) {
    try { localStorage.setItem('nb-share-prefs', JSON.stringify(readPrefs)); } catch {}
    return;
  }
  clearTimeout(prefsSaveT);
  prefsSaveT = setTimeout(() => {
    fetch('/api/prefs', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'reader:' + file, value: JSON.stringify(readPrefs) }),
    }).catch(() => {});
  }, 600);
}

function applyReadPrefs() {
  if (usesViewer) { postToViewer({ type: 'nb-read-prefs', prefs: readPrefs }); return; }
  // html 笔记：字号用 zoom 整体缩放（不破坏自带排版），行距只覆盖正文段落，色温用 sepia 滤镜
  const doc = iframe.contentDocument;
  if (!doc || !doc.body) return;
  doc.body.style.zoom = readPrefs.scale === 100 ? '' : String(readPrefs.scale / 100);
  let st = doc.getElementById('nb-pref-style');
  if (!st) { st = doc.createElement('style'); st.id = 'nb-pref-style'; (doc.head || doc.documentElement).appendChild(st); }
  st.textContent = readPrefs.lh > 0 ? `body p, body li { line-height: ${readPrefs.lh} !important; }` : '';
  doc.body.style.filter = readPrefs.warm > 0 ? `sepia(${readPrefs.warm})` : '';
}

const prefsToggle = document.getElementById('prefs-toggle');
const prefScale = document.getElementById('pref-scale');
const prefScaleVal = document.getElementById('pref-scale-val');

prefsToggle.addEventListener('click', () => {
  if (!prefsPanel.hidden) { prefsPanel.hidden = true; return; }
  tocPanel.hidden = true;
  bookmarksPanel.hidden = true;
  moreMenu.hidden = true;
  prefsPanel.hidden = false;
  showBar();
});
document.getElementById('prefs-close').addEventListener('click', () => { prefsPanel.hidden = true; });

// 按文档类型隐藏不适用的控件：PDF 只支持色温；HTML 页面自带排版，不支持宽度
if (kind === 'pdf') {
  document.getElementById('pref-row-scale').hidden = true;
  document.getElementById('pref-row-lh').hidden = true;
  document.getElementById('pref-row-width').hidden = true;
  document.getElementById('prefs-tip').textContent = 'PDF keeps its original layout — only warmth can be adjusted here.';
} else if (kind === 'html') {
  document.getElementById('pref-row-width').hidden = true;
}

prefScale.addEventListener('input', () => {
  readPrefs.scale = parseInt(prefScale.value, 10) || 100;
  prefScaleVal.textContent = readPrefs.scale + '%';
  applyReadPrefs();
  saveReadPrefs();
});
prefsPanel.addEventListener('click', (e) => {
  const lhBtn = e.target.closest('[data-lh]');
  const wBtn = e.target.closest('[data-width]');
  const warmBtn = e.target.closest('[data-warm]');
  if (lhBtn) readPrefs.lh = parseFloat(lhBtn.dataset.lh) || 0;
  else if (wBtn) readPrefs.width = parseInt(wBtn.dataset.width, 10) || 820;
  else if (warmBtn) readPrefs.warm = parseFloat(warmBtn.dataset.warm) || 0;
  else return;
  syncPrefsUI();
  applyReadPrefs();
  saveReadPrefs();
});
document.getElementById('pref-reset').addEventListener('click', () => {
  readPrefs = { ...DEFAULT_READ_PREFS };
  syncPrefsUI();
  applyReadPrefs();
  saveReadPrefs();
});

function syncPrefsUI() {
  prefScale.value = String(readPrefs.scale);
  prefScaleVal.textContent = readPrefs.scale + '%';
  const mark = (sel, isOn) => prefsPanel.querySelectorAll(sel).forEach((b) => b.classList.toggle('active', isOn(b)));
  mark('[data-lh]', (b) => parseFloat(b.dataset.lh) === (readPrefs.lh || 0));
  mark('[data-width]', (b) => parseInt(b.dataset.width, 10) === readPrefs.width);
  mark('[data-warm]', (b) => parseFloat(b.dataset.warm) === (readPrefs.warm || 0));
}

// ========== 专注模式（内部能力保留，UI 入口已随「更多」菜单移除） ==========
let focusMode = false;
let splitMode = false;
function updateMoreStates() {}   // 「更多」菜单已移除，保留空函数兼容历史调用

function setFocus(on) {
  focusMode = !!on;
  if (focusMode) bar.classList.add('hidden');
}
function setSplit(on) {
  splitMode = !!on;
  document.body.classList.toggle('split-chat', splitMode);
  if (splitMode && chatPanel.hidden) openChat();
}

// ========== 分享：设置有效期（最长一年）→ 生成只读链接 ==========
const shareBtn = document.getElementById('share-btn');
const shareModal = document.getElementById('share-modal');
const shareExp = document.getElementById('share-exp');
const shareGenBtn = document.getElementById('share-gen');
const shareResult = document.getElementById('share-result');
const shareLinkInput = document.getElementById('share-link');
const shareExpiryEl = document.getElementById('share-expiry');
let shareDays = 0;

if (shareBtn) shareBtn.addEventListener('click', openShareModal);
function openShareModal() {
  shareDays = 0;
  shareExp.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
  shareGenBtn.disabled = true;
  shareGenBtn.textContent = 'Create link';
  shareResult.hidden = true;
  prefsPanel.hidden = true;
  shareModal.hidden = false;
  showBar();
}
function closeShareModal() { shareModal.hidden = true; }

if (shareExp) shareExp.addEventListener('click', (e) => {
  const b = e.target.closest('[data-days]');
  if (!b) return;
  shareDays = parseInt(b.dataset.days, 10) || 0;
  shareExp.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  shareGenBtn.disabled = !shareDays;
});
document.getElementById('share-cancel')?.addEventListener('click', closeShareModal);
if (shareModal) shareModal.addEventListener('click', (e) => { if (e.target === shareModal) closeShareModal(); });

if (shareGenBtn) shareGenBtn.addEventListener('click', async () => {
  if (!shareDays) { toast('Pick an expiry first'); return; }
  shareGenBtn.disabled = true;
  shareGenBtn.textContent = 'Creating…';
  try {
    const res = await fetch('/api/share', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, days: shareDays }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'Failed to create link');
    const url = new URL(d.url, location.origin).href;
    shareLinkInput.value = url;
    const exp = new Date(d.expires_at);
    const pad = (n) => String(n).padStart(2, '0');
    shareExpiryEl.textContent = `Link valid until ${exp.getFullYear()}-${pad(exp.getMonth() + 1)}-${pad(exp.getDate())} ${pad(exp.getHours())}:${pad(exp.getMinutes())}`;
    shareResult.hidden = false;
    shareGenBtn.textContent = 'Regenerate';
    try { await navigator.clipboard.writeText(url); toast('Link created and copied'); }
    catch { toast('Link created'); }
    shareLinkInput.focus();
    shareLinkInput.select();
  } catch (e) {
    toast('Share failed: ' + (e.message || 'unknown error'));
    shareGenBtn.textContent = 'Create link';
  } finally {
    shareGenBtn.disabled = !shareDays;
  }
});
document.getElementById('share-copy')?.addEventListener('click', async () => {
  if (!shareLinkInput.value) return;
  try { await navigator.clipboard.writeText(shareLinkInput.value); toast('Copied'); }
  catch { shareLinkInput.select(); try { document.execCommand('copy'); toast('Copied'); } catch {} }
});

// 轻提示
let toastT = null;
function toast(msg) {
  let el = document.getElementById('nb-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'nb-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 2600);
}

// ===== 建立 / 校验索引 =====
async function ensureIndexed() {
  if (kind === 'pdf') { ragSupported = false; setChatStatus('Full-text search isn’t available for PDFs — ask using highlights / bookmarks'); return; }
  let sections = [];
  try { sections = kind === 'md' ? await extractSectionsMd() : extractSectionsFromDoc(iframe.contentDocument); } catch {}
  const joined = sections.map((s) => s.text).join('\n').trim();
  if (!joined) { setChatStatus(''); return; }
  const hash = hashText(joined);
  try {
    const st = await fetch(`/api/rag/status?file=${encodeURIComponent(file)}`).then((r) => r.json());
    if (st.hasVectorize === false) { ragSupported = false; setChatStatus('Vector search not enabled'); return; }
    if (st.indexed && st.hash === hash) { setChatStatus(st.chunks ? `Indexed ${st.chunks} sections` : ''); return; }
  } catch {}
  setChatStatus('Indexing…');
  try {
    const res = await fetch('/api/rag/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, hash, sections }),
    });
    const d = await res.json().catch(() => ({}));
    setChatStatus(res.ok ? (d.chunks ? `Indexed ${d.chunks} sections` : '') : 'Indexing failed (you can still ask)');
  } catch { setChatStatus('Indexing failed (you can still ask)'); }
}

// html：用 Range 取每个 h1-h3 标题到下一个标题之间的纯文本，保留小节结构
function extractSectionsFromDoc(doc) {
  const body = doc && doc.body;
  if (!body) return [];
  const heads = [...body.querySelectorAll('h1, h2, h3')];
  if (!heads.length) {
    const t = (body.innerText || body.textContent || '').replace(/\s+/g, ' ').trim();
    return t ? [{ heading: 'Full text', level: 0, text: t.slice(0, 4000) }] : [];
  }
  const sections = [];
  try {
    const r0 = doc.createRange(); r0.setStart(body, 0); r0.setEndBefore(heads[0]);
    const lead = r0.toString().replace(/\s+/g, ' ').trim();
    if (lead) sections.push({ heading: '(intro)', level: 0, text: lead.slice(0, 4000) });
  } catch {}
  heads.forEach((h, i) => {
    const title = (h.textContent || '').trim();
    if (!title) return;
    let text = '';
    try {
      const r = doc.createRange();
      r.setStartAfter(h);
      if (i + 1 < heads.length) r.setEndBefore(heads[i + 1]); else r.setEndAfter(body.lastChild || body);
      text = r.toString().replace(/\s+/g, ' ').trim();
    } catch {}
    sections.push({ heading: title, level: +h.tagName[1], text: (title + '。' + text).slice(0, 4000) });
  });
  return sections;
}

async function extractSectionsMd() {
  let raw = '';
  try { raw = await fetch(sourceURL).then((r) => r.text()); } catch { return []; }
  const lines = String(raw).split(/\r?\n/);
  const out = [];
  let cur = { heading: '(intro)', level: 0, lines: [] };
  for (const ln of lines) {
    const m = /^(#{1,3})\s+(.*)/.exec(ln);
    if (m) {
      if (cur.lines.join('').trim() || cur.heading !== '(intro)') out.push(cur);
      cur = { heading: m[2].trim(), level: m[1].length, lines: [] };
    } else cur.lines.push(ln);
  }
  if (cur.lines.join('').trim() || !out.length) out.push(cur);
  return out
    .map((s) => ({
      heading: s.heading, level: s.level,
      text: (s.heading + '。' + s.lines.join(' ')).replace(/[#*`>_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000),
    }))
    .filter((s) => s.text);
}

function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function escapeHTML(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHTML(s); }
