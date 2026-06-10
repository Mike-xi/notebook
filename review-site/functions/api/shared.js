// 只读分享的取数端点（公开路径，_middleware 放行，凭 HMAC token 自鉴权，无需登录）。
// GET /api/shared?token=...        -> { kind, file, title, subject, content? }（html/md 返回正文文本）
// GET /api/shared?token=...&raw=1  -> pdf 原始流（动态取 R2，静态经 ASSETS）
import { hmacSign } from '../_lib/auth.js';
import { ensureCoursesSchema } from '../_lib/db.js';

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// 校验 token，返回 file；无效/过期返回 null
async function verifyToken(env, token) {
  try {
    const dot = (token || '').lastIndexOf('.');
    if (dot <= 0) return null;
    const payload = b64urlDecode(token.slice(0, dot));
    const sig = token.slice(dot + 1);
    const expect = await hmacSign(env.AUTH_SECRET, 'share:' + payload);
    if (sig !== expect) return null;
    const sep = payload.lastIndexOf('|');
    if (sep <= 0) return null;
    const file = payload.slice(0, sep);
    const exp = parseInt(payload.slice(sep + 1), 10);
    if (!file || !Number.isFinite(exp) || exp < Date.now()) return null;
    return file;
  } catch { return null; }
}

function kindOf(file) {
  const ext = (file.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'md' || ext === 'markdown') return 'md';
  return 'html';
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  const file = await verifyToken(env, token);
  if (!file) return Response.json({ error: '分享链接无效或已过期' }, { status: 403 });

  const kind = kindOf(file);
  const isDynamic = file.startsWith('u-');

  // pdf 原始流
  if (url.searchParams.get('raw') === '1') {
    if (kind !== 'pdf') return Response.json({ error: '仅 PDF 支持 raw' }, { status: 400 });
    if (isDynamic) {
      try {
        const obj = await env.FILES.get(file);
        if (!obj) return new Response('not found', { status: 404 });
        return new Response(obj.body, {
          headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, max-age=600' },
        });
      } catch { return new Response('not found', { status: 404 }); }
    }
    const r = await env.ASSETS.fetch(new Request(url.origin + '/notes/' + encodeURIComponent(file)));
    if (!r.ok) return new Response('not found', { status: 404 });
    return new Response(r.body, {
      headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, max-age=600' },
    });
  }

  // 元数据 + 正文
  if (isDynamic) {
    await ensureCoursesSchema(env);
    const row = await env.DB.prepare('SELECT title, subject, kind, html FROM courses WHERE file = ?').bind(file).first();
    if (!row) return Response.json({ error: '课程不存在（可能已被删除）' }, { status: 404 });
    return Response.json({
      kind: row.kind || kind, file,
      title: row.title || file, subject: row.subject || '',
      content: row.kind === 'pdf' ? undefined : row.html,
    });
  }

  // 静态课程：meta 取 courses.json，正文取 /notes/*
  let meta = null;
  try {
    const mr = await env.ASSETS.fetch(new Request(url.origin + '/courses.json'));
    const courses = mr.ok ? await mr.json() : [];
    meta = (courses || []).find((c) => c.file === file) || null;
  } catch {}
  let content;
  if (kind !== 'pdf') {
    const r = await env.ASSETS.fetch(new Request(url.origin + '/notes/' + encodeURIComponent(file)));
    if (!r.ok) return Response.json({ error: '课程不存在' }, { status: 404 });
    content = await r.text();
  }
  return Response.json({
    kind, file,
    title: (meta && meta.title) || file, subject: (meta && meta.subject) || '',
    content,
  });
}
