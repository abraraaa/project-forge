// tests/sync-gate.test.js
// ─────────────────────────────────────────────────────────────────────────────
// J1 — the sync gate (boss decision 2026-07-26: FULL BIND).
//
// Before this, /api/sync asserted nothing about WHO was calling: the profile
// name was the only key, so anyone who could guess a handle could read a
// stranger's complete training history and bodyweight, and merge-write into
// it (and mergeHistories unions rather than replaces, so fabricated sessions
// could be injected permanently). The July audit raised it; the auth
// machinery built afterwards went into /api/photos and /api/bugs and never
// into the route carrying the most data.
//
// These locks pin the contract in both directions: the gate is ON for data
// verbs, and it is deliberately OFF for the two pre-identity bootstraps that
// cannot possibly carry a token.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { normaliseProfile } from "../lib/profile-name.js";

// Two accounts: sarah (storage key "sarah") and mallory. The store is mocked
// at its readers; resolveTokenIdentity and matchTokenIdentity run for real.
const SARAH = { id: "hwa_" + "s".repeat(26), storageKey: "sarah", roles: ["lifter"], plan: "free", deletedAt: null };
const MALLORY = { id: "hwa_" + "m".repeat(26), storageKey: "mallory", roles: ["lifter"], plan: "free", deletedAt: null };
const ACCOUNTS = [SARAH, MALLORY];
vi.mock("../lib/identity-store.js", () => ({
  dbGetAccount: async (id) => ACCOUNTS.find((a) => a.id === id) || null,
  dbAccountByStorageKey: async (sk) => ACCOUNTS.find((a) => a.storageKey === sk) || null,
  dbResolveHandle: async (name) => {
    const a = ACCOUNTS.find((x) => x.storageKey === normaliseProfile(name));
    return a ? { ...a, accountId: a.id, handle: a.storageKey } : null;
  },
}));
const { resolveTokenIdentity } = await import("../lib/auth-server.js");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const route = readFileSync(resolve(root, "app/api/sync/route.js"), "utf8");

// Ordering assertions must compare CODE, not prose. This route's comments
// deliberately name the very identifiers being ordered ("…mergeHistories
// unions rather than replaces…"), and a comment ABOVE the gate explaining
// the bug would otherwise read as a call BEFORE the gate — failing a lock
// that is actually satisfied. Strip line comments first; the third time a
// source-shape lock has tripped on documentation rather than behaviour.
const code = (src) =>
  src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

const section = (verb) => {
  const start = route.indexOf(`export async function ${verb}`);
  const rest = route.slice(start + 1);
  const nextExport = rest.indexOf("\nexport async function ");
  return code(nextExport === -1 ? rest : rest.slice(0, nextExport));
};

