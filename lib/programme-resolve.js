// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/programme-resolve.js
// ─────────────────────────────────────────────────────────────────────────────
// The programme as the app composes it (rotation → main lifts → focus), each
// lift's plan weight (planStartWeight) and rep target. Shared by the MCP
// tools, the trainer validator, the trainer plan and the device applier.
//
// Pure, and imports nothing from storage, the MCP server, the database or
// net, so the trainer pane can bundle it (tests/trainer-bundle.test.js).
// lib/storage.js and lib/mcp-server.js re-export these under their old paths.
// ─────────────────────────────────────────────────────────────────────────────

import {
  SESSIONS, EXERCISE_POOLS, SWAP_DB, MAIN_LIFT_FUNCTIONAL_EQUIVALENTS, RETIRED_LOAD_TYPES, FORMER_LOAD_TYPES, isValidMainLiftChoice, mainLiftOptions,
  applyRotationToSession, applyMainLiftsToSession, applyFocusToSession,
} from "./programme.js";
import { getLiftProfile, getLoadType, isBodyweightMovement, parseTimedReps, swapLoadType, startWeightFor, deriveMuscleAnchors, sanitiseWorkingWeights, snapToImplement, STEP_SIZES } from "./lift-translations.js";
import { repTargetRepairs, scheduledWeight, deloadBaseWeight, deloadAsOf, deloadSetsFor } from "./progression.js";

// ─── BW-percentage starting weights for the 5 main lifts ─────────────────────
// Replaces the hardcoded SESSIONS defaults for first-session prescription.
// Multipliers are coaching-norm intermediate-novice floors (Israetel/Helms),
// rounded to the nearest 2.5kg. Barbell lifts are floored at 20kg (empty bar).
//
// Returns null when bodyweight isn't captured — caller falls back to the
// programme.js SESSIONS default for that lift.
export const MAIN_LIFT_BW_MULTIPLIERS = {
  "Hex Bar Deadlift":       1.00,
  "Barbell Back Squat":     0.75,
  "Barbell Bench Press":    0.65,
  "Barbell Overhead Press": 0.40,
  "Power Clean":            0.50,
};

// Round to the nearest 2.5kg — standard plate-loadable increment.
export function roundToHalfPlate(kg) {
  return Math.round(kg / 2.5) * 2.5;
}

// A main lift swapped to one of its listed equivalents starts from the slot
// default's multiplier scaled by the engine's translation factor for the pair
// (lib/lift-translations.js PROFILES, the factor cold start and the muscle
// anchor already use), so a new user who picks Front Squat meets a number,
// not an empty drum. Push Press fills two slots and takes the lower start.
// No start for Weighted Dips (its kg is optional added load) or for a lift
// with no factor in PROFILES: those keep the template's.
/**
 * @param {string | null | undefined} liftName
 * @returns {{ slot: string, ratio: number, multiplier: number, loadType: string } | null}
 */
export function mainLiftStartBasis(liftName) {
  if (!liftName) return null;
  const own = MAIN_LIFT_BW_MULTIPLIERS[liftName];
  if (own) return { slot: liftName, ratio: 1, multiplier: own, loadType: "barbell" };
  /** @type {{ slot: string, ratio: number, multiplier: number, loadType: string } | null} */
  let best = null;
  for (const [slot, alts] of Object.entries(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS)) {
    if (!alts.includes(liftName)) continue;
    const option = (SWAP_DB[slot] || []).find((o) => o.name === liftName);
    const loadType = swapLoadType(option);
    if (isBodyweightMovement(loadType)) continue;
    const from = getLiftProfile(slot).factor;
    const to = getLiftProfile(liftName).factor;
    if (!(from > 0) || !(to > 0)) continue;
    const ratio = to / from;
    const multiplier = MAIN_LIFT_BW_MULTIPLIERS[slot] * ratio;
    if (!best || multiplier < best.multiplier) best = { slot, ratio, multiplier, loadType };
  }
  return best;
}

/**
 * The bodyweight-derived first weight. The five defaults always get one. An
 * enumerated equivalent gets one only where it carries no template weight of
 * its own (a swapped main lift); as a pool accessory or a session swap it
 * keeps the programme's template, which the caller falls through to.
 * @param {string} liftName
 * @param {number | null | undefined} bodyweightKg
 * @param {number | null | undefined} [templateWeight]  the exercise's own weight, if any
 */
