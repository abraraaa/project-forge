// tests/oauth-credentials.test.js
// An AI grant lives only as long as the passkey that approved it can still
// sign in on the grant's account: removed, keyless, on another account, or on
// a domain no longer served all end it.
import { describe, it, expect, vi, beforeEach } from "vitest";

let doc = null;
let fallback = true;
/** account id → credential rows (credential-index shape) */
const rows = new Map();
/** id → account */
const accounts = new Map();
/** live handle → account id */
const handles = new Map();
/** auth token → stored token row */
const tokens = new Map();
let oauthStore = null;
vi.mock("../lib/blob-utils.js", () => ({ readJsonByPrefix: vi.fn(async () => doc) }));
vi.mock("../lib/identity-store.js", () => ({
  dbListCredentials: vi.fn(async (accountId) => rows.get(accountId) || []),
  dbGetAccount: vi.fn(async (id) => accounts.get(id) || null),
  dbAccountByStorageKey: vi.fn(async (sk) => [...accounts.values()].find((a) => a.storageKey === sk) || null),
  dbResolveHandle: vi.fn(async (name) => {
    const h = String(name).trim().toLowerCase();
    const a = accounts.get(handles.get(h));
    return a ? { ...a, accountId: a.id, handle: h } : null;
  }),
}));
vi.mock("../lib/db.js", async (orig) => ({
  ...(await orig()),
  hasDb: () => true,
  dbReadToken: vi.fn(async (t) => tokens.get(t) || null),
}));
vi.mock("../lib/rate-limit.js", () => ({ rateLimit: () => null, rateLimitShared: async () => null }));
vi.mock("../lib/oauth-store.js", () => ({ neonOAuthStore: async () => oauthStore }));
vi.mock("../lib/identity.js", async (orig) => ({
  ...(await orig()),
  get IDENTITY_BLOB_FALLBACK() { return fallback; },
}));

const { credentialExists, grantIdentity } = await import("../lib/oauth-credentials.js");
const { readJsonByPrefix } = await import("../lib/blob-utils.js");
const { NATIVE_RP_ID, LEGACY_RP_ID } = await import("../lib/origin.js");

const BOTH = [NATIVE_RP_ID, LEGACY_RP_ID];
const AFTER_SUNSET = [NATIVE_RP_ID];
const A = "hwa_" + "a".repeat(26);
const B = "hwa_" + "b".repeat(26);
const SAM = { accountId: A, storageKey: "sam" };
const row = (id, rpId, publicKey = "pk") => ({ id, publicKey, rpId, counter: 0, transports: [] });
const cred = (id, rpId, publicKey = "pk") => ({ id, publicKey, rpId });

describe("credentialExists (credential index)", () => {
  beforeEach(() => { doc = null; fallback = true; rows.clear(); accounts.clear(); vi.mocked(readJsonByPrefix).mockClear(); });

  it("a native passkey on the account keeps its grant", async () => {
    rows.set(A, [row("n1", NATIVE_RP_ID)]);
    expect(await credentialExists(SAM, "n1", AFTER_SUNSET)).toBe(true);
  });

  it("an old-domain passkey keeps its grant only while that domain is served", async () => {
    rows.set(A, [row("l1", LEGACY_RP_ID)]);
    expect(await credentialExists(SAM, "l1", BOTH)).toBe(true);
    expect(await credentialExists(SAM, "l1", AFTER_SUNSET)).toBe(false);
  });

  it("a keyless row ends the grant, and an index row is final (no Blob second opinion)", async () => {
    rows.set(A, [row("k1", NATIVE_RP_ID, "")]);
    doc = { credentials: [cred("k1", NATIVE_RP_ID)] };
    expect(await credentialExists(SAM, "k1", BOTH)).toBe(false);
    rows.set(A, [row("l1", LEGACY_RP_ID)]);
    doc = { credentials: [cred("l1", NATIVE_RP_ID)] };
    expect(await credentialExists(SAM, "l1", AFTER_SUNSET)).toBe(false);
  });

  it("a passkey indexed on a different account does not keep this account's grant", async () => {
    rows.set(B, [row("n1", NATIVE_RP_ID)]);
    expect(await credentialExists(SAM, "n1", BOTH)).toBe(false);
    expect(await credentialExists({ accountId: B, storageKey: B }, "n1", BOTH)).toBe(true);
  });

  it("missing inputs never match", async () => {
    rows.set(A, [row("n1", NATIVE_RP_ID)]);
    expect(await credentialExists({ accountId: "", storageKey: "sam" }, "n1", BOTH)).toBe(false);
    expect(await credentialExists(/** @type {any} */ ({ storageKey: "sam" }), "n1", BOTH)).toBe(false);
    expect(await credentialExists(null, "n1", BOTH)).toBe(false);
    expect(await credentialExists(SAM, "", BOTH)).toBe(false);
    expect(await credentialExists({ accountId: A, storageKey: "" }, "n1", BOTH)).toBe(false);
  });
});

