// POST /api/apple/advisor   { budget, category?, prefer? }
//   用 Workers AI 结合「真实价格历史统计 + 苹果价格周期常识」给出：
//   该预算下推荐买哪些产品、以及最适合出手的时间段。鉴权由 _middleware.js 拦在登录后。
//
//   所有价格数字均来自 D1（apple_products / apple_history），AI 只负责"推荐 + 时机推理"，绝不编造价格。
//   无 AI 绑定时退化为纯规则建议（按"当前价距历史低点的位置 + 趋势"打分），保证功能可用。
import { ensureAppleSchema } from '../../_lib/db.js';

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

// 由当前月份推导临近的大促/发布节点，喂给模型做时机判断（避免凭空臆测日期）。
function cyclesHint(now) {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = d.getMonth() + 1; // 1-12
  const lines = [
    `今天约 ${d.toISOString().slice(0, 10)}（${y}年${m}月）。`,
    '苹果价格周期常识：',
    '- 新 iPhone 每年 9 月发布；发布后上一代官方降价/第三方渠道跳水，想买旧款等 9 月后最划算。',
    '- 全年大促节点：618（6 月中下旬）、双 11（11 月）、年货节（春节前 1–2 月）、开学季教育优惠（约 7–9 月，学生认证可叠加）。',
    '- Mac / iPad 更新无固定月份，常见于春季发布会（3–5 月）与秋季（10–11 月）；临近更新别在发布前高价入手。',
    '- Apple Watch 多与 iPhone 同期（9 月）更新。',
  ];
  // 给出"下一个值得等的节点"提示
  if (m >= 6 && m <= 8) lines.push('当前接近/刚过 618 与暑期教育优惠季，下一个大节点是 9 月新品 + 双 11。');
  else if (m === 9 || m === 10) lines.push('当前处于新品发布期，旧款正在/即将降价，双 11 临近。');
  else if (m === 11) lines.push('当前是双 11，全年电商价低点之一。');
  else if (m === 12 || m <= 2) lines.push('当前接近年货节，是节前促销与备货期。');
  else lines.push('当前是春季，可关注春季发布会与 618 蓄水期。');
  return lines.join('\n');
}

function trendOf(stats, price) {
  if (!stats || stats.n < 2) return 'flat';
  if (price < stats.prev) return 'down';
  if (price > stats.prev) return 'up';
  return 'flat';
}
// 当前价在 [历史最低, 历史最高] 中的位置：0=历史低点（越低越值得买）
function dealScore(stats, price) {
  if (!stats || stats.max <= stats.min) return 0.5;
  return Math.max(0, Math.min(1, (price - stats.min) / (stats.max - stats.min)));
}

export async function onRequestPost({ request, env }) {
  await ensureAppleSchema(env);

  let b;
  try { b = await request.json(); } catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }
  const budget = Math.round(Number(b?.budget));
  if (!Number.isFinite(budget) || budget <= 0) return Response.json({ error: '请输入有效预算' }, { status: 400 });
  const category = ['iphone', 'ipad', 'mac', 'watch', 'airpods'].includes(b?.category) ? b.category : '';
  const prefer = str(b?.prefer).slice(0, 120);

  // 取产品 + 历史，算统计
  const where = category ? 'WHERE category = ?' : '';
  const stmt = env.DB.prepare(`SELECT category, name, price, source FROM apple_products ${where} ORDER BY price`);
  const products = ((category ? await stmt.bind(category).all() : await stmt.all()).results) || [];
  if (!products.length) return Response.json({ error: '暂无产品数据，请先刷新或录入' }, { status: 400 });

  const names = products.map((p) => p.name);
  const ph = names.map(() => '?').join(',');
  const hrows = (await env.DB.prepare(
    `SELECT name, price, ts FROM apple_history WHERE name IN (${ph}) ORDER BY name, ts ASC`
  ).bind(...names).all()).results || [];
  const histByName = new Map();
  for (const r of hrows) {
    if (!histByName.has(r.name)) histByName.set(r.name, []);
    histByName.get(r.name).push({ price: r.price, ts: r.ts });
  }

  const enriched = products.map((p) => {
    const hist = histByName.get(p.name) || [];
    const prices = hist.map((h) => h.price);
    const min = prices.length ? Math.min(...prices, p.price) : p.price;
    const max = prices.length ? Math.max(...prices, p.price) : p.price;
    const avg = prices.length ? Math.round(prices.reduce((a, c) => a + c, 0) / prices.length) : p.price;
    const prev = hist.length >= 2 ? hist[hist.length - 2].price : p.price;
    const days = hist.length ? Math.max(1, Math.round((Date.now() - hist[0].ts) / 86400000)) : 0;
    const stats = { min, max, avg, prev, n: hist.length };
    return {
      name: p.name, category: p.category, price: p.price,
      min, max, avg, days, n: hist.length,
      trend: trendOf(stats, p.price),
      deal: dealScore(stats, p.price),
    };
  });

  // 预算内（含 10% 略超作为"加点预算可够"）的候选，按 deal 升序（越接近历史低点越靠前）
  const afford = enriched.filter((e) => e.price <= budget);
  const stretch = enriched.filter((e) => e.price > budget && e.price <= budget * 1.1);
  const candidates = [...afford, ...stretch].sort((a, b2) => a.deal - b2.deal).slice(0, 14);

  const now = Date.now();

  // —— 无 AI 绑定：规则化兜底 ——
  if (!env.AI) return Response.json({ ok: true, source: 'rule', ...ruleAdvice(budget, candidates, now) });

  // —— Workers AI ——
  const prodLines = candidates.map((e) =>
    `- ${e.name}（${e.category}）现价￥${e.price}｜区间￥${e.min}-￥${e.max}｜均价￥${e.avg}｜`
    + `趋势${e.trend === 'down' ? '下降' : e.trend === 'up' ? '上涨' : '平稳'}｜`
    + `${e.n >= 2 ? `已追踪${e.days}天/${e.n}个价点，当前处区间${Math.round(e.deal * 100)}%位置(0=历史低)` : '历史数据刚开始积累'}`
  ).join('\n');

  const sys = '你是「苹果产品购买时机顾问」。只输出一个 JSON 对象，禁止任何解释、Markdown 代码块或多余文字。'
    + '字段：summary(一句话总览,≤40字)，picks(数组,最多4个,每项{name(必须用给定型号原文),price(数字,用给定现价),verdict(立即/可买/再等其一),reason(≤30字,引用价格趋势或区间位置)})，'
    + 'timing(数组,2-3个{window(时间段,如"现在"/"9月新机后"/"双11"),advice(≤30字)})，note(风险/提醒一句,≤30字)。'
    + '原则：现价接近历史低点或下降趋势→倾向立即/可买；接近发布期或现价偏高→建议再等并指出节点。全部用简体中文，价格只能用给定数字。';
  const user = `用户预算：￥${budget}\n偏好：${prefer || '（未填，可不考虑）'}\n${category ? `只看分类：${category}\n` : ''}`
    + `\n${cyclesHint(now)}\n\n候选产品（价格与统计均为真实数据，不要改动数字）：\n${prodLines}\n\n请输出 JSON。`;

  try {
    const r = await env.AI.run(MODEL, {
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      max_tokens: 700, temperature: 0.4,
    });
    const rsp = r && (r.response ?? r.result?.response);
    const parsed = (rsp && typeof rsp === 'object') ? rsp : extractJSON(String(rsp || ''));
    const out = sanitizeAdvice(parsed, candidates, budget);
    if (!out) return Response.json({ ok: true, source: 'rule', ...ruleAdvice(budget, candidates, now) });
    return Response.json({ ok: true, source: 'ai', ...out, candidates: candidates.length });
  } catch {
    return Response.json({ ok: true, source: 'rule', ...ruleAdvice(budget, candidates, now) });
  }
}

