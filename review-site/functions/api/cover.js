// 课程卡片封面图：管理员可替换，替换后覆盖静态的 /assets/covers/<slug>.webp
//
// GET    /api/cover?list=1      -> { covers: { slug: updated_at } }  首页一次性拿到哪些卡片有自定义封面
// GET    /api/cover?slug=xxx    -> 图片本体（URL 带 v=updated_at，故可长缓存）
// POST   /api/cover?slug=xxx    -> 上传（管理员）。body 为图片原始字节，Content-Type 带 mime
// DELETE /api/cover?slug=xxx    -> 删除自定义封面（管理员），卡片退回静态图/渐变底
import { ensureCoversSchema } from '../_lib/db.js';
import { getRole } from '../_lib/auth.js';

const MAX_BYTES = 3 * 1024 * 1024;   // 前端已压到 640x360 webp（通常 <60KB），这里只兜底
const OK_MIME = ['image/webp', 'image/png', 'image/jpeg', 'image/gif', 'image/avif'];

const json = (data, status = 200) => Response.json(data, { status });

// slug 来自课程 file 去扩展名，只允许安全字符，避免拼出越界的 R2 key
function cleanSlug(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,80}$/.test(s) ? s : '';
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!env.DB) return json({ covers: {} });
  await ensureCoversSchema(env);

  if (url.searchParams.get('list')) {
    const rs = await env.DB.prepare('SELECT slug, updated_at FROM course_covers').all();
    const covers = {};
    for (const r of rs.results || []) covers[r.slug] = r.updated_at;
    return json({ covers });
  }

  const slug = cleanSlug(url.searchParams.get('slug'));
  if (!slug) return json({ error: '参数不合法' }, 400);
  const row = await env.DB.prepare('SELECT r2_key, mime FROM course_covers WHERE slug = ?').bind(slug).first();
  if (!row) return new Response('Not found', { status: 404 });
  if (!env.FILES) return json({ error: 'R2 未配置' }, 500);

  const obj = await env.FILES.get(row.r2_key);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.mime || 'image/webp',
      // URL 上带 v=updated_at，内容变了 URL 就变，所以可以放心长缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
      'ETag': obj.httpEtag
    }
  });
}

export async function onRequestPost({ request, env }) {
  if ((await getRole(request, env)) !== 'admin') return json({ error: '仅管理员可更换封面' }, 403);
  if (!env.FILES) return json({ error: 'R2 未配置' }, 500);
  await ensureCoversSchema(env);

  const url = new URL(request.url);
  const slug = cleanSlug(url.searchParams.get('slug'));
  if (!slug) return json({ error: '参数不合法' }, 400);

  const mime = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!OK_MIME.includes(mime)) return json({ error: '只支持图片（webp/png/jpg/gif/avif）' }, 415);

  const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declared && declared > MAX_BYTES) return json({ error: '图片太大，上限 3MB' }, 413);
  if (!request.body) return json({ error: '没有图片内容' }, 400);

  const r2Key = `covers/${slug}`;
  let obj;
  try {
    obj = await env.FILES.put(r2Key, request.body, { httpMetadata: { contentType: mime } });
  } catch {
    return json({ error: '上传到存储失败' }, 500);
  }
  const size = obj?.size ?? declared ?? 0;
  if (size > MAX_BYTES) {
    try { await env.FILES.delete(r2Key); } catch {}
    return json({ error: '图片太大，上限 3MB' }, 413);
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO course_covers (slug, r2_key, mime, size, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET r2_key = excluded.r2_key, mime = excluded.mime,
       size = excluded.size, updated_at = excluded.updated_at`
  ).bind(slug, r2Key, mime, size, now).run();

  return json({ ok: true, slug, size, updated_at: now });
}

export async function onRequestDelete({ request, env }) {
  if ((await getRole(request, env)) !== 'admin') return json({ error: '仅管理员可更换封面' }, 403);
  await ensureCoversSchema(env);

  const url = new URL(request.url);
  const slug = cleanSlug(url.searchParams.get('slug'));
  if (!slug) return json({ error: '参数不合法' }, 400);

  const row = await env.DB.prepare('SELECT r2_key FROM course_covers WHERE slug = ?').bind(slug).first();
  if (!row) return json({ ok: true, slug, removed: false });
  if (env.FILES) { try { await env.FILES.delete(row.r2_key); } catch {} }
  await env.DB.prepare('DELETE FROM course_covers WHERE slug = ?').bind(slug).run();
  return json({ ok: true, slug, removed: true });
}
