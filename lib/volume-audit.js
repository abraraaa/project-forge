// @ts-check
// lib/volume-audit.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure helper: compute the weekly weighted-set volume a programme delivers to
// each muscle, and flag it against evidence-based volume landmarks (MEV/MAV/MRV).
//
// This is the measurement tool behind the programme-rebalance work — it turns
// "Day C feels redundant with Day B" into "the posterior chain gets N weighted
// sets/week, which is above MRV." Build candidate programmes, re-audit, compare.
//
// Set-counting model (matches lib/analytics.js): every exercise in a block earns
// that block's `sets` count. A 3-set superset gives exA 3 sets AND exB 3 sets —
// they're distinct movements performed for 3 rounds each. Sets are then spread
// across muscles by exercise anatomy (primary 1.0 + weighted secondaries) via
// distributeAcrossMuscles, so a squat credits quads fully and glutes/hams/etc.
// partially — the same honest accounting the analytics layer uses.
//
// Granular, not display-bucketed: the volume landmarks separate each deltoid
// head ("Shoulders" target applies per head) and keep Biceps/Triceps distinct,
// so this audit works at the 13-muscle MUSCLES level — NOT the 9-bucket chart
// vocabulary (which merges delts → Shoulders and biceps/triceps → Arms).
// ─────────────────────────────────────────────────────────────────────────────

import { SESSIONS, applyFocusToSessions, DEFAULT_FOCUS } from "./programme.js";
import { distributeAcrossMuscles, MUSCLES } from "./exercise-anatomy.js";
import { isCountedSet } from "./counted-set.js";

// Weekly volume landmarks (weighted sets per week), from the project reference
// data (Israetel/Nuckols/Helms-derived). The "Shoulders (per head)" row applies
// independently to Front / Side / Rear delts. Forearms has no landmark (it's a
// stabiliser we track but don't programme volume for) and is reported untargeted.
export const VOLUME_TARGETS = {
  Quads:         { mev: 8,  mav: 18, mrv: 22 },
  Hamstrings:    { mev: 6,  mav: 12, mrv: 16 },
  Glutes:        { mev: 4,  mav: 12, mrv: 16 },
  Chest:         { mev: 8,  mav: 16, mrv: 20 },
  // Back split (stage 3): Lats + Upper Back carry the old Back volume as
  // banded targets (panel-adjudicated starting landmarks, RP-consistent).
  // Erectors is a fatigue CEILING — mev 0, same doctrine as Traps: warn
  // when deadlift-heavy weeks stack axial load, never nag a shortfall.
  Lats:          { mev: 6,  mav: 14, mrv: 22 },
  "Upper Back":  { mev: 6,  mav: 16, mrv: 22 },
  Erectors:      { mev: 0,  mav: 6,  mrv: 12 },
  // Traps: mev 0, like Core — the reference data treats direct trap volume
  // as optional (deads/rows/carries deliver plenty indirectly), so the row
  // must flag EXCESS without ever nagging a shortfall nobody should chase.
  Traps:         { mev: 0,  mav: 12, mrv: 20 },
  "Front Delts": { mev: 6,  mav: 12, mrv: 16 },
  "Side Delts":  { mev: 6,  mav: 12, mrv: 16 },
  "Rear Delts":  { mev: 6,  mav: 12, mrv: 16 },
  Biceps:        { mev: 5,  mav: 14, mrv: 20 },
  Triceps:       { mev: 6,  mav: 14, mrv: 18 },
  Calves:        { mev: 6,  mav: 12, mrv: 16 },
  Core:          { mev: 0,  mav: 16, mrv: 25 },
};

// Display order for reports — landmark muscles first (in table order), then any
// tracked-but-untargeted muscle (e.g. Forearms) so nothing silently vanishes.
export const AUDIT_MUSCLE_ORDER = [
  ...Object.keys(VOLUME_TARGETS),
  ...Object.values(MUSCLES).filter((m) => !(m in VOLUME_TARGETS)),
];

const round1 = (n) => Math.round(n * 10) / 10;

