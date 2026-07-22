// tests/auth-server.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The passkey lock's pure, security-critical predicates. The signature
// verification itself is delegated to @simplewebauthn/server (battle-tested);
// these lock the decisions AROUND it that this app owns: what counts as a real
// (verifiable) passkey, whether a mint-time token is valid, and the RP config
// that binds a ceremony to its origin. All three are fail-closed by design.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rpConfigFromRequest, isTokenValid, hasRealPasskey, issueChallenge, verifyChallenge, hasChallengeSecret } from "../lib/auth-server.js";

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

describe("stateless challenges (signed, no blob round-trip)", () => {
  const prev = process.env.CHALLENGE_SECRET;
  beforeEach(() => { process.env.CHALLENGE_SECRET = "test-secret-abc123"; });
  afterEach(() => {
    if (prev === undefined) delete process.env.CHALLENGE_SECRET;
    else process.env.CHALLENGE_SECRET = prev;
    vi.useRealTimers();
  });

  it("hasChallengeSecret reflects the env var", () => {
    expect(hasChallengeSecret()).toBe(true);
    delete process.env.CHALLENGE_SECRET;
    expect(hasChallengeSecret()).toBe(false);
  });

  it("a freshly issued challenge verifies for the same profile + ceremony (profile normalised)", () => {
    const c = issueChallenge("Sarah", "auth");
    expect(verifyChallenge(c, "Sarah", "auth")).toBe(true);
    expect(verifyChallenge(c, "sarah", "auth")).toBe(true);
  });

  it("rejects a challenge bound to a different profile or ceremony", () => {
    const c = issueChallenge("Sarah", "auth");
    expect(verifyChallenge(c, "Mallory", "auth")).toBe(false);
    expect(verifyChallenge(c, "Sarah", "reg")).toBe(false);
  });

  it("rejects a tampered or garbage challenge", () => {
    const c = issueChallenge("Sarah", "auth");
    const parts = Buffer.from(c, "base64url").toString().split(".");
    parts[3] = parts[3].slice(0, -1) + (parts[3].slice(-1) === "A" ? "B" : "A"); // flip a sig char
    const tampered = Buffer.from(parts.join(".")).toString("base64url");
    expect(verifyChallenge(tampered, "Sarah", "auth")).toBe(false);
    expect(verifyChallenge("garbage", "Sarah", "auth")).toBe(false);
    expect(verifyChallenge("", "Sarah", "auth")).toBe(false);
  });

  it("rejects an expired challenge (past the ~2-min TTL)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00Z"));
    const c = issueChallenge("Sarah", "auth");
    expect(verifyChallenge(c, "Sarah", "auth")).toBe(true);
    vi.setSystemTime(new Date("2026-07-15T00:03:00Z")); // +3 min
    expect(verifyChallenge(c, "Sarah", "auth")).toBe(false);
  });

  it("a challenge signed under a different secret does not verify (HMAC binding)", () => {
    const c = issueChallenge("Sarah", "auth");
    process.env.CHALLENGE_SECRET = "a-completely-different-secret";
    expect(verifyChallenge(c, "Sarah", "auth")).toBe(false);
  });
});

describe("Heatwayve migration — two origins, one rpId (challenge 1)", () => {
  const req = (host) => ({ headers: { get: (k) => (k === "host" ? host : null) } });
  it("heatwayve.app is an allowed ORIGIN but rpId stays theforged.fit", () => {
    expect(rpConfigFromRequest(req("heatwayve.app")))
      .toEqual({ rpId: "theforged.fit", expectedOrigin: "https://heatwayve.app" });
    expect(rpConfigFromRequest(req("www.heatwayve.app")).expectedOrigin).toBe("https://www.heatwayve.app");
  });
  it("allow-list is exact-match — lookalike hosts fail toward the legacy origin", () => {
    expect(rpConfigFromRequest(req("evil-heatwayve.app")).expectedOrigin).toBe("https://theforged.fit");
    expect(rpConfigFromRequest(req("heatwayve.app.evil.com")).expectedOrigin).toBe("https://theforged.fit");
  });
  it("the ROR well-known lists both domains and stays a static literal", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../app/.well-known/webauthn/route.js"), "utf8");
    expect(src).toContain('"https://theforged.fit"');
    expect(src).toContain('"https://heatwayve.app"');
    expect(src).not.toMatch(/request|headers\.get/); // never reflected from input
  });
});
