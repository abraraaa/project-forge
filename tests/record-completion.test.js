// @vitest-environment jsdom
// tests/record-completion.test.js
// ─────────────────────────────────────────────────────────────────────────────
// recordCompletion — the single write path for date completions. Locks the
// three-step contract every completion needs (effective-schedule stamping,
// the Days upsert, breather resolution) so no future call site can drift.
// Each historic bug in this territory was one call site missing one step:
// null scheduledType (no default-week fallback), retro strength logs never
// resuming a breather, bonus marks indistinguishable from broken writes.
//
// Also locks the _foldLegacy future-date guard: a legacy dayDone key dated
// in the future (the retired P.markDayDone midnight-straddle write) must
// never mint a phantom Day entry.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import { recordCompletion, Days, W, Bk, mergeDayEntries } from "../lib/storage.js";
import { WEEK } from "../lib/programme.js";

const PROFILE = "test-rc";

// Monday-start weekday index for an ISO date, matching storage's convention.
const dowMon = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  const js = new Date(y, m - 1, d).getDay();
  return js === 0 ? 6 : js - 1;
};

beforeEach(() => {
  localStorage.clear();
});

describe("recordCompletion — kinds", () => {
  it("session: writes sessionId + completedType strength, stamps scheduledType", () => {
    const res = recordCompletion(PROFILE, "2026-07-08", {
      kind: "session",
      sessionId: "2026-07-08T18:00:00.000Z",
    });
    expect(res.entry.sessionId).toBe("2026-07-08T18:00:00.000Z");
    expect(res.entry.completedType).toBe("strength");
    // No custom schedule → DEFAULT_WEEK fallback, never null.
    expect(res.entry.scheduledType).toBe(WEEK[dowMon("2026-07-08")].type);
  });

  it("session without a sessionId is refused", () => {
    expect(recordCompletion(PROFILE, "2026-07-08", { kind: "session" })).toBeNull();
    expect(Days.get(PROFILE, "2026-07-08")).toBeNull();
  });

  it("tick: completedType = the schedule effective ON THAT DATE, not today's", () => {
    // Old schedule (cardio everywhere) in force until the 10th; new schedule
    // (strength everywhere) effective from the 10th. A tick for the 8th must
    // stamp under the OLD schedule.
    const cardioWeek   = Array(7).fill({ type: "cardio" });
    const strengthWeek = Array(7).fill({ type: "strength" });
    W.save(cardioWeek,   { effectiveFrom: "2026-01-01" });
    W.save(strengthWeek, { effectiveFrom: "2026-07-10" });

    const res = recordCompletion(PROFILE, "2026-07-08", { kind: "tick" });
    expect(res.entry.scheduledType).toBe("cardio");
    expect(res.entry.completedType).toBe("cardio");
  });

  it("tick with no custom schedule falls back to the default week (never null)", () => {
    const res = recordCompletion(PROFILE, "2026-07-08", { kind: "tick" });
    expect(res.entry.completedType).toBe(WEEK[dowMon("2026-07-08")].type);
    expect(res.entry.completedType).not.toBeNull();
    // The null-completedType bug made manualTickDates filter the entry out,
    // so the retro picker re-surfaced the same day as missed forever.
    expect(Days.manualTickDates(PROFILE)["2026-07-08"]).toBe(true);
  });

  it("bonus: marks only — no completedType, scheduledType stamped for the repair signal", () => {
    const res = recordCompletion(PROFILE, "2026-07-08", { kind: "bonus" });
    expect(res.entry.marks.bonus).toBe(true);
    expect(res.entry.completedType).toBeUndefined();
    expect(res.entry.scheduledType).toBe(WEEK[dowMon("2026-07-08")].type);
  });

  it("unknown kind and bad dates are refused", () => {
    expect(recordCompletion(PROFILE, "2026-07-08", {})).toBeNull();
    expect(recordCompletion(PROFILE, "not-a-date", { kind: "tick" })).toBeNull();
    expect(recordCompletion(null, "2026-07-08", { kind: "tick" })).toBeNull();
  });
});

