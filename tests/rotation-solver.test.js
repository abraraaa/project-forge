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
import { solveRotation, volumeObjective, FOCUS_VOLUME_PROFILES } from "../lib/rotation-solver.js";
import { EXERCISE_POOLS, FOCUS_OPTIONS } from "../lib/programme.js";

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

  it("Strong's floor-exempt arms may sit under MEV without counting as failure", () => {
    // The exemption is a stated trade, not an accident — lock that the
    // profile carries it so a refactor can't silently start punishing it.
    expect(FOCUS_VOLUME_PROFILES.Strong.floorExempt.has("Biceps")).toBe(true);
    expect(FOCUS_VOLUME_PROFILES.Strong.floorExempt.has("Triceps")).toBe(true);
  });
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
