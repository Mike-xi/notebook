import { DurableObject } from 'cloudflare:workers';

const enc = new TextEncoder();
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_MESSAGE = 4000;
const MAX_UPLOAD = 8 * 1024 * 1024;
const PASSWORD_ITERATIONS = 100000;
const BUILD_VERSION = '2026.07.30-3';
const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

function base64url(bytes) {
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function sha256(value) {
  return base64url(await crypto.subtle.digest('SHA-256', enc.encode(value)));
}

async function passwordHash(password, salt = randomToken(16)) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: fromBase64url(salt),
    iterations: PASSWORD_ITERATIONS,
  }, key, 256);
  return { salt, hash: base64url(bits) };
}

function constantTimeEqual(a, b) {
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  let diff = aa.length ^ bb.length;
  const length = Math.max(aa.length, bb.length);
  for (let i = 0; i < length; i += 1) diff |= (aa[i % aa.length] || 0) ^ (bb[i % bb.length] || 0);
  return diff === 0;
}

function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

function failure(message, status = 400, code = 'bad_request') {
  return response({ error: code, message }, status);
}

async function readJSON(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new Error('请提交 JSON 数据');
  return request.json();
}

function cleanText(value, max = 100) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function normalizeUsername(value) {
  return cleanText(value, 24).toLowerCase();
}

function parseCookies(request) {
  const result = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function sessionCookie(token, env, maxAge = SESSION_SECONDS) {
  const domain = cleanText(env.COOKIE_DOMAIN, 120);
  const secure = env.COOKIE_SECURE !== 'false';
  return [
    `chat_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    secure ? 'Secure' : '',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    secure ? 'Partitioned' : '',
    `Max-Age=${maxAge}`,
    domain ? `Domain=${domain}` : '',
  ].filter(Boolean).join('; ');
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio || '',
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

async function currentUser(request, env) {
  const token = parseCookies(request).chat_session;
  if (!token) return null;
  const tokenHash = await sha256(token);
  const now = Date.now();
  const row = await env.DB.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, now).first();
  if (!row || row.status !== 'active') return null;
  return row;
}

async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw Object.assign(new Error('请先登录'), { status: 401, code: 'unauthorized' });
  return user;
}

async function requireAdmin(request, env) {
  const user = await requireUser(request, env);
  if (user.role !== 'admin') throw Object.assign(new Error('需要管理员权限'), { status: 403, code: 'forbidden' });
  return user;
}

async function createSession(env, userId) {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).bind(await sha256(token), userId, now, now + SESSION_SECONDS * 1000).run();
  return token;
}

async function audit(env, actorId, action, targetType, targetId, detail = '') {
  await env.DB.prepare(`
    INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(actorId || null, action, targetType, targetId, detail.slice(0, 1000), Date.now()).run();
}

function orderedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

async function isMember(env, conversationId, userId) {
  return env.DB.prepare(`
    SELECT cm.role, c.kind, c.title FROM conversation_members cm
    JOIN conversations c ON c.id = cm.conversation_id
    WHERE cm.conversation_id = ? AND cm.user_id = ?
  `).bind(conversationId, userId).first();
}

async function getMessageRows(env, conversationId, before = Number.MAX_SAFE_INTEGER, limit = 60) {
  const result = await env.DB.prepare(`
    SELECT m.*, u.username, u.display_name,
           a.file_name, a.mime, a.size
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN attachments a ON a.id = m.attachment_id
    WHERE m.conversation_id = ? AND m.seq < ?
    ORDER BY m.seq DESC LIMIT ?
  `).bind(conversationId, before, Math.min(Math.max(limit, 1), 100)).all();
  return (result.results || []).reverse().map(formatMessage);
}

function formatMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    sender: {
      id: row.sender_id,
      username: row.username,
      displayName: row.display_name,
    },
    kind: row.deleted_at ? 'text' : row.kind,
    body: row.deleted_at ? '' : row.body,
    attachment: row.attachment_id && !row.deleted_at ? {
      id: row.attachment_id,
      name: row.file_name,
      mime: row.mime,
      size: row.size,
      url: `/media/${row.attachment_id}`,
    } : null,
    replyTo: row.reply_to || null,
    createdAt: row.created_at,
    editedAt: row.edited_at || null,
    deletedAt: row.deleted_at || null,
  };
}

