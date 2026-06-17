// 留言板前端：自选昵称留言、人人可见，每 5 秒轮询增量。
// 管理员额外展示每条留言的 IP / User-Agent，并可删除。鉴权靠站点登录 Cookie。
(function () {
  const $ = (id) => document.getElementById(id);
  const listEl = $('list'), emptyEl = $('empty'), nickEl = $('nick'), bodyEl = $('body'), sendBtn = $('send');
  let isAdmin = false, lastId = 0, polling = false;

  // 主题跟随站点
  (function theme() {
    let t = 'auto';
    try { t = localStorage.getItem('nb-theme') || 'auto'; } catch {}
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.classList.toggle('dark', dark);
  })();

  try { nickEl.value = localStorage.getItem('nb-board-name') || ''; } catch {}

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function toast(t) { const e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove('show'), 1800); }
  function fmtTime(ts) {
    const d = new Date(ts), p = (x) => String(x).padStart(2, '0');
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    return sameDay ? hm : `${d.getMonth() + 1}-${p(d.getDate())} ${hm}`;
  }

  function atBottom() { return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80; }
  function scrollDown() { listEl.scrollTop = listEl.scrollHeight; }

  function render(m) {
    const el = document.createElement('div');
    el.className = 'post';
    el.dataset.id = m.id;
    let meta = '';
    if (isAdmin) {
      meta = `<div class="meta"><span><span class="k">IP</span> ${esc(m.ip || '—')}</span>` +
        `<span><span class="k">UA</span> ${esc(m.ua || '—')}</span>` +
        `<button class="del" data-id="${m.id}">删除</button></div>`;
    }
    el.innerHTML =
      `<div class="head"><span class="nick">${esc(m.nick || '匿名')}</span><span class="time">${fmtTime(m.created_at)}</span></div>` +
      `<div class="body">${esc(m.body)}</div>` + meta;
    return el;
  }

  function append(messages) {
    if (!messages.length) return;
    const stick = atBottom();
    for (const m of messages) {
      listEl.appendChild(render(m));
      if (m.id > lastId) lastId = m.id;
    }
    emptyEl.hidden = true;
    if (stick) scrollDown();
  }

  async function load() {
    if (polling) return;
    polling = true;
    try {
      const url = lastId ? `/api/board?after=${lastId}` : '/api/board';
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!r.ok) return;
      const d = await r.json();
      if (d.me && d.me.admin && !isAdmin) { isAdmin = true; $('admin-flag').hidden = false; $('hint').textContent = '管理员视图：可见每条留言的 IP / 客户端，并可删除。'; }
      const msgs = d.messages || [];
      if (!lastId && !msgs.length) emptyEl.hidden = false;
      append(msgs);
    } catch {} finally { polling = false; }
  }

  async function send() {
    const body = bodyEl.value.trim();
    if (!body) return;
    const nick = (nickEl.value.trim() || '匿名').slice(0, 24);
    try { localStorage.setItem('nb-board-name', nick); } catch {}
    sendBtn.disabled = true;
    try {
      const r = await fetch('/api/board', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nick, body }),
      });
      const d = await r.json();
      if (!r.ok) { toast(d.error || '发送失败'); return; }
      if (d.message && d.message.id > lastId) append([d.message]);
      bodyEl.value = ''; autoGrow(); scrollDown();
    } catch { toast('网络错误'); } finally { sendBtn.disabled = false; bodyEl.focus(); }
  }

  async function del(id) {
    if (!confirm('删除这条留言？')) return;
    try {
      const r = await fetch('/api/board', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      if (r.ok) { const el = listEl.querySelector(`.post[data-id="${id}"]`); if (el) el.remove(); }
      else toast('删除失败');
    } catch { toast('网络错误'); }
  }

  function autoGrow() { bodyEl.style.height = 'auto'; bodyEl.style.height = Math.min(140, bodyEl.scrollHeight) + 'px'; }

  sendBtn.addEventListener('click', send);
  bodyEl.addEventListener('input', autoGrow);
  bodyEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  listEl.addEventListener('click', (e) => { const b = e.target.closest('.del'); if (b) del(parseInt(b.dataset.id, 10)); });

  // 调试钩子
  window.__board = { reload: load, lastId: () => lastId, isAdmin: () => isAdmin };

  load();
  setInterval(() => { if (!document.hidden) load(); }, 5000);
})();
