/* =====================================================================
   HELI · 候机厅 / 甲板日志
   机场：航班牌 + 停机坪 + 乘客名册；海上设施：甲板日志 + 人员进出
   时钟与海图页共用（sessionStorage），所以来回切换不会跳时间。
   ===================================================================== */
(function () {
  'use strict';
  const H = window.HELI;
  const $ = s => document.querySelector(s);
  const q = new URLSearchParams(location.search);
  let ID = (q.get('id') || 'A01').toUpperCase();
  let D = null, isA = true, viewDay = 0, selFlight = null;

  H.load().then(() => {
    D = H.data;
    if (!D.nodes[ID]) ID = 'A01';
    isA = D.nodes[ID].k === 'A';
    document.title = (isA ? `${ID} ${H.nodeName(ID)} 候机厅` : `${ID} 甲板日志`) + ' · 海上运载调度';
    viewDay = H.dayOf(H.Clock.now());
    renderAll();
    setInterval(tick, 500);
    $('#btn-live').onclick = () => { H.Clock.live(); viewDay = H.dayOf(H.Clock.now()); renderAll(); };
  }).catch(e => {
    $('#content').innerHTML = '<div class="panel glass"><p style="color:#ff6b6b">数据载入失败：' + e.message + '</p></div>';
  });

  /* ---------------------------------------------------------- 顶部 */
  function renderHero() {
    const n = D.nodes[ID];
    const others = ['A01', 'A02', 'A03'].map((a, i) => a === ID ? null : `${a} ${n.dA[i]} km`).filter(Boolean);
    $('#hero').innerHTML = heroArt() + `<div class="hero-in">
      <div class="hero-id">${ID}</div>
      <div class="hero-txt">
        <h1>${isA ? H.nodeName(ID) + ' · 候机厅' : '海上设施 ' + ID}</h1>
        <p>${isA ? '陆地机场 · 基地保有 8 架直升机 · 06:00 开场 / 18:00 最晚起飞 / 20:00 全部归场'
        : '固定式海上平台' + (n.rf ? ' · <b style="color:#ffd98a">设有加油站，停靠可加满油箱</b>' : ' · 无加油能力')}</p>
        <p class="dim mono" style="font-size:11.5px">距 ${others.join(' · ')}（题目距离矩阵）</p>
      </div>
      <div class="hero-clock">
        <div class="tm" id="bigclock">--:--</div>
        <div class="d" id="bigday"></div>
      </div>
    </div>`;
  }

  /* 候机厅落地窗外的天色随时刻变化：日出 05:20、日落 19:40，与三维海图同一套 */
  function heroArt() {
    const mo = H.minOfDay(H.Clock.now());
    const f = (mo - 320) / 860;
    const elev = Math.sin(Math.PI * Math.max(-0.42, Math.min(1.42, f))) * 1.15;
    const night = elev < -0.17 ? 1 : elev > 0.10 ? 0 : (0.10 - elev) / 0.27;
    const dusk = 1 - Math.min(1, Math.abs(elev) / 0.58);
    const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
    const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;
    let top = mix(mix([42, 111, 208], [39, 64, 126], dusk), [4, 9, 20], night);
    let hor = mix(mix([159, 205, 242], [255, 138, 61], dusk), [12, 26, 48], night);
    const sunX = 1015 - 330 * Math.max(0, Math.min(1, f));
    const sunY = 96 - 66 * Math.max(0, Math.sin(Math.PI * Math.max(0, Math.min(1, f))));
    const sunC = night > 0.55 ? '#dfe9f7' : (dusk > 0.5 ? '#ffb066' : '#fff4d2');
    const plat = (x, sc) => `<g transform="translate(${x},98) scale(${sc})" fill="#0a1626" opacity=".9">
        <rect x="-24" y="-4" width="48" height="6"/><rect x="-19" y="-15" width="14" height="11"/>
        <rect x="-20" y="2" width="3.4" height="24"/><rect x="17" y="2" width="3.4" height="24"/>
        <rect x="-7" y="2" width="2.6" height="24"/><rect x="6" y="2" width="2.6" height="24"/>
        <rect x="6" y="-28" width="2.6" height="13"/>
        <ellipse cx="7.3" cy="-32" rx="3.4" ry="5.4" fill="#ff9a3c" opacity=".85"/>
        <ellipse cx="11" cy="-6" rx="11" ry="3" fill="#132436"/></g>`;
    return `<svg class="hero-sky" viewBox="0 0 1200 170" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="hsky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${rgb(top)}"/><stop offset="1" stop-color="${rgb(hor)}"/></linearGradient>
        <linearGradient id="hsea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${rgb(mix(hor, [10, 46, 74], 0.62))}"/>
          <stop offset="1" stop-color="${rgb(mix([5, 24, 44], [2, 8, 16], night))}"/></linearGradient>
        <radialGradient id="hglow"><stop offset="0" stop-color="${sunC}" stop-opacity=".62"/>
          <stop offset="1" stop-color="${sunC}" stop-opacity="0"/></radialGradient>
        <linearGradient id="hfade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#08111e" stop-opacity=".97"/>
          <stop offset="0.5" stop-color="#08111e" stop-opacity=".74"/>
          <stop offset="1" stop-color="#08111e" stop-opacity=".42"/></linearGradient>
      </defs>
      <rect width="1200" height="170" fill="url(#hsky)"/>
      <circle cx="${sunX.toFixed(0)}" cy="${sunY.toFixed(0)}" r="56" fill="url(#hglow)"/>
      <circle cx="${sunX.toFixed(0)}" cy="${sunY.toFixed(0)}" r="${night > 0.55 ? 7 : 11}" fill="${sunC}" opacity=".9"/>
      <rect y="98" width="1200" height="72" fill="url(#hsea)"/>
      ${plat(690, 0.55)}${plat(1000, 0.8)}
      <g stroke="${rgb(mix(hor, [255, 255, 255], 0.4))}" stroke-opacity=".18" fill="none" stroke-width="1.2">
        ${[112, 126, 142, 160].map(y => `<path d="M560 ${y} Q740 ${y - 4} 900 ${y} T1200 ${y}"/>`).join('')}
      </g>
      <g transform="translate(790,52)">
        <ellipse rx="17" ry="5.6" fill="#e6eef7"/><rect x="-36" y="-1.6" width="21" height="3.6" rx="1.8" fill="#e6eef7"/>
        <rect x="-38" y="-11" width="2.8" height="10" rx="1.4" fill="#4a9bd8"/>
        <rect x="-2.5" y="-10" width="4" height="5.6" fill="#39424b"/>
        <rect x="-31" y="-13" width="62" height="2.1" rx="1" fill="#39424b" opacity=".7"/>
        <animateTransform attributeName="transform" type="translate"
          values="790,52;786,46;790,52" dur="5.5s" repeatCount="indefinite"/>
      </g>
      <g stroke="rgba(6,13,23,.34)" stroke-width="5">
        ${[640, 800, 960, 1120].map(x => `<line x1="${x}" y1="0" x2="${x}" y2="170"/>`).join('')}
      </g>
      <rect width="1200" height="170" fill="url(#hfade)"/>
    </svg>`;
  }

  function dist(a, b) {
    const p = D.nodes[a], r = D.nodes[b];
    return Math.round(Math.hypot(p.x - r.x, p.y - r.y));
  }

  /* ---------------------------------------------------------- KPI */
  function renderKpis() {
    const n = D.nodes[ID];
    const rows = H.boardFor(ID, viewDay);
    const m = H.Clock.now();
    let on = 0, off = 0;
    rows.forEach(r => { on += r.on; off += r.off; });
    const out = isA ? D.roster.filter(a => a.base === ID).filter(a => {
      const f = flightNow(a.id, m);
      return f != null;
    }).length : 0;
    const items = isA
      ? [[rows.filter(r => r.isStart).length, '今日出港架次'], [out, '此刻在外飞机'], [on, '今日登机人次'], [off, '今日抵达人次'],
      [D.roster.filter(a => a.base === ID).length, '基地机队'], [n.visits, '全周停靠次数']]
      : [[rows.length, '今日停靠'], [n.visits, '全周停靠'], [on, '今日登机'], [off, '今日抵达'],
      [n.dep, '全周离开人次'], [n.arr, '全周抵达人次']];
    $('#kpis').innerHTML = items.map(([v, l]) =>
      `<div class="mini"><b>${v}</b><span>${l}</span></div>`).join('');
  }

  function flightNow(acId, m) {
    for (const fi of D.byAc[acId] || []) {
      const f = D.flights[fi];
      if (f.day !== H.dayOf(m)) continue;
      const st = H.flightState(f, m);
      if (st.phase === 'air' || st.phase === 'ground' || st.phase === 'prep') return { fi, st };
    }
    return null;
  }

  /* ---------------------------------------------------------- 日期 chips */
  function renderChips() {
    $('#daychips').innerHTML = D.meta.days.map((d, i) =>
      `<button class="chip${i === viewDay ? ' on' : ''}" data-d="${i}">${D.meta.week[i]} ${d.slice(5)}</button>`).join('')
      + `<button class="chip" id="chip-now">⟲ 今天此刻</button>`;
    $('#daychips').querySelectorAll('[data-d]').forEach(b => b.onclick = () => {
      viewDay = +b.dataset.d; selFlight = null; renderAll();
    });
    $('#chip-now').onclick = () => {
      H.Clock.live(); viewDay = H.dayOf(H.Clock.now()); selFlight = null; renderAll();
    };
  }

  /* ---------------------------------------------------------- 主体 */
  function renderAll() {
    renderHero(); renderKpis(); renderChips();
    $('#content').innerHTML = isA ? airportHTML() : platformHTML();
    wire();
    tick();
    flipIn();
  }

  function statusOf(f, m) {
    const st = H.flightState(f, m);
    const map = {
      idle: ['计划中', 'var(--dim)'], prep: ['登机中', 'var(--cyan)'],
      air: ['飞行中', 'var(--green)'], ground: ['海上停靠', 'var(--amber)'], done: ['已归场', 'var(--dim)'],
    };
    if (H.dayOf(m) !== f.day) return H.dayOf(m) > f.day ? ['已归场', 'var(--dim)'] : ['计划中', 'var(--dim)'];
    return map[st.phase];
  }

  function airportHTML() {
    const m = H.Clock.now();
    const rows = H.boardFor(ID, viewDay);
    const deps = rows.filter(r => r.isStart);
    const arrs = rows.filter(r => r.isEnd);
    const mine = D.roster.filter(a => a.base === ID);

    let h = '';
    /* --- 出发牌 --- */
    h += panel('出发 · DEPARTURES', `${deps.length} 班`,
      deps.length ? fidsTable(deps, true, m) : empty('这一天没有从本场出发的航班'));
    /* --- 到达牌 --- */
    h += panel('到达 · ARRIVALS', `${arrs.length} 班`,
      arrs.length ? fidsTable(arrs, false, m) : empty('这一天没有返场航班'));

    /* --- 停机坪 --- */
    h += panel('停机坪 · APRON', `${mine.length} 个机位`, `<div class="apron">` + mine.map(a => {
      const fl = flightNow(a.id, m);
      const todays = (D.byAc[a.id] || []).filter(fi => D.flights[fi].day === viewDay);
      const cls = fl ? 'out' : (a.used ? '' : 'idle');
      const st = fl ? `<span style="color:var(--amber)">执行 ${H.flightNo(D.flights[fl.fi])}</span>`
        : a.used ? `<span style="color:var(--green)">在场待命</span>`
          : `<span class="dim">本周未启用</span>`;
      const p = D.meta.fleet[a.t];
      return `<div class="stand ${cls}">
        <div class="sid">${a.id}</div>
        <div class="sty">${a.t} · ${p.seat} 座 · ${p.v} km/h</div>
        <div class="sst">${st}</div>
        <div class="sty" style="margin-top:3px">今日 ${todays.length} 架次</div>
        ${heliIcon(a.t)}
      </div>`;
    }).join('') + `</div>`);

    /* --- 乘客名册 --- */
    const target = selFlight != null ? selFlight : (deps[0] ? deps[0].fi : null);
    h += panel('旅客名册 · MANIFEST', target != null ? H.flightNo(D.flights[target]) : '—',
      target != null ? manifestHTML(target) : empty('点上面任意一班查看名册'));

    /* --- 本场统计 --- */
    h += panel('本场一周概览', '', weekOverview());
    return h;
  }

  function fidsTable(rows, isDep, m) {
    return `<div style="overflow-x:auto"><table class="fids">
      <thead><tr>
        <th>${isDep ? '起飞' : '返场'}</th><th>航班</th><th>机型 / 机号</th><th>航线</th>
        <th>${isDep ? '旅客 / 峰值' : '返程载客'}</th><th>状态</th></tr></thead><tbody>` +
      rows.map(r => {
        const f = r.f, [txt, col] = statusOf(f, m);
        const now = H.dayOf(m) === f.day && txt !== '计划中' && txt !== '已归场';
        const past = txt === '已归场';
        const t = isDep ? f.s[0].d : f.s[f.s.length - 1].a;
        const load = isDep ? `${f.pax.length} 人 · 峰值 ${f.maxload}/${f.seat}`
          : `${f.load[f.load.length - 1] || 0} / ${f.seat}`;
        return `<tr data-fi="${f.i}" class="${now ? 'now' : past ? 'past' : ''}">
          <td class="t">${flipStr(H.hhmm(t))}</td>
          <td class="no">${H.flightNo(f)}</td>
          <td><span style="color:${H.typeColor(f.t)};font-weight:600">${f.t}</span> <span class="dim mono" style="font-size:11px">${f.ac}</span></td>
          <td class="rt">${f.s.map(s => s.n).join(' › ')}</td>
          <td class="rt">${load}</td>
          <td class="st" style="color:${col}">${txt}</td></tr>`;
      }).join('') + '</tbody></table></div>';
  }

  function manifestHTML(fi) {
    const f = D.flights[fi], pax = H.paxOf(f);
    const byTask = [0, 0, 0, 0];
    pax.forEach(x => byTask[x.tt]++);
    let h = `<div class="grid3" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:9px;margin-bottom:13px">
      <div class="mini"><b>${pax.length}</b><span>登机人数</span></div>
      <div class="mini"><b>${f.dur}</b><span>使用时间 / 分</span></div>
      <div class="mini"><b>${Math.round(f.km)}</b><span>航程 / km</span></div>
      <div class="mini"><b>${H.fmt(f.fuel)}</b><span>燃油 / kg</span></div>
      <div class="mini"><b>${(f.maxload / f.seat * 100).toFixed(0)}%</b><span>峰值满座率</span></div>
    </div>`;
    h += `<div class="bars" style="margin-bottom:14px">` + byTask.map((c, i) => c ?
      `<div class="bar-row"><span class="lab">${D.meta.taskNames[i]}</span>
        <span class="track"><span class="fill" style="width:${c / pax.length * 100}%;background:${H.taskColor(i)}"></span></span>
        <span class="val">${c} 人</span></div>` : '').join('') + `</div>`;
    h += `<div style="overflow-x:auto"><table class="pax-table"><thead><tr>
      <th>人员编号</th><th>任务</th><th>起点</th><th>终点</th><th>登机</th><th>抵达</th><th>时间窗</th></tr></thead><tbody>` +
      pax.map(x => `<tr>
        <td class="id"><span class="dotc" style="background:${H.taskColor(x.tt)}"></span>${x.pid}</td>
        <td>${D.meta.taskNames[x.tt]}</td>
        <td>${x.o === 'LAND' ? '陆地' : x.o}</td><td>${x.d === 'LAND' ? '陆地' : x.d}</td>
        <td class="win">${H.hhmm(x.depT)}</td><td class="win">${H.hhmm(x.arrT)}</td>
        <td class="win">${x.ep.slice(5, 16)} ~ ${x.la.slice(5, 16)}</td></tr>`).join('')
      + `</tbody></table></div>`;
    h += `<div class="sect-title" style="margin-top:14px">停靠时刻表</div><div class="legline">` +
      f.s.map((s, i) => `<div class="leg pass">
        <div class="leg-t">${s.a != null ? H.hhmm(s.a) : '　—　'}${s.d != null ? ' → ' + H.hhmm(s.d) : ''}</div>
        <div class="leg-n">${s.n}${s.r ? '<span class="leg-badge" style="background:rgba(214,165,42,.25);color:#ffd98a">加满油箱</span>' : ''}</div>
        ${i < f.load.length ? `<div class="leg-x">飞往 ${f.s[i + 1].n} · 机上 ${f.load[i]} 人</div>` : ''}
      </div>`).join('') + `</div>`;
    return h;
  }

  function weekOverview() {
    const per = D.meta.days.map((_, d) => {
      const rows = H.boardFor(ID, d);
      return { d, n: rows.length, dep: rows.filter(r => r.isStart).length, on: rows.reduce((s, r) => s + r.on, 0), off: rows.reduce((s, r) => s + r.off, 0) };
    });
    const max = Math.max(1, ...per.map(p => p.n));
    return `<div class="bars">` + per.map(p =>
      `<div class="bar-row"><span class="lab">${D.meta.week[p.d]}</span>
        <span class="track"><span class="fill" style="width:${p.n / max * 100}%;background:${p.d === viewDay ? 'var(--amber)' : 'var(--cyan)'}"></span></span>
        <span class="val" style="width:auto">${p.n} 次停靠 · ↑${p.on} ↓${p.off}</span></div>`).join('') + `</div>`;
  }

  /* ---------------------------------------------------------- 平台页 */
  function platformHTML() {
    const m = H.Clock.now();
    const rows = H.boardFor(ID, viewDay);
    let h = '';
    h += panel('停机甲板 · HELIDECK', rows.length + ' 次停靠', deckHTML(rows, m));
    h += panel('甲板日志 · DECK LOG', D.meta.week[viewDay] + ' ' + D.meta.days[viewDay].slice(5),
      rows.length ? deckLog(rows, m) : empty('这一天没有航班停靠本平台'));
    const target = selFlight != null ? selFlight : (rows[0] ? rows[0].fi : null);
    h += panel('人员进出 · PERSONNEL', target != null ? H.flightNo(D.flights[target]) : '—',
      target != null ? peopleAt(target) : empty('点上面任意一次停靠查看人员'));
    h += panel('本平台一周概览', '', weekOverview());
    h += panel('谁在服务它', '', servedBy());
    return h;
  }

  function deckHTML(rows, m) {
    const cur = rows.find(r => {
      const a = r.arr != null ? r.arr : r.dep, b = r.dep != null ? r.dep : r.arr;
      return H.dayOf(m) === viewDay && H.minOfDay(m) >= a && H.minOfDay(m) <= b;
    });
    const next = rows.find(r => H.dayOf(m) < viewDay || (H.dayOf(m) === viewDay && (r.arr != null ? r.arr : r.dep) > H.minOfDay(m)));
    const n = D.nodes[ID];
    return `<div class="deck">
      <svg viewBox="0 0 1000 210" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#0e2740"/><stop offset="1" stop-color="#04101c"/></linearGradient>
        </defs>
        <rect width="1000" height="210" fill="url(#sg)"/>
        <g opacity=".45" stroke="#1d5580" fill="none" stroke-width="1.2">${Array.from({ length: 7 }, (_, i) =>
      `<path d="M0 ${158 + i * 9} Q250 ${152 + i * 9} 500 ${158 + i * 9} T1000 ${158 + i * 9}">
             <animate attributeName="d" dur="${5 + i}s" repeatCount="indefinite"
               values="M0 ${158 + i * 9} Q250 ${152 + i * 9} 500 ${158 + i * 9} T1000 ${158 + i * 9};
                       M0 ${158 + i * 9} Q250 ${166 + i * 9} 500 ${158 + i * 9} T1000 ${158 + i * 9};
                       M0 ${158 + i * 9} Q250 ${152 + i * 9} 500 ${158 + i * 9} T1000 ${158 + i * 9}"/></path>`).join('')}</g>
        <g stroke="#4e5964" stroke-width="6" fill="none">
          <path d="M415 176 L424 108 M615 176 L606 108 M462 182 L468 108 M568 182 L562 108"/>
        </g>
        <rect x="398" y="96" width="224" height="13" rx="3" fill="#3d4650"/>
        <rect x="406" y="84" width="50" height="13" fill="#c9d2db"/>
        <rect x="406" y="80" width="50" height="5" fill="#cf6520"/>
        <path d="M566 88 L582 62 L590 64 L574 90 Z" fill="#4e5964"/>
        <ellipse cx="586" cy="54" rx="8" ry="13" fill="#ffb454" opacity=".85">
          <animate attributeName="ry" values="13;19;11;15;13" dur="1.6s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values=".85;.6;.9;.7;.85" dur="1.1s" repeatCount="indefinite"/></ellipse>
        <ellipse cx="510" cy="96" rx="54" ry="14" fill="#1e242a" stroke="#8fa4b6" stroke-width="2"/>
        <text x="510" y="102" text-anchor="middle" font-family="ui-monospace,monospace" font-size="16" font-weight="700" fill="#e6eef7" opacity=".85">H</text>
        ${n.rf ? `<g><rect x="632" y="80" width="15" height="25" rx="3" fill="#d6a52a"/>
          <rect x="651" y="84" width="13" height="21" rx="3" fill="#d6a52a"/>
          <text x="648" y="119" text-anchor="middle" font-size="9.5" fill="#ffd98a" font-family="ui-monospace" letter-spacing="1">FUEL</text></g>` : ''}
        ${cur ? `<g transform="translate(510,68)">
          <ellipse rx="24" ry="7.5" fill="#e8eff7"/><rect x="-49" y="-2" width="28" height="4.6" rx="2" fill="#e8eff7"/>
          <rect x="-52" y="-14" width="3.4" height="13" rx="1.6" fill="#4a9bd8"/>
          <rect x="-3.6" y="-13" width="6" height="7.4" fill="#39424b"/>
          <rect x="-42" y="-16" width="84" height="2.8" rx="1.4" fill="#39424b">
            <animate attributeName="opacity" values="1;.3;1" dur=".2s" repeatCount="indefinite"/></rect>
          <animateTransform attributeName="transform" type="translate" values="510,68;510,63;510,68" dur="3.4s" repeatCount="indefinite"/>
        </g>` : ''}
      </svg>
      <div style="position:absolute;left:16px;top:14px;text-shadow:0 2px 10px rgba(0,0,0,.8)">
        <div class="mono" style="font-size:11px;color:var(--dim);letter-spacing:.14em">HELIDECK STATUS</div>
        <div style="font-size:18px;font-weight:600;margin-top:3px;color:${cur ? 'var(--amber)' : 'var(--dim)'}">
          ${cur ? H.flightNo(cur.f) + ' 在甲板上' : '甲板空闲'}</div>
        <div class="dim" style="font-size:12px;margin-top:4px">
          ${next ? '下一班 ' + H.flightNo(next.f) + ' · ' + H.hhmm(next.arr != null ? next.arr : next.dep) : '本日再无航班'}</div>
        ${n.rf ? '<div style="font-size:12px;margin-top:6px;color:#ffd98a">本平台设有加油站</div>' : ''}
      </div>
    </div>`;
  }

  function deckLog(rows, m) {
    return `<div style="overflow-x:auto"><table class="fids"><thead><tr>
      <th>抵达</th><th>离开</th><th>航班</th><th>机号</th><th>上/下</th><th>续飞</th><th>状态</th></tr></thead><tbody>` +
      rows.map(r => {
        const [txt, col] = statusOf(r.f, m);
        return `<tr data-fi="${r.fi}">
          <td class="t">${r.arr != null ? flipStr(H.hhmm(r.arr)) : '<span class="dim" style="font-size:12px">始发</span>'}</td>
          <td class="t">${r.dep != null ? flipStr(H.hhmm(r.dep)) : '<span class="dim" style="font-size:12px">终到</span>'}</td>
          <td class="no">${H.flightNo(r.f)}</td>
          <td class="rt">${r.f.ac}</td>
          <td class="rt">↑${r.on} ↓${r.off}</td>
          <td class="rt">${r.si < r.f.s.length - 1 ? r.f.s[r.si + 1].n : '—'}${r.refuel ? '<span class="leg-badge" style="background:rgba(214,165,42,.22);color:#ffd98a;margin-left:5px">加油</span>' : ''}</td>
          <td class="st" style="color:${col}">${txt}</td></tr>`;
      }).join('') + '</tbody></table></div>';
  }

  function peopleAt(fi) {
    const f = D.flights[fi];
    const si = (H.boardFor(ID, viewDay).find(r => r.fi === fi) || {}).si;
    const pax = H.paxOf(f);
    const ons = pax.filter(x => x.b === si), offs = pax.filter(x => x.o === si);
    const tbl = (list, label) => list.length ? `<div class="sect-title">${label} ${list.length} 人</div>
      <div style="overflow-x:auto"><table class="pax-table"><thead><tr><th>人员</th><th>任务</th><th>起点</th><th>终点</th><th>时间窗</th></tr></thead><tbody>` +
      list.map(x => `<tr><td class="id"><span class="dotc" style="background:${H.taskColor(x.tt)}"></span>${x.pid}</td>
        <td>${D.meta.taskNames[x.tt]}</td><td>${x.o === 'LAND' ? '陆地' : x.o}</td><td>${x.d === 'LAND' ? '陆地' : x.d}</td>
        <td class="win">${x.ep.slice(5, 16)} ~ ${x.la.slice(5, 16)}</td></tr>`).join('') + '</tbody></table></div>' : '';
    const body = tbl(offs, '在此下机') + tbl(ons, '在此登机');
    return body || empty('这一次停靠没有人员上下（借道加油或过站）');
  }

  function servedBy() {
    const cnt = { A01: 0, A02: 0, A03: 0 };
    const types = { T1: 0, T2: 0, T3: 0 };
    for (const { fi } of D.byNode[ID]) { const f = D.flights[fi]; cnt[f.base]++; types[f.t]++; }
    const tot = Math.max(1, D.nodes[ID].visits);
    let h = `<div class="bars">`;
    for (const a of ['A01', 'A02', 'A03']) h += `<div class="bar-row"><span class="lab">${a} ${H.nodeName(a)}</span>
      <span class="track"><span class="fill" style="width:${cnt[a] / tot * 100}%;background:var(--cyan)"></span></span>
      <span class="val">${cnt[a]} 次</span></div>`;
    for (const t of ['T1', 'T2', 'T3']) h += `<div class="bar-row"><span class="lab">${t} · ${D.meta.fleet[t].seat} 座</span>
      <span class="track"><span class="fill" style="width:${types[t] / tot * 100}%;background:${H.typeColor(t)}"></span></span>
      <span class="val">${types[t]} 次</span></div>`;
    return h + `</div>`;
  }

  /* ---------------------------------------------------------- 小工具 */
  function panel(title, badge, body) {
    return `<div class="panel glass"><h2>${title}<span class="line"></span>${badge ? `<em>${badge}</em>` : ''}</h2>${body}</div>`;
  }
  function empty(t) { return `<div class="empty">${t}</div>`; }
  function flipStr(s) {
    return [...s].map(ch => ch === ':' ? '<span style="opacity:.5;margin:0 1px">:</span>' : `<span class="flip">${ch}</span>`).join('');
  }
  function flipIn() {
    const els = [...document.querySelectorAll('.flip')];
    els.slice(0, 140).forEach((el, i) => {
      el.style.animationDelay = (i % 24) * 22 + 'ms';
      el.classList.add('roll');
      setTimeout(() => el.classList.remove('roll'), 700);
    });
  }
  function heliIcon(t) {
    const c = H.typeColor(t);
    return `<svg width="46" height="26" viewBox="0 0 46 26"><g fill="${c}" opacity=".9">
      <ellipse cx="20" cy="16" rx="9" ry="4"/><rect x="27" y="14.6" width="12" height="2.6" rx="1.3"/>
      <rect x="37" y="10" width="2.4" height="7" rx="1"/><rect x="4" y="9.4" width="34" height="1.8" rx=".9"/>
      <rect x="19" y="6" width="2" height="4"/></g></svg>`;
  }

  function wire() {
    document.querySelectorAll('tr[data-fi]').forEach(tr => {
      tr.onclick = () => {
        selFlight = +tr.dataset.fi;
        $('#content').innerHTML = isA ? airportHTML() : platformHTML();
        wire(); tick();
        const t = [...document.querySelectorAll('.panel')].find(p => /MANIFEST|PERSONNEL/.test(p.textContent.slice(0, 40)));
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });
  }

  /* ---------------------------------------------------------- 走时 */
  let heroKey = -1;
  function tick() {
    if (!D) return;
    const m = H.Clock.now(), d = H.dayOf(m);
    const hk = Math.floor(H.minOfDay(m) / 8);
    if (hk !== heroKey) { heroKey = hk; const sv = $('#hero .hero-sky'); if (sv) sv.outerHTML = heroArt(); }
    const bc = $('#bigclock');
    if (bc) {
      bc.textContent = H.hhmmss(H.minOfDay(m));
      $('#bigday').textContent = D.meta.week[d] + ' · ' + D.meta.days[d];
    }
    const live = H.Clock.mode === 'live';
    $('#livebadge').classList.toggle('off', !live);
    $('#livetxt').textContent = live ? 'LIVE 1:1' : (H.Clock.paused ? '已暂停' : H.Clock.rate + '× 回放');
    if (d === viewDay) {
      document.querySelectorAll('tr[data-fi]').forEach(tr => {
        const f = D.flights[+tr.dataset.fi];
        const [txt, col] = statusOf(f, m);
        const cell = tr.querySelector('.st');
        if (cell && cell.textContent !== txt) { cell.textContent = txt; cell.style.color = col; }
        tr.classList.toggle('now', txt === '飞行中' || txt === '海上停靠' || txt === '登机中');
        tr.classList.toggle('past', txt === '已归场');
      });
    }
  }
})();
