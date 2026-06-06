// 用户在线创建的课程（内容存 D1，file slug 以 "u-" 前缀标识为动态课程）
// GET    /api/courses                 -> 动态课程列表（不含 html 正文）
// POST   /api/courses  {title, html, icon?, subject?, description?, color?}
// DELETE /api/courses  {file}         -> 删除课程并清理其进度/书签
// 鉴权由 _middleware.js 统一处理（只有登录用户能访问 /api/*）

const MAX_HTML_BYTES = 1_500_000; // D1 单值上限 2MB，留足余量
const DEFAULT_ICON = '📘';
const PALETTE = ['#6750A4', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6'];

async function ensureTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS courses (
       file        TEXT PRIMARY KEY,
       title       TEXT NOT NULL,
       subject     TEXT,
       description TEXT,
       icon        TEXT,
       color       TEXT,
       tags        TEXT,
       html        TEXT NOT NULL,
       created_at  INTEGER NOT NULL
     )`
  ).run();
}

export async function onRequestGet({ env }) {
  await ensureTable(env);
  const { results } = await env.DB.prepare(
    `SELECT file, title, subject, description, icon, color, tags, created_at
     FROM courses ORDER BY created_at DESC`
  ).all();
  const courses = (results || []).map((r) => ({
    file: r.file,
    title: r.title,
    subject: r.subject || '',
    description: r.description || '',
    icon: r.icon || DEFAULT_ICON,
    color: r.color || PALETTE[0],
    tags: safeTags(r.tags),
    created_at: r.created_at,
    dynamic: true,
  }));
  return Response.json(courses);
}

export async function onRequestPost({ request, env }) {
  await ensureTable(env);

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }

  let { title, html, icon, subject, description, color } = body || {};
  title = (typeof title === 'string' ? title : '').trim();
  if (!title) return Response.json({ error: '请填写课程名称' }, { status: 400 });
  if (typeof html !== 'string' || !html.trim()) {
    return Response.json({ error: '请上传 HTML 文件' }, { status: 400 });
  }
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > MAX_HTML_BYTES) {
    return Response.json(
      { error: `HTML 太大（${(bytes / 1e6).toFixed(2)} MB），请控制在 1.5 MB 以内` },
      { status: 413 }
    );
  }

  const file = `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.html`;
  const finalIcon = (typeof icon === 'string' && icon.trim()) ? [...icon.trim()].slice(0, 2).join('') : DEFAULT_ICON;
  const finalColor = (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color))
    ? color : PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const finalSubject = (typeof subject === 'string' ? subject : '').trim().slice(0, 40) || '我的笔记';
  const finalDesc = (typeof description === 'string' ? description : '').trim().slice(0, 120) || '上传的复习笔记';

  await env.DB.prepare(
    `INSERT INTO courses (file, title, subject, description, icon, color, tags, html, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(file, title.slice(0, 80), finalSubject, finalDesc, finalIcon, finalColor, '[]', html, Date.now()).run();

  return Response.json({ ok: true, file });
}

export async function onRequestDelete({ request, env }) {
  await ensureTable(env);

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }

  const file = body?.file;
  if (typeof file !== 'string' || !file.startsWith('u-')) {
    return Response.json({ error: '非法的课程标识' }, { status: 400 });
  }
  // 主操作：删除课程本身
  await env.DB.prepare('DELETE FROM courses WHERE file = ?').bind(file).run();
  // 尽力清理关联的进度/书签（即便这些表暂不存在也不影响删除成功）
  try { await env.DB.prepare('DELETE FROM progress WHERE file = ?').bind(file).run(); } catch {}
  try { await env.DB.prepare('DELETE FROM bookmarks WHERE file = ?').bind(file).run(); } catch {}
  return Response.json({ ok: true });
}

function safeTags(s) {
  try { const t = JSON.parse(s || '[]'); return Array.isArray(t) ? t : []; }
  catch { return []; }
}
