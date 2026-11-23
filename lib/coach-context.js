// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/coach-context.js
// A point-in-time snapshot of someone's training, written for a chat model to
// read. Pure: callers pass the stores in. No profile name — the user decides
// where this goes.

import { mainLiftTrend } from "./analytics.js";
import { makeDayContext, weeklyStrength } from "./day-state.js";
import { auditHistoryVolume, VOLUME_TARGETS } from "./volume-audit.js";
import { localDateStr, daysBetween } from "./dates.js";
import { loggedAddedKg } from "./lift-translations.js";

const PRIMER = `How Heatwayve programmes (read this before advising):
- Three-day A/B/C rotation. Five main lifts carry progressive overload; accessories rotate at block boundaries, never session to session.
- Weekly volume per muscle is held between MEV (least that grows) and MRV (most you recover from). Past MRV is diminishing returns and a recovery bill, not extra progress.
- Progression runs on effort: sets rated with reps in reserve. Weight rises when the prescribed reps land with room to spare; a stall is answered with reps first, then weight.
- 6–30 reps all build muscle when taken close to failure. The programme's range is a recommendation, not a rule.
- Consistency beats novelty. Deloads are for regular trainees (2.5+ sessions a week over 12 weeks), not a cure for missed weeks.`;

const r1 = (n) => Math.round(n * 10) / 10;

/**
 * One logged session as a line: date, readiness, each exercise's sets. A
 * session a trainer logged with them says so, never who (loggedBy's name and
 * account stay on the device).
 */
export function sessionLine(rec) {
  const exs = (rec.blocks || []).flatMap((b) => b.exercises || []).map((ex) => {
    const sets = (ex.sets || []).filter((s) => s && s.reps != null);
    if (!sets.length) return null;
    const lt = ex.loadType ?? sets[0].loadType;
    // Bodyweight lifts store ADDED load in weight: "+10 kg", never "10 kg" —
    // and a pure bodyweight set's weight only when its effective load proves it.
    const added = lt === "bodyweight" || lt === "loaded_bodyweight" || lt === "loaded_bw";
    const kg = added ? loggedAddedKg(sets[0], lt) : null;
    const w = added
      ? (kg != null ? `+${kg} kg ` : "")
      : (sets[0].weight != null ? `${sets[0].weight} kg ` : "");
    // Numeric RPEs only: an enum-era label ("normal") or NaN would turn the
    // max into "@RPE NaN". No numbers, no effort clause.
    const rpes = sets.map((s) => s.rpe).filter((x) => typeof x === "number" && Number.isFinite(x));
    return `${ex.name} ${w}× ${sets.map((s) => s.reps).join("/")}${rpes.length ? ` @RPE ${Math.max(...rpes)}` : ""}`;
  }).filter(Boolean);
  const coached = rec.loggedBy && typeof rec.loggedBy === "object" ? " · logged with your trainer" : "";
  return `- ${rec.date} · ${rec.readiness || "normal"}${rec.travel ? " · travelling" : ""}${coached}: ${exs.join("; ")}`;
}

/**
 * One week of the consistency line. The current week reads as in progress,
 * not short, so the model doesn't advise on a week that hasn't happened.
 * With `through` (a date, not today), each week is named by its Monday and
 * the last reads up to that date.
 * @param {{ mondayIso?: string, planned: number, plannedSoFar: number, plannedResting: number, done: number, partial: boolean }} w
 * @param {string | null} [through]
 */
export function consistencyCell(w, through = null) {
  const name = through ? `${w.mondayIso}: ` : "";
  if (w.partial) return through
    ? `${name}${w.done}/${w.plannedSoFar} through ${through} (${w.planned} planned)`
    : `${w.done}/${w.plannedSoFar} so far (this week, in progress; ${w.planned} planned)`;
  if (w.planned === 0 && w.plannedResting > 0) return `${name}breather`;
  return `${name}${w.done}/${w.planned}${w.plannedResting ? " (part breather)" : ""}`;
}

/**
 * The sentence saying a given asOf was set aside, why, and the day read on
 * instead; null when none was (lib/mcp-server.js readingDay).
 * @param {{ day: string | null, last: string | null, rejected?: { asOf: string, after: boolean } | null } | null | undefined} on
 * @returns {string | null}
 */
export function asOfSetAside(on) {
  const r = on?.rejected;
  if (!r || !on?.day) return null;
  return `asOf ${r.asOf} is ${r.after ? "more than a year after" : "more than a day before"} my last session (${on.last}), so this reads on ${on.day}.`;
}

/**
 * The opening lines when the snapshot is read on a given day rather than on
 * the device's clock: through `asOf` when one was given, else as of the last
 * logged session, else undated.
 * @param {{ day: string | null, asOf: boolean, last: string | null }} on
 * @returns {string[]}
 */
function throughHeader({ day, asOf, last }) {
  const own = "Dates are my own calendar's.";
  if (!day) return ["# My training — Heatwayve snapshot", own];
  if (!asOf) return [`# My training — Heatwayve snapshot as of ${day}, my last logged session`,
    `${own} It shows what I'd done by my last session, ${day}; it doesn't say how long ago that was.`];
  const gap = last ? daysBetween(last, day) : null;
  const since = gap === null ? ""
    : gap === 0 ? ` My last session was on ${day}.`
    : gap === 1 ? ` My last session was ${last}, the day before ${day}.`
    : gap === -1 ? ` My last session was ${last}, the day after ${day}.`
    : ` My last session was ${last}, ${gap} days before ${day}.`;
  return [`# My training — Heatwayve snapshot through ${day}`, `${own} It shows what I'd done through ${day}, nothing after.${since}`];
}

