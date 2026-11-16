// Library numbers: lift factors, slot templates and the cold-start ceilings
// that size a first suggestion for a lift the lifter has never logged.
import { describe, it, expect } from "vitest";
import { getLiftProfile, coldStartFromAnchor, __test__ } from "../lib/lift-translations.js";
import { SESSIONS, EXERCISE_POOLS } from "../lib/programme.js";

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
