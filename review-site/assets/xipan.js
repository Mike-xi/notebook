// Xi Pan 私人云盘（仅管理员）：浏览器端 WebDAV 客户端，调本站 /dav 接口（同源 Cookie 鉴权）。
// 与 Windows/iPhone 等外部 WebDAV 客户端访问的是同一份 R2 存储（前缀 xipan/）。
(function () {
  const $ = (id) => document.getElementById(id);
  const listEl = $('list');
  let cur = '';   // 当前目录相对路径（无首尾斜杠）

  // 主题
  (function () { let t = 'auto'; try { t = localStorage.getItem('nb-theme') || 'auto'; } catch {}
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.classList.toggle('dark', dark); })();

  $('dav-url').textContent = location.origin + '/dav/';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const enc = (rel) => rel.split('/').map(encodeURIComponent).join('/');
  const davUrl = (rel, dir) => '/dav/' + enc(rel) + (dir && rel ? '/' : '');
  function toast(t) { const e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove('show'), 1800); }
  function fmtSize(n) { n = +n || 0; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'; return (n / 1073741824).toFixed(2) + ' GB'; }

  function crumbs() {
    const parts = cur ? cur.split('/') : [];
    let acc = '', html = `<button data-go="">Xi Pan</button>`;
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? acc + '/' + parts[i] : parts[i];
      html += `<span class="sep">/</span><button data-go="${esc(acc)}">${esc(parts[i])}</button>`;
    }
    $('crumbs').innerHTML = html;
  }

  async function load() {
    crumbs();
    listEl.innerHTML = '<div class="loading" id="loading">加载中…</div>';
    let res;
    try {
      res = await fetch(davUrl(cur, true), { method: 'PROPFIND', headers: { Depth: '1' } });
    } catch { listEl.innerHTML = '<div class="empty">网络错误</div>'; return; }
    if (res.status === 401) { listEl.innerHTML = '<div class="empty">需要管理员权限（请用管理员密码登录后访问）。</div>'; return; }
    if (res.status === 404) { listEl.innerHTML = '<div class="empty">这个文件夹不存在了。</div>'; return; }
    if (!res.ok && res.status !== 207) { listEl.innerHTML = '<div class="empty">加载失败（' + res.status + '）</div>'; return; }

    const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
    const responses = [...xml.getElementsByTagNameNS('DAV:', 'response')];
    const selfHref = davUrl(cur, true);
    const items = [];
    for (const r of responses) {
      const href = decodeURIComponent((r.getElementsByTagNameNS('DAV:', 'href')[0] || {}).textContent || '');
      if (!href || href.replace(/\/+$/, '') === selfHref.replace(/\/+$/, '')) continue;  // 跳过目录自身
      const isDir = !!r.getElementsByTagNameNS('DAV:', 'collection').length;
      let rel = decodeURIComponent(href).replace(/^\/dav\/?/, '').replace(/\/+$/, '');
      const name = rel.split('/').pop();
      const size = (r.getElementsByTagNameNS('DAV:', 'getcontentlength')[0] || {}).textContent || '';
      const lm = (r.getElementsByTagNameNS('DAV:', 'getlastmodified')[0] || {}).textContent || '';
      items.push({ rel, name, isDir, size, lm });
    }
    items.sort((a, b) => (a.isDir !== b.isDir) ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, 'zh'));

    if (!items.length) { listEl.innerHTML = '<div class="empty">空文件夹 — 点「上传」或把文件拖进来。</div>'; return; }
    listEl.innerHTML = items.map((it) => {
      const meta = it.isDir ? '文件夹' : `${fmtSize(it.size)}${it.lm ? ' · ' + new Date(it.lm).toLocaleString('zh-CN', { hour12: false }) : ''}`;
      const nameCell = it.isDir
        ? `<button data-open="${esc(it.rel)}">${esc(it.name)}</button>`
        : `<a href="${esc(davUrl(it.rel, false))}" download="${esc(it.name)}" target="_blank" rel="noopener">${esc(it.name)}</a>`;
      return `<div class="row"><span class="ic">${it.isDir ? '📁' : '📄'}</span>` +
        `<div class="nm">${nameCell}<span class="meta">${esc(meta)}</span></div>` +
        `<div class="acts"><button class="rn" data-rn="${esc(it.rel)}" data-dir="${it.isDir ? 1 : 0}">重命名</button>` +
        `<button class="del" data-del="${esc(it.rel)}" data-dir="${it.isDir ? 1 : 0}">删除</button></div></div>`;
    }).join('');
  }

  // 事件委托
  $('crumbs').addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) { cur = b.dataset.go; load(); } });
  listEl.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]'); if (open) { cur = open.dataset.open; load(); return; }
    const del = e.target.closest('[data-del]'); if (del) return doDelete(del.dataset.del, del.dataset.dir === '1');
    const rn = e.target.closest('[data-rn]'); if (rn) return doRename(rn.dataset.rn, rn.dataset.dir === '1');
  });

  $('mkdir').addEventListener('click', async () => {
    const name = (prompt('新文件夹名称：') || '').trim();
    if (!name || /[\\/]/.test(name)) { if (name) toast('名称不能含 / 或 \\'); return; }
    const rel = cur ? cur + '/' + name : name;
    const r = await fetch(davUrl(rel, true), { method: 'MKCOL' });
    if (r.ok) { toast('已创建'); load(); } else toast('创建失败（' + r.status + '）');
  });

  $('upload').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => { uploadFiles([...e.target.files]); e.target.value = ''; });

  async function uploadFiles(files) {
    if (!files.length) return;
    const bar = $('up-bar'); let done = 0;
    bar.style.display = 'block';
    for (const f of files) {
      bar.textContent = `上传中 ${done + 1}/${files.length}：${f.name}`;
      const rel = cur ? cur + '/' + f.name : f.name;
      try {
        const r = await fetch(davUrl(rel, false), { method: 'PUT', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f });
        if (!r.ok) toast(`「${f.name}」上传失败（${r.status}）`);
      } catch { toast(`「${f.name}」上传出错`); }
      done++;
    }
    bar.style.display = 'none';
    toast(`上传完成（${done} 个）`); load();
  }

  async function doDelete(rel, isDir) {
    if (!confirm(`删除${isDir ? '文件夹（含全部内容）' : '文件'}「${rel.split('/').pop()}」？`)) return;
    const r = await fetch(davUrl(rel, isDir), { method: 'DELETE' });
    if (r.ok) { toast('已删除'); load(); } else toast('删除失败（' + r.status + '）');
  }

  async function doRename(rel, isDir) {
    const old = rel.split('/').pop();
    const name = (prompt('重命名为：', old) || '').trim();
    if (!name || name === old || /[\\/]/.test(name)) { if (name && /[\\/]/.test(name)) toast('名称不能含 / 或 \\'); return; }
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const dst = parent ? parent + '/' + name : name;
    const r = await fetch(davUrl(rel, isDir), { method: 'MOVE', headers: { Destination: location.origin + davUrl(dst, isDir) } });
    if (r.ok) { toast('已重命名'); load(); } else toast('重命名失败（' + r.status + '）');
  }

  // 拖拽上传
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); if (e.dataTransfer?.files?.length) uploadFiles([...e.dataTransfer.files]); });

  window.__xipan = { reload: load, cd: (p) => { cur = p || ''; load(); } };
  load();
})();
