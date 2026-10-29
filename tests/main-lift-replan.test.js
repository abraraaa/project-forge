// @vitest-environment jsdom
// A main-lift swap changes weekly volume with the accessories unchanged. The
// block re-plans only when the new lift breaks a band (2026-09-25; ~1.2% of
// solved config × swap combinations did, e.g. Push Press for Power Clean
// left Upper Back out of band).
import { describe, it, expect, beforeEach } from "vitest";
import { P, PB, F, LS, getLocalProfile } from "../lib/storage.js";
import { solveRotation, bandViolations, FOCUS_VOLUME_PROFILES } from "../lib/rotation-solver.js";
import { saveMainLiftCore, saveFocusCore, resetProgrammeCore } from "../lib/profile-actions.js";
import { applyTrainerRows } from "../lib/trainer-sync.js";
import { validateOp } from "../lib/trainer-change.js";
import { computeWeeklyVolume, VOLUME_TARGETS } from "../lib/volume-audit.js";
import { SESSIONS, applyRotationToSession } from "../lib/programme.js";
import { todayLocalIso } from "../lib/dates.js";

const mulberry = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const setup = (seed) => {
  const { config } = solveRotation({ history: {}, focus: "Forged", mainLifts: {}, rng: mulberry(seed) });
  PB.save({ number: 3, startDate: "2026-09-22", config, history: {} });
  F.save("sam", "Forged");
  return config;
};

describe("main-lift change keeps the week in band", () => {
  beforeEach(() => { localStorage.clear(); P.add("sam"); P.setActive("sam"); });

  it("a swap that breaks a band re-plans the block's accessories", () => {
    const before = setup(0);
    expect(bandViolations(before, { focus: "Forged", mainLifts: { "Power Clean": "Push Press" } })).toContain("Upper Back");
    const { summary, mainLifts } = saveMainLiftCore("sam", "Power Clean", "Push Press");
    expect(mainLifts["Power Clean"]).toBe("Push Press");
    expect(summary?.reason).toBe("main_lift");
    const after = PB.get();
    expect(after.number).toBe(3);                    // same block
    expect(after.startDate).toBe("2026-09-22");
    expect(bandViolations(after.config, { focus: "Forged", mainLifts }).length).toBe(0);
  });

  it("a swap that stays in band leaves the accessories alone", () => {
    const before = setup(4);
    expect(bandViolations(before, { focus: "Forged", mainLifts: { "Barbell Bench Press": "Dumbbell Bench Press" } })).toEqual([]);
    const { summary } = saveMainLiftCore("sam", "Barbell Bench Press", "Dumbbell Bench Press");
    expect(summary).toBeNull();
    expect(PB.get().config).toEqual(before);
  });

  it("back to the default lift is a choice like any other", () => {
    setup(4);
    saveMainLiftCore("sam", "Power Clean", "Push Press");
    const { mainLifts } = saveMainLiftCore("sam", "Power Clean", null);
    expect(mainLifts["Power Clean"]).toBe("Power Clean");
  });
});

