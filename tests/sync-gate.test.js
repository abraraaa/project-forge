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

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isTokenValid } from "../lib/auth-server.js";

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
    for (const write of ["dbUpsertProfile", "mergeMeta", "mergeHistories"]) {
      expect(put.indexOf(write), write).toBeGreaterThan(gateAt);
    }
  });

  it("the gate compares the TOKEN's profile to the REQUESTED profile", () => {
    // The /api/photos contract: no seam between what was authorised and what
    // gets used. isTokenValid does the binding; the gate must call it.
    expect(route).toContain("isTokenValid(data, profile, Date.now())");
    const now = Date.now();
    const t = { profile: "sarah", expires: now + 1000, scope: "sync" };
    expect(isTokenValid(t, "sarah", now)).toBe(true);
    expect(isTokenValid(t, "SARAH", now)).toBe(true);   // normalised, not naive
    expect(isTokenValid(t, "mallory", now)).toBe(false); // the whole point
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

  it("slides on a 7-day window, matching hw_photos", () => {
    // Boss, 2026-07-26: window length is not a UX dial — any active day
    // rotates it, so a trusted device never re-auths regardless. A longer
    // window only gives a LOST phone more days. Keep parity with the photo
    // cookie rather than inventing a second policy.
    expect(route).toContain("const SYNC_TTL_MS = 7 * 86400000;");
    expect(route).toContain("maxAge: 7 * 86400");
    const photos = readFileSync(resolve(root, "app/api/photos/route.js"), "utf8");
    expect(photos).toContain("const PHOTO_TTL_MS = 7 * 86400000;");
  });

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

  it("the UI names it honestly and does not paint it as an alarm", () => {
    const cards = readFileSync(resolve(root, "components/sync-cards.jsx"), "utf8");
    expect(cards).toContain("On this device only");
    expect(cards).toMatch(/needsAuth: T\.steel/);   // never T.coral
  });
});

describe("the nightly self-test proves the gate is live in the deployed build", () => {
  it("asserts an ungated read is refused, then carries a token", () => {
    const s = readFileSync(resolve(root, "app/api/cron/sync-selftest/route.js"), "utf8");
    expect(s).toContain("ungated GET is refused (J1 gate live)");
    expect(s).toContain("x-hw-auth");
    // Direct handler invocation uses a plain Request (no cookie jar) — the
    // header path is the only one available to it, which is the point.
    expect(s).toContain("SELFTEST_TOKEN");
  });
});
