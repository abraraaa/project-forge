// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/progression.js
// ─────────────────────────────────────────────────────────────────────────────
// The progression engine.
//
// Single entry point: computeNextPrescription(...)
// Pure function — no React, no I/O. Takes session history + lift state +
// optional context, returns the next prescription for that lift.
//
// ─── Type definitions (JSDoc — IDE-only, no runtime cost) ────────────────────

/**
 * Static metadata about a single lift.
 * @typedef {Object} LiftProfile
 * @property {string} primaryMuscle       Used for cold-start anchor lookup
 * @property {"power"|"lower_compound"|"upper_compound"|"accessory"|"isolation"} category
 * @property {boolean} progressesByLoad   False for BW-only lifts (rep progression instead)
 * @property {number} step                kg increment when ADDing weight
 */

/**
 * Per-profile, per-lift training state.
 * @typedef {Object} LiftState
 * @property {number|null} currentWeight  What was last loaded
 * @property {{ reps: number, sets: number, baseReps?: number }} currentRepRange
 *   baseReps: the programme's target, kept across a rep climb.
 * @property {number|null} bestE1RM       Highest estimated 1RM seen
 * @property {number} consecutiveHolds    Drives stall detection
 * @property {number} consecutiveAdds     Drives the double rung
 * @property {"mild"|"stall"|"deep_stall"|null} stallSignal
 * @property {number} sessionsCount       Used for confidence calibration
 * @property {number} [inRecoveryUntil]   Phase 3 — recovery sessions remaining
 * @property {Array<Object>} history      Last 12 prescription decisions
 */

/**
 * What the engine returns for next session.
 * @typedef {Object} Prescription
 * @property {number|null} weight         kg, or null for BW-progression lifts
 * @property {number|string} reps         Target reps; "X/leg" for unilateral
 * @property {number} sets
 * @property {number} rir                 Target RIR
 * @property {"COLD_START"|"ADD"|"HOLD"|"DROP_5"|"DROP_10"|"DELOAD"|"RECOVERY"} decision
 * @property {string[]} rationale         Human-readable trail of reasoning steps
 * @property {"low"|"moderate"|"high"} confidence
 * @property {boolean} repRangeChanged    True if rep range was cycled this session
 * @property {{ reps: number, sets: number, baseReps: number }} [repRange]
 *   The range for the caller to persist.
 */

/**
 * Optional context for computeNextPrescription.
 * @typedef {Object} ComputeContext
 * @property {string} [readiness]         Current session readiness
 * @property {number} [currentWeight]     Fallback weight if no history
 * @property {string} [loadType]          Implement the load sits on, when the
 *                                        caller knows it (cold start has no
 *                                        record to read it from)
 */

// The decision rules are DEFINED by evaluatePerformance / decideMovement /
// applyMovement below and pinned by tests/progression.test.js. Read those —
// a prose restatement here would only drift from them.
//
// INVARIANTS — each of these has cost us a real defect:
//   · A HOLD must hold. Never round or otherwise adjust the load on a HOLD;
//     return the performed weight unchanged.
//   · Rounding increments come from STEP_SIZES — the same source as the step
//     itself. Never hard-code a second grid. The result is then snapped to the
//     IMPLEMENT'S grid (snapToImplement, shared with the drum): category steps
//     are barbell-shaped, and 1.25kg on a dumbbell prescribes a weight that
//     does not exist.
//   · Fatigue may only downgrade a decision, never upgrade one.
//   · Recovery state must survive a session being applied; rebuilding lift
//     state from scratch silently collapses the recovery window to one.
// ─────────────────────────────────────────────────────────────────────────────

import { getLiftProfile, STEP_SIZES, ADD_THRESHOLD_RIR, coldStartFromAnchor, snapToImplement, isBodyweightMovement } from "./lift-translations.js";
import { parseLocalDate, localDateStr, todayLocalIso } from "./dates.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_REPS = 5;
const DEFAULT_SETS = 3;
const DEFAULT_RIR  = 2;

// ─── Numeric reps parser (mirrors storage.js) ─────────────────────────────────
function parseReps(reps) {
  if (typeof reps === "number") return reps;
  if (typeof reps === "string") {
    const m = reps.match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }
  return 0;
}

// Round to plate increment based on category
function roundToCategoryIncrement(weight, category) {
  if (weight === null || weight === undefined) return weight;
  const increment = (
    category === "accessory_arm" ||
    category === "accessory_isolation"
  ) ? 0.5 : 1.25;
  return Math.round(weight / increment) * increment;
}

// ─── Find the most recent session of a given lift in history ──────────────────
// Iterates v2-shape session history (newest last by ID sort) and returns the
// most recent session containing the lift, plus the exercise object within it.
//
// Skips sessions where readiness === "cooked" by default — those don't drive
// progression decisions (they're recovery sessions).
//
// ALWAYS skips travel sessions, with no opt-in (lib/travel.js). This is the
// funnel every load prescription reads through, and a travel record is not
// evidence about load: it is the same session trained with bodyweight in a
// hotel room. The danger is specific — travel keeps the NAME of any movement
// that already travels (Bulgarian Split Squat, Pull-Up), so without this the
// engine would read a bodyweight set logged at null weight as the newest
// evidence for a loaded lift and prescribe down from it. A user who trained
// honestly on holiday would come home to a wrecked prescription.
function findMostRecentLiftSession(history, liftName, { includeCooked = false } = {}) {
  if (!history || !history.length) return null;

  // Iterate newest-first
  for (let i = history.length - 1; i >= 0; i--) {
    const rec = history[i];
    if (rec?.travel === true) continue;
    if (!includeCooked && rec.readiness === "cooked") continue;

    for (const block of rec.blocks || []) {
      for (const ex of block.exercises || []) {
        if (ex.name === liftName) {
          return { session: rec, exercise: ex, blockType: block.type };
        }
      }
    }
  }
  return null;
}

// ─── Evaluate a session's performance against its prescribed target ──────────
// Returns one of:
//   "PERFORMED_FULL"    — hit all prescribed reps across all prescribed sets
//   "PERFORMED_PARTIAL" — hit reps on every LOGGED set, but logged fewer sets
//                         than prescribed (ran out of time ≠ failed)
//   "MISSED_LIGHT"      — missed reps on one set only
//   "MISSED_MODERATE"   — missed across multiple sets, ≤ 30% shortfall
//   "MISSED_HEAVY"      — > 30% shortfall (badly missed session)
//
// Considers `prescribed` if present on the exercise; falls back to per-set
// rep targets derived from the first set if not.
//
// WARNING: unlogged sets are ABSENT EVIDENCE, never zero-rep failures. Only
// logged sets enter the shortfall maths. Counting a skipped set as 0 reps
// made "logged 1 of 3 sets" read as a >30% shortfall → DROP_10, punishing a
// cut-short session as a badly failed one. A partial session with clean
// logged sets holds (no ADD off partial evidence, no DROP either); a partial
// whose logged sets genuinely missed still evaluates those misses.
// ─── Reach sets — the Fresh-day nudge ────────────────────────────────────────
// A "reach" is a set the user chose to take BEYOND the prescription on a day
// they declared Fresh: either an extra set, or the final prescribed set flipped
// heavier on the drum. Upside-only by contract, in all three directions:
//
//   never a miss — a reach contributes no shortfall, so reaching and falling
//                  short can NEVER deload you. This is the load-bearing half:
//                  an EXTRA set sits outside `evaluableSets` and is ignored for
//                  free, but a RAMPED final set sits inside the evaluated
//                  window, where a good-day reach would otherwise read as a
//                  failed session and cost the user 5%.
//   earned only  — a reach raises the working weight only if it met the
//                  prescribed reps at the heavier load. Heavier-for-fewer is a
//                  fine set, but it is not evidence you can hold the
//                  prescription there next week, and the engine's weight is a
//                  prescription, not a personal best.
//   still honest — a reach's RIR still counts (topSetRir), so grinding one out
//                  holds at the new weight rather than stacking another step.
const isReach = (s) => s?.reach === true;

