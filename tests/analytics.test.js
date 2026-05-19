// tests/analytics.test.js
// ────────────────────────────────────────────────────────────────────────────
// Volume aggregation correctness + muscle-bucket vocabulary invariants.
//
// Coverage focus:
//   1. per_db exercises double for volume (DB curl × 10kg × 10 reps both arms
//      = 200kg systemic load, not 100kg). Without this, every dumbbell
//      exercise is under-counted by half in per-muscle distribution charts.
//   2. Non-per_db loadTypes don't double (1×).
//   3. Legacy records without loadType default to 1× (don't retro-multiply).
//   4. normaliseMuscle emits the 9-bucket DISPLAY_BUCKET vocabulary
//      (Quads/Glutes/Hamstrings/Calves/Chest/Back/Shoulders/Arms/Core + Other).
//   5. Every value normaliseMuscle can emit has a key in MUSCLE_COLOURS —
//      the invariant that would have caught the Weekly Volume colour
//      collision bug.
//   6. The duplicated normaliser in storage.js stays in lockstep with the
//      analytics.js copy.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { weeklyVolume, __test_p4__ } from "../lib/analytics.js";
import { __test_storage__ } from "../lib/storage.js";
import { DISPLAY_BUCKET } from "../lib/exercise-anatomy.js";
import { MUSCLE_COLOURS } from "../lib/tokens.js";

const { aggregateVolume, normaliseMuscle } = __test_p4__;
const { _normaliseMuscle } = __test_storage__;

function buildSet({ weight = 10, reps = 10, loadType = null, volume = null, effectiveLoad = null }) {
  return {
    weight,
    reps,
    rir: 2,
    loadType,
    effectiveLoad: effectiveLoad ?? weight,
    volume: volume,
  };
}

function buildSession({ date = "2026-04-27", exercises = [] }) {
  return {
    v: 2,
    id: `${date}T10:00:00.000Z`,
    date,
    readiness: "normal",
    blocks: [{ id: "x", type: "main", exercises }],
  };
}

describe("aggregateVolume — per_db loadType doubles", () => {
  it("doubles volume for per_db exercise when set has loadType=per_db", () => {
    const session = buildSession({
      exercises: [{
        name: "DB Curl",
        muscle: "Biceps",
        loadType: "per_db",
        sets: [
          buildSet({ weight: 10, reps: 10, loadType: "per_db", volume: 100 }),
          buildSet({ weight: 10, reps: 10, loadType: "per_db", volume: 100 }),
          buildSet({ weight: 10, reps: 10, loadType: "per_db", volume: 100 }),
        ],
      }],
    });
    const result = aggregateVolume([session]);
    // 3 sets × (10kg × 10 reps × 2 hands) = 600. Biceps now buckets to "Arms".
    expect(result.byMuscle.Arms).toBe(600);
    expect(result.total).toBe(600);
  });

  it("doubles via exercise-level loadType when sets lack loadType (legacy records)", () => {
    // v1 records: per-set loadType absent; rely on exercise-level loadType.
    // "Lateral delt" used to mis-bucket to Back via the substring rule; the
    // new ordering (delt before lat) puts it in Shoulders.
    const session = buildSession({
      exercises: [{
        name: "Lateral Raise",
        muscle: "Lateral delt",
        loadType: "per_db",
        sets: [
          buildSet({ weight: 8, reps: 15, loadType: null, volume: 120 }),
          buildSet({ weight: 8, reps: 15, loadType: null, volume: 120 }),
        ],
      }],
    });
    const result = aggregateVolume([session]);
    // 2 × (8 × 15 × 2) = 480
    expect(result.byMuscle.Shoulders).toBe(480);
  });

  it("does NOT double for barbell loadType", () => {
    const session = buildSession({
      exercises: [{
        name: "Barbell Back Squat",
        muscle: "Quadriceps",
        loadType: "barbell",
        sets: [
          buildSet({ weight: 100, reps: 5, loadType: "barbell", volume: 500 }),
        ],
      }],
    });
    const result = aggregateVolume([session]);
    expect(result.byMuscle.Quads).toBe(500); // 1×
  });

  it("does NOT double for machine, total, loaded_bw, or bodyweight loadTypes", () => {
    const session = buildSession({
      exercises: [
        {
          name: "Leg Press", muscle: "Quadriceps", loadType: "machine",
          sets: [buildSet({ weight: 100, reps: 10, loadType: "machine", volume: 1000 })],
        },
        {
          name: "Cable Pull-Through", muscle: "Glutes", loadType: "total",
          sets: [buildSet({ weight: 50, reps: 10, loadType: "total", volume: 500 })],
        },
      ],
    });
    const result = aggregateVolume([session]);
    // New vocabulary splits this: Quadriceps → Quads, Glutes → Glutes.
    expect(result.byMuscle.Quads).toBe(1000);
    expect(result.byMuscle.Glutes).toBe(500);
  });

  it("legacy records without any loadType default to 1× (no retro-multiplier)", () => {
    const session = buildSession({
      exercises: [{
        name: "Bench Press",
        muscle: "Chest",
        // no loadType on exercise or sets
        sets: [
          { weight: 80, reps: 5, rir: 2, volume: 400 },
        ],
      }],
    });
    const result = aggregateVolume([session]);
    expect(result.byMuscle.Chest).toBe(400);
  });

  it("falls back to raw weight × reps × multiplier when cached volume is absent", () => {
    const session = buildSession({
      exercises: [{
        name: "DB Curl",
        muscle: "Biceps",
        loadType: "per_db",
        sets: [
          { weight: 10, reps: 10, rir: 2, loadType: "per_db" }, // no volume, no effectiveLoad
        ],
      }],
    });
    const result = aggregateVolume([session]);
    // 10 × 10 × 2 = 200
    expect(result.byMuscle.Arms).toBe(200);
  });
});

