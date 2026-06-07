// 高亮/批注（按文本字符偏移定位，笔记内容静态故可靠）
// GET    /api/highlights?file=xx            -> 某文件的全部高亮
// POST   /api/highlights  {file,start,end,text,color?}  -> 新建，返回 id
// PUT    /api/highlights  {id, color?, note?}           -> 改颜色/批注
// DELETE /api/highlights  {id}                          -> 删除
// 鉴权由 _middleware.js 处理。
import { ensureHighlightsSchema } from '../_lib/db.js';

const COLORS = ['yellow', 'green', 'blue', 'pink'];
const json = (o, s = 200) => Response.json(o, { status: s });

export async function onRequestGet({ request, env }) {
  await ensureHighlightsSchema(env);
  const file = new URL(request.url).searchParams.get('file');
  if (!file) return json({ error: 'missing file' }, 400);
  const { results } = await env.DB.prepare(
    'SELECT id, file, start_off, end_off, text, color, note, created_at FROM highlights WHERE file = ? ORDER BY start_off ASC'
  ).bind(file).all();
  return json(results || []);
}

export async function onRequestPost({ request, env }) {
  await ensureHighlightsSchema(env);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'invalid body' }, 400); }
  const { file, start, end, text } = b || {};
  if (typeof file !== 'string' || typeof start !== 'number' || typeof end !== 'number' || end <= start) {
    return json({ error: 'bad params' }, 400);
  }
  const color = COLORS.includes(b.color) ? b.color : 'yellow';
  const res = await env.DB.prepare(
    'INSERT INTO highlights (file, start_off, end_off, text, color, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(file, Math.floor(start), Math.floor(end), String(text || '').slice(0, 500), color, '', Date.now()).run();
  return json({ ok: true, id: res.meta.last_row_id });
}

export async function onRequestPut({ request, env }) {
  await ensureHighlightsSchema(env);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'invalid body' }, 400); }
  const { id } = b || {};
  if (typeof id !== 'number') return json({ error: 'bad params' }, 400);
  const sets = [], binds = [];
  if (typeof b.color === 'string' && COLORS.includes(b.color)) { sets.push('color = ?'); binds.push(b.color); }
  if (typeof b.note === 'string') { sets.push('note = ?'); binds.push(b.note.slice(0, 1000)); }
  if (!sets.length) return json({ error: 'nothing to update' }, 400);
  binds.push(id);
  await env.DB.prepare(`UPDATE highlights SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return json({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  await ensureHighlightsSchema(env);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'invalid body' }, 400); }
  if (typeof b?.id !== 'number') return json({ error: 'bad params' }, 400);
  await env.DB.prepare('DELETE FROM highlights WHERE id = ?').bind(b.id).run();
  return json({ ok: true });
}
