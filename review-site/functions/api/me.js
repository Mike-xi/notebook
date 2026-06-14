// GET /api/me -> { role: 'admin' | 'guest' }
// 前端据此决定是否显示「删除 / 拖动排序 / 创建课程」等管理操作。
// 鉴权由 _middleware.js 处理（未登录到不了这里）。
import { getRole } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const role = (await getRole(request, env)) || 'guest';
  return Response.json({ role });
}
