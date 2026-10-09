// The profile wipe closes the account. Keyed by the token's account (its
// storage key), never the requested name: photo blobs go by the account's own
// index rows, the rest of its folder only by enumerated file patterns, and the
// close (grants revoked, handles released, account closed with consent
// cleared, its credentials rows deleted, a waiting application to coach
// withdrawn with what it said cleared) runs last in one transaction.
//
// Neon is simulated over accounts / handles / credentials / oauth_grants /
// trainer_applications / trainer_changes (read only: the wipe's dry run) with
// all-or-nothing transactions; profile rows, photo index rows and tokens sit
// in memory behind the db.js helpers. Blob is an in-memory path map.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normaliseProfile } from "../lib/profile-name.js";
import { NextRequest } from "next/server";

const db = { accounts: [], handles: [], credentials: [], grants: [], applications: [], changes: [], changeSql: [], failChanges: false, txns: [], failTxn: null, nextHandleId: 1 };
const blobs = new Map();
const dels = [];
const blobFail = { del: null };
const tokens = new Map();
const profiles = new Map();
const photoRows = [];
const oauthTokens = new Map();

const unique = (detail) => Object.assign(new Error(`duplicate key value violates unique constraint (${detail})`), { code: "23505" });
const norm = (q) => q.replace(/\s+/g, " ").trim();

function run(state, { q, values }) {
  const s = norm(q);
  if (/^(CREATE|ALTER)\b/.test(s)) return [];
  // trainer_changes: only the wipe's dry-run read is served; anything else throws.
  if (/\btrainer_changes\b/.test(s)) {
    state.changeSql.push(s);
    if (state.failChanges) throw new Error("db unavailable");
    if (s === "SELECT id FROM trainer_changes WHERE profile = ? AND cleared_at IS NULL ORDER BY created_at, id") {
      return state.changes.filter((c) => c.profile === values[0] && c.cleared_at == null)
        .sort((x, y) => x.created_at - y.created_at || (x.id < y.id ? -1 : 1)).map((c) => ({ id: c.id }));
    }
  }
  if (s.includes("FROM handles h JOIN accounts a")) {
    const [h] = values;
    const row = state.handles.find((r) => r.handle === h && r.released_at == null && r.kind === "primary");
    const acct = row && state.accounts.find((a) => a.id === row.account_id && a.deleted_at == null);
    return acct ? [{ ...acct, handle: row.handle, display: row.display, kind: row.kind, claimed_at: null, hold_until: null }] : [];
  }
  if (/^SELECT id, public_key[\s\S]*FROM credentials WHERE account_id = \?/.test(s)) {
    return state.credentials.filter((c) => c.account_id === values[0]).map((c) => ({ ...c }));
  }
  const byCol = s.match(/^SELECT \* FROM accounts WHERE (id|storage_key) = \?/);
  if (byCol) return state.accounts.filter((a) => a[byCol[1]] === values[0]).slice(0, 1).map((a) => ({ ...a }));
  // The claim's expired-alias release (no aliases exist here).
  if (s.startsWith("UPDATE handles SET released_at = now() WHERE handle = ? AND kind = 'alias'")) return [];
  if (/^INSERT INTO accounts \(id, storage_key, webauthn_user_id, origin\)/.test(s)) {
    const [id, storage_key, webauthn_user_id, origin] = values;
    for (const [k, v] of Object.entries({ id, storage_key, webauthn_user_id })) {
      if (state.accounts.some((a) => a[k] === v)) throw unique(`accounts.${k}`);
    }
    state.accounts.push({ id, storage_key, webauthn_user_id, origin, roles: ["lifter"], plan: "free", consent: null, created_at: new Date().toISOString(), deleted_at: null });
    return [];
  }
  if (/^INSERT INTO handles \(handle, account_id, display\)/.test(s)) {
    const [handle, account_id, display] = values;
    if (state.handles.some((r) => r.handle === handle && r.released_at == null)) throw unique("handles_live");
    state.handles.push({ id: state.nextHandleId++, handle, account_id, display, kind: "primary", released_at: null });
    return [];
  }
  // ── The close ──
  if (s === "UPDATE oauth_grants SET revoked_at = ? WHERE (account_id = ? OR (account_id IS NULL AND profile = ?)) AND revoked_at IS NULL") {
    const [at, a, sk] = values;
    for (const g of state.grants) {
      if ((g.account_id === a || (g.account_id == null && g.profile === sk)) && g.revoked_at == null) g.revoked_at = at;
    }
    return [];
  }
  // The trainer-side revoke: grants that name the closing account as trainer.
  if (s === "UPDATE oauth_grants SET revoked_at = ?, revoked_by = 'closed' WHERE kind = 'trainer' AND trainer_account_id = ? AND revoked_at IS NULL") {
    const [at, t] = values;
    for (const g of state.grants) {
      if (g.kind === "trainer" && g.trainer_account_id === t && g.revoked_at == null) Object.assign(g, { revoked_at: at, revoked_by: "closed" });
    }
    return [];
  }
  if (s === "UPDATE handles SET released_at = now() WHERE account_id = ? AND released_at IS NULL") {
    for (const r of state.handles) if (r.account_id === values[0] && r.released_at == null) r.released_at = "now";
    return [];
  }
  // Applied as written: deleted_at, and consent only when the statement clears it.
  const close = s.match(/^UPDATE accounts SET deleted_at = now\(\)(, consent = NULL)? WHERE id = \?$/);
  if (close) {
    if (state.failClose) throw state.failClose;
    for (const a of state.accounts) if (a.id === values[0]) Object.assign(a, { deleted_at: "now" }, close[1] ? { consent: null } : {});
    return [];
  }
  // Applied as written: a waiting application withdrawn; what any application said cleared.
  if (s === "UPDATE trainer_applications SET status = CASE WHEN status = 'applied' THEN 'withdrawn' ELSE status END, decided_at = CASE WHEN status = 'applied' THEN ? ELSE decided_at END, about = NULL, link = NULL WHERE account_id = ?") {
    for (const r of state.applications) {
      if (r.account_id !== values[1]) continue;
      if (r.status === "applied") Object.assign(r, { status: "withdrawn", decided_at: values[0] });
      Object.assign(r, { about: null, link: null });
    }
    return [];
  }
  if (s === "DELETE FROM credentials WHERE account_id = ?") {
    state.credentials = state.credentials.filter((c) => c.account_id !== values[0]);
    return [];
  }
  throw new Error(`unexpected SQL: ${s}`);
}

