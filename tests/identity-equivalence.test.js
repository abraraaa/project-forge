// Identity equivalence: the storage-key path builders yield, byte for byte,
// the paths the routes built inline before lib/storage-keys existed; and,
// once the gates resolve tokens to accounts, every existing account (storage
// key = its handle) still reads and writes exactly the keys and paths it did.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, join } from "node:path";
import { normaliseProfile } from "../lib/profile-name.js";
import {
  profileDir, metaPath, historyPath, credentialsPrefix, credentialsPath,
  photosPrefix, photoPath, snapshotPaths,
} from "../lib/storage-keys.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(resolve(root, f), "utf8");

// The pre-storage-keys formulas, copied from the routes and frozen. Each took
// the raw name and normalised it inline.
const normalise = normaliseProfile;
const OLD = {
  // sync:37-41, register-options:17
  meta: (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/meta.json`,
  history: (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/history.json`,
  prefix: (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/`,
  // register-verify, login-options, login-verify, check, sync DELETE, oauth-credentials
  credPrefix: (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials`,
  credPath: (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/credentials.json`,
  // photos:46-47, called with the gate's already-normalised profile
  photo: (profile, date) => `forge/profiles/${encodeURIComponent(normalise(profile))}/photos/${date}.jpg`,
  // passkey-census bucket prefix (n is the decoded key)
  photosPrefix: (n) => `forge/profiles/${encodeURIComponent(n)}/photos/`,
  // sync DELETE: enc = encodeURIComponent(normalise(profile))
  wipeDaily: (name) => `forge/snapshots/daily/${encodeURIComponent(normalise(name))}.json`,
  wipeWeekly: (name) => `forge/snapshots/weekly/${encodeURIComponent(normalise(name))}.json`,
  // snapshot cron: the DB key, not re-normalised
  cronDaily: (profile) => `forge/snapshots/daily/${encodeURIComponent(profile)}.json`,
  cronWeekly: (profile) => `forge/snapshots/weekly/${encodeURIComponent(profile)}.json`,
  // login/register options + verify (fallback challenge blob)
  challenge: (name) => `forge/challenges/${createHash("sha256").update(normalise(name)).digest("base64url")}`,
};

const NAMES = [
  "sam", "Sam ", "ＳＡＭ", "café", "café", "a b", "x%y", "o'neil",
  "Kelvin", "Kelvin", "Ünïcödé 名前", "émoji 💪", "  padded  ",
];
const DATE = "2026-10-01";

describe("storage-key builders equal the old inline formulas", () => {
  for (const n of NAMES) {
    // Existing accounts: storage key = today's normalised handle.
    const sk = normaliseProfile(n);
    it(JSON.stringify(n), () => {
      expect(metaPath(sk)).toBe(OLD.meta(n));
      expect(historyPath(sk)).toBe(OLD.history(n));
      expect(profileDir(sk)).toBe(OLD.prefix(n));
      expect(profileDir(sk).endsWith("/")).toBe(true);
      expect(credentialsPrefix(sk)).toBe(OLD.credPrefix(n));
      expect(credentialsPath(sk)).toBe(OLD.credPath(n));
      // photos route: g.profile = normalise(name); the old builder normalised again.
      const g = normalise(n);
      expect(photoPath(normalise(g), DATE)).toBe(OLD.photo(g, DATE));
      expect(photoPath(sk, DATE)).toBe(OLD.photo(n, DATE));
      expect(photosPrefix(sk)).toBe(OLD.photosPrefix(sk));
      const wipe = snapshotPaths(normalise(n));
      expect(wipe.daily).toBe(OLD.wipeDaily(n));
      expect(wipe.weekly).toBe(OLD.wipeWeekly(n));
      const cron = snapshotPaths(sk);
      expect(cron.daily).toBe(OLD.cronDaily(sk));
      expect(cron.weekly).toBe(OLD.cronWeekly(sk));
    });
  }

  it("builders take the key verbatim and never normalise again", () => {
    expect(metaPath("Sam ")).toBe("forge/profiles/Sam%20/meta.json");
    expect(snapshotPaths("ＳＡＭ").daily).toBe(`forge/snapshots/daily/${encodeURIComponent("ＳＡＭ")}.json`);
    expect(profileDir("hwa_abc")).toBe("forge/profiles/hwa_abc/");
  });

  it("look-alike names land on one key, as before", () => {
    expect(metaPath(normaliseProfile("ＳＡＭ"))).toBe("forge/profiles/sam/meta.json");
    expect(metaPath(normaliseProfile("Kelvin"))).toBe(metaPath(normaliseProfile("kelvin")));
    expect(metaPath(normaliseProfile("café"))).toBe(metaPath(normaliseProfile("café")));
  });
});

describe("the challenge key is unchanged", () => {
  const ROUTES = [
    "app/api/auth/login-options/route.js", "app/api/auth/login-verify/route.js",
    "app/api/auth/register-options/route.js", "app/api/auth/register-verify/route.js",
  ];
  it("every ceremony route still derives it from sha256(normalise(profile))", () => {
    for (const f of ROUTES) {
      const src = read(f);
      expect(src).toContain('crypto.createHash("sha256").update(normalise(profile)).digest("base64url")');
      expect(src).toContain("forge/challenges/${userId}");
    }
    expect(OLD.challenge("ＳＡＭ")).toBe(OLD.challenge("sam"));
  });
});

describe("lib/storage-keys is the only builder of storage-key paths", () => {
  const walk = (d) => readdirSync(resolve(root, d)).flatMap((e) => {
    const p = join(d, e);
    return statSync(resolve(root, p)).isDirectory() ? walk(p) : /\.(js|jsx|ts)$/.test(e) ? [p] : [];
  });
  // db-import reads a dir segment it LISTED (already encoded), not a key.
  const ALLOWED = ["lib/storage-keys.js", "app/api/diag/db-import/route.js"];
  it("no other file interpolates into a profile or snapshot path", () => {
    const offenders = [...walk("app"), ...walk("lib")]
      .map((f) => relative(root, resolve(root, f)))
      .filter((f) => !ALLOWED.includes(f))
      .filter((f) => /forge\/(profiles|snapshots\/(daily|weekly))\/\$\{/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});

// ─── Token half: the gates, for an existing account ─────────────────────────
// Neon is mocked at the db.js / identity-store readers (arguments captured),
// Blob as an in-memory path map. The gates and resolveTokenIdentity are real.

const A = { id: "hwa_" + "a".repeat(26), storageKey: "sam" };
// NFKC runs before lowercasing, so this name's key is not a fixed point of
// normaliseProfile: a second pass folds it onto V's key. Claims now refuse
// such names; J stands for an account that somehow holds one.
const AWKWARD = "J\u030Cohn";
const J = { id: "hwa_" + "j".repeat(26), storageKey: normaliseProfile(AWKWARD) };
const V = { id: "hwa_" + "v".repeat(26), storageKey: "\u01F0ohn" };
// A reclaimed account: keyed by its own id, holding the handle "sam".
const B = { id: "hwa_" + "b".repeat(26), storageKey: "hwa_" + "b".repeat(26) };
const M = { id: "hwa_" + "m".repeat(26), storageKey: "mallory" };
const live = { accounts: [], handles: new Map() };
const store = { tokens: new Map(), blobs: new Map(), grants: [] };

vi.mock("@/lib/identity-store", async (importOriginal) => {
  const acct = (a) => a && { ...a, webauthnUserId: "u", roles: ["lifter"], plan: "free", consent: null, origin: "backfill", deletedAt: null };
  return {
    ...(await importOriginal()),
    dbGetAccount: vi.fn(async (id) => acct(live.accounts.find((a) => a.id === id)) || null),
    dbAccountByStorageKey: vi.fn(async (sk) => acct(live.accounts.find((a) => a.storageKey === sk)) || null),
    dbResolveHandle: vi.fn(async (name) => {
      const h = normaliseProfile(name);
      const a = live.accounts.find((x) => x.id === live.handles.get(h));
      return a ? { ...acct(a), accountId: a.id, handle: h, display: h, kind: "primary" } : null;
    }),
  };
});
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal()),
  hasDb: () => true,
  dbInsertToken: vi.fn(async (t, rec) => { store.tokens.set(t, rec); return true; }),
  dbReadToken: vi.fn(async (t) => store.tokens.get(t) || null),
  dbDeleteToken: vi.fn(async (t) => { store.tokens.delete(t); }),
  dbReadProfile: vi.fn(async () => ({ meta: { displayName: "Sam" }, history: [], cursor: "c" })),
  dbReadProfileSince: vi.fn(async () => ({ meta: {}, history: [], cursor: "c" })),
  dbCursorNow: vi.fn(async () => "c"),
  dbReadMetaBase: vi.fn(async () => ({ meta: {}, revs: {} })),
  dbInsertHistory: vi.fn(async () => {}),
  dbWriteMetaGuarded: vi.fn(async () => true),
  dbDeleteProfile: vi.fn(async () => {}),
  dbUpsertPhoto: vi.fn(async () => {}),
  dbGetPhoto: vi.fn(async () => null),
  dbDeletePhoto: vi.fn(async () => {}),
  dbListPhotos: vi.fn(async () => []),
  dbHasRetiredPhotos: vi.fn(async () => false),
}));
vi.mock("@vercel/blob", () => ({
  list: vi.fn(async ({ prefix }) => ({
    blobs: [...store.blobs.keys()].filter((p) => p.startsWith(prefix)).map((p) => ({ pathname: p, url: `https://blob/${p}`, uploadedAt: "2026-10-01T00:00:00.000Z" })),
  })),
  put: vi.fn(async (path, body) => { store.blobs.set(path, body); return { pathname: path }; }),
  get: vi.fn(async (path) => (store.blobs.has(path)
    ? { statusCode: 200, stream: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }) }
    : null)),
  del: vi.fn(async (urls) => { for (const u of [].concat(urls)) store.blobs.delete(String(u).replace("https://blob/", "")); }),
}));
// The store applies the real ownership rule, so the route must hand it an owner.
vi.mock("@/lib/oauth-store", async () => {
  const { ownsGrant } = await import("@/lib/oauth");
  return {
    neonOAuthStore: async () => ({
      listGrants: vi.fn(async (owner) => store.grants.filter((g) => ownsGrant(g, owner) && !g.revokedAt)),
      getGrant: async (id) => store.grants.find((g) => g.id === id) || null,
      revokeGrant: async (id) => { store.grants.find((g) => g.id === id).revokedAt = 1; },
    }),
  };
});
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => null, rateLimitShared: async () => null }));

