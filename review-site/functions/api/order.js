// 课程显示顺序（单用户，存 prefs 表 key=course_order，值为 file 列表 JSON）。
// 顺序按 file 记录，可统一覆盖静态(courses.json)与动态课程。
// GET /api/order         -> { order: [file, ...] }
// PUT /api/order {order}  -> { ok: true }
// 鉴权由 _middleware.js 统一处理。
import { ensurePrefsSchema } from '../_lib/db.js';

const KEY = 'course_order';

export async function onRequestGet({ env }) {
  await ensurePrefsSchema(env);
  const rows = await env.DB.prepare("SELECT key, value FROM prefs WHERE key IN (?, 'hidden_courses')").bind(KEY).all();
  const map = {};
  for (const r of (rows.results || [])) map[r.key] = r.value;
  const parseList = (v) => {
    try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : []; }
    catch { return []; }
  };
  // order：课程显示顺序；hidden：被删除的静态课程（首页据此过滤）
  return Response.json({ order: parseList(map[KEY]), hidden: parseList(map['hidden_courses']) });
}

export async function onRequestPut({ request, env }) {
  await ensurePrefsSchema(env);
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }

  if (!Array.isArray(body?.order)) {
    return Response.json({ error: '缺少 order 数组' }, { status: 400 });
  }
  // 去重、限长，只留字符串
  const seen = new Set();
  const order = [];
  for (const x of body.order) {
    if (typeof x !== 'string' || seen.has(x)) continue;
    seen.add(x);
    order.push(x);
    if (order.length >= 500) break;
  }

  await env.DB.prepare(
    'INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(KEY, JSON.stringify(order)).run();
  return Response.json({ ok: true });
}
