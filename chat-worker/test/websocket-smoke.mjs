import assert from 'node:assert/strict';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:8791';
const aliceName = process.argv[3];
const bobName = process.argv[4];
const password = process.argv[5] || 'Local-Smoke-Password-2026!';

if (!aliceName || !bobName) {
  throw new Error('Usage: node test/websocket-smoke.mjs <base> <alice> <bob> [password]');
}

async function login(username) {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200, `login failed for ${username}`);
  return response.headers.get('set-cookie').split(';')[0];
}

async function api(cookie, path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Cookie', cookie);
  let body = options.body;
  if (body) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }
  const response = await fetch(base + path, { ...options, headers, body });
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
    } else {
      queue.push(value);
    }
  });

  function waitFor(predicate, timeout = 5000) {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = waiters.findIndex((item) => item.resolve === resolve);
        if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
        reject(new Error('Timed out waiting for WebSocket event'));
      }, timeout);
      waiters.push({ predicate, resolve, timer });
    });
  }

  return { socket, waitFor };
}

const [aliceCookie, bobCookie] = await Promise.all([login(aliceName), login(bobName)]);
const data = await api(aliceCookie, '/api/conversations');
const conversation = data.conversations.find((item) => item.kind === 'dm');
assert.ok(conversation, 'DM conversation should exist');

const alice = connect(aliceCookie, conversation.id);
const bob = connect(bobCookie, conversation.id);
await Promise.all([
  alice.waitFor((event) => event.type === 'ready'),
  bob.waitFor((event) => event.type === 'ready'),
]);
const [alicePresence, bobPresence] = await Promise.all([
  alice.waitFor((event) => event.type === 'presence' && event.onlineUsers?.length === 2),
  bob.waitFor((event) => event.type === 'presence' && event.onlineUsers?.length === 2),
]);
assert.deepEqual(
  new Set(alicePresence.onlineUsers.map((user) => user.displayName)),
  new Set(['Alice', 'Bob']),
);
assert.equal(bobPresence.membersOnline, 2);

const body = `实时消息 ${Date.now()}`;
alice.socket.send(JSON.stringify({ type: 'message', conversationId: conversation.id, kind: 'text', body }));
const [aliceEvent, bobEvent] = await Promise.all([
  alice.waitFor((event) => event.type === 'message' && event.message?.body === body),
  bob.waitFor((event) => event.type === 'message' && event.message?.body === body),
]);
assert.equal(aliceEvent.message.id, bobEvent.message.id);
assert.match(aliceEvent.message.sender.avatarUrl, /^\/avatars\//);

const editedBody = `${body}（已编辑）`;
await api(aliceCookie, `/api/messages/${aliceEvent.message.id}`, {
  method: 'PATCH',
  body: { body: editedBody },
});
await Promise.all([
  alice.waitFor((event) => event.type === 'message-updated' && event.id === aliceEvent.message.id),
  bob.waitFor((event) => event.type === 'message-updated' && event.id === aliceEvent.message.id),
]);

await api(aliceCookie, `/api/messages/${aliceEvent.message.id}`, { method: 'DELETE' });
await Promise.all([
  alice.waitFor((event) => event.type === 'message-deleted' && event.id === aliceEvent.message.id),
  bob.waitFor((event) => event.type === 'message-deleted' && event.id === aliceEvent.message.id),
]);

const history = await api(bobCookie, `/api/conversations/${conversation.id}/messages`);
const persisted = history.messages.find((item) => item.id === aliceEvent.message.id);
assert.ok(persisted?.deletedAt, 'revoked message should remain as an audited tombstone');

bob.socket.close();
const aliceAfterBobLeaves = await alice.waitFor(
  (event) => event.type === 'presence' && event.onlineUsers?.length === 1,
);
assert.equal(aliceAfterBobLeaves.onlineUsers[0].displayName, 'Alice');
alice.socket.close();
console.log(JSON.stringify({
  ok: true,
  conversationId: conversation.id,
  realtimeDeliveredTo: 2,
  presenceUsers: alicePresence.onlineUsers.length,
  presenceAfterLeave: aliceAfterBobLeaves.onlineUsers.length,
  edited: true,
  revoked: true,
  persisted: true,
}));
