// Library numbers: lift factors, slot templates and the cold-start ceilings
// that size a first suggestion for a lift the lifter has never logged.
import { describe, it, expect } from "vitest";
import { getLiftProfile, coldStartFromAnchor, startWeightFor, deriveMuscleAnchors, snapToImplement, REFERENCE_LIFTS, __test__ } from "../lib/lift-translations.js";
import { computeNextPrescription } from "../lib/progression.js";
import { SESSIONS, EXERCISE_POOLS, SWAP_DB } from "../lib/programme.js";

/** Every lift the programme lists: sessions, pools, swap keys and options. */
function catalogue() {
  const names = new Set();
  for (const s of SESSIONS) for (const b of s.blocks || []) for (const v of Object.values(b)) if (v && typeof v === "object" && v.name) names.add(v.name);
  for (const slot of Object.values(EXERCISE_POOLS)) for (const ex of slot.pool) names.add(ex.name);
  for (const [k, opts] of Object.entries(SWAP_DB)) { names.add(k); for (const o of opts) names.add(o.name); }
  return [...names];
}

/** The first template a lift carries, or null. */
function template(name) {
  return templates(name).find((w) => typeof w === "number") ?? null;
}

/** Every template of a lift, in the sessions and the pools. */
function templates(name) {
  const out = [];
  for (const s of SESSIONS) for (const b of s.blocks || []) for (const v of Object.values(b)) {
    if (v && typeof v === "object" && v.name === name) out.push(v.weight);
  }
  for (const slot of Object.values(EXERCISE_POOLS)) for (const ex of slot.pool) if (ex.name === name) out.push(ex.weight);
  return out;
}

describe("factors", () => {
  const FACTORS = {
    "Face Pull": 0.5,
    "Rear Delt Fly": 0.25,
    "Cable Rear Delt Fly": 0.3,
    "Low-to-High Cable Crossover": 0.2,
    "Low-to-High Cable Fly": 0.2,
    "Bulgarian Split Squat": 0.25,
    "DB Front Squat": 0.2,
    "Leg Press": 2.0,
    "Reverse Hyperextension": 0.25,
  };
  for (const [name, factor] of Object.entries(FACTORS)) {
    it(`${name} reads ${factor} from its own profile`, () => {
      expect(Object.hasOwn(__test__.PROFILES, name)).toBe(true);
      expect(getLiftProfile(name).factor).toBe(factor);
    });
  }

  it("a never-logged lift starts at anchor x 0.75 x its factor", () => {
    // Shoulders 71.5 (OHP 61.25 x 5); Quadriceps 151.7 (squat 130 x 5); Glutes 186.7.
    expect(coldStartFromAnchor("Face Pull", { bestE1RM: 71.5 })).toBe(25);
    expect(coldStartFromAnchor("Rear Delt Fly", { bestE1RM: 71.5 })).toBe(13.5);
    expect(coldStartFromAnchor("DB Front Squat", { bestE1RM: 151.7 })).toBe(23);
    expect(coldStartFromAnchor("Leg Press", { bestE1RM: 151.7 })).toBe(227.5);
    expect(coldStartFromAnchor("Reverse Hyperextension", { bestE1RM: 186.7 })).toBe(35);
  });
});

describe("slot templates", () => {
  it("DB Front Squat is 16 kg per dumbbell", () => {
    expect(templates("DB Front Squat")).toEqual([16]);
  });
  it("Landmine Press is 20 kg wherever it is listed", () => {
    const got = templates("Landmine Press");
    expect(got.length).toBeGreaterThan(0);
    expect(new Set(got)).toEqual(new Set([20]));
  });
});

const LATERAL_RAISES = ["Lateral Raise", "Seated Lateral Raise", "Cable Lateral Raise", "Leaning Lateral Raise"];
const MACHINE_CURLS = ["Machine Hamstring Curl", "Seated Leg Curl"];
const TRICEPS_TEMPLATE_START = [
  "Overhead Tricep Extension", "DB Overhead Extension", "DB Kickback", "Tricep Dips",
  "Rope Tricep Pushdown", "Single-Arm Pushdown", "Reverse-Grip Pushdown",
];
const HUGE = { bestE1RM: 1000, bestE1RMLift: "x" };

