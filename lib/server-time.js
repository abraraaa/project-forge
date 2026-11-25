// @ts-check
// lib/server-time.js
// ─────────────────────────────────────────────────────────────────────────────
// The server's date and time, on Temporal (a Node global). Server-only: the
// browser floor (iPhone Safari) has no Temporal, so no module a client
// component reaches may import this file or name Temporal
// (tests/server-time-boundary.test.js).
//
//   · "now" is epoch milliseconds, passed in, and every default reads
//     Date.now(): nothing here reads Temporal.Now, so a test's fake clock
//     governs every result.
//   · A day is a "YYYY-MM-DD" string; an instant is epoch milliseconds or a
//     toISOString()-shaped string (milliseconds, Z).
//   · A day here is a calendar day in a named zone; a duration's day is
//     24 hours. Nothing reads the process's own zone.
//   · Stored instants are read with Date's parser (readInstantMs), which
//     accepts forms Temporal.Instant.from refuses.
// ─────────────────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── Durations ───────────────────────────────────────────────────────────────

/**
 * A fixed duration in milliseconds; a day is 24 hours.
 * @param {Temporal.DurationLike} like  e.g. { days: 30 }
 */
export const durationMs = (like) => Temporal.Duration.from(like).total({ unit: "milliseconds" });

/**
 * A fixed duration in seconds (a cookie's Max-Age); a day is 24 hours.
 * @param {Temporal.DurationLike} like
 */
export const durationSeconds = (like) => Temporal.Duration.from(like).total({ unit: "seconds" });

// ── Instants ────────────────────────────────────────────────────────────────

/** @param {number} ms */
const instant = (ms) => Temporal.Instant.fromEpochMilliseconds(ms);

/**
 * An instant as toISOString() writes it: always milliseconds, always Z.
 * @param {number} [ms]
 */
export const isoInstant = (ms = Date.now()) => instant(ms).toString({ fractionalSecondDigits: 3 });

/**
 * The instant `by` milliseconds after `ms`: an expiry, or when a window frees.
 * @param {number} ms
 * @param {number} by
 */
export const msAfter = (ms, by) => instant(ms).add({ milliseconds: by }).epochMilliseconds;

/**
 * The instant `by` milliseconds before `ms`: where a window back from now opens.
 * @param {number} ms
 * @param {number} by
 */
export const msBefore = (ms, by) => instant(ms).subtract({ milliseconds: by }).epochMilliseconds;

/**
 * A stored instant (ISO string, epoch ms or Date) as epoch milliseconds, by
 * Date's parser; NaN when unreadable.
 * @param {unknown} v
 */
export const readInstantMs = (v) => new Date(/** @type {any} */ (v)).getTime();

/**
 * Whole 24-hour periods from `fromMs` to `toMs`, rounded down.
 * @param {number} fromMs
 * @param {number} toMs
 */
export const wholeDaysBetweenMs = (fromMs, toMs) => Math.floor(instant(fromMs).until(instant(toMs)).total({ unit: "days" }));

/**
 * Whether a sliding credential re-mints now: its own token is older than
 * `rotateAfterMs` (or unreadable), and the Face ID it carries (authAt, else
 * createdAt) is less than `capMs` old.
 * @param {{ createdAt?: unknown, authAt?: unknown }} token
 * @param {number} now
 * @param {{ rotateAfterMs: number, capMs: number }} window
 */
export function slides({ createdAt, authAt }, now, { rotateAfterMs, capMs }) {
  const age = now - readInstantMs(createdAt || 0);
  const authAge = now - readInstantMs(authAt || createdAt || 0);
  const withinCap = Number.isFinite(authAge) && authAge < capMs;
  return (!Number.isFinite(age) || age > rotateAfterMs) && withinCap;
}

// ── Days ────────────────────────────────────────────────────────────────────

/**
 * The calendar date of `now` in `zone`.
 * @param {number} now
 * @param {string} zone  an IANA zone
 */
export const dayIn = (now, zone) => instant(now).toZonedDateTimeISO(zone).toPlainDate().toString();

/** Today's UTC date. @param {number} [now] */
export const utcDay = (now = Date.now()) => dayIn(now, "UTC");

/**
 * The UTC weekday of `now`, ISO numbered: 1 Monday … 7 Sunday.
 * @param {number} [now]
 */
export const utcWeekday = (now = Date.now()) => instant(now).toZonedDateTimeISO("UTC").dayOfWeek;

