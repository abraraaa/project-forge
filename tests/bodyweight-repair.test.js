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
  it("is read-only: no writes in the module, and the diag page only renders it", () => {
    const src = readFileSync(resolve(__dirname, "../lib/bodyweight-repair.js"), "utf8");
    expect(src).not.toMatch(/\b(LS|localStorage|save|set)\s*\(/);
    const page = readFileSync(resolve(__dirname, "../app/diag-sync/page.jsx"), "utf8");
    expect(page).toContain("dry run, nothing is changed");
  });
});
