// Every reader that shows a prescribed weight agrees with the card during a
// deload and on a lift's first visit after one (scheduledPlan), and none of
// them mentions a deload when none is active.
import { describe, it, expect } from "vitest";
import { runTool } from "../lib/mcp-server.js";
import { projectPlan } from "../lib/trainer-plan.js";

const SQUAT = "Barbell Back Squat";
const now = new Date(2026, 10, 4, 9, 0);
const state = (currentWeight, reps = 5, over = {}) => ({
  currentWeight, history: [], currentRepRange: { reps, sets: 3, baseReps: reps }, ...over,
});
const deload = { startedAt: new Date(2026, 10, 2, 8, 0).toISOString(), plannedDays: 5, preDeloadWeights: { [SQUAT]: 100 } };
const meta = (lifts, activeDeload, weights = { [SQUAT]: 100 }) => ({
  weights, reps: {}, trainingState: { lifts, mesocycle: { activeDeload } },
});
const squatLine = (text) => text.split("\n").find((l) => l.startsWith(`- ${SQUAT}:`) || l.includes(`${SQUAT} `));

describe("the MCP readers", () => {
  it("current_loads shows the deload weight, and a bodyweight lift's reps as they are", () => {
    const text = runTool("current_loads", {}, { meta: meta({ [SQUAT]: state(100), "Nordic Curl": state(null, 8) }, deload), history: [] }, now).text;
    expect(text.split("\n")).toContain(`- ${SQUAT}: 65 kg`);
    expect(text).not.toContain("Nordic Curl: bodyweight × 4");
  });

  it("current_loads shows the re-entry on a lift's first visit after the close", () => {
    const lifts = { [SQUAT]: state(65, 5, { inRecoveryUntil: 3, preDeloadWeight: 100 }) };
    const text = runTool("current_loads", {}, { meta: meta(lifts, null, { [SQUAT]: 65 }), history: [] }, now).text;
    expect(text.split("\n")).toContain(`- ${SQUAT}: 90 kg`);
    expect(text.toLowerCase()).not.toContain("deload");
  });

  it("programme shows the deload weight and says it is a deload week, and neither without one", () => {
    const on = runTool("programme", {}, { meta: meta({ [SQUAT]: state(100) }, deload), history: [] }, now).text;
    expect(squatLine(on)).toContain("@ 65 kg");
    expect(on).toContain("Deload week: the weights and reps below are the deload's.");
    const off = runTool("programme", {}, { meta: meta({ [SQUAT]: state(100) }, null), history: [] }, now).text;
    expect(squatLine(off)).toContain("@ 100 kg");
    expect(off.toLowerCase()).not.toContain("deload");
  });
});

describe("one set fewer for a hard bodyweight block", () => {
  // Strength A's ass2 with TRX Row rotated in: both lifts bodyweight, last logged at RPE 9.
  const HIP = "45-Degree Hip Extension", TRX = "TRX Row";
  const hard = (name) => ({ name, loadType: "bodyweight", sets: [{ weight: null, reps: 12, rpe: 9, rir: 1, loadType: "bodyweight" }] });
  const history = [{ v: 2, id: "2026-11-01T10:00:00.000Z", date: "2026-11-01", session: "strength-a", readiness: "normal",
    blocks: [{ id: "ass2", type: "superset", exercises: [hard(HIP), hard(TRX)] }] }];
  const m = (active) => ({ ...meta({ [SQUAT]: state(100), [HIP]: state(null, 12), [TRX]: state(null, 12) }, active),
    programmeBlock: { number: 1, config: { "ass2-B": { name: TRX } } } });
  const line = (text) => text.split("\n").find((l) => l.includes(`${HIP} `));

  it("programme prints the block at one set fewer during a deload, and as composed without one", () => {
    expect(line(runTool("programme", {}, { meta: m(deload), history }, now).text)).toMatch(new RegExp(`${HIP} 2 × .* \\+ ${TRX} 2 ×`));
    expect(line(runTool("programme", {}, { meta: m(null), history }, now).text)).toMatch(new RegExp(`${HIP} 3 × .* \\+ ${TRX} 3 ×`));
  });
});

describe("the trainer plan", () => {
  const lift = (m) => projectPlan({ meta: m, history: [] }, { todayIso: "2026-11-04" }).lifts.find((l) => l.name === SQUAT);

  it("shows the client's card weight as w and keeps the stored W as the basis", () => {
    const l = lift(meta({ [SQUAT]: state(100) }, deload));
    expect(l.w).toBe(65);
    expect(l.basis.w).toBe(100);
  });

  it("past its window a deload reads as none: the re-entry after a session in it, the normal weight after none", () => {
    const history = [{ v: 2, id: "2026-11-02T10:00:00.000Z", date: "2026-11-02", session: "strength-a", blocks: [] }];
    const plan = projectPlan({ meta: meta({ [SQUAT]: state(100) }, deload), history }, { todayIso: "2026-11-09" });
    expect(plan.deload.active).toBe(false);
    expect(plan.lifts.find((l) => l.name === SQUAT).w).toBe(90);
    const rested = projectPlan({ meta: meta({ [SQUAT]: state(100) }, deload), history: [] }, { todayIso: "2026-11-09" });
    expect(rested.deload.active).toBe(false);
    expect(rested.lifts.find((l) => l.name === SQUAT).w).toBe(100);
    const during = projectPlan({ meta: meta({ [SQUAT]: state(100) }, deload), history }, { todayIso: "2026-11-04" });
    expect(during.deload.active).toBe(true);
    expect(during.lifts.find((l) => l.name === SQUAT).w).toBe(65);
  });

  it("shows W as it is with no deload", () => {
    const l = lift(meta({ [SQUAT]: state(100) }, null));
    expect(l.w).toBe(100);
    expect(l.basis.w).toBe(100);
  });
});

describe("the retro sheet", () => {
  it("prefills from the card's plan, not raw W and R", async () => {
    const { readFileSync: read } = await import("node:fs");
    expect(read(new URL("../components/ForgeApp.jsx", import.meta.url), "utf8")).toContain("setDrops={retroPlan.setDrops}");
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../components/ForgeApp.jsx", import.meta.url), "utf8");
    expect(src).toMatch(/const retroPlan = useMemo\(\(\) => scheduledPlan\(\{/);
    expect(src).toContain("workingWeights={retroPlan.weights}");
    expect(src).toContain("workingReps={retroPlan.reps}");
  });
});
