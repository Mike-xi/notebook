const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const APP_BASE = location.pathname === '/starpost-app' || location.pathname.startsWith('/starpost-app/')
  ? '/starpost-app'
  : '';
const appPath = (path) => path.startsWith('/') ? `${APP_BASE}${path}` : path;

const MAX_ATTACHMENT = 8 * 1024 * 1024;
const MAX_QUEUE = 9;
const LIST_REFRESH_MS = 15000;

const state = {
  user: null,
  friends: { friends: [], incoming: [], outgoing: [], blocked: [] },
  conversations: [],
  activeId: null,
  activeDetail: null,
  activeKind: 'dm',
  messages: [],
  reads: {},
  ws: null,
  reconnectTimer: null,
  manualClose: false,
  pendingFiles: [],
  mediaRecorder: null,
  mediaChunks: [],
  typingTimer: null,
  activeView: 'chats',
  onlineUsers: [],
  unknownOnlineCount: 0,
  replyTo: null,
  editing: null,
  refreshTimer: null,
};

const authView = $('#auth-view');
const appView = $('#app-view');
const sidebarContent = $('#sidebar-content');
const sidebarTitle = $('#sidebar-title');
const sidebarEyebrow = $('#sidebar-eyebrow');
const sidebarSearch = $('#sidebar-search');
const conversationEmpty = $('#conversation-empty');
const conversationActive = $('#conversation-active');
const messagesEl = $('#messages');
const messageInput = $('#message-input');
const toastEl = $('#toast');
const attachmentTray = $('#attachment-tray');
const composerContext = $('#composer-context');
const attachMenu = $('#attach-menu');
const emojiPanel = $('#emoji-panel');
const fileInput = $('#file-input');
const dropVeil = $('#drop-veil');

