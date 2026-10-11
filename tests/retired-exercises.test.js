// tests/retired-exercises.test.js
// A retired exercise is offered nowhere but still resolves for sets already
// logged under its name. Face-Away Cable Row (retired 2026-10-11) is the case.

import { describe, it, expect } from "vitest";
import {
  SESSIONS, EXERCISE_POOLS, SWAP_DB, MAIN_LIFT_FUNCTIONAL_EQUIVALENTS, RETIRED_EXERCISES,
  applyRotationToSession, dedupeRotationConfig, pushHistoryBlock,
} from "../lib/programme.js";
import { solveRotation, bandViolations } from "../lib/rotation-solver.js";
import { getLiftProfile } from "../lib/lift-translations.js";
import { EXERCISE_ANATOMY, getAnatomy, distributeAcrossMuscles } from "../lib/exercise-anatomy.js";
import { getTempo } from "../lib/exercise-tempo.js";
import { LIBRARY } from "../lib/library.js";
import { isSwapFor } from "../lib/trainer-change.js";

const RETIRED = "Face-Away Cable Row";

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

describe("retired exercises", () => {
  it("lists the retired row", () => {
    expect(RETIRED_EXERCISES.has(RETIRED)).toBe(true);
  });

  for (const name of RETIRED_EXERCISES) {
    it(`${name} still resolves: profile, anatomy, tempo`, () => {
      const profile = getLiftProfile(name);
      expect(profile.category).toBe("upper_pull");
      expect(profile.factor).toBe(0.55);
      expect(EXERCISE_ANATOMY[name]).toBeDefined();
      expect(getAnatomy(name)?.primary).toBe("Lats");
      expect(distributeAcrossMuscles(name, 1).Lats).toBe(1);
      expect(getTempo(name)?.tempo).toMatch(/^\d-\d-\d-\d$/);
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
  }

  it("a swap sheet opened on the retired name offers nothing", () => {
    // SessionScreen's SwapOverlay reads SWAP_DB[name] || [].
    expect(SWAP_DB[RETIRED] || []).toEqual([]);
    expect(isSwapFor(RETIRED, "Seated Cable Row")).toBe(false);
  });
});

describe("a stored rotation config naming the retired row", () => {
  const stale = { "css2-B": { name: RETIRED, reps: 10, weight: 26, muscle: "Mid back", loadType: "total" } };

  it("reads back as the slot default, not the retired lift", () => {
    const dayC = SESSIONS.find((s) => s.blocks.some((b) => b.id === "css2"));
    const out = applyRotationToSession(dayC, stale);
    const block = out.blocks.find((b) => b.id === "css2");
    expect(block.exB.name).toBe(EXERCISE_POOLS["css2-B"].pool[0].name);
    expect(block.exB.name).not.toBe(RETIRED);
  });

  it("read-time helpers neither throw nor rewrite it", () => {
    expect(dedupeRotationConfig(stale, {})).toBe(stale);
    expect(() => bandViolations(stale)).not.toThrow();
  });

  it("the next solve re-picks css2-B from the live pool, deterministically per seed", () => {
    const history = pushHistoryBlock({}, stale);
    expect(history["css2-B"]).toEqual([RETIRED]);
    for (const focus of ["Forged", "Strong", "Sculpt"]) {
      for (let seed = 1; seed <= 5; seed++) {
        const a = solveRotation({ history, focus, rng: seeded(seed) });
        const b = solveRotation({ history, focus, rng: seeded(seed) });
        expect(a.config["css2-B"]?.name, `${focus}/${seed}`).toBe(b.config["css2-B"]?.name);
        expect(poolNames("css2-B"), `${focus}/${seed}`).toContain(a.config["css2-B"].name);
      }
    }
  });
});

describe("the replacements", () => {
  it("css2-B carries Neutral-Grip Lat Pulldown; css3-A carries Face-Away Cable Curl", () => {
    expect(poolNames("css2-B")).toContain("Neutral-Grip Lat Pulldown");
    expect(poolNames("css3-A")).toContain("Face-Away Cable Curl");
  });

  it("both resolve through profile, anatomy, tempo and swaps", () => {
    expect(getLiftProfile("Neutral-Grip Lat Pulldown")).toMatchObject({ category: "upper_pull", factor: 0.85 });
    expect(getLiftProfile("Face-Away Cable Curl")).toMatchObject({ primaryMuscle: "Biceps", category: "accessory_arm", factor: 0.3, progressesByLoad: true });
    expect(getAnatomy("Neutral-Grip Lat Pulldown")?.primary).toBe("Lats");
    expect(getAnatomy("Face-Away Cable Curl")?.primary).toBe("Biceps");
    expect(getTempo("Neutral-Grip Lat Pulldown")).not.toBeNull();
    expect(getTempo("Face-Away Cable Curl")).not.toBeNull();
    expect(SWAP_DB["Face-Away Cable Curl"].map((o) => o.name)).toEqual(["Incline DB Curl", "DB Curl"]);
    expect(SWAP_DB["Neutral-Grip Lat Pulldown"].map((o) => o.name)).toEqual(["Lat Pulldown", "Neutral-Grip Pull-Up"]);
  });
});
