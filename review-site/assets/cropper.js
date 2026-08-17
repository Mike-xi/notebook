// 图片裁剪 / 缩放。
//
// 换封面和换课程图标时先进这个框：拖动平移、滚轮或滑杆缩放，框里留下的部分才是
// 最终存下去的。输出直接按目标尺寸画进 canvas，所以上传的永远是裁好的小图，
// 不会把 4000px 的原图怼进 R2。
//
//   NBCropper.open(file, { aspect: 16/9, out: { w: 640, h: 360 }, round: false })
//     -> Promise<Blob>，用户取消则 reject(new Error('cancelled'))
(function () {
  const VIEW_MAX_W = 460;    // 取景框最大宽度（会按可视区再收）
  const VIEW_MAX_H = 320;

  function open(file, opts) {
    const o = opts || {};
    const aspect = o.aspect || 1;
    const outW = (o.out && o.out.w) || 512;
    const outH = (o.out && o.out.h) || Math.round(outW / aspect);
    const round = !!o.round;

    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这不是一张能打开的图片')); };
      img.onload = () => start(img, url);
      img.src = url;

      function start(image) {
        // 取景框尺寸：按 aspect 在上限内取最大
        let vw = Math.min(VIEW_MAX_W, Math.max(200, window.innerWidth - 96));
        let vh = vw / aspect;
        if (vh > VIEW_MAX_H) { vh = VIEW_MAX_H; vw = vh * aspect; }
        vw = Math.round(vw); vh = Math.round(vh);

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay crop-overlay';
        overlay.innerHTML = `
          <div class="modal crop-modal" role="dialog" aria-modal="true" aria-label="裁剪图片">
            <h3>裁剪图片</h3>
            <p class="crop-tip">拖动移动位置，滚轮或下面的滑杆缩放。框内的部分会被保存。</p>
            <div class="crop-stage" style="width:${vw}px;height:${vh}px">
              <canvas class="crop-canvas" width="${vw}" height="${vh}"></canvas>
              <div class="crop-frame${round ? ' is-round' : ''}" aria-hidden="true"></div>
            </div>
            <div class="crop-zoom">
              <span class="ic" data-icon="image" data-icon-size="13"></span>
              <input type="range" class="crop-range" min="1" max="4" step="0.01" value="1" aria-label="缩放">
            </div>
            <div class="modal-actions co-actions">
              <button type="button" class="btn-soft" data-crop-reset>重置</button>
              <span class="co-spacer"></span>
              <button type="button" class="btn-ghost" data-crop-cancel>取消</button>
              <button type="button" class="btn-primary" data-crop-ok>使用这张</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        if (window.NBIconHydrate) NBIconHydrate(overlay);

        const cv = overlay.querySelector('.crop-canvas');
        const ctx = cv.getContext('2d');
        const zoomInput = overlay.querySelector('.crop-range');

        // baseScale：刚好铺满取景框（cover）。zoom 是在此之上的倍数。
        const baseScale = Math.max(vw / image.width, vh / image.height);
        let zoom = 1, tx = 0, ty = 0;   // tx/ty：图片中心相对取景框中心的偏移

        function clamp() {
          const s = baseScale * zoom;
          const halfW = Math.max(0, (image.width * s - vw) / 2);
          const halfH = Math.max(0, (image.height * s - vh) / 2);
          tx = Math.min(halfW, Math.max(-halfW, tx));
          ty = Math.min(halfH, Math.max(-halfH, ty));
        }

        function draw() {
          clamp();
          const s = baseScale * zoom;
          const w = image.width * s, h = image.height * s;
          ctx.clearRect(0, 0, vw, vh);
          ctx.drawImage(image, vw / 2 - w / 2 + tx, vh / 2 - h / 2 + ty, w, h);
        }
        draw();

        // 拖动平移
        let drag = null;
        cv.addEventListener('pointerdown', (e) => {
          drag = { x: e.clientX, y: e.clientY, tx, ty };
          cv.setPointerCapture(e.pointerId);
          cv.classList.add('grabbing');
        });
        cv.addEventListener('pointermove', (e) => {
          if (!drag) return;
          tx = drag.tx + (e.clientX - drag.x);
          ty = drag.ty + (e.clientY - drag.y);
          draw();
        });
        const endDrag = () => { drag = null; cv.classList.remove('grabbing'); };
        cv.addEventListener('pointerup', endDrag);
        cv.addEventListener('pointercancel', endDrag);

        // 滚轮缩放：以取景框中心为锚点
        cv.addEventListener('wheel', (e) => {
          e.preventDefault();
          const next = Math.min(4, Math.max(1, zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
          const k = next / zoom;
          tx *= k; ty *= k;
          zoom = next;
          zoomInput.value = String(zoom);
          draw();
        }, { passive: false });

        zoomInput.addEventListener('input', () => {
          const next = parseFloat(zoomInput.value);
          const k = next / zoom;
          tx *= k; ty *= k;
          zoom = next;
          draw();
        });

        function cleanup() {
          URL.revokeObjectURL(url);
          overlay.remove();
          document.removeEventListener('keydown', onKey);
        }
        function onKey(e) { if (e.key === 'Escape') cancel(); }
        function cancel() { cleanup(); reject(new Error('cancelled')); }
        document.addEventListener('keydown', onKey);

        overlay.querySelector('[data-crop-cancel]').addEventListener('click', cancel);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
        overlay.querySelector('[data-crop-reset]').addEventListener('click', () => {
          zoom = 1; tx = 0; ty = 0; zoomInput.value = '1'; draw();
        });

        overlay.querySelector('[data-crop-ok]').addEventListener('click', () => {
          // 用同一套变换按目标尺寸重画一遍，取景框到输出的比例是 outW/vw
          const out = document.createElement('canvas');
          out.width = outW; out.height = outH;
          const octx = out.getContext('2d');
          const r = outW / vw;
          const s = baseScale * zoom * r;
          const w = image.width * s, h = image.height * s;
          octx.drawImage(image, outW / 2 - w / 2 + tx * r, outH / 2 - h / 2 + ty * r, w, h);
          out.toBlob((blob) => {
            if (!blob) { cancel(); return; }
            cleanup();
            resolve(blob);
          }, 'image/webp', 0.9);
        });
      }
    });
  }

  window.NBCropper = { open };
})();
