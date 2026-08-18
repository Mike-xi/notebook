// WebDAV 服务（私人云盘「Xi Pan」的多端接入）。
//   存储：R2 桶 FILES，前缀 xipan/，对象 key = 完整路径（与路径解耦的公共云盘不同，这里 key 即路径，
//   保证 WebDAV 与站内浏览器视图同一份真相）。空目录用「以 / 结尾的零字节对象」当占位标记。
//   鉴权：HTTP Basic（用户名任意，密码 = ADMIN_PASSWORD 之一）给 Windows/iPhone 等外部客户端；
//        或站点管理员 Cookie，给站内浏览器视图用 fetch 调本接口。
//        用浏览器直接打开这个地址不会弹 Basic 对话框，见 isBrowserNav。
//   挂载地址（带末尾斜杠）：https://<域名>/dav/
//   _middleware.js 已放行 /dav，由本函数自行鉴权。
import { getRole } from '../_lib/auth.js';

const ROOT = 'xipan/';
const XIPAN_QUOTA = 2 * 1024 * 1024 * 1024;   // Xi Pan 私人云盘总空间上限：2 GB
const DAV = 'DAV: 1, 2';
const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK';

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.FILES) return new Response('R2 not configured', { status: 500 });

  const url = new URL(request.url);
  // /dav/<path...> -> path（去掉前缀，规范化，挡 ..）
  let rel = decodeURIComponent(url.pathname.replace(/^\/dav\/?/, ''));
  rel = rel.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  if (rel.split('/').some((s) => s === '..' || s === '.')) return new Response('Bad path', { status: 400 });
  const isDirReq = url.pathname.endsWith('/') || rel === '';

  // ---- 鉴权：Basic 或 管理员 Cookie ----
  // 挂载地址被人直接粘进浏览器地址栏时，别走 Basic：本站只有一个密码、根本没有用户名，
  // 浏览器却会弹一个「用户名 + 密码」的原生框，填对密码也只换来一页 405（GET 目录）。
  // 所以先认出「浏览器导航请求」，把它引到网页版 Xi Pan / 登录页去。
  const nav = isBrowserNav(request);
  if (!(await authed(request, env))) {
    if (nav) {
      // 压根没登录 -> 去登录页，登完回到这个地址；登录页只认站内相对路径
      if (!(await currentRole(request, env))) {
        return Response.redirect(new URL('/login?next=' + encodeURIComponent(url.pathname), url).toString(), 302);
      }
      // 登录了但不是三级：再跳登录页只会来回打转，直接说清楚
      return adminOnlyPage();
    }
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Xi Pan", charset="UTF-8"' },
    });
  }
  // 已登录的浏览器导航：目录交给网页版（这个函数只会吐 XML / 405），文件照常下载
  if (nav && (isDirReq || (request.method === 'GET' && await isCollection(env, rel)))) {
    return Response.redirect(new URL('/xipan#/' + rel.split('/').map(encodeURIComponent).join('/'), url).toString(), 302);
  }

  const m = request.method.toUpperCase();
  try {
    switch (m) {
      case 'OPTIONS': return davOptions();
      case 'PROPFIND': return await propfind(env, request, rel);
      case 'GET': case 'HEAD': return await getFile(env, rel, m === 'HEAD');
      case 'PUT': return await putFile(env, request, rel);
      case 'DELETE': return await del(env, rel);
      case 'MKCOL': return await mkcol(env, rel);
      case 'MOVE': return await moveOrCopy(env, request, rel, true);
      case 'COPY': return await moveOrCopy(env, request, rel, false);
      case 'PROPPATCH': return proppatch(rel);
      case 'LOCK': return lock(rel);
      case 'UNLOCK': return new Response(null, { status: 204 });
      default: return new Response('Method Not Allowed', { status: 405, headers: { Allow: ALLOW } });
    }
  } catch (e) {
    return new Response('Server error: ' + (e && e.message ? e.message : e), { status: 500 });
  }
}

