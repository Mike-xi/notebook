import { createSessionToken, makeAuthCookie, hashOwnerId } from '../_lib/auth.js';
import { logEvent } from '../_lib/db.js';

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
  // 登录日志：角色 · 大致位置 · 浏览器标识。位置取自 Cloudflare 边缘给的 request.cf，
  // 只有城市/国家，**不记录 IP**。三段用 ' · ' 分隔，/api/logins 按这个格式解析。
  const cf = request.cf || {};
  const place = [cf.city, cf.country].filter(Boolean).join(', ') || '未知';
  const ua = (request.headers.get('User-Agent') || '').slice(0, 160);
  await logEvent(env, 'login', `${role} · ${place} · ${ua}`);
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
