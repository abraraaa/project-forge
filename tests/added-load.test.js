// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// Optional added load on PURE bodyweight lifts (a vest, a plate on the hips).
//
// Its own synced store, `forge:<p>:addedLoads` = { [lift]: { kg, updatedAt } }:
//   - only the user writes it, and "none" is kg 0 — stored, never deleted;
//   - it merges per lift (newer stamp wins, ties to remote) as a pure union;
//   - a no-vest set logs exactly what it always did (weight null);
//   - a vest set's effective load is bodyweight + kg;
//   - the engine never writes it and never treats it as load evidence.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  P, getLocalProfile, logSet, newDraftLog, finaliseDraft, computeEffectiveLoad, migrateV1ToV2, H, TS, backgroundSync,
} from "../lib/storage.js";
import { DeltaSync } from "../lib/sync-delta.js";
import { mergeMeta, mergeMetaFields, mergeProfileData, fieldClosure, mergeAddedLoads } from "../lib/sync-merge.js";
import { addedLoadFor, loggedAddedKg } from "../lib/lift-translations.js";
import { applySessionToEngine } from "../lib/session-engine.js";
import { detectDeloadSignals } from "../lib/progression.js";
import { PROFILE_SUFFIXES, collectStoreSnapshot } from "../lib/store-health.js";

const T1 = "2026-09-20T10:00:00.000Z";
const T2 = "2026-09-21T10:00:00.000Z";

beforeEach(() => localStorage.clear());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// ─── Store ───────────────────────────────────────────────────────────────────
describe("the added-load store", () => {
  it("starts empty and tolerates garbage", () => {
    expect(P.getAddedLoads("p")).toEqual({});
    localStorage.setItem("forge:p:addedLoads", "[1,2]");
    expect(P.getAddedLoads("p")).toEqual({});
    localStorage.setItem("forge:p:addedLoads", "not json");
    expect(P.getAddedLoads("p")).toEqual({});
  });

  it("setting a vest stamps that lift only", () => {
    P.saveAddedLoadsRaw("p", { HX: { kg: 5, updatedAt: T1 } });
    const ret = P.setAddedLoad("p", "Glute Bridge", 10);
    const map = P.getAddedLoads("p");
    expect(Object.keys(map)).toEqual(["HX", "Glute Bridge"]);
    expect(map.HX).toEqual({ kg: 5, updatedAt: T1 });
    expect(map["Glute Bridge"].kg).toBe(10);
    expect(map["Glute Bridge"].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ret).toEqual(map);
  });

  it("0 is stored as a value, never a deleted key", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T1));
    P.setAddedLoad("p", "Glute Bridge", 10);
    const before = P.getAddedLoads("p")["Glute Bridge"].updatedAt;
    vi.setSystemTime(new Date(Date.parse(T1) + 60_000));
    P.setAddedLoad("p", "Glute Bridge", 0);
    const map = P.getAddedLoads("p");
    expect("Glute Bridge" in map).toBe(true);
    expect(map["Glute Bridge"].kg).toBe(0);
    expect(map["Glute Bridge"].updatedAt > before).toBe(true);
  });

  it("re-confirming the same kg mints no newer stamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T1));
    P.setAddedLoad("p", "Glute Bridge", 10);
    const before = P.getAddedLoads("p")["Glute Bridge"].updatedAt;
    vi.setSystemTime(new Date(Date.parse(T1) + 60_000));
    P.setAddedLoad("p", "Glute Bridge", 10);
    expect(P.getAddedLoads("p")["Glute Bridge"].updatedAt).toBe(before);

    // "None" on a lift with no entry is no change: nothing is written.
    localStorage.clear();
    P.setAddedLoad("p", "Sissy Squat", 0);
    expect(localStorage.getItem("forge:p:addedLoads")).toBeNull();
  });

  it("rejects nonsense", () => {
    P.setAddedLoad("p", "X", -5);
    P.setAddedLoad("p", "X", NaN);
    // @ts-expect-error — a string kg must be refused at runtime too
    P.setAddedLoad("p", "X", "10");
    P.setAddedLoad("p", "X", Infinity);
    expect(P.getAddedLoads("p")).toEqual({});
  });

  it("saveAddedLoadsRaw lands a map as-is, ignores non-objects", () => {
    const m = { A: { kg: 5, updatedAt: T1 } };
    P.saveAddedLoadsRaw("p", m);
    expect(P.getAddedLoads("p")).toEqual(m);
    P.saveAddedLoadsRaw("p", null);
    // @ts-expect-error — an array is not a map
    P.saveAddedLoadsRaw("p", []);
    expect(P.getAddedLoads("p")).toEqual(m);
  });

  it("rides the sync payload, suffix registered", () => {
    P.setAddedLoad("p", "Glute Bridge", 10);
    expect(getLocalProfile("p").meta.addedLoads).toEqual(P.getAddedLoads("p"));
    expect(PROFILE_SUFFIXES.has("addedLoads")).toBe(true);
  });

  it("the /diag-sync snapshot carries it to the health check", () => {
    P.setAddedLoad("p", "GB", 10);
    expect(collectStoreSnapshot("p").addedLoads).toEqual(P.getAddedLoads("p"));
  });
});