// The per-set rep target, derived the one way: explicit prescription if the
// exercise carries one, else the first set's reps as the implied target.
function targetRepsFor(exercise, sets) {
  if (exercise?.prescribed?.reps) return parseReps(exercise.prescribed.reps);
  return parseReps(sets?.[0]?.reps);
}

function evaluatePerformance(exercise) {
  const sets = (exercise.sets || []).filter(s => s.reps !== null && s.reps !== undefined);
  if (sets.length === 0) return "PERFORMED_FULL"; // No data — neutral

  // Determine target reps per set
  let targetSets = sets.length;
  let targetReps;
  if (exercise.prescribed && exercise.prescribed.reps) {
    targetReps = parseReps(exercise.prescribed.reps);
    if (exercise.prescribed.sets) targetSets = exercise.prescribed.sets;
  } else {
    // No prescribed — use the first set's reps as the implied target
    targetReps = parseReps(sets[0].reps);
  }
  if (!targetReps || targetReps === 0) return "PERFORMED_FULL";

  // Only logged sets are evaluable — see the warning above.
  const evaluableSets = Math.min(targetSets, sets.length);
  const partial = sets.length < targetSets;

  // Count missed-rep sets and total shortfall across the logged sets
  let missedSetCount = 0;
  let totalShortfall = 0;
  const totalTargetReps = evaluableSets * targetReps;

  for (let i = 0; i < evaluableSets; i++) {
    // A reach is never a miss. It stays in `evaluableSets` so the partial
    // check still sees a complete session — the user did every set, one of
    // them just weighed more than we asked for.
    if (isReach(sets[i])) continue;
    const performed = parseReps(sets[i].reps);
    const shortfall = Math.max(0, targetReps - performed);
    if (shortfall > 0) missedSetCount += 1;
    totalShortfall += shortfall;
  }

  if (missedSetCount === 0) return partial ? "PERFORMED_PARTIAL" : "PERFORMED_FULL";
  if (missedSetCount === 1 && totalShortfall <= Math.ceil(targetReps * 0.4)) {
    return "MISSED_LIGHT"; // One set short by a small amount
  }
  const shortfallRatio = totalShortfall / totalTargetReps;
  if (shortfallRatio > 0.30) return "MISSED_HEAVY";
  return "MISSED_MODERATE";
}

// ─── Get the top-set RIR for a session's exercise ─────────────────────────────
// Returns the lowest RIR seen across the exercise's sets (the "hardest" set).
// Lower RIR = closer to limit. We use this rather than average because the top
// set is the most diagnostic of progression readiness.
function topSetRir(exercise) {
  const sets = (exercise.sets || []).filter(s => s.rir !== null && s.rir !== undefined);
  if (sets.length === 0) return null;
  return Math.min(...sets.map(s => s.rir));
}

// ─── Get the top-set effective load ──────────────────────────────────────────
// Returns the heaviest set's effectiveLoad if available (reflects true systemic
// load including bodyweight for non-external lifts).
//
// CRITICAL: fallbackWeight is used ONLY when the exercise has no performable
// loads (no sets, or all-zero bodyweight sets). It must NOT be max-blended
// with actual performed loads — doing so makes a stale liftState.currentWeight
// override the user's just-performed lighter top set, so the engine reasons
// from a phantom basis. That bug surfaced as "I logged 100kg max-effort
// after dropping the bar weight in-session, but next session jumped to 110kg"
// when liftState.currentWeight was still seeded from the old hardcoded
// SESSIONS default.
function topSetWeight(exercise, fallbackWeight, loadType = null) {
  const sets = exercise.sets || [];
  if (sets.length === 0) return fallbackWeight;
  // A reach set only counts toward the working weight if it MET the target at
  // the heavier load — see the reach contract above. Heavier-for-fewer would
  // otherwise silently become next session's prescription.
  const target = targetRepsFor(exercise, sets);
  const earned = (s) => !isReach(s) || (!!target && parseReps(s.reps) >= target);
  // A bodyweight movement's effectiveLoad INCLUDES bodyweight, so prescribing
  // from it hands back ~83kg of "added weight" on a plain pull-up. The engine
  // reasons in effectiveLoad for est1rm and volume — right, the systemic load
  // really is BW+added — but what it PRESCRIBES has to be in the units the
  // user enters, which here is the added load alone.
  const addedOnly = isBodyweightMovement(loadType);
  const loads = sets
    .filter(earned)
    .map(s => (addedOnly ? (s.weight ?? 0) : (s.effectiveLoad ?? s.weight ?? 0)))
    .filter(l => l > 0);
  if (loads.length === 0) return addedOnly ? null : fallbackWeight;
  return Math.max(...loads);
}

// ─── Decide ADD / HOLD / DROP based on performance + RIR ─────────────────────
/**
 * @returns {{ decision: "ADD"|"HOLD"|"DROP_5"|"DROP_10", reason: string }}
 */
function decideMovement(performance, rir, addThresholdRir, readiness) {
  // Cooked sessions: never add weight, never drop further. Just hold.
  if (readiness === "cooked") {
    return { decision: "HOLD", reason: "readiness_cooked" };
  }

  // Performance gate: ADD requires hitting prescribed reps
  if (performance === "PERFORMED_FULL") {
    if (rir === null) {
      // No RIR signal — be conservative, hold
      return { decision: "HOLD", reason: "no_rir_signal" };
    }
    if (rir >= addThresholdRir) {
      return { decision: "ADD", reason: "performed_full_with_rir" };
    }
    if (rir === 0) {
      // True grinder — held but at absolute limit
      return { decision: "HOLD", reason: "performed_full_rir0_grinder" };
    }
    if (rir === 1) {
      return { decision: "HOLD", reason: "performed_full_rir1_close_to_limit" };
    }
    // RIR is between 1 and the addThreshold — sub-threshold for this category
    return { decision: "HOLD", reason: "performed_full_subthreshold_rir" };
  }

  if (performance === "PERFORMED_PARTIAL") {
    // Clean sets but a cut-short session — no ADD off partial evidence,
    // and certainly no DROP for sets that were never attempted.
    return { decision: "HOLD", reason: "partial_session" };
  }

  if (performance === "MISSED_LIGHT") {
    return { decision: "HOLD", reason: "missed_light" };
  }
  if (performance === "MISSED_MODERATE") {
    return { decision: "DROP_5", reason: "missed_moderate" };
  }
  if (performance === "MISSED_HEAVY") {
    return { decision: "DROP_10", reason: "missed_heavy" };
  }

  // Unknown — be conservative
  return { decision: "HOLD", reason: "unknown_state" };
}