describe("credentialExists (Blob fallback, no index row)", () => {
  beforeEach(() => { doc = null; fallback = true; rows.clear(); vi.mocked(readJsonByPrefix).mockClear(); });

  it("with the fallback on, the account's own Blob doc decides, under the same usability rule", async () => {
    doc = { credentials: [cred("n1", NATIVE_RP_ID), cred("l1", LEGACY_RP_ID), { id: "x1", publicKey: "pk" }, cred("k1", NATIVE_RP_ID, "")] };
    expect(await credentialExists(SAM, "n1", AFTER_SUNSET)).toBe(true);
    expect(await credentialExists(SAM, "l1", BOTH)).toBe(true);
    expect(await credentialExists(SAM, "l1", AFTER_SUNSET)).toBe(false);
    expect(await credentialExists(SAM, "x1", BOTH)).toBe(true); // no rpId reads as the old domain
    expect(await credentialExists(SAM, "x1", AFTER_SUNSET)).toBe(false);
    expect(await credentialExists(SAM, "k1", BOTH)).toBe(false);
    expect(await credentialExists(SAM, "gone", BOTH)).toBe(false);
    // The storage key's own prefix, byte-identical to the pre-account path.
    expect(vi.mocked(readJsonByPrefix).mock.calls[0][0]).toBe("forge/profiles/sam/credentials");
  });

  it("an account-keyed storage key reads its own prefix", async () => {
    doc = { credentials: [cred("n1", NATIVE_RP_ID)] };
    expect(await credentialExists({ accountId: B, storageKey: B }, "n1", BOTH)).toBe(true);
    expect(vi.mocked(readJsonByPrefix).mock.calls[0][0]).toBe(`forge/profiles/${B}/credentials`);
  });

  it("with the fallback off, no index row means no passkey", async () => {
    fallback = false;
    doc = { credentials: [cred("n1", NATIVE_RP_ID)] };
    expect(await credentialExists(SAM, "n1", BOTH)).toBe(false);
    expect(readJsonByPrefix).not.toHaveBeenCalled();
  });

  it("no doc, no passkey", async () => {
    expect(await credentialExists(SAM, "n1", BOTH)).toBe(false);
  });
});

describe("grantIdentity", () => {
  beforeEach(() => { accounts.clear(); });
  const acct = (id, storageKey, deletedAt = null) => accounts.set(id, { id, storageKey, deletedAt, roles: ["lifter"], plan: "free" });

  it("a grant with an account id resolves to that account", async () => {
    acct(A, "sam");
    expect(await grantIdentity({ accountId: A, profile: "sam" })).toEqual(SAM);
  });

  it("a pre-account grant resolves by its profile as a storage key, never to a reclaimer", async () => {
    acct(A, "sam");
    acct(B, B); // B now holds the handle "sam"; its storage key is its id
    expect(await grantIdentity({ accountId: null, profile: "sam" })).toEqual(SAM);
  });

  it("a closed or missing account resolves to nothing", async () => {
    acct(A, "sam", "2026-10-01T00:00:00Z");
    expect(await grantIdentity({ accountId: A, profile: "sam" })).toBe(null);
    expect(await grantIdentity({ accountId: null, profile: "sam" })).toBe(null);
    expect(await grantIdentity({ accountId: B, profile: B })).toBe(null);
    expect(await grantIdentity({ accountId: null, profile: "" })).toBe(null);
    expect(await grantIdentity(null)).toBe(null);
  });
});

