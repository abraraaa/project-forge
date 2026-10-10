// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/trainer-change.js
// ─────────────────────────────────────────────────────────────────────────────
// A trainer's change to a client's plan: the one validator, the status a
// change reads as, and the plan the client's device applies it by.
//
// Pure: no fetch, no localStorage, no DB. The trainer route (write and dry
// run), the trainer pane's bounds and the device applier all call this
// module, so a number the pane offers is a number the route accepts and the
// device applies. Every limit comes from the engine's own modules; none is
// copied here.
//
// The trainer never writes client data. A change waits on the server; the
// client's app re-checks it against its own latest training and applies it
// through its own stamped setters (planDeviceSteps returns what to write).
//
// No limit reads the client's body or muscle anchors, in any phase. A lift
// with no performed top set takes up to the larger of its category's
// cold-start cap and its template weight. A lift whose last top set holds a
// load the session view doesn't show (anchorLogged) is reps only.
// ─────────────────────────────────────────────────────────────────────────────

import {
  findMostRecentLiftSession, topSetWeight, MAX_JUMP_FRACTION, deloadIntensityFor,
  RECOVERY_SESSIONS_PER_LIFT, ADOPT_MIN_REPS,
} from "./progression.js";
import {
  getLiftProfile, STEP_SIZES, CATEGORY_COLD_START_MAX_KG, WORKING_WEIGHT_MAX_KG,
  snapToImplement, nextRung, weightStepForLoadType, isBodyweightMovement, getLoadType, swapLoadType, ADDED_LOAD_MAX_KG,
} from "./lift-translations.js";
import { MAIN_LIFT_FUNCTIONAL_EQUIVALENTS, isValidMainLiftChoice, timedTargetFor, WEEK, SWAP_DB, EXERCISE_POOLS } from "./programme.js";
import { EFFECTIVE_REP_BAND, recommendedReps } from "./rep-band.js";
import { isValidWeekConfig, ensureScheduleHistory, scheduleEntryOn, TYPE_LABEL } from "./sync-merge.js";
import { bandViolations } from "./rotation-solver.js";
import {
  resolvedProgramme, validMainLifts, loadTypeOfName, repsForSession, composedSessions, repTargets,
} from "./programme-resolve.js";
import { addDaysIso, mondayOfWeekIso, daysBetween, jsDow } from "./dates.js";
import { shownSetWeight } from "./trainer-view.js";

// ─── Limits ──────────────────────────────────────────────────────────────────

/** Changes in one set, at most. */
export const MAX_OPS = 16;
/** Change sets per client per rolling 7 days (the route counts them). */
export const SETS_PER_WEEK = 10;
/** How far ahead a dated change may start, in days. */
export const HORIZON_DAYS = 28;
/** The weight drum's top: the heaviest working weight the client's app stores. */
export const MAX_KG = WORKING_WEIGHT_MAX_KG;
/** Up per rolling 7 days, against the top set of a week ago. */
export const WEEK_JUMP_FRACTION = 0.15;
/** Below this share of the last top set a drop is allowed with a warning. */
export const BIG_DROP_FRACTION = 0.85;
/** A timed hold: whole seconds on the drum's bounds. */
export const TIMED_SECONDS = Object.freeze({ min: 5, max: 180, step: 5 });
/** Reps: the adoption floor to the top of the effective band. */
export const REP_LIMITS = Object.freeze({ min: ADOPT_MIN_REPS, max: EFFECTIVE_REP_BAND.max });

/** Which slices accept writes. Week changes are S2; dated lift changes S3. */
export const LIVE_SLICES = Object.freeze({ week: false, dated: false });

/** "session" is a coached session record: validateSessionSet, never validateOp. */
export const KINDS = Object.freeze(["weight", "reps", "mainLift", "week", "session"]);
/** The outcomes a device may acknowledge (trainer_changes.outcome). kept, auto_kept and discarded are a session's. */
export const OUTCOMES = Object.freeze([
  "applied", "superseded", "already_there", "deload", "limits", "replaced", "kept", "auto_kept", "discarded",
]);
/** Refusal codes that mean "not now", answered at apply by the outcome `deload`. */
export const BLOCK_CODES = Object.freeze(["deload", "recovery"]);

/** Labels a trainer may give a day, by type. Strength takes none. */
export const DAY_LABELS = Object.freeze({
  cardio: Object.freeze(["Pilates", "Spin", "Swim", "Run", "Row", "Class"]),
  zone2: Object.freeze(["Walk", "Ride", "Easy run", "Hike"]),
  hiit: Object.freeze(["Circuit", "Intervals", "Class"]),
  rest: Object.freeze(["Mobility", "Stretch", "Yoga"]),
  strength: Object.freeze([]),
});

/** "hws_" + 26 lowercase base32: minted by the trainer device, the idempotency key. */
export const SET_ID_RE = /^hws_[a-z2-7]{26}$/;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {{ kind: "weight", lift: string, kg: number, from?: string | null }
 *   | { kind: "reps", lift: string, reps: number, from?: string | null }
 *   | { kind: "mainLift", canonical: string, choice: string, from?: string | null }
 *   | { kind: "week", week: { type: string, label?: string }[], from: string }} ChangeOp
 */
/**
 * What the trainer's pane showed when the change was drafted (write phase).
 * @typedef {{
 *   lifts?: Record<string, { anchorDate: string | null, anchorKg: number | null, w: number | null, r: number | string | null }>,
 *   mains?: Record<string, string>,
 *   week?: Record<string, string[]>,
 * }} WireBasis
 */
/**
 * @typedef {{
 *   meta: any, history: any[], todayIso: string,
 *   phase?: "write" | "apply",
 *   basis?: WireBasis,
 *   mainLiftChoices?: Record<string, string>,
 * }} ChangeCtx
 * mainLiftChoices: main lifts chosen by the same set, whose lifts are then
 * eligible for weight and reps changes too (validateChangeSet fills it).
 */
/**
 * One accepted change, ready to store or preview. basis is device-only:
 * { anchorId, trainedId, w, r } for a lift, { choice } for a main lift, { weekEditedAt }
 * for a week. It never goes to the trainer.
 * @typedef {{ kind: string, target: string, before: any, after: any, from: string | null, basis: any }} Change
 */
/**
 * A stored change (trainer_changes, camelCased by rowFromDb).
 * @typedef {{
 *   id: string, set: string, kind: string, target: string,
 *   before: any, after: any, from: string | null, basis: any,
 *   at: number | null, appliedAt: string | null, outcome: string | null,
 *   undoneAt: number | null, undoneBy: string | null, revertedAt: string | null,
 *   by?: string | null, warnings?: any, deliveredAt?: string | null, editsLive?: boolean,
 * }} ChangeRow
 * deliveredAt: a session row only, when it first reached the client's device.
 */

// ─── Small helpers ───────────────────────────────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s) => typeof s === "string" && ISO_RE.test(s) && addDaysIso(s, 0) === s;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const own = (obj, k) => (obj && typeof obj === "object" && Object.hasOwn(obj, k) ? obj[k] : undefined);
const isName = (s) => typeof s === "string" && s.length > 0 && s.length <= 128;
/** A programme main lift, by own key only (a name like "constructor" is not one). */
const isMainCanonical = (c) => typeof c === "string" && Object.hasOwn(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS, c);
/** Stored values compare as the same whether a number or its string. */
const same = (a, b) => (a ?? null) === (b ?? null) || (a != null && b != null && String(a) === String(b));
/** The leading integer of a rep value: 10, "10", "10/leg" → 10. */
const repNumber = (v) => {
  if (isNum(v)) return v;
  const m = typeof v === "string" ? v.match(/^\s*(\d+)/) : null;
  return m ? parseInt(m[1], 10) : null;
};

const floorToGrid = (kg, lt) => {
  const s = weightStepForLoadType(lt);
  return Math.round(Math.floor(kg / s + 1e-9) * s * 100) / 100;
};
const ceilToGrid = (kg, lt) => {
  const s = weightStepForLoadType(lt);
  return Math.round(Math.ceil(kg / s - 1e-9) * s * 100) / 100;
};

/** Current values on the client's meta. */
const weightOf = (meta, lift) => { const w = own(meta?.weights, lift); return isNum(w) ? w : null; };
const repsOf = (meta, lift) => own(meta?.reps, lift) ?? null;
/** The choice in force for a main lift: the canonical when unset or invalid. */
export function currentMainLift(meta, canonical) {
  const c = own(meta?.mainLifts, canonical);
  return typeof c === "string" && c && isValidMainLiftChoice(canonical, c) ? c : canonical;
}

const weekLog = (meta) => ensureScheduleHistory(meta?.userWeek) || [];
/** The week in force from `iso`: the governing entry, or the default week. */
const weekOnDate = (meta, iso) => {
  const g = scheduleEntryOn(weekLog(meta), iso);
  return { entry: g, week: g ? g.week : WEEK };
};

// ─── The programme and the anchor ────────────────────────────────────────────

/**
 * The client's lifts by name (first slot wins), plus any lift a main-lift
 * choice in the same set brings in.
 * @param {any} meta
 * @param {Record<string, string> | undefined} choices
 */
function programmeLifts(meta, choices) {
  /** @type {Map<string, any>} */
  const out = new Map();
  for (const l of resolvedProgramme(meta)) if (!out.has(l.name)) out.set(l.name, l);
  if (choices && Object.keys(choices).length) {
    const next = { ...meta, mainLifts: { ...(validMainLifts(meta) || {}), ...choices } };
    for (const l of resolvedProgramme(next)) if (!out.has(l.name)) out.set(l.name, l);
  }
  return out;
}

