// Starting weights for the five main lifts and their listed equivalents.
// The defaults are pinned to the pre-equivalents formula; an equivalent's
// start is the slot default's multiplier times the engine's own translation
// factor for the pair (lib/lift-translations.js PROFILES).
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startingWeightForLift, mainLiftStartBasis, MAIN_LIFT_BW_MULTIPLIERS, inferLoadType } from "../lib/storage.js";
import { getLiftProfile, inferLoadType as inferLoadTypeDirect, getLoadType, swapLoadType, weightStepForLoadType } from "../lib/lift-translations.js";
import { MAIN_LIFT_FUNCTIONAL_EQUIVALENTS, MAIN_LIFT_GROUPS, SWAP_DB, EXERCISE_POOLS } from "../lib/programme.js";

const DEFAULTS = {
  "Hex Bar Deadlift":       1.00,
  "Barbell Back Squat":     0.75,
  "Barbell Bench Press":    0.65,
  "Barbell Overhead Press": 0.40,
  "Power Clean":            0.50,
};
// The formula before equivalents existed, verbatim.
const before = (mult, bw) => Math.max(20, Math.round((bw * mult) / 2.5) * 2.5);

// Equivalents with no start, and why. Everything else must get one.
const NO_START = {
  "Weighted Dips": "added load is optional (loaded bodyweight); starts empty by design",
  "Hang Power Clean": "no factor in lift-translations PROFILES; name inference gives none",
};

const equivalents = [...new Set(Object.values(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS).flat())];

// Rounding step of an equivalent's start: 5 kg per dumbbell, 2.5 kg otherwise.
const stepFor = (loadType) => (loadType === "per_db" ? 5 : 2.5);

// Every load type a lift can be drummed on. The start is keyed by name, so it
// reaches the lift as a swapped main (loadType name-inferred), as a rotation
// pool accessory (its own loadType) and as a session swap (swapLoadType).
function loadTypesFor(name) {
  const types = new Set([getLoadType({ name })]);
  for (const slot of Object.values(EXERCISE_POOLS)) {
    for (const ex of slot.pool || []) if (ex.name === name) types.add(getLoadType(ex));
  }
  for (const opts of Object.values(SWAP_DB)) {
    for (const o of opts) if (o.name === name) types.add(swapLoadType(o));
  }
  return [...types];
}
const onGrid = (kg, step) => Math.abs(kg / step - Math.round(kg / step)) < 1e-9;

describe("startingWeightForLift: the five defaults are unchanged", () => {
  it("keeps the multiplier table", () => {
    expect(MAIN_LIFT_BW_MULTIPLIERS).toEqual(DEFAULTS);
  });

  it("matches the old formula at every quarter kilo from 20 to 250 kg", () => {
    for (const [lift, mult] of Object.entries(DEFAULTS)) {
      for (let bw = 20; bw <= 250; bw += 0.25) {
        expect(startingWeightForLift(lift, bw)).toBe(before(mult, bw));
      }
      expect(startingWeightForLift(lift, null)).toBe(null);
      expect(startingWeightForLift(lift, undefined)).toBe(null);
    }
  });

  it("still returns null for a lift that is neither a default nor a listed equivalent", () => {
    for (const lift of ["DB Curl", "Lateral Raise", "Chest-Supported DB Row", "Goblet Squat", "Hang Clean", "", null]) {
      expect(startingWeightForLift(lift, 80)).toBe(null);
    }
  });
});

