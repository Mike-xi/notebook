import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:8791';
const sessions = { admin: '', alice: '', bob: '' };

async function call(as, path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (sessions[as]) headers.set('Cookie', sessions[as]);
  let body = options.body;
  if (body && !(body instanceof ArrayBuffer)) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }
  const response = await fetch(base + path, { ...options, headers, body });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) sessions[as] = setCookie.split(';')[0];
  const data = (response.headers.get('content-type') || '').includes('application/json')
    ? await response.json()
    : await response.arrayBuffer();
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${data?.message || ''}`);
  return { data, response };
}

const suffix = Date.now().toString(36).slice(-5);
const adminName = `admin_${suffix}`;
const aliceName = `alice_${suffix}`;
const bobName = `bob_${suffix}`;
const password = 'Local-Smoke-Password-2026!';

const bootstrapStatus = await call('admin', '/api/bootstrap/status');
assert.equal(bootstrapStatus.data.ready, false, 'fresh local database should not be initialized');

const bootstrap = await call('admin', '/api/bootstrap', {
  method: 'POST',
  headers: { 'X-Bootstrap-Secret': 'local-test-bootstrap' },
  body: { username: adminName, displayName: '本地管理员', password },
});
assert.equal(bootstrap.data.user.role, 'admin');

async function makeInvite(label) {
  const result = await call('admin', '/api/admin/invitations', {
    method: 'POST',
    body: { label, maxUses: 1, days: 1 },
  });
  return result.data.code;
}

const aliceInvite = await makeInvite('Alice smoke test');
const bobInvite = await makeInvite('Bob smoke test');

const alice = await call('alice', '/api/register', {
  method: 'POST',
  body: { username: aliceName, displayName: 'Alice', password, invite: aliceInvite },
});
const bob = await call('bob', '/api/register', {
  method: 'POST',
  body: { username: bobName, displayName: 'Bob', password, invite: bobInvite },
});
assert.equal(alice.data.user.username, aliceName);
assert.equal(bob.data.user.username, bobName);

const avatarBytes = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n0kAAAAASUVORK5CYII=',
  'base64',
)).buffer;
const avatarUpload = await call('alice', '/api/profile/avatar', {
  method: 'POST',
  headers: { 'Content-Type': 'image/png' },
  body: avatarBytes,
});
assert.match(avatarUpload.data.user.avatarUrl, /^\/avatars\//);
const avatarDownload = await call('alice', avatarUpload.data.user.avatarUrl);
assert.equal(avatarDownload.data.byteLength, avatarBytes.byteLength);

await call('alice', '/api/friends/request', { method: 'POST', body: { username: bobName } });
const bobFriends = await call('bob', '/api/friends');
assert.equal(bobFriends.data.incoming.length, 1);
await call('bob', '/api/friends/accept', {
  method: 'POST',
  body: { requestId: bobFriends.data.incoming[0].requestId },
});

const aliceFriends = await call('alice', '/api/friends');
assert.equal(aliceFriends.data.friends.length, 1);
const bobId = aliceFriends.data.friends[0].id;

const dm = await call('alice', '/api/conversations/dm', { method: 'POST', body: { userId: bobId } });
assert.ok(dm.data.id);
const group = await call('alice', '/api/conversations/group', {
  method: 'POST',
  body: { title: 'Smoke Group', memberIds: [bobId] },
});
assert.ok(group.data.id);

const attachmentBody = new TextEncoder().encode('starpost smoke attachment').buffer;
const upload = await call('alice', `/api/conversations/${dm.data.id}/uploads`, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain', 'X-File-Name': encodeURIComponent('smoke.txt') },
  body: attachmentBody,
});
assert.equal(upload.data.attachment.name, 'smoke.txt');
const downloaded = await call('bob', upload.data.attachment.url);
assert.equal(new TextDecoder().decode(downloaded.data), 'starpost smoke attachment');

const adminStats = await call('admin', '/api/admin/stats');
assert.equal(adminStats.data.users, 3);
assert.equal(adminStats.data.groups, 1);
assert.equal(adminStats.data.attachments, 1);

const adminConversations = await call('admin', '/api/admin/conversations');
assert.equal(adminConversations.data.conversations.length, 2);

console.log(JSON.stringify({
  ok: true,
  users: adminStats.data.users,
  friends: aliceFriends.data.friends.length,
  conversations: adminConversations.data.conversations.length,
  avatarBytes: avatarDownload.data.byteLength,
  attachmentBytes: adminStats.data.attachmentBytes,
}));
