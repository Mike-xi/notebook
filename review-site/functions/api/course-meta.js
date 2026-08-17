// 课程的重命名 / 简介 / 图标覆盖层。
//
// 为什么不直接改 courses 表：静态课程写在 git 里的 courses.json，改不动；
// 动态课程才在 D1。这里统一走 prefs 里的一张覆盖表 course_meta：
//   { "<file>": { "title": "...", "description": "...", "icon": "..." } }
// 前端读到后盖在原始字段上，静态和动态课程一视同仁。字段留空＝清掉覆盖，
// 恢复原始值。
//
// PUT /api/course-meta { file, title?, description?, icon? } -> { ok, meta }
// 读取合并在 /api/order 的返回里（meta 字段），少一次请求。
import { ensurePrefsSchema } from '../_lib/db.js';
import { getRole } from '../_lib/auth.js';

const KEY = 'course_meta';
const json = (data, status = 200) => Response.json(data, { status });
const str = (v) => (typeof v === 'string' ? v : '').trim();

export async function readMeta(env) {
  try {
    const row = await env.DB.prepare('SELECT value FROM prefs WHERE key = ?').bind(KEY).first();
    const parsed = JSON.parse(row?.value || '{}');
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch { return {}; }
}

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ meta: {} });
  await ensurePrefsSchema(env);
  return json({ meta: await readMeta(env) });
}

export async function onRequestPut({ request, env }) {
  if ((await getRole(request, env)) !== 'admin') return json({ error: '仅管理员可修改课程' }, 403);
  await ensurePrefsSchema(env);

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求格式错误' }, 400); }

  const file = str(body?.file);
  if (!file || file.length > 200 || file.includes('/')) return json({ error: '非法的课程标识' }, 400);

  const meta = await readMeta(env);
  const entry = { ...(meta[file] || {}) };

  // 只处理请求里明确给了的字段；空串＝清除覆盖
  if (typeof body.title === 'string') {
    const v = str(body.title).slice(0, 80);
    if (v) entry.title = v; else delete entry.title;
  }
  if (typeof body.description === 'string') {
    const v = str(body.description).slice(0, 160);
    if (v) entry.description = v; else delete entry.description;
  }
  if (typeof body.icon === 'string') {
    const v = str(body.icon).slice(0, 200);
    // 图标要么是 emoji/短文本，要么是站内图片地址；不接受外链，避免首页被塞进第三方请求
    if (!v) delete entry.icon;
    else if (v.startsWith('/')) entry.icon = v;
    else if ([...v].length <= 4) entry.icon = v;
    else return json({ error: '图标只能是 emoji 或站内图片' }, 400);
  }

  if (Object.keys(entry).length) meta[file] = entry;
  else delete meta[file];

  await env.DB.prepare(
    `INSERT INTO prefs (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(KEY, JSON.stringify(meta)).run();

  return json({ ok: true, meta });
}
