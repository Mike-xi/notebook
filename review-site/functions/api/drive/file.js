// GET /api/drive/file?path=<filepath>[&dl=1]  -> 流式返回文件字节（任何登录用户可读）
//   dl=1 时作为附件下载（Content-Disposition: attachment），否则尽量内联预览。
//   支持 Range（视频/PDF 分段加载）。
import { ensureDriveSchema } from '../../_lib/db.js';
import { getRole } from '../../_lib/auth.js';
import { normPath, guessMime } from '../../_lib/drive.js';

export async function onRequestGet({ request, env }) {
  await ensureDriveSchema(env);
  if (!env.FILES) return new Response('R2 not configured', { status: 500 });

  const url = new URL(request.url);
  const path = normPath(url.searchParams.get('path') || '');
  if (!path) return new Response('bad path', { status: 400 });

  const node = await env.DB.prepare('SELECT name, is_dir, r2_key, mime, visible FROM drive_nodes WHERE path = ?').bind(path).first();
  if (!node || node.is_dir) return new Response('not found', { status: 404 });
  // 非管理员只能取「对外可见」的文件
  if (!node.visible && (await getRole(request, env)) !== 'admin') return new Response('not found', { status: 404 });

  const rangeHeader = request.headers.get('Range');
  const parsed = rangeHeader ? parseRange(rangeHeader) : null;

  let obj;
  try {
    obj = await env.FILES.get(node.r2_key, parsed ? { range: parsed } : undefined);
  } catch {
    return new Response('not found', { status: 404 });
  }
  if (!obj) return new Response('not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  const mime = node.mime || guessMime(node.name);
  headers.set('Content-Type', mime);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, max-age=3600');
  if (obj.httpEtag) headers.set('etag', obj.httpEtag);

  const disposition = url.searchParams.get('dl') === '1' ? 'attachment' : 'inline';
  headers.set('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(node.name)}`);

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

function parseRange(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const startStr = m[1], endStr = m[2];
  if (startStr === '' && endStr === '') return null;
  if (startStr === '') return { suffix: parseInt(endStr, 10) };
  const offset = parseInt(startStr, 10);
  if (endStr === '') return { offset };
  return { offset, length: parseInt(endStr, 10) - offset + 1 };
}
