// 高亮 + 批注引擎。运行在 reader 父页，操作 iframe 内的笔记 DOM（同源）。
// 定位用「相对正文根的字符偏移」：offsetOf 用 Range.toString().length 求起止偏移，
// 重开时按文本节点累计长度还原 Range 再包裹 <mark>。笔记内容静态，故可靠。
// 选区浮条与批注弹层建在父页（iframe 全屏固定，故 iframe 内 client 坐标=父页坐标）。
window.NBHighlights = (function () {
  const COLORS = {
    yellow: 'rgba(255,214,80,.5)',
    green: 'rgba(110,220,130,.45)',
    blue: 'rgba(110,180,255,.45)',
    pink: 'rgba(255,135,190,.45)',
  };
  const ORDER = ['yellow', 'green', 'blue', 'pink'];

  let doc, win, root, file;
  let currentRange = null;
  let toolbar, popover;
  const records = new Map(); // id -> {id,start_off,end_off,text,color,note}
  let started = false;

  function init(opts) {
    if (started) return;
    started = true;
    doc = opts.doc; win = opts.win; root = opts.root; file = opts.file;
    if (!doc || !win || !root) return;
    injectStyle();
    buildParentUI();
    doc.addEventListener('mouseup', onMouseUp);
    doc.addEventListener('click', onDocClick);
    win.addEventListener('scroll', hideAll, { passive: true });
    load();
  }

  // ===== 偏移 <-> Range =====
  function offsetOf(container, offset) {
    const r = doc.createRange();
    r.setStart(root, 0);
    try { r.setEnd(container, offset); } catch { return 0; }
    return r.toString().length;
  }
  function rangeFromOffsets(start, end) {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let total = 0, sN = null, sO = 0, eN = null, eO = 0, n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      if (sN === null && total + len >= start) { sN = n; sO = start - total; }
      if (total + len >= end) { eN = n; eO = end - total; break; }
      total += len;
    }
    if (!sN || !eN) return null;
    const r = doc.createRange();
    try { r.setStart(sN, Math.min(sO, sN.nodeValue.length)); r.setEnd(eN, Math.min(eO, eN.nodeValue.length)); }
    catch { return null; }
    return r;
  }

  // ===== 包裹 / 拆除 =====
  function wrapOffsets(start, end, id, color, note) {
    const r = rangeFromOffsets(start, end);
    if (r) wrapRange(r, id, color, note);
  }
  function wrapRange(range, id, color, note) {
    if (range.startContainer === range.endContainer && range.startContainer.nodeType === 3) {
      wrapPortion(range.startContainer, range.startOffset, range.endOffset, id, color, note);
      return;
    }
    const ca = range.commonAncestorContainer;
    const base = ca.nodeType === 3 ? ca.parentNode : ca;
    const walker = doc.createTreeWalker(base, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) { if (range.intersectsNode(n)) nodes.push(n); }
    nodes.forEach((tn) => {
      let s = 0, e = tn.nodeValue.length;
      if (tn === range.startContainer) s = range.startOffset;
      if (tn === range.endContainer) e = range.endOffset;
      if (e > s) wrapPortion(tn, s, e, id, color, note);
    });
  }
  function wrapPortion(tn, s, e, id, color, note) {
    const r = doc.createRange();
    r.setStart(tn, s); r.setEnd(tn, e);
    const mark = doc.createElement('mark');
    mark.className = 'nb-hl';
    mark.dataset.hlId = String(id);
    mark.dataset.color = color;
    if (note) mark.dataset.hasNote = '1';
    try { r.surroundContents(mark); } catch {}
  }
  function unwrap(id) {
    doc.querySelectorAll(`mark.nb-hl[data-hl-id="${id}"]`).forEach((m) => {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    });
  }
  function setMarkAttr(id, attr, val) {
    doc.querySelectorAll(`mark.nb-hl[data-hl-id="${id}"]`).forEach((m) => {
      if (val == null) delete m.dataset[attr]; else m.dataset[attr] = val;
    });
  }

  // ===== 加载已有 =====
  async function load() {
    let list = [];
    try { list = await fetch(`/api/highlights?file=${encodeURIComponent(file)}`).then((r) => r.json()); } catch {}
    (list || []).forEach((h) => {
      records.set(h.id, h);
      wrapOffsets(h.start_off, h.end_off, h.id, h.color, h.note);
    });
  }

  // ===== 选区 =====
  function onMouseUp() {
    setTimeout(() => {
      const sel = win.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hideToolbar();
      const range = sel.getRangeAt(0);
      if (range.collapsed || !range.toString().trim()) return hideToolbar();
      if (!root.contains(range.commonAncestorContainer)) return hideToolbar();
      currentRange = range.cloneRange();
      showToolbar(range.getBoundingClientRect());
    }, 0);
  }
  async function createHighlight(color) {
    if (!currentRange) return;
    const start = offsetOf(currentRange.startContainer, currentRange.startOffset);
    const end = offsetOf(currentRange.endContainer, currentRange.endOffset);
    const text = currentRange.toString();
    hideToolbar();
    try { win.getSelection().removeAllRanges(); } catch {}
    if (end <= start) return;
    try {
      const res = await fetch('/api/highlights', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, start, end, text, color }),
      });
      const data = await res.json();
      if (!res.ok) return;
      records.set(data.id, { id: data.id, start_off: start, end_off: end, text, color, note: '' });
      wrapOffsets(start, end, data.id, color, '');
    } catch {}
  }

  // ===== 点击已有高亮 -> 批注弹层 =====
  function onDocClick(e) {
    const mark = e.target.closest && e.target.closest('mark.nb-hl');
    if (mark) { e.preventDefault(); openPopover(parseInt(mark.dataset.hlId, 10), mark); }
    else if (!toolbar.contains(e.target)) hideToolbar();
  }

  async function updateHl(id, patch) {
    try {
      await fetch('/api/highlights', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...patch }),
      });
    } catch {}
    const rec = records.get(id); if (rec) Object.assign(rec, patch);
    if (patch.color != null) setMarkAttr(id, 'color', patch.color);
    if (patch.note != null) setMarkAttr(id, 'hasNote', patch.note ? '1' : null);
  }
  async function deleteHl(id) {
    try {
      await fetch('/api/highlights', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch {}
    unwrap(id); records.delete(id); hidePopover();
  }

  // ===== 父页 UI =====
  function buildParentUI() {
    toolbar = document.createElement('div');
    toolbar.className = 'nb-hl-toolbar';
    toolbar.innerHTML = ORDER.map((c) => `<button class="nb-hl-swatch" data-c="${c}" style="background:${COLORS[c]}" title="高亮"></button>`).join('');
    toolbar.addEventListener('mousedown', (e) => e.preventDefault()); // 别让按下清掉选区
    toolbar.addEventListener('click', (e) => {
      const sw = e.target.closest('.nb-hl-swatch');
      if (sw) createHighlight(sw.dataset.c);
    });
    document.body.appendChild(toolbar);

    popover = document.createElement('div');
    popover.className = 'nb-hl-popover';
    popover.innerHTML = `
      <div class="nb-hl-colors">${ORDER.map((c) => `<button class="nb-hl-swatch" data-c="${c}" style="background:${COLORS[c]}"></button>`).join('')}</div>
      <textarea class="nb-hl-note" rows="3" placeholder="写点批注…"></textarea>
      <div class="nb-hl-actions"><button class="nb-hl-del">删除</button><button class="nb-hl-done">完成</button></div>`;
    document.body.appendChild(popover);
    popover.querySelector('.nb-hl-colors').addEventListener('click', (e) => {
      const sw = e.target.closest('.nb-hl-swatch');
      if (sw && popover.dataset.id) updateHl(parseInt(popover.dataset.id, 10), { color: sw.dataset.c });
    });
    popover.querySelector('.nb-hl-note').addEventListener('change', (e) => {
      if (popover.dataset.id) updateHl(parseInt(popover.dataset.id, 10), { note: e.target.value });
    });
    popover.querySelector('.nb-hl-del').addEventListener('click', () => {
      if (popover.dataset.id) deleteHl(parseInt(popover.dataset.id, 10));
    });
    popover.querySelector('.nb-hl-done').addEventListener('click', hidePopover);
  }

  function showToolbar(rect) {
    const below = rect.top < 56;
    toolbar.style.left = clamp(rect.left + rect.width / 2, 80, window.innerWidth - 80) + 'px';
    toolbar.style.top = (below ? rect.bottom + 8 : rect.top - 8) + 'px';
    toolbar.dataset.below = below ? '1' : '';
    toolbar.classList.add('show');
  }
  function hideToolbar() { currentRange = null; toolbar && toolbar.classList.remove('show'); }

  function openPopover(id, mark) {
    const rec = records.get(id); if (!rec) return;
    hideToolbar();
    popover.dataset.id = String(id);
    popover.querySelector('.nb-hl-note').value = rec.note || '';
    const rect = mark.getBoundingClientRect();
    const below = rect.bottom < window.innerHeight - 180;
    popover.style.left = clamp(rect.left, 12, window.innerWidth - 252) + 'px';
    popover.style.top = (below ? rect.bottom + 8 : rect.top - 8) + 'px';
    popover.dataset.below = below ? '1' : '';
    popover.classList.add('show');
  }
  function hidePopover() { popover && popover.classList.remove('show'); popover.dataset.id = ''; }
  function hideAll() { hideToolbar(); hidePopover(); }

  function injectStyle() {
    if (doc.getElementById('nb-hl-style')) return;
    const colorRules = ORDER.map((c) => `mark.nb-hl[data-color="${c}"]{background:${COLORS[c]};}`).join('');
    const s = doc.createElement('style');
    s.id = 'nb-hl-style';
    s.textContent = `
      mark.nb-hl{ color:inherit; border-radius:2px; cursor:pointer; padding:.02em 0; box-decoration-break:clone; -webkit-box-decoration-break:clone; }
      mark.nb-hl[data-has-note]{ border-bottom:2px dotted currentColor; }
      ${colorRules}`;
    (doc.head || doc.documentElement).appendChild(s);
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  return { init };
})();
