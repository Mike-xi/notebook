// 云盘前端：面包屑导航 + 列表 + 上传/新建文件夹/重命名/删除/下载。
// 权限：读（浏览/下载）任何登录用户；写（上传/建夹/改名/删除）仅管理员（三级）。
(function () {
  'use strict';

  let isAdmin = false;
  let currentPath = '';

  const $ = (id) => document.getElementById(id);
  const listEl = $('drive-list');
  const emptyEl = $('drive-empty');
  const crumbsEl = $('drive-crumbs');
  const actionsEl = $('drive-actions');
  const fileInput = $('file-input');
  const dropzone = $('drive-dropzone');
  const uploadsEl = $('drive-uploads');
  const roleBadge = $('drive-role');

  const ic = (n, s) => (window.NBIcon ? NBIcon(n, { size: s || 18 }) : '');

  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function escapeAttr(s) { return escapeHTML(s).replace(/`/g, '&#96;'); }

  function fmtSize(n) {
    if (!n) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ----- 路径 <-> hash -----
  function pathFromHash() {
    const h = location.hash || '';
    if (!h.startsWith('#/')) return '';
    return decodeURIComponent(h.slice(2)).replace(/^\/+|\/+$/g, '');
  }
  function go(path) { location.hash = '#/' + path.split('/').map(encodeURIComponent).join('/'); }

  function fileUrl(path, dl) {
    return `/api/drive/file?path=${encodeURIComponent(path)}${dl ? '&dl=1' : ''}`;
  }

  // ----- 渲染 -----
  function renderCrumbs(breadcrumb) {
    crumbsEl.innerHTML = breadcrumb.map((c, i) => {
      const last = i === breadcrumb.length - 1;
      const label = i === 0 ? `${ic('folder', 16)} ${escapeHTML(c.name)}` : escapeHTML(c.name);
      if (last) return `<span class="crumb current">${label}</span>`;
      return `<button class="crumb" data-path="${escapeAttr(c.path)}">${label}</button><span class="crumb-sep">/</span>`;
    }).join('');
  }

  function renderItems(items) {
    if (!items.length) {
      listEl.innerHTML = '';
      emptyEl.hidden = false;
      emptyEl.textContent = isAdmin
        ? '这个文件夹是空的 — 点「上传」或把文件拖进来。'
        : '这个文件夹还没有内容。';
      return;
    }
    emptyEl.hidden = true;
    listEl.innerHTML = items.map((it) => {
      const icon = it.is_dir ? ic('folder', 22) : ic('file', 22);
      const meta = it.is_dir ? '文件夹' : `${fmtSize(it.size)} · ${escapeHTML(fmtDate(it.created_at))}`;
      const nameCell = it.is_dir
        ? `<button class="di-name" data-act="open" data-path="${escapeAttr(it.path)}">${escapeHTML(it.name)}</button>`
        : `<a class="di-name" href="${fileUrl(it.path, false)}" target="_blank" rel="noopener" title="预览 / 打开">${escapeHTML(it.name)}</a>`;
      let actions = '';
      if (!it.is_dir) {
        actions += `<a class="di-btn" href="${fileUrl(it.path, true)}" title="下载" aria-label="下载">${ic('download', 17)}</a>`;
      }
      if (isAdmin) {
        actions += `<button class="di-btn" data-act="rename" data-path="${escapeAttr(it.path)}" data-name="${escapeAttr(it.name)}" title="重命名" aria-label="重命名">${ic('edit', 16)}</button>`;
        actions += `<button class="di-btn di-del" data-act="delete" data-path="${escapeAttr(it.path)}" data-dir="${it.is_dir ? 1 : 0}" title="删除" aria-label="删除">${ic('trash', 16)}</button>`;
      }
      return `
        <li class="drive-item ${it.is_dir ? 'is-dir' : 'is-file'}">
          <span class="di-icon">${icon}</span>
          <div class="di-main">
            ${nameCell}
            <span class="di-meta">${meta}</span>
          </div>
          <div class="di-actions">${actions}</div>
        </li>`;
    }).join('');
  }

  // ----- 数据 -----
  async function load(path) {
    currentPath = path;
    listEl.innerHTML = '<li class="drive-loading">加载中…</li>';
    emptyEl.hidden = true;
    let data;
    try {
      const r = await fetch(`/api/drive/list?path=${encodeURIComponent(path)}`);
      data = await r.json();
      if (!r.ok) throw new Error(data.error || '加载失败');
    } catch (e) {
      listEl.innerHTML = '';
      emptyEl.hidden = false;
      emptyEl.textContent = '⚠️ ' + (e.message || '加载失败');
      // 路径无效时回到根
      if (path) setTimeout(() => go(''), 800);
      return;
    }
    renderCrumbs(data.breadcrumb || [{ name: '云盘', path: '' }]);
    renderItems(data.items || []);
  }

  // ----- 写操作 -----
  async function mkdir() {
    const name = prompt('新建文件夹名称：');
    if (name == null) return;
    const r = await fetch('/api/drive/op', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mkdir', parent: currentPath, name: name.trim() }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return alert(d.error || '创建失败');
    load(currentPath);
  }

  async function renameItem(path, oldName) {
    const newName = prompt('重命名为：', oldName);
    if (newName == null) return;
    if (newName.trim() === oldName) return;
    const r = await fetch('/api/drive/op', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rename', path, newName: newName.trim() }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return alert(d.error || '重命名失败');
    load(currentPath);
  }

  async function deleteItem(path, isDir) {
    const msg = isDir ? '删除该文件夹及其全部内容？此操作不可恢复。' : '删除该文件？此操作不可恢复。';
    if (!confirm(msg)) return;
    const r = await fetch('/api/drive/op', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', path }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return alert(d.error || '删除失败');
    load(currentPath);
  }

  // ----- 上传（XHR 带进度，逐个串行） -----
  function uploadFiles(files) {
    if (!isAdmin || !files || !files.length) return;
    uploadsEl.hidden = false;
    const queue = Array.from(files);
    let idx = 0;

    const next = () => {
      if (idx >= queue.length) {
        setTimeout(() => { uploadsEl.hidden = true; uploadsEl.innerHTML = ''; }, 1200);
        load(currentPath);
        return;
      }
      const file = queue[idx++];
      const row = document.createElement('div');
      row.className = 'up-row';
      row.innerHTML = `<span class="up-name">${escapeHTML(file.name)}</span>
        <span class="up-bar"><i style="width:0%"></i></span>
        <span class="up-pct">0%</span>`;
      uploadsEl.appendChild(row);
      const bar = row.querySelector('.up-bar i');
      const pct = row.querySelector('.up-pct');

      const xhr = new XMLHttpRequest();
      const url = `/api/drive/upload?parent=${encodeURIComponent(currentPath)}&name=${encodeURIComponent(file.name)}`;
      xhr.open('POST', url);
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const p = Math.round((e.loaded / e.total) * 100);
        bar.style.width = p + '%';
        pct.textContent = p + '%';
      };
      xhr.onload = () => {
        let d = {};
        try { d = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) {
          bar.style.width = '100%'; pct.textContent = '✓'; row.classList.add('done');
        } else {
          row.classList.add('err'); pct.textContent = '✗';
          row.querySelector('.up-name').textContent = file.name + ' — ' + (d.error || '失败');
        }
        next();
      };
      xhr.onerror = () => { row.classList.add('err'); pct.textContent = '✗'; next(); };
      xhr.send(file);
    };
    next();
  }

  // ----- 事件 -----
  crumbsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.crumb[data-path]');
    if (b) go(b.dataset.path);
  });

  listEl.addEventListener('click', (e) => {
    const open = e.target.closest('[data-act="open"]');
    if (open) { go(open.dataset.path); return; }
    const rn = e.target.closest('[data-act="rename"]');
    if (rn) { renameItem(rn.dataset.path, rn.dataset.name); return; }
    const del = e.target.closest('[data-act="delete"]');
    if (del) { deleteItem(del.dataset.path, del.dataset.dir === '1'); return; }
  });

  $('mkdir-btn').addEventListener('click', mkdir);
  $('upload-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { uploadFiles(fileInput.files); fileInput.value = ''; });

  // 拖拽上传（仅管理员）
  let dragDepth = 0;
  dropzone.addEventListener('dragenter', (e) => {
    if (!isAdmin) return;
    e.preventDefault(); dragDepth++; dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragover', (e) => { if (isAdmin) e.preventDefault(); });
  dropzone.addEventListener('dragleave', () => {
    if (!isAdmin) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove('dragover');
  });
  dropzone.addEventListener('drop', (e) => {
    if (!isAdmin) return;
    e.preventDefault(); dragDepth = 0; dropzone.classList.remove('dragover');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) uploadFiles(files);
  });

  window.addEventListener('hashchange', () => load(pathFromHash()));

  // ----- 启动 -----
  (async function init() {
    try {
      const me = await fetch('/api/me').then((r) => (r.ok ? r.json() : { role: 'guest' }));
      isAdmin = (me && me.role) === 'admin';
    } catch {}
    actionsEl.hidden = !isAdmin;
    if (roleBadge) {
      roleBadge.hidden = false;
      roleBadge.textContent = isAdmin ? '管理员 · 可上传' : '只读 · 可下载';
      roleBadge.classList.toggle('admin', isAdmin);
    }
    load(pathFromHash());
  })();
})();
