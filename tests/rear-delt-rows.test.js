// One rear-delt row a day, and no day's list saying "rear delt" twice (owner,
// 2026-11-04): a flared cable row beside Rear Delt Row, or Cable Rear Delt Fly
// beside Rear Delt Fly, reads as the same lift twice. The bands decide first;
// the rule is the fallback, so it never costs a band.
import { describe, it, expect } from "vitest";
import { solveRotation } from "../lib/rotation-solver.js";
import { REAR_DELT_ROWS, REAR_DELT_NAMED, SESSIONS, EXERCISE_POOLS, FOCUS_OPTIONS, MAIN_LIFT_FUNCTIONAL_EQUIVALENTS, pushHistoryBlock } from "../lib/programme.js";
import { EXERCISE_ANATOMY } from "../lib/exercise-anatomy.js";

const mulberry = (seed) => {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const SAYS_REAR_DELT = /rear delt/i;
/** Each day's exercise names as the list shows them: rotated picks and fixed lifts. */
const dayNames = (config, session) => session.blocks.flatMap((b) =>
  [["ex", b.id], ["exA", `${b.id}-A`], ["exB", `${b.id}-B`]].filter(([f]) => b[f]).map(([f, key]) => (EXERCISE_POOLS[key] ? config[key]?.name : b[f].name)).filter(Boolean));
/** Session names breaking a rule: two rear-delt rows, or "rear delt" said twice. */
const doubled = (config) => SESSIONS.filter((s) => {
  const names = dayNames(config, s);
  return names.filter((n) => REAR_DELT_ROWS.has(n)).length > 1 || names.filter((n) => SAYS_REAR_DELT.test(n)).length > 1;
}).map((s) => s.name);

describe("one rear-delt row a day", () => {
  it("lists rows the catalogue holds, each crediting the rear delts", () => {
    expect([...REAR_DELT_ROWS].sort()).toEqual(["Rear Delt Row", "Single-Arm High Cable Row", "Wide-Grip Cable Row"]);
    for (const name of REAR_DELT_ROWS) {
      const a = EXERCISE_ANATOMY[name];
      expect(a, name).toBeDefined();
      expect(a.primary === "Rear Delts" || (a.secondary?.["Rear Delts"] || 0) >= 0.4, name).toBe(true);
    }
  });

  it("the named list is every pool or template lift that says rear delt", () => {
    const named = new Set([
      ...Object.values(EXERCISE_POOLS).flatMap((p) => p.pool.map((e) => e.name)),
      ...SESSIONS.flatMap((s) => s.blocks.flatMap((b) => [b.ex, b.exA, b.exB].filter(Boolean).map((e) => e.name))),
    ].filter((n) => SAYS_REAR_DELT.test(n)));
    expect([...REAR_DELT_NAMED].sort()).toEqual([...named].sort());
  });

  it("only Day C can hold two rows, from its back slot and its finisher", () => {
    const slots = Object.entries(EXERCISE_POOLS).filter(([, p]) => p.pool.some((e) => REAR_DELT_ROWS.has(e.name))).map(([k]) => k).sort();
    expect(slots).toEqual(["cfin-A", "css2-B"]);
  });

  for (const focus of FOCUS_OPTIONS) {
    it(`${focus}: 40 seeds, 4 chained rotations: never two on a day, never out of band`, () => {
      let rowInBack = 0, namedInFinisher = 0;
      for (let i = 0; i < 40; i++) {
        const rng = mulberry(7000 + i);
        let history = {}, config = null;
        for (let block = 0; block < 4; block++) {
          if (config) history = pushHistoryBlock(history, config);
          const r = solveRotation({ history, focus, rng });
          config = r.config;
          expect(r.report.outOfBand, `${focus} seed ${7000 + i} block ${block + 1}`).toEqual([]);
          expect(doubled(config), `${focus} seed ${7000 + i} block ${block + 1}`).toEqual([]);
          if (REAR_DELT_ROWS.has(config["css2-B"]?.name)) rowInBack++;
          if (REAR_DELT_NAMED.has(config["cfin-A"]?.name)) namedInFinisher++;
        }
      }
      // Both rules have work: a flared row often sits in the back slot, a lift
      // named rear delt often in the finisher, and still neither doubles.
      expect(rowInBack).toBeGreaterThan(10);
      expect(namedInFinisher).toBeGreaterThan(10);
    });
  }

  it("holds across every main-lift swap", () => {
    for (const [main, options] of Object.entries(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS)) {
      for (const o of options) {
        const name = typeof o === "string" ? o : o.name;
        for (const focus of FOCUS_OPTIONS) for (let s = 0; s < 4; s++) {
          const r = solveRotation({ focus, mainLifts: { [main]: name }, rng: mulberry(s) });
          expect(r.report.outOfBand, `${focus} ${main}->${name} seed ${s}`).toEqual([]);
          expect(doubled(r.config), `${focus} ${main}->${name} seed ${s}`).toEqual([]);
        }
      }
    }
  });
});