const copyState = (s) => ({
  accounts: s.accounts.map((a) => ({ ...a })),
  handles: s.handles.map((r) => ({ ...r })),
  credentials: s.credentials.map((c) => ({ ...c })),
  grants: s.grants.map((g) => ({ ...g })),
  applications: s.applications.map((r) => ({ ...r })),
  nextHandleId: s.nextHandleId,
  failClose: s.failTxn,
});

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    const tag = (strings, ...values) => {
      const stmt = { q: strings.join("?"), values };
      return { ...stmt, then: (ok, ko) => new Promise((r) => r(run(db, stmt))).then(ok, ko) };
    };
    tag.transaction = async (queries) => {
      const draft = copyState(db);
      const record = { statements: queries.map((q) => norm(q.q)), committed: false };
      db.txns.push(record);
      const out = queries.map((q) => run(draft, q)); // throws → nothing committed
      delete draft.failClose;
      Object.assign(db, draft);
      record.committed = true;
      return out;
    };
    return tag;
  },
}));

const pathOf = (u) => String(u).replace("https://blob/", "");
vi.mock("@vercel/blob", () => ({
  list: vi.fn(async ({ prefix }) => ({
    blobs: [...blobs.keys()].filter((p) => p.startsWith(prefix)).map((p) => ({ pathname: p, url: `https://blob/${p}`, uploadedAt: "2026-10-01T00:00:00.000Z" })),
  })),
  put: vi.fn(async (path, body, opts) => {
    if (blobs.has(path) && !opts?.allowOverwrite) throw new Error("blob already exists");
    blobs.set(path, body);
    return { pathname: path };
  }),
  get: vi.fn(async (path) => {
    const p = pathOf(path);
    if (!blobs.has(p)) return null;
    const bytes = new TextEncoder().encode(String(blobs.get(p)));
    return { statusCode: 200, stream: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
  }),
  del: vi.fn(async (urls) => {
    const list = [].concat(urls).map(pathOf);
    if (blobFail.del && list.some(blobFail.del)) throw new Error("blob store unavailable");
    for (const p of list) { dels.push(p); blobs.delete(p); }
  }),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => null, rateLimitShared: async () => null }));
// Profile rows, photo index rows and tokens in memory; sql/ensureSchema stay real.
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
  dbListPhotos: vi.fn(async (sk) => photoRows.filter((r) => r.profile === sk).map((r) => ({ date: r.date, blob_path: r.blob_path }))),
  dbDeleteProfile: vi.fn(async (sk) => {
    profiles.delete(sk);
    for (let i = photoRows.length - 1; i >= 0; i--) if (photoRows[i].profile === sk) photoRows.splice(i, 1);
    for (const [t, rec] of tokens) if (rec.profile === sk) tokens.delete(t);
  }),
  dbHasRetiredPhotos: vi.fn(async () => false),
}));
// The route's claim mode: what ships, unless a test runs the post-flip mode.
const claimMode = { value: null };
vi.mock("@/lib/identity-store", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, get CLAIM_MODE() { return claimMode.value ?? real.CLAIM_MODE; } };
});
// AI connections read the simulated grants table, so the close's revocation is what /mcp sees.
vi.mock("@/lib/oauth-store", () => ({
  neonOAuthStore: async () => ({
    getToken: async (hash) => oauthTokens.get(hash) || null,
    getGrant: async (id) => {
      const g = db.grants.find((x) => x.id === id);
      return g ? { id: g.id, clientId: "c", accountId: g.account_id, profile: g.profile, credentialId: g.credential_id,
        scope: g.scope, revokedAt: g.revoked_at, kind: "ai", resource: g.resource, expiresAt: null } : null;
    },
    touchGrant: async () => {},
  }),
}));

