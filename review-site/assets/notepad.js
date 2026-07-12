// 手写笔记：书架首页 + 分页 Canvas 笔记（仿 GoodNotes）。
// 压感笔迹用 perfect-freehand（tldraw 作者的开源库，MIT）；触控笔/鼠标画，手指只滚动（palm rejection）。
// 数据按登录密码隔离（owner，见服务端 auth.js），autosave 到 /api/notepad/*。
import { getStroke } from 'https://esm.sh/perfect-freehand@1.2.2';

const PAGE_W = 1240, PAGE_H = 1754; // 逻辑坐标系（A4 比例），与屏幕像素无关，靠 CSS 缩放响应式
const PALETTE = ['#1c1c1e', '#f5f0e6', '#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1'];
const SIZES = [{ label: '细', v: 6 }, { label: '中', v: 11 }, { label: '粗', v: 18 }];
const PAPERS = [{ v: 'blank', label: '空白' }, { v: 'lined', label: '横线' }, { v: 'grid', label: '方格' }, { v: 'dotted', label: '点阵' }];
const ERASE_R = 26;
const SAVE_DEBOUNCE = 900;

const $ = (sel) => document.querySelector(sel);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, size) => (window.NBIcon ? window.NBIcon(name, { size }) : '');

const state = {
  books: [],
  currentBook: null,
  pages: [],
  currentPageIdx: 0,
  currentPageId: null,
  strokes: [],
  undo: [], redo: [],
  liveStroke: null,
  erasing: false,
  tool: 'pen',
  color: '#1c1c1e', // 纸张恒为浅色（见 drawPaper），默认墨色用黑即可，不必跟随站点主题
  size: 11,
  paper: 'blank',
  dirty: false,
};

async function api(path, opts) {
  const r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}

function timeAgo(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60); if (h < 24) return h + ' 小时前';
  const d = Math.floor(h / 24); if (d < 30) return d + ' 天前';
  return new Date(ts).toLocaleDateString('zh-CN');
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
    card.innerHTML = `
      <div class="book-cover" style="background:${b.color}">
        ${b.cover ? `<img src="${b.cover}">` : `<span class="bc-icon">${icon('books', 30)}</span>`}
        <button class="book-del" title="删除">${icon('trash', 14)}</button>
      </div>
      <div class="book-meta">${escapeHtml(b.title)}</div>
      <div class="book-sub">${b.page_count} 页 · ${timeAgo(b.updated_at)}</div>
    `;
    card.addEventListener('click', (e) => { if (e.target.closest('.book-del')) return; openBook(b); });
    card.querySelector('.book-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`删除笔记本《${b.title}》？此操作不可恢复。`)) return;
      await api('/api/notepad/books?id=' + b.id, { method: 'DELETE' });
      await loadShelf();
    });
    grid.appendChild(card);
  }
}

