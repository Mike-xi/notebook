import assert from 'node:assert/strict';
import { onRequest } from '../../review-site/functions/starpost-app/[[path]].js';

const nativeFetch = globalThis.fetch;
let forwardedURL;
let forwardedInit;

globalThis.fetch = async (url, init) => {
  forwardedURL = String(url);
  forwardedInit = init;
  return new Response(null, {
    status: 302,
    headers: {
      Location: 'https://notebook-chat.xiaxi0694.workers.dev/admin?from=login',
      'Set-Cookie': 'chat_session=secret; Path=/; Secure; HttpOnly; SameSite=None; Partitioned',
    },
  });
};

try {
  const response = await onRequest({
    request: new Request('https://sjtu.ccwu.cc/starpost-app/api/session?probe=1', {
      headers: { Cookie: 'chat_session=secret' },
    }),
  });

  assert.equal(forwardedURL, 'https://notebook-chat.xiaxi0694.workers.dev/api/session?probe=1');
  assert.equal(forwardedInit.method, 'GET');
  assert.equal(forwardedInit.headers.get('X-Forwarded-Host'), 'sjtu.ccwu.cc');
  assert.equal(response.headers.get('Location'), '/starpost-app/admin?from=login');
  assert.equal(
    response.headers.get('Set-Cookie'),
    'chat_session=secret; Path=/starpost-app; Secure; HttpOnly; SameSite=Lax',
  );
  assert.equal(response.headers.get('X-Starpost-Proxy'), 'pages');
} finally {
  globalThis.fetch = nativeFetch;
}

console.log(JSON.stringify({ ok: true, forwardedURL }));
