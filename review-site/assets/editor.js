// 站内 Markdown 笔记编辑器：左编辑右预览（窄屏二选一切换）。
// 新建：POST /api/courses（multipart，复用上传通道）；编辑：PUT /api/courses。
// 新建时的草稿自动备份到 localStorage，防崩溃丢稿；保存成功后清掉。
//
// 除了基本的语法工具栏，还有几件「成熟编辑器该有」的事（对着 Typora / StackEdit /
// Vditor 这些补的）：
//   · 公式符号面板 —— 希腊字母 / 运算 / 关系 / 微积分 / 矩阵 / 物理记号 / 常量单位 /
//     常用公式，按钮本身用 KaTeX 渲染，支持中文搜索（数据见 editor-symbols.js）；
//   · 大纲（从 # 标题生成，点击跳转）、字数与阅读时间统计；
//   · 列表 / 引用回车自动续行，空项回车收尾；
//   · 图片粘贴或拖入，压缩后内嵌成 data URI；
//   · 编辑区与预览区滚动同步。
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
    updateCount();
    renderOutline();
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

  // ===== Markdown 工具栏 =====
  // 按钮不写死在 HTML 里，改由这份 TOOL_DEFS 渲染；顺序和显隐存本机 nb-ed-tools，
  // 再同步到账号（/api/prefs 的 editor: 前缀），换台设备也是同一套排布。
  //
  // 关键约束：节点只 new 一次，重排靠 replaceChildren 搬**同一批**节点。
  // π / ☰ 这两颗的点击监听和 .on 高亮都挂在节点上，重新 createElement 会把它们抹掉。
  // 隐藏的工具节点仍然造好放在 toolNodes 里（只是没挂进 DOM），所以随时可以再显示出来。
  const svg = (body) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const SVG_LINK = svg('<path d="M10 13.5a4 4 0 0 0 5.66 0l3-3A4 4 0 0 0 13 4.8l-1.7 1.7"/><path d="M14 10.5a4 4 0 0 0-5.66 0l-3 3A4 4 0 0 0 11 19.2l1.7-1.7"/>');
  const SVG_IMAGE = svg('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.6" cy="10" r="1.6"/><path d="M21 15.5 16 10.5 6.5 19.5"/>');

  const TOOL_DEFS = [
    { id: 'h1',      name: '一级标题', label: 'H1',        title: '一级标题' },
    { id: 'h2',      name: '二级标题', label: 'H',         title: '标题' },
    { id: 'h3',      name: '三级标题', label: 'H3',        title: '三级标题' },
    { id: 'bold',    name: '加粗',     label: '<b>B</b>',  title: '加粗 (Ctrl/⌘+B)' },
    { id: 'italic',  name: '斜体',     label: '<i>I</i>',  title: '斜体 (Ctrl/⌘+I)' },
    { id: 'strike',  name: '删除线',   label: 'S&#822;',   title: '删除线' },
    { id: 'sep1',    name: '分隔符',   kind: 'sep' },
    { id: 'ul',      name: '无序列表', label: '&bull;—',   title: '无序列表' },
    { id: 'ol',      name: '有序列表', label: '1.',        title: '有序列表' },
    { id: 'task',    name: '任务清单', label: '☑',         title: '任务清单' },
    { id: 'quote',   name: '引用',     label: '❝',         title: '引用' },
    { id: 'sep2',    name: '分隔符',   kind: 'sep' },
    { id: 'code',    name: '代码',     label: '&lt;/&gt;', title: '行内代码 / 代码块' },
    { id: 'formula', name: '数学公式', label: '∑',         title: '数学公式' },
    // 链接和图片没有靠谱的等宽字形：emoji 在 Windows 上要么是彩色的（跟旁边一排
    // 单色字形不搭），要么直接豆腐块。这两颗改画内联 SVG，跟着 currentColor 走。
    { id: 'link',    name: '链接',     label: SVG_LINK,    title: '链接' },
    { id: 'image',   name: '插入图片', label: SVG_IMAGE,   title: '插入图片（也可直接粘贴 / 拖入）' },
    { id: 'table',   name: '表格',     label: '▦',         title: '表格' },
    { id: 'hr',      name: '分隔线',   label: '—',         title: '分隔线' },
    { id: 'sep3',    name: '分隔符',   kind: 'sep' },
    { id: 'sym',     name: '公式符号', label: 'π',         title: '公式符号面板（希腊字母 / 物理记号 / 常用公式）', domId: 'ed-sym-btn' },
    { id: 'outline', name: '大纲',     label: '☰',         title: '大纲', domId: 'ed-ol-btn' },
  ];
  const DEF_BY_ID = new Map(TOOL_DEFS.map((d) => [d.id, d]));
  const DEFAULT_HIDDEN = ['h1', 'h3'];   // 造好但默认收着，去自定义面板里开
  const TOOLS_KEY = 'nb-ed-tools';
  const TOOLS_PREF = 'editor:tools';

  const toolsEl = document.getElementById('ed-tools');
  const toolNodes = new Map();

  function nodeFor(def) {
    let el = toolNodes.get(def.id);
    if (el) return el;
    if (def.kind === 'sep') {
      el = document.createElement('span');
      el.className = 'ed-tool-sep';
      el.setAttribute('aria-hidden', 'true');
    } else {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'ed-tool';
      el.title = def.title || def.name;
      el.setAttribute('aria-label', def.name);
      el.innerHTML = def.label;
      el.dataset.md = def.id;
      if (def.domId) el.id = def.domId;
    }
    toolNodes.set(def.id, el);
    return el;
  }
  TOOL_DEFS.forEach(nodeFor);

  function defaultCfg() {
    return { order: TOOL_DEFS.map((d) => d.id), hidden: DEFAULT_HIDDEN.slice() };
  }
  // 只认识得出的 id；老配置里没有的新工具补到末尾（宁可多一颗，也别让新功能悄悄消失）
  function normCfg(raw) {
    const order = [];
    (Array.isArray(raw && raw.order) ? raw.order : []).forEach((id) => {
      if (DEF_BY_ID.has(id) && !order.includes(id)) order.push(id);
    });
    TOOL_DEFS.forEach((d) => { if (!order.includes(d.id)) order.push(d.id); });
    const hidden = (Array.isArray(raw && raw.hidden) ? raw.hidden : []).filter((id) => DEF_BY_ID.has(id));
    return { order, hidden };
  }

  let toolCfg = defaultCfg();
  let cfgDirty = false;
  let cfgTimer = 0;
  try {
    const raw = localStorage.getItem(TOOLS_KEY);
    if (raw) toolCfg = normCfg(JSON.parse(raw));
  } catch (_) { /* 本机存坏了就用默认，不值得打断编辑 */ }

  function renderToolbar() {
    if (!toolsEl) return;
    const hidden = new Set(toolCfg.hidden);
    toolsEl.replaceChildren(...toolCfg.order
      .filter((id) => !hidden.has(id))
      .map((id) => DEF_BY_ID.get(id))
      .filter(Boolean)
      .map(nodeFor));
  }

  function saveToolCfg() {
    try { localStorage.setItem(TOOLS_KEY, JSON.stringify(toolCfg)); } catch (_) { /* 隐私模式写不进去，随它 */ }
    clearTimeout(cfgTimer);
    cfgTimer = window.setTimeout(() => {
      fetch('/api/prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: TOOLS_PREF, value: JSON.stringify(toolCfg) }),
        keepalive: true,
      }).catch(() => { /* 本机那份仍然有效，下次改动再同步 */ });
    }, 200);
  }

  // 云端那份只在用户本次还没动过配置时才覆盖本机，避免刚拖完就被慢半拍的响应打回去
  async function hydrateToolCfg() {
    try {
      const r = await fetch(`/api/prefs?key=${encodeURIComponent(TOOLS_PREF)}`, { headers: { Accept: 'application/json' } });
      if (!r.ok) return;
      const d = await r.json();
      if (!d.value || cfgDirty) return;
      toolCfg = normCfg(JSON.parse(d.value));
      try { localStorage.setItem(TOOLS_KEY, JSON.stringify(toolCfg)); } catch (_) { /* 同上 */ }
      renderToolbar();
      if (cfgBox && !cfgBox.hidden) renderCfgList();
    } catch (_) { /* 离线就用本机的 */ }
  }

  renderToolbar();
  const symBtn = toolNodes.get('sym');
  const olBtn = toolNodes.get('outline');

  function afterEdit() {
    inputEl.focus();
    markDirty();
    schedulePreview();
    if (!file) backupDraft();
  }

  // 行内包裹：有选区→两侧加标记并保持选中；无选区→插入占位文字并选中，便于直接改写
  function wrapInline(before, after, placeholder) {
    const s = inputEl.selectionStart, e = inputEl.selectionEnd;
    const sel = inputEl.value.slice(s, e) || placeholder || '';
    inputEl.setRangeText(before + sel + after, s, e, 'end');
    const innerStart = s + before.length;
    inputEl.setSelectionRange(innerStart, innerStart + sel.length);
    afterEdit();
  }

  // 行前缀：对选区涉及的每一整行套用前缀（标题/列表/引用等）
  function prefixLines(makePrefix) {
    const val = inputEl.value;
    const s = inputEl.selectionStart, e = inputEl.selectionEnd;
    const lineStart = val.lastIndexOf('\n', s - 1) + 1;
    let lineEnd = val.indexOf('\n', e);
    if (lineEnd === -1) lineEnd = val.length;
    const out = val.slice(lineStart, lineEnd).split('\n').map(makePrefix).join('\n');
    inputEl.setRangeText(out, lineStart, lineEnd, 'end');
    inputEl.setSelectionRange(lineStart, lineStart + out.length);
    afterEdit();
  }

  // 块级插入：保证前后有空行，符合 Markdown 块语义
  function insertBlock(text) {
    const s = inputEl.selectionStart, e = inputEl.selectionEnd;
    const val = inputEl.value;
    const nlBefore = s > 0 && val[s - 1] !== '\n' ? '\n' : '';
    const nlAfter = e < val.length && val[e] !== '\n' ? '\n' : '';
    inputEl.setRangeText(nlBefore + text + nlAfter, s, e, 'end');
    afterEdit();
  }

  function applyMd(type) {
    switch (type) {
      case 'bold': return wrapInline('**', '**', '粗体');
      case 'italic': return wrapInline('*', '*', '斜体');
      case 'strike': return wrapInline('~~', '~~', '删除线');
      case 'h1': return prefixLines((ln) => '# ' + ln.replace(/^#{1,6}\s*/, ''));
      case 'h2': return prefixLines((ln) => '## ' + ln.replace(/^#{1,6}\s*/, ''));
      case 'h3': return prefixLines((ln) => '### ' + ln.replace(/^#{1,6}\s*/, ''));
      case 'ul': return prefixLines((ln) => '- ' + ln.replace(/^[-*]\s+/, ''));
      case 'ol': return prefixLines((ln, i) => (i + 1) + '. ' + ln.replace(/^\d+\.\s+/, ''));
      case 'task': return prefixLines((ln) => '- [ ] ' + ln.replace(/^- \[[ x]\]\s+/, ''));
      case 'quote': return prefixLines((ln) => '> ' + ln.replace(/^>\s?/, ''));
      case 'code': {
        const sel = inputEl.value.slice(inputEl.selectionStart, inputEl.selectionEnd);
        return sel.includes('\n') ? insertBlock('```\n' + sel + '\n```') : wrapInline('`', '`', '代码');
      }
      case 'formula': {
        const sel = inputEl.value.slice(inputEl.selectionStart, inputEl.selectionEnd);
        return sel.includes('\n') ? insertBlock('$$\n' + (sel || 'a^2 + b^2 = c^2') + '\n$$') : wrapInline('$', '$', 'a^2+b^2=c^2');
      }
      case 'link': return wrapInline('[', '](https://)', '链接文字');
      case 'table': return insertBlock('| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |');
      case 'hr': return insertBlock('---');
      case 'image': return pickImage();
    }
  }

  // 手机没法拖拽、粘贴也别扭，所以工具栏里给一颗直通相册/文件的按钮
  let picker = null;
  function pickImage() {
    if (!picker) {
      picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = 'image/*';
      picker.hidden = true;
      picker.addEventListener('change', () => {
        const f = picker.files && picker.files[0];
        picker.value = '';
        if (f) insertImage(f);
      });
      document.body.appendChild(picker);
    }
    picker.click();
  }

  if (toolsEl) {
    toolsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-md]');
      if (!btn) return;
      e.preventDefault();
      applyMd(btn.dataset.md);
    });
    // 桌面上按下工具按钮会先夺走焦点，光标位置一闪；触屏不走 mousedown，靠 afterEdit 的 focus() 收回来
    toolsEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ed-tool')) e.preventDefault();
    });
  }

  // ===== 自定义工具栏面板 =====
  const cfgBox = document.getElementById('ed-cfg');
  const cfgList = document.getElementById('cfg-list');
  const cfgBtn = document.getElementById('ed-cfg-btn');

  function renderCfgList() {
    if (!cfgList) return;
    const hidden = new Set(toolCfg.hidden);
    const last = toolCfg.order.length - 1;
    cfgList.innerHTML = toolCfg.order.map((id, i) => {
      const d = DEF_BY_ID.get(id);
      if (!d) return '';
      const off = hidden.has(id);
      const icon = d.kind === 'sep' ? '<span style="opacity:.45">｜</span>' : d.label;
      return `<li class="cfg-item${off ? ' off' : ''}" data-id="${id}">
        <button class="cfg-grip" type="button" aria-label="拖动排序">⠿</button>
        <span class="cfg-icon" aria-hidden="true">${icon}</span>
        <span class="cfg-name">${d.name}</span>
        <button class="cfg-move" type="button" data-dir="-1" aria-label="上移"${i === 0 ? ' disabled' : ''}>▲</button>
        <button class="cfg-move" type="button" data-dir="1" aria-label="下移"${i === last ? ' disabled' : ''}>▼</button>
        <button class="cfg-eye" type="button" role="switch" aria-label="${d.name}：${off ? '当前隐藏' : '当前显示'}" aria-checked="${off ? 'false' : 'true'}"></button>
      </li>`;
    }).join('');
  }

  function commitCfg() {
    cfgDirty = true;
    saveToolCfg();
    renderToolbar();
  }

  if (cfgList) {
    cfgList.addEventListener('click', (e) => {
      const li = e.target.closest('.cfg-item');
      if (!li) return;
      const id = li.dataset.id;
      const move = e.target.closest('.cfg-move');
      if (move) {
        const i = toolCfg.order.indexOf(id);
        const j = i + Number(move.dataset.dir);
        if (i < 0 || j < 0 || j >= toolCfg.order.length) return;
        toolCfg.order.splice(j, 0, toolCfg.order.splice(i, 1)[0]);
        commitCfg();
        renderCfgList();
        return;
      }
      if (e.target.closest('.cfg-eye')) {
        const k = toolCfg.hidden.indexOf(id);
        if (k >= 0) toolCfg.hidden.splice(k, 1); else toolCfg.hidden.push(id);
        commitCfg();
        renderCfgList();
      }
    });

    // 拖拽排序：DOM 先动，松手时再把顺序回写进 toolCfg.order
    let drag = null;
    cfgList.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('.cfg-grip');
      if (!grip) return;
      const li = grip.closest('.cfg-item');
      if (!li) return;
      e.preventDefault();
      try { grip.setPointerCapture(e.pointerId); } catch (_) { /* 老浏览器没有就算了 */ }
      drag = { li, grip, id: e.pointerId };
      li.classList.add('dragging');
    });
    cfgList.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const y = e.clientY;
      for (const other of cfgList.children) {
        if (other === drag.li) continue;
        const r = other.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const after = other.compareDocumentPosition(drag.li) & Node.DOCUMENT_POSITION_FOLLOWING;
        if (y < mid && after) { cfgList.insertBefore(drag.li, other); break; }
        if (y > mid && !after) { cfgList.insertBefore(drag.li, other.nextSibling); break; }
      }
    });
    const endDrag = () => {
      if (!drag) return;
      drag.li.classList.remove('dragging');
      drag = null;
      toolCfg.order = [...cfgList.children].map((li) => li.dataset.id).filter(Boolean);
      commitCfg();
      renderCfgList();
    };
    cfgList.addEventListener('pointerup', endDrag);
    cfgList.addEventListener('pointercancel', endDrag);
  }

  function closeCfg() { if (cfgBox) cfgBox.hidden = true; }
  if (cfgBtn && cfgBox) {
    cfgBtn.addEventListener('click', () => { renderCfgList(); cfgBox.hidden = false; });
    cfgBox.addEventListener('click', (e) => { if (e.target === cfgBox) closeCfg(); });
    document.getElementById('cfg-close').addEventListener('click', closeCfg);
    document.getElementById('cfg-done').addEventListener('click', closeCfg);
    document.getElementById('cfg-reset').addEventListener('click', () => {
      toolCfg = defaultCfg();
      commitCfg();
      renderCfgList();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !cfgBox.hidden) closeCfg();
    });
  }

  // 编辑区内快捷键（保存快捷键见下方全局监听）
  const HOTKEYS = { b: 'bold', i: 'italic', k: 'link', e: 'code', m: 'formula' };
  inputEl.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const act = HOTKEYS[e.key.toLowerCase()];
    if (act) { e.preventDefault(); applyMd(act); }
  });

  // ===== 公式符号面板 =====
  // 数据在 assets/editor-symbols.js。按钮上的样子直接用 KaTeX 渲染，所见即所得。
  // 插入时会判断光标是不是已经在 $…$ 里：不在就顺手补一对美元号，省得每次手动包。
  const symsBox = document.getElementById('ed-syms');
  const symTabs = document.getElementById('sym-tabs');
  const symGrid = document.getElementById('sym-grid');
  const symSearch = document.getElementById('sym-search');
  // symBtn 在上面的工具栏注册表里建好（隐藏时节点不在 DOM，getElementById 找不到）
  const GROUPS = window.NB_SYMBOLS || [];
  let symGroup = GROUPS.length ? GROUPS[0].key : '';

  function katexHTML(tex) {
    if (!window.katex) return escapeHTML(tex);
    try { return katex.renderToString(tex, { throwOnError: false, displayMode: false }); }
    catch { return escapeHTML(tex); }
  }
  function escapeHTML(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // 光标是否落在行内公式里：数一数本段落里光标之前有多少个未转义的 $，奇数即在里面
  function insideMath(pos) {
    const val = inputEl.value;
    const from = val.lastIndexOf('\n\n', Math.max(0, pos - 1)) + 1;
    const seg = val.slice(from, pos);
    let n = 0;
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] === '$' && seg[i - 1] !== '\\') n++;
    }
    return n % 2 === 1;
  }

  function insertSymbol(item) {
    const s = inputEl.selectionStart, e = inputEl.selectionEnd;
    const body = item.i || item.t;
    const block = body.includes('\n');                 // 矩阵这类多行的，直接给块级公式
    let text = body, pad = 0;
    if (block) {
      text = insideMath(s) ? body : '$$\n' + body + '\n$$';
      pad = insideMath(s) ? 0 : 3;
    } else if (!insideMath(s)) {
      text = '$' + body + '$';
      pad = 1;
    }
    inputEl.setRangeText(text, s, e, 'end');
    // 模板插进去以后把要改的那一小段选中，直接接着敲
    if (item.sel) {
      const at = inputEl.value.indexOf(item.sel, s + pad);
      if (at >= 0) inputEl.setSelectionRange(at, at + item.sel.length);
    }
    afterEdit();
  }

  function renderSymGrid(query) {
    if (!symGrid) return;
    const q = (query || '').trim().toLowerCase();
    let items = [];
    let wide = false;
    if (q) {
      // 搜索跨全部分组，匹配关键字或 LaTeX 本身
      GROUPS.forEach((gr) => gr.items.forEach((it) => {
        const hay = ((it.k || '') + ' ' + (it.i || it.t)).toLowerCase();
        if (hay.includes(q)) items.push(it);
      }));
      items = items.slice(0, 60);
    } else {
      const gr = GROUPS.find((x) => x.key === symGroup) || GROUPS[0];
      if (gr) { items = gr.items; wide = !!gr.wide; }
    }
    symGrid.classList.toggle('wide', wide || (!!q && items.some((it) => (it.i || it.t).length > 22)));
    symGrid.innerHTML = items.length
      ? items.map((it, i) => `<button class="sym-btn" type="button" data-sym="${i}" title="${escapeHTML(it.k || '')}\n${escapeHTML(it.i || it.t)}">${katexHTML(it.t)}</button>`).join('')
      : '<p class="sym-empty">没找到，换个词试试（支持中文名，如「求和」「矢量」「雷诺」）</p>';
    symGrid.__items = items;
  }

  if (symsBox && GROUPS.length) {
    symTabs.innerHTML = GROUPS.map((gr) => `<button class="sym-tab${gr.key === symGroup ? ' on' : ''}" type="button" data-group="${gr.key}">${gr.name}</button>`).join('');
    symTabs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-group]');
      if (!b) return;
      symGroup = b.dataset.group;
      symSearch.value = '';
      symTabs.querySelectorAll('.sym-tab').forEach((x) => x.classList.toggle('on', x.dataset.group === symGroup));
      renderSymGrid('');
    });
    symGrid.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sym]');
      if (!b || !symGrid.__items) return;
      const it = symGrid.__items[Number(b.dataset.sym)];
      if (it) insertSymbol(it);
    });
    symSearch.addEventListener('input', () => renderSymGrid(symSearch.value));
    symBtn.addEventListener('click', () => {
      const open = symsBox.hidden;
      symsBox.hidden = !open;
      symBtn.classList.toggle('on', open);
      if (open && !symGrid.__items) renderSymGrid('');
    });
  }

  // ===== 大纲 =====
  // 从正文里抓 # 标题（跳过 ``` 代码块里的假标题），点一下把编辑区滚过去。
  const outlineEl = document.getElementById('ed-outline');
  // olBtn 同上，见工具栏注册表

  function headings() {
    const lines = inputEl.value.split('\n');
    const out = [];
    let fence = false;
    lines.forEach((ln, i) => {
      if (/^\s*(```|~~~)/.test(ln)) { fence = !fence; return; }
      if (fence) return;
      const m = /^(#{1,4})\s+(.+?)\s*#*$/.exec(ln);
      if (m) out.push({ level: m[1].length, text: m[2], line: i });
    });
    return out;
  }

  function renderOutline() {
    if (!outlineEl || !mainEl.classList.contains('show-outline')) return;
    const hs = headings();
    outlineEl.innerHTML = hs.length
      ? hs.map((h) => `<button class="ol-item h${h.level}" type="button" data-line="${h.line}">${escapeHTML(h.text)}</button>`).join('')
      : '<p class="ol-empty">还没有标题。用 <b>#</b> 开头写一行就会出现在这里。</p>';
  }

  // 把某一行滚到编辑区可视范围（textarea 没有 scrollIntoView，按行高估算）
  function gotoLine(line) {
    const val = inputEl.value;
    let at = 0;
    for (let i = 0; i < line; i++) {
      const nl = val.indexOf('\n', at);
      if (nl === -1) break;
      at = nl + 1;
    }
    inputEl.focus();
    inputEl.setSelectionRange(at, at);
    const lh = parseFloat(getComputedStyle(inputEl).lineHeight) || 27;
    inputEl.scrollTop = Math.max(0, line * lh - inputEl.clientHeight / 3);
  }

  if (outlineEl && olBtn) {
    olBtn.addEventListener('click', () => {
      const on = mainEl.classList.toggle('show-outline');
      olBtn.classList.toggle('on', on);
      if (on) renderOutline();
    });
    outlineEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-line]');
      if (b) gotoLine(Number(b.dataset.line));
    });
  }

  // ===== 字数统计 =====
  // 中文按字算、英文按词算，两边分开数才准。
  const countEl = document.getElementById('ed-count');
  function updateCount() {
    if (!countEl) return;
    const text = inputEl.value;
    const cjk = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
    const words = (text.replace(/[一-鿿㐀-䶿]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
    const lines = text ? text.split('\n').length : 0;
    // 中文按 300 字/分钟、英文按 200 词/分钟估阅读时间
    const mins = Math.max(1, Math.round(cjk / 300 + words / 200));
    countEl.textContent = `${cjk + words} 字 · ${lines} 行 · 约 ${mins} 分钟`;
  }

  // ===== 列表 / 引用自动续行 =====
  // 回车时如果上一行是列表项，自动补上同样的记号；上一行是空项就把它清掉收尾。
  const LIST_RE = /^(\s*)(?:([-*+])|(\d+)([.)]))\s+(\[[ xX]\]\s+)?(.*)$/;
  const QUOTE_RE = /^(\s*)>\s?(.*)$/;

  function continueList(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    const pos = inputEl.selectionStart;
    if (pos !== inputEl.selectionEnd) return;
    const val = inputEl.value;
    const from = val.lastIndexOf('\n', pos - 1) + 1;
    const line = val.slice(from, pos);

    const li = LIST_RE.exec(line);
    if (li) {
      const [, indent, bullet, num, dot, task, body] = li;
      if (!body.trim()) {           // 空项：回车即收尾，把这行清掉
        e.preventDefault();
        inputEl.setRangeText('', from, pos, 'end');
        afterEdit();
        return;
      }
      e.preventDefault();
      const mark = bullet ? bullet + ' ' : (Number(num) + 1) + dot + ' ';
      inputEl.setRangeText('\n' + indent + mark + (task ? '[ ] ' : ''), pos, pos, 'end');
      afterEdit();
      return;
    }
    const qu = QUOTE_RE.exec(line);
    if (qu) {
      if (!qu[2].trim()) {
        e.preventDefault();
        inputEl.setRangeText('', from, pos, 'end');
        afterEdit();
        return;
      }
      e.preventDefault();
      inputEl.setRangeText('\n' + qu[1] + '> ', pos, pos, 'end');
      afterEdit();
    }
  }
  inputEl.addEventListener('keydown', continueList);

  // ===== 图片：粘贴 / 拖进来 =====
  // 站内没有给笔记正文用的图床，所以压一压直接内嵌成 data URI（笔记本身就是一份 .md 文本）。
  // 长边超过 1600 会缩，压完还超过 1.2MB 就拒绝 —— 免得一张图把整篇笔记撑爆。
  const IMG_MAX_EDGE = 1600;
  const IMG_MAX_BYTES = 1.2 * 1024 * 1024;

  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, IMG_MAX_EDGE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        const type = file.type === 'image/png' ? 'image/png' : 'image/webp';
        resolve(cv.toDataURL(type, 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读不出来')); };
      img.src = url;
    });
  }

  async function insertImage(file) {
    if (!file || !/^image\//.test(file.type)) return;
    setStatus('处理图片…');
    try {
      const uri = await shrinkImage(file);
      if (uri.length > IMG_MAX_BYTES) { setStatus('图片太大了（压完仍超 1.2 MB），先缩小再传', 'err'); return; }
      insertBlock(`![${(file.name || 'image').replace(/\.[^.]+$/, '')}](${uri})`);
      setStatus(`已插入图片（约 ${Math.max(1, Math.round(uri.length / 1024))} KB）`);
    } catch (err) {
      setStatus(err.message || '图片插入失败', 'err');
    }
  }

  inputEl.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData && e.clipboardData.items || [])].find((x) => x.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    insertImage(item.getAsFile());
  });
  inputEl.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });
  inputEl.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file || !/^image\//.test(file.type)) return;
    e.preventDefault();
    insertImage(file);
  });

  // ===== 编辑区 <-> 预览 滚动同步 =====
  // 按滚动百分比对齐就够了（要精确对应得给每个块打行号，代价太大）。
  const previewWrap = document.getElementById('ed-preview-wrap');
  let syncing = 0;
  function linkScroll(from, to) {
    from.addEventListener('scroll', () => {
      if (syncing === 2) return;
      syncing = 1;
      const max = from.scrollHeight - from.clientHeight;
      const ratio = max > 0 ? from.scrollTop / max : 0;
      to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
      requestAnimationFrame(() => { syncing = 0; });
    }, { passive: true });
  }
  if (previewWrap) {
    linkScroll(inputEl, previewWrap);
    previewWrap.addEventListener('scroll', () => {
      if (syncing === 1) return;
      syncing = 2;
      const max = previewWrap.scrollHeight - previewWrap.clientHeight;
      const ratio = max > 0 ? previewWrap.scrollTop / max : 0;
      inputEl.scrollTop = ratio * (inputEl.scrollHeight - inputEl.clientHeight);
      requestAnimationFrame(() => { syncing = 0; });
    }, { passive: true });
  }

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
        if (d.pending) {
          // 游客提交：进入审核队列，不再继续在线编辑（后续 PUT 编辑仅管理员可用）
          localStorage.removeItem(DRAFT_KEY);
          dirty = false;
          setStatus('已提交，等待管理员审核');
          setTimeout(() => { location.href = '/'; }, 1200);
          return;
        }
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

  // 窄屏：编辑/预览分段控件（桌面是左右分栏，控件由 CSS 隐藏）。
  // 药丸滑块交给 segment.js 就地增强，这里只管切 .active。
  const viewSeg = document.getElementById('ed-view');
  if (viewSeg) viewSeg.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    const preview = b.dataset.view === 'preview';
    mainEl.classList.toggle('show-preview', preview);
    viewSeg.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    if (preview) renderPreview();
  });

  // 窄屏顶栏放不下学科/字数/状态，收进「⋯」展开的第二行
  const barEl = document.querySelector('.ed-bar');
  const moreBtn = document.getElementById('ed-more-btn');
  if (barEl && moreBtn) moreBtn.addEventListener('click', () => {
    const on = barEl.classList.toggle('expanded');
    moreBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
  });

  // iOS 弹出键盘时 vh/dvh 都不缩，只有 visualViewport 会缩 —— 不跟着它算，
  // 贴在底部的工具栏就整条被键盘盖住。--ed-vh 只在窄屏的媒体查询里被用到。
  const vv = window.visualViewport;
  if (vv) {
    const syncVH = () => {
      document.documentElement.style.setProperty('--ed-vh', vv.height + 'px');
      if (vv.offsetTop > 1) window.scrollTo(0, 0);   // 顺手把被顶上去的布局视口拉回来
    };
    vv.addEventListener('resize', syncVH);
    vv.addEventListener('scroll', syncVH);
    syncVH();
  }

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
  hydrateToolCfg();
})();
