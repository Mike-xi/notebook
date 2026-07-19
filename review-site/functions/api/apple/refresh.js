// POST /api/apple/refresh —— 从 Apple 中国官网与太平洋电脑网同步真实公开价格。
// 鉴权：X-API-Key（定时任务）或管理员 Cookie。
// 任一分类失败时保留旧数据；所有数据源都失败时不推进“最近刷新”时间。
import { ensureAppleSchema, recordApplePrice, ensurePrefsSchema } from '../../_lib/db.js';
import { getRole } from '../../_lib/auth.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const APPLE_BASE = 'https://www.apple.com.cn';
const APPLE_CATS = [
  { category: 'iphone', label: 'iPhone', url: `${APPLE_BASE}/shop/buy-iphone` },
  { category: 'ipad', label: 'iPad', url: `${APPLE_BASE}/shop/buy-ipad` },
  { category: 'mac', label: 'Mac', url: `${APPLE_BASE}/shop/buy-mac` },
  { category: 'watch', label: 'Apple Watch', url: `${APPLE_BASE}/shop/buy-watch` },
];
const PC_CATS = [
  { category: 'iphone', slug: 'mobile', label: 'iPhone' },
  { category: 'mac', slug: 'notebook', label: 'Mac' },
  { category: 'watch', slug: 'smartwatch', label: 'Apple Watch' },
];
const SOURCE_LABELS = { 'apple-cn': 'Apple 中国官网', pconline: '太平洋电脑网' };
const PC_RE = /<a\s+href="([^"]*?(\d+)_price\.html)"\s+title="苹果([^"]+?)报价"[^>]*>￥(\d+)<\/a>/g;

function decodeEntities(value) {
  const named = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ''; } })
    .replace(/&(nbsp|amp|quot|apos|lt|gt);/gi, (_, n) => named[n.toLowerCase()] || '');
}
function textOnly(value) {
  return decodeEntities(String(value || '').replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/[\s\u00a0]+/g, ' ').trim();
}
function visibleText(html) {
  return textOnly(String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' '));
}
function cleanOfficialName(value) { return textOnly(value).replace(/^新款\s+/i, '').slice(0, 100); }
function toAbsoluteAppleUrl(value) {
  try {
    const url = new URL(decodeEntities(value), APPLE_BASE);
    return url.protocol === 'https:' && (url.hostname === 'apple.com.cn' || url.hostname.endsWith('.apple.com.cn')) ? url.href : '';
  } catch { return ''; }
}
async function fetchHtml(url) {
  const resp = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

// Apple Store 主商品卡片中的人民币起售价（服务端 HTML）。
export function parseOfficialCards(html) {
  const chunks = String(html || '').split(/<div\s+class="[^"]*\brf-hcard\s+[^"]*"/i).slice(1);
  const rows = [], seen = new Set();
  for (const raw of chunks) {
    const chunk = raw.slice(0, 14000);
    const title = chunk.match(/<div\s+class="rf-hcard-content-title"[^>]*>([\s\S]*?)<\/div>/i);
    const priceMatch = chunk.match(/class="[^"]*rf-hcard-scrim-price[^"]*"[^>]*>[\s\S]{0,500}?RMB\s*([\d,]+)/i);
    const hrefMatch = chunk.match(/<a\s+href="([^"]+)"/i);
    if (!title || !priceMatch || !hrefMatch) continue;
    const name = cleanOfficialName(title[1]);
    const price = parseInt(priceMatch[1].replace(/,/g, ''), 10);
    const url = toAbsoluteAppleUrl(hrefMatch[1]);
    const key = name.toLowerCase();
    if (!name || !url || !Number.isFinite(price) || price < 100 || seen.has(key)) continue;
    seen.add(key); rows.push({ name, price, url });
  }
  return rows;
}

