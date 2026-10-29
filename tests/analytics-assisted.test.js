// tests/analytics-assisted.test.js
// On an assisted lift the logged kg is help, so "last time" must name the set
// with the least of it, the way the engine's top set does.
import { describe, it, expect } from "vitest";
import { recentForExercise } from "../lib/analytics.js";

const rec = (date, name, loadType, sets) => ({
  date, blocks: [{ exercises: [{ name, loadType, sets: sets.map(([weight, reps, rpe]) => ({ weight, reps, rpe })) }] }],
});

describe("recentForExercise on an assisted lift", () => {
  it("takes the set with the least assistance as the top set", () => {
    const history = [rec("2026-10-20", "Assisted Pull-Up", "assisted_bodyweight", [[20, 8, 8], [20, 8, 8.5], [17.5, 8, 9]])];
    const [last] = recentForExercise(history, "Assisted Pull-Up", 1);
    expect(last.topSet.weight).toBe(17.5);
  });

  it("counts no help as the hardest set", () => {
    const history = [rec("2026-10-20", "Assisted Pull-Up", "assisted_bodyweight", [[5, 8, 8], [0, 6, 9.5]])];
    expect(recentForExercise(history, "Assisted Pull-Up", 1)[0].topSet.weight).toBe(0);
  });

  it("reads the assisted type from the sets when the exercise has none", () => {
    const r = rec("2026-10-20", "Assisted Pull-Up", undefined, [[20, 8, 8], [17.5, 8, 9], [20, 8, 8]]);
    for (const set of r.blocks[0].exercises[0].sets) Object.assign(set, { loadType: "assisted_bodyweight" });
    expect(recentForExercise([r], "Assisted Pull-Up", 1)[0].topSet.weight).toBe(17.5);
  });

  it("a loaded lift still takes the heaviest set", () => {
    const history = [rec("2026-10-20", "Barbell Back Squat", "external", [[100, 5, 8], [105, 5, 9], [100, 5, 8]])];
    expect(recentForExercise(history, "Barbell Back Squat", 1)[0].topSet.weight).toBe(105);
  });
});
