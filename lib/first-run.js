// @ts-check
// lib/first-run.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers for the first-run strength-days step and the closing line.
// No storage: the caller decides whether a result differs and saves it.
// ─────────────────────────────────────────────────────────────────────────────

import { WEEK } from "./programme.js";

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** @typedef {{ s?: string, label?: string, type: string }} WeekDay */

/** @param {string} type */
const labelFor = (type) => WEEK.find((d) => d.type === type)?.label || "Rest";

/** @param {WeekDay[]} week @returns {number[]} */
function strengthIdxs(week) {
  const out = [];
  for (let i = 0; i < (week?.length || 0); i++) if (week[i]?.type === "strength") out.push(i);
  return out;
}

/** @param {WeekDay[]} week */
export function strengthDayCount(week) {
  return strengthIdxs(week).length;
}

/**
 * Make exactly `chosen` the strength days. A day that stops being strength
 * takes the type of a day that became strength, matched in weekday order, so
 * the conditioning plan moves rather than disappears; any left over is rest.
 * Same set as now → the same array back, so callers can tell nothing changed.
 * @param {WeekDay[]} week
 * @param {number[]} chosen  week indexes, 0 = Monday
 * @returns {WeekDay[]}
 */
export function moveStrengthDays(week, chosen) {
  const want = [...new Set(chosen)].filter((i) => Number.isInteger(i) && i >= 0 && i < week.length).sort((a, b) => a - b);
  const now = strengthIdxs(week);
  const vacated = now.filter((i) => !want.includes(i));
  const taken = want.filter((i) => !now.includes(i));
  if (!vacated.length && !taken.length) return week;
  const displaced = taken.map((i) => week[i].type);
  return week.map((d, i) => {
    let type = d.type;
    if (want.includes(i)) type = "strength";
    else if (vacated.includes(i)) type = displaced[vacated.indexOf(i)] || "rest";
    return type === d.type ? d : { ...d, type, label: labelFor(type) };
  });
}

// What a strength-day count does to the A/B/C round. Weekly volume is solved
// for one each of A, B and C (volume-audit.js), so n days is about n/3 of it.
// Three is the plan and needs no note.
const NOTES = {
  0: "Pick at least one.",
  1: "One day: a full round takes three weeks. Progress will be slow.",
  2: "Two days: a full A, B, C round takes a week and a half, so each muscle gets about two-thirds of its weekly work.",
  4: "Four days: the round comes back within the week. About a third more work, so watch recovery.",
  5: "Five days: the round comes back within the week. About two-thirds more work, so watch recovery.",
  6: "Six days: two full rounds a week, so twice the work. Watch recovery.",
  7: "Seven days: no day off strength, more than twice the work. Watch recovery.",
};

/** @param {number} count @returns {string | null} */
export function dayNote(count) {
  return NOTES[/** @type {keyof typeof NOTES} */ (count)] ?? null;
}

/**
 * The day the first session falls on: the first strength day from today on,
 * wrapping to next week. "today" when today is one; null with no strength days.
 * With no history that session is A (programme.js nextStrengthIdx).
 * @param {WeekDay[]} week
 * @param {number} todayIdx  0 = Monday
 * @returns {string | null}
 */
export function firstSessionDay(week, todayIdx) {
  const days = strengthIdxs(week);
  if (!days.length) return null;
  const idx = days.find((i) => i >= todayIdx) ?? days[0];
  return idx === todayIdx ? "today" : DAY_NAMES[idx];
}
