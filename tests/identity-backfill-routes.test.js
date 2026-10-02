// Identity backfill routes: the dry-run (CRON_SECRET and the admin view on
// /diag-sync) only reads; apply is disabled by default, needs a fresh admin
// ceremony and the exact planHash, refuses on any conflict, and only ever
// INSERTs … ON CONFLICT DO NOTHING. Nothing returned carries a public key or
// a full credential id. The admin is recognised by the account the token
// resolves to (ADMIN_ACCOUNT_ID, else ADMIN_PROFILE as a storage key).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// ── In-memory Neon: answers exactly the statements these routes issue ───────
const calls = [];
let state;
let tokens; // hashed token → auth_tokens row
let names; // table → DISTINCT profiles
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

function fakeQuery(q, v) {
  if (/^\s*(CREATE|ALTER)\b/.test(q)) return [];
  calls.push({ q, values: v });
  if (/FROM auth_tokens\s+WHERE token = /.test(q)) {
    const row = tokens.get(v[0]);
    return row ? [row] : [];
  }
  let m = q.match(/^SELECT DISTINCT profile FROM (\w+)$/);
  if (m) return (names[m[1]] || []).map((profile) => ({ profile }));
  if (/^SELECT profile, value FROM meta WHERE field = 'displayName'$/.test(q)) return state.display;
  if (/^SELECT id, storage_key, deleted_at FROM accounts$/.test(q)) return state.accounts.map(({ id, storage_key, deleted_at = null }) => ({ id, storage_key, deleted_at }));
  if (/^SELECT DISTINCT account_id FROM handles$/.test(q)) return [...new Set(state.handles.map((h) => h.account_id))].map((account_id) => ({ account_id }));
  if (/^SELECT handle, account_id FROM handles WHERE released_at IS NULL$/.test(q)) return state.handles.filter((h) => !h.released_at).map(({ handle, account_id }) => ({ handle, account_id }));
  if (/^SELECT id, account_id FROM credentials$/.test(q)) return state.credentials.map(({ id, account_id }) => ({ id, account_id }));
  const bySk = (sk) => state.accounts.find((a) => a.storage_key === sk);
  if (/^SELECT \* FROM accounts WHERE id = \? LIMIT 1$/.test(q)) return state.accounts.filter((a) => a.id === v[0]);
  if (/^SELECT \* FROM accounts WHERE storage_key = \? LIMIT 1$/.test(q)) return state.accounts.filter((a) => a.storage_key === v[0]);
  if (/^\s*INSERT INTO accounts\b/.test(q)) {
    const [id, sk, webauthn_user_id, consent] = v;
    if (bySk(sk)) return [];
    state.accounts.push({ id, storage_key: sk, webauthn_user_id, consent });
    return [{ id }];
  }
  if (/^\s*INSERT INTO handles\b/.test(q)) {
    const [handle, display, claimed_at, sk] = v;
    const a = bySk(sk);
    if (!a || a.deleted_at || state.handles.some((h) => h.handle === handle && !h.released_at)) return [];
    state.handles.push({ handle, account_id: a.id, display, claimed_at });
    return [{ id: state.handles.length }];
  }
  if (/^\s*INSERT INTO credentials\b/.test(q)) {
    const [id, public_key, counter, transports, rp_id, user_handle, created_at, sk] = v;
    const a = bySk(sk);
    if (!a || a.deleted_at || state.credentials.some((c) => c.id === id)) return [];
    state.credentials.push({ id, account_id: a.id, public_key, counter, transports, rp_id, user_handle, created_at });
    return [{ id }];
  }
  throw new Error(`unexpected SQL: ${q}`);
}

vi.mock("@neondatabase/serverless", () => ({
  neon: () => async (strings, ...values) => fakeQuery(strings.join("?").trim(), values),
}));

let blobs;
let docs;
vi.mock("@vercel/blob", () => ({
  list: async () => ({ blobs, cursor: undefined }),
  get: async () => null,
}));
vi.mock("../lib/blob-utils.js", () => ({ readJsonDirect: async (p) => (p in docs ? docs[p] : null) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => null, rateLimitShared: async () => null }));

