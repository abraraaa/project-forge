// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/day-state.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE answer to "what is this day?", for any date. Every day carries:
//   planned — the schedule IN FORCE on that date (a schedule edit never
//             rewrites the past; a future-dated edit is honoured),
//   did     — what actually happened: a strength session (history is the
//             truth; a Days sessionId stands in until history syncs) or a
//             manual tick,
//   done    — a session satisfies any day; a tick only its own type,
//   covered — a missed strength day made up by a surplus session in the
//             same ISO week (the picker's weekly quota, expressed per date),
//   resting — inside a declared breather (end is half-open),
//   owed    — the one "anything missed?" answer: null, "log" or "tick",
//   session — which of A/B/C: the one LOGGED, what logging it retro would
//             write (past), or the forward cycle projection (today on),
//   shown   — the day object to render: a done day wears what was done,
//   bonus   — Days marks.bonus; display only, never done/owed/activity.
// Pure: callers pass the stores and today in; nothing here reads a clock or
// writes anything.
// ─────────────────────────────────────────────────────────────────────────────

import { WEEK, SESSIONS, recordLetterIdx, nextStrengthIdx, projectStrengthDaySessions, sessionMetaForDate } from "./programme.js";
import { addDaysIso, daysBetween, mondayIndex, mondayOfWeekIso } from "./dates.js";

/** @typedef {"strength"|"cardio"|"zone2"|"hiit"|"rest"|string} DayType */

/** @typedef {{ kind: "strength", source: "history"|"days", sessionIdx: number|null,
 *   count: number, travel: boolean, recordIds: string[] }
 * | { kind: "tick", type: DayType }} Did */

/** @typedef {{
 *   iso: string, weekIdx: number,
 *   when: "past"|"today"|"future",
 *   planned: DayType, plannedDay: any,
 *   did: Did|null,
 *   done: boolean,
 *   covered: boolean, coveredBy: string|null,
 *   resting: boolean,
 *   owed: null|"log"|"tick",
 *   status: "done"|"covered"|"missed"|"due"|"upcoming"|"rest"|"resting",
 *   session: number|null,
 *   shown: any,
 *   bonus: boolean
 * }} DayState */

/** @typedef {{
 *   todayIso: string,
 *   days: Record<string, any>,
 *   weekFor: (iso: string) => any[] | null,
 *   recordsOn: Record<string, any[]>,
 *   cycleDates: string[], cycleLetter: (number|null)[],
 *   breakSpans: { start: string, end: string|null }[],
 *   nextIdx: number,
 *   plannedCache: Map<string, any>,
 *   weekCache: Map<string, DayState[]>,
 *   proj: { map: Map<string, number>, cursor: string, k: number }
 * }} DayContext */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_CAP = 400;

/** Single record-recognition rule for the whole app. */
export const isStrengthRecord = (r) => String(r?.session || "").startsWith("strength") || recordLetterIdx(r) !== null;

/**
 * Index the stores once per render: strength records per date (deduped by
 * id), the letter timeline for cycle-before-date lookups, and breather spans.
 * @param {{ todayIso: string, history?: any[], days?: Record<string, any>,
 *   breaks?: any[], weekFor?: (iso: string) => any[] | null }} input
 * @returns {DayContext}
 */
export function makeDayContext({ todayIso, history = [], days = {}, breaks = [], weekFor = () => null }) {
  /** @type {Record<string, Map<string, any>>} */
  const byDate = {};
  const lettered = [];
  (history || []).forEach((r, i) => {
    if (!r?.date || !isStrengthRecord(r)) return;
    // Same id twice (a merge echo) is one session, not two.
    (byDate[r.date] ||= new Map()).set(r.id != null ? `id:${r.id}` : `ix:${i}`, r);
    const idx = recordLetterIdx(r);
    if (idx !== null) lettered.push({ key: `${r.date}|${r.id || ""}`, date: r.date, idx });
  });
  /** @type {Record<string, any[]>} */
  const recordsOn = {};
  for (const [date, m] of Object.entries(byDate)) {
    recordsOn[date] = [...m.values()].sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
  }
  // Sorted by date|id, the same order lastStrengthIdx uses, so the latest
  // record before a date is one binary search away.
  lettered.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // A malformed end must not silently mean "still resting" (which would
  // suppress owed days forever), so a span with a bad date is dropped.
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const breakSpans = (Array.isArray(breaks) ? breaks : [])
    .filter((b) => b && typeof b.start === "string" && ISO.test(b.start.slice(0, 10)))
    .filter((b) => !b.endedAt || ISO.test(String(b.endedAt).slice(0, 10)))
    .map((b) => ({ start: b.start.slice(0, 10), end: b.endedAt ? String(b.endedAt).slice(0, 10) : null }));

  return {
    todayIso,
    days: days || {},
    weekFor: weekFor || (() => null),
    recordsOn,
    cycleDates: lettered.map((l) => l.date),
    cycleLetter: lettered.map((l) => l.idx),
    breakSpans,
    nextIdx: nextStrengthIdx(history || []),
    plannedCache: new Map(),
    weekCache: new Map(),
    proj: { map: new Map(), cursor: todayIso, k: 0 },
  };
}

