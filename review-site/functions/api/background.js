// 首页自定义背景图。
//
// 背景一共最多 8 张：5 张内置（前端写死，见 assets/backgrounds.js）+ 最多 3 张自定义上传。
// 存储范围（scope）按身份分两份，与站内「三级独立、一二级共用」的口径一致：
//   admin  -> 'admin'    三级密码自己一份
//   friend/guest -> 'shared'  一二级共用一份
//
// GET    /api/background?list=1   -> { scope, max, items: [{id,label,mime,updated_at}] }
// GET    /api/background?id=xxx   -> 图片本体（URL 带 v=updated_at，可长缓存）
// POST   /api/background?label=   -> 上传，body 为图片原始字节，Content-Type 带 mime
// DELETE /api/background?id=xxx   -> 删除
import { ensureBackgroundsSchema } from '../_lib/db.js';
import { getRole } from '../_lib/auth.js';

const MAX_CUSTOM_BG = 3;                 // 5 张内置 + 3 张自定义 = 8
const MAX_BYTES = 4 * 1024 * 1024;       // 前端已压到 ≤1920px webp，这里只兜底
const OK_MIME = ['image/webp', 'image/png', 'image/jpeg', 'image/avif'];

const json = (data, status = 200) => Response.json(data, { status });

// 一二级共用一份，三级自己一份
function scopeOf(role) { return role === 'admin' ? 'admin' : 'shared'; }

// id 由服务端生成，只允许安全字符，避免拼出越界的 R2 key
const cleanId = (raw) => {
  const s = String(raw || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,40}$/.test(s) ? s : '';
};
const cleanLabel = (raw) => String(raw || '').replace(/[^\p{L}\p{N} _.·-]/gu, '').trim().slice(0, 16);

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!env.DB) return json({ scope: 'shared', max: MAX_CUSTOM_BG, items: [] });
  await ensureBackgroundsSchema(env);

  if (url.searchParams.get('list')) {
    const role = (await getRole(request, env)) || 'guest';
    const scope = scopeOf(role);
    const rs = await env.DB
      .prepare('SELECT id, label, mime, updated_at FROM home_backgrounds WHERE scope = ? ORDER BY updated_at')
      .bind(scope).all();
    return json({ scope, max: MAX_CUSTOM_BG, items: rs.results || [] });
  }

  // 取图：只允许读自己 scope 里的图，避免游客猜 id 拿到管理员的背景
  const id = cleanId(url.searchParams.get('id'));
  if (!id) return json({ error: '参数不合法' }, 400);
  const role = (await getRole(request, env)) || 'guest';
  const row = await env.DB
    .prepare('SELECT r2_key, mime FROM home_backgrounds WHERE id = ? AND scope = ?')
    .bind(id, scopeOf(role)).first();
  if (!row) return new Response('Not found', { status: 404 });
  if (!env.FILES) return json({ error: 'R2 未配置' }, 500);

  const obj = await env.FILES.get(row.r2_key);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.mime || 'image/webp',
      // URL 上带 v=updated_at，内容变了 URL 就变，可放心长缓存
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: obj.httpEtag,
    },
  });
}

export async function onRequestPost({ request, env }) {
  const role = await getRole(request, env);
  if (!role) return json({ error: '请先登录' }, 401);
  if (!env.FILES) return json({ error: 'R2 未配置' }, 500);
  await ensureBackgroundsSchema(env);
  const scope = scopeOf(role);

  const mime = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!OK_MIME.includes(mime)) return json({ error: '只支持图片（webp / png / jpg / avif）' }, 415);

  const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declared && declared > MAX_BYTES) return json({ error: '图片太大，上限 4MB' }, 413);
  if (!request.body) return json({ error: '没有图片内容' }, 400);

  const used = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM home_backgrounds WHERE scope = ?').bind(scope).first();
  if ((used?.n || 0) >= MAX_CUSTOM_BG) {
    return json({ error: `自定义背景最多 ${MAX_CUSTOM_BG} 张，请先删掉一张` }, 409);
  }

  const url = new URL(request.url);
  const id = Math.random().toString(36).slice(2, 10);
  const label = cleanLabel(url.searchParams.get('label')) || '我的背景';
  const r2Key = `home-bg/${scope}/${id}`;

  let obj;
  try {
    obj = await env.FILES.put(r2Key, request.body, { httpMetadata: { contentType: mime } });
  } catch {
    return json({ error: '上传到存储失败' }, 500);
  }
  const size = obj?.size ?? declared ?? 0;
  if (size > MAX_BYTES) {
    try { await env.FILES.delete(r2Key); } catch { /* 清理失败不影响返回 */ }
    return json({ error: '图片太大，上限 4MB' }, 413);
  }

  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO home_backgrounds (id, scope, label, r2_key, mime, size, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, scope, label, r2Key, mime, size, now).run();

  return json({ ok: true, id, label, mime, size, updated_at: now });
}

export async function onRequestDelete({ request, env }) {
  const role = await getRole(request, env);
  if (!role) return json({ error: '请先登录' }, 401);
  await ensureBackgroundsSchema(env);
  const scope = scopeOf(role);

  const id = cleanId(new URL(request.url).searchParams.get('id'));
  if (!id) return json({ error: '参数不合法' }, 400);

  const row = await env.DB
    .prepare('SELECT r2_key FROM home_backgrounds WHERE id = ? AND scope = ?').bind(id, scope).first();
  if (!row) return json({ ok: true, id, removed: false });
  if (env.FILES) { try { await env.FILES.delete(row.r2_key); } catch { /* R2 已不在也算删掉了 */ } }
  await env.DB.prepare('DELETE FROM home_backgrounds WHERE id = ? AND scope = ?').bind(id, scope).run();
  return json({ ok: true, id, removed: true });
}
