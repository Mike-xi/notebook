/**
 * Create a stateful detector for short, stationary multi-pointer taps.
 * This module intentionally has no DOM dependencies; callers translate their
 * pointer events into calls to the returned methods.
 */
export function createMultiTapDetector({
  onTwoFingerTap,
  onThreeFingerTap,
  maxDurationMs = 300,
  maxMoveDist = 12,
}) {
  const pointers = new Map();
  const maxMoveDistSquared = maxMoveDist * maxMoveDist;
  let firstDownTime = null;
  let count = 0;
  let invalid = false;

  function reset() {
    pointers.clear();
    firstDownTime = null;
    count = 0;
    invalid = false;
  }

  function down(id, x, y, t) {
    if (pointers.size === 0) firstDownTime = t;
    pointers.set(id, { x, y });
    count = Math.max(count, pointers.size);
  }

  function move(id, x, y, _t) {
    const start = pointers.get(id);
    if (!start || invalid) return;
    const dx = x - start.x;
    const dy = y - start.y;
    if (dx * dx + dy * dy > maxMoveDistSquared) invalid = true;
  }

  function up(id, t) {
    if (!pointers.delete(id) || pointers.size > 0) return;

    const withinDuration = t - firstDownTime <= maxDurationMs;
    const callback = !invalid && withinDuration
      ? (count === 2 ? onTwoFingerTap : count === 3 ? onThreeFingerTap : null)
      : null;

    // Reset before invoking user code so even a throwing/re-entrant callback
    // cannot make this gesture fire twice or leak into the next gesture.
    reset();
    if (typeof callback === 'function') callback();
  }

  return { down, move, up, cancel: reset };
}

/**
 * Pick the two contacts most likely to be deliberate navigation fingers.
 * Safari contact radii vary greatly between fingers and devices, so size is a
 * ranking signal rather than a hard palm-rejection threshold. A fresh gesture
 * must start with both fingers placed within a short window; an old resting
 * palm plus one new finger therefore does not start a pan.
 */
export function selectNavigationPair(points, {
  gestureActive = false,
  activeIds = null,
  maxStartGapMs = 480,
} = {}) {
  if (!Array.isArray(points) || points.length < 2) return [];
  if (gestureActive && Array.isArray(activeIds) && activeIds.length === 2) {
    const byId = new Map(points.map((point) => [point.id, point]));
    const active = activeIds.map((id) => byId.get(id));
    return active.every(Boolean) ? active : [];
  }
  const candidates = [];
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const pair = [points[i], points[j]];
      const gap = Math.abs((Number(pair[0].startedAt) || 0) - (Number(pair[1].startedAt) || 0));
      if (!gestureActive && gap > maxStartGapMs) continue;
      const area = (Number(pair[0].area) || 0) + (Number(pair[1].area) || 0);
      candidates.push({ pair, gap, area });
    }
  }
  candidates.sort((a, b) => a.area - b.area || a.gap - b.gap);
  return candidates[0]?.pair || [];
}
