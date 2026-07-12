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
