// A single-set miss holds, and used to hold forever — the lift never dropped,
// it just racked up consecutiveHolds until the whole programme offered a
// deload for one stubborn exercise. Three in a row is a load problem on that
// lift and gets that lift's answer.

import { describe, it, expect } from "vitest";
import { computeNextPrescription, updateLiftStateFromSession } from "../lib/progression.js";

const set = (reps, rir = 1) => ({ weight: 100, effectiveLoad: 100, reps, rir, est1rm: 100 * (1 + reps / 30) });

// One set short by one rep: MISSED_LIGHT.
const lightMiss = (date) => ({
  id: `${date}T10:00:00`, date, session: "strength-a", readiness: "normal",
  blocks: [{ type: "main", exercises: [{
    name: "Barbell Back Squat", muscle: "Quadriceps",
    prescribed: { reps: 5, sets: 3, rir: 2 },
    sets: [set(5), set(5), set(4)],
  }] }],
});

const state = (consecutiveLightMisses, extra = {}) => ({
  currentWeight: 100, sessionsCount: 6, consecutiveAdds: 0, consecutiveHolds: 0,
  stallSignal: null, currentRepRange: { reps: 5, sets: 3, baseReps: 5 }, history: [],
  consecutiveLightMisses, ...extra,
});

const prescribe = (liftState, history = [lightMiss("2026-08-01")]) =>
  computeNextPrescription({ liftName: "Barbell Back Squat", history, liftState, context: { readiness: "normal", loadType: "barbell" } });

describe("the third one-set miss drops the lift", () => {
  it("first and second still hold", () => {
    for (const n of [0, 1]) {
      const p = prescribe(state(n));
      expect(p.decision).toBe("HOLD");
      expect(p.weight).toBe(100);
      expect(p.rationale).toContain("decision_reason=missed_light");
    }
  });

  it("third drops 5%, on that lift only, and says why", () => {
    const p = prescribe(state(2));
    expect(p.decision).toBe("DROP_5");
    expect(p.weight).toBe(95);
    expect(p.rationale).toContain("decision_reason=missed_light_repeated");
  });

  it("a moderate or heavy miss is untouched — it already drops", () => {
    const heavy = { ...lightMiss("2026-08-01") };
    heavy.blocks[0].exercises[0].sets = [set(5), set(3), set(2)];
    const p = prescribe(state(2), [heavy]);
    expect(["DROP_5", "DROP_10"]).toContain(p.decision);
    expect(p.rationale).not.toContain("decision_reason=missed_light_repeated");
  });

  it("a clean session with two misses banked is not a drop", () => {
    const clean = { ...lightMiss("2026-08-01") };
    clean.blocks[0].exercises[0].sets = [set(5, 3), set(5, 3), set(5, 3)];
    const p = prescribe(state(2), [clean]);
    expect(p.decision).toBe("ADD");
  });

  it("a state without the field reads as zero", () => {
    const p = prescribe(state(undefined));
    expect(p.decision).toBe("HOLD");
  });
});

describe("the counter", () => {
  const ex = { name: "Barbell Back Squat", sets: [set(5), set(5), set(4)] };
  const rec = (readiness = "normal") => ({ date: "2026-08-01", readiness });
  const hold = (reason) => ({ decision: "HOLD", weight: 100, reps: 5, sets: 3, rationale: [`decision_reason=${reason}`] });

  it("increments on a light miss and resets on anything else", () => {
    let st = updateLiftStateFromSession(state(0), rec(), ex, hold("missed_light"));
    expect(st.consecutiveLightMisses).toBe(1);
    st = updateLiftStateFromSession(st, rec(), ex, hold("missed_light"));
    expect(st.consecutiveLightMisses).toBe(2);
    st = updateLiftStateFromSession(st, rec(), ex, { ...hold("performed_full_rir1_close_to_limit") });
    expect(st.consecutiveLightMisses).toBe(0);
  });

  it("the drop the third miss earns drains it", () => {
    const drop = { decision: "DROP_5", weight: 95, reps: 5, sets: 3, rationale: ["decision_reason=missed_light_repeated"] };
    const st = updateLiftStateFromSession(state(2, { consecutiveHolds: 2 }), rec(), ex, drop);
    expect(st.consecutiveLightMisses).toBe(0);
    expect(st.consecutiveHolds).toBe(0);
  });

  it("cooked freezes it, as it freezes consecutiveHolds", () => {
    const st = updateLiftStateFromSession(state(2), rec("cooked"), ex, hold("readiness_cooked"));
    expect(st.consecutiveLightMisses).toBe(2);
  });

  it("an ADD resets it", () => {
    const add = { decision: "ADD", weight: 102.5, reps: 5, sets: 3, rationale: ["decision_reason=performed_full_with_rir"] };
    expect(updateLiftStateFromSession(state(2), rec(), ex, add).consecutiveLightMisses).toBe(0);
  });

  it("a prescription with no reason trail resets it", () => {
    const bare = { decision: "HOLD", weight: 100, reps: 5, sets: 3, rationale: [] };
    expect(updateLiftStateFromSession(state(2), rec(), ex, bare).consecutiveLightMisses).toBe(0);
  });
});

describe("end to end — three sessions, one drop", () => {
  it("holds, holds, drops", () => {
    let liftState = state(0);
    const decisions = [];
    for (const date of ["2026-08-01", "2026-08-04", "2026-08-06"]) {
      const history = [lightMiss(date)];
      const p = prescribe(liftState, history);
      decisions.push(p.decision);
      liftState = updateLiftStateFromSession(liftState, history[0], history[0].blocks[0].exercises[0], p);
    }
    expect(decisions).toEqual(["HOLD", "HOLD", "DROP_5"]);
    expect(liftState.consecutiveLightMisses).toBe(0);
    expect(liftState.consecutiveHolds).toBe(0);
    expect(liftState.stallSignal).toBe(null);
  });
});