describe("startingWeightForLift: listed equivalents", () => {
  it("gives every equivalent a positive, plate-rounded start at 80 kg, bar-floored on a barbell", () => {
    for (const lift of equivalents) {
      if (NO_START[lift]) continue;
      const kg = startingWeightForLift(lift, 80);
      expect(kg, lift).toBeGreaterThan(0);
      expect(kg % stepFor(mainLiftStartBasis(lift)?.loadType), lift).toBe(0);
      if (mainLiftStartBasis(lift)?.loadType === "barbell") expect(kg, lift).toBeGreaterThanOrEqual(20);
    }
  });

  it("lands on every grid the lift is drummed on, at every quarter kilo from 30 to 200 kg", () => {
    for (const lift of equivalents) {
      if (NO_START[lift]) continue;
      const types = loadTypesFor(lift);
      for (let bw = 30; bw <= 200; bw += 0.25) {
        const kg = startingWeightForLift(lift, bw);
        for (const lt of types) expect(onGrid(kg, weightStepForLoadType(lt)), `${lift} at ${bw} kg on the ${lt} grid: ${kg}`).toBe(true);
      }
    }
  });

  it("keeps DB Floor Press as a pool accessory on whole-kilo dumbbells", () => {
    const poolEntry = Object.values(EXERCISE_POOLS).flatMap((s) => s.pool || []).find((ex) => ex.name === "DB Floor Press");
    expect(getLoadType(poolEntry)).toBe("per_db");
    expect(weightStepForLoadType("per_db")).toBe(1);
    // Before the per-dumbbell step these were 12.5, 17.5, 22.5 and 27.5.
    // As a swapped main (no template weight) it starts from bodyweight; as the
    // pool accessory it keeps the programme's template, so the start stands down.
    expect([50, 70, 90, 110].map((bw) => startingWeightForLift("DB Floor Press", bw))).toEqual([15, 20, 25, 30]);
    expect([50, 70, 90, 110].map((bw) => startingWeightForLift("DB Floor Press", bw, poolEntry.weight))).toEqual([null, null, null, null]);
    // The defaults never stand down for a template.
    expect(startingWeightForLift("Barbell Back Squat", 80, 60)).toBe(60);
  });

  it("names its exceptions and gives them nothing", () => {
    for (const lift of Object.keys(NO_START)) {
      expect(equivalents).toContain(lift);
      expect(mainLiftStartBasis(lift)).toBe(null);
      expect(startingWeightForLift(lift, 80)).toBe(null);
    }
  });

  it("takes its ratio from the engine's translation factors, nowhere else", () => {
    for (const lift of equivalents) {
      const basis = mainLiftStartBasis(lift);
      if (!basis) continue;
      expect(basis.ratio).toBeCloseTo(getLiftProfile(lift).factor / getLiftProfile(basis.slot).factor, 10);
      expect(basis.multiplier).toBeCloseTo(DEFAULTS[basis.slot] * basis.ratio, 10);
    }
  });

  it("starts Push Press, listed under two slots, from the lower of the two", () => {
    const slots = Object.keys(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS).filter((s) => MAIN_LIFT_FUNCTIONAL_EQUIVALENTS[s].includes("Push Press"));
    expect(slots.length).toBe(2);
    const each = slots.map((s) => DEFAULTS[s] * getLiftProfile("Push Press").factor / getLiftProfile(s).factor);
    expect(mainLiftStartBasis("Push Press")?.multiplier).toBeCloseTo(Math.min(...each), 10);
  });

  it("floors a light lifter at the empty bar on barbells and one step otherwise", () => {
    expect(startingWeightForLift("Incline BB Press", 40)).toBe(20);
    expect(startingWeightForLift("Dumbbell Shoulder Press", 10)).toBe(5);
    expect(startingWeightForLift("Hack Squat", 2)).toBe(2.5);
  });
});

describe("inferLoadType moved to lift-translations", () => {
  it("is the same function from both import paths", () => {
    expect(inferLoadType).toBe(inferLoadTypeDirect);
    expect(readFileSync(path.resolve("lib/lift-translations.js"), "utf8")).not.toMatch(/^import /m);
  });
});

