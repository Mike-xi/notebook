// AI 对话历史读取 / 清空（保存由 /api/rag/chat 与 /api/omni 在作答后自动完成）。
// GET    /api/chat-history?scope=<file|omni>  -> { messages:[{role,content,created_at}] }
// DELETE /api/chat-history  { scope }          -> { ok:true }
// 鉴权由 _middleware.js 处理。
import { getChatMessages, clearChatMessages } from '../_lib/db.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

export async function onRequestGet({ request, env }) {
  const scope = str(new URL(request.url).searchParams.get('scope')).slice(0, 200);
  if (!scope) return Response.json({ messages: [] });
  const messages = await getChatMessages(env, scope, 60);
  return Response.json({ messages });
}

export async function onRequestDelete({ request, env }) {
  let b;
  try { b = await request.json(); } catch { b = {}; }
  const scope = str(b?.scope).slice(0, 200);
  if (scope) await clearChatMessages(env, scope);
  return Response.json({ ok: true });
}
