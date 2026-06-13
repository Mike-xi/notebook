// 五子棋联机房间（单密码站点内：知道密码的人都能登录并加入同一房间对弈）。
// 状态存 D1 表 gomoku_rooms，客户端 ~1.2s 轮询。无需 Durable Objects / WebSocket。
//   GET  /api/gomoku?room=CODE&clientId=ID            -> 房间状态（不存在则创建空房）
//   POST /api/gomoku {room, clientId, action, ...}     -> action: join{side} / move{x,y} / reset / leave{side}
// 鉴权由 _middleware.js 统一处理（仅登录用户可访问 /api/*）。
const SIZE = 15;

let ready = false;
async function ensureSchema(env) {
  if (ready) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS gomoku_rooms (
       id          TEXT PRIMARY KEY,
       size        INTEGER NOT NULL DEFAULT 15,
       moves       TEXT NOT NULL DEFAULT '[]',
       turn        INTEGER NOT NULL DEFAULT 1,
       black       TEXT,
       white       TEXT,
       winner      INTEGER NOT NULL DEFAULT 0,
       win_line    TEXT,
       updated_at  INTEGER NOT NULL,
       created_at  INTEGER NOT NULL
     )`
  ).run();
  ready = true;
}

const json = (o, status = 200) => Response.json(o, { status });
const clean = (s, n = 64) => (typeof s === 'string' ? s : '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, n);

function seatOf(row, clientId) {
  if (clientId && row.black === clientId) return 'black';
  if (clientId && row.white === clientId) return 'white';
  return 'spectator';
}
function stateOf(row, clientId) {
  return {
    room: row.id,
    size: row.size || SIZE,
    moves: safeMoves(row.moves),
    turn: row.turn,
    winner: row.winner,
    winLine: row.win_line ? safeJSON(row.win_line, null) : null,
    blackTaken: !!row.black,
    whiteTaken: !!row.white,
    you: seatOf(row, clientId),
    updated_at: row.updated_at,
  };
}
function safeJSON(s, d) { try { return JSON.parse(s); } catch { return d; } }
function safeMoves(s) { const a = safeJSON(s, []); return Array.isArray(a) ? a : []; }

async function getRow(env, id) {
  return env.DB.prepare('SELECT * FROM gomoku_rooms WHERE id = ?').bind(id).first();
}
async function createRoom(env, id) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO gomoku_rooms (id, size, moves, turn, winner, updated_at, created_at)
     VALUES (?, ?, '[]', 1, 0, ?, ?) ON CONFLICT(id) DO NOTHING`
  ).bind(id, SIZE, now, now).run();
  return getRow(env, id);
}

// 从最后一手判断是否成五；返回连成的 5 个点或 null
function checkWin(board, size, x, y, color) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of dirs) {
    const line = [[x, y]];
    for (let s = 1; s < 5; s++) { const nx = x + dx * s, ny = y + dy * s; if (nx < 0 || ny < 0 || nx >= size || ny >= size || board[ny][nx] !== color) break; line.push([nx, ny]); }
    for (let s = 1; s < 5; s++) { const nx = x - dx * s, ny = y - dy * s; if (nx < 0 || ny < 0 || nx >= size || ny >= size || board[ny][nx] !== color) break; line.unshift([nx, ny]); }
    if (line.length >= 5) return line.slice(0, 5);
  }
  return null;
}
function buildBoard(moves, size) {
  const b = Array.from({ length: size }, () => new Array(size).fill(0));
  for (const m of moves) { const [x, y, c] = m; if (x >= 0 && y >= 0 && x < size && y < size) b[y][x] = c; }
  return b;
}

export async function onRequestGet({ request, env }) {
  await ensureSchema(env);
  const url = new URL(request.url);
  const id = clean(url.searchParams.get('room'));
  const clientId = clean(url.searchParams.get('clientId'));
  if (!id) return json({ error: 'missing room' }, 400);
  let row = await getRow(env, id);
  if (!row) row = await createRoom(env, id);
  // 顺手清理 2 天前的旧房（概率触发，serverless 友好）
  if (Math.random() < 0.05) {
    try { await env.DB.prepare('DELETE FROM gomoku_rooms WHERE updated_at < ?').bind(Date.now() - 2 * 864e5).run(); } catch {}
  }
  return json(stateOf(row, clientId));
}

export async function onRequestPost({ request, env }) {
  await ensureSchema(env);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const id = clean(body?.room);
  const clientId = clean(body?.clientId);
  const action = clean(body?.action, 16);
  if (!id || !clientId || !action) return json({ error: 'missing params' }, 400);

  let row = await getRow(env, id);
  if (!row) row = await createRoom(env, id);
  const size = row.size || SIZE;

  if (action === 'join') {
    const side = body.side === 'white' ? 'white' : 'black';
    // 已落座则幂等；座位空则占座；座位被他人占则失败
    if (row[side] && row[side] !== clientId) return json({ error: 'seat taken', ...stateOf(row, clientId) }, 409);
    const other = side === 'black' ? 'white' : 'black';
    if (row[other] === clientId) { // 不能同时占两个座位：换座
      await env.DB.prepare(`UPDATE gomoku_rooms SET ${other} = NULL WHERE id = ?`).bind(id).run();
    }
    await env.DB.prepare(`UPDATE gomoku_rooms SET ${side} = ?, updated_at = ? WHERE id = ?`).bind(clientId, Date.now(), id).run();
    return json(stateOf(await getRow(env, id), clientId));
  }

  if (action === 'leave') {
    for (const s of ['black', 'white']) if (row[s] === clientId) await env.DB.prepare(`UPDATE gomoku_rooms SET ${s} = NULL, updated_at = ? WHERE id = ?`).bind(Date.now(), id).run();
    return json(stateOf(await getRow(env, id), clientId));
  }

  if (action === 'reset') {
    await env.DB.prepare("UPDATE gomoku_rooms SET moves='[]', turn=1, winner=0, win_line=NULL, updated_at=? WHERE id=?").bind(Date.now(), id).run();
    return json(stateOf(await getRow(env, id), clientId));
  }

  if (action === 'move') {
    if (row.winner) return json({ error: 'game over', ...stateOf(row, clientId) }, 409);
    const seat = seatOf(row, clientId);
    const turn = row.turn;
    if ((turn === 1 && seat !== 'black') || (turn === 2 && seat !== 'white')) {
      return json({ error: 'not your turn', ...stateOf(row, clientId) }, 409);
    }
    const x = body.x | 0, y = body.y | 0;
    if (x < 0 || y < 0 || x >= size || y >= size) return json({ error: 'out of board' }, 400);
    const moves = safeMoves(row.moves);
    const board = buildBoard(moves, size);
    if (board[y][x] !== 0) return json({ error: 'occupied', ...stateOf(row, clientId) }, 409);
    board[y][x] = turn;
    moves.push([x, y, turn]);
    const line = checkWin(board, size, x, y, turn);
    let winner = 0, winLine = null;
    if (line) { winner = turn; winLine = line; }
    else if (moves.length >= size * size) winner = 3; // 平局
    await env.DB.prepare('UPDATE gomoku_rooms SET moves=?, turn=?, winner=?, win_line=?, updated_at=? WHERE id=?')
      .bind(JSON.stringify(moves), winner ? row.turn : (turn === 1 ? 2 : 1), winner, winLine ? JSON.stringify(winLine) : null, Date.now(), id).run();
    return json(stateOf(await getRow(env, id), clientId));
  }

  return json({ error: 'unknown action' }, 400);
}
