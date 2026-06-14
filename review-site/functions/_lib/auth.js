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

export async function createSessionToken(env, role = 'guest') {
  const expiry = Date.now() + SESSION_DURATION_MS;
  const r = role === 'admin' ? 'admin' : 'guest';
  const payload = `${expiry}|${r}`;            // 把角色编进已签名的 payload
  const sig = await hmacSign(env.AUTH_SECRET, payload);
  return `${payload}.${sig}`;
}

// 校验通过返回角色字符串（'admin' | 'guest'），失败返回 false。
// 旧版（payload 只有 expiry、无角色）token 一律按最低权限 'guest' 处理。
export async function verifySessionToken(token, env) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expectedSig = await hmacSign(env.AUTH_SECRET, payload);
  if (sig !== expectedSig) return false;
  const [expStr, roleStr] = payload.split('|');
  const expiry = parseInt(expStr, 10);
  if (isNaN(expiry) || expiry < Date.now()) return false;
  return roleStr === 'admin' ? 'admin' : 'guest';
}

// 取当前请求的角色（'admin' | 'guest'）；未登录/无效返回 null
export async function getRole(request, env) {
  const role = await verifySessionToken(getCookie(request, COOKIE_NAME), env);
  return role || null;
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
