// Home consumers moved onto lib/day-state.js. Each moved site runs its old
// derivation (copied here as a fixture) against the day-context answer over
// varied stores, and the two must match exactly.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  isStrengthRecord,
  makeDayContext, resolveDay, resolveRange, owedDays, sessionsFrom, beginSessionIdx,
} from "../lib/day-state.js";
import { addDaysIso, mondayIndex, mondayOfWeekIso } from "../lib/dates.js";
import { WEEK, projectStrengthDaySessions, nextStrengthIdx, sessionMetaForDate } from "../lib/programme.js";

const S = (t) => ({ type: t, label: t });
const weekOf = (...types) => types.map(S);
const MWF = weekOf("strength", "rest", "strength", "rest", "strength", "rest", "rest");
const TWO = weekOf("rest", "strength", "zone2", "rest", "strength", "cardio", "rest");
const FOUR = weekOf("strength", "strength", "cardio", "strength", "zone2", "strength", "rest");
const NONE = weekOf("rest", "zone2", "rest", "cardio", "rest", "hiit", "rest");

// Live records are timestamped at log time; retro ones at noon UTC of the date.
const live = (date, letter, hh = "18") => ({ id: `${date}T${hh}:00:00.000Z`, date, session: `strength-${letter}` });
const retro = (date, letter) => ({ ...live(date, letter, "12"), retrospective: true });

const START = "2026-09-07"; // a Monday
const D = (n) => addDaysIso(START, n);

// Schedules: fixed, or edited mid-week (the edit is effective from Wednesday).
const SCHEDULES = {
  default: { userWeek: WEEK, weekFor: () => WEEK },
  mwf: { userWeek: MWF, weekFor: () => MWF },
  two: { userWeek: TWO, weekFor: () => TWO },
  four: { userWeek: FOUR, weekFor: () => FOUR },
  none: { userWeek: NONE, weekFor: () => NONE },
  editedMidWeek: { userWeek: FOUR, weekFor: (iso) => (iso >= D(9) ? FOUR : MWF) },
};

const HISTORIES = {
  empty: [],
  steady: [live(D(0), "a"), live(D(2), "b"), live(D(4), "c"), live(D(7), "a")],
  missedDays: [live(D(0), "a"), live(D(7), "b")],
  // Retro-logged after later live sessions, so append order ≠ date order.
  retroLogged: [live(D(0), "a"), live(D(4), "c"), retro(D(2), "b"), live(D(9), "a"), retro(D(7), "c")],
  doubles: [live(D(2), "a", "08"), live(D(2), "b", "19"), live(D(3), "c")],
  // A merge echo: the same record twice.
  echo: [live(D(1), "b"), live(D(1), "b"), live(D(8), "c")],
  letterOnly: [live(D(0), "a"), { id: `${D(3)}T09:00:00.000Z`, date: D(3), session: "travel_b", scheduledLetter: "B" }],
  doneToday: [live(D(0), "a"), live(D(10), "b"), live(D(11), "c")],
};

const DAYS = {
  none: {},
  ticks: {
    [D(1)]: { completedType: "zone2", scheduledType: "zone2" },
    [D(3)]: { completedType: "cardio", scheduledType: "cardio" },
    [D(9)]: { completedType: "cardio", scheduledType: "strength" },
    [D(11)]: { completedType: "strength", scheduledType: "strength" }, // legacy strength tick
  },
  unsynced: { [D(10)]: { sessionId: `${D(10)}T18:00:00.000Z`, completedType: "strength" } },
  bonus: { [D(5)]: { marks: { bonus: true }, scheduledType: "cardio", completedType: null } },
};

const BREAKS = {
  none: [],
  closed: [{ start: `${D(4)}T08:00:00.000Z`, endedAt: `${D(8)}T08:00:00.000Z` }],
  open: [{ start: `${D(9)}T08:00:00.000Z`, endedAt: null }],
};

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const ONLY_EMPTY = { days: { none: {} }, breaks: { none: [] } };

// Each test takes the slice of this product that can change its answer; owedDays
// and sessionMetaForDate are slow enough that the full product risks the timeout.
function* fixtures({ todays = range(0, 16), days = DAYS, breaks = BREAKS } = {}) {
  for (const [sk, sched] of Object.entries(SCHEDULES))
    for (const [hk, history] of Object.entries(HISTORIES))
      for (const [dk, dayStore] of Object.entries(days))
        for (const [bk, breakList] of Object.entries(breaks))
          for (const t of todays)
            yield { sk, hk, label: `${sk}/${hk}/${dk}/${bk}/D${t}`, todayIso: D(t), history, days: dayStore, breaks: breakList, ...sched };
}
const ctxOf = (f) => makeDayContext({ todayIso: f.todayIso, history: f.history, days: f.days, breaks: f.breaks, weekFor: f.weekFor });

