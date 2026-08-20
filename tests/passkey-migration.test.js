// tests/passkey-migration.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The theforged.fit → heatwayve.app passkey migration (boss ruling, 2026-08-18:
// a 90-day window, then the old domain is not renewed).
//
// The invariant that matters most is the one WebAuthn enforces and we cannot
// see fail in a unit test: A CEREMONY IS SINGLE-rpId. Offer a credential bound
// to a different rpId than the one declared and the authenticator cannot
// satisfy the prompt — the user spends a Face ID and gets an error. So every
// test below that touches planLoginCeremony checks BOTH halves of the answer
// agree, not just that it returned something.
//
// The second invariant: an rpId is never inferred. It is read back from what
// the library cryptographically matched, because guessing it is precisely the
// class of bold assumption that has cost us before.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  rpConfigFromRequest, planLoginCeremony, credentialRpId,
} from "../lib/auth-server.js";
import {
  NATIVE_RP_ID, LEGACY_RP_ID, PASSKEY_SUNSET,
  acceptedRpIds, legacyRpRetired, passkeyNudgeUrgent, daysUntilPasskeySunset,
} from "../lib/origin.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(resolve(root, p), "utf8");

const req = (host) => /** @type {any} */ ({ headers: { get: (k) => (k === "host" ? host : null) } });
const at = (d) => new Date(`${d}T12:00:00`).getTime();
const cred = (id, rpId, extra = {}) => ({ id, publicKey: "k", ...(rpId ? { rpId } : null), ...extra });

describe("migration timeline", () => {
  it("accepts both rpIds during the window and only the native one after", () => {
    expect(acceptedRpIds(at("2026-08-18"))).toEqual([NATIVE_RP_ID, LEGACY_RP_ID]);
    expect(acceptedRpIds(at("2026-11-15"))).toEqual([NATIVE_RP_ID, LEGACY_RP_ID]);
    expect(acceptedRpIds(at("2026-11-16"))).toEqual([NATIVE_RP_ID]);
  });

  it("retires on the sunset date, not before", () => {
    expect(legacyRpRetired(at("2026-11-15"))).toBe(false);
    expect(legacyRpRetired(at("2026-11-16"))).toBe(true);
  });

  it("turns the nudge urgent for the final 30 days only", () => {
    expect(passkeyNudgeUrgent(at("2026-10-16"))).toBe(false);
    expect(passkeyNudgeUrgent(at("2026-10-18"))).toBe(true);
    expect(passkeyNudgeUrgent(at("2026-11-15"))).toBe(true);
    // Past the sunset there is nothing left to nudge about.
    expect(passkeyNudgeUrgent(at("2026-11-17"))).toBe(false);
  });

  it("counts down and never goes negative", () => {
    expect(daysUntilPasskeySunset(at("2026-08-18"))).toBe(90);
    expect(daysUntilPasskeySunset(at("2026-12-25"))).toBe(0);
  });

  it("the window is 90 days from the ruling", () => {
    expect(PASSKEY_SUNSET).toBe("2026-11-16");
    expect(daysUntilPasskeySunset(at("2026-08-18"))).toBe(90);
  });
});

describe("rp config — which rpId a NEW credential is minted under", () => {
  it("mints native from a heatwayve origin", () => {
    for (const host of ["heatwayve.app", "www.heatwayve.app"]) {
      const c = rpConfigFromRequest(req(host), at("2026-08-18"));
      expect(c.rpId).toBe(NATIVE_RP_ID);
      expect(c.expectedOrigin).toBe(`https://${host}`);
    }
  });

  it("mints legacy from the legacy origin — the browser would reject native there", () => {
    // No reverse Related Origin Requests document is served at heatwayve.app,
    // so a ceremony genuinely on theforged.fit cannot claim the native rpId.
    const c = rpConfigFromRequest(req(LEGACY_RP_ID), at("2026-08-18"));
    expect(c.rpId).toBe(LEGACY_RP_ID);
  });

  it("stops minting legacy once the domain is retired", () => {
    expect(rpConfigFromRequest(req(LEGACY_RP_ID), at("2026-12-01")).rpId).toBe(NATIVE_RP_ID);
  });

  it("keeps localhost isolated from migration semantics", () => {
    const c = rpConfigFromRequest(req("localhost:3000"), at("2026-08-18"));
    expect(c).toMatchObject({ rpId: "localhost", expectedOrigin: "http://localhost:3000" });
    expect(c.acceptedRpIds).toEqual(["localhost"]);
  });

  it("pins expectedOrigin to one exact string even though the library allows a list", () => {
    // Only the rpId dimension is widened: the credential's rpId is unknown
    // until verification matches it, but the origin is known exactly.
    expect(typeof rpConfigFromRequest(req("heatwayve.app")).expectedOrigin).toBe("string");
  });

  it("fails an unknown host toward a live origin it cannot match", () => {
    const c = rpConfigFromRequest(req("evil.example"), at("2026-08-18"));
    expect(c.expectedOrigin).toBe(`https://${NATIVE_RP_ID}`);
  });
});