// ── Census fixture (spec §6): one profile, two keyed passkeys ──────────────
const PK1 = "pQECAyYgASFYIPUBLICKEYONEheatwayveAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PK2 = "pQECAyYgASFYIPUBLICKEYTWOtheforgedBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ID1 = "AAAAcredentialOneFullIdentifier111111";
const ID2 = "BBBBcredentialTwoFullIdentifier222222";
const CRED_PATH = "forge/profiles/sam/credentials-x1.json";
const ADMIN_ID = "hwa_" + "b".repeat(26);
const BOB_ID = "hwa_" + "c".repeat(26);

function fixture() {
  blobs = [
    { pathname: "forge/profiles/sam/meta.json", uploadedAt: new Date("2026-06-01T10:00:00Z"), size: 10 },
    { pathname: CRED_PATH, uploadedAt: new Date("2026-08-01T10:00:00Z"), size: 10 },
    { pathname: "forge/profiles/sam/photos/2026-09-01.jpg", uploadedAt: new Date("2026-09-01T10:00:00Z"), size: 10 },
  ];
  docs = {
    [CRED_PATH]: {
      credentials: [
        { id: ID1, publicKey: PK1, counter: 3, transports: ["internal"], rpId: "heatwayve.app", createdAt: "2026-08-01T10:00:00.000Z" },
        { id: ID2, publicKey: PK2, counter: 0, transports: ["hybrid"], rpId: "theforged.fit" },
      ],
      consent: { version: "v2", at: "2026-09-01T00:00:00.000Z" },
    },
  };
  names = { sessions: ["sam"], meta: ["sam"], photos: ["sam"], auth_tokens: ["sam"], oauth_grants: [], oauth_codes: [] };
  // The owner and one other lifter already hold accounts with no data rows,
  // so the census plan (sam only) is unchanged by them.
  state = {
    accounts: [
      { id: ADMIN_ID, storage_key: "boss", roles: ["lifter"], plan: "free", deleted_at: null },
      { id: BOB_ID, storage_key: "bob", roles: ["lifter"], plan: "free", deleted_at: null },
    ],
    handles: [], credentials: [], display: [{ profile: "sam", value: "Sam" }],
  };
}
const SEEDED = 2;

const NOW = Date.now();
function token(name, row) {
  tokens.set(sha(name), {
    profile: "boss", expires: NOW + 3600000, scope: null, created_at: new Date(NOW).toISOString(),
    auth_at: new Date(NOW - 10000).toISOString(), credential_id: ID1, account_id: ADMIN_ID, ...row,
  });
  return name;
}

