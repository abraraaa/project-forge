// Admin is an ACCOUNT, not a name. ADMIN_ACCOUNT_ID matches the account id;
// without it, ADMIN_PROFILE matches the storage key (frozen at account
// creation), never the handle, so whoever later holds the admin's handle is
// never admin. The bugs gate decides on the identity its token resolves to.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normaliseProfile } from "../lib/profile-name.js";

const BOSS = { id: "hwa_" + "b".repeat(26), storageKey: "boss", roles: ["lifter"], plan: "free", deletedAt: null };
// Holds the handle "boss" after a reclaim: a fresh, id-keyed storage key.
const RECLAIMER = { id: "hwa_" + "r".repeat(26), storageKey: "hwa_" + "r".repeat(26), roles: ["lifter"], plan: "free", deletedAt: null };
const SAM = { id: "hwa_" + "s".repeat(26), storageKey: "sam", roles: ["lifter"], plan: "free", deletedAt: null };
const ACCOUNTS = [BOSS, RECLAIMER, SAM];
const tokens = new Map();

vi.mock("@/lib/identity-store", () => ({
  dbGetAccount: async (id) => ACCOUNTS.find((a) => a.id === id) || null,
  dbAccountByStorageKey: async (sk) => ACCOUNTS.find((a) => a.storageKey === sk) || null,
  dbResolveHandle: async (name) => {
    const a = normaliseProfile(name) === "boss" ? RECLAIMER : ACCOUNTS.find((x) => x.storageKey === normaliseProfile(name));
    return a ? { ...a, accountId: a.id, handle: normaliseProfile(name) } : null;
  },
}));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal()),
  hasDb: () => true,
  dbReadToken: vi.fn(async (t) => tokens.get(t) || null),
  dbListBugs: vi.fn(async () => [{ id: 1, message: "m" }]),
  dbUpdateBugStatus: vi.fn(async () => {}),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => null }));

const { isAdminIdentity } = await import("@/lib/auth-server");
const { GET, PATCH } = await import("@/app/api/bugs/route");
const { dbUpdateBugStatus } = await import("@/lib/db");

const ident = (a, handle = null) => ({ accountId: a.id, storageKey: a.storageKey, handle, roles: a.roles, plan: a.plan });

describe("isAdminIdentity", () => {
  it("ADMIN_ACCOUNT_ID matches by id only", () => {
    const env = { ADMIN_ACCOUNT_ID: BOSS.id, ADMIN_PROFILE: "sam" };
    expect(isAdminIdentity(ident(BOSS), env)).toBe(true);
    // A matching storage key under a different id is not the admin, and the
    // id wins over the fallback when both are set.
    expect(isAdminIdentity({ ...ident(SAM), storageKey: "boss" }, env)).toBe(false);
    expect(isAdminIdentity(ident(SAM), env)).toBe(false);
  });

  it("ADMIN_PROFILE fallback matches the storage key, never the handle", () => {
    const env = { ADMIN_PROFILE: "Boss" };
    expect(isAdminIdentity(ident(BOSS), env)).toBe(true);
    expect(isAdminIdentity(ident(RECLAIMER, "boss"), env)).toBe(false);
    expect(isAdminIdentity({ accountId: "x", storageKey: "", handle: "boss" }, env)).toBe(false);
  });

  it("both unset → nobody is admin", () => {
    expect(isAdminIdentity(ident(BOSS), {})).toBe(false);
    expect(isAdminIdentity(ident(BOSS), { ADMIN_PROFILE: "", ADMIN_ACCOUNT_ID: "" })).toBe(false);
    expect(isAdminIdentity(null, { ADMIN_ACCOUNT_ID: BOSS.id })).toBe(false);
  });
});

describe("bugs gate", () => {
  const req = (token, init = {}) => new Request("https://heatwayve.app/api/bugs", {
    ...init, headers: { ...(token ? { "x-hw-auth": token } : {}), ...(init.headers || {}) },
  });
  const future = () => Date.now() + 60_000;

  beforeEach(() => {
    tokens.clear();
    vi.unstubAllEnvs();
    vi.stubEnv("ADMIN_ACCOUNT_ID", "");
    vi.stubEnv("ADMIN_PROFILE", "");
    vi.mocked(dbUpdateBugStatus).mockClear();
    tokens.set("boss-id", { profile: "boss", accountId: BOSS.id, expires: future() });
    tokens.set("boss-legacy", { profile: "boss", expires: future() });
    tokens.set("reclaimer", { profile: RECLAIMER.storageKey, accountId: RECLAIMER.id, expires: future() });
    tokens.set("sam", { profile: "sam", accountId: SAM.id, expires: future() });
    tokens.set("boss-photos", { profile: "boss", accountId: BOSS.id, expires: future(), scope: "photos" });
    tokens.set("boss-sync", { profile: "boss", accountId: BOSS.id, expires: future(), scope: "sync" });
    tokens.set("boss-expired", { profile: "boss", accountId: BOSS.id, expires: Date.now() - 1 });
    tokens.set("orphan", { profile: "nobody", expires: future() });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("ADMIN_ACCOUNT_ID admits the admin account's token and nobody else's", async () => {
    vi.stubEnv("ADMIN_ACCOUNT_ID", BOSS.id);
    expect((await GET(req("boss-id"))).status).toBe(200);
    expect((await GET(req("boss-legacy"))).status).toBe(200); // legacy row: resolved by storage key
    expect((await GET(req("sam"))).status).toBe(403);
    expect((await GET(req("reclaimer"))).status).toBe(403);
  });

  it("ADMIN_PROFILE fallback: the admin's storage key, not whoever holds the handle", async () => {
    vi.stubEnv("ADMIN_PROFILE", "Boss");
    expect((await GET(req("boss-id"))).status).toBe(200);
    expect((await GET(req("reclaimer"))).status).toBe(403);
    expect((await GET(req("sam"))).status).toBe(403);
  });

  it("any scope, expiry, no token, and a token with no account are refused before admin", async () => {
    vi.stubEnv("ADMIN_ACCOUNT_ID", BOSS.id);
    for (const t of ["boss-photos", "boss-sync", "boss-expired", null, "orphan", "unknown"]) {
      expect((await GET(req(t))).status, String(t)).toBe(401);
    }
    const patch = await PATCH(req("boss-sync", { method: "PATCH", body: JSON.stringify({ id: 1, status: "filled" }) }));
    expect(patch.status).toBe(401);
    expect(dbUpdateBugStatus).not.toHaveBeenCalled();
  });

  it("fails closed in production when both env vars are unset; open in dev, as before", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await GET(req("boss-id"))).status).toBe(403);
    const patch = await PATCH(req("boss-id", { method: "PATCH", body: JSON.stringify({ id: 1, status: "filled" }) }));
    expect(patch.status).toBe(403);
    expect(dbUpdateBugStatus).not.toHaveBeenCalled();
    vi.stubEnv("NODE_ENV", "development");
    expect((await GET(req("sam"))).status).toBe(200);
  });
});