describe("credentialRpId — absent means legacy, not unknown", () => {
  it("reads a field-less credential as legacy", () => {
    expect(credentialRpId({ id: "a", publicKey: "k" })).toBe(LEGACY_RP_ID);
    expect(credentialRpId({ id: "a", publicKey: "k", rpId: "" })).toBe(LEGACY_RP_ID);
  });
  it("respects a stored rpId", () => {
    expect(credentialRpId({ rpId: NATIVE_RP_ID })).toBe(NATIVE_RP_ID);
  });
});

describe("planLoginCeremony — one rpId, and only its own credentials", () => {
  const cfgNative = (now = at("2026-08-18")) => rpConfigFromRequest(req("heatwayve.app"), now);

  // The load-bearing assertion, applied to every plan this suite produces.
  const assertCoherent = (plan) => {
    expect(plan).not.toBeNull();
    const ids = new Set(plan.credentials.map((c) => credentialRpId(c)));
    expect([...ids]).toEqual([plan.rpId]);
  };

  it("prefers the native pool when the profile holds one", () => {
    const plan = planLoginCeremony(
      { credentials: [cred("legacy-1"), cred("native-1", NATIVE_RP_ID)] },
      cfgNative(),
    );
    assertCoherent(plan);
    expect(plan.rpId).toBe(NATIVE_RP_ID);
    expect(plan.credentials.map((c) => c.id)).toEqual(["native-1"]);
  });

  it("never mixes pools, however many credentials there are", () => {
    const plan = planLoginCeremony(
      {
        credentials: [
          cred("l1"), cred("l2"), cred("l3"),
          cred("n1", NATIVE_RP_ID), cred("n2", NATIVE_RP_ID),
        ],
      },
      cfgNative(),
    );
    assertCoherent(plan);
    expect(plan.credentials).toHaveLength(2);
  });

  it("falls back to the legacy pool while the window is open", () => {
    const plan = planLoginCeremony({ credentials: [cred("l1"), cred("l2")] }, cfgNative());
    assertCoherent(plan);
    expect(plan.rpId).toBe(LEGACY_RP_ID);
  });

  it("returns null for a legacy-only profile once the domain is retired", () => {
    // Not an error state — the client reads it as "no passkey" and re-offers
    // setup, which is how the holder mints a native one.
    const now = at("2026-12-01");
    expect(planLoginCeremony({ credentials: [cred("l1")] }, cfgNative(now))).toBeNull();
  });

  it("still logs in a profile that upgraded, after the sunset", () => {
    const now = at("2026-12-01");
    const plan = planLoginCeremony(
      { credentials: [cred("l1"), cred("n1", NATIVE_RP_ID)] },
      cfgNative(now),
    );
    assertCoherent(plan);
    expect(plan.rpId).toBe(NATIVE_RP_ID);
  });

  it("never offers a keyless credential", () => {
    // No signature can be checked against one, so a ceremony using it fails
    // AFTER costing the user a prompt.
    const plan = planLoginCeremony(
      { credentials: [{ id: "keyless" }, cred("n1", NATIVE_RP_ID)] },
      cfgNative(),
    );
    assertCoherent(plan);
    expect(plan.credentials.map((c) => c.id)).toEqual(["n1"]);
  });

  it("returns null when every credential is keyless", () => {
    expect(planLoginCeremony({ credentials: [{ id: "a" }, { id: "b" }] }, cfgNative())).toBeNull();
  });

  it("is empty- and null-safe", () => {
    expect(planLoginCeremony(null, cfgNative())).toBeNull();
    expect(planLoginCeremony({ credentials: [] }, cfgNative())).toBeNull();
  });
});

describe("the routes read the rpId back rather than assuming it", () => {
  it("both verify routes accept the rpId SET, not a single guess", () => {
    for (const p of ["app/api/auth/register-verify/route.js", "app/api/auth/login-verify/route.js"]) {
      expect(src(p)).toContain("expectedRPID: acceptedRpIds");
    }
  });

  it("register-verify stores the rpId the library matched", () => {
    expect(src("app/api/auth/register-verify/route.js"))
      .toContain("verification.registrationInfo.rpID");
  });

  it("login-verify backfills from the verified assertion, not from config", () => {
    const s = src("app/api/auth/login-verify/route.js");
    expect(s).toContain("verification.authenticationInfo.rpID");
    // The backfill rides the existing counter write — one write, not two.
    expect(s.match(/writeJsonReplacingPrefix\(/g) || []).toHaveLength(1);
  });

  it("no auth route hardcodes the legacy domain any more", () => {
    for (const p of [
      "app/api/auth/register-options/route.js",
      "app/api/auth/login-options/route.js",
      "app/api/auth/register-verify/route.js",
      "app/api/auth/login-verify/route.js",
    ]) {
      expect(src(p)).not.toMatch(/"theforged\.fit"/);
    }
  });

  it("login-options declares the planned rpId and offers only its credentials", () => {
    const s = src("app/api/auth/login-options/route.js");
    expect(s).toContain("rpId: plan.rpId");
    expect(s).toContain("plan.credentials.map");
    // The old shape offered every stored credential regardless of rpId.
    expect(s).not.toContain("credData.credentials.map");
  });
});
