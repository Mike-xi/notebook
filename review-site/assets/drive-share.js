// 云盘公开分享访问页：凭 URL 的 ?t=token（+ 可选密码）浏览/下载，无需登录。
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const token = params.get('t') || '';
  let pw = '';
  let isDir = false;
  let shareName = '';
  let currentSub = '';

  const $ = (id) => document.getElementById(id);
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
  function extOf(name) { return (name.split('.').pop() || '').toLowerCase(); }
  function previewKind(name) {
    const e = extOf(name);
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'].includes(e)) return 'image';
    if (['mp4', 'webm', 'ogg', 'mov'].includes(e)) return 'video';
    if (['mp3', 'wav', 'm4a', 'flac', 'aac'].includes(e)) return 'audio';
    if (e === 'pdf') return 'pdf';
    if (['html', 'htm', 'txt', 'md', 'markdown', 'json', 'csv', 'log', 'xml'].includes(e)) return 'doc';
    if (['docx', 'pptx', 'xlsx', 'xls', 'ods', 'xlsb', 'xlsm', 'ppt', 'doc', 'odt', 'odp'].includes(e)) return 'office';
    return null;
  }

  const base = `/api/drive/shared?token=${encodeURIComponent(token)}`;
  const pwQ = () => (pw ? `&pw=${encodeURIComponent(pw)}` : '');
  const dlUrl = (sub) => `${base}&op=download&sub=${encodeURIComponent(sub || '')}${pwQ()}`;
  const inlineUrl = (sub) => `${base}&op=download&inline=1&sub=${encodeURIComponent(sub || '')}${pwQ()}`;

  function showError(msg) {
    $('ds-gate').hidden = true;
    $('ds-content').hidden = true;
    const e = $('ds-error'); e.hidden = false; e.textContent = '⚠️ ' + msg;
  }

  async function start() {
    if (!token) return showError('分享链接无效');
    let meta;
    try { meta = await (await fetch(`${base}&op=meta${pwQ()}`)).json(); }
    catch { return showError('加载失败'); }
    if (meta.error && !meta.requiresPassword) return showError(meta.error);
    if (meta.expired) return showError('分享已过期');

    shareName = meta.name || '分享';
    isDir = !!meta.is_dir;
    $('ds-title').textContent = shareName;
    document.title = `${shareName} · 分享`;

    if (meta.requiresPassword && !meta.authorized) {
      $('ds-gate').hidden = false;
      $('ds-content').hidden = true;
      $('ds-pw').focus();
      return;
    }
    $('ds-gate').hidden = true;
    $('ds-content').hidden = false;
    if (isDir) loadFolder('');
    else renderFile();
  }

  // 密码门
  $('ds-pw-go').addEventListener('click', tryPw);
  $('ds-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryPw(); });
  async function tryPw() {
    pw = $('ds-pw').value;
    let meta;
    try { meta = await (await fetch(`${base}&op=meta${pwQ()}`)).json(); }
    catch { return; }
    if (meta.authorized) { $('ds-pw-err').hidden = true; start(); }
    else { $('ds-pw-err').hidden = false; }
  }

  // 单文件分享
  function renderFile() {
    $('ds-crumbs').innerHTML = `<span class="crumb current">${ic('link', 16)} ${escapeHTML(shareName)}</span>`;
    $('ds-list').hidden = true;
    const box = $('ds-file');
    box.hidden = false;
    const kind = previewKind(shareName);
    let preview = '';
    if (kind === 'image') preview = `<img class="ds-prev" src="${escapeAttr(inlineUrl(''))}" alt="">`;
    else if (kind === 'video') preview = `<video class="ds-prev" src="${escapeAttr(inlineUrl(''))}" controls></video>`;
    else if (kind === 'audio') preview = `<audio src="${escapeAttr(inlineUrl(''))}" controls></audio>`;
    else if (kind === 'pdf' || kind === 'doc') preview = `<iframe class="ds-prev" src="${escapeAttr(inlineUrl(''))}" title="预览"></iframe>`;
    else if (kind === 'office') preview = `<iframe class="ds-prev" src="/viewer-office.html?src=${encodeURIComponent(inlineUrl(''))}&name=${encodeURIComponent(shareName)}" title="预览"></iframe>`;
    box.innerHTML = `
      <div class="ds-file-head">
        <span class="di-icon">${ic('file', 28)}</span>
        <div class="di-main"><span class="ds-file-name">${escapeHTML(shareName)}</span></div>
        <a class="btn-confirm" href="${escapeAttr(dlUrl(''))}">下载</a>
      </div>
      ${preview ? `<div class="ds-prev-wrap">${preview}</div>` : '<p class="drive-empty">该类型暂不支持在线预览，请下载查看。</p>'}`;
  }

  // 文件夹分享
  async function loadFolder(sub) {
    currentSub = sub;
    $('ds-file').hidden = true;
    const listEl = $('ds-list');
    listEl.hidden = false;
    listEl.innerHTML = '<li class="drive-loading">加载中…</li>';
    let data;
    try { data = await (await fetch(`${base}&op=list&sub=${encodeURIComponent(sub)}${pwQ()}`)).json(); }
    catch { listEl.innerHTML = ''; return; }
    if (data.error) { showError(data.error); return; }
    renderCrumbs(sub);
    const items = data.items || [];
    $('ds-empty').hidden = items.length > 0;
    listEl.innerHTML = items.map((it) => {
      const icon = it.is_dir ? ic('folder', 22) : ic('file', 22);
      const meta = it.is_dir ? '文件夹' : fmtSize(it.size);
      const nameCell = it.is_dir
        ? `<button class="di-name" data-open="${escapeAttr(it.sub)}">${escapeHTML(it.name)}</button>`
        : `<a class="di-name" href="${escapeAttr(inlineUrl(it.sub))}" target="_blank" rel="noopener">${escapeHTML(it.name)}</a>`;
      const dl = it.is_dir ? '' : `<a class="di-btn" href="${escapeAttr(dlUrl(it.sub))}" title="下载">${ic('download', 17)}</a>`;
      return `<li class="drive-item ${it.is_dir ? 'is-dir' : 'is-file'}">
        <span class="di-icon">${icon}</span>
        <div class="di-main">${nameCell}<span class="di-meta">${meta}</span></div>
        <div class="di-actions">${dl}</div></li>`;
    }).join('');
  }

  function renderCrumbs(sub) {
    const crumbs = [{ name: shareName, sub: '' }];
    if (sub) { let acc = ''; for (const p of sub.split('/')) { acc = acc ? acc + '/' + p : p; crumbs.push({ name: p, sub: acc }); } }
    $('ds-crumbs').innerHTML = crumbs.map((c, i) => {
      const last = i === crumbs.length - 1;
      const label = i === 0 ? `${ic('folder', 16)} ${escapeHTML(c.name)}` : escapeHTML(c.name);
      if (last) return `<span class="crumb current">${label}</span>`;
      return `<button class="crumb" data-sub="${escapeAttr(c.sub)}">${label}</button><span class="crumb-sep">/</span>`;
    }).join('');
  }

  $('ds-list').addEventListener('click', (e) => {
    const o = e.target.closest('[data-open]');
    if (o) loadFolder(o.dataset.open);
  });
  $('ds-crumbs').addEventListener('click', (e) => {
    const c = e.target.closest('.crumb[data-sub]');
    if (c) loadFolder(c.dataset.sub);
  });

  start();
})();
