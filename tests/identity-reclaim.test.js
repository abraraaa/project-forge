// Sign-in reads the credential index, and a lapsed handle is reclaimed as a
// NEW account: the previous account keeps every row and blob, the reclaimer
// inherits nothing, and a trainer's handle never lapses.
//
// Neon is simulated over accounts / handles / credentials with the
// constraints that matter here (live-handle uniqueness, credential id primary
// key, the storage-key CHECK) and all-or-nothing transactions. Blob is an
// in-memory path map behind lib/blob-utils and @vercel/blob.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

const db = { accounts: [], handles: [], credentials: [], log: [], txns: [], race: null, nextHandleId: 1 };
const blobs = new Map();
const blobWrites = [];
const tokens = new Map();

const unique = (detail) => Object.assign(new Error(`duplicate key value violates unique constraint (${detail})`), { code: "23505" });

function run(state, { q, values }) {
  if (/^\s*(CREATE|ALTER)\b/.test(q)) return [];
  db.log.push({ q, values });
  if (q.includes("FROM handles h JOIN accounts a")) {
    const row = state.handles.find((r) => r.handle === values[0] && r.released_at == null && r.kind === "primary");
    const acct = row && state.accounts.find((a) => a.id === row.account_id && a.deleted_at == null);
    return acct ? [{ ...acct, handle: row.handle, display: row.display, kind: row.kind, claimed_at: null, hold_until: null }] : [];
  }
  const byCol = q.match(/^\s*SELECT \* FROM accounts WHERE (id|storage_key) = \?/);
  if (byCol) return state.accounts.filter((a) => a[byCol[1]] === values[0]).slice(0, 1).map((a) => ({ ...a }));
  if (/^\s*SELECT id, public_key[\s\S]*FROM credentials WHERE account_id = \?/.test(q)) {
    return state.credentials.filter((c) => c.account_id === values[0]).map((c) => ({ ...c }));
  }
  if (/^\s*SELECT account_id FROM credentials/.test(q)) {
    return state.credentials.filter((c) => c.id === values[0]).map((c) => ({ account_id: c.account_id }));
  }
  if (/^\s*INSERT INTO credentials\b/.test(q)) {
    if (db.failCredentialInsert) { db.failCredentialInsert = false; throw new Error("index unavailable"); }
    const [id, account_id, public_key, counter, transports, rp_id, user_handle, created_at] = q.includes("ON CONFLICT")
      ? [values[0], values[1], values[2], values[3], values[4], values[5], values[6], values[8]]
      : values;
    if (state.credentials.some((c) => c.id === id)) {
      if (q.includes("ON CONFLICT")) return [];
      throw unique("credentials_pkey");
    }
    state.credentials.push({ id, account_id, public_key, counter, transports: JSON.parse(transports), rp_id, user_handle, source: "register", created_at, last_used_at: null });
    return [{ id }];
  }
  if (/^\s*UPDATE credentials\b/.test(q)) {
    const [counter, rpId, id, accountId] = values;
    const c = state.credentials.find((x) => x.id === id && x.account_id === accountId);
    if (!c) return [];
    if (counter != null) c.counter = counter;
    if (rpId != null) c.rp_id = rpId;
    c.last_used_at = new Date().toISOString();
    return [{ id }];
  }
  if (/^\s*UPDATE accounts SET consent\b/.test(q)) {
    const a = state.accounts.find((x) => x.id === values[1]);
    if (!a) return [];
    a.consent = values[0] == null ? null : JSON.parse(values[0]);
    return [{ id: a.id }];
  }
  if (/^\s*UPDATE handles SET released_at = now\(\)\s+WHERE handle = \? AND account_id = \?/.test(q)) {
    const [h, accountId] = values;
    for (const r of state.handles) if (r.handle === h && r.account_id === accountId && r.released_at == null) r.released_at = "now";
    return [];
  }
  if (/^\s*INSERT INTO accounts \(id, storage_key, webauthn_user_id, consent, origin\)/.test(q)) {
    const [id, storage_key, webauthn_user_id, consent] = values;
    const origin = q.match(/'(\w+)'\)\s*$/)?.[1];
    for (const [k, v] of Object.entries({ id, storage_key, webauthn_user_id })) {
      if (state.accounts.some((a) => a[k] === v)) throw unique(`accounts.${k}`);
    }
    if (!(storage_key === id || ["backfill", "precutover_claim"].includes(origin))) throw Object.assign(new Error("check"), { code: "23514" });
    state.accounts.push({ id, storage_key, webauthn_user_id, origin, roles: ["lifter"], plan: "free", consent: consent == null ? null : JSON.parse(consent), lapsed_at: null, deleted_at: null });
    return [];
  }
  if (/^\s*INSERT INTO handles \(handle, account_id, display\)/.test(q)) {
    const [handle, account_id, display] = values;
    if (db.race) { const commit = db.race; db.race = null; commit(db); commit(state); }
    if (state.handles.some((r) => r.handle === handle && r.released_at == null)) throw unique("handles_live");
    state.handles.push({ id: state.nextHandleId++, handle, account_id, display, kind: "primary", released_at: null });
    return [];
  }
  throw new Error(`unexpected SQL: ${q}`);
}