function icon(name) {
  return `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function initials(name) {
  const text = String(name || 'U').trim();
  return [...text][0]?.toUpperCase() || 'U';
}

function avatarContent(user, fallbackName) {
  if (user?.avatarUrl) {
    return `<img src="${escapeHTML(appPath(user.avatarUrl))}" alt="" loading="lazy">`;
  }
  return escapeHTML(initials(fallbackName || user?.displayName));
}

function avatarHTML(user, fallbackName, className = '') {
  return `<span class="avatar ${className}">${avatarContent(user, fallbackName)}</span>`;
}

function setAvatar(element, user, fallbackName) {
  if (!element) return;
  element.innerHTML = avatarContent(user, fallbackName);
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function formatFullTime(value) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

// Attachments are rendered from their MIME type, so video rides the 'file' kind
// on the wire without needing a schema migration.
function mediaKind(attachment, kind) {
  const mime = attachment?.mime || '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (kind === 'image' || kind === 'audio') return kind;
  return 'file';
}

function uploadKind(file) {
  const type = file.type || '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  return 'file';
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_RUN = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Emoji_Component}|️|‍|\s)+$/u;
function emojiOnly(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || [...trimmed].length > 12) return false;
  return PICTOGRAPHIC.test(trimmed) && EMOJI_RUN.test(trimmed);
}

function previewOf(message) {
  if (!message) return '开始一段对话';
  if (message.kind === 'system') return message.body;
  if (message.kind === 'text') return message.body;
  return { image: '[图片]', audio: '[语音]', file: '[文件]' }[message.kind] || '[消息]';
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const body = options.body && !(options.body instanceof ArrayBuffer) && !(options.body instanceof Blob)
    ? JSON.stringify(options.body)
    : options.body;
  if (body && typeof body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const result = await fetch(appPath(path), { ...options, body, headers, credentials: 'same-origin' });
  const type = result.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await result.json() : null;
  if (!result.ok) {
    const error = new Error(data?.message || `请求失败（${result.status}）`);
    error.status = result.status;
    error.code = data?.error;
    throw error;
  }
  return data;
}

function setButtonBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.dataset.original = button.innerHTML;
    button.textContent = '请稍候…';
  } else if (button.dataset.original) {
    button.innerHTML = button.dataset.original;
  }
}

$$('[data-auth-tab]').forEach((button) => {
  button.addEventListener('click', () => {
    $$('[data-auth-tab]').forEach((item) => item.classList.toggle('active', item === button));
    const register = button.dataset.authTab === 'register';
    $('#login-form').hidden = register;
    $('#register-form').hidden = !register;
    $('#auth-title').textContent = register ? '加入星邮' : '欢迎回来';
    $('#auth-subtitle').textContent = register ? '使用管理员发放的邀请码创建账号。' : '登录后继续你的对话。';
    $('#auth-error').textContent = '';
  });
});

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('button[type="submit"]', event.currentTarget);
  setButtonBusy(button, true);
  $('#auth-error').textContent = '';
  try {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const data = await api('/api/login', { method: 'POST', body: values });
    state.user = data.user;
    await enterApp();
  } catch (error) {
    $('#auth-error').textContent = error.message;
  } finally {
    setButtonBusy(button, false);
  }
});

$('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('button[type="submit"]', event.currentTarget);
  setButtonBusy(button, true);
  $('#auth-error').textContent = '';
  try {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const data = await api('/api/register', { method: 'POST', body: values });
    state.user = data.user;
    await enterApp();
  } catch (error) {
    $('#auth-error').textContent = error.message;
  } finally {
    setButtonBusy(button, false);
  }
});

async function init() {
  try {
    const data = await api('/api/session');
    state.user = data.user;
  } catch {
    state.user = null;
  }
  if (state.user) await enterApp();
  else {
    authView.hidden = false;
    appView.hidden = true;
  }
}

async function enterApp() {
  authView.hidden = true;
  appView.hidden = false;
  setAvatar($('#rail-avatar'), state.user, state.user.displayName);
  $('#admin-link').hidden = state.user.role !== 'admin';
  await Promise.all([loadFriends(), loadConversations()]);
  setView('chats');
  startBackgroundRefresh();
}

// Only the open conversation has a socket, so the list and friend requests are
// kept fresh with a light poll instead of going stale until reload.
function startBackgroundRefresh() {
  clearInterval(state.refreshTimer);
  let tick = 0;
  state.refreshTimer = setInterval(async () => {
    if (document.hidden || !state.user) return;
    tick += 1;
    try {
      await loadConversations();
      if (tick % 3 === 0) {
        await loadFriends();
        if (state.activeView === 'contacts' && !sidebarSearch.value.trim()) renderContacts();
      }
    } catch {
      // Transient network errors just wait for the next tick.
    }
  }, LIST_REFRESH_MS);
}

async function loadFriends() {
  state.friends = await api('/api/friends');
  updateBadges();
}

async function loadConversations() {
  const data = await api('/api/conversations');
  state.conversations = data.conversations;
  // Whatever is on screen has been read by definition.
  const open = state.conversations.find((item) => item.id === state.activeId);
  if (open && !document.hidden) open.unread = 0;
  updateBadges();
  if (state.activeView === 'chats') renderChats();
}

function setView(view) {
  state.activeView = view;
  $$('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $('#new-group-button').hidden = view !== 'chats';
  sidebarSearch.value = '';
  if (view === 'chats') {
    sidebarEyebrow.textContent = 'Starpost';
    sidebarTitle.textContent = '消息';
    sidebarSearch.placeholder = '搜索会话';
    renderChats();
  } else if (view === 'contacts') {
    sidebarEyebrow.textContent = 'People';
    sidebarTitle.textContent = '联系人';
    sidebarSearch.placeholder = '搜索用户名';
    renderContacts();
  } else {
    openProfile();
    setView('chats');
  }
}

$$('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$('#rail-avatar').addEventListener('click', openProfile);

function renderChats() {
  const query = sidebarSearch.value.trim().toLowerCase();
  const rows = state.conversations.filter((item) => item.title.toLowerCase().includes(query));
  if (!rows.length) {
    sidebarContent.innerHTML = `<div class="list-empty">${icon('chat')}<span>${query ? '没有匹配的会话' : '还没有对话<br>去联系人中找一位好友吧'}</span></div>`;
    return;
  }
  sidebarContent.innerHTML = rows.map((item) => {
    const preview = previewOf(item.lastMessage);
    return `<button class="chat-item ${item.id === state.activeId ? 'active' : ''}" type="button" data-chat-id="${item.id}">
      ${avatarHTML(item.kind === 'dm' ? item.peer : null, item.title, item.kind === 'group' ? 'group' : '')}
      <span class="chat-item-main">
        <span class="chat-item-row"><strong>${escapeHTML(item.title)}</strong><time>${formatTime(item.lastMessage?.createdAt || item.updatedAt)}</time></span>
        <span class="chat-item-row"><p>${escapeHTML(preview)}</p>${item.unread ? `<b class="unread-badge">${item.unread > 99 ? '99+' : item.unread}</b>` : ''}</span>
      </span>
    </button>`;
  }).join('');
}

async function renderContacts() {
  const query = sidebarSearch.value.trim();
  if (query.length >= 2) {
    sidebarContent.innerHTML = '<div class="list-empty"><span>正在搜索…</span></div>';
    try {
      const data = await api(`/api/users?q=${encodeURIComponent(query)}`);
      const friendIds = new Set(state.friends.friends.map((item) => item.id));
      const outgoingIds = new Set(state.friends.outgoing.map((item) => item.id));
      sidebarContent.innerHTML = `<div class="section-caption">搜索结果</div>${data.users.map((person) => personHTML(person, friendIds.has(person.id) ? 'friend' : outgoingIds.has(person.id) ? 'outgoing' : 'stranger')).join('') || '<div class="list-empty"><span>没有找到用户</span></div>'}`;
    } catch (error) {
      sidebarContent.innerHTML = `<div class="list-empty"><span>${escapeHTML(error.message)}</span></div>`;
    }
    return;
  }
  const chunks = [];
  if (state.friends.incoming.length) {
    chunks.push(`<div class="section-caption">好友申请 <b>${state.friends.incoming.length}</b></div>${state.friends.incoming.map((p) => personHTML(p, 'incoming')).join('')}`);
  }
  if (state.friends.friends.length) {
    chunks.push(`<div class="section-caption">我的好友 <b>${state.friends.friends.length}</b></div>${state.friends.friends.map((p) => personHTML(p, 'friend')).join('')}`);
  }
  if (state.friends.outgoing.length) {
    chunks.push(`<div class="section-caption">等待回应</div>${state.friends.outgoing.map((p) => personHTML(p, 'outgoing')).join('')}`);
  }
  if (state.friends.blocked.length) {
    chunks.push(`<div class="section-caption">黑名单 <b>${state.friends.blocked.length}</b></div>${state.friends.blocked.map((p) => personHTML(p, 'blocked')).join('')}`);
  }
  sidebarContent.innerHTML = chunks.join('') || `<div class="list-empty">${icon('users')}<span>搜索用户名并发送好友申请</span></div>`;
}

function personHTML(person, relation) {
  let actions = '';
  if (relation === 'incoming') {
    actions = `<button data-friend-action="accept" data-request-id="${person.requestId}" title="接受">${icon('check')}</button><button data-friend-action="reject" data-request-id="${person.requestId}" title="拒绝">${icon('close')}</button>`;
  } else if (relation === 'friend') {
    actions = `<button data-dm-user="${escapeHTML(person.id)}" title="发消息">${icon('chat')}</button>
      <button data-remove-friend="${escapeHTML(person.id)}" data-name="${escapeHTML(person.displayName)}" title="删除好友">${icon('user-minus')}</button>
      <button data-block-user="${escapeHTML(person.id)}" data-name="${escapeHTML(person.displayName)}" title="拉黑">${icon('ban')}</button>`;
  } else if (relation === 'blocked') {
    actions = `<button data-unblock-user="${escapeHTML(person.id)}" title="解除拉黑">${icon('check')}</button>`;
  } else if (relation === 'stranger') {
    actions = `<button data-add-user="${escapeHTML(person.username)}" title="加好友">${icon('plus')}</button>`;
  } else {
    actions = '<button disabled>已发送</button>';
  }
  return `<div class="person-item">
    ${avatarHTML(person, person.displayName)}
    <span class="person-main"><strong>${escapeHTML(person.displayName)}</strong><p>@${escapeHTML(person.username)}${person.bio ? ` · ${escapeHTML(person.bio)}` : ''}</p></span>
    <span class="person-actions">${actions}</span>
  </div>`;
}

let searchTimer;
sidebarSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => state.activeView === 'chats' ? renderChats() : renderContacts(), state.activeView === 'contacts' ? 280 : 0);
});

sidebarContent.addEventListener('click', async (event) => {
  const chat = event.target.closest('[data-chat-id]');
  if (chat) return openConversation(chat.dataset.chatId);
  const dm = event.target.closest('[data-dm-user]');
  if (dm) {
    try {
      // Creating the room is async; drop the previous room's "已连接" now so
      // nothing (and nobody) treats the composer as ready in the meantime.
      resetPresence();
      const data = await api('/api/conversations/dm', { method: 'POST', body: { userId: dm.dataset.dmUser } });
      await loadConversations();
      setView('chats');
      return openConversation(data.id);
    } catch (error) {
      return toast(error.message);
    }
  }
  const add = event.target.closest('[data-add-user]');
  if (add) {
    try {
      await api('/api/friends/request', { method: 'POST', body: { username: add.dataset.addUser } });
      toast('好友申请已发送');
      await loadFriends();
      return renderContacts();
    } catch (error) {
      return toast(error.message);
    }
  }
  const unfriend = event.target.closest('[data-remove-friend]');
  if (unfriend) {
    if (!confirm(`删除好友 ${unfriend.dataset.name}？`)) return;
    try {
      await api('/api/friends/remove', { method: 'POST', body: { userId: unfriend.dataset.removeFriend } });
      await Promise.all([loadFriends(), loadConversations()]);
      renderContacts();
      toast('已删除好友');
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  const block = event.target.closest('[data-block-user]');
  if (block) {
    if (!confirm(`拉黑 ${block.dataset.name}？你们将无法互发消息。`)) return;
    try {
      await api('/api/friends/block', { method: 'POST', body: { userId: block.dataset.blockUser } });
      await Promise.all([loadFriends(), loadConversations()]);
      renderContacts();
      toast('已拉黑');
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  const unblock = event.target.closest('[data-unblock-user]');
  if (unblock) {
    try {
      await api('/api/friends/unblock', { method: 'POST', body: { userId: unblock.dataset.unblockUser } });
      await loadFriends();
      renderContacts();
      toast('已解除拉黑');
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  const action = event.target.closest('[data-friend-action]');
  if (action) {
    try {
      await api(`/api/friends/${action.dataset.friendAction}`, { method: 'POST', body: { requestId: action.dataset.requestId } });
      await loadFriends();
      renderContacts();
      toast(action.dataset.friendAction === 'accept' ? '已成为好友' : '已拒绝申请');
    } catch (error) {
      toast(error.message);
    }
  }
});

// Switching conversations used to wait on two round trips before drawing
// anything. Now the header comes from the list we already have, the socket
// dials in parallel, and cached history paints immediately while it refreshes.
const historyCache = new Map();

function paintConversationHeader(summary) {
  const title = summary?.title || '会话';
  $('#chat-title').textContent = title;
  setAvatar($('#chat-avatar'), summary?.kind === 'dm' ? summary.peer : null, title);
  $('#chat-avatar').classList.toggle('group', summary?.kind === 'group');
}

async function openConversation(id) {
  if (state.activeId === id && state.ws?.readyState === WebSocket.OPEN) {
    appView.classList.add('mobile-chat-open');
    return;
  }
  closeSocket();
  state.replyTo = null;
  state.editing = null;
  messageInput.value = '';
  autoGrow();
  renderComposerContext();
  clearAttachments();
  state.activeId = id;
  state.activeDetail = null;
  state.onlineUsers = [];
  resetPresence();
  renderChats();
  conversationEmpty.hidden = true;
  conversationActive.hidden = false;
  appView.classList.add('mobile-chat-open');

  const summary = state.conversations.find((item) => item.id === id);
  state.activeKind = summary?.kind || 'dm';
  paintConversationHeader(summary);

  const cached = historyCache.get(id);
  if (cached) {
    state.messages = cached.messages;
    state.reads = cached.reads;
    renderMessages({ stick: true });
    renderReadReceipt();
  } else {
    state.messages = [];
    state.reads = {};
    messagesEl.innerHTML = `<button class="history-button" id="history-button" type="button" hidden>加载更早消息</button>
      <div class="messages-skeleton">${'<span></span>'.repeat(5)}</div>`;
  }

  connectSocket();
  // Keep an already-open detail panel in sync with the new conversation.
  if (!$('#detail-panel').hidden) {
    ensureDetail().then(renderDetail).catch(() => {});
  }

  try {
    const history = await api(`/api/conversations/${id}/messages`);
    if (state.activeId !== id) return;
    // Anything that arrived over the socket while this request was in flight
    // must survive it, otherwise a message sent right after opening vanishes.
    const known = new Set(history.messages.map((message) => message.id));
    const live = state.messages.filter((message) => !known.has(message.id));
    state.messages = [...history.messages, ...live].sort((a, b) => a.seq - b.seq);
    state.reads = Object.fromEntries((history.reads || []).map((item) => [item.userId, item.seq]));
    historyCache.set(id, { messages: state.messages, reads: state.reads });
    renderMessages({ stick: !cached });
    renderReadReceipt();
    markRead();
  } catch (error) {
    if (state.activeId !== id) return;
    toast(error.message);
    conversationActive.hidden = true;
    conversationEmpty.hidden = false;
  }
}

// Member details are only needed by the detail panel, so they load on demand.
async function ensureDetail() {
  if (state.activeDetail || !state.activeId) return state.activeDetail;
  state.activeDetail = await api(`/api/conversations/${state.activeId}`);
  return state.activeDetail;
}

function renderMessages({ preserveScroll = false, stick = false } = {}) {
  const previousHeight = messagesEl.scrollHeight;
  const previousTop = messagesEl.scrollTop;
  // Only chase the bottom when the reader is already there — otherwise a new
  // message would yank them out of the history they are reading.
  const atBottom = previousHeight - previousTop - messagesEl.clientHeight < 140;
  const historyButton = `<button class="history-button" id="history-button" type="button" ${state.messages.length >= 60 ? '' : 'hidden'}>加载更早消息</button>`;
  if (!state.messages.length) {
    messagesEl.innerHTML = `${historyButton}<div class="list-empty">${icon('chat')}<span>这是对话的开始</span></div>`;
    return;
  }
  let lastDay = '';
  const rows = [];
  for (const message of state.messages) {
    const day = new Date(message.createdAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
    if (day !== lastDay) {
      rows.push(`<div class="day-divider"><span>${escapeHTML(day)}</span></div>`);
      lastDay = day;
    }
    rows.push(messageHTML(message));
  }
  messagesEl.innerHTML = historyButton + rows.join('');
  if (preserveScroll) messagesEl.scrollTop = previousTop + messagesEl.scrollHeight - previousHeight;
  else if (stick || atBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  else messagesEl.scrollTop = previousTop;
}

function quoteHTML(reply) {
  if (!reply) return '';
  const text = reply.deleted ? '原消息已撤回' : (reply.body || previewOf({ kind: reply.kind, body: '' }));
  return `<button class="message-quote" type="button" data-jump-message="${escapeHTML(reply.id)}">
    <strong>${escapeHTML(reply.displayName)}</strong><span>${escapeHTML(text)}</span>
  </button>`;
}

function attachmentHTML(message) {
  if (!message.attachment || message.deletedAt) return '';
  const url = appPath(message.attachment.url);
  const name = escapeHTML(message.attachment.name);
  const view = mediaKind(message.attachment, message.kind);
  if (view === 'image') {
    return `<button class="message-attachment media" type="button" data-preview="${escapeHTML(message.id)}">
      <img src="${url}" alt="${name}" loading="lazy">
      <span class="media-zoom">${icon('zoom-in')}</span>
    </button>`;
  }
  if (view === 'video') {
    return `<div class="message-attachment media video">
      <video src="${url}" preload="metadata" controls playsinline></video>
      <button class="media-expand" type="button" data-preview="${escapeHTML(message.id)}" title="全屏预览">${icon('zoom-in')}</button>
    </div>`;
  }
  if (view === 'audio') {
    return `<div class="message-attachment"><audio controls preload="metadata" src="${url}"></audio></div>`;
  }
  return `<a class="message-attachment file-card" href="${url}" target="_blank" rel="noopener">${icon('file')}<div><strong>${name}</strong><span>${formatSize(message.attachment.size)}</span></div></a>`;
}

function messageHTML(message) {
  if (message.kind === 'system' && !message.deletedAt) {
    return `<div class="system-row" data-message-id="${escapeHTML(message.id)}"><span>${escapeHTML(message.body)}</span></div>`;
  }
  const own = message.sender.id === state.user.id;
  const deleted = !!message.deletedAt;
  const attachment = attachmentHTML(message);
  const view = message.attachment && !deleted ? mediaKind(message.attachment, message.kind) : null;
  const mediaOnly = (view === 'image' || view === 'video') && !message.body;
  const editable = own && !deleted && !message.attachment;
  const actions = deleted ? '' : `<span class="message-actions">
    <button data-reply-message="${escapeHTML(message.id)}" title="回复">${icon('reply')}</button>
    ${editable ? `<button data-edit-message="${escapeHTML(message.id)}" title="编辑">${icon('edit')}</button>` : ''}
    ${own ? `<button data-delete-message="${escapeHTML(message.id)}" title="撤回">${icon('trash')}</button>` : ''}
  </span>`;
  const bodyHTML = deleted
    ? '<div class="message-text">消息已撤回</div>'
    : (message.body ? `<div class="message-text${emojiOnly(message.body) ? ' jumbo' : ''}">${escapeHTML(message.body)}</div>` : '');
  return `<div class="message-row ${own ? 'own' : ''}" data-message-id="${escapeHTML(message.id)}">
    ${!own ? `<span class="message-avatar">${avatarContent(message.sender, message.sender.displayName)}</span>` : actions}
    <div class="message-stack">
      ${!own ? `<p class="message-sender">${escapeHTML(message.sender.displayName)}</p>` : ''}
      <div class="message-bubble ${deleted ? 'deleted' : ''}${mediaOnly ? ' media-only' : ''}">
        ${quoteHTML(message.replyTo)}
        ${attachment}
        ${bodyHTML}
        <div class="message-meta">${message.editedAt ? '<span>已编辑</span>' : ''}<time>${formatFullTime(message.createdAt)}</time></div>
      </div>
    </div>
    ${own ? '' : actions}
  </div>`;
}

messagesEl.addEventListener('click', async (event) => {
  if (event.target.closest('#history-button')) return loadOlderMessages();

  const preview = event.target.closest('[data-preview]');
  if (preview) return openLightbox(preview.dataset.preview);

  const jump = event.target.closest('[data-jump-message]');
  if (jump) return jumpToMessage(jump.dataset.jumpMessage);

  const reply = event.target.closest('[data-reply-message]');
  if (reply) {
    const message = state.messages.find((item) => item.id === reply.dataset.replyMessage);
    if (!message) return;
    state.editing = null;
    state.replyTo = {
      id: message.id,
      displayName: message.sender.displayName,
      body: message.body || previewOf(message),
    };
    renderComposerContext();
    messageInput.focus();
    return;
  }

  const edit = event.target.closest('[data-edit-message]');
  if (edit) {
    const message = state.messages.find((item) => item.id === edit.dataset.editMessage);
    if (!message) return;
    state.replyTo = null;
    state.editing = { id: message.id, original: message.body };
    messageInput.value = message.body;
    renderComposerContext();
    autoGrow();
    messageInput.focus();
    messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
    return;
  }

  const remove = event.target.closest('[data-delete-message]');
  if (remove) {
    if (!confirm('撤回这条消息？附件也会一并删除。')) return;
    try {
      await api(`/api/messages/${remove.dataset.deleteMessage}`, { method: 'DELETE' });
    } catch (error) {
      toast(error.message);
    }
    return;
  }

  // Touch devices have no hover, so tapping a bubble reveals its actions.
  const bubble = event.target.closest('.message-bubble');
  if (bubble && matchMedia('(hover: none)').matches) {
    const row = bubble.closest('.message-row');
    const open = row.classList.contains('actions-open');
    $$('.message-row.actions-open', messagesEl).forEach((item) => item.classList.remove('actions-open'));
    row.classList.toggle('actions-open', !open);
  }
});

function jumpToMessage(id) {
  const row = messagesEl.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
  if (!row) return toast('原消息不在当前加载范围内');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.remove('flash');
  void row.offsetWidth;
  row.classList.add('flash');
}

function renderComposerContext() {
  if (state.editing) {
    composerContext.hidden = false;
    composerContext.dataset.mode = 'edit';
    $('#context-icon').innerHTML = icon('edit');
    $('#context-title').textContent = '正在编辑消息';
    $('#context-text').textContent = state.editing.original;
    messageInput.placeholder = '修改后按 Enter 保存，Esc 取消';
    return;
  }
  if (state.replyTo) {
    composerContext.hidden = false;
    composerContext.dataset.mode = 'reply';
    $('#context-icon').innerHTML = icon('reply');
    $('#context-title').textContent = `回复 ${state.replyTo.displayName}`;
    $('#context-text').textContent = state.replyTo.body;
    messageInput.placeholder = '输入消息…';
    return;
  }
  composerContext.hidden = true;
  composerContext.dataset.mode = '';
  messageInput.placeholder = '输入消息…';
}

function clearComposerContext() {
  const wasEditing = !!state.editing;
  state.replyTo = null;
  state.editing = null;
  if (wasEditing) {
    messageInput.value = '';
    autoGrow();
  }
  renderComposerContext();
}

$('#context-cancel').addEventListener('click', clearComposerContext);

async function loadOlderMessages() {
  const first = state.messages[0];
  if (!first) return;
  try {
    const data = await api(`/api/conversations/${state.activeId}/messages?before=${first.seq}`);
    if (!data.messages.length) {
      $('#history-button').hidden = true;
      return toast('已经到最早一条消息了');
    }
    state.messages = [...data.messages, ...state.messages];
    const cached = historyCache.get(state.activeId);
    if (cached) cached.messages = state.messages;
    renderMessages({ preserveScroll: true });
    renderReadReceipt();
  } catch (error) {
    toast(error.message);
  }
}

// The status line must not claim "已连接" before the socket is actually open —
// that made the composer look ready while sending still failed.
function resetPresence() {
  state.onlineUsers = [];
  state.unknownOnlineCount = 0;
  $('#chat-status').textContent = '正在连接…';
  $('#chat-status').classList.remove('connected');
  $('#online-count').textContent = '0';
  $('#online-button').hidden = true;
}

function updatePresence(data) {
  const receivedUsers = Array.isArray(data.onlineUsers) ? data.onlineUsers : [];
  const count = Number(data.membersOnline) || receivedUsers.length || 0;
  state.onlineUsers = receivedUsers;
  state.unknownOnlineCount = Math.max(0, count - receivedUsers.length);
  if (count > 0 && !state.onlineUsers.length && state.user) {
    state.onlineUsers = [{
      id: state.user.id,
      displayName: state.user.displayName,
      avatarUrl: state.user.avatarUrl || null,
    }];
    state.unknownOnlineCount = Math.max(0, count - 1);
  }
  $('#chat-status').textContent = count ? `${count} 人在线` : '已连接';
  $('#chat-status').classList.add('connected');
  $('#online-count').textContent = String(count);
  $('#online-button').hidden = false;
}

function renderOnlineList() {
  const members = new Map((state.activeDetail?.members || []).map((member) => [member.id, member]));
  const knownUsers = state.onlineUsers.map((presence) => {
    const member = members.get(presence.id);
    const person = member || presence;
    const subtitle = member?.username
      ? `@${escapeHTML(member.username)}${presence.id === state.user.id ? ' · 你' : ''}`
      : (presence.id === state.user.id ? '你' : '当前在线');
    return `<div class="online-person">
      ${avatarHTML(person, presence.displayName)}
      <div><strong>${escapeHTML(presence.displayName || member?.displayName || '用户')}</strong><span>${subtitle}</span></div>
      <i class="online-dot" aria-label="在线"></i>
    </div>`;
  }).join('');
  const unknownUsers = state.unknownOnlineCount
    ? `<div class="online-pending"><span>另有 ${state.unknownOnlineCount} 人在线，等待其客户端刷新后显示身份</span></div>`
    : '';
  $('#online-list').innerHTML = knownUsers + unknownUsers
    || '<div class="list-empty"><span>当前没有成员在线</span></div>';
}

function connectSocket() {
  if (!state.activeId) return;
  state.manualClose = false;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}${appPath(`/ws/${state.activeId}`)}`);
  state.ws = socket;
  $('#chat-status').textContent = '正在连接…';
  $('#chat-status').classList.remove('connected');
  socket.addEventListener('open', () => {
    if (socket !== state.ws) return;
    $('#chat-status').textContent = '已连接';
    $('#chat-status').classList.add('connected');
  });
  socket.addEventListener('message', (event) => {
    if (socket !== state.ws) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'ready' || data.type === 'presence') {
      updatePresence(data);
    } else if (data.type === 'message') {
      if (!state.messages.some((item) => item.id === data.message.id)) {
        state.messages.push(data.message);
        renderMessages({ stick: data.message.sender.id === state.user.id });
        renderReadReceipt();
        // Only claim it was read when the tab is actually in front; otherwise
        // let the badge stand until the user comes back.
        if (document.hidden && data.message.sender.id !== state.user.id) loadConversations();
        else markRead().then(loadConversations);
      }
    } else if (data.type === 'read') {
      state.reads[data.userId] = Math.max(state.reads[data.userId] || 0, Number(data.seq) || 0);
      renderReadReceipt();
    } else if (data.type === 'members-changed') {
      if (data.removedUserId === state.user.id) leaveActiveConversation('你已被移出群组');
      else refreshActiveDetail();
    } else if (data.type === 'conversation-renamed') {
      $('#chat-title').textContent = data.title;
      loadConversations();
      refreshActiveDetail();
    } else if (data.type === 'conversation-removed') {
      leaveActiveConversation('该会话已被删除');
    } else if (data.type === 'message-updated') {
      const message = state.messages.find((item) => item.id === data.id);
      if (message) {
        message.body = data.body;
        message.editedAt = data.editedAt;
        renderMessages();
      }
    } else if (data.type === 'message-deleted') {
      const message = state.messages.find((item) => item.id === data.id);
      if (message) {
        message.body = '';
        message.deletedAt = data.deletedAt;
        renderMessages();
      }
    } else if (data.type === 'typing' && data.userId !== state.user.id) {
      const line = $('#typing-line');
      line.textContent = data.active ? `${data.displayName} 正在输入…` : '';
      line.hidden = !data.active;
      clearTimeout(line.timer);
      if (data.active) line.timer = setTimeout(() => { line.hidden = true; }, 2600);
    } else if (data.type === 'error') {
      toast(data.message);
    }
  });
  socket.addEventListener('close', () => {
    if (socket !== state.ws || state.manualClose) return;
    $('#chat-status').textContent = '连接已断开，正在重连…';
    $('#chat-status').classList.remove('connected');
    $('#online-count').textContent = '…';
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(connectSocket, 1800);
  });
}