async function handleAuth(request, env, pathname) {
  if (pathname === '/api/bootstrap/status' && request.method === 'GET') {
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first();
    return response({ ready: Number(row?.count || 0) > 0 });
  }

  if (pathname === '/api/bootstrap' && request.method === 'POST') {
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first();
    if (Number(count?.count || 0) > 0) return failure('初始化已经完成', 409, 'already_initialized');
    const supplied = request.headers.get('x-bootstrap-secret') || '';
    if (!env.BOOTSTRAP_SECRET || !constantTimeEqual(supplied, env.BOOTSTRAP_SECRET)) {
      return failure('初始化凭据无效', 403, 'forbidden');
    }
    const body = await readJSON(request);
    const username = cleanText(body.username, 24);
    const usernameNorm = normalizeUsername(username);
    const password = String(body.password || '');
    if (!USERNAME_RE.test(username)) return failure('用户名需为 3–24 位字母、数字或下划线');
    if (password.length < 10 || password.length > 128) return failure('密码至少 10 位，最多 128 位');
    const derived = await passwordHash(password);
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(`
      INSERT INTO users
      (id, username, username_norm, display_name, password_salt, password_hash, role, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, ?)
    `).bind(id, username, usernameNorm, cleanText(body.displayName, 32) || username, derived.salt, derived.hash, now, now).run();
    await audit(env, id, 'bootstrap_admin', 'user', id);
    const token = await createSession(env, id);
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    return response({ user: publicUser(user) }, 201, { 'Set-Cookie': sessionCookie(token, env) });
  }

  if (pathname === '/api/register' && request.method === 'POST') {
    const body = await readJSON(request);
    const username = cleanText(body.username, 24);
    const usernameNorm = normalizeUsername(username);
    const password = String(body.password || '');
    const invite = cleanText(body.invite, 80).toUpperCase();
    if (!USERNAME_RE.test(username)) return failure('用户名需为 3–24 位字母、数字或下划线');
    if (password.length < 10 || password.length > 128) return failure('密码至少 10 位，最多 128 位');
    if (!invite) return failure('请输入邀请码');
    const inviteHash = await sha256(invite);
    const invitation = await env.DB.prepare(`
      SELECT * FROM invitations
      WHERE code_hash = ? AND uses < max_uses AND (expires_at IS NULL OR expires_at > ?)
    `).bind(inviteHash, Date.now()).first();
    if (!invitation) return failure('邀请码无效或已经过期', 403, 'invalid_invite');
    const exists = await env.DB.prepare('SELECT 1 FROM users WHERE username_norm = ?').bind(usernameNorm).first();
    if (exists) return failure('该用户名已被使用', 409, 'username_taken');
    const derived = await passwordHash(password);
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO users
        (id, username, username_norm, display_name, password_salt, password_hash, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, username, usernameNorm, cleanText(body.displayName, 32) || username, derived.salt, derived.hash, now, now),
      env.DB.prepare('UPDATE invitations SET uses = uses + 1 WHERE code_hash = ?').bind(inviteHash),
    ]);
    const token = await createSession(env, id);
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    return response({ user: publicUser(user) }, 201, { 'Set-Cookie': sessionCookie(token, env) });
  }

  if (pathname === '/api/login' && request.method === 'POST') {
    const body = await readJSON(request);
    const user = await env.DB.prepare('SELECT * FROM users WHERE username_norm = ?')
      .bind(normalizeUsername(body.username)).first();
    if (!user) return failure('用户名或密码不正确', 401, 'invalid_credentials');
    const derived = await passwordHash(String(body.password || ''), user.password_salt);
    if (!constantTimeEqual(derived.hash, user.password_hash)) {
      return failure('用户名或密码不正确', 401, 'invalid_credentials');
    }
    if (user.status !== 'active') return failure('账号已被停用', 403, 'account_disabled');
    const token = await createSession(env, user.id);
    await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(Date.now(), user.id).run();
    return response({ user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookie(token, env) });
  }

  if (pathname === '/api/logout' && request.method === 'POST') {
    const token = parseCookies(request).chat_session;
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return response({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', env, 0) });
  }

  if (pathname === '/api/session' && request.method === 'GET') {
    const user = await currentUser(request, env);
    return response({ user: publicUser(user) });
  }

  if (pathname === '/api/profile' && request.method === 'PATCH') {
    const user = await requireUser(request, env);
    const body = await readJSON(request);
    const displayName = cleanText(body.displayName, 32);
    const bio = String(body.bio || '').trim().slice(0, 160);
    if (!displayName) return failure('昵称不能为空');
    await env.DB.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?')
      .bind(displayName, bio, user.id).run();
    const updated = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
    return response({ user: publicUser(updated) });
  }

  if (pathname === '/api/password' && request.method === 'PATCH') {
    const user = await requireUser(request, env);
    const body = await readJSON(request);
    const current = await passwordHash(String(body.currentPassword || ''), user.password_salt);
    if (!constantTimeEqual(current.hash, user.password_hash)) return failure('当前密码不正确', 403);
    const next = String(body.newPassword || '');
    if (next.length < 10 || next.length > 128) return failure('新密码至少 10 位，最多 128 位');
    const derived = await passwordHash(next);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?')
        .bind(derived.salt, derived.hash, user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    ]);
    const token = await createSession(env, user.id);
    return response({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, env) });
  }
  return null;
}