const clone = (s) => ({
  accounts: s.accounts.map((a) => ({ ...a })),
  handles: s.handles.map((r) => ({ ...r })),
  credentials: s.credentials.map((c) => ({ ...c })),
  nextHandleId: s.nextHandleId,
});

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    const tag = (strings, ...values) => {
      const stmt = { q: strings.join("?"), values };
      return { ...stmt, then: (ok, ko) => new Promise((r) => r(run(db, stmt))).then(ok, ko) };
    };
    tag.transaction = async (queries) => {
      const draft = clone(db);
      const record = { statements: queries.map((s) => s.q.trim().split(/\s+/).slice(0, 2).join(" ")), committed: false };
      db.txns.push(record);
      const out = queries.map((s) => run(draft, s)); // throws → nothing committed
      Object.assign(db, draft);
      record.committed = true;
      return out;
    };
    return tag;
  },
}));

const newest = (prefix) => [...blobs.keys()].filter((p) => p.startsWith(prefix)).sort().pop();
vi.mock("@/lib/blob-utils", () => ({
  readJsonDirect: vi.fn(async (p) => (blobs.has(p) ? JSON.parse(blobs.get(p)) : null)),
  readJsonByPrefix: vi.fn(async (prefix) => { const p = newest(prefix); return p ? JSON.parse(blobs.get(p)) : null; }),
  deleteByPrefix: vi.fn(async () => 0),
  // As blob-utils does: write, then sweep the other blobs under the prefix,
  // so a misdirected prefix shows up as a missing blob.
  writeJsonReplacingPrefix: vi.fn(async (prefix, path, value) => {
    blobWrites.push({ prefix, path, value: JSON.parse(JSON.stringify(value)) });
    blobs.set(path, JSON.stringify(value));
    for (const k of [...blobs.keys()]) if (k !== path && k.startsWith(prefix)) blobs.delete(k);
  }),
}));
vi.mock("@vercel/blob", () => ({
  list: vi.fn(async ({ prefix }) => ({ blobs: [...blobs.keys()].filter((p) => p.startsWith(prefix)).map((pathname) => ({ pathname })) })),
  put: vi.fn(async (path, body, opts) => {
    if (blobs.has(path) && !opts?.allowOverwrite) throw new Error("blob already exists");
    blobWrites.push({ path, value: typeof body === "string" ? JSON.parse(body) : body, opts });
    blobs.set(path, body);
  }),
  get: vi.fn(async (path) => (blobs.has(path) ? { statusCode: 200, stream: new ReadableStream({ start(c) { c.close(); } }) } : null)),
  del: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => null, rateLimitShared: async () => null }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal()),
  dbInsertToken: vi.fn(async (token, rec) => { tokens.set(token, { ...rec }); }),
  dbReadToken: vi.fn(async (token) => tokens.get(token) || null),
  dbRetirePhotos: vi.fn(async () => 0),
  // The photo index, captured by argument (the key each call is made under).
  dbUpsertPhoto: vi.fn(async () => true),
  dbListPhotos: vi.fn(async () => []),
  dbGetPhoto: vi.fn(async () => null),
  dbDeletePhoto: vi.fn(async () => true),
  dbHasRetiredPhotos: vi.fn(async () => false),
}));
// Passthrough spies: the real functions run, and a test can see whether the
// route reached them.
vi.mock("@/lib/identity-store", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, dbReclaimHandle: vi.fn(real.dbReclaimHandle) };
});
vi.mock("@/lib/auth-server", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, mintAuthToken: vi.fn(real.mintAuthToken) };
});
const reg = vi.fn();
const auth = vi.fn();
vi.mock("@simplewebauthn/server", () => ({
  verifyRegistrationResponse: (...a) => reg(...a),
  verifyAuthenticationResponse: (...a) => auth(...a),
}));

const { POST: registerOptions } = await import("@/app/api/auth/register-options/route");
const { POST: registerVerify } = await import("@/app/api/auth/register-verify/route");
const { POST: loginOptions } = await import("@/app/api/auth/login-options/route");
const { POST: loginVerify } = await import("@/app/api/auth/login-verify/route");
const { GET: check } = await import("@/app/api/auth/check/route");
const { reclaimUserId, readCredentialSet, IDENTITY_BLOB_FALLBACK } = await import("@/lib/credential-store");
const { resolveTokenIdentity, mintAuthToken } = await import("@/lib/auth-server");
const { dbReclaimHandle } = await import("@/lib/identity-store");
const photos = await import("@/app/api/photos/route");
const blobApi = await import("@vercel/blob");
const { dbRetirePhotos, dbUpsertPhoto, dbListPhotos, dbGetPhoto, dbDeletePhoto, dbHasRetiredPhotos } = await import("@/lib/db");

