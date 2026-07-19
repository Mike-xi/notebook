// 通用偏好读写（存 prefs 表，与课程排序共用一张表）。
// 仅允许白名单前缀的 key，避免被当成任意 KV 滥用。
// GET /api/prefs?key=reader:xxx -> { value: string|null }
// PUT /api/prefs {key, value}   -> { ok: true }
// 鉴权由 _middleware.js 统一处理。
import { ensurePrefsSchema } from '../_lib/db.js';
import { getOwner } from '../_lib/auth.js';

const ALLOWED_PREFIXES = ['reader:', 'appearance:'];
const MAX_KEY_LEN = 200;
const MAX_VALUE_LEN = 2000;

function validKey(k) {
  return typeof k === 'string' && k.length > 0 && k.length <= MAX_KEY_LEN
    && ALLOWED_PREFIXES.some((p) => k.startsWith(p));
}

async function storageKey(request, env, key) {
  if (!key.startsWith('appearance:')) return key;
  const owner = await getOwner(request, env);
  return owner ? `user:${owner}:${key}` : null;
}

export async function onRequestGet({ request, env }) {
  const key = new URL(request.url).searchParams.get('key');
  if (!validKey(key)) return Response.json({ error: '非法的 key' }, { status: 400 });
  const dbKey = await storageKey(request, env, key);
  if (!dbKey) return Response.json({ error: 'unauthorized' }, { status: 401 });
  await ensurePrefsSchema(env);
  const row = await env.DB.prepare('SELECT value FROM prefs WHERE key = ?').bind(dbKey).first();
  return Response.json({ value: row ? row.value : null });
}

export async function onRequestPut({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }

  const key = body?.key;
  if (!validKey(key)) return Response.json({ error: '非法的 key' }, { status: 400 });
  const dbKey = await storageKey(request, env, key);
  if (!dbKey) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const value = typeof body?.value === 'string' ? body.value : JSON.stringify(body?.value ?? '');
  if (value.length > MAX_VALUE_LEN) return Response.json({ error: 'value 过长' }, { status: 400 });

  await ensurePrefsSchema(env);
  await env.DB.prepare(
    'INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(dbKey, value).run();
  return Response.json({ ok: true });
}