async function handleFriends(request, env, pathname, url) {
  const user = await requireUser(request, env);
  if (pathname === '/api/users' && request.method === 'GET') {
    const q = cleanText(url.searchParams.get('q'), 32).toLowerCase();
    if (q.length < 2) return response({ users: [] });
    const rows = await env.DB.prepare(`
      SELECT id, username, display_name, bio, role, status, created_at, last_seen_at
      FROM users
      WHERE id != ? AND status = 'active'
        AND (username_norm LIKE ? OR lower(display_name) LIKE ?)
      ORDER BY CASE WHEN username_norm = ? THEN 0 ELSE 1 END, username_norm
      LIMIT 30
    `).bind(user.id, `%${q}%`, `%${q}%`, q).all();
    return response({ users: (rows.results || []).map(publicUser) });
  }

  if (pathname === '/api/friends' && request.method === 'GET') {
    const [friends, incoming, outgoing, blocked] = await Promise.all([
      env.DB.prepare(`
        SELECT u.* FROM friendships f
        JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
        WHERE f.user_a = ? OR f.user_b = ?
        ORDER BY lower(u.display_name)
      `).bind(user.id, user.id, user.id).all(),
      env.DB.prepare(`
        SELECT fr.id AS request_id, fr.created_at AS request_created_at, u.*
        FROM friend_requests fr JOIN users u ON u.id = fr.sender_id
        WHERE fr.receiver_id = ? ORDER BY fr.created_at DESC
      `).bind(user.id).all(),
      env.DB.prepare(`
        SELECT fr.id AS request_id, fr.created_at AS request_created_at, u.*
        FROM friend_requests fr JOIN users u ON u.id = fr.receiver_id
        WHERE fr.sender_id = ? ORDER BY fr.created_at DESC
      `).bind(user.id).all(),
      env.DB.prepare(`
        SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = ? ORDER BY lower(u.display_name)
      `).bind(user.id).all(),
    ]);
    const withRequest = (row) => ({ ...publicUser(row), requestId: row.request_id, requestedAt: row.request_created_at });
    return response({
      friends: (friends.results || []).map(publicUser),
      incoming: (incoming.results || []).map(withRequest),
      outgoing: (outgoing.results || []).map(withRequest),
      blocked: (blocked.results || []).map(publicUser),
    });
  }

  if (pathname === '/api/friends/request' && request.method === 'POST') {
    const body = await readJSON(request);
    const target = await env.DB.prepare('SELECT * FROM users WHERE username_norm = ? AND status = ?')
      .bind(normalizeUsername(body.username), 'active').first();
    if (!target || target.id === user.id) return failure('找不到该用户', 404, 'user_not_found');
    const blocked = await env.DB.prepare(`
      SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
    `).bind(user.id, target.id, target.id, user.id).first();
    if (blocked) return failure('当前无法向该用户发送好友申请', 403);
    const [a, b] = orderedPair(user.id, target.id);
    if (await env.DB.prepare('SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?').bind(a, b).first()) {
      return failure('你们已经是好友', 409, 'already_friends');
    }
    const reverse = await env.DB.prepare('SELECT id FROM friend_requests WHERE sender_id = ? AND receiver_id = ?')
      .bind(target.id, user.id).first();
    if (reverse) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM friend_requests WHERE id = ?').bind(reverse.id),
        env.DB.prepare('INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)')
          .bind(a, b, Date.now()),
      ]);
      return response({ accepted: true });
    }
    try {
      await env.DB.prepare(`
        INSERT INTO friend_requests (id, sender_id, receiver_id, created_at) VALUES (?, ?, ?, ?)
      `).bind(crypto.randomUUID(), user.id, target.id, Date.now()).run();
    } catch {
      return failure('好友申请已经发送', 409, 'already_requested');
    }
    return response({ ok: true }, 201);
  }

  const action = pathname.match(/^\/api\/friends\/(accept|reject|remove|block|unblock)$/);
  if (action && request.method === 'POST') {
    const body = await readJSON(request);
    if (action[1] === 'accept' || action[1] === 'reject') {
      const item = await env.DB.prepare('SELECT * FROM friend_requests WHERE id = ? AND receiver_id = ?')
        .bind(String(body.requestId || ''), user.id).first();
      if (!item) return failure('好友申请不存在', 404);
      if (action[1] === 'accept') {
        const [a, b] = orderedPair(item.sender_id, item.receiver_id);
        await env.DB.batch([
          env.DB.prepare('DELETE FROM friend_requests WHERE id = ?').bind(item.id),
          env.DB.prepare('INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)')
            .bind(a, b, Date.now()),
        ]);
      } else {
        await env.DB.prepare('DELETE FROM friend_requests WHERE id = ?').bind(item.id).run();
      }
      return response({ ok: true });
    }
    const targetId = String(body.userId || '');
    if (!targetId || targetId === user.id) return failure('用户无效');
    const [a, b] = orderedPair(user.id, targetId);
    if (action[1] === 'remove') {
      await env.DB.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').bind(a, b).run();
    } else if (action[1] === 'block') {
      await env.DB.batch([
        env.DB.prepare('INSERT OR REPLACE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
          .bind(user.id, targetId, Date.now()),
        env.DB.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').bind(a, b),
        env.DB.prepare('DELETE FROM friend_requests WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)')
          .bind(user.id, targetId, targetId, user.id),
      ]);
    } else if (action[1] === 'unblock') {
      await env.DB.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?')
        .bind(user.id, targetId).run();
    }
    return response({ ok: true });
  }
  return null;
}

