// 留言板（公共论坛）：自选昵称留言、所有登录用户可见。
// GET  /api/board?after=<id>          -> { messages:[...], me:{ admin }, now }
//   普通用户：每条 {id,nick,body,created_at}；管理员：额外带 {ip, ua}。
//   after 省略=返回最近一批（时间升序）；带 after=只返回 id>after 的增量（前端轮询）。
// POST /api/board { nick, body }       -> { ok, message }   （服务端记录真实 IP + UA）
// POST /api/board { action:'delete', id }  -> { ok }        （仅管理员删除）
// 鉴权由 _middleware.js 统一拦在登录后，这里再按角色决定是否返回 IP/UA。
import { ensureBoardSchema, pruneBoard } from '../_lib/db.js';
import { getRole } from '../_lib/auth.js';

const MAX_BODY = 1000;
const MAX_NICK = 24;
const MIN_INTERVAL_MS = 800;   // 同一 IP 两条留言的最小间隔（防刷屏）

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const clean = (s, max) => str(s).replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
const clientIp = (request) =>
  request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '0.0.0.0';

function shape(row, admin) {
  const m = { id: row.id, nick: row.nick, body: row.body, created_at: row.created_at };
  if (admin) { m.ip = row.ip; m.ua = row.ua; }
  return m;
}

export async function onRequestGet({ request, env }) {
  await ensureBoardSchema(env);
  const admin = (await getRole(request, env)) === 'admin';
  const url = new URL(request.url);
  const after = parseInt(url.searchParams.get('after'), 10);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 80, 1), 200);

  let rows;
  if (Number.isFinite(after) && after > 0) {
    rows = (await env.DB.prepare(
      'SELECT id, nick, body, ip, ua, created_at FROM board_messages WHERE id > ? ORDER BY id ASC LIMIT ?'
    ).bind(after, limit).all()).results || [];
  } else {
    const desc = (await env.DB.prepare(
      'SELECT id, nick, body, ip, ua, created_at FROM board_messages ORDER BY id DESC LIMIT ?'
    ).bind(limit).all()).results || [];
    rows = desc.reverse();
  }

  return Response.json({ messages: rows.map((r) => shape(r, admin)), me: { admin }, now: Date.now() });
}

export async function onRequestPost({ request, env }) {
  await ensureBoardSchema(env);
  const role = await getRole(request, env);

  let b;
  try { b = await request.json(); } catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }

  // 管理员删除
  if (b && b.action === 'delete') {
    if (role !== 'admin') return Response.json({ error: '无权限' }, { status: 403 });
    const id = parseInt(b.id, 10);
    if (!Number.isFinite(id)) return Response.json({ error: 'bad id' }, { status: 400 });
    await env.DB.prepare('DELETE FROM board_messages WHERE id = ?').bind(id).run();
    return Response.json({ ok: true });
  }

  const body = clean(b?.body, MAX_BODY);
  if (!body) return Response.json({ error: '留言不能为空' }, { status: 400 });
  const nick = clean(b?.nick, MAX_NICK) || '匿名';

  const ip = clientIp(request);
  const ua = clean(request.headers.get('User-Agent'), 400);
  const now = Date.now();

  // 防刷：同一 IP 间隔过短，或与上一条完全相同
  const last = await env.DB.prepare(
    'SELECT body, created_at FROM board_messages WHERE ip = ? ORDER BY id DESC LIMIT 1'
  ).bind(ip).first();
  if (last) {
    if (now - last.created_at < MIN_INTERVAL_MS) return Response.json({ error: '发得太快了，慢一点～' }, { status: 429 });
    if (last.body === body && now - last.created_at < 5000) return Response.json({ error: '别重复刷屏哦' }, { status: 429 });
  }

  const res = await env.DB.prepare(
    'INSERT INTO board_messages (nick, body, ip, ua, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(nick, body, ip, ua, now).run();

  await pruneBoard(env);

  const row = { id: res.meta?.last_row_id, nick, body, ip, ua, created_at: now };
  return Response.json({ ok: true, message: shape(row, role === 'admin') });
}