function closeSocket() {
  state.manualClose = true;
  clearTimeout(state.reconnectTimer);
  if (state.ws) state.ws.close(1000, 'switch conversation');
  state.ws = null;
  state.onlineUsers = [];
  state.unknownOnlineCount = 0;
  $('#online-count').textContent = '0';
}

$('#online-button').addEventListener('click', () => {
  renderOnlineList();
  $('#online-dialog').showModal();
});

// The rail dot is derived from the whole list, so it has to be recomputed
// wherever unread counts change — otherwise it stayed lit after reading.
function updateBadges() {
  const unread = state.conversations.reduce((sum, item) => sum + (item.unread || 0), 0);
  $('#rail-unread').hidden = unread === 0;
  $('#rail-requests').hidden = state.friends.incoming.length === 0;
}

async function markRead() {
  const last = state.messages.at(-1);
  if (!last || !state.activeId) return;
  const conversationId = state.activeId;
  try {
    await api(`/api/conversations/${conversationId}/read`, { method: 'POST', body: { seq: last.seq } });
    const summary = state.conversations.find((item) => item.id === conversationId);
    if (summary) summary.unread = 0;
    state.reads[state.user.id] = Math.max(state.reads[state.user.id] || 0, last.seq);
    renderChats();
    updateBadges();
  } catch {
    // Reading markers are best effort.
  }
}

