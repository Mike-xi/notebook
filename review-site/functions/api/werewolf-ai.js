// 狼人杀「AI 玩家发言」：客户端把每个 AI 的隐藏身份 + 本回合结构化意图（要不要跳预言家、
// 公布的查验、想投谁）连同公开日志发来，这里让 Workers AI 用自然中文替他们「润色」成一段发言。
// 策略由客户端的启发式大脑决定（保证逻辑自洽、离线也能玩），LLM 只负责把意图写成像人说的话。
//   GET  /api/werewolf-ai                 -> { models:[{id,label,hint}] }
//   POST /api/werewolf-ai {config,day,players,speakers,intents,log,model}
//        -> { speeches:[{seat,text}], source:'ai'|'heuristic' }
// 鉴权由 _middleware.js 处理；无 AI 绑定 / 出错时回退到模板发言。
const json = (o, s = 200) => Response.json(o, { status: s });

const MODELS = [
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B', hint: '强 · 默认' },
  { id: '@cf/qwen/qwen2.5-coder-32b-instruct', label: 'Qwen2.5 32B', hint: '推理型' },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 24B', hint: '均衡' },
  { id: '@cf/meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B', hint: '快' },
];
const MODEL_IDS = new Set(MODELS.map((m) => m.id));

export function onRequestGet() { return json({ models: MODELS }); }