const sync = await import("@/app/api/sync/route");
const photos = await import("@/app/api/photos/route");
const connections = await import("@/app/api/sync/connections/route");
const dbm = await import("@/lib/db");
const blob = await import("@vercel/blob");

const HOUR = 3600_000;
// Rows as today's code minted them: no account id, profile = the normalised name.
const legacyRow = (profile, extra = {}) => ({ profile, expires: Date.now() + HOUR, createdAt: new Date().toISOString(), ...extra });
const jpeg = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x02,
  0xff, 0xd9,
]);
const call = (mock) => vi.mocked(mock).mock.calls;

beforeEach(() => {
  vi.clearAllMocks();
  live.accounts = [A, J, V, M];
  live.handles = new Map([["sam", A.id], [J.storageKey, J.id], [V.storageKey, V.id], ["mallory", M.id]]);
  store.tokens.clear(); store.blobs.clear();
  store.grants = [{ id: "g1", profile: "sam", clientName: "Claude", createdAt: 1, lastUsedAt: 2, revokedAt: null }];
});

describe("token half: an existing account keys exactly as before", () => {
  it("sync GET with a legacy hw_sync cookie row reads dbReadProfile(\"sam\")", async () => {
    store.tokens.set("c1", legacyRow("sam", { scope: "sync" }));
    const res = await sync.GET(new NextRequest("https://heatwayve.app/api/sync?profile=Sam", { headers: { cookie: "hw_sync=c1" } }));
    expect(res.status).toBe(200);
    expect(call(dbm.dbReadProfile)).toEqual([["sam"]]);
  });

  it("sync GET ?since keys the delta read by the same key", async () => {
    store.tokens.set("t", legacyRow("sam", { scope: "sync" }));
    const res = await sync.GET(new NextRequest("https://heatwayve.app/api/sync?profile=sam&since=2026-10-01T00:00:00.000Z", { headers: { "x-hw-auth": "t" } }));
    expect(res.status).toBe(200);
    expect(call(dbm.dbReadProfileSince)[0][0]).toBe("sam");
  });

  it("delta PUT reads and upserts under \"sam\"", async () => {
    store.tokens.set("t", legacyRow("sam", { scope: "sync" }));
    const res = await sync.PUT(new NextRequest("https://heatwayve.app/api/sync", {
      method: "PUT", headers: { "x-hw-auth": "t", "content-type": "application/json" },
      body: JSON.stringify({ profile: "SAM", delta: { meta: { bodyweight: 80 }, history: [] } }),
    }));
    expect(res.status).toBe(200);
    expect(call(dbm.dbReadMetaBase)[0][0]).toBe("sam");
    expect(call(dbm.dbWriteMetaGuarded)[0][0]).toBe("sam");
  });

  it("fat PUT with no DB rows seeds from the same blob paths as before", async () => {
    vi.mocked(dbm.dbReadProfile).mockResolvedValueOnce(null);
    store.tokens.set("t", legacyRow("sam", { scope: "sync" }));
    const res = await sync.PUT(new NextRequest("https://heatwayve.app/api/sync", {
      method: "PUT", headers: { "x-hw-auth": "t", "content-type": "application/json" },
      body: JSON.stringify({ profile: "sam", data: { history: [] } }),
    }));
    expect(res.status).toBe(200);
    expect(call(blob.list)[0][0]).toEqual({ prefix: OLD.prefix("sam") });
    expect(call(blob.get).map((c) => c[0])).toEqual([OLD.meta("sam"), OLD.history("sam")]);
    expect(call(dbm.dbInsertHistory)[0][0]).toBe("sam");
  });

  it("sliding rotation mints a row with profile = the storage key and the account id", async () => {
    store.tokens.set("old", legacyRow("sam", { scope: "sync", createdAt: new Date(Date.now() - 2 * 86400000).toISOString() }));
    const res = await sync.GET(new NextRequest("https://heatwayve.app/api/sync?profile=sam", { headers: { cookie: "hw_sync=old" } }));
    expect(res.status).toBe(200);
    const [[, rec]] = call(dbm.dbInsertToken);
    expect(rec).toMatchObject({ profile: "sam", accountId: A.id, scope: "sync" });
    expect(res.headers.get("set-cookie")).toContain("hw_sync=");
  });

  it("photos POST writes forge/profiles/sam/photos/<date>.jpg and indexes it under \"sam\"", async () => {
    store.tokens.set("t", legacyRow("sam"));
    const res = await photos.POST(new NextRequest("https://heatwayve.app/api/photos?profile=Sam&date=2026-10-01", {
      method: "POST", headers: { "x-hw-auth": "t" }, body: jpeg,
    }));
    expect(res.status).toBe(200);
    expect(call(blob.put)[0][0]).toBe("forge/profiles/sam/photos/2026-10-01.jpg");
    expect(call(blob.put)[0][0]).toBe(OLD.photo(normaliseProfile("Sam"), "2026-10-01"));
    expect(call(dbm.dbUpsertPhoto)[0]).toEqual(["sam", { date: "2026-10-01", blobPath: "forge/profiles/sam/photos/2026-10-01.jpg", bodyweightAt: null }]);
  });

  it("photos POST builds the path from the storage key verbatim, never re-normalised onto another key", async () => {
    store.tokens.set("t", legacyRow(J.storageKey));
    const victim = photoPath(V.storageKey, "2026-10-01");
    store.blobs.set(victim, "victim");
    const res = await photos.POST(new NextRequest(`https://heatwayve.app/api/photos?${new URLSearchParams({ profile: AWKWARD, date: "2026-10-01" })}`, {
      method: "POST", headers: { "x-hw-auth": "t" }, body: jpeg,
    }));
    expect(res.status).toBe(200);
    // The second pass would have landed on V's path.
    expect(OLD.photo(J.storageKey, "2026-10-01")).toBe(victim);
    expect(call(blob.put)[0][0]).toBe(photoPath(J.storageKey, "2026-10-01"));
    expect(call(blob.put)[0][0].startsWith(photosPrefix(J.storageKey))).toBe(true);
    expect(store.blobs.get(victim)).toBe("victim");
    expect(call(dbm.dbUpsertPhoto)[0][0]).toBe(J.storageKey);
  });

  it("photos GET and DELETE refuse an index row pointing outside the account's own prefix", async () => {
    const victim = photoPath(V.storageKey, "2026-10-01");
    store.blobs.set(victim, "victim");
    store.tokens.set("t", legacyRow(J.storageKey));
    const url = `https://heatwayve.app/api/photos?${new URLSearchParams({ profile: AWKWARD, date: "2026-10-01" })}`;
    vi.mocked(dbm.dbGetPhoto).mockResolvedValue({ blob_path: victim });
    expect((await photos.GET(new NextRequest(url, { headers: { "x-hw-auth": "t" } }))).status).toBe(404);
    expect((await photos.DELETE(new NextRequest(url, { method: "DELETE", headers: { "x-hw-auth": "t" } }))).status).toBe(404);
    vi.mocked(dbm.dbGetPhoto).mockReset().mockResolvedValue(null);
    expect(call(blob.get)).toEqual([]);
    for (const m of [dbm.dbDeletePhoto, blob.del, blob.list]) expect(call(m)).toEqual([]);
    expect(store.blobs.get(victim)).toBe("victim");
  });

  it("photos DELETE removes exactly sam's row and the stored blob_path", async () => {
    store.tokens.set("t", legacyRow("sam", { scope: "photos" }));
    const path = "forge/profiles/sam/photos/2026-09-01.jpg";
    store.blobs.set(path, "x");
    store.blobs.set("forge/profiles/sam/photos/2026-09-01.jpg.bak", "y");
    vi.mocked(dbm.dbGetPhoto).mockResolvedValueOnce({ blob_path: path });
    const res = await photos.DELETE(new NextRequest("https://heatwayve.app/api/photos?profile=Sam&date=2026-09-01", { method: "DELETE", headers: { "x-hw-auth": "t" } }));
    expect(res.status).toBe(200);
    expect(call(dbm.dbGetPhoto)[0]).toEqual(["sam", "2026-09-01"]);
    expect(call(dbm.dbDeletePhoto)).toEqual([["sam", "2026-09-01"]]);
    // The exact-path delete, as before: list the stored path, del only the exact match.
    expect(path).toBe(OLD.photo("sam", "2026-09-01"));
    expect(call(blob.list)).toEqual([[{ prefix: path }]]);
    expect(call(blob.del)).toEqual([[[`https://blob/${path}`]]]);
    expect([...store.blobs.keys()]).toEqual(["forge/profiles/sam/photos/2026-09-01.jpg.bak"]);
  });

  it("photos GET reads the stored blob_path, looked up under \"sam\"", async () => {
    store.tokens.set("t", legacyRow("sam", { scope: "photos" }));
    store.blobs.set("forge/profiles/sam/photos/2026-09-01.jpg", "x");
    vi.mocked(dbm.dbGetPhoto).mockResolvedValueOnce({ blob_path: "forge/profiles/sam/photos/2026-09-01.jpg" });
    const res = await photos.GET(new NextRequest("https://heatwayve.app/api/photos?profile=sam&date=2026-09-01", { headers: { "x-hw-auth": "t" } }));
    expect(res.status).toBe(200);
    expect(call(dbm.dbGetPhoto)[0]).toEqual(["sam", "2026-09-01"]);
    expect(call(blob.get)[0][0]).toBe("forge/profiles/sam/photos/2026-09-01.jpg");
  });

  it("connections GET lists the legacy grant held under \"sam\"", async () => {
    store.tokens.set("c1", legacyRow("sam", { scope: "sync" }));
    const res = await connections.GET(new NextRequest("https://heatwayve.app/api/sync/connections?profile=sam", { headers: { cookie: "hw_sync=c1" } }));
    expect(res.status).toBe(200);
    expect((await res.json()).connections).toEqual([{ id: "g1", name: "Claude", since: 1, lastRead: 2 }]);
  });

  it("connections: the owner lists and revokes both a legacy grant and an account-bound grant", async () => {
    store.grants.push({ id: "g2", profile: "sam", accountId: A.id, clientName: "ChatGPT", createdAt: 3, lastUsedAt: 4, revokedAt: null });
    store.tokens.set("c1", legacyRow("sam", { scope: "sync" }));
    const list = await connections.GET(new NextRequest("https://heatwayve.app/api/sync/connections?profile=sam", { headers: { cookie: "hw_sync=c1" } }));
    expect((await list.json()).connections.map((c) => c.id)).toEqual(["g1", "g2"]);
    for (const id of ["g1", "g2"]) {
      const res = await connections.POST(new NextRequest("https://heatwayve.app/api/sync/connections", {
        method: "POST", headers: { cookie: "hw_sync=c1", "content-type": "application/json" },
        body: JSON.stringify({ profile: "sam", disconnect: id }),
      }));
      expect(res.status).toBe(200);
    }
    expect(store.grants.map((g) => g.revokedAt)).toEqual([1, 1]);
  });

  it("the wipe gate admits a legacy ceremony row and the wipe keys by \"sam\"", async () => {
    store.tokens.set("w", legacyRow("sam"));
    const res = await sync.DELETE(new NextRequest("https://heatwayve.app/api/sync?profile=Sam", { method: "DELETE", headers: { "x-hw-auth": "w" } }));
    expect(res.status).toBe(200);
    expect(call(dbm.dbDeleteProfile)).toEqual([["sam"]]);
    expect(call(blob.del)[0][0]).toEqual([OLD.wipeDaily("sam"), OLD.wipeWeekly("sam")]);
  });
});

