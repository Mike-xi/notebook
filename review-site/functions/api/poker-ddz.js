// 斗地主联机房间。状态存 D1 表 ddz_rooms，客户端 ~1.3s 轮询。
// 服务端权威：手牌隐藏、空位 AI 自动补齐。每次请求先把所有“该 AI 行动”的步骤跑完。
//   POST /api/poker-ddz {action, room, cid, ...}
//     create{nick} / join{nick} / state / bid{call} / play{ids} / pass
//     / reset / leave / chat{text}
// 鉴权由 _middleware.js 统一处理（仅登录用户可访问 /api/*）。
import { DoudizhuGame, ddzAdvance } from '../../assets/poker-engine.js';

const json = (o, status = 200) => Response.json(o, { status });
const clean = (s, n = 16) => (typeof s === 'string' ? s : '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, n);
const cleanNick = (s) => (typeof s === 'string' ? s : '').replace(/[\x00-\x1f\x7f<>]/g, '').slice(0, 12) || '玩家';
const cleanText = (s) => (typeof s === 'string' ? s : '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 120);
const safeJSON = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

let ready = false;
async function ensureSchema(env) {
  if (ready) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ddz_rooms (
       room TEXT PRIMARY KEY,
       state TEXT NOT NULL,
       seats TEXT NOT NULL,
       chat TEXT NOT NULL DEFAULT '[]',
       updated_at INTEGER NOT NULL,
       created_at INTEGER NOT NULL)`
  ).run();
  ready = true;
}
const getRow = (env, room) => env.DB.prepare('SELECT * FROM ddz_rooms WHERE room=?').bind(room).first();
async function saveRow(env, room, g, seats) {
  await env.DB.prepare('UPDATE ddz_rooms SET state=?, seats=?, updated_at=? WHERE room=?')
    .bind(JSON.stringify(g.toJSON()), JSON.stringify(seats), Date.now(), room).run();
}

function newSeats(creatorCid, nick) {
  const seats = [{ cid: creatorCid, nick, ai: false }];
  for (let i = 1; i < 3; i++) seats.push({ cid: null, nick: ['', '下家', '上家'][i], ai: true });
  return seats;
}
function newGame(seats) {
  return new DoudizhuGame({
    isAI: seats.map(x => x.ai),
    names: seats.map((x, i) => x.nick || ['你', '下家', '上家'][i]),
  });
}

async function load(env, room) {
  const row = await getRow(env, room);
  if (!row) return null;
  const seats = safeJSON(row.seats, null);
  const g = DoudizhuGame.from(safeJSON(row.state, null));
  const chat = safeJSON(row.chat, []);
  if (!seats || !g) return null;
  return { row, seats, g, chat };
}

function view(room, g, seats, cid, chat) {
  const mySeat = seats.findIndex(x => x.cid && x.cid === cid);
  const v = g.publicView(mySeat);
  v.room = room;
  v.mySeat = mySeat;
  v.seatsFilled = seats.map(x => !x.ai);
  v.chat = chat || [];
  return json(v);
}

export async function onRequestPost({ request, env }) {
  await ensureSchema(env);
  let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const action = clean(body?.action);
  const cid = clean(body?.cid, 32);
  let room = clean(body?.room, 12);
  if (!action || !cid) return json({ error: 'missing params' }, 400);
  const now = Date.now();

  // 偶发清理 2 天前的房
  if (Math.random() < 0.04) { try { await env.DB.prepare('DELETE FROM ddz_rooms WHERE updated_at < ?').bind(now - 2 * 864e5).run(); } catch {} }

  // ---- 建房 ----
  if (action === 'create') {
    if (!room) room = ('' + Math.floor(100000 + Math.random() * 899999));
    const exist = await getRow(env, room);
    if (exist) return doJoin(env, room, cid, cleanNick(body.nick));   // 已存在 → 当作加入
    const seats = newSeats(cid, cleanNick(body.nick));
    const g = newGame(seats);
    ddzAdvance(g);
    await env.DB.prepare('INSERT INTO ddz_rooms (room,state,seats,chat,updated_at,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(room) DO NOTHING')
      .bind(room, JSON.stringify(g.toJSON()), JSON.stringify(seats), '[]', now, now).run();
    return view(room, g, seats, cid, []);
  }

  if (!room) return json({ error: 'missing room' }, 400);
  if (action === 'join') return doJoin(env, room, cid, cleanNick(body.nick));

  const L = await load(env, room);
  if (!L) return json({ error: 'no room', notFound: true }, 404);
  const { seats, g, chat } = L;
  const mySeat = seats.findIndex(x => x.cid && x.cid === cid);

  if (action === 'state') {
    ddzAdvance(g);
    await saveRow(env, room, g, seats);
    return view(room, g, seats, cid, chat);
  }
  if (action === 'chat') {
    if (mySeat < 0) return json({ error: 'not a player' }, 403);
    const t = cleanText(body.text);
    if (t) {
      chat.push({ by: mySeat, nick: seats[mySeat].nick, t, ts: now });
      await env.DB.prepare('UPDATE ddz_rooms SET chat=?, updated_at=? WHERE room=?')
        .bind(JSON.stringify(chat.slice(-40)), now, room).run();
    }
    return view(room, g, seats, cid, chat.slice(-40));
  }
  if (action === 'leave') {
    if (mySeat >= 0) { seats[mySeat].cid = null; seats[mySeat].ai = true; g.s.isAI[mySeat] = true; }
    ddzAdvance(g);
    await saveRow(env, room, g, seats);
    return json({ ok: true });
  }
  if (action === 'reset') {
    if (mySeat < 0) return json({ error: 'not a player', notFound: false }, 403);
    const ng = newGame(seats);
    ddzAdvance(ng);
    await saveRow(env, room, ng, seats);
    return view(room, ng, seats, cid, chat);
  }

  if (mySeat < 0) return json({ error: 'not a player' }, 403);

  let r = { ok: true };
  if (action === 'bid') {
    r = g.bid(mySeat, body.call | 0);
  } else if (action === 'play') {
    const ids = Array.isArray(body.ids) ? body.ids.map(x => x | 0).slice(0, 20) : null;
    if (!ids) return json({ error: 'bad ids' }, 400);
    r = g.playByIds(mySeat, ids);
  } else if (action === 'pass') {
    r = g.pass(mySeat);
  } else {
    return json({ error: 'unknown action' }, 400);
  }
  if (r && r.ok === false) {
    ddzAdvance(g); await saveRow(env, room, g, seats);
    return json({ error: 'illegal', reason: r.err, ...g.publicView(mySeat), room, mySeat, seatsFilled: seats.map(x => !x.ai), chat }, 409);
  }

  ddzAdvance(g);
  await saveRow(env, room, g, seats);
  return view(room, g, seats, cid, chat);
}

async function doJoin(env, room, cid, nick) {
  const L = await load(env, room);
  if (!L) return json({ error: 'no room', notFound: true }, 404);
  const { seats, g, chat } = L;
  let seat = seats.findIndex(x => x.cid && x.cid === cid);
  if (seat < 0) seat = seats.findIndex(x => x.ai);          // 占一个 AI 空位
  if (seat < 0) return json({ error: 'room full', ...g.publicView(-1), room, mySeat: -1, seatsFilled: seats.map(x => !x.ai), chat }, 409);
  seats[seat].cid = cid; seats[seat].ai = false; if (nick) seats[seat].nick = nick;
  // 同步引擎该座的标记（影响 advance 是否替它行动）
  g.s.isAI[seat] = false; g.s.names[seat] = nick || g.s.names[seat];
  ddzAdvance(g);
  await saveRow(env, room, g, seats);
  return view(room, g, seats, cid, chat);
}

export async function onRequestGet() { return json({ error: 'use POST' }, 405); }