const sync = await import("@/app/api/sync/route");
const { POST: loginOptions } = await import("@/app/api/auth/login-options/route");
const { GET: authCheck } = await import("@/app/api/auth/check/route");
const { POST: mcp } = await import("@/app/mcp/route");
const { hashSecret, MCP_RESOURCE, SCOPE_READ } = await import("@/lib/oauth");
const { CLAIM_MODE: SHIPPED_MODE } = await vi.importActual("@/lib/identity-store");
const dbm = await import("@/lib/db");

const A = "hwa_" + "a".repeat(26);
const B = "hwa_" + "b".repeat(26);
const M = "hwa_" + "m".repeat(26);
const CONSENT = { version: "2026-09", at: "2026-09-29T10:00:00.000Z" };
const HOUR = 3600_000;

const seed = (id, sk, handle, extra = {}) => {
  db.accounts.push({ id, storage_key: sk, webauthn_user_id: `uid-${id}`, origin: sk === id ? "reclaim" : "backfill", roles: ["lifter"], plan: "free", consent: null, created_at: "2026-10-01", deleted_at: null, ...extra });
  if (handle) db.handles.push({ id: db.nextHandleId++, handle, account_id: id, display: handle, kind: "primary", released_at: null });
};
const passkey = (accountId, id = `cred-${accountId}`) => db.credentials.push({ id, account_id: accountId, public_key: "pk", counter: 0, transports: ["internal"], rp_id: "heatwayve.app", user_handle: "uh", source: "backfill", created_at: null, last_used_at: null });
const grant = (id, accountId, profile) => db.grants.push({ id, account_id: accountId, profile, credential_id: `cred-${accountId ?? A}`, scope: SCOPE_READ, resource: MCP_RESOURCE, revoked_at: null });
const ceremony = (t, accountId, sk) => tokens.set(t, { profile: sk, accountId, expires: Date.now() + 2 * 60_000, scope: null });
const dir = (sk) => `forge/profiles/${encodeURIComponent(sk)}/`;

