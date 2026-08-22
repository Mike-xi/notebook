// POST /api/ai-detect  { text, models?: string[] }
//   -> { judges: [{ model, label, score, verdict, reasons[], likely, likelyWhy, error? }],
//        consensus: { score, verdict, spread, agreed } }
//
// AI 文本检测 · 引擎 B：多评委 LLM 判定 + 模型归因。
// 鉴权由 _middleware.js 统一处理（只有登录用户能访问 /api/*）。
//
// 为什么是「多评委」而不是一个模型说了算：单模型对这种主观判断的方差很大，
// 同一段文字换个模型能差 30 分。并排跑三个、把分歧量（spread）也回给前端，
// 比伪造一个精确的单一数字诚实得多——分歧大本身就是「这段不好判」的信息。
//
// 为什么不做真困惑度：那需要逐 token logprob，而 Workers AI 的输出 schema 只有
// response / usage / tool_calls，拿不到。真困惑度那一档（Fast-DetectGPT 曲率）
// 只能放浏览器里用 ONNX 小模型跑，见前端的引擎 C。
import { extractAIText, stripThink } from '../_lib/rag.js';

// 评委名单。全部在本账号上实测过：能调通、稳定吐 JSON、判断方向正确、3~5 秒出结果。
//
// 淘汰记录（别再往回加）：
//   · @cf/google/gemma-3-12b-it —— 5018 Account is not allowed to access（本账号无权限）。
//     注意 `_lib/rag.js` 的 CHAT_MODELS 里也还挂着它和 @cf/meta/llama-3.1-8b-instruct
//     （后者实际叫 -fp8），那两个在模型下拉里选中必挂。
//   · gpt-oss-120b / qwen3.8-27b / glm-4.7-flash / nemotron-3-120b / qwen3-30b —— 推理型模型，
//     思考 token 先吃掉预算，JSON 写一半就被 max_tokens 截断，而且要 5~16 秒。评委不该这么慢。
const JUDGES = [
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',     label: 'Llama 3.3 70B' },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 24B' },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct',      label: 'Llama 4 Scout' },
];
const JUDGE_BY_ID = new Map(JUDGES.map((j) => [j.id, j]));

const MAX_CHARS = 6000;
const VERDICTS = ['人写', 'AI 生成', '人机混合', '不确定'];
// 归因候选：只在这几个里挑，免得模型自由发挥出一堆不存在的名字
const FAMILIES = ['ChatGPT / GPT 系', 'Claude', 'Gemini', 'DeepSeek', '通义千问 Qwen', '文心/豆包等国产', '开源小模型', '说不好'];

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
};

// 提示词是调出来的，不是拍出来的。第一版只给了字段说明，结果 Llama 3.3 给一段
// 典型的模型输出打了 40 分「人写」，理由是「论证结构清晰、使用专业术语、有明确的论点」——
// 它把「写得好」当成了「人写」。加上下面的评分锚点和三条避坑说明之后，同一个模型
// 同一段文本从 40 变成 95，另两个评委也跟着稳了。改这段之前先想清楚要顶掉哪一条。
const SYS = `你是文本溯源分析员。判断给定文本由人类撰写还是大语言模型生成。
只输出一个 JSON 对象，禁止解释、禁止 Markdown 代码块。

字段：
score：整数 0-100。0=确定人写，100=确定 AI 生成。评分锚点：
  0-20  有个人经历、口语、情绪、错字、跳跃的思路
  21-40 大体像人写，但比较正式
  41-60 说不好
  61-80 偏 AI：套话多、结构工整、语气中性
  81-100 高度像 AI：三段式总分总、每段等长、「综上所述/值得注意的是」类连接词铺满
verdict：必须是 ${VERDICTS.map((v) => `"${v}"`).join(' / ')} 之一，且必须与 score 一致。
reasons：2-4 条中文短句，每条 ≤30 字，**必须引用原文里的具体词句**作为证据，不要写「感觉像」这类空话。
likely：若 score≥50，从 ${FAMILIES.map((v) => `"${v}"`).join(' / ')} 里挑一个最像的；否则填 "说不好"。
likelyWhy：一句话说明归因依据，≤25 字。

**判断时最容易犯的三个错，务必避开：**
1.「论证清晰／用词专业／逻辑严密」**不是**人写的证据 —— 模型最擅长的就是这个。别因为写得好就判人写。
2.「正式、不带情绪」**不等于** AI —— 论文、公文、技术文档本来就这样。要看有没有套话和空洞的排比，而不是看正不正式。
3. 具体的数字、专有名词、可验证的细节（型号、参数、地名、报错信息）是**偏人写**的信号，因为模型倾向于泛泛而谈。`;

