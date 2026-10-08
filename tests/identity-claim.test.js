// Name claim writes an account and its live handle in one transaction, beside
// the claim-marker blob; availability resolves through handles first, with the
// blob prefix kept as a union while IDENTITY_BLOB_FALLBACK is on. The route
// claims in CLAIM_MODE, shipped as "claim" (keyed by the account id, never
// the name). The "precutover" tests run the route as it was before the flip
// (keyed by the handle), which dbClaimHandle still accepts.
//
// Neon is simulated over two in-memory tables with the real constraints that
// matter here (live-handle uniqueness, storage-key uniqueness, the storage-key
// CHECK) and all-or-nothing transactions. Blob is an in-memory path map.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normaliseProfile } from "../lib/profile-name.js";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

const db = { accounts: [], handles: [], credentials: [], txns: [], race: null, fail: null, nextHandleId: 1 };
const blobs = new Map();
const puts = [];
const dels = [];
const tokens = new Map();
const profiles = new Map();

const unique = (detail) => Object.assign(new Error(`duplicate key value violates unique constraint (${detail})`), { code: "23505" });
const nowMs = () => Date.now();
const HOUR_MS = 3600_000;

function run(state, { q, values }) {
  if (/^\s*(CREATE|ALTER)\b/.test(q)) return [];
  if (q.includes("FROM handles h JOIN accounts a")) {
    const [h] = values;
    const row = state.handles.find((r) => r.handle === h && r.released_at == null
      && (r.kind === "primary" || (r.hold_until != null && r.hold_until > nowMs())));
    const acct = row && state.accounts.find((a) => a.id === row.account_id && a.deleted_at == null);
    return acct ? [{ ...acct, handle: row.handle, display: row.display, kind: row.kind, claimed_at: null, hold_until: row.hold_until }] : [];
  }
  if (/^\s*SELECT id, public_key[\s\S]*FROM credentials WHERE account_id = \?/.test(q)) {
    return state.credentials.filter((c) => c.account_id === values[0]).map((c) => ({ ...c }));
  }
  // Account lookups (token gates resolve through these once they carry identity).
  const byCol = q.match(/^\s*SELECT \* FROM accounts WHERE (id|storage_key) = \?/);
  if (byCol) return state.accounts.filter((a) => a[byCol[1]] === values[0]).slice(0, 1).map((a) => ({ ...a }));
  // The wipe's close (lib/identity-store.js dbCloseAccount).
  if (/^\s*UPDATE oauth_grants SET revoked_at = \?/.test(q)) return [];
  if (/^\s*UPDATE handles SET released_at = now\(\)\s+WHERE account_id = \?/.test(q)) {
    for (const r of state.handles) if (r.account_id === values[0] && r.released_at == null) r.released_at = nowMs();
    return [];
  }
  if (/^\s*UPDATE accounts SET deleted_at = now\(\), consent = NULL\s+WHERE id = \?/.test(q)) {
    for (const a of state.accounts) if (a.id === values[0]) Object.assign(a, { deleted_at: new Date().toISOString(), consent: null });
    return [];
  }
  if (/^\s*DELETE FROM credentials WHERE account_id = \?/.test(q)) {
    state.credentials = state.credentials.filter((c) => c.account_id !== values[0]);
    return [];
  }
  // The close's withdrawal of a waiting application to coach (none in these fixtures).
  if (/^\s*UPDATE trainer_applications SET status = CASE WHEN status = 'applied' THEN 'withdrawn' ELSE status END, [^\n]*about = NULL, link = NULL\s+WHERE account_id = \?$/.test(q)) return [];
  if (/^\s*UPDATE handles SET released_at = now\(\)/.test(q)) {
    const [h] = values;
    for (const r of state.handles) {
      if (r.handle === h && r.kind === "alias" && r.hold_until <= nowMs() && r.released_at == null) r.released_at = nowMs();
    }
    return [];
  }
  if (/^\s*INSERT INTO accounts \(id, storage_key, webauthn_user_id, origin\)/.test(q)) {
    const [id, storage_key, webauthn_user_id, origin] = values;
    if (db.fail) throw db.fail;
    for (const [k, v] of Object.entries({ id, storage_key, webauthn_user_id })) {
      if (state.accounts.some((a) => a[k] === v)) throw unique(`accounts.${k}`);
    }
    if (!(storage_key === id || ["backfill", "precutover_claim"].includes(origin))) {
      throw Object.assign(new Error("check constraint"), { code: "23514" });
    }
    state.accounts.push({ id, storage_key, webauthn_user_id, origin, roles: ["lifter"], plan: "free", consent: null, created_at: new Date().toISOString(), deleted_at: null });
    return [];
  }
  if (/^\s*INSERT INTO handles \(handle, account_id, display\)/.test(q)) {
    const [handle, account_id, display] = values;
    // A concurrent claimant commits between our account insert and our handle insert.
    if (db.race) {
      const commit = db.race;
      db.race = null;
      commit(db);
      if (state !== db) commit(state);
    }
    if (!state.accounts.some((a) => a.id === account_id)) throw Object.assign(new Error("fk"), { code: "23503" });
    if (state.handles.some((r) => r.handle === handle && r.released_at == null)) throw unique("handles_live");
    state.handles.push({ id: state.nextHandleId++, handle, account_id, display, kind: "primary", hold_until: null, released_at: null });
    return [];
  }
  throw new Error(`unexpected SQL: ${q}`);
}

