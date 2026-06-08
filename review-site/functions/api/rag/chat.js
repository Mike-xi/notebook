// POST /api/rag/chat  { file, question, quote?, history? }
//   -> { answer, sources:[heading], retrieved }
// 检索 Vectorize（按 file 过滤）+ 取用户高亮/书签 -> 拼 prompt -> llama-3.3-70b 作答。
// 鉴权由 _middleware.js 处理。
import { ensureRagSchema, embed, CHAT_MODEL, CHAT_MODELS, resolveChatModel } from '../../_lib/rag.js';
import { ensureHighlightsSchema } from '../../_lib/db.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

// GET /api/rag/chat -> 可选模型清单（前端下拉据此渲染，单一数据源）。
export function onRequestGet() {
  return Response.json({ models: CHAT_MODELS, default: CHAT_MODEL });
}

export async function onRequestPost({ request, env }) {
  if (!env.AI) return Response.json({ error: 'AI 未绑定' }, { status: 503 });
  await ensureRagSchema(env);

  let b;
  try { b = await request.json(); } catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }
  const file = str(b?.file);
  const question = str(b?.question).slice(0, 1000);
  const quote = str(b?.quote).slice(0, 2000);
  const model = resolveChatModel(b?.model);
  if (!question) return Response.json({ error: '请输入问题' }, { status: 400 });

  // 1) 向量检索（按当前课程过滤）
  let matches = [];
  if (env.VECTORIZE && file) {
    try {
      const [qv] = await embed(env, [question]);
      if (qv) {
        const res = await env.VECTORIZE.query(qv, { topK: 6, returnMetadata: 'all', filter: { file: { $eq: file } } });
        matches = (res && res.matches) || [];
      }
    } catch {}
  }

  // 2) 用户高亮 + 书签
  let highlights = [], bookmarks = [];
  try {
    await ensureHighlightsSchema(env);
    const h = await env.DB.prepare('SELECT text, note FROM highlights WHERE file = ? ORDER BY start_off ASC LIMIT 30').bind(file).all();
    highlights = h.results || [];
  } catch {}
  try {
    const bk = await env.DB.prepare('SELECT title, scroll_pct FROM bookmarks WHERE file = ? ORDER BY scroll_pct ASC LIMIT 20').bind(file).all();
    bookmarks = bk.results || [];
  } catch {}

  // 3) 拼上下文
  const ctx = matches.map((m, i) => `[片段${i + 1}|${str(m.metadata?.heading) || '正文'}] ${str(m.metadata?.text)}`).join('\n');
  const hlText = highlights.map((h) => `• ${str(h.text)}${h.note ? `（批注：${str(h.note)}）` : ''}`).join('\n');
  const bmText = bookmarks.map((bm) => `• ${str(bm.title)}（约 ${Math.round((bm.scroll_pct || 0) * 100)}% 处）`).join('\n');

  const sys = '你是这篇复习笔记的 AI 助教。优先依据下面的【笔记片段】回答，并明确指出内容大致在哪个小节（用片段里给出的小节标题）。'
    + '结合【我的高亮重点】和【我的书签】理解用户的关注点。若【笔记片段】没有覆盖问题，就说明“笔记里没有直接提到”，再用你的知识简要补充并标注“（补充）”。'
    + '回答用简体中文，简明扼要、适当分点，不要编造笔记里不存在的内容。';
  let user = '';
  if (ctx) user += `【笔记片段】\n${ctx}\n\n`;
  if (hlText) user += `【我的高亮重点】\n${hlText}\n\n`;
  if (bmText) user += `【我的书签】\n${bmText}\n\n`;
  if (quote) user += `【我正在看的段落】\n${quote}\n\n`;
  user += `问题：${question}`;

  let answer = '';
  try {
    const r = await env.AI.run(model, {
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      max_tokens: 700,
      temperature: 0.3,
    });
    const rsp = r && (r.response ?? r.result?.response);
    answer = typeof rsp === 'string' ? rsp : (rsp ? JSON.stringify(rsp) : '');
    
    // Strip <think>...</think> tags if present, specifically for deepseek-r1
    if (model.includes('deepseek-r1')) {
      answer = answer.replace(/<think>[\s\S]*?<\/think>\n*/g, '');
    }
  } catch {
    return Response.json({ error: 'AI 调用失败，请稍后再试' }, { status: 502 });
  }

  // 4) 来源小节（去重）
  const sources = [], seen = new Set();
  for (const m of matches) {
    const h = str(m.metadata?.heading);
    if (h && !seen.has(h)) { seen.add(h); sources.push(h); }
  }

  return Response.json({ answer: answer.trim(), sources: sources.slice(0, 4), retrieved: matches.length });
}