const wipe = (name, t) => sync.DELETE(new NextRequest(`https://heatwayve.app/api/sync?${new URLSearchParams({ profile: name })}`, { method: "DELETE", headers: { "x-hw-auth": t } }));
const checkName = async (name) => (await (await sync.GET(new NextRequest(`https://heatwayve.app/api/sync?${new URLSearchParams({ profile: name, check: "1" })}`))).json()).exists;
const claim = (name) => sync.POST(new NextRequest("https://heatwayve.app/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: name, displayName: name }) }));
const mcpPing = (token) => mcp(new Request("https://heatwayve.app/mcp", {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
}));

// The backfilled account "sam" (storage key = its handle), its neighbours, and
// what lives in and around its folder.
const SAM = dir("sam");
const SAM_OWN_PHOTO = `${SAM}photos/2026-09-01.jpg`;
const SAM_RETIRED_PHOTO = `${SAM}photos/2026-08-01.jpg`; // a previous holder's, its row retired
const SAM_UNKNOWN = [`${SAM}avatar.png`, `${SAM}notes/meta.json`, `${SAM}meta.json.bak`, `${SAM}credentials/inner.json`, `${SAM}history-x/y.json`];
const SAM_JUNK = ["meta.json", "history.json", "meta-x1.json", "history-x2.json", "credentials.json", "credentials-x3.json"].map((f) => SAM + f);
const SNAPS = (sk) => [`forge/snapshots/daily/${encodeURIComponent(sk)}.json`, `forge/snapshots/weekly/${encodeURIComponent(sk)}.json`];
const NEIGHBOURS = [`${dir("sammy")}meta.json`, `${dir("sammy")}credentials.json`, `${dir("mallory")}meta.json`, ...SNAPS("sammy"), "forge/profiles/sam", "forge/profiles/sam.json"];

function seedSam({ unknown = true } = {}) {
  seed(A, "sam", "sam", { consent: CONSENT });
  passkey(A);
  seed(M, "mallory", "mallory");
  passkey(M);
  grant("g-acct", A, "sam");
  grant("g-legacy", null, "sam");
  grant("g-other", M, "mallory");
  grant("g-sammy", null, "sammy");
  for (const p of [...SAM_JUNK, SAM_OWN_PHOTO, ...SNAPS("sam"), ...NEIGHBOURS]) blobs.set(p, "{}");
  blobs.set(`${SAM}credentials-x3.json`, JSON.stringify({ credentials: [], consent: CONSENT }));
  photoRows.push({ profile: "sam", date: "2026-09-01", blob_path: SAM_OWN_PHOTO });
  if (unknown) {
    for (const p of [SAM_RETIRED_PHOTO, ...SAM_UNKNOWN]) blobs.set(p, "{}");
    photoRows.push({ profile: "sam/retired/m1", date: "2026-08-01", blob_path: SAM_RETIRED_PHOTO });
  }
  profiles.set("sam", { meta: { displayName: "Sam" }, history: [], cursor: "c" });
}

beforeEach(() => {
  process.env.DATABASE_URL = "postgres://fake";
  claimMode.value = null;
  Object.assign(db, { accounts: [], handles: [], credentials: [], grants: [], applications: [], changes: [], changeSql: [], failChanges: false, txns: [], failTxn: null, nextHandleId: 1 });
  blobs.clear(); dels.length = 0; tokens.clear(); profiles.clear(); photoRows.length = 0; oauthTokens.clear();
  blobFail.del = null;
  vi.clearAllMocks();
});
afterEach(() => { delete process.env.DATABASE_URL; delete process.env.CRON_SECRET; });

describe("wiping a backfilled account (storage key = its handle)", () => {
  it("deletes its own photo, its rows, its snapshots and the enumerated files, then closes it", async () => {
    seedSam();
    ceremony("w", A, "sam");
    const res = await wipe("Sam", "w");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 1 + SAM_JUNK.length, kept: 1 + SAM_UNKNOWN.length,
      trainerChanges: { dryRun: true, count: 0 } });
    // Photo by its index row first, then snapshots, then the enumerated files.
    expect(dels).toEqual([SAM_OWN_PHOTO, ...SNAPS("sam"), ...SAM_JUNK]);
    expect(vi.mocked(dbm.dbDeleteToken).mock.calls).toEqual([["w"]]);
    expect(vi.mocked(dbm.dbDeleteProfile).mock.calls).toEqual([["sam"]]);
    // The close: one committed transaction, last.
    expect(db.txns).toEqual([{ committed: true, statements: [
      expect.stringMatching(/^UPDATE oauth_grants SET revoked_at/),
      expect.stringMatching(/^UPDATE handles SET released_at = now\(\) WHERE account_id/),
      "UPDATE accounts SET deleted_at = now(), consent = NULL WHERE id = ?",
      "DELETE FROM credentials WHERE account_id = ?",
      "UPDATE oauth_grants SET revoked_at = ?, revoked_by = 'closed' WHERE kind = 'trainer' AND trainer_account_id = ? AND revoked_at IS NULL",
      "UPDATE trainer_applications SET status = CASE WHEN status = 'applied' THEN 'withdrawn' ELSE status END, decided_at = CASE WHEN status = 'applied' THEN ? ELSE decided_at END, about = NULL, link = NULL WHERE account_id = ?",
    ] }]);
    const [a, m] = db.accounts;
    expect(a).toMatchObject({ id: A, deleted_at: "now", consent: null });
    expect(m).toMatchObject({ id: M, deleted_at: null });
    expect(db.handles.map((h) => [h.handle, h.released_at])).toEqual([["sam", "now"], ["mallory", null]]);
    expect(db.credentials.map((c) => c.account_id)).toEqual([M]);
    expect(Object.fromEntries(db.grants.map((g) => [g.id, g.revoked_at != null]))).toEqual({ "g-acct": true, "g-legacy": true, "g-other": false, "g-sammy": false });
  });

  it("revokes live trainer grants naming the account as trainer, stamped 'closed'; others are untouched", async () => {
    seedSam({ unknown: false });
    const T = "hwa_" + "t".repeat(26);
    const share = (id, accountId, trainer, extra = {}) => db.grants.push({ id, account_id: accountId, profile: accountId, kind: "trainer", trainer_account_id: trainer, revoked_at: null, revoked_by: null, ...extra });
    share("t-to-sam", M, A);
    share("t-old", B, A, { revoked_at: 5, revoked_by: "client" });
    share("t-unrelated", T, M);
    share("t-own", A, M); // sam's own share as a client: ended by the account-scoped revoke
    ceremony("w", A, "sam");
    expect((await wipe("sam", "w")).status).toBe(200);
    const at = db.grants.find((g) => g.id === "g-acct").revoked_at;
    const byId = Object.fromEntries(db.grants.map((g) => [g.id, [g.revoked_at, g.revoked_by ?? null]]));
    expect(byId["t-to-sam"]).toEqual([at, "closed"]);
    expect(byId["t-old"]).toEqual([5, "client"]);
    expect(byId["t-unrelated"]).toEqual([null, null]);
    expect(byId["t-own"]).toEqual([at, null]);
  });

  it("withdraws its waiting application to coach and clears what it said; other accounts' rows are untouched", async () => {
    seedSam({ unknown: false });
    const T = "hwa_" + "t".repeat(26);
    const row = (account_id, status, extra = {}) => ({ account_id, status, about: `about-${account_id}`, link: "https://x.example",
      terms: { version: "v", at: "t", adult: true }, applied_at: 1, decided_at: null, seen_at: null, created_at: 1, ...extra });
    db.applications.push(row(A, "applied"), row(M, "applied"), row(T, "denied", { decided_at: 2 }));
    ceremony("w", A, "sam");
    expect((await wipe("sam", "w")).status).toBe(200);
    expect(db.applications).toEqual([
      row(A, "withdrawn", { about: null, link: null, decided_at: expect.any(Number) }),
      row(M, "applied"),
      row(T, "denied", { decided_at: 2 }),
    ]);
  });

  it("a closing account whose application was already decided keeps the decision but loses what it wrote", async () => {
    seedSam({ unknown: false });
    const decided = { account_id: A, status: "denied", about: "a", link: "https://x.example", terms: null, applied_at: 1, decided_at: 2, seen_at: null, created_at: 1 };
    db.applications.push({ ...decided });
    ceremony("w", A, "sam");
    expect((await wipe("sam", "w")).status).toBe(200);
    expect(db.applications).toEqual([{ ...decided, about: null, link: null }]);
  });

  it("a previous holder's retired photo and every unknown file under the folder survive", async () => {
    seedSam();
    ceremony("w", A, "sam");
    expect((await wipe("sam", "w")).status).toBe(200);
    for (const p of [SAM_RETIRED_PHOTO, ...SAM_UNKNOWN, ...NEIGHBOURS]) expect(blobs.has(p), p).toBe(true);
    expect(photoRows).toEqual([{ profile: "sam/retired/m1", date: "2026-08-01", blob_path: SAM_RETIRED_PHOTO }]);
    // Still under the name's prefix, so the name stays held while the fallback counts blobs.
    expect(await checkName("sam")).toBe(true);
  });

  it("deletes a subset of what today's wipe deletes on the same fixture", async () => {
    seedSam();
    ceremony("w", A, "sam");
    // Today's wipe (origin/main): dbDeleteProfile("sam"), both snapshots,
    // and every blob listed under forge/profiles/sam/.
    const today = new Set([...SNAPS("sam"), ...[...blobs.keys()].filter((p) => p.startsWith(SAM))]);
    expect((await wipe("sam", "w")).status).toBe(200);
    expect(dels.filter((p) => !today.has(p))).toEqual([]);
    expect([...today].filter((p) => !dels.includes(p)).sort()).toEqual([SAM_RETIRED_PHOTO, ...SAM_UNKNOWN].sort());
    expect(vi.mocked(dbm.dbDeleteProfile).mock.calls).toEqual([["sam"]]);
  });

  it("the equivalence: an existing account's wipe keys every path exactly as today", async () => {
    seedSam({ unknown: false });
    ceremony("w", A, "sam");
    expect((await wipe("SAM ", "w")).status).toBe(200);
    expect(vi.mocked(dbm.dbListPhotos).mock.calls).toEqual([["sam"]]);
    expect(dels).toEqual(["forge/profiles/sam/photos/2026-09-01.jpg", "forge/snapshots/daily/sam.json", "forge/snapshots/weekly/sam.json", ...SAM_JUNK]);
  });

  it("an index row pointing outside the account's own photos prefix is never followed", async () => {
    seedSam({ unknown: false });
    blobs.set(`${dir("mallory")}photos/2026-09-02.jpg`, "x");
    photoRows.push({ profile: "sam", date: "2026-09-02", blob_path: `${dir("mallory")}photos/2026-09-02.jpg` });
    photoRows.push({ profile: "sam", date: "2026-09-03", blob_path: `${SAM}../mallory/meta.json` });
    ceremony("w", A, "sam");
    expect((await wipe("sam", "w")).status).toBe(200);
    expect(blobs.has(`${dir("mallory")}photos/2026-09-02.jpg`)).toBe(true);
    expect(dels.filter((p) => !p.startsWith(SAM) && !SNAPS("sam").includes(p))).toEqual([]);
  });
});

