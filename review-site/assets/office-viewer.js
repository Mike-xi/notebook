// Office 文档在线预览（纯前端渲染：文件字节只在浏览器内解析，不外传任何第三方查看器）。
//   装在云盘预览弹窗 / 公开分享页的 iframe 内，同源 fetch src（带 Cookie 或 token 鉴权）。
//   ?src=<文件URL>&name=<文件名>
//   docx -> docx-preview，xlsx/xls/ods/csv -> SheetJS，pptx -> pptx-preview。
//   旧二进制格式 .ppt/.doc 与 .odt/.odp 无可靠纯前端解析库 -> 降级为下载提示。
(function () {
  const CDN = {
    jszip: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    docx: 'https://cdn.jsdelivr.net/npm/docx-preview@0.3.7/dist/docx-preview.min.js',
    xlsx: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    pptx: 'https://esm.sh/pptx-preview@1.0.7',
  };

  const qs = new URLSearchParams(location.search);
  const src = qs.get('src');
  const name = qs.get('name') || '文档';
  const ext = (name.split('.').pop() || '').toLowerCase();

  const stage = document.getElementById('stage');
  const tabsEl = document.getElementById('tabs');
  const docEl = document.getElementById('doc');
  const msgEl = document.getElementById('msg');

  applyTheme(currentTheme());

  if (!src) { fail('缺少文件参数'); return; }

  run().catch((e) => fail('预览失败：' + (e && e.message ? e.message : e) + '，可下载后用本地软件打开。'));

  async function run() {
    let render;
    if (ext === 'docx') render = renderDocx;
    else if (['xlsx', 'xls', 'ods', 'csv', 'xlsb', 'xlsm'].includes(ext)) render = renderSheet;
    else if (ext === 'pptx') render = renderPptx;
    else { unsupported(); return; }

    const buf = await fetchBuf();
    await render(buf);
    msgEl.hidden = true;
    stage.hidden = false;
  }

  async function fetchBuf() {
    const r = await fetch(src);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.arrayBuffer();
  }

  // ---- DOCX ----
  async function renderDocx(buf) {
    await loadScript(CDN.jszip);
    await loadScript(CDN.docx);
    await window.docx.renderAsync(buf, docEl, null, {
      className: 'docx',
      inWrapper: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
    });
  }

  // ---- 电子表格 ----
  async function renderSheet(buf) {
    await loadScript(CDN.xlsx);
    const wb = window.XLSX.read(new Uint8Array(buf), { type: 'array' });
    const names = wb.SheetNames || [];
    if (!names.length) { unsupported('空工作簿'); return; }

    const sheetWrap = document.createElement('div');
    sheetWrap.className = 'xl-sheet';
    docEl.appendChild(sheetWrap);

    const show = (idx) => {
      sheetWrap.innerHTML = window.XLSX.utils.sheet_to_html(wb.Sheets[names[idx]]);
      [...tabsEl.children].forEach((c, i) => c.classList.toggle('active', i === idx));
    };

    if (names.length > 1) {
      tabsEl.hidden = false;
      names.forEach((nm, i) => {
        const b = document.createElement('button');
        b.className = 'xl-tab';
        b.textContent = nm;
        b.addEventListener('click', () => show(i));
        tabsEl.appendChild(b);
      });
    }
    show(0);
  }

  // ---- PPTX ----
  async function renderPptx(buf) {
    const mod = await import(CDN.pptx);
    const w = Math.max(320, (stage.clientWidth || 960) - 24);
    const previewer = mod.init(docEl, { width: w, height: Math.round(w * 0.5625) });
    await previewer.preview(buf);
  }

  // ---- 降级 / 错误 ----
  function unsupported(extra) {
    const tip = extra ? extra + '。' : '';
    fail(`${tip}该文档类型（${escapeHtml(ext.toUpperCase())}）暂不支持在线预览，请下载后用本地软件打开。`, true);
  }
  function fail(text, showDl) {
    stage.hidden = true;
    msgEl.hidden = false;
    msgEl.innerHTML = `<span class="msg-text">${escapeHtml(text)}</span>` +
      (showDl ? `<a class="dl" href="${escapeAttr(src || '#')}" download="${escapeAttr(name)}">下载文件</a>` : '');
  }

  function loadScript(url) {
    return new Promise((res, rej) => {
      if ([...document.scripts].some((s) => s.src === url)) return res();
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => res();
      s.onerror = () => rej(new Error('资源加载失败'));
      document.head.appendChild(s);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }

  function currentTheme() {
    try {
      const p = localStorage.getItem('nb-theme') || 'auto';
      if (p === 'dark') return 'dark';
      if (p === 'light') return 'light';
      return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch { return 'light'; }
  }
  function applyTheme(eff) { document.body.classList.toggle('dark', eff === 'dark'); }
  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'nb-theme') applyTheme(d.effective);
  });
})();
