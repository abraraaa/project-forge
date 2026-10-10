// @ts-check
// lib/trainer-view.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers for what a trainer and their clients are shown of each other:
// names, the trainer's view of a client's training (an allow-list
// projection, built from nothing), the schedule as runs, the roster signal,
// and the look ring. The plan a trainer may change is server-only, in
// lib/trainer-plan.js; this module stays light enough for the trainer pane.
// ─────────────────────────────────────────────────────────────────────────────

import { normaliseProfile } from "./profile-name.js";
import { mainLiftTrend } from "./analytics.js";
import { loggedAddedKg, getLoadType } from "./lift-translations.js";
import { ensureScheduleHistory, scheduleEntryOn, normaliseWeek } from "./sync-merge.js";
import { addDaysIso, daysBetween, mondayOfWeekIso } from "./dates.js";
import { makeDayContext, weeklyStrength, strengthRhythm } from "./day-state.js";
import { isResting } from "./breaks.js";

/**
 * The name a trainer or client is shown by: the display form of their live
 * primary handle when it normalises to that handle, otherwise the handle
 * itself. display is not bound to the handle at claim, so a crafted display
 * can never stand in for someone else's name. meta.displayName is never used.
 * @param {{ handle?: string | null, display?: string | null } | null | undefined} row  dbPrimaryHandle's result
 * @returns {string | null}
 */
export function publicName(row) {
  const handle = row?.handle;
  if (typeof handle !== "string" || !handle) return null;
  const display = row?.display;
  return typeof display === "string" && normaliseProfile(display) === handle ? display : handle;
}

// ── The projection ──────────────────────────────────────────────────────────

/** Full session detail: 24 weeks. */
export const DETAIL_DAYS = 168;
/** One top set per main lift per session: 12 months. */
export const TREND_DAYS = 365;

/**
 * Every key the projection may emit, per object. Tests hold the output to it.
 * root's "plan" and "edits" are added on the server (lib/trainer-plan.js:
 * PLAN_KEYS, EDITS_STATUSES).
 */
export const VIEW_KEYS = Object.freeze({
  root: ["window", "breaks", "schedule", "sessions", "tops", "plan", "ran", "edits"],
  window: ["from", "trendFrom", "to"],
  break: ["start", "endedAt"],
  run: ["from", "week"],
  day: ["s", "label", "type"],
  session: ["id", "date", "session", "scheduledLetter", "travel", "coached", "readiness", "blocks"],
  block: ["type", "exercises"],
  exercise: ["name", "muscle", "loadType", "sets"],
  set: ["weight", "reps", "rpe", "rir", "loadType"],
  top: ["id", "date", "readiness", "blocks"],
  topBlock: ["type", "exercises"],
  topExercise: ["name", "sets"],
  topSet: ["weight", "reps", "rpe"],
});

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const BANDS = new Set(["fresh", "normal", "cooked"]);
// Value rebuilders, shared with lib/trainer-plan.js so both read values one way.
export const str = (v) => (typeof v === "string" ? v : null);
export const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const isoDate = (v) => (typeof v === "string" && ISO.test(v.slice(0, 10)) ? v.slice(0, 10) : null);

/** The app's rep forms ("5", "8/leg", "45s") as stored; anything else as its leading count. */
export function reps(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  if (/^\d{1,4}(?:\/leg|s)?$/.test(v)) return v;
  const m = v.match(/^(\d{1,4})/);
  return m ? Number(m[1]) : null;
}

/**
 * Breathers as bare spans: dates only, no id, no reason. With a window, only
 * spans that overlap it. A span with a malformed date is dropped, as
 * makeDayContext drops it.
 * @param {unknown} breaks  meta.breaks
 * @param {{ from: string, to: string }} [range]
 * @returns {{ start: string, endedAt: string | null }[]}
 */
export function projectBreaks(breaks, range) {
  const out = [];
  for (const b of Array.isArray(breaks) ? breaks : []) {
    const start = isoDate(b?.start);
    if (!start) continue;
    const endedAt = b.endedAt ? isoDate(String(b.endedAt)) : null;
    if (b.endedAt && !endedAt) continue;
    if (range && (start > range.to || (endedAt !== null && endedAt < range.from))) continue;
    out.push({ start, endedAt });
  }
  return out;
}

/**
 * The schedule in force on each date, as runs of equal weeks: [{ from, week }],
 * ascending. The plan in force only changes at an entry's effectiveFrom, so
 * those dates are the only run boundaries. With a range, runs are clipped to
 * it (the first starts at range.from). Edit times and the edit log stay out.
 * @param {unknown} userWeek  meta.userWeek, either shape
 * @param {{ from: string, to: string }} [range]
 * @returns {{ from: string, week: { s: string, label: string, type: string }[] | null }[]}
 */
