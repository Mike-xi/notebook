// 狼人杀「联机房间」后端：服务端权威状态机 + 计时自动推进（像线上狼人杀 APP）。
// 无 WebSocket，客户端 ~1.3s 轮询；每次 GET/POST 都会按当前时间把状态机往前推（lazy advance）。
// 人不够的座位由 AI 补；该行动的人超时未操作则由 AI 代为行动。AI 发言用 _lib/wwai.js 逐座位生成。
//   GET  /api/werewolf?room=CODE&clientId=ID            -> 该客户端可见的状态（推进后）
//   POST /api/werewolf {room,clientId,action,...}
//        action: create{cfg,name} / join{name} / leave / start /
//                night{kind:'wolf'|'seer'|'witch',target,save,poison} / speak{text,claimSeer} /
//                vote{target} / shoot{target}
// 鉴权由 _middleware.js 处理（仅登录用户）。并发用乐观锁 tick 做 CAS，避免重复推进。
import { genTurn, genVote, PERSONAS } from '../_lib/wwai.js';

const json = (o, s = 200) => Response.json(o, { status: s });
const clean = (s, n = 40) => (typeof s === 'string' ? s : '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, n);
const cleanName = (s) => (typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 12);
const ROLE_CN = { wolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人', idiot: '白痴', villager: '平民' };
const NAMES = ['阿强', '小敏', '老王', '阿珍', '大壮', '丽丽', '阿伟', '婷婷', '志明', '春娇', '阿龙', '晓彤', '建国', '秀英', '大山', '阿May'];
const CONFIGS = {
  '333': { n: 9, roles: ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager'] },
  '444': { n: 12, roles: ['wolf', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'idiot', 'villager', 'villager', 'villager', 'villager'] },
};
// 各阶段时长（秒）
const SECS = { wolf: 30, seer: 20, witch: 25, announce: 6, speak: 45, vote: 30, hunter: 20 };
const isGod = (r) => r === 'seer' || r === 'witch' || r === 'hunter' || r === 'idiot';
const rand = (a) => a[Math.floor(Math.random() * a.length)];
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; };

let ready = false;
async function ensureSchema(env) {
  if (ready) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS werewolf_rooms (
       id TEXT PRIMARY KEY, cfg TEXT NOT NULL DEFAULT '333',
       state TEXT NOT NULL, tick INTEGER NOT NULL DEFAULT 0,
       updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`
  ).run();
  ready = true;
}
const safeJSON = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
async function getRow(env, id) { return env.DB.prepare('SELECT * FROM werewolf_rooms WHERE id=?').bind(id).first(); }

// ---------- 建房 / 状态初始化 ----------
function freshState(id, cfg, host) {
  const c = CONFIGS[cfg];
  const players = [];
  for (let s = 0; s < c.n; s++) {
    players.push({ seat: s, name: `席位${s + 1}`, clientId: null, isAI: true, role: null, alive: true, revealed: false, canVote: true, persona: rand(PERSONAS), deathCause: null, _vote: -1, memory: '' });
  }
  return {
    id, cfg, n: c.n, host, phase: 'lobby', day: 0, deadline: null,
    players, night: {}, witch: { antidote: true, poison: true }, seerChecks: [], claims: [],
    speak: null, votes: {}, log: [], winner: null, lastVoteCount: null, firstNight: true, pendingShoot: null,
  };
}

// ---------- 工具 ----------
const P = (st, seat) => st.players[seat];
const aliveAll = (st) => st.players.filter((p) => p.alive);
const aliveSeats = (st) => aliveAll(st).map((p) => p.seat);
const aliveWolves = (st) => st.players.filter((p) => p.alive && p.role === 'wolf');
const aliveNonWolfSeats = (st) => st.players.filter((p) => p.alive && p.role !== 'wolf').map((p) => p.seat);
const aliveHumans = (st) => st.players.filter((p) => p.alive && !p.isAI);
const nm = (st, seat) => `${seat + 1}号(${P(st, seat).name})`;
const logPush = (st, k, text, seat = null) => { st.log.push({ k, text, seat }); if (st.log.length > 160) st.log = st.log.slice(-160); };
function setDeadline(st, now, secs) { st.deadline = now + secs * 1000; }

function checkWin(st) {
  const w = aliveWolves(st).length;
  if (w === 0) { st.winner = 'good'; return true; }
  const gods = st.players.filter((p) => p.alive && isGod(p.role)).length;
  const vill = st.players.filter((p) => p.alive && p.role === 'villager').length;
  if (gods === 0 || vill === 0) { st.winner = 'wolf'; return true; }
  return false;
}

// ---------- 启动：分配身份 ----------
function startGame(st, now) {
  const roles = shuffle(CONFIGS[st.cfg].roles);
  const namePool = shuffle(NAMES);
  let ni = 0;
  st.players.forEach((p, i) => {
    p.role = roles[i];
    if (p.isAI) p.name = namePool[ni++] || `电脑${i + 1}`;
  });
  st.phase = 'night_wolf'; st.day = 1; st.firstNight = true;
  st.night = { wolfVotes: {}, seerDone: false, witchDone: false };
  setDeadline(st, now, SECS.wolf);
  logPush(st, 'sys', `游戏开始！${st.cfg} 板，共 ${st.n} 人。天黑请闭眼……`);
  logPush(st, 'night', `🌙 第 1 夜`);
}

// ================= 夜晚 AI 启发式 =================
function aiWolfKill(st) {
  const realClaim = st.claims.find((c) => c.real);
  if (realClaim) { const p = P(st, realClaim.seat); if (p.alive && p.role !== 'wolf') return p.seat; }
  const cands = aliveNonWolfSeats(st);
  return cands.length ? rand(cands) : null;
}
function resolveWolfKill(st) {
  // 合并所有狼（人类已提交 + AI 自动）的投票，多数决；AI 狼若没投则各自挑一个
  const wolves = aliveWolves(st);
  const votes = {};
  for (const w of wolves) {
    let t = st.night.wolfVotes[w.seat];
    if (t == null) t = w.isAI ? aiWolfKill(st) : null;
    if (t != null && P(st, t).alive && P(st, t).role !== 'wolf') votes[t] = (votes[t] || 0) + 1;
  }
  let target = null, max = 0;
  for (const k in votes) if (votes[k] > max) { max = votes[k]; target = +k; }
  if (target == null) { const c = aliveNonWolfSeats(st); target = c.length ? rand(c) : null; }
  st.night.wolfTarget = target;
}
function aiSeerCheck(st) {
  const seer = st.players.find((p) => p.role === 'seer');
  if (!seer || !seer.alive) return;
  const checked = new Set(st.seerChecks.map((c) => c.target));
  let cands = st.players.filter((p) => p.alive && p.seat !== seer.seat && !checked.has(p.seat)).map((p) => p.seat);
  if (!cands.length) cands = st.players.filter((p) => p.alive && p.seat !== seer.seat).map((p) => p.seat);
  const fake = st.claims.find((c) => !c.real && P(st, c.seat).alive);
  const t = (fake && cands.includes(fake.seat)) ? fake.seat : (cands.length ? rand(cands) : null);
  if (t == null) return;
  st.seerChecks.push({ target: t, res: P(st, t).role === 'wolf' ? 'wolf' : 'good' });
}
function aiWitch(st) {
  const killed = st.night.wolfTarget;
  if (st.witch.antidote && killed != null && st.firstNight) { st.night.saved = true; st.witch.antidote = false; return; }
  if (st.witch.antidote && killed != null) { const rc = st.claims.find((c) => c.real); if (rc && rc.seat === killed) { st.night.saved = true; st.witch.antidote = false; return; } }
  if (st.witch.poison && st.day >= 2 && !st.night.saved) {
    const rc = st.claims.find((c) => c.real); const t = rc ? claimWolfTarget(st, rc) : null;
    if (t != null && P(st, t).alive && Math.random() < 0.5) { st.night.poison = t; st.witch.poison = false; }
  }
}
function resolveNight(st) {
  const deaths = [];
  const kt = st.night.wolfTarget;
  if (kt != null && !st.night.saved && P(st, kt).alive) { P(st, kt).alive = false; P(st, kt).deathCause = 'wolf'; deaths.push(kt); }
  const pt = st.night.poison;
  if (pt != null && P(st, pt).alive) { P(st, pt).alive = false; P(st, pt).deathCause = 'poison'; deaths.push(pt); }
  // 夜里死的 AI 预言家，自动公布查验（让好人接到信息，相当于划水报查杀）
  for (const s of deaths) { const p = P(st, s); if (p.role === 'seer' && p.isAI) registerRealClaim(st, s); }
  st.lastNight = { deaths };
}

// ================= 查验/跳身份/投票 启发式 =================
function registerRealClaim(st, seat) {
  let c = st.claims.find((x) => x.real);
  if (!c) { c = { seat, reports: st.seerChecks.slice(), real: true, announced: false }; st.claims.push(c); }
  else { c.seat = seat; c.reports = st.seerChecks.slice(); }
}
function claimWolfTarget(st, claim) {
  if (!claim) return null;
  for (let i = claim.reports.length - 1; i >= 0; i--) { const r = claim.reports[i]; if (r.res === 'wolf' && P(st, r.target).alive) return r.target; }
  return null;
}
function lastAliveSeerWolf(st) {
  for (let i = st.seerChecks.length - 1; i >= 0; i--) { const r = st.seerChecks[i]; if (r.res === 'wolf' && P(st, r.target).alive) return r.target; }
  return null;
}
function randAliveOther(st, seat, exclude) {
  const ex = new Set(exclude || []); ex.add(seat);
  const c = aliveSeats(st).filter((s) => !ex.has(s)); return c.length ? rand(c) : -1;
}
function maybeWolfFakeClaim(st) {
  const realClaim = st.claims.find((c) => c.real);
  if (!realClaim) return;
  if (st.claims.some((c) => !c.real)) return;
  const wolves = st.players.filter((p) => p.alive && p.role === 'wolf' && p.isAI);
  if (!wolves.length) return;
  if (Math.random() < 0.55) {
    const faker = rand(wolves);
    const reports = [{ target: realClaim.seat, res: 'wolf' }];
    const mates = st.players.filter((p) => p.alive && p.role === 'wolf' && p.seat !== faker.seat);
    if (mates.length && Math.random() < 0.5) reports.push({ target: rand(mates).seat, res: 'good' });
    st.claims.push({ seat: faker.seat, reports, real: false, announced: false });
  }
}
// 没有可信查杀时的兜底：好人共享一个「确定性怀疑对象」，保证票收敛到同一活人
// （排除可信的存活真预言家和它给的金水）。按天轮换，避免永远针对同一座位。
function fallbackSuspect(st, p) {
  const rc = st.claims.find((c) => c.real);
  const trust = new Set();
  if (rc && P(st, rc.seat).alive) trust.add(rc.seat);
  if (rc) rc.reports.forEach((r) => { if (r.res === 'good' && P(st, r.target).alive) trust.add(r.target); });
  let cands = aliveSeats(st).filter((s) => !trust.has(s) && s !== p.seat);
  if (!cands.length) cands = aliveSeats(st).filter((s) => s !== p.seat);
  if (!cands.length) return -1;
  return cands[st.day % cands.length];
}
function goodVote(st, p) {
  const claims = st.claims; const realClaim = claims.find((c) => c.real);
  if (p.role === 'seer') {
    const t = lastAliveSeerWolf(st); if (t != null) return t;
    const fc = claims.find((c) => !c.real && P(st, c.seat).alive); if (fc) return fc.seat;
    return fallbackSuspect(st, p);
  }
  if (claims.length) {
    const believe = (claims.length >= 2 && realClaim && Math.random() < 0.72) ? realClaim : rand(claims);
    const t = claimWolfTarget(st, believe);
    if (t != null) return t; // 跟可信预言家的存活查杀
    // 被信的预言家没有存活查杀：怀疑另一个还活着的跳预言家者（多半是对跳的狼）
    const others = claims.filter((c) => c !== believe && P(st, c.seat).alive);
    if (others.length) return rand(others).seat;
  }
  return fallbackSuspect(st, p); // 没有可用信息 → 收敛到共享怀疑对象，绝不弃票
}
function computeAIVotesAndIntents(st) {
  const claims = st.claims; const realClaim = claims.find((c) => c.real);
  let wolfTarget = -1;
  if (realClaim && P(st, realClaim.seat).alive && P(st, realClaim.seat).role !== 'wolf') wolfTarget = realClaim.seat;
  else { const fc = claims.find((c) => !c.real); const t = fc ? claimWolfTarget(st, fc) : null; if (t != null && P(st, t).alive && P(st, t).role !== 'wolf') wolfTarget = t; else { const g = aliveNonWolfSeats(st); wolfTarget = g.length ? rand(g) : -1; } }
  // 3 狼以上时分一个狼去投别人打掩护，避免对真预言家一波流
  const wv = aliveWolves(st);
  let blendWolf = -1, blendSeat = -1;
  if (wv.length > 2) { const c = aliveNonWolfSeats(st).filter((s) => s !== wolfTarget); if (c.length) { blendWolf = wv[wv.length - 1].seat; blendSeat = rand(c); } }
  for (const p of st.players) {
    if (!p.alive || !p.canVote) continue;
    if (p.role === 'wolf') p._vote = (p.seat === blendWolf && blendSeat >= 0) ? blendSeat : wolfTarget;
    else p._vote = goodVote(st, p);
  }
}

// ================= 投票结算 =================
// AI 最终定票：存活 AI 读完当天全部发言后并行决策（投票互不可见，可并行）。失败回退启发式基线。
async function finalizeAIVotes(st, env) {
  computeAIVotesAndIntents(st); // 启发式基线
  if (!env || !env.AI) return;
  const voters = st.players.filter((p) => p.alive && p.canVote && p.isAI);
  if (!voters.length) return;
  const players = st.players.map((x) => ({ seat: x.seat, name: x.name, alive: x.alive }));
  const claims = publicClaimsServer(st); const log = aiLog(st);
  await Promise.all(voters.map(async (p) => {
    const v = await genVote(env, { config: st.cfg, day: st.day, seat: p.seat, role: p.role, name: p.name, persona: p.persona, players, log, claims, priv: privForServer(st, p.seat), memory: p.memory || '' });
    if (typeof v.vote === 'number') { p._vote = v.vote; if (typeof v.notes === 'string' && v.notes) p.memory = v.notes; }
  }));
}

function tallyAndResolve(st, now) {
  // 收齐所有存活可投票者（人类已提交 votes[seat]，AI 用 _vote）。_vote 已由 finalizeAIVotes 设置。
  const count = {}; const detail = [];
  for (const v of st.players) {
    if (!v.alive || !v.canVote) continue;
    let tgt = (v.seat in st.votes) ? st.votes[v.seat] : (v.isAI ? v._vote : -1);
    if (tgt != null && tgt >= 0 && P(st, tgt).alive) { count[tgt] = (count[tgt] || 0) + 1; detail.push(`${v.seat + 1}→${tgt + 1}`); }
    else detail.push(`${v.seat + 1}弃`);
  }
  st.lastVoteCount = count;
  logPush(st, 'sys', `🗳️ 投票：${detail.join('，')}`);
  let max = 0, tied = [];
  for (const k in count) { const c = count[k]; if (c > max) { max = c; tied = [+k]; } else if (c === max) tied.push(+k); }
  if (max === 0 || tied.length !== 1) {
    logPush(st, 'sys', max === 0 ? '无人投票，本轮无人出局。' : `⚖️ 平票（${tied.map((s) => s + 1 + '号').join('、')}），本轮无人出局。`);
    return nextNightOrOver(st, now);
  }
  const out = tied[0]; const p = P(st, out);
  if (p.role === 'idiot' && !p.revealed) {
    p.revealed = true; p.canVote = false;
    logPush(st, 'claim', `🤪 ${nm(st, out)} 被投出——翻牌是白痴！免疫放逐，失去投票权。`, out);
    return nextNightOrOver(st, now);
  }
  p.alive = false; p.deathCause = 'vote';
  logPush(st, 'dead', `⚖️ ${nm(st, out)} 被投票放逐出局。`, out);
  if (p.role === 'seer' && p.isAI) registerRealClaim(st, out);
  if (p.role === 'hunter') { st.pendingShoot = out; st.phase = 'hunter'; st.hunterFrom = 'vote'; setDeadline(st, now, SECS.hunter); if (p.isAI) { /* 立即由推进逻辑处理 */ } return; }
  if (checkWin(st)) { st.phase = 'over'; st.deadline = null; return; }
  nextNightOrOver(st, now);
}
function nextNightOrOver(st, now) {
  if (checkWin(st)) { st.phase = 'over'; st.deadline = null; return; }
  st.day += 1; st.firstNight = false;
  st.phase = 'night_wolf'; st.night = { wolfVotes: {} };
  st.votes = {}; st.lastVoteCount = null; st.speak = null;
  setDeadline(st, now, SECS.wolf);
  logPush(st, 'night', `🌙 第 ${st.day} 夜，天黑请闭眼……`);
}

// ================= 猎人开枪 =================
function aiHunterShoot(st, seat) {
  const cands = aliveSeats(st).filter((s) => s !== seat);
  if (!cands.length) return null;
  const rc = st.claims.find((c) => c.real); const t = rc ? claimWolfTarget(st, rc) : null;
  if (t != null && cands.includes(t)) return t;
  const fake = st.claims.find((c) => !c.real && cands.includes(c.seat)); if (fake) return fake.seat;
  return rand(cands);
}
function doShoot(st, seat, target, now) {
  const p = P(st, seat); p.revealed = true;
  logPush(st, 'claim', `🔫 ${nm(st, seat)} 是猎人，翻牌开枪！`, seat);
  if (target != null && P(st, target).alive && target !== seat) {
    P(st, target).alive = false; P(st, target).deathCause = 'shot';
    logPush(st, 'dead', `🔫 ${nm(st, seat)} 开枪带走了 ${nm(st, target)}。`, target);
  }
  st.pendingShoot = null;
  const from = st.hunterFrom; st.hunterFrom = null;
  if (checkWin(st)) { st.phase = 'over'; st.deadline = null; return; }
  if (from === 'night') { enterSpeak(st, now); } else { nextNightOrOver(st, now); }
}

// ================= 白天发言 =================
function enterAnnounce(st, now) {
  resolveNight(st);
  st.phase = 'announce'; setDeadline(st, now, SECS.announce);
  const deaths = st.lastNight.deaths;
  if (!deaths.length) logPush(st, 'sys', '🌅 天亮了，昨晚是平安夜，无人死亡。');
  else logPush(st, 'dead', `🌅 天亮了，昨晚 ${deaths.map((s) => nm(st, s)).join('、')} 倒牌出局。`);
}
function afterAnnounce(st, now) {
  // 夜里被刀的猎人开枪（被毒不可）
  const deaths = st.lastNight.deaths || [];
  for (const s of deaths) { const p = P(st, s); if (p.role === 'hunter' && p.deathCause === 'wolf') { st.pendingShoot = s; st.phase = 'hunter'; st.hunterFrom = 'night'; setDeadline(st, now, SECS.hunter); return; } }
  if (checkWin(st)) { st.phase = 'over'; st.deadline = null; return; }
  enterSpeak(st, now);
}
function enterSpeak(st, now) {
  // 真预言家（AI）自动跳（保证好人有信息）；AI 狼的悍跳改由各狼在自己发言回合里 LLM 自己决定（见 advance 的 speak 分支）。
  const seer = st.players.find((p) => p.role === 'seer');
  if (seer && seer.alive && seer.isAI) registerRealClaim(st, seer.seat);
  st.claims.forEach((c) => { if (!c.announced) { c.announced = true; const t = claimWolfTarget(st, c); logPush(st, 'claim', `🔮 ${nm(st, c.seat)} ${c.real ? '' : '也'}跳预言家${t != null ? '，查杀 ' + (t + 1) + '号' : ''}${c.real ? '' : '（对跳）'}。`, c.seat); } });
  computeAIVotesAndIntents(st); // 启发式基线票（兜底）；LLM 决策会逐个覆盖
  st.phase = 'speak';
  st.speak = { order: aliveSeats(st), idx: 0 };
  armSpeaker(st, now);
}
// 服务端构造单座位的合法私有视图（不泄露他人身份给模型）
function privForServer(st, seat) {
  const p = P(st, seat); const priv = {};
  if (p.role === 'wolf') {
    priv.mates = st.players.filter((x) => x.role === 'wolf').map((x) => x.seat);
    if (st.night && st.night.wolfTarget != null) priv.nightKill = st.night.wolfTarget;
  } else if (p.role === 'seer') {
    priv.seerChecks = st.seerChecks.slice();
    priv.claimed = st.claims.some((c) => c.real && c.seat === seat);
  } else if (p.role === 'witch') {
    priv.antidote = st.witch.antidote; priv.poison = st.witch.poison;
  }
  return priv;
}
const publicClaimsServer = (st) => st.claims.map((c) => ({ seat: c.seat, reports: (c.reports || []).map((r) => ({ target: r.target, res: r.res })) }));
const aiLog = (st) => st.log.filter((e) => e.k === 'speech' || e.k === 'claim' || e.k === 'dead' || e.k === 'sys').slice(-30)
  .map((e) => (e.seat != null && e.k === 'speech') ? `${e.seat + 1}号(${P(st, e.seat).name})：${e.text}` : e.text);
function armSpeaker(st, now) {
  const sp = st.speak;
  if (sp.idx >= sp.order.length) { enterVote(st, now); return; }
  setDeadline(st, now, SECS.speak);
}
function enterVote(st, now) {
  st.phase = 'vote'; st.votes = {}; setDeadline(st, now, SECS.vote);
  computeAIVotesAndIntents(st); // 同时给每个存活者算出建议票(_vote)，真人客户端可作提示
  logPush(st, 'sys', '🗳️ 进入投票，请选择放逐对象。');
}

// ================= 主推进 =================
async function advance(st, now, env) {
  let didLLM = false;
  for (let guard = 0; guard < 60; guard++) {
    const ph = st.phase;
    if (ph === 'lobby' || ph === 'over') break;
    const expired = st.deadline != null && now >= st.deadline;

    if (ph === 'night_wolf') {
      const humanWolves = aliveHumans(st).filter((p) => p.role === 'wolf');
      const allActed = humanWolves.every((p) => st.night.wolfVotes[p.seat] != null);
      if (humanWolves.length && !allActed && !expired) break;
      resolveWolfKill(st); st.phase = 'night_seer'; setDeadline(st, now, SECS.seer); continue;
    }
    if (ph === 'night_seer') {
      const seer = st.players.find((p) => p.role === 'seer' && p.alive);
      if (seer && !seer.isAI) {
        if (st.night.seerDone) { st.phase = 'night_witch'; setDeadline(st, now, SECS.witch); continue; }
        if (expired) { aiSeerCheck(st); st.phase = 'night_witch'; setDeadline(st, now, SECS.witch); continue; }
        break;
      }
      if (seer) aiSeerCheck(st);
      st.phase = 'night_witch'; setDeadline(st, now, SECS.witch); continue;
    }
    if (ph === 'night_witch') {
      const witch = st.players.find((p) => p.role === 'witch' && p.alive);
      if (witch && !witch.isAI) {
        if (st.night.witchDone || expired) { enterAnnounce(st, now); continue; }
        break;
      }
      if (witch) aiWitch(st);
      enterAnnounce(st, now); continue;
    }
    if (ph === 'announce') {
      if (!expired) break;
      afterAnnounce(st, now); continue;
    }
    if (ph === 'hunter') {
      const seat = st.pendingShoot; const p = seat != null ? P(st, seat) : null;
      if (p && !p.isAI && !expired && st.pendingShoot != null) break; // 等人类猎人开枪
      const target = (p && p.isAI) ? aiHunterShoot(st, seat) : (expired ? aiHunterShoot(st, seat) : null);
      doShoot(st, seat, target, now); continue;
    }
    if (ph === 'speak') {
      const sp = st.speak; const cur = sp.order[sp.idx];
      if (cur == null) { enterVote(st, now); continue; }
      const p = P(st, cur);
      if (!p.alive) { sp.idx++; armSpeaker(st, now); continue; }
      if (!p.isAI) {
        if (sp.spoke) { sp.idx++; sp.spoke = false; armSpeaker(st, now); continue; }
        if (expired) { logPush(st, 'sys', `${nm(st, cur)} 超时未发言，过麦。`, cur); sp.idx++; armSpeaker(st, now); continue; }
        break; // 等人类发言
      }
      // AI 发言：每个 AI 是独立 agent，读【全场公开记录(含真人发言) + 自己私有信息 + 记忆】现场决策。
      // 每次推进只出一个，保证请求有界。
      const players = st.players.map((x) => ({ seat: x.seat, name: x.name, alive: x.alive }));
      const dec = await genTurn(env, {
        config: st.cfg, day: st.day, seat: cur, role: p.role, name: p.name, persona: p.persona,
        players, log: aiLog(st), claims: publicClaimsServer(st), priv: privForServer(st, cur), memory: p.memory || '',
      });
      didLLM = true;
      // 狼悍跳：AI 狼自己决定（仅当此刻还没有人对跳时）
      if (p.role === 'wolf' && dec.claimSeer && dec.frame != null && !st.claims.some((c) => !c.real)) {
        st.claims.push({ seat: cur, reports: [{ target: dec.frame, res: 'wolf' }], real: false, announced: true });
        logPush(st, 'claim', `🔮 ${nm(st, cur)} 也跳预言家，查杀 ${dec.frame + 1}号（对跳）。`, cur);
      } else if (dec.source === 'heuristic' && p.role === 'wolf' && !st.claims.some((c) => !c.real)) {
        maybeWolfFakeClaim(st); // LLM 不可用时的悍跳兜底
        st.claims.forEach((c) => { if (!c.announced) { c.announced = true; const t = claimWolfTarget(st, c); logPush(st, 'claim', `🔮 ${nm(st, c.seat)} 也跳预言家${t != null ? '，查杀 ' + (t + 1) + '号' : ''}（对跳）。`, c.seat); } });
      }
      if (typeof dec.vote === 'number' && dec.vote >= 0) p._vote = dec.vote;
      if (typeof dec.notes === 'string') p.memory = dec.notes;
      logPush(st, 'speech', dec.text, cur);
      sp.idx++; armSpeaker(st, now);
      break; // 一次只出一个 AI 发言（客户端下次轮询再出下一个，形成节奏）
    }
    if (ph === 'vote') {
      const voters = st.players.filter((p) => p.alive && p.canVote && !p.isAI);
      const allVoted = voters.every((p) => p.seat in st.votes);
      if (voters.length && !allVoted && !expired) break;
      await finalizeAIVotes(st, env); didLLM = true;
      tallyAndResolve(st, now); continue;
    }
    break;
  }
  return didLLM;
}

// ---------- 客户端可见视图 ----------
function meAction(st, me, now) {
  if (!me) return { act: 'spectate' };
  if (!me.alive) return { act: 'dead' };
  const ph = st.phase;
  if (ph === 'night_wolf' && me.role === 'wolf') {
    const mates = aliveWolves(st).filter((w) => w.seat !== me.seat).map((w) => ({ seat: w.seat, name: w.name, pick: st.night.wolfVotes[w.seat] }));
    return { act: (me.seat in st.night.wolfVotes) ? 'wolf-wait' : 'wolf', targets: aliveNonWolfSeats(st), mates, myPick: st.night.wolfVotes[me.seat] };
  }
  if (ph === 'night_seer' && me.role === 'seer') {
    if (st.night.seerDone) { const last = st.seerChecks[st.seerChecks.length - 1]; return { act: 'seer-done', result: last ? { target: last.target, res: last.res } : null }; }
    return { act: 'seer', targets: aliveSeats(st).filter((s) => s !== me.seat) };
  }
  if (ph === 'night_witch' && me.role === 'witch') {
    if (st.night.witchDone) return { act: 'witch-done' };
    return { act: 'witch', killed: st.night.wolfTarget, antidote: st.witch.antidote, poison: st.witch.poison, targets: aliveSeats(st).filter((s) => s !== me.seat) };
  }
  if (ph === 'hunter' && st.pendingShoot === me.seat) return { act: 'shoot', targets: aliveSeats(st).filter((s) => s !== me.seat) };
  if (ph === 'speak') {
    const cur = st.speak.order[st.speak.idx];
    if (cur === me.seat && !st.speak.spoke) return { act: 'speak', canClaimSeer: me.role === 'seer' };
  }
  if (ph === 'vote') { if (!(me.seat in st.votes)) return { act: 'vote', targets: aliveSeats(st).filter((s) => s !== me.seat), suggest: (me._vote != null && me._vote >= 0 && P(st, me._vote).alive && me._vote !== me.seat) ? me._vote : null }; return { act: 'vote-done' }; }
  return { act: 'wait' };
}
function view(st, clientId, now) {
  const me = st.players.find((p) => p.clientId === clientId);
  const youSeat = me ? me.seat : -1;
  const youRole = me ? me.role : null;
  const over = st.phase === 'over';
  const speakingSeat = st.phase === 'speak' && st.speak ? st.speak.order[st.speak.idx] : null;
  return {
    id: st.id, cfg: st.cfg, n: st.n, phase: st.phase, day: st.day, host: st.host,
    remain: st.deadline ? Math.max(0, Math.round((st.deadline - now) / 1000)) : null,
    youSeat, youRole, youAlive: me ? me.alive : null,
    started: st.phase !== 'lobby',
    speakingSeat,
    players: st.players.map((p) => ({
      seat: p.seat, name: p.name, isAI: p.isAI, taken: !!p.clientId, alive: p.alive, revealed: p.revealed,
      isYou: p.seat === youSeat, mate: youRole === 'wolf' && p.role === 'wolf' && p.seat !== youSeat,
      role: (over || p.revealed || p.seat === youSeat || (youRole === 'wolf' && p.role === 'wolf')) ? p.role : null,
      voted: st.phase === 'vote' ? (p.seat in st.votes) : false,
    })),
    log: st.log.slice(-90),
    voteCount: st.lastVoteCount, winner: st.winner,
    me: meAction(st, me, now),
  };
}

// ---------- 持久化 + CAS 推进 ----------
async function loadAdvanceSave(env, id, now, mutate) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getRow(env, id);
    if (!row) return null;
    const st = safeJSON(row.state, null); if (!st) return null;
    const tick = row.tick;
    if (mutate) { const stop = mutate(st); if (stop === 'nosave') return st; }
    await advance(st, now, env);
    const res = await env.DB.prepare('UPDATE werewolf_rooms SET state=?, tick=?, updated_at=? WHERE id=? AND tick=?')
      .bind(JSON.stringify(st), tick + 1, now, id, tick).run();
    if (res.meta && res.meta.changes > 0) return st;
    // CAS 失败：别人先推进了，重试读最新
  }
  const row = await getRow(env, id); return row ? safeJSON(row.state, null) : null;
}

export async function onRequestGet({ request, env }) {
  await ensureSchema(env);
  const url = new URL(request.url);
  const id = clean(url.searchParams.get('room'));
  const clientId = clean(url.searchParams.get('clientId'), 64);
  if (!id) return json({ error: 'missing room' }, 400);
  const now = Date.now();
  const st = await loadAdvanceSave(env, id, now, null);
  if (!st) return json({ error: 'no room', notFound: true }, 404);
  if (Math.random() < 0.04) { try { await env.DB.prepare('DELETE FROM werewolf_rooms WHERE updated_at < ?').bind(now - 2 * 864e5).run(); } catch {} }
  return json(view(st, clientId, now));
}

export async function onRequestPost({ request, env }) {
  await ensureSchema(env);
  let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const id = clean(body?.room);
  const clientId = clean(body?.clientId, 64);
  const action = clean(body?.action, 16);
  if (!id || !clientId || !action) return json({ error: 'missing params' }, 400);
  const now = Date.now();

  if (action === 'create') {
    const cfg = body.cfg === '444' ? '444' : '333';
    const existing = await getRow(env, id);
    if (existing) { // 已存在则当作 join
    } else {
      const st = freshState(id, cfg, clientId);
      await env.DB.prepare('INSERT INTO werewolf_rooms (id,cfg,state,tick,updated_at,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .bind(id, cfg, JSON.stringify(st), 0, now, now).run();
    }
    // 紧接着占座
    const st = await loadAdvanceSave(env, id, now, (s) => { joinSeat(s, clientId, body.name); });
    return st ? json(view(st, clientId, now)) : json({ error: 'create failed' }, 500);
  }

  const row = await getRow(env, id);
  if (!row) return json({ error: 'no room', notFound: true }, 404);

  const st = await loadAdvanceSave(env, id, now, (s) => applyAction(s, clientId, action, body, now));
  if (!st) return json({ error: 'apply failed' }, 500);
  return json(view(st, clientId, now));
}

function joinSeat(st, clientId, name) {
  if (st.phase !== 'lobby') return; // 开局后不能加入
  if (st.players.some((p) => p.clientId === clientId)) return; // 已在房
  const seat = st.players.find((p) => !p.clientId);
  if (!seat) return;
  seat.clientId = clientId; seat.isAI = false; seat.name = cleanName(name) || `玩家${seat.seat + 1}`;
}

function applyAction(st, clientId, action, body, now) {
  const me = st.players.find((p) => p.clientId === clientId);
  if (action === 'join') { joinSeat(st, clientId, body.name); return; }
  if (action === 'leave') { if (me && st.phase === 'lobby') { me.clientId = null; me.isAI = true; me.name = `席位${me.seat + 1}`; } return; }
  if (action === 'start') {
    if (st.phase === 'lobby' && (clientId === st.host || st.players.some((p) => p.clientId === clientId))) {
      if (st.players.some((p) => p.clientId)) startGame(st, now);
    }
    return;
  }
  if (!me || !me.alive) return;
  if (action === 'night') {
    const kind = body.kind;
    if (kind === 'wolf' && st.phase === 'night_wolf' && me.role === 'wolf') {
      const t = body.target | 0; if (P(st, t) && P(st, t).alive && P(st, t).role !== 'wolf') st.night.wolfVotes[me.seat] = t;
    } else if (kind === 'seer' && st.phase === 'night_seer' && me.role === 'seer' && !st.night.seerDone) {
      const t = body.target | 0; if (P(st, t) && P(st, t).alive && t !== me.seat) { st.seerChecks.push({ target: t, res: P(st, t).role === 'wolf' ? 'wolf' : 'good' }); st.night.seerDone = true; }
    } else if (kind === 'witch' && st.phase === 'night_witch' && me.role === 'witch' && !st.night.witchDone) {
      if (body.save && st.witch.antidote && st.night.wolfTarget != null) { st.night.saved = true; st.witch.antidote = false; }
      else if (body.poison != null && st.witch.poison) { const t = body.poison | 0; if (P(st, t) && P(st, t).alive && t !== me.seat && !st.night.saved) { st.night.poison = t; st.witch.poison = false; } }
      st.night.witchDone = true;
    }
    return;
  }
  if (action === 'speak' && st.phase === 'speak') {
    const cur = st.speak.order[st.speak.idx];
    if (cur === me.seat && !st.speak.spoke) {
      if (body.claimSeer && me.role === 'seer') { registerRealClaim(st, me.seat); if (!st.claims.find((c) => c.seat === me.seat).announced) { st.claims.find((c) => c.seat === me.seat).announced = true; logPush(st, 'claim', `🔮 ${nm(st, me.seat)} 跳预言家，公布查验。`, me.seat); } computeAIVotesAndIntents(st); }
      const t = cleanName0(body.text);
      if (t) logPush(st, 'speech', t, me.seat); else logPush(st, 'sys', `${nm(st, me.seat)} 选择过麦。`, me.seat);
      st.speak.spoke = true;
    }
    return;
  }
  if (action === 'vote' && st.phase === 'vote' && me.canVote) {
    const t = body.target == null ? -1 : (body.target | 0);
    st.votes[me.seat] = (t >= 0 && P(st, t) && P(st, t).alive && t !== me.seat) ? t : -1;
    return;
  }
  if (action === 'shoot' && st.phase === 'hunter' && st.pendingShoot === me.seat) {
    const t = body.target == null ? null : (body.target | 0);
    doShoot(st, me.seat, (t != null && P(st, t) && P(st, t).alive && t !== me.seat) ? t : null, now);
    return;
  }
}
const cleanName0 = (s) => (typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
