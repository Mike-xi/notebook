// 笔记页内嵌资产（插入的图片、PDF 导入的页面底图）：存 R2，key=notepad/<owner>/asset-<rand>.<ext>。
// POST ?ext=jpg|jpeg|png|webp|gif  body=原始字节 → { key }；GET ?key= 校验 owner 前缀后流式返回。
// 删除不单独提供接口——随页面/笔记本删除时由 pages.js / books.js 按页面 JSON 里的引用做 GC。
import { ensureNotepadSchema } from '../../_lib/db.js';
import { getOwner } from '../../_lib/auth.js';

const MAX_BYTES = 20 * 1024 * 1024; // 单张图片上限 20MB（手机原图也够）
const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif',
};

export async function onRequestPost({ request, env }) {
  const owner = await getOwner(request, env);
  if (!owner) return Response.json({ error: '请先登录' }, { status: 401 });
  if (!env.FILES) return Response.json({ error: 'R2 未配置' }, { status: 500 });
  await ensureNotepadSchema(env);

  const url = new URL(request.url);
  const ext = String(url.searchParams.get('ext') || '').toLowerCase();
  const mime = EXT_MIME[ext];
  if (!mime) return Response.json({ error: '不支持的图片格式' }, { status: 400 });

  const declaredLen = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declaredLen && declaredLen > MAX_BYTES) {
    return Response.json({ error: `图片太大（${(declaredLen / 1e6).toFixed(1)} MB），上限 20 MB` }, { status: 413 });
  }
  if (!request.body) return Response.json({ error: '没有图片内容' }, { status: 400 });

  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const key = `notepad/${owner}/asset-${rand}.${ext}`;
  let obj;
  try {
    obj = await env.FILES.put(key, request.body, { httpMetadata: { contentType: mime } });
  } catch {
    return Response.json({ error: '上传到存储失败' }, { status: 500 });
  }
  if ((obj?.size ?? 0) > MAX_BYTES) {
    try { await env.FILES.delete(key); } catch {}
    return Response.json({ error: '图片太大，上限 20 MB' }, { status: 413 });
  }
  return Response.json({ ok: true, key, size: obj?.size ?? declaredLen });
}

export async function onRequestGet({ request, env }) {
  const owner = await getOwner(request, env);
  if (!owner) return Response.json({ error: '请先登录' }, { status: 401 });
  if (!env.FILES) return Response.json({ error: 'R2 未配置' }, { status: 500 });

  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  // 只能读自己 owner 前缀下的资产（key 里不允许再出现路径歧义字符）
  if (!key.startsWith(`notepad/${owner}/asset-`) || key.includes('..')) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }
  const obj = await env.FILES.get(key);
  if (!obj) return Response.json({ error: 'not found' }, { status: 404 });
  const headers = new Headers();
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'private, max-age=31536000, immutable'); // key 含随机串，内容不变可长缓存
  if (obj.size != null) headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { headers });
}
