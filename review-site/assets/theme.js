// 主题与动态背景偏好：本机缓存用于无闪烁首屏，登录后再按密码用户与服务端同步。
(function () {
  const THEME_KEY = 'nb-theme';
  const BG_KEY = 'nb-background';
  const OPACITY_KEY = 'nb-bg-opacity';
  const PREF_KEY = 'appearance:home';
  const THEME_ORDER = ['auto', 'light', 'dark'];
  // 内置 5 套；另外允许 custom:<id> 形式的自定义图片背景（最多 3 张，见 api/background.js）
  const BG_BUILTIN = ['none', 'aurora', 'blinds', 'waves', 'terrain'];
  // 老配置迁移：下线的 id 就近映射，用户的选择不会莫名其妙被清掉
  const BG_ALIAS = {
    balatro: 'waves', plain: 'none',
    mesh: 'aurora', silk: 'waves', nebula: 'terrain',
  };
  const isCustomBg = (v) => typeof v === 'string' && /^custom:[a-z0-9-]{1,40}$/.test(v);
  const validBg = (v) => BG_BUILTIN.includes(v) || isCustomBg(v);
  const normBg = (v) => (BG_ALIAS[v] || v);
  // 背景浓淡：0.15~1，落到 CSS 变量 --nb-bg-opacity（画布层和图片层都吃它）
  const OPACITY_MIN = 0.15, OPACITY_MAX = 1, OPACITY_DEFAULT = 0.55;
  const clampOpacity = (v) => {
    const n = Number(v);
    if (!isFinite(n)) return OPACITY_DEFAULT;
    return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, Math.round(n * 100) / 100));
  };
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
    const value = normBg(localStorage.getItem(BG_KEY));
    if (validBg(value)) return value;
    localStorage.setItem(BG_KEY, 'none');
    return 'none';
  }

  function opacityPref() {
    const raw = localStorage.getItem(OPACITY_KEY);
    return raw == null ? OPACITY_DEFAULT : clampOpacity(raw);
  }

  function applyOpacity(value) {
    document.documentElement.style.setProperty('--nb-bg-opacity', String(value));
    document.querySelectorAll('[data-bg-opacity]').forEach((el) => {
      if (el.value !== String(value)) el.value = String(value);
    });
    window.dispatchEvent(new CustomEvent('nb-background-opacity', { detail: { opacity: value } }));
  }

  function setOpacity(value, userAction = true) {
    const v = clampOpacity(value);
    localStorage.setItem(OPACITY_KEY, String(v));
    if (userAction) dirty = true;
    applyOpacity(v);
    if (userAction) queuePersist();
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
    return { theme: themePref(), background: backgroundPref(), bgOpacity: opacityPref() };
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
    pref = normBg(pref);
    if (!validBg(pref)) return;
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
      if (remote.bgOpacity != null) setOpacity(remote.bgOpacity, false);
      if (validBg(normBg(remote.background))) {
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
    document.querySelectorAll('[data-bg-opacity]').forEach((input) => {
      if (input.__nbOpacityWired) return;
      input.__nbOpacityWired = true;
      // input 事件实时改画面，change 才落库，免得拖一下发几十个请求
      input.addEventListener('input', () => {
        const v = clampOpacity(input.value);
        localStorage.setItem(OPACITY_KEY, String(v));
        dirty = true;
        document.documentElement.style.setProperty('--nb-bg-opacity', String(v));
      });
      input.addEventListener('change', () => setOpacity(input.value));
    });
    updateThemeButtons(themePref());
    updateBackgroundButtons(backgroundPref());
    applyOpacity(opacityPref());
  }

  mql.addEventListener('change', () => {
    if (themePref() === 'auto') applyTheme('auto');
  });
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_KEY) applyTheme(themePref());
    if (event.key === BG_KEY) applyBackground(backgroundPref());
  });

  applyTheme(themePref());
  applyOpacity(opacityPref());
  applyBackground(backgroundPref());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
  window.addEventListener('load', hydrate, { once: true });

  window.NBTheme = {
    BUILTIN_BG: BG_BUILTIN,
    isCustomBg,
    validBg,
    get effective() { return effective(themePref()); },
    get pref() { return themePref(); },
    get background() { return backgroundPref(); },
    get bgOpacity() { return opacityPref(); },
    OPACITY_MIN, OPACITY_MAX, OPACITY_DEFAULT,
    apply: () => applyTheme(themePref()),
    set: setTheme,
    setBackground,
    setOpacity,
    sync: queuePersist,
    flush: persist,
  };
})();
