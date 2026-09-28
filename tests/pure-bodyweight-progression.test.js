// tests/pure-bodyweight-progression.test.js
// Pure bodyweight lifts (loadType "bodyweight") progress by reps, never kg.
// Four of them carried load-progression profiles, so a cold start seeded an
// anchor-derived kg that was then logged as added load (2026-09-28).
import { describe, it, expect } from "vitest";
import { SESSIONS, EXERCISE_POOLS, SWAP_DB } from "../lib/programme.js";
import { getLiftProfile, getLoadType, swapLoadType } from "../lib/lift-translations.js";
import { computeNextPrescription } from "../lib/progression.js";

function pureBodyweightNames() {
  const names = new Set();
  const add = (ex, lt) => { if (ex?.name && lt === "bodyweight") names.add(ex.name); };
  for (const s of SESSIONS) for (const b of s.blocks || []) for (const ex of b.exercises || []) add(ex, getLoadType(ex));
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
});
