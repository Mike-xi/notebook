import { createSessionToken, makeAuthCookie } from '../_lib/auth.js';
import { logEvent } from '../_lib/db.js';

export async function onRequestPost({ request, env }) {
  if (!env.SITE_PASSWORD || !env.AUTH_SECRET) {
    return jsonResp({ error: 'server not configured' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResp({ error: 'invalid body' }, 400);
  }

  if (!body?.password || body.password !== env.SITE_PASSWORD) {
    // 简单延时，降低暴力枚举速度
    await new Promise((r) => setTimeout(r, 500));
    return jsonResp({ ok: false }, 401);
  }

  const token = await createSessionToken(env);
  // 记录登录日志（仅时间 + 浏览器标识，不存 IP）；失败不影响登录
  await logEvent(env, 'login', (request.headers.get('User-Agent') || '').slice(0, 120));
  return new Response(JSON.stringify({ ok: true }), {
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
