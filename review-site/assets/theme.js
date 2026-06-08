// 主题管理：偏好三态 auto/light/dark，持久化到 localStorage，解析为 <html data-theme>。
// 各页 <head> 里有一段内联脚本先行设置 data-theme 避免首屏闪烁；本文件负责切换 UI、
// 跟随系统变化、以及把生效主题广播给阅读器 iframe（让笔记正文也能跟着变暗）。

(function () {
  const KEY = 'nb-theme';
  const ORDER = ['auto', 'light', 'dark'];
  const ICON = { auto: '🌗', light: '☀️', dark: '🌙' };
  const LABEL = {
    auto: '主题：跟随系统（点击切到浅色）',
    light: '主题：浅色（点击切到深色）',
    dark: '主题：深色（点击切到跟随系统）',
  };
  const mql = window.matchMedia('(prefers-color-scheme: dark)');

  function getPref() {
    const v = localStorage.getItem(KEY);
    return ORDER.includes(v) ? v : 'auto';
  }
  function effective(pref) {
    if (pref === 'dark') return 'dark';
    if (pref === 'light') return 'light';
    return mql.matches ? 'dark' : 'light';
  }

  function apply(pref) {
    const eff = effective(pref);
    document.documentElement.dataset.theme = eff;
    updateButton(pref);
    // 通知本页其它脚本（如 reader.js 给 iframe 注入暗色）
    window.dispatchEvent(new CustomEvent('nb-theme-change', { detail: { pref, effective: eff } }));
    return eff;
  }

  function updateButton(pref) {
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.textContent = ICON[pref];
      btn.title = LABEL[pref];
      btn.setAttribute('aria-label', LABEL[pref]);
    });
    // 分段控件（设置里的 跟随系统/浅色/深色）：高亮当前项
    document.querySelectorAll('[data-theme-set]').forEach((btn) => {
      const on = btn.getAttribute('data-theme-set') === pref;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function cycle() {
    const next = ORDER[(ORDER.indexOf(getPref()) + 1) % ORDER.length];
    localStorage.setItem(KEY, next);
    apply(next);
  }

  // 直接设定某个偏好（供分段控件用）
  function setPref(pref) {
    if (!ORDER.includes(pref)) return;
    localStorage.setItem(KEY, pref);
    apply(pref);
  }

  // 系统色变化时，仅在「跟随系统」下重新解析
  mql.addEventListener('change', () => {
    if (getPref() === 'auto') apply('auto');
  });

  function wire() {
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      if (btn.__nbWired) return;
      btn.__nbWired = true;
      btn.addEventListener('click', cycle);
    });
    document.querySelectorAll('[data-theme-set]').forEach((btn) => {
      if (btn.__nbWired) return;
      btn.__nbWired = true;
      btn.addEventListener('click', () => setPref(btn.getAttribute('data-theme-set')));
    });
    updateButton(getPref());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  // 暴露给 reader.js：当前生效主题 + 偏好
  window.NBTheme = {
    get effective() { return effective(getPref()); },
    get pref() { return getPref(); },
    apply: () => apply(getPref()),
    set: setPref,
  };
})();