function openNewBookModal() {
  $('#nb-title').value = '';
  const row = $('#nb-color-row');
  row.innerHTML = '';
  let picked = PALETTE[4];
  PALETTE.slice(2).forEach((c) => { // 前两个是黑/白，笔记本封面用彩色更好看
    const sw = document.createElement('div');
    sw.className = 'swatch' + (c === picked ? ' on' : '');
    sw.style.background = c;
    sw.addEventListener('click', () => { row.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on')); sw.classList.add('on'); picked = c; });
    row.appendChild(sw);
  });
  $('#new-book-modal').hidden = false;
  $('#nb-title').focus();
  $('#new-book-modal')._picked = () => picked;
}

async function createBook() {
  const title = $('#nb-title').value.trim() || '未命名笔记本';
  const color = $('#new-book-modal')._picked();
  const { id } = await api('/api/notepad/books', { method: 'POST', body: JSON.stringify({ title, color }) });
  $('#new-book-modal').hidden = true;
  await loadShelf();
  const b = state.books.find((x) => x.id === id);
  if (b) openBook(b);
}

/* ------------------------------ 笔记本 / 页面 ------------------------------ */

async function openBook(book) {
  state.currentBook = book;
  const { pages } = await api('/api/notepad/pages?book_id=' + book.id);
  state.pages = pages;
  $('#shelf-view').hidden = true;
  $('#page-view').hidden = false;
  $('#book-title').textContent = book.title;
  const lastIdx = parseInt(localStorage.getItem('notepad-last-' + book.id) || '0', 10);
  await openPage(Math.min(Math.max(lastIdx, 0), pages.length - 1));
  renderPageStrip();
}

async function backToShelf() {
  await flushSave();
  state.currentBook = null;
  $('#page-view').hidden = true;
  $('#shelf-view').hidden = false;
  await loadShelf();
}

async function openPage(idx) {
  if (idx < 0 || idx >= state.pages.length) return;
  await flushSave();
  state.currentPageIdx = idx;
  const page = state.pages[idx];
  state.currentPageId = page.id;
  state.paper = page.paper || state.currentBook.paper || 'blank';
  localStorage.setItem('notepad-last-' + state.currentBook.id, String(idx));

  const { strokes } = await api('/api/notepad/page-data?id=' + page.id);
  state.strokes = strokes || [];
  state.undo = []; state.redo = [];
  drawPaper(state.paper);
  redrawInk();
  syncUndoButtons();
  updatePagerLabel();
  renderPageStrip();
}

function updatePagerLabel() {
  $('#pg-label').textContent = `${state.currentPageIdx + 1} / ${state.pages.length}`;
  $('#pg-prev').disabled = state.currentPageIdx <= 0;
  $('#pg-next').disabled = state.currentPageIdx >= state.pages.length - 1;
}

async function addPage() {
  const { id, idx, paper } = await api('/api/notepad/pages', { method: 'POST', body: JSON.stringify({ book_id: state.currentBook.id, paper: state.paper }) });
  state.pages.push({ id, idx, paper, thumb: '', updated_at: Date.now() });
  await openPage(state.pages.length - 1);
}

async function deletePage(pageId) {
  if (state.pages.length <= 1) { toast('笔记本至少保留一页'); return; }
  if (!confirm('删除这一页？此操作不可恢复。')) return;
  await api('/api/notepad/pages?id=' + pageId, { method: 'DELETE' });
  const { pages } = await api('/api/notepad/pages?book_id=' + state.currentBook.id);
  state.pages = pages;
  await openPage(Math.min(state.currentPageIdx, pages.length - 1));
}

function renderPageStrip() {
  const strip = $('#page-strip');
  strip.innerHTML = '';
  state.pages.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'thumb' + (i === state.currentPageIdx ? ' on' : '');
    el.innerHTML = `${p.thumb ? `<img src="${p.thumb}">` : ''}<span class="idx">${i + 1}</span><button class="del">${icon('close', 10)}</button>`;
    el.addEventListener('click', (e) => { if (e.target.closest('.del')) return; openPage(i); });
    el.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); deletePage(p.id); });
    strip.appendChild(el);
  });
  const add = document.createElement('div');
  add.className = 'thumb add';
  add.innerHTML = icon('plus', 18);
  add.addEventListener('click', addPage);
  strip.appendChild(add);
}

/* ------------------------------ 画布 ------------------------------ */

let bgCtx, inkCtx;
function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  cv.width = PAGE_W * dpr;
  cv.height = PAGE_H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}

// 纸张背景始终用「纸的颜色」，不跟随站点深浅色主题——就像真实笔记本一样，翻开永远是纸不是屏幕背景。
// 这样任何时候写的墨迹颜色，换主题后依然是同一张纸上、不会因为纸变黑而看不见。只有工具栏/书架跟随站点主题。
function drawPaper(paper) {
  bgCtx.clearRect(0, 0, PAGE_W, PAGE_H);
  bgCtx.fillStyle = '#fffdf8';
  bgCtx.fillRect(0, 0, PAGE_W, PAGE_H);
  if (paper === 'blank') return;
  bgCtx.strokeStyle = 'rgba(0,0,0,.10)';
  bgCtx.lineWidth = 1;
  if (paper === 'lined') {
    const step = 62;
    for (let y = step; y < PAGE_H; y += step) { bgCtx.beginPath(); bgCtx.moveTo(40, y + 0.5); bgCtx.lineTo(PAGE_W - 40, y + 0.5); bgCtx.stroke(); }
  } else if (paper === 'grid') {
    const step = 54;
    for (let x = step; x < PAGE_W; x += step) { bgCtx.beginPath(); bgCtx.moveTo(x + 0.5, 0); bgCtx.lineTo(x + 0.5, PAGE_H); bgCtx.stroke(); }
    for (let y = step; y < PAGE_H; y += step) { bgCtx.beginPath(); bgCtx.moveTo(0, y + 0.5); bgCtx.lineTo(PAGE_W, y + 0.5); bgCtx.stroke(); }
  } else if (paper === 'dotted') {
    const step = 54;
    bgCtx.fillStyle = 'rgba(0,0,0,.22)';
    for (let x = step; x < PAGE_W; x += step) for (let y = step; y < PAGE_H; y += step) { bgCtx.beginPath(); bgCtx.arc(x, y, 2, 0, Math.PI * 2); bgCtx.fill(); }
  }
}

