// @ts-check
// lib/trainer-plan.js
// ─────────────────────────────────────────────────────────────────────────────
// The plan a trainer may change, for a grant with the client's changes on.
// Server-only: it runs the validator and the programme resolver, so the
// trainer pane never bundles it. The read-only view is lib/trainer-view.js.
// ─────────────────────────────────────────────────────────────────────────────

import { isBodyweightMovement } from "./lift-translations.js";
import { normaliseWeek } from "./sync-merge.js";
import { addDaysIso, mondayOfWeekIso } from "./dates.js";
import {
  boundsFor, liftBasis, changeStatus, currentMainLift, anchorLogged, sessionPreview,
  SETS_PER_WEEK, SESSIONS_PER_WEEK, SESSION_KIND, HORIZON_DAYS,
} from "./trainer-change.js";
import { resolvedProgramme, loadTypeOfName, validMainLifts, repTargets } from "./programme-resolve.js";
import { findMostRecentLiftSession } from "./progression.js";
import { mainLiftOptions, WEEK, EXERCISE_POOLS, FOCUS_OPTIONS, DEFAULT_FOCUS } from "./programme.js";
import { projectForTrainer as projectView, scheduleRuns, runsWeekFor, str, num, isoDate, reps } from "./trainer-view.js";

/** Every key the plan may emit, per object. Tests hold the output to it. */
export const PLAN_KEYS = Object.freeze({
  plan: ["lifts", "mains", "deload", "week", "programme", "changes", "budget"],
  planLift: ["name", "session", "loadType", "w", "reps", "anchor", "bounds", "blocked", "pending", "basis"],
  planAnchor: ["date", "kg", "reps"],
  planBounds: ["min", "max", "step", "warnBelow"],
  planBlocked: ["code", "until"],
  planPending: ["w", "reps"],
  planBasis: ["anchorDate", "anchorKg", "w", "r"],
  planMain: ["canonical", "choice", "options", "basis"],
  planDeload: ["active", "until"],
  planRun: ["from", "week", "pending"],
  planChange: ["id", "set", "kind", "target", "before", "after", "from", "status", "reason", "date", "cooked", "at", "delivered", "warnings"],
  planBudget: ["used", "of", "freeAt", "sessions"],
  // What the trainer's device composes a coached session from, as the client's
  // app would: the rotation (config, slot id to its pick), focus, main lifts,
  // and the rep targets in force (lift name to target; a lift without one
  // takes its slot's template, as on their device).
  planProgramme: ["number", "config", "focus", "mainLifts", "reps"],
  planSlot: ["name", "reps", "weight", "muscle", "vid", "loadType", "loadProfile"],
  // A session change's value: never the record itself.
  planSession: ["letter", "date", "exercises", "sets"],
  planSessionBudget: ["used", "of", "freeAt"],
  // view.ran: the sessions the trainer ran, on a live grant with changes not
  // on (changes: planChange rows of kind session; budget: planSessionBudget).
  ran: ["changes", "budget"],
});

/** Where the trainer's changes stand on a grant, as the view carries it (view.edits). */
export const EDITS_STATUSES = Object.freeze(["on", "off", "fresh", "unavailable"]);

/**
 * The grant's edits status:
 *   on           changes on, and the trainer's changes were read (the plan comes with it)
 *   unavailable  changes on, but the trainer's changes could not be read (no plan)
 *   fresh        approved under the old share consent: changes were never on, and
 *                need a fresh approval (every grant on the current consent starts on)
 *   off          the client turned them off
 * @param {{ edits?: boolean, editsAt?: number | null } | null | undefined} grant  dbTrainerGrants' row
 * @param {PlanChanges | null | undefined} changes  dbChangesForTrainer's result, null when unread
 * @returns {"on" | "off" | "fresh" | "unavailable"}
 */
export function editsStatus(grant, changes) {
  if (grant?.edits === true) return changes ? "on" : "unavailable";
  return grant?.editsAt == null ? "fresh" : "off";
}

