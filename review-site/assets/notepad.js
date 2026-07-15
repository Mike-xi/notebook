// 手写笔记 v4：书架 + 分页 Canvas 笔记（仿 GoodNotes）。
// - Pencil 优先输入：pen 压感、合并事件高频采样、手掌拒绝、双指移动/缩放
// - 活动笔迹独立 Canvas + rAF 合成，书写时不再反复重画整页历史笔迹
// - 页面元素 items：图片（拖动/角柄或双指捏合缩放/裁切）与 Markdown 文本块
// - 视图：竖直滚动（默认，多页纵向堆叠、滚动自动切页）/ 水平翻页 两种模式；−/+ 缩放
// - 新增页插入到当前页之后；缩略图条可拖拽换序；双指轻点=撤销、三指=重做
// - 导出整本 PDF（jsPDF）；导入 PDF（pdf.js 每页转图片作页面底图）
// - 数据按登录密码隔离（owner），自动保存到 /api/notepad/*；图片字节存 R2 asset
import { getStroke } from 'https://esm.sh/perfect-freehand@1.2.2';
import { clampRect, applyCrop, resizeKeepAspect } from './notepad-geom.js';
import { createMultiTapDetector } from './notepad-gestures.js';

const PAGE_W = 1240, PAGE_H = 1754; // 逻辑坐标系（A4 比例），显示尺寸靠 CSS/transform 缩放
const PALETTE = ['#1c1c1e', '#f5f0e6', '#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1'];
const SIZES = [{ label: '细', v: 6 }, { label: '中', v: 11 }, { label: '粗', v: 18 }];
const PAPERS = [
  { v: 'blank', label: '空白' }, { v: 'lined', label: '横线' }, { v: 'grid', label: '方格' },
  { v: 'dotted', label: '点阵' }, { v: 'cornell', label: '康奈尔' },
];
const COVERS = ['cover-01', 'cover-02', 'cover-03', 'cover-04', 'cover-05', 'cover-06', 'cover-07', 'cover-08'];
const ERASE_R = 26;
const SAVE_DEBOUNCE = 900;
const THUMB_W = 320;
const PREVIEW_W = 640;
const ZOOM_MIN = 0.5, ZOOM_MAX = 2.5, ZOOM_STEP = 0.1;
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';
const JSPDF_URL = 'https://esm.sh/jspdf@2.5.2';

const $ = (sel) => document.querySelector(sel);
const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, size) => (window.NBIcon ? window.NBIcon(name, { size }) : '');
const uid = () => 'it' + Math.random().toString(36).slice(2, 10);
const assetUrl = (key) => '/api/notepad/asset?key=' + encodeURIComponent(key);

const state = {
  books: [],
  currentBook: null,
  pages: [],
  currentPageIdx: 0,
  currentPageId: null,
  strokes: [],
  items: [],
  undo: [], redo: [],
  liveStroke: null,
  erasing: false,
  tool: 'pen',
  color: '#1c1c1e', // 纸张恒浅色（见 drawPaperTo），默认墨色黑
  size: 11,
  paper: 'blank',
  dirty: false,
  selectedId: null,
  editingId: null,
  crop: null,        // { itemId, rect:{rx,ry,rw,rh} }
  layerScale: 1,
};

// 视图偏好（跨会话记忆；禅模式收起工具栏也不影响）
const view = {
  flip: localStorage.getItem('np-flip') === 'h' ? 'h' : 'v',       // v=竖直滚动 h=水平翻页
  zoom: Math.min(Math.max(parseFloat(localStorage.getItem('np-zoom')) || 1, ZOOM_MIN), ZOOM_MAX),
};

// iPadOS 13.4+ 会把 Apple Pencil 暴露为 pointerType=pen。Pencil 模式下，单指/手掌不再交给
// Safari 做选择或滚动，只有两个明确的指尖接触才用于移动和缩放页面。
const savedInputMode = localStorage.getItem('np-input-mode');
const isIPad = /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const input = {
  hasTouch: navigator.maxTouchPoints > 0,
  isIPad,
  mode: savedInputMode === 'pencil' || savedInputMode === 'touch' ? savedInputMode : (isIPad ? 'pencil' : 'touch'),
  explicitMode: savedInputMode === 'pencil' || savedInputMode === 'touch',
  activePen: null,
  lastPenAt: -Infinity,
  detectedPen: false,
};
const navTouches = new Map();
let touchGesture = null;

function isEditableTarget(target) {
  return !!(target?.closest && target.closest('textarea,input,[contenteditable="true"]'));
}

function updateInputModeUI() {
  document.body.classList.toggle('pencil-mode', input.mode === 'pencil');
  document.body.classList.toggle('touch-device', input.hasTouch);
  const btn = $('#btn-input-mode');
  if (!btn) return;
  const pencil = input.mode === 'pencil';
  btn.classList.toggle('on', pencil);
  btn.setAttribute('aria-pressed', String(pencil));
  btn.title = pencil
    ? 'Pencil 防误触已开启：单指/手掌忽略，双指移动与缩放'
    : '手指浏览：单指滚动；点此开启 Pencil 防误触';
  btn.setAttribute('aria-label', btn.title);
  $('#input-mode-label').textContent = pencil ? 'Pencil' : '触控';
}

function setInputMode(mode, { persist = false, announce = false } = {}) {
  input.mode = mode === 'pencil' ? 'pencil' : 'touch';
  if (persist) {
    input.explicitMode = true;
    localStorage.setItem('np-input-mode', input.mode);
  }
  finishTouchNavigation($('#page-surface-wrap'), true);
  updateInputModeUI();
  if (announce) toast(input.mode === 'pencil'
    ? 'Pencil 防误触已开启 · 单指/手掌忽略，双指移动缩放'
    : '手指浏览已开启 · 单指可滚动页面', 2800);
}

function isPalmContact(e) {
  // Pointer Events 的 width/height 是接触椭圆的 CSS 像素尺寸；Safari 能提供时可先排除大面积手掌。
  return Math.max(Number(e.width) || 0, Number(e.height) || 0) >= 38;
}

function touchPair() {
  return [...navTouches.values()].filter((p) => !p.blocked).slice(0, 2);
}

function beginTouchNavigation(wrap) {
  const pts = touchPair();
  if (pts.length < 2) return;
  const rect = wrap.getBoundingClientRect();
  const cx = (pts[0].x + pts[1].x) / 2 - rect.left;
  const cy = (pts[0].y + pts[1].y) / 2 - rect.top;
  touchGesture = {
    startDistance: Math.max(24, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)),
    startZoom: view.zoom,
    startScrollLeft: wrap.scrollLeft,
    startScrollTop: wrap.scrollTop,
    startCenterX: cx,
    startCenterY: cy,
    zoomDirty: false,
  };
}

function updateTouchNavigation(wrap) {
  const pts = touchPair();
  if (pts.length < 2) return;
  if (!touchGesture) beginTouchNavigation(wrap);
  if (!touchGesture) return;
  const rect = wrap.getBoundingClientRect();
  const cx = (pts[0].x + pts[1].x) / 2 - rect.left;
  const cy = (pts[0].y + pts[1].y) / 2 - rect.top;
  const distance = Math.max(24, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
  const zoom = clamp(Math.round(touchGesture.startZoom * distance / touchGesture.startDistance * 100) / 100, ZOOM_MIN, ZOOM_MAX);
  const ratio = zoom / touchGesture.startZoom;
  if (Math.abs(zoom - view.zoom) >= 0.01) {
    view.zoom = zoom;
    $('#zoom-label').textContent = Math.round(view.zoom * 100) + '%';
    applyWidths();
    touchGesture.zoomDirty = true;
  }
  wrap.scrollLeft = (touchGesture.startScrollLeft + touchGesture.startCenterX) * ratio - cx;
  wrap.scrollTop = (touchGesture.startScrollTop + touchGesture.startCenterY) * ratio - cy;
}

function finishTouchNavigation(wrap, cancel = false) {
  if (touchGesture?.zoomDirty) {
    if (!cancel) localStorage.setItem('np-zoom', String(view.zoom));
    reinitCanvases();
  }
  navTouches.clear();
  touchGesture = null;
}

function penStarted(e) {
  if (e.pointerType !== 'pen') return;
  input.detectedPen = true;
  input.activePen = e.pointerId;
  input.lastPenAt = performance.now();
  finishTouchNavigation($('#page-surface-wrap'), true);
  if (!input.explicitMode && input.mode !== 'pencil') setInputMode('pencil');
  updateInputModeUI();
}

function penFinished(e) {
  if (e.pointerType !== 'pen' || input.activePen !== e.pointerId) return;
  input.activePen = null;
  input.lastPenAt = performance.now();
}

async function api(path, opts) {
  const r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

function toast(msg, ms = 2000) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function timeAgo(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60); if (h < 24) return h + ' 小时前';
  const d = Math.floor(h / 24); if (d < 30) return d + ' 天前';
  return new Date(ts).toLocaleDateString('zh-CN');
}

/* ------------------------------ 纸张绘制（thumb/导出/预览共用） ------------------------------ */

// 纸张背景恒为浅色（像真实纸张），不跟站点深浅色主题——换主题墨迹永远可读。
function drawPaperTo(ctx, paper, w = PAGE_W, h = PAGE_H) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fffdf8';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(0,0,0,.10)';
  ctx.lineWidth = Math.max(1, w / PAGE_W);
  const sx = w / PAGE_W, sy = h / PAGE_H;
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1 * sx, y1 * sy); ctx.lineTo(x2 * sx, y2 * sy); ctx.stroke(); };
  if (paper === 'lined') {
    for (let y = 62; y < PAGE_H; y += 62) line(40, y, PAGE_W - 40, y);
  } else if (paper === 'grid') {
    for (let x = 54; x < PAGE_W; x += 54) line(x, 0, x, PAGE_H);
    for (let y = 54; y < PAGE_H; y += 54) line(0, y, PAGE_W, y);
  } else if (paper === 'dotted') {
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    for (let x = 54; x < PAGE_W; x += 54) for (let y = 54; y < PAGE_H; y += 54) {
      ctx.beginPath(); ctx.arc(x * sx, y * sy, 2 * sx, 0, Math.PI * 2); ctx.fill();
    }
  } else if (paper === 'cornell') {
    // 康奈尔笔记：顶部标题线 + 左侧提示栏竖线 + 底部总结区横线，其余为横线区
    ctx.strokeStyle = 'rgba(179,38,30,.35)';
    ctx.lineWidth = Math.max(1.5, 1.5 * sx);
    line(0, 140, PAGE_W, 140);
    line(310, 140, 310, PAGE_H - 260);
    line(0, PAGE_H - 260, PAGE_W, PAGE_H - 260);
    ctx.strokeStyle = 'rgba(0,0,0,.10)';
    ctx.lineWidth = Math.max(1, sx);
    for (let y = 140 + 62; y < PAGE_H - 260; y += 62) line(330, y, PAGE_W - 40, y);
  }
}

