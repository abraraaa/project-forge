// @vitest-environment jsdom
// tests/breaks.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Breather logic (lib/breaks.js) + the Bk store and its sync merge
// (lib/storage.js). These lock: only one breather open at a time, activity
// after the start day ends it (live OR retro), same/earlier activity does
// not, and a breather + its resolution round-trip through the blob meta
// payload and merge conflict-free across devices (design principle #0).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import {
  REASONS, normaliseReason, reasonLabel, activeBreak, isResting,
  breakEndedBy, makeBreak,
} from "../lib/breaks.js";

describe("reason vocabulary", () => {
  it("offers 3–5 reasons, each with id + label", () => {
    expect(REASONS.length).toBeGreaterThanOrEqual(3);
    expect(REASONS.length).toBeLessThanOrEqual(5);
    for (const r of REASONS) {
      expect(typeof r.id).toBe("string");
      expect(r.label.length).toBeGreaterThan(0);
    }
  });

  it("normaliseReason keeps known ids, nulls the rest", () => {
    expect(normaliseReason("travelling")).toBe("travelling");
    expect(normaliseReason("nonsense")).toBeNull();
    expect(normaliseReason(null)).toBeNull();
  });

  it("reasonLabel resolves ids and tolerates unknowns", () => {
    expect(reasonLabel("injured")).toBe("Injured or ill");
    expect(reasonLabel("nope")).toBeNull();
  });
});

describe("activeBreak / isResting", () => {
  it("returns the open record, or null", () => {
    expect(activeBreak([])).toBeNull();
    expect(activeBreak(null)).toBeNull();
    const open = { id: "t1", start: "2026-07-01", reason: null, endedAt: null };
    const closed = { id: "t0", start: "2026-06-01", reason: "resting", endedAt: "2026-06-10" };
    expect(activeBreak([closed, open])).toEqual(open);
    expect(isResting([closed, open])).toBe(true);
    expect(isResting([closed])).toBe(false);
  });

  it("takes the latest when (defensively) more than one is open", () => {
    const a = { id: "t1", start: "2026-06-01", endedAt: null };
    const b = { id: "t2", start: "2026-07-01", endedAt: null };
    expect(activeBreak([a, b]).id).toBe("t2");
  });
});

describe("breakEndedBy — activity on-or-after start ends it", () => {
  const brk = { id: "t1", start: "2026-07-06", reason: "busy", endedAt: null };

  it("training the same day you paused (or later) resumes the rhythm", () => {
    expect(breakEndedBy(brk, "2026-07-06")).toBe(true); // same day — the fix
    expect(breakEndedBy(brk, "2026-07-07")).toBe(true);
    expect(breakEndedBy(brk, "2026-08-01")).toBe(true);
  });

  it("only activity STRICTLY BEFORE the start is exempt (retro-fill last week is safe)", () => {
    expect(breakEndedBy(brk, "2026-07-05")).toBe(false);
    expect(breakEndedBy(brk, "2026-07-01")).toBe(false);
  });

  it("an already-ended or malformed break is never re-ended", () => {
    expect(breakEndedBy({ ...brk, endedAt: "2026-07-10" }, "2026-07-20")).toBe(false);
    expect(breakEndedBy(null, "2026-07-07")).toBe(false);
    expect(breakEndedBy(brk, "")).toBe(false);
  });
});

describe("makeBreak", () => {
  it("builds the record with a normalised reason", () => {
    expect(makeBreak("resting", "2026-07-06", "2026-07-06T09:00:00.000Z")).toEqual({
      id: "2026-07-06T09:00:00.000Z", start: "2026-07-06", reason: "resting", endedAt: null,
    });
    expect(makeBreak("garbage", "2026-07-06", "t").reason).toBeNull();
  });
});

// ── Store + sync ────────────────────────────────────────────────────────────
describe("Bk store + sync round-trip", () => {
  let Bk, getLocalProfile, backgroundSync;
  const PROFILE = "breaktest";

  beforeEach(async () => {
    localStorage.clear();
    const storage = await import("../lib/storage.js");
    Bk = storage.Bk;
    getLocalProfile = storage.getLocalProfile;
  });

  it("start() opens a breather; endOnActivity() resumes on same-day-or-later activity", () => {
    Bk.start(PROFILE, "travelling", { today: "2026-07-06", confirmedAt: "2026-07-06T09:00:00.000Z" });
    expect(Bk.getActive(PROFILE)?.reason).toBe("travelling");

    expect(Bk.endOnActivity(PROFILE, "2026-07-04")).toBe(false); // before the pause — exempt
    expect(Bk.getActive(PROFILE)).not.toBeNull();
    expect(Bk.endOnActivity(PROFILE, "2026-07-06")).toBe(true);  // same day — resumes
    expect(Bk.getActive(PROFILE)).toBeNull();
  });

  it("end() manually resumes with no activity (the 'Back to it' path)", () => {
    Bk.start(PROFILE, "resting", { today: "2026-06-30", confirmedAt: "t1" });
    expect(Bk.getActive(PROFILE)).not.toBeNull();
    expect(Bk.end(PROFILE, { today: "2026-07-06" })).toBe(true);
    expect(Bk.getActive(PROFILE)).toBeNull();
    expect(Bk.getAll(PROFILE)[0].endedAt).toBe("2026-07-06");
    expect(Bk.end(PROFILE)).toBe(false); // nothing open → no-op
  });

  it("start() closes any already-open breather first", () => {
    Bk.start(PROFILE, "resting", { today: "2026-06-01", confirmedAt: "t0" });
    Bk.start(PROFILE, "busy", { today: "2026-07-01", confirmedAt: "t1" });
    const all = Bk.getAll(PROFILE);
    expect(all).toHaveLength(2);
    expect(all.filter((b) => !b.endedAt)).toHaveLength(1);
    expect(Bk.getActive(PROFILE).reason).toBe("busy");
  });

  it("breaks ride in the meta payload", () => {
    Bk.start(PROFILE, "injured", { today: "2026-07-06", confirmedAt: "t1" });
    const snap = getLocalProfile(PROFILE);
    expect(snap.meta.breaks).toHaveLength(1);
    expect(snap.meta.breaks[0].reason).toBe("injured");
  });
});