/* Read receipts ---------------------------------------------------------- */

function renderReadReceipt() {
  messagesEl.querySelectorAll('.read-receipt').forEach((node) => node.remove());
  const mine = [...state.messages].reverse()
    .find((message) => message.kind !== 'system' && !message.deletedAt && message.sender.id === state.user.id);
  if (!mine) return;
  const others = Object.entries(state.reads).filter(([id]) => id !== state.user.id);
  if (!others.length) return;
  const seen = others.filter(([, seq]) => Number(seq) >= mine.seq).length;
  const row = messagesEl.querySelector(`[data-message-id="${CSS.escape(mine.id)}"]`);
  if (!row) return;
  const label = state.activeKind === 'group'
    ? (seen ? `${seen}/${others.length} 人已读` : '未读')
    : (seen ? '已读' : '未读');
  const node = document.createElement('span');
  node.className = `read-receipt${seen ? ' seen' : ''}`;
  node.textContent = label;
  row.querySelector('.message-stack')?.append(node);
}

function autoGrow() {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 140)}px`;
}
messageInput.addEventListener('input', () => {
  autoGrow();
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'typing', active: true }));
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => state.ws?.send(JSON.stringify({ type: 'typing', active: false })), 1100);
  }
});
messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = messageInput.value.trim();

  if (state.editing) {
    if (!body) return toast('消息不能为空');
    const { id, original } = state.editing;
    if (body === original) return clearComposerContext();
    try {
      await api(`/api/messages/${id}`, { method: 'PATCH', body: { body } });
      clearComposerContext();
    } catch (error) {
      toast(error.message);
    }
    return;
  }

  if (!state.activeId) return;
  if (!body && !state.pendingFiles.length) return;
  const submit = $('.send-button', event.currentTarget);
  submit.disabled = true;
  const replyTo = state.replyTo?.id || null;
  try {
    // Opening a conversation and typing immediately is normal; give the socket
    // a moment to finish its handshake instead of rejecting the message.
    if (!await socketReady()) throw new Error('聊天连接尚未就绪，请稍后重试');
    if (!state.pendingFiles.length) {
      sendOverSocket({ body, kind: 'text', attachmentId: null, replyTo });
    } else {
      // Each attachment becomes its own message; the typed text rides with the first.
      const files = [...state.pendingFiles];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const attachment = await uploadFile(file);
        sendOverSocket({
          body: index === 0 ? body : '',
          kind: uploadKind(file),
          attachmentId: attachment.id,
          replyTo: index === 0 ? replyTo : null,
        });
      }
    }
    messageInput.value = '';
    autoGrow();
    clearAttachments();
    state.replyTo = null;
    renderComposerContext();
  } catch (error) {
    toast(error.message);
  } finally {
    submit.disabled = false;
  }
});

function socketReady(timeout = 5000) {
  if (state.ws?.readyState === WebSocket.OPEN) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (state.ws?.readyState === WebSocket.OPEN) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        resolve(false);
      }
    }, 80);
  });
}

function sendOverSocket(payload) {
  state.ws.send(JSON.stringify({ type: 'message', conversationId: state.activeId, ...payload }));
}

async function uploadFile(file) {
  const result = await api(`/api/conversations/${state.activeId}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    body: await file.arrayBuffer(),
  });
  return result.attachment;
}

