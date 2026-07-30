const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const APP_BASE = location.pathname === '/starpost-app' || location.pathname.startsWith('/starpost-app/')
  ? '/starpost-app'
  : '';
const appPath = (path) => path.startsWith('/') ? `${APP_BASE}${path}` : path;

const state = {
  user: null,
  friends: { friends: [], incoming: [], outgoing: [], blocked: [] },
  conversations: [],
  activeId: null,
  activeDetail: null,
  messages: [],
  ws: null,
  reconnectTimer: null,
  manualClose: false,
  pendingFile: null,
  mediaRecorder: null,
  mediaChunks: [],
  typingTimer: null,
  activeView: 'chats',
  onlineUsers: [],
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
}

async function loadFriends() {
  state.friends = await api('/api/friends');
  const count = state.friends.incoming.length;
  $('#rail-requests').hidden = count === 0;
}

async function loadConversations() {
  const data = await api('/api/conversations');
  state.conversations = data.conversations;
  const unread = state.conversations.reduce((sum, item) => sum + item.unread, 0);
  $('#rail-unread').hidden = unread === 0;
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
    const preview = item.lastMessage
      ? (item.lastMessage.kind === 'text' ? item.lastMessage.body : { image: '[图片]', audio: '[语音]', file: '[文件]' }[item.lastMessage.kind] || '[消息]')
      : '开始一段对话';
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
  sidebarContent.innerHTML = chunks.join('') || `<div class="list-empty">${icon('users')}<span>搜索用户名并发送好友申请</span></div>`;
}

function personHTML(person, relation) {
  let actions = '';
  if (relation === 'incoming') {
    actions = `<button data-friend-action="accept" data-request-id="${person.requestId}" title="接受">${icon('check')}</button><button data-friend-action="reject" data-request-id="${person.requestId}" title="拒绝">${icon('close')}</button>`;
  } else if (relation === 'friend') {
    actions = `<button data-dm-user="${person.id}" title="发消息">${icon('chat')}</button>`;
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

async function openConversation(id) {
  if (state.activeId === id && state.ws?.readyState === WebSocket.OPEN) {
    appView.classList.add('mobile-chat-open');
    return;
  }
  closeSocket();
  state.activeId = id;
  state.onlineUsers = [];
  updatePresence({ membersOnline: 0, onlineUsers: [] });
  renderChats();
  conversationEmpty.hidden = true;
  conversationActive.hidden = false;
  appView.classList.add('mobile-chat-open');
  messagesEl.innerHTML = '<button class="history-button" id="history-button" type="button" hidden>加载更早消息</button><div class="list-empty"><span>正在加载消息…</span></div>';
  try {
    const [detail, history] = await Promise.all([
      api(`/api/conversations/${id}`),
      api(`/api/conversations/${id}/messages`),
    ]);
    state.activeDetail = detail;
    state.messages = history.messages;
    const summary = state.conversations.find((item) => item.id === id);
    $('#chat-title').textContent = summary?.title || detail.conversation.title || '会话';
    const peer = detail.conversation.kind === 'dm'
      ? detail.members.find((member) => member.id !== state.user.id)
      : null;
    setAvatar($('#chat-avatar'), peer, $('#chat-title').textContent);
    $('#chat-avatar').classList.toggle('group', detail.conversation.kind === 'group');
    renderMessages();
    renderDetail();
    connectSocket();
    markRead();
  } catch (error) {
    toast(error.message);
    conversationActive.hidden = true;
    conversationEmpty.hidden = false;
  }
}

function renderMessages({ preserveScroll = false } = {}) {
  const previousHeight = messagesEl.scrollHeight;
  const previousTop = messagesEl.scrollTop;
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
  else messagesEl.scrollTop = messagesEl.scrollHeight;
}

function messageHTML(message) {
  const own = message.sender.id === state.user.id;
  const deleted = !!message.deletedAt;
  let attachment = '';
  if (message.attachment && !deleted) {
    const attachmentURL = appPath(message.attachment.url);
    if (message.kind === 'image') {
      attachment = `<a class="message-attachment" href="${attachmentURL}" target="_blank"><img src="${attachmentURL}" alt="${escapeHTML(message.attachment.name)}" loading="lazy"></a>`;
    } else if (message.kind === 'audio') {
      attachment = `<div class="message-attachment"><audio controls preload="metadata" src="${attachmentURL}"></audio></div>`;
    } else {
      attachment = `<a class="message-attachment file-card" href="${attachmentURL}" target="_blank">${icon('file')}<div><strong>${escapeHTML(message.attachment.name)}</strong><span>${formatSize(message.attachment.size)}</span></div></a>`;
    }
  }
  const actions = own && !deleted ? `<span class="message-actions"><button data-edit-message="${message.id}" title="编辑">${icon('edit')}</button><button data-delete-message="${message.id}" title="撤回">${icon('trash')}</button></span>` : '';
  return `<div class="message-row ${own ? 'own' : ''}" data-message-id="${message.id}">
    ${!own ? `<span class="message-avatar">${avatarContent(message.sender, message.sender.displayName)}</span>` : actions}
    <div class="message-stack">
      ${!own ? `<p class="message-sender">${escapeHTML(message.sender.displayName)}</p>` : ''}
      <div class="message-bubble ${deleted ? 'deleted' : ''}">
        ${attachment}
        <div class="message-text">${deleted ? '消息已撤回' : escapeHTML(message.body)}</div>
        <div class="message-meta">${message.editedAt ? '<span>已编辑</span>' : ''}<time>${formatFullTime(message.createdAt)}</time></div>
      </div>
    </div>
    ${own ? '' : actions}
  </div>`;
}

messagesEl.addEventListener('click', async (event) => {
  if (event.target.closest('#history-button')) return loadOlderMessages();
  const edit = event.target.closest('[data-edit-message]');
  if (edit) {
    const message = state.messages.find((item) => item.id === edit.dataset.editMessage);
    const value = prompt('编辑消息', message?.body || '');
    if (!value?.trim() || value.trim() === message?.body) return;
    try {
      await api(`/api/messages/${message.id}`, { method: 'PATCH', body: { body: value.trim() } });
    } catch (error) {
      toast(error.message);
    }
  }
  const remove = event.target.closest('[data-delete-message]');
  if (remove && confirm('撤回这条消息？')) {
    try {
      await api(`/api/messages/${remove.dataset.deleteMessage}`, { method: 'DELETE' });
    } catch (error) {
      toast(error.message);
    }
  }
});

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
    renderMessages({ preserveScroll: true });
  } catch (error) {
    toast(error.message);
  }
}

