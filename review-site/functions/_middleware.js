import { isAuthenticated } from './_lib/auth.js';

const PUBLIC_PATHS = new Set([
  '/login.html',
  '/api/login',
]);

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // 允许公开路径
  if (PUBLIC_PATHS.has(path)) return next();

  // 已登录
  if (await isAuthenticated(request, env)) return next();

  // 未登录：API 返 401，页面跳登录
  if (path.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const loginUrl = new URL('/login.html', url);
  return Response.redirect(loginUrl.toString(), 302);
}
