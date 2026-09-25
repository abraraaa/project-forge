// @vitest-environment jsdom
// The Home absence nudge: activity and breathers come off the day context
// (decisions 5 and 7), and a dismissal persists per absence (decision 6).
import { describe, it, expect, beforeEach } from "vitest";
import { nudgeAbsence } from "../lib/absence.js";
import { makeDayContext } from "../lib/day-state.js";
import { AN } from "../lib/storage.js";
import { PROFILE_SUFFIXES } from "../lib/store-health.js";

const rec = (date) => ({ id: `${date}T10:00`, date, session: "strength_a", scheduledLetter: "A" });
const ctx = (todayIso, extra = {}) => makeDayContext({ todayIso, weekFor: () => null, ...extra });

describe("nudgeAbsence — judged from the day context", () => {
  it("a long quiet stretch after the last session is current", () => {
    const a = nudgeAbsence(ctx("2026-07-06", { history: [rec("2026-06-20")] }), { weeklySlots: 3 });
    expect(a?.start).toBe("2026-06-21");
    expect(a?.days).toBe(15); // decision 5: through yesterday
  });

  it("any did is activity: a tick, and a synced sessionId without history (decision 7)", () => {
    const history = [rec("2026-06-20")];
    const tick = ctx("2026-07-06", { history, days: { "2026-07-01": { completedType: "hiit" } } });
    expect(nudgeAbsence(tick, { weeklySlots: 3 })).toBeNull();
    const session = ctx("2026-07-06", { history, days: { "2026-07-01": { sessionId: "s1" } } });
    expect(nudgeAbsence(session, { weeklySlots: 3 })).toBeNull();
  });

  it("a closed breather is declared rest, not days off", () => {
    const breaks = [{ start: "2026-06-21", endedAt: "2026-07-02T09:00:00Z" }];
    const c = ctx("2026-07-06", { history: [rec("2026-06-20")], breaks });
    // Only Jul 2–5 are quiet: 4 < threshold 6.
    expect(nudgeAbsence(c, { weeklySlots: 3 })).toBeNull();
  });

  it("decision 6: the dismissed absence stays hidden; a new one shows", () => {
    const c = ctx("2026-07-06", { history: [rec("2026-06-20")] });
    expect(nudgeAbsence(c, { weeklySlots: 3, dismissedStart: "2026-06-21" })).toBeNull();
    // Trained Jul 1 after dismissing, then quiet again: a different absence.
    const later = ctx("2026-07-20", { history: [rec("2026-06-20"), rec("2026-07-01")] });
    expect(nudgeAbsence(later, { weeklySlots: 3, dismissedStart: "2026-06-21" })?.start).toBe("2026-07-02");
  });
});

describe("AN — per-profile dismissal, device-local", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips the dismissed start date per profile", () => {
    expect(AN.get("ana")).toBeNull();
    AN.dismiss("ana", "2026-06-21");
    expect(AN.get("ana")).toBe("2026-06-21");
    expect(AN.get("ben")).toBeNull();
    expect(localStorage.getItem("forge:ana:absenceNudge")).toBe(JSON.stringify("2026-06-21"));
  });

  it("overwrites in place and ignores garbage", () => {
    AN.dismiss("ana", "2026-06-21");
    AN.dismiss("ana", "2026-07-02");
    expect(AN.get("ana")).toBe("2026-07-02");
    localStorage.setItem("forge:ana:absenceNudge", JSON.stringify({ bad: 1 }));
    expect(AN.get("ana")).toBeNull();
  });

  it("is registered in PROFILE_SUFFIXES", () => {
    expect(PROFILE_SUFFIXES.has("absenceNudge")).toBe(true);
  });
});