export function startingWeightForLift(liftName, bodyweightKg, templateWeight = null) {
  if (!liftName) return null;
  if (bodyweightKg === null || bodyweightKg === undefined) return null;
  const mult = MAIN_LIFT_BW_MULTIPLIERS[liftName];
  if (mult) {
    const raw = bodyweightKg * mult;
    const rounded = roundToHalfPlate(raw);
    // Empty-bar floor on barbell lifts — all five mains here are barbell.
    return Math.max(20, rounded);
  }
  if (templateWeight != null) return null;
  const basis = mainLiftStartBasis(liftName);
  if (!basis) return null;
  // The start must sit on the 1.25 kg drum of a swapped main (loadType
  // name-inferred) and on the implement's own grid. 2.5 kg covers plates and
  // pin stacks; a per-dumbbell weight steps 5 kg, the smallest step on both
  // the 1 kg and the 1.25 kg grid. Floor: the empty bar on a barbell, one
  // step otherwise.
  const step = basis.loadType === "per_db" ? 5 : 2.5;
  const rounded = Math.round((bodyweightKg * basis.multiplier) / step) * step;
  return Math.max(basis.loadType === "barbell" ? 20 : step, rounded);
}

/**
 * startWeightFor (lib/lift-translations.js) with its bodyweight rung wired to
 * startingWeightForLift. Every plan weight resolves through this.
 * @param {Parameters<typeof startWeightFor>[0]} ex
 * @param {Omit<NonNullable<Parameters<typeof startWeightFor>[1]>, "bodyweightStart">} [opts]
 */
export function planStartWeight(ex, opts = {}) {
  return startWeightFor(ex, { ...opts, bodyweightStart: startingWeightForLift });
}

// The engine reasons in plain numbers; the session keeps the template's
// shape. "8/leg" climbs to "9/leg"; timed targets ("20s") never climb.
// Here rather than in lib/session-engine.js, which imports storage, so the
// trainer pane can bundle it.
/**
 * @param {unknown} reps
 * @param {unknown} shape
 */
export function repsForSession(reps, shape) {
  if (typeof reps !== "number" || !(reps > 0)) return null;
  const s = typeof shape === "string" ? shape : "";
  if (/s$/.test(s)) return null;
  const leg = s.match(/\/leg$/);
  return leg ? `${reps}/leg` : reps;
}

/**
 * A deload day's set counts, from scheduledPlan: `day` while the deload
 * runs; `lifts` a lift's own rule, a target count (a lift the deload scales
 * by load: its deload sets, deloadSetsFor) or `true` (a bodyweight or
 * assisted lift after a hard last session: one set fewer, never below 2).
 * @typedef {{ day: boolean, lifts: Record<string, number | true> }} DeloadSets
 */

/** @type {DeloadSets} */
export const NO_DELOAD_SETS = Object.freeze({ day: false, lifts: Object.freeze({}) });

/**
 * Whether the deload scales a lift by load (its weight deloads, and its sets
 * take the deload count).
 * @param {string} name
 * @param {string|null|undefined} loadType
 */
function deloadsByLoad(name, loadType) {
  return getLiftProfile(name).progressesByLoad && loadType !== "assisted_bodyweight" && loadType !== "bodyweight";
}

/**
 * A lift's set count in a block of `n` sets on a deload day: its rule in
 * `sets.lifts`, else, while the deload runs, a lift it scales by load takes
 * its deload sets; never more than `n`.
 * @param {any} ex
 * @param {DeloadSets} sets
 * @param {number} n
 */
function deloadLiftSets(ex, sets, n) {
  const rule = Object.hasOwn(sets.lifts, ex.name) ? sets.lifts[ex.name] : null;
  if (rule === true) return n > 2 ? n - 1 : n;
  if (typeof rule === "number") return Math.min(rule, n);
  if (!sets.day) return n;
  if (deloadsByLoad(ex.name, ex.loadType ?? loadTypeOfName(ex.name))) return Math.min(deloadSetsFor(ex.name), n);
  // A bodyweight or assisted lift keeps its reps and loses one set (never below 2).
  return n > 2 ? n - 1 : n;
}

/**
 * A session with each block at its deload day's set count: the smallest of
 * its lifts' counts (deloadLiftSets). The session as given when no block
 * changes.
 * @param {any} session
 * @param {DeloadSets} [sets]
 */
