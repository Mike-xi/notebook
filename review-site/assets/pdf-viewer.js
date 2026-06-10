// 自定义 PDF 阅读器：连续滚动、虚拟化渲染（占位高度预先排好，进视口才渲染 canvas）、
// 缩放、页码、大纲上报。装在 reader 的 iframe 内，body 正常滚动 → 父页 reader.js 能像
// 普通文档一样读取滚动条做进度/书签。暗色与目录跳转通过 postMessage 与父页联动。
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';

const MAX_COL_W = 980;   // 适应宽度时单页最大像素宽，过宽不利阅读
const qs = new URLSearchParams(location.search);
const src = qs.get('src');

const pagesEl = document.getElementById('pages');
const loadingEl = document.getElementById('pdf-loading');
const barEl = document.getElementById('pv-bar');
const pageIndEl = document.getElementById('pv-page-ind');
const zoomLabelEl = document.getElementById('pv-zoom-label');

let pdfDoc = null;
let scale = 1;
let fitMode = true;
let baseViewports = [];      // [i] -> 缩放1时的 viewport（含 width/height）
let pageDivs = [];           // [i] -> .pdf-page 元素
const rendered = new Set();
const rendering = new Set();
let layoutId = 0;
let observer = null;

applyTheme(currentTheme());
if (!src) { loadingEl.textContent = '缺少文件参数'; }
else init();

async function init() {
  try {
    pdfDoc = await pdfjsLib.getDocument({ url: src }).promise;
  } catch (e) {
    loadingEl.innerHTML = '';
    loadingEl.textContent = 'PDF 加载失败：' + (e && e.message ? e.message : e);
    return;
  }

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    baseViewports[i] = page.getViewport({ scale: 1 });
  }

  scale = computeFitScale();
  layout();
  setupObserver();

  loadingEl.hidden = true;
  barEl.hidden = false;
  updateZoomLabel();
  updatePageIndicator();
  reportOutline();
  post({ type: 'nb-ready' });
}

function computeFitScale() {
  const avail = Math.min(pagesEl.clientWidth - 24, MAX_COL_W);
  const baseW = (baseViewports[1] && baseViewports[1].width) || 612;
  return clamp(avail / baseW, 0.3, 4);
}

// 排版：为每页放一个正确高度的占位 div（总高即刻确定，进度/书签稳定）
function layout() {
  layoutId++;
  rendered.clear();
  rendering.clear();
  pagesEl.innerHTML = '';
  pageDivs = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const bv = baseViewports[i];
    const div = document.createElement('div');
    div.className = 'pdf-page';
    div.style.width = Math.floor(bv.width * scale) + 'px';
    div.style.height = Math.floor(bv.height * scale) + 'px';
    div.dataset.page = String(i);
    const ph = document.createElement('div');
    ph.className = 'pdf-ph-num';
    ph.textContent = i;
    div.appendChild(ph);
    pagesEl.appendChild(div);
    pageDivs[i] = div;
  }
  if (observer) { observer.disconnect(); pageDivs.forEach((d) => d && observer.observe(d)); }
}

function setupObserver() {
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) renderPage(parseInt(e.target.dataset.page, 10));
    }
  }, { rootMargin: '600px 0px' });
  pageDivs.forEach((d) => d && observer.observe(d));
}

