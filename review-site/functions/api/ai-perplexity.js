// POST /api/ai-perplexity  { text }
//   -> { model, tokens, ppl, lnppl, top1, buckets:{top1,top10,top100,rest}, score, marks:[{t,rank,lp}] }
//
// AI 文本检测 · 引擎 C：真·困惑度（GLTR 那一套）。
//
// 这是三档里唯一有学术依据的：把文本喂给一个参照语言模型，看它**事先**多大程度上
// 能猜中每一个 token。模型生成的文本，token 绝大多数正好是参照模型的第一选择
// （rank=1）、困惑度很低；人写的会不断冒出模型想不到的词。
// 分桶画法出自 GLTR（Gehrmann et al., ACL 2019 demo）：rank 1 / 2-10 / 11-100 / >100。
//
// —— 关于「Workers AI 拿不到 logprob」的更正 ——
// 官方文档给每个模型列的输出 schema 只有 response / usage / tool_calls，据此我一开始
// 判定服务端算不了困惑度。**这是错的**：vLLM 后端的模型在 chat 通道（messages）上
// 透传 `prompt_logprobs`，返回每个 prompt token 的 logprob 和 rank。实测：
//   · 只有 messages 通道有；`prompt` + raw:true 那条路返回 undefined
//   · 各模型区分度差别很大，llama-3.3-70b-fp8-fast 直接给出 ppl=188145/top1=0% 的废数据，
//     gpt-oss-120b 三种样本一律 ppl~1500/top1~21%（没有区分度）
//   · mistral-small-3.1-24b 最干净：AI 样本 ppl 5.3/top1 65%，人写随笔 ppl 37.7/top1 43%
import { getRole } from '../_lib/auth.js';

// 参照模型定死不给选：阈值是按它的分布标定的，换一个模型这些数就全不作数了。
const MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
// 正文在 chat 模板里的边界靠这两个特殊 token 定位。
// **不能靠拼接 decoded_token 再字符串匹配**：CJK 字符会被拆成字节级 token，
// 单独解码是空串（实测「工具栏」回来是 ["工","具","",""]），拼出来的串跟原文对不上。
const MARK_BEGIN = '[INST]';
const MARK_END = '[/INST]';

const MAX_CHARS = 4000;   // 再长响应体里的 prompt_logprobs 会很大，收益也不再增加

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ramp = (v, lo, hi) => clamp01((v - lo) / (hi - lo));

export async function onRequestPost({ request, env }) {
  if (!env.AI) return Response.json({ error: 'AI 未绑定（请在 Pages 后台加 AI binding）' }, { status: 503 });

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }

  const text = String(body?.text || '').trim().slice(0, MAX_CHARS);
  if (text.length < 60) return Response.json({ error: '文本太短，至少 60 字才算得出稳定的困惑度' }, { status: 400 });

  let pl;
  try {
    const r = await env.AI.run(MODEL, {
      messages: [{ role: 'user', content: text }],
      max_tokens: 1,           // 一个字都不用它生成，要的只是 prompt 那一侧的概率
      prompt_logprobs: 0,      // 0 = 只要实际 token 自己的 logprob 和 rank
    });
    pl = r && (r.prompt_logprobs || r.result?.prompt_logprobs);
  } catch (e) {
    return Response.json({ error: '参照模型调用失败：' + String((e && e.message) || e).slice(0, 120) }, { status: 502 });
  }
  if (!Array.isArray(pl)) {
    return Response.json({ error: '这个部署上的 Workers AI 没有回传 prompt_logprobs，引擎 C 不可用' }, { status: 503 });
  }

  // 每个槽位是 { "<tokenId>": { decoded_token, logprob, rank } }；首个 token 没有条件概率，是 null
  const toks = pl.map((slot) => (slot ? Object.values(slot)[0] : null));

  let start = 0, end = toks.length;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] && toks[i].decoded_token === MARK_BEGIN) { start = i + 1; break; }
  }
  for (let i = toks.length - 1; i >= 0; i--) {
    if (toks[i] && toks[i].decoded_token === MARK_END) { end = i; break; }
  }
  if (end - start < 10) { start = Math.min(2, toks.length); end = toks.length; }   // 模板变了就退回全量

  const buckets = { top1: 0, top10: 0, top100: 0, rest: 0 };
  const marks = [];
  let sum = 0, n = 0;
  for (let i = start; i < end; i++) {
    const e = toks[i];
    if (!e || typeof e.logprob !== 'number' || !Number.isFinite(e.logprob)) continue;
    sum += e.logprob; n++;
    const rk = Number(e.rank) || 9999;
    if (rk === 1) buckets.top1++;
    else if (rk <= 10) buckets.top10++;
    else if (rk <= 100) buckets.top100++;
    else buckets.rest++;
    // 前端画 GLTR 色带用；token 文本可能是空串（字节级切分），前端按空串合并显示
    if (marks.length < 1200) marks.push({ t: e.decoded_token || '', rank: rk, lp: Math.round(e.logprob * 100) / 100 });
  }
  if (n < 10) return Response.json({ error: '没取到足够的 token 概率' }, { status: 502 });

  const lnppl = -sum / n;               // 平均负对数似然
  const ppl = Math.exp(lnppl);
  const top1 = buckets.top1 / n;

  // 阈值按上面那三份对照样本在本模型下的实测值标的（AI ln≈1.7/top1 .65，
  // 学术人写 ln≈2.5/.58，口语人写 ln≈3.6/.43）。样本量很小，只当粗刻度用。
  const score = Math.round(100 * clamp01(0.6 * ramp(lnppl, 4.0, 1.4) + 0.4 * ramp(top1, 0.35, 0.70)));

  return Response.json({
    model: MODEL,
    tokens: n,
    ppl: Math.round(ppl * 10) / 10,
    lnppl: Math.round(lnppl * 1000) / 1000,
    top1: Math.round(top1 * 1000) / 1000,
    buckets,
    score,
    marks,
    // 管理员才回传原始 token 数，方便排查；普通用户不需要
    debug: (await getRole(request, env)) === 'admin' ? { rawTokens: toks.length, span: [start, end] } : undefined,
  });
}
