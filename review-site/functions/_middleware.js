import { isAuthenticated, getCookie } from './_lib/auth.js';
import { logEvent, bumpActivityDay } from './_lib/db.js';
import { buildDetail } from './_lib/visitlog.js';

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

// 「访问」日志。/api/login 只在真的敲密码那一刻记一笔，而 cookie 有效期 30 天 ——
// 手机装到桌面后往往一个月才登一次，日志里就只剩下天天重登的电脑，看着像「手机没被记录」。
// 所以这里补一条：带着有效 cookie 来的设备，每天第一次打开页面记一条 type=visit。
// 用一个只存日期戳的 cookie 去重，避免为此每次都读一遍 D1；写库放进 waitUntil，不挡首屏。
const SEEN_COOKIE = 'nb_seen';
const dayStamp = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);   // 按北京时间分天

// 只对「人打开的页面」记账：导航请求、GET、非 API / 非静态资源。
function isPageView(request, path) {
  if (request.method !== 'GET') return false;
  if (path.startsWith('/api/') || path.startsWith('/assets/') || path.startsWith('/dav')) return false;
  const mode = request.headers.get('Sec-Fetch-Mode');
  if (mode) return mode === 'navigate';
  return (request.headers.get('Accept') || '').includes('text/html');
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (PUBLIC_PATHS.has(path)) return next();
  // 星邮拥有独立的账号体系；同域入口公开，但所有数据 API 仍由星邮自身鉴权。
  // 浏览器只访问 sjtu.ccwu.cc，Pages Function 在服务端转发到聊天 Worker。
  if (path === '/starpost-app' || path.startsWith('/starpost-app/')) return next();
  // 静态资源（样式/脚本）放行，否则未登录的登录页会因 CSS/JS 被拦而裸样式。
  // 注意：笔记正文 /notes/* 与 /courses.json 不在此列，仍需登录。
  if (path.startsWith('/assets/') || path === '/favicon.ico') return next();
  // 只读分享：带 share token 的阅读器页面公开（仅是页面壳，正文由 /api/shared 的 token 鉴权）。
  if ((path === '/reader.html' || path === '/reader') && url.searchParams.has('share')) return next();
  // 大创综合演示 /dc：纯静态展示页（含 Python 算法源码），公开给团队/评审直接访问。
  if (path === '/dc' || path.startsWith('/dc/')) return next();
  // 策联杯 B 题问题三三维海图 /heli：纯静态展示页，公开给队友/评审直接访问。
  if (path === '/heli' || path.startsWith('/heli/')) return next();
  // 私人云盘 WebDAV：/dav 由其函数自行做 Basic/管理员鉴权（外部客户端无法走登录页 Cookie 流程）。
  if (path === '/dav' || path.startsWith('/dav/')) return next();
  // 公共云盘 Agent API：由其函数用 X-API-Key 自鉴权（脚本/agent 无登录 Cookie）。
  if (path === '/api/drive/agent') return next();
  // 苹果比价刷新端点：由其函数用 X-API-Key 自鉴权（GitHub Actions cron 无登录 Cookie）。
  if (path === '/api/apple/refresh') return next();

  const role = await isAuthenticated(request, env);
  if (role) {
    const today = dayStamp();
    if (isPageView(request, path) && getCookie(request, SEEN_COOKIE) !== today) {
      context.waitUntil(Promise.all([
        logEvent(env, 'visit', buildDetail(role, request)),
        bumpActivityDay(env, role, 'visit'),      // 热力图的按天计数（logs 只留 30 天，见 db.js）
      ]));
      const res = await next();
      // Response 的 headers 是只读的，得整个复制一份才能补 Set-Cookie
      const out = new Response(res.body, res);
      out.headers.append('Set-Cookie', `${SEEN_COOKIE}=${today}; Path=/; Max-Age=86400; SameSite=Lax`);
      return out;
    }
    return next();
  }

  if (path.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return Response.redirect(new URL('/login', url).toString(), 302);
}
