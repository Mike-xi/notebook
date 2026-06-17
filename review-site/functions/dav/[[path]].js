// WebDAV 服务（私人云盘「Xi Pan」的多端接入）。
//   存储：R2 桶 FILES，前缀 xipan/，对象 key = 完整路径（与路径解耦的公共云盘不同，这里 key 即路径，
//   保证 WebDAV 与站内浏览器视图同一份真相）。空目录用「以 / 结尾的零字节对象」当占位标记。
//   鉴权：HTTP Basic（用户名任意，密码 = ADMIN_PASSWORD 之一）给 Windows/iPhone 等外部客户端；
//        或站点管理员 Cookie，给站内浏览器视图用 fetch 调本接口。
//   挂载地址（带末尾斜杠）：https://<域名>/dav/
//   _middleware.js 已放行 /dav，由本函数自行鉴权。
import { getRole } from '../_lib/auth.js';

const ROOT = 'xipan/';
const DAV = 'DAV: 1, 2';
const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK';

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.FILES) return new Response('R2 not configured', { status: 500 });

  // ---- 鉴权：Basic 或 管理员 Cookie ----
  if (!(await authed(request, env))) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Xi Pan", charset="UTF-8"' },
    });
  }

  const url = new URL(request.url);
  // /dav/<path...> -> path（去掉前缀，规范化，挡 ..）
  let rel = decodeURIComponent(url.pathname.replace(/^\/dav\/?/, ''));
  rel = rel.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  if (rel.split('/').some((s) => s === '..' || s === '.')) return new Response('Bad path', { status: 400 });
  const isDirReq = url.pathname.endsWith('/') || rel === '';

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

async function authed(request, env) {
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

async function putFile(env, request, rel) {
  if (!rel) return new Response('Bad target', { status: 400 });
  // 目标父目录如果是个文件则拒绝；同名目录存在也拒绝
  if (await env.FILES.head(dirKey(rel))) return new Response('Conflict: is a directory', { status: 409 });
  const existed = await env.FILES.head(keyOf(rel));
  // R2.put 需要已知长度：带 Content-Length 时直接流式直传（高效）；分块编码（无长度）时先缓冲。
  const hasLen = request.headers.get('Content-Length') != null;
  const body = hasLen ? request.body : await request.arrayBuffer();
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