// ─── Sync hydration ──────────────────────────────────────────────────────────
// A pull lands the merged union locally, so the next session logs the other
// device's vest.
describe("a pull lands added loads locally", () => {
  const okJson = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

  it("full pull: the merged union", async () => {
    P.saveAddedLoadsRaw("p", { GB: { kg: 5, updatedAt: T1 }, HX: { kg: 2.5, updatedAt: T1 } });
    vi.stubGlobal("fetch", (url, opts = {}) => opts.method === "PUT" ? okJson({ ok: true })
      : okJson({ meta: { addedLoads: { GB: { kg: 10, updatedAt: T2 } } }, history: [] }));
    await backgroundSync("p");
    expect(P.getAddedLoads("p")).toEqual({ GB: { kg: 10, updatedAt: T2 }, HX: { kg: 2.5, updatedAt: T1 } });
  });

  it("delta pull", async () => {
    DeltaSync.setCursor("p", "2026-09-19T00:00:00.000Z");
    vi.stubGlobal("fetch", () => okJson({
      delta: true, meta: { addedLoads: { GB: { kg: 10, updatedAt: T2 } } }, history: [], cursor: "2026-09-22T00:00:00.000Z",
    }));
    await backgroundSync("p");
    expect(P.getAddedLoads("p")).toEqual({ GB: { kg: 10, updatedAt: T2 } });
  });
});

// ─── Merge ───────────────────────────────────────────────────────────────────
describe("added loads merge per lift", () => {
  it("per lift, newer wins; different lifts both survive", () => {
    const phone = { addedLoads: { GB: { kg: 10, updatedAt: T2 } } };
    const laptop = { addedLoads: { GB: { kg: 0, updatedAt: T1 }, HX: { kg: 5, updatedAt: T1 } } };
    const want = { GB: { kg: 10, updatedAt: T2 }, HX: { kg: 5, updatedAt: T1 } };
    expect(mergeMeta(phone, laptop).addedLoads).toEqual(want);
    expect(mergeMeta(laptop, phone).addedLoads).toEqual(want);
  });

  it("a newer \"none\" beats an older vest, both orders", () => {
    const vest = { addedLoads: { GB: { kg: 10, updatedAt: T1 } } };
    const none = { addedLoads: { GB: { kg: 0, updatedAt: T2 } } };
    expect(mergeMeta(vest, none).addedLoads.GB.kg).toBe(0);
    expect(mergeMeta(none, vest).addedLoads.GB.kg).toBe(0);
  });

  it("explicit rule, not the unknown passthrough (the server keeps a newer entry against an older echo)", () => {
    // Under the passthrough remote would win wholesale and give 0. This is
    // also the server's call shape: mergeMeta(baseMeta, incoming).
    const out = mergeMeta(
      { addedLoads: { GB: { kg: 10, updatedAt: T2 } } },
      { addedLoads: { GB: { kg: 0, updatedAt: T1 } } },
    );
    expect(out.addedLoads.GB.kg).toBe(10);
  });

  it("ties go to remote", () => {
    const out = mergeMeta(
      { addedLoads: { GB: { kg: 10, updatedAt: T1 } } },
      { addedLoads: { GB: { kg: 5, updatedAt: T1 } } },
    );
    expect(out.addedLoads.GB.kg).toBe(5);
  });

  it("a missing stamp is the epoch: a stamped entry beats it, both orders", () => {
    expect(mergeAddedLoads({ GB: { kg: 10 } }, { GB: { kg: 5, updatedAt: T1 } }).GB.kg).toBe(5);
    expect(mergeAddedLoads({ GB: { kg: 5, updatedAt: T1 } }, { GB: { kg: 10 } }).GB.kg).toBe(5);
  });

  it("idempotent and garbage-tolerant", () => {
    const x = { GB: { kg: 10, updatedAt: T1 } };
    expect(mergeAddedLoads(x, x)).toEqual(x);
    expect(mergeAddedLoads(null, x)).toEqual(x);
    expect(mergeAddedLoads(x, [])).toEqual(x);
    expect(mergeAddedLoads(undefined, undefined)).toEqual({});
  });

  it("a peer without the field never blanks it", () => {
    const x = { GB: { kg: 10, updatedAt: T1 } };
    expect(mergeMeta({ addedLoads: x }, { weights: { a: 1 } }).addedLoads).toEqual(x);
    expect(mergeMeta({ weights: { a: 1 } }, { addedLoads: x }).addedLoads).toEqual(x);
  });

  it("ships alone in a delta", () => {
    expect([...fieldClosure(["addedLoads"])]).toEqual(["addedLoads"]);
    const out = mergeMetaFields(
      { addedLoads: { GB: { kg: 10, updatedAt: T1 } }, weights: { x: 1 } },
      { addedLoads: { HX: { kg: 5, updatedAt: T2 } } },
    );
    expect(Object.keys(out)).toEqual(["addedLoads"]);
    expect(Object.keys(out.addedLoads).sort()).toEqual(["GB", "HX"]);
  });

  it("no phantom change detection", () => {
    const r = mergeProfileData({ meta: { addedLoads: {} }, history: [] }, { meta: {}, history: [] });
    expect(r.remoteHadMore).toBe(false);
    expect(r.localHadMore).toBe(false);
  });

  it("a pure union: no key is ever dropped", () => {
    const e1 = { kg: 10, updatedAt: T1 }, e2 = { kg: 0, updatedAt: T1 };
    const e3 = { kg: 5, updatedAt: T2 }, e4 = { kg: 2.5, updatedAt: T2 };
    const pairs = [
      [{ A: e1, B: e2 }, { B: e3, C: e4 }],
      [{}, { Z: e1 }],
      [{ A: e1 }, {}],
      // every remote entry newer
      [{ A: e1, B: e2 }, { A: e3, B: e4 }],
    ];
    for (const [l, r] of pairs) {
      expect(Object.keys(mergeAddedLoads(l, r)).sort())
        .toEqual([...new Set([...Object.keys(l), ...Object.keys(r)])].sort());
    }
  });
});

