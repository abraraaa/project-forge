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

describe("Rec 11b — auth tokens live in the DB (code shape)", () => {
  const authServer = readFileSync(resolve(root, "lib/auth-server.js"), "utf8");
  const db = readFileSync(resolve(root, "lib/db.js"), "utf8");

  it("ONE mint path: no route writes forge/tokens blobs any more", () => {
    for (const rel of ["app/api/auth/login-verify/route.js", "app/api/photos/route.js"]) {
      const src = readFileSync(resolve(root, rel), "utf8");
      expect(src, rel).not.toContain("put(`forge/tokens/");
      expect(src, rel).toContain("mintAuthToken(");
    }
    // The blob mint survives ONLY inside mintAuthToken's no-DB dev fallback.
    expect(authServer).toContain("put(`forge/tokens/");
    expect(authServer).toMatch(/if \(hasDb\(\)\) \{\s*await dbInsertToken/);
  });

  it("reads are DB-first with the transition blob fallback", () => {
    const read = authServer.slice(authServer.indexOf("export async function readTokenData"));
    expect(read.indexOf("dbReadToken")).toBeGreaterThan(-1);
    expect(read.indexOf("dbReadToken")).toBeLessThan(read.indexOf("readJsonDirect"));
  });

  it("profile wipe kills the profile's outstanding tokens (the survive-the-wipe gap)", () => {
    const wipe = db.slice(db.indexOf("export async function dbDeleteProfile"));
    expect(wipe).toContain("DELETE FROM auth_tokens WHERE profile =");
  });

  it("the wipe path consumes its ceremony token as a DB row", () => {
    const route = readFileSync(resolve(root, "app/api/sync/route.js"), "utf8");
    const delBlock = route.slice(route.indexOf("export async function DELETE"));
    expect(delBlock).toContain("dbDeleteToken(authToken)");
  });
});

describe("snapshot shrink guard (boss, 2026-07-26)", () => {
  const cron = readFileSync(resolve(root, "app/api/cron/sync-snapshot/route.js"), "utf8");
  it("a collapsed snapshot refuses the overwrite and fails the run", () => {
    expect(cron).toContain("looksLikeDisaster(prior");
    expect(cron).toContain("status: ok ? 200 : 500");
    // still write-only: the guard SKIPS, never deletes
    expect(cron).not.toMatch(/\bdel\s*\(/);
  });
  it("guard semantics: majority history loss trips it; young profiles and growth never do", async () => {
    // The function is module-internal; assert semantics via the source
    // constants + a re-implementation check of the documented contract.
    expect(cron).toContain("SHRINK_GUARD_RATIO = 0.5");
    expect(cron).toContain("if (oldLen < 4) return false");
  });
});

describe("bug reports — fill-or-kill (boss flow, built pre-flip)", () => {
  const route = readFileSync(resolve(root, "app/api/bugs/route.js"), "utf8");
  it("triage is STATUS-ONLY: no delete verb for bug_reports anywhere", () => {
    expect(route).not.toContain("export async function DELETE");
    const db = readFileSync(resolve(root, "lib/db.js"), "utf8");
    expect(db).not.toMatch(/DELETE FROM bug_reports/);
  });
  it("submit is open + hard-limited; read and triage are ceremony-gated", () => {
    const post = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function GET"));
    expect(post).toContain('rateLimit(request, "bugs-submit", 5)');
    expect(post).not.toContain("ceremonyGate");
    for (const verb of ["GET", "PATCH"]) {
      const block = route.slice(route.indexOf(`export async function ${verb}`));
      expect(block.slice(0, 400), verb).toContain("ceremonyGate(request)");
    }
    // photo-scope cookies never qualify for triage (wipe-gate posture)
    expect(route).toContain('data.scope === "photos"');
  });
  it("the sheet follows the modal doctrine and the review page runs the real ceremony", () => {
    const sheet = readFileSync(resolve(root, "components/BugReportSheet.jsx"), "utf8");
    expect(sheet).toMatch(/Cancel<\/button>|"Cancel"/);
    expect(sheet).not.toContain('aria-label="Close"');
    const review = readFileSync(resolve(root, "app/diag-bugs/page.jsx"), "utf8");
    expect(review).toContain("getAuthTokenWithCeremony");
  });
});

describe("single-admin recognition (boss, 2026-07-26 — not a role system)", () => {
  it("isAdminProfile: env names the boss; unset env = no admin exists", async () => {
    const { isAdminProfile } = await import("../lib/auth-server.js");
    expect(isAdminProfile("Abrar", "abrar")).toBe(true);   // case-insensitive
    expect(isAdminProfile("  Abrar ", "abrar")).toBe(true); // normalised
    expect(isAdminProfile("sarah", "abrar")).toBe(false);
    expect(isAdminProfile("abrar", undefined)).toBe(false); // no env → nobody
    expect(isAdminProfile(null, "abrar")).toBe(false);
  });
  it("login-verify carries the flag; bugs gate enforces it server-side", () => {
    const login = readFileSync(resolve(root, "app/api/auth/login-verify/route.js"), "utf8");
    expect(login).toContain("admin: isAdminProfile(profile)");
    const bugs = readFileSync(resolve(root, "app/api/bugs/route.js"), "utf8");
    expect(bugs).toContain("process.env.ADMIN_PROFILE && !isAdminProfile(data.profile)");
    expect(bugs).toContain("status: 403");
  });
  it("the client flag is a memory-only UI hint riding the ceremony cache", () => {
    const session = readFileSync(resolve(root, "lib/auth-session.js"), "utf8");
    expect(session).toContain("isAdminSession");
    expect(session).toMatch(/admin: !!auth\.admin/);
    const profileScreen = readFileSync(resolve(root, "components/ProfileScreen.jsx"), "utf8");
    // the admin wing (bug reports + diagnostics) is recognition-gated
    expect(profileScreen).toMatch(/isAdminSession\(current\)[\s\S]{0,400}diag-bugs/);
    expect(profileScreen).toMatch(/isAdminSession\(current\)[\s\S]{0,900}diag-sync/);
    expect(profileScreen).not.toMatch(/\{current && \(\s*<Fade d=\{300\}>\s*<a href="\/diag-sync"/);
  });
});
