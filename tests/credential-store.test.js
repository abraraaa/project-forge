// Credential index dual-write: every verified registration INSERTs the
// credential under the account holding the name, every verified sign-in
// touches its row, and consent lands on the account — all beside the Blob
// credentials doc, whose write is unchanged. Reads come from the index,
// unioned with the doc while the fallback is on.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

// In-memory Neon: just enough of accounts / handles / credentials for the
// real lib/identity-store.js statements.
const db = { accounts: [], handles: [], credentials: [], log: [] };
vi.mock("@neondatabase/serverless", () => ({
  // Statements run as they are built; a transaction just awaits them.
  neon: () => Object.assign(async (strings, ...values) => {
    const q = strings.join("?");
    if (/^\s*(CREATE|ALTER)\b/.test(q)) return [];
    db.log.push({ q, values });
    if (/FROM handles h JOIN accounts a/.test(q)) {
      const h = db.handles.find((x) => x.handle === values[0] && !x.released_at);
      const a = h && db.accounts.find((x) => x.id === h.account_id && !x.deleted_at);
      return a ? [{ ...a, handle: h.handle, display: h.display, kind: "primary", claimed_at: null, hold_until: null }] : [];
    }
    if (/^\s*INSERT INTO credentials\b/.test(q)) {
      const [id, account_id, public_key, counter, transports, rp_id, user_handle, source, created_at] = values;
      if (db.credentials.some((c) => c.id === id)) return [];
      db.credentials.push({ id, account_id, public_key, counter, transports: JSON.parse(transports), rp_id, user_handle, source, created_at, last_used_at: null });
      return [{ id }];
    }
    if (/SELECT account_id FROM credentials/.test(q)) {
      return db.credentials.filter((c) => c.id === values[0]).map((c) => ({ account_id: c.account_id }));
    }
    if (/^\s*UPDATE credentials\b/.test(q)) {
      const [counter, rpId, id, accountId] = values;
      const c = db.credentials.find((x) => x.id === id && x.account_id === accountId);
      if (!c) return [];
      if (counter != null) c.counter = counter;
      if (rpId != null) c.rp_id = rpId;
      c.last_used_at = new Date().toISOString();
      return [{ id }];
    }
    if (/^\s*UPDATE accounts SET consent\b/.test(q)) {
      const a = db.accounts.find((x) => x.id === values[1]);
      if (!a) return [];
      a.consent = values[0] == null ? null : JSON.parse(values[0]);
      return [{ id: a.id }];
    }
    return [];
  }, { transaction: async (qs) => Promise.all(qs) }),
}));

const blob = { doc: null, writes: [] };
vi.mock("@/lib/blob-utils", () => ({
  readJsonDirect: vi.fn(async () => null),
  readJsonByPrefix: vi.fn(async () => (blob.doc ? JSON.parse(JSON.stringify(blob.doc)) : null)),
  deleteByPrefix: vi.fn(async () => 0),
  writeJsonReplacingPrefix: vi.fn(async (prefix, path, value) => { blob.writes.push([prefix, path, JSON.parse(JSON.stringify(value))]); }),
}));
vi.mock("@vercel/blob", () => ({ list: vi.fn(async () => ({ blobs: [] })), put: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => null, rateLimitShared: async () => null }));
vi.mock("@/lib/auth-server", async (importOriginal) => ({
  ...(await importOriginal()),
  hasChallengeSecret: () => true,
  verifyChallenge: () => true,
  verifyAuthToken: vi.fn(async () => ({ accountId: "hwa_" + "a".repeat(26), storageKey: "sam" })),
  mintAuthToken: vi.fn(async () => "tok"),
}));
vi.mock("@/lib/db", async (importOriginal) => ({ ...(await importOriginal()), dbRetirePhotos: vi.fn(async () => {}) }));
const reg = vi.fn();
const auth = vi.fn();
vi.mock("@simplewebauthn/server", () => ({
  verifyRegistrationResponse: (...a) => reg(...a),
  verifyAuthenticationResponse: (...a) => auth(...a),
}));

