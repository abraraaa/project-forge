// @vitest-environment jsdom
// tests/local-device-keys.test.js
// ─────────────────────────────────────────────────────────────────────────────
// programmeBlock and weekConfig are per profile (forge:<profile>:…). The
// device-wide keys they used to live at are copied into each profile on first
// access and never removed.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { P, PB, W, getLocalProfile, backgroundSync } from "../lib/storage.js";
import { PROFILE_SUFFIXES, collectStoreSnapshot } from "../lib/store-health.js";
import { ensureScheduleHistory } from "../lib/sync-merge.js";

const week = (...types) => types.map((type) => ({ type }));
const DEVICE_WEEK = [{
  editedAt: "2026-01-05T09:00:00.000Z",
  effectiveFrom: "2026-01-05",
  week: week("strength", "cardio", "strength", "cardio", "strength", "zone2", "rest"),
}];
// What W reads back from DEVICE_WEEK (weeks normalised to {s, label, type}).
const DEVICE_HISTORY = ensureScheduleHistory(DEVICE_WEEK);
const ALT_WEEK = week("cardio", "strength", "cardio", "strength", "cardio", "strength", "rest");
const DEVICE_PB = { number: 4, startDate: "2026-01-05", config: { a: "x" }, history: {}, updatedAt: "2026-01-05T09:00:00.000Z" };

const raw = (k) => window.localStorage.getItem(k);
const DEVICE_PB_RAW = JSON.stringify(DEVICE_PB);
const DEVICE_WEEK_RAW = JSON.stringify(DEVICE_WEEK);

function expectDeviceKeysUntouched() {
  expect(raw("forge:programmeBlock")).toBe(DEVICE_PB_RAW);
  expect(raw("forge:weekConfig")).toBe(DEVICE_WEEK_RAW);
}

beforeEach(() => {
  window.localStorage.setItem("forge:programmeBlock", DEVICE_PB_RAW);
  window.localStorage.setItem("forge:weekConfig", DEVICE_WEEK_RAW);
  P.add("A");
  P.add("B");
  P.setActive("A");
});

afterEach(() => {
  expectDeviceKeysUntouched();
  vi.unstubAllGlobals();
});

describe("per-profile programmeBlock / weekConfig", () => {
  it("first read copies the device-wide values into the profile's own keys", () => {
    expect(PB.get("A").number).toBe(4);
    expect(JSON.parse(raw("forge:A:programmeBlock"))).toEqual(DEVICE_PB);
    expect(JSON.parse(raw("forge:A:weekConfig"))).toEqual(DEVICE_WEEK);
    expect(raw("forge:A:deviceKeysAdopted_v1")).not.toBe(null);
    expect(raw("forge:B:programmeBlock")).toBe(null); // B not touched until read
  });

  it("two profiles on one device keep separate programme state", () => {
    PB.save({ ...PB.get("A"), number: 5 }, { profile: "A" });
    expect(PB.get("B").number).toBe(4);
    expect(PB.get("A").number).toBe(5);

    W.save(ALT_WEEK, { profile: "B", effectiveFrom: "2026-02-02" });
    expect(W.getHistory("A")).toEqual(DEVICE_HISTORY);
    expect(W.getHistory("B")).toHaveLength(2);
    expect(W.getEffectiveOn("2026-02-03", "A")[0].type).toBe("strength");
    expect(W.getEffectiveOn("2026-02-03", "B")[0].type).toBe("cardio");
  });

  it("the active profile is the default", () => {
    PB.save({ ...PB.get(), number: 6 });
    expect(PB.get("A").number).toBe(6);
    P.setActive("B");
    expect(PB.get().number).toBe(4);
  });

  it("W.reset(A) clears A's schedule and does not re-copy the device-wide one", () => {
    expect(W.getHistory("A")).toEqual(DEVICE_HISTORY);
    W.reset("A");
    expect(W.get("A")).toBe(null);
    expect(W.getHistory("A")).toBe(null);
    expect(raw("forge:A:weekConfig")).toBe(null);
    expect(W.getHistory("B")).toEqual(DEVICE_HISTORY);
  });

  it("W.reset with no profile removes nothing", () => {
    window.localStorage.removeItem("forge:active");
    expect(W.reset()).toBe(null);
  });

  it("getLocalProfile and the snapshot read the profile's own keys", () => {
    PB.save({ ...PB.get("A"), number: 5 }, { profile: "A" });
    expect(getLocalProfile("A").meta.programmeBlock.number).toBe(5);
    expect(getLocalProfile("B").meta.programmeBlock.number).toBe(4);
    expect(collectStoreSnapshot("A").programmeBlock.number).toBe(5);
    expect(collectStoreSnapshot("B").programmeBlock.number).toBe(4);
  });

  it("a pull lands in the pulled profile's keys only", async () => {
    PB.get("B");
    const remotePb = { ...DEVICE_PB, number: 9, updatedAt: "2026-03-01T00:00:00.000Z" };
    const remoteWeek = [...DEVICE_WEEK, { editedAt: "2026-03-01T00:00:00.000Z", effectiveFrom: "2026-03-02", week: ALT_WEEK }];
    vi.stubGlobal("fetch", async (url, opts = {}) => ({
      ok: true, status: 200,
      json: async () => (opts.method ? {} : { meta: { programmeBlock: remotePb, userWeek: remoteWeek }, history: [] }),
    }));
    await backgroundSync("A");
    expect(PB.get("A").number).toBe(9);
    expect(W.getHistory("A")).toHaveLength(2);
    expect(PB.get("B").number).toBe(4);
    expect(W.getHistory("B")).toEqual(DEVICE_HISTORY);
  });

  it("the profile wipe removes A's keys and leaves the device-wide keys and B alone", () => {
    PB.get("A");
    PB.get("B");
    const bBefore = Object.fromEntries(
      ["programmeBlock", "weekConfig", "deviceKeysAdopted_v1"].map((s) => [s, raw(`forge:B:${s}`)]));
    // The loop ProfileScreen.jsx runs on a user-initiated profile wipe.
    PROFILE_SUFFIXES.forEach((s) => window.localStorage.removeItem(`forge:A:${s}`));
    for (const s of ["programmeBlock", "weekConfig", "deviceKeysAdopted_v1"]) {
      expect(raw(`forge:A:${s}`)).toBe(null);
      expect(raw(`forge:B:${s}`)).toBe(bBefore[s]);
      expect(raw(`forge:B:${s}`)).not.toBe(null);
    }
  });
});

describe("single-profile device: same values, same sync payload", () => {
  it("getLocalProfile carries the device-wide values unchanged", () => {
    const meta = getLocalProfile("A").meta;
    expect(meta.programmeBlock).toEqual(DEVICE_PB);
    expect(meta.userWeek).toEqual(DEVICE_HISTORY);
    // Repeat reads are stable.
    expect(getLocalProfile("A")).toEqual(getLocalProfile("A"));
  });

  it("with no device-wide values, the defaults are unchanged", () => {
    window.localStorage.removeItem("forge:programmeBlock");
    window.localStorage.removeItem("forge:weekConfig");
    const meta = getLocalProfile("A").meta;
    expect(meta.userWeek).toBe(null);
    expect(meta.programmeBlock).toMatchObject({ number: 1, config: {}, history: {} });
    expect(W.get("A")).toBe(null);
    // Restore for the afterEach invariant.
    window.localStorage.setItem("forge:programmeBlock", DEVICE_PB_RAW);
    window.localStorage.setItem("forge:weekConfig", DEVICE_WEEK_RAW);
  });
});
