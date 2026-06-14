// 狼人杀「单座位 AI 发言」接口（solo 模式逐座位调用，每个 AI 是独立 agent）。
//   GET  /api/werewolf-ai                         -> { models, personas }
//   POST /api/werewolf-ai {config,day,seat,role,name,persona,players,log,intent,model}
//        -> { seat, text, source }
// 真正的提示词/兜底在 ../_lib/wwai.js，online 引擎也复用它。鉴权由 _middleware.js 处理。
import { MODELS, PERSONAS, genSpeech } from '../_lib/wwai.js';

const json = (o, s = 200) => Response.json(o, { status: s });

export function onRequestGet() { return json({ models: MODELS, personas: PERSONAS }); }

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (typeof body?.seat !== 'number' || !Array.isArray(body?.players) || !body?.role) {
    return json({ error: 'missing seat/players/role' }, 400);
  }
  const { text, source } = await genSpeech(env, {
    config: body.config === '444' ? '444' : '333',
    day: Math.max(1, body.day | 0 || 1),
    seat: body.seat | 0,
    role: body.role,
    name: typeof body.name === 'string' ? body.name.slice(0, 24) : `${(body.seat | 0) + 1}号`,
    persona: body.persona,
    players: body.players,
    log: Array.isArray(body.log) ? body.log : [],
    intent: body.intent || {},
    model: body.model,
  });
  return json({ seat: body.seat | 0, text, source });
}
