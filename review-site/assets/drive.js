// 云盘前端：导航 + 列表 + 上传/新建/重命名/移动/删除/下载 + 分享管理 + 预览 + 排序/搜索/容量。
// 权限：读（浏览/下载/预览）任何登录用户；写（上传/建夹/改名/移动/删除/分享）仅管理员（三级）。
(function () {
  'use strict';

  let isAdmin = false;
  let canUpload = false;          // 任何已登录用户都能上传（一二级走审核）
  let currentPath = '';
  let rawItems = [];
  let usage = { total: 0, files: 0 };
  let sortKey = localStorage.getItem('nb-drive-sort') || 'name';
  let sortDir = parseInt(localStorage.getItem('nb-drive-dir'), 10) || 1;  // 1 升序 / -1 降序
  let searchTerm = '';
  let draggingPath = null;      // 内部拖拽（移动）中的源路径
  const TOTAL_QUOTA = 8 * 1024 * 1024 * 1024;    // 公共云盘总空间上限：8 GB（私人云盘 Xi Pan 另算，限 2 GB）

  const $ = (id) => document.getElementById(id);
  const listEl = $('drive-list');
  const emptyEl = $('drive-empty');
  const crumbsEl = $('drive-crumbs');
  const actionsEl = $('drive-actions');
  const fileInput = $('file-input');
  const dropzone = $('drive-dropzone');
  const uploadsEl = $('drive-uploads');
  const roleBadge = $('drive-role');
  const footEl = $('drive-foot');

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
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts), p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function toast(msg) {
    let el = $('nb-toast');
    if (!el) { el = document.createElement('div'); el.id = 'nb-toast'; document.body.appendChild(el); }
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 2000);
  }

  // ----- 路径 <-> hash -----
  function pathFromHash() {
    const h = location.hash || '';
    if (!h.startsWith('#/')) return '';
    return decodeURIComponent(h.slice(2)).replace(/^\/+|\/+$/g, '');
  }
  function go(path) { location.hash = '#/' + path.split('/').map(encodeURIComponent).join('/'); }
  function fileUrl(path, dl) { return `/api/drive/file?path=${encodeURIComponent(path)}${dl ? '&dl=1' : ''}`; }

  // ----- 预览类型判断 -----
  function extOf(name) { return (name.split('.').pop() || '').toLowerCase(); }
  const CODE_EXTS = [
    'py', 'pyw', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'jsonc', 'ipynb',
    'xml', 'svg', 'vue', 'css', 'scss', 'sass', 'less', 'yml', 'yaml', 'toml', 'ini',
    'cfg', 'conf', 'properties', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql',
    'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'cs', 'java', 'go', 'rs', 'rb', 'php',
    'swift', 'kt', 'kts', 'scala', 'lua', 'pl', 'pm', 'r', 'dart', 'm', 'mm', 'tex',
    'gradle', 'mk', 'txt', 'log', 'csv', 'tsv',
  ];
  const OFFICE_EXTS = ['ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'odt', 'odp', 'ods'];
  function previewKind(name) {
    const e = extOf(name);
    const base = name.toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'].includes(e)) return 'image';
    if (['mp4', 'webm', 'ogg', 'mov'].includes(e)) return 'video';
    if (['mp3', 'wav', 'm4a', 'flac', 'aac'].includes(e)) return 'audio';
    if (e === 'pdf') return 'pdf';
    if (['html', 'htm'].includes(e)) return 'html';
    if (['md', 'markdown'].includes(e)) return 'markdown';
    if (CODE_EXTS.includes(e) || base === 'dockerfile' || base === 'makefile') return 'code';
    if (OFFICE_EXTS.includes(e)) return 'office';
    return null;
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

  function viewItems() {
    let arr = rawItems.slice();
    if (searchTerm) arr = arr.filter((it) => it.name.toLowerCase().includes(searchTerm));
    arr.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;     // 文件夹永远在前
      let r = 0;
      if (sortKey === 'size') r = (a.size || 0) - (b.size || 0);
      else if (sortKey === 'time') r = (a.created_at || 0) - (b.created_at || 0);
      else r = a.name.localeCompare(b.name, 'zh');
      return r * sortDir;
    });
    return arr;
  }

  function renderItems() {
    const items = viewItems();
    if (!items.length) {
      listEl.innerHTML = '';
      emptyEl.hidden = false;
      emptyEl.textContent = searchTerm ? '没有匹配的文件。'
        : (isAdmin ? '这个文件夹是空的 — 点「上传」或把文件拖进来。' : '这个文件夹还没有内容。');
      return;
    }
    emptyEl.hidden = true;
    listEl.innerHTML = items.map((it) => {
      const icon = it.is_dir ? ic('folder', 22) : ic('file', 22);
      const meta = it.is_dir ? '文件夹' : `${fmtSize(it.size)} · ${escapeHTML(fmtDate(it.created_at))}`;
      const nameCell = it.is_dir
        ? `<button class="di-name" data-act="open" data-path="${escapeAttr(it.path)}">${escapeHTML(it.name)}</button>`
        : `<button class="di-name" data-act="preview" data-path="${escapeAttr(it.path)}" data-name="${escapeAttr(it.name)}">${escapeHTML(it.name)}</button>`;
      let actions = '';
      // 管理员：对外可见开关（点一下切换；文件夹会连子项一起放开/收回）
      const visChip = isAdmin
        ? `<button class="di-vis ${it.visible ? 'on' : ''}" data-act="visible" data-path="${escapeAttr(it.path)}" data-vis="${it.visible ? 1 : 0}" title="${it.visible ? '一二级可见，点击改为仅自己' : '仅管理员可见，点击对外开放'}">${it.visible ? '对外' : '仅自己'}</button>`
        : '';
      if (!it.is_dir) actions += `<a class="di-btn" href="${fileUrl(it.path, true)}" title="下载" aria-label="下载">${ic('download', 17)}</a>`;
      if (isAdmin) {
        actions = visChip + actions;
        actions += `<button class="di-btn" data-act="share" data-path="${escapeAttr(it.path)}" data-name="${escapeAttr(it.name)}" title="分享" aria-label="分享">${ic('share', 16)}</button>`;
        actions += `<button class="di-btn" data-act="rename" data-path="${escapeAttr(it.path)}" data-name="${escapeAttr(it.name)}" title="重命名" aria-label="重命名">${ic('edit', 16)}</button>`;
        actions += `<button class="di-btn di-del" data-act="delete" data-path="${escapeAttr(it.path)}" data-dir="${it.is_dir ? 1 : 0}" title="删除" aria-label="删除">${ic('trash', 16)}</button>`;
      }
      return `
        <li class="drive-item ${it.is_dir ? 'is-dir' : 'is-file'}" data-path="${escapeAttr(it.path)}" data-dir="${it.is_dir ? 1 : 0}" ${isAdmin ? 'draggable="true"' : ''}>
          <span class="di-icon">${icon}</span>
          <div class="di-main">${nameCell}<span class="di-meta">${meta}</span></div>
          <div class="di-actions">${actions}</div>
        </li>`;
    }).join('');
  }

  function renderFoot() {
    const pct = Math.min(100, usage.total / TOTAL_QUOTA * 100);
    footEl.innerHTML = `
      <div class="quota-head"><span>存储空间</span><span>已用 ${fmtSize(usage.total)} / ${fmtSize(TOTAL_QUOTA)} · ${usage.files} 个文件</span></div>
      <div class="quota-bar"><i style="width:${pct.toFixed(2)}%"></i></div>`;
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
      if (path) setTimeout(() => go(''), 800);
      return;
    }
    rawItems = data.items || [];
    usage = data.usage || { total: 0, files: 0 };
    renderCrumbs(data.breadcrumb || [{ name: '云盘', path: '' }]);
    renderItems();
    renderFoot();
  }

  // ----- 写操作 -----
  async function op(payload, okMsg) {
    const r = await fetch('/api/drive/op', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { alert(d.error || '操作失败'); return false; }
    if (okMsg) toast(okMsg);
    await load(currentPath);
    return true;
  }
  async function mkdir() {
    const name = prompt('新建文件夹名称：');
    if (name == null) return;
    op({ action: 'mkdir', parent: currentPath, name: name.trim() });
  }
  async function renameItem(path, oldName) {
    const newName = prompt('重命名为：', oldName);
    if (newName == null || newName.trim() === oldName) return;
    op({ action: 'rename', path, newName: newName.trim() });
  }
  async function deleteItem(path, isDir) {
    if (!confirm(isDir ? '删除该文件夹及其全部内容？此操作不可恢复。' : '删除该文件？此操作不可恢复。')) return;
    op({ action: 'delete', path });
  }
  async function moveItem(path, dest) {
    if (path === dest) return;
    await op({ action: 'move', path, dest }, '已移动');
  }

  // ----- 上传（XHR 带进度） -----
  // 管理员上传直接上线；一二级（guest）上传进审核队列，管理员通过后才会出现在云盘。
  function uploadFiles(files) {
    if (!canUpload || !files || !files.length) return;
    uploadsEl.hidden = false;
    const queue = Array.from(files);
    let idx = 0, pendingCount = 0;
    const next = () => {
      if (idx >= queue.length) {
        setTimeout(() => { uploadsEl.hidden = true; uploadsEl.innerHTML = ''; }, 1600);
        if (pendingCount) toast('已提交，等待管理员审核');
        load(currentPath);
        return;
      }
      const file = queue[idx++];
      const row = document.createElement('div');
      row.className = 'up-row';
      row.innerHTML = `<span class="up-name">${escapeHTML(file.name)}</span><span class="up-bar"><i style="width:0%"></i></span><span class="up-pct">0%</span>`;
      uploadsEl.appendChild(row);
      const bar = row.querySelector('.up-bar i'), pct = row.querySelector('.up-pct');
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/drive/upload?parent=${encodeURIComponent(currentPath)}&name=${encodeURIComponent(file.name)}`);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { const p = Math.round(e.loaded / e.total * 100); bar.style.width = p + '%'; pct.textContent = p + '%'; } };
      xhr.onload = () => {
        let d = {}; try { d = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) {
          bar.style.width = '100%';
          if (d.pending) { pct.textContent = '待审核'; row.classList.add('done', 'pending'); pendingCount++; }
          else { pct.textContent = '✓'; row.classList.add('done'); }
        } else { row.classList.add('err'); pct.textContent = '✗'; row.querySelector('.up-name').textContent = file.name + ' — ' + (d.error || '失败'); }
        next();
      };
      xhr.onerror = () => { row.classList.add('err'); pct.textContent = '✗'; next(); };
      xhr.send(file);
    };
    next();
  }

  // ----- 预览 -----
  const previewModal = $('preview-modal');
  function openPreview(path, name) {
    const kind = previewKind(name);
    const body = $('preview-body');
    $('preview-name').textContent = name;
    $('preview-dl').href = fileUrl(path, true);
    const url = fileUrl(path, false);
    const dlUrl = fileUrl(path, true);
    if (kind === 'image') body.innerHTML = `<img src="${escapeAttr(url)}" alt="${escapeAttr(name)}">`;
    else if (kind === 'video') body.innerHTML = `<video src="${escapeAttr(url)}" controls autoplay></video>`;
    else if (kind === 'audio') body.innerHTML = `<div class="preview-audio"><audio src="${escapeAttr(url)}" controls autoplay></audio></div>`;
    else if (kind === 'pdf' || kind === 'html') body.innerHTML = `<iframe src="${escapeAttr(url)}" title="${escapeAttr(name)}"></iframe>`;
    else if (kind === 'markdown') body.innerHTML = `<iframe src="/viewer-md.html?src=${encodeURIComponent(url)}" title="${escapeAttr(name)}"></iframe>`;
    else if (kind === 'code') body.innerHTML = `<iframe src="/viewer-code.html?src=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}" title="${escapeAttr(name)}"></iframe>`;
    else if (kind === 'office') body.innerHTML = `<iframe src="/viewer-office.html?src=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}" title="${escapeAttr(name)}"></iframe>`;
    else body.innerHTML = `<div class="preview-none">该类型暂不支持预览。<br><br><a class="btn-confirm" href="${escapeAttr(dlUrl)}">下载文件</a></div>`;
    previewModal.hidden = false;
  }
  function closePreview() { previewModal.hidden = true; $('preview-body').innerHTML = ''; }
  $('preview-close').addEventListener('click', closePreview);
  previewModal.addEventListener('click', (e) => { if (e.target === previewModal) closePreview(); });

  // ----- 分享：创建 -----
  const shareModal = $('share-modal');
  let shareTargetPath = '';
  function openShareCreate(path, name) {
    shareTargetPath = path;
    $('share-target').textContent = `为「${name}」创建公开分享链接`;
    $('share-pwd').value = '';
    $('share-maxdl').value = '';
    $('share-days').value = '30';
    $('share-result').hidden = true;
    $('share-create').hidden = false;
    shareModal.hidden = false;
  }
  function closeShareCreate() { shareModal.hidden = true; }
  $('share-cancel').addEventListener('click', closeShareCreate);
  shareModal.addEventListener('click', (e) => { if (e.target === shareModal) closeShareCreate(); });
  $('share-create').addEventListener('click', async () => {
    const payload = {
      path: shareTargetPath,
      expiresDays: parseInt($('share-days').value, 10) || 0,
      password: $('share-pwd').value.trim(),
      maxDownloads: parseInt($('share-maxdl').value, 10) || 0,
    };
    const btn = $('share-create'); btn.disabled = true;
    try {
      const r = await fetch('/api/drive/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '创建失败');
      const abs = location.origin + d.url;
      $('share-link').value = abs;
      $('share-result').hidden = false;
      btn.hidden = true;
    } catch (e) { alert(e.message || '创建失败'); }
    finally { btn.disabled = false; }
  });
  $('share-copy').addEventListener('click', () => {
    const inp = $('share-link');
    inp.select();
    navigator.clipboard?.writeText(inp.value).then(() => toast('链接已复制')).catch(() => { document.execCommand('copy'); toast('链接已复制'); });
  });

  // ----- 分享：管理 -----
  const sharesModal = $('shares-modal');
  const sharesBody = $('shares-body');
  function openSharesManage() { sharesModal.hidden = false; loadShares(); }
  async function loadShares() {
    sharesBody.innerHTML = '<p class="rv-loading">加载中…</p>';
    let data;
    try { const r = await fetch('/api/drive/share'); data = await r.json(); if (!r.ok) throw new Error(data.error || '加载失败'); }
    catch (e) { sharesBody.innerHTML = `<p class="rv-empty">⚠️ ${escapeHTML(e.message || '加载失败')}</p>`; return; }
    const list = data.shares || [];
    if (!list.length) { sharesBody.innerHTML = '<p class="rv-empty">还没有分享链接</p>'; return; }
    sharesBody.innerHTML = list.map((s) => {
      const tags = [];
      if (s.expired) tags.push('<span class="sh-tag err">已过期</span>');
      else if (s.expires_at) tags.push(`<span class="sh-tag">至 ${escapeHTML(fmtDate(s.expires_at))}</span>`);
      else tags.push('<span class="sh-tag">永久</span>');
      if (s.hasPassword) tags.push('<span class="sh-tag">🔒 加密</span>');
      tags.push(`<span class="sh-tag">下载 ${s.downloads}${s.max_dl ? '/' + s.max_dl : ''}</span>`);
      if (s.used_up) tags.push('<span class="sh-tag err">已达上限</span>');
      return `
        <div class="rv-card" data-token="${escapeAttr(s.token)}">
          <span class="rv-icon">${s.is_dir ? '📁' : '📄'}</span>
          <div class="rv-info">
            <h4>${escapeHTML(s.name)}</h4>
            <p class="rv-meta">${tags.join(' ')}</p>
          </div>
          <div class="rv-actions">
            <button class="rv-btn sh-copy" data-url="${escapeAttr(location.origin + s.url)}">复制链接</button>
            <button class="rv-btn rv-reject sh-revoke" data-token="${escapeAttr(s.token)}">撤销</button>
          </div>
        </div>`;
    }).join('');
  }
  sharesBody.addEventListener('click', async (e) => {
    const cp = e.target.closest('.sh-copy');
    if (cp) { navigator.clipboard?.writeText(cp.dataset.url).then(() => toast('链接已复制')).catch(() => {}); return; }
    const rv = e.target.closest('.sh-revoke');
    if (rv) {
      if (!confirm('撤销这个分享链接？链接将立即失效。')) return;
      const r = await fetch('/api/drive/share', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: rv.dataset.token }) });
      if (r.ok) { toast('已撤销'); loadShares(); } else alert('撤销失败');
    }
  });
  $('shares-close').addEventListener('click', () => { sharesModal.hidden = true; });
  sharesModal.addEventListener('click', (e) => { if (e.target === sharesModal) sharesModal.hidden = true; });

  // ----- 内容审核（仅管理员）：一二级上传的待审文件，通过 / 拒绝 / 预览 -----
  const reviewModal = $('review-modal');
  const reviewBody = $('review-body');
  const reviewBadge = $('review-badge');
  async function refreshReviewBadge() {
    if (!reviewBadge) return;
    try {
      const r = await fetch('/api/drive/review');
      if (!r.ok) return;
      const d = await r.json();
      const n = (d.pending || []).length;
      reviewBadge.textContent = n > 99 ? '99+' : String(n);
      reviewBadge.hidden = n === 0;
    } catch {}
  }
  function openReview() { reviewModal.hidden = false; loadReview(); }
  async function loadReview() {
    reviewBody.innerHTML = '<p class="rv-loading">加载中…</p>';
    let data;
    try { const r = await fetch('/api/drive/review'); data = await r.json(); if (!r.ok) throw new Error(data.error || '加载失败'); }
    catch (e) { reviewBody.innerHTML = `<p class="rv-empty">⚠️ ${escapeHTML(e.message || '加载失败')}</p>`; return; }
    const list = data.pending || [];
    if (!list.length) { reviewBody.innerHTML = '<p class="rv-empty">暂无待审核的内容 🎉</p>'; return; }
    reviewBody.innerHTML = list.map((f) => {
      const loc = f.parent ? f.parent : '云盘根目录';
      return `
        <div class="rv-card" data-path="${escapeAttr(f.path)}">
          <span class="rv-icon">📄</span>
          <div class="rv-info">
            <h4>${escapeHTML(f.name)}</h4>
            <p class="rv-meta">${fmtSize(f.size)} · 位置：${escapeHTML(loc)} · ${escapeHTML(fmtDate(f.created_at))}</p>
          </div>
          <div class="rv-actions">
            <button class="rv-btn rv-preview" data-path="${escapeAttr(f.path)}" data-name="${escapeAttr(f.name)}">预览</button>
            <button class="rv-btn rv-approve" data-path="${escapeAttr(f.path)}">通过</button>
            <button class="rv-btn rv-reject" data-path="${escapeAttr(f.path)}">拒绝</button>
          </div>
        </div>`;
    }).join('');
  }
  async function reviewAction(path, action) {
    try {
      const r = await fetch('/api/drive/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, action }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '操作失败');
      toast(action === 'approve' ? '已通过，已对外开放' : '已拒绝');
      loadReview(); refreshReviewBadge();
      if (action === 'approve') load(currentPath);
    } catch (e) { alert(e.message || '操作失败'); }
  }
  if (reviewModal && reviewBody) {
    reviewBody.addEventListener('click', (e) => {
      const pv = e.target.closest('.rv-preview');
      if (pv) return openPreview(pv.dataset.path, pv.dataset.name);
      const ap = e.target.closest('.rv-approve');
      if (ap) return reviewAction(ap.dataset.path, 'approve');
      const rj = e.target.closest('.rv-reject');
      if (rj) { if (confirm('拒绝并删除这个文件？此操作不可恢复。')) reviewAction(rj.dataset.path, 'reject'); }
    });
    $('review-close').addEventListener('click', () => { reviewModal.hidden = true; });
    reviewModal.addEventListener('click', (e) => { if (e.target === reviewModal) reviewModal.hidden = true; });
  }

  // ----- 列表点击委托 -----
  listEl.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'open') go(t.dataset.path);
    else if (act === 'visible') op({ action: 'visible', path: t.dataset.path, visible: t.dataset.vis !== '1' }, t.dataset.vis !== '1' ? '已对外开放' : '已设为仅自己');
    else if (act === 'preview') openPreview(t.dataset.path, t.dataset.name);
    else if (act === 'share') openShareCreate(t.dataset.path, t.dataset.name);
    else if (act === 'rename') renameItem(t.dataset.path, t.dataset.name);
    else if (act === 'delete') deleteItem(t.dataset.path, t.dataset.dir === '1');
  });
  crumbsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.crumb[data-path]');
    if (b) go(b.dataset.path);
  });

  // ----- 工具栏 -----
  $('drive-search-input').addEventListener('input', (e) => { searchTerm = e.target.value.trim().toLowerCase(); renderItems(); });
  const sortKeySel = $('drive-sort-key');
  sortKeySel.value = sortKey;
  sortKeySel.addEventListener('change', () => { sortKey = sortKeySel.value; localStorage.setItem('nb-drive-sort', sortKey); renderItems(); });
  const sortDirBtn = $('drive-sort-dir');
  function syncDirBtn() { sortDirBtn.classList.toggle('desc', sortDir < 0); sortDirBtn.title = sortDir < 0 ? '当前降序' : '当前升序'; }
  sortDirBtn.addEventListener('click', () => { sortDir = -sortDir; localStorage.setItem('nb-drive-dir', String(sortDir)); syncDirBtn(); renderItems(); });
  syncDirBtn();
  $('mkdir-btn').addEventListener('click', mkdir);
  $('upload-btn').addEventListener('click', () => fileInput.click());
  $('shares-btn').addEventListener('click', openSharesManage);
  { const rb = $('review-btn'); if (rb) rb.addEventListener('click', openReview); }
  fileInput.addEventListener('change', () => { uploadFiles(fileInput.files); fileInput.value = ''; });

  // ----- 拖拽：内部移动 + 外部上传 -----
  // 内部移动：列表项 draggable，拖到文件夹行或面包屑上松手即移动
  listEl.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.drive-item');
    if (!li || !isAdmin) return;
    draggingPath = li.dataset.path;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', draggingPath); } catch {}
  });
  listEl.addEventListener('dragend', () => {
    draggingPath = null;
    listEl.querySelectorAll('.drag-target').forEach((x) => x.classList.remove('drag-target'));
    crumbsEl.querySelectorAll('.drag-target').forEach((x) => x.classList.remove('drag-target'));
  });
  listEl.addEventListener('dragover', (e) => {
    if (!draggingPath) return;
    const li = e.target.closest('.drive-item.is-dir');
    listEl.querySelectorAll('.drag-target').forEach((x) => x.classList.remove('drag-target'));
    if (li && li.dataset.path !== draggingPath) { e.preventDefault(); li.classList.add('drag-target'); }
  });
  listEl.addEventListener('drop', (e) => {
    if (!draggingPath) return;
    const li = e.target.closest('.drive-item.is-dir');
    if (li && li.dataset.path !== draggingPath) {
      e.preventDefault(); e.stopPropagation();
      const src = draggingPath; draggingPath = null;
      moveItem(src, li.dataset.path);
    }
  });
  crumbsEl.addEventListener('dragover', (e) => {
    if (!draggingPath) return;
    const c = e.target.closest('.crumb');
    crumbsEl.querySelectorAll('.drag-target').forEach((x) => x.classList.remove('drag-target'));
    if (c) { e.preventDefault(); c.classList.add('drag-target'); }
  });
  crumbsEl.addEventListener('drop', (e) => {
    if (!draggingPath) return;
    const c = e.target.closest('.crumb');
    if (c) {
      e.preventDefault(); e.stopPropagation();
      const dest = c.classList.contains('current') ? currentPath : (c.dataset.path != null ? c.dataset.path : '');
      const src = draggingPath; draggingPath = null;
      moveItem(src, dest);
    }
  });

  // 外部文件拖入上传（任何已登录用户，且非内部拖拽时）
  let dragDepth = 0;
  dropzone.addEventListener('dragenter', (e) => {
    if (!canUpload || draggingPath) return;
    e.preventDefault(); dragDepth++; dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragover', (e) => { if (canUpload && !draggingPath) e.preventDefault(); });
  dropzone.addEventListener('dragleave', () => {
    if (!canUpload || draggingPath) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove('dragover');
  });
  dropzone.addEventListener('drop', (e) => {
    if (!canUpload) return;
    dragDepth = 0; dropzone.classList.remove('dragover');
    if (draggingPath) return;                 // 内部移动由专门的 handler 处理
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) { e.preventDefault(); uploadFiles(files); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!previewModal.hidden) closePreview();
    else if (!shareModal.hidden) closeShareCreate();
    else if (!sharesModal.hidden) sharesModal.hidden = true;
    else if (reviewModal && !reviewModal.hidden) reviewModal.hidden = true;
  });
  window.addEventListener('hashchange', () => load(pathFromHash()));

  // ----- 启动 -----
  (async function init() {
    try {
      const me = await fetch('/api/me').then((r) => (r.ok ? r.json() : { role: 'guest' }));
      isAdmin = (me && me.role) === 'admin';
    } catch {}
    canUpload = true;                 // 在 drive.html 上即已登录；一二级上传走审核
    actionsEl.hidden = false;         // 上传按钮对所有登录用户开放
    // 仅管理员：新建文件夹 / 管理分享 / 内容审核
    ['mkdir-btn', 'shares-btn', 'review-btn'].forEach((id) => { const b = $(id); if (b) b.hidden = !isAdmin; });
    if (roleBadge) {
      roleBadge.hidden = false;
      roleBadge.textContent = isAdmin ? '管理员 · 可上传' : '可上传 · 需审核';
      roleBadge.classList.toggle('admin', isAdmin);
    }
    if (isAdmin) refreshReviewBadge();
    load(pathFromHash());
  })();
})();
