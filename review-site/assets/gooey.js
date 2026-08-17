// 分段控件的黏液（gooey）指示器。
//
// 移植自 React Bits「GooeyNav」（公开 registry，JS-CSS 变体）：原版是一个自带
// <ul> 的导航组件，这里改成「就地增强」—— 不动现有 .seg / .seg-btn 结构，只往
// 容器里插两层 effect，所以 theme.js / premium.js 原来绑的点击逻辑一行都不用改。
//
// 原理和原版一致：一层 .effect.filter 里放白（或黑）色小球，靠
// filter: blur() contrast() 把它们熔成一坨，再用 mix-blend-mode 把底色抠掉。
// 亮色主题下底色是白、球是深色、混合模式 darken；暗色主题反过来。
(function () {
  const ANIM_MS = 600;
  const PILL_DELAY = 260;      // 粒子开始汇聚到药丸长出来之间的间隔
  const PARTICLES = 14;
  const DIST = [86, 10];
  const R = 100;
  const TIME_VAR = 300;
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');

  const noise = (n = 1) => n / 2 - Math.random() * n;

  function getXY(distance, pointIndex, totalPoints) {
    const angle = ((360 + noise(8)) / totalPoints) * pointIndex * (Math.PI / 180);
    return [distance * Math.cos(angle), distance * Math.sin(angle)];
  }

  function makeParticles(host) {
    if (REDUCED.matches) return;
    host.style.setProperty('--time', `${ANIM_MS * 2 + TIME_VAR}ms`);
    for (let i = 0; i < PARTICLES; i++) {
      const t = ANIM_MS * 2 + noise(TIME_VAR * 2);
      const start = getXY(DIST[0], PARTICLES - i, PARTICLES);
      const end = getXY(DIST[1] + noise(7), PARTICLES - i, PARTICLES);
      const rot = noise(R / 10);
      const rotate = (rot > 0 ? rot + R / 20 : rot - R / 20) * 10;
      host.classList.remove('active');

      setTimeout(() => {
        const particle = document.createElement('span');
        const point = document.createElement('span');
        particle.className = 'particle';
        particle.style.setProperty('--start-x', `${start[0]}px`);
        particle.style.setProperty('--start-y', `${start[1]}px`);
        particle.style.setProperty('--end-x', `${end[0]}px`);
        particle.style.setProperty('--end-y', `${end[1]}px`);
        particle.style.setProperty('--time', `${t}ms`);
        particle.style.setProperty('--scale', `${1 + noise(0.2)}`);
        particle.style.setProperty('--rotate', `${rotate}deg`);
        point.className = 'point';
        particle.appendChild(point);
        host.appendChild(particle);
        requestAnimationFrame(() => host.classList.add('active'));
        setTimeout(() => { try { host.removeChild(particle); } catch (_) { /* 已被清掉 */ } }, t);
      }, 30);
    }
  }

  // 药丸的位置只能在元素真正有尺寸时才算得出来，而这些控件多半躺在初始 hidden 的
  // 设置面板里。ResizeObserver / IntersectionObserver 在祖先 display:none 时都不
  // 回调（实测一次都不触发），所以这里用一个低频自校正循环兜底：每 250ms 扫一遍
  // 已增强的控件，尺寸对不上就重新贴。4 个元素的 offsetWidth 读取，开销可以忽略。
  const TRACKED = [];
  setInterval(() => {
    for (const seg of TRACKED) {
      const btn = seg.querySelector('.seg-btn.active') || seg.querySelector('.seg-btn');
      if (!btn || !btn.offsetWidth) continue;
      const f = seg.querySelector('.effect.filter');
      if (f && f.style.width !== `${btn.offsetWidth}px`) seg.__gooeyRefresh();
    }
  }, 250);

  function enhance(seg) {
    if (seg.__gooey) return;
    seg.__gooey = true;
    seg.classList.add('gooey');

    // 两层：pill 是实心药丸（不加滤镜、不混合，保证深浅两色下都填得实），
    // filter 只负责粒子的「熔球」效果 —— 原版把两件事塞在同一层，靠 contrast
    // 把药丸也一起烧成纯色，但那依赖底色，换主题就露馅。
    const pill = document.createElement('span');
    pill.className = 'effect pill';
    pill.setAttribute('aria-hidden', 'true');
    seg.appendChild(pill);

    const filter = document.createElement('span');
    filter.className = 'effect filter';
    filter.setAttribute('aria-hidden', 'true');
    seg.appendChild(filter);

    // 药丸贴到当前选中的那一格上；用 offset 而不是 getBoundingClientRect，
    // 免得设置面板还在弹出动画（scale）里时算出被缩放过的尺寸。
    let pillTimer = 0;
    let spawning = false;                // 正在放「粒子汇聚 → 药丸长出」这段动画
    function place(btn, animate) {
      if (!btn) return;
      const box = {
        left: `${btn.offsetLeft}px`, top: `${btn.offsetTop}px`,
        width: `${btn.offsetWidth}px`, height: `${btn.offsetHeight}px`,
      };
      Object.assign(filter.style, box);

      if (!animate) {
        // 初次定位 / 尺寸变化：直接就位。注意不能顺手清掉 spawning ——
        // 点击后业务代码会改 .active 类，MutationObserver 立刻走到这一支，
        // 把刚设上的收缩状态抹掉，药丸就又变成「先出现再放粒子」了。
        Object.assign(pill.style, box);
        if (!spawning) pill.classList.remove('spawning');
        return;
      }

      // 点击时的顺序：药丸先在旧位置消失 → 瞬移到新位置 → 粒子往里汇聚 →
      // 汇聚到位时药丸才从中心长出来。原来是药丸先滑过去再放粒子，观感是
      // 「一大坨紫色先出现、粒子后补」，正好反了。
      clearTimeout(pillTimer);
      spawning = true;
      pill.classList.add('spawning');    // scale(0)，且此刻不带位移过渡
      void pill.offsetWidth;
      Object.assign(pill.style, box);    // 隐身状态下瞬移，不会被看到滑动
      [...filter.querySelectorAll('.particle')].forEach((p) => p.remove());
      makeParticles(filter);
      // 粒子 30ms 后开始飞，到 ~65% 才收拢到中心，这里等它们聚拢再放药丸
      pillTimer = setTimeout(() => {
        spawning = false;
        pill.classList.remove('spawning');
      }, PILL_DELAY);
    }

    const activeBtn = () => seg.querySelector('.seg-btn.active') || seg.querySelector('.seg-btn');

    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn || btn.parentElement !== seg) return;
      // 点击时业务代码可能还没来得及切 .active，直接按点到的那个走
      place(btn, true);
    });

    const refresh = () => place(activeBtn(), false);

    // 别处（快捷键、云端同步）改了选中项也要跟上
    const mo = new MutationObserver(refresh);
    seg.querySelectorAll('.seg-btn').forEach((b) => mo.observe(b, { attributes: true, attributeFilter: ['class'] }));

    refresh();
    seg.__gooeyRefresh = refresh;
    TRACKED.push(seg);
    return { refresh };
  }

  function enhanceAll(root) {
    (root || document).querySelectorAll('.seg').forEach(enhance);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => enhanceAll());
  else enhanceAll();

  window.NBGooey = { enhance, enhanceAll };
})();