const snapshot = (s) => ({
  accounts: s.accounts.map((a) => ({ ...a })),
  handles: s.handles.map((r) => ({ ...r })),
  credentials: s.credentials.map((c) => ({ ...c })),
  nextHandleId: s.nextHandleId,
});

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    // Lazy like the real driver: a statement runs when awaited, or inside transaction().
    const tag = (strings, ...values) => {
      const stmt = { q: strings.join("?"), values };
      return { ...stmt, then: (ok, ko) => new Promise((r) => r(run(db, stmt))).then(ok, ko) };
    };
    tag.transaction = async (queries) => {
      const draft = snapshot(db);
      const record = { statements: queries.map((s) => s.q.trim().split(/\s+/).slice(0, 3).join(" ")), committed: false };
      db.txns.push(record);
      const out = queries.map((s) => run(draft, s)); // throws → nothing committed
      Object.assign(db, draft);
      record.committed = true;
      return out;
    };
    return tag;
  },
}));

const blobResult = (body) => {
  const bytes = new TextEncoder().encode(body);
  return { statusCode: 200, stream: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
};
vi.mock("@vercel/blob", () => ({
  list: vi.fn(async ({ prefix }) => ({
    blobs: [...blobs.keys()].filter((p) => p.startsWith(prefix)).map((p) => ({ pathname: p, url: `https://blob/${p}`, uploadedAt: new Date().toISOString() })),
  })),
  put: vi.fn(async (path, body, opts) => {
    if (blobs.has(path) && !opts?.allowOverwrite) throw new Error("blob already exists");
    blobs.set(path, body);
    puts.push({ path, body: typeof body === "string" ? JSON.parse(body) : body, opts });
    return { pathname: path };
  }),
  get: vi.fn(async (path) => (blobs.has(path) ? blobResult(blobs.get(path)) : null)),
  del: vi.fn(async (urls) => {
    for (const u of [].concat(urls)) {
      const p = String(u).replace("https://blob/", "");
      dels.push(p);
      blobs.delete(p);
    }
  }),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => null, rateLimitShared: async () => null }));
// Profile rows and tokens in memory; sql/ensureSchema stay real (they reach the simulator).
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal()),
  dbInsertToken: vi.fn(async (token, rec) => { tokens.set(token, { ...rec, createdAt: rec.createdAt || new Date().toISOString() }); }),
  dbReadToken: vi.fn(async (token) => tokens.get(token) || null),
  dbDeleteToken: vi.fn(async (token) => { tokens.delete(token); }),
  dbReadProfile: vi.fn(async (sk) => profiles.get(sk) || null),
  dbInsertHistory: vi.fn(async (sk, history) => {
    const cur = profiles.get(sk) || { meta: {}, history: [] };
    const byId = new Map(cur.history.map((r) => [r.id, r]));
    for (const r of history || []) if (!byId.has(r.id)) byId.set(r.id, r);
    profiles.set(sk, { ...cur, history: [...byId.values()], cursor: "c" });
  }),
  dbReadMetaBase: vi.fn(async (sk) => ({ meta: { ...(profiles.get(sk)?.meta || {}) }, revs: {} })),
  dbWriteMetaGuarded: vi.fn(async (sk, meta) => {
    const cur = profiles.get(sk) || { meta: {}, history: [] };
    profiles.set(sk, { ...cur, meta: { ...cur.meta, ...(meta || {}) }, cursor: "c" });
    return true;
  }),
  dbDeleteProfile: vi.fn(async (sk) => { profiles.delete(sk); }),
  dbUpsertPhoto: vi.fn(async () => {}),
  dbListPhotos: vi.fn(async () => []),
  dbHasRetiredPhotos: vi.fn(async () => false),
  dbGetPhoto: vi.fn(async () => null),
}));
// The route's claim mode: what ships, unless a suite runs the post-flip mode.
const claimMode = { value: null };
vi.mock("@/lib/identity-store", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, get CLAIM_MODE() { return claimMode.value ?? real.CLAIM_MODE; } };
});
const inMode = (mode) => beforeEach(() => { claimMode.value = mode; });
// The blob fallback: on as shipped, unless a test runs it flipped off.
const fallback = { value: null };
vi.mock("@/lib/identity", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, get IDENTITY_BLOB_FALLBACK() { return fallback.value ?? real.IDENTITY_BLOB_FALLBACK; } };
});
// AI connections: an in-memory OAuth store; accounts and passkeys come from the simulator.
const oauth = { store: null };
vi.mock("@/lib/oauth-store", () => ({ neonOAuthStore: async () => oauth.store }));

const { GET, PUT, POST, DELETE } = await import("@/app/api/sync/route");
const { GET: photosGET, POST: photosPOST } = await import("@/app/api/photos/route");
const { POST: mcpPOST } = await import("@/app/mcp/route");
const { dbClaimHandle } = await import("@/lib/identity-store");
const { CLAIM_MODE: SHIPPED_MODE } = await vi.importActual("@/lib/identity-store");
const { mintAuthToken } = await import("@/lib/auth-server");
const { memoryStore, registerClient, issueCode, exchangeCode } = await import("@/lib/oauth");
const dbm = await import("@/lib/db");
const { list, put } = await import("@vercel/blob");