async function conversationSummary(env, user) {
  const rows = await env.DB.prepare(`
    SELECT c.id, c.kind, c.title, c.owner_id, c.created_at, c.updated_at,
           cm.role AS member_role, cm.last_read_seq,
           (SELECT MAX(seq) FROM messages WHERE conversation_id = c.id) AS max_seq,
           (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY seq DESC LIMIT 1) AS last_body,
           (SELECT kind FROM messages WHERE conversation_id = c.id ORDER BY seq DESC LIMIT 1) AS last_kind,
           (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY seq DESC LIMIT 1) AS last_message_at
    FROM conversation_members cm
    JOIN conversations c ON c.id = cm.conversation_id
    WHERE cm.user_id = ?
    ORDER BY COALESCE(last_message_at, c.updated_at) DESC
  `).bind(user.id).all();
  const result = [];
  for (const row of rows.results || []) {
    let title = row.title;
    let peer = null;
    if (row.kind === 'dm') {
      peer = await env.DB.prepare(`
        SELECT u.* FROM conversation_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = ? AND cm.user_id != ? LIMIT 1
      `).bind(row.id, user.id).first();
      title = peer?.display_name || peer?.username || '私聊';
    }
    result.push({
      id: row.id,
      kind: row.kind,
      title,
      ownerId: row.owner_id,
      role: row.member_role,
      peer: publicUser(peer),
      lastMessage: row.last_body ? { body: row.last_body, kind: row.last_kind, createdAt: row.last_message_at } : null,
      unread: Math.max(0, Number(row.max_seq || 0) - Number(row.last_read_seq || 0)),
      updatedAt: row.updated_at,
    });
  }
  return result;
}

