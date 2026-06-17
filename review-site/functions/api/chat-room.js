// 大群聊（所有登录用户共用一个房间，轮询式，无需 WebSocket）。
// GET  /api/chat-room?after=<id>&uid=<client_id>  -> { messages:[...], me:{ip_tag} }
//   after 省略时返回最近一批；带 after 时只返回 id>after 的增量（前端每数秒轮询一次）。
// POST /api/chat-room { text, nick, client_id }     -> { ok, message }
// 用 client_id（前端生成、存 localStorage）区分用户；ip_tag 是 IP 的短哈希（同网标识+配色，不存明文）。
// 鉴权由 _middleware.js 统一处理（仅有站点密码的人能进）。
import { ensureChatRoomSchema, pruneChatRoom } from '../_lib/db.js';

const MAX_TEXT = 800;
const MAX_NICK = 20;
const MIN_INTERVAL_MS = 600;     // 同一 client 两条消息的最小间隔（防刷屏）

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const clean = (s, max) => str(s).replace(/[\x00-\x1f\x7f]/g, "").slice(0, max);

// IP 短哈希：SHA-256(ip + AUTH_SECRET) 取前 6 位 hex。盐用站点密钥，避免被反推。
async function ipTag(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '0.0.0.0';
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + '|' + (env.AUTH_SECRET || 'salt')));
    return Array.from(new Uint8Array(buf)).slice(0, 3).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return '000000'; }
}

export async function onRequestGet({ request, env }) {
  await ensureChatRoomSchema(env);
  const url = new URL(request.url);
  const after = parseInt(url.searchParams.get('after'), 10);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 60, 1), 200);

  let rows;
  if (Number.isFinite(after) && after > 0) {
    rows = (await env.DB.prepare(
      'SELECT id, client_id, nick, ip_tag, text, created_at FROM chat_room WHERE id > ? ORDER BY id ASC LIMIT ?'
    ).bind(after, limit).all()).results || [];
  } else {
    // 最近一批，再翻正成时间升序
    const desc = (await env.DB.prepare(
      'SELECT id, client_id, nick, ip_tag, text, created_at FROM chat_room ORDER BY id DESC LIMIT ?'
    ).bind(limit).all()).results || [];
    rows = desc.reverse();
  }

  return Response.json({ messages: rows, me: { ip_tag: await ipTag(request, env) }, now: Date.now() });
}

export async function onRequestPost({ request, env }) {
  await ensureChatRoomSchema(env);

  let b;
  try { b = await request.json(); } catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }

  const text = clean(b?.text, MAX_TEXT);
  if (!text) return Response.json({ error: '消息不能为空' }, { status: 400 });

  let clientId = str(b?.client_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  const tag = await ipTag(request, env);
  if (!clientId) clientId = 'ip-' + tag;              // 没带 client_id 就退化为按 IP 区分
  const nick = clean(b?.nick, MAX_NICK) || ('访客-' + clientId.slice(-4));

  // 防刷：同一 client 间隔过短，或与上一条完全相同，则拒绝
  const last = await env.DB.prepare(
    'SELECT text, created_at FROM chat_room WHERE client_id = ? ORDER BY id DESC LIMIT 1'
  ).bind(clientId).first();
  const now = Date.now();
  if (last) {
    if (now - last.created_at < MIN_INTERVAL_MS) return Response.json({ error: '发得太快了，慢一点～' }, { status: 429 });
    if (last.text === text && now - last.created_at < 5000) return Response.json({ error: '别重复刷屏哦' }, { status: 429 });
  }

  const res = await env.DB.prepare(
    'INSERT INTO chat_room (client_id, nick, ip_tag, text, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(clientId, nick, tag, text, now).run();

  await pruneChatRoom(env);

  return Response.json({
    ok: true,
    message: { id: res.meta?.last_row_id, client_id: clientId, nick, ip_tag: tag, text, created_at: now },
  });
}
