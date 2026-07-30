const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const content = $('#admin-content');
let currentView = 'overview';
let users = [];
let conversations = [];

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function initials(name) { return [...String(name || 'U').trim()][0]?.toUpperCase() || 'U'; }
function formatTime(value) { return value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }
function formatSize(bytes) { return bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `请求失败（${response.status}）`);
  return data;
}
function toast(message) {
  const el = $('#admin-toast'); el.textContent = message; el.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 2600);
}
async function init() {
  const session = await api('/api/session').catch(() => ({ user: null }));
  if (!session.user) return location.replace('/');
  if (session.user.role !== 'admin') return location.replace('/');
  $('#admin-identity').textContent = `${session.user.displayName} · 管理员`;
  showView('overview');
}
const meta = {
  overview: ['Operations', '运行总览'],
  users: ['Members', '用户管理'],
  conversations: ['Moderation', '会话审查'],
  invites: ['Registration', '邀请码'],
};
async function showView(view) {
  currentView = view;
  $$('[data-admin-view]').forEach((button) => button.classList.toggle('active', button.dataset.adminView === view));
  $('#admin-eyebrow').textContent = meta[view][0];
  $('#admin-title').textContent = meta[view][1];
  content.innerHTML = '<div class="panel"><div class="panel-head"><p>正在加载…</p></div></div>';
  try {
    if (view === 'overview') await renderOverview();
    if (view === 'users') await renderUsers();
    if (view === 'conversations') await renderConversations();
    if (view === 'invites') await renderInvites();
  } catch (error) {
    content.innerHTML = `<div class="panel"><div class="panel-head"><p>${escapeHTML(error.message)}</p></div></div>`;
  }
}
$$('[data-admin-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.adminView)));
async function renderOverview() {
  const data = await api('/api/admin/stats');
  content.innerHTML = `<div class="stat-grid">
    ${stat('注册用户', data.users)}${stat('群组', data.groups)}${stat('消息记录', data.messages)}${stat('附件空间', formatSize(data.attachmentBytes))}
  </div>
  <section class="panel"><div class="panel-head"><div><h2>管理边界</h2><p>这里可以访问未端到端加密的全部会话内容。</p></div></div>
  <div style="padding:20px;color:var(--muted);line-height:1.8">管理员操作会写入审计日志。仅在处理举报、安全事件或数据维护时查看私人会话，并确保所有用户已知晓站点的内容管理政策。</div></section>`;
}
function stat(label, value) { return `<article class="stat-card"><span>${label}</span><strong>${value}</strong></article>`; }
async function renderUsers(query = '') {
  const data = await api(`/api/admin/users?q=${encodeURIComponent(query)}`);
  users = data.users;
  content.innerHTML = `<section class="panel">
    <div class="panel-head"><div><h2>全部用户</h2><p>${users.length} 个结果</p></div><label class="search-box"><svg><use href="#i-search"/></svg><input id="user-search" value="${escapeHTML(query)}" placeholder="搜索用户名或昵称"></label></div>
    <div class="data-list"><div class="data-row head"><span>用户</span><span>权限</span><span>状态</span><span>操作</span></div>
      ${users.map(userRow).join('') || '<div style="padding:25px;color:var(--muted)">没有用户</div>'}
    </div></section>`;
  let timer;
  $('#user-search').addEventListener('input', (event) => { clearTimeout(timer); timer = setTimeout(() => renderUsers(event.target.value), 280); });
}
function userRow(user) {
  return `<div class="data-row" data-user-id="${user.id}">
    <div class="user-cell"><span class="avatar">${escapeHTML(initials(user.displayName))}</span><span class="cell-main"><strong>${escapeHTML(user.displayName)}</strong><span>@${escapeHTML(user.username)} · ${formatTime(user.createdAt)}</span></span></div>
    <span>${user.role === 'admin' ? '管理员' : '成员'}</span>
    <span class="status ${user.status === 'banned' ? 'banned' : ''}">${user.status === 'banned' ? '已停用' : '正常'}</span>
    <span class="row-actions"><button data-user-role="${user.role === 'admin' ? 'user' : 'admin'}">${user.role === 'admin' ? '降为成员' : '设为管理员'}</button><button data-user-status="${user.status === 'banned' ? 'active' : 'banned'}">${user.status === 'banned' ? '恢复' : '停用'}</button></span>
  </div>`;
}
content.addEventListener('click', async (event) => {
  const row = event.target.closest('[data-user-id]');
  const status = event.target.closest('[data-user-status]');
  const role = event.target.closest('[data-user-role]');
  if (row && (status || role)) {
    const body = status ? { status: status.dataset.userStatus } : { role: role.dataset.userRole };
    if (status?.dataset.userStatus === 'banned' && !confirm('停用该账号并注销其全部会话？')) return;
    try {
      await api(`/api/admin/users/${row.dataset.userId}`, { method: 'PATCH', body });
      toast('用户状态已更新'); await renderUsers($('#user-search')?.value || '');
    } catch (error) { toast(error.message); }
  }
  const review = event.target.closest('[data-review-conversation]');
  if (review) openMessages(review.dataset.reviewConversation, review.dataset.title);
  const copy = event.target.closest('[data-copy-code]');
  if (copy) { await navigator.clipboard.writeText(copy.dataset.copyCode); toast('邀请码已复制'); }
  const removeInvite = event.target.closest('[data-delete-invite]');
  if (removeInvite && confirm('删除这个邀请码？')) {
    await api(`/api/admin/invitations/${encodeURIComponent(removeInvite.dataset.deleteInvite)}`, { method: 'DELETE' });
    toast('邀请码已删除'); renderInvites();
  }
});
async function renderConversations() {
  const data = await api('/api/admin/conversations');
  conversations = data.conversations;
  content.innerHTML = `<section class="panel"><div class="panel-head"><div><h2>全部会话</h2><p>管理员可查看群组和私人对话的服务端记录。</p></div></div>
    <div class="data-list"><div class="data-row head"><span>会话</span><span>类型</span><span>规模</span><span>操作</span></div>
    ${conversations.map((item) => `<div class="data-row">
      <span class="cell-main"><strong>${escapeHTML(item.title || (item.kind === 'dm' ? '私人对话' : '未命名群组'))}</strong><span>${escapeHTML(item.last_body || '暂无消息')}</span></span>
      <span>${item.kind === 'group' ? '群组' : '私聊'}</span><span>${item.member_count} 人 · ${item.message_count} 条</span>
      <span class="row-actions"><button data-review-conversation="${item.id}" data-title="${escapeHTML(item.title || '私人对话')}">查看消息</button></span>
    </div>`).join('') || '<div style="padding:25px;color:var(--muted)">暂无会话</div>'}</div></section>`;
}
async function openMessages(id, title) {
  $('#message-dialog-title').textContent = title;
  $('#message-dialog-list').innerHTML = '<p class="muted">正在加载…</p>';
  $('#message-dialog').showModal();
  try {
    const data = await api(`/api/admin/conversations/${id}/messages`);
    $('#message-dialog-list').innerHTML = data.messages.map((message) => `<div class="review-message" data-review-message="${message.id}">
      <span class="sender">${escapeHTML(message.sender.displayName)}</span>
      <span class="body">${message.deletedAt ? '<em class="muted">消息已撤回</em>' : escapeHTML(message.body || `[${message.kind}] ${message.attachment?.name || ''}`)}</span>
      <span><time>${formatTime(message.createdAt)}</time>${message.deletedAt ? '' : `<button data-admin-delete-message="${message.id}" title="删除"><svg><use href="#i-trash"/></svg></button>`}</span>
    </div>`).join('') || '<p class="muted">暂无消息</p>';
  } catch (error) { $('#message-dialog-list').innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`; }
}
$('#message-dialog-close').addEventListener('click', () => $('#message-dialog').close());
$('#message-dialog-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-admin-delete-message]');
  if (!button || !confirm('从会话中删除这条消息？')) return;
  try {
    await api(`/api/messages/${button.dataset.adminDeleteMessage}`, { method: 'DELETE' });
    event.target.closest('[data-review-message]').remove(); toast('消息已删除');
  } catch (error) { toast(error.message); }
});
async function renderInvites() {
  const data = await api('/api/admin/invitations');
  content.innerHTML = `<section class="panel">
    <div class="panel-head"><div><h2>邀请码</h2><p>注册码仅在创建时显示一次。</p></div></div>
    <form class="invite-form" id="invite-form"><input name="label" maxlength="60" placeholder="备注，例如：项目组"><input name="maxUses" type="number" min="1" max="100" value="1" aria-label="可用次数"><input name="days" type="number" min="1" max="365" value="7" aria-label="有效天数"><button class="primary-button" type="submit">生成邀请码</button></form>
    <div id="latest-code"></div>
    <div class="data-list"><div class="data-row head"><span>备注</span><span>使用情况</span><span>到期时间</span><span>操作</span></div>
    ${data.invitations.map((item) => `<div class="data-row"><span class="cell-main"><strong>${escapeHTML(item.label || '未命名邀请')}</strong><span>由 ${escapeHTML(item.creator)} 创建</span></span><span>${item.uses} / ${item.maxUses}</span><span>${formatTime(item.expiresAt)}</span><span class="row-actions"><button data-delete-invite="${item.hash}">删除</button></span></div>`).join('') || '<div style="padding:25px;color:var(--muted)">暂无邀请码</div>'}</div>
  </section>`;
  $('#invite-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await api('/api/admin/invitations', { method: 'POST', body: values });
      $('#latest-code').innerHTML = `<div class="latest-code"><p>新邀请码（离开页面后不再显示）</p><strong>${escapeHTML(result.code)}</strong> <button class="small-button" data-copy-code="${escapeHTML(result.code)}"><svg><use href="#i-copy"/></svg> 复制</button></div>`;
      toast('邀请码已生成');
    } catch (error) { toast(error.message); }
  });
}
init();
