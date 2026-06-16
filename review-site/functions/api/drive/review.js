// 云盘内容审核（仅管理员 / 三级）。一二级（guest）上传的文件 status=pending，在这里通过或拒绝。
// GET  /api/drive/review                  -> { pending: [...] } 待审核文件列表
// POST /api/drive/review {path, action}   -> action=approve（置 approved + 对外可见）| reject（删文件并清 R2）
import { ensureDriveSchema, logEvent } from '../../_lib/db.js';
import { getRole } from '../../_lib/auth.js';
import { normPath } from '../../_lib/drive.js';

const forbid = () => Response.json({ error: '需要管理员权限' }, { status: 403 });

export async function onRequestGet({ request, env }) {
  if ((await getRole(request, env)) !== 'admin') return forbid();
  await ensureDriveSchema(env);
  const { results } = await env.DB.prepare(
    `SELECT path, name, parent, size, mime, created_at
     FROM drive_nodes WHERE is_dir = 0 AND status = 'pending'
     ORDER BY created_at ASC`
  ).all();
  return Response.json({ pending: results || [] });
}

export async function onRequestPost({ request, env }) {
  if ((await getRole(request, env)) !== 'admin') return forbid();
  await ensureDriveSchema(env);

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }

  const path = normPath(body?.path || '');
  const action = body?.action;
  if (!path) return Response.json({ error: '非法路径' }, { status: 400 });

  const node = await env.DB.prepare(
    'SELECT id, r2_key, status FROM drive_nodes WHERE path = ? AND is_dir = 0'
  ).bind(path).first();
  if (!node) return Response.json({ error: '文件不存在' }, { status: 404 });
  if (node.status !== 'pending') return Response.json({ error: '该文件不在待审核状态' }, { status: 409 });

  if (action === 'approve') {
    // 通过后置为正常文件并对一二级可见（管理员仍可随时改回「仅自己」）
    await env.DB.prepare("UPDATE drive_nodes SET status = 'approved', visible = 1 WHERE id = ?").bind(node.id).run();
    await logEvent(env, 'drive-approve', path);
    return Response.json({ ok: true });
  }

  if (action === 'reject') {
    if (node.r2_key) { try { await env.FILES.delete(node.r2_key); } catch {} }
    await env.DB.prepare('DELETE FROM drive_nodes WHERE id = ?').bind(node.id).run();
    await logEvent(env, 'drive-reject', path);
    return Response.json({ ok: true });
  }

  return Response.json({ error: '未知操作' }, { status: 400 });
}
