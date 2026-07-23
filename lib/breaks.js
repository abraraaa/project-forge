// @ts-check
// lib/breaks.js
// ─────────────────────────────────────────────────────────────────────────────
// Breathers — the user-facing companion to the derived absence model
// (lib/absence.js). Where absence is DETECTED (a fact about the gap), a
// breather is DECLARED (the user saying "I'm stepping back, and it's fine").
//
// A breather is the one part of absence modelling that must be stored: it
// carries the user's own annotation (why) and their intent (pause the
// rhythm). The record lives in localStorage AND the blob meta payload
// (design principle #0 — see the Bk entity + mergeBreaks in storage.js).
//
// This module is the PURE half: record shape, the reason vocabulary, and
// the two questions the surfaces ask — "is a breather active?" and "does
// this activity end it?". No storage, no clock; today/dates are passed in.
//
// SHAPE  { id, start, reason, endedAt }
//   · id       ISO timestamp of confirmation — the merge key (two devices
//              confirming produce different ids; union is conflict-free).
//   · start    ISO date the breather begins (the confirmation day). The
//              rhythm rests from here; only activity STRICTLY BEFORE it
//              (e.g. a retro fill for last week) fails to end it.
//   · reason   one of REASONS[].id, or null if the user declined to say.
//   · endedAt  ISO date the breather resumed — the first activity on or
//              after start (live/retro), or a manual "Back to it"; null
//              while open.
//
// VOICE  a breather is permission, never a confession. Rest is a training
// variable. Copy around it stays in the away-state register — calm,
// reaffirming, a little playful; never a scold, never frantic.
// ─────────────────────────────────────────────────────────────────────────────

// 3–5 reasons covering most seasons, on two honest axes: chose-to-stop
// (Resting up) vs got-stopped (Injured, Busy stretch), plus the where
// (Travelling) and the catch-all. Labels stay short, warm, non-clinical.
export const REASONS = [
  { id: "travelling", label: "Travelling" },
  { id: "injured",    label: "Injured or ill" },
  { id: "resting",    label: "Resting up" },
  { id: "busy",       label: "Busy stretch" },
  { id: "other",      label: "Something else" },
];

const REASON_IDS = new Set(REASONS.map((r) => r.id));

/** Normalise a reason id to a known one, or null. */
export function normaliseReason(reason) {
  return REASON_IDS.has(reason) ? reason : null;
}

/** The human label for a stored reason id, or null. */
export function reasonLabel(reason) {
  return REASONS.find((r) => r.id === reason)?.label ?? null;
}

/**
 * The open breather from a record list, or null. "Open" = endedAt null.
 * There is only ever one open at a time (start() closes any prior open
 * one first), but this tolerates malformed data by taking the latest.
 * @param {Array<{id?: string, start?: string, reason?: string, endedAt?: string|null}>} breaks
 */
export function activeBreak(breaks) {
  const open = (Array.isArray(breaks) ? breaks : []).filter((b) => b && b.start && !b.endedAt);
  if (open.length === 0) return null;
  return open.sort((a, b) => String(a.start).localeCompare(String(b.start))).at(-1);
}

/** Is a breather currently active? (the rhythm-rest predicate) */
export function isResting(breaks) {
  return activeBreak(breaks) !== null;
}

/**
 * Does activity on `activityDate` end this breather? True iff the breather
 * is open and the activity falls ON OR AFTER its start — training the same
 * day you declared a breather (or any day after) resumes the rhythm, live
 * or retro. Only activity STRICTLY BEFORE the start is exempt, so a
 * retro-fill for last week can't cancel a breather you started today.
 */
export function breakEndedBy(brk, activityDate) {
  if (!brk || !brk.start || brk.endedAt) return false;
  if (typeof activityDate !== "string" || !activityDate) return false;
  return activityDate >= brk.start;
}

/**
 * Build the record for a freshly-confirmed breather. Pure — caller supplies
 * `today` (start day) and `confirmedAt` (id/timestamp); the store appends it.
 * @param {string} reason
 * @param {string} today        ISO date
 * @param {string} confirmedAt  ISO timestamp
 */
export function makeBreak(reason, today, confirmedAt) {
  return { id: confirmedAt, start: today, reason: normaliseReason(reason), endedAt: null };
}
