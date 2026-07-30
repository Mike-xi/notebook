const PREFIX = '/starpost-app';
const UPSTREAM_ORIGIN = 'https://notebook-chat.xiaxi0694.workers.dev';

function upstreamURL(requestURL) {
  const incoming = new URL(requestURL);
  let pathname = incoming.pathname.slice(PREFIX.length);
  if (!pathname) pathname = '/';
  return new URL(`${pathname}${incoming.search}`, UPSTREAM_ORIGIN);
}

function rewriteLocation(value) {
  if (!value) return value;
  const location = new URL(value, UPSTREAM_ORIGIN);
  if (location.origin !== UPSTREAM_ORIGIN) return value;
  return `${PREFIX}${location.pathname}${location.search}${location.hash}`;
}

function rewriteSessionCookie(value) {
  if (!value) return value;
  return value
    .replace(/Path=\/(?:;|$)/i, `Path=${PREFIX};`)
    .replace(/;\s*Partitioned/ig, '')
    .replace(/SameSite=None/ig, 'SameSite=Lax');
}

export async function onRequest({ request }) {
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.set('X-Forwarded-Host', new URL(request.url).host);

  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  const response = await fetch(upstreamURL(request.url), init);

  // A WebSocket response carries a live webSocket handle and must be returned
  // intact rather than wrapped in a new Response.
  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
    return response;
  }

  const responseHeaders = new Headers(response.headers);
  const location = responseHeaders.get('Location');
  const cookie = responseHeaders.get('Set-Cookie');
  if (location) responseHeaders.set('Location', rewriteLocation(location));
  if (cookie) responseHeaders.set('Set-Cookie', rewriteSessionCookie(cookie));
  responseHeaders.set('X-Starpost-Proxy', 'pages');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