/* Attachment queue ------------------------------------------------------- */

const PICK_PRESETS = {
  image: { accept: 'image/*' },
  video: { accept: 'video/*' },
  audio: { accept: 'audio/*' },
  file: { accept: '' },
  camera: { accept: 'image/*,video/*', capture: 'environment' },
};
const thumbURLs = new WeakMap();

function thumbFor(file) {
  if (!/^(image|video)\//.test(file.type || '')) return '';
  if (!thumbURLs.has(file)) thumbURLs.set(file, URL.createObjectURL(file));
  return thumbURLs.get(file);
}

function releaseThumb(file) {
  const url = thumbURLs.get(file);
  if (url) {
    URL.revokeObjectURL(url);
    thumbURLs.delete(file);
  }
}

function openFilePicker(kind = 'file') {
  const preset = PICK_PRESETS[kind] || PICK_PRESETS.file;
  fileInput.accept = preset.accept;
  if (preset.capture) fileInput.setAttribute('capture', preset.capture);
  else fileInput.removeAttribute('capture');
  fileInput.value = '';
  fileInput.click();
}

function addFiles(files) {
  const incoming = [...(files || [])].filter(Boolean);
  if (!incoming.length) return;
  const accepted = [];
  for (const file of incoming) {
    if (state.pendingFiles.length + accepted.length >= MAX_QUEUE) {
      toast(`一次最多添加 ${MAX_QUEUE} 个附件`);
      break;
    }
    if (file.size > MAX_ATTACHMENT) {
      toast(`「${file.name}」超过 8 MB，已跳过`);
      continue;
    }
    accepted.push(file);
  }
  if (!accepted.length) return;
  state.pendingFiles = [...state.pendingFiles, ...accepted];
  renderAttachments();
}

function renderAttachments() {
  const files = state.pendingFiles;
  attachmentTray.hidden = !files.length;
  if (!files.length) {
    attachmentTray.innerHTML = '';
    return;
  }
  attachmentTray.innerHTML = files.map((file, index) => {
    const thumb = thumbFor(file);
    const visual = thumb
      ? (file.type.startsWith('video/')
        ? `<video src="${thumb}" muted preload="metadata"></video><i class="tray-badge">${icon('video')}</i>`
        : `<img src="${thumb}" alt="">`)
      : icon(file.type.startsWith('audio/') ? 'mic' : 'file');
    return `<div class="tray-item" title="${escapeHTML(file.name)}">
      <span class="tray-thumb">${visual}</span>
      <span class="tray-copy"><strong>${escapeHTML(file.name)}</strong><span>${formatSize(file.size)} · ${escapeHTML(file.type || '文件')}</span></span>
      <button type="button" data-remove-file="${index}" aria-label="移除">${icon('close')}</button>
    </div>`;
  }).join('');
}

function clearAttachments() {
  state.pendingFiles.forEach(releaseThumb);
  state.pendingFiles = [];
  fileInput.value = '';
  renderAttachments();
}

attachmentTray.addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove-file]');
  if (!remove) return;
  const index = Number(remove.dataset.removeFile);
  const [file] = state.pendingFiles.splice(index, 1);
  if (file) releaseThumb(file);
  renderAttachments();
});

fileInput.addEventListener('change', (event) => {
  addFiles(event.target.files);
  event.target.value = '';
});

/* Popovers: attachment menu and emoji picker ----------------------------- */

