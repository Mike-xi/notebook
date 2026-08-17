// GET /api/me -> { role, level, name, isAdmin }
// role  : 'guest' | 'friend' | 'admin'（同时就是等级，见 _lib/auth.js）
// level : 1 | 2 | 3
// name  : 访客 / 好友 / 管理员
// 前端据此显示身份卡，并决定是否显示「删除 / 拖动排序 / 创建课程」等管理操作。
// 鉴权由 _middleware.js 处理（未登录到不了这里）。
import { getRole, ROLE_NAMES, ROLE_LEVEL } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const role = (await getRole(request, env)) || 'guest';
  return Response.json({
    role,
    level: ROLE_LEVEL[role] || 1,
    name: ROLE_NAMES[role] || '访客',
    isAdmin: role === 'admin',
  });
}
