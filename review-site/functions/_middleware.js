import { isAuthenticated } from './_lib/auth.js';

const PUBLIC_PATHS = new Set([
  '/login.html',
  '/login',
  '/api/login',
  '/share.html',   // 只读分享页（页面本身公开，取数靠 /api/shared 的 token 自鉴权）
  '/api/shared',
]);

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (PUBLIC_PATHS.has(path)) return next();
  // 静态资源（样式/脚本）放行，否则未登录的登录页会因 CSS/JS 被拦而裸样式。
  // 注意：笔记正文 /notes/* 与 /courses.json 不在此列，仍需登录。
  if (path.startsWith('/assets/') || path === '/favicon.ico') return next();

  if (await isAuthenticated(request, env)) return next();

  if (path.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return Response.redirect(new URL('/login', url).toString(), 302);
}