/**
 * Whether every loaded set of a logged exercise reads as the session view
 * shows it: each set's load as the validator reads it (added kg on a
 * bodyweight movement by the programme's load type, else effectiveLoad ??
 * weight), when above 0, equals the weight the view shows for that set
 * (trainer-view.js shownSetWeight). One derived load (a body-based
 * effectiveLoad, a pure bodyweight set's stale weight or the body itself)
 * fails it, whatever its size. So does any set typed as a bodyweight
 * movement (its own type, else the exercise's) when the programme's type is
 * not one, whatever its values: its load is the body's, plus or minus. And
 * so does a set with no type of its own that carries an effectiveLoad.
 * @param {any} ex
 * @param {string | null | undefined} lt  the programme's load type
 */
function exerciseLogged(ex, lt) {
  const addedOnly = isBodyweightMovement(lt);
  return (Array.isArray(ex?.sets) ? ex.sets : []).every((s) => {
    if (!addedOnly && isBodyweightMovement(s?.loadType ?? ex?.loadType)) return false;
    // The app types every set it writes; an untyped set carrying an
    // effectiveLoad is not one of its shapes, so it reads as derived.
    if (!s?.loadType && isNum(s?.effectiveLoad)) return false;
    const read = addedOnly ? s?.weight : (s?.effectiveLoad ?? s?.weight);
    return !(isNum(read) && read > 0) || shownSetWeight(s, ex, typeof lt === "string" ? lt : null) === read;
  });
}

/**
 * The last performed top set of a lift: skips travel and cooked records and
 * unearned reach sets, and reads added kg on bodyweight movements.
 * logged: exerciseLogged over that session's sets.
 * @returns {{ id: string, date: string | null, kg: number | null, logged: boolean } | null}
 */
function anchorOf(history, lift, lt) {
  const found = findMostRecentLiftSession(Array.isArray(history) ? history : [], lift);
  if (!found) return null;
  const top = topSetWeight(found.exercise, null, lt);
  const kg = isNum(top) && top > 0 ? top : null;
  return { id: found.session?.id ?? null, date: found.session?.date ?? null, kg, logged: exerciseLogged(found.exercise, lt) };
}

/**
 * Whether a lift's last top set may be measured from: none, or one whose
 * every loaded set reads as the session view shows it (exerciseLogged). The
 * validator and the trainer's plan (lib/trainer-plan.js) share this rule: a
 * lift that fails it is reps only.
 * @param {any[]} history
 * @param {string} name
 * @param {string | null | undefined} loadType  the programme's
 */
export function anchorLogged(history, name, loadType) {
  return anchorOf(history, name, loadType ?? loadTypeOfName(name))?.logged ?? true;
}

/** Records dated a week or more before today. */
const weekAgoHistory = (history, todayIso) => {
  const cutoff = addDaysIso(todayIso, -7);
  return (Array.isArray(history) ? history : []).filter((r) => typeof r?.date === "string" && cutoff && r.date <= cutoff);
};

/**
 * The most a never-performed lift takes: the larger of its category's
 * cold-start cap and its template weight in the programme, on the
 * implement's grid. Both are public programme numbers, the same for every
 * client and in every phase. Null when the lift has neither.
 */
function firstLoadMax(name, lift, lt) {
  const p = getLiftProfile(name);
  const cap = p.progressesByLoad ? own(CATEGORY_COLD_START_MAX_KG, p.category) : undefined;
  const template = lift?.ex?.weight;
  const top = Math.max(isNum(cap) && cap > 0 ? cap : 0, isNum(template) && template > 0 ? template : 0);
  return top > 0 ? floorToGrid(top, lt) : null;
}

/** Deload or recovery session 1 blocks a weight change: the engine ignores W then. */
function blockOf(meta, lift) {
  const ts = meta?.trainingState;
  const active = ts?.mesocycle?.activeDeload;
  if (active) {
    const days = isNum(active.plannedDays) ? active.plannedDays : 0;
    const started = typeof active.startedAt === "string" ? new Date(active.startedAt) : null;
    const until = started && !Number.isNaN(started.getTime()) ? addDaysIso(started, days) : null;
    return { code: "deload", until };
  }
  if (own(ts?.lifts, lift)?.inRecoveryUntil === RECOVERY_SESSIONS_PER_LIFT) return { code: "recovery", until: null };
  return null;
}

/** Why a weight change can never apply to this lift, or null. */
function unloadable(name, lt) {
  if (lt === "bodyweight") return "bodyweight";
  if (timedTargetFor(name) !== null) return "timed";
  if (!getLiftProfile(name).progressesByLoad) return "not_by_load";
  return null;
}

/**
 * Every weight limit for a lift, computed once for both the validator and
 * the pane's bounds.
 */
function weightLimits(name, lift, ctx) {
  const lt = lift?.loadType ?? loadTypeOfName(name);
  const anchor = anchorOf(ctx.history, name, lt);
  // A top set read from a derived load is reps only, in both phases: no limit
  // is measured from a kg that moves with the client's body.
  const refuse = unloadable(name, lt) ?? (anchor && !anchor.logged ? "reps_only" : null);
  const category = getLiftProfile(name).category;
  const step = weightStepForLoadType(lt);
  const kg = anchor?.kg ?? null;
  /** @type {{ per_change: number, per_week: number } | null} */
  let up = null;
  let floor = null;
  let warnBelow = null;
  let noHistoryMax = null;
  if (kg !== null) {
    const rung = nextRung(kg, lt, +1);
    const engineStep = STEP_SIZES[category] ?? 0;
    // A week-ago top set the view withholds sets no limit: one rung that week.
    const a7 = anchorOf(weekAgoHistory(ctx.history, ctx.todayIso), name, lt);
    const withheld7 = !!a7 && a7.kg !== null && !a7.logged;
    const kg7 = a7?.kg ?? kg;
    up = {
      per_change: Math.max(rung, floorToGrid(kg + Math.max(2 * engineStep, MAX_JUMP_FRACTION * kg), lt)),
      per_week: withheld7 ? rung : Math.max(rung, floorToGrid((1 + WEEK_JUMP_FRACTION) * kg7, lt)),
    };
    floor = ceilToGrid(kg * deloadIntensityFor(category), lt);
    warnBelow = kg * BIG_DROP_FRACTION;
  } else if (isBodyweightMovement(lt)) {
    // No added load performed yet: measured from 0 added kg by the per-change rule (two engine steps, or one rung).
    noHistoryMax = Math.max(nextRung(0, lt, +1), floorToGrid(2 * (STEP_SIZES[category] ?? 0), lt));
  } else {
    // W8, in every phase: the cap or the template, whichever is larger. Neither: refused.
    noHistoryMax = firstLoadMax(name, lift, lt);
  }
  return { lt, refuse, step, anchor, up, floor, warnBelow, noHistoryMax, block: blockOf(ctx.meta, name) };
}

// ─── Basis ───────────────────────────────────────────────────────────────────

/**
 * What the trainer's pane shows for a lift and must send back unchanged:
 * the last top set and the current W and R. Never a record id.
 * @param {string} name
 * @param {ChangeCtx} ctx
 * @returns {{ anchorDate: string | null, anchorKg: number | null, w: number | null, r: number | string | null }}
 */
export function liftBasis(name, ctx) {
  const lift = programmeLifts(ctx.meta, ctx.mainLiftChoices).get(name);
  const lt = lift?.loadType ?? loadTypeOfName(name);
  const anchor = anchorOf(ctx.history, name, lt);
  return { anchorDate: anchor?.date ?? null, anchorKg: anchor?.kg ?? null, w: weightOf(ctx.meta, name), r: repsOf(ctx.meta, name) };
}

/** The 7 day types a week change is drafted against, from `from`. */
export function weekBasis(meta, from) {
  return weekOnDate(meta, from).week.map((d) => d.type);
}

/** The id of the record the device compares at apply: the last non-cooked, non-travel session of the lift. */
export function anchorIdOf(history, name) {
  return findMostRecentLiftSession(Array.isArray(history) ? history : [], name)?.session?.id ?? null;
}

/** The last session that trained the lift, cooked included (travel is not training): any newer one means they trained in between. */
export function trainedIdOf(history, name) {
  return findMostRecentLiftSession(Array.isArray(history) ? history : [], name, { includeCooked: true })?.session?.id ?? null;
}

const sameLiftBasis = (sent, server, keys) => !!sent && typeof sent === "object" && keys.every((k) => same(sent[k], server[k]));

// ─── The validator ───────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   ok: boolean, code: string | null, until?: string | null, stale: boolean,
 *   warnings: string[], change: Change | null,
 * }} OpResult
 */

/**
 * Check one change against the client's plan, history and state. The first
 * failing rule refuses (`code`); a stale basis (write phase only) is reported
 * apart, so the route can answer "refresh" rather than "refused".
 * @param {any} op
 * @param {ChangeCtx} ctx
 * @returns {OpResult}
 */
export function validateOp(op, ctx) {
  const phase = ctx.phase ?? "write";
  /** @type {OpResult} */
  const res = { ok: false, code: null, stale: false, warnings: [], change: null };
  const refuse = (code, extra = {}) => ({ ...res, ...extra, ok: false, code });
  // A session is a whole record, checked by validateSessionSet: never a week, never in a plan set.
  if (!op || typeof op !== "object" || op.kind === SESSION_KIND || !KINDS.includes(op.kind)) return refuse("kind");

  const from = op.from ?? null;
  if (op.kind !== "week" && from !== null) {
    if (!isIsoDate(from)) return refuse("shape");
    if (phase === "write") {
      if (from < ctx.todayIso || from > addDaysIso(ctx.todayIso, HORIZON_DAYS)) return refuse("from_range");
      if (!LIVE_SLICES.dated) return refuse("not_yet");
    }
  }

  if (op.kind === "weight" || op.kind === "reps") {
    if (!isName(op.lift)) return refuse("shape");
    const lifts = programmeLifts(ctx.meta, ctx.mainLiftChoices);
    const lift = lifts.get(op.lift);
    if (!lift) return refuse("not_in_programme");
    return op.kind === "weight" ? checkWeight(op, lift, from, ctx, res) : checkReps(op, lift, from, ctx, res);
  }
  if (op.kind === "mainLift") return checkMainLift(op, from, ctx, res);
  if (phase === "write" && !LIVE_SLICES.week) return refuse("not_yet");
  return checkWeek(op, ctx);
}

