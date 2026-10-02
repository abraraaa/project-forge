// OAuth core for "Connect your AI": codes, PKCE, rotation, revocation, and the
// rule that a grant belongs to the account and passkey that consented.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  memoryStore, registerClient, issueCode, exchangeCode, refreshTokens, verifyAccessToken,
  revokeGrantFor, ownsGrant, pkceMatches, isAllowedRedirectUri, hashSecret, MCP_RESOURCE, CODE_TTL_MS, ACCESS_TTL_MS,
} from "../lib/oauth.js";

const A = "hwa_" + "a".repeat(26);
const B = "hwa_" + "b".repeat(26);
const SAM = { accountId: A, storageKey: "sam" };

// Neon: capture each statement; rows come from `nextRows` (oauth-store only).
const seen = [];
let nextRows = () => [];
vi.mock("@neondatabase/serverless", () => ({
  neon: () => async (strings, ...values) => { const text = strings.join("?"); seen.push({ text, values }); return nextRows(text); },
}));

const verifier = "v".repeat(43) + "erifier-for-the-test-only";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const REDIRECT = "https://grok.com/connectors/callback";

async function connected(store = memoryStore(), now = 1_000_000) {
  const { client } = await registerClient(store, { client_name: "Grok", redirect_uris: [REDIRECT] }, now);
  const { code } = await issueCode(store, { clientId: client.id, accountId: A, profile: "sam", credentialId: "cred-1",
    redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" }, now);
  const { tokens } = await exchangeCode(store, { code, clientId: client.id, redirectUri: REDIRECT, codeVerifier: verifier }, now);
  return { store, client, code, tokens, now };
}

const AI = { audience: MCP_RESOURCE, kind: "ai" };

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
    const r = await issueCode(store, { clientId: client.id, accountId: A, profile: "sam", credentialId: "c", redirectUri: REDIRECT, codeChallenge: verifier, codeChallengeMethod: "plain" });
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
    const { code } = await issueCode(store, { clientId: client.id, accountId: A, profile: "sam", credentialId: "c", redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" });
    expect((await exchangeCode(store, { code, clientId: client.id, redirectUri: REDIRECT, codeVerifier: "w".repeat(50) })).error).toBe("invalid_grant");
  });
  it("expired code fails", async () => {
    const store = memoryStore();
    const { client } = await registerClient(store, { redirect_uris: [REDIRECT] }, 0);
    const { code } = await issueCode(store, { clientId: client.id, accountId: A, profile: "sam", credentialId: "c", redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" }, 0);
    expect((await exchangeCode(store, { code, clientId: client.id, redirectUri: REDIRECT, codeVerifier: verifier }, CODE_TTL_MS + 1)).error).toBe("invalid_grant");
  });
  it("tokens are audience-bound to the MCP resource", async () => {
    const store = memoryStore();
    const { client } = await registerClient(store, { redirect_uris: [REDIRECT] });
    const r = await issueCode(store, { clientId: client.id, accountId: A, profile: "sam", credentialId: "c", redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256", resource: "https://other.example/mcp" });
    expect(r.error).toBe("invalid_target");
    expect(MCP_RESOURCE).toBe("https://heatwayve.app/mcp");
  });
});

describe("access and refresh", () => {
  it("a valid access token resolves to the account and its storage key", async () => {
    const { store, tokens, now } = await connected();
    expect(await verifyAccessToken(store, tokens.access_token, AI, now + 1)).toMatchObject({ profile: "sam", accountId: A });
    expect(await verifyAccessToken(store, tokens.access_token, AI, now + ACCESS_TTL_MS + 1)).toBe(null);
    expect(await verifyAccessToken(store, tokens.refresh_token, AI, now)).toBe(null);
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
    expect(await verifyAccessToken(store, r1.tokens.access_token, AI, now + 30)).toBe(null);
  });
});

describe("the grant belongs to the consenting passkey", () => {
  it("removing that passkey ends access", async () => {
    const { store, tokens, now } = await connected();
    const gone = async () => false;
    expect(await verifyAccessToken(store, tokens.access_token, { ...AI, credentialExists: gone }, now)).toBe(null);
  });
  it("only the owning account can disconnect it, and it stays disconnected", async () => {
    const { store, tokens, now } = await connected();
    const grantId = (await verifyAccessToken(store, tokens.access_token, AI, now)).grantId;
    // Another account, even one holding the same storage-key string, is refused.
    expect(await revokeGrantFor(store, { accountId: B, storageKey: "sam" }, grantId, now)).toBe(false);
    expect(await revokeGrantFor(store, { accountId: B, storageKey: B }, grantId, now)).toBe(false);
    expect(await verifyAccessToken(store, tokens.access_token, AI, now)).not.toBe(null);
    expect(await revokeGrantFor(store, SAM, grantId, now)).toBe(true);
    expect(await verifyAccessToken(store, tokens.access_token, AI, now)).toBe(null);
  });
});

describe("codes and grants carry the account", () => {
  it("issueCode stores the account id and the storage key verbatim; exchangeCode copies both to the grant", async () => {
    const store = memoryStore();
    const { client } = await registerClient(store, { redirect_uris: [REDIRECT] });
    const put = [];
    const putCode = store.putCode; store.putCode = async (c) => { put.push(c); return putCode(c); };
    const { code } = await issueCode(store, { clientId: client.id, accountId: B, profile: B, credentialId: "c",
      redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" });
    expect(put[0]).toMatchObject({ accountId: B, profile: B });
    await exchangeCode(store, { code, clientId: client.id, redirectUri: REDIRECT, codeVerifier: verifier });
    const [g] = await store.listGrants({ accountId: B, storageKey: B });
    expect(g).toMatchObject({ accountId: B, profile: B, credentialId: "c" });
  });
  it("a code with no account is refused", async () => {
    const store = memoryStore();
    const { client } = await registerClient(store, { redirect_uris: [REDIRECT] });
    const r = await issueCode(store, { clientId: client.id, profile: "sam", credentialId: "c", redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" });
    expect(r.error).toBe("access_denied");
  });
});

describe("grants from before accounts (no account id)", () => {
  const legacy = async () => {
    const { store, tokens, now } = await connected();
    const [g] = await store.listGrants(SAM);
    g.accountId = null; // as a pre-account row reads back
    return { store, tokens, now, grantId: g.id };
  };
  it("belong to the account whose storage key is their profile", async () => {
    const { store, grantId } = await legacy();
    expect((await store.listGrants(SAM)).map((g) => g.id)).toEqual([grantId]);
    expect(await store.listGrants({ accountId: B, storageKey: B })).toEqual([]);
    expect(ownsGrant({ accountId: null, profile: "sam" }, SAM)).toBe(true);
    expect(ownsGrant({ accountId: null, profile: "sam" }, { accountId: B, storageKey: B })).toBe(false);
    expect(ownsGrant({ accountId: A, profile: "sam" }, { accountId: B, storageKey: "sam" })).toBe(false);
    expect(ownsGrant({ accountId: null, profile: "sam" }, null)).toBe(false);
  });
  it("a reclaimer of the name can neither list nor revoke one", async () => {
    const { store, tokens, now, grantId } = await legacy();
    const reclaimer = { accountId: B, storageKey: B };
    expect(await revokeGrantFor(store, reclaimer, grantId, now)).toBe(false);
    expect(await verifyAccessToken(store, tokens.access_token, AI, now)).not.toBe(null);
    expect(await revokeGrantFor(store, SAM, grantId, now)).toBe(true);
  });
  it("resolve through resolveGrant, and the passkey is checked on that account", async () => {
    const { store, tokens, now } = await legacy();
    const seen = [];
    const resolveGrant = async (g) => (g.profile === "sam" && !g.accountId ? SAM : null);
    const credentialExists = async (owner, id) => { seen.push([owner, id]); return true; };
    expect(await verifyAccessToken(store, tokens.access_token, { ...AI, resolveGrant, credentialExists }, now))
      .toMatchObject({ profile: "sam", accountId: A });
    expect(seen).toEqual([[SAM, "cred-1"]]);
  });
  it("a grant whose account no longer resolves is refused before any passkey check", async () => {
    const { store, tokens, now } = await legacy();
    let checked = false;
    const credentialExists = async () => { checked = true; return true; };
    expect(await verifyAccessToken(store, tokens.access_token, { ...AI, resolveGrant: async () => null, credentialExists }, now)).toBe(null);
    expect(checked).toBe(false);
  });
});

describe("pkceMatches", () => {
  it("rejects short verifiers and mismatches", () => {
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches("short", challenge)).toBe(false);
    expect(pkceMatches(verifier, challenge.slice(1))).toBe(false);
  });
});

describe("revocation stamps, never deletes", () => {
  it("oauth.js and oauth-store.js issue no DELETE", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    for (const f of ["../lib/oauth.js", "../lib/oauth-store.js"]) {
      expect(readFileSync(resolve(__dirname, f), "utf8")).not.toMatch(/\bDELETE\b/);
    }
  });
});

describe("tokens are audience-bound (MCP spec)", () => {
  const connect = async () => {
    const store = memoryStore();
    const { client } = await registerClient(store, { redirect_uris: ["https://claude.ai/cb"] });
    const verifier = "v".repeat(50);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const { code } = await issueCode(store, { clientId: client.id, accountId: A, profile: "sam", credentialId: "c1", redirectUri: "https://claude.ai/cb", codeChallenge: challenge, codeChallengeMethod: "S256" });
    const { tokens } = await exchangeCode(store, { code, clientId: client.id, redirectUri: "https://claude.ai/cb", codeVerifier: verifier });
    return { store, tokens };
  };
  it("a caller that doesn't state the audience lets no one in", async () => {
    const { store, tokens } = await connect();
    expect(await verifyAccessToken(store, tokens.access_token, {})).toBeNull();
    expect(await verifyAccessToken(store, tokens.access_token, { audience: MCP_RESOURCE })).toBeNull();
  });
  it("a token for /mcp is refused for another audience or kind", async () => {
    const { store, tokens } = await connect();
    expect(await verifyAccessToken(store, tokens.access_token, AI)).not.toBeNull();
    expect(await verifyAccessToken(store, tokens.access_token, { audience: "https://heatwayve.app/trainer", kind: "ai" })).toBeNull();
    expect(await verifyAccessToken(store, tokens.access_token, { audience: MCP_RESOURCE, kind: "trainer" })).toBeNull();
  });
  it("grants from before the columns read as AI grants for /mcp", async () => {
    const { store, tokens } = await connect();
    for (const g of (await store.listGrants(SAM))) { g.kind = undefined; g.resource = undefined; }
    expect(await verifyAccessToken(store, tokens.access_token, AI)).not.toBeNull();
  });
  it("an expired grant is refused and leaves the connections list", async () => {
    const { store, tokens } = await connect();
    const [g] = await store.listGrants(SAM);
    g.expiresAt = Date.now() - 1;
    expect(await verifyAccessToken(store, tokens.access_token, AI)).toBeNull();
    expect(await store.listGrants(SAM)).toEqual([]);
  });
});

describe("the Neon store carries account_id", () => {
  afterEach(() => { delete process.env.DATABASE_URL; seen.length = 0; nextRows = () => []; });
  const store = async () => {
    process.env.DATABASE_URL = "postgres://fake";
    const { neonOAuthStore } = await import("../lib/oauth-store.js");
    const s = await neonOAuthStore();
    seen.length = 0; // drop ensureSchema
    return s;
  };
  const stmt = (re) => seen.find((q) => re.test(q.text));

  it("writes account_id on codes and grants and reads it back", async () => {
    const s = await store();
    await s.putCode({ hash: "h", clientId: "c", accountId: A, profile: "sam", credentialId: "k", redirectUri: REDIRECT, codeChallenge: "x", scope: "s", resource: MCP_RESOURCE, expiresAt: 1 });
    const code = stmt(/INSERT INTO oauth_codes/);
    expect(code.text).toMatch(/\(hash, client_id, account_id, profile,/);
    expect(code.values.slice(0, 4)).toEqual(["h", "c", A, "sam"]);
    await s.putGrant({ id: "g", clientId: "c", accountId: A, profile: "sam", credentialId: "k", scope: "s", createdAt: 1 });
    const grant = stmt(/INSERT INTO oauth_grants/);
    expect(grant.text).toMatch(/\(id, client_id, account_id, profile,/);
    expect(grant.values.slice(0, 4)).toEqual(["g", "c", A, "sam"]);
    nextRows = () => [{ id: "g", client_id: "c", account_id: null, profile: "sam", credential_id: "k", scope: "s" }];
    expect(await s.getGrant("g")).toMatchObject({ accountId: null, profile: "sam" });
    nextRows = () => [{ client_id: "c", account_id: A, profile: "sam", credential_id: "k" }];
    expect(await s.takeCode("h")).toMatchObject({ accountId: A, profile: "sam" });
  });

  it("lists by account, or a pre-account grant by storage key", async () => {
    const s = await store();
    await s.listGrants(SAM);
    const q = stmt(/FROM oauth_grants g/);
    expect(q.text.replace(/\s+/g, " ")).toContain("WHERE (g.account_id = ? OR (g.account_id IS NULL AND g.profile = ?)) AND g.revoked_at IS NULL");
    expect(q.values.slice(0, 2)).toEqual([A, "sam"]);
  });
});
