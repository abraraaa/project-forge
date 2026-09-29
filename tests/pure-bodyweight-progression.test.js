// tests/pure-bodyweight-progression.test.js
// Pure bodyweight lifts (loadType "bodyweight") progress by reps, never kg.
// Four of them carried load-progression profiles, so a cold start seeded an
// anchor-derived kg that was then logged as added load (2026-09-28).
import { describe, it, expect } from "vitest";
import { SESSIONS, EXERCISE_POOLS, SWAP_DB } from "../lib/programme.js";
import { getLiftProfile, getLoadType, swapLoadType } from "../lib/lift-translations.js";
import { computeNextPrescription, updateLiftStateFromSession } from "../lib/progression.js";

function pureBodyweightNames() {
  const names = new Set();
  const add = (ex, lt) => { if (ex?.name && lt === "bodyweight") names.add(ex.name); };
  for (const s of SESSIONS) for (const b of s.blocks || []) for (const ex of [b.ex, b.exA, b.exB]) if (ex) add(ex, getLoadType(ex));
  for (const p of Object.values(EXERCISE_POOLS)) for (const ex of p.pool || []) add(ex, getLoadType(ex));
  for (const opts of Object.values(SWAP_DB)) for (const o of opts) add(o, swapLoadType(o));
  return [...names].sort();
}

describe("pure bodyweight lifts progress by reps", () => {
  const names = pureBodyweightNames();

  it("finds the pure bodyweight lifts", () => {
    expect(names.length).toBeGreaterThanOrEqual(25);
    for (const n of ["Glute Bridge", "45-Degree Hip Extension", "Sissy Squat", "Reverse Lunge"]) expect(names).toContain(n);
  });

  it("none has a load-progression profile", () => {
    expect(names.filter((n) => getLiftProfile(n).progressesByLoad)).toEqual([]);
  });

  it("cold start never prescribes kg, even with a muscle anchor", () => {
    const anchor = { bestE1RM: 150, bestE1RMLift: "Barbell Back Squat" };
    for (const n of names) {
      const p = computeNextPrescription({ liftName: n, history: [], liftState: null, muscleAnchor: anchor, context: { pureBodyweight: true } });
      expect(p.weight, n).toBeNull();
    }
  });

  it("a stray weight on a past pure-bodyweight set never produces a kg ADD", () => {
    const set = { reps: 12, rpe: 7, weight: 80, loadType: "bodyweight" };
    const history = [{ id: "s1", date: "2026-09-20", readiness: "fresh", blocks: [{ id: "ass2", type: "accessory", exercises: [{ name: "Glute Bridge", loadType: "bodyweight", prescribed: { reps: 12, sets: 3, rir: 2 }, sets: [set, set, set] }] }] }];
    const p = computeNextPrescription({ liftName: "Glute Bridge", history, liftState: { currentWeight: 80, history: [] }, context: { pureBodyweight: true } });
    expect(p.weight).toBeNull();
    expect(p.rationale).toContain("bw_rep_progression");
  });

  it("the prescription ignores the added load", () => {
    // Parity: the bodyweight branch never reads set weights, so a vest set
    // and a no-vest set prescribe the same thing — reps climb, kg stays null.
    const mk = (w) => [{ id: "s1", date: "2026-09-20", readiness: "normal", blocks: [{ id: "ass2", type: "superset", exercises: [
      { name: "Glute Bridge", loadType: "bodyweight", prescribed: { reps: 12, sets: 3, rir: 2 },
        sets: [0, 1, 2].map(() => ({ weight: w, reps: 12, rir: 2, rpe: 8, loadType: "bodyweight" })) }] }] }];
    const run = (w) => computeNextPrescription({
      liftName: "Glute Bridge", history: mk(w), liftState: { currentWeight: 10, history: [] },
      context: { pureBodyweight: true, currentWeight: 80 },
    });
    expect(run(10)).toEqual(run(null));
    expect(run(10).weight).toBeNull();
    expect(run(10).reps).toBe(13);
    expect(run(10).rationale).toContain("bw_rep_progression");
  });
});

