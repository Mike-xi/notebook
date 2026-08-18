// 弹性滑杆。
//
// 移植自 React Bits「ElasticSlider」（原版依赖 motion/react + chakra 图标，这里全部
// 用原生 pointer 事件 + CSS transform 重写，行为对齐原版）：
//   · 悬停/按住时整条杆放大到 1.2、轨道从 6px 长到 12px，不悬停时半透明
//   · 拖到两端之外，轨道会顺着方向被「拉长压扁」，位移经 sigmoid 衰减，最多 50px
//   · 松手后弹回（原版用 spring bounce 0.5，这里用等效的回弹缓动）
//   · 两端图标在越界那一侧会顶一下
//   · 当前值浮在杆上方
//
// 用法：把一个 <input type="range"> 交给 NBSlider.enhance(input, {left, right})，
// 原 input 会被藏起来但仍然是唯一的数据源（value / input / change 事件都照旧派发），
// 所以 theme.js 那边绑的监听一行都不用改。
(function () {
  const MAX_OVERFLOW = 50;

  // 越界位移的衰减：sigmoid，越拉越沉，永远到不了 max
  function decay(value, max) {
    if (max === 0) return 0;
    const entry = value / max;
    const sigmoid = 2 * (1 / (1 + Math.exp(-entry)) - 0.5);
    return sigmoid * max;
  }

  function enhance(input, opts) {
    if (!input || input.__nbSlider) return null;
    input.__nbSlider = true;
    const o = opts || {};

    const min = parseFloat(input.min || '0');
    const max = parseFloat(input.max || '100');
    const step = parseFloat(input.step || '1') || 1;
    const fmt = o.format || ((v) => String(Math.round(((v - min) / (max - min)) * 100)));

    // 两侧图标都是可选的：没给就整个不渲染，免得留下 15px 空位把杆挤窄。
    // 本站三根杆都只挂左边一个图标当标签（文字标签已去掉，见 index.html）。
    const wrap = document.createElement('div');
    wrap.className = 'es-wrap';
    wrap.innerHTML = `
      ${o.left ? `<span class="es-icon es-left" aria-hidden="true">${o.left}</span>` : ''}
      <div class="es-root">
        <span class="es-value" aria-hidden="true"></span>
        <div class="es-track-wrap">
          <div class="es-track"><div class="es-range"></div></div>
        </div>
      </div>
      ${o.right ? `<span class="es-icon es-right" aria-hidden="true">${o.right}</span>` : ''}`;
    input.parentNode.insertBefore(wrap, input);
    input.classList.add('es-native');   // 藏起来但保留可聚焦，键盘仍能操作

    const root = wrap.querySelector('.es-root');
    const trackWrap = wrap.querySelector('.es-track-wrap');
    const range = wrap.querySelector('.es-range');
    const valueEl = wrap.querySelector('.es-value');
    const iconL = wrap.querySelector('.es-left');
    const iconR = wrap.querySelector('.es-right');
    const nudge = (el, px) => { if (el) el.style.transform = `translateX(${px}px)`; };

    let overflow = 0;       // 越界位移（px，带符号：左负右正）
    let scale = 1;          // 整条杆的缩放
    let dragging = false;
    let raf = 0;

    function paint() {
      const v = parseFloat(input.value);
      const pct = max === min ? 0 : ((v - min) / (max - min)) * 100;
      range.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      valueEl.textContent = fmt(v);

      const w = root.clientWidth || 1;
      const scaleX = 1 + Math.abs(overflow) / w;
      const scaleY = 1 - (Math.abs(overflow) / MAX_OVERFLOW) * 0.2;
      // 往左越界就以右端为支点拉伸，反之亦然
      trackWrap.style.transformOrigin = overflow < 0 ? 'right' : 'left';
      trackWrap.style.transform = `scaleX(${scaleX}) scaleY(${scaleY})`;
      nudge(iconL, overflow < 0 ? overflow / scale : 0);
      nudge(iconR, overflow > 0 ? overflow / scale : 0);
      wrap.style.setProperty('--es-scale', String(scale));
    }

    function setScale(s) { scale = s; wrap.classList.toggle('es-active', s > 1); paint(); }

    function valueFromX(clientX) {
      const r = root.getBoundingClientRect();
      let v = min + ((clientX - r.left) / r.width) * (max - min);
      v = Math.round(v / step) * step;
      return Math.min(max, Math.max(min, v));
    }

    function move(e) {
      const r = root.getBoundingClientRect();
      let raw = 0;
      if (e.clientX < r.left) raw = -(r.left - e.clientX);
      else if (e.clientX > r.right) raw = e.clientX - r.right;
      overflow = raw === 0 ? 0 : Math.sign(raw) * decay(Math.abs(raw), MAX_OVERFLOW);

      const v = valueFromX(e.clientX);
      if (parseFloat(input.value) !== v) {
        input.value = String(v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      paint();
    }

    // 松手回弹：原版是 spring(bounce .5)，这里用一段带过冲的手写缓动，观感一致
    function springBack() {
      cancelAnimationFrame(raf);
      const from = overflow;
      const t0 = performance.now();
      const dur = 520;
      const tick = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        // 阻尼振荡
        const damp = Math.exp(-6 * p) * Math.cos(10 * p);
        overflow = from * damp;
        paint();
        if (p < 1) raf = requestAnimationFrame(tick);
        else { overflow = 0; paint(); }
      };
      raf = requestAnimationFrame(tick);
    }

    root.addEventListener('pointerdown', (e) => {
      dragging = true;
      root.setPointerCapture(e.pointerId);
      setScale(1.2);
      move(e);
      e.preventDefault();
    });
    root.addEventListener('pointermove', (e) => { if (dragging) move(e); });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      springBack();
      if (!wrap.matches(':hover')) setScale(1);
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    root.addEventListener('lostpointercapture', end);

    wrap.addEventListener('pointerenter', () => setScale(1.2));
    wrap.addEventListener('pointerleave', () => { if (!dragging) setScale(1); });

    // 别处（云端同步、键盘操作原生 input）改了值也要跟上
    input.addEventListener('input', paint);
    input.addEventListener('change', paint);
    new ResizeObserver(paint).observe(root);
    // 设置面板初始 hidden 时观察器不回调，低频兜一下（同 segment.js 的处理）
    setInterval(paint, 400);

    paint();
    return { refresh: paint };
  }

  window.NBSlider = { enhance };
})();
