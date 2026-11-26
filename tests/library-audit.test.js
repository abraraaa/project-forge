// tests/library-audit.test.js
// Load types, template weights, anatomy, swaps and pool membership for the
// library entries the audit corrected. Pool membership is read live, so the
// band and one-a-day sweeps elsewhere hold the weeks these pools solve.
import { describe, it, expect } from "vitest";
import {
  SESSIONS, EXERCISE_POOLS, SWAP_DB, RETIRED_EXERCISES, RETIRED_LOAD_TYPES, FORMER_LOAD_TYPES, ROTATION_REVISED,
  applyRotationToSession, readRotationConfig,
} from "../lib/programme.js";
import { getLiftProfile, inferLoadType, swapLoadType, coldStartCapKg, __test__ } from "../lib/lift-translations.js";
import { projectForTrainer } from "../lib/trainer-plan.js";
import { loadTypeOfName } from "../lib/programme-resolve.js";
import { EXERCISE_ANATOMY, getAnatomy, PATTERN_DEFAULTS } from "../lib/exercise-anatomy.js";
import { getTempo } from "../lib/exercise-tempo.js";
import { resolveVid } from "../lib/exercise-videos.js";
import { LIBRARY, LIBRARY_REVISED } from "../lib/library.js";

const poolNames = (key) => EXERCISE_POOLS[key].pool.map((e) => e.name);
const poolEntry = (key, name) => EXERCISE_POOLS[key].pool.find((e) => e.name === name);
const sessionEntries = (name) => SESSIONS.flatMap((s) => s.blocks.flatMap((b) => [b.ex, b.exA, b.exB]))
  .filter((ex) => ex?.name === name);
const swapOptions = (name) => Object.entries(SWAP_DB).flatMap(([host, alts]) => alts.filter((a) => a.name === name).map((a) => ({ host, ...a })));
const everyPool = (name) => Object.entries(EXERCISE_POOLS).filter(([, slot]) => slot.pool.some((e) => e.name === name)).map(([k]) => k);

describe("load types", () => {
  it("Banded Hip Thrust and Single-Leg Hip Thrust progress by reps, not load", () => {
    for (const name of ["Banded Hip Thrust", "Single-Leg Hip Thrust"]) {
      expect(getLiftProfile(name), name).toMatchObject({ category: "bw_progression", factor: 0, progressesByLoad: false });
    }
    expect(poolEntry("ass2-A", "Single-Leg Hip Thrust")).toMatchObject({ loadType: "bodyweight", weight: null });
    const swaps = swapOptions("Single-Leg Hip Thrust");
    expect(swaps.length).toBeGreaterThan(0);
    for (const s of swaps) expect(s.eq, s.host).toBe("Bodyweight");
    expect(loadTypeOfName("Single-Leg Hip Thrust")).toBe("bodyweight");
  });

  it("Meadows Row loads one end of a barbell", () => {
    expect(poolEntry("ass2-B", "Meadows Row").loadType).toBe("barbell");
    expect(loadTypeOfName("Meadows Row")).toBe("barbell");
  });

  it("Toes-to-Bar is bodyweight, by name and in the pool", () => {
    expect(inferLoadType("Toes-to-Bar")).toBe("bodyweight");
    expect(poolEntry("afin-A", "Toes-to-Bar").loadType).toBe("bodyweight");
    expect(loadTypeOfName("Toes-to-Bar")).toBe("bodyweight");
    // The loaded-bodyweight family keeps its members.
    for (const n of ["Pull-Up", "Chin-Up", "Weighted Dips", "Muscle-Up"]) expect(inferLoadType(n), n).toBe("loaded_bodyweight");
  });

  it("an Ab Wheel swap is bodyweight, with no kg dial", () => {
    const swaps = swapOptions("Ab Wheel");
    expect(swaps.length).toBeGreaterThan(0);
    for (const s of swaps) {
      expect(s.eq, s.host).toBe("Bodyweight");
      expect(swapLoadType(s), s.host).toBe("bodyweight");
    }
  });
});

