// 设置面板里的两块：身份卡 + 页面背景手风琴（含自定义图片上传）。
//
// 身份：/api/me 返回 role/level/name，三级分别是 访客 / 好友 / 管理员。
// 背景：5 张内置写死在这里（与 backgrounds.js 的着色器 id 一一对应），
//       另外最多 3 张自定义图片（/api/background，一二级共用一份、三级自己一份）。
(function () {
  if (!document.body.classList.contains('home')) return;

  const $ = (id) => document.getElementById(id);
  const MAX_CUSTOM = 3;

  /* ================================================================ 身份卡 */
  // 头像用站内统一的 Phosphor 图标（assets/icons.js），不用 emoji ——
  // emoji 是各系统自己的字体，跟站内其他图标不是一套设计语言。
  const ROLE_UI = {
    guest: { name: '访客', icon: 'user' },
    friend: { name: '好友', icon: 'handshake' },
    admin: { name: '管理员', icon: 'crown' },
  };

  function renderIdentity(me) {
    const card = $('idcard');
    if (!card) return;
    const ui = ROLE_UI[me && me.role] || ROLE_UI.guest;
    // 身份只靠 data-role 换配色，文案就三个字，不再加说明
    card.dataset.role = (me && me.role) || 'guest';
    const av = $('id-avatar');
    av.innerHTML = window.NBIcon ? NBIcon(ui.icon, { size: 17 }) : '';
    $('id-name').textContent = ui.name;
    card.setAttribute('aria-label', `当前身份：${ui.name}`);
  }

  // app.js 拿到 /api/me 后会派这个事件；万一它先跑完，这里也自己兜一次
  addEventListener('nb-me', (e) => renderIdentity(e.detail));
  if (window.NBMe) renderIdentity(window.NBMe);
  else {
    fetch('/api/me', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => { if (me && !window.NBMe) renderIdentity(me); })
      .catch(() => { /* 未登录到不了首页，忽略 */ });
  }

  /* ================================================================ 背景 */
  // art 是缩略图的 CSS 近似，画的是各着色器的主色调，不额外起 WebGL 预览
  const BUILTIN = [
    { id: 'none', label: '素色', art: 'none' },
    { id: 'aurora', label: '极光', art: 'aurora' },
    { id: 'blinds', label: '百叶窗', art: 'blinds' },
    { id: 'waves', label: '波纹', art: 'waves' },
    { id: 'terrain', label: '地形', art: 'terrain' },
  ];

  let customs = [];      // [{id,label,mime,updated_at}]
  let scope = 'shared';
  let busy = false;

  const acc = $('bg-accordion');
  const fileInput = $('bg-file');
  const hint = $('bg-hint');
  const countEl = $('bg-count');
  if (!acc) return;

  window.NBBackgrounds = {
    find(value) {
      if (typeof value !== 'string' || !value.startsWith('custom:')) return null;
      const id = value.slice(7);
      return customs.find((c) => c.id === id) || null;
    },
    get list() { return customs.slice(); },
  };

  function currentBg() {
    return (window.NBTheme && NBTheme.background) || document.documentElement.dataset.bg || 'none';
  }

  function render() {
    const cur = currentBg();
    const parts = [];

    for (const b of BUILTIN) {
      parts.push(panelHTML(b.id, b.label, `<span class="bp-art bp-${b.art}"></span>`, cur === b.id));
    }
    for (const c of customs) {
      const url = `/api/background?id=${encodeURIComponent(c.id)}&v=${c.updated_at}`;
      const value = 'custom:' + c.id;
      parts.push(panelHTML(
        value,
        c.label || '我的背景',
        `<span class="bp-art" style="background-image:url(&quot;${url}&quot;)"></span>`,
        cur === value,
        `<button type="button" class="bp-del" data-del="${c.id}" title="删除这张背景" aria-label="删除这张背景">×</button>`
      ));
    }
    if (customs.length < MAX_CUSTOM) {
      parts.push(`<button type="button" class="bg-panel bg-add" id="bg-add" title="上传一张自己的背景">
        <span class="bp-art bp-add">＋</span>
        <span class="bp-label"><i class="bp-bar"></i><span>上传</span></span>
      </button>`);
    }

    acc.innerHTML = parts.join('');
    const total = BUILTIN.length + customs.length;
    if (countEl) countEl.textContent = `${total}/8`;
    // 常驻说明已经挪进「说明文档」，这里只在上传中/出错/传满时临时提示一句
    if (hint) {
      hint.textContent = busy
        ? '正在上传…'
        : customs.length >= MAX_CUSTOM
          ? `自选已满 ${MAX_CUSTOM} 张，删掉一张才能再传`
          : '';
      hint.hidden = !hint.textContent;
    }
    wire();
  }

  // 面板必须是 div：删除键是 <button>，而 <button> 里不能再套 <button>，
  // 套了会被 HTML 解析器提出来变成兄弟节点（面板就多出几个空格子）。
  function panelHTML(value, label, art, active, extra) {
    return `<div class="bg-panel${active ? ' on' : ''}" role="option" tabindex="0"
      aria-selected="${active ? 'true' : 'false'}" data-bg-set="${escapeAttr(value)}" title="${escapeAttr(label)}">
      ${art}
      <span class="bp-label"><i class="bp-bar"></i><span>${escapeHTML(label)}</span></span>
      <span class="bp-check" aria-hidden="true">✓</span>
      ${extra || ''}
    </div>`;
  }

  function wire() {
    acc.querySelectorAll('[data-bg-set]').forEach((btn) => {
      const pick = (e) => {
        if (e.target.closest('.bp-del')) return;      // 删除按钮不触发选中
        const v = btn.getAttribute('data-bg-set');
        if (window.NBTheme) NBTheme.setBackground(v);
        render();
      };
      btn.addEventListener('click', pick);
      // div 不像 button 自带键盘激活，这里补上
      btn.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        pick(e);
      });
    });
    acc.querySelectorAll('.bp-del').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        removeCustom(btn.getAttribute('data-del'));
      });
    });
    const add = $('bg-add');
    if (add) add.addEventListener('click', () => fileInput && fileInput.click());
  }

  /* ---------------------------------------------------------- 上传 / 删除 */
  // 浏览器端先压到 ≤1920px 的 webp，避免把 8MB 手机原图直接怼进 R2
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const max = 1920;
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * k));
        const h = Math.max(1, Math.round(img.height * k));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        cv.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('压缩失败'))), 'image/webp', 0.86);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这不是一张能打开的图片')); };
      img.src = url;
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file || busy) return;
      busy = true; render();
      try {
        const blob = await shrink(file);
        const label = (file.name || '').replace(/\.[^.]+$/, '').slice(0, 16) || '我的背景';
        const res = await fetch(`/api/background?label=${encodeURIComponent(label)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'image/webp' },
          body: blob,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '上传失败');
        customs.push({ id: data.id, label: data.label, mime: data.mime, updated_at: data.updated_at });
        busy = false;
        if (window.NBTheme) NBTheme.setBackground('custom:' + data.id);
        dispatchEvent(new CustomEvent('nb-backgrounds-loaded'));
        render();
      } catch (err) {
        busy = false;
        render();
        if (hint) hint.textContent = err.message || '上传失败';
      }
    });
  }

  async function removeCustom(id) {
    if (!id || busy) return;
    busy = true;
    try {
      const res = await fetch(`/api/background?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('删除失败');
      customs = customs.filter((c) => c.id !== id);
      // 正在用这张就退回素色，否则页面会挂着一张已经不存在的图
      if (currentBg() === 'custom:' + id && window.NBTheme) NBTheme.setBackground('none');
    } catch (_) { /* 失败就保持原样，下次刷新会重新拉列表 */ }
    busy = false;
    render();
  }

  /* ---------------------------------------------------------- 列表加载 */
  function load() {
    return fetch('/api/background?list=1', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        customs = Array.isArray(data.items) ? data.items : [];
        scope = data.scope || 'shared';
        // 云端已经没有的自定义背景，本地也别继续挂着
        const cur = currentBg();
        if (cur.startsWith('custom:') && !customs.some((c) => 'custom:' + c.id === cur)) {
          if (window.NBTheme) NBTheme.setBackground('none', false);
        }
        dispatchEvent(new CustomEvent('nb-backgrounds-loaded'));
      })
      .catch(() => { /* 离线时只显示 5 张内置 */ })
      .finally(render);
  }

  addEventListener('nb-appearance-hydrated', render);
  addEventListener('nb-background-change', () => {
    // 由别处（如快捷键）改的背景也要让面板跟上
    acc.querySelectorAll('[data-bg-set]').forEach((btn) => {
      const on = btn.getAttribute('data-bg-set') === currentBg();
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  });

  render();
  load();

  function escapeHTML(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function escapeAttr(s) { return escapeHTML(s).replace(/`/g, '&#96;'); }
})();
