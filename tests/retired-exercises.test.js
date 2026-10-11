// tests/retired-exercises.test.js
// A retired exercise is offered nowhere but still resolves for sets already
// logged under its name. Every check runs over RETIRED_EXERCISES, so retiring
// another lift adds a case rather than breaking one.

import { describe, it, expect } from "vitest";
import {
  SESSIONS, EXERCISE_POOLS, SWAP_DB, MAIN_LIFT_FUNCTIONAL_EQUIVALENTS, RETIRED_EXERCISES, RETIRED_LOAD_TYPES,
  applyRotationToSession, dedupeRotationConfig, pushHistoryBlock,
} from "../lib/programme.js";
import { solveRotation, bandViolations } from "../lib/rotation-solver.js";
import { getLiftProfile, inferLoadType, __test__ } from "../lib/lift-translations.js";
import { EXERCISE_ANATOMY, getAnatomy, distributeAcrossMuscles } from "../lib/exercise-anatomy.js";
import { getTempo } from "../lib/exercise-tempo.js";
import { LIBRARY } from "../lib/library.js";
import { isSwapFor } from "../lib/trainer-change.js";
import { loadTypeOfName } from "../lib/programme-resolve.js";

// mulberry32, as in rotation-solver.test.js.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const poolNames = (key) => EXERCISE_POOLS[key].pool.map((e) => e.name);
const pool = (key, name) => EXERCISE_POOLS[key].pool.find((e) => e.name === name);
const LOAD_TYPES = new Set(["barbell", "per_db", "total", "machine", "external", "bodyweight", "loaded_bodyweight", "assisted_bodyweight"]);

describe("retired exercises", () => {
  it("lists Face-Away Cable Row, each name with the load type its sets were logged under", () => {
    expect(RETIRED_EXERCISES.has("Face-Away Cable Row")).toBe(true);
    expect(RETIRED_LOAD_TYPES["Face-Away Cable Row"]).toBe("total");
    expect([...RETIRED_EXERCISES].sort()).toEqual(Object.keys(RETIRED_LOAD_TYPES).sort());
  });

  for (const name of RETIRED_EXERCISES) {
    it(`${name} still resolves: its own profile, anatomy, tempo`, () => {
      expect(Object.hasOwn(__test__.PROFILES, name), "an explicit profile, not inference").toBe(true);
      expect(getLiftProfile(name)).toBe(__test__.PROFILES[name]);
      const anatomy = EXERCISE_ANATOMY[name];
      expect(anatomy).toBeDefined();
      expect(getAnatomy(name)).toBe(anatomy);
      expect(distributeAcrossMuscles(name, 1)[anatomy.primary]).toBe(1);
      expect(getTempo(name)?.tempo).toMatch(/^[\dX]-[\dX]-[\dX]-[\dX]$/);
    });

    it(`${name} keeps its stored load type, not name inference`, () => {
      const lt = RETIRED_LOAD_TYPES[name];
      expect(LOAD_TYPES.has(lt), lt).toBe(true);
      expect(loadTypeOfName(name)).toBe(lt);
    });

    it(`${name} is offered nowhere and has no library page`, () => {
      for (const s of SESSIONS) {
        for (const b of s.blocks) {
          for (const ex of [b.ex, b.exA, b.exB]) expect(ex?.name, `${s.name}/${b.id}`).not.toBe(name);
        }
      }
      for (const [key, slot] of Object.entries(EXERCISE_POOLS)) {
        expect(slot.pool.map((e) => e.name), key).not.toContain(name);
      }
      expect(Object.hasOwn(SWAP_DB, name)).toBe(false);
      for (const [host, alts] of Object.entries(SWAP_DB)) {
        expect(alts.map((a) => a.name), host).not.toContain(name);
        expect(isSwapFor(host, name), host).toBe(false);
      }
      for (const alts of Object.values(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS)) expect(alts).not.toContain(name);
      expect(LIBRARY.some((e) => e.name === name)).toBe(false);
    });

    it(`a swap sheet opened on ${name} offers nothing`, () => {
      // SessionScreen's SwapOverlay reads SWAP_DB[name] || [].
      expect(SWAP_DB[name] || []).toEqual([]);
      for (const host of Object.keys(SWAP_DB)) expect(isSwapFor(name, host), host).toBe(false);
    });
  }

  it("the Face-Away Cable Row case: inference alone would have read it as external", () => {
    // Why the stored type is carried: no pool entry is left to give it.
    expect(inferLoadType("Face-Away Cable Row")).toBe("external");
    expect(loadTypeOfName("Face-Away Cable Row")).toBe("total");
  });
});