function checkWeight(op, lift, from, ctx, res) {
  const name = op.lift;
  const kg = op.kg;
  const L = weightLimits(name, lift, ctx);
  const refuse = (code, extra = {}) => ({ ...res, ...extra, ok: false, code });
  // W1: the lift's W is never read, the lift does not move by load, or its
  // last top set holds a load the session view doesn't show (reps only).
  // Before any rule that reads a kg.
  if (L.refuse) return refuse(L.refuse);
  // W2: the drum's range (MAX_KG, the app's sanity bound), on the implement's grid. Off-grid is refused, never snapped.
  if (!isNum(kg) || !(kg > 0) || kg > MAX_KG) return refuse("range");
  if (kg !== snapToImplement(kg, L.lt)) return refuse("off_grid");
  // W9: a deload, or recovery session 1, ignores W. Checked before the limits so it always reads as itself.
  if (L.block) return refuse(L.block.code, { until: L.block.until });
  const warnings = [];
  if (L.anchor?.kg != null) {
    // W5, W6: up from the last performed top set, per change and per 7 days.
    if (kg > L.up.per_change) return refuse("per_change");
    if (kg > L.up.per_week) return refuse("per_week");
    // W7: never below the engine's own deload load.
    if (kg < L.floor) return refuse("floor");
    if (kg < L.warnBelow) warnings.push("big_drop");
  } else if (L.noHistoryMax === null || kg > L.noHistoryMax) {
    // W8: never performed.
    return refuse("no_history");
  }
  const server = { anchorDate: L.anchor?.date ?? null, anchorKg: L.anchor?.kg ?? null, w: weightOf(ctx.meta, name) };
  // W10: what the pane showed must still hold.
  const stale = (ctx.phase ?? "write") === "write" && !sameLiftBasis(own(ctx.basis?.lifts, name), server, ["anchorDate", "anchorKg", "w"]);
  return {
    ...res, ok: !stale, stale, warnings,
    change: {
      kind: "weight", target: name, before: server.w, after: kg, from,
      basis: { anchorId: anchorIdOf(ctx.history, name), trainedId: trainedIdOf(ctx.history, name), w: server.w, r: repsOf(ctx.meta, name) },
    },
  };
}

function checkReps(op, lift, from, ctx, res) {
  const name = op.lift;
  const reps = op.reps;
  const refuse = (code) => ({ ...res, ok: false, code });
  const timed = timedTargetFor(name) !== null;
  if (!Number.isInteger(reps)) return refuse(timed ? "timed_range" : "reps_range");
  const template = lift?.ex?.reps;
  let after;
  const warnings = [];
  if (timed) {
    // R1: whole seconds on the drum, stored as an integer like a drum override.
    if (reps < TIMED_SECONDS.min || reps > TIMED_SECONDS.max || reps % TIMED_SECONDS.step !== 0) return refuse("timed_range");
    after = reps;
  } else {
    // R2: the adoption floor to the band's top, in the template's shape.
    if (reps < REP_LIMITS.min || reps > REP_LIMITS.max) return refuse("reps_range");
    after = repsForSession(reps, template) ?? reps;
    // R3: a preference, not an error.
    const rec = recommendedReps(template);
    if (rec && (reps < rec.min || reps > rec.max)) warnings.push("off_programme_reps");
    if (reps < EFFECTIVE_REP_BAND.min) warnings.push("below_rep_band");
  }
  const r = repsOf(ctx.meta, name);
  // R5
  const stale = (ctx.phase ?? "write") === "write" && !sameLiftBasis(own(ctx.basis?.lifts, name), { r }, ["r"]);
  return {
    ...res, ok: !stale, stale, warnings,
    change: {
      kind: "reps", target: name, before: r, after, from,
      basis: { anchorId: anchorIdOf(ctx.history, name), trainedId: trainedIdOf(ctx.history, name), w: weightOf(ctx.meta, name), r },
    },
  };
}

function checkMainLift(op, from, ctx, res) {
  const refuse = (code) => ({ ...res, ok: false, code });
  if (!isName(op.canonical) || !isName(op.choice)) return refuse("shape");
  // M1: a main lift, and one of its listed equivalents (or itself).
  if (!isMainCanonical(op.canonical)) return refuse("not_main");
  if (!isValidMainLiftChoice(op.canonical, op.choice)) return refuse("not_option");
  const before = currentMainLift(ctx.meta, op.canonical);
  // M2: warn when the choice puts muscles out of band that are not out now.
  const config = ctx.meta?.programmeBlock?.config || {};
  const focus = ctx.meta?.userFocus || "Forged";
  const current = validMainLifts(ctx.meta) || {};
  const now = new Set(bandViolations(config, { focus, mainLifts: current }));
  const next = bandViolations(config, { focus, mainLifts: { ...current, [op.canonical]: op.choice } });
  const warnings = next.some((m) => !now.has(m)) ? ["band"] : [];
  // M4
  const sent = own(ctx.basis?.mains, op.canonical);
  const stale = (ctx.phase ?? "write") === "write" && !same(sent, before);
  return {
    ...res, ok: !stale, stale, warnings,
    change: { kind: "mainLift", target: op.canonical, before, after: op.choice, from, basis: { choice: before } },
  };
}

/**
 * The week rules K1-K3 and K5, without the slice gate (validateOp refuses
 * week changes with `not_yet` until S2 ships). K4's volume warnings come
 * with S2.
 * @param {any} op
 * @param {ChangeCtx} ctx
 * @returns {OpResult}
 */
export function checkWeek(op, ctx) {
  const phase = ctx.phase ?? "write";
  /** @type {OpResult} */
  const res = { ok: false, code: null, stale: false, warnings: [], change: null };
  const refuse = (code) => ({ ...res, ok: false, code });
  if (!op || typeof op !== "object") return refuse("shape");
  // K1
  if (!isValidWeekConfig(op.week)) return refuse("week_shape");
  // K2: a label is the type's own, or from the fixed list.
  for (const d of op.week) {
    if (d.label === undefined || d.label === null || d.label === TYPE_LABEL[d.type]) continue;
    if (typeof d.label !== "string" || !(DAY_LABELS[d.type] || []).includes(d.label)) return refuse("label");
  }
  // K3: a Monday, from this week up to the horizon.
  const from = op.from;
  if (!isIsoDate(from) || mondayOfWeekIso(from) !== from) return refuse("from_range");
  if (phase === "write" && (from < mondayOfWeekIso(ctx.todayIso) || from > addDaysIso(ctx.todayIso, HORIZON_DAYS))) return refuse("from_range");
  const { entry, week } = weekOnDate(ctx.meta, from);
  // K5
  const sent = own(ctx.basis?.week, from);
  const stale = phase === "write" && !(Array.isArray(sent) && sent.length === 7 && sent.every((t, i) => t === week[i].type));
  const after = op.week.map((d) => (d.label && d.label !== TYPE_LABEL[d.type] ? { type: d.type, label: d.label } : { type: d.type }));
  return {
    ...res, ok: !stale, stale, warnings: [],
    change: {
      kind: "week", target: "week", before: week.map((d) => ({ type: d.type, label: d.label })), after, from,
      basis: { weekEditedAt: entry?.editedAt ?? null },
    },
  };
}

/**
 * @typedef {{
 *   ok: boolean, stale: boolean,
 *   ops: (Change & { i: number, warnings: string[] })[],
 *   refusals: { i: number | null, code: string, until?: string | null }[],
 *   warnings: { i: number, code: string }[],
 * }} SetResult
 */

/** One change per target per set: a main lift by its canonical, a weight or reps by its lift. */
const dupKey = (op) => (op?.kind === "week" ? "week"
  : op?.kind === "mainLift" ? `mainLift:${op?.canonical ?? ""}`
  : `${op?.kind}:${op?.lift ?? ""}`);

/**
 * Check a whole change set. Set-level refusals carry `i: null`.
 * @param {any} set  { id, ops }
 * @param {ChangeCtx} ctx
 * @returns {SetResult}
 */
export function validateChangeSet(set, ctx) {
  /** @type {SetResult} */
  const out = { ok: false, stale: false, ops: [], refusals: [], warnings: [] };
  const ops = set?.ops;
  if (!set || typeof set !== "object" || typeof set.id !== "string" || !SET_ID_RE.test(set.id)) {
    out.refusals.push({ i: null, code: "set_id" });
    return out;
  }
  if (!Array.isArray(ops) || ops.length < 1 || ops.length > MAX_OPS) {
    out.refusals.push({ i: null, code: "set_size" });
    return out;
  }
  // A session travels alone (validateSessionSet), never inside a plan set.
  if (ops.some((op) => op?.kind === SESSION_KIND)) {
    out.refusals.push({ i: null, code: "set_kind" });
    return out;
  }
  // Main lifts chosen in this set make their lifts eligible too: the first op
  // per main lift, as the duplicate rule below keeps, and only a valid one.
  /** @type {Record<string, string>} */
  const choices = {};
  const firstMain = new Set();
  for (const op of ops) {
    if (op?.kind !== "mainLift" || firstMain.has(dupKey(op))) continue;
    firstMain.add(dupKey(op));
    if (isName(op.canonical) && isName(op.choice) && isMainCanonical(op.canonical) && isValidMainLiftChoice(op.canonical, op.choice)) {
      choices[op.canonical] = op.choice;
    }
  }
  const setCtx = { ...ctx, mainLiftChoices: choices };
  const seen = new Set();
  ops.forEach((op, i) => {
    const key = dupKey(op);
    if (seen.has(key)) { out.refusals.push({ i, code: "duplicate" }); return; }
    seen.add(key);
    const r = validateOp(op, setCtx);
    if (r.code) out.refusals.push({ i, code: r.code, ...(r.until !== undefined ? { until: r.until } : {}) });
    else if (r.change) {
      if (r.stale) out.stale = true;
      out.ops.push({ i, ...r.change, warnings: [...r.warnings] });
    }
  });
  // R4: one set raising both load and reps on a lift.
  for (const w of out.ops.filter((o) => o.kind === "weight")) {
    const r = out.ops.find((o) => o.kind === "reps" && o.target === w.target);
    if (!r) continue;
    const kgUp = w.before === null ? false : w.after > w.before;
    const before = repNumber(r.before);
    const repsUp = before !== null && repNumber(r.after) > before;
    if (kgUp && repsUp) { w.warnings.push("double_progression"); r.warnings.push("double_progression"); }
  }
  for (const o of out.ops) for (const code of o.warnings) out.warnings.push({ i: o.i, code });
  out.ok = out.refusals.length === 0 && !out.stale;
  return out;
}