export function scheduleRuns(userWeek, range) {
  const history = ensureScheduleHistory(userWeek);
  if (!history) return [];
  const bounds = [...new Set(history.map((e) => e.effectiveFrom))].sort();
  /** @type {{ from: string, week: any[] | null, key: string }[]} */
  const runs = [];
  for (const from of bounds) {
    const e = scheduleEntryOn(history, from);
    const week = e ? normaliseWeek(e.week).map((d) => ({ s: String(d.s), label: String(d.label), type: String(d.type) })) : null;
    const key = JSON.stringify(week);
    if (runs.length && runs[runs.length - 1].key === key) continue;
    runs.push({ from, week, key });
  }
  let out = runs;
  if (range) {
    // The last run starting on or before range.from carries into the range.
    const firstIn = runs.findIndex((r) => r.from > range.from);
    const carried = firstIn === -1 ? runs.length - 1 : firstIn - 1;
    out = runs.slice(Math.max(0, carried)).filter((r) => r.from <= range.to);
    if (out.length && out[0].from < range.from) out[0] = { ...out[0], from: range.from };
  }
  return out.map((r) => ({ from: r.from, week: r.week }));
}

/**
 * weekFor over scheduleRuns' output: the week of the last run starting on or
 * before iso, else null (makeDayContext then reads the default week).
 * @param {{ from: string, week: any[] | null }[]} runs
 * @returns {(iso: string) => any[] | null}
 */
export function runsWeekFor(runs) {
  const list = Array.isArray(runs) ? runs : [];
  return (iso) => {
    let week = null;
    for (const r of list) {
      if (r.from > iso) break;
      week = r.week;
    }
    return week;
  };
}

/**
 * A set's weight as shared. A pure bodyweight set shows only proven added kg
 * (0 when none), never a stale working weight.
 */
export function setWeight(s, loadType) {
  if (loadType === "bodyweight") return s?.weight == null ? null : (loggedAddedKg(s, "bodyweight") ?? 0);
  return num(s?.weight);
}

/**
 * The load type a set is shown by: its own, else its exercise's, else
 * 'bodyweight' when either the programme (`programme`, a name or a lookup by
 * name) or the name itself says so, else whichever of the two is known.
 * @param {any} s
 * @param {any} ex
 * @param {string | ((name: string) => string | null | undefined) | null} [programme]
 */
const shownLoadType = (s, ex, programme = null) => {
  const own = str(s?.loadType) ?? str(ex?.loadType);
  if (own) return own;
  const name = str(ex?.name) ?? "";
  const prog = str(typeof programme === "function" ? programme(name) : programme);
  const inferred = getLoadType({ name });
  return prog === "bodyweight" || inferred === "bodyweight" ? "bodyweight" : (prog ?? inferred);
};

/**
 * The weight the session view shows for one logged set (read by
 * shownLoadType, `loadType` being the programme's, or a lookup by name).
 * The validator's anchorLogged (lib/trainer-change.js) holds every loaded
 * set of a top set to it.
 * @param {any} s  the set
 * @param {any} ex  its exercise
 * @param {string | ((name: string) => string | null | undefined) | null} [loadType]
 * @returns {number | null}
 */
export function shownSetWeight(s, ex, loadType = null) {
  return setWeight(s, shownLoadType(s, ex, loadType));
}

/** @param {((name: string) => string | null | undefined) | null} loadTypeOf */
function projectSession(rec, id, loadTypeOf) {
  const blocks = [];
  for (const b of Array.isArray(rec.blocks) ? rec.blocks : []) {
    const exercises = [];
    for (const ex of Array.isArray(b?.exercises) ? b.exercises : []) {
      const sets = [];
      for (const s of Array.isArray(ex?.sets) ? ex.sets : []) {
        sets.push({ weight: shownSetWeight(s, ex, loadTypeOf), reps: reps(s?.reps), rpe: num(s?.rpe), rir: num(s?.rir), loadType: str(s?.loadType) });
      }
      exercises.push({ name: str(ex?.name), muscle: str(ex?.muscle), loadType: str(ex?.loadType), sets });
    }
    blocks.push({ type: str(b?.type), exercises });
  }
  /** @type {any} */
  const out = { id, date: rec.date, session: str(rec.session), scheduledLetter: str(rec.scheduledLetter) };
  if (rec.travel === true) out.travel = true;
  // A trainer logged it with them: the flag only, never loggedBy's name or account.
  if (rec.loggedBy && typeof rec.loggedBy === "object") out.coached = true;
  out.readiness = BANDS.has(rec.readiness) ? rec.readiness : null;
  out.blocks = blocks;
  return out;
}

