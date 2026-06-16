// 云盘分享管理（仅管理员 / 三级）。有状态：存 drive_shares 表，可撤销/计数。
// POST   /api/drive/share  {path, expiresDays?, password?, maxDownloads?} -> {token, url}
// GET    /api/drive/share                                                 -> {shares:[...]}（不含密码哈希）
// DELETE /api/drive/share  {token}                                        -> 撤销
import { ensureDriveSchema, ensureDriveSharesSchema, logEvent } from '../../_lib/db.js';
import { getRole, hmacSign } from '../../_lib/auth.js';
import { normPath } from '../../_lib/drive.js';

const requireAdmin = async (request, env) => (await getRole(request, env)) === 'admin';
const forbid = () => Response.json({ error: '只有管理员（三级）可以管理分享' }, { status: 403 });

function randToken() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost({ request, env }) {
  if (!(await requireAdmin(request, env))) return forbid();
  await ensureDriveSchema(env);
  await ensureDriveSharesSchema(env);

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }

  const path = normPath(body?.path || '');
  if (!path) return Response.json({ error: '非法路径' }, { status: 400 });
  const node = await env.DB.prepare('SELECT is_dir, name FROM drive_nodes WHERE path = ?').bind(path).first();
  if (!node) return Response.json({ error: '对象不存在' }, { status: 404 });

  const days = Math.max(0, Math.min(parseInt(body?.expiresDays, 10) || 0, 3650));
  const expires_at = days > 0 ? Date.now() + days * 86400000 : 0;
  const maxDl = Math.max(0, Math.min(parseInt(body?.maxDownloads, 10) || 0, 100000));
  const pw = typeof body?.password === 'string' ? body.password.trim() : '';
  const pwdHash = pw ? await hmacSign(env.AUTH_SECRET, 'dshare:' + pw) : '';

  const token = randToken();
  await env.DB.prepare(
    `INSERT INTO drive_shares (token, path, is_dir, name, pwd, expires_at, max_dl, downloads, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).bind(token, path, node.is_dir ? 1 : 0, node.name, pwdHash, expires_at, maxDl, Date.now()).run();

  await logEvent(env, 'drive-share', node.name);
  return Response.json({ ok: true, token, url: `/drive-share?t=${token}` });
}

export async function onRequestGet({ request, env }) {
  if (!(await requireAdmin(request, env))) return forbid();
  await ensureDriveSharesSchema(env);
  const { results } = await env.DB.prepare(
    `SELECT token, path, is_dir, name, pwd, expires_at, max_dl, downloads, created_at
     FROM drive_shares ORDER BY created_at DESC`
  ).all();
  const now = Date.now();
  const shares = (results || []).map((r) => ({
    token: r.token,
    path: r.path,
    is_dir: !!r.is_dir,
    name: r.name,
    hasPassword: !!r.pwd,
    expires_at: r.expires_at,
    expired: r.expires_at > 0 && now > r.expires_at,
    max_dl: r.max_dl,
    downloads: r.downloads,
    used_up: r.max_dl > 0 && r.downloads >= r.max_dl,
    created_at: r.created_at,
    url: `/drive-share?t=${r.token}`,
  }));
  return Response.json({ shares });
}

export async function onRequestDelete({ request, env }) {
  if (!(await requireAdmin(request, env))) return forbid();
  await ensureDriveSharesSchema(env);
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }
  const token = String(body?.token || '');
  if (!token) return Response.json({ error: '缺少 token' }, { status: 400 });
  await env.DB.prepare('DELETE FROM drive_shares WHERE token = ?').bind(token).run();
  return Response.json({ ok: true });
}