describe("token half: existing accounts beside a new id-keyed account", () => {
  // What a claim creates from cutover on: storage key = its own id.
  const N = { id: "hwa_" + "n".repeat(26), storageKey: "hwa_" + "n".repeat(26) };
  beforeEach(() => {
    live.accounts.push(N);
    live.handles.set("newbie", N.id);
  });

  it("each token reads its own key: the name for sam, the id for the new account", async () => {
    store.tokens.set("s", legacyRow("sam", { scope: "sync" }));
    store.tokens.set("n", { profile: N.storageKey, accountId: N.id, scope: "sync", expires: Date.now() + HOUR, createdAt: new Date().toISOString() });
    for (const [t, name] of [["s", "Sam"], ["n", "Newbie"]]) {
      const res = await sync.GET(new NextRequest(`https://heatwayve.app/api/sync?profile=${name}`, { headers: { "x-hw-auth": t } }));
      expect(res.status, name).toBe(200);
    }
    expect(call(dbm.dbReadProfile)).toEqual([["sam"], [N.id]]);
    // Neither token opens the other's name.
    for (const [t, name] of [["s", "newbie"], ["n", "sam"]]) {
      expect((await sync.GET(new NextRequest(`https://heatwayve.app/api/sync?profile=${name}`, { headers: { "x-hw-auth": t } }))).status, name).toBe(401);
    }
    expect(call(dbm.dbReadProfile)).toHaveLength(2);
  });
});