/* ------------------------------ 书架 ------------------------------ */

async function loadShelf() {
  const { books } = await api('/api/notepad/books');
  state.books = books;
  renderShelf();
}

function renderShelf() {
  const grid = $('#book-grid');
  grid.innerHTML = '';
  $('#shelf-empty').hidden = state.books.length > 0;
  for (const b of state.books) {
    const card = document.createElement('div');
    card.className = 'book-card';
    // 封面：选了 SVG 封面用封面图；否则纯色底 + 第一页缩略图（没有缩略图则书本图标）
    const inner = b.cover
      ? `<img src="/assets/notepad-covers/${b.cover}.svg" alt="">`
      : (b.first_thumb ? `<img class="page-peek" src="${b.first_thumb}">` : `<span class="bc-icon">${icon('books', 30)}</span>`);
    card.innerHTML = `
      <div class="book-cover" style="background:${b.color}">
        ${inner}
        <button class="book-edit" title="编辑">${icon('edit', 13)}</button>
        <button class="book-del" title="删除">${icon('trash', 14)}</button>
      </div>
      <div class="book-meta">${escapeHtml(b.title)}</div>
      <div class="book-sub">${b.page_count} 页 · ${timeAgo(b.updated_at)}</div>
    `;
    card.addEventListener('click', (e) => { if (e.target.closest('.book-del') || e.target.closest('.book-edit')) return; openBook(b); });
    card.querySelector('.book-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`删除笔记本《${b.title}》？此操作不可恢复。`)) return;
      await api('/api/notepad/books?id=' + b.id, { method: 'DELETE' });
      await loadShelf();
    });
    card.querySelector('.book-edit').addEventListener('click', (e) => { e.stopPropagation(); openBookModal(b); });
    grid.appendChild(card);
  }
}

/* ------------------------------ 新建/编辑笔记本弹窗 ------------------------------ */

const bookModal = { editing: null, cover: '', color: '#e53935', paper: 'blank' };

function paperPreviewCanvas(paper, w = 60) {
  const c = document.createElement('canvas');
  c.width = w; c.height = Math.round(w * PAGE_H / PAGE_W);
  drawPaperTo(c.getContext('2d'), paper, c.width, c.height);
  return c;
}

function renderBookModalGrids() {
  const cg = $('#nb-cover-grid');
  cg.innerHTML = '';
  PALETTE.slice(2).forEach((c) => {
    const el = document.createElement('div');
    el.className = 'cover-opt' + (!bookModal.cover && bookModal.color === c ? ' on' : '');
    el.innerHTML = `<div class="plain" style="background:${c}"></div>`;
    el.addEventListener('click', () => { bookModal.cover = ''; bookModal.color = c; renderBookModalGrids(); });
    cg.appendChild(el);
  });
  COVERS.forEach((cv) => {
    const el = document.createElement('div');
    el.className = 'cover-opt' + (bookModal.cover === cv ? ' on' : '');
    el.innerHTML = `<img src="/assets/notepad-covers/${cv}.svg" alt="">`;
    el.addEventListener('click', () => { bookModal.cover = cv; renderBookModalGrids(); });
    cg.appendChild(el);
  });
  const pg = $('#nb-paper-grid');
  pg.innerHTML = '';
  PAPERS.forEach((p) => {
    const el = document.createElement('button');
    el.className = 'paper-opt' + (bookModal.paper === p.v ? ' on' : '');
    el.appendChild(paperPreviewCanvas(p.v));
    el.insertAdjacentHTML('beforeend', `<span class="pl">${p.label}</span>`);
    el.addEventListener('click', () => { bookModal.paper = p.v; renderBookModalGrids(); });
    pg.appendChild(el);
  });
}

function openBookModal(book) {
  bookModal.editing = book || null;
  bookModal.cover = book?.cover || '';
  bookModal.color = book?.color || PALETTE[4];
  bookModal.paper = book?.paper || 'blank';
  $('#bm-title').textContent = book ? '编辑笔记本' : '新建笔记本';
  $('#nb-ok').textContent = book ? '保存' : '创建';
  $('#nb-title').value = book?.title || '';
  renderBookModalGrids();
  $('#book-modal').hidden = false;
  if (!book) $('#nb-title').focus();
}

async function submitBookModal() {
  const title = $('#nb-title').value.trim() || '未命名笔记本';
  const payload = { title, color: bookModal.color, cover: bookModal.cover, paper: bookModal.paper };
  if (bookModal.editing) {
    await api('/api/notepad/books', { method: 'PUT', body: JSON.stringify({ id: bookModal.editing.id, ...payload }) });
    $('#book-modal').hidden = true;
    await loadShelf();
  } else {
    const { id } = await api('/api/notepad/books', { method: 'POST', body: JSON.stringify(payload) });
    $('#book-modal').hidden = true;
    await loadShelf();
    const b = state.books.find((x) => x.id === id);
    if (b) openBook(b);
  }
}

/* ------------------------------ 视图系统：slot / 双模式 / 缩放 ------------------------------ */

const previewCache = new Map(); // pageId -> dataURL（PREVIEW_W 宽合成图）
let previewIO = null;           // 懒合成邻页预览
let previewBusy = false;
const previewQueue = [];

function pageCssW() {
  const wrap = $('#page-surface-wrap');
  const base = Math.min((wrap.clientWidth || 720) - 32, 720);
  return Math.max(200, Math.round(base * view.zoom));
}

function slotFor(idx) { return $('#pages-col').querySelector(`.page-slot[data-idx="${idx}"]`); }

function detachSurface() {
  const surf = $('#page-surface');
  if (surf.parentElement && surf.parentElement.classList.contains('page-slot')) {
    const slot = surf.parentElement;
    const img = slot.querySelector('.slot-preview');
    if (img) { img.hidden = false; refreshSlotPreview(slot); }
  }
  surf.style.display = 'none';
  document.body.appendChild(surf);
}

function mountSurface(idx) {
  const slot = slotFor(idx);
  if (!slot) return;
  detachSurface();
  const img = slot.querySelector('.slot-preview');
  if (img) img.hidden = true;
  const surf = $('#page-surface');
  slot.appendChild(surf);
  surf.style.display = 'block';
  syncLayerScale();
}

function slotPreviewSrc(page) {
  return previewCache.get(page.id) || page.thumb || '';
}

function refreshSlotPreview(slot) {
  const idx = parseInt(slot.dataset.idx, 10);
  const page = state.pages[idx];
  if (!page) return;
  const img = slot.querySelector('.slot-preview');
  if (img) img.src = slotPreviewSrc(page);
}

// 竖直模式渲染全部页 slot；水平模式只渲染当前页一个 slot
function renderSlots() {
  detachSurface();
  const col = $('#pages-col');
  col.innerHTML = '';
  if (previewIO) { previewIO.disconnect(); previewIO = null; }
  const w = pageCssW();
  const idxs = view.flip === 'v' ? state.pages.map((_, i) => i) : [state.currentPageIdx];
  for (const i of idxs) {
    const slot = document.createElement('div');
    slot.className = 'page-slot';
    slot.dataset.idx = i;
    slot.style.width = w + 'px';
    const img = document.createElement('img');
    img.className = 'slot-preview';
    img.src = slotPreviewSrc(state.pages[i]) || '';
    slot.appendChild(img);
    slot.insertAdjacentHTML('beforeend', `<span class="slot-num">${i + 1}</span>`);
    // 笔/鼠标点到预览页 → 先激活该页
    slot.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      const idx = parseInt(slot.dataset.idx, 10);
      if (idx !== state.currentPageIdx || !slot.contains($('#page-surface'))) activatePage(idx, { scroll: false });
    });
    col.appendChild(slot);
  }
  mountSurface(state.currentPageIdx);
  if (view.flip === 'v') observePreviews();
}

function observePreviews() {
  previewIO = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const idx = parseInt(en.target.dataset.idx, 10);
      const page = state.pages[idx];
      if (!page || previewCache.has(page.id) || idx === state.currentPageIdx) continue;
      previewQueue.push(page.id);
      pumpPreviewQueue();
    }
  }, { root: $('#page-surface-wrap'), rootMargin: '150% 0px' });
  $('#pages-col').querySelectorAll('.page-slot').forEach((s) => previewIO.observe(s));
}

async function pumpPreviewQueue() {
  if (previewBusy) return;
  previewBusy = true;
  while (previewQueue.length) {
    const pageId = previewQueue.shift();
    if (previewCache.has(pageId)) continue;
    const idx = state.pages.findIndex((p) => p.id === pageId);
    if (idx < 0 || idx === state.currentPageIdx) continue;
    try {
      const d = await api('/api/notepad/page-data?id=' + pageId);
      const canvas = await composePage({ paper: state.pages[idx].paper || 'blank', strokes: d.strokes, items: d.items }, PREVIEW_W);
      previewCache.set(pageId, canvas.toDataURL('image/jpeg', 0.7));
      const slot = slotFor(idx);
      if (slot && idx !== state.currentPageIdx) refreshSlotPreview(slot);
    } catch {}
  }
  previewBusy = false;
}

