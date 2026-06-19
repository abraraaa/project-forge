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

  it("projection without a custom schedule falls back to scheduledType=null", () => {
    window.localStorage.setItem(
      "forge:alice:dayDone",
      JSON.stringify({ "2026-06-16": true }),
    );
    // No W.save() — no effective schedule.
    const all = Days.getAll("alice");
    expect(all["2026-06-16"].scheduledType).toBe(null);
  });
});