describe("Single-Leg Curl is the low cable curl its footage shows", () => {
  it("a cable lift (load type total) at 15 kg in its pool, by name too", () => {
    expect(poolEntry("bss2-B", "Single-Leg Curl")).toMatchObject({ loadType: "total", weight: 15, vid: "Y1dQUd6OKHk" });
    expect(everyPool("Single-Leg Curl")).toEqual(["bss2-B"]);
    expect(loadTypeOfName("Single-Leg Curl")).toBe("total");
  });

  it("its profile is a cable isolation lift: accessory isolation, off the machine ceiling, its template under the cap", () => {
    const profile = getLiftProfile("Single-Leg Curl");
    expect(profile).toMatchObject({ primaryMuscle: "Hamstrings", category: "accessory_isolation", progressesByLoad: true });
    expect(profile.machine).not.toBe(true);
    expect(coldStartCapKg(profile)).toBe(25);
    expect(coldStartCapKg(profile)).toBeGreaterThanOrEqual(poolEntry("bss2-B", "Single-Leg Curl").weight);
  });

  it("its anatomy is untouched", () => {
    expect(EXERCISE_ANATOMY["Single-Leg Curl"]).toEqual({ primary: "Hamstrings", secondary: { Calves: 0.1 } });
  });

  it("sets logged under per_db keep reading per dumbbell, at the weight logged", () => {
    const sets = [{ weight: 22, reps: 10, rpe: 8, loadType: "per_db" }, { weight: 22, reps: 9, rpe: 8.5, loadType: "per_db" }];
    const history = [{ v: 2, id: "2026-11-02T07:00:00.000Z", date: "2026-11-02", session: "strength-b", scheduledLetter: "B",
      blocks: [{ id: "acc", type: "accessory", exercises: [{ name: "Single-Leg Curl", loadType: "per_db", sets }] }] }];
    const view = projectForTrainer({ meta: {}, history }, { todayIso: "2026-11-09" });
    const ex = view.sessions.flatMap((r) => r.blocks.flatMap((b) => b.exercises)).find((e) => e.name === "Single-Leg Curl");
    expect(ex.loadType).toBe("per_db");
    expect(ex.sets.map((x) => [x.weight, x.loadType])).toEqual([[22, "per_db"], [22, "per_db"]]);
  });
});

describe("template weights", () => {
  it("Incline DB Press starts at 18 kg per dumbbell, in the session and the pool", () => {
    const all = [...sessionEntries("Incline DB Press"), poolEntry("css2-A", "Incline DB Press")];
    expect(all.length).toBe(2);
    for (const ex of all) expect(ex).toMatchObject({ weight: 18, loadType: "per_db" });
  });

  it("DB Floor Press and Neutral-Grip DB Press start at 20 kg per dumbbell", () => {
    expect(poolEntry("css2-A", "DB Floor Press")).toMatchObject({ weight: 20, loadType: "per_db" });
    expect(poolEntry("css2-A", "Neutral-Grip DB Press")).toMatchObject({ weight: 20, loadType: "per_db" });
  });
});

