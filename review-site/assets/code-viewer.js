// 代码 / 纯文本预览：取回原始文本，按扩展名用 highlight.js 高亮，左侧带行号。
// 装在云盘预览弹窗的 iframe 内（同源 fetch /api/drive/file，带 Cookie 鉴权）。
(function () {
  const qs = new URLSearchParams(location.search);
  const src = qs.get('src');
  const name = qs.get('name') || '';
  const wrap = document.getElementById('code-wrap');
  const gutter = document.getElementById('code-gutter');
  const codeEl = document.getElementById('code-content');
  const loadingEl = document.getElementById('code-loading');

  applyTheme(currentTheme());

  // 扩展名 -> highlight.js 语言名（未列出的走 highlightAuto）
  const LANG = {
    py: 'python', pyw: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', jsonc: 'json',
    ipynb: 'json', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
    css: 'css', scss: 'scss', sass: 'scss', less: 'less', md: 'markdown', markdown: 'markdown',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini',
    sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', bat: 'dos', cmd: 'dos',
    sql: 'sql', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
    cs: 'csharp', java: 'java', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift',
    kt: 'kotlin', kts: 'kotlin', scala: 'scala', lua: 'lua', pl: 'perl', pm: 'perl',
    r: 'r', dart: 'dart', m: 'objectivec', mm: 'objectivec', tex: 'latex', gradle: 'gradle',
    dockerfile: 'dockerfile', makefile: 'makefile', mk: 'makefile',
    txt: 'plaintext', log: 'plaintext', csv: 'plaintext', tsv: 'plaintext',
  };

  function langOf(fname) {
    const lower = fname.toLowerCase();
    if (lower === 'dockerfile') return 'dockerfile';
    if (lower === 'makefile') return 'makefile';
    const ext = (lower.split('.').pop() || '');
    return LANG[ext] || null;
  }

  if (!src) { fail('缺少文件参数'); return; }

  fetch(src)
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then((text) => render(text))
    .catch((e) => fail('加载失败：' + (e && e.message ? e.message : e)));

  function render(text) {
    let html;
    const lang = langOf(name);
    if (window.hljs) {
      try {
        if (lang && lang !== 'plaintext' && window.hljs.getLanguage(lang)) {
          html = window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
        } else if (lang === 'plaintext') {
          html = escapeHtml(text);
        } else {
          html = window.hljs.highlightAuto(text).value;
        }
      } catch { html = escapeHtml(text); }
    } else {
      html = escapeHtml(text);
    }
    codeEl.innerHTML = html;
    // 行号：以源文本行数为准（与高亮 HTML 无关，稳）
    const n = text.replace(/\n$/, '').split('\n').length;
    let nums = '';
    for (let i = 1; i <= n; i++) nums += i + '\n';
    gutter.textContent = nums;
    loadingEl.hidden = true;
    wrap.hidden = false;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }
  function fail(msg) {
    if (loadingEl) { loadingEl.querySelector('.c-spin')?.remove(); loadingEl.lastChild.textContent = msg; }
  }

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
  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'nb-theme') applyTheme(d.effective);
  });
})();