// ─── Apply movement to last weight, returning the next prescription ──────────
// Rounding applies ONLY to the percentage drops (deep audit 2026-07-26).
//
// Every decision used to be snapped to the plate grid, including HOLD — and
// the grid (1.25kg for everything except arms/isolation) does not divide every
// category's step. The results were silently wrong in both directions:
//
//   HOLD @ 18kg accessory_compound → 17.5   (a DROP on a hold)
//   HOLD @ 26kg upper_push         → 26.25  (an ADD on a hold)
//   ADD  @ 18kg accessory_compound → 18.75  (+0.75, not the intended +1.0)
//
// It also destroyed legitimate off-grid loads: a real 17.5kg dumbbell on a
// 1.0kg-step lift got rounded away from a weight the user physically owns.
//
// The reasoning now: HOLD needs no rounding because the user JUST LIFTED that
// weight — it is loadable by definition. ADD needs none because STEP_SIZES are
// already valid increments, so current+step lands on a loadable weight. Only
// DROP_5/DROP_10 produce arbitrary decimals (102.5 × 0.95 = 97.375), and those
// are exactly the cases that need snapping to something you can put on a bar.
// Rate of adaptation. A fixed category step is already ~5% of a light lift and
// ~1.8% of a heavy one, so the novice/veteran curve needs no detection. What is
// added here is a second rung for someone adding every session with reps still
// to spare, capped as a FRACTION of the load — two rungs is 5% of a 100kg squat
// but 12.5% of an 8kg curl.
const CLIMB_AFTER_ADDS = 3;      // consecutive ADDs before a second rung is offered
const CLIMB_RIR_MARGIN = 1;      // ...and only with this much RIR above threshold
const MAX_JUMP_FRACTION = 0.10;  // no single jump may exceed this share of the load

// A plateau cannot be answered by a smaller step — one rung is the floor. Hold
// the load, add a rep, bank the weight when the higher target is met.
const REP_CLIMB_CEILING = 3;     // reps may rise this far above base, then stop

/** Rungs an ADD moves: 1, or 2 when the lifter is outrunning the step.
 * @returns {1|2} */
export function climbRungs({ consecutiveAdds = 0, rir = null, addThresholdRir = 2, step = 0, currentWeight = 0 }) {
  if (!(step > 0) || !(currentWeight > 0)) return 1;
  if (consecutiveAdds < CLIMB_AFTER_ADDS) return 1;
  // No RIR means no evidence the last add was comfortable.
  if (rir === null || rir < addThresholdRir + CLIMB_RIR_MARGIN) return 1;
  if (step * 2 > currentWeight * MAX_JUMP_FRACTION) return 1;
  return 2;
}

/** Rep target for a stalled lift; never above base + REP_CLIMB_CEILING.
 * @returns {{ reps: number, changed: boolean }} */
export function repClimb({ stallSignal = null, baseReps = 0, currentReps = 0 }) {
  const base = baseReps > 0 ? baseReps : currentReps;
  const now = currentReps > 0 ? currentReps : base;
  const stalled = stallSignal === "stall" || stallSignal === "deep_stall";
  if (!stalled || !(base > 0)) return { reps: now, changed: false };
  if (now >= base + REP_CLIMB_CEILING) return { reps: now, changed: false };
  return { reps: now + 1, changed: true };
}

function applyMovement(decision, currentWeight, category, profile, loadType = null, rungs = 1) {
  const step = STEP_SIZES[category] ?? 0;
  // Category gives the SIZE of the move; the implement decides which weights
  // the move can land on. Snapped only where the engine actually moves the
  // load — a HOLD returns the performed weight untouched, always.
  const snap = (kg) => snapToImplement(kg, loadType);
  switch (decision) {
    case "ADD":
      return Math.max(0, snap(currentWeight + step * (rungs === 2 ? 2 : 1)));
    case "DROP_5":
      return Math.max(0, snap(roundToCategoryIncrement(currentWeight * 0.95, category)));
    case "DROP_10":
      return Math.max(0, snap(roundToCategoryIncrement(currentWeight * 0.90, category)));
    case "HOLD":
    default:
      return Math.max(0, currentWeight);
  }
}

// ─── Public API: computeNextPrescription ──────────────────────────────────────
// Returns a prescription object describing what the user should do on this lift
// next session. Pure function — caller persists the result to TS.lifts[name].
//
/**
 * @param {Object} opts
 * @param {string} opts.liftName           Canonical exercise name
 * @param {Array} opts.history             Session history (v2-shaped, oldest first)
 * @param {LiftState|null} opts.liftState  TS.lifts[liftName], or null on cold start
 * @param {Object|null} opts.muscleAnchor  TS.muscleAnchors[muscleGroup], for cold start
 * @param {ComputeContext} opts.context    { readiness?, currentWeight? }
 * @returns {Prescription}
 */