// Pull every (exercise, sets) pair out of a block. Main blocks carry `ex`;
// supersets/finishers carry `exA` + `exB`. Each earns the block's set count.
function blockExercises(block) {
  const sets = block?.sets || 0;
  const out = [];
  for (const key of ["ex", "exA", "exB"]) {
    if (block?.[key]) out.push({ ex: block[key], sets });
  }
  return out;
}

/**
 * Weekly weighted-set volume per (granular) muscle for a programme.
 *
 * @param {Array} [sessions]  Programme sessions (defaults to the live SESSIONS).
 *                            One pass = one training week (A + B + C).
 * @param {{focus?:string, config?:object}} [opts]
 *   focus  — Forged | Strong | Sculpt. Applies the focus's programming rules
 *            via applyFocusToSessions before counting, so the audit reflects
 *            what the user actually does (Strong drops a superset; Sculpt
 *            bumps aligned slots), not the static template.
 *   config — programmeBlock.config (per-slot active exercise). Needed by
 *            Sculpt to decide which slots are "aligned" and get the +set bump.
 *            Ignored by Forged and Strong.
 * @returns {Record<string, number>}  muscle → weighted sets/week (1dp).
 */
export function computeWeeklyVolume(sessions = SESSIONS, { focus = DEFAULT_FOCUS, config = {} } = {}) {
  const adjusted = applyFocusToSessions(sessions, focus, config);
  /** @type {Record<string, number>} */
  const totals = {};
  for (const session of adjusted || []) {
    for (const block of session?.blocks || []) {
      for (const { ex, sets } of blockExercises(block)) {
        if (!sets) continue;
        const contrib = distributeAcrossMuscles(ex.name, sets, ex.muscle);
        for (const [muscle, value] of Object.entries(contrib)) {
          totals[muscle] = (totals[muscle] || 0) + value;
        }
      }
    }
  }
  for (const m of Object.keys(totals)) totals[m] = round1(totals[m]);
  return totals;
}

// Volume-band classification against a single muscle's landmarks.
//   under_mev — won't drive growth (raise it)
//   low       — MEV..MAV: productive, room to add
//   optimal   — MAV..MRV: the target window
//   over_mrv  — above MRV: junk volume / recovery cost (trim it)
//   untargeted — no landmark for this muscle
export function classifyVolume(sets, target) {
  if (!target) return "untargeted";
  if (sets < target.mev) return "under_mev";
  if (sets < target.mav) return "low";
  if (sets <= target.mrv) return "optimal";
  return "over_mrv";
}

/**
 * Full audit: per-muscle volume + landmark + band, plus a flags list of the
 * actionable extremes (under MEV / over MRV).
 *
 * @param {Array} [sessions]
 * @param {Object} [opts]
 * @param {Object} [opts.targets]         Muscle landmark overrides
 * @param {string} [opts.focus]           "Forged" | "Strong" | "Sculpt"
 * @param {Object} [opts.config]          Per-slot active exercise
 * @returns {{ perMuscle: Record<string,{sets:number,target:any,status:string}>,
 *             flags: Array<{muscle:string,status:string,sets:number,target:any}> }}
 */
export function auditVolume(sessions = SESSIONS, { targets = VOLUME_TARGETS, focus = DEFAULT_FOCUS, config = {} } = {}) {
  const volume = computeWeeklyVolume(sessions, { focus, config });
  const muscles = [
    ...AUDIT_MUSCLE_ORDER,
    ...Object.keys(volume).filter((m) => !AUDIT_MUSCLE_ORDER.includes(m)),
  ];

  /** @type {Record<string, { sets: number, target: any, status: string }>} */
  const perMuscle = {};
  for (const muscle of muscles) {
    const sets = round1(volume[muscle] || 0);
    const target = targets[muscle] || null;
    perMuscle[muscle] = { sets, target, status: classifyVolume(sets, target) };
  }

  const flags = Object.entries(perMuscle)
    .filter(([, r]) => r.status === "under_mev" || r.status === "over_mrv")
    .map(([muscle, r]) => ({ muscle, status: r.status, sets: r.sets, target: r.target }));

  return { perMuscle, flags };
}