const claimReq = (profile, displayName = profile) => new Request("https://heatwayve.app/api/sync", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile, displayName }),
});
const claim = (profile, displayName) => POST(claimReq(profile, displayName));
const check = async (profile) => {
  const res = await GET(new Request(`https://heatwayve.app/api/sync?${new URLSearchParams({ profile, check: "1" })}`));
  expect(res.status).toBe(200);
  return (await res.json()).exists;
};
// Today's path formula, frozen here: an existing account (key = its handle) still lands exactly on it.
const todayMetaPath = (name) => `forge/profiles/${encodeURIComponent(normaliseProfile(name))}/meta.json`;
const idMetaPath = (id) => `forge/profiles/${id}/meta.json`;
const ACCOUNT_ID = /^hwa_[a-z2-7]{26}$/;

const A = "hwa_" + "a".repeat(26);
const B = "hwa_" + "b".repeat(26);
const seedInto = (s, id, sk, handle, extra = {}) => {
  s.accounts.push({ id, storage_key: sk, webauthn_user_id: `uid-${id}`, origin: "backfill", roles: ["lifter"], plan: "free", consent: null, deleted_at: null });
  s.handles.push({ id: s.nextHandleId++, handle, account_id: id, display: handle, kind: "primary", hold_until: null, released_at: null, ...extra });
};
const seedAccount = (id, sk, handle, extra = {}) => seedInto(db, id, sk, handle, extra);
const state = () => JSON.stringify({ a: db.accounts, h: db.handles, b: [...blobs.keys()] });
// A passkey on the index: what a registered account holds once its blobs are gone.
const indexPasskey = (accountId) => db.credentials.push({ id: `cred-${accountId}`, account_id: accountId, public_key: "pk", counter: 0, transports: [], rp_id: "heatwayve.app", user_handle: "uh", source: "register", created_at: null, last_used_at: null });

beforeEach(() => {
  process.env.DATABASE_URL = "postgres://fake";
  claimMode.value = null;
  fallback.value = null;
  Object.assign(db, { accounts: [], handles: [], credentials: [], txns: [], race: null, fail: null, nextHandleId: 1 });
  vi.mocked(put).mockClear();
  blobs.clear(); puts.length = 0; dels.length = 0; tokens.clear(); profiles.clear();
  vi.mocked(list).mockClear();
});
afterEach(() => { delete process.env.DATABASE_URL; delete process.env.CRON_SECRET; });

