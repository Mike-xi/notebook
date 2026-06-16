// 内容审核（仅管理员 / 三级）。游客上传的课程 status=pending，在这里通过或拒绝。
// GET  /api/review                       -> { pending: [...] } 待审核课程列表（不含正文）
// POST /api/review  {file, action}       -> action=approve（置为 approved）| reject（删除并清理）
// 鉴权：除中间件的登录校验外，这里再要求 admin 角色。
import { ensureCoursesSchema, logEvent } from '../_lib/db.js';
import { getRole } from '../_lib/auth.js';

const requireAdmin = async (request, env) => (await getRole(request, env)) === 'admin';
const forbid = () => Response.json({ error: '需要管理员权限' }, { status: 403 });

export async function onRequestGet({ request, env }) {
  if (!(await requireAdmin(request, env))) return forbid();
  await ensureCoursesSchema(env);
  const { results } = await env.DB.prepare(
    `SELECT file, title, subject, description, icon, color, kind, category, created_at
     FROM courses WHERE status = 'pending' ORDER BY created_at ASC`
  ).all();
  return Response.json({ pending: results || [] });
}

export async function onRequestPost({ request, env }) {
  if (!(await requireAdmin(request, env))) return forbid();
  await ensureCoursesSchema(env);

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }

  const file = String(body?.file || '');
  const action = body?.action;
  if (!file) return Response.json({ error: '缺少 file' }, { status: 400 });

  const row = await env.DB.prepare('SELECT file, kind, status FROM courses WHERE file = ?').bind(file).first();
  if (!row) return Response.json({ error: '课程不存在' }, { status: 404 });
  if (row.status !== 'pending') return Response.json({ error: '该课程不在待审核状态' }, { status: 409 });

  if (action === 'approve') {
    await env.DB.prepare("UPDATE courses SET status = 'approved' WHERE file = ?").bind(file).run();
    await logEvent(env, 'approve', file);
    return Response.json({ ok: true });
  }

  if (action === 'reject') {
    // 待审课程都是动态课程（u-*），物理删除并清理 R2 对象与关联数据
    await env.DB.prepare('DELETE FROM courses WHERE file = ?').bind(file).run();
    if (file.endsWith('.pdf')) { try { await env.FILES.delete(file); } catch {} }
    try { await env.DB.prepare('DELETE FROM progress WHERE file = ?').bind(file).run(); } catch {}
    try { await env.DB.prepare('DELETE FROM bookmarks WHERE file = ?').bind(file).run(); } catch {}
    try { await env.DB.prepare('DELETE FROM highlights WHERE file = ?').bind(file).run(); } catch {}
    await logEvent(env, 'reject', file);
    return Response.json({ ok: true });
  }

  return Response.json({ error: '未知操作' }, { status: 400 });
}