export function deloadSessionSets(session, sets = NO_DELOAD_SETS) {
  if (!session || !sets || (!sets.day && Object.keys(sets.lifts || {}).length === 0)) return session;
  const rules = { day: !!sets.day, lifts: sets.lifts || {} };
  let changed = false;
  const blocks = session.blocks.map((/** @type {any} */ b) => {
    const lifts = [b.ex, b.exA, b.exB].filter((e) => e?.name);
    if (lifts.length === 0 || !(b.sets > 0)) return b;
    const next = Math.min(b.sets, ...lifts.map((e) => deloadLiftSets(e, rules, b.sets)));
    if (next === b.sets) return b;
    changed = true;
    return { ...b, sets: next };
  });
  return changed ? { ...session, blocks } : session;
}

/**
 * The working weights a card plans from: the stored ones, with the deload
 * calendar's in their place while a deload runs and on a lift's first
 * visit after one, by the rules the finalise writes with (scheduledWeight).
 * Rep targets come back as they are: no lift deloads by reps. `sets` are
 * the deload day's set counts (DeloadSets, applied by deloadSessionSets):
 * every lift it scales by load at its deload sets, and a bodyweight or
 * assisted lift one set fewer (never below 2). Worked out on every read and never
 * written back. Only a lift with a stored weight takes one. A lift that
 * deloads by load with no base yet (first logged during the deload) keeps
 * its stored weight until its first deload session sets one. From the day
 * after the deload's window, the deload reads as the next session will close
 * it (deloadAsOf): each lift's re-entry, or, with no session inside the
 * window, each lift it scaled by load at its deload base. The inputs come
 * back as they are when nothing is due.
 * @param {{ weights?: Record<string, any>, reps?: Record<string, any>, trainingState?: any, history?: any[], todayIso?: string }} input
 * @returns {{ weights: Record<string, any>, reps: Record<string, any>, sets: DeloadSets }}
 */
export function scheduledPlan({ weights = {}, reps = {}, trainingState = null, history = [], todayIso = undefined } = {}) {
  const stored = trainingState?.mesocycle?.activeDeload || null;
  const asOf = stored ? deloadAsOf(trainingState, history, todayIso) : { trainingState, closed: null };
  const rested = asOf.closed === "rested";
  trainingState = asOf.trainingState;
  const active = asOf.closed ? null : stored;
  const lifts = trainingState?.lifts && typeof trainingState.lifts === "object" ? trainingState.lifts : {};
  /** @type {Record<string, any> | null} */
  let w = null;
  /** @type {Record<string, number | true>} */
  const setLifts = {};
  for (const [name, st] of Object.entries(lifts)) {
    if (!st || typeof st !== "object") continue;
    const loadType = loadTypeOfName(name);
    if (loadType === "bodyweight" && !active) continue;
    const scaled = getLiftProfile(name).progressesByLoad && loadType !== "assisted_bodyweight";
    const held = active && scaled && deloadBaseWeight(name, st, active) === null;
    const current = own(weights, name);
    const base = rested && scaled ? deloadBaseWeight(name, st, stored) : null;
    const due = loadType === "bodyweight" || held || !isWorkingWeight(current) ? null
      : base ?? scheduledWeight(name, st, trainingState, !!active, history, { loadType, currentWeight: current });
    if (due !== null && due !== current) (w ??= { ...weights })[name] = due;
    if (active && deloadsByLoad(name, loadType)) setLifts[name] = deloadSetsFor(name);
  }
  return { weights: w ?? weights, reps, sets: active ? { day: true, lifts: setLifts } : NO_DELOAD_SETS };
}

// A cooked day's load: 15% off the working weight. Today's plan only, like a
// drum edit: the prescription, W and every stored number stay as they are.
export const COOKED_LOAD = 0.85;

/**
 * A cooked day's card weights: each load-progressed lift with a working
 * weight opens at COOKED_LOAD of it, rounded to the lift's step and then to
 * its implement, and the person can dial it back up as normal. Bodyweight,
 * loaded-bodyweight and assisted lifts keep their number. A deload wins: on a
 * deload day nothing changes, and a lift whose scheduled weight is the deload
 * calendar's (not its working weight) keeps it. Pure; never written back.
 * @param {Record<string, any>} weights  the scheduled weights (scheduledPlan)
 * @param {{ working?: Record<string, any>, deload?: boolean }} [opts]
 * @returns {Record<string, any>}
 */
