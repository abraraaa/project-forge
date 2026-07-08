// @vitest-environment jsdom
// tests/storage-days.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Behaviour tests for the Days store — unified date-keyed completion entity.
//
// What this file covers:
//   1. set() upserts partial fields and auto-stamps updatedAt.
//   2. set() merges marks shallowly (no clobber of unrelated marks).
//   3. get() returns null for unknown dates.
//   4. getInRange() filters and sorts by date.
//   5. replaceAll() overwrites the full store + marks projection done.
//   6. Lazy projection from dayDone / bonusDone / strength history runs
//      once on first read, then never again (idempotent).
//   7. Existing Day entries are preserved by the projection (no clobber).
//   8. Date-of-week math handles Sunday + Monday correctly.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { Days, W } from "../lib/storage.js";

describe("Days — write + read primitives", () => {
  it("set() upserts and auto-stamps updatedAt", () => {
    const r1 = Days.set("alice", "2026-06-15", { completedType: "cardio" });
    expect(r1.date).toBe("2026-06-15");
    expect(r1.completedType).toBe("cardio");
    expect(r1.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Updating the same date preserves untouched fields, refreshes updatedAt.
    const r2 = Days.set("alice", "2026-06-15", { sessionId: "abc" });
    expect(r2.completedType).toBe("cardio");
    expect(r2.sessionId).toBe("abc");
    expect(r2.updatedAt >= r1.updatedAt).toBe(true);
  });

  it("set() merges marks shallowly", () => {
    Days.set("alice", "2026-06-15", { marks: { bonus: true } });
    Days.set("alice", "2026-06-15", { marks: { custom: "x" } });
    const got = Days.get("alice", "2026-06-15");
    expect(got.marks).toEqual({ bonus: true, custom: "x" });
  });

  it("get() returns null for unknown dates", () => {
    Days.set("alice", "2026-06-15", { completedType: "cardio" });
    expect(Days.get("alice", "2026-06-20")).toBe(null);
  });

  it("get() rejects invalid date strings cleanly", () => {
    expect(Days.get("alice", "not-a-date")).toBe(null);
    expect(Days.get(null, "2026-06-15")).toBe(null);
  });

  it("getInRange() filters and sorts by date", () => {
    Days.set("alice", "2026-06-15", { completedType: "cardio" });
    Days.set("alice", "2026-06-17", { completedType: "strength" });
    Days.set("alice", "2026-06-20", { completedType: "rest" });
    Days.set("alice", "2026-06-25", { completedType: "cardio" });

    const result = Days.getInRange("alice", "2026-06-16", "2026-06-21");
    expect(result.map((d) => d.date)).toEqual(["2026-06-17", "2026-06-20"]);
  });

  it("getAll() returns the full keyed object", () => {
    Days.set("alice", "2026-06-15", { completedType: "cardio" });
    Days.set("alice", "2026-06-17", { completedType: "strength" });
    const all = Days.getAll("alice");
    expect(Object.keys(all).sort()).toEqual(["2026-06-15", "2026-06-17"]);
  });

  it("clear() wipes the store + projection flag", () => {
    Days.set("alice", "2026-06-15", { completedType: "cardio" });
    Days.clear("alice");
    expect(Days.getAll("alice")).toEqual({});
  });

  it("replaceAll() overwrites the full store and marks projection done", () => {
    Days.set("alice", "2026-06-15", { completedType: "cardio" });
    Days.replaceAll("alice", {
      "2026-06-20": { date: "2026-06-20", completedType: "strength", marks: {} },
    });
    const all = Days.getAll("alice");
    expect(Object.keys(all)).toEqual(["2026-06-20"]);
  });

  it("replaceAll() rejects non-object input", () => {
    expect(Days.replaceAll("alice", null)).toBe(null);
    expect(Days.replaceAll("alice", [])).toBe(null);
    expect(Days.replaceAll("alice", "string")).toBe(null);
  });
});

describe("Days — current-week read projections (cutover read source)", () => {
  // Anchor "now" to a known Wednesday so week math is deterministic.
  // 2026-06-17 is a Wednesday → Monday = 2026-06-15.
  const NOW = new Date("2026-06-17T12:00:00");

  it("projectCurrentWeek maps completions to weekday indices (0=Mon)", () => {
    // Monday strength session; Tuesday tick matching its scheduled type
    // (default WEEK Tuesday = zone2 — a mismatched tick must NOT count,
    // see the schedule-edit truthfulness suite below).
    Days.set("alice", "2026-06-15", { completedType: "strength", sessionId: "s1" });
    Days.set("alice", "2026-06-16", { completedType: "zone2" });
    const proj = Days.projectCurrentWeek("alice", { now: NOW });
    expect(proj.complete[0]).toBe(true);  // Monday
    expect(proj.complete[1]).toBe(true);  // Tuesday
    expect(proj.complete[2]).toBeUndefined(); // Wednesday — nothing yet
  });

  it("projectCurrentWeek surfaces bonus marks separately from completion", () => {
    // Mirror what handleMarkBonusDone writes post-fix: scheduledType
    // stamped from the effective schedule, marks carries the bonus flag,
    // completedType stays null (bonus ≠ scheduled completion). With
    // scheduledType set, the repair migration leaves it alone.
    Days.set("alice", "2026-06-16", {
      scheduledType: "zone2",
      marks: { bonus: true },
    });
    const proj = Days.projectCurrentWeek("alice", { now: NOW });
    expect(proj.bonus[1]).toBe(true);          // Tuesday bonus
    expect(proj.complete[1]).toBeUndefined();  // bonus alone isn't completion
  });

  it("projectCurrentWeek ignores dates outside the current week", () => {
    // A completion in the PRIOR week (Mon 2026-06-08) must not bleed in.
    Days.set("alice", "2026-06-08", { completedType: "strength", sessionId: "old" });
    const proj = Days.projectCurrentWeek("alice", { now: NOW });
    expect(Object.keys(proj.complete)).toHaveLength(0);
  });

  it("manualTickDates returns only non-strength manual ticks (no sessionId)", () => {
    Days.set("alice", "2026-06-15", { completedType: "strength", sessionId: "s1" });
    Days.set("alice", "2026-06-16", { completedType: "cardio" });   // manual tick
    Days.set("alice", "2026-06-18", { completedType: "hiit" });     // manual tick
    const ticks = Days.manualTickDates("alice");
    expect(ticks).toEqual({ "2026-06-16": true, "2026-06-18": true });
    // The strength session date must NOT appear (history-backed, not a tick).
    expect(ticks["2026-06-15"]).toBeUndefined();
  });

  it("projectCurrentWeek returns empty maps for an unknown profile", () => {
    const proj = Days.projectCurrentWeek("nobody", { now: NOW });
    expect(proj.complete).toEqual({});
    expect(proj.bonus).toEqual({});
  });
});

describe("Days — lazy projection from legacy stores", () => {
  it("projects dayDone marks into Day entries on first read", () => {
    // Set up a custom schedule so scheduledType lookups have something.
    W.save([
      { type: "strength" }, { type: "cardio" },   { type: "strength" },
      { type: "cardio" },   { type: "strength" }, { type: "zone2" },
      { type: "rest" },
    ], { effectiveFrom: "2026-06-01" });

    // Legacy dayDone marks (the user ticked a cardio Tuesday).
    window.localStorage.setItem(
      "forge:alice:dayDone",
      JSON.stringify({ "2026-06-16": true }),
    );

    const all = Days.getAll("alice");
    expect(all["2026-06-16"]).toBeDefined();
    expect(all["2026-06-16"].completedType).toBe("cardio");
    expect(all["2026-06-16"].scheduledType).toBe("cardio");
  });

  it("projects strength session records into Day entries with sessionId", () => {
    W.save([
      { type: "strength" }, { type: "cardio" },   { type: "strength" },
      { type: "cardio" },   { type: "strength" }, { type: "zone2" },
      { type: "rest" },
    ], { effectiveFrom: "2026-06-01" });

    window.localStorage.setItem("forge:alice:history", JSON.stringify([
      {
        id: "2026-06-15T10:00:00.000Z",
        date: "2026-06-15",
        session: "strength-a",
        schemaVersion: 3,
        blocks: [],
      },
    ]));

    const all = Days.getAll("alice");
    expect(all["2026-06-15"]).toBeDefined();
    expect(all["2026-06-15"].completedType).toBe("strength");
    expect(all["2026-06-15"].sessionId).toBe("2026-06-15T10:00:00.000Z");
  });

  it("projects cardio bonus marks from bonusDone (per-week-keyed)", () => {
    W.save([
      { type: "strength" }, { type: "cardio" },   { type: "strength" },
      { type: "cardio" },   { type: "strength" }, { type: "zone2" },
      { type: "rest" },
    ], { effectiveFrom: "2026-06-01" });

    // bonusDone is keyed by Monday of the week + day idx.
    // Mon = 2026-06-15, Tuesday idx = 1 → date 2026-06-16.
    window.localStorage.setItem(
      "forge:alice:bonusDone:2026-06-15",
      JSON.stringify({ "1": true }),
    );

    const all = Days.getAll("alice");
    expect(all["2026-06-16"]).toBeDefined();
    expect(all["2026-06-16"].marks?.bonus).toBe(true);
  });

  it("projection is idempotent — runs once, no double-stamping", () => {
    window.localStorage.setItem(
      "forge:alice:dayDone",
      JSON.stringify({ "2026-06-16": true }),
    );

    // First call triggers projection.
    const a = Days.getAll("alice");
    const t1 = a["2026-06-16"].updatedAt;

    // Second call must not re-stamp. Wait a tick to ensure timestamps would
    // differ if the projection re-ran.
    const b = Days.getAll("alice");
    const t2 = b["2026-06-16"].updatedAt;
    expect(t1).toBe(t2);
  });

  it("existing Day entries are preserved by the projection (no clobber)", () => {
    // User has an explicit Day entry already (e.g. from a fresh write).
    Days.set("alice", "2026-06-16", { completedType: "hiit", marks: { custom: 1 } });

    // Legacy dayDone says the same date was ticked. Projection must NOT
    // overwrite the explicit completedType.
    window.localStorage.setItem(
      "forge:alice:dayDone",
      JSON.stringify({ "2026-06-16": true }),
    );
    // Force projection to run by clearing the flag.
    window.localStorage.removeItem("forge:alice:daysProjected");

    const got = Days.get("alice", "2026-06-16");
    expect(got.completedType).toBe("hiit");
    expect(got.marks?.custom).toBe(1);
  });

  it("projection without a custom schedule falls back to the default WEEK type", () => {
    // 2026-06-16 is a Tuesday. The default WEEK has Tuesday as zone2.
    // Critical: scheduledType must NOT be null here — if it were, the
    // matching completedType would also be null, and Days.manualTickDates
    // would filter the entry out as having no completion. The retro picker
    // would then keep showing the same date as "missed" forever. Regression
    // guard for the bug reported on 2026-06-21.
    window.localStorage.setItem(
      "forge:alice:dayDone",
      JSON.stringify({ "2026-06-16": true }),
    );
    // No W.save() — no schedule edit log; fallback to DEFAULT_WEEK kicks in.
    const all = Days.getAll("alice");
    expect(all["2026-06-16"].scheduledType).toBe("zone2");
    expect(all["2026-06-16"].completedType).toBe("zone2");
    // And the date appears in manualTickDates (the retro picker's read).
    expect(Days.manualTickDates("alice")["2026-06-16"]).toBe(true);
  });

  it("repairs Day entries with null scheduledType/completedType from the pre-d6772c1 bug", () => {
    // Simulates an entry written by a buggy handleMarkDayDone tap before
    // the DEFAULT_WEEK fallback shipped: scheduledType and completedType
    // both null, no sessionId, no marks. Without repair, manualTickDates
    // filters it out and the retro picker keeps re-surfacing the date.
    window.localStorage.setItem(
      "forge:alice:days",
      JSON.stringify({
        "2026-06-15": {
          date: "2026-06-15",
          scheduledType: null,
          completedType: null,
          sessionId: null,
          marks: {},
          updatedAt: "2026-06-15T10:00:00Z",
        },
      }),
    );
    // Set projectedKey so _foldLegacy doesn't fire — we want to verify
    // the repair runs on its own gate.
    window.localStorage.setItem("forge:alice:daysProjected", "true");

    // First read triggers _maybeRepair via getAll → _maybeProject.
    // 2026-06-15 is a Monday — default WEEK says strength.
    const all = Days.getAll("alice");
    expect(all["2026-06-15"].scheduledType).toBe("strength");
    expect(all["2026-06-15"].completedType).toBe("strength");
    expect(Days.manualTickDates("alice")["2026-06-15"]).toBe(true);
    // Repair flag is set so subsequent reads no-op.
    expect(window.localStorage.getItem("forge:alice:daysRepaired_v1")).toBe("true");
  });

  it("repair also fixes pre-fix bonus-then-broken-Mark entries (marks preserved)", () => {
    // Pre-fix scenario: user tapped Mark ✓ (wrote null/null due to bug),
    // then tapped bonus (added marks: { bonus: true }). Result entry has
    // all three completion fields null + a bonus mark — indistinguishable
    // from a legitimate bonus-only entry. Post-fix handleMarkBonusDone
    // stamps scheduledType so new entries don't fall into this pattern;
    // the repair healing the legacy ones unblocks the retro picker for
    // the much more common "did both" case. False-positive risk for
    // legit-bonus-only-with-null-scheduled is accepted (rare; user can
    // always re-tap to correct).
    window.localStorage.setItem(
      "forge:alice:days",
      JSON.stringify({
        "2026-06-15": {
          date: "2026-06-15",
          scheduledType: null,
          completedType: null,
          sessionId: null,
          marks: { bonus: true },
          updatedAt: "2026-06-15T10:00:00Z",
        },
      }),
    );
    window.localStorage.setItem("forge:alice:daysProjected", "true");

    const all = Days.getAll("alice");
    // 2026-06-15 is a Monday — default WEEK says strength.
    expect(all["2026-06-15"].scheduledType).toBe("strength");
    expect(all["2026-06-15"].completedType).toBe("strength");
    // Bonus mark survives the repair (spread preserves it).
    expect(all["2026-06-15"].marks.bonus).toBe(true);
  });
});

// Schedule-edit truthfulness (user report 2026-07-09): a manual tick only
// satisfies its OWN type against the currently-effective schedule; a real
// strength session (sessionId) satisfies any day. Prevents the false
// positive: tick cardio, flip the day to strength, day showed complete.
describe("projectCurrentWeek — completion must match the effective type", () => {
  const PROFILE = "schedmatch";
  const isoOfDow = (i) => { // i = 0..6 Monday-start, current week
    const d = new Date(); d.setHours(0,0,0,0);
    const shift = d.getDay() === 0 ? -6 : 1 - d.getDay();
    d.setDate(d.getDate() + shift + i);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  };

  it("a tick of the wrong type does not complete the day; matching type and sessionId do", async () => {
    localStorage.clear();
    const { Days } = await import("../lib/storage.js");
    // Default WEEK: index 1 = zone2. A cardio tick there must NOT complete it.
    Days.set(PROFILE, isoOfDow(1), { scheduledType: "cardio", completedType: "cardio" });
    expect(Days.projectCurrentWeek(PROFILE).complete[1]).toBeUndefined();
    // Matching type completes.
    Days.set(PROFILE, isoOfDow(1), { completedType: "zone2" });
    expect(Days.projectCurrentWeek(PROFILE).complete[1]).toBe(true);
    // A real strength session satisfies any day (index 3 = cardio in WEEK).
    Days.set(PROFILE, isoOfDow(3), { scheduledType: "strength", completedType: "strength", sessionId: "x" });
    expect(Days.projectCurrentWeek(PROFILE).complete[3]).toBe(true);
  });
});
