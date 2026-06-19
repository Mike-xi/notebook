// 英汉词典：AI 词汇深度分析。给定单词 + 已有释义，让 Workers AI 输出记忆法 / 例句 / 辨析 / 搭配。
// POST /api/dict-ai { word, phonetic?, translation? }  -> { analysis: "<markdown>" }
// 鉴权由 _middleware.js 拦在登录后。无 AI 绑定时优雅降级 503。
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

export async function onRequestPost({ request, env }) {
  if (!env.AI) return Response.json({ error: 'AI 未绑定（请在 Pages 后台加 AI binding）' }, { status: 503 });

  let b;
  try { b = await request.json(); } catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }
  const word = str(b?.word).slice(0, 60);
  if (!word) return Response.json({ error: '缺少单词' }, { status: 400 });
  const phonetic = str(b?.phonetic).slice(0, 60);
  const translation = str(b?.translation).slice(0, 600);

  const sys = '你是一位耐心、地道的英语老师，帮中国大学生深入掌握一个英语单词。'
    + '用简体中文回答，输出精炼的 Markdown，包含以下小标题（用 ## ）：\n'
    + '## 记忆方法 —— 词根词缀拆解或联想记忆，1-3 条。\n'
    + '## 地道例句 —— 3 条真实自然的英文例句，每条另起一行先英文后中文翻译（用 — 分隔）。\n'
    + '## 近义辨析 —— 列出 1-3 个近义词并说明与本词的细微区别；没有就写“无明显近义词”。\n'
    + '## 常见搭配 —— 3-5 个高频搭配/短语，附中文。\n'
    + '不要重复抄写已给的词典释义，不要寒暄，不要输出多余前后缀文字。';
  const user = `单词：${word}${phonetic ? `  /${phonetic}/` : ''}\n`
    + `词典释义：${translation || '(未提供)'}\n\n请给出深度分析。`;

  let text = '';
  try {
    const r = await env.AI.run(MODEL, {
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      max_tokens: 700,
      temperature: 0.5,
    });
    const rsp = r && (r.response ?? r.result?.response);
    text = typeof rsp === 'string' ? rsp : str(rsp);
  } catch {
    return Response.json({ error: 'AI 调用失败，请稍后再试' }, { status: 502 });
  }

  text = text.replace(/```\w*\n?/g, '').trim();
  if (!text) return Response.json({ error: 'AI 没有返回内容' }, { status: 502 });
  return Response.json({ analysis: text });
}
