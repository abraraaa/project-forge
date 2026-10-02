// tests/wipe-gate.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The DELETE /api/sync wipe gate. Deletion here is irreversible — blobs, DB
// rows, snapshots and progress photos — so this is wipe-protocol territory and
// the locks are deliberately blunt and stay forever.
//
// The invariants, stated positively. Each must hold on every future edit:
//   1. The gate resolves its credential through the shared, encoding-safe
//      helper against the one authoritative store — never a route-local read
//      built from caller-supplied text.
//   2. Validity is a positive assertion (correct shape, correct type, correct
//      profile), never the absence of a failure.
//   3. Proof of control is required UNCONDITIONALLY. There is no branch in
//      which the destructive path runs without it; a profile that cannot yet
//      prove control gets a recoverable prompt, not a deletion.
//   4. The guard precedes every destructive call, with nothing between.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isTokenValid, resolveTokenIdentity } from "../lib/auth-server.js";
import { dbGetAccount, dbAccountByStorageKey, dbResolveHandle } from "../lib/identity-store.js";

// A live account for "sarah" exists, so a refusal below can only come from
// the record's shape, never from a missing account.
vi.mock("../lib/identity-store.js", () => {
  const sarah = { id: "hwa_" + "s".repeat(26), storageKey: "sarah", roles: ["lifter"], plan: "free", deletedAt: null };
  return {
    dbGetAccount: vi.fn(async () => sarah),
    dbAccountByStorageKey: vi.fn(async () => sarah),
    dbResolveHandle: vi.fn(async () => ({ ...sarah, accountId: sarah.id, handle: "sarah" })),
  };
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const routeSrc = readFileSync(resolve(root, "app/api/sync/route.js"), "utf8");
const deleteSrc = routeSrc.slice(routeSrc.indexOf("export async function DELETE"));

describe("wipe gate — credential resolution is safe and positive", () => {
  it("never builds a storage path from raw credential text", () => {
    // Credential text must never be interpolated raw into a storage path.
    expect(deleteSrc).not.toMatch(/`forge\/tokens\/\$\{authToken\}`/);
    // Any token path in the wipe path must encode.
    for (const use of deleteSrc.match(/`forge\/tokens\/[^`]*`/g) || []) {
      expect(use).toContain("encodeURIComponent(authToken)");
    }
  });

  it("the gate resolves the token through the shared, encoding reader", () => {
    // readTokenData encodes, and reads the same store mintAuthToken writes
    // to. Mint and read must never disagree about which store is authoritative.
    expect(deleteSrc).toContain("await readTokenData(authToken)");
    expect(deleteSrc).toContain("resolveTokenIdentity(tokenData, profile, Date.now())");
  });

  it("rejects a structurally-similar object that is not a minted token", () => {
    // A plausible-looking object that is NOT a minted credential: validity
    // must not fall out of mere structural resemblance.
    const snapshotAsToken = {
      profile: "sarah",
      snappedAt: "2026-07-26T03:00:00.000Z",
      meta: {},
      history: [],
    };
    // Expiry must be asserted positively. A comparison against a missing
    // value is not a rejection, so the type check is the thing that matters:
    expect(Date.now() > snapshotAsToken.expires).toBe(false);
    // isTokenValid requires expires to BE a number.
    expect(isTokenValid(snapshotAsToken, "sarah", Date.now())).toBe(false);
  });

  it("the gate's own predicate refuses it on shape, before any lookup", async () => {
    const snapshotAsToken = { profile: "sarah", snappedAt: "2026-07-26T03:00:00.000Z", meta: {}, history: [] };
    expect(await resolveTokenIdentity(snapshotAsToken, "sarah", Date.now())).toBeNull();
    expect(await resolveTokenIdentity({ ...snapshotAsToken, expires: "9999999999999" }, "sarah", Date.now())).toBeNull();
    for (const reader of [dbGetAccount, dbAccountByStorageKey, dbResolveHandle]) expect(reader).not.toHaveBeenCalled();
    // The same record with a numeric expiry does resolve: the refusal above was the shape rule.
    expect(await resolveTokenIdentity({ ...snapshotAsToken, expires: Date.now() + 60_000 }, "sarah", Date.now())).toMatchObject({ storageKey: "sarah" });
  });

  it("isTokenValid still accepts a genuine, unexpired, correctly-bound token", () => {
    const now = Date.now();
    const real = { profile: "sarah", expires: now + 3600_000, scope: null };
    expect(isTokenValid(real, "sarah", now)).toBe(true);
    expect(isTokenValid(real, "SARAH", now)).toBe(true);          // normalised
    expect(isTokenValid(real, "mallory", now)).toBe(false);        // bound
    expect(isTokenValid({ ...real, expires: now - 1 }, "sarah", now)).toBe(false);
  });
});

describe("wipe gate — fails closed, always", () => {
  it("the credential check is unconditional and precedes every destructive call", () => {
    // Proof of control is unconditional — no branch may skip the auth block.
    expect(deleteSrc).not.toMatch(/if\s*\(\s*hasPasskeys\s*\)\s*\{/);
    // An absent token is refused before anything destructive is reached.
    const tokenGuard = deleteSrc.indexOf("if (!authToken)");
    expect(tokenGuard).toBeGreaterThan(-1);
    const scopeGuard = deleteSrc.indexOf("if (tokenData.scope)");
    expect(scopeGuard).toBeGreaterThan(tokenGuard);
    for (const destructive of ["dbDeleteToken(", "del(photoBlobs)", "dbDeleteProfile", "snapshotPaths(", "del(junk.map", "dbCloseAccount("]) {
      expect(deleteSrc.indexOf(destructive), destructive).toBeGreaterThan(scopeGuard);
    }
  });

  it("everything after the gate keys by the resolved account, never the requested name", () => {
    const body = deleteSrc.slice(deleteSrc.indexOf("if (tokenData.scope)"));
    expect(body).toContain("const sk = id.storageKey;");
    expect(body).not.toMatch(/normalise\(profile\)/);
    // The interim refusal of id-keyed accounts is gone: the wipe reaches them.
    expect(deleteSrc).not.toContain("cannot be deleted yet");
  });

  it("photos go by the account's own index rows, read before the rows are deleted", () => {
    const rowsRead = deleteSrc.indexOf("await dbListPhotos(sk)");
    expect(rowsRead).toBeGreaterThan(-1);
    expect(deleteSrc).toContain(".filter((p) => typeof p === \"string\" && p.startsWith(photosPrefix(sk)))");
    expect(deleteSrc.indexOf("del(photoBlobs)")).toBeGreaterThan(rowsRead);
    expect(deleteSrc.indexOf("dbDeleteProfile(sk)")).toBeGreaterThan(deleteSrc.indexOf("del(photoBlobs)"));
  });

  it("the folder sweep deletes only enumerated file patterns, and the close runs last", () => {
    // No unconditional prefix delete: every listed blob is matched first.
    expect(deleteSrc).not.toMatch(/del\(blobs\.map|del\(listed/);
    expect(deleteSrc).toContain("WIPE_FILE_RES.some((re) => re.test(b.pathname.slice(dir.length)))");
    const res = routeSrc.slice(routeSrc.indexOf("const WIPE_FILE_RES = ["));
    expect(res.slice(0, res.indexOf("];")).split("\n").slice(1).map((l) => l.trim()).filter(Boolean)).toEqual([
      "/^meta\\.json$/,",
      "/^history\\.json$/,",
      "/^meta-[^/]+\\.json$/,",
      "/^history-[^/]+\\.json$/,",
      "/^credentials[^/]*\\.json$/,",
    ]);
    const close = deleteSrc.indexOf("dbCloseAccount(id.accountId, sk)");
    for (const step of ["del(photoBlobs)", "dbDeleteProfile(sk)", "del([snaps.daily, snaps.weekly])", "del(junk.map"]) {
      expect(deleteSrc.indexOf(step), step).toBeLessThan(close);
    }
  });

  it("the close only UPDATEs grants, handles and accounts, and deletes only the account's credentials rows", () => {
    const store = readFileSync(resolve(root, "lib/identity-store.js"), "utf8");
    const fn = store.slice(store.indexOf("export async function dbCloseAccount"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect([...body.matchAll(/\b(UPDATE|DELETE FROM|INSERT INTO) (\w+)/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
      "UPDATE oauth_grants", "UPDATE handles", "UPDATE accounts", "DELETE FROM credentials",
    ]);
    expect(body).toContain("DELETE FROM credentials WHERE account_id = ${accountId}`");
  });

  it("repo-wide, no code deletes account or handle rows", () => {
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = resolve(dir, e.name);
      return e.isDirectory() ? walk(p) : /\.(js|jsx|mjs)$/.test(e.name) ? [p] : [];
    });
    const files = [...walk(resolve(root, "lib")), ...walk(resolve(root, "app"))];
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/DELETE\s+FROM\s+(accounts|handles)\b/i);
  });

  it("a passkey-less profile is told to set one up, not silently wiped", () => {
    expect(deleteSrc).toContain("requiresPasskeySetup");
  });

  it("NO scoped token ever satisfies the wipe gate (strengthened by J1)", () => {
    expect(deleteSrc).toMatch(/if \(tokenData\.scope\)/);
    const now = Date.now();
    // isTokenValid is scope-blind by design, so the route must check scope
    // itself — assert the shape rather than assuming the helper covers it.
    expect(isTokenValid({ profile: "sarah", expires: now + 1000, scope: "photos" }, "sarah", now)).toBe(true);
  });
});

describe("diag inventory route — authorization required, fails closed", () => {
  it("requires the operator bearer and fails closed when unset", () => {
    const s = readFileSync(resolve(root, "app/api/diag/db-import/route.js"), "utf8");
    expect(s).toContain('request.headers.get("authorization")');
    expect(s).toContain("process.env.CRON_SECRET");
    expect(s).toContain("Bearer ${cronSecret}");
    // Fail-closed on missing env, matching the cron routes: an unconfigured
    // deployment refuses rather than opens.
    expect(s).toMatch(/if \(!cronSecret\)[\s\S]{0,120}status: 500/);
    // The auth check must precede the census itself.
    expect(s.indexOf("Unauthorized")).toBeLessThan(s.indexOf('prefix: "forge/profiles/"'));
    // And it must still hold no delete authority (wipe protocol rule 4).
    expect(s).not.toMatch(/\bdel\s*\(|DROP |DELETE FROM/);
  });
});