function closePopovers(except = null) {
  for (const [panel, trigger] of [[attachMenu, $('#attach-button')], [emojiPanel, $('#emoji-button')]]) {
    if (panel === except) continue;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
}

function togglePopover(panel, trigger) {
  const next = panel.hidden;
  closePopovers(next ? panel : null);
  panel.hidden = !next;
  trigger.setAttribute('aria-expanded', String(next));
  return next;
}

$('#attach-button').addEventListener('click', (event) => {
  event.stopPropagation();
  togglePopover(attachMenu, event.currentTarget);
});

attachMenu.addEventListener('click', (event) => {
  const pick = event.target.closest('[data-pick]');
  if (!pick) return;
  closePopovers();
  openFilePicker(pick.dataset.pick);
});

const EMOJI_GROUPS = [
  { key: 'recent', label: '最近', tab: '🕘', emojis: [] },
  { key: 'smiley', label: '表情', tab: '😀', emojis: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤗 🤭 🤫 🤔 🤐 😐 😑 😶 😏 😒 🙄 😬 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🥵 🥶 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 👻 👽 🤖 💩' },
  { key: 'gesture', label: '手势', tab: '👍', emojis: '👍 👎 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐 🖖 👋 🤝 🙏 💪 🦾 ✍️ 👏 🙌 👐 🤲 🫶 💅 👀 👁 👄 🫰 🫡 🤝' },
  { key: 'heart', label: '心情', tab: '❤️', emojis: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 💬 💭 💤 ✨ 🌟 ⭐ 🔥 🎉 🎊 🎈 🎁 🏆 🥇 🎯 🍀' },
  { key: 'animal', label: '动物', tab: '🐶', emojis: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🐙 🦑 🦀 🐟 🐬 🐳 🦈 🐊 🐆 🦓 🦍 🐘 🦛 🐪 🦒 🐇 🌸 🌻 🌵 🌊' },
  { key: 'food', label: '食物', tab: '🍎', emojis: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌽 🥕 🧄 🧅 🥔 🥐 🍞 🥖 🧀 🥚 🍳 🥞 🧇 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍣 🍱 🍤 🍙 🍚 🍢 🍡 🍧 🍨 🍦 🍰 🎂 🧁 🍫 🍬 🍭 🍮 🥛 ☕ 🍵 🧋 🍺 🍻 🥂 🍷' },
  { key: 'thing', label: '物品', tab: '💡', emojis: '⌚ 📱 💻 ⌨️ 🖥 🖨 🖱 💾 📷 📹 🎥 📞 ☎️ 📺 📻 🎙 ⏰ ⏳ 📡 🔋 🔌 💡 🔦 🕯 🧯 💸 💵 💰 💳 💎 ⚖️ 🔧 🔨 🛠 🔩 ⚙️ 🧰 🧲 💊 💉 🩹 🌡 🧹 🧺 🧻 🛁 🧼 🔑 🚪 🛋 🛏 🧸 🖼 🛍 🎒 👑 👓 🕶 📚 📖 📝 ✏️ 📌 📎 🗂 📅 📈 📉 🔍 🔒 🔓' },
  { key: 'symbol', label: '符号', tab: '✅', emojis: '✅ ❌ ⭕ ❗ ❓ ⚠️ 🚫 ♻️ ⚡ 🔔 🔕 🎵 🎶 ➕ ➖ ➗ ✖️ ♾ 💲 ™️ ©️ ®️ 🔢 🆕 🆓 🆗 🆙 🆘 ⬆️ ⬇️ ⬅️ ➡️ ↕️ ↔️ 🔄 🔃 🔙 🔚 🔛 🔜 🔝 ⏩ ⏪ ▶️ ◀️ ⏸ ⏹ ⏺ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟧 🟨 🟩 🟦 🟪' },
].map((group) => ({ ...group, emojis: Array.isArray(group.emojis) ? group.emojis : group.emojis.split(' ') }));

const RECENT_KEY = 'starpost-emoji-recent';
let emojiGroup = 'smiley';

function recentEmoji() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.slice(0, 32) : [];
  } catch {
    return [];
  }
}

function pushRecentEmoji(emoji) {
  const next = [emoji, ...recentEmoji().filter((item) => item !== emoji)].slice(0, 32);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private-mode storage failures should never break sending a message.
  }
}

function renderEmojiPanel() {
  $('#emoji-tabs').innerHTML = EMOJI_GROUPS.map((group) => `
    <button type="button" class="${group.key === emojiGroup ? 'active' : ''}" data-emoji-group="${group.key}" title="${group.label}">${group.tab}</button>
  `).join('');
  const group = EMOJI_GROUPS.find((item) => item.key === emojiGroup) || EMOJI_GROUPS[1];
  const emojis = group.key === 'recent' ? recentEmoji() : group.emojis;
  $('#emoji-grid').innerHTML = emojis.length
    ? emojis.map((emoji) => `<button type="button" data-emoji="${escapeHTML(emoji)}">${escapeHTML(emoji)}</button>`).join('')
    : '<p class="emoji-empty">还没有用过的表情</p>';
}

function insertEmoji(emoji) {
  const start = messageInput.selectionStart ?? messageInput.value.length;
  const end = messageInput.selectionEnd ?? start;
  messageInput.value = messageInput.value.slice(0, start) + emoji + messageInput.value.slice(end);
  const caret = start + emoji.length;
  messageInput.focus();
  messageInput.setSelectionRange(caret, caret);
  autoGrow();
  pushRecentEmoji(emoji);
}

$('#emoji-button').addEventListener('click', (event) => {
  event.stopPropagation();
  if (togglePopover(emojiPanel, event.currentTarget)) renderEmojiPanel();
});

emojiPanel.addEventListener('click', (event) => {
  event.stopPropagation();
  const tab = event.target.closest('[data-emoji-group]');
  if (tab) {
    emojiGroup = tab.dataset.emojiGroup;
    renderEmojiPanel();
    return;
  }
  const pick = event.target.closest('[data-emoji]');
  if (pick) {
    insertEmoji(pick.dataset.emoji);
    if (emojiGroup === 'recent') renderEmojiPanel();
  }
});

document.addEventListener('click', () => closePopovers());
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!attachMenu.hidden || !emojiPanel.hidden) {
    closePopovers();
    return;
  }
  if (!$('#lightbox').hidden) closeLightbox();
  else if (state.editing || state.replyTo) clearComposerContext();
});

/* Paste and drag-and-drop ------------------------------------------------ */

messageInput.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files || [])];
  if (!files.length) return;
  event.preventDefault();
  addFiles(files);
});

let dragDepth = 0;
const conversationEl = $('#conversation');
conversationEl.addEventListener('dragenter', (event) => {
  if (!state.activeId || !event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  dragDepth += 1;
  dropVeil.hidden = false;
});
conversationEl.addEventListener('dragover', (event) => {
  if (!state.activeId || !event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
conversationEl.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropVeil.hidden = true;
});
conversationEl.addEventListener('drop', (event) => {
  if (!state.activeId) return;
  event.preventDefault();
  dragDepth = 0;
  dropVeil.hidden = true;
  addFiles(event.dataTransfer?.files);
});

$('#record-button').addEventListener('click', async () => {
  if (state.mediaRecorder?.state === 'recording') {
    state.mediaRecorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('当前浏览器不支持语音录制');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type)) || '';
    state.mediaChunks = [];
    state.mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    state.mediaRecorder.addEventListener('dataavailable', (event) => { if (event.data.size) state.mediaChunks.push(event.data); });
    state.mediaRecorder.addEventListener('stop', () => {
      const blob = new Blob(state.mediaChunks, { type: state.mediaRecorder.mimeType || 'audio/webm' });
      const extension = blob.type.includes('mp4') ? 'm4a' : 'webm';
      addFiles([new File([blob], `语音留言-${Date.now()}.${extension}`, { type: blob.type })]);
      stream.getTracks().forEach((track) => track.stop());
      $('#record-button').classList.remove('recording');
      toast('录音完成，点击发送');
    });
    state.mediaRecorder.start();
    $('#record-button').classList.add('recording');
    toast('正在录音，再次点击结束');
  } catch {
    toast('无法使用麦克风，请检查浏览器权限');
  }
});

/* Lightbox --------------------------------------------------------------- */

const lightbox = $('#lightbox');
const lightboxCanvas = $('#lightbox-canvas');
const viewer = { items: [], index: 0, scale: 1, x: 0, y: 0, panning: false, originX: 0, originY: 0 };

function previewableMessages() {
  return state.messages.filter((message) => !message.deletedAt && message.attachment
    && ['image', 'video'].includes(mediaKind(message.attachment, message.kind)));
}

function openLightbox(messageId) {
  viewer.items = previewableMessages();
  const index = viewer.items.findIndex((item) => item.id === messageId);
  if (index < 0) return;
  viewer.index = index;
  lightbox.hidden = false;
  document.body.classList.add('lightbox-open');
  renderLightbox();
}

function closeLightbox() {
  lightbox.hidden = true;
  document.body.classList.remove('lightbox-open');
  lightboxCanvas.innerHTML = '';
  viewer.items = [];
}

function renderLightbox() {
  const message = viewer.items[viewer.index];
  if (!message) return closeLightbox();
  const url = appPath(message.attachment.url);
  const kind = mediaKind(message.attachment, message.kind);
  viewer.scale = 1;
  viewer.x = 0;
  viewer.y = 0;
  lightboxCanvas.innerHTML = kind === 'video'
    ? `<video src="${url}" controls playsinline></video>`
    : `<img src="${url}" alt="${escapeHTML(message.attachment.name)}" draggable="false">`;
  lightbox.classList.toggle('is-video', kind === 'video');
  $('#lightbox-name').textContent = message.attachment.name;
  $('#lightbox-meta').textContent = [
    message.sender.displayName,
    formatSize(message.attachment.size),
    `${viewer.index + 1} / ${viewer.items.length}`,
  ].join(' · ');
  const download = $('#lightbox-download');
  download.href = url;
  download.setAttribute('download', message.attachment.name);
  const multiple = viewer.items.length > 1;
  $('#lightbox-prev').hidden = !multiple;
  $('#lightbox-next').hidden = !multiple;
  $('#lightbox-strip').hidden = !multiple;
  applyViewerTransform();
  renderLightboxStrip();
}

function renderLightboxStrip() {
  $('#lightbox-strip').innerHTML = viewer.items.map((item, index) => {
    const url = appPath(item.attachment.url);
    const active = index === viewer.index ? ' class="active"' : '';
    const inner = mediaKind(item.attachment, item.kind) === 'video'
      ? `<video src="${url}" preload="metadata" muted></video>`
      : `<img src="${url}" alt="" loading="lazy">`;
    return `<button type="button" data-strip="${index}"${active}>${inner}</button>`;
  }).join('');
}

function applyViewerTransform() {
  const media = lightboxCanvas.firstElementChild;
  if (media) {
    media.style.transform = `translate(${viewer.x}px, ${viewer.y}px) scale(${viewer.scale})`;
    media.style.cursor = viewer.scale > 1 ? 'grab' : 'zoom-in';
  }
  $('#lightbox-scale').textContent = `${Math.round(viewer.scale * 100)}%`;
}

// Zoom keeps the point under the cursor anchored, which is what makes pinching
// into a detail of a screenshot feel right.
function zoomAt(nextScale, clientX, clientY) {
  const rect = lightboxCanvas.getBoundingClientRect();
  const scale = Math.min(6, Math.max(1, nextScale));
  const cx = clientX - rect.left - rect.width / 2;
  const cy = clientY - rect.top - rect.height / 2;
  const ratio = scale / viewer.scale;
  viewer.x = cx - ratio * (cx - viewer.x);
  viewer.y = cy - ratio * (cy - viewer.y);
  viewer.scale = scale;
  if (scale === 1) {
    viewer.x = 0;
    viewer.y = 0;
  }
  applyViewerTransform();
}

