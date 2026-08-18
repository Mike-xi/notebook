import { createSessionToken, makeAuthCookie, hashOwnerId } from '../_lib/auth.js';
import { logEvent, bumpActivityDay } from '../_lib/db.js';
import { buildDetail } from '../_lib/visitlog.js';

// 逗号分隔的多密码 -> 去空数组
const normPwd = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// 三级密码 -> 三级身份：
//   ADMIN_PASSWORD                 -> admin  三级 · 管理员
//   FRIEND_PASSWORD                -> friend 二级 · 好友（本次新增）
//   GUEST_PASSWORD 或 SITE_PASSWORD -> guest  一级 · 访客
//
// 一级这条链原样保留（GUEST_PASSWORD 优先、SITE_PASSWORD 只作回退），不能改成
// 两个变量都收：现网如果两个都配着，SITE_PASSWORD 本来是永远轮不到的死密码，
// 一旦被收进名单就等于把一个早已停用的密码重新放行了。
// 所以新增的只有 FRIEND_PASSWORD —— 不设它就没有二级，其余行为与改造前完全一致。
// 同一个密码出现在多张名单里时，等级高的优先。
export async function onRequestPost({ request, env }) {
  const admins = normPwd(env.ADMIN_PASSWORD);
  const friends = normPwd(env.FRIEND_PASSWORD);
  const guests = normPwd(env.GUEST_PASSWORD || env.SITE_PASSWORD);
  if (!env.AUTH_SECRET || (!admins.length && !friends.length && !guests.length)) {
    return jsonResp({ error: 'server not configured' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResp({ error: 'invalid body' }, 400);
  }

  const pw = body?.password;
  let role = null;
  if (pw && admins.includes(pw)) role = 'admin';
  else if (pw && friends.includes(pw)) role = 'friend';
  else if (pw && guests.includes(pw)) role = 'guest';
  if (!role) {
    // 简单延时，降低暴力枚举速度
    await new Promise((r) => setTimeout(r, 500));
    return jsonResp({ ok: false }, 401);
  }

  const owner = await hashOwnerId(pw);
  const token = await createSessionToken(env, role, owner);
  // 登录日志：角色 · 位置 · IP · 浏览器标识，统一由 _lib/visitlog.js 编码成 JSON。
  // 位置和 IP 都取自 Cloudflare 边缘（request.cf / CF-Connecting-IP）；IP 只有管理员看得到，
  // 一二级在 /api/logins 里会被抹掉，别在别处直接把 detail 原样吐给前端。
  await logEvent(env, 'login', buildDetail(role, request));
  await bumpActivityDay(env, role, 'login');   // 热力图的按天计数（logs 只留 30 天，见 db.js）
  return new Response(JSON.stringify({ ok: true, role }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': makeAuthCookie(token),
    },
  });
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
