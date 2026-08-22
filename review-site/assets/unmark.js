// 可见水印擦除 · 界面
//
// 流程：进图 → 涂/框出水印 → 擦。推理内核见 unmark-core.js。
// 图片全程留在本机，不上传服务器；唯一走网络的是那份 28MB 权重，且只下一次。
//
// 「多处水印」是这页的主场景，所以给了三条路：
//   ① 画笔随便涂几块，一次擦掉（蒙版本来就支持多个不连通区域）
//   ② 方框工具，适合规整的角标
//   ③ **找出所有相同水印** —— 框住其中一个，自动在全图找同款并一起选上。
//      平铺重复水印（图库那种满屏斜排）用这个最省事。
(function () {
  const $ = (id) => document.getElementById(id);

  const stage = $('um-stage');
  const baseC = $('um-base');       // 原图
  const maskC = $('um-mask');       // 蒙版（半透明红）
  const baseX = baseC.getContext('2d', { willReadFrequently: true });
  const maskX = maskC.getContext('2d', { willReadFrequently: true });

  let img = null;                    // 当前工作图（每擦一次就更新成结果，便于接着擦下一处）
  let originalData = null;           // 刚载入时的原始像素，用于「按住看原图」和「还原」
  let imgW = 0, imgH = 0;
  let history = [];                  // 蒙版撤销栈
  let resultData = null;             // 擦完的结果
  let tool = 'brush';
  let brush = 34;
  let busy = false;

  function say(text, kind) {
    const el = $('um-msg');
    if (!text) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = text;
    el.className = 'um-msg' + (kind ? ' ' + kind : '');
  }

  function setBusy(on, label) {
    busy = on;
    $('um-run').disabled = on || !img;
    $('um-run').textContent = on ? (label || '处理中…') : '擦掉选中区域';
  }

  // ===== 载入图片 =====
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('图片解不开'));
      im.src = src;
    });
  }

  async function useFile(file) {
    if (!file || !file.type.startsWith('image/')) { say('请给一张图片（PNG / JPG / WebP）', 'err'); return; }
    say('正在载入…');
    try {
      const url = URL.createObjectURL(file);
      const im = await loadImage(url);
      URL.revokeObjectURL(url);

      // 太大的图先缩一缩：MI-GAN 是逐像素跑的，4000px 的图在 WASM 上要等很久，
      // 而且擦水印这种活儿 2000px 已经够用了。缩放比例告诉用户，别让他以为掉画质是 bug。
      const MAX = 2000;
      let w = im.naturalWidth, h = im.naturalHeight;
      let scaled = false;
      if (Math.max(w, h) > MAX) {
        const k = MAX / Math.max(w, h);
        w = Math.round(w * k); h = Math.round(h * k);
        scaled = true;
      }
      imgW = w; imgH = h;
      baseC.width = maskC.width = w;
      baseC.height = maskC.height = h;
      baseX.drawImage(im, 0, 0, w, h);
      img = baseX.getImageData(0, 0, w, h);
      originalData = new ImageData(new Uint8ClampedArray(img.data), w, h);
      maskX.clearRect(0, 0, w, h);
      history = [];
      resultData = null;
      $('um-empty').hidden = true;
      stage.hidden = false;
      $('um-tools').hidden = false;
      fitStage();
      setBusy(false);
      $('um-save').disabled = true;
      $('um-compare').disabled = true;
      say(scaled
        ? `已载入并缩放到 ${w}×${h}（原图 ${im.naturalWidth}×${im.naturalHeight}，超过 2000px 会很慢）`
        : `已载入 ${w}×${h}`, 'ok');
    } catch (e) {
      say(e.message || '载入失败', 'err');
    }
  }

  // 画布按容器宽度自适应，指针坐标要换算回图片坐标
  function fitStage() {
    const maxW = stage.parentElement.clientWidth - 2;
    const k = Math.min(1, maxW / imgW);
    const w = Math.round(imgW * k), h = Math.round(imgH * k);
    for (const c of [baseC, maskC]) { c.style.width = w + 'px'; c.style.height = h + 'px'; }
    stage.style.width = w + 'px';
    stage.style.height = h + 'px';
  }
  window.addEventListener('resize', () => { if (img) fitStage(); });

  function toImgXY(e) {
    const r = maskC.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width * imgW,
      y: (e.clientY - r.top) / r.height * imgH,
    };
  }

  function pushHistory() {
    history.push(maskX.getImageData(0, 0, imgW, imgH));
    if (history.length > 20) history.shift();
    $('um-undo').disabled = false;
  }

  // ===== 涂抹 / 框选 =====
  let drawing = false, rectStart = null;

  maskC.addEventListener('pointerdown', (e) => {
    if (!img || busy) return;
    e.preventDefault();
    maskC.setPointerCapture(e.pointerId);
    pushHistory();
    drawing = true;
    const p = toImgXY(e);
    if (tool === 'rect') { rectStart = p; }
    else { paint(p, p); }
  });
  maskC.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = toImgXY(e);
    if (tool === 'rect') {
      // 框选过程中实时预览：先还原到按下时的状态，再画当前矩形
      maskX.putImageData(history[history.length - 1], 0, 0);
      drawRect(rectStart, p);
    } else {
      paint(lastPt || p, p);
    }
    lastPt = p;
  });
  let lastPt = null;
  const endDraw = () => { drawing = false; lastPt = null; rectStart = null; };
  maskC.addEventListener('pointerup', endDraw);
  maskC.addEventListener('pointercancel', endDraw);

  function paint(a, b) {
    maskX.save();
    maskX.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over';
    maskX.strokeStyle = 'rgba(230,70,60,.55)';
    maskX.lineWidth = brush;
    maskX.lineCap = 'round';
    maskX.lineJoin = 'round';
    maskX.beginPath();
    maskX.moveTo(a.x, a.y);
    maskX.lineTo(b.x, b.y);
    maskX.stroke();
    maskX.restore();
  }

  function drawRect(a, b) {
    maskX.save();
    maskX.fillStyle = 'rgba(230,70,60,.55)';
    maskX.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    maskX.restore();
  }

  $('um-undo').addEventListener('click', () => {
    const prev = history.pop();
    if (!prev) return;
    maskX.putImageData(prev, 0, 0);
    $('um-undo').disabled = !history.length;
  });
  $('um-clear').addEventListener('click', () => {
    if (!img) return;
    pushHistory();
    maskX.clearRect(0, 0, imgW, imgH);
  });

  document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
    tool = b.dataset.tool;
    document.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('active', x === b));
    maskC.style.cursor = tool === 'rect' ? 'crosshair' : 'cell';
  }));
  $('um-brush').addEventListener('input', (e) => {
    brush = Number(e.target.value);
    $('um-brush-val').textContent = brush;
  });

  // ===== 找出所有相同水印 =====
  // 平铺/重复水印（图库那种满屏斜排、或者四角各一个）是「多处水印」最常见的形态。
  // 做法是归一化互相关（NCC）模板匹配：拿选中区域当模板，在全图找相关度高的位置。
  //
  // 直接在原分辨率上暴力匹配是 O(模板面积 × 图面积)，1000×800 的图配 100×40 的模板
  // 就要三十亿次乘加，浏览器里没法接受。所以走**粗筛 + 精配**两段：
  //
  //   粗筛：图和模板都降到 1/4 灰度，用很松的阈值捞一批候选（数量级降到千万，秒级）。
  //   精配：只对候选点，在 ±4px 的小窗口里做全分辨率 NCC，取最好的那个偏移。
  //
  // **为什么必须有精配这一步**：块平均降采样是带相位的。同一个水印出现在 y=30 和
  // y=160，除以 4 一个有余数一个没有，落进的采样格子不一样，平均下来图案就变形了。
  // 实测四枚一模一样的水印，只在粗筛层比对，NCC 是 1.00 / 0.79 / 0.57 / 0.44 一路掉下来，
  // 不管阈值定在哪儿都会漏。放到全分辨率上比就没这个问题。
  const DOWN = 4;
  const COARSE_T = 0.35;   // 粗筛只负责别漏，宁可多捞
  const FINE_T = 0.70;     // 精配才是真正的判据

  function grayFull(data, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, p = 0; p < g.length; p++, i += 4) {
      g[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return g;
  }

  // 去均值 + 归一化的模板，配合 nccAt 算相关系数
  function makeTpl(g, w, box) {
    const t = new Float32Array(box.w * box.h);
    let mean = 0;
    for (let y = 0; y < box.h; y++) {
      for (let x = 0; x < box.w; x++) {
        const v = g[(box.y + y) * w + (box.x + x)];
        t[y * box.w + x] = v; mean += v;
      }
    }
    mean /= t.length;
    let norm = 0;
    for (let i = 0; i < t.length; i++) { t[i] -= mean; norm += t[i] * t[i]; }
    return { t, norm: Math.sqrt(norm) || 1, w: box.w, h: box.h };
  }

  function nccAt(g, gw, gh, tpl, x, y) {
    if (x < 0 || y < 0 || x + tpl.w > gw || y + tpl.h > gh) return -1;
    let mean = 0;
    for (let j = 0; j < tpl.h; j++) for (let i = 0; i < tpl.w; i++) mean += g[(y + j) * gw + (x + i)];
    mean /= tpl.w * tpl.h;
    let dot = 0, norm = 0;
    for (let j = 0; j < tpl.h; j++) {
      for (let i = 0; i < tpl.w; i++) {
        const d = g[(y + j) * gw + (x + i)] - mean;
        dot += d * tpl.t[j * tpl.w + i];
        norm += d * d;
      }
    }
    return dot / (Math.sqrt(norm) * tpl.norm || 1);
  }

  function grayDown(data, w, h, k) {
    const gw = Math.floor(w / k), gh = Math.floor(h / k);
    const g = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let s = 0;
        for (let dy = 0; dy < k; dy++) {
          for (let dx = 0; dx < k; dx++) {
            const i = ((y * k + dy) * w + (x * k + dx)) * 4;
            s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          }
        }
        g[y * gw + x] = s / (k * k);
      }
    }
    return { g, w: gw, h: gh };
  }

  // 取蒙版当前的包围盒，当模板用
  function maskBBox() {
    const m = maskX.getImageData(0, 0, imgW, imgH).data;
    let x0 = imgW, y0 = imgH, x1 = -1, y1 = -1;
    for (let y = 0; y < imgH; y++) {
      for (let x = 0; x < imgW; x++) {
        if (m[(y * imgW + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  $('um-find').addEventListener('click', async () => {
    if (!img || busy) return;
    const box = maskBBox();
    if (!box) { say('先框住或涂出其中一个水印，再点这里', 'err'); return; }
    if (box.w < DOWN * 3 || box.h < DOWN * 3) { say('选区太小了，框大一点再找', 'err'); return; }

    setBusy(true, '搜索中…');
    say('正在全图搜索相同图案…');
    await new Promise((r) => setTimeout(r, 30));   // 让浏览器先把「搜索中」画出来

    try {
      // ---- ① 粗筛 ----
      const big = grayDown(img.data, imgW, imgH, DOWN);
      const cBox = {
        x: Math.floor(box.x / DOWN), y: Math.floor(box.y / DOWN),
        w: Math.max(2, Math.floor(box.w / DOWN)), h: Math.max(2, Math.floor(box.h / DOWN)),
      };
      const cTpl = makeTpl(big.g, big.w, cBox);
      const cand = [];
      for (let y = 0; y + cTpl.h <= big.h; y++) {
        for (let x = 0; x + cTpl.w <= big.w; x++) {
          const v = nccAt(big.g, big.w, big.h, cTpl, x, y);
          if (v > COARSE_T) cand.push({ x: x * DOWN, y: y * DOWN, v });
        }
      }
      // 粗筛层先做一次疏化，别把几千个候选全丢给精配
      cand.sort((a, b) => b.v - a.v);
      const coarse = [];
      for (const s of cand) {
        if (coarse.some((k) => Math.abs(k.x - s.x) < box.w * 0.5 && Math.abs(k.y - s.y) < box.h * 0.5)) continue;
        coarse.push(s);
        if (coarse.length >= 200) break;
      }

      // ---- ② 全分辨率精配 ----
      const full = grayFull(img.data, imgW, imgH);
      const fTpl = makeTpl(full, imgW, box);
      const hits = [];
      const R = DOWN;                       // 粗筛的位置误差最多就是一个降采样格
      for (const c of coarse) {
        let best = -1, bx = c.x, by = c.y;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            const v = nccAt(full, imgW, imgH, fTpl, c.x + dx, c.y + dy);
            if (v > best) { best = v; bx = c.x + dx; by = c.y + dy; }
          }
        }
        if (best >= FINE_T) hits.push({ x: bx, y: by, v: best });
      }

      // ---- ③ 非极大值抑制 ----
      hits.sort((a, b) => b.v - a.v);
      const keep = [];
      for (const s of hits) {
        if (keep.some((k) => Math.abs(k.x - s.x) < box.w * 0.6 && Math.abs(k.y - s.y) < box.h * 0.6)) continue;
        keep.push(s);
        if (keep.length >= 60) break;
      }

      pushHistory();
      maskX.save();
      maskX.fillStyle = 'rgba(230,70,60,.55)';
      const pad = 3;                        // 往外放一点，把水印边缘的半透明像素也盖住
      for (const k of keep) {
        maskX.fillRect(k.x - pad, k.y - pad, box.w + pad * 2, box.h + pad * 2);
      }
      maskX.restore();
      say(keep.length > 1
        ? `找到 ${keep.length} 处相同图案，已全部选上。多选/漏选可以用画笔和橡皮改。`
        : '只找到你框的这一处，图里可能没有重复水印。', keep.length > 1 ? 'ok' : '');
    } catch (e) {
      say('搜索失败：' + (e.message || e), 'err');
    }
    setBusy(false);
  });

  // ===== 擦 =====
  $('um-run').addEventListener('click', async () => {
    if (!img || busy) return;
    setBusy(true, '准备模型…');
    try {
      const mask = maskX.getImageData(0, 0, imgW, imgH);
      const out = await window.NBUnmark.inpaint(img, mask, (p, got, total, cached) => {
        if (cached) { say('模型已在本机缓存，直接开算'); return; }
        setBusy(true, `下载模型 ${(p * 100).toFixed(0)}%`);
        say(`首次使用要下载 28MB 的模型（${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB），之后本机就不用再下了`);
      });
      setBusy(true, '生成中…');
      say('正在重建被遮住的区域…');
      resultData = out;
      baseX.putImageData(out, 0, 0);
      img = out;                                  // 允许接着擦下一处
      maskX.clearRect(0, 0, imgW, imgH);
      history = [];
      $('um-undo').disabled = true;
      $('um-save').disabled = false;
      $('um-compare').disabled = false;
      say('擦完了。还有没干净的地方可以接着涂、再擦一次。', 'ok');
    } catch (e) {
      say('失败：' + (e.message || e), 'err');
    }
    setBusy(false);
  });

  // 按住看原图
  const cmp = $('um-compare');
  let beforeData = null;
  ['pointerdown', 'pointerenter'].forEach((k) => cmp.addEventListener(k, () => {
    if (!originalData || cmp.disabled) return;
    beforeData = baseX.getImageData(0, 0, imgW, imgH);
    baseX.putImageData(originalData, 0, 0);
  }));
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((k) => cmp.addEventListener(k, () => {
    if (beforeData) { baseX.putImageData(beforeData, 0, 0); beforeData = null; }
  }));

  $('um-save').addEventListener('click', () => {
    baseC.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'unmarked.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  });

  $('um-reset').addEventListener('click', () => {
    if (!originalData) return;
    baseX.putImageData(originalData, 0, 0);
    img = new ImageData(new Uint8ClampedArray(originalData.data), imgW, imgH);
    maskX.clearRect(0, 0, imgW, imgH);
    history = [];
    $('um-undo').disabled = true;
    $('um-save').disabled = true;
    $('um-compare').disabled = true;
    say('已还原成刚载入时的样子');
  });

  // ===== 进图的三条路 =====
  $('um-pick').addEventListener('click', () => $('um-file').click());
  $('um-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) useFile(f);
  });
  const drop = $('um-drop');
  ['dragenter', 'dragover'].forEach((k) => drop.addEventListener(k, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((k) => drop.addEventListener(k, (e) => {
    e.preventDefault();
    if (k === 'dragleave' && drop.contains(e.relatedTarget)) return;
    drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) useFile(f);
  });
  window.addEventListener('paste', (e) => {
    const it = [...(e.clipboardData?.items || [])].find((x) => x.type.startsWith('image/'));
    if (it) useFile(it.getAsFile());
  });

  // 环境提示：没有 WebGPU 就走单线程 WASM，慢很多，先说清楚
  if (!window.NBUnmark.hasWebGPU()) {
    $('um-env').textContent = '当前浏览器没有 WebGPU，将用 WASM 单线程计算，大图会比较慢（建议用新版 Chrome / Edge）。';
    $('um-env').hidden = false;
  }
  window.NBUnmark.hasCache().then((c) => {
    if (c) { $('um-env').textContent = '模型已缓存在本机，不用再下载。'; $('um-env').hidden = false; }
  });
})();