async function handleConversations(request, env, pathname, url) {
  const user = await requireUser(request, env);
  if (pathname === '/api/conversations' && request.method === 'GET') {
    return response({ conversations: await conversationSummary(env, user) });
  }

  if (pathname === '/api/conversations/dm' && request.method === 'POST') {
    const body = await readJSON(request);
    const targetId = String(body.userId || '');
    const [a, b] = orderedPair(user.id, targetId);
    if (!await env.DB.prepare('SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?').bind(a, b).first()) {
      return failure('只能与好友发起私聊', 403, 'not_friends');
    }
    const existing = await env.DB.prepare(`
      SELECT c.id FROM conversations c
      JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
      JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
      WHERE c.kind = 'dm' AND (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id = c.id) = 2
      LIMIT 1
    `).bind(user.id, targetId).first();
    if (existing) return response({ id: existing.id });
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO conversations (id, kind, title, owner_id, created_at, updated_at)
        VALUES (?, 'dm', '', ?, ?, ?)
      `).bind(id, user.id, now, now),
      env.DB.prepare(`
        INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)
      `).bind(id, user.id, now),
      env.DB.prepare(`
        INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)
      `).bind(id, targetId, now),
    ]);
    return response({ id }, 201);
  }

  if (pathname === '/api/conversations/group' && request.method === 'POST') {
    const body = await readJSON(request);
    const title = cleanText(body.title, 50);
    const memberIds = [...new Set((Array.isArray(body.memberIds) ? body.memberIds : []).map(String))]
      .filter((id) => id && id !== user.id).slice(0, 99);
    if (!title) return failure('请输入群组名称');
    if (!memberIds.length) return failure('至少选择一位好友');
    const friends = new Set();
    const friendRows = await env.DB.prepare(`
      SELECT user_a, user_b FROM friendships WHERE user_a = ? OR user_b = ?
    `).bind(user.id, user.id).all();
    for (const row of friendRows.results || []) friends.add(row.user_a === user.id ? row.user_b : row.user_a);
    if (memberIds.some((id) => !friends.has(id))) return failure('群组成员必须是你的好友', 403);
    const id = crypto.randomUUID();
    const now = Date.now();
    const statements = [
      env.DB.prepare(`
        INSERT INTO conversations (id, kind, title, owner_id, created_at, updated_at)
        VALUES (?, 'group', ?, ?, ?, ?)
      `).bind(id, title, user.id, now, now),
      env.DB.prepare(`
        INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)
      `).bind(id, user.id, now),
      ...memberIds.map((memberId) => env.DB.prepare(`
        INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)
      `).bind(id, memberId, now)),
    ];
    await env.DB.batch(statements);
    await audit(env, user.id, 'create_group', 'conversation', id, title);
    return response({ id }, 201);
  }

  const messagesMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (messagesMatch && request.method === 'GET') {
    const conversationId = messagesMatch[1];
    if (!await isMember(env, conversationId, user.id) && user.role !== 'admin') return failure('无权查看此会话', 403);
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    return response({ messages: await getMessageRows(env, conversationId, before, 60) });
  }

  const detailMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (detailMatch && request.method === 'GET') {
    const conversationId = detailMatch[1];
    if (!await isMember(env, conversationId, user.id) && user.role !== 'admin') return failure('无权查看此会话', 403);
    const conversation = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(conversationId).first();
    if (!conversation) return failure('会话不存在', 404);
    const members = await env.DB.prepare(`
      SELECT cm.role AS member_role, cm.joined_at, u.*
      FROM conversation_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id = ? ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, lower(u.display_name)
    `).bind(conversationId).all();
    return response({
      conversation: {
        id: conversation.id,
        kind: conversation.kind,
        title: conversation.title,
        ownerId: conversation.owner_id,
        createdAt: conversation.created_at,
      },
      members: (members.results || []).map((row) => ({ ...publicUser(row), memberRole: row.member_role, joinedAt: row.joined_at })),
    });
  }

  const readMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/read$/);
  if (readMatch && request.method === 'POST') {
    const conversationId = readMatch[1];
    if (!await isMember(env, conversationId, user.id)) return failure('无权访问此会话', 403);
    const body = await readJSON(request);
    const seq = Math.max(0, Number(body.seq) || 0);
    await env.DB.prepare(`
      UPDATE conversation_members SET last_read_seq = MAX(last_read_seq, ?)
      WHERE conversation_id = ? AND user_id = ?
    `).bind(seq, conversationId, user.id).run();
    return response({ ok: true });
  }

  const uploadMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/uploads$/);
  if (uploadMatch && request.method === 'POST') {
    const conversationId = uploadMatch[1];
    if (!await isMember(env, conversationId, user.id)) return failure('无权上传到此会话', 403);
    const length = Number(request.headers.get('content-length')) || 0;
    if (!length || length > MAX_UPLOAD) return failure('附件大小需在 8 MB 以内', 413, 'file_too_large');
    const data = await request.arrayBuffer();
    if (data.byteLength > MAX_UPLOAD) return failure('附件大小需在 8 MB 以内', 413, 'file_too_large');
    const fileName = decodeURIComponent(request.headers.get('x-file-name') || 'attachment').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 120);
    const mime = cleanText(request.headers.get('content-type') || 'application/octet-stream', 120);
    const id = crypto.randomUUID();
    const objectKey = `chat/${conversationId}/${id}`;
    await env.FILES.put(objectKey, data, { httpMetadata: { contentType: mime } });
    await env.DB.prepare(`
      INSERT INTO attachments (id, conversation_id, uploader_id, object_key, file_name, mime, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, conversationId, user.id, objectKey, fileName, mime, data.byteLength, Date.now()).run();
    return response({
      attachment: { id, name: fileName, mime, size: data.byteLength, url: `/media/${id}` },
    }, 201);
  }

  const membersMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/members$/);
  if (membersMatch && request.method === 'POST') {
    const conversationId = membersMatch[1];
    const membership = await isMember(env, conversationId, user.id);
    if (!membership || !['owner', 'admin'].includes(membership.role)) return failure('需要群管理员权限', 403);
    const conversation = await env.DB.prepare('SELECT kind FROM conversations WHERE id = ?').bind(conversationId).first();
    if (conversation?.kind !== 'group') return failure('私聊不能添加成员');
    const body = await readJSON(request);
    const targetId = String(body.userId || '');
    const [a, b] = orderedPair(user.id, targetId);
    if (!await env.DB.prepare('SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?').bind(a, b).first()) {
      return failure('只能邀请好友加入群组', 403);
    }
    await env.DB.prepare(`
      INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at)
      VALUES (?, ?, 'member', ?)
    `).bind(conversationId, targetId, Date.now()).run();
    return response({ ok: true });
  }

  return null;
}

