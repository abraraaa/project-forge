// tests/delta-sync.test.js
// ─────────────────────────────────────────────────────────────────────────────
// PR A locks for the delta-sync design (#2 family).
// Pure pieces tested directly (fieldClosure, mergeMetaFields); the route's
// delta branches + cursor ordering locked by code shape.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
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
    expect(branch).toContain("dbReadProfileSince(gate.profile, since)");
    expect(branch).not.toContain("readLatestLegacy");
  });

  it("PUT delta: cursor taken BEFORE the write; merge scoped via fieldClosure; failures 503 (client retries)", () => {
    const branch = route.slice(route.indexOf("parsed.body.delta"), route.indexOf('if (!data) return NextResponse.json({ error: "No data" }'));
    expect(branch.indexOf("dbCursorNow()")).toBeLessThan(branch.indexOf("writeMetaGuarded("));
    expect(branch).toContain("fieldClosure(Object.keys(incoming))");
    expect(branch).toContain("dbReadMetaBase(norm, closure)");
    expect(branch).toContain("mergeMetaFields(existing, incoming)");
    expect(branch).toContain("status: 503");
  });

  it("GET never writes the DB (no read-time backfill)", () => {
    // A DB read error used to fall through to a blob backfill that could
    // overwrite newer DB meta with the frozen blob copy. Migration happens on
    // PUT, which merges stamp-aware.
    const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PUT"));
    expect(get).not.toMatch(/dbWriteMetaGuarded|dbInsertHistory|dbInsertRecords|writeMetaGuarded/);
  });

  it("full reads hand out a cursor taken BEFORE the row queries (at-least-once)", () => {
    const read = db.slice(db.indexOf("export async function dbReadProfile("), db.indexOf("export async function dbInsertRecords"));
    expect(read.indexOf("dbNowCursor")).toBeLessThan(read.indexOf("SELECT field, value"));
    const since = db.slice(db.indexOf("export async function dbReadProfileSince"));
    expect(since.indexOf("dbNowCursor")).toBeLessThan(since.indexOf("updated_at > "));
  });
});

describe("meta writers (code)", () => {
  // Every source file that can ship, minus tests, static files, build output
  // and local tooling (worktree copies, coverage).
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", ".next", ".git", ".claude", "coverage"].includes(name)) continue;
      if (dir === root && ["tests", "public"].includes(name)) continue;
      const p = resolve(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|jsx|mjs|cjs|ts)$/.test(name)) files.push(p);
    }
  };
  walk(root);
  const rel = (p) => p.slice(root.length + 1);
  const db = readFileSync(resolve(root, "lib/db.js"), "utf8");
  const WRITE = /\b(INSERT\s+INTO|UPDATE|MERGE\s+INTO)\s+("?public"?\.)?"?meta"?\b/gi;

  it("one statement writes meta rows, and it is the guarded upsert", () => {
    const writers = files.filter((p) => readFileSync(p, "utf8").match(WRITE)).map(rel);
    expect(writers).toEqual(["lib/db.js"]);
    expect(db.match(WRITE)).toEqual(["INSERT INTO meta"]);
    const guarded = db.slice(db.indexOf("export async function dbWriteMetaGuarded"), db.indexOf("// ─── Delta sync"));
    expect(guarded).toContain("INSERT INTO meta");
    expect(guarded).toContain("WHERE COALESCE(meta.rev, 0) = ");
  });

  it("no blind meta writer is left, and only the sync PUT calls the guarded one", () => {
    // Allowed blind callers: none. The wipe (dbDeleteProfile) removes rows and
    // never writes them; every other meta access in the repo is a read.
    const BLIND = /\b(dbUpsertMetaFields|dbUpsertProfile)\b/;
    expect(files.filter((p) => BLIND.test(readFileSync(p, "utf8"))).map(rel)).toEqual([]);
    const callers = files.filter((p) => /\bdbWriteMetaGuarded\(/.test(readFileSync(p, "utf8"))).map(rel).sort();
    expect(callers).toEqual(["app/api/sync/route.js", "lib/db.js"]);
  });
});