// 校验/收敛 AI 输出：型号必须在候选里、价格用真实现价，避免幻觉。
function sanitizeAdvice(parsed, candidates, budget) {
  if (!parsed || typeof parsed !== 'object') return null;
  const byName = new Map(candidates.map((c) => [c.name, c]));
  const verdicts = ['立即', '可买', '再等'];
  const picks = (Array.isArray(parsed.picks) ? parsed.picks : [])
    .map((p) => {
      const c = byName.get(str(p?.name));
      if (!c) return null;
      return {
        name: c.name, price: c.price,
        verdict: verdicts.includes(str(p?.verdict)) ? str(p.verdict) : (c.deal <= 0.25 ? '可买' : '再等'),
        reason: str(p?.reason).slice(0, 40),
      };
    })
    .filter(Boolean).slice(0, 4);
  const timing = (Array.isArray(parsed.timing) ? parsed.timing : [])
    .map((t) => ({ window: str(t?.window).slice(0, 16), advice: str(t?.advice).slice(0, 40) }))
    .filter((t) => t.window && t.advice).slice(0, 3);
  if (!picks.length && !timing.length) return null;
  return { summary: str(parsed.summary).slice(0, 60), picks, timing, note: str(parsed.note).slice(0, 40) };
}

// 规则兜底：选 deal 最低（最接近历史低点）的前几个，套用周期常识给时机。
function ruleAdvice(budget, candidates, now) {
  const m = new Date(now).getMonth() + 1;
  const picks = candidates.slice(0, 4).map((c) => {
    const low = c.deal <= 0.25, down = c.trend === 'down';
    return {
      name: c.name, price: c.price,
      verdict: (low || down) ? (low && down ? '立即' : '可买') : '再等',
      reason: c.n < 2 ? '价格数据刚开始积累，先观察' :
        low ? `接近历史低点￥${c.min}` : down ? '近期价格在下降' : `偏高(区间${Math.round(c.deal * 100)}%)，可再等`,
    };
  });
  const timing = [];
  if (m >= 6 && m <= 8) {
    timing.push({ window: '现在', advice: '暑期教育优惠+618余热，学生认证可叠加' });
    timing.push({ window: '9月后', advice: '新 iPhone 发布，旧款降价更划算' });
    timing.push({ window: '双11', advice: '11月电商全年低点之一' });
  } else if (m === 9 || m === 10) {
    timing.push({ window: '现在', advice: '新品发布，旧款开始跳水可入手' });
    timing.push({ window: '双11', advice: '11月再等通常更低' });
  } else if (m === 11) {
    timing.push({ window: '现在', advice: '双11全年低点之一，可出手' });
  } else {
    timing.push({ window: '现在', advice: '关注当前价是否接近历史低点' });
    timing.push({ window: '618/双11', advice: '大促节点电商价更低' });
  }
  return {
    summary: picks.length ? `预算￥${budget} 内为你筛了 ${picks.length} 款，按价格时机排序` : '该预算内暂无合适产品，可放宽预算或换分类',
    picks, timing, note: '价格来自 Apple 中国官网起售价或公开第三方参考价，实际成交价以各渠道为准',
  };
}

function extractJSON(s) {
  if (!s) return {};
  let t = String(s).replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try { const o = JSON.parse(t); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
