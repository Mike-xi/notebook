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
const chatToggle = document.getElementById('chat-toggle');
const chatPanel = document.getElementById('chat-panel');

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
    if (win && doc && root) NBHighlights.init({ doc, win, root, file, onAskAI: askFromSelection });
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
  const y = win.scrollY;
  const revealT = barRevealThreshold();
  if (y > lastScrollY + 6 && y > 120) {
    hideBar();
  } else if (y < lastScrollY - revealT) {
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
  if (chatPanel && !chatPanel.hidden) return;
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
    chatPanel.hidden = true;
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
  chatPanel.hidden = true;
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
    if (!chatPanel.hidden) { chatPanel.hidden = true; return; }
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
  tocPanel.hidden = true;
  bookmarksPanel.hidden = true;
  chatPanel.hidden = false;
  showBar();
  if (!ragTriggered) { ragTriggered = true; ensureIndexed(); }
  setTimeout(() => chatInput && chatInput.focus(), 30);
}

chatToggle.addEventListener('click', () => {
  if (!chatPanel.hidden) chatPanel.hidden = true; else openChat();
});
document.getElementById('chat-close').addEventListener('click', () => { chatPanel.hidden = true; });

// 划词 -> 问 AI：打开面板并带入选中文本
function askFromSelection(text) {
  const t = (text || '').trim();
  if (!t) return;
  openChat();
  currentQuote = t;
  chatQuoteBox.hidden = false;
  chatQuoteBox.innerHTML = `<span class="cq-label">划选</span><span class="cq-text">${escapeHTML(t.slice(0, 140))}${t.length > 140 ? '…' : ''}</span><button class="cq-clear" title="取消">✕</button>`;
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
  appendMsg('user', q + (quote ? '　🔖（针对划选内容）' : ''));
  chatInput.value = ''; autoGrow(); clearQuote();
  chatBusy = true;
  const thinking = appendMsg('ai', '思考中…', null, true);
  try {
    const model = chatModelSelect ? chatModelSelect.value : undefined;
    const res = await fetch('/api/rag/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, question: q, quote, model }),
    });
    const d = await res.json().catch(() => ({}));
    thinking.remove();
    if (!res.ok) throw new Error(d.error || '请求失败');
    appendMsg('ai', d.answer || '(没有得到回答)', d.sources || []);
  } catch (e) {
    thinking.remove();
    appendMsg('ai', '⚠️ ' + (e.message || '请求失败'));
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
  bubble.textContent = text;
  wrap.appendChild(bubble);
  if (sources && sources.length) {
    const src = document.createElement('div');
    src.className = 'chat-sources';
    src.innerHTML = '<span class="cs-label">📍 相关位置</span>'
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

// ===== 建立 / 校验索引 =====
async function ensureIndexed() {
  if (kind === 'pdf') { ragSupported = false; setChatStatus('PDF 暂不支持全文检索，可基于高亮/书签问答'); return; }
  let sections = [];
  try { sections = kind === 'md' ? await extractSectionsMd() : extractSectionsFromDoc(iframe.contentDocument); } catch {}
  const joined = sections.map((s) => s.text).join('\n').trim();
  if (!joined) { setChatStatus(''); return; }
  const hash = hashText(joined);
  try {
    const st = await fetch(`/api/rag/status?file=${encodeURIComponent(file)}`).then((r) => r.json());
    if (st.hasVectorize === false) { ragSupported = false; setChatStatus('未启用向量检索'); return; }
    if (st.indexed && st.hash === hash) { setChatStatus(st.chunks ? `已索引 ${st.chunks} 段` : ''); return; }
  } catch {}
  setChatStatus('正在建立索引…');
  try {
    const res = await fetch('/api/rag/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, hash, sections }),
    });
    const d = await res.json().catch(() => ({}));
    setChatStatus(res.ok ? (d.chunks ? `已索引 ${d.chunks} 段` : '') : '索引失败（仍可直接提问）');
  } catch { setChatStatus('索引失败（仍可直接提问）'); }
}

// html：用 Range 取每个 h1-h3 标题到下一个标题之间的纯文本，保留小节结构
function extractSectionsFromDoc(doc) {
  const body = doc && doc.body;
  if (!body) return [];
  const heads = [...body.querySelectorAll('h1, h2, h3')];
  if (!heads.length) {
    const t = (body.innerText || body.textContent || '').replace(/\s+/g, ' ').trim();
    return t ? [{ heading: '全文', level: 0, text: t.slice(0, 4000) }] : [];
  }
  const sections = [];
  try {
    const r0 = doc.createRange(); r0.setStart(body, 0); r0.setEndBefore(heads[0]);
    const lead = r0.toString().replace(/\s+/g, ' ').trim();
    if (lead) sections.push({ heading: '(开头)', level: 0, text: lead.slice(0, 4000) });
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
  let cur = { heading: '(开头)', level: 0, lines: [] };
  for (const ln of lines) {
    const m = /^(#{1,3})\s+(.*)/.exec(ln);
    if (m) {
      if (cur.lines.join('').trim() || cur.heading !== '(开头)') out.push(cur);
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