describe("anatomy and copy", () => {
  it("Landmine Squeeze Press and Svend Press are chest lifts", () => {
    expect(EXERCISE_ANATOMY["Landmine Squeeze Press"].primary).toBe("Chest");
    expect(EXERCISE_ANATOMY["Landmine Squeeze Press"].secondary["Front Delts"]).toBe(0.5);
    expect(EXERCISE_ANATOMY["Svend Press"]).toEqual({ primary: "Chest", secondary: { "Front Delts": 0.3 } });
  });

  it("Incline Push-Up is labelled Chest wherever it is offered", () => {
    const swaps = swapOptions("Incline Push-Up");
    expect(swaps.length).toBeGreaterThan(0);
    for (const s of swaps) expect(s.muscle, s.host).toBe("Chest");
  });

  it("Copenhagen Plank swaps to adduction work", () => {
    expect(SWAP_DB["Copenhagen Plank"].map((a) => [a.name, a.eq, a.muscle])).toEqual([
      ["Side-Lying Adduction", "Bodyweight", "Adductors"],
      ["Hip Adduction", "Machine", "Adductors"],
    ]);
    for (const a of SWAP_DB["Copenhagen Plank"]) {
      expect(EXERCISE_ANATOMY[a.name], a.name).toBeDefined();
      expect(resolveVid(a.name, a.vid), a.name).toBe(a.vid);
    }
  });

  it("the Deficit Reverse Lunge note puts the front foot on the platform", () => {
    const note = getTempo("Deficit Reverse Lunge").note;
    expect(note).toMatch(/front foot on a platform/);
    expect(note).not.toMatch(/back foot/i);
  });

  it("Chin-Up credits Biceps 0.55, above Pull-Up", () => {
    expect(EXERCISE_ANATOMY["Chin-Up"].secondary.Biceps).toBe(0.55);
    expect(EXERCISE_ANATOMY["Chin-Up"].secondary.Biceps).toBeGreaterThan(EXERCISE_ANATOMY["Pull-Up"].secondary.Biceps);
  });

  it("Band Pull-Apart credits the upper back", () => {
    expect(EXERCISE_ANATOMY["Band Pull-Apart"].secondary["Upper Back"]).toBe(0.3);
  });

  it("a dumbbell kickback is a triceps lift; glute kickbacks still read as glutes", () => {
    expect(getAnatomy("DB Kickback")).not.toBe(PATTERN_DEFAULTS.hip_thrust);
    expect(getAnatomy("DB Kickback").primary).toBe("Triceps");
    for (const n of ["Glute Kickback", "Cable Kickback", "Cable Glute Kickback"]) expect(getAnatomy(n), n).toBe(PATTERN_DEFAULTS.hip_thrust);
  });
});

describe("one lift, one place", () => {
  it("the low-to-high fly sits in Day C once", () => {
    expect(poolNames("css2-A")).not.toContain("Low-to-High Cable Fly");
    const dayC = SESSIONS[2];
    const slotKeys = dayC.blocks.flatMap((b) => [`${b.id}-A`, `${b.id}-B`]).filter((k) => EXERCISE_POOLS[k]);
    const lowToHigh = slotKeys.filter((k) => poolNames(k).some((n) => /low-to-high/i.test(n)));
    expect(lowToHigh.length).toBe(1);
  });

  it("Incline DB Press swaps to the low-to-high crossover, not a second cable fly", () => {
    const names = SWAP_DB["Incline DB Press"].map((a) => a.name);
    expect(names).toContain("Low-to-High Cable Crossover");
    expect(swapOptions("Cable Chest Fly")).toEqual([]);
  });

  it("Incline DB Row leaves the row pool, which keeps Chest-Supported DB Row", () => {
    expect(everyPool("Incline DB Row")).toEqual([]);
    expect(poolNames("ass2-B")).toContain("Chest-Supported DB Row");
  });

  it("the landmine pool holds Landmine Press once, without its single-arm copy", () => {
    const names = poolNames("ass1-B");
    expect(names.filter((n) => n === "Landmine Press")).toHaveLength(1);
    expect(everyPool("Single-Arm Landmine Press")).toEqual([]);
  });

  it("Incline Landmine Press is retired at the load type its sets were logged under", () => {
    expect(RETIRED_EXERCISES.has("Incline Landmine Press")).toBe(true);
    expect(RETIRED_LOAD_TYPES["Incline Landmine Press"]).toBe("barbell");
    expect(everyPool("Incline Landmine Press")).toEqual([]);
    expect(Object.hasOwn(SWAP_DB, "Incline Landmine Press")).toBe(false);
    expect(swapOptions("Incline Landmine Press")).toEqual([]);
    expect(Object.hasOwn(__test__.PROFILES, "Incline Landmine Press")).toBe(true);
    expect(getTempo("Incline Landmine Press")).toBeTruthy();
    expect(EXERCISE_ANATOMY["Incline Landmine Press"]).toBeDefined();
  });

  it("a lift no longer offered keeps its footage", () => {
    const kept = {
      "Cable Chest Fly": "hhruLxo9yZU", "Low-to-High Cable Fly": "eQ_NBB6OBH4", "Incline DB Row": "2LxN3_3atps",
      "Single-Arm Landmine Press": "Sjb5meztfSE", "Incline Landmine Press": "N9_1DnqUAQw",
    };
    for (const [name, vid] of Object.entries(kept)) {
      expect(resolveVid(name), name).toBe(vid);
      if (!RETIRED_EXERCISES.has(name)) expect(LIBRARY.find((e) => e.name === name)?.vid, name).toBe(vid);
    }
  });

  it("a stored pick of a lift that left its pool reads as the slot's default, without a write", () => {
    const stored = { "ass2-B": { name: "Incline DB Row", reps: 10, weight: 20, muscle: "Upper back", loadType: "per_db" } };
    const before = JSON.stringify(stored);
    const day = applyRotationToSession(SESSIONS[0], stored);
    expect(day.blocks.find((b) => b.id === "ass2").exB.name).toBe(EXERCISE_POOLS["ass2-B"].pool[0].name);
    readRotationConfig(stored);
    expect(JSON.stringify(stored)).toBe(before);
  });
});

