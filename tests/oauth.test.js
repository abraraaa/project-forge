// OAuth core for "Connect your AI": codes, PKCE, rotation, revocation, and the
// rule that a grant belongs to the passkey that consented.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  memoryStore, registerClient, issueCode, exchangeCode, refreshTokens, verifyAccessToken,
  revokeGrantFor, pkceMatches, isAllowedRedirectUri, hashSecret, MCP_RESOURCE, CODE_TTL_MS, ACCESS_TTL_MS,
} from "../lib/oauth.js";

const verifier = "v".repeat(43) + "erifier-for-the-test-only";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const REDIRECT = "https://grok.com/connectors/callback";

async function connected(store = memoryStore(), now = 1_000_000) {
  const { client } = await registerClient(store, { client_name: "Grok", redirect_uris: [REDIRECT] }, now);
  const { code } = await issueCode(store, { clientId: client.id, profile: "sam", credentialId: "cred-1",
    redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" }, now);
  const { tokens } = await exchangeCode(store, { code, clientId: client.id, redirectUri: REDIRECT, codeVerifier: verifier }, now);
  return { store, client, code, tokens, now };
}

describe("registration and redirect URIs", () => {
  it("https anywhere, http only on loopback, no fragments", () => {
    expect(isAllowedRedirectUri(REDIRECT)).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:3334/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example/cb")).toBe(false);
    expect(isAllowedRedirectUri("https://x.example/cb#frag")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
  });
  it("refuses a client with no valid redirect", async () => {
    expect((await registerClient(memoryStore(), { redirect_uris: ["http://evil.example"] })).error).toBe("invalid_redirect_uri");
  });
});

describe("authorization code", () => {
  it("S256 only", async () => {
    const store = memoryStore();
    const { client } = await registerClient(store, { redirect_uris: [REDIRECT] });
    const r = await issueCode(store, { clientId: client.id, profile: "sam", credentialId: "c", redirectUri: REDIRECT, codeChallenge: verifier, codeChallengeMethod: "plain" });
    expect(r.error).toBe("invalid_request");
  });
  it("exchanges once, with the right verifier, redirect and resource", async () => {
    const { store, client, code, tokens } = await connected();
    expect(tokens.token_type).toBe("Bearer");
    const again = await exchangeCode(store, { code, clientId: client.id, redirectUri: REDIRECT, codeVerifier: verifier });
    expect(again.error).toBe("invalid_grant");
  });
  it("wrong verifier fails", async () => {
    const store = memoryStore();
    const { client } = await registerClient(store, { redirect_uris: [REDIRECT] });
    const { code } = await issueCode(store, { clientId: client.id, profile: "sam", credentialId: "c", redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" });
    expect((await exchangeCode(store, { code, clientId: client.id, redirectUri: REDIRECT, codeVerifier: "w".repeat(50) })).error).toBe("invalid_grant");
  });
  it("expired code fails", async () => {
    const store = memoryStore();
    const { client } = await registerClient(store, { redirect_uris: [REDIRECT] }, 0);
    const { code } = await issueCode(store, { clientId: client.id, profile: "sam", credentialId: "c", redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" }, 0);
    expect((await exchangeCode(store, { code, clientId: client.id, redirectUri: REDIRECT, codeVerifier: verifier }, CODE_TTL_MS + 1)).error).toBe("invalid_grant");
  });
  it("tokens are audience-bound to the MCP resource", async () => {
    const store = memoryStore();
    const { client } = await registerClient(store, { redirect_uris: [REDIRECT] });
    const r = await issueCode(store, { clientId: client.id, profile: "sam", credentialId: "c", redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256", resource: "https://other.example/mcp" });
    expect(r.error).toBe("invalid_target");
    expect(MCP_RESOURCE).toBe("https://heatwayve.app/mcp");
  });
});

describe("access and refresh", () => {
  it("a valid access token resolves to the profile", async () => {
    const { store, tokens, now } = await connected();
    expect((await verifyAccessToken(store, tokens.access_token, {}, now + 1))?.profile).toBe("sam");
    expect(await verifyAccessToken(store, tokens.access_token, {}, now + ACCESS_TTL_MS + 1)).toBe(null);
    expect(await verifyAccessToken(store, tokens.refresh_token, {}, now)).toBe(null);
  });
  it("secrets are stored hashed, never raw", async () => {
    const { store, tokens } = await connected();
    expect(store._tokens.has(tokens.access_token)).toBe(false);
    expect(store._tokens.has(hashSecret(tokens.access_token))).toBe(true);
  });
  it("refresh rotates; replaying a spent refresh token revokes the grant", async () => {
    const { store, client, tokens, now } = await connected();
    const r1 = await refreshTokens(store, { refreshToken: tokens.refresh_token, clientId: client.id }, now + 10);
    expect(r1.tokens.access_token).not.toBe(tokens.access_token);
    const replay = await refreshTokens(store, { refreshToken: tokens.refresh_token, clientId: client.id }, now + 20);
    expect(replay.error).toBe("invalid_grant");
    expect(await verifyAccessToken(store, r1.tokens.access_token, {}, now + 30)).toBe(null);
  });
});

describe("the grant belongs to the consenting passkey", () => {
  it("removing that passkey ends access", async () => {
    const { store, tokens, now } = await connected();
    const gone = async () => false;
    expect(await verifyAccessToken(store, tokens.access_token, { credentialExists: gone }, now)).toBe(null);
  });
  it("only the owner can disconnect it, and it stays disconnected", async () => {
    const { store, tokens, now } = await connected();
    const grantId = (await verifyAccessToken(store, tokens.access_token, {}, now)).grantId;
    expect(await revokeGrantFor(store, "someone-else", grantId, now)).toBe(false);
    expect(await verifyAccessToken(store, tokens.access_token, {}, now)).not.toBe(null);
    expect(await revokeGrantFor(store, "sam", grantId, now)).toBe(true);
    expect(await verifyAccessToken(store, tokens.access_token, {}, now)).toBe(null);
  });
});

describe("pkceMatches", () => {
  it("rejects short verifiers and mismatches", () => {
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches("short", challenge)).toBe(false);
    expect(pkceMatches(verifier, challenge.slice(1))).toBe(false);
  });
});

describe("oauth keys profiles by the shared name rule", () => {
  it("normalises on issue and on revoke", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../lib/oauth.js"), "utf8");
    expect(src).toContain("profile: normaliseProfile(profile)");
    expect(src).toContain("grant.profile !== normaliseProfile(profile)");
  });
});