export function computeNextPrescription({
  liftName,
  history = [],
  liftState = null,
  muscleAnchor = null,
  context = {},
}) {
  const profile = getLiftProfile(liftName);
  const category = profile.category;
  const addThresholdRir = ADD_THRESHOLD_RIR[category] ?? DEFAULT_RIR;
  const rationale = [];

  // ─── Cold start ──────────────────────────────────────────────────────────
  // No prior history for this lift.
  const lastSession = findMostRecentLiftSession(history, liftName, { includeCooked: false });

  if (!lastSession || !liftState) {
    // BW-progression lifts get rep-based prescription, no weight
    if (!profile.progressesByLoad) {
      return {
        weight: null,
        reps: DEFAULT_REPS,
        sets: DEFAULT_SETS,
        rir: DEFAULT_RIR,
        decision: "COLD_START",
        rationale: ["bw_progression_no_weight"],
        confidence: "moderate",
        repRangeChanged: false,
      };
    }

    // Try anchor-based cold start
    const anchorWeight = snapToImplement(
      coldStartFromAnchor(liftName, muscleAnchor),
      context.loadType ?? null,
    );
    if (anchorWeight !== null) {
      rationale.push("cold_start_from_anchor");
      rationale.push(`anchor_lift=${muscleAnchor?.bestE1RMLift || "unknown"}`);
      return {
        weight: anchorWeight,
        reps: DEFAULT_REPS,
        sets: DEFAULT_SETS,
        rir: DEFAULT_RIR,
        decision: "COLD_START",
        rationale,
        confidence: "moderate",
        repRangeChanged: false,
      };
    }

    // No anchor available — caller falls back to programme.js default
    rationale.push("cold_start_no_anchor");
    return {
      weight: context.currentWeight ?? null, // caller provides programme default
      reps: DEFAULT_REPS,
      sets: DEFAULT_SETS,
      rir: DEFAULT_RIR,
      decision: "COLD_START",
      rationale,
      confidence: "low",
      repRangeChanged: false,
    };
  }

  // ─── Standard path — we have history for this lift ───────────────────────
  const lastEx = lastSession.exercise;
  const loadType = context.loadType
    ?? lastEx?.loadType
    ?? lastEx?.sets?.find((x) => x?.loadType)?.loadType
    ?? null;
  const lastWeight = topSetWeight(lastEx, liftState.currentWeight, loadType);
  const performance = evaluatePerformance(lastEx);
  const rir = topSetRir(lastEx);
  const lastReadiness = lastSession.session.readiness;

  rationale.push(`last_performance=${performance}`);
  if (rir !== null) rationale.push(`top_set_rir=${rir}`);
  if (lastReadiness === "cooked") rationale.push("last_session_cooked");

  // BW-progression lifts: no weight change, but we can suggest rep progression
  if (!profile.progressesByLoad) {
    // Simple rep progression: if performed full + RIR ≥ 2, add 1 rep target
    const lastReps = parseReps(lastEx.sets?.[0]?.reps) || DEFAULT_REPS;
    const repsNext = (performance === "PERFORMED_FULL" && rir !== null && rir >= addThresholdRir)
      ? lastReps + 1
      : lastReps;
    rationale.push("bw_rep_progression");
    return {
      weight: null,
      reps: repsNext,
      sets: lastEx.prescribed?.sets ?? DEFAULT_SETS,
      rir: DEFAULT_RIR,
      decision: repsNext > lastReps ? "ADD" : "HOLD",
      rationale,
      confidence: "moderate",
      repRangeChanged: false,
    };
  }

  // A bodyweight movement carrying no added load progresses by REPS, whatever
  // its profile says. progressesByLoad is true for a pull-up because it CAN
  // take a belt, not because it always does — so the choice is made per
  // session, from whether load was actually used.
  if (isBodyweightMovement(loadType) && !(lastWeight > 0)) {
    const lastReps = parseReps(lastEx.sets?.[0]?.reps) || DEFAULT_REPS;
    const repsNext = (performance === "PERFORMED_FULL" && rir !== null && rir >= addThresholdRir)
      ? lastReps + 1
      : lastReps;
    rationale.push("bw_rep_progression_unloaded");
    return {
      weight: null,
      reps: repsNext,
      sets: lastEx.prescribed?.sets ?? DEFAULT_SETS,
      rir: DEFAULT_RIR,
      decision: repsNext > lastReps ? "ADD" : "HOLD",
      rationale,
      confidence: "moderate",
      repRangeChanged: false,
    };
  }

  // Loaded progression
  const movement = decideMovement(performance, rir, addThresholdRir, context.readiness ?? lastReadiness);
  rationale.push(`decision_reason=${movement.reason}`);

  // The implement decides which weights exist. Category steps are barbell-
  // shaped (1.25kg is a micro-plate); a dumbbell rack cannot express .25 or
  // .75, and the drum's per_db step is whole kg so the fraction would persist
  // forever. Read it off the record we are reasoning from.
  // baseReps is remembered across a rep climb so there is something to return to.
  const prevRange = liftState.currentRepRange || null;
  const programmeReps =
    parseReps(lastEx.prescribed?.reps) || parseReps(lastEx.sets?.[0]?.reps) || DEFAULT_REPS;
  const baseReps = prevRange?.baseReps ?? programmeReps;
  const heldReps = prevRange?.reps ?? programmeReps;

  let repsOut = heldReps;
  let repRangeChanged = false;
  let rungs = 1;

  if (movement.decision === "ADD") {
    if (heldReps > baseReps) {
      // Raised target met: bank it as weight, reps back to base, single rung.
      repsOut = baseReps;
      repRangeChanged = true;
      rationale.push("rep_climb_banked");
    } else {
      rungs = climbRungs({
        consecutiveAdds: liftState.consecutiveAdds ?? 0,
        rir,
        addThresholdRir,
        step: STEP_SIZES[category] ?? 0,
        currentWeight: lastWeight ?? 0,
      });
      if (rungs === 2) rationale.push("climbing_double_rung");
    }
  } else if (movement.decision === "HOLD") {
    const climbed = repClimb({ stallSignal: liftState.stallSignal ?? null, baseReps, currentReps: heldReps });
    if (climbed.changed) {
      repsOut = climbed.reps;
      repRangeChanged = true;
      rationale.push(`rep_climb_to=${climbed.reps}`);
    }
  }

  const nextWeight = applyMovement(movement.decision, lastWeight, category, profile, loadType, rungs);

  // Confidence calibration
  /** @type {"low"|"moderate"|"high"} */
  let confidence = "moderate";
  if (liftState && (liftState.sessionsCount ?? 0) >= 4) confidence = "high";
  if (liftState && (liftState.sessionsCount ?? 0) <= 1) confidence = "low";
  if (rir === null) confidence = "low";

  const setsOut = prevRange?.sets ?? lastEx.prescribed?.sets ?? DEFAULT_SETS;

  return {
    weight: nextWeight,
    reps: repsOut,
    sets: setsOut,
    rir: lastEx.prescribed?.rir ?? DEFAULT_RIR,
    decision: movement.decision,
    rationale,
    confidence,
    repRangeChanged,
    // Persisted by updateLiftStateFromSession so the climb survives the session.
    repRange: { reps: repsOut, sets: setsOut, baseReps },
  };
}

