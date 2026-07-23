(() => {
  'use strict';

  const CONFIG_KEY = 'xi-glance-config-v1';
  const TODO_KEY = 'xi-glance-todos-v1';
  const BOOKMARK_KEY = 'xi-glance-bookmarks-v1';
  const DEFAULT_CONFIG = {
    theme: 'dark',
    density: 'comfortable',
    hue: 42,
    hourFormat: '24',
    city: '上海',
    lat: 31.2304,
    lon: 121.4737,
    feeds: ['ithome', 'sspai', 'cloudflare'],
    repos: ['glanceapp/glance', 'ourongxing/newsnow', 'cloudflare/workers-sdk'],
    monitors: [
      { name: 'Xi Notebook', url: 'https://sjtu.ccwu.cc/' },
      { name: 'NewsNow', url: 'https://xi-newsnow.pages.dev/' },
      { name: 'Cloudflare', url: 'https://www.cloudflarestatus.com/api/v2/status.json' },
    ],
    page: 'home',
    order: {},
  };
  const DEFAULT_BOOKMARKS = [
    { id: 'sjtu', name: 'Xi Notebook', url: 'https://sjtu.ccwu.cc/', group: '学习' },
    { id: 'canvas', name: 'SJTU Canvas', url: 'https://oc.sjtu.edu.cn/', group: '学习' },
    { id: 'github', name: 'GitHub', url: 'https://github.com/', group: '开发' },
    { id: 'cloudflare', name: 'Cloudflare', url: 'https://dash.cloudflare.com/', group: '开发' },
  ];
  const FALLBACK_HN = [
    { id: 1, title: 'Hacker News 暂时无法连接，点击打开原站', url: 'https://news.ycombinator.com/', commentsUrl: 'https://news.ycombinator.com/', score: 0, comments: 0, by: 'system', time: Date.now() },
  ];
  const WEATHER_CODES = {
    0: ['晴朗', '☀'],
    1: ['大致晴朗', '◒'],
    2: ['局部多云', '◑'],
    3: ['阴天', '☁'],
    45: ['有雾', '≋'],
    48: ['雾凇', '≋'],
    51: ['细雨', '♧'],
    53: ['细雨', '♧'],
    55: ['较强细雨', '♧'],
    61: ['小雨', '☂'],
    63: ['中雨', '☂'],
    65: ['大雨', '☂'],
    71: ['小雪', '✣'],
    73: ['中雪', '✣'],
    75: ['大雪', '✣'],
    80: ['阵雨', '☂'],
    81: ['阵雨', '☂'],
    82: ['强阵雨', '☂'],
    85: ['阵雪', '✣'],
    86: ['强阵雪', '✣'],
    95: ['雷暴', 'ϟ'],
    96: ['雷暴伴冰雹', 'ϟ'],
    99: ['强雷暴', 'ϟ'],
  };

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  let config = loadConfig();
  let feedData = [];
  let activeFeed = config.feeds[0] || 'ithome';
  let hnExpanded = false;
  let refreshSequence = 0;
  let toastTimer = 0;
  let draggedWidget = null;

  function loadConfig() {
    try {
      const stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
      return normalizeConfig({ ...DEFAULT_CONFIG, ...stored });
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  function normalizeConfig(value) {
    const next = { ...DEFAULT_CONFIG, ...value };
    next.theme = ['dark', 'light', 'auto'].includes(next.theme) ? next.theme : 'dark';
    next.density = ['comfortable', 'compact'].includes(next.density) ? next.density : 'comfortable';
    next.hourFormat = String(next.hourFormat) === '12' ? '12' : '24';
    next.hue = Math.min(240, Math.max(25, Number(next.hue) || 42));
    next.city = String(next.city || '上海').slice(0, 30);
    next.lat = Math.min(90, Math.max(-90, Number(next.lat) || 31.2304));
    next.lon = Math.min(180, Math.max(-180, Number(next.lon) || 121.4737));
    next.feeds = Array.isArray(next.feeds) && next.feeds.length ? next.feeds.slice(0, 5) : [...DEFAULT_CONFIG.feeds];
    next.repos = Array.isArray(next.repos) && next.repos.length ? next.repos.slice(0, 6) : [...DEFAULT_CONFIG.repos];
    next.monitors = Array.isArray(next.monitors) && next.monitors.length
      ? next.monitors.slice(0, 6)
      : structuredClone(DEFAULT_CONFIG.monitors);
    next.page = ['home', 'news', 'dev'].includes(next.page) ? next.page : 'home';
    next.order = next.order && typeof next.order === 'object' ? next.order : {};
    return next;
  }

  function saveConfig() {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }

  function safeUrl(value, fallback = '#') {
    try {
      const url = new URL(value, location.href);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : fallback;
    } catch {
      return fallback;
    }
  }

  function hostname(value) {
    try {
      return new URL(value).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function formatNumber(value) {
    const number = Number(value) || 0;
    return new Intl.NumberFormat('zh-CN', {
      notation: number >= 10000 ? 'compact' : 'standard',
      maximumFractionDigits: 1,
    }).format(number);
  }

  function relativeTime(value) {
    if (!value) return '刚刚';
    const time = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(time)) return '';
    const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
    if (seconds < 60) return '刚刚';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)} 天前`;
    return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(time));
  }

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function applyAppearance() {
    const dark = config.theme === 'auto'
      ? matchMedia('(prefers-color-scheme: dark)').matches
      : config.theme === 'dark';
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.density = config.density;
    root.style.setProperty('--hue', String(config.hue));
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111114' : '#f4f2ec');
  }

  function updateClock() {
    const now = new Date();
    const hour12 = config.hourFormat === '12';
    $('top-clock').textContent = new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12,
    }).format(now);
    const hour = now.getHours();
    const greeting = hour < 6 ? '夜深了' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
    $('greeting').textContent = `${greeting} · ${new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(now)}`;
  }

  function renderCalendar() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const first = new Date(year, month, 1);
    const mondayOffset = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - mondayOffset);
    const weekNumber = Math.ceil((((now - new Date(year, 0, 1)) / 86400000) + new Date(year, 0, 1).getDay() + 1) / 7);
    $('calendar-month').textContent = `${year} 年 ${month + 1} 月`;
    $('calendar-week').textContent = `第 ${weekNumber} 周`;
    const headings = ['一', '二', '三', '四', '五', '六', '日']
      .map((day) => `<span class="calendar-cell heading">${day}</span>`)
      .join('');
    const cells = [];
    for (let index = 0; index < 42; index += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const outside = date.getMonth() !== month;
      const today = date.toDateString() === now.toDateString();
      cells.push(`<span class="calendar-cell${outside ? ' outside' : ''}${today ? ' today' : ''}"${today ? ' aria-current="date"' : ''}>${date.getDate()}</span>`);
    }
    $('calendar-grid').innerHTML = headings + cells.join('');
  }

  async function api(query, options) {
    const response = await fetch(`/api/glance${query}`, {
      credentials: 'same-origin',
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options?.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body.data;
  }

  function renderWeather(data) {
    const current = data?.current;
    if (!current) throw new Error('天气数据为空');
    const [condition, glyph] = WEATHER_CODES[current.weather_code] || ['天气变化中', '◌'];
    $('weather-place').textContent = config.city;
    $('weather-temp').textContent = `${Math.round(current.temperature_2m)}°`;
    $('weather-condition').textContent = condition;
    $('weather-feels').textContent = `体感 ${Math.round(current.apparent_temperature)}°`;
    $('weather-glyph').textContent = glyph;

    const times = data.hourly?.time || [];
    let start = Math.max(0, times.findIndex((time) => time >= current.time));
    if (start < 0) start = 0;
    const values = (data.hourly?.temperature_2m || []).slice(start, start + 10);
    const labels = times.slice(start, start + 10);
    const min = Math.min(...values);
    const max = Math.max(...values);
    $('hourly-chart').innerHTML = values.map((value, index) => {
      const height = 15 + ((value - min) / Math.max(1, max - min)) * 32;
      const hour = String(labels[index] || '').slice(11, 13);
      return `<div class="hour-bar-wrap" title="${escapeHTML(value)}°"><i class="hour-bar" style="height:${height}px"></i><span>${index % 3 === 0 ? `${hour}时` : ''}</span></div>`;
    }).join('');
    $('weather-facts').innerHTML = [
      [`${Math.round(current.wind_speed_10m)} km/h`, '风速'],
      [`${Math.round(current.cloud_cover)}%`, '云量'],
      [`${Math.round(data.daily?.precipitation_probability_max?.[0] || 0)}%`, '降水'],
    ].map(([value, label]) => `<div class="weather-fact"><strong>${value}</strong><span>${label}</span></div>`).join('');
  }

  function renderWeatherError() {
    $('weather-condition').textContent = '天气服务暂时不可用';
    $('weather-feels').textContent = '稍后刷新重试';
    $('weather-glyph').textContent = '—';
    $('hourly-chart').innerHTML = '';
    $('weather-facts').innerHTML = '';
  }

  function renderHackerNews(items) {
    const stories = items?.length ? items : FALLBACK_HN;
    $('hn-list').innerHTML = stories.map((story, index) => {
      const target = safeUrl(story.url, story.commentsUrl);
      const domain = hostname(target);
      return `<li class="story-item"${!hnExpanded && index >= 7 ? ' hidden' : ''}>
        <a class="story-title" href="${escapeHTML(target)}" target="_blank" rel="noopener">${escapeHTML(story.title)}</a>
        ${domain ? `<span class="story-domain">${escapeHTML(domain)} ↗</span>` : ''}
        <div class="story-meta">
          <span>${relativeTime(story.time)}</span>
          <span>· ${formatNumber(story.score)} points</span>
          <a href="${escapeHTML(safeUrl(story.commentsUrl))}" target="_blank" rel="noopener">· ${formatNumber(story.comments)} comments</a>
        </div>
      </li>`;
    }).join('');
    $('hn-more').hidden = stories.length <= 7;
    $('hn-more').innerHTML = hnExpanded ? '收起 <span>⌃</span>' : '显示更多 <span>⌄</span>';
  }

  function seededLine(seed) {
    let value = 48;
    const points = [];
    for (let index = 0; index < 14; index += 1) {
      const code = seed.charCodeAt(index % seed.length);
      value = Math.min(90, Math.max(10, value + ((code * (index + 3)) % 17) - 8));
      points.push(`${index * 7.7},${100 - value}`);
    }
    return points.join(' ');
  }

  function renderMarkets(items) {
    if (!items?.length) {
      $('market-list').innerHTML = '<div class="error-state">市场数据暂时不可用</div>';
      return;
    }
    $('market-list').innerHTML = items.map((item) => {
      const change = Number(item.change);
      const direction = change >= 0 ? 'positive' : 'negative';
      const price = Number(item.usd);
      return `<div class="market-row">
        <div><span class="market-symbol">${escapeHTML(item.symbol)}</span><span class="market-name">${escapeHTML(item.name)}</span></div>
        <svg class="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M ${seededLine(item.id).replaceAll(' ', ' L ')}"/></svg>
        <div class="market-price"><span>$${Number.isFinite(price) ? price.toLocaleString('en-US', { maximumFractionDigits: price < 100 ? 2 : 0 }) : '—'}</span><small class="market-change ${direction}">${Number.isFinite(change) ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '—'}</small></div>
      </div>`;
    }).join('');
  }

  function renderGithub(items) {
    if (!items?.length) {
      $('release-list').innerHTML = '<div class="error-state">GitHub 数据暂时不可用</div>';
      $('repo-list').innerHTML = '<div class="error-state">无法读取仓库</div>';
      return;
    }
    $('release-list').innerHTML = items.map((item) => {
      const release = item.release;
      return `<a class="release-card" href="${escapeHTML(safeUrl(release?.url || item.url))}" target="_blank" rel="noopener">
        <div class="release-name"><span>${escapeHTML(item.repo)}</span><svg><use href="#i-external"/></svg></div>
        <p>${escapeHTML(item.description || '暂无仓库简介')}</p>
        <div class="release-meta">
          ${release ? `<span>${escapeHTML(release.tag || release.name)}</span><span>· ${relativeTime(release.publishedAt)}</span>` : '<span>暂无正式发布</span>'}
          <span>· ★ ${formatNumber(item.stars)}</span>
        </div>
      </a>`;
    }).join('');
    $('repo-list').innerHTML = items.map((item) => `<a class="repo-row" href="${escapeHTML(safeUrl(item.url))}" target="_blank" rel="noopener">
      <strong>${escapeHTML(item.repo)}</strong>
      <span>★ ${formatNumber(item.stars)} · fork ${formatNumber(item.forks)} · ${escapeHTML(item.language || 'Mixed')}</span>
    </a>`).join('');
  }

  function renderFeeds(groups) {
    feedData = Array.isArray(groups) ? groups : [];
    if (!feedData.some((group) => group.id === activeFeed)) activeFeed = feedData[0]?.id || '';
    $('feed-tabs').innerHTML = feedData.map((group) =>
      `<button class="subtab${group.id === activeFeed ? ' active' : ''}" type="button" data-feed="${escapeHTML(group.id)}">${escapeHTML(group.title)}</button>`,
    ).join('');
    const group = feedData.find((item) => item.id === activeFeed);
    if (!group?.items?.length) {
      $('feed-list').innerHTML = `<div class="${group?.error ? 'error-state' : 'empty-state'}">${group?.error ? '这个来源暂时连接失败' : '这个来源暂无内容'}</div>`;
    } else {
      $('feed-list').innerHTML = group.items.slice(0, 7).map((item) =>
        `<a class="feed-item" href="${escapeHTML(safeUrl(item.url, group.home))}" target="_blank" rel="noopener">
          <strong>${escapeHTML(item.title)}</strong>
          <span class="feed-meta">${relativeTime(item.publishedAt)}${item.author ? ` · ${escapeHTML(item.author)}` : ''}</span>
        </a>`,
      ).join('');
    }
    renderLatestFeed();
  }

  function renderLatestFeed() {
    const combined = feedData
      .flatMap((group) => (group.items || []).map((item) => ({ ...item, source: group.title })))
      .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))
      .slice(0, 18);
    $('latest-feed').innerHTML = combined.length
      ? combined.map((item) => `<div class="latest-item">
          <span class="latest-source">${escapeHTML(item.source)}<br>${relativeTime(item.publishedAt)}</span>
          <a href="${escapeHTML(safeUrl(item.url))}" target="_blank" rel="noopener">${escapeHTML(item.title)}</a>
        </div>`).join('')
      : '<div class="empty-state">暂无可显示的资讯</div>';
  }

  function renderMonitors(items) {
    if (!items?.length) {
      $('monitor-list').innerHTML = '<div class="error-state">监控端点暂时不可用</div>';
      return;
    }
    $('monitor-list').innerHTML = items.map((item) => `<a class="monitor-row" href="${escapeHTML(safeUrl(item.url))}" target="_blank" rel="noopener">
      <i class="status-dot ${item.ok ? 'ok' : 'down'}"></i>
      <span class="monitor-name">${escapeHTML(item.name)}</span>
      <span class="monitor-latency">${item.ok ? `${item.latency} ms` : (item.error || `HTTP ${item.status}`)}</span>
    </a>`).join('');
  }

  async function loadMonitors() {
    return api('', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'monitors', items: config.monitors }),
    });
  }

  async function refreshData({ notify = false } = {}) {
    const sequence = ++refreshSequence;
    $('refresh-button').classList.add('loading');
    const requests = [
      api(`?type=weather&lat=${encodeURIComponent(config.lat)}&lon=${encodeURIComponent(config.lon)}&timezone=Asia%2FShanghai`),
      api('?type=hackernews&limit=16'),
      api('?type=markets'),
      api(`?type=github&repos=${encodeURIComponent(config.repos.join(','))}`),
      api(`?type=feeds&ids=${encodeURIComponent(config.feeds.join(','))}`),
      loadMonitors(),
    ];
    const results = await Promise.allSettled(requests);
    if (sequence !== refreshSequence) return;
    const [weatherResult, hnResult, marketResult, githubResult, feedResult, monitorResult] = results;
    weatherResult.status === 'fulfilled' ? renderWeather(weatherResult.value) : renderWeatherError();
    renderHackerNews(hnResult.status === 'fulfilled' ? hnResult.value : FALLBACK_HN);
    renderMarkets(marketResult.status === 'fulfilled' ? marketResult.value : []);
    renderGithub(githubResult.status === 'fulfilled' ? githubResult.value : []);
    renderFeeds(feedResult.status === 'fulfilled' ? feedResult.value : []);
    renderMonitors(monitorResult.status === 'fulfilled' ? monitorResult.value : []);
    $('refresh-button').classList.remove('loading');
    if (notify) {
      const failed = results.filter((result) => result.status === 'rejected').length;
      showToast(failed ? `刷新完成，${failed} 个数据源暂时不可用` : '所有数据已刷新');
    }
  }

  function loadBookmarks() {
    try {
      const stored = JSON.parse(localStorage.getItem(BOOKMARK_KEY) || 'null');
      return Array.isArray(stored) ? stored : structuredClone(DEFAULT_BOOKMARKS);
    } catch {
      return structuredClone(DEFAULT_BOOKMARKS);
    }
  }

  function saveBookmarks(items) {
    localStorage.setItem(BOOKMARK_KEY, JSON.stringify(items));
  }

  function renderBookmarks() {
    const items = loadBookmarks();
    const groups = Map.groupBy ? Map.groupBy(items, (item) => item.group || '我的书签') : items.reduce((map, item) => {
      const key = item.group || '我的书签';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
      return map;
    }, new Map());
    $('bookmark-list').innerHTML = items.length
      ? Array.from(groups.entries()).map(([group, links]) => `<div class="bookmark-group">
          <p class="bookmark-group-title">${escapeHTML(group)}</p>
          ${links.map((item) => `<a class="bookmark-link" href="${escapeHTML(safeUrl(item.url))}" target="_blank" rel="noopener" data-bookmark="${escapeHTML(item.id)}">
            <span class="bookmark-icon">${escapeHTML(item.name.slice(0, 1))}</span>
            <span>${escapeHTML(item.name)}</span>
            <button class="remove-bookmark" type="button" data-remove-bookmark="${escapeHTML(item.id)}" aria-label="删除 ${escapeHTML(item.name)}">×</button>
          </a>`).join('')}
        </div>`).join('')
      : '<div class="empty-state">还没有书签，点“添加”创建一个。</div>';
  }

  function loadTodos() {
    try {
      const stored = JSON.parse(localStorage.getItem(TODO_KEY) || '[]');
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  }

  function saveTodos(items) {
    localStorage.setItem(TODO_KEY, JSON.stringify(items));
  }

  function renderTodos() {
    const items = loadTodos();
    const open = items.filter((item) => !item.done).length;
    $('todo-count').textContent = `${open} 项未完成`;
    $('todo-list').innerHTML = items.length
      ? items.map((item) => `<li class="todo-item${item.done ? ' done' : ''}" data-todo="${escapeHTML(item.id)}">
          <button class="todo-toggle" type="button" data-toggle-todo="${escapeHTML(item.id)}" aria-label="${item.done ? '标记未完成' : '标记完成'}"><svg><use href="#i-check"/></svg></button>
          <span class="todo-text">${escapeHTML(item.text)}</span>
          <button class="todo-delete" type="button" data-delete-todo="${escapeHTML(item.id)}" aria-label="删除待办">×</button>
        </li>`).join('')
      : '<li class="empty-state">清单是空的，今天可以从容一点。</li>';
  }

  function setPage(page, persist = true) {
    const current = ['home', 'news', 'dev'].includes(page) ? page : 'home';
    document.querySelectorAll('.page-tab').forEach((button) => {
      const active = button.dataset.page === current;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    document.querySelectorAll('[data-pages]').forEach((element) => {
      element.hidden = !element.dataset.pages.split(',').includes(current);
    });
    if (persist) {
      config.page = current;
      saveConfig();
    }
    window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  function applyWidgetOrder() {
    for (const [columnName, ids] of Object.entries(config.order || {})) {
      const column = document.querySelector(`[data-column="${CSS.escape(columnName)}"]`);
      if (!column || !Array.isArray(ids)) continue;
      ids.forEach((id) => {
        const widget = document.querySelector(`[data-widget="${CSS.escape(id)}"]`);
        if (widget) column.append(widget);
      });
    }
  }

  function saveWidgetOrder() {
    config.order = {};
    document.querySelectorAll('[data-column]').forEach((column) => {
      config.order[column.dataset.column] = Array.from(column.querySelectorAll(':scope > [data-widget]'))
        .map((widget) => widget.dataset.widget);
    });
    saveConfig();
  }

  function setupDragAndDrop() {
    document.querySelectorAll('[data-widget]').forEach((widget) => {
      widget.draggable = true;
      widget.addEventListener('dragstart', (event) => {
        if (!event.target.closest('.drag-handle')) {
          event.preventDefault();
          return;
        }
        draggedWidget = widget;
        widget.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', widget.dataset.widget);
      });
      widget.addEventListener('dragend', () => {
        widget.classList.remove('dragging');
        document.querySelectorAll('.drag-over').forEach((item) => item.classList.remove('drag-over'));
        draggedWidget = null;
        saveWidgetOrder();
      });
    });
    document.querySelectorAll('[data-column]').forEach((column) => {
      column.addEventListener('dragover', (event) => {
        if (!draggedWidget) return;
        event.preventDefault();
        const target = event.target.closest('[data-widget]');
        document.querySelectorAll('.drag-over').forEach((item) => item.classList.remove('drag-over'));
        if (!target || target === draggedWidget || target.hidden) {
          column.append(draggedWidget);
          return;
        }
        target.classList.add('drag-over');
        const box = target.getBoundingClientRect();
        const after = event.clientY > box.top + box.height / 2;
        column.insertBefore(draggedWidget, after ? target.nextSibling : target);
      });
      column.addEventListener('drop', (event) => {
        event.preventDefault();
        document.querySelectorAll('.drag-over').forEach((item) => item.classList.remove('drag-over'));
        saveWidgetOrder();
      });
    });
  }

  function populateSettings() {
    $('setting-theme').value = config.theme;
    $('setting-density').value = config.density;
    $('setting-hue').value = String(config.hue);
    $('setting-hour-format').value = config.hourFormat;
    $('setting-city').value = config.city;
    $('setting-lat').value = String(config.lat);
    $('setting-lon').value = String(config.lon);
    document.querySelectorAll('#feed-options input[name="feeds"]').forEach((input) => {
      input.checked = config.feeds.includes(input.value);
    });
    $('setting-repos').value = config.repos.join('\n');
    $('setting-monitors').value = config.monitors.map((item) => `${item.name} | ${item.url}`).join('\n');
  }

  function parseMonitorLines(value) {
    return String(value || '').split(/\r?\n/).map((line) => {
      const [name, ...urlParts] = line.split('|');
      return { name: name?.trim(), url: urlParts.join('|').trim() };
    }).filter((item) => item.name && safeUrl(item.url, '')).slice(0, 6);
  }

  function readSettings() {
    const feeds = Array.from(document.querySelectorAll('#feed-options input[name="feeds"]:checked')).map((input) => input.value);
    const repos = $('setting-repos').value.split(/\r?\n|,/).map((repo) => repo.trim())
      .filter((repo) => /^[\w.-]+\/[\w.-]+$/.test(repo)).slice(0, 6);
    const monitors = parseMonitorLines($('setting-monitors').value);
    return normalizeConfig({
      ...config,
      theme: $('setting-theme').value,
      density: $('setting-density').value,
      hue: Number($('setting-hue').value),
      hourFormat: $('setting-hour-format').value,
      city: $('setting-city').value.trim(),
      lat: Number($('setting-lat').value),
      lon: Number($('setting-lon').value),
      feeds: feeds.length ? feeds : [...DEFAULT_CONFIG.feeds],
      repos: repos.length ? repos : [...DEFAULT_CONFIG.repos],
      monitors: monitors.length ? monitors : structuredClone(DEFAULT_CONFIG.monitors),
    });
  }

  function exportConfig() {
    const payload = {
      product: 'Xi Notebook · Glance',
      version: 1,
      exportedAt: new Date().toISOString(),
      config,
      bookmarks: loadBookmarks(),
      todos: loadTodos(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `xi-glance-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showToast('配置已导出');
  }

  async function importConfig(file) {
    if (!file || file.size > 200000) throw new Error('配置文件无效或过大');
    const payload = JSON.parse(await file.text());
    if (payload.product !== 'Xi Notebook · Glance' || payload.version !== 1) throw new Error('这不是有效的一瞥配置');
    config = normalizeConfig(payload.config || {});
    if (Array.isArray(payload.bookmarks)) saveBookmarks(payload.bookmarks.slice(0, 100));
    if (Array.isArray(payload.todos)) saveTodos(payload.todos.slice(0, 200));
    saveConfig();
    location.reload();
  }

  function handleSearch(query) {
    const raw = query.trim();
    if (!raw) return;
    const shortcuts = {
      '!gh': 'https://github.com/search?q=',
      '!yt': 'https://www.youtube.com/results?search_query=',
      '!b': 'https://www.bing.com/search?q=',
      '!g': 'https://www.google.com/search?q=',
      '!wiki': 'https://zh.wikipedia.org/w/index.php?search=',
    };
    const [bang, ...rest] = raw.split(/\s+/);
    if (shortcuts[bang.toLowerCase()] && rest.length) {
      open(shortcuts[bang.toLowerCase()] + encodeURIComponent(rest.join(' ')), '_blank', 'noopener');
    } else if (/^https?:\/\//i.test(raw)) {
      open(safeUrl(raw), '_blank', 'noopener');
    } else {
      open(`https://www.bing.com/search?q=${encodeURIComponent(raw)}`, '_blank', 'noopener');
    }
  }

  function bindEvents() {
    document.querySelector('.page-tabs').addEventListener('click', (event) => {
      const tab = event.target.closest('[data-page]');
      if (tab) setPage(tab.dataset.page);
    });
    $('refresh-button').addEventListener('click', () => refreshData({ notify: true }));
    $('hn-more').addEventListener('click', () => {
      hnExpanded = !hnExpanded;
      document.querySelectorAll('#hn-list .story-item').forEach((item, index) => {
        item.hidden = !hnExpanded && index >= 7;
      });
      $('hn-more').innerHTML = hnExpanded ? '收起 <span>⌃</span>' : '显示更多 <span>⌄</span>';
    });
    $('feed-tabs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-feed]');
      if (!button) return;
      activeFeed = button.dataset.feed;
      renderFeeds(feedData);
    });
    document.addEventListener('click', (event) => {
      const cycle = event.target.closest('[data-action="cycle-feed"]');
      if (cycle && feedData.length) {
        const index = feedData.findIndex((group) => group.id === activeFeed);
        activeFeed = feedData[(index + 1) % feedData.length].id;
        renderFeeds(feedData);
      }
      if (event.target.closest('[data-action="add-bookmark"]')) {
        $('bookmark-name').value = '';
        $('bookmark-url').value = '';
        $('bookmark-dialog').showModal();
      }
      const removeBookmark = event.target.closest('[data-remove-bookmark]');
      if (removeBookmark) {
        event.preventDefault();
        const next = loadBookmarks().filter((item) => item.id !== removeBookmark.dataset.removeBookmark);
        saveBookmarks(next);
        renderBookmarks();
      }
      const toggleTodo = event.target.closest('[data-toggle-todo]');
      if (toggleTodo) {
        const items = loadTodos().map((item) => item.id === toggleTodo.dataset.toggleTodo ? { ...item, done: !item.done } : item);
        saveTodos(items);
        renderTodos();
      }
      const deleteTodo = event.target.closest('[data-delete-todo]');
      if (deleteTodo) {
        saveTodos(loadTodos().filter((item) => item.id !== deleteTodo.dataset.deleteTodo));
        renderTodos();
      }
    });
    $('search-form').addEventListener('submit', (event) => {
      event.preventDefault();
      handleSearch($('search-input').value);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey
          && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) {
        event.preventDefault();
        $('search-input').focus();
      }
    });
    $('todo-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const text = $('todo-input').value.trim();
      if (!text) return;
      const items = loadTodos();
      items.unshift({ id: `t-${Date.now().toString(36)}`, text, done: false, createdAt: Date.now() });
      saveTodos(items);
      $('todo-input').value = '';
      renderTodos();
    });
    $('bookmark-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const name = $('bookmark-name').value.trim();
      const url = safeUrl($('bookmark-url').value, '');
      if (!name || !url) {
        showToast('请填写有效名称和网址');
        return;
      }
      const items = loadBookmarks();
      items.push({ id: `b-${Date.now().toString(36)}`, name, url, group: '我的书签' });
      saveBookmarks(items);
      renderBookmarks();
      $('bookmark-dialog').close();
      showToast('书签已添加');
    });
    $('settings-button').addEventListener('click', () => {
      populateSettings();
      $('settings-dialog').showModal();
    });
    $('setting-hue').addEventListener('input', (event) => root.style.setProperty('--hue', event.target.value));
    $('settings-dialog').addEventListener('close', () => applyAppearance());
    $('settings-form').addEventListener('submit', (event) => {
      if (event.submitter?.value === 'cancel') return;
      event.preventDefault();
      config = readSettings();
      saveConfig();
      applyAppearance();
      updateClock();
      $('settings-dialog').close();
      refreshData({ notify: true });
    });
    $('export-button').addEventListener('click', exportConfig);
    $('import-input').addEventListener('change', async (event) => {
      try {
        await importConfig(event.target.files?.[0]);
      } catch (error) {
        showToast(error.message || '导入失败');
        event.target.value = '';
      }
    });
    $('reset-button').addEventListener('click', () => {
      if (!confirm('恢复默认布局、来源、书签和待办？此操作不可撤销。')) return;
      localStorage.removeItem(CONFIG_KEY);
      localStorage.removeItem(BOOKMARK_KEY);
      localStorage.removeItem(TODO_KEY);
      location.reload();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (config.theme === 'auto') applyAppearance();
    });
  }

  function init() {
    applyAppearance();
    applyWidgetOrder();
    renderCalendar();
    renderBookmarks();
    renderTodos();
    setPage(config.page, false);
    updateClock();
    setInterval(updateClock, 30000);
    bindEvents();
    setupDragAndDrop();
    refreshData();
  }

  init();
})();