/**
 * The trainer route's view: the read-only projection (lib/trainer-view.js),
 * plus `edits` (the grant's edits status) when given, and `plan` (projectPlan)
 * only when the status is on and the trainer's changes were read. With any
 * other status and the trainer's changes read (a live grant), `ran`
 * (projectRan): the sessions they ran with the client and the session
 * count, and nothing of the plan. A status left out reads as on when changes
 * are given; the trainer's own training passes neither, so carries neither key.
 * @param {{ meta?: any, history?: any[] } | null | undefined} data  dbReadProfile's result
 * @param {{ todayIso: string, edits?: PlanChanges | null, status?: "on" | "off" | "fresh" | "unavailable" | null }} opts
 */
export function projectForTrainer(data, { todayIso, edits = null, status = edits ? "on" : null }) {
  const out = projectView(data, { todayIso, loadTypeOf: programmeLoadTypes(data?.meta) });
  if (status === null || !EDITS_STATUSES.includes(status)) return out;
  out.edits = status;
  if (status === "on" && edits) out.plan = projectPlan(data, { todayIso, ...edits });
  else if (edits) out.ran = projectRan(data, { todayIso, ...edits });
  return out;
}

/**
 * The programme's load type by name (first slot wins), else the catalogue's:
 * how the view reads a logged set that carries no load type, as the plan does.
 * @param {any} meta
 */
function programmeLoadTypes(meta) {
  /** @type {Map<string, string>} */
  const byName = new Map();
  for (const l of resolvedProgramme(meta && typeof meta === "object" ? meta : {})) {
    if (!byName.has(l.name) && typeof l.loadType === "string") byName.set(l.name, l.loadType);
  }
  return (name) => byName.get(name) ?? loadTypeOfName(name);
}

/**
 * The trainer's own changes on the grant and its budget, as
 * dbChangesForTrainer returns them: plan sets, and sessions counted apart.
 * @typedef {{ rows?: any[] | null, used?: number, freeAt?: number | null,
 *   sessions?: { used?: number, freeAt?: number | null } | null }} PlanChanges
 */

const CODE = /^[a-z_]{1,32}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** A device's toISOString() instant, else null. */
const instant = (v) => (typeof v === "string" && INSTANT.test(v) && new Date(v).toISOString() === v ? v : null);
const SESSION_LETTERS = ["A", "B", "C"];

/** A stored change value, by kind, rebuilt from nothing. */
function changeValue(kind, v) {
  if (v === null || v === undefined) return null;
  if (kind === "weight") return num(v);
  if (kind === "reps") return reps(v);
  if (kind === "mainLift") return typeof v === "string" && v.length <= 128 ? v : null;
  if (kind === SESSION_KIND) {
    // What the list shows of a session: its letter, day and size, never the record.
    if (!v || typeof v !== "object" || !v.record || typeof v.record !== "object") return null;
    const { letter, date, exercises, sets } = sessionPreview(v.record);
    return { letter, date, exercises, sets };
  }
  if (kind === "week") {
    if (!Array.isArray(v) || v.length !== 7) return null;
    return v.map((d) => {
      /** @type {{ type: string | null, label?: string }} */
      const day = { type: str(d?.type) };
      const label = str(d?.label);
      if (label) day.label = label;
      return day;
    });
  }
  return null;
}

/**
 * The last performed top set: the validator's date and kg, plus that set's
 * reps. The set is found by the load the validator read (added kg on a
 * bodyweight movement, else effectiveLoad ?? weight). Any age: the trainer
 * with changes on sees each lift's last top set however old, as the basis for
 * safe limits; the share consent's row on each lift's last top set
 * (SHARE_COPY.rows, lib/trainer-terms.js) and the privacy page disclose it.
 * Reps only (a pure bodyweight lift, or one that fails the validator's own
 * anchorLogged): kg is null, and the reps are the most of any set that
 * session, never picked by a load the view withholds.
 */
function anchorFor(name, loadType, basis, history) {
  if (!basis.anchorDate) return { anchor: null, repsOnly: loadType === "bodyweight" };
  const repsOnly = loadType === "bodyweight" || !anchorLogged(history, name, loadType);
  const ex = findMostRecentLiftSession(history, name)?.exercise;
  const sets = Array.isArray(ex?.sets) ? ex.sets : [];
  const kg = repsOnly ? null : basis.anchorKg;
  const read = (s) => (isBodyweightMovement(loadType) ? s?.weight : (s?.effectiveLoad ?? s?.weight));
  let best = null;
  for (const s of sets) {
    if (kg !== null && read(s) !== kg) continue;
    const r = reps(s?.reps);
    const n = typeof r === "number" ? r : r === null ? null : parseInt(r, 10);
    if (n !== null && Number.isFinite(n) && (best === null || n > best.n)) best = { n, r };
  }
  return { anchor: { date: basis.anchorDate, kg, reps: best ? best.r : null }, repsOnly };
}

