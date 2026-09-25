// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/day-state.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE answer to "what is this day?" for the home week. Every day carries:
//   planned — the schedule IN FORCE on that date (a schedule edit never
//             rewrites the past),
//   did     — what actually happened: a logged strength session (history is
//             the truth for strength) or a manual tick,
//   done    — the same rule as Days.projectCurrentWeek: a session satisfies
//             any day; a tick only its own type,
//   session — which of A/B/C to show: the one LOGGED for a done day, the
//             cycle projection (over the as-lived plan) otherwise,
//   shown   — the day object to render: a done day wears what was done.
// Before this, the strip took its types from the as-lived week, its letters
// from TODAY's schedule and its colours from the plan — four fixes in one
// territory, each patching one seam. Pure; callers pass the stores in.
// ─────────────────────────────────────────────────────────────────────────────

import { WEEK, SESSIONS, recordLetterIdx, projectStrengthDaySessions } from "./programme.js";
import { addDaysIso } from "./dates.js";

const isStrengthRecord = (r) => String(r?.session || "").startsWith("strength") || recordLetterIdx(r) !== null;

/**
 * @param {{ mondayIso: string, todayIdx: number, history?: any[], days?: Record<string, any>,
 *   weekFor: (iso: string) => any[] | null }} input
 */
export function resolveWeek({ mondayIso, todayIdx, history = [], days = {}, weekFor }) {
  const isoAt = (i) => addDaysIso(mondayIso, i);
  const planned = Array.from({ length: 7 }, (_, i) => (weekFor(isoAt(i)) || WEEK)[i] || WEEK[i]);
  const projected = projectStrengthDaySessions(planned, history, todayIdx);

  // Latest strength record per date (id breaks same-day ties).
  /** @type {Record<string, any>} */
  const loggedOn = {};
  for (const r of history || []) {
    if (!r?.date || !isStrengthRecord(r)) continue;
    const cur = loggedOn[r.date];
    if (!cur || String(r.id || "") > String(cur.id || "")) loggedOn[r.date] = r;
  }

  return planned.map((day, i) => {
    const iso = isoAt(i);
    const rec = loggedOn[iso];
    const entry = days?.[iso];
    let did = null;
    if (rec || entry?.sessionId) did = { kind: "strength", sessionIdx: rec ? recordLetterIdx(rec) : null };
    else if (entry?.completedType) did = { kind: "tick", type: entry.completedType };

    const done = did?.kind === "strength" || (did?.kind === "tick" && did.type === day.type);
    const loggedIdx = did?.kind === "strength" && i <= todayIdx ? did.sessionIdx : null;
    const session = loggedIdx != null ? loggedIdx
      : day.type === "strength" && projected[i] !== undefined ? projected[i] : null;
    const shownType = done ? (did.kind === "strength" ? "strength" : did.type) : day.type;
    return {
      iso,
      planned: day.type,
      did,
      done,
      session,
      shown: shownType === day.type ? day : { ...day, type: shownType },
    };
  });
}

/** The { weekIdx: sessionIdx } map the home screen reads. */
export const sessionsFrom = (week) =>
  Object.fromEntries(week.map((d, i) => [i, d.session]).filter(([, s]) => s !== null && s < SESSIONS.length));