/** The schedule in force on iso; anything but a 7-day array reads as the default. */
function weekIn(ctx, iso) {
  const w = ctx.weekFor(iso);
  return Array.isArray(w) && w.length === 7 ? w : WEEK;
}

/** The day object from the schedule in force ON iso. */
function plannedOn(ctx, iso) {
  let d = ctx.plannedCache.get(iso);
  if (d === undefined) {
    const i = mondayIndex(iso);
    d = weekIn(ctx, iso)[i] || WEEK[i];
    ctx.plannedCache.set(iso, d);
  }
  return d;
}

/** What logging a strength session on iso would write: next after the latest lettered record strictly before it. */
function cycleBefore(ctx, iso) {
  let lo = 0;
  let hi = ctx.cycleDates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ctx.cycleDates[mid] < iso) lo = mid + 1; else hi = mid;
  }
  return lo === 0 ? 0 : (ctx.cycleLetter[lo - 1] + 1) % SESSIONS.length;
}

/** @returns {Did|null} */
function didOn(ctx, iso) {
  const recs = ctx.recordsOn[iso];
  if (recs?.length) {
    const latest = recs[recs.length - 1];
    return {
      kind: "strength",
      source: "history",
      sessionIdx: recordLetterIdx(latest),
      count: recs.length,
      travel: recs.some((r) => r?.travel === true),
      recordIds: recs.map((r) => r?.id).filter((id) => id != null).map(String),
    };
  }
  const entry = ctx.days?.[iso];
  // A finalised session whose history hasn't synced yet.
  if (entry?.sessionId) return { kind: "strength", source: "days", sessionIdx: null, count: 1, travel: false, recordIds: [] };
  if (entry?.completedType) return { kind: "tick", type: entry.completedType };
  return null;
}

const satisfies = (did, plannedType) => did?.kind === "strength" || (did?.kind === "tick" && did.type === plannedType);

function restingOn(ctx, iso) {
  return ctx.breakSpans.some((b) => b.start <= iso && (b.end === null || iso < b.end));
}

/** Forward A/B/C projection from today: each strength-planned day not yet done takes the next letter, across weeks. */
function projectedOn(ctx, iso) {
  const p = ctx.proj;
  while (p.cursor <= iso) {
    const d = p.cursor;
    if (plannedOn(ctx, d)?.type === "strength") {
      const doneToday = d === ctx.todayIso && satisfies(didOn(ctx, d), "strength");
      if (!doneToday) { p.map.set(d, (ctx.nextIdx + p.k) % SESSIONS.length); p.k += 1; }
    }
    p.cursor = addDaysIso(d, 1);
  }
  return p.map.get(iso) ?? null;
}

