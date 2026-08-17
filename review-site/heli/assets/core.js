/* =====================================================================
   HELI · 共用内核
   ---------------------------------------------------------------------
   1) 载入 plan.json（问题三最终提交方案的完整编译结果）
   2) 周时钟：默认 1:1 跟随真实时间——现实的周一 09:12 就是计划里 08-03 09:12
   3) 架次状态查询：任意时刻某架次在哪儿、在干什么
   两个页面（海图 index / 候机厅 terminal）共用，时钟状态经 sessionStorage 续接。
   ===================================================================== */
(function (global) {
  'use strict';

  const DAY_MIN = 1440;
  const WEEK_MIN = DAY_MIN * 7;
  const PREP_MIN = 20;          // 起飞前多久开始登机 / 启车（可视化用，非题目约束）

  /* ---------------------------------------------------------------- 数据 */
  const H = {
    data: null,
    ready: false,
    DAY_MIN, WEEK_MIN, PREP_MIN,
  };

  let _loading = null;
  H.load = function () {
    if (_loading) return _loading;
    _loading = fetch('/heli/data/plan.json', { cache: 'no-cache' })
      .then(r => {
        if (!r.ok) throw new Error('plan.json ' + r.status);
        return r.json();
      })
      .then(d => {
        H.data = d;
        H.ready = true;
        index(d);
        return d;
      });
    return _loading;
  };

  /* 派生索引：按天分组、按机号分组、按节点分组 */
  function index(d) {
    d.byDay = Array.from({ length: 7 }, () => []);
    d.byAc = {};
    d.byNode = {};                       // node -> [{fi, si}]  该节点被哪些架次在第几站停靠
    for (const n of Object.keys(d.nodes)) d.byNode[n] = [];
    d.flights.forEach((f, i) => {
      f.i = i;
      d.byDay[f.day].push(i);
      (d.byAc[f.ac] = d.byAc[f.ac] || []).push(i);
      f.s.forEach((s, si) => d.byNode[s.n].push({ fi: i, si }));
      // 便于渲染：每一站的坐标
      f.xy = f.s.map(s => [d.nodes[s.n].x, d.nodes[s.n].y]);
      f.legMin = [];
      for (let j = 0; j < f.s.length - 1; j++) f.legMin.push(f.s[j + 1].a - f.s[j].d);
      f.km = f.km;
    });
    for (const day of d.byDay) day.sort((a, b) => d.flights[a].s[0].d - d.flights[b].s[0].d);
    for (const ac of Object.keys(d.byAc)) d.byAc[ac].sort((a, b) => d.flights[a].day * 1e4 + d.flights[a].s[0].d - (d.flights[b].day * 1e4 + d.flights[b].s[0].d));
    // 每人反查
    d.peopleIds = Object.keys(d.people);
    // 每天在空架次数曲线（每 5 分钟一格，给时间轴画热力）
    d.density = [];
    for (let m = 0; m < WEEK_MIN; m += 5) {
      d.density.push(H.airborneCount(m));
    }
    d.densityMax = Math.max(1, ...d.density);
  }

  /* ---------------------------------------------------------------- 时钟 */
  /* 绝对分钟 M ∈ [0, 10080)：0 = 2026-08-03(周一) 00:00 */
  const KEY = 'heli-clock-v1';

  const Clock = {
    mode: 'live',      // live | manual
    rate: 1,           // manual 模式下的倍速
    _base: 0,          // manual 模式的锚点 sim 分钟
    _wall: 0,          // 锚点对应的真实 performance/Date 毫秒
    paused: false,

    liveMinutes() {
      const n = new Date();
      const dow = (n.getDay() + 6) % 7;          // 周一 = 0
      return dow * DAY_MIN + n.getHours() * 60 + n.getMinutes() + n.getSeconds() / 60 + n.getMilliseconds() / 60000;
    },
    now() {
      if (this.mode === 'live') return this.liveMinutes();
      if (this.paused) return this._base;
      const dt = (Date.now() - this._wall) / 60000;   // 真实分钟
      let m = this._base + dt * this.rate;
      m = ((m % WEEK_MIN) + WEEK_MIN) % WEEK_MIN;
      return m;
    },
    set(m, opt) {
      m = ((m % WEEK_MIN) + WEEK_MIN) % WEEK_MIN;
      this.mode = 'manual';
      this._base = m;
      this._wall = Date.now();
      if (opt && opt.rate != null) this.rate = opt.rate;
      this.save();
      emit();
    },
    setRate(r) {
      const m = this.now();
      this.mode = 'manual';
      this.rate = r;
      this.paused = false;
      this._base = m;
      this._wall = Date.now();
      this.save();
      emit();
    },
    pause(on) {
      const m = this.now();
      this.mode = 'manual';
      this.paused = on == null ? !this.paused : !!on;
      this._base = m;
      this._wall = Date.now();
      this.save();
      emit();
    },
    live() {
      this.mode = 'live';
      this.paused = false;
      this.rate = 1;
      this.save();
      emit();
    },
    save() {
      try {
        sessionStorage.setItem(KEY, JSON.stringify({
          mode: this.mode, rate: this.rate, paused: this.paused,
          base: this.mode === 'manual' ? this.now() : 0, wall: Date.now(),
        }));
      } catch (e) { /* 隐私模式下忽略 */ }
    },
    restore() {
      try {
        const s = JSON.parse(sessionStorage.getItem(KEY) || 'null');
        if (!s) return;
        this.mode = s.mode === 'manual' ? 'manual' : 'live';
        this.rate = s.rate || 1;
        this.paused = !!s.paused;
        if (this.mode === 'manual') {
          const gone = (Date.now() - (s.wall || Date.now())) / 60000;
          this._base = (s.base || 0) + (this.paused ? 0 : gone * this.rate);
          this._wall = Date.now();
          this._base = ((this._base % WEEK_MIN) + WEEK_MIN) % WEEK_MIN;
        }
      } catch (e) { /* 忽略 */ }
    },
  };
  H.Clock = Clock;

  const listeners = [];
  H.onClock = fn => { listeners.push(fn); };
  function emit() { listeners.forEach(f => { try { f(); } catch (e) { console.warn(e); } }); }
  H.emitClock = emit;

  /* ---------------------------------------------------------------- 时间格式 */
  H.dayOf = m => Math.floor(m / DAY_MIN) % 7;
  H.minOfDay = m => ((m % DAY_MIN) + DAY_MIN) % DAY_MIN;
  H.hhmm = m => {
    m = Math.max(0, Math.round(m));
    const h = Math.floor(m / 60) % 24, mi = m % 60;
    return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
  };
  H.hhmmss = m => {
    const t = Math.max(0, m);
    const h = Math.floor(t / 60) % 24, mi = Math.floor(t) % 60, s = Math.floor((t % 1) * 60);
    return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  };
  H.dur = m => {
    m = Math.round(m);
    const h = Math.floor(m / 60), mi = m % 60;
    return h ? `${h} 小时 ${mi} 分` : `${mi} 分`;
  };
  H.dayLabel = d => H.data.meta.week[d] + ' · ' + H.data.meta.days[d].slice(5).replace('-', '/');
  H.absStamp = m => H.data.meta.days[H.dayOf(m)] + ' ' + H.hhmm(H.minOfDay(m));
  /* '2026-08-05 08:33' -> 绝对分钟 */
  H.parseStamp = s => {
    const i = H.data.meta.days.indexOf(s.slice(0, 10));
    if (i < 0) return null;
    return i * DAY_MIN + parseInt(s.slice(11, 13), 10) * 60 + parseInt(s.slice(14, 16), 10);
  };

  H.nodeName = n => {
    if (!n) return '—';
    if (n === 'LAND') return '陆地';
    if (n[0] === 'A') return (H.data.meta.airportNames[n] || n);
    return n;
  };
  H.nodeFull = n => (n && n[0] === 'A') ? `${n} ${H.nodeName(n)}` : n;

  /* ---------------------------------------------------------------- 架次状态 */
  /* phase: idle(未到时间) | prep(登机启车) | air(空中) | ground(海上停靠) | done(已归场) */
  H.flightState = function (f, mAbs) {
    if (H.dayOf(mAbs) !== f.day) {
      return { phase: H.dayOf(mAbs) < f.day ? 'idle' : 'done' };
    }
    const t = H.minOfDay(mAbs), s = f.s, k = s.length - 1;
    if (t < s[0].d) {
      return { phase: t >= s[0].d - PREP_MIN ? 'prep' : 'idle', at: 0, node: s[0].n, until: s[0].d };
    }
    if (t >= s[k].a) return { phase: 'done', at: k, node: s[k].n };
    for (let i = 0; i < k; i++) {
      const dep = s[i].d, arr = s[i + 1].a;
      if (t < arr) {
        const span = Math.max(1e-6, arr - dep);
        return {
          phase: 'air', leg: i, p: Math.min(1, Math.max(0, (t - dep) / span)),
          from: s[i].n, to: s[i + 1].n, arr, dep, span,
          load: f.load[i],
        };
      }
      if (i + 1 < k && t < s[i + 1].d) {
        return {
          phase: 'ground', at: i + 1, node: s[i + 1].n,
          since: s[i + 1].a, until: s[i + 1].d, refuel: !!s[i + 1].r,
        };
      }
    }
    return { phase: 'done', at: k, node: s[k].n };
  };

  /* 当前有活动（prep/air/ground）的架次索引 */
  H.activeFlights = function (mAbs) {
    const d = H.data, day = H.dayOf(mAbs), out = [];
    for (const fi of d.byDay[day]) {
      const st = H.flightState(d.flights[fi], mAbs);
      if (st.phase === 'air' || st.phase === 'ground' || st.phase === 'prep') out.push({ fi, st });
    }
    return out;
  };

  H.airborneCount = function (mAbs) {
    const d = H.data, day = H.dayOf(mAbs);
    let n = 0;
    for (const fi of d.byDay[day]) {
      if (H.flightState(d.flights[fi], mAbs).phase === 'air') n++;
    }
    return n;
  };

  /* 空间位置：返回 {x, y, alt, hdg}，x/y 为 km 平面坐标 */
  H.flightPos = function (f, st, cruise) {
    const d = H.data;
    cruise = cruise == null ? 9 : cruise;
    if (st.phase === 'air') {
      const a = f.xy[st.leg], b = f.xy[st.leg + 1];
      const x = a[0] + (b[0] - a[0]) * st.p, y = a[1] + (b[1] - a[1]) * st.p;
      const span = st.span;
      // 爬升/下降各占航段的一小段，短航段自动压缩
      const ramp = Math.min(0.42, Math.max(0.1, 7 / Math.max(8, span)));
      let alt;
      if (st.p < ramp) alt = cruise * smooth(st.p / ramp);
      else if (st.p > 1 - ramp) alt = cruise * smooth((1 - st.p) / ramp);
      else alt = cruise;
      return { x, y, alt, hdg: Math.atan2(b[0] - a[0], -(b[1] - a[1])) };
    }
    const idx = st.at != null ? st.at : 0;
    const p = f.xy[idx] || f.xy[0];
    return { x: p[0], y: p[1], alt: 0, hdg: 0 };
  };
  function smooth(t) { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); }
  H.smooth = smooth;

  /* ---------------------------------------------------------------- 节点航班牌 */
  /* 某节点某天的所有停靠记录，按时间排序 */
  H.boardFor = function (node, day) {
    const d = H.data, rows = [];
    for (const { fi, si } of d.byNode[node] || []) {
      const f = d.flights[fi];
      if (f.day !== day) continue;
      const s = f.s[si], k = f.s.length - 1;
      // 上下客人数
      let on = 0, off = 0;
      for (const [pid, b, o] of f.pax) { if (b === si) on++; if (o === si) off++; }
      rows.push({
        fi, si, f, stop: s, isStart: si === 0, isEnd: si === k,
        arr: s.a, dep: s.d, on, off,
        onboard: si < k ? f.load[si] : 0,
        refuel: !!s.r,
      });
    }
    rows.sort((a, b) => (a.arr != null ? a.arr : a.dep) - (b.arr != null ? b.arr : b.dep));
    return rows;
  };

  /* 架次编号：给个像民航航班号的展示名 */
  H.flightNo = function (f) {
    const base = { A01: '1', A02: '2', A03: '3' }[f.base] || '9';
    return 'OF' + base + String(f.i + 1).padStart(3, '0');
  };
  H.acShort = ac => ac.split('-').slice(1).join('');

  /* 某架次的乘客明细（带人员档案） */
  H.paxOf = function (f) {
    return f.pax.map(([pid, b, o]) => {
      const p = H.data.people[pid];
      return {
        pid, b, o, ...p,
        from: f.s[b].n, to: f.s[o].n,
        depT: f.s[b].d, arrT: f.s[o].a,
      };
    });
  };

  /* 停靠序列的可读串：A01 › F007 › F006 › A01 */
  H.routeStr = f => f.s.map(s => s.n).join(' › ');

  /* 状态文字 */
  H.phaseText = function (st) {
    switch (st.phase) {
      case 'idle': return '计划中';
      case 'prep': return '登机 · 启车';
      case 'air': return '飞行中';
      case 'ground': return st.refuel ? '停靠 · 加油' : '停靠 · 上下客';
      case 'done': return '已归场';
      default: return '';
    }
  };

  /* ---------------------------------------------------------------- 杂项 */
  H.taskName = t => H.data.meta.taskNames[t] || '—';
  H.taskColor = t => ['#ff5f5f', '#ffc44d', '#4fd1ff', '#b98cff'][t] || '#8aa';
  H.typeColor = t => ({ T1: '#5ad1a0', T2: '#4fb0ff', T3: '#ffb454' })[t] || '#ccc';

  H.fmt = n => (n == null ? '—' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','));

  /* 找“下一个有飞机在天上”的时刻（夜航静默期给个跳转按钮） */
  H.nextActive = function (mAbs) {
    for (let step = 5; step <= WEEK_MIN; step += 5) {
      const m = (mAbs + step) % WEEK_MIN;
      if (H.airborneCount(m) > 0) return m;
    }
    return mAbs;
  };

  Clock.restore();
  global.HELI = H;
})(window);