describe("token half: another account's token never crosses", () => {
  const fresh = () => legacyRow("mallory", { scope: "sync" });

  it("sync, photos, connections and wipe all refuse mallory's token for sam, touching nothing", async () => {
    store.tokens.set("m", fresh());
    store.tokens.set("mw", legacyRow("mallory"));
    const reqs = [
      () => sync.GET(new NextRequest("https://heatwayve.app/api/sync?profile=sam", { headers: { "x-hw-auth": "m" } })),
      () => sync.PUT(new NextRequest("https://heatwayve.app/api/sync", {
        method: "PUT", headers: { "x-hw-auth": "m", "content-type": "application/json" },
        body: JSON.stringify({ profile: "sam", data: { history: [] } }),
      })),
      () => photos.GET(new NextRequest("https://heatwayve.app/api/photos?profile=sam", { headers: { "x-hw-auth": "mw" } })),
      () => connections.GET(new NextRequest("https://heatwayve.app/api/sync/connections?profile=sam", { headers: { "x-hw-auth": "m" } })),
      () => sync.DELETE(new NextRequest("https://heatwayve.app/api/sync?profile=sam", { method: "DELETE", headers: { "x-hw-auth": "mw" } })),
      () => photos.DELETE(new NextRequest("https://heatwayve.app/api/photos?profile=sam&date=2026-09-01", { method: "DELETE", headers: { "x-hw-auth": "mw" } })),
      () => photos.POST(new NextRequest("https://heatwayve.app/api/photos?profile=sam&date=2026-09-01", { method: "POST", headers: { "x-hw-auth": "mw" }, body: jpeg })),
    ];
    for (const r of reqs) expect((await r()).status).toBe(401);
    for (const m of [dbm.dbReadProfile, dbm.dbInsertHistory, dbm.dbWriteMetaGuarded, dbm.dbListPhotos, dbm.dbGetPhoto, dbm.dbDeletePhoto, dbm.dbUpsertPhoto, dbm.dbDeleteProfile, dbm.dbDeleteToken, blob.del, blob.put, dbm.dbInsertToken]) {
      expect(call(m)).toEqual([]);
    }
  });

  it("connections: another account can neither list nor revoke sam's grants", async () => {
    store.grants.push({ id: "g2", profile: "sam", accountId: A.id, clientName: "ChatGPT", createdAt: 3, lastUsedAt: 4, revokedAt: null });
    store.tokens.set("m", fresh());
    const list = await connections.GET(new NextRequest("https://heatwayve.app/api/sync/connections?profile=mallory", { headers: { "x-hw-auth": "m" } }));
    expect(list.status).toBe(200);
    expect((await list.json()).connections).toEqual([]);
    for (const id of ["g1", "g2"]) {
      const res = await connections.POST(new NextRequest("https://heatwayve.app/api/sync/connections", {
        method: "POST", headers: { "x-hw-auth": "m", "content-type": "application/json" },
        body: JSON.stringify({ profile: "mallory", disconnect: id }),
      }));
      expect(res.status).toBe(404);
    }
    expect(store.grants.map((g) => g.revokedAt)).toEqual([null, null]);
  });

  it("a minted row whose account id is another account's is refused even with sam's storage key", async () => {
    store.tokens.set("x", { ...legacyRow("sam", { scope: "sync" }), accountId: M.id });
    const res = await sync.GET(new NextRequest("https://heatwayve.app/api/sync?profile=sam", { headers: { "x-hw-auth": "x" } }));
    expect(res.status).toBe(401);
  });

  it("after the handle moves to another account, the old holder's legacy cookie gets a 401 on it", async () => {
    live.accounts.push(B);
    live.handles.set("sam", B.id);
    store.tokens.set("c1", legacyRow("sam", { scope: "sync" }));
    for (const res of [
      await sync.GET(new NextRequest("https://heatwayve.app/api/sync?profile=sam", { headers: { cookie: "hw_sync=c1" } })),
      await photos.GET(new NextRequest("https://heatwayve.app/api/photos?profile=sam", { headers: { "x-hw-auth": "c1" } })),
      await connections.GET(new NextRequest("https://heatwayve.app/api/sync/connections?profile=sam", { headers: { cookie: "hw_sync=c1" } })),
    ]) expect(res.status).toBe(401);
    expect(call(dbm.dbReadProfile)).toEqual([]);
    expect(call(dbm.dbListPhotos)).toEqual([]);
  });

  it("the wipe of an id-keyed account holding \"sam\" keys by its id, never the name", async () => {
    live.accounts.push(B);
    live.handles.set("sam", B.id);
    store.tokens.set("w", { profile: B.storageKey, accountId: B.id, expires: Date.now() + HOUR });
    store.blobs.set("forge/profiles/sam/meta.json", "{}");
    const res = await sync.DELETE(new NextRequest("https://heatwayve.app/api/sync?profile=sam", { method: "DELETE", headers: { "x-hw-auth": "w" } }));
    expect(res.status).toBe(200);
    expect(call(dbm.dbDeleteProfile)).toEqual([[B.storageKey]]);
    expect(call(dbm.dbListPhotos)).toEqual([[B.storageKey]]);
    expect(call(blob.list).map((c) => c[0].prefix)).toEqual([`forge/profiles/${B.storageKey}/`]);
    expect(call(blob.del)[0][0]).toEqual([OLD.wipeDaily(B.storageKey), OLD.wipeWeekly(B.storageKey)]);
    expect(store.blobs.has("forge/profiles/sam/meta.json")).toBe(true);
  });
});

