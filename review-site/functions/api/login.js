import { createSessionToken, makeAuthCookie, hashOwnerId } from '../_lib/auth.js';
import { logEvent } from '../_lib/db.js';

// 逗号分隔的多密码 -> 去空数组
const normPwd = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

export async function onRequestPost({ request, env }) {
  const admins = normPwd(env.ADMIN_PASSWORD);
  // 游客密码：优先 GUEST_PASSWORD，回退旧的 SITE_PASSWORD（兼容历史配置）
  const guests = normPwd(env.GUEST_PASSWORD || env.SITE_PASSWORD);
  if (!env.AUTH_SECRET || (!admins.length && !guests.length)) {
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
  else if (pw && guests.includes(pw)) role = 'guest';
  if (!role) {
    // 简单延时，降低暴力枚举速度
    await new Promise((r) => setTimeout(r, 500));
    return jsonResp({ ok: false }, 401);
  }

  const owner = await hashOwnerId(pw);
  const token = await createSessionToken(env, role, owner);
  // 记录登录日志（仅时间 + 浏览器标识，不存 IP）；失败不影响登录
  await logEvent(env, 'login', `${role} · ${(request.headers.get('User-Agent') || '').slice(0, 100)}`);
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
