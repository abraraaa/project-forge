// Double rung when climbing, rep target when stalled. The climb is bounded by
// a fraction of the load, not a rung count.

import { describe, it, expect } from "vitest";
import { climbRungs, repClimb, computeNextPrescription } from "../lib/progression.js";

const set = ({ weight = 100, reps = 5, rir = 2 }) => ({
  weight, reps, rir, effectiveLoad: weight, volume: weight * reps,
});
const exercise = ({ name = "Barbell Back Squat", sets, prescribed = null }) => ({
  name, muscle: "Quadriceps", sets,
  prescribed: prescribed || { sets: sets.length, reps: sets[0].reps, weight: sets[0].weight },
  summary: { totalVolume: 0, topSet: sets[0] },
});
const session = ({ date = "2026-08-20", readiness = "normal", exercises }) => ({
  v: 2, id: `${date}T10:00:00.000Z`, date, readiness, retrospective: false,
  blocks: [{ id: "a1", type: "main", exercises }],
});

describe("climbRungs — a second rung, never a third", () => {
  const base = { addThresholdRir: 2, step: 2.5, currentWeight: 100 };

  it("holds at one rung until the run is long enough", () => {
    for (const n of [0, 1, 2]) {
      expect(climbRungs({ ...base, consecutiveAdds: n, rir: 4 }), `${n} adds`).toBe(1);
    }
    expect(climbRungs({ ...base, consecutiveAdds: 3, rir: 4 })).toBe(2);
  });

  it("never returns more than two", () => {
    expect(climbRungs({ ...base, consecutiveAdds: 50, rir: 5 })).toBe(2);
  });

  it("will not guess from an unrated set", () => {
    expect(climbRungs({ ...base, consecutiveAdds: 9, rir: null })).toBe(1);
  });

  it("requires reps genuinely to spare, not merely meeting the threshold", () => {
    expect(climbRungs({ ...base, consecutiveAdds: 9, rir: 2 })).toBe(1);
    expect(climbRungs({ ...base, consecutiveAdds: 9, rir: 3 })).toBe(2);
  });

  describe("the safety bound — a share of the load, not a rung count", () => {
    it("allows a double rung on a heavy lift, where it is a small share", () => {
      // 2.5kg step on 100kg: two rungs is 5%.
      expect(climbRungs({ addThresholdRir: 2, consecutiveAdds: 5, rir: 4, step: 2.5, currentWeight: 100 })).toBe(2);
    });

    it("refuses it on a light lift, where the same two rungs are a leap", () => {
      // 0.5kg step on 8kg: two rungs is 12.5%, past the cap.
      expect(climbRungs({ addThresholdRir: 2, consecutiveAdds: 5, rir: 4, step: 0.5, currentWeight: 8 })).toBe(1);
      // 2.5kg step on 20kg: 25%.
      expect(climbRungs({ addThresholdRir: 2, consecutiveAdds: 5, rir: 5, step: 2.5, currentWeight: 20 })).toBe(1);
    });

    it("is safe on nonsense inputs", () => {
      expect(climbRungs({ consecutiveAdds: 9, rir: 5, step: 0, currentWeight: 100 })).toBe(1);
      expect(climbRungs({ consecutiveAdds: 9, rir: 5, step: 2.5, currentWeight: 0 })).toBe(1);
      expect(climbRungs({})).toBe(1);
    });
  });
});

describe("repClimb — output, not a smaller step", () => {
  it("does nothing without a stall", () => {
    expect(repClimb({ stallSignal: null, baseReps: 8, currentReps: 8 })).toEqual({ reps: 8, changed: false });
    // "mild" is two holds, not a plateau.
    expect(repClimb({ stallSignal: "mild", baseReps: 8, currentReps: 8 }).changed).toBe(false);
  });

  it("adds a rep on a stall and on a deep stall", () => {
    expect(repClimb({ stallSignal: "stall", baseReps: 8, currentReps: 8 })).toEqual({ reps: 9, changed: true });
    expect(repClimb({ stallSignal: "deep_stall", baseReps: 8, currentReps: 9 })).toEqual({ reps: 10, changed: true });
  });

  it("stops climbing at the ceiling rather than growing forever", () => {
    expect(repClimb({ stallSignal: "stall", baseReps: 8, currentReps: 11 })).toEqual({ reps: 11, changed: false });
  });
});

describe("through the engine — the climb", () => {
  const flying = (consecutiveAdds) =>
    computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [session({ exercises: [exercise({ sets: [set({ weight: 100, reps: 5, rir: 4 })] })] })],
      liftState: {
        currentWeight: 100, sessionsCount: 6, consecutiveAdds,
        consecutiveHolds: 0, stallSignal: null, currentRepRange: null,
      },
      context: { readiness: "normal", loadType: "total" },
    });

  it("adds one rung on a short run and two once it is established", () => {
    const short = flying(1);
    const long = flying(4);
    expect(short.decision).toBe("ADD");
    expect(long.decision).toBe("ADD");
    expect(long.weight - short.weight).toBeGreaterThan(0);
    expect(long.rationale).toContain("climbing_double_rung");
    expect(short.rationale).not.toContain("climbing_double_rung");
  });
});

describe("through the engine — the stall", () => {
  const stalled = ({ stallSignal, currentRepRange, rir = 1 }) =>
    computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [session({ exercises: [exercise({ sets: [set({ weight: 100, reps: 5, rir })] })] })],
      liftState: {
        currentWeight: 100, sessionsCount: 8, consecutiveAdds: 0,
        consecutiveHolds: 3, stallSignal, currentRepRange,
      },
      context: { readiness: "normal", loadType: "total" },
    });

  it("raises the rep target and leaves the weight alone", () => {
    const r = stalled({ stallSignal: "stall", currentRepRange: null });
    expect(r.decision).toBe("HOLD");
    expect(r.weight).toBe(100);
    expect(r.reps).toBe(6);
    expect(r.repRangeChanged).toBe(true);
    expect(r.rationale).toContain("rep_climb_to=6");
  });

  it("banks the reps as weight once the raised target is met, and resets", () => {
    // Raised to 6 and hit with reps to spare.
    const r = computeNextPrescription({
      liftName: "Barbell Back Squat",
      history: [session({ exercises: [exercise({ sets: [set({ weight: 100, reps: 6, rir: 2 })] })] })],
      liftState: {
        currentWeight: 100, sessionsCount: 9, consecutiveAdds: 0,
        consecutiveHolds: 0, stallSignal: null,
        currentRepRange: { reps: 6, sets: 3, baseReps: 5 },
      },
      context: { readiness: "normal", loadType: "total" },
    });
    expect(r.decision).toBe("ADD");
    expect(r.weight).toBeGreaterThan(100);
    expect(r.reps).toBe(5);                       // back to base
    expect(r.rationale).toContain("rep_climb_banked");
    expect(r.rationale).not.toContain("climbing_double_rung");
  });

  it("carries the raised target forward for the caller to persist", () => {
    const r = stalled({ stallSignal: "stall", currentRepRange: null });
    expect(r.repRange).toEqual({ reps: 6, sets: expect.any(Number), baseReps: 5 });
  });
});