// The rep climb reaches the session: one rep per full, easy session, up to
// base + 3, then hold. Load is never added by the engine (2026-09-29).
describe("pure bodyweight rep climb", () => {
  const set = (reps, rir = 2, weight = null) => ({ weight, reps, rir, rpe: 8, loadType: "bodyweight" });
  // Live-shaped: no prescribed; every set logs the target the session showed.
  const record = (reps, rir = 2, weight = null) => ({
    id: "s1", date: "2026-09-20", readiness: "normal",
    blocks: [{ id: "ass2", type: "superset", exercises: [
      { name: "Glute Bridge", loadType: "bodyweight", sets: [0, 1, 2].map(() => set(reps, rir, weight)) }] }],
  });
  const prescribe = (reps, currentRepRange = null, { rir = 2, weight = null } = {}) => computeNextPrescription({
    liftName: "Glute Bridge", history: [record(reps, rir, weight)],
    liftState: { currentWeight: null, sessionsCount: 4, history: [], currentRepRange },
    context: { pureBodyweight: true },
  });

  it("a full, easy session climbs one rep and flags the change", () => {
    const p = prescribe(12);
    expect(p.reps).toBe(13);
    expect(p.decision).toBe("ADD");
    expect(p.repRangeChanged).toBe(true);
    expect(p.repRange).toEqual({ reps: 13, sets: 3, baseReps: 12, bwClimb: true });
    expect(p.weight).toBeNull();
  });

  it("climbs from the kept base, and holds at base + 3", () => {
    expect(prescribe(14, { reps: 14, sets: 3, baseReps: 12, bwClimb: true }).reps).toBe(15);
    const p = prescribe(15, { reps: 15, sets: 3, baseReps: 12, bwClimb: true });
    expect(p.reps).toBe(15);
    expect(p.decision).toBe("HOLD");
    expect(p.repRangeChanged).toBe(false);
    expect(p.rationale).toContain("bw_rep_ceiling");
    expect(p.repRange.baseReps).toBe(12);
    expect(p.weight).toBeNull();
  });

  it("a stray weight at the ceiling still never yields kg", () => {
    const p = prescribe(15, { reps: 15, sets: 3, baseReps: 12, bwClimb: true }, { weight: 20 });
    expect(p.weight).toBeNull();
    expect(p.reps).toBe(15);
  });

  it("a hard or missed session holds the target and changes nothing", () => {
    const p = prescribe(13, { reps: 13, sets: 3, baseReps: 12, bwClimb: true }, { rir: 1 });
    expect(p.reps).toBe(13);
    expect(p.decision).toBe("HOLD");
    expect(p.repRangeChanged).toBe(false);
    expect(p.rationale).not.toContain("bw_rep_ceiling");
    // A real hold still counts toward a stall.
    const rec = record(13, 1);
    const state = { currentWeight: null, sessionsCount: 4, history: [], consecutiveHolds: 0, currentRepRange: { reps: 13, sets: 3, baseReps: 12, bwClimb: true } };
    expect(updateLiftStateFromSession(state, rec, rec.blocks[0].exercises[0], p).consecutiveHolds).toBe(1);
  });

  it("an untrusted range is not a base: a cold start's default or a loaded range", () => {
    // Cold start persisted DEFAULT_REPS (5) as the base for every BW lift.
    expect(prescribe(12, { reps: 5, sets: 3, baseReps: 5 }).repRange.baseReps).toBe(12);
    expect(prescribe(8, { reps: 8, sets: 3, baseReps: 5 }).reps).toBe(9);
  });

  it("a target the user set outside the climb becomes the base", () => {
    const p = prescribe(20, { reps: 13, sets: 3, baseReps: 12, bwClimb: true });
    expect(p.reps).toBe(21);
    expect(p.repRange.baseReps).toBe(20);
  });

  it("a target lowered below the climb's base becomes the base", () => {
    const p = prescribe(10, { reps: 14, sets: 3, baseReps: 12, bwClimb: true });
    expect(p.reps).toBe(11);
    expect(p.repRange.baseReps).toBe(10);
  });

  it("a timed hold never climbs", () => {
    const history = [{ id: "s1", date: "2026-09-20", readiness: "normal", blocks: [{ id: "afin", type: "finisher", exercises: [
      { name: "L-Sit Hold", loadType: "bodyweight", sets: [0, 1, 2].map(() => ({ weight: null, reps: "20s", rir: 3, loadType: "bodyweight" })) }] }] }];
    const p = computeNextPrescription({ liftName: "L-Sit Hold", history, liftState: { sessionsCount: 4, history: [] }, context: { pureBodyweight: true } });
    expect(p.reps).toBe(20);
    expect(p.decision).toBe("HOLD");
    expect(p.repRangeChanged).toBe(false);
    expect(p.rationale).toContain("bw_timed_hold");
  });

  it("a capped hold is not a stall: no deload pressure builds", () => {
    let state = { currentWeight: null, sessionsCount: 4, history: [], consecutiveHolds: 0, currentRepRange: { reps: 15, sets: 3, baseReps: 12, bwClimb: true } };
    for (let i = 0; i < 5; i++) {
      const rec = record(15);
      const p = computeNextPrescription({ liftName: "Glute Bridge", history: [rec], liftState: state, context: { pureBodyweight: true } });
      state = updateLiftStateFromSession(state, rec, rec.blocks[0].exercises[0], p);
    }
    expect(state.consecutiveHolds).toBe(0);
    expect(state.stallSignal).toBeNull();
    expect(state.currentRepRange).toEqual({ reps: 15, sets: 3, baseReps: 12, bwClimb: true });
  });
});
