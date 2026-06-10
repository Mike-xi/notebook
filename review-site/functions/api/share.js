// POST /api/share {file, days?} -> { url, expires_at }
// 生成只读分享链接：无状态 HMAC 签名 token（file + 过期时间），无需建表。
// 链接默认 30 天有效；因 token 无状态，过期前无法单独撤销（换 AUTH_SECRET 会使所有链接失效）。
// 鉴权由 _middleware.js 统一处理（仅登录用户可生成）。
import { hmacSign } from '../_lib/auth.js';
import { logEvent } from '../_lib/db.js';

function b64urlEncode(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: '请求格式错误' }, { status: 400 }); }

  const file = typeof body?.file === 'string' ? body.file.trim() : '';
  if (!file || file.length > 120 || file.includes('|') || file.includes('/')) {
    return Response.json({ error: '非法的课程标识' }, { status: 400 });
  }
  const days = Math.min(Math.max(parseInt(body?.days, 10) || 30, 1), 90);
  const exp = Date.now() + days * 24 * 60 * 60 * 1000;

  const payload = `${file}|${exp}`;
  const sig = await hmacSign(env.AUTH_SECRET, 'share:' + payload);
  const token = `${b64urlEncode(payload)}.${sig}`;

  await logEvent(env, 'share', file);
  return Response.json({ url: `/share.html?token=${encodeURIComponent(token)}`, expires_at: exp });
}