async function renderPage(i) {
  if (!i || rendered.has(i) || rendering.has(i)) return;
  rendering.add(i);
  const myLayout = layoutId;
  const div = pageDivs[i];
  try {
    const page = await pdfDoc.getPage(i);
    if (myLayout !== layoutId || pageDivs[i] !== div) return; // 缩放已重排，丢弃
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    if (myLayout !== layoutId || pageDivs[i] !== div) return;
    const ph = div.querySelector('.pdf-ph-num');
    if (ph) ph.remove();
    div.appendChild(canvas);
    // 文本层：与 canvas 同尺寸叠放，让 PDF 可选中、可复制、可被页内搜索高亮
    try {
      const tl = document.createElement('div');
      tl.className = 'textLayer';
      tl.style.setProperty('--scale-factor', String(scale));
      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent(),
        container: tl,
        viewport: page.getViewport({ scale }),   // CSS 像素尺寸（不乘 dpr）
      });
      await textLayer.render();
      if (myLayout === layoutId && pageDivs[i] === div) {
        div.appendChild(tl);
        if (searchQuery) highlightPage(div);
      }
    } catch (e) {
      console.warn('[pdf] text layer page', i, 'failed', e);
    }
    rendered.add(i);
  } catch (e) {
    // 单页渲染失败不影响其它页
    console.warn('[pdf] render page', i, 'failed', e);
  } finally {
    rendering.delete(i);
  }
}

// ========== 缩放 ==========
function applyScale(newScale, anchorRatio) {
  const docEl = document.scrollingElement || document.documentElement;
  const prevMax = docEl.scrollHeight - docEl.clientHeight;
  const ratio = anchorRatio != null ? anchorRatio : (prevMax > 0 ? docEl.scrollTop / prevMax : 0);
  scale = clamp(newScale, 0.3, 4);
  layout();
  const newMax = docEl.scrollHeight - docEl.clientHeight;
  docEl.scrollTop = ratio * newMax;
  updateZoomLabel();
  updatePageIndicator();
}
function zoomBy(f) { fitMode = false; applyScale(scale * f); }

document.getElementById('pv-zoom-in').addEventListener('click', () => zoomBy(1.15));
document.getElementById('pv-zoom-out').addEventListener('click', () => zoomBy(1 / 1.15));
zoomLabelEl.addEventListener('click', () => { fitMode = true; applyScale(computeFitScale()); });
function updateZoomLabel() { zoomLabelEl.textContent = Math.round(scale * 100) + '%'; }

// ctrl + 滚轮缩放
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  fitMode = false;
  applyScale(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

let resizeT = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (fitMode) applyScale(computeFitScale()); }, 150);
});

// ========== 页码指示 + 底栏淡出 ==========
let rafPending = false;
let fadeT = null;
window.addEventListener('scroll', () => {
  if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; updatePageIndicator(); }); }
  showBar();
}, { passive: true });
window.addEventListener('mousemove', showBar, { passive: true });

function updatePageIndicator() {
  if (!pdfDoc) return;
  const docEl = document.scrollingElement || document.documentElement;
  const probe = docEl.scrollTop + docEl.clientHeight * 0.35;
  let cur = 1;
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const d = pageDivs[i];
    if (d && d.offsetTop <= probe) cur = i; else break;
  }
  pageIndEl.textContent = `${cur} / ${pdfDoc.numPages}`;
}
function showBar() {
  barEl.classList.remove('faded');
  clearTimeout(fadeT);
  fadeT = setTimeout(() => barEl.classList.add('faded'), 2200);
}

// ========== 大纲 ==========
async function reportOutline() {
  let outline = null;
  try { outline = await pdfDoc.getOutline(); } catch {}
  const items = [];
  async function walk(nodes, level) {
    for (const n of nodes || []) {
      const page = await destToPage(n.dest);
      items.push({ title: n.title || '(无标题)', page, level });
      if (n.items && n.items.length) await walk(n.items, level + 1);
    }
  }
  if (outline && outline.length) await walk(outline, 0);
  post({ type: 'nb-outline', kind: 'pdf', items });
}
async function destToPage(dest) {
  try {
    let explicit = dest;
    if (typeof dest === 'string') explicit = await pdfDoc.getDestination(dest);
    if (!Array.isArray(explicit) || !explicit[0]) return null;
    const idx = await pdfDoc.getPageIndex(explicit[0]);
    return idx + 1;
  } catch { return null; }
}
function gotoPage(p) {
  const d = pageDivs[p];
  if (d) window.scrollTo({ top: d.offsetTop - 8, behavior: 'smooth' });
}

