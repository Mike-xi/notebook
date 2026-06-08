// POST /api/omni  { question, model?, staticCourses?:[{title,subject,description}] }
//   -> { answer }
// 「全能问答」：把用户的全部课程（动态课程含正文摘录 + 静态课程元数据）、阅读进度、
// 操作日志拼成上下文，交给所选模型作答。鉴权由 _middleware.js 处理。
// GET /api/omni -> { models, default }（前端下拉用，与课程内对话共用同一份清单）
import { ensureCoursesSchema, ensureLogsSchema } from '../_lib/db.js';
import { CHAT_MODELS, CHAT_MODEL, resolveChatModel } from '../_lib/rag.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const stripText = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const fmtDate = (ts) => { try { return new Date(ts).toLocaleDateString('zh-CN'); } catch { return ''; } };

export function onRequestGet() {
  return Response.json({ models: CHAT_MODELS, default: CHAT_MODEL });
}

export async function onRequestPost({ request, env }) {
  if (!env.AI) return Response.json({ error: 'AI 未绑定' }, { status: 503 });
  await ensureCoursesSchema(env);

  let b;
  try { b = await request.json(); } catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }
  const question = str(b?.question).slice(0, 1000);
  if (!question) return Response.json({ error: '请输入问题' }, { status: 400 });
  const model = resolveChatModel(b?.model);

  // 1) 动态课程（含正文摘录）
  let dynRows = [];
  try {
    const r = await env.DB.prepare(
      'SELECT file, title, subject, description, tags, kind, html, created_at FROM courses ORDER BY created_at DESC'
    ).all();
    dynRows = r.results || [];
  } catch {}

  // 2) 阅读进度
  const pctMap = {};
  try {
    const r = await env.DB.prepare('SELECT file, scroll_pct FROM progress').all();
    for (const p of (r.results || [])) pctMap[p.file] = p.scroll_pct;
  } catch {}

  // 3) 操作日志（近 40 条）
  let logs = [];
  try {
    await ensureLogsSchema(env);
    const r = await env.DB.prepare('SELECT type, detail, created_at FROM logs ORDER BY created_at DESC LIMIT 40').all();
    logs = r.results || [];
  } catch {}

  // 4) 静态课程元数据（客户端传入，无正文）
  const staticCourses = Array.isArray(b?.staticCourses) ? b.staticCourses.slice(0, 50) : [];

  // ===== 拼上下文（限制正文摘录总量，避免超出模型预算）=====
  let excerptBudget = 9000;
  const courseLines = [];
  for (const c of dynRows) {
    let tags = '';
    try { const t = JSON.parse(c.tags || '[]'); if (Array.isArray(t)) tags = t.join('、'); } catch {}
    const pct = pctMap[c.file] ? `，已读 ${Math.round(pctMap[c.file] * 100)}%` : '';
    let line = `• [${c.kind}]《${str(c.title)}》｜学科：${str(c.subject) || '—'}｜简介：${str(c.description) || '—'}`
      + `${tags ? `｜标签：${tags}` : ''}｜创建：${fmtDate(c.created_at)}${pct}`;
    if (c.kind !== 'pdf' && excerptBudget > 0) {
      const ex = stripText(c.html).slice(0, Math.min(500, excerptBudget));
      if (ex) { excerptBudget -= ex.length; line += `\n   摘录：${ex}…`; }
    }
    courseLines.push(line);
  }
  for (const c of staticCourses) {
    courseLines.push(`•《${str(c?.title)}》｜学科：${str(c?.subject) || '—'}｜简介：${str(c?.description) || '—'}`);
  }

  const typeLabel = { login: '登录', upload: '上传课程', delete: '删除课程' };
  const logLines = logs.map((l) =>
    `• ${fmtDate(l.created_at)} ${typeLabel[l.type] || l.type}${l.detail ? `：${str(l.detail)}` : ''}`);

  const sys = '你是「复习笔记」站点的全能助手，掌握用户的全部课程资料、阅读进度与操作日志。'
    + '你可以回答资料库整体情况、各门课程的内容、学习进度、最近的上传/登录等操作，也能跨课程对比、给出复习建议。'
    + '优先依据下面的【课程清单】和【操作日志】回答；信息不足时如实说明，再用常识补充并标注“（补充）”。'
    + '回答用简体中文，简明扼要、适当分点，不要编造资料里不存在的内容。';

  let user = '';
  if (courseLines.length) user += `【课程清单（共 ${courseLines.length} 门）】\n${courseLines.join('\n')}\n\n`;
  if (logLines.length) user += `【操作日志（近 ${logLines.length} 条，已自动定期清理）】\n${logLines.join('\n')}\n\n`;
  user += `问题：${question}`;
  user = user.slice(0, 16000);

  let answer = '';
  try {
    const r = await env.AI.run(model, {
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      max_tokens: 800,
      temperature: 0.3,
    });
    const rsp = r && (r.response ?? r.result?.response);
    answer = typeof rsp === 'string' ? rsp : (rsp ? JSON.stringify(rsp) : '');
    if (model.includes('deepseek-r1')) {
      answer = answer.replace(/<think>[\s\S]*?<\/think>\n*/g, '');
    }
  } catch {
    return Response.json({ error: 'AI 调用失败，请稍后再试' }, { status: 502 });
  }

  return Response.json({ answer: answer.trim() });
}
