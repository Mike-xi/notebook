// 课程分类覆盖（单用户，存 prefs key=category_overrides，值为 {file: category} JSON map）。
// 同时适用于静态(courses.json)与动态(u-*)课程——首页把它叠加在课程自身分类之上，
// 于是「拖动课程卡到某个 Tab」即可改分类，无需改 courses.json 或动态课程的 DB 列。
// POST /api/category {file, category}  -> { ok: true }
// 鉴权由 _middleware.js 统一处理。
import { ensurePrefsSchema } from '../_lib/db.js';

const KEY = 'category_overrides';
const CATEGORIES = ['learn', 'explore', 'play'];

export async function onRequestPost({ request, env }) {
  await ensurePrefsSchema(env);
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }

  const file = body?.file;
  const category = body?.category;
  if (typeof file !== 'string' || !file || file.length > 200 || file.includes('/')) {
    return Response.json({ error: '非法的课程标识' }, { status: 400 });
  }
  if (!CATEGORIES.includes(category)) {
    return Response.json({ error: '非法的分类' }, { status: 400 });
  }

  const row = await env.DB.prepare('SELECT value FROM prefs WHERE key = ?').bind(KEY).first();
  let map = {};
  try { const p = JSON.parse(row?.value || '{}'); if (p && typeof p === 'object' && !Array.isArray(p)) map = p; } catch {}
  map[file] = category;
  // 限条目数（兜底）
  const keys = Object.keys(map);
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete map[k];

  await env.DB.prepare(
    'INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(KEY, JSON.stringify(map)).run();
  return Response.json({ ok: true });
}
