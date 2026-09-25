// @vitest-environment jsdom
// A main-lift swap changes weekly volume with the accessories unchanged. The
// block re-plans only when the new lift breaks a band (2026-09-25; ~1.2% of
// solved config × swap combinations did, e.g. Push Press for Power Clean
// left Upper Back out of band).
import { describe, it, expect, beforeEach } from "vitest";
import { P, PB, F } from "../lib/storage.js";
import { solveRotation, bandViolations } from "../lib/rotation-solver.js";
import { saveMainLiftCore } from "../lib/profile-actions.js";

const mulberry = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const setup = (seed) => {
  const { config } = solveRotation({ history: {}, focus: "Forged", mainLifts: {}, rng: mulberry(seed) });
  PB.save({ number: 3, startDate: "2026-09-22", config, history: {} });
  F.save("sam", "Forged");
  return config;
};

describe("main-lift change keeps the week in band", () => {
  beforeEach(() => { localStorage.clear(); P.add("sam"); P.setActive("sam"); });

  it("a swap that breaks a band re-plans the block's accessories", () => {
    const before = setup(4);
    expect(bandViolations(before, { focus: "Forged", mainLifts: { "Power Clean": "Push Press" } })).toContain("Upper Back");
    const { summary, mainLifts } = saveMainLiftCore("sam", "Power Clean", "Push Press");
    expect(mainLifts["Power Clean"]).toBe("Push Press");
    expect(summary?.reason).toBe("main_lift");
    const after = PB.get();
    expect(after.number).toBe(3);                    // same block
    expect(after.startDate).toBe("2026-09-22");
    expect(bandViolations(after.config, { focus: "Forged", mainLifts }).length).toBe(0);
  });

  it("a swap that stays in band leaves the accessories alone", () => {
    const before = setup(4);
    expect(bandViolations(before, { focus: "Forged", mainLifts: { "Barbell Bench Press": "Dumbbell Bench Press" } })).toEqual([]);
    const { summary } = saveMainLiftCore("sam", "Barbell Bench Press", "Dumbbell Bench Press");
    expect(summary).toBeNull();
    expect(PB.get().config).toEqual(before);
  });

  it("back to the default lift is a choice like any other", () => {
    setup(4);
    saveMainLiftCore("sam", "Power Clean", "Push Press");
    const { mainLifts } = saveMainLiftCore("sam", "Power Clean", null);
    expect(mainLifts["Power Clean"]).toBe("Power Clean");
  });
});
