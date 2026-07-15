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
 * The local Monday of the (Monday-anchored) week containing `input`, as a
 * local "YYYY-MM-DD". Accepts a Date or a "YYYY-MM-DD" string. Returns null
 * for a malformed string.
 * @param {Date | string} input
 * @returns {string | null}
 */
export function mondayOfWeekIso(input) {
  const d = input instanceof Date ? new Date(input) : parseLocalDate(input);
  if (!d) return null;
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun..6=Sat
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  return localDateStr(d);
}
