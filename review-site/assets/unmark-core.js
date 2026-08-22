// 可见水印擦除 · 推理内核（MI-GAN，纯浏览器）
//
// 干的事：图片 + 蒙版 → 把蒙版盖住的地方按周围内容重新长出来（image inpainting）。
// 模型是 Picsart 的 MI-GAN（migan_pipeline_v2.onnx，28MB），跑在 onnxruntime-web 上，
// 有 WebGPU 就用 WebGPU，没有退回 WASM。全程在本机，图片不上传。
//
// —— 关于参考实现 ——
// 同样用这个模型的 inpaint-web (lxfater) 是 **GPL-3.0**，所以这份胶水是照着模型的
// 输入输出约定重写的，没有抄它的代码。实际要做的事也就三件：
//   ① canvas 的 RGBA 拆成 uint8 的 NCHW（三通道，去掉 alpha）
//   ② 蒙版做成 1×1×H×W 的 uint8，**要擦的地方是 0、保留的地方是 255**（极性反直觉，见下）
//   ③ 输出的 NCHW 拼回 RGBA 画到 canvas
// pipeline_v2 这一版内部自己做分块，任意分辨率进、同分辨率出，不用外面切图。
(function () {
  const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/';
  const MODEL_URL = '/api/model/migan';
  const DB_NAME = 'nb-models';
  const STORE = 'weights';
  const DB_KEY = 'migan_pipeline_v2';

  let session = null;
  let ortReady = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('加载失败：' + src));
      document.head.appendChild(s);
    });
  }

  // ---- IndexedDB：28MB 只下一次 ----
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function cacheGet() {
    try {
      const db = await idb();
      return await new Promise((resolve) => {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(DB_KEY);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
    } catch (_) { return null; }      // 隐私模式下 IndexedDB 可能直接不可用
  }
  async function cachePut(buf) {
    try {
      const db = await idb();
      await new Promise((resolve) => {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).put(buf, DB_KEY);
        t.oncomplete = t.onerror = t.onabort = resolve;
      });
    } catch (_) { /* 存不下就每次重下，不影响功能 */ }
  }
  async function cacheClear() {
    try {
      const db = await idb();
      await new Promise((resolve) => {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).delete(DB_KEY);
        t.oncomplete = t.onerror = t.onabort = resolve;
      });
    } catch (_) { /* 同上 */ }
  }

  async function hasCache() { return !!(await cacheGet()); }

  async function fetchModel(onProgress) {
    const cached = await cacheGet();
    if (cached) { onProgress && onProgress(1, cached.byteLength, cached.byteLength, true); return cached; }

    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error('模型下载失败 HTTP ' + res.status);
    const total = Number(res.headers.get('X-Model-Bytes') || res.headers.get('Content-Length') || 0);

    // 边下边报进度：28MB 在慢网上要等一会儿，没有进度条用户会以为卡死
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress && onProgress(total ? got / total : 0, got, total, false);
    }
    const buf = new Uint8Array(got);
    let at = 0;
    for (const c of chunks) { buf.set(c, at); at += c.length; }
    await cachePut(buf.buffer);
    return buf.buffer;
  }

  async function ensureOrt() {
    if (ortReady) return ortReady;
    ortReady = (async () => {
      await loadScript(ORT_CDN + 'ort.min.js');
      const ort = window.ort;
      ort.env.wasm.wasmPaths = ORT_CDN;
      // 多线程 WASM 需要页面跨源隔离（COOP/COEP），而本站要引 jsDelivr 的脚本，
      // 开了隔离那些外链就全挂。所以单线程 + 有 WebGPU 就走 WebGPU。
      ort.env.wasm.numThreads = 1;
      return ort;
    })();
    return ortReady;
  }

  function hasWebGPU() { return typeof navigator !== 'undefined' && !!navigator.gpu; }

  async function ensureSession(onProgress) {
    if (session) return session;
    const ort = await ensureOrt();
    const buf = await fetchModel(onProgress);
    const providers = hasWebGPU() ? ['webgpu', 'wasm'] : ['wasm'];
    try {
      session = await ort.InferenceSession.create(buf, { executionProviders: providers });
    } catch (e) {
      // WebGPU 在某些驱动/浏览器上会建会话失败，退回 WASM 再试一次而不是直接报错
      if (providers[0] === 'webgpu') {
        session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
      } else throw e;
    }
    return session;
  }

  // ---- 张量拆装 ----
  // canvas 的 ImageData 是 HWC + alpha，模型要的是 CHW 且只有 RGB
  function toCHW(rgba, w, h) {
    const n = w * h;
    const out = new Uint8Array(3 * n);
    for (let i = 0; i < n; i++) {
      out[i] = rgba[i * 4];
      out[n + i] = rgba[i * 4 + 1];
      out[2 * n + i] = rgba[i * 4 + 2];
    }
    return out;
  }
  function fromCHW(chw, w, h) {
    const n = w * h;
    const out = new Uint8ClampedArray(4 * n);
    for (let i = 0; i < n; i++) {
      out[i * 4] = chw[i];
      out[i * 4 + 1] = chw[n + i];
      out[i * 4 + 2] = chw[2 * n + i];
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  // 蒙版画布约定：涂过的地方 alpha > 0。
  //
  // ⚠ **MI-GAN 的极性跟直觉相反：0 = 要重画的洞，255 = 原样保留。**
  // 一开始按「要擦的地方给 255」写，结果是把水印当成了唯一要保留的东西、
  // 整张图其余部分全被模型重画——出来一片糊，而水印稳稳地还在原地。
  // 参考实现里那句 `(v !== 255) * 255` 就是在做同一个反转，只是绕了一道。
  function maskToPlane(maskRGBA, w, h) {
    const n = w * h;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = maskRGBA[i * 4 + 3] > 8 ? 0 : 255;
    return out;
  }

  // 数的是「洞」的像素数，也就是值为 0 的那些
  function countHoles(plane) {
    let n = 0;
    for (let i = 0; i < plane.length; i++) if (plane[i] === 0) n++;
    return n;
  }

  /**
   * 擦除。
   * @param {ImageData} image 原图
   * @param {ImageData} mask  蒙版（涂过的地方 alpha>0）
   * @returns {Promise<ImageData>}
   */
  async function inpaint(image, mask, onProgress) {
    const { width: w, height: h } = image;
    if (mask.width !== w || mask.height !== h) throw new Error('蒙版与原图尺寸不一致');
    const plane = maskToPlane(mask.data, w, h);
    if (!countHoles(plane)) throw new Error('还没涂任何区域');

    const ort = await ensureOrt();
    const sess = await ensureSession(onProgress);

    const feeds = {};
    feeds[sess.inputNames[0]] = new ort.Tensor('uint8', toCHW(image.data, w, h), [1, 3, h, w]);
    feeds[sess.inputNames[1]] = new ort.Tensor('uint8', plane, [1, 1, h, w]);

    const out = await sess.run(feeds);
    const res = out[sess.outputNames[0]];

    // 别假设输出就是原尺寸——按张量自己报的 dims 来拆（[N,C,H,W]）。
    // pipeline 版本内部会分块/补边，万一某个尺寸下吐回来的不是原大小，
    // 用错的 w/h 去拆 CHW 只会得到一张条纹状的乱图，而且很难看出是哪儿错了。
    const d = res.dims || [];
    const oh = d.length >= 4 ? d[d.length - 2] : h;
    const ow = d.length >= 4 ? d[d.length - 1] : w;
    if (res.data.length < 3 * ow * oh) throw new Error('模型输出尺寸异常：' + JSON.stringify(d));

    const got = new ImageData(fromCHW(res.data, ow, oh), ow, oh);
    if (ow === w && oh === h) return got;

    // 尺寸对不上就缩回原大小，宁可损一点清晰度也不能错位
    const cv = document.createElement('canvas');
    cv.width = ow; cv.height = oh;
    cv.getContext('2d').putImageData(got, 0, 0);
    const dst = document.createElement('canvas');
    dst.width = w; dst.height = h;
    const dx = dst.getContext('2d');
    dx.imageSmoothingQuality = 'high';
    dx.drawImage(cv, 0, 0, w, h);
    return dx.getImageData(0, 0, w, h);
  }

  window.NBUnmark = {
    inpaint, ensureSession, hasCache, cacheClear, hasWebGPU,
    get ready() { return !!session; },
  };
})();
