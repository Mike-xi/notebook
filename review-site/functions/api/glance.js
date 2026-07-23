const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, max-age=30',
  'X-Content-Type-Options': 'nosniff',
};

const FEEDS = {
  cloudflare: {
    title: 'Cloudflare Blog',
    url: 'https://blog.cloudflare.com/rss/',
    home: 'https://blog.cloudflare.com/',
  },
  github: {
    title: 'GitHub Blog',
    url: 'https://github.blog/feed/',
    home: 'https://github.blog/',
  },
  ithome: {
    title: 'IT之家',
    url: 'https://www.ithome.com/rss/',
    home: 'https://www.ithome.com/',
  },
  sspai: {
    title: '少数派',
    url: 'https://sspai.com/feed',
    home: 'https://sspai.com/',
  },
  solidot: {
    title: 'Solidot',
    url: 'https://www.solidot.org/index.rss',
    home: 'https://www.solidot.org/',
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

async function fetchWithTimeout(url, options = {}, timeout = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Xi-Notebook-Glance/1.0 (+https://sjtu.ccwu.cc)',
        Accept: 'application/json, application/rss+xml, application/atom+xml, text/xml, */*',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, ttl = 300) {
  const response = await fetchWithTimeout(url, {
    cf: { cacheEverything: true, cacheTtl: ttl },
  });
  if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
  return response.json();
}

async function weather(params) {
  const lat = clamp(params.get('lat'), -90, 90, 31.2304);
  const lon = clamp(params.get('lon'), -180, 180, 121.4737);
  const timezone = params.get('timezone') || 'Asia/Shanghai';
  const query = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone,
    forecast_days: '7',
    current: [
      'temperature_2m',
      'apparent_temperature',
      'is_day',
      'precipitation',
      'weather_code',
      'cloud_cover',
      'wind_speed_10m',
    ].join(','),
    hourly: [
      'temperature_2m',
      'precipitation_probability',
      'weather_code',
    ].join(','),
    daily: [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_probability_max',
      'sunrise',
      'sunset',
    ].join(','),
  });
  return fetchJson(`https://api.open-meteo.com/v1/forecast?${query}`, 600);
}

async function hackerNews(params) {
  const limit = Math.round(clamp(params.get('limit'), 5, 30, 14));
  const ids = await fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json', 120);
  const stories = await Promise.all(
    ids.slice(0, limit + 5).map((id) =>
      fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, 120)
        .catch(() => null)),
  );
  return stories
    .filter((item) => item && !item.deleted && !item.dead && item.title)
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      title: item.title,
      url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
      commentsUrl: `https://news.ycombinator.com/item?id=${item.id}`,
      score: item.score || 0,
      comments: item.descendants || 0,
      by: item.by || '',
      time: item.time ? item.time * 1000 : null,
    }));
}

async function markets() {
  const ids = 'bitcoin,ethereum,solana';
  const data = await fetchJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd,cny&include_24hr_change=true`,
    120,
  );
  const labels = {
    bitcoin: ['BTC', 'Bitcoin'],
    ethereum: ['ETH', 'Ethereum'],
    solana: ['SOL', 'Solana'],
  };
  return Object.entries(labels).map(([id, [symbol, name]]) => ({
    id,
    symbol,
    name,
    usd: data[id]?.usd ?? null,
    cny: data[id]?.cny ?? null,
    change: data[id]?.usd_24h_change ?? null,
  }));
}

function cleanRepo(value) {
  const repo = String(value || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo) ? repo : null;
}

async function github(params) {
  const requested = (params.get('repos') || 'glanceapp/glance,ourongxing/newsnow,cloudflare/workers-sdk')
    .split(',')
    .map(cleanRepo)
    .filter(Boolean)
    .slice(0, 6);

  return Promise.all(requested.map(async (repo) => {
    const headers = { Accept: 'application/vnd.github+json' };
    const [meta, release] = await Promise.all([
      fetchJson(`https://api.github.com/repos/${repo}`, 900),
      fetchWithTimeout(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers,
        cf: { cacheEverything: true, cacheTtl: 1800 },
      }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    return {
      repo,
      url: meta.html_url,
      description: meta.description || '',
      stars: meta.stargazers_count || 0,
      forks: meta.forks_count || 0,
      issues: meta.open_issues_count || 0,
      language: meta.language || '',
      pushedAt: meta.pushed_at,
      release: release ? {
        name: release.name || release.tag_name,
        tag: release.tag_name,
        url: release.html_url,
        publishedAt: release.published_at,
      } : null,
    };
  }));
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'");
}

