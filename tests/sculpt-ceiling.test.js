// Sculpt's +1 set on aligned supersets is checked against the week's MRV
// before it fires. Unconditionally it put Glutes at 16.6 against a 16
// ceiling on the default config — over by construction, before rotation had
// picked anything — and was the cause of Sculpt's out-of-band weeks.

import { describe, it, expect } from "vitest";
import {
  SESSIONS, EXERCISE_POOLS, MAIN_LIFT_FUNCTIONAL_EQUIVALENTS,
  applyFocusToSession, applyFocusToSessions, applyRotationToSession,
  applyMainLiftsToSession, sculptBumpBlockIds, SCULPT_ALIGNED_PRIMARIES, pushHistoryBlock,
} from "../lib/programme.js";
import { computeWeeklyVolume, VOLUME_TARGETS } from "../lib/volume-audit.js";
import { solveRotation } from "../lib/rotation-solver.js";

const defaultConfig = {};
for (const [key, slot] of Object.entries(EXERCISE_POOLS)) defaultConfig[key] = slot.pool[0];

const setsOf = (session, id) => session.blocks.find((b) => b.id === id).sets;
const sculptWeek = (config, mainLifts = {}) =>
  computeWeeklyVolume(
    SESSIONS.map((s) => applyMainLiftsToSession(applyRotationToSession(s, config), mainLifts)),
    { focus: "Sculpt", config, mainLifts },
  );

describe("the ceiling on the default config", () => {
  it("holds every aligned primary at or under MRV", () => {
    const v = sculptWeek(defaultConfig);
    for (const m of SCULPT_ALIGNED_PRIMARIES) {
      expect(v[m] || 0, m).toBeLessThanOrEqual(VOLUME_TARGETS[m].mrv);
    }
  });

  it("withholds the set from the glute block and keeps it on the others", () => {
    const kept = sculptBumpBlockIds(defaultConfig);
    // ass2 is the largest glute contributor of the aligned blocks — it is the
    // one withdrawal that brings the week under 16. Chest/arm blocks are
    // nowhere near their ceilings and keep the set.
    expect(kept.has("ass2")).toBe(false);
    expect(kept.has("css2")).toBe(true);
    expect(kept.has("css3")).toBe(true);
    const a = applyFocusToSession(SESSIONS[0], "Sculpt", defaultConfig);
    expect(setsOf(a, "ass2")).toBe(setsOf(SESSIONS[0], "ass2"));
  });

  it("a withheld block still takes the 12-15 rep range on its aligned sides", () => {
    const a = applyFocusToSession(SESSIONS[0], "Sculpt", defaultConfig);
    const ass2 = a.blocks.find((b) => b.id === "ass2");
    expect(ass2.exA.reps).toBe("12-15");
    expect(ass2.exB.reps).toBe("12-15");
  });

  it("still raises glutes above the Forged baseline — the ceiling trims, it does not cancel", () => {
    const forged = computeWeeklyVolume(SESSIONS.map((s) => applyRotationToSession(s, defaultConfig)), { focus: "Forged", config: defaultConfig });
    expect(sculptWeek(defaultConfig).Glutes).toBeGreaterThan(forged.Glutes);
  });
});

describe("the ceiling covers the partner side of a superset", () => {
  // mulberry32, as in tests/rotation-solver.test.js — seed 294 lands ass2 on
  // Single-Leg RDL (aligned via Incline Landmine Press on the other side).
  function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("a bump that would carry Hamstrings over MRV is withheld", () => {
    const { config } = solveRotation({ focus: "Sculpt", rng: mulberry(294), history: {} });
    expect(config["ass2-A"].name).toBe("Single-Leg RDL");
    // Anchor changed after the solve, as the main-lifts page does.
    const mainLifts = { "Hex Bar Deadlift": "Romanian Deadlift" };
    expect(sculptBumpBlockIds(config, mainLifts).has("ass2")).toBe(false);
    const v = sculptWeek(config, mainLifts);
    for (const [m, t] of Object.entries(VOLUME_TARGETS)) {
      const forged = computeWeeklyVolume(
        SESSIONS.map((s) => applyMainLiftsToSession(applyRotationToSession(s, config), mainLifts)),
        { focus: "Forged", config, mainLifts },
      );
      // Sculpt may only exceed a ceiling where the Forged week already does.
      if ((forged[m] || 0) <= t.mrv) expect(v[m] || 0, m).toBeLessThanOrEqual(t.mrv);
    }
  });
});

describe("headroom restores the bump", () => {
  it("Push Press in the clean slot drops indirect glute work and ass2 gets its set back", () => {
    const mainLifts = { "Power Clean": "Push Press" };
    expect(sculptBumpBlockIds(defaultConfig, mainLifts).has("ass2")).toBe(true);
    const v = sculptWeek(defaultConfig, mainLifts);
    expect(v.Glutes).toBeLessThanOrEqual(VOLUME_TARGETS.Glutes.mrv);
  });
});

describe("the same answer on every surface", () => {
  it("per-session and per-week application agree block for block", () => {
    for (const mainLifts of [{}, { "Power Clean": "Push Press" }, { "Barbell Back Squat": "Front Squat" }]) {
      const week = applyFocusToSessions(SESSIONS, "Sculpt", defaultConfig, mainLifts);
      SESSIONS.forEach((s, i) => {
        const single = applyFocusToSession(s, "Sculpt", defaultConfig, mainLifts);
        expect(single.blocks.map((b) => b.sets)).toEqual(week[i].blocks.map((b) => b.sets));
      });
    }
  });

  it("is pure — repeat calls agree and the template is untouched", () => {
    const before = JSON.stringify(SESSIONS);
    const a = [...sculptBumpBlockIds(defaultConfig)].sort();
    const b = [...sculptBumpBlockIds(defaultConfig)].sort();
    expect(a).toEqual(b);
    expect(JSON.stringify(SESSIONS)).toBe(before);
  });

  it("an empty config bumps nothing, as before", () => {
    expect(sculptBumpBlockIds({}).size).toBe(0);
  });
});

describe("across rotations and anchors", () => {
  it("no solver config, with any single anchor swap, puts an aligned primary over MRV", () => {
    const seeded = (n) => () => { n = (n * 1103515245 + 12345) % 2147483648; return n / 2147483648; };
    const combos = [{}];
    for (const [c, alts] of Object.entries(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS)) for (const a of alts) combos.push({ [c]: a });
    const breaches = [];
    for (const mainLifts of combos) {
      for (let seed = 0; seed < 6; seed++) {
        let history = {}, config = null;
        const rng = seeded(seed * 7919 + 17);
        for (let block = 0; block < 3; block++) {
          if (config) history = pushHistoryBlock(history, config);
          config = solveRotation({ focus: "Sculpt", mainLifts, rng, history }).config;
          const v = sculptWeek(config, mainLifts);
          for (const m of SCULPT_ALIGNED_PRIMARIES) {
            if ((v[m] || 0) > VOLUME_TARGETS[m].mrv) breaches.push(`${JSON.stringify(mainLifts)} seed ${seed} block ${block + 1}: ${m} ${v[m]}`);
          }
        }
      }
    }
    expect(breaches).toEqual([]);
  }, 120_000); // ~250 Sculpt solves, each pricing the ceiling inside the objective
});
