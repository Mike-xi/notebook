// 四川麻将（血战到底）联机房间。状态存 D1 表 scmj_rooms，客户端 ~1.3s 轮询。
// 服务端权威：手牌隐藏、动作优先级、空位 AI 自动补齐。每次请求先把所有"该 AI 行动"的步骤跑完。
//   POST /api/sichuan-majiang {action, room, cid, ...}
//     create{nick,di,cap} / join{nick} / state / dingque{suit} / discard{tile}
//     / zimo / angang{tile} / bugang{tile} / respond{resp} / reset / leave
// 鉴权由 _middleware.js 统一处理（仅登录用户可访问 /api/*）。
import { SCMJGame, aiChooseQue, DEFAULT_RULE, ruleFor } from '../../assets/scmj-engine.js';

const json = (o, status = 200) => Response.json(o, { status });
const clean = (s, n = 16) => (typeof s === 'string' ? s : '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, n);
const cleanNick = (s) => (typeof s === 'string' ? s : '').replace(/[\x00-\x1f\x7f<>]/g, '').slice(0, 12) || '玩家';
const safeJSON = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const sumCounts = (c) => c.reduce((a, b) => a + b, 0);

let ready = false;
async function ensureSchema(env) {
  if (ready) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS scmj_rooms (
       room TEXT PRIMARY KEY,
       state TEXT NOT NULL,
       seats TEXT NOT NULL,
       rule TEXT NOT NULL,
       wdl INTEGER DEFAULT 0,
       updated_at INTEGER NOT NULL,
       created_at INTEGER NOT NULL)`
  ).run();
  ready = true;
}
const getRow = (env, room) => env.DB.prepare('SELECT * FROM scmj_rooms WHERE room=?').bind(room).first();
async function saveRow(env, room, g, seats, wdl) {
  await env.DB.prepare('UPDATE scmj_rooms SET state=?, seats=?, wdl=?, updated_at=? WHERE room=?')
    .bind(JSON.stringify(g.toJSON()), JSON.stringify(seats), wdl | 0, Date.now(), room).run();
}

function newSeats(creatorCid, nick) {
  const seats = [{ cid: creatorCid, nick, ai: false }];
  for (let i = 1; i < 4; i++) seats.push({ cid: null, nick: ['', '下家', '对家', '上家'][i], ai: true });
  return seats;
}
function newGame(seats, rule, dealer = 0) {
  return new SCMJGame({
    rule, dealer,
    isAI: seats.map(x => x.ai),
    names: seats.map((x, i) => x.nick || ['你', '下家', '对家', '上家'][i]),
  });
}

// 把所有"该 AI 行动 / 已超时"的步骤推进完。返回新的 window deadline(ms 时间戳, 0=无)。
function advance(g, seats, now, wdl) {
  let guard = 0;
  while (guard++ < 4000) {
    const s = g.s;
    if (s.phase === 'end') return 0;
    if (s.phase === 'dingque') {
      for (let i = 0; i < 4; i++) if (s.players[i].que == null && seats[i].ai) g.setQue(i, aiChooseQue(s.players[i].hand));
      if (s.phase !== 'dingque') continue;   // 全部定缺完，进入打牌
      return 0;                               // 等真人定缺
    }
    if (s.phase === 'play') {
      if (seats[s.turn].ai) { g.aiActTurn(s.turn); continue; }
      return 0;                               // 等真人出牌
    }
    if (s.phase === 'window') {
      let acted = false;
      for (const seat of g.windowResponders()) {
        if (s.window.responders[seat].resp == null && seats[seat].ai) { g.aiRespond(seat); acted = true; break; }
      }
      if (s.phase !== 'window') continue;     // 窗口已解析
      if (acted) continue;
      // 只剩真人响应者
      if (!wdl) wdl = now + 12000;            // 12s 后自动过
      if (now > wdl) {
        for (const seat of g.windowResponders()) if (s.window.responders[seat].resp == null) g.respond(seat, 'pass');
        if (s.phase !== 'window') { wdl = 0; continue; }
      }
      return wdl;
    }
    return 0;
  }
  return wdl;
}

function view(room, g, seats, cid) {
  const s = g.s;
  const mySeat = seats.findIndex(x => x.cid && x.cid === cid);
  const ended = s.phase === 'end';
  const players = s.players.map((p, i) => ({
    name: seats[i].nick || p.name, ai: seats[i].ai, que: p.que,
    score: p.score, hu: p.hu, huInfo: p.huInfo, melds: p.melds, discards: p.discards,
    handCount: sumCounts(p.hand),
    hand: (i === mySeat || ended || p.hu) ? p.hand : null,
    drawn: (i === mySeat) ? p.drawn : null,
  }));
  let win = null;
  if (s.phase === 'window' && mySeat >= 0 && s.window.responders[mySeat]) {
    win = { tile: s.window.tile, from: s.window.from, opts: s.window.responders[mySeat].opts, chi: s.window.responders[mySeat].chi || null, waiting: s.window.responders[mySeat].resp != null };
  } else if (s.phase === 'window') {
    win = { tile: s.window.tile, from: s.window.from, opts: [], waiting: true };
  }
  let turnOpts = null;
  if (s.phase === 'play' && s.turn === mySeat && !s.players[mySeat].hu) turnOpts = g.turnOptions(mySeat);
  return {
    room, mySeat, variant: s.rule.variant, phase: s.phase, turn: s.turn, dealer: s.dealer,
    rest: Math.max(0, s.wend - s.wpos), liveCount: s.liveCount,
    ended, reason: s.result && s.result.reason, result: s.result,
    players, window: win, turnOpts, lastDraw: s.lastDraw,
    dingqueNeeded: s.phase === 'dingque' && mySeat >= 0 && s.players[mySeat].que == null,
    seatsFilled: seats.map(x => !x.ai),
    log: s.log.slice(-14),
  };
}

async function load(env, room) {
  const row = await getRow(env, room);
  if (!row) return null;
  const seats = safeJSON(row.seats, null);
  const rule = safeJSON(row.rule, DEFAULT_RULE);
  const g = SCMJGame.from(safeJSON(row.state, null));
  return { row, seats, rule, g, wdl: row.wdl | 0 };
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
  if (Math.random() < 0.04) { try { await env.DB.prepare('DELETE FROM scmj_rooms WHERE updated_at < ?').bind(now - 2 * 864e5).run(); } catch {} }

  // ---- 建房 ----
  if (action === 'create') {
    if (!room) room = ('' + Math.floor(100000 + Math.random() * 899999));
    const exist = await getRow(env, room);
    if (exist) {
      // 已存在 → 当作加入
      return doJoin(env, room, cid, cleanNick(body.nick), now);
    }
    const rule = ruleFor(clampVariant(body.variant), { di: clampDi(body.di), maxFan: clampCap(body.cap) });
    const seats = newSeats(cid, cleanNick(body.nick));
    const g = newGame(seats, rule, 0);
    const wdl = advance(g, seats, now, 0);
    await env.DB.prepare('INSERT INTO scmj_rooms (room,state,seats,rule,wdl,updated_at,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(room) DO NOTHING')
      .bind(room, JSON.stringify(g.toJSON()), JSON.stringify(seats), JSON.stringify(rule), wdl | 0, now, now).run();
    return json(view(room, g, seats, cid));
  }

  if (!room) return json({ error: 'missing room' }, 400);

  if (action === 'join') return doJoin(env, room, cid, cleanNick(body.nick), now);

  const L = await load(env, room);
  if (!L) return json({ error: 'no room', notFound: true }, 404);
  const { seats, g } = L;
  let wdl = L.wdl;
  const mySeat = seats.findIndex(x => x.cid && x.cid === cid);

  if (action === 'state') {
    wdl = advance(g, seats, now, wdl);
    await saveRow(env, room, g, seats, wdl);
    return json(view(room, g, seats, cid));
  }
  if (action === 'leave') {
    if (mySeat >= 0) { seats[mySeat].cid = null; seats[mySeat].ai = true; }
    wdl = advance(g, seats, now, wdl);
    await saveRow(env, room, g, seats, wdl);
    return json({ ok: true });
  }
  if (action === 'reset') {
    if (mySeat < 0) return json({ error: 'not a player', ...view(room, g, seats, cid) }, 403);
    const rule = L.rule;
    const ng = newGame(seats, rule, (g.s.dealer + 1) % 4);
    wdl = advance(ng, seats, now, 0);
    await saveRow(env, room, ng, seats, wdl);
    return json(view(room, ng, seats, cid));
  }

  if (mySeat < 0) return json({ error: 'not a player', ...view(room, g, seats, cid) }, 403);

  let r = { ok: true };
  if (action === 'dingque') {
    r = g.setQue(mySeat, clampSuit(body.suit)) ? { ok: true } : { ok: false };
  } else if (action === 'discard') {
    if (g.s.turn !== mySeat) return json({ error: 'not your turn', ...view(room, g, seats, cid) }, 409);
    r = g.discard(mySeat, clampTile(body.tile));
  } else if (action === 'zimo') {
    if (g.s.turn !== mySeat) return json({ error: 'not your turn' }, 409);
    r = g.zimo(mySeat);
  } else if (action === 'angang') {
    if (g.s.turn !== mySeat) return json({ error: 'not your turn' }, 409);
    r = g.angang(mySeat, clampTile(body.tile));
  } else if (action === 'bugang') {
    if (g.s.turn !== mySeat) return json({ error: 'not your turn' }, 409);
    r = g.bugang(mySeat, clampTile(body.tile));
  } else if (action === 'respond') {
    const resp = clean(body.resp, 8);
    if (!['hu', 'peng', 'gang', 'chi', 'pass'].includes(resp)) return json({ error: 'bad resp' }, 400);
    r = g.respond(mySeat, resp, resp === 'chi' ? { seq: clampTile(body.seq) } : null);
  } else {
    return json({ error: 'unknown action' }, 400);
  }
  if (r && r.ok === false) return json({ error: 'illegal', ...view(room, g, seats, cid) }, 409);

  wdl = advance(g, seats, now, action === 'respond' || action === 'discard' ? 0 : wdl);
  await saveRow(env, room, g, seats, wdl);
  return json(view(room, g, seats, cid));
}

async function doJoin(env, room, cid, nick, now) {
  const L = await load(env, room);
  if (!L) return json({ error: 'no room', notFound: true }, 404);
  const { seats, g, rule } = L;
  let wdl = L.wdl;
  let seat = seats.findIndex(x => x.cid && x.cid === cid);
  if (seat < 0) seat = seats.findIndex(x => x.ai);          // 占一个 AI 空位
  if (seat < 0) return json({ error: 'room full', ...view(room, g, seats, cid) }, 409);
  seats[seat].cid = cid; seats[seat].ai = false; if (nick) seats[seat].nick = nick;
  // 同步引擎里该座的 isAI 标记（影响 advance 是否替它行动）
  g.s.players[seat].isAI = false; g.s.players[seat].name = nick;
  wdl = advance(g, seats, now, wdl);
  await saveRow(env, room, g, seats, wdl);
  return json(view(room, g, seats, cid));
}

const clampSuit = (v) => { v = +v; return (v === 0 || v === 1 || v === 2) ? v : 0; };
const clampTile = (v) => { v = +v; return (Number.isInteger(v) && v >= 0 && v < 27) ? v : -1; };
const clampDi = (v) => { v = +v; return [1, 2, 5].includes(v) ? v : 1; };
const clampCap = (v) => { v = +v; return [3, 4, 5].includes(v) ? v : 4; };
const clampVariant = (v) => (v === 'changsha' ? 'changsha' : 'sichuan');

export async function onRequestGet() { return json({ error: 'use POST' }, 405); }