// ─── Owner review table, generated from the code above ───────────────────────
// Set FORGE_WEIGHTS_TABLE=<path> to write it; the test checks it either way.
const LT_SRC = readFileSync(path.resolve("lib/lift-translations.js"), "utf8").split("\n");
const PG_SRC = readFileSync(path.resolve("lib/programme.js"), "utf8").split("\n");
const ltLine = (name) => {
  const i = LT_SRC.findIndex((l) => l.trimStart().startsWith(`"${name}":`));
  if (i >= 0) return `lift-translations.js:${i + 1}`;
  const f = LT_SRC.findIndex((l) => l.startsWith("function inferProfileFromName"));
  return `inferred (inferProfileFromName, lift-translations.js:${f + 1})`;
};
// A start is keyed by name, so it also reaches the same lift as a rotation
// pool accessory (EXERCISE_POOLS) that a user has no working weight for yet.
const POOLS_FROM = PG_SRC.findIndex((l) => l.startsWith("export const EXERCISE_POOLS"));
const POOLS_TO = PG_SRC.findIndex((l, i) => i > POOLS_FROM && l.startsWith("export const "));
const accessoryUses = (name) => PG_SRC
  .map((l, i) => ({ l, i }))
  .filter(({ l, i }) => i > POOLS_FROM && i < POOLS_TO && l.includes(`name:"${name}"`) && /weight:\s*\d/.test(l))
  .map(({ l, i }) => `also a pool accessory, programme.js:${i + 1} (keeps its template ${l.match(/weight:\s*([\d.]+)/)[1]} kg there)`);

function tableRows() {
  return equivalents.concat(Object.keys(DEFAULTS)).map((lift) => {
    const isDefault = !!DEFAULTS[lift];
    const basis = mainLiftStartBasis(lift);
    const slots = isDefault ? [lift] : Object.keys(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS).filter((s) => MAIN_LIFT_FUNCTIONAL_EQUIVALENTS[s].includes(lift));
    const notes = [];
    if (NO_START[lift]) notes.push(NO_START[lift]);
    if (basis && !isDefault) {
      const to = getLiftProfile(lift), from = getLiftProfile(basis.slot);
      if (to.primaryMuscle !== from.primaryMuscle) notes.push(`anchor muscle differs (${to.primaryMuscle} vs ${from.primaryMuscle})`);
      if (slots.length > 1) notes.push(`listed under ${slots.length} slots; lower start used`);
    }
    notes.push(...accessoryUses(lift));
    return {
      lift,
      slot: slots.map((s) => MAIN_LIFT_GROUPS[s] ? `${MAIN_LIFT_GROUPS[s]} (${s})` : s).join("; "),
      source: isDefault ? "MAIN_LIFT_BW_MULTIPLIERS (default)" : `${ltLine(lift)} factor ${getLiftProfile(lift).factor} / ${ltLine(basis?.slot ?? slots[0])} factor ${getLiftProfile(basis?.slot ?? slots[0]).factor}`,
      ratio: basis ? +basis.ratio.toFixed(4) : null,
      multiplier: basis ? +basis.multiplier.toFixed(4) : null,
      loadType: basis?.loadType ?? "-",
      at80: startingWeightForLift(lift, 80),
      notes: notes.join("; "),
    };
  });
}

describe("owner review table", () => {
  it("agrees with startingWeightForLift row for row", () => {
    const rows = tableRows();
    expect(rows.length).toBe(equivalents.length + 5);
    for (const r of rows) {
      expect(r.at80).toBe(startingWeightForLift(r.lift, 80));
      if (r.multiplier !== null && !DEFAULTS[r.lift]) {
        const step = stepFor(r.loadType);
        expect(r.at80).toBe(Math.max(r.loadType === "barbell" ? 20 : step, Math.round((80 * mainLiftStartBasis(r.lift).multiplier) / step) * step));
      }
    }
    const md = [
      "| Lift | Slot | Ratio source | Ratio | Multiplier (× BW) | Load type | At 80 kg | Notes |",
      "|---|---|---|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.lift} | ${r.slot} | ${r.source} | ${r.ratio ?? "-"} | ${r.multiplier ?? "-"} | ${r.loadType} | ${r.at80 === null ? "none" : `${r.at80} kg`} | ${r.notes || ""} |`),
    ].join("\n");
    if (process.env.FORGE_WEIGHTS_TABLE) writeFileSync(process.env.FORGE_WEIGHTS_TABLE, md + "\n");
    expect(md).toContain("| Front Squat |");
  });
});