/**
 * A real calendar date in "YYYY-MM-DD", or null.
 * @param {unknown} iso
 */
function plainDate(iso) {
  if (typeof iso !== "string" || !ISO_DATE.test(iso)) return null;
  try {
    return Temporal.PlainDate.from(iso);
  } catch {
    return null;
  }
}

/**
 * The date `n` calendar days after `iso` (before, for negative n); null for
 * anything that is not a real date or a whole number of days.
 * @param {unknown} iso
 * @param {number} n
 * @returns {string | null}
 */
export function addDays(iso, n) {
  const d = plainDate(iso);
  return d && Number.isInteger(n) ? d.add({ days: n }).toString() : null;
}

/**
 * Calendar days from `a` to `b`, positive when b is later; null when either
 * is not a real date.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number | null}
 */
export function daysBetween(a, b) {
  const da = plainDate(a);
  const db = plainDate(b);
  return da && db ? da.until(db).days : null;
}

/**
 * The trainer's today: the device's date when it is a real date within one
 * day of the server's UTC date, otherwise the server's UTC date.
 * @param {unknown} raw  the date the device sent
 * @param {number} [now]
 */
export function trainerDay(raw, now = Date.now()) {
  const utc = utcDay(now);
  const d = daysBetween(utc, raw);
  return d !== null && Math.abs(d) <= 1 ? /** @type {string} */ (raw) : utc;
}

// ── The lifter's calendar ───────────────────────────────────────────────────

/**
 * The calendar date of `now` in `zone`; null when this runtime can't resolve
 * the zone.
 * @param {number} now
 * @param {string} zone  an IANA zone or a "+HH:MM" offset
 */
function dayInOrNull(now, zone) {
  try {
    return dayIn(now, zone);
  } catch {
    return null;
  }
}

/**
 * Minutes east of UTC as an offset zone ("+13:00"); null outside a day.
 * @param {unknown} minutes
 */
function offsetZone(minutes) {
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || Math.abs(minutes) >= 1440) return null;
  const a = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/**
 * The calendar date of instant `ms` on the lifter's clock: in the zone of the
 * newest record that names one and was logged at or before `ms` (its id),
 * else of the newest record that names one. The zone is its loggedTz, else
 * its loggedTzOffset when this runtime can't resolve the zone. Newest is the
 * latest date, then the latest id. Null when no record names a usable zone.
 * @param {number} ms
 * @param {unknown} history
 * @returns {string | null}
 */
export function lifterDay(ms, history) {
  /** @type {any} */
  let newest = null;
  /** @type {any} */
  let newestByThen = null;
  /** @param {any} a @param {any} b */
  const later = (a, b) => !b || a.key[0] > b.key[0] || (a.key[0] === b.key[0] && a.key[1] > b.key[1]);
  for (const r of Array.isArray(history) ? history : []) {
    if (!r || typeof r !== "object" || (typeof r.loggedTz !== "string" && offsetZone(r.loggedTzOffset) === null)) continue;
    const c = { r, key: [String(r.date ?? ""), String(r.id ?? "")] };
    if (later(c, newest)) newest = c;
    if (readInstantMs(r.id) <= ms && later(c, newestByThen)) newestByThen = c;
  }
  const pick = newestByThen ?? newest;
  if (!pick) return null;
  const { loggedTz, loggedTzOffset } = pick.r;
  const byZone = typeof loggedTz === "string" && loggedTz ? dayInOrNull(ms, loggedTz) : null;
  const offset = offsetZone(loggedTzOffset);
  return byZone ?? (offset ? dayInOrNull(ms, offset) : null);
}

/**
 * `meta` with its deload's startDate, the day it was accepted on the lifter's
 * clock (lifterDay), when it was stored without a real one. `meta` itself
 * when it has one, has no deload, or no record names a usable zone. Never
 * written back.
 * @param {any} meta
 * @param {unknown} history
 */
export function withLifterDeloadDate(meta, history) {
  const ts = meta?.trainingState;
  const active = ts?.mesocycle?.activeDeload;
  if (!active || typeof active !== "object" || plainDate(active.startDate)) return meta;
  const ms = readInstantMs(active.startedAt);
  if (!active.startedAt || !Number.isFinite(ms)) return meta;
  const startDate = lifterDay(ms, history);
  if (!startDate) return meta;
  return { ...meta, trainingState: { ...ts, mesocycle: { ...ts.mesocycle, activeDeload: { ...active, startDate } } } };
}