describe("the gate is ON for every verb that touches a profile's data", () => {
  it("GET gates before serving anything but the availability check", () => {
    const get = section("GET");
    const gateAt = get.indexOf("await syncGate(request, profile)");
    expect(gateAt).toBeGreaterThan(-1);
    // Every data-serving branch must sit BELOW the gate.
    for (const branch of ["dbReadProfileSince", "dbReadProfile(", "readJson(metaPath"]) {
      expect(get.indexOf(branch), branch).toBeGreaterThan(gateAt);
    }
  });

  it("PUT gates before a single byte is merged", () => {
    const put = section("PUT");
    const gateAt = put.indexOf("await syncGate(request, profile)");
    expect(gateAt).toBeGreaterThan(-1);
    for (const write of ["dbInsertHistory", "writeMetaGuarded", "mergeMeta", "mergeHistories"]) {
      expect(put.indexOf(write), write).toBeGreaterThan(gateAt);
    }
  });

  it("the gate binds the TOKEN's account to the REQUESTED profile", async () => {
    // The /api/photos contract: no seam between what was authorised and what
    // gets used. resolveTokenIdentity does the binding; the gate must call it.
    expect(route).toContain("resolveTokenIdentity(data, profile, Date.now())");
    const now = Date.now();
    const legacy = { profile: "sarah", expires: now + 1000, scope: "sync" };
    expect((await resolveTokenIdentity(legacy, "sarah", now))?.storageKey).toBe("sarah");
    expect((await resolveTokenIdentity(legacy, "SARAH", now))?.storageKey).toBe("sarah"); // normalised, not naive
    expect(await resolveTokenIdentity(legacy, "mallory", now)).toBeNull();                // the whole point
    const minted = { profile: "sarah", accountId: SARAH.id, expires: now + 1000, scope: "sync" };
    expect((await resolveTokenIdentity(minted, "sarah", now))?.accountId).toBe(SARAH.id);
    expect(await resolveTokenIdentity(minted, "mallory", now)).toBeNull();
    // A row naming one account cannot borrow another's storage key.
    expect(await resolveTokenIdentity({ ...minted, accountId: MALLORY.id }, "sarah", now)).toBeNull();
    expect(await resolveTokenIdentity({ ...legacy, expires: now - 1 }, "sarah", now)).toBeNull();
  });

  it("past the gate, GET and PUT key by the gate's storage key, never the raw param", () => {
    // Once storage keys stop being names, a re-normalised param would read and
    // write some other key than the one the gate authorised.
    for (const verb of ["GET", "PUT"]) {
      const body = section(verb);
      const after = body.slice(body.indexOf("await syncGate(request, profile)"));
      expect(after, verb).not.toContain("normalise(profile)");
      expect(after, verb).toContain("gate.profile");
    }
    expect(route).toContain("return { profile: identity.storageKey, identity, refresh };");
    // Rotation mints for the resolved account, not for a name.
    expect(route).toMatch(/mintAuthToken\(\{\s*identity, ttlMs: SYNC_TTL_MS, scope: "sync"/);
  });
});

describe("the gate is OFF, deliberately, for the two pre-identity bootstraps", () => {
  it("POST (name claim) stays open — you cannot hold a token for a profile that does not exist", () => {
    expect(section("POST")).not.toContain("syncGate");
  });

  it("GET ?check=1 answers before the gate — availability precedes identity", () => {
    const get = section("GET");
    expect(get.indexOf("exists: blobs.length > 0"))
      .toBeLessThan(get.indexOf("await syncGate(request, profile)"));
  });
});

describe("the sync cookie cannot be escalated into a wipe", () => {
  it("DELETE rejects ANY scoped token, not merely the photo scope", () => {
    const del = section("DELETE");
    // The cookie is path-scoped to /api/sync and DELETE lives on that path,
    // so the browser attaches it to wipe requests. Checking one named scope
    // would have let a 7-day sliding cookie authorise permanent destruction;
    // rejecting any scope means a scope added later is refused by default.
    expect(del).toMatch(/if \(tokenData\.scope\)/);
    expect(del).not.toMatch(/tokenData\.scope === "photos"[\s\S]{0,40}\{\s*return/);
  });
});

describe("cookie shape", () => {
  it("is httpOnly, Secure, SameSite=Strict and path-scoped to /api/sync", () => {
    expect(route).toContain('path: "/api/sync"');
    expect(route).toMatch(/httpOnly: true, secure: true, sameSite: "strict"/);
  });

  it("slides on a 30-day window; photos deliberately stay at 7", () => {
    // Boss, 2026-08-01 (supersedes the 7-day parity ruling): the daily
    // rotation only protects a device that syncs at least weekly — a
    // normal training pause (holiday, deload, illness) lapsed the cookie
    // and stranded the device in the resting state with no ceremony
    // offered. 30 days covers real absence; the 90-day absolute ceiling
    // still bounds a lost phone. Photos keep the tighter 7 — different
    // sensitivity, deliberately not parity.
    expect(route).toContain("const SYNC_TTL_MS = 30 * 86400000;");
    expect(route).toContain("maxAge: 30 * 86400");
    const photos = readFileSync(resolve(root, "app/api/photos/route.js"), "utf8");
    expect(photos).toContain("const PHOTO_TTL_MS = 7 * 86400000;");
    expect(photos).toContain("maxAge: 7 * 86400");
  });

  // The lapse above is only survivable if some tap re-auths: with a passkey
  // on file, Sync now runs the ceremony and then a FULL sync. Pinned by
  // rendering the row — tests/components/sync-cards.test.jsx.

  it("rotation stops at an absolute ceiling measured from the ORIGINAL ceremony", () => {
    // Without a cap, one captured cookie renews itself for life.
    expect(route).toContain("SYNC_ABSOLUTE_CAP_MS");
    expect(route).toContain("data.authAt");
    const auth = readFileSync(resolve(root, "lib/auth-server.js"), "utf8");
    // authAt must survive rotation — carried forward, never re-stamped.
    expect(auth).toContain("authAt: authAt || new Date().toISOString()");
  });

  it("both ceremonies mint it, so a fresh passkey syncs without a second prompt", () => {
    for (const f of ["app/api/auth/login-verify/route.js", "app/api/auth/register-verify/route.js"]) {
      const s = readFileSync(resolve(root, f), "utf8");
      expect(s, f).toContain('scope: "sync"');
      expect(s, f).toContain('res.cookies.set("hw_sync"');
    }
  });
});

describe("client: a 401 is a resting state, not a failure", () => {
  const storage = readFileSync(resolve(root, "lib/storage.js"), "utf8");

  it("every sync wire call distinguishes 401 from a real error", () => {
    expect(storage).toContain("SYNC_STATE_NEEDS_AUTH");
    // All four wire calls must branch on it.
    expect((storage.match(/SYNC_STATE_NEEDS_AUTH/g) || []).length).toBeGreaterThanOrEqual(5);
  });

  it("a 401 on push KEEPS the backlog queued — nothing is dropped for want of a cookie", () => {
    for (const fn of ["blobPush", "blobPushDelta"]) {
      const start = storage.indexOf(`export async function ${fn}(`);
      const body = storage.slice(start, start + 1400);
      const authAt = body.indexOf("authFail(res)");
      expect(authAt, fn).toBeGreaterThan(-1);
      // PQ.add must appear inside the 401 branch, before the early return.
      expect(body.slice(authAt, authAt + 220), fn).toContain("PQ.add(profile)");
    }
  });

  // The UI side (named "On this device only", painted steel, never a heat
  // colour) is pinned by rendering the card — tests/components/sync-cards.test.jsx.
});

describe("the nightly self-test proves the gate is live in the deployed build", () => {
  it("asserts an ungated read is refused, then carries a token", () => {
    const s = readFileSync(resolve(root, "app/api/cron/sync-selftest/route.js"), "utf8");
    expect(s).toContain("ungated GET is refused (J1 gate live)");
    // A token belongs to an account, so the claim (which creates it) comes
    // before the mint.
    const body = s.slice(s.indexOf("try {"), s.indexOf("} finally {"));
    expect(body.indexOf("ungated GET is refused")).toBeLessThan(body.indexOf("POST claims the name"));
    expect(body.indexOf("re-claim 409s")).toBeLessThan(body.indexOf("SELFTEST_TOKEN = await mintAuthToken"));
    expect(body).toContain("claimed-but-unwritten GET serves the claim marker");
    expect(body).not.toContain("unwritten profile GET 404s");
    expect(s).toContain("x-hw-auth");
    // Direct handler invocation uses a plain Request (no cookie jar) — the
    // header path is the only one available to it, which is the point.
    expect(s).toContain("SELFTEST_TOKEN");
  });

  it("cleans up with an UNSCOPED token, because the wipe gate refuses scopes", () => {
    // The self-test works through a sync-scoped token, but DELETE rejects any
    // scope. Reusing the working token 401'd and left the throwaway profile
    // behind on every nightly run. Cleanup mints its own unscoped one.
    const s = readFileSync(resolve(root, "app/api/cron/sync-selftest/route.js"), "utf8");
    const cleanup = s.slice(s.indexOf("SELFTEST_PROFILE_RE.test(profile)"));
    expect(cleanup).toMatch(/mintAuthToken\(\{\s*profile,\s*ttlMs:\s*\d+\s*\}\)/);
    // ...and that mint must not smuggle a scope back in.
    const mintCall = cleanup.slice(cleanup.indexOf("mintAuthToken"), cleanup.indexOf("syncDELETE"));
    expect(mintCall).not.toContain("scope");
  });
});
