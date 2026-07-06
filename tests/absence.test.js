// tests/absence.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Semantics lock for lib/absence.js. These tests ARE the specification —
// absence is derived (never stored), measured in quiet days against the
// user's cadence, and symmetric between closed and ongoing gaps. If a
// change here is needed, the design in docs/absence-modelling.md moved.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { detectAbsences, absencesFromHistory, absenceThresholdDays, weeklySlotsFromWeek, MIN_ABSENCE_DAYS } from "../lib/absence.js";

describe("weeklySlotsFromWeek — non-rest days are the cadence denominator", () => {
  it("counts every non-rest day, conditioning included", () => {
    const week = [
      { s: "M", type: "strength" }, { s: "T", type: "zone2" }, { s: "W", type: "strength" },
      { s: "T", type: "cardio" }, { s: "F", type: "strength" }, { s: "S", type: "hiit" }, { s: "S", type: "rest" },
    ];
    expect(weeklySlotsFromWeek(week)).toBe(6);
  });

  it("a pure 3-day strength week counts 3", () => {
    const week = [
      { s: "M", type: "strength" }, { s: "T", type: "rest" }, { s: "W", type: "strength" },
      { s: "T", type: "rest" }, { s: "F", type: "strength" }, { s: "S", type: "rest" }, { s: "S", type: "rest" },
    ];
    expect(weeklySlotsFromWeek(week)).toBe(3);
  });

  it("falls back to 3 on null/empty/all-rest/garbage", () => {
    expect(weeklySlotsFromWeek(null)).toBe(3);
    expect(weeklySlotsFromWeek([])).toBe(3);
    expect(weeklySlotsFromWeek([{ type: "rest" }, { type: "rest" }])).toBe(3);
    expect(weeklySlotsFromWeek([{}, null, { s: "x" }])).toBe(3);
  });
});

describe("absenceThresholdDays — cadence-aware, floored", () => {
  it("scales with schedule: sparser weeks tolerate longer quiet", () => {
    expect(absenceThresholdDays(3)).toBe(6);  // ceil(7/3 * 2) + 1 = 6
    expect(absenceThresholdDays(2)).toBe(8);  // ceil(3.5 * 2) + 1 = 8
    expect(absenceThresholdDays(1)).toBe(15); // once-a-week: two misses ≈ two weeks
  });

  it("floors at MIN_ABSENCE_DAYS so a 6x athlete's long weekend never flags", () => {
    expect(absenceThresholdDays(6)).toBe(MIN_ABSENCE_DAYS);
    expect(absenceThresholdDays(7)).toBe(MIN_ABSENCE_DAYS);
  });

  it("survives degenerate slots", () => {
    expect(absenceThresholdDays(0)).toBe(15);
    expect(absenceThresholdDays(undefined)).toBe(15);
  });
});

describe("detectAbsences — closed gaps", () => {
  const base = { weeklySlots: 3, today: "2026-07-06" };

  it("a normal training rhythm produces no absences", () => {
    const r = detectAbsences({ ...base, activityDates: ["2026-06-29", "2026-07-01", "2026-07-03", "2026-07-06"] });
    expect(r.absences).toEqual([]);
    expect(r.current).toBeNull();
  });

  it("one missed slot is life, not an absence (quiet < threshold)", () => {
    // 5 quiet days at 3x/week (threshold 6) — under it.
    const r = detectAbsences({ ...base, activityDates: ["2026-06-25", "2026-07-01", "2026-07-06"] });
    expect(r.absences).toEqual([]);
  });

  it("two missed slots is an absence, with honest boundaries", () => {
    // Jun 20 → Jul 1: 10 quiet days between.
    const r = detectAbsences({ ...base, activityDates: ["2026-06-20", "2026-07-01", "2026-07-06"] });
    expect(r.absences).toHaveLength(1);
    const a = r.absences[0];
    expect(a.start).toBe("2026-06-21");
    expect(a.end).toBe("2026-06-30");
    expect(a.days).toBe(10);
    expect(a.ongoing).toBe(false);
    expect(a.missedSessions).toBe(4); // 10 / (7/3) ≈ 4.3 → 4
    expect(r.current).toBeNull();
  });

  it("multiple distinct gaps each register once", () => {
    const r = detectAbsences({
      ...base,
      activityDates: ["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-07-04", "2026-07-06"],
    });
    expect(r.absences.filter(a => !a.ongoing)).toHaveLength(3);
  });

  it("duplicates and unsorted input don't distort anything", () => {
    const r = detectAbsences({
      ...base,
      activityDates: ["2026-07-01", "2026-06-20", "2026-07-01", "2026-07-06", "2026-06-20"],
    });
    expect(r.absences).toHaveLength(1);
    expect(r.absences[0].days).toBe(10);
  });
});

