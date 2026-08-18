// 下载中心页面：云端转存的前端 + 管理员的限速面板。
// 后端在 functions/api/relay.js —— 任务真正在服务端跑，这里只负责下单和轮询画进度。
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ic = (n, size) => (window.NBIcon ? NBIcon(n, { size: size || 16 }) : '');
  const fmt = (n) => {
    n = +n || 0;
    if (n < 1024) return Math.round(n) + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  };

  const urlsEl = $('dlc-urls');
  const folderEl = $('dlc-folder');
  const nameEl = $('dlc-name');
  const jobsEl = $('dlc-jobs');
  const metersEl = $('dlc-meters');
  const msgEl = $('dlc-msg');

  let dest = 'drive';
  let me = null;                 // 上一次 GET 回来的整包状态
  let timer = 0;
  const speed = new Map();       // id -> { got, at, bps }，两次轮询之间算出来的瞬时速度

  function say(text, kind) {
    if (!text) { msgEl.hidden = true; return; }
    msgEl.hidden = false;
    msgEl.textContent = text;
    msgEl.className = 'dlc-msg' + (kind ? ' ' + kind : '');
  }

  async function api(body) {
    const res = await fetch('/api/relay', {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || ('请求失败（' + res.status + '）'));
    return data;
  }

  // ---- 目的地 ----
  $('dlc-dest').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dest]');
    if (!b) return;
    dest = b.dataset.dest;
    $('dlc-dest').querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  });

  // ---- 探测：先看一眼要下的是什么 ----
  $('dlc-probe').addEventListener('click', async () => {
    const first = (urlsEl.value.split('\n').map((s) => s.trim()).filter(Boolean))[0];
    if (!first) return say('先粘一个链接', 'warn');
    say('探测中…');
    try {
      const d = await api({ action: 'probe', url: first });
      const cap = me && me.limit ? me.limit.file * 1048576 : 0;
      const over = cap && d.size && d.size > cap;
      // 探到的名字比从 URL 末段猜的准（很多下载链接末段是 /download、/__down 之类），
      // 顺手填进「另存为」，不满意还能改
      if (nameEl && !nameEl.value.trim()) nameEl.value = d.name;
      say(`${d.name} · ${d.size ? fmt(d.size) : '大小未知'}${d.type ? ' · ' + d.type : ''}` +
          (over ? `（超过你这一级的单文件上限 ${me.limit.file} MB）` : ''), over ? 'warn' : 'ok');
    } catch (e) { say(e.message, 'warn'); }
  });

  // ---- 下单 ----
  $('dlc-go').addEventListener('click', async () => {
    const urls = urlsEl.value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!urls.length) return say('先粘一个链接', 'warn');
    const parent = folderEl.value.trim();
    // 「另存为」只对单条链接有意义，一次贴一堆时忽略
    const name = urls.length === 1 ? nameEl.value.trim() : '';
    let ok = 0;
    const errs = [];
    for (const url of urls) {
      try { await api({ action: 'add', url, dest, parent, name: name || undefined }); ok++; }
      catch (e) { errs.push(e.message); }
    }
    if (ok) { urlsEl.value = ''; nameEl.value = ''; }
    say(errs.length ? `${ok ? '已下单 ' + ok + ' 个；' : ''}${errs.join('；')}` : `已下单 ${ok} 个任务`, errs.length ? 'warn' : 'ok');
    refresh();
  });

  // ---- 任务列表 ----
  function jobRow(jb) {
    const pct = jb.size ? Math.min(100, Math.round((jb.got / jb.size) * 100)) : 0;
    const s = speed.get(jb.id);
    const rate = jb.status === 'running' && s && s.bps > 0 ? ' · ' + fmt(s.bps) + '/s' : '';
    const where = jb.dest === 'xipan' ? 'Xi Pan' : '公共云盘';
    const tail = jb.status === 'done'
      ? `${where} · ${jb.path}`
      : jb.status === 'error'
        ? `<span class="dlc-err">${esc(jb.error || '失败')}</span>`
        : `${jb.size ? fmt(jb.got) + ' / ' + fmt(jb.size) : fmt(jb.got) + ' / 大小未知'}${rate}`;
    const openable = jb.status === 'done' && jb.dest === 'drive';
    return `<div class="dlc-job" data-id="${jb.id}">
      <div class="dlc-job-top">
        <span class="dlc-job-name">${esc(jb.name)}</span>
        <span class="dlc-job-tag ${jb.status}">${jb.status === 'done' ? '完成' : jb.status === 'error' ? '失败' : pct + '%'}</span>
      </div>
      <div class="dlc-bar"><i style="width:${jb.status === 'done' ? 100 : pct}%"></i></div>
      <div class="dlc-job-foot">
        <span>${tail}</span>
        <span class="dlc-job-acts">
          ${me && me.admin && jb.role && jb.role !== 'admin' ? `<em class="dlc-who">${jb.role === 'friend' ? '好友' : '访客'}</em>` : ''}
          ${openable ? `<a href="/drive.html" title="去云盘">${ic('folder', 15)}</a>` : ''}
          <button type="button" data-cancel="${jb.id}" title="${jb.status === 'running' ? '中止并删除' : '删除这条记录'}">${ic('trash', 15)}</button>
        </span>
      </div>
    </div>`;
  }

  function renderJobs(d) {
    const now = Date.now();
    for (const jb of d.jobs) {
      const prev = speed.get(jb.id);
      if (prev && jb.got > prev.got && now > prev.at) {
        jb.bps = ((jb.got - prev.got) * 1000) / (now - prev.at);
        speed.set(jb.id, { got: jb.got, at: now, bps: jb.bps });
      } else if (!prev) {
        speed.set(jb.id, { got: jb.got, at: now, bps: 0 });
      }
    }
    jobsEl.innerHTML = d.jobs.length
      ? d.jobs.map(jobRow).join('') +
        `<button class="dlc-clear" type="button" id="dlc-clear">清空已结束的记录</button>`
      : '<p class="dlc-empty">还没有转存任务</p>';
  }

  function renderMeters(d) {
    const L = d.limit || {};
    const used = d.usedToday || 0;
    const bits = [
      `限速 <b>${L.speed ? L.speed + ' MB/s' : '不限'}</b>`,
      `单文件 <b>≤ ${L.file} MB</b>`,
      `今日 <b>${fmt(used)}${L.daily ? ' / ' + L.daily + ' MB' : ''}</b>`,
      `并发 <b>${d.running || 0} / ${L.conc}</b>`,
    ];
    const q = d.usage || {};
    const box = (k, label) => {
      const u = q[k]; if (!u) return '';
      const pct = Math.min(100, Math.round((u.used / u.quota) * 100));
      return `<span class="dlc-meter"><em>${label}</em><i class="dlc-bar"><i style="width:${pct}%"></i></i><b>${fmt(u.used)} / ${fmt(u.quota)}</b></span>`;
    };
    metersEl.innerHTML =
      `<div class="dlc-gate">${bits.join('<span class="dlc-dot">·</span>')}</div>` +
      `<div class="dlc-quotas">${box('drive', '公共云盘')}${d.admin ? box('xipan', 'Xi Pan') : ''}</div>`;
  }

  // ---- 管理员：三级闸门 ----
  const ROLE_CN = { guest: '访客（一级）', friend: '好友（二级）', admin: '管理员（三级）' };
  function renderLimits(limits) {
    $('dlc-admin').hidden = false;
    $('dlc-limits').innerHTML = ['guest', 'friend', 'admin'].map((r) => {
      const L = limits[r];
      const lock = r === 'admin';
      return `<div class="dlc-lrow" data-role="${r}">
        <span class="dlc-lname">${ROLE_CN[r]}</span>
        <label class="dlc-lf"><span>开放</span><input type="checkbox" data-f="on" ${L.on ? 'checked' : ''} ${lock ? 'disabled' : ''}></label>
        <label class="dlc-lf"><span>限速 MB/s</span><input type="number" data-f="speed" min="0" max="100" step="0.5" value="${L.speed}"></label>
        <label class="dlc-lf"><span>单文件 MB</span><input type="number" data-f="file" min="1" max="512" step="1" value="${L.file}"></label>
        <label class="dlc-lf"><span>每日 MB</span><input type="number" data-f="daily" min="0" max="20480" step="64" value="${L.daily}"></label>
        <label class="dlc-lf"><span>并发</span><input type="number" data-f="conc" min="1" max="8" step="1" value="${L.conc}"></label>
      </div>`;
    }).join('') + '<p class="dlc-lnote">0 = 不限。改动对之后新建的任务生效。</p>';
  }

  const saveBtn = $('dlc-save-limits');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const limits = {};
    $('dlc-limits').querySelectorAll('.dlc-lrow').forEach((row) => {
      const o = {};
      row.querySelectorAll('[data-f]').forEach((inp) => {
        o[inp.dataset.f] = inp.type === 'checkbox' ? (inp.checked ? 1 : 0) : Number(inp.value);
      });
      limits[row.dataset.role] = o;
    });
    saveBtn.disabled = true;
    try {
      const d = await api({ action: 'limits', limits });
      renderLimits(d.limits);
      say('限速已保存', 'ok');
    } catch (e) { say(e.message, 'warn'); }
    saveBtn.disabled = false;
    refresh();
  });

  // ---- 轮询 ----
  async function refresh() {
    let d;
    try { d = await api(null); } catch (e) { say(e.message, 'warn'); return; }
    me = d;
    const badge = $('dlc-role');
    if (badge) { badge.hidden = false; badge.textContent = ROLE_CN[d.role] || d.role; }
    // 三级才有 Xi Pan 这个去处
    const xp = document.querySelector('[data-dest="xipan"]');
    if (xp && !d.admin) { xp.remove(); if (dest === 'xipan') dest = 'drive'; $('dlc-dest').classList.add('solo'); }
    if (d.admin && d.limits) renderLimits(d.limits);
    if (!d.limit.on) {
      $('dlc-go').disabled = true;
      say('管理员暂时关闭了你这一级的云端转存，可以先用本地下载器', 'warn');
    }
    renderMeters(d);
    renderJobs(d);

    clearTimeout(timer);
    const busy = d.jobs.some((jb) => jb.status === 'running');
    timer = setTimeout(refresh, busy ? 1800 : 15000);
  }

  jobsEl.addEventListener('click', async (e) => {
    const cancel = e.target.closest('[data-cancel]');
    if (cancel) {
      try { await api({ action: 'cancel', id: Number(cancel.dataset.cancel) }); } catch (err) { say(err.message, 'warn'); }
      return refresh();
    }
    if (e.target.closest('#dlc-clear')) {
      try { await api({ action: 'clear' }); } catch (err) { say(err.message, 'warn'); }
      return refresh();
    }
  });

  // ---- 命令行那一小块：跟着第一行链接走 ----
  const cmdOut = $('dlc-cmd-out');
  const syncCmd = () => {
    const first = (urlsEl.value.split('\n').map((s) => s.trim()).filter(Boolean))[0];
    cmdOut.value = `aria2c -x16 -s16 -c "${first || '链接'}"`;
  };
  urlsEl.addEventListener('input', syncCmd);
  $('dlc-cmd-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(cmdOut.value); say('命令已复制', 'ok'); }
    catch { cmdOut.select(); document.execCommand('copy'); }
  });

  refresh();
  // 页面切到后台就别再空转轮询了
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
