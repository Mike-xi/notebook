// 笔记本 CRUD。owner 由登录密码哈希决定（见 auth.js getOwner），三个密码各自一份，互不可见。
import { ensureNotepadSchema } from '../../_lib/db.js';
import { getOwner } from '../../_lib/auth.js';
import { PAPERS, deletePageBlobs } from '../../_lib/notepad.js';

// 封面样式 id 白名单（assets/notepad-covers/cover-XX.svg；'' = 纯色封面用 color）
const COVERS = ['', 'cover-01', 'cover-02', 'cover-03', 'cover-04', 'cover-05', 'cover-06', 'cover-07', 'cover-08'];

async function requireOwner(request, env) {
  const owner = await getOwner(request, env);
  if (!owner) return null;
  await ensureNotepadSchema(env);
  return owner;
}

export async function onRequestGet({ request, env }) {
  const owner = await requireOwner(request, env);
  if (!owner) return Response.json({ error: '请先登录' }, { status: 401 });

  const books = await env.DB.prepare(
    `SELECT b.id, b.title, b.color, b.cover, b.paper, b.sort, b.updated_at,
            (SELECT COUNT(*) FROM notepad_pages p WHERE p.book_id = b.id) AS page_count,
            (SELECT thumb FROM notepad_pages p WHERE p.book_id = b.id ORDER BY idx ASC LIMIT 1) AS first_thumb
     FROM notepad_books b WHERE b.owner = ? ORDER BY b.sort ASC, b.id ASC`
  ).bind(owner).all();
  return Response.json({ books: books.results || [] });
}

export async function onRequestPost({ request, env }) {
  const owner = await requireOwner(request, env);
  if (!owner) return Response.json({ error: '请先登录' }, { status: 401 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'invalid body' }, { status: 400 }); }
  const title = String(body?.title || '未命名笔记本').slice(0, 60);
  const color = /^#[0-9a-fA-F]{6}$/.test(body?.color || '') ? body.color : '#f2c14e';
  const cover = COVERS.includes(body?.cover) ? body.cover : '';
  const paper = PAPERS.includes(body?.paper) ? body.paper : 'blank';
  const now = Date.now();

  const top = await env.DB.prepare('SELECT COALESCE(MIN(sort),0) AS m FROM notepad_books WHERE owner = ?').bind(owner).first();
  const sort = (top?.m || 0) - 1;

  const res = await env.DB.prepare(
    `INSERT INTO notepad_books (owner, title, color, cover, paper, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(owner, title, color, cover, paper, sort, now, now).run();
  const bookId = res.meta.last_row_id;

  // 新笔记本自带第一页
  await env.DB.prepare(
    `INSERT INTO notepad_pages (book_id, owner, idx, paper, thumb, updated_at) VALUES (?, ?, 0, ?, '', ?)`
  ).bind(bookId, owner, paper, now).run();

  return Response.json({ ok: true, id: bookId });
}

export async function onRequestPut({ request, env }) {
  const owner = await requireOwner(request, env);
  if (!owner) return Response.json({ error: '请先登录' }, { status: 401 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'invalid body' }, { status: 400 }); }
  const id = parseInt(body?.id, 10);
  if (!id) return Response.json({ error: 'missing id' }, { status: 400 });
  const row = await env.DB.prepare('SELECT id FROM notepad_books WHERE id = ? AND owner = ?').bind(id, owner).first();
  if (!row) return Response.json({ error: 'not found' }, { status: 404 });

  const sets = [];
  const binds = [];
  if (typeof body.title === 'string') { sets.push('title = ?'); binds.push(body.title.slice(0, 60)); }
  if (/^#[0-9a-fA-F]{6}$/.test(body.color || '')) { sets.push('color = ?'); binds.push(body.color); }
  if (COVERS.includes(body.cover)) { sets.push('cover = ?'); binds.push(body.cover); }
  if (PAPERS.includes(body.paper)) { sets.push('paper = ?'); binds.push(body.paper); }
  if (!sets.length) return Response.json({ ok: true });
  sets.push('updated_at = ?'); binds.push(Date.now());
  binds.push(id, owner);
  await env.DB.prepare(`UPDATE notepad_books SET ${sets.join(', ')} WHERE id = ? AND owner = ?`).bind(...binds).run();
  return Response.json({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  const owner = await requireOwner(request, env);
  if (!owner) return Response.json({ error: '请先登录' }, { status: 401 });

  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id') || '', 10);
  if (!id) return Response.json({ error: 'missing id' }, { status: 400 });
  const row = await env.DB.prepare('SELECT id FROM notepad_books WHERE id = ? AND owner = ?').bind(id, owner).first();
  if (!row) return Response.json({ error: 'not found' }, { status: 404 });

  const pages = await env.DB.prepare('SELECT id FROM notepad_pages WHERE book_id = ? AND owner = ?').bind(id, owner).all();
  for (const p of pages.results || []) {
    await deletePageBlobs(env, owner, p.id); // 页面 JSON + 引用的图片资产一起清
  }
  await env.DB.prepare('DELETE FROM notepad_pages WHERE book_id = ? AND owner = ?').bind(id, owner).run();
  await env.DB.prepare('DELETE FROM notepad_books WHERE id = ? AND owner = ?').bind(id, owner).run();
  return Response.json({ ok: true });
}
