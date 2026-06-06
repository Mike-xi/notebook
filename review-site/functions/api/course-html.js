// GET /api/course-html?file=u-xxx.html -> 返回 D1 中存储的课程 HTML（供 reader 的 iframe 加载）
// 鉴权由 _middleware.js 处理；iframe 同源请求自带 cookie，故只有登录用户能读取。
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const file = url.searchParams.get('file');
  if (!file) return new Response('missing file', { status: 400 });

  let row;
  try {
    row = await env.DB.prepare('SELECT html FROM courses WHERE file = ?').bind(file).first();
  } catch {
    return new Response('not found', { status: 404 }); // 表尚未创建等情况
  }
  if (!row) return new Response('not found', { status: 404 });

  return new Response(row.html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'X-Frame-Options': 'SAMEORIGIN',
    },
  });
}