const { POST: registerVerify } = await import("@/app/api/auth/register-verify/route");
const { POST: loginVerify } = await import("@/app/api/auth/login-verify/route");
const { CONSENT_VERSION } = await import("@/lib/consent");
const { mirrorAccountConsent } = await import("@/lib/credential-store");
const { writeJsonReplacingPrefix } = await import("@/lib/blob-utils");

const root = resolve(__dirname, "..");
const A = "hwa_" + "a".repeat(26);
const B = "hwa_" + "b".repeat(26);
const NOW = new Date("2026-10-01T12:00:00.000Z");
const claim = { version: CONSENT_VERSION };
const ON_FILE = { version: CONSENT_VERSION, at: "2026-09-29T08:00:00.000Z" };

const post = (url, body) => new Request(`http://localhost${url}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const register = (body = {}) => registerVerify(post("/api/auth/register-verify", {
  profile: "Sam", credential: { id: "c2", rawId: "c2", type: "public-key", response: {} }, ...body,
}));
const login = (body = {}) => loginVerify(post("/api/auth/login-verify", {
  profile: "Sam", credential: { id: "c1", rawId: "c1", type: "public-key", response: {} }, ...body,
}));
const stored = (extra = {}) => ({ credentials: [{ id: "c1", publicKey: "AQID", counter: 0, rpId: "heatwayve.app", transports: [] }], ...extra });
const statements = (re) => db.log.filter((l) => re.test(l.q));

function seed({ consent = null } = {}) {
  db.accounts = [{ id: A, storage_key: "sam", webauthn_user_id: "uid", roles: ["lifter"], plan: "free", consent, origin: "backfill", created_at: null, lapsed_at: null, deleted_at: null }];
  db.handles = [{ handle: "sam", account_id: A, display: "Sam", released_at: null }];
}

beforeEach(() => {
  process.env.DATABASE_URL = "postgres://fake";
  db.accounts = []; db.handles = []; db.credentials = []; db.log = [];
  blob.doc = null; blob.writes = [];
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  reg.mockReset(); auth.mockReset();
  // Verified on the legacy rpId: the row must carry what the library matched.
  reg.mockResolvedValue({
    verified: true,
    registrationInfo: { rpID: "theforged.fit", credential: { id: "c2", publicKey: new Uint8Array([1, 2, 3]), counter: 3, transports: ["internal"] } },
  });
  auth.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 0, rpID: "heatwayve.app" } });
  seed();
});
afterEach(() => { vi.useRealTimers(); delete process.env.DATABASE_URL; });

describe("registration indexes the credential beside the doc", () => {
  it("one credentials row on the account the handle resolves to, as verified", async () => {
    expect((await register()).status).toBe(200);
    expect(db.credentials).toEqual([{
      id: "c2", account_id: A, public_key: "AQID", counter: 3, transports: ["internal"],
      rp_id: "theforged.fit", user_handle: "uid", source: "register",
      created_at: NOW.toISOString(), last_used_at: null,
    }]);
    // The user.id register-options baked into the passkey: the account's own.
    expect(db.credentials[0].user_handle).toBe(db.accounts[0].webauthn_user_id);
    // Resolved through the live handle, normalised before SQL.
    expect(statements(/FROM handles h JOIN accounts a/)[0].values[0]).toBe("sam");
    // The doc and the row agree on every shared field.
    const docCred = blob.writes[0][2].credentials.find((c) => c.id === "c2");
    expect(docCred).toMatchObject({ publicKey: db.credentials[0].public_key, rpId: db.credentials[0].rp_id, createdAt: db.credentials[0].created_at });
  });

  it("the Blob write is today's doc at today's path; with no DB nothing resolves and nothing is written", async () => {
    blob.doc = stored({ consent: ON_FILE, note: "keep" });
    seed({ consent: ON_FILE });
    expect((await register({ authToken: "t", consent: claim })).status).toBe(200);
    expect(writeJsonReplacingPrefix).toHaveBeenCalledTimes(1);
    const [prefix, path, doc] = writeJsonReplacingPrefix.mock.calls[0];
    expect([prefix, path]).toEqual(["forge/profiles/sam/credentials", "forge/profiles/sam/credentials.json"]);
    expect(doc).toEqual({
      credentials: [
        { id: "c1", publicKey: "AQID", counter: 0, rpId: "heatwayve.app", transports: [] },
        { id: "c2", publicKey: "AQID", counter: 3, transports: ["internal"], createdAt: NOW.toISOString(), rpId: "theforged.fit" },
      ],
      consent: ON_FILE,
      note: "keep",
    });

    vi.clearAllMocks();
    delete process.env.DATABASE_URL;
    db.log = [];
    expect((await register({ authToken: "t", consent: claim })).status).toBe(404);
    expect(writeJsonReplacingPrefix).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
  });

  it("re-registering the same credential inserts nothing new", async () => {
    expect((await register()).status).toBe(200);
    expect((await register({ authToken: "t" })).status).toBe(200);
    expect(db.credentials).toHaveLength(1);
    expect(db.credentials[0].account_id).toBe(A);
  });

  it("an id indexed to another account fails the ceremony: 400, nothing written, no token", async () => {
    db.credentials.push({ id: "c2", account_id: B, public_key: "x", counter: 0, transports: [], rp_id: "heatwayve.app", user_handle: "u", source: "backfill", created_at: null, last_used_at: null });
    const before = JSON.parse(JSON.stringify(db.credentials));
    const res = await register({ consent: claim });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Registration could not be verified" });
    expect(db.credentials).toEqual(before);
    expect(statements(/^\s*(INSERT|UPDATE|DELETE)\b/)).toEqual([]);
    expect(blob.writes).toEqual([]);
    expect(writeJsonReplacingPrefix).not.toHaveBeenCalled();
    const { mintAuthToken } = await import("@/lib/auth-server");
    expect(mintAuthToken).not.toHaveBeenCalled();
  });

  it("the same id already on this account still registers (idempotent)", async () => {
    db.credentials.push({ id: "c2", account_id: A, public_key: "x", counter: 0, transports: [], rp_id: "heatwayve.app", user_handle: "uid", source: "register", created_at: null, last_used_at: null });
    expect((await register({ authToken: "t" })).status).toBe(200);
    expect(db.credentials).toHaveLength(1);
    expect(statements(/INSERT INTO credentials/)).toHaveLength(1);
  });

  it("no live account for the name: 404, and nothing is written anywhere", async () => {
    db.handles = [];
    expect((await register({ consent: claim })).status).toBe(404);
    expect(db.credentials).toEqual([]);
    expect(statements(/^\s*(INSERT|UPDATE|DELETE)\b/)).toEqual([]);
    expect(blob.writes).toEqual([]);
  });

  it("nothing is written before the attestation verifies (reads only)", async () => {
    reg.mockRejectedValue(new Error("bad"));
    expect((await register({ consent: claim })).status).toBe(400);
    expect(db.log.length).toBeGreaterThan(0);
    expect(db.log.every((l) => /^\s*SELECT\b/.test(l.q))).toBe(true);
    expect(blob.writes).toEqual([]);
  });
});

describe("consent lands on the account", () => {
  it("a registration claim is stamped on accounts.consent, the same record as the doc", async () => {
    await register({ consent: claim });
    expect(db.accounts[0].consent).toEqual(blob.writes[0][2].consent);
    expect(db.accounts[0].consent).toEqual({ version: CONSENT_VERSION, at: NOW.toISOString() });
  });

  it("the same record already on the account is not rewritten", async () => {
    seed({ consent: ON_FILE });
    blob.doc = stored({ consent: ON_FILE });
    await register({ authToken: "t", consent: claim });
    expect(statements(/UPDATE accounts/)).toEqual([]);
    expect(db.accounts[0].consent).toEqual(ON_FILE);
  });

  it("a reclaim leaves the previous holder's consent alone and carries none of it to the new account", async () => {
    process.env.CHALLENGE_SECRET = "s";
    try {
      seed({ consent: ON_FILE });
      blob.doc = { credentials: [{ id: "old", publicKey: "AQID", rpId: "example.org" }], consent: ON_FILE };
      const clientDataJSON = Buffer.from(JSON.stringify({ challenge: "ch" })).toString("base64url");
      expect((await register({ credential: { id: "c2", rawId: "c2", type: "public-key", response: { clientDataJSON } } })).status).toBe(200);
      expect(db.accounts[0].consent).toEqual(ON_FILE);
      expect(statements(/^\s*UPDATE accounts\b/)).toEqual([]);
      const [made] = statements(/^\s*INSERT INTO accounts\b/);
      expect(made.values[3]).toBeNull();
      // The mirror is the new account's own doc, with no consent on it.
      expect(blob.writes).toHaveLength(1);
      expect(blob.writes[0][0]).toBe(`forge/profiles/${made.values[0]}/credentials`);
      expect(blob.writes[0][2].consent).toBeUndefined();
    } finally {
      delete process.env.CHALLENGE_SECRET;
    }
  });

  it("a sign-in claim is stamped on accounts.consent, the same record as the doc", async () => {
    blob.doc = stored();
    const res = await login({ consent: claim });
    expect((await res.json()).consentRecorded).toBe(true);
    expect(db.accounts[0].consent).toEqual(blob.writes[0][2].consent);
  });

  it("a sign-in whose doc write failed stamps nothing on the account", async () => {
    blob.doc = stored();
    writeJsonReplacingPrefix.mockRejectedValueOnce(new Error("blob"));
    const res = await login({ consent: claim });
    expect((await res.json()).consentRecorded).toBe(false);
    expect(statements(/UPDATE accounts/)).toEqual([]);
  });

  it("a sign-in that stamps nothing leaves accounts.consent alone, even when the doc holds a record", async () => {
    blob.doc = stored({ consent: ON_FILE });
    const res = await login({ consent: claim });
    expect((await res.json()).consentRecorded).toBe(true);
    expect(blob.writes).toEqual([]);
    expect(statements(/UPDATE accounts/)).toEqual([]);
    expect(db.accounts[0].consent ?? null).toBeNull();
  });

  it("only a changed value ever writes; null and undefined never clear the account's consent", async () => {
    const acct = { id: A, consent: ON_FILE };
    expect(await mirrorAccountConsent(acct, null)).toBe(false);
    expect(await mirrorAccountConsent(acct, undefined)).toBe(false);
    // jsonb returns keys in its own order: still the same record.
    expect(await mirrorAccountConsent({ id: A, consent: { at: ON_FILE.at, version: ON_FILE.version } }, ON_FILE)).toBe(false);
    expect(statements(/UPDATE accounts/)).toEqual([]);
  });
});

describe("sign-in touches the index row", () => {
  beforeEach(async () => {
    await register();
    db.log = [];
    blob.doc = { credentials: [blob.writes[0][2].credentials[0]] };
    blob.writes = [];
  });
  const loginC2 = (body = {}) => login({ credential: { id: "c2", rawId: "c2", type: "public-key", response: {} }, ...body });

  it("updates counter, rp_id and last_used_at, and never inserts", async () => {
    auth.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 9, rpID: "heatwayve.app" } });
    vi.setSystemTime(new Date("2026-10-02T07:00:00.000Z"));
    expect((await loginC2()).status).toBe(200);
    expect(db.credentials).toHaveLength(1);
    expect(db.credentials[0]).toMatchObject({ account_id: A, counter: 9, rp_id: "heatwayve.app", last_used_at: "2026-10-02T07:00:00.000Z" });
    expect(statements(/INSERT INTO credentials/)).toEqual([]);
    expect(statements(/^\s*UPDATE credentials/)[0].values).toEqual([9, "heatwayve.app", "c2", A]);
  });

  it("every success advances last_used_at, even when the doc is not rewritten", async () => {
    auth.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 3, rpID: "theforged.fit" } });
    await loginC2();
    expect(blob.writes).toEqual([]); // counter and rpId unchanged: today's condition skips the doc
    expect(db.credentials[0].last_used_at).toBe(NOW.toISOString());
    await loginC2();
    expect(statements(/^\s*UPDATE credentials/)).toHaveLength(2);
    expect(db.credentials).toHaveLength(1);
  });

  it("a credential the index does not hold is left alone", async () => {
    blob.doc = stored();
    expect((await login()).status).toBe(200);
    expect(statements(/INSERT INTO credentials/)).toEqual([]);
    expect(db.credentials.map((c) => c.id)).toEqual(["c2"]);
  });

  it("an index failure never denies the login", async () => {
    const q = db.credentials;
    db.credentials = null; // the fake throws on any credentials statement
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await loginC2();
    expect(res.status).toBe(200);
    expect((await res.json()).verified).toBe(true);
    spy.mockRestore();
    db.credentials = q;
  });

  it("a failed assertion writes nothing (reads only)", async () => {
    auth.mockRejectedValue(new Error("x"));
    expect((await loginC2()).status).toBe(401);
    expect(db.log.every((l) => /^\s*SELECT\b/.test(l.q))).toBe(true);
    expect(blob.writes).toEqual([]);
  });
});

describe("the store is the one door to the index", () => {
  const read = (rel) => readFileSync(resolve(root, rel), "utf8");
  const code = (rel) => read(rel).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");

  it("credential-store deletes nothing", () => {
    expect(code("lib/credential-store.js")).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b|\bdel\(|deleteByPrefix|removeItem|deleted_at/);
    // Blob is read here, never written: exactly these two read imports.
    const imports = code("lib/credential-store.js").split("\n").filter((l) => /@vercel\/blob|blob-utils/.test(l));
    expect(imports).toEqual(['import { list } from "@vercel/blob";', 'import { readJsonByPrefix } from "./blob-utils.js";']);
    expect(code("lib/credential-store.js")).not.toMatch(/\bput\(|writeJsonReplacingPrefix|deleteByPrefix/);
  });

  it("no route or lib module but the store calls the credential index functions", () => {
    const walk = (d) => readdirSync(resolve(root, d)).flatMap((e) => {
      const p = join(d, e);
      return statSync(resolve(root, p)).isDirectory() ? walk(p) : /\.(js|jsx)$/.test(e) ? [p] : [];
    });
    const hits = [...walk("app"), ...walk("lib"), ...walk("components")]
      .filter((f) => !["lib/identity-store.js", "lib/credential-store.js"].includes(f))
      .filter((f) => /\bdb(InsertCredential|TouchCredential|ListCredentials)\b/.test(read(f)));
    expect(hits).toEqual([]);
  });

  it("both verify routes index through the store, ordered by what sign-in reads", () => {
    // Sign-in: after the doc mirror, inside a catch.
    const lv = read("app/api/auth/login-verify/route.js");
    const call = lv.indexOf("await indexSignIn(");
    expect(call).toBeGreaterThan(lv.indexOf("await writeJsonReplacingPrefix("));
    expect(lv.slice(call - 20, call)).toMatch(/try \{\s*$/);
    // Registration: with the fallback on, the doc first and the index inside a
    // catch; with it off, the index first and uncaught, the mirror after.
    const rv = read("app/api/auth/register-verify/route.js");
    expect(rv).toContain("const index = () => indexRegistration(");
    const branch = rv.indexOf("if (IDENTITY_BLOB_FALLBACK) {");
    const split = rv.indexOf("} else {", branch);
    const on = rv.slice(branch, split);
    const off = rv.slice(split, rv.indexOf("// Consume the challenge", split));
    expect(on.indexOf("await writeMirror();")).toBeGreaterThan(-1);
    expect(on.indexOf("await writeMirror();")).toBeLessThan(on.indexOf("try { await index(); }"));
    expect(off).toMatch(/^\} else \{[\s\S]*?\n\s+await index\(\);/);
    expect(off.indexOf("await index();")).toBeLessThan(off.indexOf("await writeMirror();"));
  });
});
