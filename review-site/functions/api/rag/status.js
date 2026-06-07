// GET /api/rag/status?file=xx -> { indexed, hash, chunks, hasVectorize }
// 客户端据此决定是否需要重新 ingest。鉴权由 _middleware.js 处理。
import { ensureRagSchema } from '../../_lib/rag.js';

export async function onRequestGet({ request, env }) {
  await ensureRagSchema(env);
  const file = new URL(request.url).searchParams.get('file');
  if (!file) return Response.json({ error: 'missing file' }, { status: 400 });
  const row = await env.DB.prepare('SELECT hash, chunks FROM rag_index WHERE file = ?').bind(file).first();
  return Response.json({
    indexed: !!row,
    hash: row?.hash || '',
    chunks: row?.chunks || 0,
    hasVectorize: !!env.VECTORIZE,
  });
}