function strokeOptions(s) {
  if (s.tool === 'highlighter') return { size: s.size * 2.4, thinning: 0.12, smoothing: 0.5, streamline: 0.5, simulatePressure: s.simulated };
  return { size: s.size, thinning: 0.65, smoothing: 0.5, streamline: 0.5, simulatePressure: s.simulated };
}

function paintStroke(ctx, s) {
  if (!s.pts.length) return;
  const outline = getStroke(s.pts, strokeOptions(s));
  if (!outline.length) return;
  ctx.beginPath();
  ctx.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1]);
  ctx.closePath();
  ctx.fillStyle = s.color;
  ctx.globalAlpha = s.tool === 'highlighter' ? 0.38 : 1;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function redrawInk() {
  inkCtx.clearRect(0, 0, PAGE_W, PAGE_H);
  for (const s of state.strokes) paintStroke(inkCtx, s);
  if (state.liveStroke) paintStroke(inkCtx, state.liveStroke);
}

function toLocal(e) {
  const rect = $('#ink-canvas').getBoundingClientRect();
  const x = (e.clientX - rect.left) * (PAGE_W / rect.width);
  const y = (e.clientY - rect.top) * (PAGE_H / rect.height);
  const pressure = e.pressure > 0 ? e.pressure : 0.5;
  return { x, y, pressure };
}

function eraseAt(pt) {
  let hit = false;
  for (let i = state.strokes.length - 1; i >= 0; i--) {
    const s = state.strokes[i];
    if (s.pts.some((p) => (p[0] - pt.x) ** 2 + (p[1] - pt.y) ** 2 < ERASE_R * ERASE_R)) {
      state.strokes.splice(i, 1);
      pushOp({ type: 'erase', stroke: s, index: i });
      hit = true;
    }
  }
  if (hit) redrawInk();
}

let activePointerId = null;
function onDown(e) {
  if (e.pointerType === 'touch') return; // 手指仅滚动，不画（palm rejection）
  e.preventDefault();
  const ink = $('#ink-canvas');
  try { ink.setPointerCapture(e.pointerId); } catch {} // 极少数情况下浏览器会拒绝捕获，不影响后续照常画
  activePointerId = e.pointerId;
  const pt = toLocal(e);
  if (state.tool === 'eraser') { state.erasing = true; eraseAt(pt); return; }
  state.liveStroke = { tool: state.tool, color: state.color, size: state.size, simulated: e.pointerType === 'mouse', pts: [[pt.x, pt.y, pt.pressure]] };
}
function onMove(e) {
  if (e.pointerId !== activePointerId) return;
  const pt = toLocal(e);
  if (state.tool === 'eraser') { if (state.erasing) eraseAt(pt); return; }
  if (!state.liveStroke) return;
  state.liveStroke.pts.push([pt.x, pt.y, pt.pressure]);
  redrawInk();
}
function onUp(e) {
  if (e.pointerId !== activePointerId) return;
  activePointerId = null;
  state.erasing = false;
  if (state.liveStroke && state.liveStroke.pts.length >= 1) {
    state.strokes.push(state.liveStroke);
    pushOp({ type: 'add', stroke: state.liveStroke });
  }
  state.liveStroke = null;
  redrawInk();
}

function pushOp(op) {
  state.undo.push(op);
  state.redo.length = 0;
  if (state.undo.length > 200) state.undo.shift();
  syncUndoButtons();
  scheduleSave();
}
function doUndo() {
  const op = state.undo.pop(); if (!op) return;
  if (op.type === 'add') { const i = state.strokes.indexOf(op.stroke); if (i >= 0) state.strokes.splice(i, 1); }
  else if (op.type === 'erase') { state.strokes.splice(Math.min(op.index, state.strokes.length), 0, op.stroke); }
  state.redo.push(op);
  redrawInk(); syncUndoButtons(); scheduleSave();
}
function doRedo() {
  const op = state.redo.pop(); if (!op) return;
  if (op.type === 'add') { state.strokes.push(op.stroke); }
  else if (op.type === 'erase') { const i = state.strokes.indexOf(op.stroke); if (i >= 0) state.strokes.splice(i, 1); }
  state.undo.push(op);
  redrawInk(); syncUndoButtons(); scheduleSave();
}
function syncUndoButtons() {
  $('#btn-undo').disabled = state.undo.length === 0;
  $('#btn-redo').disabled = state.redo.length === 0;
}