describe("trainer changes: the wipe reports what it would clear and clears nothing (dry run)", () => {
  const T = "hwa_" + "t".repeat(26);
  const change = (id, profile, extra = {}) => ({ id, set_id: id.split(".")[0], grant_id: "tg", profile, client_account_id: A,
    author_account_id: T, source: "trainer", status: "sent", kind: "weight", target: "Back Squat",
    old_value: 100, new_value: 105, basis: { anchorId: "r1", w: 100, r: 5 }, warnings: null,
    created_at: 1, outcome: null, undone_at: null, reverted_at: null, cleared_at: null, ...extra });
  const seedChanges = () => db.changes.push(
    change("s2.0", "sam", { created_at: 20 }),
    change("s1.1", "sam", { created_at: 10, outcome: "applied", undone_at: 15 }),
    change("s1.0", "sam", { created_at: 10, source: "ai", status: "proposed" }),
    change("s0.0", "sam", { created_at: 5, cleared_at: 6, old_value: null, new_value: null, basis: null }),
    change("n1.0", "sammy", { created_at: 1 }),
    change("n2.0", "sam/x", { created_at: 1 }),
    change("n3.0", "Sam", { created_at: 1 }),
    change("n4.0", "mallory", { created_at: 1, client_account_id: M, author_account_id: A }),
  );

  it("the dry run sends one SELECT and changes no row; the reply carries the count, the log the ids by storage key", async () => {
    seedSam({ unknown: false });
    seedChanges();
    const before = structuredClone(db.changes);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    ceremony("w", A, "sam");
    const res = await wipe("sam", "w");
    expect(res.status).toBe(200);
    const body = await res.json();
    // Exactly this storage key's rows not yet cleared, oldest first, whatever their source or state.
    expect(body.trainerChanges).toEqual({ dryRun: true, count: 3 });
    // One read, and no other statement against the table; every row, numbers included, untouched.
    expect(db.changeSql).toEqual(["SELECT id FROM trainer_changes WHERE profile = ? AND cleared_at IS NULL ORDER BY created_at, id"]);
    expect(db.txns.flatMap((t) => t.statements).filter((x) => x.includes("trainer_changes"))).toEqual([]);
    expect(db.changes).toEqual(before);
    // The ids go to the log for the owner to read, by storage key; never to the device.
    expect(info).toHaveBeenCalledWith(expect.stringContaining("dry run"), "sam",
      JSON.stringify({ count: 3, part: "1/1", ids: ["s1.0", "s1.1", "s2.0"] }));
    expect(JSON.stringify(body)).not.toMatch(/s1\.0|s2\.0/);
    info.mockRestore();
    // The rest of the wipe ran as before: the account is closed.
    expect(db.accounts.find((a) => a.id === A)).toMatchObject({ deleted_at: "now" });
  });

  it("a reclaimed, id-keyed account reports by its storage key, never the name", async () => {
    seed(B, B, "sam");
    passkey(B);
    db.changes.push(change("k1.0", B, { client_account_id: B }), change("k2.0", "sam"));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    ceremony("w", B, B);
    const res = await wipe("sam", "w");
    expect(res.status).toBe(200);
    expect((await res.json()).trainerChanges).toEqual({ dryRun: true, count: 1 });
    expect(info).toHaveBeenCalledWith(expect.stringContaining("dry run"), B, JSON.stringify({ count: 1, part: "1/1", ids: ["k1.0"] }));
    info.mockRestore();
  });

  it("a long kill list is logged 200 ids a line, in order, every id once", async () => {
    seedSam({ unknown: false });
    const many = Array.from({ length: 450 }, (_, i) => change(`m${String(i).padStart(3, "0")}.00`, "sam", { created_at: 100 + i }));
    db.changes.push(...many);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    ceremony("w", A, "sam");
    const res = await wipe("sam", "w");
    expect(res.status).toBe(200);
    expect((await res.json()).trainerChanges).toEqual({ dryRun: true, count: 450 });
    const lines = info.mock.calls.filter((c) => String(c[0]).includes("dry run"));
    expect(lines.map((c) => c[1])).toEqual(["sam", "sam", "sam"]);
    const parts = lines.map((c) => JSON.parse(c[2]));
    expect(parts.map((x) => [x.count, x.part, x.ids.length])).toEqual([[450, "1/3", 200], [450, "2/3", 200], [450, "3/3", 50]]);
    expect(parts.flatMap((x) => x.ids)).toEqual(many.map((c) => c.id));
    info.mockRestore();
    expect(db.changeSql).toEqual(["SELECT id FROM trainer_changes WHERE profile = ? AND cleared_at IS NULL ORDER BY created_at, id"]);
  });

  it("nothing to clear still logs one line, so the owner sees the zero", async () => {
    seedSam({ unknown: false });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    ceremony("w", A, "sam");
    expect((await (await wipe("sam", "w")).json()).trainerChanges).toEqual({ dryRun: true, count: 0 });
    expect(info.mock.calls.filter((c) => String(c[0]).includes("dry run")).map((c) => c[2]))
      .toEqual([JSON.stringify({ count: 0, part: "1/1", ids: [] })]);
    info.mockRestore();
  });

  it("a failed dry run never stops the wipe, and the reply carries no report", async () => {
    seedSam({ unknown: false });
    seedChanges();
    db.failChanges = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    ceremony("w", A, "sam");
    const res = await wipe("sam", "w");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 1 + SAM_JUNK.length, kept: 0 });
    expect(err).toHaveBeenCalledWith(expect.stringContaining("trainer changes dry run failed"));
    err.mockRestore();
    expect(db.accounts.find((a) => a.id === A)).toMatchObject({ deleted_at: "now" });
    expect(db.txns.at(-1)?.committed).toBe(true);
  });
});

