// The volume audit counts the user's CHOSEN anchors. Counting the template's
// mains for someone who picked otherwise audits a week nobody trains — and the
// rotation solver picks accessories against that baseline, so it would solve
// the wrong week too.

import { describe, it, expect } from "vitest";
import { computeWeeklyVolume, auditVolume } from "../lib/volume-audit.js";
import { MAIN_LIFT_FUNCTIONAL_EQUIVALENTS } from "../lib/programme.js";
import { EXERCISE_ANATOMY } from "../lib/exercise-anatomy.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const solver = readFileSync(resolve(root, "lib/rotation-solver.js"), "utf8");

describe("no choices changes nothing", () => {
  it("matches the template audit exactly", () => {
    expect(computeWeeklyVolume(undefined, { mainLifts: {} }))
      .toEqual(computeWeeklyVolume());
  });

  it("an unlisted choice is ignored rather than counted", () => {
    expect(computeWeeklyVolume(undefined, { mainLifts: { "Barbell Back Squat": "Leg Extension" } }))
      .toEqual(computeWeeklyVolume());
  });
});

describe("a chosen anchor moves the numbers", () => {
  it("shifts volume when the movement credits different muscles", () => {
    const base = computeWeeklyVolume();
    const swapped = computeWeeklyVolume(undefined, {
      mainLifts: { "Barbell Bench Press": "Weighted Dips" },
    });
    // Bench and Dips are close by design (both chest-primary, 0.4 triceps);
    // the honest difference is front delts, and the audit should see it.
    expect(swapped).not.toEqual(base);
    expect(swapped["Front Delts"]).toBeLessThan(base["Front Delts"]);
  });

  it("auditVolume carries the choice through to the bands", () => {
    const a = auditVolume(undefined, { mainLifts: {} });
    const b = auditVolume(undefined, { mainLifts: { "Barbell Bench Press": "Weighted Dips" } });
    expect(b.perMuscle["Front Delts"].sets).toBeLessThan(a.perMuscle["Front Delts"].sets);
  });

  it("every listed alternative produces a countable week", () => {
    for (const [main, alts] of Object.entries(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS)) {
      for (const alt of alts) {
        const v = computeWeeklyVolume(undefined, { mainLifts: { [main]: alt } });
        const total = Object.values(v).reduce((n, x) => n + x, 0);
        expect(total, `${main} -> ${alt} produced no volume`).toBeGreaterThan(0);
      }
    }
  });
});

describe("the rotation solver solves the chosen week", () => {
  it("threads mainLifts into every volume evaluation", () => {
    expect(solver).toContain("function volumeFor(config, focus, mainLifts)");
    expect(solver).toContain("computeWeeklyVolume(rotated, { focus, config, mainLifts })");
    // No evaluation may still call the two-arg form, or the solver optimises
    // against the template while the user trains something else.
    expect(solver).not.toMatch(/volumeFor\([a-z]+,\s*focus\)/);
  });

  it("accepts the choice as a parameter", () => {
    expect(solver).toMatch(/mainLifts = \{\}/);
  });
});

describe("anatomy coverage for choosable anchors", () => {
  it("covers every choosable anchor", () => {
    // A movement with no EXERCISE_ANATOMY entry falls back to the block's
    // coarse muscle label, so its volume is credited bluntly. Every choosable
    // anchor needs an entry before it reaches the picker.
    const missing = [];
    for (const [main, alts] of Object.entries(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS)) {
      for (const name of [main, ...alts]) {
        if (!EXERCISE_ANATOMY[name]) missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });
});
