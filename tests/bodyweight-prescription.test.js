// A bodyweight lift must never prescribe bodyweight as ADDED weight.
// effectiveLoad for a loaded_bodyweight set is BW + added, so prescribing from
// it handed back ~83kg of "added weight" on a plain pull-up (boss report,
// 2026-08-30). The engine still reasons in effectiveLoad for est1rm and volume.

import { describe, it, expect } from "vitest";
import { computeNextPrescription } from "../lib/progression.js";
import { computeEffectiveLoad } from "../lib/storage.js";

const BW = 82;
// A real pull-up set: no belt, so weight is null and effectiveLoad is bodyweight.
const bwSet = ({ reps = 8, rir = 2, weight = null }) => ({
  weight,
  reps,
  rir,
  loadType: "loaded_bodyweight",
  bodyweightUsed: BW,
  effectiveLoad: computeEffectiveLoad("loaded_bodyweight", weight, BW),
});
const session = (sets) => ({
  v: 2, id: "2026-08-30T10:00:00.000Z", date: "2026-08-30", readiness: "normal", retrospective: false,
  blocks: [{ id: "b1", type: "main", exercises: [{
    name: "Pull-Up", muscle: "Lats", sets, loadType: "loaded_bodyweight",
    prescribed: { sets: sets.length, reps: sets[0].reps, weight: sets[0].weight },
    summary: { totalVolume: 0, topSet: sets[0] },
  }] }],
});
const run = (sets, ctx = {}) => computeNextPrescription({
  liftName: "Pull-Up",
  history: [session(sets)],
  liftState: { currentWeight: null, sessionsCount: 4, consecutiveAdds: 0, consecutiveHolds: 0, stallSignal: null, currentRepRange: null },
  context: { readiness: "normal", loadType: "loaded_bodyweight", ...ctx },
});

describe("the reported bug", () => {
  it("the set really does carry bodyweight in effectiveLoad", () => {
    // Confirms the input, so a change to computeEffectiveLoad retires this test
    // honestly rather than silently.
    expect(bwSet({}).weight).toBeNull();
    expect(bwSet({}).effectiveLoad).toBe(BW);
  });

  it("never prescribes bodyweight as added weight", () => {
    const r = run([bwSet({ reps: 8, rir: 2 })]);
    expect(r.weight).toBeNull();
    expect(r.weight).not.toBe(BW);
  });

  it("does not prescribe bodyweight plus a rung either", () => {
    // The exact failure: 82 -> 83.25 landing in workingWeights.
    const r = run([bwSet({ reps: 8, rir: 3 })]);
    expect(r.weight).not.toBeCloseTo(BW + 1.25);
    expect(r.weight).toBeNull();
  });

  it("progresses reps instead, since that is how an unloaded pull-up moves", () => {
    const r = run([bwSet({ reps: 8, rir: 3 })]);
    expect(r.decision).toBe("ADD");
    expect(r.reps).toBe(9);
    expect(r.rationale).toContain("bw_rep_progression_unloaded");
  });

  it("holds reps when the set was not clean", () => {
    const r = run([bwSet({ reps: 8, rir: 0 })]);
    expect(r.decision).toBe("HOLD");
    expect(r.reps).toBe(8);
    expect(r.weight).toBeNull();
  });
});

describe("a genuinely loaded bodyweight lift still progresses its load", () => {
  it("adds to the ADDED weight, not to bodyweight plus it", () => {
    const r = run([bwSet({ reps: 6, rir: 3, weight: 10 })]);
    expect(r.decision).toBe("ADD");
    // 10kg on the belt -> one rung up. Never 92 (BW+10) or 93.25.
    expect(r.weight).toBeGreaterThan(10);
    expect(r.weight).toBeLessThan(15);
  });

  it("holds the added weight rather than resetting it", () => {
    const r = run([bwSet({ reps: 6, rir: 0, weight: 10 })]);
    expect(r.weight).toBe(10);
  });
});

describe("ordinary loaded lifts are untouched", () => {
  it("still reasons from effectiveLoad", () => {
    const r = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [{
        v: 2, id: "x", date: "2026-08-30", readiness: "normal", retrospective: false,
        blocks: [{ id: "b1", type: "main", exercises: [{
          name: "Barbell Back Squat", muscle: "Quadriceps", loadType: "barbell",
          sets: [{ weight: 100, reps: 5, rir: 3, effectiveLoad: 100 }],
          prescribed: { sets: 1, reps: 5, weight: 100 },
          summary: { totalVolume: 0, topSet: { weight: 100 } },
        }] }],
      }],
      liftState: { currentWeight: 100, sessionsCount: 6, consecutiveAdds: 0, consecutiveHolds: 0, stallSignal: null, currentRepRange: null },
      context: { readiness: "normal", loadType: "barbell" },
    });
    expect(r.decision).toBe("ADD");
    expect(r.weight).toBeGreaterThan(100);
  });
});
