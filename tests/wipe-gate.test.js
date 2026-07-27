// tests/wipe-gate.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The DELETE /api/sync wipe gate — locks shut the two holes the 2026-07-26
// deep audit found in it. Both were reachable by an ANONYMOUS caller and both
// ended in the same place: irreversible destruction of a profile's blobs, DB
// rows, snapshots and progress photos. This is the wipe protocol's own
// territory, so the locks are deliberately blunt and stay forever.
//
//  HOLE 1 — TRAVERSAL. The gate read its token with a route-local blob helper
//  via `forge/tokens/${authToken}`, raw and unencoded. The SDK interpolates a
//  pathname straight into a URL string and fetch() collapses `../`, so
//  `authToken=../snapshots/daily/<name>.json` aimed the "token" read at that
//  profile's own snapshot — a file the app itself writes, guaranteed to exist,
//  and whose shape satisfied every check the gate then performed.
//
//  HOLE 2 — NO-PASSKEY PASS-THROUGH. The gate ran only `if (hasPasskeys)`, so
//  a profile with no verifiable credential was deletable by anyone who could
//  name it — and /api/auth/check tells any caller which profiles those are.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isTokenValid } from "../lib/auth-server.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const routeSrc = readFileSync(resolve(root, "app/api/sync/route.js"), "utf8");
const deleteSrc = routeSrc.slice(routeSrc.indexOf("export async function DELETE"));

describe("wipe gate — traversal (the snapshot-as-token forgery)", () => {
  it("the DELETE gate never builds a blob path from a raw authToken", () => {
    // The exact shape of the bug: an unencoded token interpolated into a path.
    expect(deleteSrc).not.toMatch(/`forge\/tokens\/\$\{authToken\}`/);
    // Any token path in the wipe path must encode.
    for (const use of deleteSrc.match(/`forge\/tokens\/[^`]*`/g) || []) {
      expect(use).toContain("encodeURIComponent(authToken)");
    }
  });

  it("the gate resolves the token through the shared, encoding reader", () => {
    // readTokenData encodes AND reads the same store mintAuthToken writes to.
    // The old route-local blob read was both forgeable and (post-Rec-11b)
    // blind to every DB-minted token, so real wipes 401'd while the forgery
    // sailed through — the lock rejected the key and admitted the crowbar.
    expect(deleteSrc).toContain("await readTokenData(authToken)");
    expect(deleteSrc).toContain("isTokenValid(tokenData, profile, Date.now())");
  });

  it("isTokenValid rejects a snapshot blob masquerading as a token", () => {
    // This is the forged object, verbatim in shape: what the snapshot cron
    // writes at forge/snapshots/daily/<profile>.json.
    const snapshotAsToken = {
      profile: "sarah",
      snappedAt: "2026-07-26T03:00:00.000Z",
      meta: {},
      history: [],
    };
    // The old inline check was `Date.now() > tokenData.expires`, and
    // `Date.now() > undefined` is false — a NaN comparison is not a rejection.
    // Proving the trap still bites, so nobody re-introduces the bare compare:
    expect(Date.now() > snapshotAsToken.expires).toBe(false);
    // isTokenValid requires expires to BE a number, which is what kills it.
    expect(isTokenValid(snapshotAsToken, "sarah", Date.now())).toBe(false);
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
  it("no passkey no longer means no gate: the token check is unconditional", () => {
    // The bug was a conditional wrapper around the whole auth block.
    expect(deleteSrc).not.toMatch(/if\s*\(\s*hasPasskeys\s*\)\s*\{/);
    // An absent token is refused before anything destructive is reached.
    const tokenGuard = deleteSrc.indexOf("if (!authToken)");
    expect(tokenGuard).toBeGreaterThan(-1);
    for (const destructive of ["dbDeleteProfile", "forge/snapshots/daily/", "del(blobs.map"]) {
      expect(deleteSrc.indexOf(destructive)).toBeGreaterThan(tokenGuard);
    }
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

describe("diag census — no longer an anonymous namespace dump", () => {
  it("db-import requires the CRON_SECRET bearer and fails closed when unset", () => {
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