async function handleMessages(request, env, pathname) {
  const user = await requireUser(request, env);
  const match = pathname.match(/^\/api\/messages\/([^/]+)$/);
  if (!match) return null;
  const message = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(match[1]).first();
  if (!message) return failure('消息不存在', 404);
  if (request.method === 'PATCH') {
    if (message.sender_id !== user.id) return failure('只能编辑自己的消息', 403);
    const body = await readJSON(request);
    const text = String(body.body || '').trim().slice(0, MAX_MESSAGE);
    if (!text) return failure('消息不能为空');
    const editedAt = Date.now();
    await env.DB.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?')
      .bind(text, editedAt, message.id).run();
    await env.CHAT_ROOMS.getByName(message.conversation_id).fetch(new Request('https://room.internal/broadcast', {
      method: 'POST',
      body: JSON.stringify({ type: 'message-updated', id: message.id, body: text, editedAt }),
    }));
    return response({ ok: true });
  }
  if (request.method === 'DELETE') {
    if (message.sender_id !== user.id && user.role !== 'admin') return failure('无权撤回此消息', 403);
    const deletedAt = Date.now();
    await env.DB.prepare('UPDATE messages SET body = ?, deleted_at = ? WHERE id = ?')
      .bind('', deletedAt, message.id).run();
    await env.CHAT_ROOMS.getByName(message.conversation_id).fetch(new Request('https://room.internal/broadcast', {
      method: 'POST',
      body: JSON.stringify({ type: 'message-deleted', id: message.id, deletedAt }),
    }));
    return response({ ok: true });
  }
  return null;
}

