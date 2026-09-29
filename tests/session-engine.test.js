// @vitest-environment jsdom
// tests/session-engine.test.js
// ─────────────────────────────────────────────────────────────────────────────
// #16 locks: ONE session-finalise engine, shared by the live and retro paths.
// Behavioural: the engine applies a record to TS (lift state advances,
// volume aggregates recompute) and honours the older-backfill guard.
// Class lock: neither component may ever grow a second engine copy.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { H, TS } from "../lib/storage.js";
import { applySessionToEngine } from "../lib/session-engine.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const record = (id, date, weight) => ({
  id, date, dow: 1, type: "strength", session: "strength-a", readiness: "normal",
  blocks: [{ id: "a1", type: "main", exercises: [{
    name: "Barbell Back Squat", muscle: "Quadriceps",
    sets: [{ weight, reps: 5, rir: 2, volume: weight * 5, effectiveLoad: weight, est1rm: weight * 1.16 }],
    totalVolume: weight * 10, topSet: { weight, reps: 5 },
  }]}],
  duration: 3000,
});

describe("applySessionToEngine", () => {
  beforeEach(() => localStorage.clear());

  it("applies a live record: lift state advances, volume recomputes, prescription lands in wwUpdates", () => {
    const rec = record(new Date().toISOString(), "2026-07-24", 100);
    H.append("p", rec);
    const out = applySessionToEngine("p", rec);
    const lift = TS.get("p").lifts?.["Barbell Back Squat"];
    expect(lift).toBeTruthy();
    expect(lift.currentWeight).toBeGreaterThan(0);
    expect(typeof out.wwUpdates["Barbell Back Squat"]).toBe("number");
    expect(out.justCompletedDeload).toBe(false);
    expect(TS.get("p").volume).toBeTruthy();
  });

  it("older-backfill guard: a retro record older than the newest evidence never regresses lift state", () => {
    const newer = record("2026-07-20T10:00:00.000Z", "2026-07-20", 110);
    H.append("p2", newer);
    applySessionToEngine("p2", newer);
    const before = TS.get("p2").lifts["Barbell Back Squat"].currentWeight;

    const older = record("2026-07-01T10:00:00.000Z", "2026-07-01", 80);
    H.append("p2", older);
    applySessionToEngine("p2", older);
    expect(TS.get("p2").lifts["Barbell Back Squat"].currentWeight).toBe(before); // untouched
  });

  it("is defensive: null inputs return the empty summary without touching stores", () => {
    expect(applySessionToEngine(null, null)).toEqual({ wwUpdates: {}, wrUpdates: {}, justCompletedDeload: false, stillInDeload: false });
  });
});

describe("#16 class lock — the engine lives ONCE", () => {
  it("neither component contains the per-exercise engine loop any more", () => {
    for (const rel of ["components/SessionHost.jsx", "components/ForgeApp.jsx"]) {
      const src = readFileSync(resolve(root, rel), "utf8");
      expect(src, `${rel} re-grew an engine copy`).not.toContain("computeNextPrescription(");
      expect(src, rel).not.toContain("updateLiftStateFromSession(");
      expect(src, rel).not.toContain("reconcileLiftStateWithSession(");
      expect(src, rel).toContain("applySessionToEngine(");
    }
  });
});

// A stale total (bodyweight) stored as a pull-up's added load heals on the
// next unloaded session: the engine writes 0 back (2026-09-25).
describe("bodyweight lifts heal a stale working weight", () => {
  beforeEach(() => localStorage.clear());
  it("an unloaded pull-up session writes 0 added, and lift state follows", () => {
    const BW = 79.8;
    const set = { weight: 0, reps: 8, rir: 2, loadType: "loaded_bodyweight", bodyweightUsed: BW, effectiveLoad: BW };
    const rec = {
      v: 2, id: new Date().toISOString(), date: "2026-09-25", readiness: "normal", session: "strength_b",
      blocks: [{ id: "bss1", type: "superset", exercises: [{
        name: "Pull-Up", muscle: "Lats", loadType: "loaded_bodyweight", sets: [set, set, set],
        prescribed: { sets: 3, reps: 8, weight: BW }, summary: { topSet: set },
      }] }],
    };
    TS.save("p", { lifts: { "Pull-Up": { currentWeight: BW, sessionsCount: 5, consecutiveAdds: 0, consecutiveHolds: 0 } } });
    H.append("p", rec);
    const out = applySessionToEngine("p", rec, { currentWeights: { "Pull-Up": BW } });
    expect(out.wwUpdates["Pull-Up"]).toBe(0);
    expect(TS.get("p").lifts["Pull-Up"].currentWeight).toBe(0);
  });
});