const writes = () => calls.filter((c) => !/^\s*SELECT\b/.test(c.q));
const req = (path, { method = "GET", headers = {}, body } = {}) =>
  new Request(`https://heatwayve.app${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const leaks = (text) => [PK1, PK2, ID1, ID2].filter((s) => text.includes(s));

const dryRun = () => import("../app/api/diag/identity-backfill/route.js");
const adminView = () => import("../app/api/diag/identity-backfill/admin/route.js");
const apply = () => import("../app/api/diag/identity-backfill/apply/route.js");

let logs;
beforeEach(() => {
  calls.length = 0;
  tokens = new Map();
  fixture();
  token("good-token", {});
  token("scoped-token", { scope: "sync" });
  token("photo-token", { scope: "photos" });
  token("expired-token", { expires: NOW - 1 });
  token("stale-token", { auth_at: new Date(NOW - 20 * 60000).toISOString() });
  token("legacy-admin-token", { account_id: null }); // pre-cutover row: resolves by storage key
  token("bob-token", { profile: "bob", account_id: BOB_ID });
  token("ghost-token", { profile: "ghost", account_id: null }); // no account holds this storage key
  delete process.env.ADMIN_PROFILE;
  process.env.DATABASE_URL = "postgres://fake";
  process.env.CRON_SECRET = "s3cret";
  process.env.ADMIN_ACCOUNT_ID = ADMIN_ID;
  process.env.IDENTITY_BACKFILL_APPLY = "1";
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
});
afterEach(() => {
  for (const k of ["DATABASE_URL", "CRON_SECRET", "ADMIN_ACCOUNT_ID", "ADMIN_PROFILE", "IDENTITY_BACKFILL_APPLY"]) delete process.env[k];
  vi.restoreAllMocks();
});

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
const DRY_FILES = ["app/api/diag/identity-backfill/route.js", "app/api/diag/identity-backfill/admin/route.js", "lib/identity-backfill-inputs.js"];
const APPLY_FILE = "app/api/diag/identity-backfill/apply/route.js";

// ─────────────────────────────────────────────────────────────────────────────
describe("identity backfill dry-run — source can never write", () => {
  it.each(DRY_FILES)("%s: blob import is list only; no write verb, SQL or otherwise", (f) => {
    const src = read(f);
    const blobImport = src.match(/import\s*\{[^}]*\}\s*from\s*"@vercel\/blob"/s)?.[0] || "";
    if (blobImport) expect(blobImport.replace(/import|from|"@vercel\/blob"|[{}\s]/g, "")).toBe("list");
    const c = code(src);
    expect(c).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/);
    for (const banned of [/\bdel\s*\(/, /\bput\s*\(/, /\bcopy\s*\(/, /deleteByPrefix|writeJson|dbDeleteToken|removeItem/]) {
      expect(c).not.toMatch(banned);
    }
    expect(src).not.toMatch(/identity-store/);
  });

  it("each dry-run route exports only GET", () => {
    for (const f of DRY_FILES.slice(0, 2)) {
      expect([...read(f).matchAll(/export async function ([A-Z]+)/g)].map((m) => m[1])).toEqual(["GET"]);
    }
  });

  it("is not a cron", () => {
    const crons = JSON.parse(read("vercel.json")).crons || [];
    expect(crons.some((c) => String(c.path).includes("identity-backfill"))).toBe(false);
  });
});

describe("identity backfill dry-run — CRON_SECRET route", () => {
  it("500 without CRON_SECRET, 401 with a bad bearer, and no SQL either way", async () => {
    const { GET } = await dryRun();
    delete process.env.CRON_SECRET;
    expect((await GET(req("/api/diag/identity-backfill"))).status).toBe(500);
    process.env.CRON_SECRET = "s3cret";
    expect((await GET(req("/api/diag/identity-backfill", { headers: { authorization: "Bearer nope" } }))).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("returns the census plan, safe, with an aggregate-only log line and zero writes", async () => {
    const { GET } = await dryRun();
    const res = await GET(req("/api/diag/identity-backfill", { headers: { authorization: "Bearer s3cret" } }));
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.dryRun).toBe(true);
    expect(body.counts.accounts.create).toBe(1);
    expect(body.counts.handles.create).toBe(1);
    expect(body.counts.credentials.create).toBe(2);
    expect(body.conflicts).toEqual([]);
    expect(body.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.credentials.map((c) => c.rpId).sort()).toEqual(["heatwayve.app", "theforged.fit"]);
    expect(leaks(text)).toEqual([]);
    expect(writes()).toEqual([]);
    const line = logs.find((l) => l.startsWith("[forge:identity-backfill]"));
    expect(line).toMatch(/accounts=1 handles=1 credentials=2 conflicts=0 .* hash=[0-9a-f]{64}$/);
    expect(line).not.toMatch(/sam/);
    expect(leaks(line)).toEqual([]);
  });
});

describe("identity backfill dry-run — owner view on /diag-sync", () => {
  const view = async (tok) => (await adminView()).GET(req("/api/diag/identity-backfill/admin", { headers: tok ? { "x-hw-auth": tok } : {} }));

  it("401 without a token, with a scoped, photo or expired token, or one no account holds", async () => {
    for (const t of [null, "nope", "scoped-token", "photo-token", "expired-token", "ghost-token"]) {
      expect((await view(t)).status).toBe(401);
    }
    expect(writes()).toEqual([]);
  });

  it("admin by account id: the token's account must be ADMIN_ACCOUNT_ID", async () => {
    expect((await view("good-token")).status).toBe(200);
    expect((await view("legacy-admin-token")).status).toBe(200); // legacy row, same account
    expect((await view("bob-token")).status).toBe(403);
    process.env.ADMIN_ACCOUNT_ID = BOB_ID;
    process.env.ADMIN_PROFILE = "boss"; // the id wins over the fallback
    expect((await view("good-token")).status).toBe(403);
    expect(writes()).toEqual([]);
  });

  it("admin by legacy ADMIN_PROFILE: matched against the resolved storage key", async () => {
    delete process.env.ADMIN_ACCOUNT_ID;
    process.env.ADMIN_PROFILE = "Boss";
    expect((await view("legacy-admin-token")).status).toBe(200);
    expect((await view("good-token")).status).toBe(200);
    expect((await view("bob-token")).status).toBe(403);
    process.env.ADMIN_PROFILE = "ghost"; // names a storage key no account holds
    expect((await view("ghost-token")).status).toBe(401);
    expect(writes()).toEqual([]);
  });

  it("a token whose account is closed is refused, even under ADMIN_PROFILE", async () => {
    delete process.env.ADMIN_ACCOUNT_ID;
    process.env.ADMIN_PROFILE = "boss";
    state.accounts[0].deleted_at = new Date(NOW - 1000).toISOString();
    expect((await view("legacy-admin-token")).status).toBe(401);
  });

  it("403 when both ADMIN_ACCOUNT_ID and ADMIN_PROFILE are unset (fails closed)", async () => {
    delete process.env.ADMIN_ACCOUNT_ID;
    for (const t of ["good-token", "legacy-admin-token", "bob-token"]) expect((await view(t)).status).toBe(403);
  });

  it("the admin reads the same safe plan, plus whether apply is on", async () => {
    const { GET } = await dryRun();
    const cron = await (await GET(req("/api/diag/identity-backfill", { headers: { authorization: "Bearer s3cret" } }))).json();
    const res = await view("stale-token"); // reading needs no fresh ceremony
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.planHash).toBe(cron.planHash);
    expect(body.applyEnabled).toBe(true);
    expect(leaks(text)).toEqual([]);
    delete process.env.IDENTITY_BACKFILL_APPLY;
    expect((await (await view("good-token")).json()).applyEnabled).toBe(false);
    expect(writes()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("identity backfill apply — source", () => {
  const src = read(APPLY_FILE);
  it("exports POST only", () => {
    expect([...src.matchAll(/export async function ([A-Z]+)/g)].map((m) => m[1])).toEqual(["POST"]);
  });
  it("writes nothing but INSERT … ON CONFLICT … DO NOTHING; no update, delete, blob write or token consume", () => {
    const c = code(src);
    expect(c).not.toMatch(/\b(UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE)\b/);
    expect(c).not.toMatch(/DO UPDATE|@vercel\/blob|\bdel\s*\(|\bput\s*\(|dbDeleteToken|deleteByPrefix|writeJson|identity-store/);
    const sqls = [...c.matchAll(/q`([^`]*)`/g)].map((m) => m[1]);
    expect(sqls).toHaveLength(3);
    for (const s of sqls) expect(s).toMatch(/^\s*INSERT INTO (accounts|handles|credentials)\b[\s\S]*ON CONFLICT[\s\S]*DO NOTHING/);
  });
  it("never attaches a handle or credential to a closed account", () => {
    const sqls = [...code(src).matchAll(/q`([^`]*)`/g)].map((m) => m[1]).filter((s) => /FROM accounts a/.test(s));
    expect(sqls).toHaveLength(2);
    for (const s of sqls) expect(s).toMatch(/WHERE a\.storage_key = \$\{\w+\.storageKey\} AND a\.deleted_at IS NULL/);
  });
});

describe("identity backfill apply — gates", () => {
  const post = async (tok, body) =>
    (await apply()).POST(req("/api/diag/identity-backfill/apply", { method: "POST", headers: tok ? { "x-hw-auth": tok } : {}, body }));
  const currentHash = async () =>
    (await (await (await dryRun()).GET(req("/api/diag/identity-backfill", { headers: { authorization: "Bearer s3cret" } }))).json()).planHash;

  it.each([undefined, "0", "true", "yes"])("flag %s → 403 and no SQL at all", async (flag) => {
    const hash = await currentHash();
    calls.length = 0;
    if (flag === undefined) delete process.env.IDENTITY_BACKFILL_APPLY; else process.env.IDENTITY_BACKFILL_APPLY = flag;
    const res = await post("good-token", { confirm: hash });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("apply disabled");
    expect(calls).toEqual([]);
  });

  it("401 for no, unknown, scoped, expired, stale (not fresh) or account-less ceremony tokens; zero writes", async () => {
    const hash = await currentHash();
    for (const t of [null, "nope", "scoped-token", "photo-token", "expired-token", "stale-token", "ghost-token"]) {
      expect((await post(t, { confirm: hash })).status).toBe(401);
    }
    expect(writes()).toEqual([]);
  });

  it("403 for a non-admin account, or with both ADMIN_ACCOUNT_ID and ADMIN_PROFILE unset", async () => {
    const hash = await currentHash();
    expect((await post("bob-token", { confirm: hash })).status).toBe(403);
    delete process.env.ADMIN_ACCOUNT_ID;
    expect((await post("good-token", { confirm: hash })).status).toBe(403);
    expect((await post("legacy-admin-token", { confirm: hash })).status).toBe(403);
    expect(writes()).toEqual([]);
  });

  it("the legacy ADMIN_PROFILE fallback admits the owner's legacy ceremony token", async () => {
    delete process.env.ADMIN_ACCOUNT_ID;
    process.env.ADMIN_PROFILE = "boss";
    const hash = await currentHash();
    calls.length = 0;
    expect((await post("legacy-admin-token", { confirm: hash })).status).toBe(200);
    expect(writes()).toHaveLength(4);
  });

  it("400 without a hash-shaped confirm", async () => {
    expect((await post("good-token", {})).status).toBe(400);
    expect((await post("good-token", { confirm: "abc" })).status).toBe(400);
    expect(writes()).toEqual([]);
  });

  it("409 on a hash mismatch, with zero writes and no key material", async () => {
    const res = await post("good-token", { confirm: "0".repeat(64) });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text).planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(leaks(text)).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it("409 when the store changed after the owner read the hash", async () => {
    const hash = await currentHash();
    docs[CRED_PATH].credentials[1].counter = 9; // a sign-in between read and apply
    expect((await post("good-token", { confirm: hash })).status).toBe(409);
    expect(writes()).toEqual([]);
  });

  it("409 on any conflict, even with the matching hash, and zero writes", async () => {
    names.sessions.push("Sam"); // non-canonical key
    const hash = await currentHash();
    const res = await post("good-token", { confirm: hash });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text).conflicts).toEqual([{ key: "Sam", reason: "non-canonical" }]);
    expect(leaks(text)).toEqual([]);
    expect(writes()).toEqual([]);
  });
});

describe("identity backfill apply — happy path", () => {
  const post = async (tok, body) =>
    (await apply()).POST(req("/api/diag/identity-backfill/apply", { method: "POST", headers: { "x-hw-auth": tok }, body }));
  const dry = async () =>
    (await (await dryRun()).GET(req("/api/diag/identity-backfill", { headers: { authorization: "Bearer s3cret" } }))).json();

  it("inserts exactly the planned rows, returns counts only; a second apply inserts 0", async () => {
    const before = await dry();
    calls.length = 0;
    const res = await post("good-token", { confirm: before.planHash });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ applied: true, inserted: { accounts: 1, handles: 1, credentials: 2 } });
    expect(leaks(text)).toEqual([]);

    const w = writes();
    expect(w).toHaveLength(4);
    for (const s of w) expect(s.q).toMatch(/^\s*INSERT INTO (accounts|handles|credentials)\b[\s\S]*ON CONFLICT[\s\S]*DO NOTHING/);

    expect(state.accounts).toHaveLength(SEEDED + 1);
    const acct = state.accounts[SEEDED];
    expect(acct.id).toMatch(/^hwa_[a-z2-7]{26}$/);
    expect(acct.storage_key).toBe("sam");
    expect(acct.webauthn_user_id).not.toBe(createHash("sha256").update("sam").digest("base64url"));
    expect(JSON.parse(acct.consent)).toEqual({ version: "v2", at: "2026-09-01T00:00:00.000Z" });
    expect(state.handles).toEqual([{ handle: "sam", account_id: acct.id, display: "Sam", claimed_at: "2026-06-01T10:00:00.000Z" }]);
    const legacy = createHash("sha256").update("sam").digest("base64url");
    expect(state.credentials.map((c) => [c.id, c.public_key, c.rp_id, c.user_handle, c.account_id])).toEqual([
      [ID1, PK1, "heatwayve.app", legacy, acct.id],
      [ID2, PK2, "theforged.fit", legacy, acct.id],
    ]);
    const line = logs.filter((l) => l.startsWith("[forge:identity-backfill]")).pop();
    expect(line).toMatch(/applied=1\/1\/2$/);
    expect(leaks(line)).toEqual([]);
    expect(line).not.toMatch(/sam|hwa_/);

    // The same hash again: the store has changed, so it is refused.
    calls.length = 0;
    expect((await post("good-token", { confirm: before.planHash })).status).toBe(409);
    expect(writes()).toEqual([]);

    // The re-read shows nothing to create; applying THAT plan inserts 0.
    const after = await dry();
    expect(after.counts).toEqual({
      accounts: { create: 0, present: 1, conflict: 0 },
      handles: { create: 0, present: 1, conflict: 0 },
      credentials: { create: 0, present: 2, conflict: 0 },
    });
    calls.length = 0;
    const again = await post("good-token", { confirm: after.planHash });
    expect(await again.json()).toEqual({ applied: true, inserted: { accounts: 0, handles: 0, credentials: 0 } });
    expect(writes()).toEqual([]);
    expect(state.accounts).toHaveLength(SEEDED + 1);
    expect(state.credentials).toHaveLength(2);
  });
});

describe("identity backfill — never re-reserves a released name", () => {
  const SAM_ID = "hwa_" + "d".repeat(26);
  const post = async (tok, body) =>
    (await apply()).POST(req("/api/diag/identity-backfill/apply", { method: "POST", headers: { "x-hw-auth": tok }, body }));
  const dry = async () =>
    (await (await dryRun()).GET(req("/api/diag/identity-backfill", { headers: { authorization: "Bearer s3cret" } }))).json();

  it("a closed account whose files outlived the wipe gets no handle and no passkey back", async () => {
    state.accounts.push({ id: SAM_ID, storage_key: "sam", deleted_at: new Date(NOW - 60000).toISOString() });
    state.handles.push({ handle: "sam", account_id: SAM_ID, released_at: new Date(NOW - 60000).toISOString() });
    const plan = await dry();
    expect(plan.skipped.closedAccounts).toEqual(["sam"]);
    expect(plan.counts).toEqual({
      accounts: { create: 0, present: 1, conflict: 0 },
      handles: { create: 0, present: 0, conflict: 0 },
      credentials: { create: 0, present: 0, conflict: 0 },
    });
    calls.length = 0;
    expect(await (await post("good-token", { confirm: plan.planHash })).json())
      .toEqual({ applied: true, inserted: { accounts: 0, handles: 0, credentials: 0 } });
    expect(writes()).toEqual([]);
    expect(state.handles.filter((h) => !h.released_at)).toEqual([]);
  });

  it("an open account whose handle lapsed and was released plans no handle row", async () => {
    state.accounts.push({ id: SAM_ID, storage_key: "sam", deleted_at: null });
    state.handles.push({ handle: "sam", account_id: SAM_ID, released_at: new Date(NOW - 60000).toISOString() });
    state.credentials.push({ id: ID1, account_id: SAM_ID }, { id: ID2, account_id: SAM_ID });
    const plan = await dry();
    expect(plan.skipped.releasedHandles).toEqual([{ key: "sam", heldBy: null }]);
    expect(plan.handles).toEqual([]);
    expect(plan.counts.handles).toEqual({ create: 0, present: 0, conflict: 0 });
    calls.length = 0;
    expect(await (await post("good-token", { confirm: plan.planHash })).json())
      .toEqual({ applied: true, inserted: { accounts: 0, handles: 0, credentials: 0 } });
    expect(state.handles.filter((h) => !h.released_at)).toEqual([]);
  });
});
