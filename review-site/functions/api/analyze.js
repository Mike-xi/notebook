// POST /api/analyze  { title, kind, excerpt }  ->  { subject, description, tags[], icon }
// 用 Workers AI 给上传的笔记自动生成元数据（学科 / 简介 / 标签 / 图标）。
// 鉴权由 _middleware.js 统一处理（只有登录用户能访问 /api/*）。
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// 可选图标调色板——必须与前端 app.js 的 ICONS 保持一致。AI 只能从中挑选。
export const ICONS = [
  '📘', '📗', '📙', '📕', '📓', '📝', '📐', '📊', '📈', '🧮', '🔢', '⚛️',
  '🔬', '🧲', '⚡', '🌊', '🔭', '🧪', '⚗️', '🧬', '💻', '🐍', '🌐', '🤖',
  '🧠', '⚙️', '🏗️', '🚢', '🚀', '🛰️', '🎲', '🗺️', '🌍', '💡', '🎯', '📡',
];

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

export async function onRequestPost({ request, env }) {
  if (!env.AI) return Response.json({ error: 'AI 未绑定（请在 Pages 后台加 AI binding）' }, { status: 503 });

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }

  const title = str(body?.title).slice(0, 80);
  const kind = ['html', 'md', 'pdf'].includes(body?.kind) ? body.kind : 'html';
  const excerpt = str(body?.excerpt).slice(0, 4000);
  if (!title && !excerpt) return Response.json({ error: '缺少内容' }, { status: 400 });

  const sys = '你是课程笔记元数据助手。只输出一个 JSON 对象，禁止任何解释、Markdown 代码块或多余文字。'
    + '字段：subject(学科名，≤8字)，description(一句话简介，≤30字，不带句号)，'
    + 'tags(3-5个关键词组成的字符串数组)，icon(必须从给定 emoji 列表里原样挑选一个最贴切的，只能是列表里的字符)。全部用简体中文。';
  const user = `可选图标列表：${ICONS.join(' ')}\n\n课程名：${title || '(未填)'}\n类型：${kind}\n`
    + `正文摘要：${excerpt || '(无正文，请仅依据课程名推断)'}\n\n请输出 JSON。`;

  let parsed = {};
  try {
    const r = await env.AI.run(MODEL, {
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      max_tokens: 320,
      temperature: 0.2,
    });
    const rsp = r && (r.response ?? r.result?.response);
    // Workers AI 对 JSON 输出会自动解析为对象；少数情况是字符串，再兜底解析一次
    parsed = (rsp && typeof rsp === 'object') ? rsp : extractJSON(String(rsp || ''));
  } catch {
    return Response.json({ error: 'AI 调用失败，请稍后再试' }, { status: 502 });
  }

  const icon = str(parsed.icon);
  return Response.json({
    subject: str(parsed.subject).slice(0, 12),
    description: str(parsed.description).replace(/[。.]+$/, '').slice(0, 40),
    tags: sanitizeTags(parsed.tags),
    icon: ICONS.includes(icon) ? icon : '',
  });
}

// 从模型输出里抠出 JSON 对象，容忍代码块包裹/前后多余文字。
function extractJSON(s) {
  if (!s) return {};
  let t = String(s).replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try { const o = JSON.parse(t); return o && typeof o === 'object' ? o : {}; }
  catch { return {}; }
}

function sanitizeTags(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x : String(x || '')).trim())
    .filter(Boolean)
    .map((x) => x.slice(0, 16))
    .slice(0, 6);
}
