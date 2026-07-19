// 苹果比价取数 / 管理。鉴权由 _middleware.js 统一拦在登录后。
//
// GET  /api/apple
//   -> { categories:[{key,label,products:[{name,category,price,url,source,updated_at,
//                                            history:[{price,ts}], stats:{first,min,max,avg,prev,n,since},
//                                            third:[{channel,price,url,note,updated_at}]}]}],
//        refreshed_at, me:{admin}, now }
// POST /api/apple   （仅管理员）
//   { action:'addProduct', category, name, price, url }   手录已人工核验的补充产品（source=manual）
//   { action:'delProduct', name }                          删除产品（自动源行下次刷新会回来；manual 行永久删）
//   { action:'setThird', name, channel, price, url, note } 手录第三方渠道价（淘宝/京东/拼多多…）
//   { action:'delThird', name, channel }                   删除某第三方价
import { ensureAppleSchema, recordApplePrice, ensurePrefsSchema } from '../_lib/db.js';
import { getRole } from '../_lib/auth.js';

const CAT_LABELS = [
  ['iphone', 'iPhone'],
  ['ipad', 'iPad'],
  ['mac', 'Mac'],
  ['watch', 'Apple Watch'],
  ['airpods', 'AirPods'],
  ['other', '其他'],
];

const SOURCE_LABELS = {
  'apple-cn': 'Apple 中国官网',
  pconline: '太平洋电脑网',
  manual: '人工核验',
};

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const clean = (s, max) => str(s).replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
const toPrice = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };

function buildStats(hist, current) {
  // hist: [{price, ts}] 升序。current = 当前价（apple_products.price）。
  if (!hist.length) return { first: current, min: current, max: current, avg: current, prev: current, n: 0, since: 0 };
  const prices = hist.map((h) => h.price);
  const min = Math.min(...prices, current);
  const max = Math.max(...prices, current);
  const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  const prev = hist.length >= 2 ? hist[hist.length - 2].price : hist[0].price;
  return { first: hist[0].price, min, max, avg, prev, n: hist.length, since: hist[0].ts };
}

export async function onRequestGet({ request, env }) {
  await ensureAppleSchema(env);
  const admin = (await getRole(request, env)) === 'admin';

  const products = (await env.DB.prepare(
    'SELECT category, name, price, url, source, updated_at FROM apple_products ORDER BY category, sort, price'
  ).all()).results || [];
  const sourceCounts = new Map();
  for (const product of products) sourceCounts.set(product.source, (sourceCounts.get(product.source) || 0) + 1);
  const sources = [...sourceCounts].map(([key, count]) => ({
    key, label: SOURCE_LABELS[key] || key, count,
  }));

  // 价格历史（只在价变时记点，量很小）：一把查回，JS 分组
  const histByName = new Map();
  if (products.length) {
    const names = products.map((p) => p.name);
    const ph = names.map(() => '?').join(',');
    const hrows = (await env.DB.prepare(
      `SELECT name, price, ts FROM apple_history WHERE name IN (${ph}) ORDER BY name, ts ASC`
    ).bind(...names).all()).results || [];
    for (const r of hrows) {
      if (!histByName.has(r.name)) histByName.set(r.name, []);
      histByName.get(r.name).push({ price: r.price, ts: r.ts });
    }
  }

  // 第三方价
  const thirdByName = new Map();
  const trows = (await env.DB.prepare(
    'SELECT name, channel, price, url, note, updated_at FROM apple_third ORDER BY price ASC'
  ).all()).results || [];
  for (const r of trows) {
    if (!thirdByName.has(r.name)) thirdByName.set(r.name, []);
    thirdByName.get(r.name).push({ channel: r.channel, price: r.price, url: r.url, note: r.note, updated_at: r.updated_at });
  }

  const byCat = new Map();
  for (const p of products) {
    const hist = histByName.get(p.name) || [];
    const item = {
      name: p.name, category: p.category, price: p.price, url: p.url,
      source: p.source, updated_at: p.updated_at,
      history: hist,
      stats: buildStats(hist, p.price),
      third: thirdByName.get(p.name) || [],
    };
    if (!byCat.has(p.category)) byCat.set(p.category, []);
    byCat.get(p.category).push(item);
  }

  const categories = CAT_LABELS
    .map(([key, label]) => ({ key, label, products: byCat.get(key) || [] }))
    .filter((c) => c.products.length);

  await ensurePrefsSchema(env);
  const prefRows = (await env.DB.prepare(
    "SELECT key, value FROM prefs WHERE key IN ('apple_refreshed_at', 'apple_refresh_report')"
  ).all()).results || [];
  const prefs = new Map(prefRows.map((row) => [row.key, row.value]));
  const refreshed_at = parseInt(prefs.get('apple_refreshed_at'), 10) || 0;
  let refresh_report = null;
  try { refresh_report = JSON.parse(prefs.get('apple_refresh_report') || 'null'); } catch {}

  return Response.json({ categories, sources, refreshed_at, refresh_report, me: { admin }, now: Date.now() });
}

