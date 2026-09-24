// @vitest-environment jsdom
// Main-lift choices sync across devices, stamped per lift. The failure modes
// this pins: a revert-to-default undone by the other device's older copy,
// one device's edit erasing another's edit to a different lift, and a
// server without the field blanking a device's choices.
import { describe, it, expect, beforeEach } from "vitest";
import { mergeMeta, mergeMetaFields, fieldClosure } from "../lib/sync-merge.js";
import { P, getLocalProfile } from "../lib/storage.js";

const T1 = "2026-09-20T10:00:00.000Z";
const T2 = "2026-09-21T10:00:00.000Z";
const SQ = "Barbell Back Squat", BP = "Barbell Bench Press";

describe("merge", () => {
  it("two devices editing different lifts both keep their edit", () => {
    const phone = { mainLifts: { [SQ]: "Barbell Front Squat" }, mainLiftStamps: { [SQ]: T2 } };
    const laptop = { mainLifts: { [BP]: "Dumbbell Bench Press" }, mainLiftStamps: { [BP]: T1 } };
    const m = mergeMeta(phone, laptop);
    expect(m.mainLifts).toEqual({ [SQ]: "Barbell Front Squat", [BP]: "Dumbbell Bench Press" });
    expect(m.mainLiftStamps).toEqual({ [SQ]: T2, [BP]: T1 });
  });

  it("a newer revert-to-default beats an older choice, from either side", () => {
    const older = { mainLifts: { [SQ]: "Barbell Front Squat" }, mainLiftStamps: { [SQ]: T1 } };
    const newerDefault = { mainLifts: { [SQ]: SQ }, mainLiftStamps: { [SQ]: T2 } };
    expect(mergeMeta(newerDefault, older).mainLifts[SQ]).toBe(SQ);
    expect(mergeMeta(older, newerDefault).mainLifts[SQ]).toBe(SQ);
  });

  it("a stamped choice beats an unstamped legacy one", () => {
    const legacy = { mainLifts: { [SQ]: "Barbell Front Squat" } };
    const stamped = { mainLifts: { [SQ]: "Barbell Box Squat" }, mainLiftStamps: { [SQ]: T1 } };
    expect(mergeMeta(stamped, legacy).mainLifts[SQ]).toBe("Barbell Box Squat");
    expect(mergeMeta(legacy, stamped).mainLifts[SQ]).toBe("Barbell Box Squat");
  });

  it("delta pushes carry choices and stamps together", () => {
    expect([...fieldClosure(["mainLifts"])].sort()).toEqual(["mainLiftStamps", "mainLifts"]);
    const out = mergeMetaFields(
      { mainLifts: { [SQ]: "Barbell Front Squat" }, mainLiftStamps: { [SQ]: T1 }, weights: { x: 1 } },
      { mainLifts: { [BP]: "Dumbbell Bench Press" }, mainLiftStamps: { [BP]: T2 } },
    );
    expect(Object.keys(out).sort()).toEqual(["mainLiftStamps", "mainLifts"]);
    expect(out.mainLifts).toEqual({ [SQ]: "Barbell Front Squat", [BP]: "Dumbbell Bench Press" });
  });
});

describe("store", () => {
  beforeEach(() => localStorage.clear());

  it("setMainLift stamps the one lift and stores default explicitly", () => {
    P.setMainLift("sam", SQ, "Barbell Front Squat");
    P.setMainLift("sam", SQ, null);
    expect(P.getMainLifts("sam")).toEqual({ [SQ]: SQ });
    expect(Object.keys(P.getMainLiftStamps("sam"))).toEqual([SQ]);
  });

  it("the sync payload carries choices and stamps", () => {
    P.setMainLift("sam", BP, "Dumbbell Bench Press");
    const { meta } = getLocalProfile("sam");
    expect(meta.mainLifts).toEqual({ [BP]: "Dumbbell Bench Press" });
    expect(meta.mainLiftStamps[BP]).toMatch(/^\d{4}-/);
  });
});

describe("review fixes", () => {
  beforeEach(() => localStorage.clear());

  it("re-tapping the selected lift does not mint a newer stamp", () => {
    P.setMainLift("sam", SQ, "Front Squat");
    const before = P.getMainLiftStamps("sam")[SQ];
    P.setMainLift("sam", SQ, "Front Squat");
    expect(P.getMainLiftStamps("sam")[SQ]).toBe(before);
  });

  it("an app that predates the field can't turn 'never synced' into an empty map", () => {
    const m = mergeMeta({ weights: { a: 1 } }, { weights: { a: 2 } });
    expect("mainLifts" in m).toBe(false);
    expect("mainLiftStamps" in m).toBe(false);
    expect(mergeMeta({ mainLifts: {} }, {}).mainLifts).toEqual({});
  });

  it("delta pushes and delta pulls keep value and stamp maps together", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const storage = readFileSync(resolve(__dirname, "../lib/storage.js"), "utf8");
    expect(storage).toContain("for (const f of fieldClosure(Object.keys(dirty)))");
    const db = readFileSync(resolve(__dirname, "../lib/db.js"), "utf8");
    expect(db).toContain("[...fieldClosure(Object.keys(meta))].filter((f) => !(f in meta))");
  });
});