// ─── Logging and effective load ──────────────────────────────────────────────
describe("logging an added load", () => {
  const base = {
    blockId: "ass2", blockType: "superset", exerciseName: "Glute Bridge", muscle: "Glutes",
    swapped: false, fromPool: null, loadType: "bodyweight", bodyweight: 80, reps: 12, rpe: 8,
  };

  it("addedLoadFor", () => {
    expect(addedLoadFor({ GB: { kg: 10 } }, "GB")).toBe(10);
    expect(addedLoadFor({ GB: { kg: 0 } }, "GB")).toBeNull();
    expect(addedLoadFor({}, "GB")).toBeNull();
    expect(addedLoadFor(null, "GB")).toBeNull();
    // @ts-expect-error — a string kg is not a load
    expect(addedLoadFor({ GB: { kg: "10" } }, "GB")).toBeNull();
    expect(addedLoadFor({ GB: { kg: -1 } }, "GB")).toBeNull();
    expect(addedLoadFor({ GB: null }, "GB")).toBeNull();
  });

  it("computeEffectiveLoad", () => {
    expect(computeEffectiveLoad("bodyweight", null, 80)).toBe(80);
    expect(computeEffectiveLoad("bodyweight", 10, 80)).toBe(90);
    expect(computeEffectiveLoad("bodyweight", 0, 80)).toBe(80);
    expect(computeEffectiveLoad("bodyweight", 10, null)).toBeNull();
    expect(computeEffectiveLoad("loaded_bodyweight", 10, 80)).toBe(90);
    expect(computeEffectiveLoad("external", 10, 80)).toBe(10);
  });

  it("a no-vest set is byte-identical", () => {
    const none = addedLoadFor({ "Glute Bridge": { kg: 0, updatedAt: T1 } }, "Glute Bridge");
    expect(JSON.stringify(logSet({ blocks: {} }, { ...base, weight: null })))
      .toBe(JSON.stringify(logSet({ blocks: {} }, { ...base, weight: none })));
  });

  it("a vest set: weight 10, effective load bodyweight + 10", () => {
    const d = logSet({ blocks: {} }, { ...base, weight: addedLoadFor({ "Glute Bridge": { kg: 10, updatedAt: T1 } }, "Glute Bridge") });
    const s = d.blocks.ass2.exercises["Glute Bridge"].sets[0];
    expect(s.weight).toBe(10);
    expect(s.effectiveLoad).toBe(90);
    expect(s.volume).toBe(1080);
    expect(s.loadType).toBe("bodyweight");
    expect(s.bodyweightUsed).toBe(80);
    expect(loggedAddedKg(s, "bodyweight")).toBe(10);
  });

  it("an old record with weight null reads identically", () => {
    const v1 = { id: "2026-01-05T10:00:00.000Z", date: "2026-01-05", blocks: [{ id: "a", type: "accessory", exercises: [
      { name: "Glute Bridge", loadType: "bodyweight", sets: [{ weight: null, reps: 12, bodyweightUsed: 80 }] }] }] };
    expect(migrateV1ToV2(v1).blocks[0].exercises[0].sets[0].effectiveLoad).toBe(80);

    // A v2 record keeps its cached effective load, stray weight and all.
    const v2 = { schemaVersion: 2, id: "2026-01-06T10:00:00.000Z", date: "2026-01-06", blocks: [{ id: "a", type: "accessory", exercises: [
      { name: "Glute Bridge", loadType: "bodyweight", sets: [
        { weight: 80, reps: 12, rir: 2, loadType: "bodyweight", bodyweightUsed: 80, effectiveLoad: 80, est1rm: 112, volume: 960 }] }] }] };
    expect(migrateV1ToV2(v2)).toBe(v2);
  });

  it("loggedAddedKg tells a phantom from a vest", () => {
    expect(loggedAddedKg({ weight: 40, bodyweightUsed: 80, effectiveLoad: 80 }, "bodyweight")).toBeNull();
    expect(loggedAddedKg({ weight: 10, bodyweightUsed: 80, effectiveLoad: 90 }, "bodyweight")).toBe(10);
    expect(loggedAddedKg({ weight: 1.25, bodyweightUsed: 79.8, effectiveLoad: 81.05 }, "bodyweight")).toBe(1.25);
    // logSet caches bw + w unrounded; across a power of two the sum is inexact.
    expect(loggedAddedKg({ weight: 1.25, bodyweightUsed: 63.9, effectiveLoad: 63.9 + 1.25 }, "bodyweight")).toBe(1.25);
    expect(loggedAddedKg({ weight: 10, bodyweightUsed: null, effectiveLoad: null }, "bodyweight")).toBeNull();
    expect(loggedAddedKg({ weight: null, bodyweightUsed: 80, effectiveLoad: 80 }, "bodyweight")).toBeNull();
    expect(loggedAddedKg({ weight: 0, bodyweightUsed: 80, effectiveLoad: 80 }, "bodyweight")).toBeNull();
    expect(loggedAddedKg(null, "bodyweight")).toBeNull();
    expect(loggedAddedKg({ weight: 10 }, "loaded_bodyweight")).toBe(10);
    expect(loggedAddedKg({ weight: 0 }, "loaded_bodyweight")).toBeNull();
    expect(loggedAddedKg({ weight: 5 }, "loaded_bw")).toBe(5);
  });
});

