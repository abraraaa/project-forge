// lib/first-run.js: the strength-days week build, the per-count notes and
// the day named on the closing screen.
import { describe, it, expect } from "vitest";
import { WEEK, projectStrengthDaySessions } from "../lib/programme.js";
import { moveStrengthDays, dayNote, strengthDayCount, firstSessionDay } from "../lib/first-run.js";

const types = (w) => w.map((d) => d.type);
const letters = (w, today = 0) => {
  const p = projectStrengthDaySessions(w, [], today);
  return Object.keys(p).map(Number).sort((a, b) => a - b).map((i) => "ABC"[p[i]]).join("");
};

describe("moveStrengthDays", () => {
  it("returns the same week when the chosen days are the strength days", () => {
    expect(moveStrengthDays(WEEK, [4, 0, 2])).toBe(WEEK);
  });

  it("swaps a moved day's type into the day it left (Mon → Tue)", () => {
    const w = moveStrengthDays(WEEK, [1, 2, 4]);
    expect(types(w)).toEqual(["zone2", "strength", "strength", "cardio", "strength", "hiit", "rest"]);
    expect(w[0]).toEqual({ s: "M", label: "Zone 2", type: "zone2" });
    expect(w[1]).toEqual({ s: "T", label: "Strength", type: "strength" });
    expect(WEEK[0].type).toBe("strength"); // input untouched
  });

  it("matches vacated and taken days in weekday order", () => {
    // Mon/Wed/Fri → Tue/Thu/Sat: Mon←Tue's zone2, Wed←Thu's cardio, Fri←Sat's hiit.
    const w = moveStrengthDays(WEEK, [1, 3, 5]);
    expect(types(w)).toEqual(["zone2", "strength", "cardio", "strength", "hiit", "strength", "rest"]);
  });

  it("makes surplus vacated days rest when fewer days are chosen", () => {
    expect(types(moveStrengthDays(WEEK, [0, 4]))).toEqual(["strength", "zone2", "rest", "cardio", "strength", "hiit", "rest"]);
    expect(types(moveStrengthDays(WEEK, [1]))).toEqual(["zone2", "strength", "rest", "cardio", "rest", "hiit", "rest"]);
  });

  it("adds a fourth day without touching the others", () => {
    const w = moveStrengthDays(WEEK, [0, 2, 4, 5]);
    expect(types(w)).toEqual(["strength", "zone2", "strength", "cardio", "strength", "strength", "rest"]);
    expect(w[0]).toBe(WEEK[0]);
  });

  it("works from an edited week", () => {
    const edited = moveStrengthDays(WEEK, [1, 3, 5]);
    const w = moveStrengthDays(edited, [1, 3, 6]);
    expect(types(w)).toEqual(["zone2", "strength", "cardio", "strength", "hiit", "rest", "strength"]);
  });

  it("ignores duplicates and out-of-range indexes", () => {
    expect(moveStrengthDays(WEEK, [0, 0, 2, 4, 9, -1])).toBe(WEEK);
  });

  it("keeps A, B, C in order over whichever days are chosen", () => {
    expect(letters(moveStrengthDays(WEEK, [1, 3, 5]))).toBe("ABC");
    expect(letters(moveStrengthDays(WEEK, [0, 2]))).toBe("AB");
    expect(letters(moveStrengthDays(WEEK, [0, 2, 4, 5]))).toBe("ABCA");
  });
});

describe("strengthDayCount and dayNote", () => {
  it("counts strength days", () => {
    expect(strengthDayCount(WEEK)).toBe(3);
    expect(strengthDayCount(moveStrengthDays(WEEK, []))).toBe(0);
  });

  it("has no note for three days", () => {
    expect(dayNote(3)).toBeNull();
  });

  it("says what one, two and four days do to the round", () => {
    expect(dayNote(1)).toBe("One day: a full round takes three weeks. Progress will be slow.");
    expect(dayNote(2)).toBe("Two days: a full A, B, C round takes a week and a half, so each muscle gets about two-thirds of its weekly work.");
    expect(dayNote(4)).toBe("Four days: the round comes back within the week. About a third more work, so watch recovery.");
  });

  it("asks for at least one day at zero and covers up to seven", () => {
    expect(dayNote(0)).toBe("Pick at least one.");
    for (const n of [5, 6, 7]) expect(dayNote(n)).toMatch(/recovery/);
    expect(dayNote(8)).toBeNull();
  });

  it("never says the old cycle copy", () => {
    for (let n = 0; n <= 7; n++) expect(dayNote(n) || "").not.toMatch(/won't be reached|A again/);
  });
});

describe("firstSessionDay", () => {
  it("is today when today is a strength day", () => {
    expect(firstSessionDay(WEEK, 0)).toBe("today");
    expect(firstSessionDay(WEEK, 4)).toBe("today");
  });

  it("is the next strength day this week", () => {
    expect(firstSessionDay(WEEK, 1)).toBe("Wednesday");
    expect(firstSessionDay(WEEK, 3)).toBe("Friday");
  });

  it("wraps to next week once this week's strength days are past", () => {
    expect(firstSessionDay(WEEK, 5)).toBe("Monday");
    expect(firstSessionDay(moveStrengthDays(WEEK, [1, 3]), 6)).toBe("Tuesday");
  });

  it("matches the day the projection gives A", () => {
    const w = moveStrengthDays(WEEK, [1, 3, 5]);
    const names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    for (let today = 0; today < 7; today++) {
      const p = projectStrengthDaySessions(w, [], today);
      const aIdx = Number(Object.keys(p).find((i) => p[i] === 0));
      expect(firstSessionDay(w, today)).toBe(aIdx === today ? "today" : names[aIdx]);
    }
  });

  it("is null with no strength days", () => {
    expect(firstSessionDay(moveStrengthDays(WEEK, []), 2)).toBeNull();
  });
});