describe("consent route: the code carries the token's account", () => {
  const REDIRECT = "https://claude.ai/cb";
  const now = Date.now();
  const fresh = (extra = {}) => ({ profile: "sam", expires: now + 3600e3, authAt: new Date(now - 60e3).toISOString(), credentialId: "n1", ...extra });
  let codes;

  beforeEach(async () => {
    accounts.clear(); handles.clear(); tokens.clear(); rows.clear(); doc = null; fallback = true;
    const { memoryStore } = await import("../lib/oauth.js");
    oauthStore = memoryStore();
    await oauthStore.putClient({ id: "hwc_t", name: "Claude", redirectUris: [REDIRECT], createdAt: 0 });
    codes = [];
    const putCode = oauthStore.putCode;
    oauthStore.putCode = async (c) => { codes.push(c); return putCode(c); };
  });

  const consent = async (authToken, profile = "sam") => {
    const { POST } = await import("../app/api/oauth/consent/route.js");
    const params = { client_id: "hwc_t", redirect_uri: REDIRECT, response_type: "code", code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "s" };
    const res = await POST(new Request("https://heatwayve.app/api/oauth/consent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ authToken, profile, params, approve: true }),
    }));
    return { status: res.status, body: await res.json() };
  };

  it("an existing account (storage key = handle) gets a code for its id and \"sam\"", async () => {
    accounts.set(A, { id: A, storageKey: "sam", deletedAt: null, roles: ["lifter"], plan: "free" });
    handles.set("sam", A);
    rows.set(A, [row("n1", NATIVE_RP_ID)]);
    tokens.set("t", fresh({ accountId: A }));
    tokens.set("legacy", fresh());
    for (const t of ["t", "legacy"]) {
      const r = await consent(t, "Sam ");
      expect(r.status).toBe(200);
      expect(new URL(r.body.redirect).searchParams.get("code")).toBeTruthy();
    }
    expect(codes.map((c) => [c.accountId, c.profile, c.credentialId])).toEqual([[A, "sam", "n1"], [A, "sam", "n1"]]);
  });

  it("the old holder's token is refused on a reclaimed name, and nothing is issued", async () => {
    accounts.set(A, { id: A, storageKey: "sam", deletedAt: null, roles: ["lifter"], plan: "free" });
    accounts.set(B, { id: B, storageKey: B, deletedAt: null, roles: ["lifter"], plan: "free" });
    handles.set("sam", B);
    rows.set(A, [row("n1", NATIVE_RP_ID)]);
    tokens.set("legacy", fresh());
    tokens.set("t", fresh({ accountId: A }));
    for (const t of ["legacy", "t"]) expect((await consent(t)).status).toBe(401);
    expect(codes).toEqual([]);
  });

  it("a passkey not on the token's account, a stale ceremony, or no name gets 401", async () => {
    accounts.set(A, { id: A, storageKey: "sam", deletedAt: null, roles: ["lifter"], plan: "free" });
    handles.set("sam", A);
    rows.set(B, [row("n1", NATIVE_RP_ID)]);
    tokens.set("t", fresh({ accountId: A }));
    expect((await consent("t")).status).toBe(401);
    rows.set(A, [row("n1", NATIVE_RP_ID)]);
    tokens.set("stale", fresh({ accountId: A, authAt: new Date(now - 6 * 60e3).toISOString() }));
    expect((await consent("stale")).status).toBe(401);
    expect((await consent("t", "")).status).toBe(401);
    expect((await consent("t", null)).status).toBe(401);
    expect(codes).toEqual([]);
    expect((await consent("t")).status).toBe(200);
  });
});
