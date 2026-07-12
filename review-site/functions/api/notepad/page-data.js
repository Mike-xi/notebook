// 单页数据（笔画 strokes + 图片/文本块 items）：存 R2（key=notepad/<owner>/page-<id>.json），
// D1 只存缩略图与更新时间。图片字节单独存 R2 asset（见 asset.js），items 里只存引用 key。
import { ensureNotepadSchema } from '../../_lib/db.js';
import { getOwner } from '../../_lib/auth.js';
import { pageDataKey, collectAssetKeys } from '../../_lib/notepad.js';

const MAX_BYTES = 8 * 1024 * 1024; // 单页笔画 JSON 上限 8MB（正常使用远小于此）

async function requireOwner(request, env) {
  const owner = await getOwner(request, env);
  if (!owner) return null;
  await ensureNotepadSchema(env);
  return owner;
}

export async function onRequestGet({ request, env }) {
  const owner = await requireOwner(request, env);
  if (!owner) return Response.json({ error: '请先登录' }, { status: 401 });
  if (!env.FILES) return Response.json({ error: 'R2 未配置' }, { status: 500 });

  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id') || '', 10);
  if (!id) return Response.json({ error: 'missing id' }, { status: 400 });
  const page = await env.DB.prepare('SELECT id FROM notepad_pages WHERE id = ? AND owner = ?').bind(id, owner).first();
  if (!page) return Response.json({ error: 'not found' }, { status: 404 });

  try {
    const obj = await env.FILES.get(`notepad/${owner}/page-${id}.json`);
    if (!obj) return Response.json({ strokes: [], items: [] });
    const data = await obj.json();
    return Response.json({
      strokes: Array.isArray(data?.strokes) ? data.strokes : [],
      items: Array.isArray(data?.items) ? data.items : [],
    });
  } catch {
    return Response.json({ strokes: [], items: [] });
  }
}

export async function onRequestPut({ request, env }) {
  const owner = await requireOwner(request, env);
  if (!owner) return Response.json({ error: '请先登录' }, { status: 401 });
  if (!env.FILES) return Response.json({ error: 'R2 未配置' }, { status: 500 });

  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id') || '', 10);
  if (!id) return Response.json({ error: 'missing id' }, { status: 400 });
  const page = await env.DB.prepare('SELECT id, book_id FROM notepad_pages WHERE id = ? AND owner = ?').bind(id, owner).first();
  if (!page) return Response.json({ error: 'not found' }, { status: 404 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'invalid body' }, { status: 400 }); }
  const strokes = Array.isArray(body?.strokes) ? body.strokes : [];
  const items = Array.isArray(body?.items) ? body.items : [];
  const payload = JSON.stringify({ strokes, items });
  if (new TextEncoder().encode(payload).length > MAX_BYTES) {
    return Response.json({ error: '这一页内容太多了，新建一页继续吧' }, { status: 413 });
  }
  const thumb = typeof body?.thumb === 'string' && body.thumb.startsWith('data:image/') ? body.thumb.slice(0, 60000) : '';
  const now = Date.now();

  // 差量 GC：旧版本引用、新版本不再引用的图片资产，随保存一并清掉（失败吞掉不影响保存）
  try {
    const old = await env.FILES.get(pageDataKey(owner, id));
    if (old) {
      const oldData = await old.json().catch(() => null);
      const keep = new Set(collectAssetKeys({ items }, owner));
      for (const k of collectAssetKeys(oldData, owner)) {
        if (!keep.has(k)) { try { await env.FILES.delete(k); } catch {} }
      }
    }
  } catch {}

  await env.FILES.put(pageDataKey(owner, id), payload, { httpMetadata: { contentType: 'application/json' } });
  await env.DB.prepare('UPDATE notepad_pages SET thumb = ?, updated_at = ? WHERE id = ?').bind(thumb, now, id).run();
  await env.DB.prepare('UPDATE notepad_books SET updated_at = ? WHERE id = ?').bind(now, page.book_id).run();
  return Response.json({ ok: true });
}
