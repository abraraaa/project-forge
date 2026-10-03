// A trainer session token (scope "trainer") opens nothing but the trainer
// routes. Every existing gate refuses it, by header and by that gate's own
// cookie, and the same token unscoped is still admitted wherever it is today.
// The trainer cookie itself is never read by any of these gates.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { normaliseProfile } from "../lib/profile-name.js";

const A = { id: "hwa_" + "a".repeat(26), storageKey: "sam" };
const tokens = new Map();
const touched = [];
const track = (name, fn) => vi.fn(async (...a) => { touched.push(name); return fn(...a); });

vi.mock("@/lib/identity-store", async (importOriginal) => {
  const acct = { ...A, webauthnUserId: "u", roles: ["lifter", "trainer"], plan: "free", consent: null, origin: "claim", deletedAt: null };
  return {
    ...(await importOriginal()),
    dbGetAccount: vi.fn(async (id) => (id === A.id ? acct : null)),
    dbAccountByStorageKey: vi.fn(async (sk) => (sk === A.storageKey ? acct : null)),
    dbResolveHandle: vi.fn(async (name) => (normaliseProfile(name) === "sam" ? { ...acct, accountId: A.id, handle: "sam", display: "Sam", kind: "primary" } : null)),
    dbCloseAccount: track("dbCloseAccount", () => true),
  };
});
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal()),
  hasDb: () => true,
  dbReadToken: vi.fn(async (t) => tokens.get(t) || null),
  dbInsertToken: track("dbInsertToken", () => true),
  dbDeleteToken: track("dbDeleteToken", () => true),
  dbReadProfile: track("dbReadProfile", () => ({ meta: {}, history: [], cursor: "c" })),
  dbDeleteProfile: track("dbDeleteProfile", () => 0),
  dbListPhotos: track("dbListPhotos", () => []),
  dbHasRetiredPhotos: track("dbHasRetiredPhotos", () => false),
  dbListBugs: track("dbListBugs", () => []),
}));
vi.mock("@vercel/blob", () => ({
  list: track("list", () => ({ blobs: [] })),
  put: track("put", () => ({})),
  get: track("get", () => null),
  del: track("del", () => {}),
}));
vi.mock("@/lib/oauth-store", () => ({ neonOAuthStore: async () => ({ listGrants: track("listGrants", () => []) }) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => null, rateLimitShared: async () => null }));

const sync = await import("@/app/api/sync/route");
const connections = await import("@/app/api/sync/connections/route");
const photos = await import("@/app/api/photos/route");
const bugs = await import("@/app/api/bugs/route");
const { verifyAuthToken, readTokenData } = await import("@/lib/auth-server");
const { consentFromToken } = await import("@/lib/oauth-http");
const { TRAINER_COOKIE } = await import("@/lib/trainer-session");

// The same record with and without the trainer scope: a live, fresh ceremony
// shape (account, passkey, Face ID a minute ago), so scope is the only difference.
const record = (scope) => ({
  profile: A.storageKey, accountId: A.id, expires: Date.now() + 3600_000, credentialId: "cred-1",
  createdAt: new Date(Date.now() - 60_000).toISOString(), authAt: new Date(Date.now() - 60_000).toISOString(),
  ...(scope ? { scope } : {}),
});

const H = "https://heatwayve.app";
// Each gate, called the way its own client calls it; `cookie` is the gate's own cookie name.
const GATES = {
  "sync GET (syncGate)": { cookie: "hw_sync", run: (h) => sync.GET(new NextRequest(`${H}/api/sync?profile=sam`, { headers: h })), admitted: "dbReadProfile" },
  "connections (gate)": { cookie: "hw_sync", run: (h) => connections.GET(new NextRequest(`${H}/api/sync/connections?profile=sam`, { headers: h })), admitted: "listGrants" },
  // The wipe reads the header only.
  "sync DELETE (wipe)": { cookie: null, run: (h) => sync.DELETE(new NextRequest(`${H}/api/sync?profile=sam`, { method: "DELETE", headers: h })), admitted: "dbDeleteToken" },
  "bugs GET (ceremonyGate)": { cookie: null, run: (h) => bugs.GET(new NextRequest(`${H}/api/bugs`, { headers: h })), admitted: "dbListBugs" },
  "photos GET (gate)": { cookie: "hw_photos", run: (h) => photos.GET(new NextRequest(`${H}/api/photos?profile=sam`, { headers: h })), admitted: "dbListPhotos" },
};
const header = (t) => ({ "x-hw-auth": t });
// With no header token the wipe lists the credentials doc for its passkey hint: a read, never a write.
const dataTouched = () => touched.filter((n) => n !== "list");
const cookie = (name, t) => ({ cookie: `${name}=${t}` });

beforeEach(() => {
  tokens.clear();
  touched.length = 0;
  tokens.set("t-trainer", record("trainer"));
  tokens.set("t-none", record(null));
  process.env.ADMIN_ACCOUNT_ID = A.id;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { delete process.env.ADMIN_ACCOUNT_ID; });

describe("a trainer-scope token is refused by every existing gate", () => {
  for (const [name, g] of Object.entries(GATES)) {
    it(`${name}: 401 by header, touching nothing`, async () => {
      const res = await g.run(header("t-trainer"));
      expect(res.status).toBe(401);
      expect((await res.json()).requiresAuth).toBe(true);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(touched).toEqual([]);
    });
    if (g.cookie) {
      it(`${name}: 401 by its own cookie (${g.cookie})`, async () => {
        const res = await g.run(cookie(g.cookie, "t-trainer"));
        expect(res.status).toBe(401);
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(touched).toEqual([]);
      });
    }
    it(`${name}: the trainer cookie is never read`, async () => {
      // Even a full-scope token, if it only rides in the trainer cookie, opens nothing here.
      for (const t of ["t-trainer", "t-none"]) {
        const res = await g.run(cookie(TRAINER_COOKIE, t));
        expect(res.status, t).toBe(401);
      }
      expect(dataTouched()).toEqual([]);
    });
  }

  it("consentFromToken refuses it", () => {
    expect(consentFromToken(record("trainer"), Date.now())).toBeNull();
  });

  it("verifyAuthToken refuses it, whatever other scope a caller allows", async () => {
    expect(await verifyAuthToken("sam", "t-trainer")).toBeNull();
    expect(await verifyAuthToken("sam", "t-trainer", { allowScope: "photos" })).toBeNull();
    expect(await verifyAuthToken("sam", "t-trainer", { allowScope: "sync" })).toBeNull();
  });
});

describe("equivalence: the same token unscoped is admitted wherever it is today", () => {
  for (const [name, g] of Object.entries(GATES)) {
    it(`${name}: admitted by header`, async () => {
      const res = await g.run(header("t-none"));
      expect(res.status).toBe(200);
      expect(touched).toContain(g.admitted);
    });
  }

  it("consentFromToken admits it and names its passkey", () => {
    expect(consentFromToken(record(null), Date.now())).toEqual({ credentialId: "cred-1" });
  });

  it("verifyAuthToken admits it", async () => {
    expect(await verifyAuthToken("sam", "t-none")).toMatchObject({ accountId: A.id, storageKey: "sam" });
  });

  it("the two records differ only in scope", async () => {
    const { scope, ...rest } = await readTokenData("t-trainer");
    expect(scope).toBe("trainer");
    expect(Object.keys(rest).sort()).toEqual(Object.keys(await readTokenData("t-none")).sort());
  });
});