const A = "hwa_" + "a".repeat(26);
const C = "hwa_" + "c".repeat(26);
const AFTER_SUNSET = new Date("2026-12-01T12:00:00.000Z");
const ON_FILE = { version: "2026-09-29", at: "2026-09-29T08:00:00.000Z" };
const LEGACY = { id: "old", public_key: "AQID", counter: 4, transports: [], rp_id: "theforged.fit", user_handle: createHash("sha256").update("sam").digest("base64url"), source: "backfill", created_at: "2026-07-20T00:00:00.000Z", last_used_at: null };

const post = (url, body) => new Request(`https://heatwayve.app${url}`, {
  method: "POST", headers: { "content-type": "application/json", host: "heatwayve.app" }, body: JSON.stringify(body),
});
const options = async (profile = "Sam") => (await registerOptions(post("/api/auth/register-options", { profile }))).json();
const clientData = (challenge) => Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin: "https://heatwayve.app" })).toString("base64url");
const register = (challenge, body = {}) => registerVerify(post("/api/auth/register-verify", {
  profile: "Sam", credential: { id: "new", rawId: "new", type: "public-key", response: { clientDataJSON: clientData(challenge) } }, ...body,
}));
// Smallest JPEG the photo route accepts: SOI, a 16x16 SOF0, SOS, EOI.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
const writes = () => db.log.filter((l) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(l.q));

function seedAccount(id, sk, handle, extra = {}) {
  db.accounts.push({ id, storage_key: sk, webauthn_user_id: `uid-${id}`, origin: "backfill", roles: ["lifter"], plan: "free", consent: null, lapsed_at: null, deleted_at: null, ...extra });
  db.handles.push({ id: db.nextHandleId++, handle, account_id: id, display: handle, kind: "primary", released_at: null });
}

beforeEach(() => {
  process.env.DATABASE_URL = "postgres://fake";
  process.env.CHALLENGE_SECRET = "reclaim-test-secret";
  Object.assign(db, { accounts: [], handles: [], credentials: [], log: [], txns: [], race: null, failCredentialInsert: false, nextHandleId: 1 });
  blobs.clear(); blobWrites.length = 0; tokens.clear();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AFTER_SUNSET);
  reg.mockReset(); auth.mockReset();
  reg.mockResolvedValue({
    verified: true,
    registrationInfo: { rpID: "heatwayve.app", credential: { id: "new", publicKey: new Uint8Array([9, 9]), counter: 0, transports: ["internal"] } },
  });
  auth.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 0, rpID: "heatwayve.app" } });
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.DATABASE_URL;
  delete process.env.CHALLENGE_SECRET;
});

