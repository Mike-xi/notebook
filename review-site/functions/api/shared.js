// 只读分享的取数端点（公开路径，_middleware 放行，凭 HMAC token 自鉴权，无需登录）。
// GET /api/shared?token=...        -> { kind, file, title, subject, content? }（元数据，给阅读器取标题）
// GET /api/shared?token=...&raw=1  -> 正文原始流：html→text/html、md→text/markdown、pdf→application/pdf
//                                    （供分享模式的阅读器 iframe / viewer 同源加载，享完整阅读功能）
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

  // 正文原始流（供分享模式阅读器同源加载）
  if (url.searchParams.get('raw') === '1') {
    // pdf：动态取 R2、静态经 ASSETS，流式返回
    if (kind === 'pdf') {
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

    // html / md：动态取 D1、静态读 /notes/，按类型设置 Content-Type
    let content = null;
    if (isDynamic) {
      await ensureCoursesSchema(env);
      const row = await env.DB.prepare('SELECT html FROM courses WHERE file = ?').bind(file).first();
      content = row ? row.html : null;
    } else {
      const r = await env.ASSETS.fetch(new Request(url.origin + '/notes/' + encodeURIComponent(file)));
      content = r.ok ? await r.text() : null;
    }
    if (content == null) return new Response('not found', { status: 404 });
    const ctype = kind === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8';
    return new Response(content, {
      headers: { 'Content-Type': ctype, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' },
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
