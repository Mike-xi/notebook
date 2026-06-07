// POST /api/rag/ingest  { file, hash, sections:[{heading,level,text}] }
// 把课程正文切块、嵌入、写入 Vectorize；hash 不变则跳过。鉴权由 _middleware.js 处理。
import { ensureRagSchema, chunkSections, embed, vecId } from '../../_lib/rag.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

export async function onRequestPost({ request, env }) {
  if (!env.AI || !env.VECTORIZE) return Response.json({ error: 'AI/Vectorize 未绑定' }, { status: 503 });
  await ensureRagSchema(env);

  let b;
  try { b = await request.json(); } catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }
  const file = str(b?.file);
  const hash = str(b?.hash);
  const sections = Array.isArray(b?.sections) ? b.sections : [];
  if (!file) return Response.json({ error: '缺少 file' }, { status: 400 });

  const existing = await env.DB.prepare('SELECT hash, chunks FROM rag_index WHERE file = ?').bind(file).first();
  if (existing && hash && existing.hash === hash) {
    return Response.json({ ok: true, skipped: true, chunks: existing.chunks });
  }

  const chunks = chunkSections(sections);

  // 删除旧向量（按旧块数推 id）
  if (existing && existing.chunks > 0) {
    const oldIds = [];
    for (let i = 0; i < existing.chunks; i++) oldIds.push(vecId(file, i));
    try { await env.VECTORIZE.deleteByIds(oldIds); } catch {}
  }

  if (!chunks.length) {
    // 无可索引内容（空/pdf）：写占位避免反复重试
    await upsertIndexRow(env, file, hash || 'empty', 0);
    return Response.json({ ok: true, chunks: 0 });
  }

  const vectors = [];
  for (let i = 0; i < chunks.length; i += 100) {
    const batch = chunks.slice(i, i + 100);
    const embs = await embed(env, batch.map((c) => c.text));
    batch.forEach((c, j) => {
      vectors.push({
        id: vecId(file, i + j),
        values: embs[j],
        metadata: { file, heading: c.heading.slice(0, 120), idx: i + j, text: c.text.slice(0, 1000) },
      });
    });
  }
  await env.VECTORIZE.upsert(vectors);
  await upsertIndexRow(env, file, hash || 'nohash', chunks.length);

  return Response.json({ ok: true, chunks: chunks.length });
}

function upsertIndexRow(env, file, hash, chunks) {
  return env.DB.prepare(
    `INSERT INTO rag_index (file, hash, chunks, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(file) DO UPDATE SET hash = excluded.hash, chunks = excluded.chunks, updated_at = excluded.updated_at`
  ).bind(file, hash, chunks, Date.now()).run();
}
