import assert from 'node:assert/strict';
import WebSocket from 'ws';

const [base, adminName, adminPassword] = process.argv.slice(2);
if (!base || !adminName || !adminPassword) {
  throw new Error('Usage: node test/production-smoke.mjs <base> <admin> <password>');
}

const sessions = {};
async function call(as, path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (sessions[as]) headers.set('Cookie', sessions[as]);
  const body = options.body ? JSON.stringify(options.body) : undefined;
  if (body) headers.set('Content-Type', 'application/json');
  const response = await fetch(base + path, { ...options, headers, body });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) sessions[as] = setCookie.split(';')[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${data.message || ''}`);
  return data;
}

function connect(cookie, conversationId) {
  const url = new URL(`/ws/${conversationId}`, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url, { headers: { Cookie: cookie } });
  const queue = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const value = JSON.parse(raw.toString());
    const index = waiters.findIndex(({ predicate }) => predicate(value));
    if (index >= 0) {
      const [{ resolve, timer }] = waiters.splice(index, 1);
      clearTimeout(timer);
      resolve(value);
    } else queue.push(value);
  });
  return {
    socket,
    waitFor(predicate, timeout = 8000) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for production WebSocket event')), timeout);
        waiters.push({ predicate, resolve, timer });
      });
    },
  };
}

await call('admin', '/api/login', {
  method: 'POST',
  body: { username: adminName, password: adminPassword },
});

const suffix = Date.now().toString(36).slice(-6);
const aliceName = `prodsmoke_a_${suffix}`;
const bobName = `prodsmoke_b_${suffix}`;
const userPassword = `Smoke-${suffix}-Password!`;

async function invite(label) {
  const data = await call('admin', '/api/admin/invitations', {
    method: 'POST',
    body: { label, maxUses: 1, days: 1 },
  });
  return data.code;
}

const [aliceInvite, bobInvite] = await Promise.all([
  invite(`production-smoke-${suffix}-alice`),
  invite(`production-smoke-${suffix}-bob`),
]);
const alice = await call('alice', '/api/register', {
  method: 'POST',
  body: { username: aliceName, displayName: '生产测试 A', password: userPassword, invite: aliceInvite },
});
const bob = await call('bob', '/api/register', {
  method: 'POST',
  body: { username: bobName, displayName: '生产测试 B', password: userPassword, invite: bobInvite },
});

await call('alice', '/api/friends/request', { method: 'POST', body: { username: bobName } });
const bobFriends = await call('bob', '/api/friends');
await call('bob', '/api/friends/accept', {
  method: 'POST',
  body: { requestId: bobFriends.incoming[0].requestId },
});
const dm = await call('alice', '/api/conversations/dm', {
  method: 'POST',
  body: { userId: bob.user.id },
});

const aliceSocket = connect(sessions.alice, dm.id);
const bobSocket = connect(sessions.bob, dm.id);
await Promise.all([
  aliceSocket.waitFor((event) => event.type === 'ready'),
  bobSocket.waitFor((event) => event.type === 'ready'),
]);
const messageBody = `production websocket ${suffix}`;
aliceSocket.socket.send(JSON.stringify({
  type: 'message',
  conversationId: dm.id,
  kind: 'text',
  body: messageBody,
}));
const [sent, received] = await Promise.all([
  aliceSocket.waitFor((event) => event.type === 'message' && event.message?.body === messageBody),
  bobSocket.waitFor((event) => event.type === 'message' && event.message?.body === messageBody),
]);
assert.equal(sent.message.id, received.message.id);

const reviewed = await call('admin', `/api/admin/conversations/${dm.id}/messages`);
assert.ok(reviewed.messages.some((message) => message.id === sent.message.id));
aliceSocket.socket.close();
bobSocket.socket.close();

console.log(JSON.stringify({
  ok: true,
  users: [aliceName, bobName],
  userIds: [alice.user.id, bob.user.id],
  conversationId: dm.id,
  messageId: sent.message.id,
  realtimeDeliveredTo: 2,
  adminReviewed: true,
}));