function stripMarkup(value) {
  return decodeEntities(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTag(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
    if (match) return match[1];
  }
  return '';
}

function pickLink(block) {
  const atom = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  if (atom) return decodeEntities(atom[1]);
  return stripMarkup(pickTag(block, ['link', 'guid']));
}

function parseFeed(xml, source) {
  const blocks = [
    ...(xml.match(/<item\b[\s\S]*?<\/item>/gi) || []),
    ...(xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || []),
  ];
  return blocks.slice(0, 16).map((block, index) => {
    const rawDate = stripMarkup(pickTag(block, ['pubDate', 'published', 'updated', 'dc:date']));
    const rawDescription = pickTag(block, ['description', 'summary', 'content', 'content:encoded']);
    return {
      id: stripMarkup(pickTag(block, ['guid', 'id'])) || `${source.title}-${index}`,
      title: stripMarkup(pickTag(block, ['title'])) || 'Untitled',
      url: pickLink(block) || source.home,
      description: stripMarkup(rawDescription).slice(0, 240),
      author: stripMarkup(pickTag(block, ['author', 'dc:creator'])),
      publishedAt: rawDate && !Number.isNaN(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null,
      source: source.title,
    };
  }).filter((item) => item.url && /^https?:\/\//i.test(item.url));
}

async function feeds(params) {
  const ids = (params.get('ids') || 'ithome,sspai,cloudflare')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => FEEDS[id])
    .slice(0, 5);
  const selected = ids.length ? ids : ['ithome', 'sspai', 'cloudflare'];
  const results = await Promise.all(selected.map(async (id) => {
    const source = FEEDS[id];
    try {
      const response = await fetchWithTimeout(source.url, {
        cf: { cacheEverything: true, cacheTtl: 600 },
      }, 12000);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const xml = await response.text();
      return { id, title: source.title, home: source.home, items: parseFeed(xml, source) };
    } catch (error) {
      return { id, title: source.title, home: source.home, items: [], error: error.message };
    }
  }));
  return results;
}

function isSafeMonitorUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || (url.port && url.port !== '443')) return false;
    if (!host.includes('.') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return false;
    return true;
  } catch {
    return false;
  }
}

async function checkMonitor(item) {
  const started = Date.now();
  try {
    const response = await fetchWithTimeout(item.url, {
      method: 'GET',
      redirect: 'follow',
      cf: { cacheEverything: false },
    }, 7000);
    return {
      name: item.name,
      url: item.url,
      ok: response.status >= 200 && response.status < 500,
      status: response.status,
      latency: Date.now() - started,
    };
  } catch (error) {
    return {
      name: item.name,
      url: item.url,
      ok: false,
      status: 0,
      latency: Date.now() - started,
      error: error.name === 'AbortError' ? 'timeout' : 'unreachable',
    };
  }
}

async function monitors(items) {
  const defaults = [
    { name: 'Xi Notebook', url: 'https://sjtu.ccwu.cc/' },
    { name: 'NewsNow', url: 'https://xi-newsnow.pages.dev/' },
    { name: 'Cloudflare', url: 'https://www.cloudflarestatus.com/api/v2/status.json' },
  ];
  const chosen = Array.isArray(items) && items.length ? items : defaults;
  const safe = chosen
    .map((item) => ({
      name: String(item?.name || 'Service').trim().slice(0, 50),
      url: String(item?.url || '').trim(),
    }))
    .filter((item) => item.name && isSafeMonitorUrl(item.url))
    .slice(0, 6);
  if (!safe.length) throw new Error('No valid HTTPS monitor endpoints');
  return Promise.all(safe.map(checkMonitor));
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || '';
  try {
    if (type === 'weather') return json({ type, data: await weather(url.searchParams) });
    if (type === 'hackernews') return json({ type, data: await hackerNews(url.searchParams) });
    if (type === 'markets') return json({ type, data: await markets() });
    if (type === 'github') return json({ type, data: await github(url.searchParams) });
    if (type === 'feeds') return json({ type, data: await feeds(url.searchParams), feeds: FEEDS });
    if (type === 'monitors') return json({ type, data: await monitors(null) });
    if (type === 'catalog') {
      return json({
        type,
        feeds: Object.fromEntries(Object.entries(FEEDS).map(([id, value]) => [
          id,
          { title: value.title, home: value.home },
        ])),
      });
    }
    return json({ error: 'Unknown Glance data type' }, 400);
  } catch (error) {
    return json({ error: error?.message || 'Glance data request failed', type }, 502);
  }
}

export async function onRequestPost({ request }) {
  try {
    const body = await request.json();
    if (body?.type !== 'monitors') return json({ error: 'Unsupported operation' }, 400);
    return json({ type: 'monitors', data: await monitors(body.items) });
  } catch (error) {
    return json({ error: error?.message || 'Invalid request' }, 400);
  }
}
