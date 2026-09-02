// @ts-check
// lib/rest-clock.js
// The rest timer is a DEADLINE, not a tally of ticks. A decrementing counter
// stops counting when iOS suspends timers on lock, so a four-minute break read
// as 2:10 on return. Anything on the lock screen also needs a deadline: you
// cannot schedule a notification against a counter.

/**
 * Seconds left against the wall clock. Never negative; null endsAt reads 0.
 * @param {number|null} endsAt  epoch ms
 * @param {number} [now]
 */
export function restRemaining(endsAt, now = Date.now()) {
  if (endsAt === null || endsAt === undefined || !Number.isFinite(endsAt)) return 0;
  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}

/** The deadline for a rest of `seconds` starting now. */
export function restDeadline(seconds, now = Date.now()) {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return now + s * 1000;
}