// The bodyweight rep climb reaches the session screen through wrUpdates, up to
// base + 3, then holds (2026-09-29).
describe("bodyweight rep climb reaches the session", () => {
  beforeEach(() => localStorage.clear());
  let n = 0;
  // Live-shaped: no prescribed; every set logs the target the session showed.
  const bwRecord = (name, reps, { rir = 2, loadType = "bodyweight", weight = null } = {}) => {
    n += 1;
    const set = { weight, reps, rir, loadType };
    const at = new Date(Date.UTC(2026, 8, n, 10)).toISOString();
    return {
      v: 2, id: at, date: at.slice(0, 10),
      readiness: "normal", session: "strength-a",
      blocks: [{ id: "ass2", type: "superset", exercises: [{ name, muscle: "Glutes", loadType, sets: [set, set, set] }] }],
    };
  };
  const seed = (name) => TS.save("p", { lifts: { [name]: { currentWeight: null, sessionsCount: 3, consecutiveAdds: 0, consecutiveHolds: 0, history: [] } } });
  const apply = (rec) => { H.append("p", rec); return applySessionToEngine("p", rec); };

  it("a full, easy pure-bodyweight session writes the next target", () => {
    seed("Glute Bridge");
    const out = apply(bwRecord("Glute Bridge", 12));
    expect(out.wrUpdates["Glute Bridge"]).toBe(13);
    expect(out.wwUpdates["Glute Bridge"]).toBeUndefined();
  });

  it("climbs session by session to base + 3, then holds without a stall", () => {
    seed("Glute Bridge");
    let target = 12;
    const shown = [];
    for (let i = 0; i < 6; i++) {
      const out = apply(bwRecord("Glute Bridge", target));
      target = out.wrUpdates["Glute Bridge"] ?? target;
      shown.push(target);
    }
    expect(shown).toEqual([13, 14, 15, 15, 15, 15]);
    const lift = TS.get("p").lifts["Glute Bridge"];
    expect(lift.stallSignal).toBeNull();
    expect(lift.currentRepRange).toMatchObject({ reps: 15, baseReps: 12, bwClimb: true });
  });

  it("keeps the per-leg shape", () => {
    seed("Reverse Lunge");
    expect(apply(bwRecord("Reverse Lunge", "15/leg")).wrUpdates["Reverse Lunge"]).toBe("16/leg");
  });

  it("a retro record takes the shape from its prescribed target", () => {
    seed("Reverse Lunge");
    const rec = bwRecord("Reverse Lunge", 15);
    rec.blocks[0].exercises[0].prescribed = { sets: 3, reps: "15/leg", weight: null, rir: null };
    expect(apply(rec).wrUpdates["Reverse Lunge"]).toBe("16/leg");
  });

  it("a timed hold writes nothing", () => {
    seed("L-Sit Hold");
    const out = apply(bwRecord("L-Sit Hold", "20s", { rir: 3 }));
    expect(out.wrUpdates).toEqual({});
    expect(TS.get("p").lifts["L-Sit Hold"].currentRepRange.reps).toBe(20);
    // A met hold is not a stall.
    expect(TS.get("p").lifts["L-Sit Hold"].consecutiveHolds).toBe(0);
  });

  it("an unloaded pull-up climbs reps and keeps 0 added", () => {
    TS.save("p", { lifts: { "Pull-Up": { currentWeight: 0, sessionsCount: 5, consecutiveAdds: 0, consecutiveHolds: 0, history: [] } } });
    const out = apply(bwRecord("Pull-Up", 8, { loadType: "loaded_bodyweight", weight: 0 }));
    expect(out.wrUpdates["Pull-Up"]).toBe(9);
    expect(out.wwUpdates["Pull-Up"]).toBe(0);
  });

  it("an unloaded pull-up at the ceiling holds and adds no load", () => {
    TS.save("p", { lifts: { "Pull-Up": { currentWeight: 0, sessionsCount: 5, consecutiveAdds: 0, consecutiveHolds: 0, history: [],
      currentRepRange: { reps: 11, sets: 3, baseReps: 8, bwClimb: true } } } });
    const out = apply(bwRecord("Pull-Up", 11, { loadType: "loaded_bodyweight", weight: 0, rir: 3 }));
    expect(out.wrUpdates["Pull-Up"]).toBeUndefined();
    expect(out.wwUpdates["Pull-Up"]).toBe(0);
  });

  it("a belted session does not reset the unloaded climb's base", () => {
    TS.save("p", { lifts: { "Pull-Up": { currentWeight: 0, sessionsCount: 5, consecutiveAdds: 0, consecutiveHolds: 0, history: [] } } });
    let target = 8;
    const shown = [];
    // Unloaded to the ceiling, then belt and no belt alternating.
    const belts = [0, 0, 0, 0, 5, 0, 0, 5, 0, 5, 0, 0];
    for (const weight of belts) {
      const out = apply(bwRecord("Pull-Up", target, { loadType: "loaded_bodyweight", weight, rir: 3 }));
      target = out.wrUpdates["Pull-Up"] ?? target;
      shown.push(target);
    }
    expect(shown.slice(0, 4)).toEqual([9, 10, 11, 11]);
    expect(Math.max(...shown)).toBe(11);
  });

  it("belted stalls and unloaded sessions alternating never climb past base + 3", () => {
    TS.save("p", { lifts: { "Pull-Up": { currentWeight: 0, sessionsCount: 5, consecutiveAdds: 0, consecutiveHolds: 0, history: [] } } });
    let target = 8;
    const shown = [];
    // Hard belted sessions stall and climb the loaded target; easy unloaded
    // ones then climb from wherever that left it.
    const round = [...Array(7).fill([5, 1]), ...Array(4).fill([0, 3])];
    for (const [weight, rir] of [...round, ...round, ...round]) {
      const out = apply(bwRecord("Pull-Up", target, { loadType: "loaded_bodyweight", weight, rir }));
      target = out.wrUpdates["Pull-Up"] ?? target;
      shown.push(target);
    }
    expect(Math.max(...shown)).toBe(11);
    expect(TS.get("p").lifts["Pull-Up"].currentRepRange.baseReps).toBe(8);
  });

  it("a belted session after an unloaded climb banks the reps back to base", () => {
    TS.save("p", { lifts: { "Pull-Up": { currentWeight: 0, sessionsCount: 5, consecutiveAdds: 0, consecutiveHolds: 0, history: [],
      currentRepRange: { reps: 11, sets: 3, baseReps: 8, bwClimb: true } } } });
    const out = apply(bwRecord("Pull-Up", 11, { loadType: "loaded_bodyweight", weight: 5, rir: 3 }));
    expect(out.wrUpdates["Pull-Up"]).toBe(8);
    expect(out.wwUpdates["Pull-Up"]).toBeGreaterThan(5);
  });

  it("a timed hold logged as integer seconds still never climbs", () => {
    seed("L-Sit Hold");
    apply(bwRecord("L-Sit Hold", "20s", { rir: 3 }));
    // A drum override logs whole seconds, not "25s".
    const out = apply(bwRecord("L-Sit Hold", 25, { rir: 3 }));
    expect(out.wrUpdates).toEqual({});
    expect(TS.get("p").lifts["L-Sit Hold"].currentRepRange).toMatchObject({ reps: 25, timed: true });
  });

  it("a timed hold drummed to whole seconds before any timed record still never climbs", () => {
    TS.save("p", { lifts: { "L-Sit Hold": { currentWeight: null, sessionsCount: 5, consecutiveAdds: 0, consecutiveHolds: 0, history: [],
      currentRepRange: { reps: 25, sets: 3, baseReps: 25 } } } });
    const out = apply(bwRecord("L-Sit Hold", 25, { rir: 3 }));
    expect(out.wrUpdates).toEqual({});
    expect(TS.get("p").lifts["L-Sit Hold"].currentRepRange).toMatchObject({ reps: 25, timed: true });
  });
});
