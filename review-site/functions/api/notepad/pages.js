// 页面元数据 CRUD（笔画数据本身在 page-data.js，走 R2）。
import { ensureNotepadSchema } from '../../_lib/db.js';
import { getOwner } from '../../_lib/auth.js';
import { PAPERS, deletePageBlobs } from '../../_lib/notepad.js';

async function requireOwner(request, env) {
  const owner = await getOwner(request, env);
  if (!owner) return null;
  await ensureNotepadSchema(env);
  return owner;
}

async function ownsBook(env, owner, bookId) {
  return env.DB.prepare('SELECT id, paper FROM notepad_books WHERE id = ? AND owner = ?').bind(bookId, owner).first();
}

export async function onRequestGet({ request, env }) {
  const owner = await requireOwner(request, env);
  if (!owner) return Response.json({ error: '请先登录' }, { status: 401 });

  const url = new URL(request.url);
  const bookId = parseInt(url.searchParams.get('book_id') || '', 10);
  if (!bookId) return Response.json({ error: 'missing book_id' }, { status: 400 });
  if (!(await ownsBook(env, owner, bookId))) return Response.json({ error: 'not found' }, { status: 404 });

  const pages = await env.DB.prepare(
    'SELECT id, idx, paper, thumb, updated_at FROM notepad_pages WHERE book_id = ? AND owner = ? ORDER BY idx ASC'
  ).bind(bookId, owner).all();
  return Response.json({ pages: pages.results || [] });
}

export async function onRequestPost({ request, env }) {
  const owner = await requireOwner(request, env);
  if (!owner) return Response.json({ error: '请先登录' }, { status: 401 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'invalid body' }, { status: 400 }); }
  const bookId = parseInt(body?.book_id, 10);
  if (!bookId) return Response.json({ error: 'missing book_id' }, { status: 400 });
  const book = await ownsBook(env, owner, bookId);
  if (!book) return Response.json({ error: 'not found' }, { status: 404 });

  const paper = PAPERS.includes(body?.paper) ? body.paper : book.paper;
  const top = await env.DB.prepare('SELECT COALESCE(MAX(idx),-1) AS m FROM notepad_pages WHERE book_id = ?').bind(bookId).first();
  const maxIdx = top?.m ?? -1;
  // after：插入到第 after 页之后（新页 idx=after+1，后续页后移）；缺省/越界=追加到末尾
  let idx;
  const after = Number.isInteger(body?.after) ? body.after : NaN;
  if (after >= 0 && after <= maxIdx) {
    await env.DB.prepare('UPDATE notepad_pages SET idx = idx + 1 WHERE book_id = ? AND idx > ?').bind(bookId, after).run();
    idx = after + 1;
  } else {
    idx = maxIdx + 1;
  }
  const now = Date.now();
  const res = await env.DB.prepare(
    `INSERT INTO notepad_pages (book_id, owner, idx, paper, thumb, updated_at) VALUES (?, ?, ?, ?, '', ?)`
  ).bind(bookId, owner, idx, paper, now).run();
  await env.DB.prepare('UPDATE notepad_books SET updated_at = ? WHERE id = ?').bind(now, bookId).run();
  return Response.json({ ok: true, id: res.meta.last_row_id, idx, paper });
}

export async function onRequestPut({ request, env }) {
  const owner = await requireOwner(request, env);
  if (!owner) return Response.json({ error: '请先登录' }, { status: 401 });

  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id') || '', 10);
  if (!id) return Response.json({ error: 'missing id' }, { status: 400 });
  const page = await env.DB.prepare('SELECT id, book_id, idx FROM notepad_pages WHERE id = ? AND owner = ?').bind(id, owner).first();
  if (!page) return Response.json({ error: 'not found' }, { status: 404 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'invalid body' }, { status: 400 }); }

  // 重排：move_to = 目标位置（0 起）。读出有序 id 列表，本地挪位后按新顺序批量回写 idx。
  if (Number.isInteger(body?.move_to)) {
    const rows = await env.DB.prepare('SELECT id FROM notepad_pages WHERE book_id = ? ORDER BY idx ASC').bind(page.book_id).all();
    const ids = (rows.results || []).map((r) => r.id);
    const from = ids.indexOf(id);
    const to = Math.min(Math.max(body.move_to, 0), ids.length - 1);
    if (from < 0) return Response.json({ error: 'not found' }, { status: 404 });
    if (from !== to) {
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      const stmt = env.DB.prepare('UPDATE notepad_pages SET idx = ? WHERE id = ?');
      await env.DB.batch(ids.map((pid, i) => stmt.bind(i, pid)));
      await env.DB.prepare('UPDATE notepad_books SET updated_at = ? WHERE id = ?').bind(Date.now(), page.book_id).run();
    }
    return Response.json({ ok: true, to });
  }

  if (!PAPERS.includes(body?.paper)) return Response.json({ error: 'invalid paper' }, { status: 400 });
  await env.DB.prepare('UPDATE notepad_pages SET paper = ?, updated_at = ? WHERE id = ?').bind(body.paper, Date.now(), id).run();
  return Response.json({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  const owner = await requireOwner(request, env);
  if (!owner) return Response.json({ error: '请先登录' }, { status: 401 });

  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id') || '', 10);
  if (!id) return Response.json({ error: 'missing id' }, { status: 400 });
  const page = await env.DB.prepare('SELECT id, book_id, idx FROM notepad_pages WHERE id = ? AND owner = ?').bind(id, owner).first();
  if (!page) return Response.json({ error: 'not found' }, { status: 404 });

  const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM notepad_pages WHERE book_id = ?').bind(page.book_id).first();
  if ((count?.c || 0) <= 1) return Response.json({ error: '笔记本至少保留一页' }, { status: 400 });

  await deletePageBlobs(env, owner, id); // 页面 JSON + 引用的图片资产一起清
  await env.DB.prepare('DELETE FROM notepad_pages WHERE id = ? AND owner = ?').bind(id, owner).run();
  // 紧凑后续页的 idx，避免出现空洞
  await env.DB.prepare('UPDATE notepad_pages SET idx = idx - 1 WHERE book_id = ? AND idx > ?').bind(page.book_id, page.idx).run();
  await env.DB.prepare('UPDATE notepad_books SET updated_at = ? WHERE id = ?').bind(Date.now(), page.book_id).run();
  return Response.json({ ok: true });
}