describe("a lapsed lifter's handle is reclaimed as a new account", () => {
  beforeEach(() => {
    seedAccount(A, "sam", "sam", { consent: ON_FILE });
    db.credentials.push({ ...LEGACY, account_id: A });
    blobs.set("forge/profiles/sam/credentials-x1.json", JSON.stringify({ credentials: [{ id: "old", publicKey: "AQID", rpId: "theforged.fit" }], consent: ON_FILE }));
    blobs.set("forge/profiles/sam/meta.json", JSON.stringify({ displayName: "Sam" }));
  });

  it("options hand out a user.id derived from the challenge, not the account's", async () => {
    const opts = await options();
    expect(opts.user.id).toBe(reclaimUserId(opts.challenge));
    expect(opts.user.id).not.toBe(`uid-${A}`);
    expect(opts.user.name).toBe("sam");
    expect(writes()).toEqual([]);
  });

  it("verify runs one transaction: new account keyed by its own id, the old account untouched", async () => {
    const before = { account: { ...db.accounts[0] }, cred: { ...db.credentials[0] }, blobs: new Map(blobs) };
    const opts = await options();
    const res = await register(opts.challenge);
    expect(res.status).toBe(200);

    expect(db.txns).toEqual([{ statements: ["UPDATE handles", "INSERT INTO", "INSERT INTO", "INSERT INTO"], committed: true }]);
    expect(writes().map((w) => w.q.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "UPDATE handles SET", "INSERT INTO accounts", "INSERT INTO handles", "INSERT INTO credentials",
    ]);
    const B = db.accounts[1];
    expect(B.id).toMatch(/^hwa_[a-z2-7]{26}$/);
    expect(B).toMatchObject({ storage_key: B.id, origin: "reclaim", webauthn_user_id: opts.user.id, consent: null });

    // The previous holder: handle released (an UPDATE), account and passkey rows as they were.
    expect(db.handles.find((h) => h.account_id === A).released_at).not.toBeNull();
    expect(db.accounts[0]).toEqual(before.account);
    expect(db.credentials.find((c) => c.id === "old")).toEqual(before.cred);
    expect(db.handles.filter((h) => h.handle === "sam" && h.released_at == null)).toEqual([expect.objectContaining({ account_id: B.id, display: "Sam" })]);

    // The new passkey belongs to B, with the user.id that options baked in.
    expect(db.credentials.find((c) => c.id === "new")).toMatchObject({ account_id: B.id, user_handle: reclaimUserId(opts.challenge), rp_id: "heatwayve.app" });
    expect(db.credentials.find((c) => c.id === "new").user_handle).toBe(opts.user.id);

    // The sync token is minted for B, keyed by B's storage key.
    const [tok] = [...tokens.values()];
    expect(tok).toMatchObject({ accountId: B.id, profile: B.id, scope: "sync" });

    // No photo retire, and nothing touches profile data tables.
    expect(dbRetirePhotos).not.toHaveBeenCalled();
    expect(db.log.filter((l) => /\b(sessions|meta|photos)\b/.test(l.q))).toEqual([]);

    // Blob: A's blobs untouched; B's mirror doc and claim marker under B's own prefix.
    for (const [p, v] of before.blobs) expect(blobs.get(p)).toBe(v);
    expect(blobWrites.map((w) => w.path)).toEqual([
      `forge/profiles/${B.id}/credentials.json`, `forge/profiles/${B.id}/meta.json`,
    ]);
    expect(blobWrites[0].prefix).toBe(`forge/profiles/${B.id}/credentials`);
    expect(blobWrites[0].value.credentials.map((c) => c.id)).toEqual(["new"]);
    expect(blobWrites[0].value.consent).toBeUndefined();
    expect(blobWrites[1].opts.allowOverwrite).toBeFalsy();
  });

  it("the reclaimer's consent is only what this request carried", async () => {
    const opts = await options();
    await register(opts.challenge, { consent: { version: "2026-09-29" } });
    const B = db.accounts[1];
    expect(B.consent).toEqual({ version: "2026-09-29", at: AFTER_SUNSET.toISOString() });
    expect(db.accounts[0].consent).toEqual(ON_FILE);
  });

  it("after a reclaim the name signs in to the new account only", async () => {
    const opts = await options();
    await register(opts.challenge);
    const B = db.accounts[1];
    const lo = await (await loginOptions(post("/api/auth/login-options", { profile: "Sam" }))).json();
    expect(lo.allowCredentials.map((c) => c.id)).toEqual(["new"]);
    expect(await (await check(new Request("https://heatwayve.app/api/auth/check?profile=Sam"))).json())
      .toEqual({ hasPasskey: true, credentialCount: 1, consent: null });
    // The old passkey id presented for the name is unknown now.
    const res = await loginVerify(post("/api/auth/login-verify", { profile: "Sam", credential: { id: "old", rawId: "old", type: "public-key", response: {} } }));
    expect(res.status).toBe(400);
    expect(auth).not.toHaveBeenCalled();
    expect(B.id).not.toBe(A);
  });

  it("the previous holder's legacy cookie no longer passes for the name; their grant still reaches only A", async () => {
    const legacyCookie = { profile: "sam", expires: Date.now() + 86400000, scope: "sync" };
    expect(await resolveTokenIdentity(legacyCookie, "Sam")).toMatchObject({ accountId: A, storageKey: "sam" });
    const opts = await options();
    await register(opts.challenge);
    const B = db.accounts[1];
    expect(await resolveTokenIdentity(legacyCookie, "Sam")).toBeNull();
    const legacyGrant = { profile: "sam", expires: Date.now() + 86400000 };
    const id = await resolveTokenIdentity(legacyGrant, null);
    expect(id).toMatchObject({ accountId: A, storageKey: "sam" });
    expect(id.accountId).not.toBe(B.id);
    // B's own token resolves to B for the name.
    const bTok = [...tokens.values()][0];
    expect(await resolveTokenIdentity(bTok, "Sam")).toMatchObject({ accountId: B.id, storageKey: B.id });
  });

  it("the reclaimer's photos key by its own storage key, never the name it holds", async () => {
    const theirs = "forge/profiles/sam/photos/2026-09-01.jpg";
    blobs.set(theirs, "A's photo");
    const opts = await options();
    expect((await register(opts.challenge)).status).toBe(200);
    const B = db.accounts[1];
    const bTok = [...tokens.keys()][0];
    const url = (q) => `https://heatwayve.app/api/photos?profile=Sam${q}`;
    const as = (method, q, body) => new NextRequest(url(q), { method, headers: { "x-hw-auth": bTok }, body });
    const own = `forge/profiles/${B.id}/photos/2026-09-01.jpg`;

    expect((await photos.POST(as("POST", "&date=2026-09-01", JPEG))).status).toBe(200);
    expect(vi.mocked(blobApi.put).mock.calls.at(-1)[0]).toBe(own);
    expect(vi.mocked(dbUpsertPhoto).mock.calls).toEqual([[B.id, { date: "2026-09-01", blobPath: own, bodyweightAt: null }]]);
    expect(blobs.get(theirs)).toBe("A's photo");

    expect((await photos.GET(as("GET", ""))).status).toBe(200);
    expect(vi.mocked(dbListPhotos).mock.calls).toEqual([[B.id]]);
    expect(vi.mocked(dbHasRetiredPhotos).mock.calls).toEqual([[B.id]]);

    vi.mocked(dbGetPhoto).mockResolvedValueOnce({ blob_path: own });
    expect((await photos.GET(as("GET", "&date=2026-09-01"))).status).toBe(200);
    expect(vi.mocked(blobApi.get).mock.calls).toEqual([[own, { access: "private" }]]);

    // An index row under B's key that points into A's directory is refused.
    vi.mocked(dbGetPhoto).mockResolvedValueOnce({ blob_path: theirs }).mockResolvedValueOnce({ blob_path: theirs });
    expect((await photos.GET(as("GET", "&date=2026-09-01"))).status).toBe(404);
    expect((await photos.DELETE(as("DELETE", "&date=2026-09-01"))).status).toBe(404);
    expect(vi.mocked(blobApi.get).mock.calls).toHaveLength(1);
    expect(vi.mocked(dbDeletePhoto)).not.toHaveBeenCalled();
    expect(vi.mocked(blobApi.del)).not.toHaveBeenCalled();

    expect(vi.mocked(dbGetPhoto).mock.calls).toEqual([[B.id, "2026-09-01"], [B.id, "2026-09-01"], [B.id, "2026-09-01"]]);
    expect(blobs.get(theirs)).toBe("A's photo");
  });

  it("a concurrent claimant wins the handle: 409 and nothing committed", async () => {
    const opts = await options();
    db.race = (s) => {
      for (const r of s.handles) if (r.handle === "sam" && r.account_id === A) r.released_at = "race";
      s.accounts.push({ id: C, storage_key: C, webauthn_user_id: "uid-c", origin: "reclaim", roles: ["lifter"], plan: "free", consent: null, deleted_at: null });
      s.handles.push({ id: 99, handle: "sam", account_id: C, display: "sam", kind: "primary", released_at: null });
    };
    const res = await register(opts.challenge);
    expect(res.status).toBe(409);
    expect(db.txns).toEqual([expect.objectContaining({ committed: false })]);
    expect(db.accounts.map((a) => a.id)).toEqual([A, C]);
    expect(db.credentials.map((c) => c.id)).toEqual(["old"]);
    expect(blobWrites).toEqual([]);
    expect(tokens.size).toBe(0);
  });

  it("a reclaim presenting the lapsed account's own passkey id fails the ceremony before any write", async () => {
    const opts = await options();
    reg.mockResolvedValueOnce({
      verified: true,
      registrationInfo: { rpID: "heatwayve.app", credential: { id: "old", publicKey: new Uint8Array([9, 9]), counter: 0, transports: ["internal"] } },
    });
    const res = await register(opts.challenge);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Registration could not be verified" });
    // The index lookup named A, the lapsed holder, for the presented id.
    const lookup = db.log.filter((l) => /^\s*SELECT account_id FROM credentials/.test(l.q));
    expect(lookup.map((l) => l.values[0])).toEqual(["old"]);
    expect(db.credentials.filter((c) => c.id === "old").map((c) => c.account_id)).toEqual([A]);
    expect(dbReclaimHandle).not.toHaveBeenCalled();
    expect(mintAuthToken).not.toHaveBeenCalled();
    expect(vi.mocked(blobApi.put)).not.toHaveBeenCalled();
    expect(db.txns).toEqual([]);
    expect(writes()).toEqual([]);
    expect(blobWrites).toEqual([]);
    expect(tokens.size).toBe(0);
    expect(db.handles.find((h) => h.account_id === A).released_at).toBeNull();
  });

  it("blob challenge mode carries the reclaim user.id in the challenge blob", async () => {
    delete process.env.CHALLENGE_SECRET;
    const opts = await options();
    const key = `forge/challenges/${createHash("sha256").update("sam").digest("base64url")}`;
    expect(JSON.parse(blobs.get(key)).userId).toBe(opts.user.id);
    expect(opts.user.id).not.toBe(`uid-${A}`);
    expect((await register(opts.challenge)).status).toBe(200);
    expect(db.accounts[1].webauthn_user_id).toBe(opts.user.id);
    expect(db.credentials.find((c) => c.id === "new").user_handle).toBe(opts.user.id);
  });
});

