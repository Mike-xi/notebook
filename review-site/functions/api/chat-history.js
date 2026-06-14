// AI 对话历史读取 / 清空（保存由 /api/rag/chat 与 /api/omni 在作答后自动完成）。
// GET    /api/chat-history?scope=<file|omni>  -> { messages:[{role,content,created_at}] }
// DELETE /api/chat-history  { scope }          -> { ok:true }
// 鉴权由 _middleware.js 处理。
import { getChatMessages, clearChatMessages } from '../_lib/db.js';
import { getRole } from '../_lib/auth.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

// 首页 AI(omni) 的历史按角色分库，与 omni.js 保持一致；课程内对话(scope=文件)不区分角色。
async function effScope(scope, request, env) {
  if (scope === 'omni' && (await getRole(request, env)) !== 'admin') return 'omni:guest';
  return scope;
}

export async function onRequestGet({ request, env }) {
  let scope = str(new URL(request.url).searchParams.get('scope')).slice(0, 200);
  if (!scope) return Response.json({ messages: [] });
  scope = await effScope(scope, request, env);
  const messages = await getChatMessages(env, scope, 60);
  return Response.json({ messages });
}

export async function onRequestDelete({ request, env }) {
  let b;
  try { b = await request.json(); } catch { b = {}; }
  let scope = str(b?.scope).slice(0, 200);
  if (scope) {
    scope = await effScope(scope, request, env);
    await clearChatMessages(env, scope);
  }
  return Response.json({ ok: true });
}
