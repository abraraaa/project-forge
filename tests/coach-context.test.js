// The coaching snapshot: a point-in-time read of someone's training for a chat
// model. Private by construction (no profile name) and honest about its date.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildCoachContext, sessionLine } from "../lib/coach-context.js";

const S = (t) => ({ type: t });
const week = ["strength","rest","strength","rest","strength","rest","rest"].map(S);
const rec = (date, weight, reps = 5) => ({
  id: `${date}T10:00:00`, date, session: "strength-a", readiness: "normal",
  blocks: [{ type: "main", exercises: [{ name: "Barbell Back Squat", muscle: "Quadriceps",
    sets: [1, 2, 3].map(() => ({ weight, reps, rpe: 8, rir: 2 })) }] }],
});
const now = new Date("2026-09-24T12:00:00");

describe("buildCoachContext", () => {
  const text = buildCoachContext({
    history: [rec("2026-09-14", 100), rec("2026-09-21", 105)],
    trainingState: { lifts: { "Barbell Back Squat": { stallSignal: "stall" } } },
    focus: "Strong", mainLifts: { "Hex Bar Deadlift": "Romanian Deadlift" },
    week, bodyweightKg: 84, now,
  });

  it("says it is a snapshot and when", () => {
    expect(text).toContain("2026-09-24");
    expect(text).toMatch(/point-in-time/);
  });
  it("carries the programming principles", () => {
    expect(text).toMatch(/Consistency beats novelty/);
    expect(text).toMatch(/MEV/);
  });
  it("describes setup, lifts, volume and recent sessions", () => {
    expect(text).toContain("Focus: Strong");
    expect(text).toContain("Strength days: Mon, Wed, Fri");
    expect(text).toContain("Romanian Deadlift (for Hex Bar Deadlift)");
    expect(text).toContain("Bodyweight: 84 kg");
    expect(text).toMatch(/Barbell Back Squat: .* kg est\. 1RM over 2 sessions .*· stall/);
    expect(text).toMatch(/## Weekly volume vs landmarks/);
    expect(text).toMatch(/- 2026-09-21 · normal: Barbell Back Squat 105 kg × 5\/5\/5 @RPE 8/);
  });
  it("sessionLine: added load reads '+N kg', a phantom reads nothing", () => {
    const r = { date: "2026-09-10", readiness: "normal", blocks: [{ exercises: [
      { name: "Glute Bridge", loadType: "bodyweight", sets: [
        { weight: 10, reps: 12, rpe: 8, bodyweightUsed: 80, effectiveLoad: 90 },
        { weight: 10, reps: 12, rpe: 8, bodyweightUsed: 80, effectiveLoad: 90 }] },
      { name: "45-Degree Hip Extension", loadType: "bodyweight", sets: [
        { weight: 40, loadType: "bodyweight", bodyweightUsed: 80, effectiveLoad: 80, reps: 15, rpe: 8 }] },
      { name: "Hanging Leg Raise", loadType: "bodyweight", sets: [{ weight: null, reps: 10, rpe: 7 }] },
      { name: "Pull-Up", loadType: "loaded_bodyweight", sets: [{ weight: 10, reps: 8, rpe: 8 }] }] }] };
    const line = sessionLine(r);
    expect(line).toContain("Glute Bridge +10 kg × 12/12 @RPE 8");
    expect(line).toContain("45-Degree Hip Extension × 15 @RPE 8");
    expect(line).toContain("Hanging Leg Raise × 10 @RPE 7");
    expect(line).toContain("Pull-Up +10 kg × 8 @RPE 8");
    expect(line).not.toContain("40 kg");
  });
  it("carries no profile name", () => {
    expect(buildCoachContext({ history: [], now })).not.toMatch(/profile/i);
  });
  it("handles an empty history", () => {
    expect(buildCoachContext({ history: [], now })).toContain("No sessions logged yet.");
  });
});

describe("consistency line (weeklyStrength)", () => {
  const two = ["rest","strength","rest","rest","rest","strength","rest"].map(S);
  // now = Thu 2026-09-24. Mon/Wed/Fri until an edit to Tue/Sat from 09-14;
  // a breather covered the week of 09-07.
  const text = buildCoachContext({
    history: [rec("2026-08-31", 100), rec("2026-09-02", 100), rec("2026-09-15", 100), rec("2026-09-22", 105)],
    week: two, weekFor: (iso) => (iso >= "2026-09-14" ? two : week),
    breaks: [{ id: "b", start: "2026-09-07", endedAt: "2026-09-14" }],
    now,
  });
  const line = text.split("\n")[text.split("\n").findIndex((l) => l.startsWith("## Consistency")) + 2];

  it("judges each week by its own schedule, a breather as a breather, this week as in progress", () => {
    expect(line.split(" · ")).toEqual([
      "0/3", "0/3", "0/3", "0/3", "2/3", "breather", "1/2",
      "1/1 so far (this week, in progress; 2 planned)",
    ]);
  });
  it("defaults every week to the passed schedule when no weekFor is given", () => {
    const flat = buildCoachContext({ history: [rec("2026-09-21", 100)], week, now });
    expect(flat).toMatch(/0\/3 · 1\/2 so far \(this week, in progress; 3 planned\)/);
  });
});

describe("wiring", () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  // The coaching page's side of the shared copy path is a render test:
  // tests/components/CoachView.test.jsx.
  it("profile links to the coaching page; the Lab copies through the shared path", () => {
    expect(read("components/ProfileScreen.jsx")).toContain('href="/profile/coach"');
    expect(read("components/PerformanceLab.jsx")).toContain("copyCoachContext(");
    expect(read("scripts/generate-sw-precache.mjs")).toContain('"/profile/coach"');
  });
});
