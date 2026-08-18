// 登录 / 访问日志。三级都能看，但看到的范围不同：
//   admin          -> 全部身份的记录，且带 IP
//   friend / guest  -> 只看自己那一级的，IP 一律不下发
// 数据来自 logs 表里 type='login'（敲密码那一刻）和 type='visit'（带着有效 cookie
// 每天第一次打开页面，由 _middleware.js 记）。两种一起返回，前端用 kind 区分 ——
// 手机的会话能撑 30 天，只看 login 会以为手机从来没上过站。
// detail 的编码与解析都在 _lib/visitlog.js，兼容三代历史格式。
//
// GET /api/logins?limit=60 -> { role, scope, canSeeIp, items: [{kind, role, place, ip, device, deviceKind, at}] }
import { ensureLogsSchema } from '../_lib/db.js';
import { getRole, ROLE_NAMES } from '../_lib/auth.js';
import { parseDetail, deviceOf } from '../_lib/visitlog.js';

const MAX_LIMIT = 200;

export async function onRequestGet({ request, env }) {
  const role = (await getRole(request, env)) || 'guest';
  if (!env.DB) return Response.json({ role, scope: 'self', canSeeIp: false, items: [] });
  await ensureLogsSchema(env);

  const url = new URL(request.url);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get('limit') || '60', 10) || 60));
  const isAdmin = role === 'admin';

  // 非管理员要按身份过滤，取多一些回来再筛，免得筛完不够一屏
  const rs = await env.DB.prepare(
    "SELECT type, detail, created_at FROM logs WHERE type IN ('login','visit') ORDER BY created_at DESC LIMIT ?"
  ).bind(isAdmin ? limit : Math.min(600, limit * 8)).all();

  const items = [];
  for (const r of rs.results || []) {
    const d = parseDetail(r.detail);
    if (!isAdmin && d.role !== role) continue;
    const dev = deviceOf(d.ua);
    items.push({
      kind: r.type === 'visit' ? 'visit' : 'login',
      role: d.role,
      roleName: ROLE_NAMES[d.role] || d.role,
      place: d.place || '未知',
      ip: isAdmin ? d.ip : '',        // IP 只给管理员，别下发给一二级
      device: dev.name,
      deviceKind: dev.kind,
      at: r.created_at,
    });
    if (items.length >= limit) break;
  }

  return Response.json({ role, scope: isAdmin ? 'all' : 'self', canSeeIp: isAdmin, items });
}