// 「人用浏览器打开这个地址」判定：只认导航请求。WebDAV 客户端（Windows 资源管理器、
// iPhone 文件 App、curl、脚本）不带 Sec-Fetch-Mode，Accept 也不是 text/html，
// 站内 xipan.js 的 fetch 是 same-origin 模式，都不会落进来。
function isBrowserNav(request) {
  const m = request.method.toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return false;
  const mode = request.headers.get('Sec-Fetch-Mode');
  if (mode) return mode === 'navigate';
  return (request.headers.get('Accept') || '').includes('text/html');
}

async function currentRole(request, env) {
  try { return await getRole(request, env); } catch { return null; }
}

function adminOnlyPage() {
  const body = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Xi Pan</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#f3f4f6;color:#1c1b1f;font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
@media (prefers-color-scheme:dark){body{background:#0f1115;color:#e6e1e5}}
.b{max-width:340px;padding:28px 26px;text-align:center;line-height:1.75;font-size:14px}
a{color:#6750A4}</style></head><body><div class="b">
<h3 style="margin:0 0 10px">Xi Pan 是私人云盘</h3>
<p>当前登录的身份没有权限。这个盘只有<b>管理员密码</b>进得来。</p>
<p><a href="/login">换个密码登录</a> · <a href="/">回首页</a></p>
</div></body></html>`;
  return new Response(body, { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function authed(request, env) {
  // API 密钥（供 agent/脚本直接调用）：X-API-Key 或 Authorization: Bearer
  const apiKey = request.headers.get('X-API-Key') ||
    (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (apiKey && env.XIPAN_API_KEY && apiKey === env.XIPAN_API_KEY) return true;
  // 站点管理员 Cookie
  try { if ((await getRole(request, env)) === 'admin') return true; } catch {}
  // HTTP Basic
  const h = request.headers.get('Authorization') || '';
  if (h.startsWith('Basic ')) {
    let dec = '';
    try { dec = atob(h.slice(6)); } catch { return false; }
    const pass = dec.slice(dec.indexOf(':') + 1);
    const admins = String(env.ADMIN_PASSWORD || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (pass && admins.includes(pass)) return true;
  }
  return false;
}

function davOptions() {
  return new Response(null, { status: 200, headers: { DAV, Allow: ALLOW, 'MS-Author-Via': 'DAV', 'Content-Length': '0' } });
}

const keyOf = (rel) => ROOT + rel;                 // 文件 key
const dirKey = (rel) => ROOT + (rel ? rel + '/' : '');  // 目录标记 key（以 / 结尾）
const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const hrefOf = (rel, isDir) => '/dav/' + rel.split('/').map(encodeURIComponent).join('/') + (isDir && rel ? '/' : '');

// 列出某目录下的直接子项（files + 子目录），并判断该路径是不是目录
async function listDir(env, rel) {
  const prefix = dirKey(rel);                       // 'xipan/' 或 'xipan/foo/'
  const out = await env.FILES.list({ prefix, delimiter: '/', include: ['httpMetadata'] });
  const files = (out.objects || []).filter((o) => o.key !== prefix && !o.key.endsWith('/'));
  const dirs = (out.delimitedPrefixes || []).map((p) => p.slice(ROOT.length).replace(/\/$/, '')); // 相对路径
  return { files, dirs };
}

async function isCollection(env, rel) {
  if (rel === '') return true;
  const marker = await env.FILES.head(dirKey(rel));
  if (marker) return true;
  const probe = await env.FILES.list({ prefix: dirKey(rel), delimiter: '/' });
  return (probe.objects && probe.objects.length > 0) || (probe.delimitedPrefixes && probe.delimitedPrefixes.length > 0);
}

function propEntry(rel, isDir, size, mtime, etag, ctype) {
  const lastmod = new Date(mtime || Date.now()).toUTCString();
  const name = rel === '' ? '' : rel.split('/').pop();
  const resType = isDir ? '<D:collection/>' : '';
  const fileProps = isDir ? '' :
    `<D:getcontentlength>${size || 0}</D:getcontentlength>` +
    `<D:getcontenttype>${xmlEsc(ctype || 'application/octet-stream')}</D:getcontenttype>` +
    (etag ? `<D:getetag>${xmlEsc(etag)}</D:getetag>` : '');
  return `<D:response><D:href>${xmlEsc(hrefOf(rel, isDir))}</D:href><D:propstat><D:prop>` +
    `<D:displayname>${xmlEsc(name)}</D:displayname>` +
    `<D:resourcetype>${resType}</D:resourcetype>` +
    `<D:getlastmodified>${lastmod}</D:getlastmodified>` +
    fileProps +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

async function propfind(env, request, rel) {
  const depthHdr = (request.headers.get('Depth') || '1').trim();
  const depth = depthHdr === '0' ? 0 : 1;          // infinity 也按 1 处理（避免全量递归）

  // 目标是文件还是目录？
  const fileHead = rel ? await env.FILES.head(keyOf(rel)) : null;
  const asFile = fileHead && !fileHead.key.endsWith('/');
  const collection = !asFile && (await isCollection(env, rel));
  if (!asFile && !collection) return new Response('Not Found', { status: 404 });

  let body = '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">';
  if (asFile) {
    body += propEntry(rel, false, fileHead.size, fileHead.uploaded?.getTime(), fileHead.httpEtag, fileHead.httpMetadata?.contentType);
  } else {
    body += propEntry(rel, true);                  // 目录自身
    if (depth === 1) {
      const { files, dirs } = await listDir(env, rel);
      for (const d of dirs) { if (d && d !== rel) body += propEntry(d, true); }
      for (const f of files) {
        const childRel = f.key.slice(ROOT.length);
        if (!childRel || childRel === rel || childRel.endsWith('/')) continue;  // 跳过目录标记/自身
        body += propEntry(childRel, false, f.size, f.uploaded?.getTime(), f.httpEtag, f.httpMetadata?.contentType);
      }
    }
  }
  body += '</D:multistatus>';
  return new Response(body, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8', DAV } });
}

async function getFile(env, rel, headOnly) {
  if (!rel) return new Response('Is a collection', { status: 405 });
  const obj = await env.FILES.get(keyOf(rel));
  if (!obj || obj.key?.endsWith('/')) return new Response('Not Found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Length', String(obj.size));
  headers.set('Accept-Ranges', 'bytes');
  if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
  if (obj.uploaded) headers.set('Last-Modified', obj.uploaded.toUTCString());
  if (!headers.get('Content-Type')) headers.set('Content-Type', 'application/octet-stream');
  return new Response(headOnly ? null : obj.body, { status: 200, headers });
}

async function xipanUsage(env) {
  let total = 0, cursor;
  do {
    const out = await env.FILES.list({ prefix: ROOT, cursor, limit: 1000 });
    for (const o of (out.objects || [])) total += o.size || 0;   // 目录标记是 0 字节
    cursor = out.truncated ? out.cursor : undefined;
  } while (cursor);
  return total;
}

async function putFile(env, request, rel) {
  if (!rel) return new Response('Bad target', { status: 400 });
  // 目标父目录如果是个文件则拒绝；同名目录存在也拒绝
  if (await env.FILES.head(dirKey(rel))) return new Response('Conflict: is a directory', { status: 409 });
  const existed = await env.FILES.head(keyOf(rel));
  // R2.put 需要已知长度：带 Content-Length 时直接流式直传（高效）；分块编码（无长度）时先缓冲。
  const clen = request.headers.get('Content-Length');
  const hasLen = clen != null;
  const body = hasLen ? request.body : await request.arrayBuffer();
  const newSize = hasLen ? (parseInt(clen, 10) || 0) : body.byteLength;
  // 2GB 配额（覆盖同名文件时按差额计）
  const usage = await xipanUsage(env);
  if (usage - (existed?.size || 0) + newSize > XIPAN_QUOTA) {
    return new Response('Insufficient Storage: Xi Pan 已满（上限 2 GB）', { status: 507 });
  }
  await env.FILES.put(keyOf(rel), body, {
    httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' },
  });
  return new Response(null, { status: existed ? 204 : 201 });
}

async function del(env, rel) {
  if (!rel) return new Response('Cannot delete root', { status: 403 });
  const fileHead = await env.FILES.head(keyOf(rel));
  if (fileHead && !fileHead.key.endsWith('/')) {
    await env.FILES.delete(keyOf(rel));
    return new Response(null, { status: 204 });
  }
  // 目录：删掉前缀下所有对象 + 标记
  await deletePrefix(env, dirKey(rel));
  return new Response(null, { status: 204 });
}

async function deletePrefix(env, prefix) {
  let cursor;
  do {
    const out = await env.FILES.list({ prefix, cursor, limit: 1000 });
    const keys = (out.objects || []).map((o) => o.key);
    if (keys.length) await env.FILES.delete(keys);
    cursor = out.truncated ? out.cursor : undefined;
  } while (cursor);
}

async function mkcol(env, rel) {
  if (!rel) return new Response('Exists', { status: 405 });
  if (await env.FILES.head(keyOf(rel))) return new Response('Conflict: file exists', { status: 409 });
  if (await env.FILES.head(dirKey(rel))) return new Response('Exists', { status: 405 });
  await env.FILES.put(dirKey(rel), new Uint8Array(0));   // 零字节目录标记
  return new Response(null, { status: 201 });
}

function destRel(request) {
  const d = request.headers.get('Destination');
  if (!d) return null;
  let p;
  try { p = new URL(d, request.url).pathname; } catch { return null; }
  let rel = decodeURIComponent(p.replace(/^\/dav\/?/, '')).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  if (rel.split('/').some((s) => s === '..' || s === '.')) return null;
  return rel;
}

async function moveOrCopy(env, request, rel, isMove) {
  const dst = destRel(request);
  if (dst === null) return new Response('Bad Destination', { status: 400 });
  if (!rel || dst === rel) return new Response('Bad request', { status: 400 });
  if (dst.startsWith(rel + '/')) return new Response('Cannot move into itself', { status: 409 });

  const fileHead = await env.FILES.head(keyOf(rel));
  if (fileHead && !fileHead.key.endsWith('/')) {
    const obj = await env.FILES.get(keyOf(rel));
    await env.FILES.put(keyOf(dst), obj.body, { httpMetadata: obj.httpMetadata });
    if (isMove) await env.FILES.delete(keyOf(rel));
    return new Response(null, { status: 201 });
  }
  // 目录：递归搬运前缀
  const srcPrefix = dirKey(rel), dstPrefix = dirKey(dst);
  let cursor, any = false;
  do {
    const out = await env.FILES.list({ prefix: srcPrefix, cursor, limit: 1000 });
    for (const o of (out.objects || [])) {
      any = true;
      const tail = o.key.slice(srcPrefix.length);
      const obj = await env.FILES.get(o.key);
      await env.FILES.put(dstPrefix + tail, obj.body, { httpMetadata: obj.httpMetadata });
    }
    cursor = out.truncated ? out.cursor : undefined;
  } while (cursor);
  if (!any) return new Response('Not Found', { status: 404 });
  if (isMove) await deletePrefix(env, srcPrefix);
  return new Response(null, { status: 201 });
}

function proppatch(rel) {
  // 不真正存自定义属性，但回 207 成功，避免 Windows/Finder 设置时间戳时报错
  const body = '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">' +
    `<D:response><D:href>${xmlEsc(hrefOf(rel, false))}</D:href>` +
    '<D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>';
  return new Response(body, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}

function lock(rel) {
  // 伪锁：返回一个 lock token，满足 Windows 写入前的 LOCK 流程（不做真正并发控制）
  const token = 'opaquelocktoken:' + crypto.randomUUID();
  const body = '<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>' +
    '<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>' +
    `<D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout>` +
    `<D:locktoken><D:href>${token}</D:href></D:locktoken>` +
    `<D:lockroot><D:href>${xmlEsc(hrefOf(rel, false))}</D:href></D:lockroot>` +
    '</D:activelock></D:lockdiscovery></D:prop>';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': '<' + token + '>' } });
}