function applyWidths() {
  const w = pageCssW();
  $('#pages-col').querySelectorAll('.page-slot').forEach((s) => { s.style.width = w + 'px'; });
  syncLayerScale();
}

function zoomTo(z) {
  view.zoom = Math.min(Math.max(Math.round(z * 10) / 10, ZOOM_MIN), ZOOM_MAX);
  localStorage.setItem('np-zoom', String(view.zoom));
  $('#zoom-label').textContent = Math.round(view.zoom * 100) + '%';
  applyWidths();
  reinitCanvases();
}

// 画布物理分辨率随缩放提高，放大后笔迹依然锐利
function canvasFactor() {
  // 旧实现放大到 3× 时单张 A4 Canvas 会占用约 78MB；iPad 上三层画布很容易触发内存回收和掉帧。
  return Math.min((window.devicePixelRatio || 1) * Math.max(1, Math.min(view.zoom, 1.25)), 2);
}
function reinitCanvases() {
  const f = canvasFactor();
  bgCtx = setupCanvas($('#bg-canvas'), f);
  inkCtx = setupCanvas($('#ink-canvas'), f);
  liveCtx = setupCanvas($('#live-canvas'), Math.min(f, 1.5));
  if (state.currentPageId) { drawPaperTo(bgCtx, state.paper); redrawInk(); redrawLive(); }
}

// 激活某页为「编辑中」页面。scroll=false 用于滚动驱动的激活（避免抢滚动）。
let activating = false;
let pendingActivate = null;
async function activatePage(idx, { scroll = true, smooth = false, force = false } = {}) {
  if (idx < 0 || idx >= state.pages.length) return;
  if (activating) { pendingActivate = { idx, opts: { scroll, smooth, force } }; return; }
  if (!force && idx === state.currentPageIdx && slotFor(idx)?.contains($('#page-surface'))) {
    if (scroll && view.flip === 'v') slotFor(idx)?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    return;
  }
  activating = true;
  try {
    await flushSave();
    state.currentPageIdx = idx;
    const page = state.pages[idx];
    state.currentPageId = page.id;
    state.paper = page.paper || state.currentBook.paper || 'blank';
    state.selectedId = null; state.editingId = null; state.crop = null;
    localStorage.setItem('notepad-last-' + state.currentBook.id, String(idx));

    const data = await api('/api/notepad/page-data?id=' + page.id);
    state.strokes = data.strokes || [];
    state.items = data.items || [];
    state.undo = []; state.redo = [];

    if (view.flip === 'h') renderSlots();
    else mountSurface(idx);
    drawPaperTo(bgCtx, state.paper);
    redrawInk();
    renderItems();
    syncUndoButtons();
    updatePagerLabel();
    renderPageStrip();
    if (scroll && view.flip === 'v') slotFor(idx)?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
  } finally {
    activating = false;
    if (pendingActivate) { const p = pendingActivate; pendingActivate = null; activatePage(p.idx, p.opts); }
  }
}

// 滚动驱动：视口中心最近的 slot 成为活动页
let scrollTimer = null;
function onWrapScroll() {
  if (view.flip !== 'v') return;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const wrap = $('#page-surface-wrap');
    const mid = wrap.getBoundingClientRect().top + wrap.clientHeight / 2;
    let best = -1, bestDist = Infinity;
    $('#pages-col').querySelectorAll('.page-slot').forEach((s) => {
      const r = s.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - mid);
      if (d < bestDist) { bestDist = d; best = parseInt(s.dataset.idx, 10); }
    });
    if (best >= 0 && best !== state.currentPageIdx) activatePage(best, { scroll: false });
  }, 140);
}

/* ------------------------------ 笔记本 / 页面 ------------------------------ */

async function openBook(book) {
  state.currentBook = book;
  const { pages } = await api('/api/notepad/pages?book_id=' + book.id);
  state.pages = pages;
  previewCache.clear();
  $('#shelf-view').hidden = true;
  $('#page-view').hidden = false;
  $('#book-title').textContent = book.title;
  const lastIdx = parseInt(localStorage.getItem('notepad-last-' + book.id) || '0', 10);
  const target = Math.min(Math.max(lastIdx, 0), pages.length - 1);
  state.currentPageIdx = target;
  renderSlots();
  await activatePage(target, { scroll: true, force: true });
  renderPageStrip();
  if (input.hasTouch && input.mode === 'pencil' && !sessionStorage.getItem('np-pencil-hint')) {
    sessionStorage.setItem('np-pencil-hint', '1');
    toast('Pencil 防误触已开启 · 单指/手掌忽略，双指移动缩放', 3200);
  }
}

async function backToShelf() {
  await flushSave();
  exitZen();
  detachSurface();
  state.currentBook = null;
  state.selectedId = null; state.editingId = null; state.crop = null;
  previewCache.clear();
  $('#page-view').hidden = true;
  $('#shelf-view').hidden = false;
  await loadShelf();
}

function openPage(idx) { return activatePage(idx, { scroll: true, smooth: view.flip === 'v' }); }

function updatePagerLabel() {
  $('#pg-label').textContent = `${state.currentPageIdx + 1} / ${state.pages.length}`;
  $('#pg-prev').disabled = state.currentPageIdx <= 0;
  $('#pg-next').disabled = state.currentPageIdx >= state.pages.length - 1;
}

// 页面列表变化后统一走这里：重建 slot + 激活目标页
async function pagesChanged(targetIdx) {
  const { pages } = await api('/api/notepad/pages?book_id=' + state.currentBook.id);
  state.pages = pages;
  renderSlots();
  await activatePage(Math.min(Math.max(targetIdx, 0), pages.length - 1), { scroll: true, force: true });
  renderPageStrip();
}

// 新页插入到当前页之后（符合直觉），返回后激活新页
async function addPage(paper) {
  const after = state.currentPageIdx;
  await api('/api/notepad/pages', {
    method: 'POST',
    body: JSON.stringify({ book_id: state.currentBook.id, paper: paper || state.paper, after }),
  });
  await pagesChanged(after + 1);
}

// 复制当前页（codex 建议采纳）。图片资产也复制一份新 key——两页共用同一 asset 会被删页 GC 误删。
async function duplicatePage() {
  await flushSave();
  toast('复制中…', 8000);
  const items = [];
  for (const it of state.items) {
    const copy = JSON.parse(JSON.stringify(it));
    copy.id = uid();
    if (copy.type === 'image' && copy.src) {
      try {
        const blob = await fetch(assetUrl(copy.src)).then((r) => r.blob());
        const ext = copy.src.split('.').pop();
        const r = await fetch('/api/notepad/asset?ext=' + ext, { method: 'POST', body: blob });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'asset copy failed');
        copy.src = d.key;
      } catch { continue; } // 单张图复制失败就跳过它，不整页失败
    }
    items.push(copy);
  }
  const strokes = JSON.parse(JSON.stringify(state.strokes));
  const after = state.currentPageIdx;
  const pg = await api('/api/notepad/pages', {
    method: 'POST',
    body: JSON.stringify({ book_id: state.currentBook.id, paper: state.paper, after }),
  });
  const thumb = state.pages[after]?.thumb || '';
  await api('/api/notepad/page-data?id=' + pg.id, { method: 'PUT', body: JSON.stringify({ strokes, items, thumb }) });
  await pagesChanged(after + 1);
  toast('已复制到下一页');
}

async function deletePage(pageId) {
  if (state.pages.length <= 1) { toast('笔记本至少保留一页'); return; }
  if (!confirm('删除这一页？此操作不可恢复。')) return;
  await api('/api/notepad/pages?id=' + pageId, { method: 'DELETE' });
  previewCache.delete(pageId);
  await pagesChanged(Math.min(state.currentPageIdx, state.pages.length - 2));
}

async function movePage(pageId, to) {
  await api('/api/notepad/pages?id=' + pageId, { method: 'PUT', body: JSON.stringify({ move_to: to }) });
  const keepId = state.currentPageId;
  const { pages } = await api('/api/notepad/pages?book_id=' + state.currentBook.id);
  state.pages = pages;
  const newIdx = pages.findIndex((p) => p.id === keepId);
  renderSlots();
  await activatePage(newIdx >= 0 ? newIdx : 0, { scroll: true, force: true });
  renderPageStrip();
}

/* ---- 缩略图条（含拖拽换序） ---- */

