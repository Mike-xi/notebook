// POST /api/drive/op  {action, ...}  -> 云盘写操作（仅管理员 / 三级）
//   action=mkdir  {parent, name}
//   action=rename {path, newName}      —— 原地改名（文件夹连同子项一起改路径）
//   action=delete {path}               —— 文件夹递归删除，连同 R2 字节
import { ensureDriveSchema } from '../../_lib/db.js';
import { getRole } from '../../_lib/auth.js';
import { normPath, cleanName, joinPath, parentOf } from '../../_lib/drive.js';

const bad = (msg, code = 400) => Response.json({ error: msg }, { status: code });

export async function onRequestPost({ request, env }) {
  if ((await getRole(request, env)) !== 'admin') {
    return bad('只有管理员（三级）可以管理云盘', 403);
  }
  await ensureDriveSchema(env);

  let body;
  try { body = await request.json(); }
  catch { return bad('请求格式错误'); }
  const action = body?.action;

  if (action === 'mkdir') return mkdir(env, body);
  if (action === 'rename') return rename(env, body);
  if (action === 'delete') return remove(env, body);
  return bad('未知操作');
}

async function mkdir(env, body) {
  const parent = normPath(body?.parent || '');
  if (parent === null) return bad('非法的上级文件夹');
  const name = cleanName(body?.name || '');
  if (!name) return bad('非法的文件夹名');

  if (parent) {
    const dir = await env.DB.prepare('SELECT is_dir FROM drive_nodes WHERE path = ?').bind(parent).first();
    if (!dir || !dir.is_dir) return bad('上级文件夹不存在', 404);
  }
  const path = joinPath(parent, name);
  const exists = await env.DB.prepare('SELECT 1 FROM drive_nodes WHERE path = ?').bind(path).first();
  if (exists) return bad('同名文件/文件夹已存在', 409);

  await env.DB.prepare(
    `INSERT INTO drive_nodes (parent, name, path, is_dir, size, mime, r2_key, created_at)
     VALUES (?, ?, ?, 1, 0, '', '', ?)`
  ).bind(parent, name, path, Date.now()).run();
  return Response.json({ ok: true, path });
}

async function rename(env, body) {
  const path = normPath(body?.path || '');
  if (!path) return bad('非法路径');
  const newName = cleanName(body?.newName || '');
  if (!newName) return bad('非法的新名称');

  const node = await env.DB.prepare('SELECT id, is_dir FROM drive_nodes WHERE path = ?').bind(path).first();
  if (!node) return bad('对象不存在', 404);

  const parent = parentOf(path);
  const newPath = joinPath(parent, newName);
  if (newPath === path) return Response.json({ ok: true, path });

  const clash = await env.DB.prepare('SELECT 1 FROM drive_nodes WHERE path = ?').bind(newPath).first();
  if (clash) return bad('同级已存在同名项', 409);

  if (!node.is_dir) {
    await env.DB.prepare('UPDATE drive_nodes SET path = ?, name = ? WHERE id = ?').bind(newPath, newName, node.id).run();
    return Response.json({ ok: true, path: newPath });
  }

  // 文件夹：改名后所有子孙的 path/parent 前缀同步替换（用 substr 精确匹配，避开 LIKE 通配符问题）
  const prefix = path + '/';
  const { results } = await env.DB.prepare(
    'SELECT id, path, parent FROM drive_nodes WHERE substr(path, 1, ?) = ?'
  ).bind(prefix.length, prefix).all();

  const stmts = [
    env.DB.prepare('UPDATE drive_nodes SET path = ?, name = ? WHERE id = ?').bind(newPath, newName, node.id),
  ];
  for (const r of (results || [])) {
    const rest = r.path.slice(path.length);              // 形如 /sub/file
    const np = newPath + rest;
    const newParent = r.parent === path ? newPath : newPath + r.parent.slice(path.length);
    stmts.push(env.DB.prepare('UPDATE drive_nodes SET path = ?, parent = ? WHERE id = ?').bind(np, newParent, r.id));
  }
  await env.DB.batch(stmts);
  return Response.json({ ok: true, path: newPath });
}

async function remove(env, body) {
  const path = normPath(body?.path || '');
  if (!path) return bad('非法路径');

  const node = await env.DB.prepare('SELECT id, is_dir, r2_key FROM drive_nodes WHERE path = ?').bind(path).first();
  if (!node) return bad('对象不存在', 404);

  if (!node.is_dir) {
    if (node.r2_key) { try { await env.FILES.delete(node.r2_key); } catch {} }
    await env.DB.prepare('DELETE FROM drive_nodes WHERE id = ?').bind(node.id).run();
    return Response.json({ ok: true });
  }

  // 文件夹：收集子孙文件的 R2 key 一并删除，再删所有节点
  const prefix = path + '/';
  const { results } = await env.DB.prepare(
    'SELECT r2_key FROM drive_nodes WHERE is_dir = 0 AND (path = ? OR substr(path, 1, ?) = ?)'
  ).bind(path, prefix.length, prefix).all();
  const keys = (results || []).map((r) => r.r2_key).filter(Boolean);
  if (keys.length) { try { await env.FILES.delete(keys); } catch {} }

  await env.DB.prepare('DELETE FROM drive_nodes WHERE path = ? OR substr(path, 1, ?) = ?')
    .bind(path, prefix.length, prefix).run();
  return Response.json({ ok: true });
}
