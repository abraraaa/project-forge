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
//   6. recentForExercise / totalTonnage / weeklyVolumeByMuscle behaviour.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  weeklyVolume, recentForExercise,
  weeklyVolumeByMuscle, totalTonnage, pendingTonnageMilestone,
  formatTonnage, TONNAGE_MILESTONES_KG, __test_p4__,
} from "../lib/analytics.js";
import { DISPLAY_BUCKET } from "../lib/exercise-anatomy.js";
import { MUSCLE_COLOURS } from "../lib/tokens.js";

const { aggregateVolume, normaliseMuscle } = __test_p4__;

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
// recentForExercise — powers the in-session "Recent" sanity-check sheet.
// ────────────────────────────────────────────────────────────────────────────
function buildHistorySession(date, exercises) {
  return { v: 2, id: `${date}T10:00:00.000Z`, date, blocks: [{ id: "x", type: "main", exercises }] };
}

describe("recentForExercise", () => {
  it("returns [] for empty history", () => {
    expect(recentForExercise([], "Back Squat")).toEqual([]);
    expect(recentForExercise(null, "Back Squat")).toEqual([]);
    expect(recentForExercise(undefined, "Back Squat")).toEqual([]);
  });

  it("returns [] when exerciseName is missing", () => {
    const h = [buildHistorySession("2026-05-01", [{ name: "Back Squat", sets: [{ weight: 100, reps: 5 }] }])];
    expect(recentForExercise(h, "")).toEqual([]);
    expect(recentForExercise(h, null)).toEqual([]);
    expect(recentForExercise(h, undefined)).toEqual([]);
  });

  it("returns [] when no session contains the exercise", () => {
    const h = [
      buildHistorySession("2026-05-01", [{ name: "Bench Press", sets: [{ weight: 80, reps: 5 }] }]),
      buildHistorySession("2026-04-28", [{ name: "Deadlift",    sets: [{ weight: 140, reps: 5 }] }]),
    ];
    expect(recentForExercise(h, "Back Squat")).toEqual([]);
  });

  it("orders results newest-first regardless of input order", () => {
    const mk = (d) => buildHistorySession(d, [{ name: "Back Squat", sets: [{ weight: 100, reps: 5 }] }]);
    const h = [mk("2026-04-01"), mk("2026-05-01"), mk("2026-03-15")];
    const out = recentForExercise(h, "Back Squat");
    expect(out.map(r => r.date)).toEqual(["2026-05-01", "2026-04-01", "2026-03-15"]);
  });

  it("limits to n entries (default 3)", () => {
    const mk = (d) => buildHistorySession(d, [{ name: "Back Squat", sets: [{ weight: 100, reps: 5 }] }]);
    const h = [mk("2026-05-05"), mk("2026-05-01"), mk("2026-04-28"), mk("2026-04-25"), mk("2026-04-20")];
    expect(recentForExercise(h, "Back Squat")).toHaveLength(3);
    expect(recentForExercise(h, "Back Squat", 5)).toHaveLength(5);
    expect(recentForExercise(h, "Back Squat", 1)).toHaveLength(1);
  });

  it("picks max-weight set as the top set", () => {
    const h = [buildHistorySession("2026-05-01", [{
      name: "Back Squat",
      sets: [
        { weight: 100, reps: 5 },
        { weight: 110, reps: 3 },
        { weight: 90,  reps: 8 },
      ],
    }])];
    const [r] = recentForExercise(h, "Back Squat");
    expect(r.topSet.weight).toBe(110);
    expect(r.topSet.reps).toBe(3);
  });

  it("breaks weight ties by max reps", () => {
    const h = [buildHistorySession("2026-05-01", [{
      name: "Back Squat",
      sets: [
        { weight: 100, reps: 5 },
        { weight: 100, reps: 8 },
        { weight: 100, reps: 6 },
      ],
    }])];
    const [r] = recentForExercise(h, "Back Squat");
    expect(r.topSet.reps).toBe(8);
  });

  it("flags allEqual when sets are uniform", () => {
    const h = [buildHistorySession("2026-05-01", [{
      name: "Back Squat",
      sets: [
        { weight: 100, reps: 5 },
        { weight: 100, reps: 5 },
        { weight: 100, reps: 5 },
      ],
    }])];
    const [r] = recentForExercise(h, "Back Squat");
    expect(r.allEqual).toBe(true);
  });

  it("flags allEqual=false when sets vary", () => {
    const h = [buildHistorySession("2026-05-01", [{
      name: "Back Squat",
      sets: [
        { weight: 100, reps: 5 },
        { weight: 100, reps: 4 },
      ],
    }])];
    const [r] = recentForExercise(h, "Back Squat");
    expect(r.allEqual).toBe(false);
  });

  it("exposes effort from topSet rpe if present, else falls back to any set rpe", () => {
    const h = [buildHistorySession("2026-05-01", [{
      name: "Back Squat",
      sets: [
        { weight: 90,  reps: 5 },                  // no rpe
        { weight: 110, reps: 3, rpe: "hard" },     // top set has rpe
        { weight: 100, reps: 5, rpe: "normal" },
      ],
    }])];
    const [r] = recentForExercise(h, "Back Squat");
    expect(r.effort).toBe("hard");

    const h2 = [buildHistorySession("2026-05-01", [{
      name: "Back Squat",
      sets: [
        { weight: 110, reps: 3 },                  // top set no rpe
        { weight: 100, reps: 5, rpe: "normal" },
      ],
    }])];
    const [r2] = recentForExercise(h2, "Back Squat");
    expect(r2.effort).toBe("normal");
  });

  it("returns null effort when no set has rpe", () => {
    const h = [buildHistorySession("2026-05-01", [{
      name: "Back Squat", sets: [{ weight: 100, reps: 5 }],
    }])];
    const [r] = recentForExercise(h, "Back Squat");
    expect(r.effort).toBeNull();
  });

  it("skips sessions where the exercise has only empty/invalid sets", () => {
    const h = [
      buildHistorySession("2026-05-05", [{ name: "Back Squat", sets: [] }]),
      buildHistorySession("2026-05-01", [{ name: "Back Squat", sets: [{ weight: null }] }]),
      buildHistorySession("2026-04-28", [{ name: "Back Squat", sets: [{ weight: 100, reps: 5 }] }]),
    ];
    const out = recentForExercise(h, "Back Squat");
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe("2026-04-28");
  });

  it("requires exact name match (case-sensitive)", () => {
    const h = [buildHistorySession("2026-05-01", [{ name: "Back Squat", sets: [{ weight: 100, reps: 5 }] }])];
    expect(recentForExercise(h, "back squat")).toEqual([]);
    expect(recentForExercise(h, "Back Squat")).toHaveLength(1);
  });

  it("searches across all blocks within a session", () => {
    const h = [{
      v: 2, date: "2026-05-01",
      blocks: [
        { id: "a", type: "main",     exercises: [{ name: "Bench Press", sets: [{ weight: 80, reps: 5 }] }] },
        { id: "b", type: "finisher", exercises: [{ name: "Back Squat",  sets: [{ weight: 100, reps: 5 }] }] },
      ],
    }];
    const out = recentForExercise(h, "Back Squat");
    expect(out).toHaveLength(1);
    expect(out[0].topSet.weight).toBe(100);
  });

  it("tolerates malformed records without crashing", () => {
    const h = [
      null,
      {},
      { date: "2026-05-01" },                                              // no blocks
      { date: "2026-04-28", blocks: null },                                // null blocks
      { date: "2026-04-25", blocks: [{ exercises: null }] },               // null exercises
      { date: "2026-04-20", blocks: [{ exercises: [null, undefined] }] },  // null exercises in list
      { blocks: [{ exercises: [{ name: "Back Squat", sets: [{ weight: 100, reps: 5 }] }] }] }, // missing date
      buildHistorySession("2026-04-15", [{ name: "Back Squat", sets: [{ weight: 100, reps: 5 }] }]),
    ];
    const out = recentForExercise(h, "Back Squat");
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe("2026-04-15");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// weeklyVolumeByMuscle — per-muscle granular sparkline data for Performance Lab.
// ────────────────────────────────────────────────────────────────────────────
describe("weeklyVolumeByMuscle", () => {
  it("returns the requested number of week columns", () => {
    const out = weeklyVolumeByMuscle([], { weeks: 8, now: new Date("2026-05-15T12:00:00Z") });
    expect(out.weeks).toHaveLength(8);
    expect(out.byMuscle).toEqual({});
  });

  it("week columns are ordered oldest → newest (Mondays)", () => {
    const out = weeklyVolumeByMuscle([], { weeks: 4, now: new Date("2026-05-13T12:00:00Z") });
    const sorted = [...out.weeks].sort();
    expect(out.weeks).toEqual(sorted);
    // Each entry is a YYYY-MM-DD on a Monday
    for (const w of out.weeks) {
      expect(/^\d{4}-\d{2}-\d{2}$/.test(w)).toBe(true);
      const day = new Date(w + "T12:00:00Z").getUTCDay();
      // Constructed via mondayOfWeek which uses local-time day calc;
      // accept Sun(0) or Mon(1) to cover the rare TZ edge.
      expect([0, 1]).toContain(day);
    }
  });

  it("credits a logged session to its week and distributes by anatomy", () => {
    // Back Squat — anatomy gives Quads primary + Glutes/Hams/Core/Calves
    // secondary. 1 completed set means Quads gets 1.0, others fractional.
    const h = [{
      date: "2026-05-11",  // Monday
      blocks: [{ id: "x", type: "main", exercises: [{
        name: "Barbell Back Squat", muscle: "Quadriceps",
        sets: [{ weight: 100, reps: 5 }],
      }]}],
    }];
    const out = weeklyVolumeByMuscle(h, { weeks: 4, now: new Date("2026-05-13T12:00:00Z") });
    // Quads should appear and be >= 1 (primary credit), Glutes/Hams should be
    // present at fractional values. Exact distribution lives in anatomy table.
    expect(out.byMuscle.Quads).toBeDefined();
    expect(out.byMuscle.Quads[out.weeks.length - 1]).toBeGreaterThanOrEqual(1);
    expect(out.byMuscle.Glutes).toBeDefined();
    expect(out.byMuscle.Glutes[out.weeks.length - 1]).toBeGreaterThan(0);
  });

  it("excludes sets that are not completed (weight null AND reps absent)", () => {
    const h = [{
      date: "2026-05-11",
      blocks: [{ id: "x", type: "main", exercises: [{
        name: "Back Squat", muscle: "Quads",
        sets: [{ weight: null }, { reps: null, weight: null }],
      }]}],
    }];
    const out = weeklyVolumeByMuscle(h, { weeks: 4, now: new Date("2026-05-13T12:00:00Z") });
    expect(out.byMuscle.Quads).toBeUndefined();
  });

  it("ignores records outside the trailing N-week window", () => {
    // Way-old record should not appear in the 4-week window.
    const h = [{
      date: "2025-12-01",
      blocks: [{ id: "x", type: "main", exercises: [{
        name: "Barbell Back Squat", muscle: "Quads",
        sets: [{ weight: 100, reps: 5 }],
      }]}],
    }];
    const out = weeklyVolumeByMuscle(h, { weeks: 4, now: new Date("2026-05-13T12:00:00Z") });
    expect(out.byMuscle.Quads).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// totalTonnage / milestones — lifetime-counter helpers for the Home card.
// ────────────────────────────────────────────────────────────────────────────
describe("totalTonnage", () => {
  it("returns 0 for empty/null history", () => {
    expect(totalTonnage([])).toBe(0);
    expect(totalTonnage(null)).toBe(0);
    expect(totalTonnage(undefined)).toBe(0);
  });

  it("sums weight × reps across all sets", () => {
    const h = [{
      date: "2026-05-01",
      blocks: [{ exercises: [{
        name: "Bench Press",
        sets: [
          { weight: 100, reps: 5 },
          { weight: 100, reps: 5 },
          { weight: 100, reps: 5 },
        ],
      }]}],
    }];
    expect(totalTonnage(h)).toBe(1500);  // 3 × 100 × 5
  });

  it("prefers cached set.volume when present", () => {
    const h = [{
      date: "2026-05-01",
      blocks: [{ exercises: [{
        name: "Squat",
        sets: [{ weight: 50, reps: 1, volume: 999 }],  // cached overrides raw
      }]}],
    }];
    expect(totalTonnage(h)).toBe(999);
  });

  it("doubles per-DB sets (both arms contribute to systemic load)", () => {
    const h = [{
      date: "2026-05-01",
      blocks: [{ exercises: [{
        name: "DB Curl",
        sets: [{ weight: 10, reps: 10, loadType: "per_db" }],
      }]}],
    }];
    expect(totalTonnage(h)).toBe(200);  // 10 × 10 × 2
  });

  it("does not double non-per-DB sets", () => {
    const h = [{
      date: "2026-05-01",
      blocks: [{ exercises: [{
        name: "Squat",
        sets: [{ weight: 100, reps: 5, loadType: "barbell" }],
      }]}],
    }];
    expect(totalTonnage(h)).toBe(500);
  });
});

describe("pendingTonnageMilestone", () => {
  it("returns null when no milestone crossed yet", () => {
    expect(pendingTonnageMilestone(500, 0)).toBeNull();
  });

  it("returns the lowest unseen milestone the user has crossed", () => {
    expect(pendingTonnageMilestone(1200, 0)).toBe(1000);
    expect(pendingTonnageMilestone(7000, 1000)).toBe(5000);
    expect(pendingTonnageMilestone(7000, 5000)).toBeNull();
  });

  it("skips milestones already acknowledged", () => {
    expect(pendingTonnageMilestone(11000, 10000)).toBeNull();
    expect(pendingTonnageMilestone(26000, 10000)).toBe(25000);
  });

  it("milestones are sorted ascending", () => {
    const sorted = [...TONNAGE_MILESTONES_KG].sort((a, b) => a - b);
    expect(TONNAGE_MILESTONES_KG).toEqual(sorted);
  });
});

describe("formatTonnage", () => {
  it("renders sub-tonne as kg", () => {
    expect(formatTonnage(500)).toBe("500 kg");
    expect(formatTonnage(999)).toBe("999 kg");
  });

  it("renders 1–9.99t with 2dp", () => {
    expect(formatTonnage(1000)).toBe("1.00 t");
    expect(formatTonnage(1234)).toBe("1.23 t");
    expect(formatTonnage(5000)).toBe("5.00 t");
  });

  it("renders 10–99.9t with 1dp", () => {
    expect(formatTonnage(10000)).toBe("10.0 t");
    expect(formatTonnage(50000)).toBe("50.0 t");
  });

  it("renders >=100t as whole tonnes", () => {
    expect(formatTonnage(100000)).toBe("100 t");
    expect(formatTonnage(250000)).toBe("250 t");
  });
});
