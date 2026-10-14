// @vitest-environment jsdom
// One resolver for every plan weight: startWeightFor (lib/lift-translations.js),
// wired to the bodyweight start by planStartWeight (lib/programme-resolve.js). Order:
// working weight → muscle-anchor cold start → bodyweight start → template → null.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { startWeightFor, coldStartFromAnchor, snapToImplement, getLiftProfile, __test__ } from "../lib/lift-translations.js";
import { planStartWeight, startingWeightForLift, newDraftLog, logSet, finaliseDraft, H, TS } from "../lib/storage.js";
import { updateMuscleAnchorFromSession } from "../lib/progression.js";
import { applySessionToEngine } from "../lib/session-engine.js";
import { runTool } from "../lib/mcp-server.js";
import { EXERCISE_POOLS } from "../lib/programme.js";

const ROOT = join(import.meta.dirname, "..");
const now = new Date("2026-09-24T12:00:00Z");

// The owner's case: a 140 kg × 10 hip thrust, Epley e1RM ≈ 186.7.
const GLUTES = { bestE1RM: 140 * (1 + 10 / 30), bestE1RMLift: "Barbell Hip Thrust" };
const ANCHORS = { Glutes: GLUTES };
const BRIDGE = EXERCISE_POOLS["ass2-A"].pool.find((p) => p.name === "Barbell Glute Bridge");

describe("startWeightFor: the rungs, in order", () => {
  const squat = { name: "Barbell Back Squat", weight: 60, loadType: "barbell" };
  const quads = { Quadriceps: { bestE1RM: 140, bestE1RMLift: "Leg Press" } };

  it("1. the lifter's working weight wins", () => {
    expect(planStartWeight(squat, { working: { [squat.name]: 100 }, bodyweight: 80, anchors: quads })).toBe(100);
  });
  it("a non-numeric working entry is not a weight: the next rung answers", () => {
    expect(planStartWeight(squat, { working: { [squat.name]: null }, anchors: quads })).toBe(105);
  });
  it("2. the muscle-anchor cold start, snapped like the engine's", () => {
    const want = snapToImplement(coldStartFromAnchor(squat.name, quads.Quadriceps), "barbell");
    expect(want).toBe(105);
    expect(planStartWeight(squat, { working: {}, bodyweight: 80, anchors: quads })).toBe(want);
  });
  it("3. the bodyweight start when no anchor answers", () => {
    expect(planStartWeight(squat, { working: {}, bodyweight: 80, anchors: {} })).toBe(startingWeightForLift(squat.name, 80, 60));
    expect(planStartWeight(squat, { bodyweight: 80 })).toBe(60);
  });
  it("3. is supplied by storage: the pure resolver alone skips it", () => {
    const swappedMain = { name: "Incline BB Press", weight: null, loadType: "barbell" };
    expect(startWeightFor(swappedMain, { bodyweight: 80 })).toBe(null);
    expect(planStartWeight(swappedMain, { bodyweight: 80 })).toBe(startingWeightForLift(swappedMain.name, 80));
  });
  it("4. the template weight", () => {
    expect(planStartWeight(squat, {})).toBe(60);
    expect(planStartWeight(squat, { template: 42.5 })).toBe(42.5);
  });
  it("5. null when nothing answers", () => {
    expect(planStartWeight({ name: "Incline BB Press", weight: null, loadType: "barbell" }, {})).toBe(null);
    expect(planStartWeight(null, {})).toBe(null);
    expect(planStartWeight({ weight: 20 }, {})).toBe(null);
  });
});

