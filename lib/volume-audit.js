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

import { SESSIONS } from "./programme.js";
import { distributeAcrossMuscles, MUSCLES } from "./exercise-anatomy.js";

// Weekly volume landmarks (weighted sets per week), from the project reference
// data (Israetel/Nuckols/Helms-derived). The "Shoulders (per head)" row applies
// independently to Front / Side / Rear delts. Forearms has no landmark (it's a
// stabiliser we track but don't programme volume for) and is reported untargeted.
export const VOLUME_TARGETS = {
  Quads:         { mev: 8,  mav: 18, mrv: 22 },
  Hamstrings:    { mev: 6,  mav: 12, mrv: 16 },
  Glutes:        { mev: 4,  mav: 12, mrv: 16 },
  Chest:         { mev: 8,  mav: 16, mrv: 20 },
  Back:          { mev: 10, mav: 20, mrv: 25 },
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
 * @returns {Record<string, number>}  muscle → weighted sets/week (1dp).
 */
export function computeWeeklyVolume(sessions = SESSIONS) {
  const totals = {};
  for (const session of sessions || []) {
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
 * @param {{ targets?: typeof VOLUME_TARGETS }} [opts]
 * @returns {{ perMuscle: Record<string,{sets:number,target:object|null,status:string}>,
 *             flags: Array<{muscle:string,status:string,sets:number,target:object|null}> }}
 */
export function auditVolume(sessions = SESSIONS, { targets = VOLUME_TARGETS } = {}) {
  const volume = computeWeeklyVolume(sessions);
  const muscles = [
    ...AUDIT_MUSCLE_ORDER,
    ...Object.keys(volume).filter((m) => !AUDIT_MUSCLE_ORDER.includes(m)),
  ];

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
