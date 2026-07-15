// tests/auth-server.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The passkey lock's pure, security-critical predicates. The signature
// verification itself is delegated to @simplewebauthn/server (battle-tested);
// these lock the decisions AROUND it that this app owns: what counts as a real
// (verifiable) passkey, whether a mint-time token is valid, and the RP config
// that binds a ceremony to its origin. All three are fail-closed by design.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { rpConfigFromRequest, isTokenValid, hasRealPasskey } from "../lib/auth-server.js";

const reqWithHost = (host) => ({ headers: { get: (k) => (k === "host" ? host : null) } });

describe("rpConfigFromRequest", () => {
  it("prod host → theforged.fit rpId + https origin", () => {
    expect(rpConfigFromRequest(reqWithHost("theforged.fit")))
      .toEqual({ rpId: "theforged.fit", expectedOrigin: "https://theforged.fit" });
  });

  it("localhost keeps its port and uses http", () => {
    expect(rpConfigFromRequest(reqWithHost("localhost:3123")))
      .toEqual({ rpId: "localhost", expectedOrigin: "http://localhost:3123" });
  });

  it("an unknown/preview host resolves to the prod RP (passkeys scoped to the real domain)", () => {
    // Preview *.vercel.app hosts intentionally don't get their own rpId.
    expect(rpConfigFromRequest(reqWithHost("project-forge-git-x.vercel.app")).rpId)
      .toBe("theforged.fit");
  });
});

describe("isTokenValid — fail-closed", () => {
  const now = 1_000_000;
  it("accepts a live token for the matching (normalised) profile", () => {
    expect(isTokenValid({ profile: "sarah", expires: now + 1000 }, "Sarah", now)).toBe(true);
  });
  it("rejects an expired token", () => {
    expect(isTokenValid({ profile: "sarah", expires: now - 1 }, "sarah", now)).toBe(false);
  });
  it("rejects a token minted for a different profile", () => {
    expect(isTokenValid({ profile: "mallory", expires: now + 1000 }, "sarah", now)).toBe(false);
  });
  it("rejects null / shapeless / expiry-less tokens", () => {
    expect(isTokenValid(null, "sarah", now)).toBe(false);
    expect(isTokenValid({}, "sarah", now)).toBe(false);
    expect(isTokenValid({ profile: "sarah" }, "sarah", now)).toBe(false);
  });
});

describe("hasRealPasskey — only a key-bearing credential counts", () => {
  it("true when any credential carries a public key", () => {
    expect(hasRealPasskey({ credentials: [{ id: "a" }, { id: "b", publicKey: "AAAA" }] })).toBe(true);
  });
  it("false for keyless legacy credentials", () => {
    expect(hasRealPasskey({ credentials: [{ id: "a" }, { id: "b", attestationObject: "x" }] })).toBe(false);
  });
  it("false for empty / missing / null", () => {
    expect(hasRealPasskey({ credentials: [] })).toBe(false);
    expect(hasRealPasskey({})).toBe(false);
    expect(hasRealPasskey(null)).toBe(false);
  });
  it("false when publicKey is present but empty", () => {
    expect(hasRealPasskey({ credentials: [{ id: "a", publicKey: "" }] })).toBe(false);
  });
});