let stripDrag = null; // {pageId, fromIdx, startX, startY, moved, to}
function renderPageStrip() {
  const strip = $('#page-strip');
  strip.innerHTML = '';
  state.pages.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'thumb' + (i === state.currentPageIdx ? ' on' : '');
    el.dataset.idx = i;
    el.innerHTML = `${p.thumb ? `<img src="${p.thumb}">` : ''}<span class="idx">${i + 1}</span><button class="del">${icon('close', 10)}</button>`;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.del')) return;
      if (stripDrag && stripDrag.suppressClick) { stripDrag = null; return; }
      openPage(i);
    });
    el.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); deletePage(p.id); });
    // 拖拽换序
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.del')) return;
      stripDrag = { pageId: p.id, fromIdx: i, startX: e.clientX, startY: e.clientY, moved: false, to: i, el };
      try { el.setPointerCapture(e.pointerId); } catch {}
    });
    el.addEventListener('pointermove', (e) => {
      if (!stripDrag || stripDrag.el !== el) return;
      if (!stripDrag.moved && Math.hypot(e.clientX - stripDrag.startX, e.clientY - stripDrag.startY) < 8) return;
      stripDrag.moved = true;
      el.classList.add('dragging');
      const thumbs = [...strip.querySelectorAll('.thumb:not(.add)')];
      let to = thumbs.length - 1;
      for (let k = 0; k < thumbs.length; k++) {
        const r = thumbs[k].getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) { to = k; break; }
      }
      stripDrag.to = to;
      thumbs.forEach((t, k) => {
        t.classList.toggle('drop-before', stripDrag.moved && k === to && to !== stripDrag.fromIdx);
      });
    });
    const endDrag = async (e) => {
      if (!stripDrag || stripDrag.el !== el) return;
      const d = stripDrag;
      strip.querySelectorAll('.thumb').forEach((t) => t.classList.remove('dragging', 'drop-before'));
      if (d.moved) {
        d.suppressClick = true;
        // 目标插入位换算：拖到自己右边时目标索引要 -1（先移除再插入）
        let to = d.to;
        if (to > d.fromIdx) to -= 1;
        if (to !== d.fromIdx) await movePage(d.pageId, to);
        else stripDrag = null;
      } else stripDrag = null;
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', () => { strip.querySelectorAll('.thumb').forEach((t) => t.classList.remove('dragging', 'drop-before')); stripDrag = null; });
    strip.appendChild(el);
  });
  const add = document.createElement('div');
  add.className = 'thumb add';
  add.innerHTML = icon('plus', 18);
  add.addEventListener('click', () => openAddPageModal());
  strip.appendChild(add);
}

function openAddPageModal() {
  const grid = $('#ap-paper-grid');
  grid.innerHTML = '';
  PAPERS.forEach((p) => {
    const el = document.createElement('button');
    el.className = 'paper-opt' + (p.v === state.paper ? ' on' : '');
    el.appendChild(paperPreviewCanvas(p.v));
    el.insertAdjacentHTML('beforeend', `<span class="pl">${p.label}</span>`);
    el.addEventListener('click', async () => { $('#addpage-modal').hidden = true; await addPage(p.v); });
    grid.appendChild(el);
  });
  $('#addpage-modal').hidden = false;
}

/* ------------------------------ 画布 ------------------------------ */

let bgCtx, inkCtx, liveCtx;
function setupCanvas(cv, factor) {
  const f = factor || (window.devicePixelRatio || 1);
  cv.width = Math.round(PAGE_W * f);
  cv.height = Math.round(PAGE_H * f);
  const ctx = cv.getContext('2d');
  ctx.scale(f, f);
  return ctx;
}

function strokeOptions(s) {
  if (s.tool === 'highlighter') return {
    size: s.size * 2.6, thinning: 0, smoothing: 0.72, streamline: 0.28, simulatePressure: false,
    start: { cap: true }, end: { cap: true },
  };
  return {
    size: s.size, thinning: 0.56, smoothing: 0.68, streamline: 0.32, simulatePressure: s.simulated,
    start: { cap: true }, end: { cap: true },
  };
}

function paintStroke(ctx, s, scale = 1) {
  if (!s.pts.length) return;
  const outline = getStroke(s.pts, strokeOptions(s));
  if (!outline.length) return;
  ctx.beginPath();
  ctx.moveTo(outline[0][0] * scale, outline[0][1] * scale);
  for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0] * scale, outline[i][1] * scale);
  ctx.closePath();
  ctx.fillStyle = s.color;
  ctx.globalAlpha = s.tool === 'highlighter' ? 0.38 : 1;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function redrawInk() {
  inkCtx.clearRect(0, 0, PAGE_W, PAGE_H);
  for (const s of state.strokes) paintStroke(inkCtx, s);
}

function redrawLive() {
  if (!liveCtx) return;
  liveCtx.clearRect(0, 0, PAGE_W, PAGE_H);
  if (state.liveStroke) paintStroke(liveCtx, state.liveStroke);
}

function toLocal(e) {
  const rect = $('#live-canvas').getBoundingClientRect();
  const x = (e.clientX - rect.left) * (PAGE_W / rect.width);
  const y = (e.clientY - rect.top) * (PAGE_H / rect.height);
  const rawPressure = e.pressure > 0 ? e.pressure : (e.pointerType === 'pen' ? 0.14 : 0.5);
  const pressure = clamp(Math.pow(rawPressure, 0.86), 0.05, 1);
  return { x, y, pressure };
}

function pointSegmentDistanceSquared(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return (px - ax) ** 2 + (py - ay) ** 2;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1);
  return (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
}

function strokeHit(s, pt) {
  const radius = ERASE_R + Math.max(2, Number(s.size) || 0) * (s.tool === 'highlighter' ? 1.2 : 0.45);
  if (s.pts.length === 1) return (s.pts[0][0] - pt.x) ** 2 + (s.pts[0][1] - pt.y) ** 2 <= radius * radius;
  for (let i = 1; i < s.pts.length; i++) {
    if (pointSegmentDistanceSquared(pt.x, pt.y, s.pts[i - 1][0], s.pts[i - 1][1], s.pts[i][0], s.pts[i][1]) <= radius * radius) return true;
  }
  return false;
}

let eraseBatch = null;
function eraseAt(pt) {
  let hit = false;
  for (let i = state.strokes.length - 1; i >= 0; i--) {
    const s = state.strokes[i];
    if (strokeHit(s, pt)) {
      state.strokes.splice(i, 1);
      if (eraseBatch) eraseBatch.push({ stroke: s, index: i });
      hit = true;
    }
  }
  if (hit) redrawInk();
}

let activePointerId = null;
let liveFrame = 0;
function scheduleLiveRedraw() {
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => { liveFrame = 0; redrawLive(); });
}

function appendPointerSamples(e) {
  if (!state.liveStroke) return;
  let samples = [e];
  try {
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    if (coalesced?.length) samples = [...coalesced, e];
  } catch {}
  for (const sample of samples) {
    const pt = toLocal(sample);
    const last = state.liveStroke.pts[state.liveStroke.pts.length - 1];
    if (last && (last[0] - pt.x) ** 2 + (last[1] - pt.y) ** 2 < 0.025 && Math.abs(last[2] - pt.pressure) < 0.002) continue;
    state.liveStroke.pts.push([pt.x, pt.y, pt.pressure]);
  }
}

function onDown(e) {
  if (e.pointerType === 'touch') return; // 手指仅滚动/手势，不画（palm rejection）
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  penStarted(e);
  const ink = $('#live-canvas');
  try { ink.setPointerCapture(e.pointerId); } catch {} // 合成指针可能拒绝捕获，不影响绘制
  activePointerId = e.pointerId;
  const pt = toLocal(e);
  if (state.tool === 'eraser') { state.erasing = true; eraseBatch = []; eraseAt(pt); return; }
  state.liveStroke = { tool: state.tool, color: state.color, size: state.size, simulated: e.pointerType === 'mouse', pts: [[pt.x, pt.y, pt.pressure]] };
  redrawLive();
}
function onMove(e) {
  if (e.pointerId !== activePointerId) return;
  if (e.pointerType === 'pen') input.lastPenAt = performance.now();
  if (state.tool === 'eraser') {
    if (state.erasing) {
      const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      (samples?.length ? samples : [e]).forEach((sample) => eraseAt(toLocal(sample)));
    }
    return;
  }
  if (!state.liveStroke) return;
  appendPointerSamples(e);
  scheduleLiveRedraw();
}
function onUp(e) {
  if (e.pointerId !== activePointerId) return;
  activePointerId = null;
  penFinished(e);
  state.erasing = false;
  if (eraseBatch?.length) pushOp({ type: 'erase-batch', strokes: eraseBatch });
  eraseBatch = null;
  if (state.liveStroke && state.liveStroke.pts.length >= 1) {
    state.strokes.push(state.liveStroke);
    pushOp({ type: 'add', stroke: state.liveStroke });
  }
  state.liveStroke = null;
  if (liveFrame) { cancelAnimationFrame(liveFrame); liveFrame = 0; }
  redrawLive();
  redrawInk();
}

/* ------------------------------ 撤销 / 重做（笔迹 + items 统一栈） ------------------------------ */

function pushOp(op) {
  state.undo.push(op);
  state.redo.length = 0;
  if (state.undo.length > 200) state.undo.shift();
  syncUndoButtons();
  scheduleSave();
}
function findItem(id) { return state.items.find((x) => x.id === id); }
function applyOp(op, dir) {
  if (op.type === 'add') {
    if (dir === 'undo') { const i = state.strokes.indexOf(op.stroke); if (i >= 0) state.strokes.splice(i, 1); }
    else state.strokes.push(op.stroke);
    redrawInk();
  } else if (op.type === 'erase') {
    if (dir === 'undo') state.strokes.splice(Math.min(op.index, state.strokes.length), 0, op.stroke);
    else { const i = state.strokes.indexOf(op.stroke); if (i >= 0) state.strokes.splice(i, 1); }
    redrawInk();
  } else if (op.type === 'erase-batch') {
    if (dir === 'undo') {
      [...op.strokes].sort((a, b) => a.index - b.index)
        .forEach(({ stroke, index }) => state.strokes.splice(Math.min(index, state.strokes.length), 0, stroke));
    } else {
      op.strokes.forEach(({ stroke }) => { const i = state.strokes.indexOf(stroke); if (i >= 0) state.strokes.splice(i, 1); });
    }
    redrawInk();
  } else if (op.type === 'item-add') {
    if (dir === 'undo') { const i = state.items.indexOf(op.item); if (i >= 0) state.items.splice(i, 1); }
    else state.items.push(op.item);
    state.selectedId = null; renderItems();
  } else if (op.type === 'item-del') {
    if (dir === 'undo') state.items.splice(Math.min(op.index, state.items.length), 0, op.item);
    else { const i = state.items.indexOf(op.item); if (i >= 0) state.items.splice(i, 1); }
    state.selectedId = null; renderItems();
  } else if (op.type === 'item-mod') {
    const it = findItem(op.id);
    if (it) Object.assign(it, dir === 'undo' ? op.before : op.after);
    renderItems();
  }
}
function doUndo() {
  const op = state.undo.pop(); if (!op) return;
  applyOp(op, 'undo');
  state.redo.push(op);
  syncUndoButtons(); scheduleSave();
}
function doRedo() {
  const op = state.redo.pop(); if (!op) return;
  applyOp(op, 'redo');
  state.undo.push(op);
  syncUndoButtons(); scheduleSave();
}
function syncUndoButtons() {
  $('#btn-undo').disabled = state.undo.length === 0;
  $('#btn-redo').disabled = state.redo.length === 0;
}

