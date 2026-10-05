// One resolver for every plan weight: startWeightFor (lib/lift-translations.js),
// wired to the bodyweight start by planStartWeight (lib/storage.js). Order:
// working weight → muscle-anchor cold start → bodyweight start → template → null.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { startWeightFor, coldStartFromAnchor, snapToImplement } from "../lib/lift-translations.js";
import { planStartWeight, startingWeightForLift } from "../lib/storage.js";
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
  const ALLOWED = new Set(["lib/lift-translations.js", "lib/storage.js", "lib/progression.js"]);

  it("only the resolver, the definitions and the engine call the cold-start helpers", () => {
    const callers = source.filter((f) => {
      const text = readFileSync(join(ROOT, f), "utf8").replace(/export function (coldStartFromAnchor|startingWeightForLift)\s*\(/g, "");
      return (text.match(CALL) || []).length > 0;
    });
    expect(callers.filter((f) => !ALLOWED.has(f))).toEqual([]);
  });
  it("storage only defines startingWeightForLift; lift-translations calls coldStartFromAnchor only in the resolver", () => {
    const storage = readFileSync(join(ROOT, "lib/storage.js"), "utf8");
    expect(storage.match(/\bstartingWeightForLift\s*\(/g)).toEqual(["startingWeightForLift("]);
    expect(storage.match(/\bcoldStartFromAnchor\b/g)).toBe(null);
    const lt = readFileSync(join(ROOT, "lib/lift-translations.js"), "utf8");
    const resolver = lt.slice(lt.indexOf("export function startWeightFor("), lt.indexOf("\n}\n", lt.indexOf("export function startWeightFor(")));
    expect(lt.match(/\bcoldStartFromAnchor\s*\(/g)).toHaveLength(2); // definition + resolver
    expect(resolver).toMatch(/coldStartFromAnchor\s*\(/);
  });
  it("the session host, the retro sheet and the MCP plan resolve through planStartWeight", () => {
    const count = (f) => (readFileSync(join(ROOT, f), "utf8").match(/\bplanStartWeight\s*\(/g) || []).length;
    expect(count("components/SessionHost.jsx")).toBe(5); // getW, swap seed, reach, logged, prescribed
    expect(count("components/ForgeApp.jsx")).toBe(1);
    expect(count("lib/mcp-server.js")).toBe(1);       // planLoad: exLine and current_loads
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