// ─── Helper: derive updated lift state from a freshly finalised session ──────
// Caller computes `prescription` via computeNextPrescription, then calls this
// to get the new TS.lifts[liftName] value to persist.
//
// Usage at session finalise:
//   const prescription = computeNextPrescription({...});
//   const newState = updateLiftStateFromSession(liftState, sessionRecord, exercise, prescription);
//   TS.updateLift(profile, liftName, newState);
export function updateLiftStateFromSession(liftState, sessionRecord, exercise, prescription) {
  const profile = getLiftProfile(exercise.name);
  const sets = exercise.sets || [];
  const performed = sets.filter(s => s.weight !== null && s.weight !== undefined);
  const topSet = performed.reduce((best, s) => {
    if (!best) return s;
    return (s.est1rm || 0) > (best.est1rm || 0) ? s : best;
  }, null);

  const prevState = liftState || {
    currentWeight: null,
    nextPrescribed: null,
    e1RM: null,
    e1RMDate: null,
    sessionsCount: 0,
    sessionsSinceLastPR: 0,
    progressionProfile: profile.category,
    stallSignal: null,
    consecutiveHolds: 0,
    history: [],
    currentRepRange: null,
    repRangeHistory: [],
  };

  const sessionsCount = (prevState.sessionsCount ?? 0) + 1;
  let e1RM = prevState.e1RM;
  let e1RMDate = prevState.e1RMDate;
  let sessionsSinceLastPR = (prevState.sessionsSinceLastPR ?? 0) + 1;
  if (topSet && topSet.est1rm && (!e1RM || topSet.est1rm > e1RM)) {
    e1RM = topSet.est1rm;
    e1RMDate = sessionRecord.date;
    sessionsSinceLastPR = 0;
  }

  // Stall tracking — increment if HOLD, reset if ADD or DROP. A HOLD on a
  // COOKED session freezes the counter instead: readiness-cooked forces HOLD
  // regardless of performance, so counting it as a failed attempt lets three
  // tired sessions manufacture a stall signal — double-counting fatigue with
  // the separate cooked-accumulation deload signal. Cooked sessions already
  // don't drive progression decisions (findMostRecentLiftSession skips them);
  // they shouldn't drive stall detection either.
  let consecutiveHolds = prevState.consecutiveHolds ?? 0;
  if (prescription.decision === "HOLD") {
    if (sessionRecord.readiness !== "cooked") consecutiveHolds += 1;
  } else {
    consecutiveHolds = 0;
  }

  // Anything other than an ADD ends the run; the double rung is re-earned.
  let consecutiveAdds = prevState.consecutiveAdds ?? 0;
  if (prescription.decision === "ADD") consecutiveAdds += 1;
  else consecutiveAdds = 0;

  // Compute stallSignal — input for Phase 3, dormant in v1
  let stallSignal = null;
  if (consecutiveHolds === 2)      stallSignal = "mild";
  else if (consecutiveHolds === 3) stallSignal = "stall";
  else if (consecutiveHolds >= 4)  stallSignal = "deep_stall";

  // History — capped at last 12 sessions
  const newHistoryEntry = {
    date: sessionRecord.date,
    weight: topSet?.weight ?? null,
    effectiveLoad: topSet?.effectiveLoad ?? null,
    reps: topSet?.reps ?? null,
    rir: topSet?.rir ?? null,
    est1rm: topSet?.est1rm ?? null,
    decision: prescription.decision,
    rationale: prescription.rationale,
  };
  const history = [...(prevState.history || []), newHistoryEntry].slice(-12);

  return {
    // Carry prior state forward FIRST (deep audit 2026-07-26). This function
    // rebuilds lift state from scratch, and TS.updateLift REPLACES the lift
    // object wholesale — so any field not enumerated below was destroyed on
    // every single session.
    //
    // That silently collapsed the documented 3-session post-deload recovery
    // to 1: completeDeload sets inRecoveryUntil = RECOVERY_SESSIONS_PER_LIFT
    // and preDeloadWeight, then the first recovery session came through here,
    // lost both, and decrementRecoveryCounter read undefined → 0 → recovery
    // over. computeRecoveryPrescription's session-2/3 branch and the
    // "recovery" mesocycle tagging were unreachable code in production.
    //
    // The spread is the CLASS fix rather than naming the two casualties:
    // every key below is explicitly recomputed and overrides its prior value,
    // so this only preserves state this function has no opinion about —
    // and the next field added to LiftState survives by default instead of
    // vanishing until someone notices.
    ...prevState,
    consecutiveAdds,
    currentWeight: topSet?.weight ?? prevState.currentWeight,
    nextPrescribed: prescription.weight,
    e1RM,
    e1RMDate,
    sessionsCount,
    sessionsSinceLastPR,
    progressionProfile: profile.category,
    stallSignal,
    consecutiveHolds,
    history,
    // From the prescription, which is where a rep climb happens. Reading
    // `prevState.currentRepRange || …` pinned it to its first value forever.
    currentRepRange: prescription.repRange
      ?? prevState.currentRepRange
      ?? { reps: prescription.reps, sets: prescription.sets, baseReps: prescription.reps },
    repRangeHistory: prevState.repRangeHistory || [],
  };
}

// ─── Helper: update muscle anchor from a finalised session ────────────────────
// Tracks the best e1RM hit on any lift in the muscle group, used for cold-start
// translations. Called once per exercise at session finalise.
//
// Returns updated muscleAnchor object — caller persists via TS.updateMuscleAnchor.
export function updateMuscleAnchorFromSession(currentAnchor, sessionRecord, exercise) {
  const profile = getLiftProfile(exercise.name);
  if (!profile.primaryMuscle) return currentAnchor; // unknown muscle — skip
  if (!profile.progressesByLoad) return currentAnchor; // BW lift — doesn't anchor

  const sets = exercise.sets || [];
  const topSet = sets.reduce((best, s) => {
    if (!best) return s;
    return (s.est1rm || 0) > (best.est1rm || 0) ? s : best;
  }, null);
  if (!topSet || !topSet.est1rm) return currentAnchor;

  // Translate this lift's e1RM to anchor-equivalent e1RM via inverse factor
  // e.g., goblet squat at 30kg with factor 0.35 → equivalent back squat ≈ 30/0.35 ≈ 86kg
  const factor = profile.factor || 1;
  if (factor === 0) return currentAnchor;
  const anchorEquivalentE1RM = topSet.est1rm / factor;

  const prev = currentAnchor || {
    bestE1RM: null,
    bestE1RMLift: null,
    bestE1RMDate: null,
    recentTopSets: [],
  };

  let bestE1RM = prev.bestE1RM;
  let bestE1RMLift = prev.bestE1RMLift;
  let bestE1RMDate = prev.bestE1RMDate;
  if (!bestE1RM || anchorEquivalentE1RM > bestE1RM) {
    bestE1RM = Math.round(anchorEquivalentE1RM * 10) / 10;
    bestE1RMLift = exercise.name;
    bestE1RMDate = sessionRecord.date;
  }

  // Append to rolling window (last 6)
  const recentTopSets = [
    ...(prev.recentTopSets || []),
    {
      date: sessionRecord.date,
      lift: exercise.name,
      weight: topSet.weight,
      reps: topSet.reps,
      effectiveLoad: topSet.effectiveLoad,
      est1rm: topSet.est1rm,
      anchorEquivalentE1RM: Math.round(anchorEquivalentE1RM * 10) / 10,
    },
  ].slice(-6);

  return {
    bestE1RM,
    bestE1RMLift,
    bestE1RMDate,
    recentTopSets,
  };
}

// ─── Reconcile liftState with what was actually performed ─────────────────────
// Returns a new liftState with currentWeight overwritten to the top-set weight
// just performed in this session's exercise. Used by the finalise pipeline to
// ensure the progression engine reasons from what the user actually lifted,
// not from a stale seed (programme default, or an old in-session adjustment
// that was further dialled down).
//
// Pure function. Returns the input untouched when nothing was performed
// (e.g. all-bodyweight sets with no fallback). Returns null if liftState
// is null (caller should leave it alone in that case).
export function reconcileLiftStateWithSession(liftState, exercise) {
  if (!liftState) return liftState;
  const sets = exercise?.sets || [];
  const loads = sets
    .map(s => s.effectiveLoad ?? s.weight ?? 0)
    .filter(l => l > 0);
  if (loads.length === 0) return liftState; // nothing loaded to reconcile from
  const performedTopSet = Math.max(...loads);
  if (performedTopSet === liftState.currentWeight) return liftState;
  return { ...liftState, currentWeight: performedTopSet };
}

// ─── Is this session the newest evidence for a lift? ──────────────────────────
// H.append sorts by id, so a retrospective record dated before an existing
// live session inserts BEHIND it. Prescriptions stay correct (the engine
// always reasons from the most recent session in history), but the state
// writers — reconcile, updateLiftStateFromSession, anchor updates — assume
// their session is the newest and would regress currentWeight to the old
// top set and misorder the per-lift history window. Callers gate those
// writers on this check; a session that isn't the latest evidence for a
// lift contributes its record to history and nothing to lift state.
export function isLatestSessionForLift(history, sessionId, liftName) {
  if (!sessionId) return true;
  return !(history || []).some(r =>
    r && r.id && r.id > sessionId &&
    r.travel !== true &&                 // travel is never newer LOAD evidence
    (r.blocks || []).some(b => (b.exercises || []).some(e => e?.name === liftName))
  );
}