/**
 * The trend tier: the top set per main lift, by the trend's own rule, so the
 * two cannot drift, over the weights the session view shows. An exercise
 * with no load type on it or any of its sets first takes the one the view
 * reads it by (shownLoadType), so an untyped pure bodyweight set is skipped
 * as a typed one is, and no logged weight the view withholds leaves.
 * @param {((name: string) => string | null | undefined) | null} loadTypeOf
 */
function projectTop(rec, id, loadTypeOf) {
  const typed = {
    ...rec,
    blocks: (Array.isArray(rec.blocks) ? rec.blocks : []).map((b) => ({
      ...b,
      exercises: (Array.isArray(b?.exercises) ? b.exercises : []).map((ex) => {
        const sets = Array.isArray(ex?.sets) ? ex.sets : [];
        const untyped = !str(ex?.loadType) && !sets.some((s) => str(s?.loadType));
        return {
          ...ex,
          ...(untyped ? { loadType: shownLoadType(null, ex, loadTypeOf) } : {}),
          sets: sets.map((s) => ({ ...s, weight: shownSetWeight(s, ex, loadTypeOf) })),
        };
      }),
    })),
  };
  const exercises = [];
  for (const [name, points] of Object.entries(mainLiftTrend([typed], { includeCooked: true }))) {
    for (const p of points) {
      exercises.push({ name, sets: [{ weight: num(p.topSet.weight), reps: reps(p.topSet.reps), rpe: num(p.topSet.rpe) }] });
    }
  }
  if (!exercises.length) return null;
  return { id, date: rec.date, readiness: BANDS.has(rec.readiness) ? rec.readiness : null, blocks: [{ type: "main", exercises }] };
}

/**
 * What a trainer sees of a client: a new object holding only the allow-listed
 * fields (VIEW_KEYS). Session detail for the last 24 weeks, one top set per
 * main lift per session back to 12 months, breathers as bare spans, and the
 * schedule as runs. Never photos, bodyweight (nor effectiveLoad, est1rm or
 * volume, which carry it), sleep, breather reasons, start times, time zones,
 * notes or any other meta. Ids are synthetic: date, noon, per-day ordinal.
 * Never a plan key: the server adds `plan` (lib/trainer-plan.js), and passes
 * loadTypeOf (the programme's load type by name) for sets that carry none.
 * @param {{ meta?: any, history?: any[] } | null | undefined} data  dbReadProfile's result
 * @param {{ todayIso: string, loadTypeOf?: ((name: string) => string | null | undefined) | null }} opts
 */
export function projectForTrainer(data, { todayIso, loadTypeOf = null }) {
  const from = /** @type {string} */ (addDaysIso(todayIso, -DETAIL_DAYS));
  const trendFrom = /** @type {string} */ (addDaysIso(todayIso, -TREND_DAYS));
  const meta = data?.meta && typeof data.meta === "object" ? data.meta : {};
  const recs = (Array.isArray(data?.history) ? data.history : [])
    .filter((r) => r && typeof r.date === "string" && ISO.test(r.date) && r.date >= trendFrom && r.date <= todayIso)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.id ?? "").localeCompare(String(b.id ?? ""))));

  // Ordinal per day by the original id: unique and ordered within a date,
  // the same id twice stays one id, and the start time never leaves.
  /** @type {Map<string, Map<string, number>>} */
  const ordinals = new Map();
  const synthId = (r, i) => {
    const day = ordinals.get(r.date) ?? ordinals.set(r.date, new Map()).get(r.date);
    const key = r.id != null ? `id:${r.id}` : `ix:${i}`;
    if (!day.has(key)) day.set(key, day.size);
    return `${r.date}T12:00:${String(day.get(key)).padStart(2, "0")}.000Z`;
  };

  const sessions = [];
  const tops = [];
  recs.forEach((r, i) => {
    const id = synthId(r, i);
    if (r.date >= from) sessions.push(projectSession(r, id, loadTypeOf));
    else {
      const t = projectTop(r, id, loadTypeOf);
      if (t) tops.push(t);
    }
  });

  const scheduleTo = /** @type {string} */ (addDaysIso(mondayOfWeekIso(todayIso), 6));
  /** @type {any} */
  const out = {
    window: { from, trendFrom, to: todayIso },
    breaks: projectBreaks(meta.breaks, { from, to: todayIso }),
    schedule: scheduleRuns(meta.userWeek, { from, to: scheduleTo }),
    sessions,
    tops,
  };
  return out;
}

/**
 * The ref a trainer opens their own training by, in place of a grant id.
 * Grant ids are "hwg_…", so no grant can be read through it.
 */
export const SELF_REF = "me";