// ─── Live training audit (from logged history) ──────────────────────────────
// Audit the user's ACTUAL recent training, not just the static programme. Same
// MEV/MAV/MRV vocabulary as auditVolume above — but the input is logged
// history sessions, and sets are averaged across the trailing window so a
// "weekly" volume is honest regardless of which days the user trained.
//
// Aggregation: non-empty sets are counted, and exercise anatomy distributes
// the set count across primary + secondary muscles (distributeAcrossMuscles).
// We keep the GRANULAR muscle vocabulary
// (not display-bucketed) so MEV/MAV/MRV per delt head and per-arm-muscle
// stays honest.
//
// Returns the same shape as auditVolume PLUS metadata the UI needs to decide
// whether to surface the card at all (a 3-day-old user with 1 session
// shouldn't get a wall of "under MEV" warnings).
//
// @param {Array} [history]  Session log records (newest-first or any order).
// @param {{weeks?:number, targets?:typeof VOLUME_TARGETS, now?:Date}} [opts]
// @returns {{
//   perMuscle: Record<string,{sets:number,target:object|null,status:string}>,
//   flags:     Array<{muscle:string,status:string,sets:number,target:object|null}>,
//   weeksAnalysed: number,
//   sessionsAnalysed: number,
// }}
export function auditHistoryVolume(
  history = [],
  { weeks = 2, targets = VOLUME_TARGETS, now = new Date() } = {},
) {
  // RECENCY-AWARE. Trailing `weeks`-week window, default 2 (down from 4 — a
  // 4-week average was too smoothing: one skipped week barely moved it, so a
  // real fall-off still read as "compliant"). MEV/MAV/MRV are "are you training
  // enough RIGHT NOW" landmarks, not a monthly average, so a shorter window is
  // the honest read: with weeks=2, a fully-skipped recent week halves the
  // per-week figure and registers instead of being averaged away.
  //
  // We divide by the window SPAN (not weeks-observed) so a skipped week counts
  // as zero rather than being ignored. When the window is empty we return
  // `away: true` so the UI can state Forge's philosophy — consistency over time
  // compounds; a lighter stretch is not failure — instead of a wall of
  // under-MEV alarms. Rolling (not week-aligned) by design: a session logged
  // today still counts, so "I trained this morning" is never shown as "away".
  const oldest = new Date(now);
  oldest.setHours(0, 0, 0, 0);
  oldest.setDate(oldest.getDate() - weeks * 7);

  const inWindow = (history || []).filter((rec) => {
    if (!rec?.date) return false;
    return new Date(rec.date) >= oldest;
  });

  const totals = {};
  for (const session of inWindow) {
    for (const block of session.blocks || []) {
      for (const ex of block.exercises || []) {
        const setsCount = (ex.sets || []).filter(isCountedSet).length;
        if (setsCount === 0) continue;
        const contrib = distributeAcrossMuscles(ex.name, setsCount, ex.muscle);
        for (const [muscle, value] of Object.entries(contrib)) {
          totals[muscle] = (totals[muscle] || 0) + value;
        }
      }
    }
  }

  const perMuscle = {};
  const muscles = [
    ...AUDIT_MUSCLE_ORDER,
    ...Object.keys(totals).filter((m) => !AUDIT_MUSCLE_ORDER.includes(m)),
  ];
  for (const muscle of muscles) {
    const sets = round1((totals[muscle] || 0) / weeks);
    const target = targets[muscle] || null;
    perMuscle[muscle] = { sets, target, status: classifyVolume(sets, target) };
  }

  const flags = Object.entries(perMuscle)
    .filter(([, r]) => r.status === "under_mev" || r.status === "over_mrv")
    .map(([muscle, r]) => ({ muscle, status: r.status, sets: r.sets, target: r.target }));

  return {
    perMuscle,
    flags,
    weeksAnalysed: weeks,
    sessionsAnalysed: inWindow.length,
    away: inWindow.length === 0,
  };
}
