// Wide seed sweep over the Strong cells closest to a band edge: Power Clean
// swapped to Push Press (Calves sat a tenth under MEV on about one seed in a
// hundred until the solver's complete repair) and no swap. Every week: no
// muscle under MEV (Strong's exempt arms aside), none over MRV, every day
// inside its CNS budget. Two seed generators, so the sweep is not one RNG's
// luck.
import { describe, it, expect } from "vitest";
import {
  solveRotation, FOCUS_VOLUME_PROFILES, sessionCnsLoad, dayBudget, SESSION_CNS_CAP,
} from "../lib/rotation-solver.js";
import { SESSIONS } from "../lib/programme.js";
import { VOLUME_TARGETS } from "../lib/volume-audit.js";

const SEEDS = 400;
const lcg = (n) => () => { n = (n * 1103515245 + 12345) % 2147483648; return n / 2147483648; };
const mulberry = (seed) => {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const exempt = FOCUS_VOLUME_PROFILES.Strong.floorExempt;

/** Every breach of one solved Strong week, as text. */
function breaches(config, volume) {
  const out = [];
  for (const [m, t] of Object.entries(VOLUME_TARGETS)) {
    const v = volume[m] || 0;
    if (v < t.mev && !exempt.has(m)) out.push(`${m} ${v.toFixed(2)} < MEV ${t.mev}`);
    if (v > t.mrv) out.push(`${m} ${v.toFixed(2)} > MRV ${t.mrv}`);
  }
  for (const s of SESSIONS) {
    const load = sessionCnsLoad(s, config, { focus: "Strong" });
    if (load > SESSION_CNS_CAP + 1e-9) out.push(`${s.name} accessories over budget ${dayBudget(s).toFixed(2)}`);
  }
  return out;
}

describe("Strong sweep: every solved week in band and inside its CNS budget", () => {
  for (const [label, mainLifts] of [["Power Clean to Push Press", { "Power Clean": "Push Press" }], ["no swap", {}]]) {
    for (const [rngName, rngOf] of [["lcg", lcg], ["mulberry", mulberry]]) {
      it(`${label}, ${SEEDS} seeds (${rngName})`, () => {
        const bad = [];
        for (let s = 1; s <= SEEDS; s++) {
          const { config, report } = solveRotation({ focus: "Strong", mainLifts, rng: rngOf(s) });
          for (const b of breaches(config, report.volume)) bad.push(`seed ${s}: ${b}`);
        }
        expect(bad).toEqual([]);
      }, 20_000);
    }
  }
});

describe("the complete repair on the week that found it", () => {
  // Strong, Power Clean to Push Press, lcg seed 25: the bounded pass spends
  // its six swaps on soft drift and stops with Calves at 5.9. The complete
  // repair changes one slot, css1-A DB Lateral Lunge to DB Walking Lunge.
  const solve = (completeRepair) =>
    solveRotation({ focus: "Strong", mainLifts: { "Power Clean": "Push Press" }, rng: lcg(25), completeRepair });

  it("without it the week is under MEV on Calves", () => {
    const { report } = solve(false);
    expect(report.outOfBand).toEqual(["Calves"]);
    expect(report.volume.Calves).toBeCloseTo(5.9, 5);
  });

  it("with it one slot changes and the week is in band", () => {
    const off = solve(false);
    const on = solve(true);
    const changed = Object.keys(on.config).filter((k) => on.config[k].name !== off.config[k]?.name);
    expect(changed).toEqual(["css1-A"]);
    expect([off.config["css1-A"].name, on.config["css1-A"].name]).toEqual(["DB Lateral Lunge", "DB Walking Lunge"]);
    expect(on.report.outOfBand).toEqual([]);
    expect(on.report.volume.Calves).toBeGreaterThanOrEqual(6);
    expect(breaches(on.config, on.report.volume)).toEqual([]);
  });
});
