// POST /api/drive/upload?parent=<folder>&name=<filename>  body = 原始文件字节（流式直传 R2）
//   仅管理员（三级）。请求体直接是文件内容，元数据走 query，避免 multipart 缓冲大文件。
import { ensureDriveSchema } from '../../_lib/db.js';
import { getRole } from '../../_lib/auth.js';
import { normPath, cleanName, joinPath, guessMime, newR2Key } from '../../_lib/drive.js';

const MAX_BYTES = 100 * 1024 * 1024;   // 单文件上限 100MB（平台请求体上限附近）

export async function onRequestPost({ request, env }) {
  if ((await getRole(request, env)) !== 'admin') {
    return Response.json({ error: '只有管理员（三级）可以上传到云盘' }, { status: 403 });
  }
  if (!env.FILES) return Response.json({ error: 'R2 未配置' }, { status: 500 });
  await ensureDriveSchema(env);

  const url = new URL(request.url);
  const parent = normPath(url.searchParams.get('parent') || '');
  if (parent === null) return Response.json({ error: '非法的目标文件夹' }, { status: 400 });
  const name = cleanName(url.searchParams.get('name') || '');
  if (!name) return Response.json({ error: '非法的文件名' }, { status: 400 });

  // 目标文件夹须存在
  if (parent) {
    const dir = await env.DB.prepare('SELECT is_dir FROM drive_nodes WHERE path = ?').bind(parent).first();
    if (!dir || !dir.is_dir) return Response.json({ error: '目标文件夹不存在' }, { status: 404 });
  }

  const path = joinPath(parent, name);
  const exists = await env.DB.prepare('SELECT 1 FROM drive_nodes WHERE path = ?').bind(path).first();
  if (exists) return Response.json({ error: '同名文件/文件夹已存在' }, { status: 409 });

  const declaredLen = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declaredLen && declaredLen > MAX_BYTES) {
    return Response.json({ error: `文件太大（${(declaredLen / 1e6).toFixed(1)} MB），上限 100 MB` }, { status: 413 });
  }
  if (!request.body) return Response.json({ error: '没有文件内容' }, { status: 400 });

  const mime = guessMime(name);
  const r2Key = newR2Key();
  let obj;
  try {
    obj = await env.FILES.put(r2Key, request.body, { httpMetadata: { contentType: mime } });
  } catch (e) {
    return Response.json({ error: '上传到存储失败' }, { status: 500 });
  }
  const size = obj?.size ?? declaredLen ?? 0;
  if (size > MAX_BYTES) {
    try { await env.FILES.delete(r2Key); } catch {}
    return Response.json({ error: '文件太大，上限 100 MB' }, { status: 413 });
  }

  await env.DB.prepare(
    `INSERT INTO drive_nodes (parent, name, path, is_dir, size, mime, r2_key, created_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
  ).bind(parent, name, path, size, mime, r2Key, Date.now()).run();

  return Response.json({ ok: true, path, size });
}
