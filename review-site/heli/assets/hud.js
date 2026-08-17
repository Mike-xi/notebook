/* =====================================================================
   HELI · 海图页 HUD —— 时钟条 / 时间轴 / 在空列表 / 检视器 / 音效
   ===================================================================== */
(function () {
  'use strict';
  const H = window.HELI;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  let world = null, D = null, curDay = -1, selected = null;

  /* ---------------------------------------------------------- 启动 */
  H.load().then(() => {
    D = H.data;
    fillStatic();
    world = window.HeliWorld($('#cv'), { onSelect, onHover, onFrame });
    window.__HW = world;   // 调试钩子：控制台里可直接拿到场景/相机/渲染器
    bindUI();
    drawTrack();
    tickUI();
    setInterval(tickUI, 250);
    setTimeout(() => { $('#boot').classList.add('gone'); }, 420);
    setTimeout(() => { $('#boot').style.display = 'none'; }, 1400);
    // 第一次来的人先看一眼玩法，之后不再打扰
    try {
      if (!localStorage.getItem('heli-seen')) {
        localStorage.setItem('heli-seen', '1');
        setTimeout(() => $('#help').classList.add('on'), 1200);
      }
    } catch (e) { /* 隐私模式忽略 */ }
  }).catch(err => {
    $('#boot-pct').innerHTML = '<span style="color:#ff6b6b">数据载入失败：' + err.message + '</span>';
    console.error(err);
  });

  /* ---------------------------------------------------------- 静态数字 */
  function fillStatic() {
    const s = D.meta.stats;
    $('#statstrip').innerHTML = [
      ['T', H.fmt(s.T) + '<span style="font-size:11px;color:var(--dim)"> 分</span>', '总飞机使用时间'],
      ['N', s.N, '总架次'],
      ['U', s.U + '%', '座位利用率'],
      ['gap', s.gap + '%', '最优性间隙'],
    ].map(([k, v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join('');
    $('#h-T').textContent = H.fmt(s.T) + ' 分（' + s.Th + ' h）';
    $('#h-N').textContent = s.N;
    $('#h-P').textContent = H.fmt(s.P) + ' 分（人均 ' + s.Pavg + '）';
    $('#h-U').textContent = s.U + ' %';
    $('#h-F').textContent = H.fmt(s.fuel);
    $('#h-G').textContent = H.fmt(s.LB) + ' / ' + s.gap + ' %';
    $('#daylabels').innerHTML = D.meta.days.map((d, i) =>
      `<div data-day="${i}">${D.meta.week[i]}<br><span style="opacity:.6">${d.slice(5)}</span></div>`).join('');
  }

  /* ---------------------------------------------------------- 交互绑定 */
  function bindUI() {
    $$('.tg[data-layer]').forEach(b => b.addEventListener('click', () => {
      b.classList.toggle('on');
      world.setLayer(b.dataset.layer, b.classList.contains('on'));
      if (b.dataset.layer === 'routes') refreshRoutes();
    }));
    $('#v-home').onclick = () => world.home();
    $('#v-top').onclick = () => world.top();
    for (const a of ['a01', 'a02', 'a03']) $('#v-' + a).onclick = () => world.focus(a.toUpperCase(), 120);

    $('#btn-live').onclick = () => { H.Clock.live(); syncSpeedUI(); };
    $('#btn-play').onclick = () => { H.Clock.pause(); syncSpeedUI(); };
    $$('#speeds .btn').forEach(b => b.addEventListener('click', () => {
      H.Clock.setRate(+b.dataset.rate); syncSpeedUI();
    }));
    $('#daylabels').addEventListener('click', e => {
      const d = e.target.closest('[data-day]');
      if (d) H.Clock.set(+d.dataset.day * 1440 + 7 * 60, { rate: 60 });
      syncSpeedUI();
    });
    $('#insp-close').onclick = () => closeInsp();
    $('#btn-help').onclick = () => $('#help').classList.add('on');
    $('#help-close').onclick = () => $('#help').classList.remove('on');
    $('#help').addEventListener('click', e => { if (e.target.id === 'help') $('#help').classList.remove('on'); });
    $('#hint-btn').onclick = () => { H.Clock.set(H.nextActive(H.Clock.now()) - 4, { rate: 10 }); syncSpeedUI(); };
    $('#tg-sound').onclick = () => toggleSound();

    // 时间轴拖动
    const tr = $('#track');
    let scrub = false;
    const toM = e => {
      const r = tr.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * H.WEEK_MIN;
    };
    tr.addEventListener('pointerdown', e => { scrub = true; tr.setPointerCapture(e.pointerId); H.Clock.set(toM(e)); syncSpeedUI(); });
    tr.addEventListener('pointermove', e => { if (scrub) H.Clock.set(toM(e)); });
    tr.addEventListener('pointerup', () => { scrub = false; });
    tr.addEventListener('pointercancel', () => { scrub = false; });

    addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); H.Clock.pause(); syncSpeedUI(); }
      else if (e.key === 'l' || e.key === 'L') { H.Clock.live(); syncSpeedUI(); }
      else if (e.key === 'h' || e.key === 'H') world.home();
      else if (e.key === 't' || e.key === 'T') world.top();
      else if (e.key === 'Escape') { closeInsp(); $('#help').classList.remove('on'); }
      else if (e.key >= '1' && e.key <= '7') { H.Clock.set((+e.key - 1) * 1440 + 7 * 60, { rate: 60 }); syncSpeedUI(); }
    });
    addEventListener('resize', drawTrack);
    syncSpeedUI();
  }

  function syncSpeedUI() {
    const c = H.Clock;
    $('#btn-play').textContent = c.paused ? '▶ 继续' : '⏸ 暂停';
    $('#btn-live').classList.toggle('on', c.mode === 'live');
    $$('#speeds .btn').forEach(b => b.classList.toggle('on', c.mode === 'manual' && +b.dataset.rate === c.rate));
    const live = c.mode === 'live';
    $('#c-live').classList.toggle('off', !live);
    $('#c-livetxt').textContent = live ? 'LIVE 1:1' : (c.paused ? '已暂停' : c.rate + '× 回放');
  }

  /* ---------------------------------------------------------- 每帧/每秒 */
  function onFrame(mAbs, act) {
    const day = H.dayOf(mAbs);
    curDay = day;
    refreshRoutes(act);
    renderAirList(act);
    $('#l-count').textContent = act.filter(a => a.st.phase === 'air').length;
    if (selected && selected.kind === 'heli') renderFlight(selected.id);
    if (selected && selected.kind === 'node') renderNode(selected.id);
    const n = act.filter(a => a.st.phase === 'air').length;
    const hint = $('#hint');
    if (n === 0) {
      const mo = H.minOfDay(mAbs);
      $('#hint-txt').innerHTML = mo < 6 * 60 || mo > 20 * 60
        ? '🌙 夜航静默期 —— 题目规定 06:00 后才可起飞、20:00 前必须全部归场'
        : '此刻没有飞机在空中';
      hint.classList.add('on');
    } else hint.classList.remove('on');
  }

  function tickUI() {
    if (!world) return;
    const m = H.Clock.now(), d = H.dayOf(m), mo = H.minOfDay(m);
    $('#c-day').textContent = D.meta.week[d] + ' · ' + D.meta.days[d];
    $('#c-time').firstChild.nodeValue = H.hhmm(mo);
    $('#c-sec').textContent = ':' + String(Math.floor((mo % 1) * 60)).padStart(2, '0');
    $('#playhead').style.left = (m / H.WEEK_MIN * 100) + '%';
    $$('#daylabels div').forEach((el, i) => el.classList.toggle('on', i === d));
    $('#l-scale').textContent = '视距 ' + Math.round(world.state.camDist) + ' km';
    const day = D.byDay[d];
    const done = day.filter(fi => H.flightState(D.flights[fi], m).phase === 'done').length;
    $('#tb-info').innerHTML = `今日 ${day.length} 架次 · 已完成 ${done} · ` +
      `日总时长 ${H.fmt(day.reduce((s, fi) => s + D.flights[fi].dur, 0))} 分`;
    if (sound.on) updateSound();
  }

  /* ---------------------------------------------------------- 航路 */
  /* 只画「此刻在飞/在停靠」的航路，加上被选中的那条。全天铺开太乱，也不说明问题。 */
  function refreshRoutes(act) {
    if (!world) return;
    const list = (act || world.activeList()).map(a => a.fi);
    const sel = selected && selected.kind === 'heli' ? selected.id : null;
    if (sel != null && !list.includes(sel)) list.push(sel);
    world.showRoutes(list, sel);
  }

  /* ---------------------------------------------------------- 在空列表 */
  function renderAirList(act) {
    const body = $('#airlist-body');
    if (!act.length) {
      body.innerHTML = '<div class="empty">此刻天上没有飞机<br><span style="opacity:.7">拖时间轴或调倍速看看白天</span></div>';
      return;
    }
    const order = { air: 0, ground: 1, prep: 2 };
    const rows = act.slice().sort((a, b) => (order[a.st.phase] - order[b.st.phase]) || a.fi - b.fi);
    body.innerHTML = rows.map(a => {
      const f = D.flights[a.fi], st = a.st;
      const sel = selected && selected.kind === 'heli' && selected.id === a.fi;
      let where, meta, sub;
      if (st.phase === 'air') {
        where = `${st.from} → ${st.to}`;
        meta = H.hhmm(st.arr); sub = '预计到达';
      } else if (st.phase === 'ground') {
        where = `停靠 ${st.node}${st.refuel ? ' · 加油' : ''}`;
        meta = H.hhmm(st.until); sub = '再出发';
      } else {
        where = `${f.base} 待飞`; meta = H.hhmm(f.s[0].d); sub = '起飞';
      }
      return `<div class="fl-row${sel ? ' sel' : ''}" data-fi="${a.fi}">
        <span class="fl-dot" style="background:${H.typeColor(f.t)}"></span>
        <div class="fl-main"><b>${H.flightNo(f)}</b><span>${where}</span></div>
        <div class="fl-meta">${meta}<i>${sub}</i></div>
      </div>`;
    }).join('');
    body.querySelectorAll('.fl-row').forEach(r => r.onclick = () => {
      const fi = +r.dataset.fi;
      onSelect({ kind: 'heli', id: fi });
      world.follow(fi);
    });
  }

  /* ---------------------------------------------------------- 选中 / 悬停 */
  function onSelect(t) {
    if (!t) { closeInsp(); return; }
    if (t.kind === 'node' && D.nodes[t.id].k === 'A') {
      // 机场 → 直接进候机厅（时钟状态经 sessionStorage 续接）
      H.Clock.save();
      location.href = '/heli/terminal.html?id=' + t.id;
      return;
    }
    selected = { kind: t.kind, id: t.id };
    world.select(selected);
    $('#right').classList.add('open');
    if (t.kind === 'heli') { renderFlight(t.id); refreshRoutes(); }
    else renderNode(t.id);
  }
  function closeInsp() {
    selected = null; world.select(null); world.follow(null);
    $('#right').classList.remove('open');
    refreshRoutes();
  }

  const tip = $('#tip');
  function onHover(t, cx, cy) {
    if (!t) { tip.classList.remove('on'); return; }
    let html;
    if (t.kind === 'node') {
      const n = D.nodes[t.id], isA = n.k === 'A';
      const day = H.dayOf(H.Clock.now());
      const rows = H.boardFor(t.id, day);
      html = `<b>${isA ? t.id + ' · ' + H.nodeName(t.id) : t.id}${n.rf ? ' · 加油站' : ''}</b>` +
        `<div class="t2">${isA ? '陆地机场 · 基地 8 架' : '海上设施' + (n.rf ? ' · 设有加油站' : '')}</div>` +
        `<div class="t2">今日 ${rows.length} 次停靠 · 全周 ${n.visits} 次</div>` +
        `<div class="t2" style="color:var(--cyan)">${isA ? '点击进入候机厅 →' : '点击查看甲板日志 →'}</div>`;
    } else {
      const f = D.flights[t.id], st = H.flightState(f, H.Clock.now());
      html = `<b>${H.flightNo(f)} · ${f.ac}</b>` +
        `<div class="t2">${H.phaseText(st)}${st.phase === 'air' ? ` ${st.from}→${st.to}` : ''}</div>` +
        `<div class="t2">机上 ${st.phase === 'air' ? st.load : 0}/${f.seat} 人</div>`;
    }
    tip.innerHTML = html;
    tip.style.left = cx + 'px';
    tip.style.top = cy + 'px';
    tip.classList.add('on');
  }

  /* ---------------------------------------------------------- 检视器：架次 */
  function renderFlight(fi) {
    const f = D.flights[fi], m = H.Clock.now(), st = H.flightState(f, m);
    const p = D.meta.fleet[f.t];
    $('#insp-kicker').textContent = '架次 FLIGHT · ' + D.meta.days[f.day] + ' ' + D.meta.week[f.day];
    $('#insp-title').textContent = H.flightNo(f);
    $('#insp-sub').innerHTML = `${f.ac} · ${f.t} <span class="dim">(${p.seat} 座 / ${p.v} km·h⁻¹ / 航程 ${p.range} km)</span>`;

    const phaseCol = { air: 'var(--green)', ground: 'var(--amber)', prep: 'var(--cyan)', done: 'var(--dim)', idle: 'var(--dim)' }[st.phase];
    let html = `<div class="mini" style="border-color:${phaseCol};margin-bottom:11px">
      <b style="color:${phaseCol};font-size:14px">${H.phaseText(st)}</b>
      <span>${st.phase === 'air' ? `${st.from} → ${st.to} · 预计 ${H.hhmm(st.arr)} 到达 · 机上 ${st.load}/${f.seat} 人`
        : st.phase === 'ground' ? `${st.node} · ${H.hhmm(st.since)}–${H.hhmm(st.until)}${st.refuel ? ' · 加满油箱' : ''}`
          : st.phase === 'prep' ? `${f.base} · ${H.hhmm(f.s[0].d)} 起飞` : `${H.hhmm(f.s[0].d)}–${H.hhmm(f.s[f.s.length - 1].a)}`}</span></div>`;

    html += `<div class="grid3">
      <div class="mini"><b>${f.dur}</b><span>使用时间 / 分</span></div>
      <div class="mini"><b>${Math.round(f.km)}</b><span>航程 / km</span></div>
      <div class="mini"><b>${H.fmt(f.fuel)}</b><span>燃油 / kg</span></div></div>`;

    html += `<div class="sect-title">停靠时刻表</div><div class="legline">`;
    const now = H.minOfDay(m);
    f.s.forEach((s, i) => {
      const t0 = s.a != null ? s.a : s.d;
      const passed = H.dayOf(m) > f.day || (H.dayOf(m) === f.day && now >= t0);
      const isNow = (st.phase === 'ground' && st.at === i) || (st.phase === 'air' && st.leg === i);
      const legLoad = i < f.load.length ? f.load[i] : null;
      html += `<div class="leg ${passed ? 'pass' : ''} ${isNow ? 'now' : ''}">
        <div class="leg-t">${s.a != null ? H.hhmm(s.a) : '　—　'}${s.d != null ? ' → ' + H.hhmm(s.d) : ''}</div>
        <div class="leg-n">${s.n}${s.n[0] === 'A' ? ' <span class="dim" style="font-weight:400;font-size:11px">' + H.nodeName(s.n) + '</span>' : ''}
          ${s.r ? '<span class="leg-badge" style="background:rgba(214,165,42,.25);color:#ffd98a">加油</span>' : ''}</div>
        ${legLoad != null ? `<div class="leg-x">飞往 ${f.s[i + 1].n} · 机上 ${legLoad}/${f.seat} 人 · 满座率 ${(legLoad / f.seat * 100).toFixed(0)}%</div>` : ''}
      </div>`;
    });
    html += `</div>`;

    const pax = H.paxOf(f);
    const byTask = [0, 0, 0, 0];
    pax.forEach(x => byTask[x.tt]++);
    html += `<div class="sect-title">乘客 ${pax.length} 人</div><div class="bars">`;
    byTask.forEach((c, i) => {
      if (!c) return;
      html += `<div class="bar-row"><span class="lab">${D.meta.taskNames[i]}</span>
        <span class="track"><span class="fill" style="width:${c / pax.length * 100}%;background:${H.taskColor(i)}"></span></span>
        <span class="val">${c}</span></div>`;
    });
    html += `</div><div style="margin-top:10px;max-height:196px;overflow-y:auto"><table class="pax-table">
      <thead><tr><th>人员</th><th>行程</th><th>时刻</th></tr></thead><tbody>` +
      pax.map(x => `<tr><td class="id"><span class="dotc" style="background:${H.taskColor(x.tt)}"></span>${x.pid}</td>
        <td>${x.from} → ${x.to}</td><td class="win">${H.hhmm(x.depT)}–${H.hhmm(x.arrT)}</td></tr>`).join('') +
      `</tbody></table></div>`;

    $('#insp-body').innerHTML = html;
    const following = world.state.follow === fi;
    $('#insp-foot').innerHTML =
      `<button class="btn ${following ? 'on' : ''}" id="f-follow">${following ? '取消跟机' : '跟机视角'}</button>` +
      `<button class="btn" id="f-base">看基地 ${f.base}</button>`;
    $('#f-follow').onclick = () => { world.follow(following ? null : fi); renderFlight(fi); };
    $('#f-base').onclick = () => world.focus(f.base, 130);
  }

  /* ---------------------------------------------------------- 检视器：节点 */
  function renderNode(id) {
    const n = D.nodes[id], isA = n.k === 'A', m = H.Clock.now(), day = H.dayOf(m);
    const rows = H.boardFor(id, day);
    $('#insp-kicker').textContent = isA ? '陆地机场 AIRPORT' : '海上设施 PLATFORM';
    $('#insp-title').innerHTML = id + (isA ? ` <span style="font-size:15px;color:var(--ink-2)">${H.nodeName(id)}</span>` : '');
    const near = nearestAirport(id);
    $('#insp-sub').innerHTML = isA
      ? '基地保有 8 架 · 06:00 开场 / 18:00 最晚起飞 / 20:00 归场'
      : `距最近机场 ${near.a} 约 ${Math.round(near.d)} km${n.rf ? ' · <span style="color:#ffd98a">设有加油站</span>' : ''}`;

    let html = `<div class="grid3">
      <div class="mini"><b>${rows.length}</b><span>今日停靠</span></div>
      <div class="mini"><b>${n.visits}</b><span>全周停靠</span></div>
      <div class="mini"><b>${n.dep + n.arr}</b><span>全周人次</span></div></div>`;
    html += `<div class="grid2" style="margin-top:9px">
      <div class="mini"><b style="color:var(--cyan)">${n.dep}</b><span>${isA ? '出海登机' : '登机离开'}</span></div>
      <div class="mini"><b style="color:var(--amber)">${n.arr}</b><span>${isA ? '海返抵达' : '抵达上岗'}</span></div></div>`;

    html += `<div class="sect-title">${D.meta.week[day]} ${D.meta.days[day].slice(5)} 起降记录</div>`;
    if (!rows.length) html += '<div class="empty">这一天没有航班停靠此处</div>';
    else {
      html += '<div class="legline">';
      const now = H.minOfDay(m);
      rows.forEach(r => {
        const t0 = r.arr != null ? r.arr : r.dep;
        const passed = now >= (r.dep != null ? r.dep : r.arr);
        const isNow = now >= t0 && now < (r.dep != null ? r.dep : r.arr + 1);
        html += `<div class="leg ${passed ? 'pass' : ''} ${isNow ? 'now' : ''}" data-fi="${r.fi}" style="cursor:pointer">
          <div class="leg-t">${r.arr != null ? H.hhmm(r.arr) : '起飞'}${r.dep != null && r.arr != null ? ' → ' + H.hhmm(r.dep) : r.dep != null ? ' ' + H.hhmm(r.dep) : ' 归场'}</div>
          <div class="leg-n">${H.flightNo(r.f)} <span class="dim" style="font-weight:400;font-size:11px">${r.f.ac}</span>
            ${r.refuel ? '<span class="leg-badge" style="background:rgba(214,165,42,.25);color:#ffd98a">加油</span>' : ''}</div>
          <div class="leg-x">${r.isStart ? '本班始发' : r.isEnd ? '本班终到' : ''}
            ${r.on ? ` ↑${r.on} 人上` : ''}${r.off ? ` ↓${r.off} 人下` : ''}
            ${r.si < r.f.s.length - 1 ? ` · 续飞 ${r.f.s[r.si + 1].n}` : ''}</div></div>`;
      });
      html += '</div>';
    }
    $('#insp-body').innerHTML = html;
    $('#insp-body').querySelectorAll('.leg[data-fi]').forEach(el => el.onclick = () => onSelect({ kind: 'heli', id: +el.dataset.fi }));

    $('#insp-foot').innerHTML =
      `<button class="btn on" id="n-go">${isA ? '进入候机厅 →' : '甲板日志 →'}</button>` +
      `<button class="btn" id="n-focus">镜头对准</button>`;
    $('#n-go').onclick = () => { H.Clock.save(); location.href = '/heli/terminal.html?id=' + id; };
    $('#n-focus').onclick = () => world.focus(id, isA ? 120 : 60);
  }

  function nearestAirport(id) {
    let best = { a: 'A01', d: 1e9 };
    const p = D.nodes[id];
    for (const a of ['A01', 'A02', 'A03']) {
      const q = D.nodes[a], d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < best.d) best = { a, d };
    }
    return best;
  }

  /* ---------------------------------------------------------- 时间轴绘制 */
  function drawTrack() {
    const cv = $('#trackcv');
    if (!cv || !D) return;
    const r = cv.parentNode.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.max(1, r.width * dpr);
    cv.height = Math.max(1, r.height * dpr);
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    const W = r.width, HH = r.height;
    g.clearRect(0, 0, W, HH);

    // 夜间底色
    for (let d = 0; d < 7; d++) {
      const x0 = d / 7 * W, x1 = (d + 1) / 7 * W;
      g.fillStyle = 'rgba(255,255,255,.028)';
      g.fillRect(x0, 0, x1 - x0, HH);
      const dayStart = x0 + (6 / 24) * (x1 - x0), dayEnd = x0 + (20 / 24) * (x1 - x0);
      const grad = g.createLinearGradient(0, 0, 0, HH);
      grad.addColorStop(0, 'rgba(79,216,255,.055)');
      grad.addColorStop(1, 'rgba(79,216,255,.012)');
      g.fillStyle = grad;
      g.fillRect(dayStart, 0, dayEnd - dayStart, HH);
      if (d) { g.fillStyle = 'rgba(140,190,255,.22)'; g.fillRect(x0, 0, 1, HH); }
    }
    // 在空架次密度
    const dens = D.density, N = dens.length, max = D.densityMax;
    g.beginPath();
    g.moveTo(0, HH);
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1) * W, y = HH - (dens[i] / max) * (HH - 5) - 1;
      g.lineTo(x, y);
    }
    g.lineTo(W, HH);
    g.closePath();
    const gr = g.createLinearGradient(0, 0, 0, HH);
    gr.addColorStop(0, 'rgba(79,216,255,.72)');
    gr.addColorStop(1, 'rgba(79,216,255,.10)');
    g.fillStyle = gr;
    g.fill();
    g.strokeStyle = 'rgba(140,232,255,.85)';
    g.lineWidth = 1.2;
    g.beginPath();
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1) * W, y = HH - (dens[i] / max) * (HH - 5) - 1;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    // 峰值标注
    g.fillStyle = 'rgba(190,225,255,.5)';
    g.font = '10px ui-monospace,monospace';
    g.fillText('峰值 ' + max + ' 架同时在空', 6, 12);
  }

  /* ---------------------------------------------------------- 环境音 */
  const sound = { on: false, ctx: null, wave: null, rotor: null, rotorGain: null, master: null };
  function toggleSound() {
    if (!sound.on) startSound(); else stopSound();
    $('#tg-sound').classList.toggle('on', sound.on);
  }
  function startSound() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = sound.ctx || new AC();
      sound.ctx = ctx;
      if (ctx.state === 'suspended') ctx.resume();
      const master = ctx.createGain();
      master.gain.value = 0.0;
      master.connect(ctx.destination);
      // 海浪：粉噪声 -> 低通 -> 缓慢起伏
      const len = ctx.sampleRate * 3;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const dat = buf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        dat[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 0.6;
      const swell = ctx.createGain(); swell.gain.value = 0.5;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.32;
      lfo.connect(lfoG); lfoG.connect(swell.gain); lfo.start();
      src.connect(lp); lp.connect(swell); swell.connect(master); src.start();
      // 旋翼：低频 + 桨叶拍打
      const rot = ctx.createOscillator(); rot.type = 'sawtooth'; rot.frequency.value = 62;
      const rotLp = ctx.createBiquadFilter(); rotLp.type = 'lowpass'; rotLp.frequency.value = 260;
      const rotG = ctx.createGain(); rotG.gain.value = 0;
      const beat = ctx.createOscillator(); beat.frequency.value = 13;
      const beatG = ctx.createGain(); beatG.gain.value = 0.55;
      beat.connect(beatG); beatG.connect(rotG.gain); beat.start();
      rot.connect(rotLp); rotLp.connect(rotG); rotG.connect(master); rot.start();
      master.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 1.6);
      Object.assign(sound, { on: true, wave: swell, rotor: rot, rotorGain: rotG, master });
    } catch (e) { console.warn('audio', e); }
  }
  function stopSound() {
    if (!sound.ctx) return;
    sound.master.gain.linearRampToValueAtTime(0, sound.ctx.currentTime + 0.5);
    setTimeout(() => { try { sound.ctx.suspend(); } catch (e) { } }, 700);
    sound.on = false;
  }
  function updateSound() {
    if (!sound.ctx || !sound.rotorGain) return;
    // 跟机或选中飞机时旋翼声起来，飞机越近越响
    const follow = world.state.follow;
    const near = follow != null ? 1 : (selected && selected.kind === 'heli' ? 0.35 : 0);
    const target = near * 0.09;
    sound.rotorGain.gain.setTargetAtTime(target, sound.ctx.currentTime, 0.4);
  }
})();