describe("the owner's cases", () => {
  it("a Glutes anchor makes a barbell glute bridge with no working weight about 112.5 kg, not the 55 kg template", () => {
    expect(BRIDGE.weight).toBe(55);
    expect(planStartWeight(BRIDGE, { working: {}, bodyweight: 80, anchors: ANCHORS })).toBe(112.5);
  });
  it("a pool accessory with a template and no anchor keeps the template", () => {
    expect(planStartWeight(BRIDGE, { working: {}, bodyweight: 80, anchors: {} })).toBe(55);
    expect(planStartWeight(BRIDGE, { working: {}, bodyweight: 80, anchors: { Chest: GLUTES } })).toBe(55);
  });
  it("a swapped main with no anchor keeps the bodyweight start", () => {
    const swapped = { name: "Incline BB Press", weight: null, loadType: "barbell" };
    const bwStart = startingWeightForLift(swapped.name, 80);
    expect(bwStart).toBeGreaterThan(0);
    expect(planStartWeight(swapped, { working: {}, bodyweight: 80, anchors: {} })).toBe(bwStart);
  });
  it("a pure bodyweight lift resolves null, whatever W or the anchors hold", () => {
    const bridge = { name: "Glute Bridge", weight: null, loadType: "bodyweight" };
    expect(planStartWeight(bridge, { working: { "Glute Bridge": 80 }, bodyweight: 80, anchors: ANCHORS, template: 20 })).toBe(null);
  });
  it("timed holds are untouched: bodyweight holds resolve null", () => {
    for (const name of ["L-Sit Hold", "Plank", "Wall Sit", "Side Plank", "Hollow Body Hold"]) {
      const anchors = { Core: GLUTES, Quadriceps: GLUTES, "Adductors / Core": GLUTES };
      expect(planStartWeight({ name, reps: "30s", weight: null }, { bodyweight: 80, anchors })).toBe(null);
    }
  });
  it("a loaded bodyweight lift takes no anchor start: its kg is optional added load", () => {
    const pullUp = { name: "Pull-Up", weight: null, loadType: "loaded_bodyweight" };
    expect(coldStartFromAnchor("Pull-Up", { bestE1RM: 120 })).toBeGreaterThan(0);
    expect(planStartWeight(pullUp, { bodyweight: 80, anchors: { Back: { bestE1RM: 120 } } })).toBe(null);
    expect(planStartWeight(pullUp, { working: { "Pull-Up": 10 }, anchors: { Back: { bestE1RM: 120 } } })).toBe(10);
  });
});

describe("the swap seed's call: only the anchor rung seeds W", () => {
  // SessionHost.onSwap: planStartWeight(newEx, { anchors, bodyweight: null, template: null })
  const seed = (ex, anchors) => planStartWeight(ex, { anchors, bodyweight: null, template: null });
  const bridge = { ...BRIDGE, weight: null };
  it("an anchor seeds its start; no anchor seeds nothing", () => {
    expect(seed(bridge, ANCHORS)).toBe(112.5);
    expect(seed(bridge, {})).toBe(null);
  });
  it("neither the template nor the bodyweight start leaks in", () => {
    expect(seed(BRIDGE, {})).toBe(null); // template 55 suppressed
    expect(seed({ name: "Incline BB Press", weight: null, loadType: "barbell" }, {})).toBe(null);
    expect(seed({ name: "Barbell Back Squat", weight: 60 }, {})).toBe(null); // bodyweight is null
  });
});