/** Up to the implement's grid (the validator's rounding): the same warning on every grid value. */
const ceilToStep = (kg, step) => Math.round(Math.ceil(kg / step - 1e-9) * step * 100) / 100;

/**
 * The waiting change the pane shows per target: a due one (next session, or
 * dated today or earlier) before one not yet due, then newest by start date
 * and sent time: the device's own pick among due rows.
 */
const pendingFirst = (todayIso) => (a, b) => {
  const due = (c) => (c.from === null || c.from <= todayIso ? 0 : 1);
  return due(a) - due(b) || (b.from ?? "").localeCompare(a.from ?? "") || (Number(b.at) || 0) - (Number(a.at) || 0);
};

/**
 * The plan a trainer may change, for a grant with the client's changes on:
 * each lift's current numbers, last top set and the range the route will
 * accept (boundsFor, the validator's own limits), the main-lift choices, the
 * deload, the week from this Monday to the 28-day horizon, what a coached
 * session is composed from (programme), the trainer's own changes with their
 * status (a session as its letter, day and size, and when it reached the
 * client's device), and the budget (plan sets, and sessions apart). The basis on each lift and main
 * is what the trainer sends back with a change; it never carries a record id
 * or an edit time. A pure bodyweight lift, or one that is reps only
 * (anchorLogged), shows no W, no anchor kg and no bounds. Nothing in the plan
 * moves with the client's bodyweight or muscle anchors: a performed lift is
 * bounded by the per-change and per-week rules, its deload floor and MAX_KG;
 * a lift with no performed top set is capped at the larger of its category's
 * cold-start cap and its template weight, both public programme numbers.
 * @param {{ meta?: any, history?: any[] } | null | undefined} data  dbReadProfile's result
 * @param {{ todayIso: string } & PlanChanges} opts
 */
export function projectPlan(data, { todayIso, rows = [], used = 0, freeAt = null, sessions = null }) {
  const meta = data?.meta && typeof data.meta === "object" ? data.meta : {};
  const history = Array.isArray(data?.history) ? data.history : [];
  const ctx = { meta, history, todayIso };
  // The route's own limits (the same in every phase).
  /** @type {import("./trainer-change.js").ChangeCtx} */
  const writeCtx = { ...ctx, phase: "write" };
  const before = pendingFirst(todayIso);

  // The trainer's changes, each with its status as the client's device would read it.
  const changes = [];
  /** @type {Map<string, any>} */
  const waiting = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const c = planChange(row, ctx);
    if (!c) continue;
    changes.push(c);
    if (c.status === "waiting" && row.kind !== SESSION_KIND) {
      const key = `${c.kind}:${c.kind === "week" ? c.from : c.target}`;
      const prev = waiting.get(key);
      if (!prev || before(c, prev) < 0) waiting.set(key, c);
    }
  }

  // Lifts: first slot wins, as the validator reads the programme.
  const lifts = [];
  const seen = new Set();
  /** @type {Map<string, string[]>} */
  const mainsSeen = new Map();
  for (const l of resolvedProgramme(meta)) {
    if (l.canonical && !mainsSeen.has(l.canonical)) mainsSeen.set(l.canonical, mainLiftOptions(l.canonical));
    if (seen.has(l.name)) continue;
    seen.add(l.name);
    const b = liftBasis(l.name, ctx);
    // Reps only: a pure bodyweight lift (W is never read), or a top set the view doesn't show (anchorLogged).
    const { anchor, repsOnly } = anchorFor(l.name, l.loadType, b, history);
    const basis = repsOnly ? { anchorDate: b.anchorDate, anchorKg: null, w: null, r: b.r } : b;
    const bounds = repsOnly ? null : boundsFor(l.name, writeCtx);
    const pw = waiting.get(`weight:${l.name}`);
    const pr = waiting.get(`reps:${l.name}`);
    lifts.push({
      name: l.name,
      session: SESSION_LETTERS[l.session] ?? null,
      loadType: str(l.loadType),
      w: basis.w,
      reps: reps(l.reps),
      anchor,
      bounds: bounds ? {
        min: bounds.min, max: bounds.max, step: bounds.step,
        warnBelow: bounds.warnBelow === null ? null : ceilToStep(bounds.warnBelow, bounds.step),
      } : null,
      blocked: bounds?.blocked ? { code: bounds.blocked.code, until: isoDate(bounds.blocked.until) } : null,
      pending: pw || pr ? { w: pw ? pw.after : null, reps: pr ? pr.after : null } : null,
      basis: { anchorDate: basis.anchorDate, anchorKg: basis.anchorKg, w: basis.w, r: reps(basis.r) },
    });
  }

  const mains = [...mainsSeen].map(([canonical, options]) => {
    const choice = currentMainLift(meta, canonical);
    return { canonical, choice, options: [...options], basis: choice };
  });

  // The deload: on or off, and when it ends (the date the validator gives a weight change).
  const deloadUntil = lifts.find((l) => l.blocked?.code === "deload")?.blocked.until ?? null;
  const deload = { active: !!meta.trainingState?.mesocycle?.activeDeload, until: deloadUntil };

  return {
    lifts,
    mains,
    deload,
    week: planWeek(meta.userWeek, todayIso, waiting),
    programme: planProgramme(meta),
    changes,
    budget: {
      used: Number.isFinite(used) ? used : 0, of: SETS_PER_WEEK, freeAt: num(freeAt),
      sessions: sessionBudget(sessions),
    },
  };
}