export async function onRequestPost({ request, env }) {
  if (!env.AI) return Response.json({ error: 'AI 未绑定（请在 Pages 后台加 AI binding）' }, { status: 503 });

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }

  const text = str(body?.text).slice(0, MAX_CHARS);
  if (text.length < 60) return Response.json({ error: '文本太短，至少 60 字才判得动' }, { status: 400 });

  // 客户端可以指定评委子集（比如只想要快的那个），非法 id 一律丢弃
  const picked = Array.isArray(body?.models)
    ? body.models.map(str).filter((id) => JUDGE_BY_ID.has(id)).slice(0, JUDGES.length)
    : [];
  const panel = picked.length ? picked.map((id) => JUDGE_BY_ID.get(id)) : JUDGES;

  const user = `请分析下面这段文本（在 <text> 标签之间），按系统指令输出 JSON。\n<text>\n${text}\n</text>`;

  // 并发跑，单个评委挂掉不影响其他人 —— allSettled 而不是 all
  const settled = await Promise.allSettled(panel.map((j) => runJudge(env, j, user)));
  const judges = settled.map((s, i) => (s.status === 'fulfilled'
    ? s.value
    : { model: panel[i].id, label: panel[i].label, score: null, verdict: null, reasons: [], likely: '', likelyWhy: '', error: '调用失败' }));

  const good = judges.filter((j) => j.score != null);
  if (!good.length) return Response.json({ error: '所有评委都没能给出判断，稍后再试', judges }, { status: 502 });

  const scores = good.map((j) => j.score);
  const mean = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const spread = Math.max(...scores) - Math.min(...scores);

  return Response.json({
    judges,
    consensus: {
      score: mean,
      spread,
      // 分歧超过 30 分就别装作有共识了，前端会据此提示「这段不好判」
      agreed: spread <= 30,
      verdict: majority(good.map((j) => j.verdict)),
      likely: majority(good.filter((j) => j.score >= 50).map((j) => j.likely)),
    },
  });
}

async function runJudge(env, judge, user) {
  const out = { model: judge.id, label: judge.label, score: null, verdict: null, reasons: [], likely: '', likelyWhy: '' };
  let raw;
  try {
    const r = await env.AI.run(judge.id, {
      messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }],
      max_tokens: 420,
      temperature: 0.1,
    });
    raw = extractAIText(r);
  } catch (e) {
    // 把真实原因带出来。光写「调用失败」的话，某个模型稳定挂掉时根本查不出是
    // 模型下线了、参数不合法、还是超时——这次 Gemma 就是这么闷了半天。
    out.error = '调用失败：' + String((e && e.message) || e).slice(0, 120);
    return out;
  }

  const parsed = extractJSON(stripThink(raw));
  out.score = num(parsed.score);
  if (out.score == null) { out.error = '返回的不是可用 JSON'; return out; }

  const v = str(parsed.verdict);
  out.verdict = VERDICTS.includes(v) ? v : (out.score >= 65 ? 'AI 生成' : out.score <= 35 ? '人写' : '不确定');
  out.reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons.map(str).filter(Boolean).map((s) => s.slice(0, 60)).slice(0, 4)
    : [];
  const likely = str(parsed.likely);
  out.likely = FAMILIES.includes(likely) ? likely : '说不好';
  out.likelyWhy = str(parsed.likelyWhy).slice(0, 40);
  return out;
}

// 从模型输出里抠出 JSON 对象，容忍代码块包裹和前后多余文字（同 analyze.js 的做法）
function extractJSON(s) {
  if (!s) return {};
  let t = String(s).replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try { const o = JSON.parse(t); return o && typeof o === 'object' ? o : {}; }
  catch { return {}; }
}

// 众数；**平票时返回空串**。
// 三个评委各说各的（1:1:1）时，原来会把 Map 里第一个键当成「多数意见」报出去——
// 那是凭遍历顺序编出来的共识，比没有结论更糟。宁可留空让前端显示「各执一词」。
function majority(list) {
  const tally = new Map();
  for (const v of list) { if (v) tally.set(v, (tally.get(v) || 0) + 1); }
  let best = '', n = 0, tied = false;
  for (const [k, c] of tally) {
    if (c > n) { best = k; n = c; tied = false; }
    else if (c === n) tied = true;
  }
  return tied ? '' : best;
}

export async function onRequestGet() {
  return Response.json({ judges: JUDGES, maxChars: MAX_CHARS });
}
