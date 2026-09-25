// @ts-check
// lib/absence.js  (date math: lib/dates.js)
// ─────────────────────────────────────────────────────────────────────────────
// Absence modelling — the Lab correctness item ("Lab paints history once;
// doesn't model 'currently off'"), reduced to its simplest true form:
//
//   ABSENCE IS DERIVED, NEVER STORED.
//
// An absence is a pure function of activity dates + the user's cadence.
// Nothing new is written to localStorage, nothing enters the sync payload,
// nothing can corrupt or need repair (design principle #0 satisfied by
// having no store at all). The only absence-related things stored are
// beside it, not in it: which absence's nudge was dismissed (storage.js AN,
// keyed by start date) and, some day, an optional user annotation ("was
// travelling"). See
// the internal design notes for the full model.
//
// SEMANTICS
//   · Absence is measured against the user's SCHEDULE, not the calendar.
//     Someone training 2×/week is not "away" after a quiet long weekend;
//     someone training 6×/week is. The unit is missed expected sessions.
//   · cadenceDays = 7 / weeklySlots — the average spacing between expected
//     sessions (weeklySlots = non-rest days in the effective week).
//   · A gap becomes an absence when it spans at least TWO missed expected
//     sessions: threshold = ceil(cadenceDays * 2) + 1 calendar days,
//     floored at MIN_ABSENCE_DAYS so high-frequency schedules don't flag
//     a weekend off. Missing one slot is life; missing two is a stretch.
//   · The gap between the last activity and TODAY is judged by the same
//     rule → an ongoing absence ({ ongoing: true, end: null }). Today is
//     never a quiet day: it isn't over, so the nudge can't fire on the
//     morning of a planned session.
//   · Days inside a breather are declared rest, not days off: callers pass
//     them as restingDates and they are skipped when counting.
//   · "Activity" is any date the user trained or marked done — callers
//     merge strength history dates with Day-store ticks so a HIIT-only
//     week never reads as away. detectAbsences is agnostic: it takes
//     ISO date strings.
//   · No activity at all → no absences. You cannot be absent from a
//     practice you haven't started; onboarding-not-begun is not a lapse.
//
// VOICE (for consumers): absence is a fact, never a verdict. Copy around
// it follows the away-state register — "a lighter stretch is part of
// training", never an alarm. Consistency over time is the philosophy;
// the model exists so surfaces can be HONEST about gaps, not so they can
// scold.
// ─────────────────────────────────────────────────────────────────────────────

import { todayLocalIso, addDaysIso as addDays, daysBetween } from "./dates.js";
import { activityInRange } from "./day-state.js";

// Floor so a 5–6×/week athlete's long weekend never reads as an absence.
export const MIN_ABSENCE_DAYS = 5;

// Count the trainable slots in an effective week — any non-rest day.
// This is the cadence denominator: activity dates merge strength AND
// conditioning (Day-store ticks), so the schedule's own conditioning days
// must count too, or a 6-day week reads far sparser than it trains. Takes
// the normalised week array W.get() returns (falls back to WEEK when the
// user has no custom schedule); tolerates null/garbage by returning 3, a
// safe mid-frequency default that never divides by zero.
export function weeklySlotsFromWeek(week) {
  if (!Array.isArray(week) || week.length === 0) return 3;
  const slots = week.filter((d) => d && d.type && d.type !== "rest").length;
  return slots > 0 ? slots : 3;
}

// The calendar-day gap that constitutes an absence for a given cadence.
export function absenceThresholdDays(weeklySlots) {
  const slots = Math.max(1, weeklySlots || 0);
  const cadenceDays = 7 / slots;
  return Math.max(Math.ceil(cadenceDays * 2) + 1, MIN_ABSENCE_DAYS);
}

/**
 * Detect absences from a set of activity dates.
 *
 * @param {object} opts
 * @param {string[]} opts.activityDates  ISO "YYYY-MM-DD" dates with any
 *   training activity (strength history dates ∪ marked day-completions).
 *   Order and duplicates don't matter.
 * @param {number} opts.weeklySlots  Non-rest days in the effective week (1–7).
 * @param {string} opts.today  ISO date for "now" — passed in, never read
 *   from the clock here, so the function stays pure and testable.
 * @param {string[]} [opts.restingDates]  Dates inside a declared breather.
 *   Declared rest is not "days off": these are skipped when counting quiet
 *   days, so a closed breather's end acts as a restart point.
 * @returns {{
 *   absences: Array<{start: string, end: string|null, days: number, missedSessions: number, ongoing: boolean}>,
 *   current: {start: string, end: null, days: number, missedSessions: number, ongoing: true} | null,
 *   thresholdDays: number,
 *   daysSinceLastActivity: number | null,
 * }}
 */