/**
 * The weight range the pane may offer for a lift, from the same limits the
 * validator uses: max is accepted, max plus one rung is refused. Null for a
 * lift whose W is never read (pure bodyweight, timed, not by load) or that is
 * reps only (anchorLogged). blocked: deload or recovery (not now),
 * no_history (never performed, with no cap or template: nothing is
 * accepted), or range (the deload floor from their top set sits over
 * MAX_KG: nothing is accepted). min is never over max. Nothing here depends
 * on the client's bodyweight or muscle anchors.
 * @param {string} name
 * @param {ChangeCtx} ctx
 * @returns {{ min: number, max: number, step: number, warnBelow: number | null, blocked: { code: string, until: string | null } | null } | null}
 */
export function boundsFor(name, ctx) {
  const lift = programmeLifts(ctx.meta, ctx.mainLiftChoices).get(name);
  if (!lift) return null;
  const L = weightLimits(name, lift, ctx);
  if (L.refuse) return null;
  const caps = [MAX_KG];
  if (L.anchor?.kg != null) caps.push(L.up.per_change, L.up.per_week);
  else caps.push(L.noHistoryMax ?? 0);
  const max = floorToGrid(Math.min(...caps), L.lt);
  const lowest = L.anchor?.kg != null ? L.floor : L.step;
  const noStart = L.anchor?.kg == null && L.noHistoryMax === null ? { code: "no_history", until: null } : null;
  const over = lowest > max ? { code: L.anchor?.kg != null ? "range" : "no_history", until: null } : null;
  return { min: Math.min(lowest, max), max, step: L.step, warnBelow: L.warnBelow, blocked: L.block ?? noStart ?? over };
}

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * A stored row (snake_case, as the DB returns it) as a ChangeRow.
 * @param {any} r
 * @returns {ChangeRow}
 */
export function rowFromDb(r) {
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    id: r.id, set: r.set_id, kind: r.kind, target: r.target,
    before: r.old_value ?? null, after: r.new_value ?? null, from: r.effective_from ?? null, basis: r.basis ?? null,
    at: n(r.created_at), appliedAt: r.applied_at ?? null, outcome: r.outcome ?? null,
    undoneAt: n(r.undone_at), undoneBy: r.undone_by ?? null, revertedAt: r.reverted_at ?? null,
    warnings: r.warnings ?? null, deliveredAt: r.delivered_at ?? null,
  };
}

/** A row from the DB, the sync payload (`undone: true`, no outcome) or already canonical. */
function normaliseRow(r) {
  if (!r || typeof r !== "object" || typeof r.id !== "string" || !KINDS.includes(r.kind)) return null;
  const appliedAt = r.appliedAt ?? null;
  return {
    ...r,
    from: r.from ?? null,
    appliedAt,
    outcome: r.outcome ?? (appliedAt ? "applied" : null),
    undoneAt: r.undoneAt ?? (r.undone ? (r.at ?? 0) : null),
    undoneBy: r.undoneBy ?? null,
    revertedAt: r.revertedAt ?? null,
  };
}

/** The lift name a row's records are matched by. */
const recordLift = (row) => (row.kind === "mainLift" ? row.after : row.target);

/**
 * The first non-travel record after the change landed that trained its lift
 * (cooked counts: it was trained). Order-independent: the least id wins.
 */
function firstRecordAfter(history, row) {
  const name = recordLift(row);
  let best = null;
  for (const rec of Array.isArray(history) ? history : []) {
    if (!rec || rec.travel === true || typeof rec.id !== "string" || !(rec.id > row.appliedAt)) continue;
    if (best && rec.id >= best.rec.id) continue;
    for (const b of rec.blocks || []) {
      const ex = (b.exercises || []).find((e) => e?.name === name);
      if (ex) { best = { rec, ex }; break; }
    }
  }
  return best;
}

/** The device's current value for a row's target. */
function currentValue(row, meta) {
  if (row.kind === "weight") return weightOf(meta, row.target);
  if (row.kind === "reps") return repsOf(meta, row.target);
  if (row.kind === "mainLift") return currentMainLift(meta, row.target);
  return null;
}

/**
 * @typedef {{ status: "waiting" | "in_force" | "trained_yours" | "changed_since" | "not_applied" | "undone" | "withdrawn"
 *     | "seen" | "kept" | "auto_kept" | "discarded" | "superseded",
 *   reason: string | null, date: string | null, cooked?: boolean, keepsAt?: number | null }} ChangeStatus
 * reason (not_applied): an outcome, or "stopped" when sharing or changes
 * ended before it landed. date: the session date (trained_yours) or the
 * change's start (waiting); for a session row, the record's date.
 * seen, kept, auto_kept, discarded and superseded are a session row's
 * (sessionStatus).
 */

/**
 * What a change reads as now. Derived on read, the same on the device and
 * the server. state.editsLive: the grant is live with changes on.
 * @param {any} input
 * @param {{ meta: any, history: any[], todayIso: string, editsLive?: boolean }} state
 * @returns {ChangeStatus}
 */
export function changeStatus(input, state) {
  if (input?.kind === SESSION_KIND) return sessionStatus(input, { editsLive: state?.editsLive });
  const row = normaliseRow(input);
  if (!row) return { status: "not_applied", reason: "limits", date: null };
  if (row.undoneAt != null) return { status: row.undoneBy === "trainer" ? "withdrawn" : "undone", reason: null, date: null };
  if (row.outcome === null) {
    if (state.editsLive === false) return { status: "not_applied", reason: "stopped", date: null };
    return { status: "waiting", reason: null, date: row.from };
  }
  if (row.outcome !== "applied") return { status: "not_applied", reason: row.outcome, date: null };
  return appliedStatus(row, state);
}

/**
 * The status of a change that landed: in force, trained at, or moved since.
 * @param {any} row  normalised, outcome "applied"
 * @param {{ meta: any, history: any[], todayIso: string }} state
 * @returns {ChangeStatus}
 */
function appliedStatus(row, state) {
  if (row.kind === "week") {
    const g = scheduleEntryOn(weekLog(state.meta), state.todayIso);
    return g?.changeId === row.id ? { status: "in_force", reason: null, date: null } : { status: "changed_since", reason: null, date: null };
  }
  const first = typeof row.appliedAt === "string" ? firstRecordAfter(state.history, row) : null;
  if (first) {
    const prescribed = row.kind === "weight" ? first.ex.prescribed?.weight : row.kind === "reps" ? first.ex.prescribed?.reps : first.ex.name;
    const trainedAt = row.kind === "mainLift" ? same(currentValue(row, state.meta), row.after) : same(prescribed, row.after);
    if (!trainedAt) return { status: "changed_since", reason: null, date: null };
    return { status: "trained_yours", reason: null, date: first.rec.date ?? null, ...(first.rec.readiness === "cooked" ? { cooked: true } : {}) };
  }
  return same(currentValue(row, state.meta), row.after)
    ? { status: "in_force", reason: null, date: null }
    : { status: "changed_since", reason: null, date: null };
}

/**
 * Whether the client may undo a change now: before it lands; or while in
 * force, except a week, which goes back only while its entry is the latest
 * edit in the log (so a put-back never outranks a later edit of theirs).
 * @param {any} input
 * @param {ChangeStatus} status
 * @param {{ meta: any }} state
 */
export function isUndoable(input, status, state) {
  // Keep is final, and a session is withdrawn only by the trainer before it arrives.
  if (input?.kind === SESSION_KIND) return false;
  if (status.status === "waiting") return true;
  if (status.status !== "in_force") return false;
  if (input?.kind !== "week") return true;
  const log = weekLog(state.meta);
  return log.length > 0 && log[log.length - 1].changeId === input.id;
}

// ─── The device's apply plan ─────────────────────────────────────────────────

/**
 * A revert to a value that was never set. The device writes an unset: null
 * with a fresh stamp (P.unsetWeight / P.unsetReps), which syncs like any edit.
 */
export const RESET = Object.freeze({ reset: /** @type {true} */ (true) });
/** @typedef {{ readonly reset: true }} PlanReset */

/**
 * @typedef {{
 *   weights: Record<string, number | PlanReset>,
 *   reps: Record<string, number | string | PlanReset>,
 *   mainLifts: Record<string, string>,
 *   weeks: { week: any[], from: string, changeId: string }[],
 *   acks: { id: string, outcome: string }[],
 *   reverts: string[],
 *   applied: { id: string, kind: string, target: string, after: any, by: string | null }[],
 * }} DevicePlan
 * weights/reps: merged into the stored maps and saved by the stamped setters.
 * A value of { reset: true } (RESET) is a revert of a change whose before was
 * unset: the device writes an unset (null, freshly stamped), never a dropped
 * key. mainLifts: one setMainLift per key (a revert to unset is the
 * canonical itself). weeks: one W.save each. acks and
 * reverts: posted only after the push succeeds. applied: for the device's
 * "Set by {name}" marks.
 * Each row is re-checked with the route's own limits: none reads the
 * client's body or anchors (a first load is capped at the category cap or
 * the template), and a reps-only lift (anchorLogged) takes no weight.
 */