// AirPods 从产品总览中的“购买”链接自动发现当前在售型号。
export function discoverAirPodsLinks(html) {
  const links = [], seen = new Set();
  const tags = String(html || '').match(/<a\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const href = tag.match(/href="([^"]+)"/i);
    const aria = tag.match(/aria-label="购买(?:，|,)\s*([^"]+)"/i);
    if (!href || !aria || !/buy_airpods/i.test(href[1])) continue;
    const name = cleanOfficialName(aria[1]), url = toAbsoluteAppleUrl(href[1]), key = name.toLowerCase();
    if (!/^AirPods(?:\s|$)/i.test(name) || !url || seen.has(key)) continue;
    seen.add(key); links.push({ name, url });
  }
  return links;
}
export function extractPriceForName(html, modelName) {
  const text = visibleText(html), name = cleanOfficialName(modelName);
  let pos = 0, bestPrice = 0, bestDistance = Infinity;
  while ((pos = text.indexOf(name, pos)) !== -1) {
    const match = text.slice(pos + name.length, pos + name.length + 420).match(/RMB\s*([\d,]+)/i);
    if (match) {
      const price = parseInt(match[1].replace(/,/g, ''), 10);
      // 完整型号后距离最近的价格最可信，可避免降噪版误关联到普通版价格。
      if (Number.isFinite(price) && price >= 300 && price < 100000 && match.index < bestDistance) {
        bestPrice = price;
        bestDistance = match.index;
      }
    }
    pos += name.length;
  }
  return bestPrice;
}
async function scrapeAppleCategory(cat) {
  const rows = parseOfficialCards(await fetchHtml(cat.url));
  if (!rows.length) throw new Error('0 命中（页面结构可能已变化）');
  return { source: 'apple-cn', category: cat.category, label: cat.label, rows, sortBase: 0 };
}
async function scrapeAirPods() {
  const links = discoverAirPodsLinks(await fetchHtml(`${APPLE_BASE}/airpods/`));
  if (!links.length) throw new Error('未发现官方购买链接');
  const settled = await Promise.allSettled(links.map(async (item) => {
    const price = extractPriceForName(await fetchHtml(item.url), item.name);
    if (!price) throw new Error(`${item.name}: 未找到价格`);
    return { ...item, price };
  }));
  const rows = [], errors = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'fulfilled') rows.push(result.value);
    else errors.push(`${links[i].name}: ${result.reason?.message || '抓取失败'}`);
  }
  if (!rows.length) throw new Error(errors.join('；') || '0 命中');
  return { source: 'apple-cn', category: 'airpods', label: 'AirPods', rows, sortBase: 0, errors };
}

export async function collectOfficialBatches() {
  const jobs = [
    ...APPLE_CATS.map((cat) => ({ name: cat.category, run: () => scrapeAppleCategory(cat) })),
    { name: 'airpods', run: scrapeAirPods },
  ];
  const settled = await Promise.allSettled(jobs.map((job) => job.run()));
  const batches = [], errors = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'fulfilled') batches.push(result.value);
    else errors.push(`${jobs[i].name}: ${result.reason?.message || '抓取失败'}`);
  }
  return { batches, errors };
}

function validateOfficialBatches(value) {
  if (!Array.isArray(value) || value.length !== 5) throw new Error('official 数据必须完整包含 5 个分类');
  const labels = new Map([...APPLE_CATS.map((cat) => [cat.category, cat.label]), ['airpods', 'AirPods']]);
  const seenCategories = new Set();
  return value.map((batch) => {
    const category = String(batch?.category || '');
    if (!labels.has(category) || seenCategories.has(category)) throw new Error(`official 分类无效：${category || '空'}`);
    if (!Array.isArray(batch.rows) || !batch.rows.length || batch.rows.length > 100) throw new Error(`official/${category} 产品列表无效`);
    seenCategories.add(category);
    const seenNames = new Set();
    const rows = batch.rows.map((row) => {
      const name = cleanOfficialName(row?.name);
      const price = Math.round(Number(row?.price));
      const url = toAbsoluteAppleUrl(row?.url);
      const key = name.toLowerCase();
      if (!name || seenNames.has(key) || !Number.isFinite(price) || price < 100 || price >= 1000000 || !url) {
        throw new Error(`official/${category} 含无效产品`);
      }
      seenNames.add(key);
      return { name, price, url };
    });
    return { source: 'apple-cn', category, label: labels.get(category), rows, sortBase: 0 };
  });
}

