// @vitest-environment jsdom
// tests/storage-history-migration.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Session record migration chain (v1 → v2 → v3). v3 adds two denormalised
// query helpers — weekStart and scheduledLetter — that are pure functions of
// existing fields, so the migration is loss-less and idempotent.
//
// What this file covers:
//   1. migrateV2ToV3 backfills v3 fields on v2 records.
//   2. migrateV2ToV3 is idempotent on v3 records (no-op).
//   3. The H.get chain (v1 → v2 → v3) upgrades v1 records all the way to v3.
//   4. Pre-v3 records on disk stay original (migration is read-time only).
//   5. newDraftLog stamps v3 fields at creation.
//   6. scheduledLetter parser tolerates both "strength-a" and "strength_a".
//   7. weekStart math handles week boundaries correctly.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { H, migrateV1ToV2, migrateV2ToV3, newDraftLog, finaliseDraft, SCHEMA_VERSION } from "../lib/storage.js";

describe("migrateV2ToV3 — denormalised query helpers", () => {
  it("backfills weekStart from date for a v2 record", () => {
    // 2026-06-17 is a Wednesday → Monday is 2026-06-15.
    const v2 = {
      id: "2026-06-17T10:00:00.000Z",
      date: "2026-06-17",
      session: "strength-a",
      schemaVersion: 2,
      blocks: [],
    };
    const v3 = migrateV2ToV3(v2);
    expect(v3.weekStart).toBe("2026-06-15");
    expect(v3.schemaVersion).toBe(3);
  });

  it("backfills scheduledLetter from session (hyphen variant)", () => {
    const v3 = migrateV2ToV3({ date: "2026-06-15", session: "strength-c", schemaVersion: 2, blocks: [] });
    expect(v3.scheduledLetter).toBe("C");
  });

  it("backfills scheduledLetter from session (underscore variant)", () => {
    const v3 = migrateV2ToV3({ date: "2026-06-15", session: "strength_b", schemaVersion: 2, blocks: [] });
    expect(v3.scheduledLetter).toBe("B");
  });

  it("returns null for non-strength session strings", () => {
    const v3 = migrateV2ToV3({ date: "2026-06-15", session: "rest", schemaVersion: 2, blocks: [] });
    expect(v3.scheduledLetter).toBe(null);
  });

  it("is idempotent on v3 records (no double-stamping)", () => {
    const v3 = {
      date: "2026-06-15", session: "strength-a",
      schemaVersion: 3,
      weekStart: "2026-06-15", scheduledLetter: "A",
      blocks: [],
    };
    const again = migrateV2ToV3(v3);
    expect(again).toBe(v3);
  });

  it("handles a Sunday date (1=Mon offset edge case)", () => {
    // 2026-06-21 is a Sunday → Monday is 2026-06-15.
    const v3 = migrateV2ToV3({ date: "2026-06-21", session: "strength-a", schemaVersion: 2, blocks: [] });
    expect(v3.weekStart).toBe("2026-06-15");
  });

  it("handles a Monday date (already the start of week)", () => {
    const v3 = migrateV2ToV3({ date: "2026-06-15", session: "strength-a", schemaVersion: 2, blocks: [] });
    expect(v3.weekStart).toBe("2026-06-15");
  });

  it("tolerates a null record", () => {
    expect(migrateV2ToV3(null)).toBe(null);
  });
});

describe("H.get migration chain — v1 records upgrade all the way to v3", () => {
  it("a v1 record on disk reads as a fully-upgraded v3 record", () => {
    // A v1 record had no schemaVersion + no v2/v3 fields. Write directly
    // to localStorage to simulate a legacy install.
    const v1 = {
      id: "2024-01-15T10:00:00.000Z",
      date: "2024-01-15",   // Monday
      session: "strength-b",
      blocks: [
        {
          id: "x", type: "main",
          exercises: [{
            name: "Bench Press", muscle: "Chest",
            sets: [{ weight: 80, reps: 5, rpe: "normal" }],
          }],
        },
      ],
    };
    window.localStorage.setItem("forge:alice:history", JSON.stringify([v1]));
    const upgraded = H.get("alice");
    expect(upgraded).toHaveLength(1);
    expect(upgraded[0].schemaVersion).toBe(3);
    expect(upgraded[0].weekStart).toBe("2024-01-15");
    expect(upgraded[0].scheduledLetter).toBe("B");
    // v2 fields also landed.
    expect(upgraded[0].mesocyclePhase).toBe("accumulation");
  });

  it("on-disk records stay original (migration is read-time only)", () => {
    const v1 = {
      id: "2024-01-15T10:00:00.000Z",
      date: "2024-01-15", session: "strength-a", blocks: [],
    };
    window.localStorage.setItem("forge:bob:history", JSON.stringify([v1]));
    H.get("bob");
    const raw = JSON.parse(window.localStorage.getItem("forge:bob:history"));
    expect(raw[0].schemaVersion).toBeUndefined();
    expect(raw[0].weekStart).toBeUndefined();
  });
});

describe("newDraftLog — stamps v3 fields at creation", () => {
  it("includes weekStart and scheduledLetter on a fresh draft", () => {
    const draft = newDraftLog({
      profileName: "alice",
      session: "strength-a",
      blockNumber: 1,
      readiness: "normal",
    });
    expect(draft.schemaVersion).toBe(SCHEMA_VERSION);
    expect(draft.scheduledLetter).toBe("A");
    // weekStart should be ISO YYYY-MM-DD; we can't assert a specific date
    // (the test runs on real "today"), just the shape.
    expect(draft.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // weekStart should be ≤ date (Monday is at or before the log date).
    expect(draft.weekStart <= draft.date).toBe(true);
  });

  it("a finalised draft retains the v3 fields", () => {
    const draft = newDraftLog({
      profileName: "alice", session: "strength-c", blockNumber: 1, readiness: "normal",
    });
    const finalised = finaliseDraft(draft);
    expect(finalised.scheduledLetter).toBe("C");
    expect(finalised.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(finalised.schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe("migrateV1ToV2 — idempotency after the SCHEMA_VERSION bump to 3", () => {
  it("returns a v2 record unchanged (does not re-process)", () => {
    const v2 = {
      id: "2024-01-15T10:00:00.000Z",
      date: "2024-01-15", session: "strength-a",
      schemaVersion: 2,
      blocks: [{ id: "x", type: "main", exercises: [] }],
    };
    expect(migrateV1ToV2(v2)).toBe(v2);
  });

  it("stamps v1 records as v2 specifically (not current) so v2→v3 picks them up", () => {
    const v1 = {
      id: "2024-01-15T10:00:00.000Z",
      date: "2024-01-15", session: "strength-a",
      blocks: [{ id: "x", type: "main", exercises: [] }],
    };
    const v2 = migrateV1ToV2(v1);
    expect(v2.schemaVersion).toBe(2);
  });
});
