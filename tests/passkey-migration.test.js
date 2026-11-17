// Passkeys verify against heatwayve.app only. A credential bound to
// theforged.fit (or with no rpId field) stays on file and is never usable.
// A ceremony is single-rpId, so a plan's declared rpId and its offered
// credentials must always agree.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  rpConfigFromRequest, planLoginCeremony, credentialRpId, hasUsablePasskey,
} from "../lib/auth-server.js";
import { NATIVE_RP_ID, LEGACY_RP_ID, acceptedRpIds } from "../lib/origin.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(resolve(root, p), "utf8");

const req = (host) => /** @type {any} */ ({ headers: { get: (k) => (k === "host" ? host : null) } });
const cred = (id, rpId, extra = {}) => ({ id, publicKey: "k", ...(rpId ? { rpId } : null), ...extra });

describe("accepted rpIds", () => {
  it("is the native id alone", () => {
    expect(acceptedRpIds()).toEqual([NATIVE_RP_ID]);
  });

  it("a legacy credential, labelled or not, is never usable", () => {
    expect(hasUsablePasskey({ credentials: [cred("l1")] })).toBe(false);
    expect(hasUsablePasskey({ credentials: [cred("l2", LEGACY_RP_ID)] })).toBe(false);
    expect(hasUsablePasskey({ credentials: [cred("l1"), cred("n1", NATIVE_RP_ID)] })).toBe(true);
  });
});

describe("rp config — which rpId a NEW credential is minted under", () => {
  it("mints native from a heatwayve origin", () => {
    for (const host of ["heatwayve.app", "www.heatwayve.app"]) {
      const c = rpConfigFromRequest(req(host));
      expect(c.rpId).toBe(NATIVE_RP_ID);
      expect(c.expectedOrigin).toBe(`https://${host}`);
    }
  });

  it("never mints legacy, and never admits the old origin", () => {
    for (const host of [LEGACY_RP_ID, `www.${LEGACY_RP_ID}`]) {
      const c = rpConfigFromRequest(req(host));
      expect(c.rpId).toBe(NATIVE_RP_ID);
      expect(c.acceptedRpIds).toEqual([NATIVE_RP_ID]);
      expect(c.expectedOrigin).toBe(`https://${NATIVE_RP_ID}`);
    }
  });

  it("keeps localhost isolated", () => {
    const c = rpConfigFromRequest(req("localhost:3000"));
    expect(c).toMatchObject({ rpId: "localhost", expectedOrigin: "http://localhost:3000" });
    expect(c.acceptedRpIds).toEqual(["localhost"]);
  });

  it("pins expectedOrigin to one exact string", () => {
    expect(typeof rpConfigFromRequest(req("heatwayve.app")).expectedOrigin).toBe("string");
  });

  it("fails an unknown host toward a live origin it cannot match", () => {
    const c = rpConfigFromRequest(req("evil.example"));
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
  const cfgNative = () => rpConfigFromRequest(req("heatwayve.app"));

  // Applied to every plan below.
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

  it("returns null for a legacy-only profile", () => {
    // Client reads null as "no passkey" and re-offers setup.
    expect(planLoginCeremony({ credentials: [cred("l1"), cred("l2", LEGACY_RP_ID)] }, cfgNative())).toBeNull();
  });

  it("returns null from the old origin too, for a legacy-only profile", () => {
    expect(planLoginCeremony({ credentials: [cred("l1")] }, rpConfigFromRequest(req(LEGACY_RP_ID)))).toBeNull();
  });

  it("logs in a profile that holds a native passkey beside a legacy one", () => {
    const plan = planLoginCeremony(
      { credentials: [cred("l1"), cred("n1", NATIVE_RP_ID)] },
      cfgNative(),
    );
    assertCoherent(plan);
    expect(plan.rpId).toBe(NATIVE_RP_ID);
  });

  it("never offers a keyless credential", () => {
    // Unverifiable, so the ceremony fails after costing a prompt.
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
  it("both verify routes verify against the config's accepted rpIds", () => {
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
    // Backfill rides the counter write.
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
    expect(s).not.toContain("credData.credentials.map");
  });
});