const ITEM_PROPS = ['x', 'y', 'w', 'h', 'crop', 'md'];
function snapItem(it) {
  const s = {};
  for (const k of ITEM_PROPS) if (k in it) s[k] = k === 'crop' && it.crop ? { ...it.crop } : it[k];
  return s;
}

/* ------------------------------ items 层（图片 / 文本块） ------------------------------ */

function syncLayerScale() {
  const surf = $('#page-surface');
  const rect = surf.getBoundingClientRect();
  const scale = rect.width / PAGE_W || 1;
  state.layerScale = scale;
  const layer = $('#items-layer');
  layer.style.transform = `scale(${scale})`;
  layer.style.setProperty('--inv', String(1 / scale));
}

function renderItems() {
  const layer = $('#items-layer');
  layer.innerHTML = '';
  for (const it of state.items) {
    const el = document.createElement('div');
    el.className = 'np-item' + (it.id === state.selectedId ? ' sel' : '');
    el.dataset.id = it.id;
    el.style.left = it.x + 'px';
    el.style.top = it.y + 'px';
    el.style.width = it.w + 'px';
    if (it.type === 'image') el.style.height = it.h + 'px';

    if (it.type === 'image') {
      const box = document.createElement('div');
      box.className = 'np-imgbox';
      const img = document.createElement('img');
      img.src = assetUrl(it.src);
      positionCroppedImg(img, it);
      img.addEventListener('load', () => {
        if (!it.natural) { it.natural = { nw: img.naturalWidth, nh: img.naturalHeight }; positionCroppedImg(img, it); }
      }, { once: true });
      box.appendChild(img);
      el.appendChild(box);
    } else if (it.type === 'text') {
      if (state.editingId === it.id) {
        const ta = document.createElement('textarea');
        ta.className = 'np-edit';
        ta.value = it.md;
        el.appendChild(ta);
        el.insertAdjacentHTML('beforeend', `<div class="np-crop-bar"><button class="no" data-act="tcancel">取消</button><button class="ok" data-act="tok">完成</button></div>`);
        setTimeout(() => { ta.focus(); ta.style.height = 'auto'; ta.style.height = Math.max(120, ta.scrollHeight) + 'px'; el.style.height = ta.style.height; }, 0);
        ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.max(120, ta.scrollHeight) + 'px'; el.style.height = ta.style.height; });
        ta.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); state.editingId = null; renderItems(); } });
      } else {
        const md = document.createElement('div');
        md.className = 'np-md';
        md.innerHTML = window.renderMarkdown ? window.renderMarkdown(it.md) : escapeHtml(it.md);
        el.appendChild(md);
      }
    }

    if (it.id === state.selectedId && state.editingId !== it.id && !(state.crop && state.crop.itemId === it.id)) {
      buildSelectionUi(el, it);
    }

    if (state.crop && state.crop.itemId === it.id) buildCropOverlay(el, it);

    layer.appendChild(el);
  }
  requestAnimationFrame(() => {
    for (const it of state.items) {
      if (it.type !== 'text' || state.editingId === it.id) continue;
      const el = layer.querySelector(`[data-id="${it.id}"]`);
      if (el) it.h = el.offsetHeight;
    }
  });
}

// 选中态 UI（浮动操作条 + 缩放角柄）
function buildSelectionUi(el, it) {
  const bar = document.createElement('div');
  bar.className = 'np-float';
  bar.style.transformOrigin = 'left top';
  bar.style.transform = 'scale(var(--inv))';
  bar.style.top = 'calc(-56px * var(--inv))';
  bar.innerHTML = it.type === 'image'
    ? `<button data-act="crop">${icon('crop', 15)}裁切</button><button class="danger" data-act="del">${icon('trash', 15)}删除</button>`
    : `<button data-act="edit">${icon('edit', 15)}编辑</button><button class="danger" data-act="del">${icon('trash', 15)}删除</button>`;
  el.appendChild(bar);
  const handle = document.createElement('div');
  handle.className = 'np-handle';
  handle.style.width = 'calc(28px * var(--inv))';
  handle.style.height = 'calc(28px * var(--inv))';
  handle.style.right = 'calc(-14px * var(--inv))';
  handle.style.bottom = 'calc(-14px * var(--inv))';
  el.appendChild(handle);
}

// 外科手术式切换选中：不重建 DOM（重建会把正在跟手的元素换掉，导致「选中即拖动」失灵）
function applySelection(id) {
  state.selectedId = id;
  const layer = $('#items-layer');
  layer.querySelectorAll('.np-item').forEach((el) => {
    const isSel = el.dataset.id === id;
    el.classList.toggle('sel', isSel);
    if (!isSel) { el.querySelector('.np-float')?.remove(); el.querySelector('.np-handle')?.remove(); }
    else if (!el.querySelector('.np-handle')) {
      const it = findItem(id);
      if (it && state.editingId !== id && !(state.crop && state.crop.itemId === id)) buildSelectionUi(el, it);
    }
  });
}

// 按 crop 定位 imgbox 内的 img：把裁切区映射铺满容器
function positionCroppedImg(img, it) {
  const n = it.natural;
  if (!n) { img.style.width = '100%'; img.style.height = '100%'; img.style.left = '0'; img.style.top = '0'; return; }
  const c = it.crop || { sx: 0, sy: 0, sw: n.nw, sh: n.nh };
  img.style.width = (it.w * n.nw / c.sw) + 'px';
  img.style.height = (it.h * n.nh / c.sh) + 'px';
  img.style.left = (-c.sx * it.w / c.sw) + 'px';
  img.style.top = (-c.sy * it.h / c.sh) + 'px';
}

/* ---- 选择 / 拖动 / 缩放 / 双指捏合（select 工具） ---- */

let drag = null; // {mode:'move'|'resize'|'pinch', id, start, orig, ptrs:Map, d0, c0}
function layerPt(e) {
  const layer = $('#items-layer');
  const rect = layer.getBoundingClientRect();
  return { x: (e.clientX - rect.left) / state.layerScale, y: (e.clientY - rect.top) / state.layerScale };
}

function onItemPointerDown(e) {
  if (state.tool !== 'select') return;
  const itemEl = e.target.closest('.np-item');
  if (!itemEl) return;
  const id = itemEl.dataset.id;
  const it = findItem(id);
  if (!it) return;
  if (e.target.closest('.np-float') || e.target.closest('.np-crop-bar')) return;
  if (state.crop && state.crop.itemId === id) return;
  if (state.editingId === id) return;
  e.preventDefault();
  if (state.selectedId !== id) { state.editingId = null; applySelection(id); }
  const pt = layerPt(e);
  // 第二根手指落在同一图片上 → 进入捏合缩放
  if (drag && drag.id === id && it.type === 'image' && e.pointerType === 'touch' && drag.ptrs.size === 1) {
    drag.ptrs.set(e.pointerId, pt);
    const pts = [...drag.ptrs.values()];
    drag.mode = 'pinch';
    drag.d0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    drag.pinchOrig = snapItem(it);
    return;
  }
  const isHandle = !!e.target.closest('.np-handle');
  drag = { mode: isHandle ? 'resize' : 'move', id, start: pt, orig: snapItem(it), ptrs: new Map([[e.pointerId, pt]]) };
  try { e.target.setPointerCapture(e.pointerId); } catch {}
}
function onItemPointerMove(e) {
  if (!drag) return;
  const it = findItem(drag.id);
  if (!it) { drag = null; return; }
  const pt = layerPt(e);
  if (drag.ptrs.has(e.pointerId)) drag.ptrs.set(e.pointerId, pt);
  const el = $('#items-layer').querySelector(`[data-id="${drag.id}"]`);
  if (drag.mode === 'pinch') {
    const pts = [...drag.ptrs.values()];
    if (pts.length < 2) return;
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    const o = drag.pinchOrig;
    const r = resizeKeepAspect({ w: o.w, h: o.h }, o.w * (d / drag.d0), 60, PAGE_W);
    // 保持捏合中心不动（用原中心即可，视觉足够稳）
    it.w = r.w; it.h = r.h;
    it.x = Math.round(o.x + o.w / 2 - r.w / 2);
    it.y = Math.round(o.y + o.h / 2 - r.h / 2);
    if (el) {
      el.style.left = it.x + 'px'; el.style.top = it.y + 'px';
      el.style.width = it.w + 'px'; el.style.height = it.h + 'px';
      const img = el.querySelector('img');
      if (img) positionCroppedImg(img, it);
    }
    return;
  }
  const dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
  if (drag.mode === 'move') {
    it.x = Math.round(Math.min(Math.max(drag.orig.x + dx, -it.w * 0.6), PAGE_W - it.w * 0.4));
    it.y = Math.round(Math.min(Math.max(drag.orig.y + dy, -it.h * 0.6), PAGE_H - 40));
    if (el) { el.style.left = it.x + 'px'; el.style.top = it.y + 'px'; }
  } else {
    if (it.type === 'image') {
      const r = resizeKeepAspect({ w: drag.orig.w, h: drag.orig.h }, drag.orig.w + dx, 60, PAGE_W);
      it.w = r.w; it.h = r.h;
      if (el) {
        el.style.width = it.w + 'px'; el.style.height = it.h + 'px';
        const img = el.querySelector('img');
        if (img) positionCroppedImg(img, it);
      }
    } else {
      it.w = Math.round(Math.min(Math.max(drag.orig.w + dx, 140), PAGE_W));
      if (el) el.style.width = it.w + 'px';
    }
  }
}
function onItemPointerUp(e) {
  if (!drag) return;
  if (e && drag.ptrs) drag.ptrs.delete(e.pointerId);
  if (drag.mode === 'pinch' && drag.ptrs.size >= 1) {
    // 一根手指抬起：结束捏合并提交
  } else if (drag.ptrs && drag.ptrs.size > 0) return; // 还有手指按着（不应发生于非捏合）
  const it = findItem(drag.id);
  if (it) {
    const base = drag.mode === 'pinch' ? drag.pinchOrig : drag.orig;
    const after = snapItem(it);
    if (JSON.stringify(after) !== JSON.stringify(base)) {
      pushOp({ type: 'item-mod', id: it.id, before: base, after });
      if (it.type === 'text') renderItems();
    }
  }
  drag = null;
}

