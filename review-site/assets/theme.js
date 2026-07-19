// 主题与动态背景偏好：本机缓存用于无闪烁首屏，登录后再按密码用户与服务端同步。
(function () {
  const THEME_KEY = 'nb-theme';
  const BG_KEY = 'nb-background';
  const PREF_KEY = 'appearance:home';
  const THEME_ORDER = ['auto', 'light', 'dark'];
  const BG_ORDER = ['none', 'aurora', 'balatro'];
  const ICON = { auto: '🌗', light: '☀️', dark: '🌙' };
  const LABEL = {
    auto: '主题：跟随系统（点击切到浅色）',
    light: '主题：浅色（点击切到深色）',
    dark: '主题：深色（点击切到跟随系统）',
  };
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  let dirty = false;
  let syncTimer = 0;

  function themePref() {
    const value = localStorage.getItem(THEME_KEY);
    return THEME_ORDER.includes(value) ? value : 'auto';
  }

  function backgroundPref() {
    const value = localStorage.getItem(BG_KEY);
    if (BG_ORDER.includes(value)) return value;
    localStorage.setItem(BG_KEY, 'none');
    return 'none';
  }

  function effective(pref) {
    if (pref === 'dark') return 'dark';
    if (pref === 'light') return 'light';
    return mql.matches ? 'dark' : 'light';
  }

  function updateThemeButtons(pref) {
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.textContent = ICON[pref];
      button.title = LABEL[pref];
      button.setAttribute('aria-label', LABEL[pref]);
    });
    document.querySelectorAll('[data-theme-set]').forEach((button) => {
      const active = button.getAttribute('data-theme-set') === pref;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function updateBackgroundButtons(pref) {
    document.querySelectorAll('[data-bg-set]').forEach((button) => {
      const active = button.getAttribute('data-bg-set') === pref;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function applyTheme(pref) {
    const resolved = effective(pref);
    document.documentElement.dataset.theme = resolved;
    updateThemeButtons(pref);
    window.dispatchEvent(new CustomEvent('nb-theme-change', {
      detail: { pref, effective: resolved },
    }));
    return resolved;
  }

  function applyBackground(pref) {
    document.documentElement.dataset.bg = pref;
    updateBackgroundButtons(pref);
    window.dispatchEvent(new CustomEvent('nb-background-change', {
      detail: { background: pref },
    }));
  }

  function snapshot() {
    return { theme: themePref(), background: backgroundPref() };
  }

  async function persist() {
    syncTimer = 0;
    try {
      const response = await fetch('/api/prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: PREF_KEY, value: JSON.stringify(snapshot()) }),
        keepalive: true,
      });
      if (!response.ok) throw new Error('appearance sync failed');
    } catch (_) {
      // 本机缓存仍然有效；下次操作或刷新会再次同步。
    }
  }

  function queuePersist() {
    clearTimeout(syncTimer);
    syncTimer = window.setTimeout(persist, 140);
  }

  function setTheme(pref, userAction = true) {
    if (!THEME_ORDER.includes(pref)) return;
    localStorage.setItem(THEME_KEY, pref);
    if (userAction) dirty = true;
    applyTheme(pref);
    if (userAction) queuePersist();
  }

  function setBackground(pref, userAction = true) {
    if (!BG_ORDER.includes(pref)) return;
    localStorage.setItem(BG_KEY, pref);
    if (userAction) dirty = true;
    applyBackground(pref);
    if (userAction) queuePersist();
  }

  function cycleTheme() {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(themePref()) + 1) % THEME_ORDER.length];
    setTheme(next);
  }

  async function hydrate() {
    try {
      const response = await fetch(`/api/prefs?key=${encodeURIComponent(PREF_KEY)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return;
      const data = await response.json();
      if (!data.value) {
        if (!dirty) queuePersist();
        return;
      }
      const remote = JSON.parse(data.value);
      if (dirty) {
        queuePersist();
        return;
      }
      if (THEME_ORDER.includes(remote.theme)) setTheme(remote.theme, false);
      if (BG_ORDER.includes(remote.background)) {
        setBackground(remote.background, false);
      } else {
        setBackground('none', false);
        queuePersist();
      }
      window.dispatchEvent(new CustomEvent('nb-appearance-hydrated', { detail: snapshot() }));
    } catch (_) {
      // 离线或旧部署时继续使用本机缓存。
    }
  }

  function wire() {
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      if (button.__nbThemeWired) return;
      button.__nbThemeWired = true;
      button.addEventListener('click', cycleTheme);
    });
    document.querySelectorAll('[data-theme-set]').forEach((button) => {
      if (button.__nbThemeWired) return;
      button.__nbThemeWired = true;
      button.addEventListener('click', () => setTheme(button.getAttribute('data-theme-set')));
    });
    document.querySelectorAll('[data-bg-set]').forEach((button) => {
      if (button.__nbBackgroundWired) return;
      button.__nbBackgroundWired = true;
      button.addEventListener('click', () => setBackground(button.getAttribute('data-bg-set')));
    });
    updateThemeButtons(themePref());
    updateBackgroundButtons(backgroundPref());
  }

  mql.addEventListener('change', () => {
    if (themePref() === 'auto') applyTheme('auto');
  });
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_KEY) applyTheme(themePref());
    if (event.key === BG_KEY) applyBackground(backgroundPref());
  });

  applyTheme(themePref());
  applyBackground(backgroundPref());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
  window.addEventListener('load', hydrate, { once: true });

  window.NBTheme = {
    get effective() { return effective(themePref()); },
    get pref() { return themePref(); },
    get background() { return backgroundPref(); },
    apply: () => applyTheme(themePref()),
    set: setTheme,
    setBackground,
    sync: queuePersist,
    flush: persist,
  };
})();
