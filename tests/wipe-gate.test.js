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

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isTokenValid } from "../lib/auth-server.js";

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
    expect(deleteSrc).toContain("isTokenValid(tokenData, profile, Date.now())");
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