describe("revision stamps", () => {
  it("the pools and the library carry this change's date", () => {
    expect(ROTATION_REVISED).toBe("2026-11-16");
    expect(LIBRARY_REVISED).toBe("2026-11-16");
  });
});

describe("stored rotation picks", () => {
  // A pick the solver stored before these corrections, as it reads back from storage.
  const stored = (pick) => JSON.parse(JSON.stringify(pick));
  const slotOf = (key) => {
    const [id, side] = key.split("-");
    for (const s of SESSIONS) for (const b of s.blocks) if (b.id === id) return { session: s, field: side ? `ex${side}` : "ex" };
    return null;
  };
  for (const [key, old, want] of /** @type {const} */ ([
    ["ass2-A", { name: "Single-Leg Hip Thrust", reps: 10, weight: 45, muscle: "Glutes", vid: "4ilXaDauMnE", loadType: "barbell", loadProfile: "moderate_mid_rep" }, { loadType: "bodyweight", weight: null }],
    ["ass1-B", { name: "Landmine Press", reps: 10, weight: 28, muscle: "Upper chest", vid: "gH7PDepHNck", loadType: "barbell", loadProfile: "moderate_mid_rep" }, { loadType: "barbell", weight: 20 }],
    ["bss2-B", { name: "Single-Leg Curl", reps: 10, weight: 22, muscle: "Hamstrings", vid: "Y1dQUd6OKHk", loadType: "per_db", loadProfile: "moderate_mid_rep" }, { loadType: "total", weight: 15 }],
  ])) {
    it(`a stored ${old.name} pick takes the pool's current load type and template`, () => {
      const { session, field } = /** @type {any} */ (slotOf(key));
      const block = applyRotationToSession(session, { [key]: stored(old) }).blocks.find((b) => b.id === key.split("-")[0]);
      expect(block[field]).toMatchObject({ name: old.name, ...want });
    });
  }
});

describe("lifts taken out of the pools and swaps", () => {
  for (const [name, lt] of /** @type {const} */ ([
    ["Incline DB Row", "per_db"], ["Single-Arm Landmine Press", "barbell"],
    ["Low-to-High Cable Fly", "total"], ["Cable Chest Fly", "total"],
  ])) {
    it(`${name} keeps the load type its sets were logged under, and its library page`, () => {
      expect(FORMER_LOAD_TYPES[name]).toBe(lt);
      expect(loadTypeOfName(name)).toBe(lt);
      expect(RETIRED_EXERCISES.has(name)).toBe(false);
      expect(LIBRARY.some((e) => e.name === name)).toBe(true);
    });
  }
});