describe("a claim writes one account, one live handle and the marker", () => {
  it("in precutover mode, a claim is keyed by its handle: alias release, account, handle, in one transaction", async () => {
    claimMode.value = "precutover";
    const res = await claim("Sam", "Sam");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, claimed: true });
    expect(db.txns).toEqual([{ statements: ["UPDATE handles SET", "INSERT INTO accounts", "INSERT INTO handles"], committed: true }]);
    expect(db.accounts).toHaveLength(1);
    const [acct] = db.accounts;
    expect(acct.id).toMatch(ACCOUNT_ID);
    expect(acct).toMatchObject({ storage_key: "sam", origin: "precutover_claim", roles: ["lifter"], plan: "free", deleted_at: null });
    expect(acct.webauthn_user_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(db.handles).toEqual([expect.objectContaining({ handle: "sam", account_id: acct.id, display: "Sam", kind: "primary", released_at: null })]);
    // Byte-identical to today's marker.
    expect(puts.map((p) => p.path)).toEqual([todayMetaPath("Sam")]);
    expect(puts[0].opts).toMatchObject({ access: "private", addRandomSuffix: false });
    expect(puts[0].opts.allowOverwrite).toBeFalsy();
    expect(puts[0].body).toMatchObject({ displayName: "Sam", weights: {}, reps: {}, streak: { count: 0, lastDate: null } });
  });

  it("in precutover mode, awkward names key and mark exactly where today's formula puts them", async () => {
    claimMode.value = "precutover";
    const names = ["café".normalize("NFD"), "a b", "x%y", "o'neil", "Kelvin", "ＭＩＸ", "\u01F0ohn", "\u1FF6"];
    for (const n of names) {
      const before = db.accounts.length;
      expect((await claim(n)).status, n).toBe(200);
      const acct = db.accounts[before];
      expect(acct.storage_key, n).toBe(normaliseProfile(n));
      expect(db.handles.at(-1).handle, n).toBe(normaliseProfile(n));
      expect(puts.at(-1).path, n).toBe(todayMetaPath(n));
    }
  });

  it("a name whose key is not a fixed point of normaliseProfile is refused, and writes nothing", async () => {
    // NFKC runs before lowercasing, so J+U+030C keys to j+U+030C, which a
    // second pass folds onto U+01F0: another person's key. Same for Omega+U+0342.
    expect((await claim("\u01F0ohn")).status).toBe(200);
    const before = state();
    const txnsBefore = db.txns.length;
    const putsBefore = puts.length;
    for (const n of ["J\u030Cohn", "\u03A9\u0342"]) {
      expect(normaliseProfile(normaliseProfile(n)), n).not.toBe(normaliseProfile(n));
      expect((await claim(n)).status, n).toBe(400);
      // Availability agrees: the name is never offered.
      const res = await GET(new Request(`https://heatwayve.app/api/sync?${new URLSearchParams({ profile: n, check: "1" })}`));
      expect(res.status, n).toBe(400);
    }
    // Nor as a display name.
    expect((await claim("john", "J\u030Cohn")).status).toBe(400);
    expect(state()).toEqual(before);
    expect(db.txns.length).toBe(txnsBefore);
    expect(puts.length).toBe(putsBefore);
    // The store refuses it too, before any SQL.
    await expect(dbClaimHandle({ handle: "J\u030Cohn", display: "x", mode: "precutover" })).rejects.toThrow("handle not claimable");
    expect(db.txns.length).toBe(txnsBefore);
  });

  it("a second claim of the same handle, in any casing or NFKC form, is 409 and writes nothing", async () => {
    expect((await claim("Sam")).status).toBe(200);
    // Drop the marker: the handle (with its passkey) alone must hold the name.
    blobs.clear();
    indexPasskey(db.accounts[0].id);
    const before = state();
    const txnsBefore = db.txns.length;
    for (const n of ["sam", "SAM", "  Sam ", "ＳＡＭ", "ｓａｍ"]) {
      const res = await claim(n);
      expect(res.status, n).toBe(409);
      expect(await res.json(), n).toEqual({ error: "Name taken", exists: true });
    }
    expect(state()).toBe(before);
    expect(db.txns.length).toBe(txnsBefore);
    expect(puts).toHaveLength(1);
  });

  it("a race loser rolls back whole: no account, no handle, no marker", async () => {
    // Both claimants pass the availability read; the other commits mid-way through ours.
    db.race = (s) => seedInto(s, B, "sam-b", "sam");
    const res = await claim("Sam");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Name taken", exists: true });
    expect(db.accounts.map((a) => a.id)).toEqual([B]);
    expect(db.handles.map((h) => h.account_id)).toEqual([B]);
    expect(puts).toEqual([]);
    expect(db.txns).toEqual([{ statements: ["UPDATE handles SET", "INSERT INTO accounts", "INSERT INTO handles"], committed: false }]);
  });

  it("names starting hwa_ are reserved (handle or display), before any read or write", async () => {
    for (const [p, d] of [["HWA_abc", "HWA_abc"], ["hwa_x", undefined], ["sam", "ＨＷＡ_sam"]]) {
      const res = await POST(claimReq(p, d));
      expect(res.status, p).toBe(400);
      expect(await res.json()).toEqual({ error: "That name is reserved" });
    }
    expect(db.txns).toEqual([]);
    expect(list).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
  });

  it("a name whose key is dots or holds a separator is refused, however it is spelled", async () => {
    // NFKC folds these to "..", "..", ".", "...", "a/b" and "a\\b": the key, not the input, builds paths.
    const names = ["\u2025", "\uFF0E\uFF0E", "\u2024", "\u2026", "a\uFF0Fb", "a\uFF3Cb"];
    for (const n of names) {
      expect((await claim(n, "Sam")).status, n).toBe(400);
      expect((await claim("Sam", n)).status, n).toBe(400);
      const res = await GET(new Request(`https://heatwayve.app/api/sync?${new URLSearchParams({ profile: n, check: "1" })}`));
      expect(res.status, n).toBe(400);
      await expect(dbClaimHandle({ handle: n, display: n, mode: "precutover" }), n).rejects.toThrow("handle not claimable");
      const photo = await photosGET(new Request(`https://heatwayve.app/api/photos?${new URLSearchParams({ profile: n })}`));
      expect(photo.status, n).toBe(400);
    }
    expect(db.txns).toEqual([]);
    expect(db.accounts).toEqual([]);
    expect(list).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
  });

  it("no handle but a blob under the prefix (fallback on) is 409 and writes nothing", async () => {
    blobs.set("forge/profiles/kelvin/meta-Ab12.json", "{}"); // legacy suffixed era
    expect((await claim("Kelvin")).status).toBe(409);
    expect((await claim("Kelvin")).status).toBe(409);
    expect(db.txns).toEqual([]);
    expect(db.accounts).toEqual([]);
    expect(puts).toEqual([]);
  });

  it("with the fallback off but claims keyed by name (precutover), a name holding blobs stays taken", async () => {
    // A claim keyed by the name would adopt its prefix and serve the data.
    fallback.value = false;
    claimMode.value = "precutover";
    blobs.set("forge/profiles/ghost/meta.json", JSON.stringify({ displayName: "Ghost", weights: { squat: 140 } }));
    expect(await check("Ghost")).toBe(true);
    expect((await claim("Ghost")).status).toBe(409);
    expect(db.txns).toEqual([]);
    expect(db.accounts).toEqual([]);
    expect(puts).toEqual([]);
  });

  it("with the fallback off too, blobs under a name stop holding it: the claim is keyed by its own id", async () => {
    fallback.value = false;
    claimMode.value = "claim";
    blobs.set("forge/profiles/ghost/meta.json", JSON.stringify({ displayName: "Ghost" }));
    expect(await check("Ghost")).toBe(false);
    expect((await claim("Ghost")).status).toBe(200);
    const [acct] = db.accounts;
    expect(acct.storage_key).toBe(acct.id);
    expect(puts.map((p) => p.path)).toEqual([idMetaPath(acct.id)]);
  });

  it("a database error other than a unique violation is a 500 that writes nothing", async () => {
    db.fail = Object.assign(new Error("conn"), { code: "08006" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await claim("Sam");
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(puts).toEqual([]);
    expect(db.accounts).toEqual([]);
    expect(db.handles).toEqual([]);
    expect(db.txns).toEqual([expect.objectContaining({ committed: false })]);
  });

  it("a claim whose marker put failed is finished by the retry, on the same account", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(put).mockImplementationOnce(async () => { throw new Error("blob 503"); });
    expect((await claim("Sam")).status).toBe(500);
    spy.mockRestore();
    expect(blobs.size).toBe(0);
    expect(db.accounts).toHaveLength(1);
    // Offered as free again, and the retry completes it: no second account or transaction.
    expect(await check("sam")).toBe(false);
    const res = await claim("Sam");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, claimed: true });
    expect(db.txns).toHaveLength(1);
    expect(db.accounts).toHaveLength(1);
    expect(db.handles).toHaveLength(1);
    expect(puts.map((p) => p.path)).toEqual([idMetaPath(db.accounts[0].storage_key)]);
    expect(puts[0].opts.allowOverwrite).toBeFalsy();
    // Finished now: the marker holds the name.
    expect(await check("SAM")).toBe(true);
    expect((await claim("SAM")).status).toBe(409);
    expect(puts).toHaveLength(1);
  });

  it("only a fresh, marker-less, passkey-less claim keyed by its own id (or, pre-cutover, its handle) is finished", async () => {
    const markerless = (id, sk, handle, origin, extra) => {
      seedAccount(id, sk, handle, extra);
      Object.assign(db.accounts.at(-1), { origin, created_at: new Date().toISOString() });
    };
    markerless(A, A, "sam", "claim");
    indexPasskey(A);                                          // a passkey on the index
    markerless(B, "alex", "alex", "backfill");                // a backfilled name
    const C = "hwa_" + "c".repeat(26);
    markerless(C, C, "kim", "reclaim");                       // id-keyed, but a reclaim
    const D = "hwa_" + "d".repeat(26);
    markerless(D, D, "lee", "claim");
    blobs.set(`forge/profiles/${D}/history.json`, "[]");      // data under its own prefix
    const E = "hwa_" + "e".repeat(26);
    markerless(E, "ann", "ann", "claim");                     // a claim not keyed by its id
    const before = state();
    for (const n of ["sam", "alex", "kim", "lee", "ann"]) {
      expect(await check(n), n).toBe(true);
      expect((await claim(n)).status, n).toBe(409);
    }
    expect(state()).toBe(before);
    expect(db.txns).toEqual([]);
    expect(puts).toEqual([]);

    // Finished on the same account and key: an id-keyed claim, and one from before cutover.
    const F = "hwa_" + "f".repeat(26);
    markerless(F, F, "max", "claim");
    const G = "hwa_" + "g".repeat(26);
    markerless(G, "joe", "joe", "precutover_claim");
    for (const n of ["max", "joe"]) {
      expect(await check(n), n).toBe(false);
      expect((await claim(n)).status, n).toBe(200);
    }
    expect(db.txns).toEqual([]);
    expect(puts.map((p) => p.path)).toEqual([idMetaPath(F), todayMetaPath("joe")]);
  });

  it("a used or stale marker-less claim stays taken, and nothing passes to the next claimant", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Consent on record: someone used this account (e.g. registered, then wiped).
    vi.mocked(put).mockImplementationOnce(async () => { throw new Error("blob 503"); });
    expect((await claim("Sam")).status).toBe(500);
    db.accounts[0].consent = { version: "2026-09-29", at: "2026-10-01T00:00:00.000Z" };
    // Older than the retry window, no consent.
    vi.mocked(put).mockImplementationOnce(async () => { throw new Error("blob 503"); });
    expect((await claim("Alex")).status).toBe(500);
    db.accounts[1].created_at = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    // No creation time at all: refuse.
    vi.mocked(put).mockImplementationOnce(async () => { throw new Error("blob 503"); });
    expect((await claim("Kim")).status).toBe(500);
    db.accounts[2].created_at = null;
    spy.mockRestore();
    const before = state();
    for (const n of ["sam", "alex", "kim"]) {
      expect(await check(n), n).toBe(true);
      expect((await claim(n)).status, n).toBe(409);
    }
    expect(state()).toBe(before);
    expect(db.txns).toHaveLength(3);
    expect(puts).toEqual([]);
  });

  it("without a DB the claim is today's blob-only claim", async () => {
    delete process.env.DATABASE_URL;
    expect((await claim("Sam")).status).toBe(200);
    expect(db.txns).toEqual([]);
    expect(db.accounts).toEqual([]);
    expect(puts.map((p) => p.path)).toEqual(["forge/profiles/sam/meta.json"]);
    expect((await claim("SAM")).status).toBe(409);
    expect(puts).toHaveLength(1);
  });
});

