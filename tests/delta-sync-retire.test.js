// tests/delta-sync-retire.test.js
// ─────────────────────────────────────────────────────────────────────────────
// PR C locks (#2 family — docs/delta-sync.md, dual-write retirement).
//   - fat PUT is DB-first: no meta/history blob writes in the DB branch
//   - snapshot cron is WRITE-ONLY by construction (zero delete authority)
//   - profile DELETE covers the snapshot generations (enumerated paths)
//   - mergeMeta unknown-field passthrough (#8) — unknowns survive round-trips
//   - the class-2 deferral tier is gone (#3)
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mergeMeta } from "../lib/sync-merge.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("#8 — mergeMeta unknown-field passthrough", () => {
  it("unknown fields survive the merge: union, remote wins where both carry it", () => {
    const merged = mergeMeta(
      { streak: { count: 3, lastDate: "2026-07-01" }, futureStoreA: { a: 1 }, sharedNew: "local" },
      { sharedNew: "remote", futureStoreB: [1, 2, 3] },
    );
    expect(merged.futureStoreA).toEqual({ a: 1 });   // local-only unknown kept
    expect(merged.futureStoreB).toEqual([1, 2, 3]);  // remote-only unknown kept
    expect(merged.sharedNew).toBe("remote");         // remote wins the tie
    expect(merged.streak.count).toBe(3);             // ruled keys still ruled
  });

  it("is idempotent for unknowns (change-detection contract)", () => {
    const m = { streak: { count: 1, lastDate: "2026-07-01" }, mystery: { x: 1 } };
    const once = mergeMeta(m, m);
    expect(once.mystery).toEqual({ x: 1 });
    expect(mergeMeta(once, once).mystery).toEqual({ x: 1 });
  });
});

describe("PR C code shapes", () => {
  const route = readFileSync(resolve(root, "app/api/sync/route.js"), "utf8");
  const cron = readFileSync(resolve(root, "app/api/cron/sync-snapshot/route.js"), "utf8");
  const storage = readFileSync(resolve(root, "lib/storage.js"), "utf8");

  it("fat PUT DB branch writes NO blobs (dual-write retired)", () => {
    const dbBranch = route.slice(
      route.indexOf("DUAL-WRITE RETIRED"),
      route.indexOf("Legacy blob path"),
    );
    expect(dbBranch).toContain("dbUpsertProfile(norm");
    expect(dbBranch).not.toContain("await put(");
    // unmigrated profiles still seed their merge base from blobs, guarded
    expect(dbBranch).toContain("blobExists(metaPath(profile))");
    expect(dbBranch).toContain("readLatestLegacy");
  });

  it("snapshot cron: Bearer-gated, both generations, and ZERO delete authority", () => {
    expect(cron).toContain("Bearer ${cronSecret}");
    expect(cron).toContain("forge/snapshots/daily/");
    expect(cron).toContain("forge/snapshots/weekly/");
    expect(cron).toContain("allowOverwrite: true");
    // The whole point: no delete exists in this file, not even imported.
    expect(cron).not.toMatch(/\bdel\s*\(/);
    expect(cron).not.toMatch(/import \{[^}]*\bdel\b[^}]*\}/);
  });

  it("the cron is scheduled", () => {
    const vercel = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8"));
    expect(vercel.crons.some((c) => c.path === "/api/cron/sync-snapshot")).toBe(true);
  });

  it("profile DELETE removes the snapshot generations — exact enumerated paths", () => {
    const delBlock = route.slice(route.indexOf("export async function DELETE"));
    expect(delBlock).toContain("forge/snapshots/daily/${enc}.json");
    expect(delBlock).toContain("forge/snapshots/weekly/${enc}.json");
  });

  it("#3 — the class-2 deferral tier is gone", () => {
    expect(storage).not.toContain("pushDeferred");
    expect(storage).not.toContain("deferredPushProfiles");
    expect(storage).toContain("flushOnLifecycle");
  });
});