// Test exports
export const __test__ = {
  evaluatePerformance,
  topSetRir,
  topSetWeight,
  decideMovement,
  applyMovement,
  findMostRecentLiftSession,
  parseReps,
};

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 3 — Signal-driven deload
// ═════════════════════════════════════════════════════════════════════════════
//
// Three pure functions:
//
//   detectDeloadSignals(trainingState, history)
//     → returns array of active signal types. Empty = no offer.
//     Read at home-screen render to decide if the deload card shows.
//
//   computeDeloadPrescription(liftName, liftState, context)
//     → returns scaled-down prescription (65%/70%/skip) for active deload mode.
//     Replaces the standard accumulation prescription while activeDeload is set.
//
//   computeRecoveryPrescription(liftName, liftState, context)
//     → returns rebuild prescription (deloaded × 1.10) for first 3 sessions
//     after a deload completes. Per-lift, transparent to user.
//
// Plus three helpers for state transitions:
//
//   shouldOfferDeload(trainingState, history)         — wraps detect + cooldown checks
//   startDeload(trainingState, signals, weights)      — sets activeDeload, returns new state
//   completeDeload(trainingState)                     — clears activeDeload, flips lifts to recovery
//
// All pure functions. No I/O. ForgeApp calls these and persists results via TS.

// ─── Constants — thresholds for detection ─────────────────────────────────────
const DELOAD_COOLDOWN_MS              = 14 * 24 * 60 * 60 * 1000; // 14 days after completion
const DISMISS_COOLDOWN_MS             = 5  * 24 * 60 * 60 * 1000; // 5 days after dismissal
const COOKED_LOOKBACK_MS              = 14 * 24 * 60 * 60 * 1000; // 14-day window for cooked accumulation
const COOKED_THRESHOLD                = 3;                        // 3 cooked sessions in window
const STALL_CONVERGENCE_MIN_LIFTS     = 2;                        // 2+ lifts in stall
const REGRESSION_CONSECUTIVE_DROPS    = 2;                        // 2 consecutive e1RM drops on same lift

const DELOAD_DEFAULT_DAYS             = 5;
const DELOAD_AUTO_CLOSE_MIN_DAYS      = 4;                        // session ≥ 4 calendar days after start auto-closes
// (a MAX_DAYS=10 "idle" constant lived here, dead: any session >10 days
// idle is necessarily ≥4 days after start, so MIN already closes it — #35)

const DELOAD_INTENSITY_MAIN           = 0.65;                     // 65% of currentWeight on main lifts
const DELOAD_INTENSITY_ACCESSORY      = 0.70;                     // 70% on accessories
const DELOAD_INTENSITY_POWER          = 0.60;                     // 60% on power lifts (more conservative)
const DELOAD_RIR_TARGET               = 4;                        // nowhere near failure

const RECOVERY_SESSIONS_PER_LIFT      = 3;                        // 3 rebuild sessions per lift
const RECOVERY_REENTRY_MULTIPLIER     = 0.90;                     // re-enter at pre-deload × 0.90
const RECOVERY_REBUILD_MULTIPLIER     = 1.10;                     // fallback only: deloaded × 1.10 when no pre-deload snapshot exists

// ─── detectDeloadSignals ──────────────────────────────────────────────────────
// Pure: returns the list of active signal types based on training state + history.
// Empty array means no offer should surface.
//
// Note: cooldowns are NOT checked here. Use shouldOfferDeload() for the full
// "should the card appear right now" check.
export function detectDeloadSignals(trainingState, history) {
  const signals = [];

  if (!trainingState) return signals;

  // Signal 1 — Stall convergence (2+ lifts at "stall" or higher)
  const stallSeverityRank = { mild: 1, stall: 2, deep_stall: 3 };
  const stalledLifts = Object.entries(trainingState.lifts || {})
    .filter(([_, st]) => stallSeverityRank[st?.stallSignal] >= 2) // "stall" or "deep_stall"
    .map(([name]) => name);

  if (stalledLifts.length >= STALL_CONVERGENCE_MIN_LIFTS) {
    signals.push({ type: "stall_convergence", lifts: stalledLifts });
  }

  // Signal 2 — Single-lift deep stall
  const deepStalls = Object.entries(trainingState.lifts || {})
    .filter(([_, st]) => st?.stallSignal === "deep_stall")
    .map(([name]) => name);

  if (deepStalls.length > 0 && !signals.find(s => s.type === "stall_convergence")) {
    signals.push({ type: "deep_stall", lifts: deepStalls });
  }

  // Signal 3 — Cooked accumulation (3 cooked sessions in last 14 days)
  if (history && history.length) {
    const now = Date.now();
    const lookbackStart = now - COOKED_LOOKBACK_MS;
    const recentCooked = history.filter(rec => {
      if (rec.readiness !== "cooked") return false;
      const t = new Date(rec.id || rec.date).getTime();
      return t >= lookbackStart;
    });
    if (recentCooked.length >= COOKED_THRESHOLD) {
      signals.push({ type: "cooked_accumulation", count: recentCooked.length });
    }
  }

  // Signal 4 — Regression on a lift (2 consecutive e1RM drops, same lift)
  for (const [name, st] of Object.entries(trainingState.lifts || {})) {
    const lh = st?.history || [];
    if (lh.length < 3) continue;
    const last3 = lh.slice(-3);
    // We need 3 sessions to detect 2 consecutive drops between them
    const drops = [];
    for (let i = 1; i < last3.length; i++) {
      const prev = last3[i - 1].est1rm;
      const curr = last3[i].est1rm;
      if (prev != null && curr != null && curr < prev) drops.push(true);
      else drops.push(false);
    }
    if (drops.length === 2 && drops.every(Boolean)) {
      signals.push({ type: "regression", lift: name });
    }
  }

  return signals;
}

// ─── shouldOfferDeload ────────────────────────────────────────────────────────
// Combines signal detection with cooldown logic. Returns null if no offer
// should surface, else returns the signal object that triggered.
//
// Cooldown rules:
//   - If activeDeload is set → no new offer (already in deload)
//   - If lastDeloadCompletedAt is within 14 days → no offer (too soon)
//   - If lastOfferDismissedAt is within 5 days → no offer (don't nag)
export function shouldOfferDeload(trainingState, history) {
  if (!trainingState?.mesocycle) return null;
  if (trainingState.mesocycle.activeDeload) return null;

  const now = Date.now();
  const lastCompleted = trainingState.mesocycle.deloadSignals?.lastDeloadCompletedAt;
  if (lastCompleted) {
    const sinceCompleted = now - new Date(lastCompleted).getTime();
    if (sinceCompleted < DELOAD_COOLDOWN_MS) return null;
  }

  const lastDismissed = trainingState.mesocycle.deloadSignals?.lastOfferDismissedAt;
  if (lastDismissed) {
    const sinceDismissed = now - new Date(lastDismissed).getTime();
    if (sinceDismissed < DISMISS_COOLDOWN_MS) return null;
  }

  const signals = detectDeloadSignals(trainingState, history);
  if (signals.length === 0) return null;

  // Return the highest-priority signal
  const priority = ["regression", "deep_stall", "stall_convergence", "cooked_accumulation"];
  for (const p of priority) {
    const found = signals.find(s => s.type === p);
    if (found) return found;
  }
  return signals[0];
}