describe("as shipped (CLAIM_MODE \"claim\"), a new account is keyed by its id", () => {
  inMode("claim");

  it("ships in claim mode", () => {
    expect(SHIPPED_MODE).toBe("claim");
  });

  it("free name: alias release, account, handle, in one transaction; storage key = the account id", async () => {
    const res = await claim("Sam", "Sam");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, claimed: true });
    expect(db.txns).toEqual([{ statements: ["UPDATE handles SET", "INSERT INTO accounts", "INSERT INTO handles"], committed: true }]);
    expect(db.accounts).toHaveLength(1);
    const [acct] = db.accounts;
    expect(acct.id).toMatch(ACCOUNT_ID);
    expect(acct).toMatchObject({ storage_key: acct.id, origin: "claim", roles: ["lifter"], plan: "free", deleted_at: null });
    expect(acct.webauthn_user_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Availability stays by handle: the name is the handle, never the key.
    expect(db.handles).toEqual([expect.objectContaining({ handle: "sam", account_id: acct.id, display: "Sam", kind: "primary", released_at: null })]);
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe(idMetaPath(acct.id));
    expect([...blobs.keys()].filter((p) => p.startsWith("forge/profiles/sam/"))).toEqual([]);
    expect(puts[0].opts).toMatchObject({ access: "private", addRandomSuffix: false });
    expect(puts[0].opts.allowOverwrite).toBeFalsy();
    expect(puts[0].body).toMatchObject({ displayName: "Sam", weights: {}, reps: {}, streak: { count: 0, lastDate: null } });
  });

  it("awkward names: the handle is the normalised name, the key and marker path are the id's", async () => {
    // Every name a claim accepts handles to a fixed point of normaliseProfile.
    const names = ["café".normalize("NFD"), "a b", "x%y", "o'neil", "Kelvin", "ＭＩＸ", "\u01F0ohn", "\u1FF6"];
    for (const n of names) {
      const before = db.accounts.length;
      expect((await claim(n)).status, n).toBe(200);
      const acct = db.accounts[before];
      expect(acct.storage_key, n).toBe(acct.id);
      expect(acct.storage_key, n).toMatch(ACCOUNT_ID);
      expect(db.handles.at(-1).handle, n).toBe(normaliseProfile(n));
      expect(puts.at(-1).path, n).toBe(idMetaPath(acct.id));
      expect(puts.at(-1).path, n).not.toBe(todayMetaPath(n));
    }
    expect(new Set(db.accounts.map((a) => a.storage_key)).size).toBe(names.length);
    // The same input finds its own handle again (no marker to lean on; each
    // account holds a passkey, so none reads as an unfinished claim).
    blobs.clear();
    for (const a of db.accounts) indexPasskey(a.id);
    const txnsBefore = db.txns.length;
    for (const n of names) {
      expect(await check(n), n).toBe(true);
      expect((await claim(n)).status, n).toBe(409);
    }
    expect(db.txns.length).toBe(txnsBefore);
    expect(db.accounts).toHaveLength(names.length);
  });

  it("a released name-keyed handle is claimed by a NEW id-keyed account that inherits nothing", async () => {
    seedAccount(A, "sam", "sam", { released_at: Date.now() - 1000 });
    const oldAccount = JSON.stringify(db.accounts[0]);
    expect(await check("sam")).toBe(false);
    expect((await claim("sam")).status).toBe(200);
    expect(JSON.stringify(db.accounts[0])).toBe(oldAccount);
    const fresh = db.accounts[1];
    expect(fresh).toMatchObject({ storage_key: fresh.id, origin: "claim" });
    expect(fresh.webauthn_user_id).not.toBe(db.accounts[0].webauthn_user_id);
    expect(puts.map((p) => p.path)).toEqual([idMetaPath(fresh.id)]);
  });

});

