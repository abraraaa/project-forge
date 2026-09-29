// tests/rotation-solver.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The volume-solving rotation's acceptance contract, born from the audit
// measurement: the legacy dice walked 65–71% of rotations out of at least
// one MEV..MRV band (Sculpt → Glutes over MRV in 40% of rolls). The solver's
// job is to take that to zero WITHOUT collapsing into the same "optimal"
// config every block — sterility is a worse bug than drift.
//
//   1. Band contract: across seeded runs, no config leaves a muscle out of
//      band (Strong's floor-exempt arms excluded — its documented trade).
//   2. Diversity contract: across seeded runs, multi-candidate slots see
//      more than one distinct pick — the temperature is alive.
//   3. Determinism: same seed → same config (the injected rng exists so
//      this file can exist).
//   4. Hard filters hold: recency memory + cross-slot uniqueness survive.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { solveRotation, volumeObjective, FOCUS_VOLUME_PROFILES, STRONG_PRESS_ONLY_SLOTS, poolFor } from "../lib/rotation-solver.js";
import { getAnatomy } from "../lib/exercise-anatomy.js";
import { EXERCISE_POOLS, FOCUS_OPTIONS, pushHistoryBlock } from "../lib/programme.js";
import { VOLUME_TARGETS } from "../lib/volume-audit.js";

// mulberry32 — tiny seeded PRNG, good enough for sampling tests.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RUNS = 20;

describe("band contract — rotations stay inside every landmark band", () => {
  for (const focus of FOCUS_OPTIONS) {
    it(`${focus}: ${RUNS} seeded solves, zero out-of-band configs`, () => {
      for (let i = 0; i < RUNS; i++) {
        const { report } = solveRotation({ focus, rng: seeded(1000 + i) });
        expect(report.outOfBand, `${focus} seed ${1000 + i}: ${report.outOfBand}`).toEqual([]);
      }
    });
  }

  // From empty history every focus was already clean; the failures lived
  // three and four rotations deep, where the recency memory had excluded
  // every in-band candidate. This chains rotations so the test can see it.
  for (const focus of FOCUS_OPTIONS) {
    it(`${focus}: 5 chained rotations, memory carried, zero out-of-band`, () => {
      for (let i = 0; i < RUNS; i++) {
        const rng = seeded(5000 + i);
        let history = {}, config = null;
        for (let block = 0; block < 5; block++) {
          if (config) history = pushHistoryBlock(history, config);
          const r = solveRotation({ history, focus, rng });
          config = r.config;
          expect(r.report.outOfBand, `${focus} seed ${5000 + i} block ${block + 1}: ${r.report.outOfBand}`).toEqual([]);
        }
      }
    });
  }

  it("memory yields to the band: Forged seed 5029, fourth chained rotation", () => {
    // The one seed family where the remembered week breaks a band. Remove the
    // relaxed second solve and this goes red; the loop above cannot tell.
    const rng = seeded(5029);
    let history = {}, config = null, r;
    for (let block = 0; block < 4; block++) {
      if (config) history = pushHistoryBlock(history, config);
      r = solveRotation({ history, focus: "Forged", rng });
      config = r.config;
      if (block < 3) expect(r.report.memoryRelaxed).toBe(false);
    }
    expect(r.report.memoryRelaxed).toBe(true);
    expect(r.report.outOfBand).toEqual([]);
  });

  it("Strong's floor-exempt arms may sit under MEV without counting as failure", () => {
    // The exemption is a stated trade, not an accident — lock that the
    // profile carries it so a refactor can't silently start punishing it.
    expect(FOCUS_VOLUME_PROFILES.Strong.floorExempt.has("Biceps")).toBe(true);
    expect(FOCUS_VOLUME_PROFILES.Strong.floorExempt.has("Triceps")).toBe(true);
  });
});