export function detectAbsences({ activityDates, weeklySlots, today, restingDates = [] }) {
  const thresholdDays = absenceThresholdDays(weeklySlots);
  const dates = Array.from(new Set(activityDates || []))
    .filter(Boolean)
    .sort();

  if (dates.length === 0) {
    return { absences: [], current: null, thresholdDays, daysSinceLastActivity: null };
  }

  const cadenceDays = 7 / Math.max(1, weeklySlots || 0);
  const resting = new Set(restingDates || []);
  const absences = [];

  // Everything is judged in QUIET DAYS — days with no activity and not
  // inside a breather. A closed gap's quiet days run from the day after the
  // last activity to the day before the return; an ongoing one runs through
  // YESTERDAY — today is still in play, so it is never a day off. Both
  // qualify by the same rule: quietDays >= thresholdDays. start is the first
  // quiet day, so it stays put while the absence lasts (the nudge's
  // dismissal is keyed on it).
  // A breather is a restart point, not just skipped days: quiet days before
  // it close as their own absence (if long enough), and counting after it
  // starts from zero — so "Back to it" never re-fires the nudge for the gap
  // the breather was declared for.
  const judge = (lastActive, until, ongoing) => {
    let start = null;
    let quiet = 0;
    let prev = null;
    const close = (isOngoing, endIso) => {
      if (start !== null && quiet >= thresholdDays) {
        absences.push({
          start,
          end: isOngoing ? null : endIso,
          days: quiet,
          missedSessions: Math.max(1, Math.round(quiet / cadenceDays)),
          ongoing: isOngoing,
        });
      }
      start = null;
      quiet = 0;
    };
    for (let iso = addDays(lastActive, 1); iso < until; iso = addDays(iso, 1)) {
      if (resting.has(iso)) { if (start !== null) close(false, prev); continue; }
      if (start === null) start = iso;
      quiet++;
      prev = iso;
    }
    close(ongoing, addDays(until, -1));
  };

  for (let i = 1; i < dates.length; i++) judge(dates[i - 1], dates[i], false);

  const last = dates[dates.length - 1];
  const sinceLast = Math.max(0, daysBetween(last, today));
  judge(last, today, true);

  const tail = absences[absences.length - 1];
  const current = tail && tail.ongoing ? /** @type {any} */ (tail) : null;

  return { absences, current, thresholdDays, daysSinceLastActivity: sinceLast };
}

/**
 * Convenience for history-only consumers: derive activity dates from
 * strength history records. Callers with Day-store access should merge
 * those dates in via `extraDates` so HIIT/Z2-only weeks count.
 *
 * @param {Array<{date?: string}>} history
 * @param {object} [opts]
 * @param {number} [opts.weeklySlots]
 * @param {string} [opts.today]
 * @param {string[]} [opts.extraDates]
 * @param {string[]} [opts.restingDates]  Breather dates, skipped as quiet days.
 */
export function absencesFromHistory(history, { weeklySlots = 3, today, extraDates = [], restingDates = [] } = {}) {
  const activityDates = [
    ...(history || []).map((r) => r.date).filter(Boolean),
    ...extraDates,
  ];
  const todayIso = today || todayLocalIso();
  return detectAbsences({ activityDates, weeklySlots, today: todayIso, restingDates });
}

/**
 * The Home nudge's absence: the ongoing one, judged from the day context
 * (any did is activity, breather days are skipped, today is never a day
 * off), or null when there is none or it is the one already dismissed.
 *
 * @param {import("./day-state.js").DayContext} ctx
 * @param {{ weeklySlots: number, dismissedStart?: string|null }} opts
 */
export function nudgeAbsence(ctx, { weeklySlots, dismissedStart = null }) {
  // Whole history: the last activity can sit arbitrarily far back.
  const { active, resting } = activityInRange(ctx, "0000-01-01", ctx.todayIso);
  const { current } = detectAbsences({ activityDates: active, restingDates: resting, weeklySlots, today: ctx.todayIso });
  return current && current.start !== dismissedStart ? current : null;
}