/** A row as the op the validator checks. */
function opFromRow(row) {
  if (row.kind === "weight") return { kind: "weight", lift: row.target, kg: row.after, from: row.from };
  if (row.kind === "reps") return { kind: "reps", lift: row.target, reps: repNumber(row.after), from: row.from };
  if (row.kind === "mainLift") return { kind: "mainLift", canonical: row.target, choice: row.after, from: row.from };
  return { kind: "week", week: row.after, from: row.from };
}

/**
 * What the client's device does with the trainer rows of one pull: which
 * values to write through its own setters, and which outcomes to report.
 * Rows not yet due are left alone. Pure.
 * @param {any[]} rows
 * @param {{ meta: any, history: any[], todayIso: string }} state
 * @returns {DevicePlan}
 */
export function planDeviceSteps(rows, { meta, history, todayIso }) {
  /** @type {DevicePlan} */
  const plan = { weights: {}, reps: {}, mainLifts: {}, weeks: [], acks: [], reverts: [], applied: [] };
  // Session rows have their own plan (planSessionSteps).
  const list = (Array.isArray(rows) ? rows : []).map(normaliseRow).filter((r) => r && r.kind !== SESSION_KIND);
  const open = list.filter((r) => r.outcome === null && r.undoneAt == null && (r.from === null || r.from <= todayIso));
  const toRevert = list.filter((r) => r.undoneAt != null && r.outcome === "applied" && r.revertedAt == null && r.kind !== "week");

  // Newest due row per target is the candidate; the rest are replaced.
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const r of open) {
    const key = `${r.kind}:${r.target}`;
    groups.set(key, [...(groups.get(key) || []), r]);
  }
  const candidates = [];
  for (const g of groups.values()) {
    g.sort((a, b) => (b.from ?? "").localeCompare(a.from ?? "") || (Number(b.at) || 0) - (Number(a.at) || 0));
    candidates.push(g[0]);
    for (const r of g.slice(1)) plan.acks.push({ id: r.id, outcome: "replaced" });
  }

  // Main lifts first, so a lift chosen in the same pull can take its weight.
  const m = { ...meta, mainLifts: { ...(meta?.mainLifts && typeof meta.mainLifts === "object" ? meta.mainLifts : {}) }, weights: { ...(meta?.weights || {}) }, reps: { ...(meta?.reps || {}) } };
  const order = ["mainLift", "weight", "reps", "week"];
  candidates.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const written = new Set();
  for (const row of candidates) {
    const outcome = row.kind === "week" ? weekOutcome(row, m) : liftOutcome(row, m, history, todayIso);
    plan.acks.push({ id: row.id, outcome: outcome.code });
    if (!outcome.write) continue;
    written.add(`${row.kind}:${row.target}`);
    plan.applied.push({ id: row.id, kind: row.kind, target: row.target, after: row.after, by: row.by ?? null });
    if (row.kind === "weight") { plan.weights[row.target] = row.after; m.weights[row.target] = row.after; }
    else if (row.kind === "reps") { plan.reps[row.target] = row.after; m.reps[row.target] = row.after; }
    else if (row.kind === "mainLift") { plan.mainLifts[row.target] = row.after; m.mainLifts[row.target] = row.after; }
    else plan.weeks.push({ week: row.after, from: row.from, changeId: row.id });
  }

  // Undone after landing: put the old value back while it is still in force.
  for (const row of toRevert) {
    const key = `${row.kind}:${row.target}`;
    const st = appliedStatus(row, { meta, history, todayIso });
    if (!written.has(key) && st.status === "in_force") {
      if (row.kind === "weight") plan.weights[row.target] = row.before ?? RESET;
      else if (row.kind === "reps") plan.reps[row.target] = row.before ?? RESET;
      else plan.mainLifts[row.target] = row.before ?? row.target;
      written.add(key);
    }
    plan.reverts.push(row.id);
  }
  return plan;
}

/** Outcome for a weight, reps or main-lift row. */
function liftOutcome(row, m, history, todayIso) {
  const cur = currentValue(row, m);
  if (same(cur, row.after)) return { code: "applied", write: false };
  const basis = row.basis && typeof row.basis === "object" ? row.basis : {};
  const check = () => validateOp(opFromRow(row), { meta: m, history, todayIso, phase: "apply" });
  if (row.from === null) {
    // Next session: only onto exactly what the trainer saw.
    const held = row.kind === "mainLift"
      ? same(cur, basis.choice ?? row.target)
      : (anchorIdOf(history, row.target) === (basis.anchorId ?? null) &&
        (basis.trainedId === undefined || trainedIdOf(history, row.target) === basis.trainedId) &&
        same(cur, row.kind === "weight" ? basis.w : basis.r));
    if (!held) return { code: "superseded", write: false };
    const v = check();
    if (!v.ok) return { code: BLOCK_CODES.includes(v.code) ? "deload" : "limits", write: false };
    return { code: "applied", write: true };
  }
  // Dated: re-checked against that day's anchor; a stale "up" never pulls anyone down.
  const v = check();
  if (!v.ok) return { code: BLOCK_CODES.includes(v.code) ? "deload" : "limits", write: false };
  if (row.kind !== "mainLift") {
    const after = row.kind === "weight" ? row.after : repNumber(row.after);
    const before = row.kind === "weight" ? row.before : repNumber(row.before);
    const now = row.kind === "weight" ? cur : repNumber(cur);
    const up = isNum(after) && (before === null || before === undefined || after > before);
    const lt = row.kind === "weight" ? (programmeLifts(m, undefined).get(row.target)?.loadType ?? loadTypeOfName(row.target)) : null;
    const anchorKg = row.kind === "weight" ? anchorOf(history, row.target, lt)?.kg ?? null : null;
    if (up && ((isNum(now) && now >= after) || (anchorKg !== null && anchorKg >= after))) return { code: "already_there", write: false };
  }
  return { code: "applied", write: true };
}

/** Outcome for a week row: lands only onto the entry the trainer saw. */
function weekOutcome(row, m) {
  const g = scheduleEntryOn(weekLog(m), row.from);
  if (g?.changeId === row.id) return { code: "applied", write: false };
  if ((g?.editedAt ?? null) !== (row.basis?.weekEditedAt ?? null)) return { code: "superseded", write: false };
  if (!isValidWeekConfig(row.after)) return { code: "limits", write: false };
  return { code: "applied", write: true };
}

// ─── Coached sessions ────────────────────────────────────────────────────────
//
// A trainer runs a client's session on their own device and sends the
// finished record as one change of kind "session". The server checks it
// against the client's plan (phase "write"); the client's device re-checks the
// bounds that protect its own stores (phase "apply") and decides what to do
// with it (planSessionSteps). Keep writes it through the same path as a live
// log; nothing here writes anything.

export const SESSION_KIND = "session";
/** Sets per exercise in one record, at most. */
export const MAX_SETS_PER_LIFT = 10;
/** Sessions per client per rolling 7 days (the route counts them), apart from the plan sets. */
export const SESSION_CAP = 7;
/** The store's name for the same cap. */
export const SESSIONS_PER_WEEK = SESSION_CAP;
/** Unless the client decides, a record is kept this long after it first reached their device. */
export const AUTO_KEEP_MS = 5 * 3600 * 1000;
/** JSON.stringify({ record, drum }) in UTF-8 bytes, at most: about twice a full Strength C at 10 sets a lift. */
export const RECORD_MAX_BYTES = 32768;
/** Drum entries in one record, at most. */
export const DRUM_MAX = 32;
/** A record's duration in seconds, at most. */
export const MAX_DURATION_S = 21600;
/** The letters a session may log: the live host's own list (components/SessionHost.jsx). */
export const SESSION_LETTERS = Object.freeze(["strength-a", "strength-b", "strength-c"]);
/** ReadinessScreen's choices (components/SessionScreen.jsx). */
export const READINESS = Object.freeze(["fresh", "normal", "cooked"]);
/** ReadinessScreen's reason tags (components/SessionScreen.jsx `reasons`; a test holds the two equal). */
export const READINESS_REASONS = Object.freeze(["slept_badly", "stressed", "recovering", "sore", "other"]);
/** The felt track (components/SessionScreen.jsx RPE track): 6 to 10 in half steps. */
export const RPE_TRACK = Object.freeze({ min: 6, max: 10, step: 0.5 });
/** A performed set's reps: the drum logs from 1; REP_LIMITS.min is a prescription floor. */
export const PERFORMED_REPS = Object.freeze({ min: 1, max: REP_LIMITS.max });

/** The drum's finest weight step (SplitWeightDrum's quarter-kilo wheel). */
const KG_GRID = 0.25;
/** The top of the engine's RIR band (lib/storage.js rpeToRir clamps to it). */
const RIR_TOP = 3;
/** The host offers a reach no earlier than this set (components/SessionHost.jsx REACH_EARLIEST_SET). */
const REACH_EARLIEST_SET = 3;

/**
 * The record's fields, exactly as newDraftLog, logSet and finaliseDraft write
 * them (lib/storage.js). `optional` keys may be absent (JSON drops undefined).
 */