function deleteItem(id) {
  const i = state.items.findIndex((x) => x.id === id);
  if (i < 0) return;
  const item = state.items[i];
  state.items.splice(i, 1);
  state.selectedId = null;
  pushOp({ type: 'item-del', item, index: i });
  renderItems();
}

/* ---- 裁切模式 ---- */

function startCrop(id) {
  const it = findItem(id);
  if (!it || it.type !== 'image') return;
  state.crop = { itemId: id, rect: { rx: 0, ry: 0, rw: it.w, rh: it.h } };
  renderItems();
}

function buildCropOverlay(el, it) {
  const veil = document.createElement('div');
  veil.className = 'np-crop-veil';
  const rect = document.createElement('div');
  rect.className = 'np-crop-rect';
  const sync = () => {
    const r = state.crop.rect;
    rect.style.left = r.rx + 'px'; rect.style.top = r.ry + 'px';
    rect.style.width = r.rw + 'px'; rect.style.height = r.rh + 'px';
  };
  sync();
  ['nw', 'ne', 'sw', 'se'].forEach((c) => {
    const h = document.createElement('div');
    h.className = 'np-crop-h';
    h.dataset.c = c;
    h.style.width = 'calc(26px * var(--inv))';
    h.style.height = 'calc(26px * var(--inv))';
    const off = 'calc(-13px * var(--inv))';
    if (c.includes('w')) h.style.left = off; else h.style.right = off;
    if (c.includes('n')) h.style.top = off; else h.style.bottom = off;
    rect.appendChild(h);
  });
  const bar = document.createElement('div');
  bar.className = 'np-crop-bar';
  bar.style.transformOrigin = 'right top';
  bar.style.transform = 'scale(var(--inv))';
  bar.style.top = 'calc(-58px * var(--inv))';
  bar.innerHTML = `<button class="no" data-act="ccancel">取消</button><button class="ok" data-act="cok">裁切</button>`;

  let cdrag = null;
  rect.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    const corner = e.target.closest('.np-crop-h')?.dataset.c || null;
    cdrag = { corner, start: layerPt(e), orig: { ...state.crop.rect } };
    try { e.target.setPointerCapture(e.pointerId); } catch {}
  });
  rect.addEventListener('pointermove', (e) => {
    if (!cdrag) return;
    const pt = layerPt(e);
    const dx = pt.x - cdrag.start.x, dy = pt.y - cdrag.start.y;
    const o = cdrag.orig;
    let r;
    if (!cdrag.corner) {
      r = { rx: o.rx + dx, ry: o.ry + dy, rw: o.rw, rh: o.rh };
      r.rx = Math.min(Math.max(r.rx, 0), it.w - r.rw);
      r.ry = Math.min(Math.max(r.ry, 0), it.h - r.rh);
    } else {
      let x1 = o.rx, y1 = o.ry, x2 = o.rx + o.rw, y2 = o.ry + o.rh;
      if (cdrag.corner.includes('w')) x1 = Math.min(x1 + dx, x2 - 40);
      if (cdrag.corner.includes('e')) x2 = Math.max(x2 + dx, x1 + 40);
      if (cdrag.corner.includes('n')) y1 = Math.min(y1 + dy, y2 - 40);
      if (cdrag.corner.includes('s')) y2 = Math.max(y2 + dy, y1 + 40);
      r = { rx: x1, ry: y1, rw: x2 - x1, rh: y2 - y1 };
      const cl = clampRect({ x: r.rx, y: r.ry, w: r.rw, h: r.rh }, { w: it.w, h: it.h });
      r = { rx: cl.x, ry: cl.y, rw: cl.w, rh: cl.h };
    }
    state.crop.rect = r;
    sync();
  });
  const end = () => { cdrag = null; };
  rect.addEventListener('pointerup', end);
  rect.addEventListener('pointercancel', end);

  veil.appendChild(rect);
  el.appendChild(veil);
  el.appendChild(bar);
}

function commitCrop() {
  const c = state.crop;
  if (!c) return;
  const it = findItem(c.itemId);
  if (it && it.natural) {
    const before = snapItem(it);
    const res = applyCrop(
      { x: it.x, y: it.y, w: it.w, h: it.h, crop: it.crop || null, natural: it.natural },
      c.rect
    );
    Object.assign(it, res);
    pushOp({ type: 'item-mod', id: it.id, before, after: snapItem(it) });
  }
  state.crop = null;
  renderItems();
}

/* ---- 插入 ---- */

function addTextItem() {
  const item = { id: uid(), type: 'text', md: '双击或点「编辑」输入文本，支持 **Markdown** 语法', x: 170, y: 320, w: 900, h: 60 };
  state.items.push(item);
  pushOp({ type: 'item-add', item });
  setTool('select');
  state.selectedId = item.id;
  state.editingId = item.id;
  renderItems();
}

async function insertImageFile(file) {
  if (!file || !file.type.startsWith('image/')) { toast('请选择图片文件'); return; }
  toast('图片处理中…', 8000);
  let blob = file, ext = 'jpg';
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) { toast('无法读取这张图片'); return; }
  const maxDim = Math.max(bmp.width, bmp.height);
  const keepPng = file.type === 'image/png' && file.size < 2 * 1024 * 1024 && maxDim <= 2200;
  if (keepPng) { ext = 'png'; }
  else if (maxDim > 2200 || file.size > 500 * 1024 || file.type !== 'image/jpeg') {
    const s = Math.min(1, 2000 / maxDim);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
    ext = 'jpg';
  }
  const nw = bmp.width, nh = bmp.height;
  bmp.close && bmp.close();
  const r = await fetch('/api/notepad/asset?ext=' + ext, { method: 'POST', body: blob });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { toast(d.error || '上传失败'); return; }
  const upBmp = await createImageBitmap(blob).catch(() => null);
  const natural = upBmp ? { nw: upBmp.width, nh: upBmp.height } : { nw, nh };
  upBmp && upBmp.close && upBmp.close();

  const w = Math.min(700, natural.nw);
  const h = Math.round(w * natural.nh / natural.nw);
  const item = { id: uid(), type: 'image', src: d.key, x: Math.round((PAGE_W - w) / 2), y: 260, w, h, crop: null, natural };
  state.items.push(item);
  pushOp({ type: 'item-add', item });
  setTool('select');
  state.selectedId = item.id;
  renderItems();
  toast('已插入图片：拖动移动 · 角柄/双指捏合缩放 · 「裁切」剪裁');
}

/* ------------------------------ 自动保存 & 页面合成 ------------------------------ */

const imgCache = new Map();
function loadImage(src) {
  if (!imgCache.has(src)) {
    imgCache.set(src, new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = src;
    }));
  }
  return imgCache.get(src);
}

