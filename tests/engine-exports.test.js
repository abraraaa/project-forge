// The engine's constants and finders, exported for the trainer-change
// validator (lib/trainer-change.js), which must use them and never copy them.
// E3: the validator's weight top is exactly the sanitiser's bound.
import { describe, it, expect } from "vitest";
import * as progression from "@/lib/progression";
import {
  findMostRecentLiftSession, topSetWeight, MAX_JUMP_FRACTION, deloadIntensityFor,
  RECOVERY_SESSIONS_PER_LIFT, ADOPT_MIN_REPS, computeDeloadPrescription, __test__,
} from "@/lib/progression";
import {
  WORKING_WEIGHT_MAX_KG, sanitiseWorkingWeights, CATEGORY_COLD_START_MAX_KG, getLiftProfile,
  getLoadType, swapLoadType, nextRung,
} from "@/lib/lift-translations";
import { TYPE_LABEL, normaliseWeek } from "@/lib/sync-merge";
import { SESSIONS, EXERCISE_POOLS, SWAP_DB } from "@/lib/programme";

/** Every lift the programme can put in front of a lifter, with its load type. */
function catalogue() {
  /** @type {Map<string, string>} */
  const out = new Map();
  const put = (name, lt) => { if (name && !out.has(name)) out.set(name, lt); };
  for (const s of SESSIONS) for (const b of s.blocks || []) for (const ex of [b.ex, b.exA, b.exB]) if (ex) put(ex.name, getLoadType(ex));
  for (const slot of Object.values(EXERCISE_POOLS)) for (const ex of slot.pool || []) put(ex.name, getLoadType(ex));
  for (const alts of Object.values(SWAP_DB)) for (const a of alts || []) put(a.name, swapLoadType(a));
  return [...out.entries()];
}

describe("engine exports pinned (no behaviour change)", () => {
  it("names the finders the test hook already carried", () => {
    expect(findMostRecentLiftSession).toBe(__test__.findMostRecentLiftSession);
    expect(topSetWeight).toBe(__test__.topSetWeight);
  });
  it("pins the constant values", () => {
    expect(MAX_JUMP_FRACTION).toBe(0.10);
    expect(RECOVERY_SESSIONS_PER_LIFT).toBe(3);
    expect(ADOPT_MIN_REPS).toBe(3);
    expect(TYPE_LABEL).toEqual({ strength: "Strength", zone2: "Zone 2", cardio: "Cardio", hiit: "HIIT", rest: "Rest" });
    expect(Object.isFrozen(TYPE_LABEL)).toBe(true);
  });
  it("deloadIntensityFor maps categories as the deload prescription does", () => {
    expect(deloadIntensityFor("lower_compound")).toBe(0.65);
    expect(deloadIntensityFor("upper_push")).toBe(0.65);
    expect(deloadIntensityFor("upper_pull")).toBe(0.65);
    expect(deloadIntensityFor("power")).toBe(0.60);
    for (const c of ["accessory_compound", "accessory_arm", "accessory_isolation", "bw_progression", undefined]) {
      expect(deloadIntensityFor(c)).toBe(0.70);
    }
  });
  it("the deload prescription still lands where the multiplier says, for every loaded catalogue lift", () => {
    for (const [name] of catalogue()) {
      const profile = getLiftProfile(name);
      if (!profile.progressesByLoad) continue;
      const rx = computeDeloadPrescription(name, { currentWeight: 100, currentRepRange: { reps: 5, sets: 3 } });
      expect(rx.rationale).toEqual([`deload_${profile.category}_${Math.round(deloadIntensityFor(profile.category) * 100)}pct`]);
    }
  });
  it("normaliseWeek still fills a missing label from TYPE_LABEL", () => {
    expect(normaliseWeek([{ type: "zone2" }, { type: "rest" }, { type: "strength" }, { type: "cardio" }, { type: "hiit" }, { type: "rest" }, { type: "rest" }])
      .map((d) => d.label)).toEqual(["Zone 2", "Rest", "Strength", "Cardio", "HIIT", "Rest", "Rest"]);
  });
  it("exports the new names", () => {
    for (const k of ["findMostRecentLiftSession", "topSetWeight", "MAX_JUMP_FRACTION", "deloadIntensityFor", "RECOVERY_SESSIONS_PER_LIFT", "ADOPT_MIN_REPS"]) {
      expect(Object.hasOwn(progression, k)).toBe(true);
    }
  });
});

describe("E3: WORKING_WEIGHT_MAX_KG is the sanitiser's bound and the validator's top", () => {
  const lifts = catalogue();
  it("covers the catalogue", () => {
    expect(lifts.length).toBeGreaterThan(50);
  });
  it("for every catalogue lift: the bound passes untouched, one rung more is rewritten to the cap", () => {
    let checked = 0;
    for (const [name, lt] of lifts) {
      const profile = getLiftProfile(name);
      const cap = profile.progressesByLoad ? CATEGORY_COLD_START_MAX_KG[profile.category] : undefined;
      if (!cap) {
        // No cap: the sanitiser never touches the lift, however heavy.
        const w = { [name]: 9999 };
        expect(sanitiseWorkingWeights(w)).toBe(w);
        continue;
      }
      // Past the cold-start cap, and the old 1.5x clamp, is real progression.
      for (const kg of [cap * 1.5, nextRung(cap * 1.5, lt, +1), WORKING_WEIGHT_MAX_KG]) {
        const w = { [name]: kg };
        expect(sanitiseWorkingWeights(w), `${name} ${kg}`).toBe(w);
      }
      const above = nextRung(WORKING_WEIGHT_MAX_KG, lt, +1);
      expect(above).toBeGreaterThan(WORKING_WEIGHT_MAX_KG);
      expect(sanitiseWorkingWeights({ [name]: above })).toEqual({ [name]: cap });
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });
  it("the validator's MAX_KG is the same number", async () => {
    const { MAX_KG } = await import("@/lib/trainer-change");
    expect(WORKING_WEIGHT_MAX_KG).toBe(400);
    expect(MAX_KG).toBe(WORKING_WEIGHT_MAX_KG);
  });
});
