// Markdown 阅读器：取回原始 md 文本，用 markdown-it 渲染，
// markdown-it-texmath + KaTeX 处理数学公式，highlight.js 做代码高亮。
// 装在 reader 的 iframe 内（body 正常滚动），目录/暗色经 postMessage 与父页联动。
(function () {
  const qs = new URLSearchParams(location.search);
  const src = qs.get('src');
  const contentEl = document.getElementById('md-content');
  const loadingEl = document.getElementById('md-loading');

  applyTheme(currentTheme());

  if (!window.markdownit) {
    fail('markdown-it 加载失败（检查网络/CDN）');
    return;
  }

  const md = window.markdownit({
    html: false,           // 用户上传内容，禁原始 HTML 更安全
    linkify: true,
    breaks: false,
    highlight(str, lang) {
      if (window.hljs && lang && window.hljs.getLanguage(lang)) {
        try {
          return '<pre class="hljs"><code>' + window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value + '</code></pre>';
        } catch {}
      }
      return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
    },
  });

  // 数学公式：$...$ 行内、$$...$$ 块级（texmath 在 inline 规则前 token 化，下划线不会被吃）
  if (window.texmath && window.katex) {
    try {
      md.use(window.texmath, {
        engine: window.katex,
        delimiters: 'dollars',
        katexOptions: { throwOnError: false, errorColor: '#cc0000' },
      });
    } catch (e) { console.warn('[md] texmath init failed', e); }
  }

  if (!src) { fail('缺少文件参数'); return; }

  fetch(src)
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then((text) => {
      contentEl.innerHTML = md.render(text);
      assignHeadingIds();
      loadingEl.hidden = true;
      reportOutline();
      post({ type: 'nb-ready' });
    })
    .catch((e) => fail('加载失败：' + (e && e.message ? e.message : e)));

  function fail(msg) {
    if (loadingEl) { loadingEl.innerHTML = ''; loadingEl.textContent = msg; }
    post({ type: 'nb-ready' }); // 仍通知父页，避免一直转圈等待
  }

  // ===== 目录 =====
  function assignHeadingIds() {
    const hs = contentEl.querySelectorAll('h1, h2, h3');
    hs.forEach((h, i) => { if (!h.id) h.id = 'h-' + i; });
  }
  function reportOutline() {
    const items = [];
    contentEl.querySelectorAll('h1, h2, h3').forEach((h) => {
      items.push({ title: h.textContent.trim(), id: h.id, level: parseInt(h.tagName[1], 10) - 1 });
    });
    post({ type: 'nb-outline', kind: 'md', items });
  }
  function gotoId(id) {
    const el = id && document.getElementById(id);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 12, behavior: 'smooth' });
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
  function applyTheme(eff) {
    const dark = eff === 'dark';
    document.body.classList.toggle('dark', dark);
    const lin = document.getElementById('hljs-light');
    const din = document.getElementById('hljs-dark');
    if (lin) lin.disabled = dark;
    if (din) din.disabled = !dark;
  }

  // ===== 阅读偏好（字号/行距/宽度/色温，由父页 reader 下发） =====
  function applyReadPrefs(p) {
    if (!p) return;
    const wrap = document.getElementById('md-wrap');
    if (wrap) wrap.style.maxWidth = (p.width || 820) + 'px';
    contentEl.style.fontSize = (Math.round(16 * (p.scale || 100)) / 100) + 'px';
    contentEl.style.lineHeight = p.lh ? String(p.lh) : '';
    document.body.style.filter = p.warm > 0 ? `sepia(${p.warm})` : '';
  }

  // ===== 与父页通信 =====
  function post(msg) { try { parent.postMessage(msg, location.origin); } catch {} }
  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'nb-theme') applyTheme(d.effective);
    else if (d.type === 'nb-goto-id') gotoId(d.id);
    else if (d.type === 'nb-read-prefs') applyReadPrefs(d.prefs);
  });
})();
