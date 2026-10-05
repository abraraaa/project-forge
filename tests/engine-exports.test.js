// The engine's constants and finders, exported for the trainer-change
// validator (lib/trainer-change.js), which must use them and never copy them.
// E3: the validator's weight ceiling is exactly the sanitiser's.
import { describe, it, expect } from "vitest";
import * as progression from "@/lib/progression";
import {
  findMostRecentLiftSession, topSetWeight, MAX_JUMP_FRACTION, deloadIntensityFor,
  RECOVERY_SESSIONS_PER_LIFT, ADOPT_MIN_REPS, computeDeloadPrescription, __test__,
} from "@/lib/progression";
import {
  categoryCeilingKg, sanitiseWorkingWeights, CATEGORY_COLD_START_MAX_KG, getLiftProfile,
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

describe("E3: categoryCeilingKg is the sanitiser's ceiling", () => {
  const lifts = catalogue();
  it("covers the catalogue", () => {
    expect(lifts.length).toBeGreaterThan(50);
  });
  it("for every catalogue lift: the ceiling passes untouched, one rung more is clamped to the cap", () => {
    let checked = 0;
    for (const [name, lt] of lifts) {
      const ceiling = categoryCeilingKg(name);
      const profile = getLiftProfile(name);
      if (ceiling === null) {
        // No cap: the sanitiser never touches the lift, however heavy.
        const w = { [name]: 9999 };
        expect(sanitiseWorkingWeights(w)).toBe(w);
        continue;
      }
      expect(ceiling).toBe(CATEGORY_COLD_START_MAX_KG[profile.category] * 1.5);
      const at = { [name]: ceiling };
      expect(sanitiseWorkingWeights(at)).toBe(at);
      const above = nextRung(ceiling, lt, +1);
      expect(above).toBeGreaterThan(ceiling);
      expect(sanitiseWorkingWeights({ [name]: above })).toEqual({ [name]: CATEGORY_COLD_START_MAX_KG[profile.category] });
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });
  it("is null for lifts that do not progress by load", () => {
    expect(categoryCeilingKg("Push-Up")).toBe(null);
    expect(categoryCeilingKg("Wall Sit")).toBe(null);
    expect(categoryCeilingKg("Barbell Back Squat")).toBe(375);
    expect(categoryCeilingKg("Leaning Lateral Raise")).toBe(37.5);
  });
});
