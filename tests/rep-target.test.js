// The engine's rep target reaches the session, a user's own target becomes
// the lift's base, and the drum marks the programme's range.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { computeNextPrescription } from "../lib/progression.js";
import { repsForSession } from "../lib/session-engine.js";
import { recommendedReps, EFFECTIVE_REP_BAND } from "../lib/rep-band.js";

const rec = (reps, rir = 1) => ({
  id: "2026-09-20T10:00:00", date: "2026-09-20", session: "strength-a", readiness: "normal",
  blocks: [{ type: "main", exercises: [{
    name: "Barbell Back Squat", muscle: "Quadriceps",
    sets: [1, 2, 3].map(() => ({ weight: 100, effectiveLoad: 100, reps, rir, est1rm: 100 * (1 + reps / 30) })),
  }] }],
});
const state = (range, extra = {}) => ({
  currentWeight: 100, sessionsCount: 8, consecutiveAdds: 0, consecutiveHolds: 3,
  stallSignal: "stall", history: [], currentRepRange: range, ...extra,
});
const prescribe = (history, liftState) =>
  computeNextPrescription({ liftName: "Barbell Back Squat", history, liftState, context: { readiness: "normal", loadType: "barbell" } });

describe("rep climb", () => {
  it("a stalled lift climbs one rep and says the target changed", () => {
    const p = prescribe([rec(5)], state({ reps: 5, sets: 3, baseReps: 5 }));
    expect(p.decision).toBe("HOLD");
    expect(p.reps).toBe(6);
    expect(p.repRangeChanged).toBe(true);
  });

  it("a user who logs their own count makes it the base; the engine climbs from there", () => {
    // Engine's target was 6 (climbed from 5); the user trained at 10.
    const p = prescribe([rec(10)], state({ reps: 6, sets: 3, baseReps: 5 }));
    expect(p.rationale).toContain("user_rep_target");
    expect(p.repRange.baseReps).toBe(10);
    expect(p.reps).toBe(11); // still stalled → climbs from 10, not back toward 5
  });

  it("logging the engine's own target is not a user override", () => {
    const p = prescribe([rec(6)], state({ reps: 6, sets: 3, baseReps: 5 }));
    expect(p.rationale).not.toContain("user_rep_target");
    expect(p.repRange.baseReps).toBe(5);
  });
});

describe("repsForSession keeps the template's shape", () => {
  it("plain, per-leg, timed", () => {
    expect(repsForSession(6, 5)).toBe(6);
    expect(repsForSession(9, "8/leg")).toBe("9/leg");
    expect(repsForSession(25, "20s")).toBe(null);
    expect(repsForSession(null, 5)).toBe(null);
  });
});

describe("recommended range", () => {
  it("parses template reps", () => {
    expect(recommendedReps("12-15")).toEqual({ min: 12, max: 15 });
    expect(recommendedReps("8/leg")).toEqual({ min: 8, max: 8 });
    expect(recommendedReps(5)).toEqual({ min: 5, max: 5 });
    expect(recommendedReps("20s")).toBe(null);
    expect(recommendedReps(undefined)).toBe(null);
  });
  it("the effective band is 6–30", () => {
    expect(EFFECTIVE_REP_BAND).toEqual({ min: 6, max: 30 });
  });
});

describe("wiring", () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  it("both finalise paths apply the engine's rep updates", () => {
    for (const f of ["components/SessionHost.jsx", "components/ForgeApp.jsx"]) {
      expect(read(f), f).toContain("engine.wrUpdates");
    }
  });
  it("the reps drum carries the tone", () => {
    expect(read("components/SessionScreen.jsx")).toContain("tone={target.timed?null:repTone}");
  });
  it("the press lift is P3 where supported", () => {
    expect(read("app/globals.css")).toMatch(/@supports \(color: color\(display-p3 1 1 1\)\) \{\s*:root \{ --press-lift: color\(display-p3/);
  });
});