describe("Strong Triceps holds MEV across rotations", () => {
  // Apart from css2-A, Strong's Triceps volume comes from bench, OHP, the bfin
  // pushdown and (secondarily) css2-B's straight-arm pulldown. A fly there left 12.5% of fresh and 24.5% of chained solves under
  // MEV; with css2-A pressing-only, 400 fresh + 100×6 chained solves all land
  // at or above it (min 6.6 default mains, 6.1 with Incline BB + Arnold).
  const mev = VOLUME_TARGETS.Triceps.mev;
  const LOWEST_TRICEPS_MAINS = { "Barbell Bench Press": "Incline BB Press", "Barbell Overhead Press": "Arnold Press" };

  for (const [label, mainLifts] of [["default mains", {}], ["lowest-triceps mains", LOWEST_TRICEPS_MAINS]]) {
    it(`${label}: every fresh and chained Strong solve is at or above MEV`, () => {
      const under = [];
      for (let i = 0; i < 400; i++) {
        const { report } = solveRotation({ focus: "Strong", mainLifts, rng: seeded(10000 + i) });
        if (report.volume.Triceps < mev) under.push(`fresh ${10000 + i}: ${report.volume.Triceps}`);
      }
      for (let i = 0; i < 100; i++) {
        const rng = seeded(50000 + i);
        let history = {}, config = null;
        for (let block = 0; block < 6; block++) {
          if (config) history = pushHistoryBlock(history, config);
          const r = solveRotation({ history, focus: "Strong", mainLifts, rng });
          config = r.config;
          if (r.report.volume.Triceps < mev) under.push(`chain ${50000 + i}/${block + 1}: ${r.report.volume.Triceps}`);
        }
      }
      expect(under).toEqual([]);
    }, 30_000); // ~4s alone; headroom for a loaded full-suite run
  }

  it("css2-A offers only Triceps-crediting presses under Strong, flies elsewhere", () => {
    expect(STRONG_PRESS_ONLY_SLOTS.has("css2-A")).toBe(true);
    const flies = ["DB Chest Fly", "Low-to-High Cable Fly"];
    const slot = EXERCISE_POOLS["css2-A"];
    // Pool-level check: sampled Forged picks land on a fly too rarely to be a
    // sturdy witness that the restriction is Strong-only.
    const forgedPool = poolFor("css2-A", slot, "Forged").map((ex) => ex.name);
    for (const fly of flies) expect(forgedPool).toContain(fly);
    const strongPool = poolFor("css2-A", slot, "Strong");
    expect(strongPool.length).toBeGreaterThanOrEqual(3);
    for (const ex of strongPool) {
      const a = getAnatomy(ex.name);
      expect(a.primary === "Triceps" || (a.secondary?.Triceps || 0) > 0, ex.name).toBe(true);
    }
    const strongPicks = new Set();
    for (let i = 0; i < 100; i++) {
      strongPicks.add(solveRotation({ focus: "Strong", rng: seeded(10000 + i) }).config["css2-A"].name);
    }
    for (const fly of flies) expect(strongPicks.has(fly)).toBe(false);
    expect(strongPicks.size).toBeGreaterThanOrEqual(3);
  }, 30_000);
});

describe("diversity contract — the temperature is alive", () => {
  it("multi-candidate slots see >1 distinct pick across seeded runs (Forged)", () => {
    const picksBySlot = {};
    for (let i = 0; i < RUNS; i++) {
      const { config } = solveRotation({ focus: "Forged", rng: seeded(2000 + i) });
      for (const [key, ex] of Object.entries(config)) {
        (picksBySlot[key] ||= new Set()).add(ex.name);
      }
    }
    const multiCandidate = Object.entries(EXERCISE_POOLS)
      .filter(([, slot]) => {
        const on = slot.loadProfile
          ? slot.pool.filter((ex) => ex.loadProfile === slot.loadProfile)
          : slot.pool;
        return on.length >= 3;
      })
      .map(([key]) => key);
    const varied = multiCandidate.filter((key) => (picksBySlot[key]?.size ?? 0) > 1);
    // At least two thirds of the roomy slots must vary across 20 runs —
    // an argmax-collapsed solver fails this immediately.
    expect(varied.length).toBeGreaterThanOrEqual(Math.ceil(multiCandidate.length * (2 / 3)));
  });
});

describe("determinism + hard filters", () => {
  it("same seed → same config", () => {
    const a = solveRotation({ focus: "Sculpt", rng: seeded(7) });
    const b = solveRotation({ focus: "Sculpt", rng: seeded(7) });
    expect(a.config).toEqual(b.config);
  });

  it("recency memory is honoured when alternatives exist", () => {
    const { config } = solveRotation({ focus: "Forged", rng: seeded(9) });
    // Build a history that excludes every pick just made, then re-solve:
    // no slot with room should repeat its excluded name.
    const history = {};
    for (const [key, ex] of Object.entries(config)) history[key] = [ex.name];
    const second = solveRotation({ focus: "Forged", rng: seeded(9), history });
    for (const [key, ex] of Object.entries(second.config)) {
      const slot = EXERCISE_POOLS[key];
      const on = slot.loadProfile
        ? slot.pool.filter((e) => e.loadProfile === slot.loadProfile)
        : slot.pool;
      if (on.length >= 2) {
        expect(ex.name, `slot ${key} repeated its excluded pick`).not.toBe(history[key][0]);
      }
    }
  });

  it("no cross-slot duplicates", () => {
    for (let i = 0; i < 10; i++) {
      const { config } = solveRotation({ focus: "Sculpt", rng: seeded(3000 + i) });
      const names = Object.values(config).map((ex) => ex.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe("volumeObjective — the shape of the cost", () => {
  it("out-of-band costs dominate soft drift", () => {
    const inBand = { Quads: 15, Chest: 12, Back: 15 };
    const overMrv = { ...inBand, Quads: 25 }; // mrv 22
    expect(volumeObjective(overMrv, "Forged")).toBeGreaterThan(
      volumeObjective(inBand, "Forged") + 100,
    );
  });
});

describe("near-ties share the slot", () => {
  // ass1-A's lunge candidates score within ~2% of each other. Rounding-level
  // anatomy weights used to hand one of them 38% of Forged picks.
  it("no ass1-A candidate takes more than 30% of 400 Forged solves", () => {
    const counts = {};
    for (let i = 0; i < 400; i++) {
      const n = solveRotation({ focus: "Forged", rng: seeded(10000 + i) }).config["ass1-A"]?.name;
      counts[n] = (counts[n] || 0) + 1;
    }
    expect(Math.max(...Object.values(counts)) / 400).toBeLessThan(0.3);
    expect(Object.keys(counts).length).toBeGreaterThanOrEqual(5);
  });
});
