/** 将显示坐标系中的矩形限制在 bounds（原点为左上角）内。 */
export function clampRect(rect, bounds) {
  const w = Math.min(Math.max(rect.w, 1), bounds.w);
  const h = Math.min(Math.max(rect.h, 1), bounds.h);
  const x = Math.min(Math.max(rect.x, 0), bounds.w - w);
  const y = Math.min(Math.max(rect.y, 0), bounds.h - h);

  return { x, y, w, h };
}

/** 把图片项显示坐标系中的选区换算为原图像素坐标系中的裁切区域。 */
export function applyCrop(item, sel) {
  const selection = clampRect(
    { x: sel.rx, y: sel.ry, w: sel.rw, h: sel.rh },
    { w: item.w, h: item.h },
  );
  const base = item.crop ?? {
    sx: 0,
    sy: 0,
    sw: item.natural.nw,
    sh: item.natural.nh,
  };

  return {
    x: item.x + selection.x,
    y: item.y + selection.y,
    w: selection.w,
    h: selection.h,
    crop: {
      sx: base.sx + (selection.x / item.w) * base.sw,
      sy: base.sy + (selection.y / item.h) * base.sh,
      sw: (selection.w / item.w) * base.sw,
      sh: (selection.h / item.h) * base.sh,
    },
  };
}

/** 在页面显示坐标系中按图片项当前宽高比缩放。 */
export function resizeKeepAspect(item, newW, minW = 60, maxW = 1240) {
  const w = Math.min(Math.max(newW, minW), maxW);
  const h = Math.round((w * item.h / item.w) * 100) / 100;

  return { w, h };
}
