// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/coach-context.js
// A point-in-time snapshot of someone's training, written for a chat model to
// read. Pure: callers pass the stores in. No profile name — the user decides
// where this goes.

import { mainLiftTrend, weeklyRhythm } from "./analytics.js";
import { auditHistoryVolume, VOLUME_TARGETS } from "./volume-audit.js";
import { localDateStr } from "./dates.js";

const PRIMER = `How Heatwayve programmes (read this before advising):
- Three-day A/B/C rotation. Five main lifts carry progressive overload; accessories rotate at block boundaries, never session to session.
- Weekly volume per muscle is held between MEV (least that grows) and MRV (most you recover from). Past MRV is diminishing returns and a recovery bill, not extra progress.
- Progression runs on effort: sets rated with reps in reserve. Weight rises when the prescribed reps land with room to spare; a stall is answered with reps first, then weight.
- 6–30 reps all build muscle when taken close to failure. The programme's range is a recommendation, not a rule.
- Consistency beats novelty. Deloads are for regular trainees (2.5+ sessions a week over 12 weeks), not a cure for missed weeks.`;

const r1 = (n) => Math.round(n * 10) / 10;

/** One logged session as a line: date, readiness, each exercise's sets. */
export function sessionLine(rec) {
  const exs = (rec.blocks || []).flatMap((b) => b.exercises || []).map((ex) => {
    const sets = (ex.sets || []).filter((s) => s && s.reps != null);
    if (!sets.length) return null;
    const w = sets[0].weight != null ? `${sets[0].weight} kg ` : "";
    const rpes = sets.map((s) => s.rpe).filter((x) => x != null);
    return `${ex.name} ${w}× ${sets.map((s) => s.reps).join("/")}${rpes.length ? ` @RPE ${Math.max(...rpes)}` : ""}`;
  }).filter(Boolean);
  return `- ${rec.date} · ${rec.readiness || "normal"}${rec.travel ? " · travelling" : ""}: ${exs.join("; ")}`;
}

/**
 * @param {{ history?: any[], trainingState?: any, focus?: string, mainLifts?: Record<string,string> | null,
 *   week?: any[], bodyweightKg?: number|null, now?: Date }} input
 * @returns {string}
 */
export function buildCoachContext({ history = [], trainingState = null, focus = "Forged", mainLifts = {}, week = [], bodyweightKg = null, now = new Date() } = {}) {
  // ISO, not a locale string: stable across devices and unambiguous to a model.
  const dateLabel = localDateStr(now);
  const out = [];
  out.push(`# My training — Heatwayve snapshot, ${dateLabel}`);
  out.push(`A point-in-time export: it shows what I'd done by ${dateLabel}, nothing after.`);
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
  if (strength.length === 0) {
    out.push("", "No sessions logged yet.");
    return out.join("\n");
  }

  const rhythm = weeklyRhythm(history, 8);
  out.push("", "## Consistency, last 8 weeks (strength days per week, oldest first)");
  out.push(rhythm.map((w) => w.days).join(" · "));

  const trends = mainLiftTrend(history);
  const lifts = trainingState?.lifts || {};
  const trendLines = Object.entries(trends).map(([name, series]) => {
    const first = series[0], last = series[series.length - 1];
    const stall = lifts[name]?.stallSignal ? ` · ${lifts[name].stallSignal.replace("_", " ")}` : "";
    return `- ${name}: ${r1(first.est1RM)} → ${r1(last.est1RM)} kg est. 1RM over ${series.length} sessions (last ${last.date}; top set ${last.topSet.weight} × ${last.topSet.reps})${stall}`;
  });
  if (trendLines.length) out.push("", "## Main lifts", ...trendLines);

  const audit = auditHistoryVolume(history, { weeks: 2, now });
  if (!audit.away) {
    out.push("", "## Weekly volume vs landmarks, last 2 weeks (sets per week)");
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