// ─── computeDeloadPrescription ────────────────────────────────────────────────
// Returns the deload-mode prescription for a single lift. Used during active
// deload window — replaces standard accumulation logic.
export function computeDeloadPrescription(liftName, liftState, context = {}) {
  const profile = getLiftProfile(liftName);
  const currentWeight = liftState?.currentWeight ?? context.currentWeight ?? null;

  // BW progression lifts: reduce reps to 50%, no weight scaling
  if (!profile.progressesByLoad) {
    const baseReps = liftState?.currentRepRange?.reps ?? DEFAULT_REPS;
    return {
      weight: null,
      reps: Math.max(3, Math.floor(baseReps * 0.5)),
      sets: 2,
      rir: DELOAD_RIR_TARGET,
      decision: "DELOAD",
      rationale: ["bw_deload_reduced_reps"],
      confidence: "high",
      mesocyclePhase: "deload",
      repRangeChanged: false,
    };
  }

  // Loaded lifts — apply category-specific intensity multiplier
  let multiplier = DELOAD_INTENSITY_ACCESSORY;
  if (profile.category === "lower_compound" || profile.category === "upper_push" || profile.category === "upper_pull") {
    multiplier = DELOAD_INTENSITY_MAIN;
  } else if (profile.category === "power") {
    multiplier = DELOAD_INTENSITY_POWER;
  }

  const deloadedWeight = currentWeight !== null
    ? roundToCategoryIncrement(currentWeight * multiplier, profile.category)
    : null;

  // Sets: main lifts → 2 (down from 3), accessories → 2, power → 3 of 3 (down from 5 of 3)
  let sets = 2;
  if (profile.category === "power") sets = 3;

  // Reps: keep prescribed rep range from current state (or sensible default)
  const reps = liftState?.currentRepRange?.reps ?? DEFAULT_REPS;

  return {
    weight: deloadedWeight,
    reps,
    sets,
    rir: DELOAD_RIR_TARGET,
    decision: "DELOAD",
    rationale: [`deload_${profile.category}_${Math.round(multiplier * 100)}pct`],
    confidence: "high",
    mesocyclePhase: "deload",
    repRangeChanged: false,
  };
}

// ─── computeRecoveryPrescription ──────────────────────────────────────────────
// Returns the rebuild prescription for a lift in active recovery (first 3
// sessions after deload completes). Session 1 re-enters at preDeloadWeight
// × 0.90; standard ADD/HOLD/DROP logic takes over from there, climbing back
// to (and past) pre-deload within a session or two of the recovery window.
//
// WARNING: the re-entry MUST anchor to preDeloadWeight, not currentWeight.
// By recovery time currentWeight holds the DELOADED load (each deload
// session reconciles it down to the performed 65–70%), so multiplying it
// re-enters at ~72% of pre-deload and step-based ADDs need ~10 weeks to
// claw back what the deload cost. And for a user who RESTED through the
// deload, currentWeight is still pre-deload, so a rebuild multiplier >1
// forces a jump ABOVE pre-deload right after a week off. The snapshot in
// completeDeload exists precisely for this anchor. currentWeight × 1.10
// survives only as the fallback for legacy states with no snapshot.
export function computeRecoveryPrescription(liftName, liftState, history, context = {}) {
  const profile = getLiftProfile(liftName);

  // First recovery session: re-enter from the pre-deload snapshot.
  // Subsequent recovery sessions: standard accumulation logic, just tagged "recovery"
  // We detect "first" as inRecoveryUntil === RECOVERY_SESSIONS_PER_LIFT (no recovery sessions completed yet)
  const firstRecoverySession = liftState?.inRecoveryUntil === RECOVERY_SESSIONS_PER_LIFT;

  if (firstRecoverySession) {
    if (!profile.progressesByLoad) {
      // BW lift returning from deload — just use last session's reps as-is
      const lastSession = findMostRecentLiftSession(history, liftName, { includeCooked: true });
      const baseReps = lastSession?.exercise?.sets?.[0]?.reps
        ? parseReps(lastSession.exercise.sets[0].reps)
        : DEFAULT_REPS;
      return {
        weight: null,
        reps: baseReps,
        sets: liftState?.currentRepRange?.sets ?? DEFAULT_SETS,
        rir: DEFAULT_RIR,
        decision: "RECOVERY",
        rationale: ["recovery_session_1_bw"],
        confidence: "moderate",
        mesocyclePhase: "recovery",
        repRangeChanged: false,
      };
    }

    const preDeload = liftState?.preDeloadWeight ?? null;
    const rebuildWeight = preDeload !== null
      ? roundToCategoryIncrement(preDeload * RECOVERY_REENTRY_MULTIPLIER, profile.category)
      : roundToCategoryIncrement(
          (liftState?.currentWeight ?? context.currentWeight ?? 0) * RECOVERY_REBUILD_MULTIPLIER,
          profile.category,
        );

    return {
      weight: rebuildWeight,
      reps: liftState?.currentRepRange?.reps ?? DEFAULT_REPS,
      sets: liftState?.currentRepRange?.sets ?? DEFAULT_SETS,
      rir: DEFAULT_RIR,
      decision: "RECOVERY",
      rationale: [preDeload !== null ? "recovery_session_1_reentry_90pct_predeload" : "recovery_session_1_rebuild_no_snapshot"],
      confidence: "moderate",
      mesocyclePhase: "recovery",
      repRangeChanged: false,
    };
  }

  // Recovery session 2 or 3 — standard accumulation logic, tagged as recovery
  const standard = computeNextPrescription({
    liftName,
    history,
    liftState,
    muscleAnchor: null,
    context,
  });
  return {
    ...standard,
    rationale: [...standard.rationale, "in_recovery_phase"],
    mesocyclePhase: "recovery",
  };
}

// ─── State transition helpers ─────────────────────────────────────────────────
// Pure functions that return new training state. ForgeApp persists via TS.save.

// Capture pre-deload weights snapshot from current lift states.
function snapshotPreDeloadWeights(trainingState) {
  const snapshot = {};
  for (const [name, st] of Object.entries(trainingState.lifts || {})) {
    if (st?.currentWeight != null) snapshot[name] = st.currentWeight;
  }
  return snapshot;
}

// Start a deload — sets activeDeload, snapshots pre-deload weights.
// Returns NEW trainingState (don't mutate the input).
export function startDeload(trainingState, signal) {
  const startedAt = new Date().toISOString();
  const triggeredLifts = signal?.lifts || (signal?.lift ? [signal.lift] : []);
  const preDeloadWeights = snapshotPreDeloadWeights(trainingState);

  return {
    ...trainingState,
    mesocycle: {
      ...trainingState.mesocycle,
      currentPhase: "deload",
      activeDeload: {
        startedAt,
        plannedDays: DELOAD_DEFAULT_DAYS,
        triggeredBy: signal?.type || "unknown",
        triggeredLifts,
        preDeloadWeights,
      },
      deloadSignals: {
        ...(trainingState.mesocycle?.deloadSignals || {}),
        active: [signal?.type].filter(Boolean),
        history: [
          ...(trainingState.mesocycle?.deloadSignals?.history || []),
          { event: "deload_started", at: startedAt, signal: signal?.type, lifts: triggeredLifts },
        ].slice(-20),
        lastOfferDismissedAt: null, // clear any prior dismissal
      },
    },
  };
}