const UTC_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });

/**
 * The trainer device's date when it is a real date within a day of the
 * server's UTC date; otherwise the server's UTC date.
 * @param {unknown} raw
 * @param {number} [now]
 */
export function trainerToday(raw, now = Date.now()) {
  const utc = UTC_DAY.format(new Date(now));
  if (typeof raw !== "string" || !ISO.test(raw) || addDaysIso(raw, 0) !== raw) return utc;
  const d = daysBetween(utc, raw);
  return d !== null && Math.abs(d) <= 1 ? raw : utc;
}

// ── The roster signal ───────────────────────────────────────────────────────

/** Sessions the roster read fetches: the 28-day rhythm plus its first ISO week, with margin. */
export const ROSTER_RECENT_DAYS = 35;
/** The only keys a roster signal carries. */
export const SIGNAL_KEYS = Object.freeze(["lastTrainedDaysAgo", "weekDone", "weekPlanned", "rhythmPct", "paused"]);

const LONDON_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" });

/**
 * The Europe/London calendar date of now: the day roster looks coalesce to.
 * @param {number} [now]
 */
export const rosterDay = (now = Date.now()) => LONDON_DAY.format(new Date(now));

/**
 * One client's roster line, from the roster read (dbRosterSignals): the
 * sessions of the last 35 days (id, date, session, letter), the latest
 * session date within 12 months, and the raw schedule and breathers. The day
 * maths is the Lab's: no Days store, breathers as bare spans, the schedule as
 * runs. Five values leave; nothing else of the input does.
 * @param {{ recent?: any[] | null, lastDate?: string | null, userWeek?: unknown, breaks?: unknown } | null | undefined} row
 * @param {string} today  trainerToday's date
 * @returns {{ lastTrainedDaysAgo: number | null, weekDone: number, weekPlanned: number, rhythmPct: number | null, paused: boolean }}
 */
export function rosterSignal(row, today) {
  const ctx = makeDayContext({
    todayIso: today,
    history: Array.isArray(row?.recent) ? row.recent : [],
    breaks: projectBreaks(row?.breaks),
    weekFor: runsWeekFor(scheduleRuns(row?.userWeek)),
  });
  const week = weeklyStrength(ctx, { weeks: 1 })[0];
  const rhythm = strengthRhythm(ctx, { days: 28 });
  // Well-formed is not enough: "2026-02-30" parses as 2 March, so the date must round-trip.
  const lastDate = typeof row?.lastDate === "string" && ISO.test(row.lastDate) && addDaysIso(row.lastDate, 0) === row.lastDate
    ? row.lastDate : null;
  const last = lastDate ? daysBetween(lastDate, today) : null;
  return {
    lastTrainedDaysAgo: last !== null && last >= 0 ? last : null,
    weekDone: week.done,
    weekPlanned: week.planned,
    rhythmPct: rhythm.expected > 0 ? Math.round(100 * rhythm.ratio) : null,
    paused: isResting(row?.breaks),
  };
}

// ── The look ring ───────────────────────────────────────────────────────────

/** Full looks within this of the newest full look refresh it instead of adding one. */
export const LOOK_COALESCE_MS = 15 * 60 * 1000;
export const LOOK_RING = 20;

/**
 * The JS mirror of the two ring UPDATEs (dbLogFullLook, and the roster's):
 * newest first, at most 20 entries, the oldest pushed out past that.
 *   full   { k: 'v' }: refreshes the newest entry's time when it is a full
 *          look under 15 minutes old, else prepends { k: 'v', at }.
 *   roster { k: 'r', d }: nothing when the ring already holds that day's
 *          roster entry, else prepends { k: 'r', d, at }.
 * `added` is what look_count gains: 1, or 0 when coalesced.
 * @param {any[] | null | undefined} looks
 * @param {{ k: 'v' } | { k: 'r', d: string }} look
 * @param {number} now
 * @returns {{ looks: any[], added: 0 | 1 }}
 */
export function nextLooks(looks, look, now) {
  const ring = Array.isArray(looks) ? looks : [];
  if (look.k === "v") {
    const top = ring[0];
    if (top?.k === "v" && Number(top.at) > now - LOOK_COALESCE_MS) {
      return { looks: [{ ...top, at: now }, ...ring.slice(1)], added: 0 };
    }
    return { looks: [{ k: "v", at: now }, ...ring].slice(0, LOOK_RING), added: 1 };
  }
  const d = /** @type {{ d: string }} */ (look).d;
  if (ring.some((e) => e?.k === "r" && e.d === d)) return { looks: ring, added: 0 };
  return { looks: [{ k: "r", d, at: now }, ...ring].slice(0, LOOK_RING), added: 1 };
}