describe("one resolver: no plan surface computes its own start", () => {
  const files = (dir) => readdirSync(join(ROOT, dir)).flatMap((f) => {
    const p = join(ROOT, dir, f);
    return statSync(p).isDirectory() ? files(relative(ROOT, p)) : /\.(jsx?|mjs)$/.test(f) ? [relative(ROOT, p)] : [];
  });
  const source = [...files("components"), ...files("app"), ...files("lib")];
  const CALL = /\b(coldStartFromAnchor|startingWeightForLift)\s*\(/g;
  // Definitions; the resolver; the engine's own first-time prescription
  // (progression.js), which sets W rather than a plan weight.
  const ALLOWED = new Set(["lib/lift-translations.js", "lib/programme-resolve.js", "lib/progression.js"]);

  it("only the resolver, the definitions and the engine call the cold-start helpers", () => {
    const callers = source.filter((f) => {
      const text = readFileSync(join(ROOT, f), "utf8").replace(/export function (coldStartFromAnchor|startingWeightForLift)\s*\(/g, "");
      return (text.match(CALL) || []).length > 0;
    });
    expect(callers.filter((f) => !ALLOWED.has(f))).toEqual([]);
  });
  it("programme-resolve only defines startingWeightForLift and calls it once, in planStartWeight; lift-translations calls coldStartFromAnchor only in the resolver", () => {
    const resolve = readFileSync(join(ROOT, "lib/programme-resolve.js"), "utf8");
    expect(resolve.match(/\bstartingWeightForLift\s*\(/g)).toEqual(["startingWeightForLift("]);
    expect(resolve.match(/bodyweightStart: startingWeightForLift\b/g)).toHaveLength(1);
    expect(resolve.match(/\bcoldStartFromAnchor\b/g)).toBe(null);
    // storage keeps the old import path only.
    expect(readFileSync(join(ROOT, "lib/storage.js"), "utf8").match(/\b(startingWeightForLift|planStartWeight)\s*\(/g)).toBe(null);
    const lt = readFileSync(join(ROOT, "lib/lift-translations.js"), "utf8");
    const resolver = lt.slice(lt.indexOf("export function startWeightFor("), lt.indexOf("\n}\n", lt.indexOf("export function startWeightFor(")));
    expect(lt.match(/\bcoldStartFromAnchor\s*\(/g)).toHaveLength(2); // definition + resolver
    expect(resolver).toMatch(/coldStartFromAnchor\s*\(/);
  });
  it("the session host, the retro sheet and the MCP plan resolve through planStartWeight", () => {
    const count = (f) => (readFileSync(join(ROOT, f), "utf8").match(/\bplanStartWeight\s*\(/g) || []).length;
    expect(count("components/SessionHost.jsx")).toBe(5); // getW, swap seed, reach, logged, prescribed
    expect(count("components/ForgeApp.jsx")).toBe(1);
    expect(count("lib/mcp-server.js")).toBe(0);       // planLoad calls planWeight (programme-resolve)
    expect(count("lib/programme-resolve.js")).toBe(2); // definition, planWeight
    expect(readFileSync(join(ROOT, "lib/mcp-server.js"), "utf8").match(/\bplanWeight\s*\(/g)).toHaveLength(1); // planLoad
  });
});

describe("MCP tools read the same start", () => {
  const meta = (extra = {}) => ({
    bodyweight: { kg: 80 },
    trainingState: { muscleAnchors: ANCHORS },
    ...extra,
  });

  it("current_loads shows 112.5 for the glute bridge with a target and no working weight", () => {
    const d = { meta: meta({ reps: { "Barbell Glute Bridge": 12 } }), history: [] };
    expect(runTool("current_loads", {}, d, now).text).toBe("- Barbell Glute Bridge: 112.5 kg (suggested start) × 12");
  });
  it("current_loads without the anchor shows the template, never 'bodyweight'", () => {
    const d = { meta: { reps: { "Barbell Glute Bridge": 12 }, programmeBlock: { config: { "ass2-A": BRIDGE } } }, history: [] };
    expect(runTool("current_loads", {}, d, now).text).toBe("- Barbell Glute Bridge: 55 kg (suggested start) × 12");
  });
  it("current_loads words a suggested start by load type, as programme does", () => {
    const pool = EXERCISE_POOLS["bss1-B"].pool;
    for (const [name, want] of [["Weighted Pull-Up", "bodyweight + 8 kg (suggested start)"], ["Assisted Pull-Up", null]]) {
      const ex = { ...pool.find((p) => p.name === name), ...(want ? {} : { weight: 20 }) };
      const read = want ?? "20 kg assistance (suggested start)";
      const d = { meta: { bodyweight: { kg: 80 }, reps: { [name]: ex.reps }, programmeBlock: { number: 1, config: { "bss1-B": ex } } }, history: [] };
      expect(runTool("current_loads", {}, d, now).text).toBe(`- ${name}: ${read} × ${ex.reps}`);
      expect(runTool("programme", {}, d, now).text).toContain(`${name} 3 × ${ex.reps} @ ${read}`);
    }
  });
  it("a stored null reads as no working weight in both tools, as the resolver reads it", () => {
    const d = { meta: meta({ weights: { "Barbell Glute Bridge": null }, reps: { "Barbell Glute Bridge": 12 }, programmeBlock: { number: 1, config: { "ass2-A": BRIDGE } } }), history: [] };
    expect(runTool("current_loads", {}, d, now).text).toBe("- Barbell Glute Bridge: 112.5 kg (suggested start) × 12");
    expect(runTool("programme", {}, d, now).text).toContain("Barbell Glute Bridge 3 × 12 @ 112.5 kg (suggested start)");
  });
  it("the programme plans the rotated-in glute bridge at 112.5", () => {
    const d = { meta: meta({ programmeBlock: { number: 1, config: { "ass2-A": BRIDGE } } }), history: [] };
    expect(runTool("programme", {}, d, now).text).toContain("Barbell Glute Bridge 3 × 12 @ 112.5 kg (suggested start)");
  });
});

describe("an unset (a stored null) is no stored value, at every rung and in the rep repair", () => {
  const squat = { name: "Barbell Back Squat", weight: 60, reps: 5, loadType: "barbell" };
  it("the start with a null W equals the start with no key, whatever else is known", () => {
    for (const opts of [{}, { bodyweight: 80 }, { anchors: { Quadriceps: { bestE1RM: 140 } } }, { bodyweight: 80, anchors: { Quadriceps: { bestE1RM: 140 } } }]) {
      const withNull = planStartWeight(squat, { ...opts, working: { [squat.name]: null } });
      expect(withNull).toBe(planStartWeight(squat, { ...opts, working: {} }));
      expect(Number.isFinite(withNull)).toBe(true);
    }
  });
  it("a null rep target is never repaired into a number, and repairs nothing else", async () => {
    const { repTargetRepairs, repairRepTarget } = await import("../lib/progression.js");
    expect(repairRepTarget({ target: null, templateReps: 5, loadType: "barbell" })).toMatchObject({ reps: null, repaired: false });
    const sessions = [{ blocks: [{ ex: squat }, { ex: { name: "Barbell Bench Press", reps: 5, loadType: "barbell" } }] }];
    expect(repTargetRepairs({ reps: { [squat.name]: null, "Barbell Bench Press": 3 }, sessions }))
      .toEqual(repTargetRepairs({ reps: { "Barbell Bench Press": 3 }, sessions }));
  });
});

// Five lifts that used to fall to name inference: the default (no anchor), the
// dumbbell incline rule, the Chest press rule and the triceps "extension" rule.
describe("lift profiles: each listed lift reads and writes its own anchor", () => {
  const CASES = [
    { name: "Push Press",             loadType: "barbell",           weight: 50, reps: 5,  want: { primaryMuscle: "Shoulders",  category: "upper_push",         factor: 1.2 } },
    { name: "Hang Power Clean",       loadType: "barbell",           weight: 50, reps: 3,  want: { primaryMuscle: "Power",      category: "power",              factor: 0.9 } },
    { name: "Weighted Dips",          loadType: "loaded_bodyweight", weight: 10, reps: 8,  want: { primaryMuscle: "Chest",      category: "upper_push",         factor: 1.0 } },
    { name: "Incline BB Press",       loadType: "barbell",           weight: 50, reps: 8,  want: { primaryMuscle: "Chest",      category: "upper_push",         factor: 0.8 } },
    { name: "Reverse Hyperextension", loadType: "machine",           weight: 25, reps: 12, want: { primaryMuscle: "Glutes",     category: "accessory_compound", factor: 0.35 } },
  ];
  const BW = 80;

  for (const c of CASES) {
    it(`${c.name}: its own profile, not inference`, () => {
      expect(Object.hasOwn(__test__.PROFILES, c.name)).toBe(true);
      expect(getLiftProfile(c.name)).toEqual({ ...c.want, progressesByLoad: true });
    });

    it(`${c.name}: one logged set writes the ${c.want.primaryMuscle} anchor`, () => {
      const d = newDraftLog({ profileName: "p", session: "strength-b", blockNumber: 1, readiness: "normal", bodyweight: BW });
      logSet(d, {
        blockId: "b2", blockType: "main", exerciseName: c.name, muscle: "", swapped: true, fromPool: null,
        loadType: c.loadType, bodyweight: BW, weight: c.weight, reps: c.reps, rpe: 8, prescribed: { sets: 3, reps: c.reps },
      });
      const rec = finaliseDraft(d);
      const ex = rec.blocks[0].exercises[0];
      const set = ex.sets[0];
      // The anchor key, as lib/session-engine.js picks it.
      expect(getLiftProfile(ex.name).primaryMuscle).toBe(c.want.primaryMuscle);
      const anchor = updateMuscleAnchorFromSession(null, rec, ex);
      expect(anchor?.bestE1RMLift).toBe(c.name);
      // Weighted Dips: the e1RM is on bodyweight plus the belt, as Weighted Pull-Up's.
      if (c.loadType === "loaded_bodyweight") expect(set.effectiveLoad).toBe(BW + c.weight);
      expect(anchor?.bestE1RM).toBeCloseTo(set.est1rm / c.want.factor, 0);
    });
  }

  it("the dumbbell incline rule no longer reads a barbell incline as per-dumbbell", () => {
    expect(__test__.inferProfileFromName("Incline Barbell Press").factor).toBe(0.8);
    expect(__test__.inferProfileFromName("Incline DB Press").factor).toBe(0.4);
  });
});

// The engine's own cold start (a lift with no state and no loaded sets to
// seed from) lands on the implement's grid. The Biceps anchor gives
// 56 x 0.75 x 0.35 = 14.7 -> 14.5, a dumbbell no rack has.
describe("the engine's cold start lands on the implement's grid", () => {
  const biceps = { bestE1RM: 56, bestE1RMLift: "DB Curl" };
  const firstSession = (weight, readiness) => {
    localStorage.clear();
    TS.save("p", { ...TS.get("p"), muscleAnchors: { Biceps: biceps } });
    const set = { weight, reps: 12, rir: 0, loadType: "per_db", effectiveLoad: weight, est1rm: weight === null ? null : 21 };
    const rec = {
      v: 2, id: "2026-10-11T10:00:00.000Z", date: "2026-10-11", readiness, session: "strength-c",
      blocks: [{ id: "cacc", type: "superset", exercises: [{ name: "Incline DB Curl", loadType: "per_db", sets: [set, set, set] }] }],
    };
    H.append("p", rec);
    return applySessionToEngine("p", rec);
  };

  it("a per-dumbbell lift with no logged load cold-starts on a whole kilo", () => {
    const out = firstSession(null, "normal");
    expect(coldStartFromAnchor("Incline DB Curl", biceps)).toBe(14.5);
    expect(out.wwUpdates["Incline DB Curl"]).toBe(15);
    expect(TS.get("p").lifts["Incline DB Curl"].history.at(-1).decision).toBe("COLD_START");
  });

  it("a cooked first session holds what was lifted, not the anchor", () => {
    const out = firstSession(15, "cooked");
    expect(out.wwUpdates["Incline DB Curl"]).toBe(15);
    expect(TS.get("p").lifts["Incline DB Curl"].history.at(-1).decision).toBe("HOLD");
  });
});
