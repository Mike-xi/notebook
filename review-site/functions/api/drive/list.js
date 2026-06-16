// GET /api/drive/list?path=<folder>  -> 列出某文件夹下的内容（任何登录用户可读）
// 返回 { path, breadcrumb:[{name,path}], items:[{name,path,is_dir,size,mime,created_at}] }
import { ensureDriveSchema } from '../../_lib/db.js';
import { normPath, breadcrumb } from '../../_lib/drive.js';

export async function onRequestGet({ request, env }) {
  await ensureDriveSchema(env);
  const url = new URL(request.url);
  const path = normPath(url.searchParams.get('path') || '');
  if (path === null) return Response.json({ error: '非法路径' }, { status: 400 });

  // 校验目标文件夹存在（根 '' 总是存在）
  if (path) {
    const dir = await env.DB.prepare('SELECT is_dir FROM drive_nodes WHERE path = ?').bind(path).first();
    if (!dir) return Response.json({ error: '文件夹不存在' }, { status: 404 });
    if (!dir.is_dir) return Response.json({ error: '不是文件夹' }, { status: 400 });
  }

  const { results } = await env.DB.prepare(
    `SELECT name, path, is_dir, size, mime, created_at
     FROM drive_nodes WHERE parent = ?
     ORDER BY is_dir DESC, name COLLATE NOCASE ASC`
  ).bind(path).all();

  // 全盘已用容量与文件数（个人规模，单次聚合即可）
  const usage = await env.DB.prepare(
    'SELECT COALESCE(SUM(size), 0) AS total, COUNT(*) AS files FROM drive_nodes WHERE is_dir = 0'
  ).first();

  return Response.json({
    path,
    breadcrumb: breadcrumb(path),
    usage: { total: usage?.total || 0, files: usage?.files || 0 },
    items: (results || []).map((r) => ({
      name: r.name,
      path: r.path,
      is_dir: !!r.is_dir,
      size: r.size,
      mime: r.mime,
      created_at: r.created_at,
    })),
  });
}
