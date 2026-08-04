// @ts-check
// lib/dates.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE implementation of local-timezone calendar math. Forge dates a user's
// training day by THEIR clock, never UTC — a session finished at 8am in
// Auckland belongs to that morning, not to the UTC day that is still
// "yesterday" at the time. The recurring, expensive bug in this codebase has
// been `new Date(str)` (parses "YYYY-MM-DD" as UTC midnight) or
// `.toISOString().slice(0, 10)` (formats in UTC): near local midnight, and for
// every user not on UTC, both shift the calendar day by one. It has been fixed
// piecemeal at least three times (the rhythm grid, findRecentDays, the BST
// check-in) while other copies quietly kept the bug. This module is the
// single home for the correct math so there is nothing left to re-derive.
//
// RULE: never `toISOString()` a value you intend to read as a calendar date,
// and never `new Date("YYYY-MM-DD")`. Use `parseLocalDate` / `localDateStr`.
// ─────────────────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The runtime's timezone at this instant: IANA zone plus the UTC offset in
 * minutes. Stamped onto records so a calendar day can be disambiguated later
 * for users who cross timezones — a bare "YYYY-MM-DD" cannot be.
 *
 * BOTH are captured deliberately. The IANA zone carries the rules (so a past
 * date can be re-resolved correctly, DST included) but is a string that may be
 * unrecognised by a future runtime; the offset is dumb but survives anything.
 * Either alone has a failure mode; together they do not.
 *
 * Degrades to nulls rather than throwing. `Intl` is universal in every
 * browser and Node version we support, so the guard is for exotic or locked-
 * down environments only — a missing stamp must never cost someone a logged
 * session.
 *
 * @returns {{ zone: string | null, offset: number | null }}
 */
export function captureZone() {
  let zone = null;
  let offset = null;
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch { /* no Intl — leave null */ }
  try {
    // getTimezoneOffset is minutes BEHIND UTC (London in summer = -60).
    // Negated here so the sign reads the way offsets are written (+01:00).
    offset = -new Date().getTimezoneOffset();
  } catch { /* leave null */ }
  return { zone, offset };
}

/**
 * Format a Date as a LOCAL "YYYY-MM-DD" (its calendar day in the runtime's
 * timezone). Never toISOString — that renders the UTC day.
 * @param {Date} d
 */
export function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today as a local "YYYY-MM-DD". */
export function todayLocalIso() {
  return localDateStr(new Date());
}

/**
 * Parse "YYYY-MM-DD" to a Date at LOCAL midnight (not UTC midnight, which is
 * what `new Date(str)` gives). Returns null for a malformed string.
 * @param {string} dateStr
 * @returns {Date | null}
 */
export function parseLocalDate(dateStr) {
  if (typeof dateStr !== "string" || !ISO_DATE.test(dateStr)) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * Normalise any accepted input (Date, or "YYYY-MM-DD") to a Date at LOCAL
 * NOON of its calendar day. Noon is the anchor for all arithmetic here: a
 * DST transition shifts a day by an hour at its edges, and ±1h around noon
 * never crosses a day boundary — so add/diff math stays calendar-exact.
 * @param {Date | string} input
 * @returns {Date | null}
 */
function toNoon(input) {
  const d = input instanceof Date ? input : parseLocalDate(input);
  if (!d || Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
}

/**
 * Walk a calendar day forward (or back, negative n) by whole days, returning
 * a local "YYYY-MM-DD". Accepts a Date or a "YYYY-MM-DD" string; null for a
 * malformed string. DST-safe via the noon anchor.
 * @param {Date | string} input
 * @param {number} n
 * @returns {string | null}
 */
export function addDaysIso(input, n) {
  const d = toNoon(input);
  if (!d || !Number.isFinite(n)) return null;
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}

/**
 * Whole calendar days from `a` to `b` (positive when b is later). Both sides
 * accept a Date or a "YYYY-MM-DD" string; null if either is malformed.
 * Calendar days, not 24h buckets — a DST week still counts 7.
 * @param {Date | string} a
 * @param {Date | string} b
 * @returns {number | null}
 */
export function daysBetween(a, b) {
  const na = toNoon(a);
  const nb = toNoon(b);
  if (!na || !nb) return null;
  return Math.round((nb.getTime() - na.getTime()) / 86400000);
}

/**
 * Weekday as a MONDAY-START index: 0=Mon..6=Sun. This is the app's week
 * convention (WEEK tables, weekDone, the home strip) — the `[6,0,1,2,3,4,5]`
 * remap tables that used to live at every call site are this function.
 * @param {Date | string} input
 * @returns {number | null}
 */
export function mondayIndex(input) {
  const d = toNoon(input);
  return d ? (d.getDay() + 6) % 7 : null;
}

/**
 * Weekday in JS's native SUNDAY-START convention: 0=Sun..6=Sat. Exists ONLY
 * because the record schema's `dow` field has stored this shape since v1 —
 * new code wants `mondayIndex`. Defaults to today.
 * @param {Date | string} [input]
 * @returns {number | null}
 */
export function jsDow(input = new Date()) {
  const d = toNoon(input);
  return d ? d.getDay() : null;
}

/**
 * The local Monday of the (Monday-anchored) week containing `input`, as a
 * local "YYYY-MM-DD". Accepts a Date or a "YYYY-MM-DD" string. Returns null
 * for a malformed string.
 * @param {Date | string} input
 * @returns {string | null}
 */
export function mondayOfWeekIso(input) {
  const idx = mondayIndex(input);
  return idx === null ? null : addDaysIso(input, -idx);
}