describe("existing names resolve to their backfilled account", () => {
  it("check=1 and claim answer from the handle, without listing blobs", async () => {
    seedAccount(A, "sam", "sam");
    for (const n of ["sam", "Sam", " SAM ", "ＳＡＭ"]) expect(await check(n), n).toBe(true);
    expect(list).not.toHaveBeenCalled();
    const before = state();
    expect((await claim("Sam")).status).toBe(409);
    expect(state()).toBe(before);
    expect(db.txns).toEqual([]);
  });

  it("a backfilled name whose data is DB-only (no blob) is still taken", async () => {
    seedAccount(A, "dbonly", "dbonly");
    expect(await check("DbOnly")).toBe(true);
    expect((await claim("dbonly")).status).toBe(409);
  });
});

describe("check=1", () => {
  it("live handle → taken; free name → free", async () => {
    seedAccount(A, "sam", "sam");
    expect(await check("sam")).toBe(true);
    expect(await check("alex")).toBe(false);
  });

  it("released handle with no blobs → free; a claim keeps the released row beside the new one", async () => {
    seedAccount(A, A, "sam", { released_at: Date.now() - 1000 }); // an id-keyed account
    expect(await check("sam")).toBe(false);
    expect((await claim("sam")).status).toBe(200);
    expect(db.handles.map((h) => [h.account_id === A, h.released_at == null])).toEqual([[true, false], [false, true]]);
    expect(db.accounts).toHaveLength(2);
  });

  it("as shipped, a released handle whose key its old account still holds is claimed keyed by the new id", async () => {
    seedAccount(A, "sam", "sam", { released_at: Date.now() - 1000 });
    expect(await check("sam")).toBe(false);
    expect((await claim("sam")).status).toBe(200);
    const fresh = db.accounts.find((a) => a.id !== A);
    expect(fresh).toMatchObject({ storage_key: fresh.id, origin: "claim" });
    expect(db.accounts.find((a) => a.id === A).storage_key).toBe("sam");
    expect(puts.map((p) => p.path)).toEqual([idMetaPath(fresh.id)]);
    expect(await check("sam")).toBe(true);
  });

  it("an alias past its hold → free (released on claim); an alias in its hold → taken", async () => {
    seedAccount(A, "sam", "sam");
    db.handles.push({ id: db.nextHandleId++, handle: "old", account_id: A, display: "old", kind: "alias", hold_until: Date.now() - 1000, released_at: null });
    expect(await check("old")).toBe(false);
    expect((await claim("old")).status).toBe(200);
    expect(db.handles.find((h) => h.kind === "alias").released_at).not.toBeNull();
    expect(db.handles.filter((h) => h.handle === "old" && h.released_at == null)).toHaveLength(1);

    db.handles.push({ id: db.nextHandleId++, handle: "held", account_id: A, display: "held", kind: "alias", hold_until: Date.now() + 86400000, released_at: null });
    expect(await check("held")).toBe(true);
    expect((await claim("held")).status).toBe(409);
  });

  it("reserved names (hwa_) report taken, without listing blobs or writing", async () => {
    for (const n of ["hwa_x", "HWA_abc", "ＨＷＡ_sam"]) expect(await check(n), n).toBe(true);
    expect(list).not.toHaveBeenCalled();
    expect(db.txns).toEqual([]);
  });

  it("no handle but a blob under the prefix → taken while the fallback is on", async () => {
    blobs.set("forge/profiles/legacy/history-x1.json", "[]");
    expect(await check("Legacy")).toBe(true);
  });
});

