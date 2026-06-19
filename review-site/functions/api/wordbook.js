// 英汉词典：单词本（收藏）+ 查词历史，云端同步。owner=角色（admin/guest），各自独立一份。
// GET  /api/wordbook                         -> { favorites:[{word,p,t,created_at}], history:[{word,created_at}] }
// POST /api/wordbook { action:'fav',   word, p, t }  -> { ok, favorited:true }   收藏
// POST /api/wordbook { action:'unfav', word }        -> { ok, favorited:false }  取消收藏
// POST /api/wordbook { action:'hist',  word }        -> { ok }                   记一次查词
// POST /api/wordbook { action:'clearhist' }          -> { ok }                   清空历史
// 鉴权由 _middleware.js 拦在登录后；这里按角色隔离数据。
import { ensureDictSchema, pruneDictHistory } from '../_lib/db.js';
import { getRole } from '../_lib/auth.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const cleanWord = (s) => str(s).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80);

export async function onRequestGet({ request, env }) {
  await ensureDictSchema(env);
  const owner = (await getRole(request, env)) || 'guest';
  const fav = (await env.DB.prepare(
    'SELECT word, p, t, created_at FROM dict_favorites WHERE owner = ? ORDER BY created_at DESC LIMIT 1000'
  ).bind(owner).all()).results || [];
  const hist = (await env.DB.prepare(
    'SELECT word, created_at FROM dict_history WHERE owner = ? ORDER BY created_at DESC LIMIT 200'
  ).bind(owner).all()).results || [];
  return Response.json({ favorites: fav, history: hist });
}

export async function onRequestPost({ request, env }) {
  await ensureDictSchema(env);
  const owner = (await getRole(request, env)) || 'guest';

  let b;
  try { b = await request.json(); } catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }
  const action = str(b?.action);
  const now = Date.now();

  if (action === 'fav') {
    const word = cleanWord(b?.word);
    if (!word) return Response.json({ error: '缺少单词' }, { status: 400 });
    const p = str(b?.p).slice(0, 120);
    const t = str(b?.t).slice(0, 400);
    await env.DB.prepare(
      `INSERT INTO dict_favorites (owner, word, p, t, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner, word) DO UPDATE SET p=excluded.p, t=excluded.t`
    ).bind(owner, word, p, t, now).run();
    return Response.json({ ok: true, favorited: true });
  }

  if (action === 'unfav') {
    const word = cleanWord(b?.word);
    if (!word) return Response.json({ error: '缺少单词' }, { status: 400 });
    await env.DB.prepare('DELETE FROM dict_favorites WHERE owner = ? AND word = ?').bind(owner, word).run();
    return Response.json({ ok: true, favorited: false });
  }

  if (action === 'hist') {
    const word = cleanWord(b?.word);
    if (!word) return Response.json({ error: '缺少单词' }, { status: 400 });
    await env.DB.prepare(
      `INSERT INTO dict_history (owner, word, created_at) VALUES (?, ?, ?)
       ON CONFLICT(owner, word) DO UPDATE SET created_at=excluded.created_at`
    ).bind(owner, word, now).run();
    await pruneDictHistory(env, owner);
    return Response.json({ ok: true });
  }

  if (action === 'clearhist') {
    await env.DB.prepare('DELETE FROM dict_history WHERE owner = ?').bind(owner).run();
    return Response.json({ ok: true });
  }

  return Response.json({ error: '未知操作' }, { status: 400 });
}
