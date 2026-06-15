// 象棋联机房间（单密码站点内：知道密码的人都能登录并加入同一房间对弈）。
// 状态存 D1 表 xiangqi_rooms，客户端 ~1.3s 轮询。走子合法/回合/将死全部服务端权威校验。
//   GET  /api/xiangqi?room=CODE&clientId=ID            -> 房间状态（不存在则创建空房）
//   POST /api/xiangqi {room, clientId, action, ...}     -> action: create{side} / join / move{mv} / reset / resign / leave
// 鉴权由 _middleware.js 统一处理（仅登录用户可访问 /api/*）。
import { initialBoard, isLegalMove, applyMove, outcome, enemy } from '../_lib/xiangqi-core.js';

const json = (o, status = 200) => Response.json(o, { status });
const clean = (s, n = 64) => (typeof s === 'string' ? s : '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, n);
const safeJSON = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

let ready = false;
async function ensureSchema(env) {
  if (ready) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS xiangqi_rooms (
       id TEXT PRIMARY KEY,
       state TEXT NOT NULL,
       red TEXT, black TEXT,
       updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`
  ).run();
  ready = true;
}
const freshState = () => ({ board: initialBoard(), turn: 'r', last: null, winner: null });
async function getRow(env, id) { return env.DB.prepare('SELECT * FROM xiangqi_rooms WHERE id=?').bind(id).first(); }
async function saveState(env, id, st) { await env.DB.prepare('UPDATE xiangqi_rooms SET state=?, updated_at=? WHERE id=?').bind(JSON.stringify(st), Date.now(), id).run(); }

function seatOf(row, clientId) {
  if (clientId && row.red === clientId) return 'r';
  if (clientId && row.black === clientId) return 'b';
  return 'spectator';
}
function view(row, clientId) {
  const st = safeJSON(row.state, freshState());
  return {
    room: row.id, board: st.board, turn: st.turn, last: st.last || null, winner: st.winner || null,
    seat: seatOf(row, clientId), bothSeated: !!(row.red && row.black),
    redTaken: !!row.red, blackTaken: !!row.black,
  };
}

export async function onRequestGet({ request, env }) {
  await ensureSchema(env);
  const url = new URL(request.url);
  const id = clean(url.searchParams.get('room'));
  const clientId = clean(url.searchParams.get('clientId'));
  if (!id) return json({ error: 'missing room' }, 400);
  const row = await getRow(env, id);
  if (!row) return json({ error: 'no room', notFound: true }, 404);
  if (Math.random() < 0.05) { try { await env.DB.prepare('DELETE FROM xiangqi_rooms WHERE updated_at < ?').bind(Date.now() - 2 * 864e5).run(); } catch {} }
  return json(view(row, clientId));
}

export async function onRequestPost({ request, env }) {
  await ensureSchema(env);
  let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const id = clean(body?.room);
  const clientId = clean(body?.clientId);
  const action = clean(body?.action, 16);
  if (!id || !clientId || !action) return json({ error: 'missing params' }, 400);
  const now = Date.now();

  if (action === 'create') {
    let row = await getRow(env, id);
    if (!row) {
      const side = body.side === 'b' ? 'black' : 'red';
      await env.DB.prepare('INSERT INTO xiangqi_rooms (id, state, red, black, updated_at, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .bind(id, JSON.stringify(freshState()), side === 'red' ? clientId : null, side === 'black' ? clientId : null, now, now).run();
      return json(view(await getRow(env, id), clientId));
    }
    // 房间已存在 → 当作加入
    return joinRoom(env, row, id, clientId);
  }

  let row = await getRow(env, id);
  if (!row) return json({ error: 'no room', notFound: true }, 404);

  if (action === 'join') return joinRoom(env, row, id, clientId);

  if (action === 'leave') {
    for (const s of ['red', 'black']) if (row[s] === clientId) await env.DB.prepare(`UPDATE xiangqi_rooms SET ${s}=NULL, updated_at=? WHERE id=?`).bind(now, id).run();
    return json(view(await getRow(env, id), clientId));
  }

  if (action === 'reset') {
    if (seatOf(row, clientId) === 'spectator') return json({ error: 'not a player', ...view(row, clientId) }, 403);
    await saveState(env, id, freshState());
    return json(view(await getRow(env, id), clientId));
  }

  if (action === 'resign') {
    const seat = seatOf(row, clientId);
    if (seat === 'spectator') return json({ error: 'not a player', ...view(row, clientId) }, 403);
    const st = safeJSON(row.state, freshState());
    if (!st.winner) { st.winner = enemy(seat); await saveState(env, id, st); }
    return json(view(await getRow(env, id), clientId));
  }

  if (action === 'move') {
    const seat = seatOf(row, clientId);
    const st = safeJSON(row.state, freshState());
    if (st.winner) return json({ error: 'game over', ...view(row, clientId) }, 409);
    if (seat !== st.turn) return json({ error: 'not your turn', ...view(row, clientId) }, 409);
    const mv = Array.isArray(body.mv) ? body.mv.map((x) => x | 0) : null;
    if (!mv || mv.length < 4) return json({ error: 'bad move' }, 400);
    if (!isLegalMove({ board: st.board, turn: st.turn }, mv)) return json({ error: 'illegal move', ...view(row, clientId) }, 409);
    const ns = applyMove({ board: st.board, turn: st.turn }, mv);
    const next = { board: ns.board, turn: ns.turn, last: mv, winner: outcome(ns) };
    await saveState(env, id, next);
    return json(view(await getRow(env, id), clientId));
  }

  return json({ error: 'unknown action' }, 400);
}

async function joinRoom(env, row, id, clientId) {
  const seat = seatOf(row, clientId);
  if (seat !== 'spectator') return json(view(row, clientId)); // 已落座，幂等
  const now = Date.now();
  if (!row.red) await env.DB.prepare('UPDATE xiangqi_rooms SET red=?, updated_at=? WHERE id=?').bind(clientId, now, id).run();
  else if (!row.black) await env.DB.prepare('UPDATE xiangqi_rooms SET black=?, updated_at=? WHERE id=?').bind(clientId, now, id).run();
  // 两座都满 → 观战
  return json(view(await getRow(env, id), clientId));
}