describe("options and verify agree on reclaim-or-not", () => {
  // The library checks the challenge through expectedChallenge; run it here.
  beforeEach(() => {
    seedAccount(A, "sam", "sam");
    db.credentials.push({ ...LEGACY, account_id: A }); // theforged.fit: usable until the sunset
    reg.mockImplementation(async ({ response, expectedChallenge }) => {
      const { challenge } = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString());
      const ok = typeof expectedChallenge === "function" ? expectedChallenge(challenge) : expectedChallenge === challenge;
      if (!ok) throw new Error("Unexpected registration response challenge");
      return { verified: true, registrationInfo: { rpID: "heatwayve.app", credential: { id: "new", publicKey: new Uint8Array([9]), counter: 0, transports: [] } } };
    });
  });
  const sunset = () => new Date(2026, 10, 16).getTime();

  it("a lapse that lands between options and verify fails the ceremony instead of recording a different user handle", async () => {
    vi.setSystemTime(sunset() - 30_000);
    const opts = await options();
    expect(opts.user.id).toBe(`uid-${A}`);
    vi.setSystemTime(sunset() + 30_000);
    const res = await register(opts.challenge);
    expect(res.status).toBe(400);
    expect(writes()).toEqual([]);
    expect(db.txns).toEqual([]);
    expect(blobWrites).toEqual([]);
    expect(tokens.size).toBe(0);
  });

  it("a reclaim challenge verifies only as a reclaim", async () => {
    vi.setSystemTime(sunset() + 30_000);
    const opts = await options();
    expect((await register(opts.challenge)).status).toBe(200);
    expect(db.credentials.find((c) => c.id === "new").user_handle).toBe(opts.user.id);
  });

  it("blob mode: a carried reclaim user.id is refused once the handle is no longer lapsed", async () => {
    delete process.env.CHALLENGE_SECRET;
    vi.setSystemTime(sunset() + 30_000);
    const opts = await options();
    blobWrites.length = 0; // the challenge blob options wrote
    vi.setSystemTime(sunset() - 30_000);
    tokens.set("tA", { profile: "sam", accountId: A, expires: Date.now() + 60000 });
    const res = await register(opts.challenge, { authToken: "tA" });
    expect(res.status).toBe(400);
    expect(writes()).toEqual([]);
    expect(blobWrites).toEqual([]);
  });
});

