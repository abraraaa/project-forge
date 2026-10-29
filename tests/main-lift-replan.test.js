// @vitest-environment jsdom
// A main-lift swap changes weekly volume with the accessories unchanged. The
// block re-plans only when the new lift breaks a band (2026-09-25; ~1.2% of
// solved config × swap combinations did, e.g. Push Press for Power Clean
// left Upper Back out of band).
import { describe, it, expect, beforeEach } from "vitest";
import { P, PB, F, LS, getLocalProfile } from "../lib/storage.js";
import { solveRotation, bandViolations, FOCUS_VOLUME_PROFILES } from "../lib/rotation-solver.js";
import { saveMainLiftCore, saveFocusCore, resetProgrammeCore, replanSeed, replanBlock, resetConfigFor } from "../lib/profile-actions.js";
import { LIBRARY_REVISED } from "../lib/library-revised.js";
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

  it("resetting accessories to defaults with the lift chosen re-plans, same block, and reports it", () => {
    const { config: rotated } = solveRotation({ history: {}, focus: "Strong", mainLifts: { [HINGE]: RDL }, rng: mulberry(7) });
    PB.save({ number: 4, startDate: "2026-10-05", config: rotated, history: { x: { y: "2026-10-05" } } });
    P.setMainLift("sam", HINGE, RDL);
    const { next, summary } = resetProgrammeCore("sam");
    const saved = PB.get();
    expect(next).toEqual(saved);
    expect(saved.number).toBe(4);
    expect(saved.startDate).toBe("2026-10-05");
    expect(saved.history).toEqual({});
    expect(Object.keys(saved.config).length).toBeGreaterThan(0);
    expect(outOfBand(saved.config, P.getMainLifts("sam"))).toEqual([]);
    expect(summary?.reason).toBe("reset");
    expect(summary?.blockNumber).toBe(4);
    expect(summary?.report.outOfBand).toEqual([]);
    expect(summary?.changes.length).toBeGreaterThan(0);
  });

  it("resetting accessories in band lands on the plain template, with nothing to report", () => {
    const { config: rotated } = solveRotation({ history: {}, focus: "Strong", mainLifts: {}, rng: mulberry(7) });
    PB.save({ number: 4, startDate: "2026-10-05", config: rotated, history: {} });
    const { next, summary } = resetProgrammeCore("sam");
    expect(next.config).toEqual({});
    expect(next.number).toBe(4);
    expect(summary).toBeNull();
  });

  it("a reset that re-plans lands on the template's seeded re-plan, the same week every time", () => {
    const { config: rotated } = solveRotation({ history: {}, focus: "Strong", mainLifts: { [HINGE]: RDL }, rng: mulberry(7) });
    PB.save({ number: 4, startDate: "2026-10-05", config: rotated, history: {} });
    P.setMainLift("sam", HINGE, RDL);
    const first = resetProgrammeCore("sam");
    expect(first.next.config).toEqual(resetConfigFor({ number: 4, focus: "Strong", mainLifts: P.getMainLifts("sam") }));
    const again = resetProgrammeCore("sam");
    expect(again.next.config).toEqual(first.next.config);
    expect(again.summary.changes).toEqual(first.summary.changes);
  });

  it("a focus change with the lift already chosen solves against it", () => {
    F.save("sam", "Forged");
    P.setMainLift("sam", HINGE, RDL);
    const { next, summary } = saveFocusCore("sam", "Strong");
    expect(summary.report.outOfBand).toEqual([]);
    expect(outOfBand(next.config, P.getMainLifts("sam"))).toEqual([]);
  });
});

