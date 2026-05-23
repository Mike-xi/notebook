import { isAuthenticated } from './_lib/auth.js';

const PUBLIC_PATHS = new Set([
  '/login.html',
  '/login',
  '/api/login',
]);

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (PUBLIC_PATHS.has(path)) return next();

  if (await isAuthenticated(request, env)) return next();

  if (path.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return Response.redirect(new URL('/login', url).toString(), 302);
}