describe("a trainer's handle never lapses", () => {
  beforeEach(() => {
    seedAccount(A, "sam", "sam", { roles: ["lifter", "trainer"] });
    db.credentials.push({ ...LEGACY, account_id: A });
  });

  it("options keep the account's own user.id", async () => {
    expect((await options()).user.id).toBe(`uid-${A}`);
  });

  it("verify refuses as a protected profile, with zero writes", async () => {
    const opts = await options();
    const res = await register(opts.challenge);
    expect(res.status).toBe(401);
    expect((await res.json()).requiresAuth).toBe(true);
    expect(writes()).toEqual([]);
    expect(db.txns).toEqual([]);
    expect(blobWrites).toEqual([]);
    expect(reg).not.toHaveBeenCalled();
  });
});

describe("registering on the account the name already holds", () => {
  it("a claimed account with no passkey takes its first one on the same account", async () => {
    seedAccount(A, "sam", "sam", { origin: "precutover_claim" });
    const opts = await options();
    expect(opts.user.id).toBe(`uid-${A}`);
    expect((await register(opts.challenge)).status).toBe(200);
    expect(db.txns).toEqual([]);
    expect(db.accounts.map((a) => a.id)).toEqual([A]);
    expect(db.credentials).toEqual([expect.objectContaining({ id: "new", account_id: A, user_handle: `uid-${A}` })]);
    expect(blobWrites.map((w) => w.path)).toEqual(["forge/profiles/sam/credentials.json"]);
    expect(blobWrites[0].prefix).toBe("forge/profiles/sam/credentials");
    expect([...tokens.values()][0]).toMatchObject({ accountId: A, profile: "sam" });
  });

  it("adding a passkey needs a ceremony token for THIS account", async () => {
    seedAccount(A, "sam", "sam");
    db.credentials.push({ ...LEGACY, id: "live", rp_id: "heatwayve.app", account_id: A });
    tokens.set("tA", { profile: "sam", accountId: A, expires: Date.now() + 60000 });
    seedAccount(C, C, "other");
    tokens.set("tC", { profile: C, accountId: C, expires: Date.now() + 60000 });
    const opts = await options();
    expect((await register(opts.challenge, { authToken: "tC" })).status).toBe(401);
    expect((await register(opts.challenge)).status).toBe(401);
    expect(writes()).toEqual([]);
    expect((await register(opts.challenge, { authToken: "tA" })).status).toBe(200);
    expect(db.credentials.map((c) => c.account_id)).toEqual([A, A]);
  });

  it("no account holding the name: 404 from options and verify, even with blobs under it", async () => {
    blobs.set("forge/profiles/sam/meta.json", "{}");
    expect((await registerOptions(post("/api/auth/register-options", { profile: "Sam" }))).status).toBe(404);
    expect((await register("x")).status).toBe(404);
    expect(writes()).toEqual([]);
  });
});