async function rasterizeText(it) {
  const html = window.renderMarkdown ? window.renderMarkdown(it.md) : escapeHtml(it.md);
  const css = 'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif;font-size:30px;line-height:1.5;color:#1c1c1e;word-break:break-word;padding:6px 10px;box-sizing:border-box;width:100%;height:100%;overflow:hidden';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(it.w)}" height="${Math.ceil(it.h)}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="${css}">${html}</div></foreignObject></svg>`;
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  return new Promise((res, rej) => {
    const im = new Image();
    const t = setTimeout(() => rej(new Error('timeout')), 3000);
    im.onload = () => { clearTimeout(t); res(im); };
    im.onerror = () => { clearTimeout(t); rej(new Error('svg')); };
    im.src = url;
  });
}

// 把一页（纸张+items+笔迹）合成到 canvas。widthPx = 输出宽度像素。
async function composePage({ paper, strokes, items }, widthPx) {
  const c = document.createElement('canvas');
  c.width = widthPx;
  c.height = Math.round(widthPx * PAGE_H / PAGE_W);
  const ctx = c.getContext('2d');
  drawPaperTo(ctx, paper, c.width, c.height);
  const s = widthPx / PAGE_W;
  for (const it of (items || [])) {
    try {
      if (it.type === 'image') {
        const im = await loadImage(assetUrl(it.src));
        const n = it.natural || { nw: im.naturalWidth, nh: im.naturalHeight };
        const cp = it.crop || { sx: 0, sy: 0, sw: n.nw, sh: n.nh };
        ctx.drawImage(im, cp.sx, cp.sy, cp.sw, cp.sh, it.x * s, it.y * s, it.w * s, it.h * s);
      } else if (it.type === 'text') {
        try {
          const im = await rasterizeText(it);
          ctx.drawImage(im, it.x * s, it.y * s, it.w * s, it.h * s);
        } catch {
          ctx.fillStyle = '#1c1c1e';
          ctx.font = `${30 * s}px sans-serif`;
          String(it.md).split('\n').forEach((ln, i) => ctx.fillText(ln, (it.x + 10) * s, (it.y + 40 + i * 45) * s));
        }
      }
    } catch {}
  }
  ctx.save();
  for (const st of (strokes || [])) paintStroke(ctx, st, s);
  ctx.restore();
  return c;
}

let saveTimer = null;
function scheduleSave() {
  state.dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!state.dirty || !state.currentPageId) return;
  const pageId = state.currentPageId;
  state.dirty = false;
  let thumb = '';
  try {
    const tc = await composePage({ paper: state.paper, strokes: state.strokes, items: state.items }, THUMB_W);
    thumb = tc.toDataURL('image/jpeg', 0.55);
  } catch {}
  try {
    await api('/api/notepad/page-data?id=' + pageId, { method: 'PUT', body: JSON.stringify({ strokes: state.strokes, items: state.items, thumb }) });
    previewCache.delete(pageId); // 内容变了，滚动预览重新合成
    const p = state.pages.find((x) => x.id === pageId);
    if (p) { p.thumb = thumb; p.updated_at = Date.now(); }
    if (state.currentPageId === pageId && !$('#page-strip').hidden) renderPageStrip();
  } catch { state.dirty = true; }
}

/* ------------------------------ 导出 / 导入 PDF ------------------------------ */

async function exportPdf() {
  if (!state.currentBook) return;
  await flushSave();
  toast('正在生成 PDF…', 60000);
  try {
    const { jsPDF } = await import(JSPDF_URL);
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    for (let i = 0; i < state.pages.length; i++) {
      toast(`正在生成 PDF… ${i + 1}/${state.pages.length}`, 60000);
      let pd;
      if (i === state.currentPageIdx) {
        pd = { paper: state.paper, strokes: state.strokes, items: state.items };
      } else {
        const d = await api('/api/notepad/page-data?id=' + state.pages[i].id);
        pd = { paper: state.pages[i].paper || 'blank', strokes: d.strokes, items: d.items };
      }
      const canvas = await composePage(pd, 1600);
      const img = canvas.toDataURL('image/jpeg', 0.85);
      if (i > 0) doc.addPage();
      doc.addImage(img, 'JPEG', 0, 0, 210, 297);
    }
    doc.save(`${state.currentBook.title || '手写笔记'}.pdf`);
    toast('PDF 已导出');
  } catch (e) {
    toast('导出失败：' + e.message);
  }
}

async function importPdfFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'ppt' || ext === 'pptx') {
    toast('PPT 请先在 Office/WPS 里「另存为 PDF」再导入（文件 → 导出 → PDF）', 4200);
    return;
  }
  if (ext !== 'pdf') { toast('请选择 PDF 文件'); return; }
  if (file.size > 80 * 1024 * 1024) { toast('PDF 太大（上限 80MB）'); return; }
  toast('正在解析 PDF…', 60000);
  try {
    const pdfjs = await import(PDFJS_URL);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    const total = Math.min(doc.numPages, 60);
    if (doc.numPages > 60) toast(`PDF 共 ${doc.numPages} 页，只导入前 60 页`, 3000);
    for (let i = 1; i <= total; i++) {
      toast(`导入中 ${i}/${total}…`, 60000);
      const page = await doc.getPage(i);
      const vp0 = page.getViewport({ scale: 1 });
      const fit = Math.min(PAGE_W / vp0.width, PAGE_H / vp0.height);
      const vp = page.getViewport({ scale: (PAGE_W / vp0.width) * 1.3 });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
      const r = await fetch('/api/notepad/asset?ext=jpg', { method: 'POST', body: blob });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '上传失败');
      const pg = await api('/api/notepad/pages', { method: 'POST', body: JSON.stringify({ book_id: state.currentBook.id, paper: 'blank' }) });
      const w = Math.round(vp0.width * fit), h = Math.round(vp0.height * fit);
      const item = { id: uid(), type: 'image', src: d.key, x: Math.round((PAGE_W - w) / 2), y: 0, w, h, crop: null, natural: { nw: c.width, nh: c.height } };
      const tc = document.createElement('canvas');
      tc.width = THUMB_W; tc.height = Math.round(THUMB_W * PAGE_H / PAGE_W);
      const tctx = tc.getContext('2d');
      tctx.fillStyle = '#fffdf8'; tctx.fillRect(0, 0, tc.width, tc.height);
      const ts = THUMB_W / PAGE_W;
      tctx.drawImage(c, item.x * ts, item.y * ts, w * ts, h * ts);
      await api('/api/notepad/page-data?id=' + pg.id, {
        method: 'PUT',
        body: JSON.stringify({ strokes: [], items: [item], thumb: tc.toDataURL('image/jpeg', 0.55) }),
      });
    }
    await pagesChanged(state.pages.length + total - 1);
    toast(`已导入 ${total} 页，可直接在上面手写批注`);
  } catch (e) {
    toast('导入失败：' + e.message, 3500);
  }
}

/* ------------------------------ 工具栏 ------------------------------ */

function renderSwatchRow(container, current, onPick) {
  container.innerHTML = '';
  PALETTE.forEach((c) => {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (c === current ? ' on' : '');
    sw.style.background = c;
    sw.addEventListener('click', () => onPick(c));
    container.appendChild(sw);
  });
}

function renderStylePopover() {
  renderSwatchRow($('#color-row'), state.color, (c) => { state.color = c; $('#cur-color').style.background = c; renderStylePopover(); });
  // 自定义颜色（codex 建议采纳）：色板后追加一个取色器
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.value = /^#[0-9a-fA-F]{6}$/.test(state.color) ? state.color : '#1c1c1e';
  picker.title = '自定义颜色';
  picker.style.cssText = 'width:22px;height:22px;border:none;border-radius:50%;padding:0;background:none;cursor:pointer';
  picker.addEventListener('input', () => { state.color = picker.value; $('#cur-color').style.background = picker.value; });
  $('#color-row').appendChild(picker);
  const row = $('#size-row'); row.innerHTML = '';
  SIZES.forEach((s) => {
    const btn = document.createElement('button');
    btn.className = 'size-opt' + (s.v === state.size ? ' on' : '');
    btn.innerHTML = `<span class="dot" style="width:${6 + s.v / 2}px;height:${6 + s.v / 2}px"></span>`;
    btn.title = s.label;
    btn.addEventListener('click', () => { state.size = s.v; renderStylePopover(); });
    row.appendChild(btn);
  });
}

function renderInsertMenu() {
  const menu = $('#insert-menu');
  menu.innerHTML = '';
  const opts = [
    { icon: 'file', label: '新增一页（插到本页后）', act: () => openAddPageModal() },
    { icon: 'stack', label: '复制本页', act: () => duplicatePage() },
    { icon: 'image', label: '插入图片', act: () => $('#file-img').click() },
    { icon: 'textt', label: '插入文本（Markdown）', act: () => addTextItem() },
    { icon: 'filepdf', label: '导入 PDF（转为可批注页面）', act: () => $('#file-pdf').click() },
  ];
  for (const o of opts) {
    const btn = document.createElement('button');
    btn.className = 'menu-opt';
    btn.innerHTML = `<span class="ic">${icon(o.icon, 17)}</span>${o.label}`;
    btn.addEventListener('click', () => { closePopovers(); o.act(); });
    menu.appendChild(btn);
  }
}

function renderPaperPopover() {
  const row = $('#paper-row'); row.innerHTML = '';
  PAPERS.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = 'menu-opt' + (p.v === state.paper ? ' on' : '');
    btn.textContent = p.label;
    btn.addEventListener('click', async () => {
      state.paper = p.v;
      drawPaperTo(bgCtx, p.v);
      $('#pop-paper').hidden = true;
      const page = state.pages[state.currentPageIdx];
      page.paper = p.v;
      try { await api('/api/notepad/pages?id=' + page.id, { method: 'PUT', body: JSON.stringify({ paper: p.v }) }); } catch {}
      scheduleSave();
      renderPaperPopover();
    });
    row.appendChild(btn);
  });
}

function renderViewPopover() {
  const row = $('#flip-row'); row.innerHTML = '';
  [{ v: 'v', label: '竖直滚动（向下翻页）', ic: 'arrowup' }, { v: 'h', label: '水平翻页（向右翻页）', ic: 'back' }].forEach((o) => {
    const btn = document.createElement('button');
    btn.className = 'menu-opt' + (view.flip === o.v ? ' on' : '');
    btn.innerHTML = `<span class="ic" style="transform:rotate(180deg)">${icon(o.ic, 16)}</span>${o.label}`;
    btn.addEventListener('click', () => {
      if (view.flip !== o.v) {
        view.flip = o.v;
        localStorage.setItem('np-flip', o.v);
        renderSlots();
        activatePage(state.currentPageIdx, { scroll: true, force: true });
      }
      closePopovers();
    });
    row.appendChild(btn);
  });
}

function setTool(tool) {
  state.tool = tool;
  ['pen', 'highlighter', 'eraser', 'select'].forEach((t) => $('#tool-' + t).classList.toggle('on', t === tool));
  document.body.classList.toggle('tool-select', tool === 'select');
  if (tool !== 'select') { state.selectedId = null; state.editingId = null; state.crop = null; renderItems(); }
}

function closePopovers() { $('#pop-style').hidden = true; $('#pop-paper').hidden = true; $('#pop-insert').hidden = true; $('#pop-view').hidden = true; }

function togglePopover(id, anchorId, onOpen) {
  const pop = $(id);
  const willOpen = pop.hidden;
  closePopovers();
  if (willOpen) {
    pop.hidden = false;
    const a = $(anchorId);
    pop.style.left = Math.min(a.offsetLeft, window.innerWidth - 250) + 'px';
    onOpen && onOpen();
  }
}

/* ---- 禅模式 & 缩略图开关 ---- */

function enterZen() {
  document.body.classList.add('np-zen');
  $('#expand-btn').hidden = false;
  requestAnimationFrame(() => { applyWidths(); });
}
function exitZen() {
  document.body.classList.remove('np-zen');
  $('#expand-btn').hidden = true;
  requestAnimationFrame(() => { applyWidths(); });
}
function toggleStrip(force) {
  const strip = $('#page-strip');
  const show = force != null ? force : strip.hidden;
  strip.hidden = !show;
  $('#btn-thumbs').classList.toggle('on', show);
  localStorage.setItem('np-strip', show ? '1' : '0');
  if (show) renderPageStrip();
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bindToolbar() {
  $('#btn-back').addEventListener('click', backToShelf);
  $('#tool-pen').addEventListener('click', () => setTool('pen'));
  $('#tool-highlighter').addEventListener('click', () => setTool('highlighter'));
  $('#tool-eraser').addEventListener('click', () => setTool('eraser'));
  $('#tool-select').addEventListener('click', () => setTool('select'));
  $('#btn-input-mode').addEventListener('click', () => setInputMode(input.mode === 'pencil' ? 'touch' : 'pencil', { persist: true, announce: true }));
  $('#btn-style').addEventListener('click', (e) => { e.stopPropagation(); togglePopover('#pop-style', '#btn-style', renderStylePopover); });
  $('#btn-insert').addEventListener('click', (e) => { e.stopPropagation(); togglePopover('#pop-insert', '#btn-insert', renderInsertMenu); });
  $('#btn-paper').addEventListener('click', (e) => { e.stopPropagation(); togglePopover('#pop-paper', '#btn-paper', renderPaperPopover); });
  $('#btn-viewset').addEventListener('click', (e) => { e.stopPropagation(); togglePopover('#pop-view', '#btn-viewset', renderViewPopover); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.popover') && !e.target.closest('#btn-style') && !e.target.closest('#btn-paper') && !e.target.closest('#btn-insert') && !e.target.closest('#btn-viewset')) closePopovers();
  });
  $('#btn-undo').addEventListener('click', doUndo);
  $('#btn-redo').addEventListener('click', doRedo);
  $('#btn-export').addEventListener('click', exportPdf);
  $('#btn-thumbs').addEventListener('click', () => toggleStrip());
  $('#btn-zen').addEventListener('click', enterZen);
  $('#expand-btn').addEventListener('click', exitZen);
  $('#pg-prev').addEventListener('click', () => openPage(state.currentPageIdx - 1));
  $('#pg-next').addEventListener('click', () => openPage(state.currentPageIdx + 1));
  $('#pg-label').addEventListener('click', () => {
    const n = parseInt(prompt(`跳转到页码（1-${state.pages.length}）`, String(state.currentPageIdx + 1)) || '', 10);
    if (n >= 1 && n <= state.pages.length) openPage(n - 1);
  });
  $('#zoom-in').addEventListener('click', () => zoomTo(view.zoom + ZOOM_STEP));
  $('#zoom-out').addEventListener('click', () => zoomTo(view.zoom - ZOOM_STEP));
  $('#zoom-label').addEventListener('click', () => zoomTo(1));

  const ink = $('#live-canvas');
  ink.addEventListener('pointerdown', onDown);
  ink.addEventListener('pointermove', onMove);
  ink.addEventListener('pointerup', onUp);
  ink.addEventListener('pointercancel', onUp);
  ink.addEventListener('lostpointercapture', onUp);

  // 双指轻点=撤销 / 三指轻点=重做（GoodNotes 手势；滚动会产生位移自动不触发）
  const det = createMultiTapDetector({ onTwoFingerTap: doUndo, onThreeFingerTap: doRedo });
  const wrap = $('#page-surface-wrap');
  wrap.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || e.target.closest('.np-item') || isEditableTarget(e.target)) return;
    det.down(e.pointerId, e.clientX, e.clientY, performance.now());
    if (input.mode !== 'pencil') return;
    e.preventDefault();
    const blocked = isPalmContact(e) || input.activePen !== null || performance.now() - input.lastPenAt < 180;
    navTouches.set(e.pointerId, { x: e.clientX, y: e.clientY, blocked });
    try { wrap.setPointerCapture(e.pointerId); } catch {}
    if (touchPair().length === 2) beginTouchNavigation(wrap);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'touch') return;
    det.move(e.pointerId, e.clientX, e.clientY, performance.now());
    if (input.mode !== 'pencil' || isEditableTarget(e.target)) return;
    e.preventDefault();
    const pt = navTouches.get(e.pointerId);
    if (!pt) return;
    pt.x = e.clientX; pt.y = e.clientY;
    if (!pt.blocked && touchPair().length >= 2) updateTouchNavigation(wrap);
  });
  wrap.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    det.up(e.pointerId, performance.now());
    if (input.mode !== 'pencil') return;
    e.preventDefault();
    navTouches.delete(e.pointerId);
    if (touchGesture && touchPair().length < 2) finishTouchNavigation(wrap);
  });
  wrap.addEventListener('pointercancel', (e) => {
    if (e.pointerType !== 'touch') return;
    det.cancel();
    if (input.mode === 'pencil') finishTouchNavigation(wrap, true);
  });
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((type) => wrap.addEventListener(type, (e) => {
    if (input.mode === 'pencil') e.preventDefault();
  }, { passive: false }));
  ['selectstart', 'contextmenu', 'dragstart'].forEach((type) => wrap.addEventListener(type, (e) => {
    if (!isEditableTarget(e.target)) e.preventDefault();
  }));
  wrap.addEventListener('scroll', onWrapScroll, { passive: true });

  // items 层交互（事件委托到 layer；点按钮走 click）
  const layer = $('#items-layer');
  layer.addEventListener('pointerdown', onItemPointerDown);
  layer.addEventListener('pointermove', onItemPointerMove);
  layer.addEventListener('pointerup', onItemPointerUp);
  layer.addEventListener('pointercancel', onItemPointerUp);
  layer.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const itemEl = e.target.closest('.np-item');
    if (!act || !itemEl) return;
    const id = itemEl.dataset.id;
    e.stopPropagation();
    if (act === 'del') deleteItem(id);
    else if (act === 'crop') startCrop(id);
    else if (act === 'edit') { state.editingId = id; renderItems(); }
    else if (act === 'cok') commitCrop();
    else if (act === 'ccancel') { state.crop = null; renderItems(); }
    else if (act === 'tok') {
      const ta = itemEl.querySelector('textarea');
      const it = findItem(id);
      if (ta && it) {
        const before = snapItem(it);
        it.md = ta.value;
        state.editingId = null;
        pushOp({ type: 'item-mod', id, before, after: snapItem(it) });
        renderItems();
      }
    } else if (act === 'tcancel') { state.editingId = null; renderItems(); }
  });
  layer.addEventListener('dblclick', (e) => {
    if (state.tool !== 'select') return;
    const itemEl = e.target.closest('.np-item');
    if (!itemEl) return;
    const it = findItem(itemEl.dataset.id);
    if (it && it.type === 'text' && state.editingId !== it.id) { state.editingId = it.id; renderItems(); }
  });
  // 点空白处取消选中
  wrap.addEventListener('pointerdown', (e) => {
    if (state.tool !== 'select') return;
    if (e.target.closest('.np-item') || e.target.closest('.popover')) return;
    if (state.selectedId || state.editingId) { state.selectedId = null; state.editingId = null; state.crop = null; renderItems(); }
  });
  document.addEventListener('keydown', (e) => {
    // e.target 可能是 document 本身（无 closest 方法），要防御
    const typing = e.target && e.target.closest ? e.target.closest('textarea,input') : null;
    if (e.key === 'Escape') { if (state.crop) { state.crop = null; renderItems(); } else if (state.selectedId) { state.selectedId = null; renderItems(); } return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId && !state.editingId && !typing) { deleteItem(state.selectedId); return; }
    // 快捷键（codex 建议采纳）：Ctrl/Cmd+Z 撤销、Ctrl+Shift+Z / Ctrl+Y 重做；输入时不响应
    if ((e.ctrlKey || e.metaKey) && !typing) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
      if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); doRedo(); return; }
    }
    // 单键换工具：P 钢笔 / H 荧光笔 / E 橡皮 / V 选择
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && state.currentBook) {
      const k = e.key.toLowerCase();
      if (k === 'p') setTool('pen');
      else if (k === 'h') setTool('highlighter');
      else if (k === 'e') setTool('eraser');
      else if (k === 'v') setTool('select');
    }
  });

  $('#file-img').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) insertImageFile(f); });
  $('#file-pdf').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importPdfFile(f); });

  $('#new-book-btn').addEventListener('click', () => openBookModal(null));
  $('#nb-cancel').addEventListener('click', () => { $('#book-modal').hidden = true; });
  $('#nb-ok').addEventListener('click', submitBookModal);
  $('#ap-cancel').addEventListener('click', () => { $('#addpage-modal').hidden = true; });

  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
  window.addEventListener('resize', () => { applyWidths(); });
}

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  bgCtx = setupCanvas($('#bg-canvas'), canvasFactor());
  inkCtx = setupCanvas($('#ink-canvas'), canvasFactor());
  liveCtx = setupCanvas($('#live-canvas'), Math.min(canvasFactor(), 1.5));
  $('#cur-color').style.background = state.color;
  $('#zoom-label').textContent = Math.round(view.zoom * 100) + '%';
  updateInputModeUI();
  setTool('pen');
  bindToolbar();
  if (localStorage.getItem('np-strip') === '1') toggleStrip(true);
  new ResizeObserver(() => syncLayerScale()).observe($('#page-surface'));
  try { await loadShelf(); } catch (e) { toast('加载失败：' + e.message); }
}
init();

window.__notepad = {
  state, view, input, doUndo, doRedo, flushSave, openBook, openPage, addPage, movePage, duplicatePage,
  addTextItem, deleteItem, startCrop, commitCrop, setTool, composePage,
  enterZen, exitZen, toggleStrip, insertImageFile, importPdfFile, exportPdf,
  zoomTo, renderSlots, activatePage, pagesChanged, setInputMode,
};