// Two devices making one change solve one week: a re-plan is seeded (the
// block, the main lifts, the focus and the library revision), so the merge
// never has two in-band weeks to choose from.
describe("a re-plan is seeded: one change, one week", () => {
  const HINGE = "Hex Bar Deadlift";
  const RDL = "Romanian Deadlift";
  /** A device holding the synced state: Strong, template accessories, block 2. */
  const device = () => {
    localStorage.clear(); P.add("sam"); P.setActive("sam"); F.save("sam", "Strong");
    PB.save({ number: 2, startDate: "2026-10-19", config: {}, history: {} });
  };
  const trainerRow = (letter) => {
    const local = getLocalProfile("sam");
    const { change: c } = validateOp({ kind: "mainLift", canonical: HINGE, choice: RDL },
      { meta: local.meta, history: local.history, todayIso: todayLocalIso(), phase: "apply" });
    const set = "hws_" + letter.repeat(26);
    return { id: `${set}.0`, set, kind: c.kind, target: c.target, from: c.from, before: c.before, after: c.after,
      basis: c.basis, at: 1_000, appliedAt: null, undone: false, by: "Alex" };
  };
  /** The week a device lands on after applying one trainer change. */
  const applied = (letter) => {
    device();
    expect(applyTrainerRows("sam", { rows: [trainerRow(letter)] })?.wrote).toBe(true);
    return PB.get().config;
  };

  it("the key: the block number, the main lifts in any order, the focus and the library revision", () => {
    const lifts = { [HINGE]: RDL, "Barbell Back Squat": "Front Squat" };
    const key = replanSeed({ number: 2, mainLifts: lifts, focus: "Strong" });
    expect(replanSeed({ number: 2, mainLifts: { "Barbell Back Squat": "Front Squat", [HINGE]: RDL }, focus: "Strong" })).toBe(key);
    // A lift set back to its default is stored as itself and changes nothing.
    expect(replanSeed({ number: 2, mainLifts: { ...lifts, "Barbell Bench Press": "Barbell Bench Press" }, focus: "Strong" })).toBe(key);
    expect(key).toContain(LIBRARY_REVISED);
    expect(replanSeed({ number: 3, mainLifts: lifts, focus: "Strong" })).not.toBe(key);
    expect(replanSeed({ number: 2, mainLifts: { [HINGE]: RDL }, focus: "Strong" })).not.toBe(key);
    expect(replanSeed({ number: 2, mainLifts: lifts, focus: "Forged" })).not.toBe(key);
  });

  it("the same key gives the same picks on two calls", () => {
    const block = { number: 2, focus: "Strong", mainLifts: { [HINGE]: RDL } };
    const a = replanBlock(block);
    expect(Object.keys(a.config).length).toBeGreaterThan(0);
    expect(replanBlock(block).config).toEqual(a.config);
  });

  it("a reset's week is solved once per key, however often home asks", () => {
    const block = { number: 2, focus: "Strong", mainLifts: { [HINGE]: RDL } };
    const week = resetConfigFor(block);
    expect(Object.keys(week).length).toBeGreaterThan(0);
    expect(resetConfigFor({ ...block, mainLifts: { [HINGE]: RDL, "Barbell Back Squat": "Barbell Back Squat" } })).toBe(week);
    expect(resetConfigFor({ ...block, mainLifts: {} })).toEqual({});
    expect(resetConfigFor({ ...block, number: 3 })).toEqual(replanBlock({ ...block, number: 3 }).config);
    expect(resetConfigFor(block)).toEqual(week);
  });

  it("two devices making the user's own change land the same week", () => {
    device();
    expect(saveMainLiftCore("sam", HINGE, RDL).summary?.reason).toBe("main_lift");
    const first = PB.get().config;
    device();
    saveMainLiftCore("sam", HINGE, RDL);
    expect(PB.get().config).toEqual(first);
  });

  it("a trainer's change lands the week a reset lands, on every device and whatever its id", () => {
    const first = applied("a");
    expect(Object.keys(first).length).toBeGreaterThan(0);
    expect(applied("a")).toEqual(first);
    expect(applied("b")).toEqual(first);
    expect(first).toEqual(resetConfigFor({ number: 2, focus: "Strong", mainLifts: P.getMainLifts("sam") }));
  });
});
