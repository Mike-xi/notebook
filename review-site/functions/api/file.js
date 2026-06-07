// GET /api/file?file=u-xxx.pdf -> 从 R2 流式返回二进制（PDF 等）
// 支持 Range 请求（PDF.js 分段加载更快）。鉴权由 _middleware.js 处理。
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('file');
  if (!key || !key.startsWith('u-')) return new Response('bad file', { status: 400 });
  if (!env.FILES) return new Response('R2 not configured', { status: 500 });

  const rangeHeader = request.headers.get('Range');
  const parsed = rangeHeader ? parseRange(rangeHeader) : null;

  let obj;
  try {
    obj = await env.FILES.get(key, parsed ? { range: parsed } : undefined);
  } catch {
    return new Response('not found', { status: 404 });
  }
  if (!obj) return new Response('not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, max-age=3600');
  headers.set('etag', obj.httpEtag);

  if (parsed && obj.range) {
    const start = obj.range.offset ?? 0;
    const len = obj.range.length ?? (obj.size - start);
    const end = start + len - 1;
    headers.set('Content-Range', `bytes ${start}-${end}/${obj.size}`);
    headers.set('Content-Length', String(len));
    return new Response(obj.body, { status: 206, headers });
  }

  headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

// 解析 "bytes=start-end" -> R2 range { offset, length }
function parseRange(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const startStr = m[1], endStr = m[2];
  if (startStr === '' && endStr === '') return null;
  if (startStr === '') {
    // 末尾 N 字节：bytes=-N
    return { suffix: parseInt(endStr, 10) };
  }
  const offset = parseInt(startStr, 10);
  if (endStr === '') return { offset };
  return { offset, length: parseInt(endStr, 10) - offset + 1 };
}
