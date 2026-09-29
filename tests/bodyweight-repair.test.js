import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { staleAddedLoads } from "../lib/bodyweight-repair.js";

const set = (weight) => ({ weight, reps: 8, loadType: "loaded_bodyweight", effectiveLoad: 79.8 + (weight || 0) });
const rec = (date, name, weights) => ({ id: `${date}T10`, date, blocks: [{ exercises: [{ name, loadType: "loaded_bodyweight", sets: weights.map(set) }] }] });

describe("stale added loads — dry run", () => {
  it("finds the reported case: bodyweight stored as a pull-up's added load", () => {
    const out = staleAddedLoads({
      weights: { "Pull-Up": 79.8, "Barbell Back Squat": 112.5 },
      trainingState: { lifts: { "Pull-Up": { currentWeight: 79.8 } } },
      history: [rec("2026-08-15", "Pull-Up", [0, 0, 0]), rec("2026-08-31", "Pull-Up", [0, 0, 0])],
    });
    expect(out).toEqual([
      { lift: "Pull-Up", field: "lift state", stored: 79.8, wouldSet: 0, from: "2026-08-31" },
      { lift: "Pull-Up", field: "working weight", stored: 79.8, wouldSet: 0, from: "2026-08-31" },
    ]);
  });
  it("uses the LATEST session, and leaves correct values and external lifts alone", () => {
    const out = staleAddedLoads({
      weights: { "Pull-Up": 10, "Barbell Back Squat": 100 },
      trainingState: { lifts: { "Pull-Up": { currentWeight: 10 } } },
      history: [rec("2026-08-01", "Pull-Up", [0]), rec("2026-09-01", "Pull-Up", [10, 10])],
    });
    expect(out).toEqual([]);
  });
  it("skips pure bodyweight lifts: their W is never read, added weight lives elsewhere", () => {
    const bw = (date, name, weights) => ({ id: `${date}T10`, date, blocks: [{ exercises: [{ name, loadType: "bodyweight", sets: weights.map((weight) => ({ weight, reps: 12, loadType: "bodyweight" })) }] }] });
    const out = staleAddedLoads({
      weights: { "Glute Bridge": 80 },
      trainingState: { lifts: { "Glute Bridge": { currentWeight: 80 } } },
      history: [bw("2026-09-20", "Glute Bridge", [0, 0]), bw("2026-09-27", "Glute Bridge", [10, 10])],
    });
    expect(out).toEqual([]);
  });
  it("ignores travel sessions, even with a backpack weight", () => {
    const travel = (r) => ({ ...r, travel: true });
    // Realistic travel slot: a loaded lift's name, logged as bodyweight + backpack.
    const slot = { id: "2026-09-10T10", date: "2026-09-10", travel: true, blocks: [{ exercises: [{ name: "Bulgarian Split Squat", loadType: "bodyweight", travel: true, sets: [{ weight: 10, reps: 10, loadType: "bodyweight" }] }] }] };
    // A newer travel record must not shadow the latest gym session either.
    const out = staleAddedLoads({
      weights: { "Bulgarian Split Squat": 18, "Pull-Up": 10 },
      trainingState: { lifts: { "Pull-Up": { currentWeight: 10 } } },
      history: [rec("2026-09-01", "Pull-Up", [10, 10]), slot, travel(rec("2026-09-12", "Pull-Up", [5, 5]))],
    });
    expect(out).toEqual([]);
  });
  it("still lists a loaded bodyweight lift with a stale working weight", () => {
    const out = staleAddedLoads({
      weights: { "Dip": 82.5 },
      history: [rec("2026-09-20", "Dip", [2.5, 2.5])],
    });
    expect(out).toEqual([{ lift: "Dip", field: "working weight", stored: 82.5, wouldSet: 2.5, from: "2026-09-20" }]);
  });
  it("is read-only: no writes in the module, and the diag page only renders it", () => {
    const src = readFileSync(resolve(__dirname, "../lib/bodyweight-repair.js"), "utf8");
    expect(src).not.toMatch(/\b(LS|localStorage|save|set)\s*\(/);
    const page = readFileSync(resolve(__dirname, "../app/diag-sync/page.jsx"), "utf8");
    expect(page).toContain("dry run, nothing is changed");
  });
});