describe("recordCompletion — breather resolution", () => {
  it("a session on/after the breather's start resumes the rhythm (the retro-log case)", () => {
    Bk.start(PROFILE, "resting", { today: "2026-07-06" });
    const res = recordCompletion(PROFILE, "2026-07-08", {
      kind: "session",
      sessionId: "2026-07-08T12:00:00.000Z",
    });
    expect(res.endedBreak).toBe(true);
    expect(Bk.getActive(PROFILE)).toBeNull();
  });

  it("a tick before the breather's start leaves it open", () => {
    Bk.start(PROFILE, "resting", { today: "2026-07-06" });
    const res = recordCompletion(PROFILE, "2026-07-04", { kind: "tick" });
    expect(res.endedBreak).toBe(false);
    expect(Bk.getActive(PROFILE)).not.toBeNull();
  });

  it("a bonus mark NEVER resumes a breather — extras are not adherence", () => {
    Bk.start(PROFILE, "resting", { today: "2026-07-06" });
    const res = recordCompletion(PROFILE, "2026-07-08", { kind: "bonus" });
    expect(res.endedBreak).toBe(false);
    expect(Bk.getActive(PROFILE)).not.toBeNull();
  });
});

describe("mergeDayEntries — field-aware cross-device merge", () => {
  it("a bonus mark on one device and a completion on the other both survive", () => {
    const local = {
      "2026-07-08": {
        date: "2026-07-08", scheduledType: "cardio", completedType: "cardio",
        sessionId: null, marks: {}, updatedAt: "2026-07-08T10:00:00.000Z",
      },
    };
    const remote = {
      "2026-07-08": {
        date: "2026-07-08", scheduledType: "cardio",
        marks: { bonus: true }, updatedAt: "2026-07-08T18:00:00.000Z",
      },
    };
    const merged = mergeDayEntries(local, remote);
    const entry = merged["2026-07-08"];
    // Whole-entry latest-wins used to let the (newer) bonus-only write
    // erase the completion. Both facts must survive.
    expect(entry.completedType).toBe("cardio");
    expect(entry.marks.bonus).toBe(true);
  });

  it("winner's fields beat the loser's on genuine per-field conflicts", () => {
    const local = {
      "2026-07-08": {
        date: "2026-07-08", scheduledType: "cardio", completedType: "cardio",
        sessionId: null, marks: {}, updatedAt: "2026-07-08T10:00:00.000Z",
      },
    };
    const remote = {
      "2026-07-08": {
        date: "2026-07-08", scheduledType: "strength", completedType: "strength",
        sessionId: "s1", marks: {}, updatedAt: "2026-07-08T18:00:00.000Z",
      },
    };
    const entry = mergeDayEntries(local, remote)["2026-07-08"];
    expect(entry.completedType).toBe("strength");
    expect(entry.sessionId).toBe("s1");
  });

  it("dates present on only one side pass through untouched", () => {
    const local  = { "2026-07-01": { date: "2026-07-01", completedType: "cardio", updatedAt: "x" } };
    const remote = { "2026-07-02": { date: "2026-07-02", completedType: "hiit",  updatedAt: "y" } };
    const merged = mergeDayEntries(local, remote);
    expect(Object.keys(merged).sort()).toEqual(["2026-07-01", "2026-07-02"]);
  });
});

describe("_foldLegacy — future-date guard", () => {
  it("a future-dated legacy dayDone key never mints a phantom Day entry", () => {
    const future = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 6); // the straddle phantom: six days ahead
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"),
            day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    })();
    localStorage.setItem(
      `forge:${PROFILE}:dayDone`,
      JSON.stringify({ [future]: true, "2026-07-01": true }),
    );
    const all = Days.getAll(PROFILE); // triggers the fold
    expect(all[future]).toBeUndefined();        // phantom refused
    expect(all["2026-07-01"]).toBeDefined();    // past tick still folds
    expect(all["2026-07-01"].completedType).not.toBeNull();
  });
});