/**
 * One of the trainer's changes as the pane lists it, with its status as the
 * client's device would read it; null for a row that is not one.
 * @param {any} row  dbChangesForTrainer's row
 * @param {{ meta: any, history: any[], todayIso: string }} ctx
 */
function planChange(row, { meta, history, todayIso }) {
  if (!row || typeof row.id !== "string" || typeof row.kind !== "string") return null;
  const st = changeStatus(row, { meta, history, todayIso, editsLive: row.editsLive !== false });
  /** @type {any} */
  const c = {
    id: row.id, set: str(row.set), kind: row.kind, target: str(row.target),
    before: changeValue(row.kind, row.before), after: changeValue(row.kind, row.after),
    from: isoDate(row.from), status: st.status, reason: st.reason, date: isoDate(st.date),
  };
  if (st.cooked === true) c.cooked = true;
  c.at = num(row.at);
  // A session only: when it first reached the client's device (its five hours run from here).
  if (row.kind === SESSION_KIND) c.delivered = instant(row.deliveredAt);
  c.warnings = Array.isArray(row.warnings) ? row.warnings.filter((w) => typeof w === "string" && CODE.test(w)) : [];
  return c;
}

/** The session count, apart from plan sets. @param {PlanChanges["sessions"]} sessions */
const sessionBudget = (sessions) => ({
  used: Number.isFinite(sessions?.used) ? Number(sessions?.used) : 0, of: SESSIONS_PER_WEEK, freeAt: num(sessions?.freeAt),
});

/**
 * The sessions a trainer ran with the client, for a live grant with changes
 * not on: their own session rows (as projectPlan lists them, never the
 * record) and the session count. Nothing of the plan, so nothing to change.
 * @param {{ meta?: any, history?: any[] } | null | undefined} data  dbReadProfile's result
 * @param {{ todayIso: string } & PlanChanges} opts
 */
export function projectRan(data, { todayIso, rows = [], sessions = null }) {
  const meta = data?.meta && typeof data.meta === "object" ? data.meta : {};
  const history = Array.isArray(data?.history) ? data.history : [];
  const changes = (Array.isArray(rows) ? rows : [])
    .filter((r) => r?.kind === SESSION_KIND)
    .map((r) => planChange(r, { meta, history, todayIso }))
    .filter(Boolean);
  return { changes, budget: sessionBudget(sessions) };
}

const SLOT_REPS = /^\d{1,4}(?:\/leg|s|-\d{1,4})?$/;

