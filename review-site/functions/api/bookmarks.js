// GET    /api/bookmarks            -> 全部书签
// GET    /api/bookmarks?file=xx    -> 某文件的书签
// POST   /api/bookmarks  body: { file, title, scroll_pct }
// DELETE /api/bookmarks  body: { id }

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const file = url.searchParams.get('file');

  let stmt;
  if (file) {
    stmt = env.DB.prepare(
      'SELECT id, file, title, scroll_pct, created_at FROM bookmarks WHERE file = ? ORDER BY scroll_pct ASC'
    ).bind(file);
  } else {
    stmt = env.DB.prepare(
      'SELECT id, file, title, scroll_pct, created_at FROM bookmarks ORDER BY created_at DESC'
    );
  }
  const { results } = await stmt.all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }

  const { file, title, scroll_pct } = body || {};
  if (typeof file !== 'string' || typeof title !== 'string' || typeof scroll_pct !== 'number') {
    return Response.json({ error: 'bad params' }, { status: 400 });
  }

  const result = await env.DB.prepare(
    'INSERT INTO bookmarks (file, title, scroll_pct, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(file, title.slice(0, 200), Math.max(0, Math.min(1, scroll_pct)), Date.now())
    .run();

  return Response.json({ ok: true, id: result.meta.last_row_id });
}

export async function onRequestDelete({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }

  const { id } = body || {};
  if (typeof id !== 'number') {
    return Response.json({ error: 'bad params' }, { status: 400 });
  }

  await env.DB.prepare('DELETE FROM bookmarks WHERE id = ?').bind(id).run();
  return Response.json({ ok: true });
}