describe("detectAbsences — ongoing absence", () => {
  it("quiet-through-today crossing the threshold is current", () => {
    const r = detectAbsences({ activityDates: ["2026-06-20"], weeklySlots: 3, today: "2026-07-06" });
    expect(r.current).not.toBeNull();
    expect(r.current.ongoing).toBe(true);
    expect(r.current.start).toBe("2026-06-21");
    expect(r.current.end).toBeNull();
    expect(r.current.days).toBe(16);
    expect(r.daysSinceLastActivity).toBe(16);
  });

  it("trained recently → not current, even with old gaps behind", () => {
    const r = detectAbsences({
      activityDates: ["2026-05-01", "2026-06-20", "2026-07-05"],
      weeklySlots: 3,
      today: "2026-07-06",
    });
    expect(r.current).toBeNull();
    // May→Jun (49 quiet) and Jun 20→Jul 5 (14 quiet) are BOTH absences —
    // every closed gap is judged, not just the biggest.
    expect(r.absences.filter(a => !a.ongoing)).toHaveLength(2);
    expect(r.absences.every(a => !a.ongoing)).toBe(true);
  });

  it("the same quiet stretch is judged by the same rule as closed gaps", () => {
    // threshold(3) = 6: 5 quiet days → not yet; 6 → current.
    const notYet = detectAbsences({ activityDates: ["2026-07-01"], weeklySlots: 3, today: "2026-07-06" });
    expect(notYet.current).toBeNull();
    const now = detectAbsences({ activityDates: ["2026-06-30"], weeklySlots: 3, today: "2026-07-06" });
    expect(now.current).not.toBeNull();
  });

  it("cadence changes the verdict for the identical quiet stretch", () => {
    const args = { activityDates: ["2026-06-30"], today: "2026-07-06" }; // 6 quiet days
    expect(detectAbsences({ ...args, weeklySlots: 6 }).current).not.toBeNull(); // threshold 5
    expect(detectAbsences({ ...args, weeklySlots: 2 }).current).toBeNull();     // threshold 8
  });
});

describe("detectAbsences — you cannot be absent from a practice you haven't started", () => {
  it("no activity at all → nothing", () => {
    const r = detectAbsences({ activityDates: [], weeklySlots: 3, today: "2026-07-06" });
    expect(r.absences).toEqual([]);
    expect(r.current).toBeNull();
    expect(r.daysSinceLastActivity).toBeNull();
  });
});

describe("absencesFromHistory — the Lab-facing convenience", () => {
  it("derives dates from records and merges extraDates (HIIT ticks count as presence)", () => {
    const history = [{ date: "2026-06-26" }, { date: "2026-07-06" }];
    const withoutTicks = absencesFromHistory(history, { weeklySlots: 3, today: "2026-07-06" });
    expect(withoutTicks.absences).toHaveLength(1); // 9 quiet days
    // A marked HIIT day mid-gap splits it below threshold on both sides
    // (4 quiet + 4 quiet at threshold 6) — presence is presence.
    const withTicks = absencesFromHistory(history, {
      weeklySlots: 3, today: "2026-07-06", extraDates: ["2026-07-01"],
    });
    expect(withTicks.absences).toEqual([]);
  });

  it("tolerates malformed records", () => {
    const r = absencesFromHistory([{ date: "2026-07-01" }, {}, { date: null }], { weeklySlots: 3, today: "2026-07-06" });
    expect(r.daysSinceLastActivity).toBe(5);
  });
});
