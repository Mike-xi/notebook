// HMAC-signed cookie auth. No external deps, uses Web Crypto API.

const COOKIE_NAME = 'review_auth';
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// owner：按登录时输入的具体密码算出的稳定标识（哈希，不可逆），用于笔记等
// 需要「同角色的不同密码也要各自一份数据」的场景。与 role（admin/guest，控制权限）正交。
export async function hashOwnerId(password) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(password || '')));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export async function createSessionToken(env, role = 'guest', owner = '') {
  const expiry = Date.now() + SESSION_DURATION_MS;
  const r = role === 'admin' ? 'admin' : 'guest';
  const payload = `${expiry}|${r}|${owner}`;   // 把角色 + owner 哈希编进已签名的 payload
  const sig = await hmacSign(env.AUTH_SECRET, payload);
  return `${payload}.${sig}`;
}

// 校验通过返回角色字符串（'admin' | 'guest'），失败返回 false。
// 旧版（payload 只有 expiry、无角色）token 一律按最低权限 'guest' 处理。
export async function verifySessionToken(token, env) {
  const full = await verifySessionFull(token, env);
  return full ? full.role : false;
}

// 同上但同时返回 owner（旧 token 没有 owner 段时，按 role 兜底，避免报错——用户重新登录一次即可补全）。
export async function verifySessionFull(token, env) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedSig = await hmacSign(env.AUTH_SECRET, payload);
  if (sig !== expectedSig) return null;
  const segs = payload.split('|');
  const expiry = parseInt(segs[0], 10);
  if (isNaN(expiry) || expiry < Date.now()) return null;
  const role = segs[1] === 'admin' ? 'admin' : 'guest';
  const owner = segs[2] || role;
  return { role, owner };
}

// 取当前请求的角色（'admin' | 'guest'）；未登录/无效返回 null
export async function getRole(request, env) {
  const role = await verifySessionToken(getCookie(request, COOKIE_NAME), env);
  return role || null;
}

// 取当前请求的 owner 标识（按登录密码区分，用于笔记等三密码三份数据的场景）；未登录/无效返回 null
export async function getOwner(request, env) {
  const full = await verifySessionFull(getCookie(request, COOKIE_NAME), env);
  return full ? full.owner : null;
}

export function getCookie(request, name) {
  const cookies = request.headers.get('Cookie') || '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function isAuthenticated(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  return await verifySessionToken(token, env);
}

export function makeAuthCookie(token) {
  const maxAge = Math.floor(SESSION_DURATION_MS / 1000);
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearAuthCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export { COOKIE_NAME };