describe("sign-in reads the credential index", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
    seedAccount(A, "sam", "sam");
  });
  const login = (id) => loginVerify(post("/api/auth/login-verify", { profile: "Sam", credential: { id, rawId: id, type: "public-key", response: {} } }));

  it("a passkey only in the index signs in, with no Blob doc at all", async () => {
    db.credentials.push({ ...LEGACY, id: "idx", rp_id: "heatwayve.app", account_id: A });
    const lo = await (await loginOptions(post("/api/auth/login-options", { profile: "Sam" }))).json();
    expect(lo).toMatchObject({ rpId: "heatwayve.app", allowCredentials: [expect.objectContaining({ id: "idx" })] });
    const res = await login("idx");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ verified: true, profile: "sam" });
    // Three tokens, all for A under its storage key; no mirror doc to write.
    expect([...tokens.values()].map((t) => [t.accountId, t.profile])).toEqual([[A, "sam"], [A, "sam"], [A, "sam"]]);
    expect(blobWrites).toEqual([]);
    expect(db.credentials[0].last_used_at).not.toBeNull();
    // The counter the signature check ran against came from the index.
    expect(auth.mock.calls[0][0].credential.counter).toBe(4);
  });

  it("clone detection runs against the higher counter of the index and the doc", async () => {
    db.credentials.push({ ...LEGACY, id: "both", rp_id: "heatwayve.app", counter: 2, account_id: A });
    blobs.set("forge/profiles/sam/credentials-x1.json", JSON.stringify({ credentials: [{ id: "both", publicKey: "AQID", counter: 9, rpId: "heatwayve.app" }] }));
    await login("both");
    expect(auth.mock.calls[0][0].credential.counter).toBe(9);
    db.credentials[0].counter = 12;
    await login("both");
    expect(auth.mock.calls[1][0].credential.counter).toBe(12);
  });

  it("with no Blob doc, a sign-in consent claim lands on the account alone", async () => {
    db.credentials.push({ ...LEGACY, id: "idx", rp_id: "heatwayve.app", account_id: A });
    const { CONSENT_VERSION } = await import("@/lib/consent");
    const res = await loginVerify(post("/api/auth/login-verify", { profile: "Sam", credential: { id: "idx", rawId: "idx", type: "public-key", response: {} }, consent: { version: CONSENT_VERSION } }));
    expect((await res.json()).consentRecorded).toBe(true);
    expect(db.accounts[0].consent).toEqual({ version: CONSENT_VERSION, at: "2026-10-01T12:00:00.000Z" });
    expect(blobWrites).toEqual([]);
  });

  it("a passkey only in the Blob doc still signs in while the fallback is on", async () => {
    expect(IDENTITY_BLOB_FALLBACK).toBe(true);
    blobs.set("forge/profiles/sam/credentials-x1.json", JSON.stringify({ credentials: [{ id: "doc", publicKey: "AQID", counter: 0, rpId: "heatwayve.app" }] }));
    expect((await login("doc")).status).toBe(200);
  });

  it("the index wins over the doc on the same id; the doc is read only under the account's storage key", async () => {
    db.credentials.push({ ...LEGACY, id: "both", rp_id: "heatwayve.app", counter: 7, account_id: A });
    blobs.set("forge/profiles/sam/credentials-x1.json", JSON.stringify({ credentials: [{ id: "both", publicKey: "OLD", counter: 1, rpId: "theforged.fit" }, { id: "extra", publicKey: "AQID", rpId: "heatwayve.app" }] }));
    blobs.set("forge/profiles/other/credentials-x1.json", JSON.stringify({ credentials: [{ id: "foreign", publicKey: "AQID", rpId: "heatwayve.app" }] }));
    const set = await readCredentialSet({ id: A, storageKey: "sam", consent: null });
    expect(set.credentials.map((c) => [c.id, c.publicKey, c.counter])).toEqual([["both", "AQID", 7], ["extra", "AQID", undefined]]);
    expect((await login("foreign")).status).toBe(400);
  });

  it("consent: the account's record first, the doc's when the account has none", async () => {
    blobs.set("forge/profiles/sam/credentials-x1.json", JSON.stringify({ credentials: [], consent: { version: "doc", at: "d" } }));
    expect((await readCredentialSet({ id: A, storageKey: "sam", consent: ON_FILE })).consent).toEqual(ON_FILE);
    expect((await readCredentialSet({ id: A, storageKey: "sam", consent: null })).consent).toEqual({ version: "doc", at: "d" });
  });

  it("an unknown name has no passkey, needs registering, and cannot sign in", async () => {
    blobs.set("forge/profiles/ghost/credentials-x1.json", JSON.stringify({ credentials: [{ id: "g", publicKey: "AQID", rpId: "heatwayve.app" }] }));
    expect(await (await check(new Request("https://heatwayve.app/api/auth/check?profile=Ghost"))).json())
      .toEqual({ hasPasskey: false, credentialCount: 0, consent: null });
    const lo = await loginOptions(post("/api/auth/login-options", { profile: "Ghost" }));
    expect(lo.status).toBe(404);
    expect((await lo.json()).needsRegister).toBe(true);
    expect((await loginVerify(post("/api/auth/login-verify", { profile: "Ghost", credential: { id: "g", rawId: "g", type: "public-key", response: {} } }))).status).toBe(400);
    expect(auth).not.toHaveBeenCalled();
  });
});

