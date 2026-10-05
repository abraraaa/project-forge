// tests/rotation-balance.test.js
// The session CNS budget in lib/rotation-solver.js. Day A already carries
// two primary mains (squat, bench) and a lunge-type accessory in ass1-A, so
// a loaded hip-thrust-family pick in ass2-A makes it the heaviest day of the
// week. The budget steers that family to C (css1-A offers it too) without
// touching the random search, pools, bands or near-tie rule.

import { describe, it, expect, beforeAll } from "vitest";
import {
  solveRotation, sessionCnsLoad, dayBudget, cnsCost,
  SESSION_CNS_CAP, MAIN_LOAD_MULTIPLIER,
} from "../lib/rotation-solver.js";
import { SESSIONS, EXERCISE_POOLS, FOCUS_OPTIONS, pushHistoryBlock, mainLiftOptions } from "../lib/programme.js";
import { getLiftProfile } from "../lib/lift-translations.js";

// mulberry32, as in tests/rotation-solver.test.js.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HIP_THRUST_FAMILY = new Set(["Barbell Hip Thrust", "Barbell Glute Bridge", "B-Stance Hip Thrust"]);
const SPLIT_SQUAT_TYPE = /split squat|lunge|step-?up/i;
const [A, B, C] = SESSIONS;
const names = (key) => EXERCISE_POOLS[key].pool.map((ex) => ex.name);
const SEEDS = 200;

describe("pools", () => {
  it("the hip-thrust family is offered in css1-A and still in ass2-A", () => {
    for (const name of HIP_THRUST_FAMILY) {
      expect(names("css1-A")).toContain(name);
      expect(names("ass2-A")).toContain(name);
    }
    // Default unchanged: pool[0] is still the template's lunge.
    expect(EXERCISE_POOLS["css1-A"].pool[0].name).toBe("DB Walking Lunge");
  });

  it("every ass1-A pick is split-squat-type, so the rule is about ass2-A", () => {
    for (const name of names("ass1-A")) expect(name).toMatch(SPLIT_SQUAT_TYPE);
  });
});

describe("cnsCost", () => {
  const ex = (name, weight = 20) => ({ name, weight });

  it("lower compounds and power cost most, upper compounds less, isolation and bodyweight least", () => {
    const squat = cnsCost(ex("Barbell Back Squat"));
    const clean = cnsCost(ex("Power Clean"));
    const bench = cnsCost(ex("Barbell Bench Press"));
    const row = cnsCost(ex("Seated Cable Row"));
    const raise = cnsCost(ex("Lateral Raise"));
    const frog = cnsCost({ name: "Frog Pump", weight: null });
    expect(squat).toBe(clean);
    expect(squat).toBeGreaterThan(bench);
    expect(bench).toBeGreaterThan(row);
    expect(row).toBeGreaterThan(raise);
    expect(raise).toBe(frog);
  });

  it("accessory compounds scale by factor", () => {
    expect(cnsCost(ex("B-Stance Hip Thrust"))).toBeGreaterThan(cnsCost(ex("Single-Leg Hip Thrust")));
    expect(cnsCost(ex("Barbell Front Rack Lunge"))).toBeGreaterThan(cnsCost(ex("DB Reverse Lunge")));
  });

  it("an accessory without external load is cheap whatever its category", () => {
    expect(cnsCost({ name: "Banded Hip Thrust", weight: null })).toBeLessThan(cnsCost(ex("Banded Hip Thrust")));
    expect(cnsCost({ name: "Pull-Up", weight: null })).toBeLessThan(cnsCost({ name: "Weighted Pull-Up", weight: 8 }));
  });

  it("a main costs more than the same lift as an accessory; a secondary main less than a primary", () => {
    const ohp = ex("Barbell Overhead Press");
    expect(MAIN_LOAD_MULTIPLIER.secondary).toBeLessThan(MAIN_LOAD_MULTIPLIER.primary);
    expect(cnsCost(ohp, "primary")).toBeGreaterThan(cnsCost(ohp, "secondary"));
    expect(cnsCost(ohp, "secondary")).toBeGreaterThanOrEqual(cnsCost(ohp));
  });

  it("a main costs its category, not its load factor: every squat option costs the same", () => {
    const squat = cnsCost(ex("Barbell Back Squat"), "primary");
    for (const name of mainLiftOptions("Barbell Back Squat")) expect(cnsCost(ex(name), "primary"), name).toBe(squat);
  });
});