function stepLightbox(delta) {
  if (viewer.items.length < 2) return;
  viewer.index = (viewer.index + delta + viewer.items.length) % viewer.items.length;
  renderLightbox();
}

$('#lightbox-close').addEventListener('click', closeLightbox);
$('#lightbox-prev').addEventListener('click', () => stepLightbox(-1));
$('#lightbox-next').addEventListener('click', () => stepLightbox(1));
$('#lightbox-zoom-in').addEventListener('click', () => zoomAt(viewer.scale * 1.4, innerWidth / 2, innerHeight / 2));
$('#lightbox-zoom-out').addEventListener('click', () => zoomAt(viewer.scale / 1.4, innerWidth / 2, innerHeight / 2));
$('#lightbox-reset').addEventListener('click', () => zoomAt(1, innerWidth / 2, innerHeight / 2));
$('#lightbox-strip').addEventListener('click', (event) => {
  const pick = event.target.closest('[data-strip]');
  if (!pick) return;
  viewer.index = Number(pick.dataset.strip);
  renderLightbox();
});

// The media element fills the stage and letterboxes itself, so "did the click
// land on the picture?" has to be answered from the contained rectangle.
function pointInMedia(event) {
  const media = lightboxCanvas.firstElementChild;
  if (!media) return false;
  const rect = media.getBoundingClientRect();
  const natural = media.tagName === 'IMG'
    ? { width: media.naturalWidth, height: media.naturalHeight }
    : { width: media.videoWidth || 16, height: media.videoHeight || 9 };
  if (!natural.width || !natural.height) return true;
  const ratio = Math.min(rect.width / natural.width, rect.height / natural.height);
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  return Math.abs(event.clientX - centerX) <= (natural.width * ratio) / 2
    && Math.abs(event.clientY - centerY) <= (natural.height * ratio) / 2;
}

$('#lightbox-stage').addEventListener('click', (event) => {
  if (event.target.closest('button, a')) return;
  if (!pointInMedia(event)) closeLightbox();
});
lightboxCanvas.addEventListener('dblclick', (event) => {
  zoomAt(viewer.scale > 1 ? 1 : 2.5, event.clientX, event.clientY);
});
lightboxCanvas.addEventListener('wheel', (event) => {
  if (lightbox.hidden) return;
  event.preventDefault();
  zoomAt(viewer.scale * (event.deltaY < 0 ? 1.18 : 1 / 1.18), event.clientX, event.clientY);
}, { passive: false });
lightboxCanvas.addEventListener('pointerdown', (event) => {
  if (viewer.scale <= 1 || event.target.tagName === 'VIDEO') return;
  viewer.panning = true;
  viewer.originX = event.clientX - viewer.x;
  viewer.originY = event.clientY - viewer.y;
  lightboxCanvas.setPointerCapture(event.pointerId);
});
lightboxCanvas.addEventListener('pointermove', (event) => {
  if (!viewer.panning) return;
  viewer.x = event.clientX - viewer.originX;
  viewer.y = event.clientY - viewer.originY;
  applyViewerTransform();
});
for (const type of ['pointerup', 'pointercancel']) {
  lightboxCanvas.addEventListener(type, () => { viewer.panning = false; });
}
document.addEventListener('keydown', (event) => {
  if (lightbox.hidden) return;
  if (event.key === 'ArrowLeft') stepLightbox(-1);
  else if (event.key === 'ArrowRight') stepLightbox(1);
  else if (event.key === '+' || event.key === '=') zoomAt(viewer.scale * 1.4, innerWidth / 2, innerHeight / 2);
  else if (event.key === '-') zoomAt(viewer.scale / 1.4, innerWidth / 2, innerHeight / 2);
});

function renderDetail() {
  const detail = state.activeDetail;
  if (!detail) return;
  const summary = state.conversations.find((item) => item.id === state.activeId);
  const title = summary?.title || detail.conversation.title || '会话';
  const peer = detail.conversation.kind === 'dm'
    ? detail.members.find((member) => member.id !== state.user.id)
    : null;
  const isGroup = detail.conversation.kind === 'group';
  const me = detail.members.find((member) => member.id === state.user.id);
  const manages = isGroup && ['owner', 'admin'].includes(me?.memberRole);
  const isOwner = isGroup && me?.memberRole === 'owner';
  $('#detail-content').innerHTML = `
    <div class="detail-hero">
      ${avatarHTML(peer, title, isGroup ? 'group' : '')}
      <h3>${escapeHTML(title)}</h3>
      <p>${isGroup ? `${detail.members.length} 位成员` : `@${escapeHTML(peer?.username || '')}`}</p>
      ${isGroup && manages ? `<button class="ghost-button" type="button" data-detail-action="rename">${icon('edit')}<span>修改群名</span></button>` : ''}
    </div>
    ${isGroup ? `<div class="section-caption">成员 <b>${detail.members.length}</b></div>` : '<div class="section-caption">对话成员</div>'}
    <div class="member-list">${detail.members.map((member) => {
      // Roles only mean something in a group; a DM has no owner to advertise.
      const role = !isGroup ? '' : member.memberRole === 'owner' ? '群主' : member.memberRole === 'admin' ? '管理员' : '';
      const removable = manages && member.id !== state.user.id && member.memberRole !== 'owner';
      return `<div class="member-line">
        ${avatarHTML(member, member.displayName)}
        <div><strong>${escapeHTML(member.displayName)}</strong><span>@${escapeHTML(member.username)}${role ? ` · ${role}` : ''}</span></div>
        ${removable ? `<button class="line-action" type="button" data-remove-member="${escapeHTML(member.id)}" data-name="${escapeHTML(member.displayName)}" title="移出群组">${icon('user-minus')}</button>` : ''}
      </div>`;
    }).join('')}</div>
    <div class="detail-actions">
      ${manages ? `<button class="ghost-button" type="button" data-detail-action="invite">${icon('user-plus')}<span>邀请好友入群</span></button>` : ''}
      ${isGroup && !isOwner ? `<button class="ghost-button danger" type="button" data-detail-action="leave">${icon('exit')}<span>退出群组</span></button>` : ''}
      ${isOwner ? `<button class="ghost-button danger" type="button" data-detail-action="disband">${icon('trash')}<span>解散群组</span></button>` : ''}
      ${!isGroup && peer ? `<button class="ghost-button danger" type="button" data-detail-action="block" data-user="${escapeHTML(peer.id)}">${icon('ban')}<span>拉黑 ${escapeHTML(peer.displayName)}</span></button>` : ''}
    </div>`;
}

