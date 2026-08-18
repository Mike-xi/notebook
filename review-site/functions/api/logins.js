// 登录 / 访问日志。三级都能看，但看到的范围不同：
//   admin          -> 全部身份的记录，且带 IP
//   friend / guest  -> 只看自己那一级的，IP 一律不下发
// 数据来自 logs 表里 type='login'（敲密码那一刻）和 type='visit'（带着有效 cookie
// 每天第一次打开页面，由 _middleware.js 记）。两种一起返回，前端用 kind 区分 ——
// 手机的会话能撑 30 天，只看 login 会以为手机从来没上过站。
// detail 的编码与解析都在 _lib/visitlog.js，兼容三代历史格式。
//
// GET /api/logins?limit=60 -> { role, scope, canSeeIp, items: [{kind, role, place, ip, device, deviceKind, at}] }
// GET /api/logins?heat=1     -> 上面那些 + heat: { days: {'YYYY-MM-DD': n}, total, max }
//   热力图走 activity_days 表（按天计数，不过期），不是 logs —— logs 只留 30 天。
import { ensureLogsSchema, ensureActivitySchema, beijingDay } from '../_lib/db.js';
import { getRole, ROLE_NAMES } from '../_lib/auth.js';
import { parseDetail, deviceOf } from '../_lib/visitlog.js';

const MAX_LIMIT = 200;
const HEAT_DAYS = 371;   // 53 周整，热力图正好排满 7 行

// 热力图：管理员看全站（三级身份合计），一二级只看自己那一级。
async function heatmap(env, role, isAdmin) {
  try {
    await ensureActivitySchema(env);
    const from = beijingDay(Date.now() - (HEAT_DAYS - 1) * 86400e3);
    const sql = isAdmin
      ? 'SELECT day, SUM(logins + visits) AS n FROM activity_days WHERE day >= ? GROUP BY day'
      : 'SELECT day, SUM(logins + visits) AS n FROM activity_days WHERE day >= ? AND role = ? GROUP BY day';
    const stmt = env.DB.prepare(sql);
    const rs = await (isAdmin ? stmt.bind(from) : stmt.bind(from, role)).all();
    const days = {};
    let total = 0, max = 0;
    for (const r of rs.results || []) {
      const n = Number(r.n) || 0;
      days[r.day] = n;
      total += n;
      if (n > max) max = n;
    }
    return { days, total, max, from, to: beijingDay(), span: HEAT_DAYS };
  } catch {
    return { days: {}, total: 0, max: 0, from: beijingDay(), to: beijingDay(), span: HEAT_DAYS };
  }
}

export async function onRequestGet({ request, env }) {
  const role = (await getRole(request, env)) || 'guest';
  if (!env.DB) return Response.json({ role, scope: 'self', canSeeIp: false, items: [] });
  await ensureLogsSchema(env);

  const url = new URL(request.url);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get('limit') || '60', 10) || 60));
  const isAdmin = role === 'admin';
  const wantHeat = url.searchParams.get('heat') === '1';

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

  const out = { role, scope: isAdmin ? 'all' : 'self', canSeeIp: isAdmin, items };
  if (wantHeat) out.heat = await heatmap(env, role, isAdmin);
  return Response.json(out);
}