describe("after the wipe, the account is gone everywhere", () => {
  it("sign-in offers nothing, check shows no passkey and no consent, MCP 401s, the token resolves to nothing", async () => {
    seedSam({ unknown: false });
    oauthTokens.set(hashSecret("ai-token"), { hash: hashSecret("ai-token"), grantId: "g-acct", kind: "access", expiresAt: Date.now() + HOUR });
    const before = {
      login: await loginOptions(new Request("https://heatwayve.app/api/auth/login-options", { method: "POST", headers: { host: "heatwayve.app" }, body: JSON.stringify({ profile: "sam" }) })),
      check: await (await authCheck(new Request("https://heatwayve.app/api/auth/check?profile=sam"))).json(),
      mcp: await mcpPing("ai-token"),
    };
    expect(before.login.status).toBe(200);
    expect((await before.login.json()).allowCredentials.map((c) => c.id)).toEqual([`cred-${A}`]);
    expect(before.check).toMatchObject({ hasPasskey: true, consent: { version: CONSENT.version } });
    expect(before.mcp.status).toBe(200);

    ceremony("w", A, "sam");
    expect((await wipe("sam", "w")).status).toBe(200);

    const login = await loginOptions(new Request("https://heatwayve.app/api/auth/login-options", { method: "POST", headers: { host: "heatwayve.app" }, body: JSON.stringify({ profile: "sam" }) }));
    expect(login.status).toBe(404);
    expect(await login.json()).toMatchObject({ needsRegister: true });
    expect(await (await authCheck(new Request("https://heatwayve.app/api/auth/check?profile=sam"))).json()).toEqual({ hasPasskey: false, credentialCount: 0, consent: null });
    expect((await mcpPing("ai-token")).status).toBe(401);
    // A token row for the closed account (had one survived) opens nothing.
    tokens.set("late", { profile: "sam", accountId: A, expires: Date.now() + HOUR, scope: "sync" });
    expect((await sync.GET(new NextRequest("https://heatwayve.app/api/sync?profile=sam", { headers: { "x-hw-auth": "late" } }))).status).toBe(401);
    // Nothing of the consent record is left: not on the account, not in a doc.
    expect(db.accounts[0].consent).toBeNull();
    expect([...blobs.keys()].filter((p) => p.startsWith(SAM))).toEqual([]);
  });

  it("the handle is free: check=1 false, and even a handle-keyed (precutover) claim of it is keyed by the new account", async () => {
    seedSam({ unknown: false });
    ceremony("w", A, "sam");
    expect((await wipe("sam", "w")).status).toBe(200);
    expect(await checkName("sam")).toBe(false);
    claimMode.value = "precutover";
    const res = await claim("Sam");
    expect(res.status).toBe(200);
    const fresh = db.accounts.find((a) => a.id !== A && a.id !== M);
    expect(fresh).toMatchObject({ storage_key: fresh.id, origin: "claim", consent: null });
    expect(db.handles.filter((h) => h.handle === "sam").map((h) => [h.account_id, h.released_at])).toEqual([[A, "now"], [fresh.id, null]]);
    // The new account inherits nothing: no passkey, no consent.
    expect(await (await authCheck(new Request("https://heatwayve.app/api/auth/check?profile=sam"))).json()).toEqual({ hasPasskey: false, credentialCount: 0, consent: null });
  });

  it("in the shipped claim mode the freed name is claimable, keyed by the new account's id", async () => {
    // Storage keys are frozen and never reassigned; the closed account keeps "sam".
    expect(SHIPPED_MODE).toBe("claim");
    seedSam({ unknown: false });
    ceremony("w", A, "sam");
    expect((await wipe("sam", "w")).status).toBe(200);
    expect(await checkName("sam")).toBe(false);
    expect((await claim("sam")).status).toBe(200);
    const fresh = db.accounts.find((a) => a.id !== A && a.id !== M);
    expect(fresh).toMatchObject({ storage_key: fresh.id, origin: "claim", consent: null });
    expect(db.accounts.find((a) => a.id === A)).toMatchObject({ storage_key: "sam" });
    expect([...blobs.keys()].filter((p) => p.startsWith(SAM))).toEqual([]);
    expect(await checkName("sam")).toBe(true);
  });
});

