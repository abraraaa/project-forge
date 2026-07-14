// tests/store-health.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The invariant checker's contract: a healthy snapshot is all-green, and
// every paid-for bug class from this project's history turns exactly its
// own row red — the null/null Day entries, the straddle phantom, duplicate
// history ids, the per-lift window overflow, orphan stamps, unknown keys.
// Read-only by doctrine; these tests also lock that it MUTATES NOTHING.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { checkStoreHealth } from "../lib/store-health.js";

const TODAY = "2026-07-14";
const T1 = "2026-07-10T10:00:00.000Z";

const healthy = () => ({
  weights: { Squat: 100 },
  weightStamps: { Squat: T1 },
  reps: { Squat: 5 },
  repStamps: {},
  days: {
    "2026-07-10": { date: "2026-07-10", scheduledType: "cardio", completedType: "cardio", sessionId: null, marks: {}, updatedAt: T1 },
  },
  userWeek: null,
  breaks: [{ id: T1, start: "2026-07-01", reason: "resting", endedAt: "2026-07-03" }],
  history: [
    { id: "2026-07-08T10:00:00.000Z", date: "2026-07-08", session: "strength-a" },
    { id: "2026-07-10T10:00:00.000Z", date: "2026-07-10", session: "strength-b" },
  ],
  trainingState: { lifts: { Squat: { history: [{ date: "2026-07-10" }] } }, muscleAnchors: {} },
  programmeBlock: { number: 2, history: { s1: ["A", "B"] } },
  unknownKeys: [],
});

const failing = (results) => results.filter((r) => !r.ok).map((r) => r.check);

describe("checkStoreHealth", () => {
  it("a healthy snapshot is all-green", () => {
    expect(failing(checkStoreHealth(healthy(), { todayIso: TODAY }))).toEqual([]);
  });

  it("flags the null/null/null Day entry class (pre-d6772c1)", () => {
    const s = healthy();
    s.days["2026-07-09"] = { date: "2026-07-09", scheduledType: null, completedType: null, sessionId: null, marks: {}, updatedAt: T1 };
    expect(failing(checkStoreHealth(s, { todayIso: TODAY })))
      .toContain("days: no null/null/null entries (pre-d6772c1 class)");
  });

  it("flags the straddle-phantom class (future completion written early)", () => {
    const s = healthy();
    s.days["2026-07-20"] = { date: "2026-07-20", scheduledType: "strength", completedType: "strength", sessionId: null, marks: {}, updatedAt: T1 };
    expect(failing(checkStoreHealth(s, { todayIso: TODAY })))
      .toContain("days: no future-dated phantom completions (straddle class)");
  });

  it("flags duplicate history ids and unsorted history", () => {
    const s = healthy();
    s.history = [
      { id: "2026-07-10T10:00:00.000Z", date: "2026-07-10", session: "strength-a" },
      { id: "2026-07-08T10:00:00.000Z", date: "2026-07-08", session: "strength-a" },
      { id: "2026-07-08T10:00:00.000Z", date: "2026-07-08", session: "strength-a" },
    ];
    const fails = failing(checkStoreHealth(s, { todayIso: TODAY }));
    expect(fails).toContain("history: ids unique");
    expect(fails).toContain("history: sorted by id");
  });

  it("flags per-lift window overflow (a writer bypassed the cap)", () => {
    const s = healthy();
    s.trainingState.lifts.Squat.history = Array.from({ length: 13 }, (_, i) => ({ date: `2026-06-${String(i + 1).padStart(2, "0")}` }));
    expect(failing(checkStoreHealth(s, { todayIso: TODAY })))
      .toContain("trainingState: per-lift window ≤ 12");
  });

  it("flags orphan stamps and unknown keys", () => {
    const s = healthy();
    s.weightStamps.Ghost = T1;
    s.unknownKeys = ["forge:probe:mystery"];
    const fails = failing(checkStoreHealth(s, { todayIso: TODAY }));
    expect(fails).toContain("weights: no orphan stamps");
    expect(fails).toContain("no unrecognised forge:* keys");
  });

  it("mutates nothing — the snapshot is byte-identical after the check", () => {
    const s = healthy();
    const before = JSON.stringify(s);
    checkStoreHealth(s, { todayIso: TODAY });
    expect(JSON.stringify(s)).toBe(before);
  });
});
