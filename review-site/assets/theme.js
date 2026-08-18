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
  // 背景浓淡 / 亮度：分别落到 CSS 变量 --nb-bg-opacity / --nb-bg-brightness，
  // 画布层和图片层都吃它们。深浅两种主题下背景本身完全一致，明暗只由这两根杆决定。
  //
  // 两根杆的刻度都是「显示 0–100」，取值范围特意配成：
  //   浓淡 100 -> opacity 1     （满格就是不打折，图片按原样铺满）
  //   亮度  50 -> brightness 1  （区间以 1 为中点对称，所以中间格＝不动原图）
  // 也就是说 100 / 50 这一组就是「直接加载图片」的原始状态，别再改这两个常数的对称性。
  // 出厂默认仍是 0.55：内置着色器铺满整屏，满格会把正文压得看不清。
  // 用户自己传的图另说 —— 上传成功那一刻 appearance.js 会把两根杆推到 100 / 50，
  // 也就是「传上去先按原图显示」，要淡再自己拉。
  const OPACITY_MIN = 0.15, OPACITY_MAX = 1, OPACITY_DEFAULT = 0.55;
  const BRIGHT_KEY = 'nb-bg-brightness';
  const BRIGHT_MIN = 0.2, BRIGHT_MAX = 1.8, BRIGHT_DEFAULT = 1;
  const clampOpacity = (v) => {
    const n = Number(v);
    if (!isFinite(n)) return OPACITY_DEFAULT;
    return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, Math.round(n * 100) / 100));
  };
  const clampBright = (v) => {
    const n = Number(v);
    if (!isFinite(n)) return BRIGHT_DEFAULT;
    return Math.min(BRIGHT_MAX, Math.max(BRIGHT_MIN, Math.round(n * 100) / 100));
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

  function brightnessPref() {
    const raw = localStorage.getItem(BRIGHT_KEY);
    return raw == null ? BRIGHT_DEFAULT : clampBright(raw);
  }
  function applyBrightness(value) {
    document.documentElement.style.setProperty('--nb-bg-brightness', String(value));
    document.querySelectorAll('[data-bg-brightness]').forEach((el) => {
      if (el.value !== String(value)) el.value = String(value);
    });
  }
  function setBrightness(value, userAction = true) {
    const v = clampBright(value);
    localStorage.setItem(BRIGHT_KEY, String(v));
    if (userAction) dirty = true;
    applyBrightness(v);
    if (userAction) queuePersist();
  }

  // 顶栏（高级界面的 Dock）通透度：0–100 连续可调（原来是四档按钮）。
  // 越透就越像玻璃 —— 底色淡下去的同时把背后的模糊和饱和度顶上来，否则纯降 alpha
  // 只会变成「一块脏兮兮的半透明板」，而不是玻璃。三个量一起由 barValue 推出来。
  const BAR_KEY = 'nb-bar-alpha';
  const BAR_DEFAULT = 40;
  // 老的四档存的是字符串，迁移成等效的数值，用户的选择不会被重置
  const BAR_LEGACY = { solid: 8, medium: 40, sheer: 65, glass: 92 };
  const clampBar = (v) => {
    if (BAR_LEGACY[v] != null) return BAR_LEGACY[v];   // 老的四档名字（本机缓存和云端 prefs 里都可能还是它）
    if (v == null || v === '') return BAR_DEFAULT;         // Number(null) 是 0，会被当成实心
    const n = Number(v);
    if (!isFinite(n)) return BAR_DEFAULT;
    return Math.min(100, Math.max(0, Math.round(n)));
  };
  function barPref() {
    const raw = localStorage.getItem(BAR_KEY);
    return raw == null ? BAR_DEFAULT : clampBar(raw);
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  function applyBar(value) {
    const t = clampBar(value) / 100;
    const root = document.documentElement;
    root.dataset.bar = String(clampBar(value));
    root.style.setProperty('--nb-bar-alpha', (lerp(0.96, 0.05, t)).toFixed(3));
    root.style.setProperty('--nb-bar-blur', `${lerp(12, 34, t).toFixed(1)}px`);
    root.style.setProperty('--nb-bar-sat', (lerp(1.2, 2.1, t)).toFixed(2));
    // 玻璃感的最后一味：越透，顶缘高光越亮，边界才不会糊掉
    root.style.setProperty('--nb-bar-gloss', (lerp(0.16, 0.62, t)).toFixed(2));
    document.querySelectorAll('[data-bar-alpha]').forEach((el) => {
      if (el.value !== String(clampBar(value))) el.value = String(clampBar(value));
    });
  }
  function setBar(value, userAction = true) {
    const v = clampBar(value);
    localStorage.setItem(BAR_KEY, String(v));
    if (userAction) dirty = true;
    applyBar(v);
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
    return {
      theme: themePref(), background: backgroundPref(),
      bgOpacity: opacityPref(), bgBrightness: brightnessPref(), bar: barPref(),
    };
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
      if (remote.bgBrightness != null) setBrightness(remote.bgBrightness, false);
      if (remote.bar != null) setBar(remote.bar, false);
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
    document.querySelectorAll('[data-bg-brightness]').forEach((input) => {
      if (input.__nbBrightWired) return;
      input.__nbBrightWired = true;
      input.addEventListener('input', () => {
        const v = clampBright(input.value);
        localStorage.setItem(BRIGHT_KEY, String(v));
        dirty = true;
        document.documentElement.style.setProperty('--nb-bg-brightness', String(v));
      });
      input.addEventListener('change', () => setBrightness(input.value));
    });
    document.querySelectorAll('[data-bar-alpha]').forEach((input) => {
      if (input.__nbBarWired) return;
      input.__nbBarWired = true;
      input.addEventListener('input', () => {
        const v = clampBar(input.value);
        localStorage.setItem(BAR_KEY, String(v));
        dirty = true;
        applyBar(v);
      });
      input.addEventListener('change', () => setBar(input.value));
    });
    // 弹性滑杆：把原生 range 就地升级（slider.js），原 input 仍是数据源
    if (window.NBSlider) {
      const ic = (n) => (window.NBIcon ? NBIcon(n, { size: 14 }) : '');
      // 只在左边挂一个图标当标签（右侧图标会把杆挤窄，悬停放大时更容易顶出面板）
      document.querySelectorAll('[data-bg-opacity]').forEach((el) =>
        NBSlider.enhance(el, { left: ic('half') }));
      document.querySelectorAll('[data-bg-brightness]').forEach((el) =>
        NBSlider.enhance(el, { left: ic('sun') }));
      document.querySelectorAll('[data-bar-alpha]').forEach((el) =>
        NBSlider.enhance(el, { left: ic('stack') }));
    }
    updateThemeButtons(themePref());
    updateBackgroundButtons(backgroundPref());
    applyOpacity(opacityPref());
    applyBrightness(brightnessPref());
    applyBar(barPref());
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
  applyBrightness(brightnessPref());
  applyBar(barPref());
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
    get bgBrightness() { return brightnessPref(); },
    get bar() { return barPref(); },
    OPACITY_MIN, OPACITY_MAX, OPACITY_DEFAULT,
    BRIGHT_DEFAULT,
    apply: () => applyTheme(themePref()),
    set: setTheme,
    setBackground,
    setOpacity,
    setBrightness,
    setBar,
    sync: queuePersist,
    flush: persist,
  };
})();