export const RECORD_KEYS = Object.freeze({
  record: Object.freeze([
    "id", "date", "dow", "profileName", "schemaVersion", "loggedTz", "loggedTzOffset", "session", "blockNumber",
    "weekStart", "scheduledLetter", "mesocyclePhase", "readiness", "readinessReason", "bodyweight", "hoursSlept",
    "daysSinceLast", "duration", "blocks", "summary",
  ]),
  block: Object.freeze(["id", "type", "intent", "exercises"]),
  exercise: Object.freeze(["name", "muscle", "loadType", "swapped", "fromPool", "tempo", "prescribed", "sets", "summary"]),
  prescribed: Object.freeze(["reps", "weight", "sets"]),
  set: Object.freeze(["weight", "reps", "rir", "rpe", "loadType", "bodyweightUsed", "effectiveLoad", "est1rm", "volume", "reach"]),
  exerciseSummary: Object.freeze(["totalVolume", "avgRir", "topSet", "hitTarget"]),
  topSet: Object.freeze(["weight", "reps", "rir", "rpe", "est1rm"]),
  summary: Object.freeze(["totalVolume", "avgRir", "completionRate", "mainLiftPRs"]),
  optional: Object.freeze({ exercise: Object.freeze(["muscle"]), set: Object.freeze(["reach"]) }),
});
/** The record schema the live host writes (lib/storage.js SCHEMA_VERSION, which this module can't import). */
const RECORD_SCHEMA = 3;

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isInstant = (v) => typeof v === "string" && ISO_INSTANT_RE.test(v) && new Date(v).toISOString() === v;
const isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const numOrNull = (v) => v === null || isNum(v);
const strOrNull = (v, max = 128) => v === null || (typeof v === "string" && v.length <= max);
const utf8Bytes = (s) => new TextEncoder().encode(s).length;
const UTC_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });
const DAY_WORDS = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Every key of `o` that holds a value is in `allowed`; every allowed key not in `optional` is present.
 * @param {any} o
 * @param {readonly string[]} allowed
 * @param {readonly string[]} [optional]
 */
function keysOk(o, allowed, optional = []) {
  if (!isPlain(o)) return false;
  for (const [k, v] of Object.entries(o)) if (v !== undefined && !allowed.includes(k)) return false;
  return allowed.every((k) => optional.includes(k) || o[k] !== undefined);
}

/** "strength-a" → "A"; any other session → null. */
const letterOfSession = (s) => {
  const m = typeof s === "string" ? s.toLowerCase().match(/^strength[-_]([abc])$/) : null;
  return m ? m[1].toUpperCase() : null;
};
/** A history record's letter: its own, else read from its session. */
const recordLetter = (r) => (typeof r?.scheduledLetter === "string" ? r.scheduledLetter : letterOfSession(r?.session));

/** On the drum's grid, within the app's bounds; a pure bodyweight lift's weight is the added load. */
function loadOk(kg, loadType) {
  if (!isNum(kg) || kg < 0 || kg > MAX_KG) return false;
  if (Math.abs(kg / KG_GRID - Math.round(kg / KG_GRID)) > 1e-9) return false;
  return loadType !== "bodyweight" || kg <= ADDED_LOAD_MAX_KG;
}

/** Reps in one of the shapes the host logs, for a timed hold or not. */
function repsShapeOk(reps, timed) {
  if (timed) {
    // Seconds on the drum's grid; the template's own "45s" when the drum was never moved.
    const m = typeof reps === "string" ? reps.match(/^(\d+)s$/) : null;
    const sec = isInt(reps) ? reps : m ? parseInt(m[1], 10) : null;
    return sec !== null && sec >= TIMED_SECONDS.min && sec <= TIMED_SECONDS.max && sec % TIMED_SECONDS.step === 0;
  }
  const inBand = (n) => isInt(n) && n >= PERFORMED_REPS.min && n <= PERFORMED_REPS.max;
  if (isInt(reps)) return inBand(reps);
  if (typeof reps !== "string") return false;
  const leg = reps.match(/^(\d+)\/leg$/);
  if (leg) return inBand(parseInt(leg[1], 10));
  // A focus template's range ("6-8"), logged as shown when no target was set.
  const range = reps.match(/^(\d+)-(\d+)$/);
  return !!range && inBand(parseInt(range[1], 10)) && inBand(parseInt(range[2], 10)) && parseInt(range[1], 10) <= parseInt(range[2], 10);
}

/** A performed set's reps, as the drum or the template writes them. */
const repsOk = (reps, name) => repsShapeOk(reps, timedTargetFor(name) !== null);

/**
 * What a set was measured against, which the engine reads: reps as a target
 * in the lift's own shape (a swap carries its own target, timed or not, so
 * "180s" on a lift that isn't a hold would turn it into one); a weight that
 * is none or within the stored bounds (W or the template as stored, so not
 * re-gridded); 1 to 10 sets.
 */
function prescribedOk(p, name, loadType) {
  const repsHeld = repsOk(p.reps, name);
  const top = loadType === "bodyweight" ? ADDED_LOAD_MAX_KG : MAX_KG;
  const weightHeld = p.weight === null || (isNum(p.weight) && p.weight >= 0 && p.weight <= top);
  const setsHeld = isInt(p.sets) && p.sets >= 1 && p.sets <= MAX_SETS_PER_LIFT;
  return { reps: repsHeld, weight: weightHeld, sets: setsHeld };
}

/** Felt: none (a superset round), or the track's value with the engine's RIR for it. */
function feltOk(rpe, rir) {
  if (rpe === null) return rir === null;
  if (!isNum(rpe) || rpe < RPE_TRACK.min || rpe > RPE_TRACK.max) return false;
  if (Math.abs(rpe / RPE_TRACK.step - Math.round(rpe / RPE_TRACK.step)) > 1e-9) return false;
  return rir === Math.min(RIR_TOP, RPE_TRACK.max - rpe);
}

/** Whether `name` is an option the swap overlay offers over the slot lift `slotName` (SWAP_DB). */
export function isSwapFor(slotName, name) {
  const options = typeof slotName === "string" && Object.hasOwn(SWAP_DB, slotName) ? SWAP_DB[slotName] : [];
  return typeof name === "string" && (options ?? []).some((o) => o.name === name);
}

/** The row target of a session record: "<date>:<letter>", one per letter per day. */
export const sessionTarget = (record) => `${record?.date}:${record?.scheduledLetter}`;

/**
 * A record's date in words for someone whose today is `todayIso`: "today",
 * "yesterday", else "Tuesday 6 Oct". Every surface reads the record's own
 * day, so two clocks that disagree never both say "today". Null for a bad date.
 * @param {string} date
 * @param {string | null | undefined} todayIso
 */
export function sessionDayWords(date, todayIso) {
  if (!isIsoDate(date)) return null;
  if (date === todayIso) return "today";
  if (isIsoDate(todayIso) && date === addDaysIso(todayIso, -1)) return "yesterday";
  const parts = DAY_WORDS.formatToParts(new Date(`${date}T12:00:00Z`));
  const part = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")}`;
}

/**
 * What the trainer's list and the dry run show of a record: never the record.
 * @param {any} record
 * @param {string | null} [todayIso]  the viewer's today, for `day`
 * @returns {{ letter: string | null, date: string | null, day: string | null, exercises: number, sets: number }}
 */
export function sessionPreview(record, todayIso = null) {
  const exercises = (Array.isArray(record?.blocks) ? record.blocks : []).flatMap((b) => (Array.isArray(b?.exercises) ? b.exercises : []));
  const date = isIsoDate(record?.date) ? record.date : null;
  return {
    letter: letterOfSession(record?.session),
    date,
    day: date && todayIso ? sessionDayWords(date, todayIso) : null,
    exercises: exercises.length,
    sets: exercises.reduce((n, e) => n + (Array.isArray(e?.sets) ? e.sets.length : 0), 0),
  };
}

/**
 * @typedef {{
 *   meta?: any, history?: any[], todayIso?: string | null,
 *   phase?: "write" | "apply",
 *   at?: number | null,
 * }} SessionCtx
 * write: the server, against the client's meta and history as stored, with
 * todayIso the trainer's today (trainerToday). apply: the client's device,
 * which re-checks the bounds that protect its own stores (S1-S5, S8-S11,
 * S14) and measures the day window from the row's `at` (ms), so a record
 * that sat undelivered never goes stale.
 */
/**
 * @typedef {{
 *   ok: boolean, stale: boolean, code: string | null, rule: string | null,
 *   ops: (Change & { i: number, warnings: string[] })[],
 *   refusals: { i: number | null, code: string, rule: string, field?: string }[],
 *   warnings: { i: number, code: string }[],
 *   change: Change | null,
 *   preview: { letter: string | null, date: string | null, day: string | null, exercises: number, sets: number } | null,
 * }} SessionResult
 * The SetResult shape plus the first failing rule (code, rule), the change
 * to store ({ kind: "session", target: sessionTarget, before: null,
 * after: { record, drum }, from: record.date, basis: null }) and its preview.
 * stale (S12): the trainer's device composed from an older plan.
 */

/**
 * Check a coached session set: { id, ops: [{ kind: "session", record, drum }] }.
 * Rules S1-S14 in order; the first failure refuses. Pure.
 * @param {any} set
 * @param {SessionCtx} ctx
 * @returns {SessionResult}
 */
