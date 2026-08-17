// 登录日志。三级都能看，但看到的范围不同：
//   admin  -> 全部身份的登录记录
//   friend / guest -> 只看自己那一级的
// 数据来自 logs 表里 type='login' 的行，detail 格式见 api/login.js：
//   "<role> · <city, country> · <user-agent>"
// **只有大致城市，没有 IP**（登录时就没记）。
//
// GET /api/logins?limit=50 -> { role, scope, items: [{role, place, device, at}] }
import { ensureLogsSchema } from '../_lib/db.js';
import { getRole, ROLE_NAMES } from '../_lib/auth.js';

const MAX_LIMIT = 100;

// User-Agent 揉成「Chrome · Windows」这种能一眼认出的设备名
function deviceOf(ua) {
  const s = String(ua || '');
  if (!s) return '未知设备';
  const os =
    /Windows/i.test(s) ? 'Windows' :
    /iPhone|iPad|iPod/i.test(s) ? 'iOS' :
    /Android/i.test(s) ? 'Android' :
    /Mac OS X|Macintosh/i.test(s) ? 'macOS' :
    /Linux/i.test(s) ? 'Linux' : '';
  const browser =
    /Edg\//i.test(s) ? 'Edge' :
    /OPR\/|Opera/i.test(s) ? 'Opera' :
    /Firefox\//i.test(s) ? 'Firefox' :
    /Chrome\//i.test(s) ? 'Chrome' :
    /Safari\//i.test(s) ? 'Safari' : '浏览器';
  return [browser, os].filter(Boolean).join(' · ');
}

export async function onRequestGet({ request, env }) {
  const role = (await getRole(request, env)) || 'guest';
  if (!env.DB) return Response.json({ role, scope: 'self', items: [] });
  await ensureLogsSchema(env);

  const url = new URL(request.url);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const isAdmin = role === 'admin';

  const rs = await env.DB.prepare(
    "SELECT detail, created_at FROM logs WHERE type = 'login' ORDER BY created_at DESC LIMIT ?"
  ).bind(isAdmin ? limit * 3 : 400).all();

  const items = [];
  for (const r of rs.results || []) {
    const parts = String(r.detail || '').split(' · ');
    // 老格式只有 "<role> · <ua>" 两段，没有位置那一段
    const rowRole = parts[0] || 'guest';
    const hasPlace = parts.length >= 3;
    const place = hasPlace ? parts[1] : '';
    const ua = hasPlace ? parts.slice(2).join(' · ') : parts.slice(1).join(' · ');
    if (!isAdmin && rowRole !== role) continue;      // 非管理员只看自己这一级
    items.push({
      role: rowRole,
      roleName: ROLE_NAMES[rowRole] || rowRole,
      place: place || '未知',
      device: deviceOf(ua),
      at: r.created_at,
    });
    if (items.length >= limit) break;
  }

  return Response.json({ role, scope: isAdmin ? 'all' : 'self', items });
}
