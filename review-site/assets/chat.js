// 课程群聊（轮询式）：所有登录用户共用一个大群。身份按本设备生成的 client_id 区分，
// 配色与「同网」标识来自服务端回传的 ip_tag（IP 短哈希，不含明文）。每 3 秒拉一次增量。
(function () {
  const UID_KEY = 'nb-room-uid';
  const NICK_KEY = 'nb-room-nick';
  const POLL_MS = 3000;

  // 本设备稳定身份
  let clientId = localStorage.getItem(UID_KEY);
  if (!clientId) {
    clientId = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    localStorage.setItem(UID_KEY, clientId);
  }
  let nick = localStorage.getItem(NICK_KEY) || '';

  const msgsEl = document.getElementById('room-msgs');
  const emptyEl = document.getElementById('room-empty');
  const mainEl = document.getElementById('room-main');
  const inputEl = document.getElementById('room-input');
  const formEl = document.getElementById('room-form');
  const subEl = document.getElementById('room-sub');
  const nickBtn = document.getElementById('room-nick-btn');

  let lastId = 0;
  let sending = false;
  let pollTimer = null;
  const seen = new Set();

  // ===== 初始化 =====
  refreshNickLabel();
  load(true);
  startPolling();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else { load(false); startPolling(); }
  });

  function startPolling() { stopPolling(); pollTimer = setInterval(() => load(false), POLL_MS); }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  async function load(initial) {
    try {
      const url = '/api/chat-room?uid=' + encodeURIComponent(clientId) + (lastId ? '&after=' + lastId : '');
      const r = await fetch(url);
      if (!r.ok) return;
      const d = await r.json();
      if (d.me && d.me.ip_tag) subEl.textContent = '大家一起讨论 · 你的身份标识 #' + d.me.ip_tag;
      const list = d.messages || [];
      const nearBottom = isNearBottom();
      let appended = 0;
      for (const m of list) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (m.id > lastId) lastId = m.id;
        msgsEl.appendChild(renderMsg(m));
        appended++;
      }
      if (appended) {
        emptyEl.hidden = true;
        if (initial || nearBottom) scrollToBottom();
      } else if (initial && !msgsEl.children.length) {
        emptyEl.hidden = false;
      }
    } catch {}
  }

  // ===== 发送 =====
  formEl.addEventListener('submit', (e) => { e.preventDefault(); send(); });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
  });

  async function send() {
    const text = inputEl.value.trim();
    if (!text || sending) return;
    sending = true;
    try {
      const r = await fetch('/api/chat-room', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, nick, client_id: clientId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { flashError(d.error || '发送失败'); return; }
      inputEl.value = '';
      inputEl.style.height = 'auto';
      // 立即把自己的消息渲染出来（轮询去重不会重复）
      if (d.message && !seen.has(d.message.id)) {
        seen.add(d.message.id);
        if (d.message.id > lastId) lastId = d.message.id;
        emptyEl.hidden = true;
        msgsEl.appendChild(renderMsg(d.message));
        scrollToBottom();
      }
    } catch { flashError('网络异常，发送失败'); }
    finally { sending = false; }
  }

  // ===== 昵称 =====
  nickBtn.addEventListener('click', () => {
    const v = prompt('设置你在群里显示的昵称（最多 20 字，留空则用「访客-xxxx」）：', nick);
    if (v === null) return;
    nick = v.trim().slice(0, 20);
    if (nick) localStorage.setItem(NICK_KEY, nick); else localStorage.removeItem(NICK_KEY);
    refreshNickLabel();
  });
  function refreshNickLabel() {
    nickBtn.textContent = '🙂 ' + (nick || ('访客-' + clientId.slice(-4)));
  }

  // ===== 渲染 =====
  function renderMsg(m) {
    const mine = m.client_id === clientId;
    const wrap = document.createElement('div');
    wrap.className = 'room-msg' + (mine ? ' mine' : '');

    const displayName = m.nick || ('访客-' + String(m.client_id || '').slice(-4));
    const color = colorFor(m.client_id || m.ip_tag || '');

    if (!mine) {
      const avatar = document.createElement('div');
      avatar.className = 'room-avatar';
      avatar.style.background = color;
      avatar.textContent = firstChar(displayName);
      wrap.appendChild(avatar);
    }

    const body = document.createElement('div');
    body.className = 'room-body';
    const meta = document.createElement('div');
    meta.className = 'room-meta';
    meta.innerHTML = `<span class="room-name" style="color:${mine ? '' : color}">${escapeHTML(displayName)}</span>`
      + `<span class="room-time">${fmtTime(m.created_at)}</span>`;
    const bubble = document.createElement('div');
    bubble.className = 'room-bubble';
    bubble.textContent = m.text || '';
    body.appendChild(meta);
    body.appendChild(bubble);
    wrap.appendChild(body);
    return wrap;
  }

  function isNearBottom() {
    return mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight < 120;
  }
  function scrollToBottom() { mainEl.scrollTop = mainEl.scrollHeight; }

  function flashError(msg) {
    subEl.textContent = '⚠️ ' + msg;
    subEl.style.color = 'var(--error)';
    setTimeout(() => { subEl.style.color = ''; }, 2500);
  }

  // 从 id 派生稳定的柔和颜色（HSL）
  function colorFor(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return `hsl(${h}, 60%, 52%)`;
  }
  function firstChar(s) { return (s || '?').trim().charAt(0).toUpperCase() || '?'; }
  function fmtTime(ts) {
    const d = new Date(ts || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }
  function escapeHTML(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
