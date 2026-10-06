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
  snapToImplement, nextRung, weightStepForLoadType, isBodyweightMovement,
} from "./lift-translations.js";
import { MAIN_LIFT_FUNCTIONAL_EQUIVALENTS, isValidMainLiftChoice, timedTargetFor, WEEK } from "./programme.js";
import { EFFECTIVE_REP_BAND, recommendedReps } from "./rep-band.js";
import { isValidWeekConfig, ensureScheduleHistory, scheduleEntryOn, TYPE_LABEL } from "./sync-merge.js";
import { bandViolations } from "./rotation-solver.js";
import { resolvedProgramme, validMainLifts, loadTypeOfName, repsForSession } from "./programme-resolve.js";
import { addDaysIso, mondayOfWeekIso } from "./dates.js";
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

export const KINDS = Object.freeze(["weight", "reps", "mainLift", "week"]);
/** The outcomes a device may acknowledge (trainer_changes.outcome). */
export const OUTCOMES = Object.freeze(["applied", "superseded", "already_there", "deload", "limits", "replaced"]);
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
 *   by?: string | null, warnings?: any,
 * }} ChangeRow
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
  if (!op || typeof op !== "object" || !KINDS.includes(op.kind)) return refuse("kind");

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
    warnings: r.warnings ?? null,
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
 * @typedef {{ status: "waiting" | "in_force" | "trained_yours" | "changed_since" | "not_applied" | "undone" | "withdrawn",
 *   reason: string | null, date: string | null, cooked?: boolean }} ChangeStatus
 * reason (not_applied): an outcome, or "stopped" when sharing or changes
 * ended before it landed. date: the session date (trained_yours) or the
 * change's start (waiting).
 */

/**
 * What a change reads as now. Derived on read, the same on the device and
 * the server. state.editsLive: the grant is live with changes on.
 * @param {any} input
 * @param {{ meta: any, history: any[], todayIso: string, editsLive?: boolean }} state
 * @returns {ChangeStatus}
 */
export function changeStatus(input, state) {
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
  if (status.status === "waiting") return true;
  if (status.status !== "in_force") return false;
  if (input?.kind !== "week") return true;
  const log = weekLog(state.meta);
  return log.length > 0 && log[log.length - 1].changeId === input.id;
}

// ─── The device's apply plan ─────────────────────────────────────────────────

/**
 * A revert to a value that was never set. The applier holds it and writes
 * nothing: the stores have no stamped unset yet.
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
 * unset: the applier holds it, so a first weight stays until the client's
 * next session changes it (the stores have no stamped unset yet). Never a
 * dropped key. mainLifts: one setMainLift per key (a revert to unset is the
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
  const list = (Array.isArray(rows) ? rows : []).map(normaliseRow).filter(Boolean);
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