export function cookedWeights(weights, { working = weights, deload = false } = {}) {
  if (deload || !weights) return weights;
  /** @type {Record<string, any> | null} */
  let w = null;
  for (const [name, kg] of Object.entries(weights)) {
    if (!isWorkingWeight(kg) || kg <= 0 || kg !== own(working, name)) continue;
    const loadType = loadTypeOfName(name);
    const profile = getLiftProfile(name);
    if (!profile.progressesByLoad || isBodyweightMovement(loadType)) continue;
    const step = STEP_SIZES[/** @type {keyof typeof STEP_SIZES} */ (profile.category)] || 1.25;
    const stepped = Math.round(Math.round((kg * COOKED_LOAD) / step) * step * 100) / 100;
    (w ??= { ...weights })[name] = snapToImplement(stepped, loadType);
  }
  return w ?? weights;
}

// ─── The composed programme ─────────────────────────────────────────────────

/**
 * Main-lift choices as synced, keeping only listed equivalents. `null` when
 * the profile has never synced the field (an older app) — unknown, which is
 * not the same as "programme defaults".
 * @param {any} meta
 * @returns {Record<string, string> | null}
 */
export function validMainLifts(meta) {
  if (!meta || meta.mainLifts == null || typeof meta.mainLifts !== "object") return null;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [canonical, choice] of Object.entries(meta.mainLifts)) {
    if (typeof choice === "string" && isValidMainLiftChoice(canonical, choice)) out[canonical] = choice;
  }
  return out;
}

const own = (obj, k) => (obj && Object.hasOwn(obj, k) ? obj[k] : undefined);

// Name → load type through every door the programme has (sessions, pools,
// swaps), plus retired and former names at the type their sets were logged under;
// tests/load-type-pairings.test.js holds that each name resolves one way.
// Built once. Names outside the catalogue fall back to inference.
/** @type {Map<string, string> | null} */
let _loadTypeByName = null;
function catalogueLoadTypes() {
  if (!_loadTypeByName) {
    const m = new Map();
    const put = (ex, lt) => { if (ex?.name && !m.has(ex.name)) m.set(ex.name, lt); };
    for (const s of SESSIONS) for (const b of s.blocks || []) for (const ex of [b.ex, b.exA, b.exB]) if (ex) put(ex, getLoadType(ex));
    for (const slot of Object.values(EXERCISE_POOLS)) for (const p of slot.pool || []) put(p, getLoadType(p));
    for (const alts of Object.values(SWAP_DB)) for (const a of alts || []) put(a, swapLoadType(a));
    for (const [name, lt] of Object.entries(RETIRED_LOAD_TYPES)) put({ name }, lt);
    for (const [name, lt] of Object.entries(FORMER_LOAD_TYPES)) put({ name }, lt);
    _loadTypeByName = m;
  }
  return _loadTypeByName;
}
/** A lift name's load type: the catalogue's, else inferred from the name. */
export const loadTypeOfName = (name) => catalogueLoadTypes().get(name) ?? getLoadType({ name });
/** Whether a name is in the catalogue (sessions, pools, swaps, retired names). */
export const hasCatalogueName = (name) => catalogueLoadTypes().has(name);

/**
 * A lift's own template weight: the first session or pool entry for it that
 * carries a weight in `loadType`, or null. A weight in other load maths is
 * not this lift's start.
 * @param {string | null | undefined} name
 * @param {string | null | undefined} loadType
 * @returns {number | null}
 */
export function catalogueTemplateWeight(name, loadType) {
  if (!name) return null;
  const entries = [
    ...SESSIONS.flatMap((s) => (s.blocks || []).flatMap((b) => [b.ex, b.exA, b.exB])),
    ...Object.values(EXERCISE_POOLS).flatMap((slot) => slot.pool || []),
  ];
  const hit = entries.find((ex) => ex?.name === name && typeof ex.weight === "number" && ex.weight > 0 && getLoadType(ex) === loadType);
  return hit ? hit.weight : null;
}

export const isWorkingWeight = (w) => typeof w === "number" && Number.isFinite(w);

/** The weight the session would plan: the one resolver (planStartWeight). */
export const planWeight = (ex, weights, bw, anchors) => planStartWeight(ex, { working: weights, bodyweight: bw, anchors });

/** Each session after rotation, and after rotation → main lifts → focus. The
 * rotated stage names the main-lift key a main block answers to. */
function composeStages(meta) {
  const config = meta.programmeBlock?.config || {};
  const focus = meta.userFocus || "Forged";
  const lifts = validMainLifts(meta) || {};
  return SESSIONS.map((template) => {
    const rotated = applyRotationToSession(template, config);
    return { rotated, composed: applyFocusToSession(applyMainLiftsToSession(rotated, lifts), focus, config, lifts) };
  });
}

