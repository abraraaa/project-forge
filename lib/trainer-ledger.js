// @ts-check
// lib/trainer-ledger.js
// ─────────────────────────────────────────────────────────────────────────────
// One main lift's ledger for the trainer pane: every logged set of the lift
// from the 24-week detail tier (view.sessions), then the 12-month tier's one
// top set per session (view.tops), newest first. Pure, over the view the
// trainer routes send (lib/trainer-view.js projectForTrainer). It shows the
// weights the view carries and nothing else: a set the view sends without kg
// stays reps only. The top-set mark is the e1RM line's own pick
// (mainLiftTrend), so the ledger and the line cannot disagree.
// ─────────────────────────────────────────────────────────────────────────────

import { mainLiftTrend, totalTonnage } from "./analytics.js";
import { isCountedSet } from "./counted-set.js";
import { isBodyweightMovement } from "./lift-translations.js";

/**
 * One logged set. kg is the view's weight; on a pure bodyweight set only
 * proven added kg (added: true), otherwise null.
 * @typedef {{ n: number, kg: number | null, added: boolean, reps: number | string | null, rpe: number | null, rir: number | null, top: boolean }} LedgerSet
 */
/**
 * A trainer change the client trained at in this session (plan.changes,
 * status trained_yours). at: when it was sent, epoch ms.
 * @typedef {{ kind: "weight" | "reps", after: number | string | null, at: number | null }} LedgerChange
 */
/**
 * One session of the lift. tier "top": from the 12-month tier, so its top
 * set is all there is, and it has no volume. prescribed: the reps the
 * trainer set for this session, where the plan carries it. coached: the
 * trainer logged it with the client (the view's flag; never on a top row).
 * @typedef {{
 *   key: string, date: string, tier: "session" | "top", sets: LedgerSet[], best: LedgerSet | null,
 *   volume: { kg: number | null, reps: number } | null, prescribed: number | string | null, changes: LedgerChange[],
 *   coached: boolean,
 * }} LedgerRow
 */

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const repsOf = (v) => (typeof v === "number" ? num(v) : typeof v === "string" && v !== "" ? v : null);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The leading count of a rep value: 8, "8", "8/leg", "45s" → 8; anything else 0. */
export function repCount(v) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : 0;
  const m = typeof v === "string" ? v.match(/^(\d+)/) : null;
  return m ? parseInt(m[1], 10) : 0;
}

/** The lift's exercises in a record's main blocks, as the e1RM line reads them. */
function liftExercises(rec, liftName) {
  const out = [];
  for (const b of Array.isArray(rec?.blocks) ? rec.blocks : []) {
    if (b?.type !== "main") continue;
    for (const ex of Array.isArray(b.exercises) ? b.exercises : []) if (ex?.name === liftName) out.push(ex);
  }
  return out;
}

/**
 * The set's load as the pane shows it: the view's weight, except a pure
 * bodyweight set, which shows only added kg above 0 (setsLine's rule).
 */
function shownKg(s, ex) {
  const w = num(s?.weight);
  if ((s?.loadType ?? ex?.loadType) === "bodyweight") return w !== null && w > 0 ? { kg: w, added: true } : { kg: null, added: false };
  return { kg: w, added: false };
}

/**
 * Which of a session's sets is its top: the e1RM line's pick (highest e1RM,
 * first on ties) over the view's weights; with no e1RM to read (reps only,
 * or pure bodyweight), the most reps, first on ties.
 * @param {string} liftName
 * @param {{ s: any, ex: any }[]} raw
 */
function topIndex(liftName, raw) {
  if (!raw.length) return -1;
  const loadType = raw[0].ex?.loadType ?? raw.find((r) => r.s?.loadType)?.s.loadType ?? null;
  const rec = { date: "0000-00-00", readiness: null, blocks: [{ type: "main", exercises: [{ name: liftName, loadType, sets: raw.map((r) => r.s) }] }] };
  const point = mainLiftTrend([rec], { includeCooked: true })[liftName]?.[0];
  if (point) {
    const i = raw.findIndex((r) => r.s.weight === point.topSet.weight && r.s.reps === point.topSet.reps);
    if (i !== -1) return i;
  }
  let best = -1;
  raw.forEach((r, i) => { if (best === -1 || repCount(r.s.reps) > repCount(raw[best].s.reps)) best = i; });
  return best;
}

/**
 * Volume over the sets the view shows a load for, by the Lab's tonnage rule
 * (per dumbbell counts both hands). A bodyweight movement's kg is added or
 * assisting kg, not the load moved, so it never counts: those sessions read
 * as total reps.
 */
