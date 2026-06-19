// POST /api/apple/refresh   —— 抓太平洋电脑网(pconline)各分类苹果参考价，upsert + 记录价格变化历史。
// 鉴权：请求头 X-API-Key: <APPLE_REFRESH_KEY>（GitHub Actions cron 用）或 管理员 Cookie。
// 由 _middleware.js 放行 /api/apple/refresh（函数自鉴权）。
//
// 数据源说明（已实测，见项目记忆 project-apple-price）：
//   pconline 分类页 https://product.pconline.com.cn/<slug>/apple/ 服务端渲染、价格在静态 HTML 里、GBK 编码。
//   只有 mobile / notebook / smartwatch 的 /apple/ 品牌过滤有效；earphone(AirPods) 不按品牌过滤、iPad 无可用 slug，
//   故 iPad / AirPods 由管理员在前端手动录入（source=manual，本接口不覆盖）。绝不编造价格。
import { ensureAppleSchema, recordApplePrice, ensurePrefsSchema } from '../../_lib/db.js';
import { getRole } from '../../_lib/auth.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 可抓分类。drop 用于剔除页面里的异常/伪产品（如 pconline 上并不存在的 "Macbook Neo"）。
const CATS = [
  { category: 'iphone', slug: 'mobile',      label: 'iPhone' },
  { category: 'mac',    slug: 'notebook',    label: 'Mac',         drop: /Neo/i },
  { category: 'watch',  slug: 'smartwatch',  label: 'Apple Watch' },
];

// 解析：<a href="..NNNN_price.html" title="苹果<型号>报价" ...>￥<价格></a>
// 注意 ￥ 是全角 U+FFE5（不是 ¥ U+00A5），title 一定带"苹果…报价"。
const RE = /<a\s+href="([^"]*?(\d+)_price\.html)"\s+title="苹果([^"]+?)报价"[^>]*>￥(\d+)<\/a>/g;

async function scrape(slug) {
  const url = `https://product.pconline.com.cn/${slug}/apple/`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  // pconline 页面声明 iso-8859-1 是错的，真实编码 GBK/gb18030
  let html;
  try { html = new TextDecoder('gb18030').decode(buf); }
  catch { html = new TextDecoder('utf-8').decode(buf); }
  const out = [];
  const seen = new Set();
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(html)) !== null) {
    const href = m[1].startsWith('//') ? `https:${m[1]}` : m[1];
    const name = m[3].trim().replace(/\s+/g, ' ');
    const price = parseInt(m[4], 10);
    if (!name || !Number.isFinite(price) || price <= 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;          // 同页去重，保留首次（通常是主推/在售款）
    seen.add(key);
    out.push({ name, price, url: href });
  }
  return out;
}

export async function onRequestPost({ request, env }) {
  // 鉴权：API Key 或 管理员
  const key = request.headers.get('X-API-Key') || '';
  const okKey = env.APPLE_REFRESH_KEY && key === env.APPLE_REFRESH_KEY;
  const okAdmin = (await getRole(request, env)) === 'admin';
  if (!okKey && !okAdmin) return Response.json({ error: 'unauthorized' }, { status: 401 });

  await ensureAppleSchema(env);

  const now = Date.now();
  const report = { ok: true, refreshed_at: now, categories: [], changes: { new: 0, down: 0, up: 0, same: 0 }, errors: [] };

  for (const cat of CATS) {
    let rows;
    try { rows = await scrape(cat.slug); }
    catch (e) { report.errors.push(`${cat.category}: ${e.message}`); continue; }
    if (cat.drop) rows = rows.filter((r) => !cat.drop.test(r.name));
    if (!rows.length) { report.errors.push(`${cat.category}: 0 命中`); continue; }

    const seenNames = [];
    let sort = 0;
    for (const r of rows) {
      seenNames.push(r.name);
      // upsert（仅覆盖 pconline 行，绝不动管理员手录的 manual 行）
      await env.DB.prepare(
        `INSERT INTO apple_products (category, name, price, url, source, sort, updated_at)
         VALUES (?, ?, ?, ?, 'pconline', ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           category=excluded.category, price=excluded.price, url=excluded.url,
           sort=excluded.sort, updated_at=excluded.updated_at
         WHERE apple_products.source='pconline'`
      ).bind(cat.category, r.name, r.price, r.url, sort++, now).run();
      // 价变历史（价格不同/首次才记一条）
      const dir = await recordApplePrice(env, r.name, r.price);
      report.changes[dir] = (report.changes[dir] || 0) + 1;
    }
    // 清理本分类下已从 pconline 下架、但仍残留的 pconline 产品（保留历史表，不影响 manual 行）
    const placeholders = seenNames.map(() => '?').join(',');
    await env.DB.prepare(
      `DELETE FROM apple_products
       WHERE source='pconline' AND category=? AND name NOT IN (${placeholders})`
    ).bind(cat.category, ...seenNames).run();

    report.categories.push({ category: cat.category, count: rows.length });
  }

  // 记录最近刷新时间
  await ensurePrefsSchema(env);
  await env.DB.prepare(
    `INSERT INTO prefs (key, value) VALUES ('apple_refreshed_at', ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).bind(String(now)).run();

  return Response.json(report);
}

// 允许 GET 触发（方便 cron 用简单 GET；同样需要 key/admin）
export async function onRequestGet(ctx) {
  return onRequestPost(ctx);
}
