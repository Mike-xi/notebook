// 顶部字标（Xi Notebook）和「My notebooks」标题：不管背景是什么，都要跳出来。
//
// 先说为什么不是 mix-blend-mode: difference（教科书上的「反色」写法）：
//   1. 顶栏 z-index 80、main z-index 1，两个都是独立的层叠上下文，
//      混合根本够不到躺在 body 底下的背景画布，白字就一直是白字；
//   2. 就算够得到，difference 把 50% 灰算出来还是 50% 灰 —— 本站默认背景
//      浓淡 .55 压在浅色 surface 上，正好落在这个灰区，字直接糊没。
// backdrop-filter: invert() 也一样，任何逐像素取反都在 0.5 那儿自我抵消。
//
// 所以换成「量一下再挑」：取左上角那片背景的实际亮度（着色器背景向
// backgrounds.js 要一帧像素，图片背景离屏画一张缩略图量），亮就上黑墨、
// 暗就上白墨。中间留一段迟滞，着色器动画来回飘的时候不会一直闪。
(function () {
  if (!document.body.classList.contains('home')) return;

  const root = document.documentElement;
  // 分界线取 0.46 不是 0.5：白字和黑字的 WCAG 对比度在相对亮度 0.179 处打平，
  // 换算回这里用的 gamma 空间正好是 0.46。两边各留 4% 的迟滞，防止着色器
  // 动画在临界值上来回跳。
  const LIGHT_ON_DARK = 0.42;     // 背景比这暗 -> 白墨
  const DARK_ON_LIGHT = 0.50;     // 背景比这亮 -> 黑墨（中间那段保持原样）
  const REDRAW_MS = 5000;         // 着色器会动，隔一会儿重量一次

  const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  // 只认站内实际用到的两种写法：#rrggbb / rgb(a)()
  function parseColor(str) {
    const s = String(str || '').trim();
    if (s.startsWith('#')) {
      const h = s.length === 4
        ? s.slice(1).split('').map((x) => x + x).join('')
        : s.slice(1, 7);
      if (h.length !== 6) return null;
      return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 };
    }
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).map(Number);
    if (p.length < 3 || p.some((x) => !isFinite(x))) return null;
    return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255 };
  }

  const cssVar = (n) => getComputedStyle(root).getPropertyValue(n);
  const numVar = (n, d) => { const x = parseFloat(cssVar(n)); return isFinite(x) ? x : d; };

  // 背景画布底下压着的就是 --surface
  function surfaceLum() {
    const c = parseColor(cssVar('--surface'));
    return c ? lum(c) : (root.dataset.theme === 'dark' ? 0.06 : 0.96);
  }

  // 图片背景：离屏缩成 N×N 的缩略图存着（同源，不会污染画布），每次取样时再按
  // 当前视口算「屏幕左上角那一片」落在图的哪个位置 —— background-size: cover 会
  // 按视口比例裁图，手机竖屏和电脑宽屏看到的根本不是同一块，不能写死一个区域。
  const THUMB = 32;
  const thumbCache = new Map();
  function loadThumb(url) {
    if (thumbCache.has(url)) return Promise.resolve(thumbCache.get(url));
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = THUMB; cv.height = THUMB;
          const ctx = cv.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, THUMB, THUMB);
          const t = { ctx, w: img.naturalWidth || 1, h: img.naturalHeight || 1 };
          thumbCache.set(url, t);
          resolve(t);
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  // 屏幕左上角 42% x 26%（字标和标题都在这一片）对应到图里的平均色
  async function sampleImage(url) {
    const t = await loadThumb(url);
    if (!t) return null;
    try {
      const vw = Math.max(1, innerWidth), vh = Math.max(1, innerHeight);
      const scale = Math.max(vw / t.w, vh / t.h);          // cover
      const offX = (vw - t.w * scale) / 2, offY = (vh - t.h * scale) / 2;   // position: center
      const u = (x, y) => [(x - offX) / scale / t.w, (y - offY) / scale / t.h];
      const [ax, ay] = u(0, 0);
      const [bx, by] = u(vw * 0.42, vh * 0.26);
      const cl = (v) => Math.min(1, Math.max(0, v));
      const x0 = Math.floor(cl(ax) * THUMB), y0 = Math.floor(cl(ay) * THUMB);
      const w = Math.max(1, Math.ceil(cl(bx) * THUMB) - x0);
      const h = Math.max(1, Math.ceil(cl(by) * THUMB) - y0);
      const d = t.ctx.getImageData(x0, y0, Math.min(w, THUMB - x0), Math.min(h, THUMB - y0)).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      if (!n) return null;
      return { r: r / n / 255, g: g / n / 255, b: b / n / 255, a: 1 };
    } catch { return null; }
  }

  // 背景层的原色 + 有效不透明度，合成到 surface 上得到「眼睛看到的亮度」
  function composite(sample) {
    const base = surfaceLum();
    if (!sample) return base;
    const opacity = numVar('--nb-bg-opacity', 0.55);
    const brightness = numVar('--nb-bg-brightness', 1);
    const alpha = Math.min(1, Math.max(0, (sample.a == null ? 1 : sample.a) * opacity));
    const front = Math.min(1, lum(sample) * brightness);
    return base * (1 - alpha) + front * alpha;
  }

  let ink = root.dataset.ink || '';
  let lastLum = null;
  function applyLum(value) {
    lastLum = value;
    const next = value < LIGHT_ON_DARK ? 'light' : value > DARK_ON_LIGHT ? 'dark' : ink || (value < 0.46 ? 'light' : 'dark');
    if (next === ink) return;
    ink = next;
    root.dataset.ink = next;          // light = 浅色墨（白字），dark = 深色墨（黑字）
  }

  let pending = false;
  let again = false;
  function measure() {
    // 取样是异步的（等一帧 / 等图片加载）。中途又被叫一次不能直接丢掉 ——
    // 云端偏好回来换背景时正好压在这个窗口里，丢了就一直按旧背景定墨色。
    if (pending) { again = true; return; }
    pending = true;
    const bg = root.dataset.bg || 'none';
    const done = (sample) => {
      pending = false;
      applyLum(composite(sample));
      if (again) { again = false; measure(); }
    };

    if (bg === 'none') { done(null); return; }
    if (bg.startsWith('custom:')) {
      const layer = document.querySelector('.nb-background-image');
      const url = layer && (layer.style.backgroundImage || '').match(/url\(["']?([^"')]+)/);
      if (!url) { done(null); return; }
      sampleImage(url[1]).then(done);
      return;
    }
    if (typeof window.NBBackgroundSample === 'function') { window.NBBackgroundSample(done); return; }
    done(null);
  }

  // 背景 / 主题 / 浓淡 / 亮度 变了都要重量；着色器在动，再挂一个低频复查。
  ['nb-background-change', 'nb-theme-change', 'nb-background-opacity', 'nb-appearance-hydrated', 'nb-backgrounds-loaded']
    .forEach((e) => addEventListener(e, () => setTimeout(measure, 60)));
  addEventListener('resize', () => setTimeout(measure, 200), { passive: true });
  setInterval(() => { if (!document.hidden) measure(); }, REDRAW_MS);

  measure();
  // 首帧着色器可能还没画出来、云端偏好也还没回来，前几秒多补几次
  [400, 1200, 2600, 4200].forEach((t) => setTimeout(measure, t));
  window.NBInk = { measure, get lum() { return lastLum; } };
})();