export function validateSessionSet(set, ctx) {
  const phase = ctx?.phase ?? "write";
  const write = phase === "write";
  /** @type {SessionResult} */
  const out = { ok: false, stale: false, code: null, rule: null, ops: [], refusals: [], warnings: [], change: null, preview: null };
  const refuse = (rule, code, field = undefined, i = 0) => {
    out.refusals.push({ i, code, rule, ...(field ? { field } : {}) });
    out.code = code;
    out.rule = rule;
    return out;
  };

  // S1: one session op, and nothing else on it.
  if (!isPlain(set) || typeof set.id !== "string" || !SET_ID_RE.test(set.id)) return refuse("S1", "set_id", undefined, null);
  if (!Array.isArray(set.ops) || set.ops.length !== 1) return refuse("S1", "set_size", undefined, null);
  const op = set.ops[0];
  if (!isPlain(op) || op.kind !== SESSION_KIND) return refuse("S1", "kind");
  if (!Object.keys(op).every((k) => k === "kind" || k === "record" || k === "drum") || !isPlain(op.record)
    || !(op.drum === undefined || isPlain(op.drum))) return refuse("S1", "op_shape");
  const record = op.record;
  const drum = op.drum ?? {};

  // S2: the size bound, and a drum of the record's own lifts.
  let bytes;
  try { bytes = utf8Bytes(JSON.stringify({ record, drum })); } catch { return refuse("S2", "size"); }
  if (bytes > RECORD_MAX_BYTES) return refuse("S2", "size");
  const blocks = Array.isArray(record.blocks) ? record.blocks : [];
  /** @type {Map<string, string>} */
  const named = new Map();
  for (const b of blocks) for (const e of Array.isArray(b?.exercises) ? b.exercises : []) {
    if (isName(e?.name) && !named.has(e.name)) named.set(e.name, typeof e.loadType === "string" ? e.loadType : "");
  }
  const drumKeys = Object.keys(drum);
  if (drumKeys.length > DRUM_MAX) return refuse("S2", "drum");
  for (const k of drumKeys) if (!named.has(k) || !loadOk(drum[k], named.get(k))) return refuse("S2", "drum", k);

  // S3: exactly the producer's fields; nothing the client's device owns.
  const shape = (field) => refuse("S3", "record_shape", field);
  if (!keysOk(record, RECORD_KEYS.record)) {
    const extra = Object.keys(record).find((k) => record[k] !== undefined && !RECORD_KEYS.record.includes(k));
    return shape(extra ?? RECORD_KEYS.record.find((k) => record[k] === undefined));
  }
  if (record.schemaVersion !== RECORD_SCHEMA) return shape("schemaVersion");
  for (const k of ["profileName", "bodyweight", "hoursSlept", "daysSinceLast"]) if (record[k] !== null) return shape(k);
  if (record.mesocyclePhase !== "accumulation") return shape("mesocyclePhase");
  if (!strOrNull(record.loggedTz, 64)) return shape("loggedTz");
  if (!(record.loggedTzOffset === null || (isInt(record.loggedTzOffset) && Math.abs(record.loggedTzOffset) <= 1440))) return shape("loggedTzOffset");
  if (!isInt(record.blockNumber) || record.blockNumber < 0) return shape("blockNumber");
  if (!Array.isArray(record.blocks) || blocks.length < 1) return shape("blocks");
  for (const [bi, b] of blocks.entries()) {
    const at = `blocks[${bi}]`;
    if (!keysOk(b, RECORD_KEYS.block) || !isName(b.id) || !isName(b.type) || !strOrNull(b.intent)) return shape(at);
    if (!Array.isArray(b.exercises) || b.exercises.length < 1) return shape(`${at}.exercises`);
    for (const [ei, e] of b.exercises.entries()) {
      const ea = `${at}.exercises[${ei}]`;
      if (!keysOk(e, RECORD_KEYS.exercise, RECORD_KEYS.optional.exercise) || !isName(e.name) || !isName(e.loadType)
        || typeof e.swapped !== "boolean" || !strOrNull(e.fromPool) || !strOrNull(e.tempo)
        || !(e.muscle === undefined || strOrNull(e.muscle, 256))) return shape(ea);
      const p = e.prescribed;
      if (!keysOk(p, RECORD_KEYS.prescribed) || !(isNum(p.reps) || typeof p.reps === "string") || !numOrNull(p.weight) || !isInt(p.sets)) {
        return shape(`${ea}.prescribed`);
      }
      if (!Array.isArray(e.sets)) return shape(`${ea}.sets`);
      for (const [si, s] of e.sets.entries()) {
        const sa = `${ea}.sets[${si}]`;
        if (!keysOk(s, RECORD_KEYS.set, RECORD_KEYS.optional.set) || s.loadType !== e.loadType) return shape(sa);
        if (s.bodyweightUsed !== null) return shape(`${sa}.bodyweightUsed`);
        if (!numOrNull(s.effectiveLoad) || !numOrNull(s.est1rm) || !numOrNull(s.volume)) return shape(sa);
        if (!(s.reach === undefined || s.reach === true)) return shape(`${sa}.reach`);
      }
      const sum = e.summary;
      if (!keysOk(sum, RECORD_KEYS.exerciseSummary) || !isNum(sum.totalVolume) || !numOrNull(sum.avgRir)
        || !(sum.hitTarget === null || typeof sum.hitTarget === "boolean")) return shape(`${ea}.summary`);
      const top = sum.topSet;
      if (top !== null && (!keysOk(top, RECORD_KEYS.topSet) || !numOrNull(top.weight) || !(isNum(top.reps) || typeof top.reps === "string")
        || !numOrNull(top.rir) || !numOrNull(top.rpe) || !numOrNull(top.est1rm))) return shape(`${ea}.summary.topSet`);
    }
  }
  const sum = record.summary;
  if (!keysOk(sum, RECORD_KEYS.summary) || !isNum(sum.totalVolume) || !numOrNull(sum.avgRir) || !numOrNull(sum.completionRate)
    || !Array.isArray(sum.mainLiftPRs) || sum.mainLiftPRs.length !== 0) return shape("summary");

  // S4: the day, and the fields that follow from it.
  const date = record.date;
  if (!isIsoDate(date)) return refuse("S4", "date", "date");
  if (!isInstant(record.id)) return refuse("S4", "date", "id");
  const idDays = daysBetween(date, record.id.slice(0, 10));
  if (idDays === null || Math.abs(idDays) > 1) return refuse("S4", "date", "id");
  if (record.weekStart !== mondayOfWeekIso(date)) return refuse("S4", "date", "weekStart");
  if (record.dow !== jsDow(date)) return refuse("S4", "date", "dow");
  if (!isInt(record.duration) || record.duration < 0 || record.duration > MAX_DURATION_S) return refuse("S4", "duration", "duration");
  if (write) {
    // Today or yesterday on the trainer's clock: the two Send offers.
    if (!isIsoDate(ctx?.todayIso) || !(date === ctx.todayIso || date === addDaysIso(ctx.todayIso, -1))) return refuse("S4", "day", "date");
  } else if (isNum(ctx?.at)) {
    // The same window, measured from when it was sent: the trainer's today is
    // within a day of the server's UTC day then, and the record is that day or the one before.
    const sentDay = UTC_DAY.format(new Date(ctx.at));
    const d = daysBetween(date, sentDay);
    if (d === null || d < -1 || d > 2) return refuse("S4", "day", "date");
  }

  // S5: a strength letter, and the letter the record names.
  const letterIdx = SESSION_LETTERS.indexOf(record.session);
  if (letterIdx < 0) return refuse("S5", "letter", "session");
  if (record.scheduledLetter !== letterOfSession(record.session)) return refuse("S5", "letter", "scheduledLetter");

  // S6, S7: the client's programme as composed, swaps from the overlay's list (server only).
  const meta = isPlain(ctx?.meta) ? ctx.meta : {};
  const sessions = write ? composedSessions(meta) : null;
  const composed = sessions ? sessions[letterIdx] : null;
  /** @type {{ e: any, block: any, slotEx: any, swapped: boolean }[]} */
  const placed = [];
  if (write) {
    let last = -1;
    for (const [bi, b] of blocks.entries()) {
      const ci = composed.blocks.findIndex((x) => x.id === b.id);
      if (ci <= last || composed.blocks[ci].type !== b.type) return refuse("S6", "block", `blocks[${bi}]`);
      last = ci;
    }
    for (const [bi, b] of blocks.entries()) {
      const cb = composed.blocks.find((x) => x.id === b.id);
      const slots = [["ex", ""], ["exA", "-A"], ["exB", "-B"]].filter(([k]) => cb[k]).map(([k, suffix]) => ({ k, ex: cb[k], key: `${cb.id}${suffix}` }));
      const used = new Set();
      for (const [ei, e] of b.exercises.entries()) {
        const field = `blocks[${bi}].exercises[${ei}]`;
        // The slot's own lift (a focus pick can override a swap and keep its flag), else an overlay option.
        let slot = slots.find((s) => !used.has(s.k) && s.ex.name === e.name);
        const swapped = !slot;
        if (!slot && e.swapped === true) slot = slots.find((s) => !used.has(s.k) && isSwapFor(s.ex.name, e.name));
        if (!slot) return refuse("S7", "exercise", field);
        used.add(slot.k);
        const lt = swapped ? swapLoadType(SWAP_DB[slot.ex.name].find((o) => o.name === e.name)) : getLoadType(slot.ex);
        if (e.loadType !== lt) return refuse("S7", "exercise", `${field}.loadType`);
        if (e.fromPool !== (Object.hasOwn(EXERCISE_POOLS, slot.key) ? slot.key : null)) return refuse("S7", "exercise", `${field}.fromPool`);
        placed.push({ e, block: cb, slotEx: slot.ex, swapped });
      }
    }
  }

  // S8: 1 to 10 sets a lift, as logged and as prescribed. One reach a
  // session, only where the live host offers it (SessionHost.jsx canReach):
  // a fresh day, the session's first main block, never a pure bodyweight
  // lift, on the last prescribed set (the third or later) or one added after.
  // A reach is never read as a miss, so one placed elsewhere could hide a short set.
  const headlineId = (write ? composed.blocks : blocks).find((b) => b?.type === "main")?.id ?? null;
  let reaches = 0;
  for (const [bi, b] of blocks.entries()) for (const [ei, e] of b.exercises.entries()) {
    const ea = `blocks[${bi}].exercises[${ei}]`;
    if (e.sets.length < 1 || e.sets.length > MAX_SETS_PER_LIFT) return refuse("S8", "sets", ea);
    if (!prescribedOk(e.prescribed, e.name, e.loadType).sets) return refuse("S8", "sets", `${ea}.prescribed`);
    for (const [si, s] of e.sets.entries()) {
      if (s.reach !== true) continue;
      reaches += 1;
      const offered = record.readiness === "fresh" && b.type === "main" && b.id === headlineId && e.loadType !== "bodyweight"
        && si >= REACH_EARLIEST_SET - 1 && si >= e.prescribed.sets - 1;
      if (!offered) return refuse("S8", "reach", `${ea}.sets[${si}]`);
    }
  }
  if (reaches > 1) return refuse("S8", "reach");

  // S9-S11: each lift's prescription and each set's load, reps and felt.
  for (const [bi, b] of blocks.entries()) for (const [ei, e] of b.exercises.entries()) {
    const ea = `blocks[${bi}].exercises[${ei}]`;
    const held = prescribedOk(e.prescribed, e.name, e.loadType);
    if (!held.weight) return refuse("S9", "load", `${ea}.prescribed`);
    if (!held.reps) return refuse("S10", "reps", `${ea}.prescribed`);
    for (const [si, s] of e.sets.entries()) {
      const field = `${ea}.sets[${si}]`;
      if (!(s.weight === null || loadOk(s.weight, e.loadType))) return refuse("S9", "load", field);
      if (!repsOk(s.reps, e.name)) return refuse("S10", "reps", field);
      if (!(s.rpe === null || isNum(s.rpe)) || !(s.rir === null || isNum(s.rir)) || !feltOk(s.rpe, s.rir)) return refuse("S11", "felt", field);
    }
  }

  // S12: what the trainer's device prescribed is the client's plan now (server only; swapped lifts are bounds only).
  if (write) {
    const targets = repTargets(meta, sessions);
    for (const { e, block, slotEx, swapped } of placed) {
      if (swapped) continue;
      const p = e.prescribed;
      // A cooked day trims a superset's sets and deloads a main lift's template
      // (scaleForReadiness, lib/storage.js): fewer sets, and an unset W, pass.
      const cooked = record.readiness === "cooked";
      const setsOk = cooked && block.type === "superset" ? p.sets >= 1 && p.sets <= block.sets : p.sets === block.sets;
      const repsHeld = same(p.reps, own(targets, e.name) ?? slotEx.reps);
      // W, else the template: what the trainer's device starts from with no
      // bodyweight and no anchors. With no W on a cooked day the template is
      // deloaded, which this module can't compute, so it may only be lighter.
      const w = weightOf(meta, e.name);
      const weightHeld = p.weight === null || p.weight === w || p.weight === (slotEx.weight ?? null)
        || (cooked && block.type === "main" && w === null && isNum(slotEx.weight) && p.weight <= slotEx.weight);
      if (!setsOk || !repsHeld || !weightHeld) {
        out.stale = true;
        out.code = "stale";
        out.rule = "S12";
        return out;
      }
    }
  }

  // S13: they logged this letter that day themselves (server; the device reads
  // it as superseded). A record reusing one of their record ids is refused
  // too: their device would take it for one already kept.
  const history = write && Array.isArray(ctx?.history) ? ctx.history : [];
  if (history.some((r) => r?.date === date && recordLetter(r) === record.scheduledLetter)) return refuse("S13", "already_logged");
  if (history.some((r) => r?.id === record.id)) return refuse("S13", "already_logged", "id");

  // S14: readiness and its reason, from the readiness screen's lists.
  if (!READINESS.includes(record.readiness)) return refuse("S14", "readiness", "readiness");
  if (!(record.readinessReason === null || READINESS_REASONS.includes(record.readinessReason))) return refuse("S14", "readiness", "readinessReason");

  /** @type {Change} */
  const change = { kind: SESSION_KIND, target: sessionTarget(record), before: null, after: { record, drum }, from: date, basis: null };
  out.ok = true;
  out.change = change;
  out.ops = [{ i: 0, ...change, warnings: [] }];
  out.preview = sessionPreview(record, write ? ctx.todayIso : null);
  return out;
}

