// 页面说明弹窗。
//
// 起因：好几个页面都在正文里挂着一行行灰色小字（云盘的审核说明、Xi Pan 底部
// 那条 WebDAV 挂载说明、留言板的可见性提示…）。这些话该看的时候要看得到，
// 但不该一直占着版面。统一收进右上角一个「说明」按钮里。
//
// 首页的说明文档是 app.js 里的 DOC_SECTIONS（内容多、还带学习画像入口），
// 这里是给其他页面用的轻量版：自带样式，不依赖 style.css，xipan 那种
// 完全独立配色的页面也能直接用。
//
//   NBHelp.attach('#help-btn', { title: '云盘说明', sections: [{ h: '标题', body: 'HTML' }] });
(function () {
  const CSS = `
.nbh-mask {
  position: fixed; inset: 0; z-index: 9000;
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  background: rgba(12, 10, 20, .42);
  -webkit-backdrop-filter: blur(5px); backdrop-filter: blur(5px);
}
.nbh-box {
  width: min(560px, 100%);
  max-height: min(76vh, 720px);
  display: flex; flex-direction: column;
  border-radius: 18px;
  background: var(--surface-container-high, var(--card, #fff));
  color: var(--on-surface, var(--fg, #1c1b1f));
  border: 1px solid var(--outline-variant, var(--border, #e3e6eb));
  box-shadow: 0 24px 64px rgba(0, 0, 0, .28);
  animation: nbh-pop 160ms ease-out;
}
@keyframes nbh-pop { from { opacity: 0; transform: translateY(8px) scale(.985); } }
.nbh-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--outline-variant, var(--border, #e3e6eb));
}
.nbh-head h3 { margin: 0; font-size: 16px; font-weight: 650; }
.nbh-x {
  flex: none; width: 32px; height: 32px;
  display: grid; place-items: center;
  border: none; border-radius: 50%;
  background: transparent; color: inherit;
  font-size: 19px; line-height: 1; cursor: pointer;
}
.nbh-x:hover { background: var(--surface-container-highest, var(--chip, #eef0f4)); }
.nbh-body { padding: 6px 18px 18px; overflow-y: auto; }
.nbh-sec { margin-top: 14px; }
.nbh-sec h4 {
  margin: 0 0 6px;
  font-size: 13px; font-weight: 650;
  color: var(--primary, #6750A4);
}
.nbh-sec div, .nbh-sec p { margin: 0; font-size: 13.5px; line-height: 1.75; color: var(--on-surface-variant, var(--muted, #6b7280)); }
.nbh-sec ul { margin: 4px 0 0; padding-left: 1.25em; font-size: 13.5px; line-height: 1.75; color: var(--on-surface-variant, var(--muted, #6b7280)); }
.nbh-sec li { margin: 2px 0; }
.nbh-sec b, .nbh-sec strong { color: var(--on-surface, var(--fg, #1c1b1f)); font-weight: 600; }
.nbh-sec code {
  padding: 1px 6px; border-radius: 6px;
  background: var(--surface-container-highest, var(--chip, #eef0f4));
  font-size: 12.5px;
}
`;

  let styled = false;
  function ensureStyle() {
    if (styled) return;
    styled = true;
    const el = document.createElement('style');
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  let mask = null;
  function close() {
    if (!mask) return;
    mask.remove();
    mask = null;
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  function open(opts) {
    ensureStyle();
    close();
    mask = document.createElement('div');
    mask.className = 'nbh-mask';
    mask.innerHTML = `<div class="nbh-box" role="dialog" aria-modal="true" aria-label="${opts.title || '说明'}">
      <div class="nbh-head"><h3>${opts.title || '说明'}</h3><button class="nbh-x" type="button" aria-label="关闭">×</button></div>
      <div class="nbh-body">${(opts.sections || []).map((s) => `
        <section class="nbh-sec"><h4>${s.h}</h4><div>${s.body}</div></section>`).join('')}</div>
    </div>`;
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    mask.querySelector('.nbh-x').addEventListener('click', close);
    document.body.appendChild(mask);
    document.addEventListener('keydown', onKey);
  }

  function attach(target, opts) {
    const btn = typeof target === 'string' ? document.querySelector(target) : target;
    if (!btn) return;
    btn.addEventListener('click', (e) => { e.preventDefault(); open(opts); });
  }

  window.NBHelp = { attach, open, close };
})();