function volumeOf(raw) {
  const loaded = raw.filter((r) => num(r.s.weight) !== null && !isBodyweightMovement(r.s.loadType ?? r.ex?.loadType));
  const kg = loaded.length
    ? totalTonnage([{ blocks: [{ exercises: loaded.map((r) => ({ loadType: r.ex?.loadType ?? null, sets: [{ weight: r.s.weight, reps: r.s.reps, loadType: r.s.loadType ?? null }] })) }] }])
    : null;
  return { kg: kg && kg > 0 ? kg : null, reps: raw.reduce((n, r) => n + repCount(r.s.reps), 0) };
}

/** @returns {LedgerRow | null} */
function rowOf(rec, liftName, tier) {
  if (typeof rec?.date !== "string" || !ISO.test(rec.date)) return null;
  const raw = [];
  for (const ex of liftExercises(rec, liftName)) {
    for (const s of Array.isArray(ex.sets) ? ex.sets : []) if (isCountedSet(s)) raw.push({ s, ex });
  }
  if (!raw.length) return null;
  const top = topIndex(liftName, raw);
  const sets = raw.map(({ s, ex }, i) => ({
    n: i + 1, ...shownKg(s, ex), reps: repsOf(s.reps), rpe: num(s.rpe), rir: num(s.rir), top: i === top,
  }));
  return {
    key: String(rec.id ?? `${rec.date}:${tier}`),
    date: rec.date,
    tier,
    sets,
    best: sets[top] ?? null,
    volume: tier === "session" ? volumeOf(raw) : null,
    prescribed: null,
    changes: [],
    coached: tier === "session" && rec.coached === true,
  };
}

/**
 * One main lift's ledger, newest first: a row per session of the lift, with
 * every counted set from view.sessions, then the one top set view.tops keeps
 * per session before that. Where the view carries the trainer's plan, a
 * weight or reps change the client trained at (plan.changes, trained_yours)
 * sits on the first session of its date, and a reps change gives that
 * session's prescribed reps.
 * @param {any} view  the trainer route's view
 * @param {string} liftName
 * @returns {LedgerRow[]}
 */
export function ledgerFor(view, liftName) {
  /** @type {LedgerRow[]} */
  const rows = [];
  const add = (list, tier) => {
    for (const rec of Array.isArray(list) ? list : []) {
      const r = rowOf(rec, liftName, tier);
      if (r) rows.push(r);
    }
  };
  add(view?.tops, "top");
  add(view?.sessions, "session");
  // Oldest first while the changes attach; ids order sessions within a day.
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const changes = (Array.isArray(view?.plan?.changes) ? view.plan.changes : [])
    .filter((c) => c && (c.kind === "weight" || c.kind === "reps") && c.target === liftName
      && c.status === "trained_yours" && typeof c.date === "string")
    .sort((a, b) => (num(a.at) ?? 0) - (num(b.at) ?? 0));
  for (const c of changes) {
    const row = rows.find((r) => r.date === c.date);
    if (!row) continue;
    const after = c.kind === "weight" ? num(c.after) : repsOf(c.after);
    row.changes.push({ kind: c.kind, after, at: num(c.at) });
    if (c.kind === "reps" && after !== null) row.prescribed = after;
  }
  return rows.reverse();
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** A set's kg as printed: "100", "+10" for added kg, "" when the view carries none. */
export function ledgerKg(set) {
  if (set?.kg == null) return "";
  return set.added ? `+${set.kg}` : String(set.kg);
}

/** Reps as logged: 5, "8/leg", "45s"; "" when none. */
export function ledgerReps(reps) {
  return reps == null ? "" : String(reps);
}

/**
 * Reps as words: a number takes "reps" ("5 reps", "1 rep"); a string already
 * says what it counts ("8/leg", "45s") and prints as is; "" when none.
 * @param {number | string | null | undefined} reps
 */
export function ledgerRepsText(reps) {
  if (typeof reps === "number") return `${reps} rep${reps === 1 ? "" : "s"}`;
  return ledgerReps(reps);
}

/** One set: "100 × 5", "+10 × 8", or with no kg its reps alone: "8 reps", "8/leg". */
export function ledgerSetText(set) {
  if (!set) return "";
  const kg = ledgerKg(set);
  if (kg) return `${kg} × ${ledgerReps(set.reps) || "–"}`;
  return ledgerRepsText(set.reps) || "–";
}

/** A session's volume: "1500 kg", or "24 reps in all" with no load to count; "" for a top-set-only row. */
export function ledgerVolumeText(volume) {
  if (!volume) return "";
  if (volume.kg != null) return `${volume.kg} kg`;
  return volume.reps > 0 ? `${volume.reps} rep${volume.reps === 1 ? "" : "s"} in all` : "";
}

/** The row's mark: "Coached" when the trainer logged the session with the client, else "". @param {LedgerRow} row */
export function ledgerMarkText(row) {
  return row?.coached === true ? "Coached" : "";
}

/** The sets a row shows: its top set alone, or all of them. @param {LedgerRow} row @param {"top" | "all"} mode */
export function ledgerSetsShown(row, mode) {
  if (mode === "all") return row.sets;
  return row.best ? [row.best] : [];
}