/** Sessions A, B and C exactly as the app composes them: rotation → main lifts → focus. */
export function composedSessions(meta) {
  return composeStages(meta).map((s) => s.composed);
}

/** Rep targets as the next session shows them: the stored ones, with any the
 * session would repair (repTargetRepairs, the same rule the app plans with).
 * Without synced lift state an adoption can't be told from a relic, so the
 * stored targets show as they are. A lift in two slots takes the first's template. */
export function repTargets(meta, sessions = composedSessions(meta)) {
  const reps = meta.reps && typeof meta.reps === "object" ? meta.reps : {};
  // No synced lift state reads as none for every lift, so the template base
  // still repairs a relic: the same answer the app gives on that device.
  const lifts = meta.trainingState?.lifts && typeof meta.trainingState.lifts === "object" ? meta.trainingState.lifts : {};
  return { ...reps, ...repTargetRepairs({ reps, lifts, sessions }) };
}

/**
 * One lift slot of the composed programme.
 * @typedef {{
 *   session: number, sessionName: string,
 *   block: string, label: string, type: string, sets: number,
 *   slot: "ex" | "exA" | "exB",
 *   name: string,
 *   canonical: string | null,
 *   loadType: string,
 *   reps: string | number,
 *   timed: boolean,
 *   w: number | null,
 *   start: number | null,
 *   ex: any,
 * }} ResolvedLift
 * canonical: the main-lift key a main slot answers to (meta.mainLifts), else null.
 * reps: the target the session shows (stored, or repaired), else the template's;
 * when `timed`, a number is seconds. w: the stored working weight, if any.
 * start: the weight the session would plan (W, else the cold start); null when
 * none resolves, and always for pure bodyweight. Its anchor rung reads the
 * anchors derived from the history passed in (deriveMuscleAnchors); without
 * one there is no anchor rung. ex: the composed exercise.
 */

/**
 * The composed sessions, each block's slots resolved.
 * @param {any} meta
 * @param {unknown} [history]  the lifter's records, for the anchor rung of each start
 */
export function resolveSessions(meta, history = []) {
  const stages = composeStages(meta);
  const reps = repTargets(meta, stages.map((s) => s.composed));
  const weights = meta.weights && typeof meta.weights === "object" ? sanitiseWorkingWeights(meta.weights) : {};
  const bw = typeof meta.bodyweight?.kg === "number" ? meta.bodyweight.kg : null;
  const anchors = deriveMuscleAnchors(history);
  return stages.map(({ rotated, composed }, session) => {
    const rotatedById = new Map((rotated.blocks || []).map((b) => [b.id, b]));
    const blocks = (composed.blocks || []).map((b) => {
      const sets = b.sets || 0;
      const keyed = b.type === "main" ? rotatedById.get(b.id)?.ex?.name : undefined;
      const canonical = typeof keyed === "string" && mainLiftOptions(keyed).length > 0 ? keyed : null;
      /** @type {Partial<Record<"ex" | "exA" | "exB", ResolvedLift>>} */
      const slots = {};
      for (const slot of /** @type {const} */ (["ex", "exA", "exB"])) {
        const ex = b[slot];
        if (!ex) continue;
        const w = own(weights, ex.name);
        const start = planWeight(ex, weights, bw, anchors);
        slots[slot] = {
          session, sessionName: composed.name,
          block: b.id, label: b.label, type: b.type, sets,
          slot, name: ex.name,
          canonical: slot === "ex" ? canonical : null,
          loadType: getLoadType(ex),
          reps: own(reps, ex.name) ?? ex.reps,
          timed: parseTimedReps(ex.reps) !== null,
          w: isWorkingWeight(w) ? w : null,
          start: typeof start === "number" && start > 0 ? start : null,
          ex,
        };
      }
      return { label: b.label, slots };
    });
    return { name: composed.name, subtitle: composed.subtitle, blocks };
  });
}

/**
 * Every lift slot the client runs, in session and block order: the programme
 * as the app composes it (rotation → main lifts → focus), with the loads and
 * targets the session would use. A lift in two slots appears twice. Shared by
 * describeProgramme, the trainer validator and the device applier.
 * @param {any} meta
 * @param {unknown} [history]  the lifter's records, for the anchor rung of each start
 * @returns {ResolvedLift[]}
 */
export function resolvedProgramme(meta, history = []) {
  const m = meta && typeof meta === "object" ? meta : {};
  return resolveSessions(m, history).flatMap((s) => s.blocks.flatMap((b) => [b.slots.ex, b.slots.exA, b.slots.exB].filter((x) => x !== undefined)));
}