// ========== 页内搜索 ==========
// 文本逐页取自 getTextContent（懒加载缓存）；命中按页导航，当前已渲染页的
// 文本层 span 若包含关键词则加高亮。关键词跨 span 断开时无法精确高亮（只跳页），属已知近似。
const searchBox = document.getElementById('pv-search');
const searchInput = document.getElementById('pv-q');
const searchCount = document.getElementById('pv-count');
let searchQuery = '';
let pageTexts = null;      // [i] -> 该页全文 lowercase
let hitPages = [];         // 含命中的页码列表
let hitTotal = 0;
let curHit = -1;

document.getElementById('pv-find').addEventListener('click', toggleSearch);
document.getElementById('pv-x').addEventListener('click', closeSearch);
document.getElementById('pv-prev').addEventListener('click', () => stepHit(-1));
document.getElementById('pv-next').addEventListener('click', () => stepHit(1));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
  if (e.key === 'Escape') closeSearch();
});

function toggleSearch() {
  if (searchBox.hidden) { searchBox.hidden = false; searchInput.focus(); }
  else closeSearch();
}
function closeSearch() {
  searchBox.hidden = true;
  searchQuery = '';
  hitPages = []; curHit = -1;
  clearHighlights();
}

async function ensurePageTexts() {
  if (pageTexts) return;
  pageTexts = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    try {
      const tc = await (await pdfDoc.getPage(i)).getTextContent();
      pageTexts[i] = tc.items.map((it) => it.str).join(' ').toLowerCase();
    } catch { pageTexts[i] = ''; }
  }
}

async function runSearch() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q || !pdfDoc) return;
  searchCount.textContent = '搜索中…';
  await ensurePageTexts();
  searchQuery = q;
  hitPages = []; hitTotal = 0;
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    let n = 0;
    for (let p = pageTexts[i].indexOf(q); p >= 0 && n < 99; p = pageTexts[i].indexOf(q, p + q.length)) n++;
    if (n > 0) { hitPages.push(i); hitTotal += n; }
  }
  clearHighlights();
  pageDivs.forEach((d) => d && highlightPage(d));
  if (!hitPages.length) { searchCount.textContent = '无结果'; curHit = -1; return; }
  curHit = 0;
  gotoPage(hitPages[0]);
  updateHitCount();
}

function stepHit(dir) {
  if (!hitPages.length) { runSearch(); return; }
  curHit = (curHit + dir + hitPages.length) % hitPages.length;
  gotoPage(hitPages[curHit]);
  updateHitCount();
}
function updateHitCount() {
  searchCount.textContent = `第 ${curHit + 1}/${hitPages.length} 页 · 共 ${hitTotal} 处`;
}
function clearHighlights() {
  document.querySelectorAll('.textLayer .pv-hit').forEach((s) => s.classList.remove('pv-hit'));
}
function highlightPage(pageDiv) {
  if (!searchQuery) return;
  pageDiv.querySelectorAll('.textLayer span').forEach((s) => {
    if ((s.textContent || '').toLowerCase().includes(searchQuery)) s.classList.add('pv-hit');
  });
}

// ========== 主题 ==========
function currentTheme() {
  try {
    const p = localStorage.getItem('nb-theme') || 'auto';
    if (p === 'dark') return 'dark';
    if (p === 'light') return 'light';
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch { return 'light'; }
}
function applyTheme(eff) { document.body.classList.toggle('dark', eff === 'dark'); }

// ========== 与父页通信 ==========
function post(msg) { try { parent.postMessage(msg, location.origin); } catch {} }
window.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'nb-theme') applyTheme(d.effective);
  else if (d.type === 'nb-goto-page' && typeof d.page === 'number') gotoPage(d.page);
  else if (d.type === 'nb-read-prefs') {
    // PDF 只支持护眼色温（字号/行距由 PDF 自身排版决定）
    const warm = (d.prefs && d.prefs.warm) || 0;
    document.body.style.filter = warm > 0 ? `sepia(${warm})` : '';
  }
});

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