describe("a stored rotation config naming a retired lift", () => {
  // Every accessory slot at once: a stored config can only name a slot key.
  const staleFor = (name) => Object.fromEntries(
    Object.keys(EXERCISE_POOLS).map((key) => [key, { name, reps: 10, weight: 26, muscle: "Mid back", loadType: RETIRED_LOAD_TYPES[name] }]),
  );

  for (const name of RETIRED_EXERCISES) {
    it(`${name} reads back as each slot's default`, () => {
      const stale = staleFor(name);
      for (const s of SESSIONS) {
        expect(applyRotationToSession(s, stale), s.name).toEqual(s);
      }
    });

    it(`${name}: read-time helpers neither throw nor rewrite it`, () => {
      // One slot at a time: the same name in two slots is a duplicate to dedupe.
      for (const [key, entry] of Object.entries(staleFor(name))) {
        const stale = { [key]: entry };
        expect(dedupeRotationConfig(stale, {}), key).toBe(stale);
        expect(() => bandViolations(stale), key).not.toThrow();
      }
    });

    it(`${name}: the next solve re-picks from the live pools, deterministically per seed`, () => {
      const history = pushHistoryBlock({}, staleFor(name));
      for (const key of Object.keys(EXERCISE_POOLS)) expect(history[key], key).toEqual([name]);
      for (const focus of ["Forged", "Strong", "Sculpt"]) {
        for (let seed = 1; seed <= 5; seed++) {
          const a = solveRotation({ history, focus, rng: seeded(seed) });
          const b = solveRotation({ history, focus, rng: seeded(seed) });
          expect(a.config, `${focus}/${seed}`).toEqual(b.config);
          for (const [key, entry] of Object.entries(a.config)) {
            if (!EXERCISE_POOLS[key]) continue;
            expect(poolNames(key), `${focus}/${seed}/${key}`).toContain(entry.name);
          }
        }
      }
    });
  }
});

describe("this change's library entries", () => {
  it("css2-B stays a horizontal row: Single-Arm High Cable Row on the retained clip", () => {
    expect(pool("css2-B", "Single-Arm High Cable Row")).toMatchObject({ reps: 10, weight: 18, muscle: "Upper back", vid: "WYCnIThgbB8", loadType: "total" });
    expect(poolNames("css2-B")).not.toContain("Neutral-Grip Lat Pulldown");
    expect(getLiftProfile("Single-Arm High Cable Row")).toEqual(getLiftProfile("Single-Arm Cable Row"));
    expect(getAnatomy("Single-Arm High Cable Row")?.primary).toBe("Upper Back");
    expect(Object.keys(getAnatomy("Single-Arm High Cable Row")?.secondary ?? {})).toEqual(expect.arrayContaining(["Rear Delts", "Lats", "Biceps"]));
    expect(getTempo("Single-Arm High Cable Row")).toMatchObject({ tempo: "3-1-2-0", evidence: "derived", sources: ["schoenfeld2015"] });
    expect(SWAP_DB["Single-Arm High Cable Row"].map((o) => o.name)).toEqual(["Single-Arm Cable Row", "Half-Kneeling Cable Row"]);
  });

  it("Neutral-Grip Lat Pulldown sits in the Day B vertical pull pool, on its own clip", () => {
    expect(pool("bss1-B", "Neutral-Grip Lat Pulldown")).toMatchObject({ vid: "lD7kUhsYO3Y", loadType: "total" });
    expect(getLiftProfile("Neutral-Grip Lat Pulldown")).toEqual(getLiftProfile("Lat Pulldown"));
    expect(getAnatomy("Neutral-Grip Lat Pulldown")?.primary).toBe("Lats");
    expect(getTempo("Neutral-Grip Lat Pulldown")).not.toBeNull();
    const swaps = SWAP_DB["Neutral-Grip Lat Pulldown"].map((o) => o.name);
    expect(swaps).toEqual(["Lat Pulldown", "Neutral-Grip Pull-Up"]);
    for (const s of swaps) expect(poolNames("bss1-B"), s).toContain(s);
  });

  it("Bayesian Cable Curl sits with the curls; the working name is gone everywhere", () => {
    expect(pool("css3-A", "Bayesian Cable Curl")).toMatchObject({ reps: 12, weight: 10, vid: "wuqwlIL37kE", loadType: "total" });
    expect(getLiftProfile("Bayesian Cable Curl")).toEqual({ primaryMuscle: "Biceps", category: "accessory_arm", factor: 0.3, progressesByLoad: true });
    expect(getAnatomy("Bayesian Cable Curl")?.primary).toBe("Biceps");
    expect(getTempo("Bayesian Cable Curl")).not.toBeNull();
    expect(SWAP_DB["Bayesian Cable Curl"].map((o) => o.name)).toEqual(["Incline DB Curl", "DB Curl"]);
    const old = "Face-Away Cable Curl";
    expect(Object.hasOwn(__test__.PROFILES, old)).toBe(false);
    expect(Object.hasOwn(EXERCISE_ANATOMY, old)).toBe(false);
    expect(getTempo(old)).toBeNull();
    expect(Object.hasOwn(SWAP_DB, old)).toBe(false);
    for (const slot of Object.values(EXERCISE_POOLS)) expect(slot.pool.map((e) => e.name)).not.toContain(old);
  });
});