describe("dayBudget and sessionCnsLoad", () => {
  it("only B's overhead press is marked secondary", () => {
    const mains = SESSIONS.flatMap((s) => s.blocks.filter((b) => b.type === "main"));
    expect(mains.filter((b) => b.load === "secondary").map((b) => b.ex.name)).toEqual(["Barbell Overhead Press"]);
  });

  it("two primary mains leave the least room, C's one main the most", () => {
    expect(dayBudget(A)).toBeLessThan(dayBudget(B));
    expect(dayBudget(B)).toBeLessThan(dayBudget(C));
    expect(dayBudget(C)).toBeLessThan(SESSION_CNS_CAP);
  });

  it("the budget follows the main's load field, not the day letter", () => {
    const relabel = (session, id, load) => ({
      ...session,
      blocks: session.blocks.map((b) => (b.id === id ? { ...b, load } : b)),
    });
    const ohp = cnsCost(B.blocks.find((b) => b.id === "b2").ex, "primary")
      - cnsCost(B.blocks.find((b) => b.id === "b2").ex, "secondary");
    expect(dayBudget(relabel(B, "b2", undefined))).toBeCloseTo(dayBudget(B) - ohp, 9);
    expect(dayBudget(relabel(A, "a2", "secondary"))).toBeGreaterThan(dayBudget(A));
  });

  it("the load counts mains and accessories, as trained under the focus", () => {
    const mainsOnly = { ...A, blocks: A.blocks.filter((b) => b.type === "main") };
    expect(sessionCnsLoad(mainsOnly)).toBeCloseTo(SESSION_CNS_CAP - dayBudget(A), 9);
    expect(sessionCnsLoad(A)).toBeGreaterThan(sessionCnsLoad(mainsOnly));
    // Strong drops ass2: the hip extension and landmine press leave A's load.
    expect(sessionCnsLoad(A, {}, { focus: "Strong" })).toBeLessThan(sessionCnsLoad(A));
    // Pure: the inputs are not touched.
    const snapshot = JSON.stringify(A);
    sessionCnsLoad(A, { "ass2-A": EXERCISE_POOLS["ass2-A"].pool[5] }, { focus: "Sculpt" });
    expect(JSON.stringify(A)).toBe(snapshot);
  });

  it("a squat day with a lunge and any loaded hip-thrust-family pick is over budget", () => {
    // Exhaustive over A's rotating slots: the lightest such A still breaches.
    const over = (config) => sessionCnsLoad(A, config) > SESSION_CNS_CAP;
    let lightest = Infinity;
    for (const a of EXERCISE_POOLS["ass1-A"].pool)
      for (const b of EXERCISE_POOLS["ass1-B"].pool)
        for (const ht of EXERCISE_POOLS["ass2-A"].pool.filter((ex) => HIP_THRUST_FAMILY.has(ex.name)))
          for (const d of EXERCISE_POOLS["ass2-B"].pool) {
            const config = { "ass1-A": a, "ass1-B": b, "ass2-A": ht, "ass2-B": d };
            expect(over(config), `${a.name} + ${ht.name}`).toBe(true);
            lightest = Math.min(lightest, sessionCnsLoad(A, config));
          }
    expect(lightest).toBeGreaterThan(SESSION_CNS_CAP);
  });

  it("the A, B and C templates sit inside their budgets; C has room for the family", () => {
    // A's ass2 defaults to a bodyweight hip extension, so even the
    // un-rotated A is under the cap.
    expect(EXERCISE_POOLS["ass2-A"].pool[0].name).toBe("45-Degree Hip Extension");
    expect(sessionCnsLoad(A)).toBeLessThan(SESSION_CNS_CAP);
    expect(sessionCnsLoad(B)).toBeLessThanOrEqual(SESSION_CNS_CAP);
    expect(sessionCnsLoad(C)).toBeLessThanOrEqual(SESSION_CNS_CAP);
    for (const name of HIP_THRUST_FAMILY) {
      const ht = EXERCISE_POOLS["css1-A"].pool.find((ex) => ex.name === name);
      expect(sessionCnsLoad(C, { "css1-A": ht }), name).toBeLessThanOrEqual(SESSION_CNS_CAP);
    }
  });
});