describe("the wipe's no-token hint reads the account holding the name", () => {
  const hint = async (profile) => {
    const res = await DELETE(new Request(`https://heatwayve.app/api/sync?${new URLSearchParams({ profile })}`, { method: "DELETE" }));
    expect(res.status).toBe(401);
    return res.json();
  };
  const realDoc = JSON.stringify({ credentials: [{ id: "old", publicKey: "pk" }] });

  it("a passkey only in the index asks for sign-in, not setup", async () => {
    seedAccount(A, "sam", "sam");
    indexPasskey(A);
    expect(await hint("Sam")).toMatchObject({ requiresAuth: true });
  });

  it("a doc under the name's prefix does not speak for an account keyed elsewhere", async () => {
    seedAccount(B, B, "sam");
    blobs.set("forge/profiles/sam/credentials.json", realDoc);
    expect(await hint("Sam")).toMatchObject({ requiresPasskeySetup: true });
    blobs.set(`forge/profiles/${B}/credentials.json`, realDoc);
    expect(await hint("Sam")).toMatchObject({ requiresAuth: true });
  });

  it("no account holding the name: setup, whatever blobs sit under it", async () => {
    blobs.set("forge/profiles/sam/credentials.json", realDoc);
    expect(await hint("Sam")).toMatchObject({ requiresPasskeySetup: true });
    expect(dels).toEqual([]);
  });
});