/** The only place coverage is decided: one ISO week, Mon–Sun. */
function resolveIsoWeek(ctx, mondayIso) {
  const cached = ctx.weekCache.get(mondayIso);
  if (cached) return cached;
  const today = ctx.todayIso;

  const base = Array.from({ length: 7 }, (_, i) => {
    const iso = addDaysIso(mondayIso, i);
    const plannedDay = plannedOn(ctx, iso);
    const did = didOn(ctx, iso);
    return {
      iso, weekIdx: i, plannedDay, planned: plannedDay?.type, did,
      when: /** @type {"past"|"today"|"future"} */ (iso < today ? "past" : iso === today ? "today" : "future"),
      resting: restingOn(ctx, iso),
    };
  });

  // Surplus: every strength session up to today beyond the first on a
  // strength-planned date — off-plan days and doubles alike.
  const surplusDates = [];
  for (const d of base) {
    if (d.iso > today || d.did?.kind !== "strength") continue;
    const extra = d.planned === "strength" ? d.did.count - 1 : d.did.count;
    for (let k = 0; k < extra; k++) surplusDates.push(d.iso);
  }
  // A day already done (e.g. a legacy "strength" tick) can't be missed, so
  // it must not take surplus meant for a day that genuinely was.
  const missed = base.filter((d) => d.when === "past" && d.planned === "strength" && !satisfies(d.did, d.planned) && !d.resting);
  // Oldest missed first: the same set the old newest-first quota left unowed.
  /** @type {Record<string, string>} */
  const coveredBy = {};
  missed.slice(0, Math.min(surplusDates.length, missed.length)).forEach((d, k) => { coveredBy[d.iso] = surplusDates[k]; });

  const out = base.map((d) => {
    const done = satisfies(d.did, d.planned);
    const covered = !done && coveredBy[d.iso] !== undefined;
    const isRest = d.planned === "rest";

    /** @type {null|"log"|"tick"} */
    let owed = null;
    if (d.when === "past" && !done && !covered && !d.resting && !isRest) owed = d.planned === "strength" ? "log" : "tick";

    /** @type {DayState["status"]} */
    const status = d.resting && !done ? "resting"
      : done ? "done"
      : covered ? "covered"
      : isRest ? "rest"
      : d.when === "past" ? "missed"
      : d.when === "today" ? "due" : "upcoming";

    const trainedStrength = d.did?.kind === "strength";
    const letter = d.did?.kind === "strength" ? d.did.sessionIdx : null;
    let session = null;
    if (letter != null && d.when !== "future") session = letter;
    else if (d.when !== "future" && (trainedStrength || (d.planned === "strength" && (d.when === "past" || done)))) session = cycleBefore(ctx, d.iso);
    else if (d.planned === "strength") session = projectedOn(ctx, d.iso);

    const shownType = done ? (d.did.kind === "strength" ? "strength" : d.did.type) : d.planned;
    return {
      iso: d.iso,
      weekIdx: d.weekIdx,
      when: d.when,
      planned: d.planned,
      plannedDay: d.plannedDay,
      did: d.did,
      done,
      covered,
      coveredBy: covered ? coveredBy[d.iso] : null,
      resting: d.resting,
      owed,
      status,
      session,
      shown: shownType === d.planned ? d.plannedDay : { ...d.plannedDay, type: shownType },
      bonus: !!ctx.days?.[d.iso]?.marks?.bonus,
    };
  });
  ctx.weekCache.set(mondayIso, out);
  return out;
}

/**
 * One date. Resolves (and caches) its whole ISO week, because coverage is decided per week.
 * @param {DayContext} ctx
 * @param {string} iso
 * @returns {DayState}
 */
export function resolveDay(ctx, iso) {
  return resolveIsoWeek(ctx, mondayOfWeekIso(iso))[mondayIndex(iso)];
}

/**
 * Inclusive and ascending. Capped so an accidental all-history call throws instead of crawling.
 * @param {DayContext} ctx
 * @param {string} fromIso
 * @param {string} toIso
 * @returns {DayState[]}
 */
export function resolveRange(ctx, fromIso, toIso) {
  const n = daysBetween(fromIso, toIso);
  if (n === null) throw new Error(`resolveRange: bad dates ${fromIso}..${toIso}`);
  if (n < 0) return [];
  if (n + 1 > RANGE_CAP) throw new Error(`resolveRange: ${n + 1} days exceeds the ${RANGE_CAP}-day cap`);
  return Array.from({ length: n + 1 }, (_, i) => resolveDay(ctx, addDaysIso(fromIso, i)));
}

/**
 * The retro picker's rows: dates in [today-daysBack, today-1] with owed != null,
 * newest first. Row shape matches findUntickedRecent's so RetroPickerSheet is unchanged.
 * @param {DayContext} ctx
 * @param {{ daysBack?: number }} [opts]
 */
export function owedDays(ctx, { daysBack = 7 } = {}) {
  const out = [];
  for (let i = 1; i <= daysBack; i++) {
    const st = resolveDay(ctx, addDaysIso(ctx.todayIso, -i));
    if (!st.owed) continue;
    /** @type {any} */
    const meta = sessionMetaForDate(st.iso, weekIn(ctx, st.iso)) || {};
    const s = st.session !== null ? SESSIONS[st.session] : null;
    out.push({
      date: st.iso,
      ...meta,
      type: st.planned,
      action: st.owed,
      sessionIdx: st.session,
      sessionName: s ? s.name : (st.plannedDay?.label || meta.sessionName || st.planned),
      sessionSubtitle: s ? s.subtitle || null : null,
    });
  }
  return out;
}