describe("a reclaimed, id-keyed account", () => {
  // A (storage key "sam") lapsed; B reclaimed the handle and is keyed by its own id.
  function seedReclaim() {
    seed(A, "sam", null, { consent: CONSENT });
    db.handles.push({ id: db.nextHandleId++, handle: "sam", account_id: A, display: "sam", kind: "primary", released_at: "2026-09-30" });
    passkey(A);
    seed(B, B, "sam", { consent: CONSENT });
    passkey(B);
    grant("g-a-legacy", null, "sam");
    grant("g-b", B, B);
    // A's data: rows and every blob under its own folder, its photo row retired by the old reclaim.
    for (const p of [...SAM_JUNK, SAM_RETIRED_PHOTO, ...SNAPS("sam")]) blobs.set(p, "{}");
    photoRows.push({ profile: "sam/retired/m1", date: "2026-08-01", blob_path: SAM_RETIRED_PHOTO });
    profiles.set("sam", { meta: {}, history: [] });
    // B's data under its id.
    const BD = dir(B);
    for (const p of [`${BD}meta.json`, `${BD}history.json`, `${BD}credentials.json`, `${BD}photos/2026-10-01.jpg`, ...SNAPS(B)]) blobs.set(p, "{}");
    photoRows.push({ profile: B, date: "2026-10-01", blob_path: `${BD}photos/2026-10-01.jpg` });
    profiles.set(B, { meta: {}, history: [] });
  }

  it("can be wiped by its handle; everything keys by its id and the previous holder's data survives", async () => {
    seedReclaim();
    const aBefore = [...blobs.keys()].filter((p) => p.startsWith(SAM) || SNAPS("sam").includes(p)).sort();
    ceremony("w", B, B);
    const res = await wipe("sam", "w");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 4, kept: 0, trainerChanges: { dryRun: true, count: 0 } });
    const BD = dir(B);
    expect(dels).toEqual([`${BD}photos/2026-10-01.jpg`, ...SNAPS(B), `${BD}meta.json`, `${BD}history.json`, `${BD}credentials.json`]);
    expect(vi.mocked(dbm.dbDeleteProfile).mock.calls).toEqual([[B]]);
    // The previous holder's retired photo blob and row, every other blob and its rows survive.
    expect([...blobs.keys()].filter((p) => p.startsWith(SAM) || SNAPS("sam").includes(p)).sort()).toEqual(aBefore);
    expect(photoRows).toEqual([{ profile: "sam/retired/m1", date: "2026-08-01", blob_path: SAM_RETIRED_PHOTO }]);
    expect(profiles.has("sam")).toBe(true);
    // Only B is closed; A's account, credentials and legacy grant are untouched.
    expect(db.accounts.map((a) => [a.id, a.deleted_at, a.consent])).toEqual([[A, null, CONSENT], [B, "now", null]]);
    expect(db.credentials.map((c) => c.account_id)).toEqual([A]);
    expect(Object.fromEntries(db.grants.map((g) => [g.id, g.revoked_at != null]))).toEqual({ "g-a-legacy": false, "g-b": true });
  });

  it("the previous holder's ceremony token cannot wipe the reclaimer", async () => {
    seedReclaim();
    ceremony("old", A, "sam");
    expect((await wipe("sam", "old")).status).toBe(401);
    expect(dels).toEqual([]);
    expect(db.txns).toEqual([]);
  });
});