describe("token half: a reclaimed account keys by its own storage key, never the name", () => {
  const bRow = (extra = {}) => ({ profile: B.storageKey, accountId: B.id, expires: Date.now() + HOUR, createdAt: new Date().toISOString(), ...extra });
  beforeEach(() => {
    live.accounts.push(B);
    live.handles.set("sam", B.id);
  });

  it("photos POST, list, GET and DELETE use B's key and paths under B's prefix", async () => {
    store.tokens.set("t", bRow());
    const own = photoPath(B.storageKey, "2026-10-01");
    const res = await photos.POST(new NextRequest("https://heatwayve.app/api/photos?profile=Sam&date=2026-10-01", {
      method: "POST", headers: { "x-hw-auth": "t" }, body: jpeg,
    }));
    expect(res.status).toBe(200);
    expect(call(blob.put)[0][0]).toBe(`forge/profiles/${B.storageKey}/photos/2026-10-01.jpg`);
    expect(call(dbm.dbUpsertPhoto)[0]).toEqual([B.storageKey, { date: "2026-10-01", blobPath: own, bodyweightAt: null }]);

    expect((await photos.GET(new NextRequest("https://heatwayve.app/api/photos?profile=sam", { headers: { "x-hw-auth": "t" } }))).status).toBe(200);
    expect(call(dbm.dbListPhotos)).toEqual([[B.storageKey]]);
    expect(call(dbm.dbHasRetiredPhotos)).toEqual([[B.storageKey]]);

    vi.mocked(dbm.dbGetPhoto).mockResolvedValue({ blob_path: own });
    expect((await photos.GET(new NextRequest("https://heatwayve.app/api/photos?profile=sam&date=2026-10-01", { headers: { "x-hw-auth": "t" } }))).status).toBe(200);
    expect((await photos.DELETE(new NextRequest("https://heatwayve.app/api/photos?profile=sam&date=2026-10-01", { method: "DELETE", headers: { "x-hw-auth": "t" } }))).status).toBe(200);
    expect(call(dbm.dbGetPhoto)).toEqual([[B.storageKey, "2026-10-01"], [B.storageKey, "2026-10-01"]]);
    vi.mocked(dbm.dbGetPhoto).mockReset().mockResolvedValue(null);
    expect(call(dbm.dbDeletePhoto)).toEqual([[B.storageKey, "2026-10-01"]]);
    // Nothing under the name's directory was read, written or listed.
    for (const m of [blob.put, blob.get, blob.list]) {
      for (const [p] of call(m)) expect(String(typeof p === "string" ? p : p.prefix).startsWith("forge/profiles/sam/")).toBe(false);
    }
  });

  it("sync GET and PUT read and write B's key, and seed only from B's prefix", async () => {
    store.tokens.set("t", bRow({ scope: "sync" }));
    expect((await sync.GET(new NextRequest("https://heatwayve.app/api/sync?profile=sam", { headers: { "x-hw-auth": "t" } }))).status).toBe(200);
    expect(call(dbm.dbReadProfile)).toEqual([[B.storageKey]]);
    vi.mocked(dbm.dbReadProfile).mockResolvedValueOnce(null);
    const res = await sync.PUT(new NextRequest("https://heatwayve.app/api/sync", {
      method: "PUT", headers: { "x-hw-auth": "t", "content-type": "application/json" },
      body: JSON.stringify({ profile: "sam", data: { history: [] } }),
    }));
    expect(res.status).toBe(200);
    expect(call(dbm.dbInsertHistory)[0][0]).toBe(B.storageKey);
    expect(call(blob.list)[0][0]).toEqual({ prefix: profileDir(B.storageKey) });
    expect(call(blob.get).map((c) => c[0])).toEqual([metaPath(B.storageKey), historyPath(B.storageKey)]);
  });
});