/**
 * weekFor gives the schedule in force on a date (defaults to `week` for
 * every date); breaks are declared breathers. Consistency is history-only.
 * `on` reads the snapshot on that day instead of `now`'s local date, and
 * reads no clock: { day, asOf, last } (lib/mcp-server.js readingDay).
 * @param {{ history?: any[], trainingState?: any, focus?: string, mainLifts?: Record<string,string> | null,
 *   week?: any[], weekFor?: (iso: string) => any[] | null, breaks?: any[], bodyweightKg?: number|null, now?: Date,
 *   on?: { day: string | null, asOf: boolean, last: string | null, rejected?: { asOf: string, after: boolean } | null } | null }} input
 * @returns {string}
 */
export function buildCoachContext({ history = [], trainingState = null, focus = "Forged", mainLifts = {}, week = [], weekFor, breaks = [], bodyweightKg = null, now = new Date(), on = null } = {}) {
  // ISO, not a locale string: stable across devices and unambiguous to a model.
  const dateLabel = on ? on.day : localDateStr(now);
  const through = on ? on.day : null;
  const out = [];
  if (on) {
    out.push(...throughHeader(on));
    const aside = asOfSetAside(on);
    if (aside) out.push(aside);
  } else {
    out.push(`# My training — Heatwayve snapshot, ${dateLabel}`);
    out.push(`A point-in-time export: it shows what I'd done by ${dateLabel}, nothing after.`);
  }
  out.push("", PRIMER);

  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const strengthDays = (week || []).map((d, i) => (d?.type === "strength" ? days[i] : null)).filter(Boolean);
  const swaps = mainLifts ? Object.entries(mainLifts).filter(([k, v]) => v && v !== k).map(([k, v]) => `${v} (for ${k})`) : null;
  out.push("", "## Setup");
  out.push(`- Focus: ${focus}`);
  if (strengthDays.length) out.push(`- Strength days: ${strengthDays.join(", ")}`);
  if (swaps) out.push(`- Main lifts: ${swaps.length ? swaps.join("; ") : "programme defaults"}`);
  if (bodyweightKg) out.push(`- Bodyweight: ${bodyweightKg} kg`);

  const strength = (history || []).filter((r) => String(r?.session || "").startsWith("strength"));
  if (strength.length === 0 || !dateLabel) {
    out.push("", "No sessions logged yet.");
    return out.join("\n");
  }

  // No Days store: a session not yet in history isn't evidence here.
  const ctx = makeDayContext({ todayIso: dateLabel, history, breaks, weekFor: weekFor || (() => week) });
  out.push("", through
    ? `## Consistency, 8 weeks to ${through} (strength days done/planned, oldest first, each week named by its Monday)`
    : "## Consistency, last 8 weeks (strength days done/planned, oldest first)");
  out.push("Planned follows the schedule in force that week; declared breather days aren't planned.");
  out.push(weeklyStrength(ctx, { weeks: 8 }).map((w) => consistencyCell(w, through)).join(" · "));

  const trends = mainLiftTrend(history);
  const lifts = trainingState?.lifts || {};
  const trendLines = Object.entries(trends).map(([name, series]) => {
    const first = series[0], last = series[series.length - 1];
    const stall = lifts[name]?.stallSignal ? ` · ${lifts[name].stallSignal.replace("_", " ")}` : "";
    return `- ${name}: ${r1(first.est1RM)} → ${r1(last.est1RM)} kg est. 1RM over ${series.length} sessions (last ${last.date}; top set ${last.topSet.weight} × ${last.topSet.reps})${stall}`;
  });
  if (trendLines.length) out.push("", "## Main lifts", ...trendLines);

  // Read on a day, the window ends on it.
  const audit = through
    ? auditHistoryVolume(history.filter((r) => typeof r?.date === "string" && r.date <= through), { weeks: 2, now: /** @type {any} */ (through) })
    : auditHistoryVolume(history, { weeks: 2, now });
  if (!audit.away) {
    out.push("", through ? `## Weekly volume vs landmarks, 2 weeks to ${through} (sets per week)` : "## Weekly volume vs landmarks, last 2 weeks (sets per week)");
    for (const [m, row] of Object.entries(audit.perMuscle)) {
      const t = VOLUME_TARGETS[m];
      if (!t || (row.sets === 0 && t.mev === 0)) continue;
      out.push(`- ${m}: ${r1(row.sets)} (MEV ${t.mev} / MRV ${t.mrv}) — ${row.status.replace("_", " ")}`);
    }
  }

  const recent = strength.slice(-6);
  out.push("", `## Last ${recent.length} sessions`);
  for (const rec of recent) out.push(sessionLine(rec));

  out.push("", "## What I'd like", "Read my consistency before my numbers. Tell me what's working, what isn't, and the one change worth making next — within the principles above.");
  return out.join("\n");
}