describe(`solver: ${SEEDS} seeds per focus`, () => {
  /** @type {Record<string, Array<ReturnType<typeof solveRotation>>>} */
  const runs = {};
  beforeAll(() => {
    for (const focus of FOCUS_OPTIONS) {
      runs[focus] = [];
      for (let i = 0; i < SEEDS; i++) runs[focus].push(solveRotation({ focus, rng: seeded(20000 + i) }));
    }
  }, 120_000);

  for (const focus of FOCUS_OPTIONS) {
    it(`${focus}: A never holds a split-squat-type and a hip-thrust-family accessory with the squat`, () => {
      const both = runs[focus].filter(({ config }) =>
        SPLIT_SQUAT_TYPE.test(config["ass1-A"].name) && HIP_THRUST_FAMILY.has(config["ass2-A"]?.name));
      expect(both.length).toBe(0);
    });

    it(`${focus}: the hip-thrust family lands on C at least as often as on A`, () => {
      const onA = runs[focus].filter(({ config }) => HIP_THRUST_FAMILY.has(config["ass2-A"]?.name)).length;
      const onC = runs[focus].filter(({ config }) => HIP_THRUST_FAMILY.has(config["css1-A"].name)).length;
      expect(onC).toBeGreaterThanOrEqual(onA);
      expect(onC).toBeGreaterThan(0);
    });

    it(`${focus}: every solve in band and inside every day's budget`, () => {
      for (const { report } of runs[focus]) {
        expect(report.outOfBand).toEqual([]);
        expect(report.overBudget).toEqual([]);
      }
    });
  }

  it("Strong still solves without its dropped blocks", () => {
    for (const { config } of runs.Strong) {
      for (const key of ["ass2-A", "ass2-B", "bss2-A", "bss2-B", "css3-A", "css3-B"]) expect(config[key]).toBeUndefined();
    }
  });

  it("chained rotations with memory keep the family off A", () => {
    for (const focus of FOCUS_OPTIONS) {
      for (let i = 0; i < 20; i++) {
        const rng = seeded(60000 + i);
        let history = {}, config = null;
        for (let block = 0; block < 5; block++) {
          if (config) history = pushHistoryBlock(history, config);
          const r = solveRotation({ history, focus, rng });
          config = r.config;
          expect(HIP_THRUST_FAMILY.has(config["ass2-A"]?.name), `${focus} ${60000 + i}/${block + 1}`).toBe(false);
          expect(r.report.overBudget).toEqual([]);
        }
      }
    }
  }, 60_000);
});

describe("the fill's over-budget redraw", () => {
  // Repair off, so the week returned is the greedy fill: without the redraw
  // the fill hands A the family alongside the squat and a lunge; with it,
  // never. (With repair on, the repair pass also clears it.)
  const both = (opts) => {
    let n = 0;
    for (let i = 0; i < SEEDS; i++) {
      const { config } = solveRotation({ focus: "Forged", rng: seeded(20000 + i), repairPasses: 0, ...opts });
      if (SPLIT_SQUAT_TYPE.test(config["ass1-A"].name) && HIP_THRUST_FAMILY.has(config["ass2-A"]?.name)) n++;
    }
    return n;
  };

  it("is load-bearing: off, at least one Forged seed breaches; on, none", () => {
    expect(both({ fillRedraw: false })).toBeGreaterThan(0);
    expect(both({})).toBe(0);
  }, 60_000);
});

describe("a squat variant as A's main", () => {
  it("Front Squat or Hack Squat: the family still never lands on A", () => {
    for (const squat of ["Front Squat", "Hack Squat"]) {
      for (const focus of ["Forged", "Sculpt"]) {
        for (let i = 0; i < 50; i++) {
          const { config, report } = solveRotation({ focus, rng: seeded(40000 + i), mainLifts: { "Barbell Back Squat": squat } });
          expect(HIP_THRUST_FAMILY.has(config["ass2-A"]?.name), `${squat} ${focus} ${40000 + i}`).toBe(false);
          expect(report.overBudget).toEqual([]);
        }
      }
    }
  }, 60_000);
});

describe("equivalence: within budget the solver is the volume solver", () => {
  // The budget only redraws a pick that would breach, so a week the volume
  // solver fills without ever breaching is drawn identically. Repair off
  // and memory kept, so the returned week is that fill.
  it("Forged and Sculpt: every week the budget-off fill keeps within budget is byte-identical", () => {
    for (const focus of ["Forged", "Sculpt"]) {
      let compared = 0;
      for (let i = 0; i < SEEDS; i++) {
        const off = solveRotation({ focus, rng: seeded(20000 + i), cnsBudget: false, repairPasses: 0 });
        if (off.report.overBudget.length || off.report.outOfBand.length || off.report.memoryRelaxed) continue;
        const on = solveRotation({ focus, rng: seeded(20000 + i), repairPasses: 0 });
        expect(JSON.stringify(on.config), `${focus} ${20000 + i}`).toBe(JSON.stringify(off.config));
        compared++;
      }
      expect(compared, focus).toBeGreaterThan(SEEDS / 4);
    }
  }, 60_000);


  it("Strong never breaches, so every seed matches the budget-off solve exactly", () => {
    for (let i = 0; i < 50; i++) {
      const on = solveRotation({ focus: "Strong", rng: seeded(30000 + i) });
      const off = solveRotation({ focus: "Strong", rng: seeded(30000 + i), cnsBudget: false });
      expect(JSON.stringify(on.config)).toBe(JSON.stringify(off.config));
      expect(on.report.objective).toBe(off.report.objective);
      expect(on.report.overBudget).toEqual([]);
    }
  }, 30_000);
});

describe("Leg Press Calf Raise", () => {
  it("has its calf profile, not an inferred upper_push", () => {
    expect(getLiftProfile("Leg Press Calf Raise")).toEqual({
      primaryMuscle: "Calves", category: "accessory_isolation", factor: 0, progressesByLoad: true,
    });
    expect(getLiftProfile("Leg Press Calf Raise")).toEqual(getLiftProfile("Standing Calf Raise"));
  });
});
