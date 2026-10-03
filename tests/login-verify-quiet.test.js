// @vitest-environment jsdom
// Quiet sign-in: a trainer or share ceremony verifies the passkey and returns
// the ceremony token, but mints no photo or sync token and sets no cookie.
// The default path keeps both cookies exactly as before.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/blob-utils", () => ({
  readJsonDirect: vi.fn(async () => null),
  readJsonByPrefix: vi.fn(async () => null),
  deleteByPrefix: vi.fn(async () => 0),
  writeJsonReplacingPrefix: vi.fn(async () => {}),
}));
vi.mock("@vercel/blob", () => ({ list: vi.fn(async () => ({ blobs: [] })), put: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => null, rateLimitShared: async () => null }));
vi.mock("@/lib/auth-server", async (importOriginal) => ({
  ...(await importOriginal()),
  hasChallengeSecret: () => true,
  verifyChallenge: () => true,
  // Each mint returns a token naming its scope, so the cookies can be traced.
  mintAuthToken: vi.fn(async ({ scope }) => `tok-${scope || "ceremony"}`),
}));
const A = "hwa_" + "a".repeat(26);
vi.mock("@/lib/identity-store", () => ({
  dbResolveHandle: vi.fn(async () => ({ id: A, storageKey: "sam", handle: "sam", webauthnUserId: "uid", roles: ["lifter"], plan: "free", consent: null })),
  dbListCredentials: vi.fn(async () => [{ id: "c1", publicKey: "AQID", counter: 0, rpId: "heatwayve.app", transports: [] }]),
  dbInsertCredential: vi.fn(async () => true),
  dbTouchCredential: vi.fn(async () => true),
  dbSetAccountConsent: vi.fn(async () => true),
}));
vi.mock("@simplewebauthn/server", () => ({
  verifyAuthenticationResponse: vi.fn(async () => ({ verified: true, authenticationInfo: { newCounter: 0, rpID: "heatwayve.app" } })),
}));
vi.mock("@/lib/net", () => ({ fetchWithTimeout: vi.fn() }));

const { POST: loginVerify } = await import("@/app/api/auth/login-verify/route");
const { mintAuthToken } = await import("@/lib/auth-server");
const { dbTouchCredential } = await import("@/lib/identity-store");
const { fetchWithTimeout } = await import("@/lib/net");
const { authenticatePasskey } = await import("@/lib/webauthn");

const CRED = { id: "c1", rawId: "c1", type: "public-key", response: {} };
const login = (extra = {}) => loginVerify(new Request("http://localhost/api/auth/login-verify", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ profile: "Sam", credential: CRED, ...extra }),
}));
const IDENTITY = { accountId: A, storageKey: "sam" };

beforeEach(() => {
  process.env.CHALLENGE_SECRET = "test-secret";
  vi.clearAllMocks();
});

describe("login-verify quiet", () => {
  it("quiet:true verifies, returns the ceremony token, mints no scoped token and sets no cookie", async () => {
    const res = await login({ quiet: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.cookies.getAll()).toEqual([]);
    expect(mintAuthToken.mock.calls).toEqual([[{ identity: IDENTITY, ttlMs: 3600000, credentialId: "c1" }]]);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, verified: true, profile: "sam", authToken: "tok-ceremony", expiresIn: 3600 });
    expect(JSON.stringify(body)).not.toMatch(/tok-(photos|sync)/);
    // The sign-in is still indexed (counter, rpId, last used).
    expect(dbTouchCredential).toHaveBeenCalledWith(A, "c1", { counter: 0, rpId: "heatwayve.app" });
  });

  it("default: ceremony, photo and sync mints in order, both cookies with their attributes", async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(mintAuthToken.mock.calls).toEqual([
      [{ identity: IDENTITY, ttlMs: 3600000, credentialId: "c1" }],
      [{ identity: IDENTITY, ttlMs: 7 * 86400000, scope: "photos" }],
      [{ identity: IDENTITY, ttlMs: 30 * 86400000, scope: "sync" }],
    ]);
    const cookies = Object.fromEntries(res.cookies.getAll().map((c) => [c.name, c]));
    expect(Object.keys(cookies).sort()).toEqual(["hw_photos", "hw_sync"]);
    expect(cookies.hw_photos).toMatchObject({
      value: "tok-photos", httpOnly: true, secure: true, sameSite: "strict", path: "/api/photos", maxAge: 7 * 86400,
    });
    expect(cookies.hw_sync).toMatchObject({
      value: "tok-sync", httpOnly: true, secure: true, sameSite: "strict", path: "/api/sync", maxAge: 30 * 86400,
    });
  });

  it("the response body is the same either way", async () => {
    const quiet = await (await login({ quiet: true })).json();
    const loud = await (await login()).json();
    expect(quiet).toEqual(loud);
  });

  it("only a literal true is quiet", async () => {
    for (const quiet of [false, "true", 1, {}, null]) {
      vi.clearAllMocks();
      const res = await login({ quiet });
      expect(res.status).toBe(200);
      expect(mintAuthToken).toHaveBeenCalledTimes(3);
      expect(res.cookies.getAll().map((c) => c.name).sort()).toEqual(["hw_photos", "hw_sync"]);
    }
  });
});

describe("authenticatePasskey quiet", () => {
  const buf = () => new Uint8Array([1]).buffer;
  const assertion = {
    id: "c1", rawId: buf(), type: "public-key",
    response: { clientDataJSON: buf(), authenticatorData: buf(), signature: buf(), userHandle: null },
  };
  const ok = (body) => ({ ok: true, json: async () => body });
  const verifyBody = () => JSON.parse(fetchWithTimeout.mock.calls[1][1].body);
  const run = async (opts) => {
    fetchWithTimeout.mockReset();
    fetchWithTimeout
      .mockResolvedValueOnce(ok({ challenge: "AQ", rpId: "localhost", allowCredentials: [] }))
      .mockResolvedValueOnce(ok({ ok: true, verified: true }));
    await authenticatePasskey("sam", opts);
    return verifyBody();
  };

  beforeEach(() => {
    window.PublicKeyCredential = /** @type {any} */ (function () {});
    Object.defineProperty(navigator, "credentials", { configurable: true, value: { get: vi.fn(async () => assertion) } });
  });
  afterEach(() => { delete window.PublicKeyCredential; });

  it("forwards quiet:true to login-verify", async () => {
    expect((await run({ quiet: true })).quiet).toBe(true);
  });

  it("sends no quiet key by default or when false", async () => {
    expect(await run()).not.toHaveProperty("quiet");
    expect(await run({ quiet: false })).not.toHaveProperty("quiet");
  });
});