const ROLE_CN = { wolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人', idiot: '白痴', villager: '平民' };
const nameOf = (players, seat) => { const p = players.find((x) => x.seat === seat); return p ? `${seat + 1}号(${p.name})` : `${seat + 1}号`; };

// ---------- 模板兜底：把结构化意图写成一句话 ----------
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function templateSpeech(players, sp, intent) {
  const me = sp.role;
  const accuseName = (intent && intent.accuse >= 0) ? nameOf(players, intent.accuse) : null;
  // 预言家公布查验（真预言家或狼人悍跳）
  if (intent && intent.claimSeer) {
    const reps = (intent.seerReports || []).map((r) => `${nameOf(players, r.target)}是${r.res === 'wolf' ? '查杀' : '金水'}`).join('，');
    const tail = accuseName ? `今天我带头票${accuseName}。` : '';
    return `我跳预言家。${reps ? '我的查验：' + reps + '。' : ''}${tail}`.trim();
  }
  // 女巫/猎人/平民/白痴的普通发言
  const goodLines = me === 'wolf'
    ? [`我是好人，昨晚信息不多，先听听预言家怎么说。`,
       `我盘了一下场，感觉${accuseName || '几个发言飘的人'}有点问题。`,
       `我站好人，建议大家跟紧预言家的查杀。`]
    : [`我是好人。${accuseName ? '我觉得' + accuseName + '有狼味，先投他。' : '今天信息太少，再观察一轮。'}`,
       `从发言看，${accuseName || '某些人'}逻辑很飘，我倾向出他。`,
       `我没什么强信息，跟预言家的刀走，${accuseName ? '今天投' + accuseName : '听预言家的'}。`];
  return pick(goodLines);
}

function heuristicSpeeches(players, speakers, intents) {
  return speakers.map((seat) => {
    const sp = players.find((p) => p.seat === seat) || { role: 'villager' };
    return { seat, text: templateSpeech(players, sp, intents && intents[seat]) };
  });
}

// ---------- LLM 发言 ----------
function buildPrompt(config, day, players, speakers, intents, log) {
  const alive = players.filter((p) => p.alive).map((p) => `${p.seat + 1}号(${p.name})`).join('、');
  const lines = [];
  lines.push(`你在主持一局中文《狼人杀》游戏，板子是「${config}」。现在是第 ${day} 天白天的发言阶段。`);
  lines.push(`存活玩家：${alive}。`);
  lines.push(`公开信息（所有人都看到的）：`);
  (log || []).slice(-24).forEach((l) => lines.push('· ' + l));
  lines.push('');
  lines.push(`请依次为下面这些玩家各写一段「第一人称发言」，每段 1~3 句、口语化、像真人玩狼人杀那样。严格按给定意图来写，不要暴露上帝视角，不要写旁白：`);
  speakers.forEach((seat, i) => {
    const p = players.find((x) => x.seat === seat);
    const it = (intents && intents[seat]) || {};
    const facts = [];
    facts.push(`真实身份=${ROLE_CN[p.role]}（保密，狼人要伪装成好人，绝不能自曝）`);
    if (it.claimSeer) {
      const reps = (it.seerReports || []).map((r) => `${nameOf(players, r.target)}=${r.res === 'wolf' ? '查杀(狼)' : '金水(好人)'}`).join('，');
      facts.push(`要跳预言家并公布查验：${reps || '（暂无查验）'}`);
    }
    if (it.accuse >= 0) facts.push(`今天想投/最怀疑：${nameOf(players, it.accuse)}`);
    if (it.defend) facts.push(`正在被怀疑，需要为自己辩护`);
    if (it.note) facts.push(it.note);
    lines.push(`(${i + 1}) ${p.seat + 1}号(${p.name})：${facts.join('；')}`);
  });
  lines.push('');
  lines.push(`只输出 JSON，格式：{"speeches":[{"seat":<座位号,0起>,"text":"发言"} ...]}，顺序与上面一致。不要输出任何额外文字。`);
  return lines.join('\n');
}

function parseSpeeches(txt, speakers) {
  if (!txt) return null;
  let obj = null;
  const m = txt.match(/\{[\s\S]*\}/);
  try { obj = JSON.parse(m ? m[0] : txt); } catch { obj = null; }
  const arr = obj && Array.isArray(obj.speeches) ? obj.speeches : (Array.isArray(obj) ? obj : null);
  if (!arr) return null;
  const out = [];
  const want = new Set(speakers);
  for (const e of arr) {
    const seat = e && (e.seat | 0);
    let t = e && typeof e.text === 'string' ? e.text : '';
    t = t.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 220);
    if (want.has(seat) && t) out.push({ seat, text: t });
  }
  return out.length ? out : null;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const config = body?.config === '444' ? '444' : '333';
  const day = Math.max(1, body?.day | 0 || 1);
  const players = Array.isArray(body?.players) ? body.players : [];
  const speakers = Array.isArray(body?.speakers) ? body.speakers.map((x) => x | 0) : [];
  const intents = body?.intents || {};
  const log = Array.isArray(body?.log) ? body.log : [];
  if (!players.length || !speakers.length) return json({ speeches: [], source: 'heuristic' });

  // 离线/无绑定：模板兜底
  if (!env || !env.AI) return json({ speeches: heuristicSpeeches(players, speakers, intents), source: 'heuristic' });

  const model = MODEL_IDS.has(body?.model) ? body.model : MODELS[0].id;
  try {
    const prompt = buildPrompt(config, day, players, speakers, intents, log);
    const r = await env.AI.run(model, {
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.85, max_tokens: 900,
    });
    const txt = (r && (r.response || r.result || '')) + '';
    const parsed = parseSpeeches(txt, speakers);
    if (parsed) {
      // 缺席的座位用模板补齐，保证每个发言者都有话
      const have = new Set(parsed.map((p) => p.seat));
      for (const seat of speakers) if (!have.has(seat)) {
        const sp = players.find((p) => p.seat === seat) || { role: 'villager' };
        parsed.push({ seat, text: templateSpeech(players, sp, intents[seat]) });
      }
      parsed.sort((a, b) => speakers.indexOf(a.seat) - speakers.indexOf(b.seat));
      return json({ speeches: parsed, source: 'ai' });
    }
  } catch (e) { /* 降级到模板 */ }
  return json({ speeches: heuristicSpeeches(players, speakers, intents), source: 'heuristic' });
}
