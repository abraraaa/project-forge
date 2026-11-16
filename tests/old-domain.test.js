// The old domain (theforged.fit) is served by nothing in this app: no redirect
// or header names it, no ceremony runs on its origin, and no Related Origin
// Requests document lets it declare the native rpId. A credential bound to it
// stays on file exactly as stored and never signs in.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  mintAuthToken: vi.fn(async () => "tok"),
}));
const A = "hwa_" + "a".repeat(26);
const rows = { list: [] };
vi.mock("@/lib/identity-store", () => ({
  dbResolveHandle: vi.fn(async () => ({ id: A, storageKey: "sam", handle: "sam", webauthnUserId: "uid", roles: ["lifter"], plan: "free", consent: null })),
  dbListCredentials: vi.fn(async () => rows.list.map((r) => ({ ...r }))),
  dbInsertCredential: vi.fn(async () => true),
  dbTouchCredential: vi.fn(async () => true),
  dbSetAccountConsent: vi.fn(async () => true),
}));
// @simplewebauthn/server is NOT mocked: the origin and rpId checks under test are its own.

const nextConfig = (await import("../next.config.mjs")).default;
const { rpConfigFromRequest, hasUsablePasskey } = await import("@/lib/auth-server");
const { NATIVE_RP_ID, LEGACY_RP_ID } = await import("@/lib/origin");
const { POST: loginOptions } = await import("@/app/api/auth/login-options/route");
const { POST: loginVerify } = await import("@/app/api/auth/login-verify/route");
const { POST: registerVerify } = await import("@/app/api/auth/register-verify/route");
const store = await import("@/lib/identity-store");
const blobUtils = await import("@/lib/blob-utils");
const blob = await import("@vercel/blob");

const OLD_HOSTS = [LEGACY_RP_ID, `www.${LEGACY_RP_ID}`];
const req = (host) => /** @type {any} */ ({ headers: { get: (k) => (k === "host" ? host : null) } });
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const post = (host, path, body) => new Request(`https://${host}${path}`, {
  method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify(body),
});
const clientData = (type, origin) => b64({ type, challenge: b64("challenge"), origin, crossOrigin: false });
const assertion = (origin) => ({
  id: "c1", rawId: "c1", type: "public-key",
  response: { clientDataJSON: clientData("webauthn.get", origin), authenticatorData: b64("x".repeat(37)), signature: b64("sig") },
});
const LEGACY_CRED = { id: "c1", publicKey: "AQID", counter: 4, rpId: LEGACY_RP_ID, transports: ["internal"], createdAt: "2026-06-01T00:00:00.000Z" };

const expectNothingWritten = () => {
  for (const fn of [store.dbInsertCredential, store.dbTouchCredential, store.dbSetAccountConsent,
    blobUtils.writeJsonReplacingPrefix, blobUtils.deleteByPrefix, blob.put, blob.del]) {
    expect(fn).not.toHaveBeenCalled();
  }
};

beforeEach(() => {
  process.env.CHALLENGE_SECRET = "test-secret";
  rows.list = [];
  vi.clearAllMocks();
});

describe("next.config serves nothing for the old domain", () => {
  it("no redirect, rewrite or header names it", async () => {
    const out = {};
    for (const k of ["redirects", "rewrites", "headers"]) {
      if (typeof nextConfig[k] === "function") out[k] = await nextConfig[k]();
    }
    expect(JSON.stringify(out)).not.toMatch(/forged\.fit/i);
    expect(JSON.stringify(out)).not.toMatch(/well-known\/webauthn/);
  });
});

describe("no Related Origin Requests document", () => {
  it("app/.well-known/webauthn has no route", () => {
    expect(existsSync(fileURLToPath(new URL("../app/.well-known/webauthn/route.js", import.meta.url)))).toBe(false);
  });
});

describe("rpConfigFromRequest gives the old hosts nothing of their own", () => {
  it.each(OLD_HOSTS)("%s is answered as an unknown host", (host) => {
    const c = rpConfigFromRequest(req(host));
    expect(c.expectedOrigin).not.toBe(`https://${host}`);
    expect(c).toEqual(rpConfigFromRequest(req("unknown.example")));
    expect(c).toEqual({ rpId: NATIVE_RP_ID, expectedOrigin: `https://${NATIVE_RP_ID}`, acceptedRpIds: [NATIVE_RP_ID] });
  });
});

describe("an auth route called from an old-domain origin refuses", () => {
  it.each(OLD_HOSTS)("login-verify on %s refuses on origin and writes nothing", async (host) => {
    rows.list = [{ ...LEGACY_CRED, rpId: NATIVE_RP_ID }];
    const res = await loginVerify(post(host, "/api/auth/login-verify", { profile: "Sam", credential: assertion(`https://${host}`) }));
    expect(res.status).toBe(401);
    const { error } = await res.json();
    expect(error).toMatch(/^Authentication failed: /);
    expect(error).toMatch(/origin/i);
    expectNothingWritten();
  });

  it.each(OLD_HOSTS)("register-verify on %s refuses on origin and writes nothing", async (host) => {
    const credential = {
      id: "c9", rawId: "c9", type: "public-key",
      response: { clientDataJSON: clientData("webauthn.create", `https://${host}`), attestationObject: b64("x") },
    };
    const res = await registerVerify(post(host, "/api/auth/register-verify", { profile: "Sam", credential }));
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toMatch(/^Registration verification failed: /);
    expect(error).toMatch(/origin/i);
    expectNothingWritten();
  });
});

describe("a stored old-domain credential stays unusable and untouched", () => {
  it("reads as no passkey", () => {
    expect(hasUsablePasskey({ credentials: [LEGACY_CRED] })).toBe(false);
    expect(hasUsablePasskey({ credentials: [{ ...LEGACY_CRED, rpId: undefined }] })).toBe(false);
  });

  it("login-options on the native host offers nothing and rewrites nothing", async () => {
    rows.list = [LEGACY_CRED];
    const res = await loginOptions(post(NATIVE_RP_ID, "/api/auth/login-options", { profile: "Sam" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ needsRegister: true });
    expectNothingWritten();
    expect(rows.list).toEqual([LEGACY_CRED]);
  });

  it("an assertion against it from the native origin fails and rewrites nothing", async () => {
    rows.list = [LEGACY_CRED];
    const res = await loginVerify(post(NATIVE_RP_ID, "/api/auth/login-verify", { profile: "Sam", credential: assertion(`https://${NATIVE_RP_ID}`) }));
    expect(res.status).toBe(401);
    expectNothingWritten();
    expect(rows.list).toEqual([LEGACY_CRED]);
  });
});