// ForgeApp before the move: the week projection anchored on today's weekday,
// indexed at today, falling back to the cycle (userWeek = the saved week).
function oldBeginLetter({ userWeek, history, todayIso }) {
  const todayIdx = mondayIndex(todayIso);
  const strengthDaySessions = projectStrengthDaySessions(userWeek, history, todayIdx);
  return strengthDaySessions[todayIdx] ?? nextStrengthIdx(history);
}

describe("Begin's session letter", () => {
  // Neither side reads days or breaks: only schedule x history x today matter.
  it("matches the old week-projection derivation on every fixture", () => {
    let n = 0;
    for (const f of fixtures(ONLY_EMPTY)) {
      expect(beginSessionIdx(ctxOf(f)), f.label).toBe(oldBeginLetter(f));
      n++;
    }
    expect(n).toBe(6 * 8 * 17);
  });

  it("is today's previewed session wherever Begin is shown (strength planned, not done)", () => {
    let shown = 0;
    // Days and breaks decide done/shown; one week of todays covers every weekday.
    for (const f of fixtures({ todays: range(7, 13) })) {
      const ctx = ctxOf(f);
      const today = resolveDay(ctx, f.todayIso);
      if (today.done || today.shown?.type !== "strength") continue;
      const monday = mondayOfWeekIso(f.todayIso);
      const preview = sessionsFrom(resolveRange(ctx, monday, addDaysIso(monday, 6)))[mondayIndex(f.todayIso)];
      expect(beginSessionIdx(ctx), f.label).toBe(preview);
      shown++;
    }
    expect(shown).toBeGreaterThan(1000);
  });
});

describe("retro letter (left on sessionMetaForDate)", () => {
  it("every owed strength row carries the letter the retro sheet and submit derive", () => {
    let rows = 0;
    // The sheet's letter depends only on schedule, history and date.
    const metaMemo = new Map();
    const metaFor = (f, date) => {
      const key = `${f.sk}/${f.hk}/${date}`;
      if (!metaMemo.has(key)) metaMemo.set(key, sessionMetaForDate(date, f.weekFor(date) || WEEK, f.history));
      return metaMemo.get(key);
    };
    // Todays D7 and D14 with daysBack 7 cover every date D0..D13 once.
    for (const f of fixtures({ todays: [7, 14] })) {
      for (const row of owedDays(ctxOf(f), { daysBack: 7 })) {
        if (row.action !== "log") continue;
        const meta = metaFor(f, row.date);
        expect(meta?.type, `${f.label} ${row.date}`).toBe("strength");
        expect(row.sessionIdx, `${f.label} ${row.date}`).toBe(meta.sessionIdx);
        rows++;
      }
    }
    expect(rows).toBeGreaterThan(1000);
  });
});

describe("week edits re-resolve today", () => {
  it("a cardio tick stops satisfying today once today is edited to strength", () => {
    const today = D(2);
    const days = { [today]: { completedType: "cardio", scheduledType: "cardio" } };
    const before = resolveDay(makeDayContext({ todayIso: today, days, weekFor: () => weekOf("rest", "rest", "cardio", "rest", "rest", "rest", "rest") }), today);
    const after = resolveDay(makeDayContext({ todayIso: today, days, weekFor: () => weekOf("rest", "rest", "strength", "rest", "rest", "rest", "rest") }), today);
    expect(before.done).toBe(true);
    expect(after.done).toBe(false);
    expect(after.status).toBe("due");
  });

  it("ForgeApp reads Begin's letter off the day context and re-keys it on both week handlers", () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../components/ForgeApp.jsx"), "utf8");
    expect(src).toMatch(/const todaySessionIdx = beginSessionIdx\(dayCtx\);/);
    expect(src).not.toMatch(/projectStrengthDaySessions/);
    for (const name of ["handleSaveWeek", "handleResetWeek"]) {
      const start = src.indexOf(`const ${name} =`);
      const body = src.slice(start, src.indexOf("\n  };", start));
      expect(body, name).toMatch(/\bbumpDays\(\);/);
    }
  });
});

describe("the Back at it gap", () => {
  it("SessionHost recognises a prior strength day by the day-state rule, letter-only records included", () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../components/SessionHost.jsx"), "utf8");
    expect(src).toMatch(/import \{ isStrengthRecord \} from "@\/lib\/day-state";/);
    expect(src).toMatch(/\.filter\(r => r\?\.date && isStrengthRecord\(r\)\)/);
    expect(src).not.toMatch(/startsWith\("strength"\)/);
    // A travel session logged under its letter counts as training, as it does on the home week.
    expect(isStrengthRecord({ date: "2026-09-21", session: "travel_b", scheduledLetter: "B" })).toBe(true);
  });
});