function updatePresence(data) {
  state.onlineUsers = Array.isArray(data.onlineUsers) ? data.onlineUsers : [];
  const count = Number(data.membersOnline) || state.onlineUsers.length || 0;
  $('#chat-status').textContent = count ? `${count} 人在线` : '已连接';
  $('#chat-status').classList.add('connected');
  $('#online-count').textContent = String(count);
  $('#online-button').hidden = !count || !state.onlineUsers.length;
}

function renderOnlineList() {
  const members = new Map((state.activeDetail?.members || []).map((member) => [member.id, member]));
  $('#online-list').innerHTML = state.onlineUsers.map((presence) => {
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
  }).join('') || '<div class="list-empty"><span>暂时没有其他人在线</span></div>';
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
        renderMessages();
        markRead();
        loadConversations();
      }
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
    $('#online-button').hidden = true;
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
  $('#online-button').hidden = true;
}

$('#online-button').addEventListener('click', () => {
  renderOnlineList();
  $('#online-dialog').showModal();
});

async function markRead() {
  const last = state.messages.at(-1);
  if (!last || !state.activeId) return;
  try {
    await api(`/api/conversations/${state.activeId}/read`, { method: 'POST', body: { seq: last.seq } });
    const summary = state.conversations.find((item) => item.id === state.activeId);
    if (summary) summary.unread = 0;
    renderChats();
  } catch {
    // Reading markers are best effort.
  }
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
  if (!state.activeId || state.ws?.readyState !== WebSocket.OPEN) return toast('聊天连接尚未就绪');
  const body = messageInput.value.trim();
  if (!body && !state.pendingFile) return;
  const submit = $('.send-button', event.currentTarget);
  submit.disabled = true;
  try {
    let attachment = null;
    let kind = 'text';
    if (state.pendingFile) {
      const file = state.pendingFile;
      attachment = await uploadFile(file);
      kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : 'file';
    }
    state.ws.send(JSON.stringify({
      type: 'message',
      conversationId: state.activeId,
      body,
      kind,
      attachmentId: attachment?.id || null,
    }));
    messageInput.value = '';
    autoGrow();
    clearAttachment();
  } catch (error) {
    toast(error.message);
  } finally {
    submit.disabled = false;
  }
});

async function uploadFile(file) {
  const result = await api(`/api/conversations/${state.activeId}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    body: await file.arrayBuffer(),
  });
  return result.attachment;
}

$('#attach-button').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return toast('附件不能超过 8 MB');
  setAttachment(file);
});
function setAttachment(file) {
  state.pendingFile = file;
  $('#attachment-preview').hidden = false;
  $('#attachment-name').textContent = file.name;
  $('#attachment-size').textContent = `${formatSize(file.size)} · ${file.type || '文件'}`;
}
function clearAttachment() {
  state.pendingFile = null;
  $('#file-input').value = '';
  $('#attachment-preview').hidden = true;
}
$('#attachment-clear').addEventListener('click', clearAttachment);

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
      setAttachment(new File([blob], `语音留言-${Date.now()}.${extension}`, { type: blob.type }));
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

function renderDetail() {
  const detail = state.activeDetail;
  if (!detail) return;
  const summary = state.conversations.find((item) => item.id === state.activeId);
  const title = summary?.title || detail.conversation.title || '会话';
  const peer = detail.conversation.kind === 'dm'
    ? detail.members.find((member) => member.id !== state.user.id)
    : null;
  $('#detail-content').innerHTML = `
    <div class="detail-hero">
      ${avatarHTML(peer, title, detail.conversation.kind === 'group' ? 'group' : '')}
      <h3>${escapeHTML(title)}</h3>
      <p>${detail.conversation.kind === 'group' ? `${detail.members.length} 位成员` : '私人对话'}</p>
    </div>
    <div class="section-caption">成员</div>
    <div class="member-list">${detail.members.map((member) => `
      <div class="member-line">${avatarHTML(member, member.displayName)}<div><strong>${escapeHTML(member.displayName)}</strong><span>@${escapeHTML(member.username)}${member.memberRole !== 'member' ? ` · ${member.memberRole === 'owner' ? '群主' : '管理员'}` : ''}</span></div></div>
    `).join('')}</div>`;
}

$('#chat-details-button').addEventListener('click', () => {
  $('#detail-panel').hidden = false;
  appView.classList.add('detail-open');
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
  if (!currentPassword || newPassword.length < 10) {
    return toast('请填写当前密码，新密码至少 10 位');
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

window.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.activeId) markRead();
});
window.addEventListener('beforeunload', closeSocket);

init();