// Strong keeps the row and drops the lunge on Day A, so Romanian Deadlift for
// Hex Bar Deadlift on the template accessories leaves Quads at 7.2 against an
// MEV of 8. Every way onto that week has to re-plan it.
describe("Strong, Romanian Deadlift, template accessories: every entry point lands in band", () => {
  const HINGE = "Hex Bar Deadlift";
  const RDL = "Romanian Deadlift";
  const exempt = FOCUS_VOLUME_PROFILES.Strong.floorExempt;

  /** Muscles under MEV (Strong's exempt arms aside) or over MRV. */
  const outOfBand = (config, mainLifts) => {
    const rotated = SESSIONS.map((s) => applyRotationToSession(s, config));
    const v = computeWeeklyVolume(rotated, { focus: "Strong", config, mainLifts });
    return Object.entries(VOLUME_TARGETS).flatMap(([m, t]) => {
      const sets = v[m] || 0;
      return (sets < t.mev && !exempt.has(m)) || sets > t.mrv ? [`${m} ${sets.toFixed(1)}`] : [];
    });
  };

  beforeEach(() => { localStorage.clear(); P.add("sam"); P.setActive("sam"); F.save("sam", "Strong"); });

  it("the premise: the template week is under MEV on Quads", () => {
    expect(outOfBand({}, { [HINGE]: RDL })).toEqual(["Quads 7.2"]);
  });

  it("the user's own change, mid-block on template accessories, re-plans and reports it", () => {
    PB.save({ number: 2, startDate: "2026-10-19", config: {}, history: {} });
    const { summary, mainLifts } = saveMainLiftCore("sam", HINGE, RDL);
    expect(summary?.reason).toBe("main_lift");
    expect(summary?.report.outOfBand).toEqual([]);
    expect(summary?.changes).toBeTruthy();
    const saved = PB.get();
    expect(saved.number).toBe(2);
    expect(Object.keys(saved.config).length).toBeGreaterThan(0);
    expect(outOfBand(saved.config, mainLifts)).toEqual([]);
  });

  it("a fresh profile choosing the lift before any rotation (first run) re-plans", () => {
    expect(LS.get("forge:sam:programmeBlock", null)).toBeNull();
    const { summary, mainLifts } = saveMainLiftCore("sam", HINGE, RDL);
    expect(summary?.reason).toBe("main_lift");
    expect(outOfBand(PB.get().config, mainLifts)).toEqual([]);
  });

  it("a trainer's main-lift change, applied on the home pull, re-plans the same way", () => {
    PB.save({ number: 2, startDate: "2026-10-19", config: {}, history: {} });
    const local = getLocalProfile("sam");
    const v = validateOp({ kind: "mainLift", canonical: HINGE, choice: RDL },
      { meta: local.meta, history: local.history, todayIso: todayLocalIso(), phase: "apply" });
    const c = v.change;
    expect(c).toBeTruthy();
    const set = "hws_" + "a".repeat(26);
    const row = { id: `${set}.0`, set, kind: c.kind, target: c.target, from: c.from, before: c.before, after: c.after,
      basis: c.basis, at: 1_000, appliedAt: null, undone: false, by: "Alex" };
    const res = applyTrainerRows("sam", { rows: [row] });
    expect(res?.wrote).toBe(true);
    expect(P.getMainLifts("sam")[HINGE]).toBe(RDL);
    const saved = PB.get();
    expect(saved.number).toBe(2);
    expect(outOfBand(saved.config, P.getMainLifts("sam"))).toEqual([]);
  });

  it("resetting accessories to defaults with the lift chosen re-plans, same block", () => {
    const { config: rotated } = solveRotation({ history: {}, focus: "Strong", mainLifts: { [HINGE]: RDL }, rng: mulberry(7) });
    PB.save({ number: 4, startDate: "2026-10-05", config: rotated, history: { x: { y: "2026-10-05" } } });
    P.setMainLift("sam", HINGE, RDL);
    const { next } = resetProgrammeCore("sam");
    const saved = PB.get();
    expect(next).toEqual(saved);
    expect(saved.number).toBe(4);
    expect(saved.startDate).toBe("2026-10-05");
    expect(saved.history).toEqual({});
    expect(Object.keys(saved.config).length).toBeGreaterThan(0);
    expect(outOfBand(saved.config, P.getMainLifts("sam"))).toEqual([]);
  });

  it("resetting accessories in band lands on the plain template", () => {
    const { config: rotated } = solveRotation({ history: {}, focus: "Strong", mainLifts: {}, rng: mulberry(7) });
    PB.save({ number: 4, startDate: "2026-10-05", config: rotated, history: {} });
    const { next } = resetProgrammeCore("sam");
    expect(next.config).toEqual({});
    expect(next.number).toBe(4);
  });

  it("a focus change with the lift already chosen solves against it", () => {
    F.save("sam", "Forged");
    P.setMainLift("sam", HINGE, RDL);
    const { next, summary } = saveFocusCore("sam", "Strong");
    expect(summary.report.outOfBand).toEqual([]);
    expect(outOfBand(next.config, P.getMainLifts("sam"))).toEqual([]);
  });
});