$('#detail-content').addEventListener('click', async (event) => {
  const remove = event.target.closest('[data-remove-member]');
  if (remove) {
    if (!confirm(`把 ${remove.dataset.name} 移出群组？`)) return;
    try {
      await api(`/api/conversations/${state.activeId}/members/${remove.dataset.removeMember}`, { method: 'DELETE' });
      await refreshActiveDetail();
      toast('成员已移出');
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  const action = event.target.closest('[data-detail-action]')?.dataset.detailAction;
  if (!action) return;
  try {
    if (action === 'rename') {
      const title = prompt('新的群组名称', state.activeDetail?.conversation.title || '');
      if (!title?.trim()) return;
      await api(`/api/conversations/${state.activeId}`, { method: 'PATCH', body: { title: title.trim() } });
      await refreshActiveDetail();
      await loadConversations();
      toast('群名已更新');
    } else if (action === 'invite') {
      openInviteDialog();
    } else if (action === 'leave') {
      if (!confirm('退出这个群组？')) return;
      await api(`/api/conversations/${state.activeId}/members/${state.user.id}`, { method: 'DELETE' });
      await leaveActiveConversation('已退出群组');
    } else if (action === 'disband') {
      if (!confirm('解散群组？所有消息和附件都会被删除。')) return;
      await api(`/api/conversations/${state.activeId}`, { method: 'DELETE' });
      await leaveActiveConversation('群组已解散');
    } else if (action === 'block') {
      if (!confirm('拉黑后你们将无法互发消息，确定继续？')) return;
      await api('/api/friends/block', { method: 'POST', body: { userId: event.target.closest('[data-detail-action]').dataset.user } });
      await loadFriends();
      toast('已拉黑');
    }
  } catch (error) {
    toast(error.message);
  }
});

async function refreshActiveDetail() {
  // Nothing to refresh until the detail panel has actually pulled members.
  if (!state.activeId || !state.activeDetail) return;
  try {
    state.activeDetail = await api(`/api/conversations/${state.activeId}`);
    const summary = state.conversations.find((item) => item.id === state.activeId);
    $('#chat-title').textContent = summary?.title || state.activeDetail.conversation.title || '会话';
    renderDetail();
  } catch {
    // The conversation may have disappeared underneath us; the list refresh handles it.
  }
}

async function leaveActiveConversation(message) {
  closeSocket();
  historyCache.delete(state.activeId);
  state.activeId = null;
  state.activeDetail = null;
  state.messages = [];
  conversationActive.hidden = true;
  conversationEmpty.hidden = false;
  appView.classList.remove('mobile-chat-open', 'detail-open');
  $('#detail-panel').hidden = true;
  await loadConversations();
  toast(message);
}

function openInviteDialog() {
  const present = new Set((state.activeDetail?.members || []).map((member) => member.id));
  const candidates = state.friends.friends.filter((person) => !present.has(person.id));
  if (!candidates.length) return toast('没有可邀请的好友了');
  $('#invite-member-picker').innerHTML = candidates.map((person) => `
    <label class="pick-line">${avatarHTML(person, person.displayName)}<span><strong>${escapeHTML(person.displayName)}</strong><br><small>@${escapeHTML(person.username)}</small></span><input type="checkbox" name="invite-member" value="${escapeHTML(person.id)}"></label>
  `).join('');
  $('#invite-dialog').showModal();
}

$('#invite-submit').addEventListener('click', async () => {
  const ids = $$('input[name="invite-member"]:checked', $('#invite-form')).map((input) => input.value);
  if (!ids.length) return toast('请至少选择一位好友');
  setButtonBusy($('#invite-submit'), true);
  try {
    for (const id of ids) {
      await api(`/api/conversations/${state.activeId}/members`, { method: 'POST', body: { userId: id } });
    }
    $('#invite-dialog').close();
    await refreshActiveDetail();
    toast('已加入群组');
  } catch (error) {
    toast(error.message);
  } finally {
    setButtonBusy($('#invite-submit'), false);
  }
});

$('#chat-details-button').addEventListener('click', async () => {
  $('#detail-panel').hidden = false;
  appView.classList.add('detail-open');
  if (!state.activeDetail) {
    $('#detail-content').innerHTML = '<div class="list-empty"><span>正在加载…</span></div>';
    try {
      await ensureDetail();
    } catch (error) {
      $('#detail-content').innerHTML = `<div class="list-empty"><span>${escapeHTML(error.message)}</span></div>`;
      return;
    }
  }
  renderDetail();
});
$('#detail-close').addEventListener('click', () => {
  $('#detail-panel').hidden = true;
  appView.classList.remove('detail-open');
});
$('#mobile-back').addEventListener('click', () => appView.classList.remove('mobile-chat-open'));

$('#new-group-button').addEventListener('click', () => {
  if (!state.friends.friends.length) return toast('先添加至少一位好友');
  $('#group-member-picker').innerHTML = state.friends.friends.map((person) => `
    <label class="pick-line">${avatarHTML(person, person.displayName)}<span><strong>${escapeHTML(person.displayName)}</strong><br><small>@${escapeHTML(person.username)}</small></span><input type="checkbox" name="member" value="${person.id}"></label>
  `).join('');
  $('#group-form').reset();
  $('#group-dialog').showModal();
});

$('#group-submit').addEventListener('click', async () => {
  const form = $('#group-form');
  const title = form.elements.title.value.trim();
  const memberIds = $$('input[name="member"]:checked', form).map((input) => input.value);
  if (!title || !memberIds.length) return toast('填写群名并选择至少一位好友');
  setButtonBusy($('#group-submit'), true);
  try {
    resetPresence();
    const data = await api('/api/conversations/group', { method: 'POST', body: { title, memberIds } });
    $('#group-dialog').close();
    await loadConversations();
    await openConversation(data.id);
  } catch (error) {
    toast(error.message);
  } finally {
    setButtonBusy($('#group-submit'), false);
  }
});

function openProfile() {
  setAvatar($('#profile-avatar'), state.user, state.user.displayName);
  $('#profile-username').textContent = `@${state.user.username}`;
  $('#profile-role').textContent = state.user.role === 'admin' ? '站点管理员' : '成员';
  $('#avatar-remove-button').hidden = !state.user.avatarUrl;
  $('#profile-form').elements.displayName.value = state.user.displayName;
  $('#profile-form').elements.bio.value = state.user.bio || '';
  $('#profile-dialog').showModal();
}

function syncCurrentUserAvatar() {
  setAvatar($('#rail-avatar'), state.user, state.user.displayName);
  setAvatar($('#profile-avatar'), state.user, state.user.displayName);
  $('#avatar-remove-button').hidden = !state.user.avatarUrl;
  const activeMember = state.activeDetail?.members?.find((member) => member.id === state.user.id);
  if (activeMember) Object.assign(activeMember, { avatarUrl: state.user.avatarUrl, displayName: state.user.displayName });
  if (state.activeId) {
    closeSocket();
    connectSocket();
  }
}

function imageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法读取这张图片'));
    };
    image.src = url;
  });
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function prepareAvatar(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('请选择 JPEG、PNG 或 WebP 图片');
  }
  if (file.size > 20 * 1024 * 1024) throw new Error('原图不能超过 20 MB');
  const image = await imageFromFile(file);
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext('2d', { alpha: false });
  const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
  const sourceX = (image.naturalWidth - sourceSize) / 2;
  const sourceY = (image.naturalHeight - sourceSize) / 2;
  context.fillStyle = '#f7f5fb';
  context.fillRect(0, 0, 512, 512);
  context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, 512, 512);
  const webp = await canvasBlob(canvas, 'image/webp', 0.86);
  const result = webp?.type === 'image/webp' ? webp : await canvasBlob(canvas, 'image/jpeg', 0.88);
  if (!result) throw new Error('当前浏览器无法处理头像');
  if (result.size > 2 * 1024 * 1024) throw new Error('处理后的头像仍超过 2 MB');
  return result;
}

$('#avatar-upload-button').addEventListener('click', () => $('#avatar-input').click());
$('#avatar-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const button = $('#avatar-upload-button');
  button.disabled = true;
  try {
    const avatar = await prepareAvatar(file);
    const data = await api('/api/profile/avatar', {
      method: 'POST',
      headers: { 'Content-Type': avatar.type },
      body: await avatar.arrayBuffer(),
    });
    state.user = data.user;
    syncCurrentUserAvatar();
    toast('头像已更新');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

$('#avatar-remove-button').addEventListener('click', async () => {
  if (!confirm('移除当前头像？')) return;
  try {
    const data = await api('/api/profile/avatar', { method: 'DELETE' });
    state.user = data.user;
    syncCurrentUserAvatar();
    toast('头像已移除');
  } catch (error) {
    toast(error.message);
  }
});

$('#profile-save').addEventListener('click', async () => {
  const form = $('#profile-form');
  setButtonBusy($('#profile-save'), true);
  try {
    const data = await api('/api/profile', { method: 'PATCH', body: {
      displayName: form.elements.displayName.value,
      bio: form.elements.bio.value,
    } });
    state.user = data.user;
    syncCurrentUserAvatar();
    $('#profile-dialog').close();
    toast('个人资料已保存');
  } catch (error) {
    toast(error.message);
  } finally {
    setButtonBusy($('#profile-save'), false);
  }
});

$('#password-save').addEventListener('click', async () => {
  const form = $('#profile-form');
  const currentPassword = form.elements.currentPassword.value;
  const newPassword = form.elements.newPassword.value;
  if (!currentPassword || newPassword.length < 6) {
    return toast('请填写当前密码，新密码至少 6 位');
  }
  setButtonBusy($('#password-save'), true);
  try {
    await api('/api/password', {
      method: 'PATCH',
      body: { currentPassword, newPassword },
    });
    form.elements.currentPassword.value = '';
    form.elements.newPassword.value = '';
    toast('密码已更新，其他设备会退出登录');
  } catch (error) {
    toast(error.message);
  } finally {
    setButtonBusy($('#password-save'), false);
  }
});

$('#logout-button').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  closeSocket();
  location.reload();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.user) return;
  // Coming back to the tab is the moment the messages were really seen.
  if (state.activeId) markRead().then(loadConversations);
  else loadConversations().catch(() => {});
});
window.addEventListener('beforeunload', closeSocket);

init();