describe("a new account's reads and writes resolve to its id, never the name", () => {
  inMode("claim");
  const jpeg = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x02,
    0xff, 0xd9,
  ]);
  const calls = (m) => vi.mocked(m).mock.calls;
  const claimed = async (name) => {
    expect((await claim(name)).status).toBe(200);
    const acct = db.accounts.at(-1);
    expect(acct.storage_key).toBe(acct.id);
    return acct;
  };
  const underName = (name) => (p) => String(p).startsWith(`forge/profiles/${name}/`);
  beforeEach(() => {
    for (const m of [dbm.dbReadProfile, dbm.dbWriteMetaGuarded, dbm.dbUpsertPhoto, dbm.dbInsertToken]) vi.mocked(m).mockClear();
  });

  it("sync GET and PUT: the claim marker, the seed and the rows are all the id's", async () => {
    const acct = await claimed("Sam");
    vi.mocked(list).mockClear(); // the claim's availability probe lists the name: that stays by handle
    const token = await mintAuthToken({ profile: "Sam", ttlMs: HOUR_MS, scope: "sync" });
    expect(calls(dbm.dbInsertToken)[0][1]).toMatchObject({ profile: acct.id, accountId: acct.id });
    const auth = { "x-hw-auth": token };

    const first = await GET(new Request("https://heatwayve.app/api/sync?profile=Sam", { headers: auth }));
    expect(first.status).toBe(200);
    expect((await first.json()).meta.displayName).toBe("Sam");
    expect(calls(dbm.dbReadProfile)).toEqual([[acct.id]]);

    const res = await PUT(new Request("https://heatwayve.app/api/sync", {
      method: "PUT", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ profile: "sam", data: { meta: { weights: { Squat: 100 } }, history: [{ id: "2026-10-01T10:00:00.000Z", date: "2026-10-01" }] } }),
    }));
    expect(res.status).toBe(200);
    expect(calls(dbm.dbWriteMetaGuarded).map((c) => c[0])).toEqual([acct.id]);
    expect(profiles.get(acct.id).meta).toMatchObject({ displayName: "Sam", weights: { Squat: 100 } });
    expect(profiles.has("sam")).toBe(false);

    const again = await GET(new Request("https://heatwayve.app/api/sync?profile=SAM", { headers: auth }));
    expect((await again.json()).meta.weights).toEqual({ Squat: 100 });
    expect(calls(dbm.dbReadProfile).map((c) => c[0])).toEqual([acct.id, acct.id, acct.id]);
    // Nothing under the name's directory was listed, read or written.
    for (const m of [list, put]) for (const [p] of calls(m)) expect(underName("sam")(typeof p === "string" ? p : p.prefix), JSON.stringify(p)).toBe(false);
  });

  it("photos: the blob path and the index row are the id's", async () => {
    const acct = await claimed("Sam");
    const token = await mintAuthToken({ profile: "Sam", ttlMs: HOUR_MS });
    const res = await photosPOST(new NextRequest("https://heatwayve.app/api/photos?profile=Sam&date=2026-10-01", {
      method: "POST", headers: { "x-hw-auth": token }, body: jpeg,
    }));
    expect(res.status).toBe(200);
    const path = `forge/profiles/${acct.id}/photos/2026-10-01.jpg`;
    expect(blobs.has(path)).toBe(true);
    expect(calls(dbm.dbUpsertPhoto)).toEqual([[acct.id, { date: "2026-10-01", blobPath: path, bodyweightAt: null }]]);
    expect([...blobs.keys()].filter(underName("sam"))).toEqual([]);
  });

  it("MCP: a grant on the new account reads the id's rows", async () => {
    const acct = await claimed("Sam");
    indexPasskey(acct.id);
    oauth.store = memoryStore();
    const REDIRECT = "https://claude.ai/cb";
    const verifier = "v".repeat(50);
    const { client } = await registerClient(oauth.store, { redirect_uris: [REDIRECT] });
    const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    const { code } = await issueCode(oauth.store, { clientId: client.id, accountId: acct.id, profile: acct.storage_key, credentialId: `cred-${acct.id}`, redirectUri: REDIRECT, codeChallenge, codeChallengeMethod: "S256" });
    const { tokens: t } = await exchangeCode(oauth.store, { code, clientId: client.id, redirectUri: REDIRECT, codeVerifier: verifier });
    profiles.set(acct.id, { meta: {}, history: [], cursor: "c" });
    const res = await mcpPOST(new Request("https://heatwayve.app/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "training_snapshot", arguments: {} } }),
    }));
    expect(res.status).toBe(200);
    expect(calls(dbm.dbReadProfile)).toEqual([[acct.id]]);
  });

  it("the existing accounts beside it keep their name keys and rows, untouched", async () => {
    const SEVEN = ["abrar", "sam", "alex", "kim", "lee", "jo", "max"];
    SEVEN.forEach((n, i) => {
      seedAccount("hwa_" + String.fromCharCode(97 + i).repeat(26), n, n);
      profiles.set(n, { meta: { displayName: n }, history: [], cursor: "c" });
    });
    const before = JSON.stringify({ a: db.accounts, h: db.handles });
    const fresh = await claimed("Newbie");
    expect(JSON.stringify({ a: db.accounts.slice(0, 7), h: db.handles.slice(0, 7) })).toBe(before);
    expect(db.accounts.map((a) => a.storage_key)).toEqual([...SEVEN, fresh.id]);
    for (const n of SEVEN) {
      expect(await check(n), n).toBe(true);
      vi.mocked(dbm.dbReadProfile).mockClear();
      const token = await mintAuthToken({ profile: n, ttlMs: HOUR_MS, scope: "sync" });
      const res = await GET(new Request(`https://heatwayve.app/api/sync?profile=${n}`, { headers: { "x-hw-auth": token } }));
      expect(res.status, n).toBe(200);
      expect(calls(dbm.dbReadProfile), n).toEqual([[n]]);
    }
  });
});

describe("the nightly self-test's throwaway claim and wipe still pass", () => {
  const runSelftest = async () => {
    process.env.CRON_SECRET = "s3cret";
    const { GET: selftest } = await import("@/app/api/cron/sync-selftest/route");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await selftest(new Request("https://heatwayve.app/api/cron/sync-selftest", { headers: { authorization: "Bearer s3cret" } }));
    spy.mockRestore();
    return { res, body: await res.json() };
  };
  const CLEANUP = "cleanup DELETE releases the throwaway profile";

  it("in claim mode, its claim, reads, writes and cleanup all run on an account keyed by its id", async () => {
    claimMode.value = "claim";
    const { body } = await runSelftest();
    expect(body.failures).toEqual([]);
    expect(body.checks.map((c) => c.name)).toContain(CLEANUP);
    expect(body.checks.length).toBeGreaterThan(10);
    expect(body.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["check=1 free before claim", "POST claims the name", "re-claim 409s", "claimed-but-unwritten GET serves the claim marker", "GET round-trips meta exactly"]));
    const [acct] = db.accounts;
    expect(acct).toMatchObject({ storage_key: acct.id, origin: "claim" });
    expect(db.handles).toEqual([expect.objectContaining({ handle: body.profile, account_id: acct.id })]);
    expect(puts.map((p) => p.path)).toEqual([idMetaPath(acct.id)]);
    expect([...profiles.keys()]).not.toContain(body.profile);
    // The cleanup wiped the id-keyed folder and closed the account.
    expect(dels).toContain(idMetaPath(acct.id));
    expect(acct.deleted_at).not.toBeNull();
    expect(db.handles[0].released_at).not.toBeNull();
  });

  // In the mode that ships.
  it("runs green in the shipped mode, and its cleanup wipes the claimed account's data", async () => {
    const { res, body } = await runSelftest();
    expect(body.failures).toEqual([]);
    expect(res.status).toBe(200);
    const [acct] = db.accounts;
    expect(acct.origin).toBe(SHIPPED_MODE === "claim" ? "claim" : "precutover_claim");
    expect(dels).toContain(idMetaPath(acct.storage_key));
    expect([...blobs.keys()].filter((p) => p.includes(acct.id) || p.includes(acct.storage_key) || p.includes(body.profile))).toEqual([]);
  });
});