// ─── The engine ──────────────────────────────────────────────────────────────
describe("the engine never writes the vest, and never treats it as evidence", () => {
  const vestSet = { weight: 10, reps: 12, rir: 2, rpe: 8, loadType: "bodyweight", bodyweightUsed: 80, effectiveLoad: 90, est1rm: 126, volume: 1080 };
  const vestRecord = () => ({
    v: 2, id: new Date().toISOString(), date: "2026-09-28", readiness: "normal", session: "strength-a",
    blocks: [{ id: "ass2", type: "superset", exercises: [
      { name: "Glute Bridge", muscle: "Glutes", loadType: "bodyweight", prescribed: { sets: 3, reps: 12 }, sets: [vestSet, vestSet, vestSet] }] }],
  });
  const liftState = { currentWeight: 0, sessionsCount: 2, consecutiveAdds: 0, consecutiveHolds: 0 };

  it("the vest stays the user's; no e1RM is set from it", () => {
    // The engine's try/catch would otherwise hide a throw behind an empty summary.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    P.setAddedLoad("p", "Glute Bridge", 10);
    const before = localStorage.getItem("forge:p:addedLoads");
    const rec = vestRecord();
    TS.save("p", { lifts: { "Glute Bridge": { ...liftState } } });
    H.append("p", rec);

    // 80 is a stale working weight on a pure bodyweight lift.
    const out = applySessionToEngine("p", rec, { currentWeights: { "Glute Bridge": 80 } });

    expect(err).not.toHaveBeenCalled();
    expect(TS.get("p").lifts["Glute Bridge"].sessionsCount).toBe(3);
    expect(TS.get("p").lifts["Glute Bridge"].e1RM ?? null).toBeNull();
    expect(localStorage.getItem("forge:p:addedLoads")).toBe(before);
    expect(out.wwUpdates["Glute Bridge"]).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(["justCompletedDeload", "stillInDeload", "wrUpdates", "wwUpdates"]);
  });

  it("a lighter vest never reads as a regression", () => {
    vi.useFakeTimers();
    const days = ["2026-09-20T10:00:00", "2026-09-22T10:00:00", "2026-09-24T10:00:00"];
    const kgs = [10, 7.5, 5];
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(new Date(days[i]));
      const d = newDraftLog({ profileName: "p", session: "strength-a", blockNumber: 1, readiness: "normal", bodyweight: 80 });
      for (let k = 0; k < 3; k++) {
        logSet(d, {
          blockId: "ass2", blockType: "superset", exerciseName: "Glute Bridge", muscle: "Glutes",
          swapped: false, fromPool: null, loadType: "bodyweight", bodyweight: 80,
          weight: kgs[i], reps: 12, rpe: 8, prescribed: { sets: 3, reps: 12 },
        });
      }
      const rec = finaliseDraft(d);
      H.append("p", rec);
      applySessionToEngine("p", rec, { currentWeights: {} });
    }
    // Without the gate the est1rm would drop 126 → 122.5 → 119 and fire.
    expect(detectDeloadSignals(TS.get("p"), H.get("p")).some((s) => s.type === "regression")).toBe(false);
    const lift = TS.get("p").lifts["Glute Bridge"];
    expect(lift.e1RM ?? null).toBeNull();
    expect(lift.history.every((h) => h.est1rm === null)).toBe(true);
  });

  describe("deload and recovery never touch W or anchors for a vest", () => {
    const run = (state) => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const rec = vestRecord();
      TS.save("p", state);
      H.append("p", rec);
      const out = applySessionToEngine("p", rec, { currentWeights: { "Glute Bridge": 80 } });
      expect(out.wwUpdates["Glute Bridge"]).toBeUndefined();
      expect(TS.get("p").muscleAnchors?.Glutes).toBeUndefined();
      expect(err).not.toHaveBeenCalled();
      return out;
    };

    it("during a deload", () => {
      // Same day as the record: under the 4-day auto-close, so still in it.
      const out = run({
        mesocycle: { activeDeload: { startedAt: "2026-09-28T09:00:00.000Z" } },
        lifts: { "Glute Bridge": { ...liftState } },
      });
      expect(out.stillInDeload).toBe(true);
    });

    it("in recovery", () => {
      run({ lifts: { "Glute Bridge": { ...liftState, inRecoveryUntil: 3 } } });
    });
  });
});