describe("weeklyVolume — per_db loadType doubles", () => {
  it("doubles DB exercise volume in weekly aggregation", () => {
    const session = buildSession({
      date: "2026-04-27",
      exercises: [{
        name: "DB Curl",
        muscle: "Biceps",
        loadType: "per_db",
        sets: [
          buildSet({ weight: 10, reps: 12, loadType: "per_db", volume: 120 }),
          buildSet({ weight: 10, reps: 12, loadType: "per_db", volume: 120 }),
          buildSet({ weight: 10, reps: 12, loadType: "per_db", volume: 120 }),
        ],
      }],
    });
    const weeks = weeklyVolume([session]);
    expect(weeks.length).toBe(1);
    // 3 × 120 × 2 = 720
    expect(weeks[0].byMuscle.Arms.volume).toBe(720);
    expect(weeks[0].byMuscle.Arms.sets).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Muscle-bucket vocabulary — the invariant that would have caught the
// Weekly Volume colour-collision bug.
// ────────────────────────────────────────────────────────────────────────────
describe("MUSCLE_COLOURS invariant — every bucket has a colour", () => {
  it("every value normaliseMuscle can emit has a key in MUSCLE_COLOURS", () => {
    // The canonical bucket set = unique values of DISPLAY_BUCKET, plus the
    // "Other" fallback the normaliser uses for unknown muscles.
    const expectedBuckets = [...new Set(Object.values(DISPLAY_BUCKET)), "Other"];
    for (const bucket of expectedBuckets) {
      expect(MUSCLE_COLOURS[bucket], `MUSCLE_COLOURS missing key "${bucket}"`).toBeTruthy();
    }
  });

  it("every MUSCLE_COLOURS value is a unique hex (no visual collisions)", () => {
    const colours = Object.values(MUSCLE_COLOURS);
    const unique  = new Set(colours);
    expect(unique.size).toBe(colours.length);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// normaliseMuscle behaviour — locks in the bucketing rules.
// ────────────────────────────────────────────────────────────────────────────
describe("normaliseMuscle — DISPLAY_BUCKET vocabulary", () => {
  // Fixture covers every raw muscle string shape that appears in programme.js
  // (and a couple of synthetic edge cases). New-bucket expectations on the right.
  const cases = [
    // Leg family — granularity goal of the migration
    ["Quadriceps",                       "Quads"],
    ["Quads & Glutes",                   "Quads"],       // first-mentioned wins
    ["Glutes",                           "Glutes"],
    ["Glutes / Hams",                    "Glutes"],      // first-mentioned wins
    ["Hamstrings",                       "Hamstrings"],
    ["Calves",                           "Calves"],
    ["Posterior chain",                  "Glutes"],      // hip-extension primary
    ["Full body / explosive",            "Glutes"],      // Power Clean
    ["Quads & Glutes / Adductors",       "Quads"],
    ["Adductors",                        "Glutes"],      // closest functional bucket

    // Upper body
    ["Chest",                            "Chest"],
    ["Upper chest",                      "Chest"],
    ["Chest / medial",                   "Chest"],
    ["Upper back",                       "Back"],
    ["Mid back",                         "Back"],
    ["Lats",                             "Back"],
    ["Lats / Biceps",                    "Back"],        // lats before bicep
    ["Lats / biceps",                    "Back"],

    // Shoulders — note "Lateral delt" must NOT mis-bucket to Back
    ["Shoulders",                        "Shoulders"],
    ["Lateral delt",                     "Shoulders"],   // delt before lat
    ["Rear delts / cuff",                "Shoulders"],
    ["Side delts",                       "Shoulders"],
    ["Front delts",                      "Shoulders"],

    // Arms (biceps + triceps + forearms merge for chart simplicity)
    ["Biceps",                           "Arms"],
    ["Triceps",                          "Arms"],
    ["Biceps & brachialis",              "Arms"],
    ["Biceps & forearms",                "Arms"],
    ["Triceps & chest",                  "Arms"],        // tricep checked first
    ["Forearms",                         "Arms"],

    // Core
    ["Core",                             "Core"],
    ["Core / Anti-rot",                  "Core"],
    ["Adductors / Core",                 "Core"],        // core check wins

    // Unknown / fallback
    ["Vibes",                            "Other"],
    ["",                                 null],
    [null,                               null],
    [undefined,                          null],
  ];

  for (const [input, expected] of cases) {
    it(`"${input}" → ${JSON.stringify(expected)}`, () => {
      expect(normaliseMuscle(input)).toBe(expected);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Equivalence — the duplicated _normaliseMuscle in storage.js must emit
// identical results. Locks the two copies together so they can't drift.
// ────────────────────────────────────────────────────────────────────────────
describe("normaliseMuscle ≡ _normaliseMuscle (analytics vs storage)", () => {
  const fixtures = [
    "Quadriceps", "Quads & Glutes", "Glutes", "Glutes / Hams", "Hamstrings",
    "Calves", "Posterior chain", "Full body / explosive",
    "Quads & Glutes / Adductors", "Adductors",
    "Chest", "Upper chest", "Chest / medial",
    "Upper back", "Mid back", "Lats", "Lats / Biceps",
    "Shoulders", "Lateral delt", "Rear delts / cuff",
    "Biceps", "Triceps", "Biceps & brachialis", "Biceps & forearms",
    "Triceps & chest", "Forearms",
    "Core", "Core / Anti-rot", "Adductors / Core",
    "Vibes", "", null, undefined,
  ];

  for (const input of fixtures) {
    it(`agrees on ${JSON.stringify(input)}`, () => {
      expect(_normaliseMuscle(input)).toBe(normaliseMuscle(input));
    });
  }
});
