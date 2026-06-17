// Office 文件预览：在 reader 的 iframe 内，用纯前端库把 docx/xlsx/pptx 渲染成网页。
//   docx -> mammoth.js（转 HTML）       xlsx -> SheetJS（转表格）      pptx -> PPTXjs（转幻灯片）
// 都在浏览器本地完成，不依赖任何第三方在线预览服务。失败时回退为「下载原文件」。
// 与父页（reader.js）经 postMessage 联动主题；不支持目录/RAG（上报空大纲即可）。
(function () {
  const qs = new URLSearchParams(location.search);
  const src = qs.get('src');
  const kind = (qs.get('kind') || '').toLowerCase();

  const loadingEl = document.getElementById('of-loading');
  const spinnerEl = document.getElementById('of-spinner');
  const fallbackEl = document.getElementById('of-fallback');
  const loadingText = document.getElementById('of-loading-text');

  applyTheme(currentTheme());
  if (src) document.getElementById('of-download').href = src;

  let readyPosted = false;
  function ready() { if (!readyPosted) { readyPosted = true; post({ type: 'nb-ready' }); post({ type: 'nb-outline', items: [] }); } }

  if (!src) { showFallback('缺少文件参数'); ready(); return; }
  if (kind === 'docx') renderDocx();
  else if (kind === 'xlsx') renderXlsx();
  else if (kind === 'pptx') renderPptx();
  else { showFallback('不支持的文件类型'); ready(); }

  // ===== DOCX =====
  async function renderDocx() {
    setLoading('正在解析 Word 文档…');
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1/mammoth.browser.min.js');
      const buf = await fetchBuffer(src);
      const result = await window.mammoth.convertToHtml({ arrayBuffer: buf });
      const wrap = document.getElementById('docx-wrap');
      document.getElementById('docx-paper').innerHTML = result.value || '<p>（空文档）</p>';
      loadingEl.hidden = true;
      wrap.hidden = false;
      ready();
    } catch (e) {
      console.warn('[office] docx failed', e);
      showFallback('Word 文档解析失败');
      ready();
    }
  }

  // ===== XLSX =====
  async function renderXlsx() {
    setLoading('正在解析 Excel 表格…');
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
      const buf = await fetchBuffer(src);
      const wb = window.XLSX.read(new Uint8Array(buf), { type: 'array' });
      const names = wb.SheetNames || [];
      if (!names.length) throw new Error('no sheets');

      const tabsEl = document.getElementById('xlsx-tabs');
      const sheetEl = document.getElementById('xlsx-sheet');
      const showSheet = (name) => {
        sheetEl.innerHTML = window.XLSX.utils.sheet_to_html(wb.Sheets[name], { id: 'xlsx-table', editable: false });
        tabsEl.querySelectorAll('.xlsx-tab').forEach((t) => t.classList.toggle('active', t.dataset.name === name));
      };
      tabsEl.innerHTML = names.map((n) => `<button class="xlsx-tab" data-name="${escapeAttr(n)}">${escapeHTML(n)}</button>`).join('');
      tabsEl.addEventListener('click', (e) => { const b = e.target.closest('.xlsx-tab'); if (b) showSheet(b.dataset.name); });
      // 只有一个工作表时隐藏切换条
      if (names.length === 1) tabsEl.style.display = 'none';
      showSheet(names[0]);

      loadingEl.hidden = true;
      document.getElementById('xlsx-wrap').hidden = false;
      ready();
    } catch (e) {
      console.warn('[office] xlsx failed', e);
      showFallback('Excel 表格解析失败');
      ready();
    }
  }

  // ===== PPTX =====
  // PPTXjs 是 jQuery 插件，依赖链较长；任一环节失败或渲染超时，都回退为下载。
  async function renderPptx() {
    setLoading('正在解析 PPT 演示（首次加载组件稍慢）…');
    const GH = 'https://cdn.jsdelivr.net/gh/meshesha/PPTXjs@master/js/';
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/jquery@3.6.4/dist/jquery.min.js');
      await loadScript(GH + 'jszip.min.js');
      await loadScript(GH + 'filereader.js').catch(() => {});   // 可选
      await loadScript(GH + 'd3.min.js').catch(() => {});        // 图表用，缺了也能渲染大部分
      await loadScript(GH + 'nv.d3.min.js').catch(() => {});
      await loadScript(GH + 'pptxjs.js');
      await loadScript(GH + 'divs2slides.js');

      const $ = window.jQuery;
      if (!$ || !$.fn || !$.fn.pptxToHtml) throw new Error('PPTXjs 未就绪');

      document.getElementById('pptx-wrap').hidden = false;
      $('#pptx-result').pptxToHtml({
        pptxFileUrl: src,
        slidesScale: '',
        slideMode: false,
        keyBoardShortCut: false,
        mediaProcess: false,
      });

      // PPTXjs 无完成回调：轮询渲染结果，出现幻灯片即判成功，超时则回退。
      let waited = 0;
      const timer = setInterval(() => {
        waited += 400;
        const slides = document.querySelectorAll('#pptx-result .slide, #pptx-result .block');
        if (slides.length) {
          clearInterval(timer);
          loadingEl.hidden = true;
          ready();
        } else if (waited >= 12000) {
          clearInterval(timer);
          showFallback('PPT 渲染超时或不受支持');
          ready();
        }
      }, 400);
    } catch (e) {
      console.warn('[office] pptx failed', e);
      showFallback('PPT 演示解析失败');
      ready();
    }
  }

  // ===== 工具 =====
  function setLoading(msg) { spinnerEl.style.display = 'flex'; fallbackEl.style.display = 'none'; loadingText.textContent = msg; loadingEl.hidden = false; }
  function showFallback(msg) {
    loadingEl.hidden = false;
    spinnerEl.style.display = 'none';
    fallbackEl.style.display = 'flex';
    const head = fallbackEl.querySelector('div');
    if (head && msg) head.textContent = '😕 ' + msg;
  }

  async function fetchBuffer(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.arrayBuffer();
  }

  // 顺序加载脚本（已加载过则跳过）。返回 Promise。
  const loaded = new Set();
  function loadScript(url) {
    if (loaded.has(url)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => { loaded.add(url); resolve(); };
      s.onerror = () => reject(new Error('加载失败: ' + url));
      document.head.appendChild(s);
    });
  }

  // ===== 主题 =====
  function currentTheme() {
    try {
      const p = localStorage.getItem('nb-theme') || 'auto';
      if (p === 'dark') return 'dark';
      if (p === 'light') return 'light';
      return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch { return 'light'; }
  }
  function applyTheme(eff) { document.body.classList.toggle('dark', eff === 'dark'); }

  function post(msg) { try { parent.postMessage(msg, location.origin); } catch {} }
  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'nb-theme') applyTheme(d.effective);
    else if (d.type === 'nb-read-prefs') {
      const warm = (d.prefs && d.prefs.warm) || 0;
      document.body.style.filter = warm > 0 ? `sepia(${warm})` : '';
    }
  });

  function escapeHTML(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escapeAttr(s) { return escapeHTML(s); }
})();
