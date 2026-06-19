import { isAuthenticated } from './_lib/auth.js';

// 注意：Pages 开启了 clean URL，会把 /foo.html 308 跳到 /foo，中间件最终看到的是去掉 .html 的路径。
// 因此每个公开页都要同时登记 .html 与无后缀两种形式。
const PUBLIC_PATHS = new Set([
  '/login.html', '/login',
  '/api/login',
  '/share.html', '/share',           // 旧分享链接入口（已改为重定向到带 token 的阅读器）
  '/api/shared',                     // 只读分享取数（凭 token 自鉴权）
  '/viewer-md.html', '/viewer-md',   // md/pdf viewer 是空壳，正文由各自 src（分享时为 /api/shared）鉴权
  '/viewer-pdf.html', '/viewer-pdf',
  '/viewer-office.html', '/viewer-office', // office 文档预览空壳（纯前端渲染，正文由 src 鉴权）
  '/drive-share.html', '/drive-share', // 云盘公开分享页（页面壳，正文由 /api/drive/shared 的 token 鉴权）
  '/api/drive/shared',                 // 云盘分享取数（凭 token + 可选密码自鉴权）
]);

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (PUBLIC_PATHS.has(path)) return next();
  // 静态资源（样式/脚本）放行，否则未登录的登录页会因 CSS/JS 被拦而裸样式。
  // 注意：笔记正文 /notes/* 与 /courses.json 不在此列，仍需登录。
  if (path.startsWith('/assets/') || path === '/favicon.ico') return next();
  // 只读分享：带 share token 的阅读器页面公开（仅是页面壳，正文由 /api/shared 的 token 鉴权）。
  if ((path === '/reader.html' || path === '/reader') && url.searchParams.has('share')) return next();
  // 私人云盘 WebDAV：/dav 由其函数自行做 Basic/管理员鉴权（外部客户端无法走登录页 Cookie 流程）。
  if (path === '/dav' || path.startsWith('/dav/')) return next();
  // 公共云盘 Agent API：由其函数用 X-API-Key 自鉴权（脚本/agent 无登录 Cookie）。
  if (path === '/api/drive/agent') return next();
  // 苹果比价刷新端点：由其函数用 X-API-Key 自鉴权（GitHub Actions cron 无登录 Cookie）。
  if (path === '/api/apple/refresh') return next();

  if (await isAuthenticated(request, env)) return next();

  if (path.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return Response.redirect(new URL('/login', url).toString(), 302);
}