// ─── Session statuses ────────────────────────────────────────────────────────

/**
 * What a session row reads as now, for the trainer and the client alike.
 * waiting: sent, not yet on their device. seen: on their device (delivered),
 * kept at keepsAt unless they say otherwise; reason "stopped" when sharing
 * stopped after it arrived (it stays until they decide, with no auto-keep,
 * so keepsAt is null). kept, auto_kept, discarded, superseded: the client's
 * decision. not_applied: "limits", or "stopped" before it arrived.
 * withdrawn: by the trainer, before it arrived. date: the record's day.
 * @param {any} row  a ChangeRow of kind "session" (deliveredAt, outcome, undoneAt)
 * @param {{ editsLive?: boolean }} [state]  editsLive: the grant is live with changes on
 * @returns {ChangeStatus}
 */
export function sessionStatus(row, { editsLive } = {}) {
  const r = isPlain(row) ? row : {};
  const date = isIsoDate(r.from) ? r.from : isIsoDate(r.after?.record?.date) ? r.after.record.date : null;
  const is = (status, reason = null, extra = {}) => ({ status, reason, date, ...extra });
  // A keep is read first: a withdraw can land after the device has the
  // record but before its arrival report does, and the client's keep then
  // still stands in their history. Only the trainer can undo a session.
  const outcome = r.outcome ?? (r.appliedAt ? "kept" : null);
  if (outcome === "kept" || outcome === "applied") return is("kept");
  if (outcome === "auto_kept") return is(outcome);
  if (r.undoneAt != null || r.undone === true) return is("withdrawn");
  if (outcome === "discarded" || outcome === "superseded") return is(outcome);
  if (outcome !== null) return is("not_applied", outcome);
  const delivered = isInstant(r.deliveredAt) ? Date.parse(r.deliveredAt) : null;
  if (delivered !== null) {
    return editsLive === false ? is("seen", "stopped", { keepsAt: null }) : is("seen", null, { keepsAt: delivered + AUTO_KEEP_MS });
  }
  if (editsLive === false) return is("not_applied", "stopped");
  return is("waiting");
}

// ─── The device's session plan ───────────────────────────────────────────────

/**
 * @typedef {{
 *   seen: { id: string, at: string }[],
 *   acks: { id: string, outcome: "limits" | "superseded" | "kept" }[],
 *   keep: { id: string, record: any, drum: Record<string, number>, by: string | null, startMs: number, keepsAt: number, auto: true }[],
 *   cards: { id: string, record: any, drum: Record<string, number>, by: string | null, startMs: number, keepsAt: number | null }[],
 * }} SessionPlan
 * seen: first sight on this device: write local seenAt (ms) and queue the
 * `delivered` report { id, at } (at: this device's ISO instant).
 * acks: outcomes to report (no write). keep: due for auto-keep now, with the
 * felt as sent. cards: waiting on the client, in row order; keepsAt null
 * when sharing has stopped (no auto-keep; it stays until they decide). A row
 * in `holding` (the record the client has open) stays a card: nothing is
 * kept under their finger.
 */

/**
 * What the client's device does with the session rows of one pull. The
 * five hours start when the record first reached any of their devices: the
 * earlier of the row's deliveredAt (the server's copy of the first report)
 * and this device's local seenAt. Never from the send. Auto-keep runs only
 * while the grant is live (row.editsLive === true) and the client is not
 * looking at it (holding). Rows already decided on this device
 * (local[id].decided) or with an ack queued (acked) are left alone. Pure.
 * @param {any[]} rows  the pull's trainer rows; kinds other than "session" are ignored
 * @param {{ history: any[], nowMs: number, local?: Record<string, { seenAt?: number | null, decided?: any }>, acked?: Iterable<string>, holding?: Iterable<string> }} ctx
 * @returns {SessionPlan}
 */
export function planSessionSteps(rows, { history, nowMs, local = {}, acked = [], holding = [] }) {
  /** @type {SessionPlan} */
  const plan = { seen: [], acks: [], keep: [], cards: [] };
  const hist = Array.isArray(history) ? history : [];
  const queued = new Set(acked);
  const held = new Set(holding);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isPlain(row) || row.kind !== SESSION_KIND || typeof row.id !== "string") continue;
    if (row.undone === true || row.undoneAt != null || (row.outcome ?? null) !== null) continue;
    const mine = isPlain(local) && Object.hasOwn(local, row.id) && isPlain(local[row.id]) ? local[row.id] : null;
    if (mine?.decided || queued.has(row.id)) continue;

    // The device's own checks: the bounds that protect its stores.
    const after = row.after;
    const ok = isPlain(after) && Object.keys(after).every((k) => k === "record" || k === "drum")
      && validateSessionSet({ id: row.set, ops: [{ kind: SESSION_KIND, record: after.record, drum: after.drum }] },
        { phase: "apply", at: isNum(row.at) ? row.at : null }).ok;
    if (!ok) { plan.acks.push({ id: row.id, outcome: "limits" }); continue; }
    const record = after.record;
    const sameDay = (r) => r?.date === record.date && recordLetter(r) === record.scheduledLetter;
    // Kept on another of their devices: this row's own record is already here,
    // on its day, with the provenance only Keep writes. An id that matches
    // anything else is never read as kept.
    const byId = hist.find((r) => r?.id === record.id);
    const keptHere = !!byId && sameDay(byId) && isPlain(byId.loggedBy)
      && (byId.loggedBy.changeId === undefined || byId.loggedBy.changeId === row.id);
    if (keptHere) { plan.acks.push({ id: row.id, outcome: "kept" }); continue; }
    if (hist.some(sameDay)) { plan.acks.push({ id: row.id, outcome: "superseded" }); continue; }
    if (byId) { plan.acks.push({ id: row.id, outcome: "limits" }); continue; }

    let seenAt = isNum(mine?.seenAt) ? mine.seenAt : null;
    if (seenAt === null) {
      seenAt = nowMs;
      plan.seen.push({ id: row.id, at: new Date(nowMs).toISOString() });
    }
    const delivered = isInstant(row.deliveredAt) ? Date.parse(row.deliveredAt) : null;
    const startMs = delivered === null ? seenAt : Math.min(delivered, seenAt);
    const live = row.editsLive === true;
    const card = { id: row.id, record, drum: isPlain(after.drum) ? after.drum : {}, by: row.by ?? null, startMs, keepsAt: live ? startMs + AUTO_KEEP_MS : null };
    if (live && !held.has(row.id) && startMs + AUTO_KEEP_MS <= nowMs) plan.keep.push({ ...card, keepsAt: startMs + AUTO_KEEP_MS, auto: true });
    else plan.cards.push(card);
  }
  return plan;
}