async function handleAdmin(request, env, pathname, url) {
  const admin = await requireAdmin(request, env);
  if (pathname === '/api/admin/stats' && request.method === 'GET') {
    const [users, groups, messages, attachments] = await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) AS count FROM users'),
      env.DB.prepare("SELECT COUNT(*) AS count FROM conversations WHERE kind = 'group'"),
      env.DB.prepare('SELECT COUNT(*) AS count FROM messages'),
      env.DB.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM attachments'),
    ]);
    return response({
      users: Number(users.results?.[0]?.count || 0),
      groups: Number(groups.results?.[0]?.count || 0),
      messages: Number(messages.results?.[0]?.count || 0),
      attachments: Number(attachments.results?.[0]?.count || 0),
      attachmentBytes: Number(attachments.results?.[0]?.bytes || 0),
    });
  }
  if (pathname === '/api/admin/users' && request.method === 'GET') {
    const q = cleanText(url.searchParams.get('q'), 50).toLowerCase();
    const rows = await env.DB.prepare(`
      SELECT * FROM users WHERE username_norm LIKE ? OR lower(display_name) LIKE ?
      ORDER BY created_at DESC LIMIT 200
    `).bind(`%${q}%`, `%${q}%`).all();
    return response({ users: (rows.results || []).map(publicUser) });
  }
  const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userMatch && request.method === 'PATCH') {
    if (userMatch[1] === admin.id) return failure('不能在这里修改当前管理员', 409);
    const body = await readJSON(request);
    const status = ['active', 'banned'].includes(body.status) ? body.status : null;
    const role = ['user', 'admin'].includes(body.role) ? body.role : null;
    if (!status && !role) return failure('没有可更新的字段');
    if (status) {
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, userMatch[1]),
        ...(status === 'banned' ? [env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userMatch[1])] : []),
      ]);
    }
    if (role) await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, userMatch[1]).run();
    await audit(env, admin.id, 'update_user', 'user', userMatch[1], JSON.stringify({ status, role }));
    return response({ ok: true });
  }
  if (pathname === '/api/admin/invitations' && request.method === 'GET') {
    const rows = await env.DB.prepare(`
      SELECT i.*, u.username AS creator_username FROM invitations i
      JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC LIMIT 100
    `).all();
    return response({
      invitations: (rows.results || []).map((row) => ({
        hash: row.code_hash,
        label: row.label,
        creator: row.creator_username,
        uses: row.uses,
        maxUses: row.max_uses,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      })),
    });
  }
  if (pathname === '/api/admin/invitations' && request.method === 'POST') {
    const body = await readJSON(request);
    const code = randomToken(12).toUpperCase();
    const maxUses = Math.min(Math.max(Number(body.maxUses) || 1, 1), 100);
    const days = Math.min(Math.max(Number(body.days) || 7, 1), 365);
    await env.DB.prepare(`
      INSERT INTO invitations (code_hash, label, created_by, max_uses, uses, expires_at, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `).bind(await sha256(code), cleanText(body.label, 60), admin.id, maxUses, Date.now() + days * 86400000, Date.now()).run();
    await audit(env, admin.id, 'create_invite', 'invitation', 'new', JSON.stringify({ maxUses, days }));
    return response({ code }, 201);
  }
  const inviteMatch = pathname.match(/^\/api\/admin\/invitations\/([^/]+)$/);
  if (inviteMatch && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM invitations WHERE code_hash = ?').bind(inviteMatch[1]).run();
    return response({ ok: true });
  }
  if (pathname === '/api/admin/conversations' && request.method === 'GET') {
    const rows = await env.DB.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) AS member_count,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS message_count,
        (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY seq DESC LIMIT 1) AS last_body
      FROM conversations c ORDER BY c.updated_at DESC LIMIT 200
    `).all();
    return response({ conversations: rows.results || [] });
  }
  const adminMessages = pathname.match(/^\/api\/admin\/conversations\/([^/]+)\/messages$/);
  if (adminMessages && request.method === 'GET') {
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    return response({ messages: await getMessageRows(env, adminMessages[1], before, 100) });
  }
  if (pathname === '/api/admin/audit' && request.method === 'GET') {
    const rows = await env.DB.prepare(`
      SELECT a.*, u.username AS actor_username FROM audit_log a
      LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT 200
    `).all();
    return response({ audit: rows.results || [] });
  }
  return null;
}

async function handleMedia(request, env, pathname) {
  const match = pathname.match(/^\/media\/([^/]+)$/);
  if (!match || request.method !== 'GET') return null;
  const user = await requireUser(request, env);
  const item = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(match[1]).first();
  if (!item) return new Response('Not found', { status: 404 });
  if (!await isMember(env, item.conversation_id, user.id) && user.role !== 'admin') {
    return new Response('Forbidden', { status: 403 });
  }
  const object = await env.FILES.get(item.object_key);
  if (!object) return new Response('Not found', { status: 404 });
  const inline = item.mime.startsWith('image/') || item.mime.startsWith('audio/') || item.mime.startsWith('video/');
  return new Response(object.body, {
    headers: {
      'Content-Type': item.mime,
      'Content-Length': String(item.size),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.file_name)}`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function handleWebSocket(request, env, pathname) {
  const match = pathname.match(/^\/ws\/([^/]+)$/);
  if (!match || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return null;
  const user = await requireUser(request, env);
  if (!await isMember(env, match[1], user.id)) return failure('无权加入此会话', 403);
  const headers = new Headers(request.headers);
  headers.set('x-chat-user-id', user.id);
  headers.set('x-chat-user-name', encodeURIComponent(user.display_name));
  return env.CHAT_ROOMS.getByName(match[1]).fetch(new Request(`https://room.internal/connect/${match[1]}`, {
    method: 'GET',
    headers,
  }));
}

function securityHeaders(responseValue) {
  const headers = new Headers(responseValue.headers);
  headers.set('X-Starpost-Version', BUILD_VERSION);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  headers.set('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self' wss: ws:",
    "style-src 'self'",
    "script-src 'self'",
    "frame-ancestors 'self' https://sjtu.ccwu.cc https://xiaoxi.site",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '));
  return new Response(responseValue.body, { status: responseValue.status, statusText: responseValue.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (pathname.startsWith('/ws/')) {
        const ws = await handleWebSocket(request, env, pathname);
        if (ws) return ws;
      }
      if (pathname.startsWith('/media/')) {
        const media = await handleMedia(request, env, pathname);
        if (media) return securityHeaders(media);
      }
      if (pathname.startsWith('/api/')) {
        let result = await handleAuth(request, env, pathname);
        if (!result && (pathname === '/api/users' || pathname.startsWith('/api/friends'))) {
          result = await handleFriends(request, env, pathname, url);
        }
        if (!result && pathname.startsWith('/api/conversations')) {
          result = await handleConversations(request, env, pathname, url);
        }
        if (!result && pathname.startsWith('/api/messages/')) {
          result = await handleMessages(request, env, pathname);
        }
        if (!result && pathname.startsWith('/api/admin/')) {
          result = await handleAdmin(request, env, pathname, url);
        }
        return securityHeaders(result || failure('接口不存在', 404, 'not_found'));
      }
      return securityHeaders(await env.ASSETS.fetch(request));
    } catch (error) {
      console.error(error);
      return securityHeaders(failure(error.message || '服务器暂时不可用', error.status || 500, error.code || 'server_error'));
    }
  },
};

export class ConversationRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/broadcast') {
      const payload = await request.json();
      this.broadcast(payload);
      return new Response(null, { status: 204 });
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const userId = request.headers.get('x-chat-user-id');
    const displayName = decodeURIComponent(request.headers.get('x-chat-user-name') || '用户');
    server.serializeAttachment({ userId, displayName });
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'ready', membersOnline: this.ctx.getWebSockets().length }));
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, raw) {
    if (typeof raw !== 'string' || raw.length > 20000) return;
    let incoming;
    try {
      incoming = JSON.parse(raw);
    } catch {
      return;
    }
    const session = socket.deserializeAttachment() || {};
    if (incoming.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong', at: Date.now() }));
      return;
    }
    if (incoming.type === 'typing') {
      this.broadcast({ type: 'typing', userId: session.userId, displayName: session.displayName, active: !!incoming.active }, socket);
      return;
    }
    if (incoming.type !== 'message') return;
    const conversationId = cleanText(incoming.conversationId, 80);
    const membership = await isMember(this.env, conversationId, session.userId);
    if (!membership) {
      socket.send(JSON.stringify({ type: 'error', message: '你已不在这个会话中' }));
      return;
    }
    const body = String(incoming.body || '').trim().slice(0, MAX_MESSAGE);
    const kind = ['text', 'image', 'file', 'audio'].includes(incoming.kind) ? incoming.kind : 'text';
    const attachmentId = incoming.attachmentId ? String(incoming.attachmentId) : null;
    if (!body && !attachmentId) {
      socket.send(JSON.stringify({ type: 'error', message: '消息不能为空' }));
      return;
    }
    let attachment = null;
    if (attachmentId) {
      attachment = await this.env.DB.prepare(`
        SELECT * FROM attachments WHERE id = ? AND conversation_id = ? AND uploader_id = ?
      `).bind(attachmentId, conversationId, session.userId).first();
      if (!attachment) {
        socket.send(JSON.stringify({ type: 'error', message: '附件无效' }));
        return;
      }
    }
    const seqRow = await this.env.DB.prepare(`
      SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE conversation_id = ?
    `).bind(conversationId).first();
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const seq = Number(seqRow?.next_seq || 1);
    await this.env.DB.batch([
      this.env.DB.prepare(`
        INSERT INTO messages
        (id, conversation_id, seq, sender_id, kind, body, attachment_id, reply_to, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, conversationId, seq, session.userId, kind, body, attachmentId, incoming.replyTo || null, createdAt),
      this.env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(createdAt, conversationId),
    ]);
    const message = {
      id,
      conversationId,
      seq,
      sender: { id: session.userId, displayName: session.displayName },
      kind,
      body,
      attachment: attachment ? {
        id: attachment.id,
        name: attachment.file_name,
        mime: attachment.mime,
        size: attachment.size,
        url: `/media/${attachment.id}`,
      } : null,
      replyTo: incoming.replyTo || null,
      createdAt,
      editedAt: null,
      deletedAt: null,
    };
    this.broadcast({ type: 'message', message });
  }

  webSocketClose() {
    this.broadcastPresence();
  }

  webSocketError() {
    this.broadcastPresence();
  }

  broadcast(payload, except = null) {
    const encoded = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try {
        socket.send(encoded);
      } catch {
        // Stale sockets are removed by the runtime.
      }
    }
  }

  broadcastPresence() {
    this.broadcast({ type: 'presence', membersOnline: this.ctx.getWebSockets().length });
  }
}
