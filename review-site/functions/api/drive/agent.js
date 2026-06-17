// 公共云盘的「Agent API」：用固定 API 密钥（env.DRIVE_API_KEY）鉴权，供脚本/agent 直接管文件。
//   鉴权：请求头 X-API-Key: <DRIVE_API_KEY>（或 Authorization: Bearer <key>）；管理员 Cookie 亦可。
//   list   : GET  /api/drive/agent?action=list&parent=<dir>
//   upload : POST /api/drive/agent?action=upload&parent=<dir>&name=<file>[&visible=1]  body=原始字节
//   mkdir  : POST /api/drive/agent?action=mkdir&parent=<dir>&name=<folder>
//   delete : POST /api/drive/agent?action=delete&path=<path>     （文件夹递归删）
//   _middleware.js 已放行 /api/drive/agent，由本函数自行用密钥鉴权。
import { ensureDriveSchema } from '../../_lib/db.js';
import { getRole } from '../../_lib/auth.js';
import { normPath, cleanName, joinPath, guessMime, newR2Key } from '../../_lib/drive.js';

const MAX_BYTES = 100 * 1024 * 1024;
const DRIVE_QUOTA = 8 * 1024 * 1024 * 1024;
const j = (data, status = 200) => Response.json(data, { status });

function keyOk(request, env) {
  const k = request.headers.get('X-API-Key') ||
    (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return !!(env.DRIVE_API_KEY && k && k === env.DRIVE_API_KEY);
}

async function driveUsage(env) {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(size),0) AS total FROM drive_nodes WHERE is_dir = 0').first();
  return r?.total || 0;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.FILES) return j({ error: 'R2 未配置' }, 500);
  if (!(keyOk(request, env) || (await getRole(request, env)) === 'admin')) {
    return j({ error: '无效的 API 密钥' }, 401);
  }
  await ensureDriveSchema(env);

  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  try {
    if (action === 'list') return await list(env, url);
    if (action === 'upload') return await upload(env, request, url);
    if (action === 'mkdir') return await mkdir(env, url);
    if (action === 'delete') return await remove(env, url);
    return j({ error: '未知操作（action=list|upload|mkdir|delete）' }, 400);
  } catch (e) {
    return j({ error: '服务端错误：' + (e && e.message ? e.message : e) }, 500);
  }
}

async function list(env, url) {
  const parent = normPath(url.searchParams.get('parent') || '');
  if (parent === null) return j({ error: '非法路径' }, 400);
  const { results } = await env.DB.prepare(
    'SELECT name, path, is_dir, size, mime, visible, status, created_at FROM drive_nodes WHERE parent = ? ORDER BY is_dir DESC, name'
  ).bind(parent).all();
  const items = (results || []).map((r) => ({
    name: r.name, path: r.path, is_dir: !!r.is_dir, size: r.size,
    mime: r.mime, visible: !!r.visible, status: r.status, created_at: r.created_at,
  }));
  return j({ ok: true, parent, items, usage: await driveUsage(env), quota: DRIVE_QUOTA });
}

async function upload(env, request, url) {
  const parent = normPath(url.searchParams.get('parent') || '');
  if (parent === null) return j({ error: '非法的目标文件夹' }, 400);
  const name = cleanName(url.searchParams.get('name') || '');
  if (!name) return j({ error: '非法的文件名' }, 400);
  const visible = url.searchParams.get('visible') === '1' ? 1 : 0;

  if (parent) {
    const dir = await env.DB.prepare('SELECT is_dir FROM drive_nodes WHERE path = ?').bind(parent).first();
    if (!dir || !dir.is_dir) return j({ error: '目标文件夹不存在' }, 404);
  }
  const path = joinPath(parent, name);
  if (await env.DB.prepare('SELECT 1 FROM drive_nodes WHERE path = ?').bind(path).first()) {
    return j({ error: '同名文件/文件夹已存在' }, 409);
  }
  if (!request.body) return j({ error: '没有文件内容' }, 400);

  const declaredLen = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declaredLen && declaredLen > MAX_BYTES) return j({ error: '文件太大，上限 100 MB' }, 413);
  const used = await driveUsage(env);
  if (declaredLen && used + declaredLen > DRIVE_QUOTA) {
    return j({ error: `公共云盘空间不足（已用 ${(used / 1073741824).toFixed(2)} GB / 上限 8 GB）` }, 413);
  }

  const mime = guessMime(name);
  const r2Key = newR2Key();
  const hasLen = request.headers.get('Content-Length') != null;
  const obj = await env.FILES.put(r2Key, hasLen ? request.body : await request.arrayBuffer(), {
    httpMetadata: { contentType: mime },
  });
  const size = obj?.size ?? declaredLen ?? 0;
  if (size > MAX_BYTES || used + size > DRIVE_QUOTA) {
    try { await env.FILES.delete(r2Key); } catch {}
    return j({ error: size > MAX_BYTES ? '文件太大，上限 100 MB' : '公共云盘空间不足（上限 8 GB）' }, 413);
  }

  await env.DB.prepare(
    `INSERT INTO drive_nodes (parent, name, path, is_dir, size, mime, r2_key, visible, status, created_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'approved', ?)`
  ).bind(parent, name, path, size, mime, r2Key, visible, Date.now()).run();
  return j({ ok: true, path, size, visible: !!visible });
}

async function mkdir(env, url) {
  const parent = normPath(url.searchParams.get('parent') || '');
  if (parent === null) return j({ error: '非法的上级文件夹' }, 400);
  const name = cleanName(url.searchParams.get('name') || '');
  if (!name) return j({ error: '非法的文件夹名' }, 400);
  if (parent) {
    const dir = await env.DB.prepare('SELECT is_dir FROM drive_nodes WHERE path = ?').bind(parent).first();
    if (!dir || !dir.is_dir) return j({ error: '上级文件夹不存在' }, 404);
  }
  const path = joinPath(parent, name);
  if (await env.DB.prepare('SELECT 1 FROM drive_nodes WHERE path = ?').bind(path).first()) {
    return j({ error: '同名文件/文件夹已存在' }, 409);
  }
  await env.DB.prepare(
    `INSERT INTO drive_nodes (parent, name, path, is_dir, size, mime, r2_key, visible, status, created_at)
     VALUES (?, ?, ?, 1, 0, '', '', 1, 'approved', ?)`
  ).bind(parent, name, path, Date.now()).run();
  return j({ ok: true, path });
}

async function remove(env, url) {
  const path = normPath(url.searchParams.get('path') || '');
  if (!path) return j({ error: '非法路径' }, 400);
  const node = await env.DB.prepare('SELECT id, is_dir, r2_key FROM drive_nodes WHERE path = ?').bind(path).first();
  if (!node) return j({ error: '对象不存在' }, 404);

  if (!node.is_dir) {
    if (node.r2_key) { try { await env.FILES.delete(node.r2_key); } catch {} }
    await env.DB.prepare('DELETE FROM drive_nodes WHERE id = ?').bind(node.id).run();
    return j({ ok: true });
  }
  const prefix = path + '/';
  const { results } = await env.DB.prepare(
    'SELECT r2_key FROM drive_nodes WHERE is_dir = 0 AND (path = ? OR substr(path, 1, ?) = ?)'
  ).bind(path, prefix.length, prefix).all();
  const keys = (results || []).map((r) => r.r2_key).filter(Boolean);
  if (keys.length) { try { await env.FILES.delete(keys); } catch {} }
  await env.DB.prepare('DELETE FROM drive_nodes WHERE path = ? OR substr(path, 1, ?) = ?')
    .bind(path, prefix.length, prefix).run();
  return j({ ok: true });
}
