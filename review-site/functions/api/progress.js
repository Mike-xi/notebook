// GET  /api/progress             -> 全部进度（首页用）
// GET  /api/progress?file=xx     -> 单个文件进度
// POST /api/progress  body: { file, scroll_pct }

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const file = url.searchParams.get('file');

  if (file) {
    const row = await env.DB.prepare(
      'SELECT file, scroll_pct, updated_at FROM progress WHERE file = ?'
    )
      .bind(file)
      .first();
    return Response.json(row || { file, scroll_pct: 0, updated_at: null });
  }

  const { results } = await env.DB.prepare(
    'SELECT file, scroll_pct, updated_at FROM progress'
  ).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }

  const { file, scroll_pct } = body || {};
  if (typeof file !== 'string' || typeof scroll_pct !== 'number') {
    return Response.json({ error: 'bad params' }, { status: 400 });
  }

  await env.DB.prepare(
    `INSERT INTO progress (file, scroll_pct, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(file) DO UPDATE SET
       scroll_pct = excluded.scroll_pct,
       updated_at = excluded.updated_at`
  )
    .bind(file, Math.max(0, Math.min(1, scroll_pct)), Date.now())
    .run();

  return Response.json({ ok: true });
}