describe("registration still reads the doc once the sign-in fallback is off", () => {
  let verify, opts, signInOptions;
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("@/lib/identity", async (importOriginal) => ({ ...(await importOriginal()), IDENTITY_BLOB_FALLBACK: false }));
    ({ POST: verify } = await import("@/app/api/auth/register-verify/route"));
    ({ POST: opts } = await import("@/app/api/auth/register-options/route"));
    ({ POST: signInOptions } = await import("@/app/api/auth/login-options/route"));
    seedAccount(A, "sam", "sam");
    // Two passkeys that only ever reached the doc (an index write that was swallowed).
    blobs.set("forge/profiles/sam/credentials-x1.json", JSON.stringify({ credentials: [
      { id: "c1", publicKey: "AQID", counter: 0, rpId: "heatwayve.app" },
      { id: "c2", publicKey: "AQID", counter: 0, rpId: "heatwayve.app" },
    ] }));
  });
  afterEach(() => { vi.doUnmock("@/lib/identity"); vi.resetModules(); });
  const reg3 = (body = {}) => verify(post("/api/auth/register-verify", {
    profile: "Sam", credential: { id: "new", rawId: "new", type: "public-key", response: { clientDataJSON: clientData("x") } }, ...body,
  }));

  it("the flag really is off for this route", async () => {
    expect((await import("@/lib/credential-store")).IDENTITY_BLOB_FALLBACK).toBe(false);
  });

  it("a stranger with no token cannot register on a doc-only account", async () => {
    const res = await reg3();
    expect(res.status).toBe(401);
    expect(writes()).toEqual([]);
    expect(blobWrites).toEqual([]);
    expect(tokens.size).toBe(0);
  });

  it("options and verify make the same reclaim call: a profile whose doc holds only keyless passkeys can register", async () => {
    // Keyless credentials never reach the index; only the doc holds them.
    blobs.clear();
    blobs.set("forge/profiles/sam/credentials-x1.json", JSON.stringify({ credentials: [{ id: "k", counter: 0 }] }));
    // As the library does: the challenge the client signed must pass verify's check.
    reg.mockImplementation(async ({ expectedChallenge, response }) => {
      const { challenge } = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8"));
      const ok = typeof expectedChallenge === "function" ? await expectedChallenge(challenge) : expectedChallenge === challenge;
      if (!ok) throw new Error("Custom challenge verifier returned false");
      return { verified: true, registrationInfo: { rpID: "heatwayve.app", credential: { id: "new", publicKey: new Uint8Array([9, 9]), counter: 0, transports: ["internal"] } } };
    });
    const o = await (await opts(post("/api/auth/register-options", { profile: "Sam" }))).json();
    const res = await verify(post("/api/auth/register-verify", {
      profile: "Sam", credential: { id: "new", rawId: "new", type: "public-key", response: { clientDataJSON: clientData(o.challenge) } },
    }));
    expect(res.status).toBe(200);
    const fresh = db.accounts.find((a) => a.origin === "reclaim");
    expect(fresh).toMatchObject({ storage_key: fresh.id, webauthn_user_id: o.user.id });
    expect(db.credentials.map((c) => [c.id, c.account_id])).toEqual([["new", fresh.id]]);
  });

  it("the index takes a new passkey before the doc: a failed INSERT leaves nothing, and the retry lands in both", async () => {
    blobs.clear();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    db.failCredentialInsert = true;
    const first = await reg3();
    spy.mockRestore();
    expect(first.status).toBe(500);
    expect(blobWrites).toEqual([]);
    expect(db.credentials).toEqual([]);
    expect(tokens.size).toBe(0);

    expect((await reg3()).status).toBe(200);
    expect(db.credentials.map((c) => [c.id, c.account_id])).toEqual([["new", A]]);
    expect(JSON.parse(blobs.get("forge/profiles/sam/credentials.json")).credentials.map((c) => c.id)).toEqual(["new"]);
    const lo = await signInOptions(post("/api/auth/login-options", { profile: "Sam" }));
    expect(lo.status).toBe(200);
    expect((await lo.json()).allowCredentials.map((c) => c.id)).toEqual(["new"]);
  });

  it("sign-in keeps the doc mirror up while the window is open, without taking the doc as a passkey", async () => {
    // c1 is indexed; c2 reached only the doc.
    db.credentials.push({ ...LEGACY, id: "c1", rp_id: "heatwayve.app", counter: 0, account_id: A });
    auth.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 5, rpID: "heatwayve.app" } });
    const { POST: lv } = await import("@/app/api/auth/login-verify/route");
    const signIn = (id) => lv(post("/api/auth/login-verify", { profile: "Sam", credential: { id, rawId: id, type: "public-key", response: {} } }));
    expect((await signIn("c2")).status).toBe(400);
    expect((await signIn("c1")).status).toBe(200);
    expect(db.credentials[0].counter).toBe(5);
    const doc = JSON.parse(blobs.get("forge/profiles/sam/credentials.json"));
    expect(doc.credentials.map((c) => [c.id, c.counter])).toEqual([["c1", 5], ["c2", 0]]);
  });

  it("the owner's third passkey keeps the doc's two: the mirror never drops what it did not read", async () => {
    tokens.set("tA", { profile: "sam", accountId: A, expires: Date.now() + 60000 });
    expect((await reg3({ authToken: "tA" })).status).toBe(200);
    expect(blobWrites).toHaveLength(1);
    expect(blobWrites[0].value.credentials.map((c) => c.id)).toEqual(["c1", "c2", "new"]);
    expect(JSON.parse(blobs.get("forge/profiles/sam/credentials.json")).credentials.map((c) => c.id)).toEqual(["c1", "c2", "new"]);
  });
});
