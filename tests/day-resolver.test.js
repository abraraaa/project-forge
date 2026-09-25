// The day resolver (lib/day-state.js) for any date: coverage, breathers,
// letters, the retro picker's rows and the adherence counters. The parity
// suite runs every findUntickedRecent fixture through both implementations;
// where they differ it is a named design decision, asserted as such.
import { describe, it, expect, vi } from "vitest";
import {
  makeDayContext, resolveDay, resolveWeek, resolveRange, owedDays, activityInRange,
  strengthRhythm, weeklyStrength, isStrengthRecord,
} from "../lib/day-state.js";
import { mondayIndex } from "../lib/dates.js";
import { findUntickedRecent, findRecentDays, sessionMetaForDate, WEEK } from "../lib/programme.js";

const S = (t) => ({ type: t, s: t, label: t });
const weekOf = (...types) => types.map(S);
const MWF = weekOf("strength", "rest", "strength", "rest", "strength", "rest", "rest");
const rec = (date, letter = null, id = `${date}T10:00`) =>
  ({ id, date, session: letter ? `strength_${letter.toLowerCase()}` : "strength-a", ...(letter ? { scheduledLetter: letter } : {}) });

// The old implementation reads the clock; pin it to the fixture's today.
function legacy(today, history, daysBack, dayDone, opts) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${today}T12:00:00`));
  try {
    return findUntickedRecent(history, daysBack, dayDone, opts);
  } finally { vi.useRealTimers(); }
}
const rows = (list) => list.map((r) => [r.date, r.type, r.action]);
const owed = (today, history, daysBack, { days = {}, weekFor, breaks = [] } = {}) =>
  owedDays(makeDayContext({ todayIso: today, history, days, breaks, weekFor }), { daysBack });
// dayDone as the app builds it: a tick of the day's own planned type.
const ticksFor = (dayDone, weekFor) => Object.fromEntries(Object.keys(dayDone).map((iso) => {
  return [iso, { completedType: weekFor(iso)[mondayIndex(iso)].type }];
}));

describe("parity with findUntickedRecent", () => {
  describe("surface logic fixtures", () => {
    it("default week, empty history: identical rows", () => {
      const weekFor = () => WEEK;
      const old = legacy("2026-09-25", [], 3, {}, { weekFor });
      expect(rows(owed("2026-09-25", [], 3, { weekFor }))).toEqual(rows(old));
      expect(rows(old)).toEqual([
        ["2026-09-24", "cardio", "tick"], ["2026-09-23", "strength", "log"], ["2026-09-22", "zone2", "tick"],
      ]);
    });

    it("an unticked z2 day fires; a tick clears it", () => {
      const week = weekOf("rest", "z2", "strength", "rest", "rest", "rest", "rest");
      const weekFor = () => week;
      const today = "2026-06-17";
      expect(rows(owed(today, [], 3, { weekFor }))).toEqual(rows(legacy(today, [], 3, {}, { week })));
      expect(rows(owed(today, [], 3, { weekFor }))).toEqual([["2026-06-16", "z2", "tick"]]);
      const dayDone = { "2026-06-16": true };
      expect(owed(today, [], 3, { weekFor, days: ticksFor(dayDone, weekFor) })).toEqual([]);
      expect(legacy(today, [], 3, dayDone, { week })).toEqual([]);
    });

    it("Monday: last week's unlogged Thursday appears only with daysBack=7", () => {
      const week = weekOf("rest", "rest", "rest", "strength", "rest", "rest", "rest");
      const weekFor = () => week;
      for (const back of [3, 7]) {
        expect(rows(owed("2026-06-15", [], back, { weekFor }))).toEqual(rows(legacy("2026-06-15", [], back, {}, { week })));
      }
      expect(rows(owed("2026-06-15", [], 7, { weekFor }))).toEqual([["2026-06-11", "strength", "log"]]);
    });
  });

  describe("per-week strength cap fixtures (Sun 21 Jun, Mon/Wed/Fri strength)", () => {
    const three = [
      { type: "strength" }, { type: "cardio" }, { type: "strength" },
      { type: "cardio" }, { type: "strength" }, { type: "zone2" }, { type: "rest" },
    ];
    const weekFor = () => three;
    const sx = (date) => ({ v: 2, id: `${date}T10:00:00.000Z`, date, session: "strength_a", blocks: [] });
    const both = (history) => [
      rows(owed("2026-06-21", history, 7, { weekFor })),
      rows(legacy("2026-06-21", history, 7, {}, { week: three })),
    ];
    const strengthOnly = (r) => r.filter(([, t]) => t === "strength");

    it("quota met: identical rows", () => {
      const [now, old] = both([sx("2026-06-15"), sx("2026-06-17"), sx("2026-06-19")]);
      expect(now).toEqual(old);
      expect(strengthOnly(now)).toEqual([]);
    });

    it("quota not met: identical rows, Wed and Fri offered", () => {
      const [now, old] = both([sx("2026-06-15")]);
      expect(now).toEqual(old);
      expect(strengthOnly(now).map(([d]) => d)).toEqual(["2026-06-19", "2026-06-17"]);
    });

    it("decision (a): shortfall rows match; strength on a cardio day no longer leaves a tick row", () => {
      const [now, old] = both([sx("2026-06-16"), sx("2026-06-18")]);
      expect(strengthOnly(now)).toEqual(strengthOnly(old));
      expect(strengthOnly(now)).toEqual([["2026-06-19", "strength", "log"]]);
      expect(old.filter(([d]) => d === "2026-06-16" || d === "2026-06-18")).toHaveLength(2);
      expect(now.filter(([d]) => d === "2026-06-16" || d === "2026-06-18")).toEqual([]);
    });

    it("decision (a): short by nothing — nothing owed, and the trained cardio/zone2 days are done", () => {
      const [now, old] = both([sx("2026-06-16"), sx("2026-06-18"), sx("2026-06-20")]);
      expect(strengthOnly(old)).toEqual([]);
      expect(old.map(([d]) => d)).toEqual(["2026-06-20", "2026-06-18", "2026-06-16"]);
      expect(now).toEqual([]);
    });

    it("decision (a): schedule shifted to Tue/Thu/Sat — no dupes, and the old logs' cardio days are done", () => {
      const shifted = [
        { type: "cardio" }, { type: "strength" }, { type: "cardio" },
        { type: "strength" }, { type: "cardio" }, { type: "strength" }, { type: "rest" },
      ];
      const history = [sx("2026-06-15"), sx("2026-06-17"), sx("2026-06-19")];
      const old = rows(legacy("2026-06-21", history, 7, {}, { week: shifted }));
      expect(strengthOnly(old)).toEqual([]);
      expect(old.map(([d, t]) => [d, t])).toEqual([["2026-06-19", "cardio"], ["2026-06-17", "cardio"], ["2026-06-15", "cardio"]]);
      expect(owed("2026-06-21", history, 7, { weekFor: () => shifted })).toEqual([]);
    });
  });

  describe("weekFor fixtures — past days keep their meaning", () => {
    const cardioWeek = Array(7).fill({ type: "cardio" });
    const strengthWeek = Array(7).fill({ type: "strength" });
    const sx = (date) => ({ v: 2, id: `${date}T10:00:00.000Z`, date, session: "strength_a", blocks: [] });

    it("planned types follow the schedule effective on each date", () => {
      const weekFor = (d) => (d >= "2026-06-19" ? strengthWeek : cardioWeek);
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-21T12:00:00"));
      let old;
      try { old = findRecentDays([], 3, { order: "asc", weekFor }); } finally { vi.useRealTimers(); }
      const ctx = makeDayContext({ todayIso: "2026-06-21", weekFor });
      expect(resolveRange(ctx, "2026-06-18", "2026-06-20").map((d) => [d.iso, d.planned]))
        .toEqual(old.map((r) => [r.date, r.type]));
    });

    it("tick for a day that was cardio then, log for the new strength day: identical", () => {
      const weekFor = (d) => (d >= "2026-06-20" ? strengthWeek : cardioWeek);
      const now = rows(owed("2026-06-21", [], 2, { weekFor }));
      expect(now).toEqual(rows(legacy("2026-06-21", [], 2, {}, { weekFor })));
      expect(now).toEqual([["2026-06-20", "strength", "log"], ["2026-06-19", "cardio", "tick"]]);
    });

    it("per-week cap follows each week's own schedule: identical", () => {
      const three = [
        { type: "strength" }, { type: "cardio" }, { type: "strength" },
        { type: "cardio" }, { type: "strength" }, { type: "rest" }, { type: "rest" },
      ];
      const six = [...Array(6).fill({ type: "strength" }), { type: "rest" }];
      const weekFor = (d) => (d >= "2026-06-15" ? six : three);
      const history = [sx("2026-06-08"), sx("2026-06-10"), sx("2026-06-12")];
      const now = rows(owed("2026-06-16", history, 7, { weekFor }));
      expect(now).toEqual(rows(legacy("2026-06-16", history, 7, {}, { weekFor })));
      expect(now.filter(([, t]) => t === "strength").map(([d]) => d)).toEqual(["2026-06-15"]);
    });
  });

  describe("judged against what was due so far (MWF, Mon 21 Sep)", () => {
    const weekFor = () => MWF;
    const cases = [
      ["2026-09-23", [rec("2026-09-22")], []],
      ["2026-09-25", [rec("2026-09-22"), rec("2026-09-24")], []],
      ["2026-09-25", [], ["2026-09-23", "2026-09-21"]],
      ["2026-09-25", [rec("2026-09-21")], ["2026-09-23"]],
      ["2026-09-23", [rec("2026-09-23")], ["2026-09-21"]],
      ["2026-09-22", [rec("2026-09-22")], []],
    ];
    it.each(cases)("today %s: identical rows, this week's owed as pinned", (today, history, thisWeek) => {
      const now = owed(today, history, 7, { weekFor });
      expect(rows(now)).toEqual(rows(legacy(today, history, 7, {}, { week: MWF, weekFor })));
      expect(now.filter((r) => r.date >= "2026-09-21").map((r) => r.date)).toEqual(thisWeek);
    });
  });

  describe("documented differences", () => {
    it("decision (b): a Days sessionId without history is done, not offered as a log", () => {
      const days = { "2026-09-23": { completedType: "strength", sessionId: "s1" } };
      expect(rows(legacy("2026-09-25", [rec("2026-09-21")], 7, {}, { weekFor: () => MWF })).map(([d]) => d)).toContain("2026-09-23");
      expect(owed("2026-09-25", [rec("2026-09-21")], 7, { weekFor: () => MWF, days })
        .filter((r) => r.date >= "2026-09-21")).toEqual([]);
    });

    it("decision (c): a mismatched tick after a schedule edit is owed as the day's new type", () => {
      // Tue was cardio when ticked; an edit effective that Tue made it zone2.
      const before = weekOf("strength", "cardio", "strength", "rest", "strength", "rest", "rest");
      const after = weekOf("strength", "zone2", "strength", "rest", "strength", "rest", "rest");
      const weekFor = (d) => (d >= "2026-09-22" ? after : before);
      const history = [rec("2026-09-21"), rec("2026-09-23")];
      expect(legacy("2026-09-24", history, 3, { "2026-09-22": true }, { weekFor })).toEqual([]);
      expect(rows(owed("2026-09-24", history, 3, { weekFor, days: { "2026-09-22": { completedType: "cardio" } } })))
        .toEqual([["2026-09-22", "zone2", "tick"]]);
    });

    it("decision (d): breather days are never owed", () => {
      const breaks = [{ id: "b", start: "2026-09-21", endedAt: null }];
      expect(legacy("2026-09-25", [], 7, {}, { weekFor: () => MWF }).filter((r) => r.date >= "2026-09-21")).toHaveLength(2);
      expect(owed("2026-09-25", [], 7, { weekFor: () => MWF, breaks }).filter((r) => r.date >= "2026-09-21")).toEqual([]);
    });

    it("decision (e): a row's letter is the one logging it retro would write", () => {
      // Last trained C on Fri 18th: the cycle says A next, the weekday map says Wed = B.
      const history = [rec("2026-09-18", "C")];
      const old = legacy("2026-09-24", history, 3, {}, { weekFor: () => MWF });
      const now = owed("2026-09-24", history, 3, { weekFor: () => MWF });
      expect(old.find((r) => r.date === "2026-09-23").sessionIdx).toBe(1);
      const wed = now.find((r) => r.date === "2026-09-23");
      expect(wed.sessionIdx).toBe(sessionMetaForDate("2026-09-23", MWF, history).sessionIdx);
      expect(wed.sessionIdx).toBe(0);
      expect(wed.sessionName).toBe("Strength A");
      expect(wed.dateLabel).toBe(old.find((r) => r.date === "2026-09-23").dateLabel);
    });

    it("decision (f): a legacy strength-typed tick on a strength day counts as done", () => {
      const days = { "2026-09-23": { completedType: "strength" } };
      const history = [rec("2026-09-21")];
      expect(legacy("2026-09-24", history, 3, days, { weekFor: () => MWF }).map((r) => r.date)).toEqual(["2026-09-23"]);
      expect(owed("2026-09-24", history, 3, { weekFor: () => MWF, days })).toEqual([]);
    });

    it("decision (g): a record recognised by its letter (not the strength prefix) counts", () => {
      const lettered = { id: "x", date: "2026-09-23", session: "travel_b", scheduledLetter: "B" };
      expect(isStrengthRecord(lettered)).toBe(true);
      expect(legacy("2026-09-24", [rec("2026-09-21"), lettered], 3, {}, { weekFor: () => MWF }).map((r) => r.date)).toEqual(["2026-09-23"]);
      expect(owed("2026-09-24", [rec("2026-09-21"), lettered], 3, { weekFor: () => MWF })).toEqual([]);
    });

    it("the same record id twice is one session", () => {
      // Old: two copies of Tue's record met a quota of two (Mon + Wed).
      const history = [rec("2026-09-22"), rec("2026-09-22")];
      expect(legacy("2026-09-24", history, 3, {}, { weekFor: () => MWF })).toEqual([]);
      expect(owed("2026-09-24", history, 3, { weekFor: () => MWF }).map((r) => r.date)).toEqual(["2026-09-23"]);
    });
  });
});

describe("covered — the weekly quota, per date", () => {
  const weekFor = () => MWF;
  const ctxAt = (today, history, extra = {}) => makeDayContext({ todayIso: today, history, weekFor, ...extra });

  it("Mon skipped, Tue trained: Mon is covered by Tue, not owed", () => {
    const ctx = ctxAt("2026-09-24", [rec("2026-09-22")]);
    const mon = resolveDay(ctx, "2026-09-21");
    expect(mon).toMatchObject({ covered: true, coveredBy: "2026-09-22", owed: null, status: "covered", done: false });
    expect(resolveDay(ctx, "2026-09-22")).toMatchObject({ done: true, status: "done" });
    // The one surplus went to the oldest miss; Wed is still owed.
    expect(resolveDay(ctx, "2026-09-23")).toMatchObject({ covered: false, owed: "log", status: "missed" });
  });

  it("a second session on a strength day is surplus", () => {
    const ctx = ctxAt("2026-09-24", [rec("2026-09-23", "A", "w1"), rec("2026-09-23", "B", "w2")]);
    expect(resolveDay(ctx, "2026-09-21")).toMatchObject({ covered: true, coveredBy: "2026-09-23" });
    expect(resolveDay(ctx, "2026-09-23").did).toMatchObject({ kind: "strength", count: 2, sessionIdx: 1, recordIds: ["w1", "w2"] });
  });

  it("a surplus dated before the miss still covers it", () => {
    const history = [rec("2026-09-21"), rec("2026-09-22")];
    expect(resolveDay(ctxAt("2026-09-24", history), "2026-09-23")).toMatchObject({ covered: true, coveredBy: "2026-09-22" });
  });

  it("an off-plan session today covers yesterday; today's own session does not", () => {
    expect(resolveDay(ctxAt("2026-09-22", [rec("2026-09-22")]), "2026-09-21").covered).toBe(true);
    expect(resolveDay(ctxAt("2026-09-23", [rec("2026-09-23")]), "2026-09-21").owed).toBe("log");
  });

  it("a strength session on a cardio day makes that day done and still counts toward the week", () => {
    const week = weekOf("strength", "cardio", "strength", "rest", "strength", "rest", "rest");
    const ctx = makeDayContext({ todayIso: "2026-09-24", history: [rec("2026-09-22")], weekFor: () => week });
    expect(resolveDay(ctx, "2026-09-22")).toMatchObject({ done: true, owed: null });
    expect(resolveDay(ctx, "2026-09-22").shown.type).toBe("strength");
    expect(resolveDay(ctx, "2026-09-21").covered).toBe(true);
  });

  it("coverage never crosses a week boundary", () => {
    const ctx = ctxAt("2026-09-29", [rec("2026-09-28", "A", "a"), rec("2026-09-28", "B", "b")]);
    expect(resolveDay(ctx, "2026-09-25")).toMatchObject({ covered: false, owed: "log" });
  });
});

describe("resting — a declared breather", () => {
  const weekFor = () => MWF;

  it("the end is half-open: the endedAt day is a training day again", () => {
    const breaks = [{ id: "b", start: "2026-09-21", endedAt: "2026-09-23" }];
    const ctx = makeDayContext({ todayIso: "2026-09-26", weekFor, breaks });
    expect(resolveDay(ctx, "2026-09-21")).toMatchObject({ resting: true, status: "resting", owed: null });
    expect(resolveDay(ctx, "2026-09-22").resting).toBe(true);
    expect(resolveDay(ctx, "2026-09-23")).toMatchObject({ resting: false, status: "missed", owed: "log" });
  });

  it("an open breather covers today and the future; resting days keep a projected letter", () => {
    const breaks = [{ id: "b", start: "2026-09-22", endedAt: null }];
    const ctx = makeDayContext({ todayIso: "2026-09-23", history: [rec("2026-09-21", "A")], weekFor, breaks });
    expect(resolveDay(ctx, "2026-09-23")).toMatchObject({ resting: true, status: "resting", session: 1 });
    expect(resolveDay(ctx, "2026-09-30")).toMatchObject({ resting: true, session: 1 });
  });

  it("resting misses don't consume surplus", () => {
    const breaks = [{ id: "b", start: "2026-09-21", endedAt: "2026-09-22" }];
    const ctx = makeDayContext({ todayIso: "2026-09-26", history: [rec("2026-09-22")], weekFor, breaks });
    expect(resolveDay(ctx, "2026-09-21").status).toBe("resting");
    expect(resolveDay(ctx, "2026-09-23")).toMatchObject({ covered: true, coveredBy: "2026-09-22" });
    expect(resolveDay(ctx, "2026-09-25").owed).toBe("log");
  });

  it("done wins over resting", () => {
    const breaks = [{ id: "b", start: "2026-09-21", endedAt: null }];
    const ctx = makeDayContext({ todayIso: "2026-09-26", history: [rec("2026-09-23")], weekFor, breaks });
    expect(resolveDay(ctx, "2026-09-23")).toMatchObject({ resting: true, done: true, status: "done" });
  });
});

describe("did — evidence on the date", () => {
  const weekFor = () => MWF;

  it("a Days sessionId without history is a strength did from days, lettered by the cycle", () => {
    const days = { "2026-09-23": { completedType: "strength", sessionId: "s1" } };
    const ctx = makeDayContext({ todayIso: "2026-09-25", history: [rec("2026-09-21", "A")], days, weekFor });
    const wed = resolveDay(ctx, "2026-09-23");
    expect(wed.did).toEqual({ kind: "strength", source: "days", sessionIdx: null, count: 1, travel: false, recordIds: [] });
    expect(wed).toMatchObject({ done: true, owed: null, session: 1 });
  });

  it("history beats Days; travel is flagged", () => {
    const days = { "2026-09-23": { sessionId: "s1" } };
    const history = [{ ...rec("2026-09-23", "C"), travel: true }];
    const d = resolveDay(makeDayContext({ todayIso: "2026-09-25", history, days, weekFor }), "2026-09-23").did;
    expect(d).toMatchObject({ kind: "strength", source: "history", sessionIdx: 2, travel: true });
  });

  it("a tick satisfies only its own type", () => {
    const days = { "2026-09-23": { completedType: "cardio" }, "2026-09-22": { completedType: "rest" } };
    const ctx = makeDayContext({ todayIso: "2026-09-25", days, weekFor });
    expect(resolveDay(ctx, "2026-09-23")).toMatchObject({ done: false, owed: "log", did: { kind: "tick", type: "cardio" } });
    expect(resolveDay(ctx, "2026-09-22").done).toBe(true);
  });

  it("a bonus is display only: never a did, never done, never activity", () => {
    const week = weekOf("strength", "cardio", "strength", "rest", "strength", "rest", "rest");
    const days = { "2026-09-22": { marks: { bonus: true } } };
    const ctx = makeDayContext({ todayIso: "2026-09-25", history: [rec("2026-09-21"), rec("2026-09-23")], days, weekFor: () => week });
    expect(resolveDay(ctx, "2026-09-22")).toMatchObject({ bonus: true, did: null, done: false, owed: "tick" });
    expect(activityInRange(ctx, "2026-09-21", "2026-09-25").active).toEqual(["2026-09-21", "2026-09-23"]);
  });
});

describe("session letters", () => {
  const weekFor = () => MWF;

  it("past hollow strength days take the cycle-before-date letter", () => {
    const history = [rec("2026-09-18", "C"), rec("2026-09-21", "A")];
    const ctx = makeDayContext({ todayIso: "2026-09-26", history, weekFor });
    for (const iso of ["2026-09-23", "2026-09-25"]) {
      expect(resolveDay(ctx, iso).session).toBe(sessionMetaForDate(iso, MWF, history).sessionIdx);
    }
    expect(resolveDay(ctx, "2026-09-23").session).toBe(1);
    expect(resolveDay(ctx, "2026-09-21").session).toBe(0);
    expect(resolveDay(ctx, "2026-09-22").session).toBeNull();
  });

  it("the forward projection walks across the week boundary", () => {
    const ctx = makeDayContext({ todayIso: "2026-09-25", history: [rec("2026-09-23", "A")], weekFor });
    expect(resolveRange(ctx, "2026-09-25", "2026-10-02").filter((d) => d.planned === "strength").map((d) => [d.iso, d.session]))
      .toEqual([["2026-09-25", 1], ["2026-09-28", 2], ["2026-09-30", 0], ["2026-10-02", 1]]);
  });

  it("today done keeps its logged letter and the projection starts after it", () => {
    const ctx = makeDayContext({ todayIso: "2026-09-25", history: [rec("2026-09-25", "B")], weekFor });
    expect(resolveDay(ctx, "2026-09-25").session).toBe(1);
    expect(resolveDay(ctx, "2026-09-28").session).toBe(2);
  });

  it("non-strength days not trained strength have no letter", () => {
    const ctx = makeDayContext({ todayIso: "2026-09-25", weekFor });
    expect(resolveRange(ctx, "2026-09-21", "2026-09-27").filter((d) => d.planned !== "strength").every((d) => d.session === null)).toBe(true);
  });
});

describe("schedule edits: the timeline", () => {
  const OLD = weekOf("strength", "rest", "strength", "rest", "strength", "cardio", "rest");
  const NEW = weekOf("rest", "strength", "rest", "strength", "rest", "strength", "cardio");

  it("an edit never rewrites the past", () => {
    const weekFor = (iso) => (iso >= "2026-09-24" ? NEW : OLD);
    const ctx = makeDayContext({ todayIso: "2026-09-26", weekFor });
    expect(resolveRange(ctx, "2026-09-21", "2026-09-27").map((d) => d.planned))
      .toEqual(["strength", "rest", "strength", "strength", "rest", "strength", "cardio"]);
    expect(resolveDay(ctx, "2026-09-22").owed).toBeNull();
  });

  it("a future-dated edit is honoured on and after its date only", () => {
    const weekFor = (iso) => (iso >= "2026-10-01" ? NEW : OLD);
    const ctx = makeDayContext({ todayIso: "2026-09-25", history: [rec("2026-09-23", "B")], weekFor });
    expect(resolveDay(ctx, "2026-09-30").planned).toBe("strength");
    expect(resolveDay(ctx, "2026-10-01").planned).toBe("strength"); // NEW Thu
    expect(resolveDay(ctx, "2026-10-02").planned).toBe("rest");     // NEW Fri
    // Fri 25 (C), Mon 28 (A), Wed 30 (B), Thu 1 Oct (C) under the edit.
    expect(resolveDay(ctx, "2026-10-01").session).toBe(2);
  });
});

describe("resolveRange", () => {
  const ctx = makeDayContext({ todayIso: "2026-09-25", weekFor: () => MWF });
  it("is inclusive and ascending", () => {
    expect(resolveRange(ctx, "2026-09-27", "2026-09-29").map((d) => [d.iso, d.weekIdx, d.when]))
      .toEqual([["2026-09-27", 6, "future"], ["2026-09-28", 0, "future"], ["2026-09-29", 1, "future"]]);
    expect(resolveRange(ctx, "2026-09-29", "2026-09-27")).toEqual([]);
  });
  it("throws past the 400-day cap", () => {
    expect(() => resolveRange(ctx, "2025-01-01", "2026-09-25")).toThrow(/cap/);
    expect(resolveRange(ctx, "2025-08-22", "2026-09-25")).toHaveLength(400);
  });
  it("never reads the clock", () => {
    const history = [rec("2026-09-21", "A")];
    const snap = () => resolveRange(makeDayContext({ todayIso: "2026-09-25", history, weekFor: () => MWF }), "2026-09-21", "2026-09-27");
    const a = snap();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-01-01T03:00:00"));
    try { expect(snap()).toEqual(a); } finally { vi.useRealTimers(); }
  });
});

describe("activityInRange", () => {
  it("returns did dates and breather dates within the window", () => {
    const days = { "2026-09-24": { completedType: "rest" }, "2026-09-26": { sessionId: "s" }, "2026-08-01": { completedType: "cardio" } };
    const breaks = [{ id: "b", start: "2026-09-10", endedAt: "2026-09-14" }, { id: "c", start: "2026-09-27", endedAt: null }];
    const ctx = makeDayContext({ todayIso: "2026-09-28", history: [rec("2026-09-21")], days, breaks, weekFor: () => MWF });
    expect(activityInRange(ctx, "2026-09-12", "2026-09-28")).toEqual({
      active: ["2026-09-21", "2026-09-24", "2026-09-26"],
      resting: ["2026-09-12", "2026-09-13", "2026-09-27", "2026-09-28"],
    });
  });
});

describe("strengthRhythm", () => {
  it("expected counts scheduled strength days per date across a schedule change (10, not 8)", () => {
    const threeDay = weekOf("strength", "rest", "strength", "rest", "strength", "rest", "rest");
    const twoDay = weekOf("rest", "strength", "rest", "rest", "rest", "strength", "rest");
    const weekFor = (d) => (d >= "2026-09-14" ? twoDay : threeDay);
    expect(strengthRhythm(makeDayContext({ todayIso: "2026-09-27", weekFor })).expected).toBe(10);
  });

  it("today counts only once done; breather days aren't expected; Days-only sessions count", () => {
    const weekFor = () => MWF;
    // Window Sat 29 Aug – Fri 25 Sep with a breather over 1–14 Sep.
    const breaks = [{ id: "b", start: "2026-09-01", endedAt: "2026-09-15" }];
    const base = { weekFor, breaks };
    const undone = strengthRhythm(makeDayContext({ todayIso: "2026-09-25", ...base }));
    // MWF dates in window: 12, minus 6 in the breather, minus today (Fri 25) = 5.
    expect(undone).toEqual({ completed: 0, expected: 5, ratio: 0 });
    const days = { "2026-09-25": { sessionId: "s" } };
    const done = strengthRhythm(makeDayContext({ todayIso: "2026-09-25", history: [rec("2026-09-23")], days, ...base }));
    expect(done).toEqual({ completed: 2, expected: 6, ratio: 2 / 6 });
  });

  it("dedupes same-day sessions and ignores ticks", () => {
    const days = { "2026-09-22": { completedType: "rest" } };
    const history = [rec("2026-09-21", "A", "a"), rec("2026-09-21", "B", "b")];
    const r = strengthRhythm(makeDayContext({ todayIso: "2026-09-25", history, days, weekFor: () => MWF }), { days: 7 });
    expect(r.completed).toBe(1);
  });
});

describe("weeklyStrength", () => {
  it("per-week schedule, partial current week, resting weeks, history-only done", () => {
    const three = weekOf("strength", "rest", "strength", "rest", "strength", "rest", "rest");
    const two = weekOf("rest", "strength", "rest", "rest", "rest", "strength", "rest");
    const weekFor = (d) => (d >= "2026-09-14" ? two : three);
    const breaks = [{ id: "b", start: "2026-09-07", endedAt: "2026-09-14" }];
    const history = [rec("2026-08-31"), rec("2026-09-02"), rec("2026-09-15"), rec("2026-09-22")];
    const days = { "2026-09-19": { sessionId: "s" } };
    const ctx = makeDayContext({ todayIso: "2026-09-23", history, days, breaks, weekFor });
    expect(weeklyStrength(ctx, { weeks: 4 })).toEqual([
      { mondayIso: "2026-08-31", planned: 3, plannedSoFar: 3, done: 2, resting: 0, partial: false },
      { mondayIso: "2026-09-07", planned: 0, plannedSoFar: 0, done: 0, resting: 7, partial: false },
      { mondayIso: "2026-09-14", planned: 2, plannedSoFar: 2, done: 1, resting: 0, partial: false },
      { mondayIso: "2026-09-21", planned: 2, plannedSoFar: 1, done: 1, resting: 0, partial: true },
    ]);
  });
});

describe("resolveWeek wrapper", () => {
  it("carries the new fields (covered, resting) and keeps the strip's current letters", () => {
    // Trained A Mon, skipped Wed, today Fri: the strip still steps Wed back
    // from today's projection; resolveDay gives the retro letter.
    const history = [rec("2026-09-21", "A"), rec("2026-09-22", "B")];
    const breaks = [{ id: "b", start: "2026-09-26", endedAt: null }];
    const w = resolveWeek({ mondayIso: "2026-09-21", todayIdx: 4, history, weekFor: () => MWF, breaks });
    expect(w.map((d) => d.status)).toEqual(["done", "done", "covered", "rest", "due", "resting", "resting"]);
    expect(w[2].session).toBe(1);
    const ctx = makeDayContext({ todayIso: "2026-09-25", history, weekFor: () => MWF, breaks });
    expect(resolveDay(ctx, "2026-09-23").session).toBe(2);
  });
});

describe("review fixes (2026-09-25)", () => {
  const wk = (...types) => types.map((type) => ({ type }));
  const PLAN = wk("strength", "cardio", "strength", "cardio", "strength", "rest", "rest");
  const rec = (date, letter) => ({ id: `${date}T10:00:00.000Z`, date, session: `strength_${letter}`, scheduledLetter: letter.toUpperCase() });

  it("a day already done by a strength tick doesn't take surplus from a genuinely missed day", () => {
    const ctx = makeDayContext({
      todayIso: "2026-09-24", weekFor: () => PLAN,
      history: [rec("2026-09-22", "a")],                     // off-plan Tue = surplus
      days: { "2026-09-21": { completedType: "strength" } },  // Mon done by tick
    });
    expect(resolveDay(ctx, "2026-09-21").done).toBe(true);
    const wed = resolveDay(ctx, "2026-09-23");
    expect(wed.covered).toBe(true);
    expect(wed.owed).toBeNull();
  });

  it("a malformed week from weekFor reads as the default, and rows still carry labels", () => {
    const ctx = makeDayContext({ todayIso: "2026-09-24", weekFor: () => [{ type: "strength" }] });
    const rows = owedDays(ctx, { daysBack: 3 });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(typeof r.dateLabel).toBe("string");
  });

  it("a breather with a malformed end is dropped, not treated as still resting", () => {
    const ctx = makeDayContext({
      todayIso: "2026-09-24", weekFor: () => PLAN,
      breaks: [{ start: "2026-09-10", endedAt: "not-a-date" }],
    });
    expect(resolveDay(ctx, "2026-09-23").resting).toBe(false);
    expect(resolveDay(ctx, "2026-09-23").owed).toBe("log");
  });
});
