// 分段控件（.seg / .seg-btn）的滑块指示器。
//
// 取代上一版的 GooeyNav 粒子熔球：那个效果每次切换都要放 14 颗粒子 + blur/contrast
// 熔球，在设置面板这种窄格子里既吵又糊，还得靠 mix-blend-mode 抠底色，换主题就露馅。
// 这一版走的是 Linear / Vercel / iOS 那一类 segmented control 的常规做法（也是
// createui.co 等组件库里 segmented-control 的实现路子）：一块药丸在格子之间滑，
// 位置和宽度都用 transform / width 过渡，曲线带一点点回弹。
//
// 唯一的花招是「拉伸」：滑行途中按滑行距离把药丸横向拉长一点，到位再收回去
// （squash & stretch），比匀速平移有分量。
//
// 就地增强，不动 DOM 结构：选中状态仍然是别处业务代码往 .seg-btn 上加 .active，
// 这里只是跟着贴。所以 theme.js / premium.js / app.js 的点击逻辑一行都不用改。
(function () {
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
  const STRETCH_MS = 260;      // 拉伸保持的时长，与 CSS 里的位移过渡对齐

  // 药丸的位置只能在元素真正有尺寸时才算得出来，而这些控件多半躺在初始 hidden 的
  // 设置面板里。ResizeObserver / IntersectionObserver 在祖先 display:none 时都不
  // 回调（实测一次都不触发），所以用一个低频自校正循环兜底：每 250ms 扫一遍已增强
  // 的控件，尺寸对不上就重新贴。几个元素的 offsetWidth 读取，开销可以忽略。
  const TRACKED = [];
  setInterval(() => {
    for (const seg of TRACKED) {
      const btn = seg.querySelector('.seg-btn.active') || seg.querySelector('.seg-btn');
      if (!btn || !btn.offsetWidth) continue;
      if (seg.__segW !== btn.offsetWidth || seg.__segX !== btn.offsetLeft) seg.__segRefresh();
    }
  }, 250);

  function enhance(seg) {
    if (seg.__seg) return;
    seg.__seg = true;
    seg.classList.add('slide');

    const thumb = document.createElement('span');
    thumb.className = 'seg-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    seg.insertBefore(thumb, seg.firstChild);

    let stretchTimer = 0;

    // 用 offsetLeft/offsetWidth 而不是 getBoundingClientRect：设置面板弹出时带
    // scale 动画，rect 会量到被缩放过的尺寸，药丸就贴歪了。
    function place(btn, animate) {
      if (!btn || !btn.offsetWidth) return;
      const from = seg.__segX;
      const x = btn.offsetLeft;
      const w = btn.offsetWidth;
      seg.__segX = x;
      seg.__segW = w;

      thumb.style.width = `${w}px`;
      thumb.style.height = `${btn.offsetHeight}px`;
      thumb.style.setProperty('--tx', `${x}px`);
      thumb.style.setProperty('--ty', `${btn.offsetTop}px`);

      clearTimeout(stretchTimer);
      if (!animate || REDUCED.matches || from == null) {
        thumb.classList.remove('moving');
        thumb.style.setProperty('--sx', '1');
        return;
      }
      // 滑得越远拉得越长，封顶 1.16 —— 再多就成橡皮筋了
      const dist = Math.abs(x - from);
      const sx = Math.min(1.16, 1 + dist / (w * 7));
      thumb.classList.add('moving');
      thumb.style.setProperty('--sx', sx.toFixed(3));
      stretchTimer = setTimeout(() => {
        thumb.style.setProperty('--sx', '1');
        thumb.classList.remove('moving');
      }, STRETCH_MS);
    }

    const activeBtn = () => seg.querySelector('.seg-btn.active') || seg.querySelector('.seg-btn');
    const refresh = () => place(activeBtn(), false);

    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn || btn.parentElement !== seg) return;
      // 点击时业务代码可能还没来得及切 .active，直接按点到的那个走
      place(btn, true);
    });

    // 别处（快捷键、云端同步、location.reload 前的回填）改了选中项也要跟上
    const mo = new MutationObserver(() => place(activeBtn(), true));
    seg.querySelectorAll('.seg-btn').forEach((b) => mo.observe(b, { attributes: true, attributeFilter: ['class'] }));

    refresh();
    seg.__segRefresh = refresh;
    TRACKED.push(seg);
    return { refresh };
  }

  function enhanceAll(root) {
    (root || document).querySelectorAll('.seg').forEach(enhance);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => enhanceAll());
  else enhanceAll();

  window.NBSegment = { enhance, enhanceAll };
})();
