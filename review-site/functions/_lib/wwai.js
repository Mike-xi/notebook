// 狼人杀「独立 LLM 玩家」共享大脑库。
// 每个 AI 是一个独立 agent：轮到它时读【完整公开对话(含真人玩家发言) + 自己的合法私有信息 + 跨回合记忆】，
// 由 LLM 自己决定「说什么 + 投谁 + 跳不跳预言家」，而不是把预先算好的意图润色成台词。
// solo（前端逐座位调用 /api/werewolf-ai）与 online（functions/api/werewolf.js）共用本库。
// 关键纪律：构造每个座位的提示词时，只喂它合法该知道的信息，绝不泄露别人身份（上帝视角）。
// LLM 不可用 / 解析失败 → 回退到启发式（heuristicSeatSpeech + 调用方自带的启发式投票），保证离线也能完整跑完。

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
  wolf: '你的真实身份是【狼人】（狼人阵营卧底）。目标：隐藏身份、误导好人、保护狼同伴，把好人尤其是预言家投出局。说话要伪装成好人，可以踩人、为同伴洗白，甚至悍跳预言家（伪造一个查杀去对跳真预言家），但绝不能暴露自己是狼，绝不能投/陷害自己的狼同伴。',
  seer: '你的真实身份是【预言家】（好人阵营核心）。你掌握每晚真实查验结果，要清楚地公布查杀(狼)和金水(好人)，带领好人投狼，语气可信、有逻辑。',
  witch: '你的真实身份是【女巫】（好人）。你有解药/毒药，发言要稳、帮好人梳理逻辑找狼，但别轻易暴露用药细节，除非有助于带队。',
  hunter: '你的真实身份是【猎人】（好人）。你出局时能开枪带走一人，可以说话强硬些、威慑狼人，帮好人定位狼。',
  idiot: '你的真实身份是【白痴】（好人）。被投票出局会翻牌、免疫放逐，所以可以大胆怀疑、跳脸找狼。',
  villager: '你的真实身份是【平民】（好人）。没有技能，靠发言逻辑、站边和投票帮好人找出狼人。',
};
const ROLE_CN = { wolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人', idiot: '白痴', villager: '平民' };

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const nameOf = (players, seat) => { const p = (players || []).find((x) => x.seat === seat); return p ? `${seat + 1}号(${p.name})` : `${seat + 1}号`; };

// ---------------- 公共上下文块（所有座位都能看到的信息） ----------------
function contextLines({ config, day, players, log, claims, priv }) {
  const L = [];
  const alive = (players || []).filter((p) => p.alive).map((p) => `${p.seat + 1}号(${p.name})`).join('、');
  L.push(`存活玩家：${alive}。`);
  // 公开的跳预言家/查验情况（不暴露真假，让你自己判断）
  if (claims && claims.length) {
    L.push('目前公开的「预言家身份」声明（真假需你自己判断）：');
    claims.forEach((c) => {
      const reps = (c.reports || []).map((r) => `${nameOf(players, r.target)}是${r.res === 'wolf' ? '查杀(狼)' : '金水(好人)'}`).join('，');
      L.push(`· ${nameOf(players, c.seat)} 自称预言家${reps ? '，公布：' + reps : '（暂未给查验）'}`);
    });
  }
  if (log && log.length) {
    L.push('到目前为止公开发生的事 & 大家的发言（按时间顺序）：');
    log.slice(-30).forEach((l) => L.push('· ' + l));
  }
  return L;
}

// 私有信息块（只给该座位合法可知的）
function privateLines({ role, name, seat, priv, players }) {
  const L = [];
  priv = priv || {};
  if (role === 'wolf') {
    const mates = (priv.mates || []).filter((s) => s !== seat).map((s) => nameOf(players, s)).join('、');
    L.push(`【只有你和狼队友知道】你的狼同伴是：${mates || '（已没有其他存活狼队友）'}。务必保护他们，绝不能投他们或把他们报成查杀。`);
    if (priv.nightKill != null) L.push(`今晚狼队刀的是 ${nameOf(players, priv.nightKill)}。`);
  }
  if (role === 'seer' && priv.seerChecks && priv.seerChecks.length) {
    const reps = priv.seerChecks.map((r) => `${nameOf(players, r.target)}=${r.res === 'wolf' ? '查杀(狼)' : '金水(好人)'}`).join('，');
    L.push(`【只有你知道】你的真实查验结果：${reps}。`);
    if (priv.claimed) L.push('你已经公开跳了预言家，请把你的查验讲清楚并带好人投狼。');
  }
  if (role === 'witch') {
    L.push(`【只有你知道】你的解药${priv.antidote ? '还在' : '已用'}、毒药${priv.poison ? '还在' : '已用'}。`);
    if (priv.nightKill != null && priv.witchTurn) L.push(`今晚被刀的是 ${nameOf(players, priv.nightKill)}。`);
  }
  return L;
}

// ---------------- 发言+决策 提示词 ----------------
export function buildTurnPrompt(args) {
  const { config, day, seat, role, name, persona, players, memory } = args;
  const L = [];
  L.push(`这是一局中文《狼人杀》（${config} 板：333=3狼3神3民共9人，444=4狼4神4民共12人）。现在是第 ${day} 天白天的发言阶段。`);
  L.push(`你是 ${seat + 1}号(${name})。${ROLE_DESC[role] || ROLE_DESC.villager}`);
  if (persona && PERSONA_DESC[persona]) L.push(`你的说话风格：${PERSONA_DESC[persona]}。`);
  privateLines(args).forEach((l) => L.push(l));
  contextLines(args).forEach((l) => L.push(l));
  if (memory) L.push(`你之前几轮记下的判断（只有你自己知道）：${memory}`);
  L.push('');
  L.push('现在轮到你发言。请仔细读上面所有人的发言（尤其是真人玩家说的话），结合你的身份和已知信息做出**你自己的真实判断**：要不要回应/反驳某人、怀疑谁、相信哪个预言家、今天想投谁。');
  L.push('严格只输出一个 JSON 对象（不要任何额外文字、不要代码块标记），字段如下：');
  L.push('{');
  L.push('  "say": "你的发言，第一人称、口语化、1~3句、像真人玩狼人杀，要针对当前局势和别人的话，不要复述规则、不要旁白、不要暴露上帝视角",');
  L.push('  "vote_seat": 你目前最想投出的人的号数（整数，如 5 表示5号；-1 表示暂不确定）,');
  L.push(`  "claim_seer": ${role === 'wolf' ? 'true/false（你这轮要不要悍跳预言家、伪造查验去对抗真预言家）' : 'false（你不是预言家就填 false）'},`);
  if (role === 'wolf') L.push('  "frame_seat": 若你悍跳预言家，要伪报成「查杀」的那个人的号数（通常是真预言家或威胁大的好人，整数；不悍跳填 -1，绝不能填你的狼队友）,');
  L.push('  "notes": "给你自己的简短备忘≤40字（场上谁可疑/你的计划），下一轮会提醒你，保持判断连贯"');
  L.push('}');
  return L.join('\n');
}

// ---------------- 投票 提示词（读完当天全部发言后定票） ----------------
export function buildVotePrompt(args) {
  const { config, day, seat, role, name, players, memory } = args;
  const L = [];
  L.push(`这是一局中文《狼人杀》（${config} 板）第 ${day} 天的投票阶段。你是 ${seat + 1}号(${name})。${ROLE_DESC[role] || ROLE_DESC.villager}`);
  privateLines(args).forEach((l) => L.push(l));
  contextLines(args).forEach((l) => L.push(l));
  if (memory) L.push(`你的备忘：${memory}`);
  L.push('');
  L.push('今天所有人都发言完了。请综合今天的全部发言（尤其真人玩家说的）做出你的最终投票决定。');
  if (role === 'wolf') L.push('你是狼：投票要把好人（最好是真预言家或带节奏的好人）投出去，绝不能投你的狼队友。');
  else L.push('你是好人：把你认为最像狼的人投出去；可以跟随你相信的预言家的查杀，也可以根据发言独立判断。');
  L.push('严格只输出一个 JSON 对象：{ "vote_seat": 你要投的人的号数（整数，-1 表示弃票）, "notes": "≤30字理由" }');
  return L.join('\n');
}

// ---------------- 离线/失败兜底：模板发言 ----------------
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
  t = ('' + t).replace(/[\x00-\x1f\x7f]/g, ' ');
  t = t.replace(/^[\s"'「『（(]*\d*号?[（(][^）)]*[)）][:：]?\s*/, ''); // 去掉开头自报「3号(阿强):」
  t = t.replace(/^[\s"'「『]+/, '').replace(/["'」』]+\s*$/, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, 180);
}

// 从模型输出里宽松抽取第一个 JSON 对象
function extractJSON(raw) {
  if (!raw) return null;
  let s = ('' + raw).trim();
  // 去掉 ```json ... ``` 包裹
  s = s.replace(/```(?:json)?/gi, '').trim();
  const i = s.indexOf('{');
  if (i < 0) return null;
  // 从第一个 { 起做括号匹配，容忍尾部多余文本
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (inStr) {
      if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
  }
  if (end < 0) return null;
  const frag = s.slice(i, end + 1);
  try { return JSON.parse(frag); } catch { return null; }
}

// 取出模型决策：Workers AI 的 response 可能已被自动解析成对象，也可能是带 ```json 围栏的字符串。
// 返回 { obj:解析出的对象或null, raw:原始字符串(对象时为'') }
function aiPayload(r) {
  const resp = r && (r.response !== undefined ? r.response : r.result);
  if (resp && typeof resp === 'object') return { obj: resp, raw: '' };
  const raw = (resp == null ? '' : String(resp));
  return { obj: extractJSON(raw), raw };
}

// 号数(1-based 或 0-based 都尽量容错) -> 0-based 座位；非法返回 null
function toSeat0(n, players) {
  if (n == null) return null;
  let v = parseInt(n, 10);
  if (isNaN(v)) return null;
  const max = (players || []).length;
  // 模型被要求用 1-based「号」；若给了 0..max-1 也接受为 0-based 的边界情况由调用方校验
  if (v >= 1 && v <= max) return v - 1;
  if (v >= 0 && v < max) return v; // 容错：模型给了 0-based
  return null;
}

// 校验一个投/陷害目标是否合法
function validTarget(seat0, args, { allowSelf = false } = {}) {
  const { players, seat, role, priv } = args;
  if (seat0 == null) return false;
  const p = (players || []).find((x) => x.seat === seat0);
  if (!p || !p.alive) return false;
  if (!allowSelf && seat0 === seat) return false;
  if (role === 'wolf' && priv && Array.isArray(priv.mates) && priv.mates.includes(seat0)) return false; // 狼不投/陷害队友
  return true;
}

function heuristicTurn(args) {
  const { role, priv } = args;
  const intent = {};
  if (role === 'seer' && priv && priv.seerChecks) { intent.claimSeer = true; intent.seerReports = priv.seerChecks; }
  return { text: heuristicSeatSpeech({ ...args, intent }), vote: null, claimSeer: false, frame: null, notes: '', source: 'heuristic' };
}

// ---------------- 生成单座位的「回合决策」：{ text, vote, claimSeer, frame, notes, source } ----------------
export async function genTurn(env, args) {
  if (!env || !env.AI) return heuristicTurn(args);
  const model = resolveModel(args.model);
  try {
    const prompt = buildTurnPrompt(args);
    const r = await env.AI.run(model, { messages: [{ role: 'user', content: prompt }], temperature: 0.85, max_tokens: 360 });
    const { obj, raw } = aiPayload(r);
    if (obj && typeof obj.say === 'string') {
      const text = cleanText(obj.say);
      if (text && text.length >= 2) {
        const voteSeat = toSeat0(obj.vote_seat, args.players);
        const vote = validTarget(voteSeat, args) ? voteSeat : null;
        let claimSeer = !!obj.claim_seer;
        let frame = null;
        if (args.role === 'wolf' && claimSeer) {
          const f = toSeat0(obj.frame_seat, args.players);
          if (validTarget(f, args)) frame = f; else claimSeer = false; // 悍跳必须有合法的伪查杀目标
        }
        if (args.role !== 'wolf') claimSeer = false; // 只有狼能凭本函数主动悍跳；真预言家的 claim 由调用方注册
        const notes = typeof obj.notes === 'string' ? obj.notes.slice(0, 60) : '';
        return { text, vote, claimSeer, frame, notes, source: 'ai' };
      }
    }
    // JSON 没解析出来，但拿到了纯文本 → 当作发言用（投票交给调用方启发式）。
    // 但若文本看起来是残缺 JSON（含 { 或 "say"），别把它当台词说出来，改走启发式。
    const looksJSON = /[{}]|"\s*say\s*"/i.test(raw || '');
    const fallbackText = cleanText(raw);
    if (!looksJSON && fallbackText && fallbackText.length >= 2) return { text: fallbackText, vote: null, claimSeer: false, frame: null, notes: '', source: 'ai-text' };
  } catch (e) { /* 降级 */ }
  return heuristicTurn(args);
}

// ---------------- 投票阶段定票：{ vote, notes, source }（vote 为 null 时调用方用自带启发式） ----------------
export async function genVote(env, args) {
  if (!env || !env.AI) return { vote: null, notes: '', source: 'heuristic' };
  const model = resolveModel(args.model);
  try {
    const prompt = buildVotePrompt(args);
    const r = await env.AI.run(model, { messages: [{ role: 'user', content: prompt }], temperature: 0.6, max_tokens: 120 });
    const { obj } = aiPayload(r);
    if (obj) {
      const voteSeat = toSeat0(obj.vote_seat, args.players);
      const vote = validTarget(voteSeat, args) ? voteSeat : (parseInt(obj.vote_seat, 10) === -1 ? -1 : null);
      const notes = typeof obj.notes === 'string' ? obj.notes.slice(0, 50) : '';
      return { vote, notes, source: 'ai' };
    }
  } catch (e) { /* 降级 */ }
  return { vote: null, notes: '', source: 'heuristic' };
}

// 兼容旧调用：只取发言文本
export async function genSpeech(env, args) {
  const t = await genTurn(env, args);
  return { text: t.text, source: t.source };
}

export { ROLE_CN };