/** The rotation pick of one slot, rebuilt from its stored fields: plain values only, as the pool writes them. */
function planSlot(stored) {
  /** @type {Record<string, string | number | null>} */
  const out = {};
  for (const k of PLAN_KEYS.planSlot) {
    const v = stored[k];
    if (k === "reps") {
      // As stored ("8/leg", "45s", "6-8", 10): a range is never read as its first count here.
      if (num(v) !== null || (typeof v === "string" && SLOT_REPS.test(v))) out.reps = v;
    } else if (k === "weight") {
      if (v === null || num(v) !== null) out.weight = v;
    } else if (typeof v === "string" && v.length <= 128) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * What the trainer's device composes a coached session from, so it composes
 * exactly as the client's app does (rotation, then main lifts, then the
 * session's swaps, then focus): the block number, the rotation's picks (only
 * a slot of the programme's pools, holding a lift of that pool), the focus,
 * the main-lift choices, and the rep targets in force for the programme's
 * lifts (stored or repaired, as lifts[].reps shows them, but only where one
 * is set, so a lift without one takes its own slot's template, a range
 * included). All programme data; the lifts it names are the plan's own
 * lifts. Nothing here moves with their bodyweight or anchors.
 * @param {any} meta
 */
function planProgramme(meta) {
  const block = meta.programmeBlock && typeof meta.programmeBlock === "object" ? meta.programmeBlock : {};
  const stored = block.config && typeof block.config === "object" && !Array.isArray(block.config) ? block.config : {};
  /** @type {Record<string, Record<string, string | number | null>>} */
  const config = {};
  for (const [slot, pick] of Object.entries(stored)) {
    if (!Object.hasOwn(EXERCISE_POOLS, slot) || !pick || typeof pick !== "object") continue;
    if (!EXERCISE_POOLS[slot].pool.some((/** @type {any} */ p) => p.name === pick.name)) continue;
    config[slot] = planSlot(pick);
  }
  return {
    // The device's default block is 1 (PB.get).
    number: Number.isInteger(block.number) && block.number > 0 ? block.number : 1,
    config,
    focus: FOCUS_OPTIONS.includes(meta.userFocus) ? meta.userFocus : DEFAULT_FOCUS,
    mainLifts: validMainLifts(meta) ?? {},
    reps: programmeReps(meta),
  };
}

/** Rep targets in force, for the programme's own lifts only. @param {any} meta */
function programmeReps(meta) {
  const targets = repTargets(meta);
  /** @type {Record<string, string | number>} */
  const out = {};
  for (const l of resolvedProgramme(meta)) {
    if (Object.hasOwn(out, l.name) || !Object.hasOwn(targets, l.name)) continue;
    const r = reps(targets[l.name]);
    if (r !== null) out[l.name] = r;
  }
  return out;
}

/** A week as the view's days: { s, label, type }, labels filled as the app shows them. */
const asDays = (week) => normaliseWeek(week).map((d) => ({ s: String(d.s), label: String(d.label), type: String(d.type) }));

/**
 * The week in force from this Monday to the horizon, as runs (the default
 * week where the client never set one), each with the trainer's waiting week
 * from that date, if any. A waiting week starting inside a run splits it.
 * @param {unknown} userWeek
 * @param {string} todayIso
 * @param {Map<string, any>} waiting
 */
function planWeek(userWeek, todayIso, waiting) {
  const from = mondayOfWeekIso(todayIso);
  const to = /** @type {string} */ (addDaysIso(todayIso, HORIZON_DAYS));
  const dflt = asDays(WEEK);
  /** @type {{ from: string, week: any[] | null }[]} */
  const runs = scheduleRuns(userWeek, { from, to }).map((r) => ({ from: r.from, week: r.week ?? dflt }));
  if (!runs.length || runs[0].from > from) runs.unshift({ from, week: dflt });
  const pending = [...waiting.values()].filter((c) => c.kind === "week" && c.from && c.from >= from && c.from <= to);
  for (const c of pending) {
    if (runs.some((r) => r.from === c.from)) continue;
    const carried = runsWeekFor(runs)(c.from);
    runs.push({ from: c.from, week: carried ?? dflt });
    runs.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  }
  return runs.map((r) => {
    const p = pending.find((c) => c.from === r.from);
    const ok = p && Array.isArray(p.after) && p.after.every((d) => d.type);
    return { from: r.from, week: r.week, pending: ok ? asDays(p.after) : null };
  });
}