/**
 * Dates in [from, to] where the user showed up (did != null), and the dates
 * inside a breather. Input to absence detection. Walks the indexes, not the
 * calendar, so a long window is cheap and uncapped.
 * @param {DayContext} ctx
 * @param {string} fromIso
 * @param {string} toIso
 * @returns {{ active: string[], resting: string[] }}
 */
export function activityInRange(ctx, fromIso, toIso) {
  const inRange = (iso) => ISO_DATE.test(iso) && iso >= fromIso && iso <= toIso;
  const candidates = new Set([...Object.keys(ctx.recordsOn), ...Object.keys(ctx.days || {})].filter(inRange));
  const active = [...candidates].filter((iso) => didOn(ctx, iso) !== null).sort();
  const resting = new Set();
  for (const b of ctx.breakSpans) {
    const start = b.start > fromIso ? b.start : fromIso;
    for (let iso = start; iso <= toIso && (b.end === null || iso < b.end); iso = addDaysIso(iso, 1)) resting.add(iso);
  }
  return { active, resting: [...resting].sort() };
}

// A strength-planned date counts as expected once it is past (today only
// when done — today is due, not missed), and not while resting unless it
// was trained anyway.
const expectedStrength = (d) => d.planned === "strength" && (d.done || (d.when === "past" && !d.resting));

/**
 * StreakLine numbers over the calendar window [today-(n-1), today].
 * @param {DayContext} ctx
 * @param {{ days?: number }} [opts]
 * @returns {{ completed: number, expected: number, ratio: number }}
 */
export function strengthRhythm(ctx, { days = 28 } = {}) {
  const range = resolveRange(ctx, addDaysIso(ctx.todayIso, -(days - 1)), ctx.todayIso);
  const completed = range.filter((d) => d.did?.kind === "strength").length;
  const expected = range.filter(expectedStrength).length;
  return { completed, expected, ratio: Math.min(1, completed / Math.max(1, expected)) };
}

/**
 * Per ISO week, newest last, each judged by its own schedule(s). planned
 * excludes resting days; plannedSoFar stops at today (the current week is
 * partial). done is history-only: the Lab is an analytics surface. resting
 * is the number of the week's days inside a breather.
 * @param {DayContext} ctx
 * @param {{ weeks?: number }} [opts]
 * @returns {{ mondayIso: string, planned: number, plannedSoFar: number, done: number, resting: number, partial: boolean }[]}
 */
export function weeklyStrength(ctx, { weeks = 8 } = {}) {
  const thisMonday = mondayOfWeekIso(ctx.todayIso);
  const out = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const mondayIso = addDaysIso(thisMonday, -7 * w);
    const days = resolveIsoWeek(ctx, mondayIso);
    out.push({
      mondayIso,
      planned: days.filter((d) => d.planned === "strength" && (d.done || !d.resting)).length,
      plannedSoFar: days.filter(expectedStrength).length,
      done: days.filter((d) => d.did?.kind === "strength" && d.did.source === "history").length,
      resting: days.filter((d) => d.resting).length,
      partial: w === 0,
    });
  }
  return out;
}

/**
 * Back-compat wrapper for the home strip: unchanged call signature, optional breaks.
 * @param {{ mondayIso: string, todayIdx: number, history?: any[], days?: Record<string, any>,
 *   weekFor: (iso: string) => any[] | null, breaks?: any[] }} input
 * @returns {DayState[]}
 */
export function resolveWeek({ mondayIso, todayIdx, history = [], days = {}, weekFor, breaks = [] }) {
  const ctx = makeDayContext({ todayIso: addDaysIso(mondayIso, todayIdx), history, days, breaks, weekFor });
  const week = resolveRange(ctx, mondayIso, addDaysIso(mondayIso, 6));
  // The strip keeps its current letters (logged, else the projection
  // anchored on today) until it reads the shared context directly.
  const projected = projectStrengthDaySessions(week.map((d) => d.plannedDay), history, todayIdx);
  return week.map((d, i) => {
    const logged = d.did?.kind === "strength" && i <= todayIdx ? d.did.sessionIdx : null;
    const session = logged != null ? logged : d.planned === "strength" && projected[i] !== undefined ? projected[i] : null;
    return session === d.session ? d : { ...d, session };
  });
}

/** The { weekIdx: sessionIdx } map the home screen reads. */
export const sessionsFrom = (week) =>
  Object.fromEntries(week.map((d, i) => [i, d.session]).filter(([, s]) => s !== null && s < SESSIONS.length));