describe("template-start lifts: the slot template, never a muscle anchor", () => {
  const ALL = [...LATERAL_RAISES, ...MACHINE_CURLS, ...TRICEPS_TEMPLATE_START];

  it("every lateral raise in the catalogue that progresses by load is one", () => {
    const raises = catalogue().filter((n) => /lateral raise/i.test(n) && getLiftProfile(n).progressesByLoad);
    expect(raises.sort()).toEqual([...LATERAL_RAISES].sort());
  });

  for (const name of ALL) {
    it(`${name}: no anchor start, whatever the anchor`, () => {
      expect(Object.hasOwn(__test__.PROFILES, name)).toBe(true);
      expect(getLiftProfile(name).templateStart).toBe(true);
      expect(coldStartFromAnchor(name, HUGE)).toBeNull();
    });
  }

  it("the plan shows the template; a logged working weight still wins", () => {
    for (const name of [...LATERAL_RAISES, ...MACHINE_CURLS, "Overhead Tricep Extension", "DB Overhead Extension", "Rope Tricep Pushdown"]) {
      const t = template(name);
      expect(t, name).toBeGreaterThan(0);
      const muscle = getLiftProfile(name).primaryMuscle;
      const ex = { name, weight: t };
      expect(startWeightFor(ex, { anchors: { [muscle]: HUGE } }), name).toBe(t);
      expect(startWeightFor(ex, { working: { [name]: t + 11 }, anchors: { [muscle]: HUGE } }), name).toBe(t + 11);
    }
  });

  it("the engine's cold start falls to the caller's template", () => {
    const p = computeNextPrescription({ liftName: "Lateral Raise", history: [], liftState: null, muscleAnchor: HUGE, context: { currentWeight: 7, loadType: "per_db" } });
    expect(p.weight).toBe(7);
    expect(p.rationale).toContain("cold_start_no_anchor");
  });

  it("a name-inferred triceps lift starts from the template too", () => {
    expect(Object.hasOwn(__test__.PROFILES, "Cable Tricep Extension")).toBe(false);
    expect(getLiftProfile("Cable Tricep Extension")).toMatchObject({ primaryMuscle: "Triceps", templateStart: true });
    expect(coldStartFromAnchor("Cable Tricep Extension", HUGE)).toBeNull();
  });
});

describe("Triceps: Tricep Pushdown is the reference lift", () => {
  const rec = (date, exercises) => ({ id: `${date}T10:00:00.000Z`, date, schemaVersion: 3, session: "strength-b", readiness: "normal", blocks: [{ id: "b", type: "main", exercises }] });
  const set = (weight, reps, loadType) => ({ weight, reps, rir: 2, loadType, effectiveLoad: weight, est1rm: Math.round(weight * (1 + reps / 30) * 10) / 10 });
  const PUSHDOWN = rec("2026-10-01", [{ name: "Tricep Pushdown", loadType: "total", sets: [set(32.5, 12, "total")] }]);
  const SKULL = rec("2026-10-02", [{ name: "Skullcrusher", loadType: "barbell", sets: [set(35, 12, "barbell")] }]);

  it("is declared and kept by the guard", () => {
    expect(REFERENCE_LIFTS.Triceps).toEqual(["Tricep Pushdown"]);
    expect(__test__.REFERENCE_MUSCLE_OF.get("Tricep Pushdown")).toBe("Triceps");
  });

  it("the guard refuses a template-start lift as a reference", () => {
    expect(__test__.referenceMuscleOf({ Shoulders: ["Lateral Raise"], Triceps: ["DB Overhead Extension", "Tricep Pushdown"] }))
      .toEqual(new Map([["Tricep Pushdown", "Triceps"]]));
  });

  it("factors: pushdown 0.50, Skullcrusher 0.50, Cable Overhead Extension 0.40 from its own profile", () => {
    expect(getLiftProfile("Tricep Pushdown").factor).toBe(0.5);
    expect(getLiftProfile("Skullcrusher").factor).toBe(0.5);
    expect(Object.hasOwn(__test__.PROFILES, "Cable Overhead Extension")).toBe(true);
    expect(getLiftProfile("Cable Overhead Extension")).toMatchObject({ primaryMuscle: "Triceps", factor: 0.4 });
    expect(getLiftProfile("Cable Overhead Extension").templateStart).toBeUndefined();
  });

  it("a logged pushdown anchors Triceps", () => {
    // 32.5 x 12: e1RM 45.5, over 0.50.
    expect(deriveMuscleAnchors([PUSHDOWN]).Triceps).toEqual({ bestE1RM: 91, bestE1RMLift: "Tricep Pushdown", bestE1RMDate: "2026-10-01" });
  });

  it("a never-logged Skullcrusher and Cable Overhead Extension start from it", () => {
    const anchors = deriveMuscleAnchors([PUSHDOWN]);
    expect(coldStartFromAnchor("Skullcrusher", anchors.Triceps)).toBe(34);
    expect(coldStartFromAnchor("Cable Overhead Extension", anchors.Triceps)).toBe(27.5);
    expect(startWeightFor({ name: "Skullcrusher", weight: 18, loadType: "barbell" }, { anchors })).toBe(snapToImplement(34, "barbell"));
    expect(startWeightFor({ name: "Cable Overhead Extension", weight: 16, loadType: "total" }, { anchors })).toBe(snapToImplement(27.5, "total"));
  });

  it("the template-start triceps lifts ignore it", () => {
    const anchors = deriveMuscleAnchors([PUSHDOWN]);
    for (const name of TRICEPS_TEMPLATE_START) {
      expect(coldStartFromAnchor(name, anchors.Triceps), name).toBeNull();
      const t = template(name);
      if (t !== null) expect(startWeightFor({ name, weight: t }, { anchors }), name).toBe(t);
    }
  });

  it("with no pushdown logged every triceps lift starts from its template, as before", () => {
    const anchors = deriveMuscleAnchors([SKULL]);
    expect(anchors.Triceps).toBeUndefined();
    const triceps = catalogue().filter((n) => getLiftProfile(n).primaryMuscle === "Triceps" && getLiftProfile(n).progressesByLoad);
    expect(triceps.length).toBeGreaterThan(5);
    for (const name of triceps) {
      const t = template(name);
      expect(startWeightFor({ name, weight: t }, { anchors }), name).toBe(t);
    }
  });
});