describe("every failure before the close leaves the wipe retryable", () => {
  it("a failed photo delete stops before any row goes; a retry finishes the job", async () => {
    seedSam({ unknown: false });
    ceremony("w", A, "sam");
    blobFail.del = (p) => p === SAM_OWN_PHOTO;
    expect((await wipe("sam", "w")).status).toBe(500);
    expect(vi.mocked(dbm.dbDeleteProfile)).not.toHaveBeenCalled();
    expect(photoRows).toHaveLength(1);
    expect(db.txns).toEqual([]);
    expect(db.accounts[0].deleted_at).toBeNull();
    blobFail.del = null;
    ceremony("w2", A, "sam");
    expect((await wipe("sam", "w2")).status).toBe(200);
    expect(blobs.has(SAM_OWN_PHOTO)).toBe(false);
    expect(db.accounts[0]).toMatchObject({ deleted_at: "now", consent: null });
  });

  it("a failed folder delete leaves the account open", async () => {
    seedSam({ unknown: false });
    ceremony("w", A, "sam");
    blobFail.del = (p) => p === `${SAM}meta.json`;
    expect((await wipe("sam", "w")).status).toBe(500);
    expect(db.txns).toEqual([]);
    expect(db.handles[0].released_at).toBeNull();
    expect(db.credentials.map((c) => c.account_id)).toContain(A);
  });

  it("a failed close is all or nothing and refuses the half-wipe", async () => {
    seedSam({ unknown: false });
    ceremony("w", A, "sam");
    db.applications.push({ account_id: A, status: "applied", about: "a", link: null });
    db.failTxn = new Error("connection reset");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await wipe("sam", "w")).status).toBe(500);
    spy.mockRestore();
    expect(db.txns).toEqual([expect.objectContaining({ committed: false })]);
    expect(db.accounts[0]).toMatchObject({ deleted_at: null, consent: CONSENT });
    expect(db.handles[0].released_at).toBeNull();
    expect(db.credentials.map((c) => c.account_id)).toEqual([A, M]);
    expect(db.grants.every((g) => g.revoked_at == null)).toBe(true);
    expect(db.applications).toEqual([{ account_id: A, status: "applied", about: "a", link: null }]);
    // The handle and passkey still resolve, so a fresh ceremony can finish it.
    db.failTxn = null;
    ceremony("w2", A, "sam");
    expect((await wipe("sam", "w2")).status).toBe(200);
    expect(db.accounts[0]).toMatchObject({ deleted_at: "now", consent: null });
  });
});

describe("the nightly self-test's claim and wipe", () => {
  const runSelftest = async () => {
    process.env.CRON_SECRET = "s3cret";
    const { GET: selftest } = await import("@/app/api/cron/sync-selftest/route");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await selftest(new Request("https://heatwayve.app/api/cron/sync-selftest", { headers: { authorization: "Bearer s3cret" } }));
    spy.mockRestore();
    return { res, body: await res.json() };
  };

  for (const mode of ["precutover", null]) {
    it(`passes and closes its throwaway account (${mode ?? "shipped"} mode)`, async () => {
      claimMode.value = mode;
      const { res, body } = await runSelftest();
      expect(body.failures).toEqual([]);
      expect(res.status).toBe(200);
      const [acct] = db.accounts;
      expect(acct.storage_key).toBe(mode === "precutover" ? normaliseProfile(body.profile) : acct.id);
      expect(acct).toMatchObject({ deleted_at: "now", consent: null });
      expect(db.handles).toEqual([expect.objectContaining({ handle: body.profile, released_at: "now" })]);
      expect([...blobs.keys()].filter((p) => p.includes(acct.storage_key))).toEqual([]);
      expect(db.txns.at(-1)).toMatchObject({ committed: true, statements: expect.arrayContaining(["DELETE FROM credentials WHERE account_id = ?"]) });
    });
  }
});
