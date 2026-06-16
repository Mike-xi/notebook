// 云盘分享的公开取数端点（_middleware 放行，无需登录，凭 token + 可选密码鉴权）。
// GET /api/drive/shared?token=..&op=meta[&pw=]            -> {name,is_dir,requiresPassword,authorized,expired,size?}
// GET /api/drive/shared?token=..&op=list&sub=<rel>[&pw=]  -> 文件夹分享：列出子目录（sub 相对分享根）
// GET /api/drive/shared?token=..&op=download&sub=<rel>[&pw=] -> 下载文件（计数 + 下载上限校验）
import { ensureDriveSchema, ensureDriveSharesSchema } from '../../_lib/db.js';
import { hmacSign } from '../../_lib/auth.js';
import { normPath, joinPath, guessMime } from '../../_lib/drive.js';

const json = (o, s = 200) => Response.json(o, { status: s });

async function loadShare(env, token) {
  await ensureDriveSharesSchema(env);
  if (!token) return null;
  return env.DB.prepare(
    'SELECT token, path, is_dir, name, pwd, expires_at, max_dl, downloads FROM drive_shares WHERE token = ?'
  ).bind(token).first();
}

// 把分享内的相对子路径解析成绝对 path，并防止越出分享子树
function resolveSub(share, sub) {
  const rel = normPath(sub || '');
  if (rel === null) return null;
  const abs = rel ? joinPath(share.path, rel) : share.path;
  if (abs !== share.path && !abs.startsWith(share.path + '/')) return null;
  return abs;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  const op = url.searchParams.get('op') || 'meta';
  const share = await loadShare(env, token);
  if (!share) return json({ error: '分享不存在' }, 404);

  const expired = share.expires_at > 0 && Date.now() > share.expires_at;
  const requiresPassword = !!share.pwd;
  let authorized = !requiresPassword;
  if (requiresPassword) {
    const pw = url.searchParams.get('pw') || '';
    if (pw) authorized = (await hmacSign(env.AUTH_SECRET, 'dshare:' + pw)) === share.pwd;
  }

  if (op === 'meta') {
    return json({
      ok: true,
      name: share.name,
      is_dir: !!share.is_dir,
      requiresPassword,
      authorized: authorized && !expired,
      expired,
    });
  }

  if (expired) return json({ error: '分享已过期' }, 403);
  if (!authorized) return json({ error: '需要访问密码' }, 401);

  await ensureDriveSchema(env);

  if (op === 'list') {
    if (!share.is_dir) return json({ error: '这是文件分享' }, 400);
    const abs = resolveSub(share, url.searchParams.get('sub'));
    if (abs === null) return json({ error: '非法子路径' }, 400);
    const dir = abs === share.path
      ? { is_dir: 1 }
      : await env.DB.prepare('SELECT is_dir FROM drive_nodes WHERE path = ?').bind(abs).first();
    if (!dir || !dir.is_dir) return json({ error: '文件夹不存在' }, 404);

    const { results } = await env.DB.prepare(
      `SELECT name, path, is_dir, size, mime, created_at FROM drive_nodes
       WHERE parent = ? ORDER BY is_dir DESC, name COLLATE NOCASE ASC`
    ).bind(abs).all();
    const items = (results || []).map((r) => ({
      name: r.name,
      sub: r.path.slice(share.path.length + 1),   // 相对分享根
      is_dir: !!r.is_dir,
      size: r.size,
      created_at: r.created_at,
    }));
    return json({ ok: true, name: share.name, sub: abs === share.path ? '' : abs.slice(share.path.length + 1), items });
  }

  if (op === 'download') {
    const abs = resolveSub(share, url.searchParams.get('sub'));
    if (abs === null) return new Response('bad sub', { status: 400 });
    const node = await env.DB.prepare('SELECT name, is_dir, r2_key FROM drive_nodes WHERE path = ?').bind(abs).first();
    if (!node || node.is_dir) return new Response('not found', { status: 404 });

    // inline=1 为在线预览（浏览），不计入「下载次数」也不受下载上限限制；只有真正下载才计数/限流
    const isInline = url.searchParams.get('inline') === '1';
    if (!isInline && share.max_dl > 0 && share.downloads >= share.max_dl) {
      return new Response('下载次数已达上限', { status: 403 });
    }

    let obj;
    try { obj = await env.FILES.get(node.r2_key); } catch { obj = null; }
    if (!obj) return new Response('not found', { status: 404 });

    // 计数 +1（仅真正下载；尽力而为，不阻塞）
    if (!isInline) {
      try { await env.DB.prepare('UPDATE drive_shares SET downloads = downloads + 1 WHERE token = ?').bind(token).run(); } catch {}
    }

    const headers = new Headers();
    headers.set('Content-Type', node.mime || guessMime(node.name));
    headers.set('Content-Length', String(obj.size));
    headers.set('Cache-Control', 'private, max-age=0, must-revalidate');
    const disp = url.searchParams.get('inline') === '1' ? 'inline' : 'attachment';
    headers.set('Content-Disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(node.name)}`);
    return new Response(obj.body, { status: 200, headers });
  }

  return json({ error: '未知操作' }, 400);
}