// Complete a deload — clears activeDeload, flips all lifts to recovery for N sessions.
// Returns NEW trainingState. Per-lift `inRecoveryUntil` and `preDeloadWeight` set so
// the recovery prescription engine knows where to rebuild from.
export function completeDeload(trainingState) {
  const completedAt = new Date().toISOString();
  const preDeload = trainingState.mesocycle?.activeDeload?.preDeloadWeights || {};

  // Each lift gets inRecoveryUntil counter set, plus preDeloadWeight stored
  const newLifts = {};
  for (const [name, st] of Object.entries(trainingState.lifts || {})) {
    newLifts[name] = {
      ...st,
      inRecoveryUntil: RECOVERY_SESSIONS_PER_LIFT,
      preDeloadWeight: preDeload[name] ?? st.currentWeight,
    };
  }

  return {
    ...trainingState,
    lifts: newLifts,
    mesocycle: {
      ...trainingState.mesocycle,
      currentPhase: "recovery",
      activeDeload: null,
      deloadSignals: {
        ...(trainingState.mesocycle?.deloadSignals || {}),
        active: [],
        lastDeloadCompletedAt: completedAt,
        history: [
          ...(trainingState.mesocycle?.deloadSignals?.history || []),
          { event: "deload_completed", at: completedAt },
        ].slice(-20),
      },
    },
  };
}

// Mark a deload offer dismissed — sets the 5-day cooldown.
export function dismissDeloadOffer(trainingState) {
  return {
    ...trainingState,
    mesocycle: {
      ...trainingState.mesocycle,
      deloadSignals: {
        ...(trainingState.mesocycle?.deloadSignals || {}),
        lastOfferDismissedAt: new Date().toISOString(),
      },
    },
  };
}

// Decrement a single lift's recovery counter (call on session finalise for each
// lift that was logged). Returns the updated lift state. When counter hits 0
// the lift is back to accumulation — preDeloadWeight is cleared as a signal
// of "no longer in recovery."
export function decrementRecoveryCounter(liftState) {
  if (!liftState) return liftState;
  const next = (liftState.inRecoveryUntil ?? 0) - 1;
  return {
    ...liftState,
    inRecoveryUntil: Math.max(0, next),
    preDeloadWeight: next > 0 ? liftState.preDeloadWeight : null,
  };
}

// Check if active deload should auto-complete based on elapsed time + new session.
// Returns true if the next session crosses the auto-close threshold.
//
// Wall-clock days, NOT session count, deliberately: a deload is a recovery
// WINDOW — its physiological purpose (dissipating accumulated fatigue) is
// time-based, and it completes whether or not the user trains through it.
// Counting sessions would punish exactly the users a deload serves: someone
// who rests fully during the week would stay "in deload" indefinitely, and
// someone who takes a 5-day break mid-deload auto-closes on return — which
// is correct, because the break itself did the recovering.
export function shouldAutoCompleteDeload(trainingState, sessionDate) {
  const active = trainingState?.mesocycle?.activeDeload;
  if (!active) return false;

  // CALENDAR days, local clock (audit #35): startedAt is a full ISO instant
  // while sessionDate is a local "YYYY-MM-DD" — the old math parsed the
  // latter as UTC midnight (the exact pattern lib/dates bans) and compared
  // it to the instant, skewing the window by up to a day either way.
  const startedDay = parseLocalDate(localDateStr(new Date(active.startedAt)));
  const sessionDay = parseLocalDate(sessionDate || todayLocalIso());
  if (!startedDay || !sessionDay) return false;
  const daysElapsed = Math.round((sessionDay.getTime() - startedDay.getTime()) / 86400000);

  // Auto-close when the next session lands ≥ 4 calendar days after start.
  return daysElapsed >= DELOAD_AUTO_CLOSE_MIN_DAYS;
}

// ─── Generate deload card copy from a signal ──────────────────────────────────
// Returns { kicker, headline, body } for the home-screen card.
// Modern London English — direct, no jargon.
export function deloadCardCopy(signal) {
  if (!signal) return null;
  const t = signal.type;

  if (t === "stall_convergence") {
    const lifts = (signal.lifts || []).slice(0, 2).join(" and ").toLowerCase();
    return {
      kicker: "Deload",
      headline: "Your body's asking for a reset.",
      body: `${lifts} have both held for several sessions. A short deload — lighter loads, less volume, five days — and you'll come back stronger.`,
    };
  }

  if (t === "deep_stall") {
    const lift = (signal.lifts?.[0] || "your lift").toLowerCase();
    return {
      kicker: "Deload",
      headline: `${lift.charAt(0).toUpperCase() + lift.slice(1)} has stalled.`,
      body: "Four sessions running, no movement. A short structured reset, then we rebuild — properly.",
    };
  }

  if (t === "cooked_accumulation") {
    return {
      kicker: "Deload",
      headline: "You've been training tired.",
      body: `Three cooked sessions in two weeks is a sign. A controlled deload now means stronger weeks ahead.`,
    };
  }

  if (t === "regression") {
    const lift = (signal.lift || "your lift").toLowerCase();
    return {
      kicker: "Deload",
      headline: `${lift.charAt(0).toUpperCase() + lift.slice(1)} is slipping.`,
      body: "Two sessions of regression in a row. A short reset, then we rebuild properly.",
    };
  }

  return {
    kicker: "Deload",
    headline: "Your body's asking for a reset.",
    body: "Five days of lighter loads and reduced volume. You'll come back stronger.",
  };
}

// ─── Format active-deload subtitle for session screen ─────────────────────────
// Returns "deload · day N of M" or null if not in active deload.
export function deloadDayLabel(activeDeload) {
  if (!activeDeload) return null;
  // Same calendar-day basis as shouldAutoCompleteDeload (#35).
  const startedDay = parseLocalDate(localDateStr(new Date(activeDeload.startedAt)));
  const todayDay = parseLocalDate(todayLocalIso());
  if (!startedDay || !todayDay) return null;
  const daysElapsed = Math.round((todayDay.getTime() - startedDay.getTime()) / 86400000);
  const day = Math.min(daysElapsed + 1, activeDeload.plannedDays);
  return `deload · day ${day} of ${activeDeload.plannedDays}`;
}

// Test exports for Phase 3
export const __test_p3__ = {
  detectDeloadSignals,
  shouldOfferDeload,
  computeDeloadPrescription,
  computeRecoveryPrescription,
  startDeload,
  completeDeload,
  dismissDeloadOffer,
  decrementRecoveryCounter,
  shouldAutoCompleteDeload,
  deloadCardCopy,
  deloadDayLabel,
  DELOAD_DEFAULT_DAYS,
  RECOVERY_SESSIONS_PER_LIFT,
};
