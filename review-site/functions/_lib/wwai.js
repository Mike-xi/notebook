// 狼人杀「单座位 AI agent」共享库：每个 AI 玩家独立、各自的角色专属系统提示词 + 性格，
// 按发言顺序逐个生成（后说话的能看到前面已发生的发言）。solo（前端逐座位调用 /api/werewolf-ai）
// 与 online（服务端引擎 functions/api/werewolf.js 直接调用 genSpeech）共用同一套提示词与兜底。

export const MODELS = [
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B', hint: '强 · 默认' },
  { id: '@cf/qwen/qwen2.5-coder-32b-instruct', label: 'Qwen2.5 32B', hint: '推理型' },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 24B', hint: '均衡' },
  { id: '@cf/meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B', hint: '快' },
];
export const MODEL_IDS = new Set(MODELS.map((m) => m.id));
export const resolveModel = (m) => (MODEL_IDS.has(m) ? m : MODELS[0].id);

// 每个 AI 开局随机分一个性格，发言带上该风格
export const PERSONAS = ['稳健理性', '激进冲锋', '谨慎划水', '幽默话痨', '阴阳吐槽', '沉稳老练'];
const PERSONA_DESC = {
  稳健理性: '你说话冷静、讲逻辑、条理清楚',
  激进冲锋: '你说话强势、爱带节奏、敢开火踩人',
  谨慎划水: '你话不多、偏保守、爱跟票',
  幽默话痨: '你话比较多、爱开玩笑、偶尔跑题但还是会站边',
  阴阳吐槽: '你爱阴阳怪气、怼人，但观点鲜明',
  沉稳老练: '你像个老玩家、点评到位、不慌不忙',
};
const ROLE_DESC = {
  wolf: '你的真实身份是【狼人】（狼人阵营卧底）。目标是隐藏身份、误导好人、保护狼同伴，把好人尤其是预言家投出局。说话要伪装成好人，可以适当踩人、为同伴洗白、甚至悍跳预言家，但绝对不能暴露自己是狼。',
  seer: '你的真实身份是【预言家】（好人阵营核心）。你掌握每晚真实查验结果，要清楚公布查杀(狼)和金水(好人)，带领好人投狼，语气可信、有逻辑。',
  witch: '你的真实身份是【女巫】（好人）。你有解药/毒药的信息，发言要稳、帮好人梳理逻辑找狼，但别轻易暴露用药细节，除非有助于带队。',
  hunter: '你的真实身份是【猎人】（好人）。你出局时能开枪带走一人，可以说话强硬些、威慑狼人，帮好人定位狼。',
  idiot: '你的真实身份是【白痴】（好人）。你被投票出局会翻牌、免疫放逐，所以可以大胆怀疑、跳脸找狼。',
  villager: '你的真实身份是【平民】（好人）。你没有技能，靠发言逻辑、站边和投票帮好人找出狼人。',
};
const ROLE_CN = { wolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人', idiot: '白痴', villager: '平民' };

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const nameOf = (players, seat) => { const p = (players || []).find((x) => x.seat === seat); return p ? `${seat + 1}号(${p.name})` : `${seat + 1}号`; };

export function buildSeatPrompt({ config, day, seat, role, name, persona, players, log, intent }) {
  const alive = (players || []).filter((p) => p.alive).map((p) => `${p.seat + 1}号(${p.name})`).join('、');
  const L = [];
  L.push(`这是一局中文《狼人杀》（${config} 板），现在是第 ${day} 天白天的发言阶段。你是 ${seat + 1}号(${name})。`);
  L.push(ROLE_DESC[role] || ROLE_DESC.villager);
  if (persona && PERSONA_DESC[persona]) L.push(`你的说话风格：${PERSONA_DESC[persona]}。`);
  L.push(`存活玩家：${alive}。`);
  if (log && log.length) { L.push('目前公开发生的事和大家的发言（按时间顺序）：'); log.slice(-26).forEach((l) => L.push('· ' + l)); }
  const it = intent || {};
  const todo = [];
  if (it.claimSeer) {
    const reps = (it.seerReports || []).map((r) => `${nameOf(players, r.target)}是${r.res === 'wolf' ? '查杀(狼)' : '金水(好人)'}`).join('，');
    todo.push(`你要跳预言家并公布查验：${reps || '（暂无查验）'}`);
  }
  if (it.accuse >= 0) todo.push(`你最怀疑/今天想投：${nameOf(players, it.accuse)}`);
  if (it.defend) todo.push('你正被怀疑，要为自己辩护');
  if (it.note) todo.push(it.note);
  if (todo.length) L.push('你这轮的打算：' + todo.join('；') + '。');
  L.push('请只用第一人称说一段你的发言，1~3 句，口语化、像真人玩狼人杀；要符合你的身份意图与说话风格；不要写旁白、不要解释、不要复述规则、不要暴露上帝视角。直接输出发言内容本身。');
  return L.join('\n');
}

// 离线/失败时的模板发言（按身份与意图，带一点性格色彩）
export function heuristicSeatSpeech({ role, persona, players, intent }) {
  const it = intent || {};
  const accuse = it.accuse >= 0 ? nameOf(players, it.accuse) : null;
  if (it.claimSeer) {
    const reps = (it.seerReports || []).map((r) => `${nameOf(players, r.target)}是${r.res === 'wolf' ? '查杀' : '金水'}`).join('，');
    return `我跳预言家。${reps ? '我的查验：' + reps + '。' : '目前还没查到狼。'}${accuse ? '今天我带头票' + accuse + '。' : ''}`;
  }
  if (role === 'wolf') {
    return pick([
      `我是好人，昨晚信息不多，先听听预言家怎么说。`,
      `我盘了下场，${accuse || '有几个发言飘的人'}我有点怀疑。`,
      `站好人，建议大家跟紧预言家的查杀走。`,
    ]);
  }
  return pick([
    `我是好人。${accuse ? '我觉得' + accuse + '有狼味，先投他。' : '今天信息太少，再观察一轮。'}`,
    `从发言看，${accuse || '某些人'}逻辑挺飘，我倾向出他。`,
    `没什么强信息，我跟预言家走，${accuse ? '今天投' + accuse : '听预言家的'}。`,
  ]);
}

function cleanText(t) {
  if (!t) return '';
  t = ('' + t).replace(/[\u0000-\u001f\u007f]/g, ' ');
  t = t.replace(/^[\s"'「『（(]*\d*号?[（(][^）)]*[)）][:：]?\s*/, ''); // 去掉开头自报「3号(阿强):」
  t = t.replace(/^[\s"'「『]+/, '').replace(/["'」』]+\s*$/, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, 180);
}

// 生成单个座位的发言：返回 { text, source }
export async function genSpeech(env, args) {
  if (!env || !env.AI) return { text: heuristicSeatSpeech(args), source: 'heuristic' };
  const model = resolveModel(args.model);
  try {
    const prompt = buildSeatPrompt(args);
    const r = await env.AI.run(model, { messages: [{ role: 'user', content: prompt }], temperature: 0.9, max_tokens: 180 });
    const txt = cleanText(r && (r.response || r.result || ''));
    if (txt && txt.length >= 2) return { text: txt, source: 'ai' };
  } catch (e) { /* 降级 */ }
  return { text: heuristicSeatSpeech(args), source: 'heuristic' };
}

export { ROLE_CN };