// ─── Wiring ──────────────────────────────────────────────────────────────────
// SessionHost is not render-testable (router), so its wiring is pinned by
// shape. The push is enforced by tests/forge-app-mutation-coverage.test.js.
describe("SessionHost wiring", () => {
  it("logs the added load for pure bodyweight, reads it from its own store, and hands it to the screen", () => {
    const src = readFileSync(resolve(__dirname, "../components/SessionHost.jsx"), "utf8");
    const slice = src.slice(src.indexOf("const pushSetToDraft"), src.indexOf("logSet(draftLogRef.current"));
    // The pure-bodyweight arm ends at the added load: no fallback to W.
    expect(slice).toMatch(/const resolvedWeight = loadType === "bodyweight" \? addedLoadFor\(addedLoads, ex\.name\)\s*\n\s*:/);
    expect(src).toContain("P.getAddedLoads(profile)");

    const at = (s, from = 0) => { const i = src.indexOf(s, from); expect(i, s).toBeGreaterThan(-1); return i; };
    // The setter updates the screen's state, not just the store.
    const setterAt = at("const setAddedLoad = useCallback");
    expect(src.slice(setterAt, at("}, [profile]);", setterAt))).toContain("setAddedLoadsState(P.setAddedLoad(profile, name, kg))");
    // pushSetToDraft re-reads the map when it changes.
    const depsAt = at("}, [", at("const pushSetToDraft"));
    expect(src.slice(depsAt, at("]);", depsAt))).toMatch(/\baddedLoads\b/);
    // Both are handed to the screen.
    const propsAt = at("const sProps = {");
    expect(src.slice(propsAt, at("\n  };", propsAt))).toMatch(/\baddedLoads, setAddedLoad,/);
  });
});