async function readOfficialPayload(request) {
  if (!/application\/json/i.test(request.headers.get('Content-Type') || '')) return null;
  let body;
  try { body = await request.json(); } catch { throw new Error('JSON 请求体无效'); }
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'official')) return null;
  return validateOfficialBatches(body.official);
}
async function scrapePConline(cat) {
  const resp = await fetch(`https://product.pconline.com.cn/${cat.slug}/apple/`, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  let html;
  try { html = new TextDecoder('gb18030').decode(buf); } catch { html = new TextDecoder('utf-8').decode(buf); }
  const rows = [], seen = new Set();
  let match; PC_RE.lastIndex = 0;
  while ((match = PC_RE.exec(html)) !== null) {
    const url = match[1].startsWith('//') ? `https:${match[1]}` : match[1];
    const name = match[3].trim().replace(/\s+/g, ' '), price = parseInt(match[4], 10), key = name.toLowerCase();
    if (!name || !Number.isFinite(price) || price <= 0 || seen.has(key)) continue;
    seen.add(key); rows.push({ name, price, url });
  }
  if (!rows.length) throw new Error('0 命中（页面结构可能已变化）');
  return { source: 'pconline', category: cat.category, label: cat.label, rows, sortBase: 1000 };
}

async function syncBatch(env, batch, now, report) {
  const seenNames = batch.rows.map((row) => row.name);
  let saved = 0;
  for (let i = 0; i < batch.rows.length; i++) {
    const row = batch.rows[i];
    const existing = await env.DB.prepare('SELECT source, price FROM apple_products WHERE name = ?').bind(row.name).first();
    const canWrite = !existing
      || (batch.source === 'apple-cn' && existing.source !== 'manual')
      || (batch.source === 'pconline' && existing.source === 'pconline');
    if (!canWrite) continue;
    // 从第三方价迁移到官网起售价时，旧趋势口径不同，重新开始记录。
    if (existing && existing.source !== batch.source) await env.DB.prepare('DELETE FROM apple_history WHERE name = ?').bind(row.name).run();
    await env.DB.prepare(
      `INSERT INTO apple_products (category, name, price, url, source, sort, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET category=excluded.category, price=excluded.price,
         url=excluded.url, source=excluded.source, sort=excluded.sort, updated_at=excluded.updated_at`
    ).bind(batch.category, row.name, row.price, row.url, batch.source, batch.sortBase + i, now).run();
    const direction = await recordApplePrice(env, row.name, row.price);
    report.changes[direction] = (report.changes[direction] || 0) + 1;
    saved++;
  }
  const placeholders = seenNames.map(() => '?').join(',');
  await env.DB.prepare(`DELETE FROM apple_products WHERE source=? AND category=? AND name NOT IN (${placeholders})`)
    .bind(batch.source, batch.category, ...seenNames).run();
  report.categories.push({ source: batch.source, source_label: SOURCE_LABELS[batch.source], category: batch.category, count: batch.rows.length, saved });
  if (batch.errors?.length) report.errors.push(...batch.errors.map((error) => `${SOURCE_LABELS[batch.source]}/${batch.category}: ${error}`));
}

export async function onRequestPost({ request, env }) {
  const key = request.headers.get('X-API-Key') || '';
  const okKey = env.APPLE_REFRESH_KEY && key === env.APPLE_REFRESH_KEY;
  const okAdmin = (await getRole(request, env)) === 'admin';
  if (!okKey && !okAdmin) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let suppliedOfficial;
  try { suppliedOfficial = await readOfficialPayload(request); }
  catch (error) { return Response.json({ error: error.message }, { status: 400 }); }

  await ensureAppleSchema(env);
  const now = Date.now();
  const report = {
    ok: false,
    refreshed_at: 0,
    official_transport: suppliedOfficial ? 'github-action' : (env.APPLE_DIRECT_FETCH === '1' ? 'direct' : 'scheduled'),
    categories: [], sources: [],
    changes: { new: 0, down: 0, up: 0, same: 0 }, errors: [],
  };
  const jobs = [
    ...(suppliedOfficial
      ? suppliedOfficial.map((batch) => ({ name: `Apple 中国官网/${batch.category}`, run: async () => batch }))
      : env.APPLE_DIRECT_FETCH === '1'
        ? [...APPLE_CATS.map((cat) => ({ name: `Apple 中国官网/${cat.category}`, run: () => scrapeAppleCategory(cat) })), { name: 'Apple 中国官网/airpods', run: scrapeAirPods }]
        : []),
    ...PC_CATS.map((cat) => ({ name: `太平洋电脑网/${cat.category}`, run: () => scrapePConline(cat) })),
  ];
  const settled = await Promise.allSettled(jobs.map((job) => job.run()));
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'rejected') {
      report.errors.push(`${jobs[i].name}: ${result.reason?.message || '抓取失败'}`);
      continue;
    }
    try { await syncBatch(env, result.value, now, report); }
    catch (error) { report.errors.push(`${jobs[i].name}: 写入失败：${error.message}`); }
  }
  const totals = new Map();
  for (const item of report.categories) totals.set(item.source, (totals.get(item.source) || 0) + item.saved);
  report.sources = [...totals].map(([key, count]) => ({ key, label: SOURCE_LABELS[key], count }));
  report.ok = report.categories.length > 0;
  await ensurePrefsSchema(env);
  if (report.ok) {
    report.refreshed_at = now;
    await env.DB.prepare(`INSERT INTO prefs (key, value) VALUES ('apple_refreshed_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(String(now)).run();
  }
  await env.DB.prepare(`INSERT INTO prefs (key, value) VALUES ('apple_refresh_report', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .bind(JSON.stringify(report)).run();
  return Response.json(report, { status: report.ok ? 200 : 502 });
}
export async function onRequestGet(ctx) { return onRequestPost(ctx); }
