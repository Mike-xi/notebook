// GET /api/course-html?file=u-xxx.{html,md} -> 返回 D1 中存储的课程正文文本
//   html：text/html（供 reader 的 iframe 直接加载）
//   md  ：text/markdown（供 viewer-md 取回后客户端渲染）
// pdf 不走这里（正文在 R2，用 /api/file）。鉴权由 _middleware.js 处理。
import { ensureCoursesSchema } from '../_lib/db.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const file = url.searchParams.get('file');
  if (!file) return new Response('missing file', { status: 400 });

  await ensureCoursesSchema(env);

  let row;
  try {
    row = await env.DB.prepare('SELECT html, kind FROM courses WHERE file = ?').bind(file).first();
  } catch {
    return new Response('not found', { status: 404 });
  }
  if (!row) return new Response('not found', { status: 404 });

  const isMd = row.kind === 'md';
  return new Response(row.html, {
    headers: {
      'Content-Type': isMd ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'X-Frame-Options': 'SAMEORIGIN',
    },
  });
}
