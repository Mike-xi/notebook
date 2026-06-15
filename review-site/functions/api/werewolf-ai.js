// 狼人杀「独立 LLM 玩家」接口（solo 模式逐座位调用，每个 AI 是独立 agent）。
//   GET  /api/werewolf-ai                  -> { models, personas }
//   POST /api/werewolf-ai {kind, config, day, seat, role, name, persona, players, log, claims, priv, memory, model}
//        kind='turn' -> { seat, text, vote, claimSeer, frame, notes, source }   发言阶段：读全场自己决策
//        kind='vote' -> { seat, vote, notes, source }                            投票阶段：读完当天发言定票
// 真正的提示词/解析/兜底在 ../_lib/wwai.js，online 引擎也复用它。鉴权由 _middleware.js 处理。
import { MODELS, PERSONAS, genTurn, genVote } from '../_lib/wwai.js';

const json = (o, s = 200) => Response.json(o, { status: s });

export function onRequestGet() { return json({ models: MODELS, personas: PERSONAS }); }

function sanitizePriv(priv) {
  if (!priv || typeof priv !== 'object') return {};
  const out = {};
  if (Array.isArray(priv.mates)) out.mates = priv.mates.map((x) => x | 0);
  if (Array.isArray(priv.seerChecks)) out.seerChecks = priv.seerChecks.map((r) => ({ target: r.target | 0, res: r.res === 'wolf' ? 'wolf' : 'good' }));
  if (priv.nightKill != null) out.nightKill = priv.nightKill | 0;
  if (priv.antidote != null) out.antidote = !!priv.antidote;
  if (priv.poison != null) out.poison = !!priv.poison;
  if (priv.claimed != null) out.claimed = !!priv.claimed;
  if (priv.witchTurn != null) out.witchTurn = !!priv.witchTurn;
  return out;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (typeof body?.seat !== 'number' || !Array.isArray(body?.players) || !body?.role) {
    return json({ error: 'missing seat/players/role' }, 400);
  }
  const args = {
    config: body.config === '444' ? '444' : '333',
    day: Math.max(1, body.day | 0 || 1),
    seat: body.seat | 0,
    role: body.role,
    name: typeof body.name === 'string' ? body.name.slice(0, 24) : `${(body.seat | 0) + 1}号`,
    persona: body.persona,
    players: body.players.map((p) => ({ seat: p.seat | 0, name: String(p.name || '').slice(0, 24), alive: !!p.alive })),
    log: Array.isArray(body.log) ? body.log.slice(-40).map((x) => String(x).slice(0, 240)) : [],
    claims: Array.isArray(body.claims) ? body.claims.map((c) => ({
      seat: c.seat | 0,
      reports: Array.isArray(c.reports) ? c.reports.map((r) => ({ target: r.target | 0, res: r.res === 'wolf' ? 'wolf' : 'good' })) : [],
    })) : [],
    priv: sanitizePriv(body.priv),
    memory: typeof body.memory === 'string' ? body.memory.slice(0, 120) : '',
    model: body.model,
  };

  if (body.kind === 'vote') {
    const { vote, notes, source } = await genVote(env, args);
    return json({ seat: args.seat, vote, notes, source });
  }
  const { text, vote, claimSeer, frame, notes, source } = await genTurn(env, args);
  return json({ seat: args.seat, text, vote, claimSeer, frame, notes, source });
}
