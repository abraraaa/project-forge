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
  SESSIONS, EXERCISE_POOLS, SWAP_DB, MAIN_LIFT_FUNCTIONAL_EQUIVALENTS, isValidMainLiftChoice, mainLiftOptions,
  applyRotationToSession, applyMainLiftsToSession, applyFocusToSession,
} from "./programme.js";
import { getLiftProfile, getLoadType, isBodyweightMovement, parseTimedReps, swapLoadType, startWeightFor } from "./lift-translations.js";
import { repTargetRepairs } from "./progression.js";

// ─── BW-percentage starting weights for the 5 main lifts ─────────────────────
// Replaces the hardcoded SESSIONS defaults for first-session prescription.
// Multipliers are evidence-based intermediate-novice floors (Israetel/Helms),
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
// with no factor in PROFILES (Hang Power Clean): those keep the template's.
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
// The same rule as lib/session-engine.js repsForSession, which imports
// storage; tests/trainer-bundle.test.js holds the two to one answer.
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
// swaps); tests/load-type-pairings.test.js holds that each name resolves one
// way. Built once. Names outside the catalogue fall back to inference.
/** @type {Map<string, string> | null} */
let _loadTypeByName = null;
function catalogueLoadTypes() {
  if (!_loadTypeByName) {
    const m = new Map();
    const put = (ex, lt) => { if (ex?.name && !m.has(ex.name)) m.set(ex.name, lt); };
    for (const s of SESSIONS) for (const b of s.blocks || []) for (const ex of [b.ex, b.exA, b.exB]) if (ex) put(ex, getLoadType(ex));
    for (const slot of Object.values(EXERCISE_POOLS)) for (const p of slot.pool || []) put(p, getLoadType(p));
    for (const alts of Object.values(SWAP_DB)) for (const a of alts || []) put(a, swapLoadType(a));
    _loadTypeByName = m;
  }
  return _loadTypeByName;
}
/** A lift name's load type: the catalogue's, else inferred from the name. */
export const loadTypeOfName = (name) => catalogueLoadTypes().get(name) ?? getLoadType({ name });
/** Whether a name is in the catalogue (sessions, pools, swaps). */
export const hasCatalogueName = (name) => catalogueLoadTypes().has(name);

/** The synced muscle anchors: the cold-start rung of every plan weight. */
export const muscleAnchorsOf = (meta) => {
  const a = meta.trainingState?.muscleAnchors;
  return a && typeof a === "object" && !Array.isArray(a) ? a : {};
};

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
 * none resolves, and always for pure bodyweight. ex: the composed exercise.
 */

/** The composed sessions, each block's slots resolved. */
export function resolveSessions(meta) {
  const stages = composeStages(meta);
  const reps = repTargets(meta, stages.map((s) => s.composed));
  const weights = meta.weights && typeof meta.weights === "object" ? meta.weights : {};
  const bw = typeof meta.bodyweight?.kg === "number" ? meta.bodyweight.kg : null;
  const anchors = muscleAnchorsOf(meta);
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
 * @returns {ResolvedLift[]}
 */
export function resolvedProgramme(meta) {
  const m = meta && typeof meta === "object" ? meta : {};
  return resolveSessions(m).flatMap((s) => s.blocks.flatMap((b) => [b.slots.ex, b.slots.exA, b.slots.exB].filter((x) => x !== undefined)));
}