/* ------------------------------ 自动保存 ------------------------------ */

let saveTimer = null;
function scheduleSave() {
  state.dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE);
}
function makeThumb() {
  const tw = 180, th = Math.round((tw * PAGE_H) / PAGE_W);
  const oc = document.createElement('canvas'); oc.width = tw; oc.height = th;
  const octx = oc.getContext('2d');
  octx.drawImage($('#bg-canvas'), 0, 0, tw, th);
  octx.drawImage($('#ink-canvas'), 0, 0, tw, th);
  return oc.toDataURL('image/jpeg', 0.62);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!state.dirty || !state.currentPageId) return;
  const pageId = state.currentPageId;
  const thumb = makeThumb();
  state.dirty = false;
  try {
    await api('/api/notepad/page-data?id=' + pageId, { method: 'PUT', body: JSON.stringify({ strokes: state.strokes, thumb }) });
    const p = state.pages.find((x) => x.id === pageId);
    if (p) { p.thumb = thumb; p.updated_at = Date.now(); }
    if (state.currentPageId === pageId) renderPageStrip();
  } catch { state.dirty = true; }
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

function renderPaperPopover() {
  const row = $('#paper-row'); row.innerHTML = '';
  PAPERS.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = 'paper-opt' + (p.v === state.paper ? ' on' : '');
    btn.textContent = p.label;
    btn.addEventListener('click', async () => {
      state.paper = p.v;
      drawPaper(p.v);
      $('#pop-paper').hidden = true;
      const page = state.pages[state.currentPageIdx];
      page.paper = p.v;
      try { await api('/api/notepad/pages?id=' + page.id, { method: 'PUT', body: JSON.stringify({ paper: p.v }) }); } catch {}
      renderPaperPopover();
    });
    row.appendChild(btn);
  });
}

function setTool(tool) {
  state.tool = tool;
  ['pen', 'highlighter', 'eraser'].forEach((t) => $('#tool-' + t).classList.toggle('on', t === tool));
}

function closePopovers() { $('#pop-style').hidden = true; $('#pop-paper').hidden = true; }

function bindToolbar() {
  $('#btn-back').addEventListener('click', backToShelf);
  $('#tool-pen').addEventListener('click', () => setTool('pen'));
  $('#tool-highlighter').addEventListener('click', () => setTool('highlighter'));
  $('#tool-eraser').addEventListener('click', () => setTool('eraser'));
  $('#btn-style').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('#pop-style');
    pop.hidden = !pop.hidden;
    $('#pop-paper').hidden = true;
    if (!pop.hidden) { pop.style.left = $('#btn-style').offsetLeft + 'px'; renderStylePopover(); }
  });
  $('#btn-paper').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('#pop-paper');
    pop.hidden = !pop.hidden;
    $('#pop-style').hidden = true;
    if (!pop.hidden) { pop.style.left = $('#btn-paper').offsetLeft + 'px'; renderPaperPopover(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.popover') && !e.target.closest('#btn-style') && !e.target.closest('#btn-paper')) closePopovers(); });
  $('#btn-undo').addEventListener('click', doUndo);
  $('#btn-redo').addEventListener('click', doRedo);
  $('#btn-addpage').addEventListener('click', addPage);
  $('#pg-prev').addEventListener('click', () => openPage(state.currentPageIdx - 1));
  $('#pg-next').addEventListener('click', () => openPage(state.currentPageIdx + 1));

  const ink = $('#ink-canvas');
  ink.addEventListener('pointerdown', onDown);
  ink.addEventListener('pointermove', onMove);
  ink.addEventListener('pointerup', onUp);
  ink.addEventListener('pointercancel', onUp);

  $('#new-book-btn').addEventListener('click', openNewBookModal);
  $('#nb-cancel').addEventListener('click', () => { $('#new-book-modal').hidden = true; });
  $('#nb-ok').addEventListener('click', createBook);

  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
}

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  bgCtx = setupCanvas($('#bg-canvas'));
  inkCtx = setupCanvas($('#ink-canvas'));
  $('#cur-color').style.background = state.color;
  setTool('pen');
  bindToolbar();
  try { await loadShelf(); } catch (e) { toast('加载失败：' + e.message); }
}
init();

window.__notepad = { state, doUndo, doRedo, flushSave, openBook, openPage, addPage };
