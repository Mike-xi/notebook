// 站内 Markdown 笔记编辑器：左编辑右预览（窄屏二选一切换）。
// 新建：POST /api/courses（multipart，复用上传通道）；编辑：PUT /api/courses。
// 新建时的草稿自动备份到 localStorage，防崩溃丢稿；保存成功后清掉。
(function () {
  const params = new URLSearchParams(location.search);
  let file = params.get('file') || '';          // 空 = 新建
  const DRAFT_KEY = 'nb-ed-draft-new';

  const titleEl = document.getElementById('ed-title');
  const subjectEl = document.getElementById('ed-subject');
  const inputEl = document.getElementById('ed-input');
  const previewEl = document.getElementById('ed-preview');
  const statusEl = document.getElementById('ed-status');
  const saveBtn = document.getElementById('ed-save');
  const mainEl = document.getElementById('ed-main');

  let dirty = false;
  let saving = false;

  // ===== Markdown 渲染（与 viewer-md 同配置） =====
  const md = window.markdownit
    ? window.markdownit({
        html: false,
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
      })
    : null;
  if (md && window.texmath && window.katex) {
    try {
      md.use(window.texmath, {
        engine: window.katex,
        delimiters: 'dollars',
        katexOptions: { throwOnError: false, errorColor: '#cc0000' },
      });
    } catch (e) { console.warn('[editor] texmath init failed', e); }
  }

  let renderT = null;
  function schedulePreview() {
    clearTimeout(renderT);
    renderT = setTimeout(renderPreview, 250);
  }
  function renderPreview() {
    const text = inputEl.value;
    if (!text.trim()) {
      previewEl.innerHTML = '<p class="ed-preview-empty">预览会出现在这里…</p>';
      return;
    }
    previewEl.innerHTML = md ? md.render(text) : '';
  }

  // ===== 状态提示 =====
  function setStatus(msg, cls) {
    statusEl.textContent = msg || '';
    statusEl.className = 'ed-status' + (cls ? ' ' + cls : '');
  }
  function markDirty() {
    if (!dirty) { dirty = true; setStatus('未保存更改', 'dirty'); }
  }

  // ===== 载入已有笔记 / 新建草稿恢复 =====
  async function load() {
    if (file) {
      setStatus('载入中…');
      try {
        const [content, courses] = await Promise.all([
          fetch(`/api/course-html?file=${encodeURIComponent(file)}`).then((r) => {
            if (!r.ok) throw new Error('笔记不存在');
            return r.text();
          }),
          fetch('/api/courses').then((r) => (r.ok ? r.json() : [])),
        ]);
        const meta = (courses || []).find((c) => c.file === file);
        if (meta && meta.kind !== 'md') throw new Error('只能编辑 Markdown 笔记');
        inputEl.value = content;
        if (meta) { titleEl.value = meta.title || ''; subjectEl.value = meta.subject || ''; }
        document.title = `${(meta && meta.title) || '笔记'} · 编辑`;
        setStatus('');
        renderPreview();
      } catch (e) {
        setStatus(e.message || '载入失败', 'err');
        inputEl.disabled = true;
        saveBtn.disabled = true;
      }
      return;
    }
    // 新建：尝试恢复草稿
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (draft && draft.content && draft.content.trim()) {
        if (confirm('发现上次未保存的草稿，要恢复吗？')) {
          inputEl.value = draft.content;
          titleEl.value = draft.title || '';
          subjectEl.value = draft.subject || '';
          markDirty();
        } else {
          localStorage.removeItem(DRAFT_KEY);
        }
      }
    } catch {}
    renderPreview();
  }

  // ===== 输入联动 =====
  inputEl.addEventListener('input', () => {
    markDirty();
    schedulePreview();
    if (!file) backupDraft();
  });
  titleEl.addEventListener('input', () => { markDirty(); if (!file) backupDraft(); });
  subjectEl.addEventListener('input', () => { markDirty(); if (!file) backupDraft(); });

  let draftT = null;
  function backupDraft() {
    clearTimeout(draftT);
    draftT = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          content: inputEl.value, title: titleEl.value, subject: subjectEl.value,
        }));
      } catch {}
    }, 800);
  }

  // Tab 缩进（编辑器基本素养）
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = inputEl.selectionStart, t = inputEl.selectionEnd;
      inputEl.setRangeText('  ', s, t, 'end');
      markDirty();
      schedulePreview();
    }
  });

  // ===== 保存 =====
  function guessTitle() {
    const t = titleEl.value.trim();
    if (t) return t;
    const m = /^#{1,3}\s+(.+)$/m.exec(inputEl.value);
    return m ? m[1].trim().slice(0, 80) : '未命名笔记';
  }

  async function save() {
    if (saving) return;
    const content = inputEl.value;
    if (!content.trim()) { setStatus('内容为空，没有保存', 'err'); return; }
    saving = true;
    saveBtn.disabled = true;
    setStatus('保存中…');
    try {
      if (!file) {
        // 新建：走已有上传通道，正文打包成 .md 文件
        const fd = new FormData();
        fd.append('title', guessTitle());
        fd.append('subject', subjectEl.value.trim());
        fd.append('description', '站内创建的 Markdown 笔记');
        fd.append('icon', '📝');
        fd.append('kind', 'md');
        fd.append('file', new Blob([content], { type: 'text/markdown' }), 'note.md');
        const res = await fetch('/api/courses', { method: 'POST', body: fd });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || '创建失败');
        file = d.file;
        history.replaceState(null, '', `/editor.html?file=${encodeURIComponent(file)}`);
        localStorage.removeItem(DRAFT_KEY);
      } else {
        const res = await fetch('/api/courses', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file, content, title: guessTitle(), subject: subjectEl.value.trim() }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || '保存失败');
      }
      titleEl.value = guessTitle();
      dirty = false;
      document.title = `${titleEl.value} · 编辑`;
      const hh = new Date();
      setStatus(`已保存 ${String(hh.getHours()).padStart(2, '0')}:${String(hh.getMinutes()).padStart(2, '0')}`);
    } catch (e) {
      setStatus(e.message || '保存失败', 'err');
    } finally {
      saving = false;
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener('click', save);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  });
  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // 窄屏：编辑/预览切换
  const previewToggle = document.getElementById('ed-preview-toggle');
  previewToggle.addEventListener('click', () => {
    const showing = mainEl.classList.toggle('show-preview');
    previewToggle.textContent = showing ? '编辑' : '预览';
    if (showing) renderPreview();
  });

  // hljs 主题随站点主题切换
  function syncHljs() {
    const dark = document.documentElement.dataset.theme === 'dark';
    const lin = document.getElementById('hljs-light');
    const din = document.getElementById('hljs-dark');
    if (lin) lin.disabled = dark;
    if (din) din.disabled = !dark;
  }
  window.addEventListener('nb-theme-change', syncHljs);
  syncHljs();

  load();
})();