export async function onRequestPost({ request, env }) {
  await ensureAppleSchema(env);
  if ((await getRole(request, env)) !== 'admin') return Response.json({ error: '无权限' }, { status: 403 });

  let b;
  try { b = await request.json(); } catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }
  const action = str(b?.action);
  const now = Date.now();

  if (action === 'addProduct') {
    const category = ['iphone', 'ipad', 'mac', 'watch', 'airpods', 'other'].includes(b?.category) ? b.category : 'other';
    const name = clean(b?.name, 80);
    const price = toPrice(b?.price);
    const url = clean(b?.url, 400);
    if (!name || !price) return Response.json({ error: '型号与价格必填' }, { status: 400 });
    await env.DB.prepare(
      `INSERT INTO apple_products (category, name, price, url, source, sort, updated_at)
       VALUES (?, ?, ?, ?, 'manual', 0, ?)
       ON CONFLICT(name) DO UPDATE SET
         category=excluded.category, price=excluded.price, url=excluded.url,
         source='manual', updated_at=excluded.updated_at`
    ).bind(category, name, price, url, now).run();
    await recordApplePrice(env, name, price);
    return Response.json({ ok: true });
  }

  if (action === 'delProduct') {
    const name = clean(b?.name, 80);
    if (!name) return Response.json({ error: 'bad name' }, { status: 400 });
    await env.DB.prepare('DELETE FROM apple_products WHERE name = ?').bind(name).run();
    await env.DB.prepare('DELETE FROM apple_third WHERE name = ?').bind(name).run();
    return Response.json({ ok: true });
  }

  if (action === 'setThird') {
    const name = clean(b?.name, 80);
    const channel = clean(b?.channel, 24);
    const price = toPrice(b?.price);
    const url = clean(b?.url, 400);
    const note = clean(b?.note, 60);
    if (!name || !channel || !price) return Response.json({ error: '型号/渠道/价格必填' }, { status: 400 });
    await env.DB.prepare(
      `INSERT INTO apple_third (name, channel, price, url, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name, channel) DO UPDATE SET
         price=excluded.price, url=excluded.url, note=excluded.note, updated_at=excluded.updated_at`
    ).bind(name, channel, price, url, note, now).run();
    return Response.json({ ok: true });
  }

  if (action === 'delThird') {
    const name = clean(b?.name, 80);
    const channel = clean(b?.channel, 24);
    if (!name || !channel) return Response.json({ error: 'bad args' }, { status: 400 });
    await env.DB.prepare('DELETE FROM apple_third WHERE name = ? AND channel = ?').bind(name, channel).run();
    return Response.json({ ok: true });
  }

  return Response.json({ error: '未知操作' }, { status: 400 });
}
