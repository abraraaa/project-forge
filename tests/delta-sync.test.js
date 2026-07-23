// tests/delta-sync.test.js
// ─────────────────────────────────────────────────────────────────────────────
// PR A locks for the delta-sync design (#2 family — docs/delta-sync.md).
// Pure pieces tested directly (fieldClosure, mergeMetaFields); the route's
// delta branches + cursor ordering locked by code shape.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { fieldClosure, mergeMetaFields } from "../lib/sync-merge.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("fieldClosure — paired fields travel together", () => {
  it("expands value↔stamp pairs in both directions", () => {
    expect([...fieldClosure(["weights"])].sort()).toEqual(["weightStamps", "weights"]);
    expect([...fieldClosure(["weightStamps"])].sort()).toEqual(["weightStamps", "weights"]);
    expect([...fieldClosure(["userFocus"])].sort()).toEqual(["userFocus", "userFocusUpdatedAt"]);
    expect([...fieldClosure(["streak"])]).toEqual(["streak"]); // unpaired passes through
  });
  it("server-managed fields are never writable via delta", () => {
    expect([...fieldClosure(["displayName", "syncedAt", "streak"])]).toEqual(["streak"]);
  });
});

describe("mergeMetaFields — THE merge, scoped to the incoming closure", () => {
  const existing = {
    weights: { Squat: 100, Bench: 80 },
    weightStamps: { Squat: "2026-07-20T10:00:00.000Z", Bench: "2026-07-20T10:00:00.000Z" },
    days: { "2026-07-01": { date: "2026-07-01", completedType: "strength", updatedAt: "2026-07-01T10:00:00.000Z" } },
    streak: { count: 5, lastDate: "2026-07-20" },
  };

  it("stamp-aware within the closure: newer incoming key wins, older loses", () => {
    const out = mergeMetaFields(existing, {
      weights: { Squat: 102.5, Bench: 70 },
      weightStamps: { Squat: "2026-07-24T10:00:00.000Z", Bench: "2026-07-19T10:00:00.000Z" },
    });
    expect(out.weights.Squat).toBe(102.5); // newer stamp → incoming wins
    expect(out.weights.Bench).toBe(80);    // older stamp → existing survives
  });

  it("returns ONLY the closure keys — untouched fields can never be clobbered", () => {
    const out = mergeMetaFields(existing, { weights: { Squat: 105 }, weightStamps: { Squat: "2026-07-25T00:00:00.000Z" } });
    expect(Object.keys(out).sort()).toEqual(["weightStamps", "weights"]);
    expect(out.days).toBeUndefined();   // mergeMeta normalises days to {} — must NOT be written back
    expect(out.streak).toBeUndefined();
  });

  it("displayName in a hostile delta is dropped, not written", () => {
    const out = mergeMetaFields(existing, { displayName: "Mallory", streak: { count: 9, lastDate: "2026-07-25" } });
    expect(out.displayName).toBeUndefined();
    expect(out.streak.count).toBe(9);
  });

  it("date-keyed stores merge per-entry inside the closure (bodyweightLog)", () => {
    const out = mergeMetaFields(
      { bodyweightLog: { "2026-07-20": { kg: 81, updatedAt: "2026-07-20T08:00:00.000Z" } } },
      { bodyweightLog: { "2026-07-21": { kg: 80.5, updatedAt: "2026-07-21T08:00:00.000Z" } } },
    );
    expect(Object.keys(out.bodyweightLog).length).toBe(2);
  });
});

describe("route + db shapes (code)", () => {
  const route = readFileSync(resolve(root, "app/api/sync/route.js"), "utf8");
  const db = readFileSync(resolve(root, "lib/db.js"), "utf8");

  it("GET ?since: cursor validated, DB-only (503 without), no blob backfill in the branch", () => {
    const branch = route.slice(route.indexOf('searchParams.get("since")'), route.indexOf("// DB-first"));
    expect(branch).toContain("Invalid cursor");
    expect(branch).toContain("Delta sync unavailable");
    expect(branch).toContain("dbReadProfileSince(normalise(profile), since)");
    expect(branch).not.toContain("readLatestLegacy");
  });

  it("PUT delta: cursor taken BEFORE the write; merge scoped via fieldClosure; failures 503 (client retries)", () => {
    const branch = route.slice(route.indexOf("parsed.body.delta"), route.indexOf('if (!data) return NextResponse.json({ error: "No data" }'));
    expect(branch.indexOf("dbCursorNow()")).toBeLessThan(branch.indexOf("dbUpsertProfile"));
    expect(branch).toContain("fieldClosure(Object.keys(incoming))");
    expect(branch).toContain("mergeMetaFields(existing, incoming)");
    expect(branch).toContain("status: 503");
  });

  it("full reads hand out a cursor taken BEFORE the row queries (at-least-once)", () => {
    const read = db.slice(db.indexOf("export async function dbReadProfile("), db.indexOf("export async function dbUpsertProfile"));
    expect(read.indexOf("dbNowCursor")).toBeLessThan(read.indexOf("SELECT field, value"));
    const since = db.slice(db.indexOf("export async function dbReadProfileSince"));
    expect(since.indexOf("dbNowCursor")).toBeLessThan(since.indexOf("updated_at > "));
  });
});
