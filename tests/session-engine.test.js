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
    expect(applySessionToEngine(null, null)).toEqual({ wwUpdates: {}, justCompletedDeload: false, stillInDeload: false });
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
