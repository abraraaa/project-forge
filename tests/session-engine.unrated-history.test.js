// @vitest-environment jsdom
// tests/session-engine.unrated-history.test.js
// Finisher sets used to log with no effort. The first rated session after
// that history must progress the lift like any other: the unrated sessions
// are holds behind it, not a reason to stall.
import { describe, it, expect, beforeEach } from "vitest";
import { H, TS } from "../lib/storage.js";
import { applySessionToEngine } from "../lib/session-engine.js";

const rec = (id, date, weight, rir) => ({
  v: 2, id, date, readiness: "normal", session: "strength-b",
  blocks: [{ id: "bfin", type: "finisher", exercises: [{
    name: "Tricep Pushdown", loadType: "cable",
    sets: [12, 12, 12].map((r) => ({ weight, reps: r, rir, loadType: "cable", effectiveLoad: weight, est1rm: weight * (1 + r / 30) })),
    prescribed: { reps: 12, sets: 3, weight },
  }] }],
});

describe("a finisher lift with unrated history", () => {
  beforeEach(() => localStorage.clear());

  it("progresses on the first rated full session", () => {
    const dates = [["2026-10-02T10:00:00.000Z", "2026-10-02"], ["2026-10-09T10:00:00.000Z", "2026-10-09"]];
    for (const [id, date] of dates) {
      const r = rec(id, date, 30, null);
      H.append("p", r);
      applySessionToEngine("p", r);
    }
    const before = TS.get("p").lifts["Tricep Pushdown"];
    expect(before.currentWeight).toBe(30);
    expect(before.history.at(-1).decision).toBe("HOLD");

    const rated = rec("2026-10-16T10:00:00.000Z", "2026-10-16", 30, 2);
    H.append("p", rated);
    const out = applySessionToEngine("p", rated);
    const after = TS.get("p").lifts["Tricep Pushdown"];
    expect(after.history.at(-1).decision).toBe("ADD");
    expect(out.wwUpdates["Tricep Pushdown"]).toBeGreaterThan(30);
  });
});
