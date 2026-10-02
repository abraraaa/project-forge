// Consent on the credentials doc: stamped only after a verified ceremony,
// preserved by both writers, and reported additively (version only) by
// /api/auth/check. The same record is mirrored onto the account row
// (dbSetAccountConsent) whenever the doc's consent changes. The routes read
// the account's credentials from the index (empty here) unioned with the doc.
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = { creds: null, writes: [], listed: [] };
vi.mock("@/lib/blob-utils", () => ({
  readJsonDirect: vi.fn(async () => null),
  readJsonByPrefix: vi.fn(async () => store.creds),
  deleteByPrefix: vi.fn(async () => 0), // not reached: stateless challenges
  writeJsonReplacingPrefix: vi.fn(async (_p, _path, value) => { store.writes.push(JSON.parse(JSON.stringify(value))); }),
}));
// Only register-verify's unreadable-doc guard lists directly.
vi.mock("@vercel/blob", () => ({ list: vi.fn(async () => ({ blobs: store.listed })), put: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => null, rateLimitShared: async () => null }));
vi.mock("@/lib/auth-server", async (importOriginal) => ({
  ...(await importOriginal()),
  hasChallengeSecret: () => true,
  verifyChallenge: () => true,
  verifyAuthToken: vi.fn(async () => ({ accountId: "hwa_" + "a".repeat(26) })),
  mintAuthToken: vi.fn(async () => "tok"), // the real one needs a DB
}));
// The account the handle resolves to; consent is mirrored onto it.
const A = "hwa_" + "a".repeat(26);
const acct = { row: null };
vi.mock("@/lib/identity-store", () => ({
  dbResolveHandle: vi.fn(async () => acct.row),
  dbListCredentials: vi.fn(async () => []),
  dbInsertCredential: vi.fn(async () => true),
  dbTouchCredential: vi.fn(async () => true),
  dbSetAccountConsent: vi.fn(async () => true),
  dbReclaimHandle: vi.fn(async () => ({ taken: false, accountId: B, storageKey: B, webauthnUserId: "r" })),
}));
const B = "hwa_" + "b".repeat(26);
vi.mock("@/lib/db", async (importOriginal) => ({ ...(await importOriginal()), dbRetirePhotos: vi.fn(async () => {}) }));
const reg = vi.fn();
const auth = vi.fn();
vi.mock("@simplewebauthn/server", () => ({
  verifyRegistrationResponse: (...a) => reg(...a),
  verifyAuthenticationResponse: (...a) => auth(...a),
}));

const { POST: registerVerify } = await import("@/app/api/auth/register-verify/route");
const { POST: loginVerify } = await import("@/app/api/auth/login-verify/route");
const { GET: check } = await import("@/app/api/auth/check/route");
const { CONSENT_VERSION } = await import("@/lib/consent");
const { verifyAuthToken } = await import("@/lib/auth-server");
const { dbRetirePhotos } = await import("@/lib/db");
const { writeJsonReplacingPrefix, deleteByPrefix } = await import("@/lib/blob-utils");
const { list, del } = await import("@vercel/blob");
const { dbSetAccountConsent, dbInsertCredential, dbTouchCredential, dbReclaimHandle } = await import("@/lib/identity-store");

const post = (url, body) => new Request(`http://localhost${url}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const CRED = { id: "c1", rawId: "c1", type: "public-key", response: {} };
const stored = (extra = {}) => ({
  credentials: [{ id: "c1", publicKey: "AQID", counter: 0, rpId: "heatwayve.app", transports: [] }],
  ...extra,
});
const ON_FILE = { version: CONSENT_VERSION, at: "2026-09-29T08:00:00.000Z" };
const claim = { version: CONSENT_VERSION };

beforeEach(() => {
  store.creds = null; store.writes = []; store.listed = [];
  acct.row = { id: A, storageKey: "sam", handle: "sam", webauthnUserId: "uid", roles: ["lifter"], plan: "free", consent: null };
  process.env.CHALLENGE_SECRET = "test-secret";
  vi.clearAllMocks();
  reg.mockReset(); auth.mockReset();
  reg.mockResolvedValue({
    verified: true,
    registrationInfo: { rpID: "heatwayve.app", credential: { id: "c2", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] } },
  });
  auth.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 0, rpID: "heatwayve.app" } });
});

describe("register-verify", () => {
  const register = (body) => registerVerify(post("/api/auth/register-verify", { profile: "Sam", credential: CRED, ...body }));

  it("stamps consent on a first registration", async () => {
    const res = await register({ consent: claim });
    expect(res.status).toBe(200);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].consent.version).toBe(CONSENT_VERSION);
    expect(Number.isNaN(Date.parse(store.writes[0].consent.at))).toBe(false);
    expect(store.writes[0].credentials.map((c) => c.id)).toEqual(["c2"]);
    // The account takes the very record the doc took.
    expect(dbSetAccountConsent.mock.calls).toEqual([[A, store.writes[0].consent]]);
  });

  it("preserves an existing consent (and every other key) when a second passkey is added without a claim", async () => {
    store.creds = stored({ consent: ON_FILE, note: "keep" });
    acct.row.consent = ON_FILE;
    const res = await register({ authToken: "t" });
    expect(res.status).toBe(200);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].consent).toEqual(ON_FILE);
    expect(store.writes[0].note).toBe("keep");
    expect(store.writes[0].credentials.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(dbSetAccountConsent).not.toHaveBeenCalled();
  });

  it("an account missing the doc's consent takes it on the next registration", async () => {
    store.creds = stored({ consent: ON_FILE });
    await register({ authToken: "t" });
    expect(store.writes[0].consent).toEqual(ON_FILE);
    expect(dbSetAccountConsent.mock.calls).toEqual([[A, ON_FILE]]);
  });

  it("the same version re-claimed keeps the original date", async () => {
    store.creds = stored({ consent: ON_FILE });
    acct.row.consent = ON_FILE;
    await register({ authToken: "t", consent: claim });
    expect(store.writes[0].consent).toEqual(ON_FILE);
    expect(dbSetAccountConsent).not.toHaveBeenCalled();
  });

  it("a new version replaces an older record in place", async () => {
    store.creds = stored({ consent: { version: "1999-01-01", at: "1999-01-01T00:00:00.000Z" } });
    acct.row.consent = { version: "1999-01-01", at: "1999-01-01T00:00:00.000Z" };
    await register({ authToken: "t", consent: claim });
    expect(store.writes[0].consent.version).toBe(CONSENT_VERSION);
    expect(JSON.stringify(store.writes[0])).not.toContain("1999-01-01");
    expect(dbSetAccountConsent.mock.calls).toEqual([[A, store.writes[0].consent]]);
  });

  it("ignores an unknown claim without failing the ceremony", async () => {
    for (const consent of [{ version: "1999-01-01" }, { version: 1 }, "yes"]) {
      store.writes = [];
      const res = await register({ consent });
      expect(res.status).toBe(200);
      expect(store.writes[0].consent).toBeUndefined();
    }
    expect(dbSetAccountConsent).not.toHaveBeenCalled();
  });

  it("never stamps without a verified attestation", async () => {
    reg.mockRejectedValue(new Error("bad"));
    expect((await register({ consent: claim })).status).toBe(400);
    expect(store.writes).toHaveLength(0);
    reg.mockResolvedValue({ verified: false });
    expect((await register({ consent: claim })).status).toBe(400);
    expect(store.writes).toHaveLength(0);
    expect(dbSetAccountConsent).not.toHaveBeenCalled();
    expect(dbInsertCredential).not.toHaveBeenCalled();
  });

  it("a reclaim does not inherit the previous holder's consent", async () => {
    const lapsed = () => ({
      credentials: [{ id: "old", publicKey: "AQID", rpId: "example.org" }],
      consent: { version: CONSENT_VERSION, at: "2026-01-01T00:00:00.000Z" },
    });
    const clientDataJSON = Buffer.from(JSON.stringify({ challenge: "ch" })).toString("base64url");
    const reclaim = (body) => register({ credential: { ...CRED, response: { clientDataJSON } }, ...body });
    store.creds = lapsed();
    acct.row.consent = lapsed().consent;
    expect((await reclaim({})).status).toBe(200);
    // The new account starts with no consent, and its mirror doc carries none.
    expect(dbReclaimHandle.mock.calls[0][0].consent).toBeUndefined();
    expect(store.writes[0].consent).toBeUndefined();
    expect(dbRetirePhotos).not.toHaveBeenCalled();
    // The previous account's record is left exactly as it is.
    expect(dbSetAccountConsent).not.toHaveBeenCalled();

    store.creds = lapsed(); store.writes = []; dbReclaimHandle.mockClear();
    await reclaim({ consent: claim });
    expect(store.writes[0].consent.version).toBe(CONSENT_VERSION);
    expect(store.writes[0].consent.at).not.toBe("2026-01-01T00:00:00.000Z");
    expect(dbReclaimHandle.mock.calls[0][0].consent).toEqual(store.writes[0].consent);
    expect(dbSetAccountConsent).not.toHaveBeenCalled();
  });

  it("the anti-stuffing gate holds with a claim in the body", async () => {
    store.creds = stored();
    verifyAuthToken.mockResolvedValueOnce(null);
    const res = await register({ authToken: "bad", consent: claim });
    expect(res.status).toBe(401);
    // A valid token for another account is no better.
    verifyAuthToken.mockResolvedValueOnce({ accountId: B });
    expect((await register({ authToken: "other", consent: claim })).status).toBe(401);
    expect(store.writes).toHaveLength(0);
    expect(reg).not.toHaveBeenCalled();
    expect(dbSetAccountConsent).not.toHaveBeenCalled();
    expect(dbInsertCredential).not.toHaveBeenCalled();
  });

  it("fails closed when a credentials doc exists but won't read", async () => {
    store.listed = [{ pathname: "forge/profiles/sam/credentials-x.json" }];
    let res = await register({ consent: claim });
    expect(res.status).toBe(503);
    // The guard protects the doc: it never "cleans up" an unreadable blob.
    expect(deleteByPrefix).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(store.writes).toHaveLength(0);
    expect(reg).not.toHaveBeenCalled();

    expect(dbInsertCredential).not.toHaveBeenCalled();
    expect(dbSetAccountConsent).not.toHaveBeenCalled();

    list.mockRejectedValueOnce(new Error("blob"));
    res = await register({ consent: claim });
    expect(res.status).toBe(503);
    expect(deleteByPrefix).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(store.writes).toHaveLength(0);

    // A truly new profile still registers.
    store.listed = [];
    expect((await register({ consent: claim })).status).toBe(200);
    expect(store.writes).toHaveLength(1);
  });

  it("an account-row failure never fails the registration or changes the doc", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await register({ consent: claim });
      dbSetAccountConsent.mockRejectedValueOnce(new Error("neon"));
      expect((await register({ consent: claim })).status).toBe(200);
      expect(store.writes).toHaveLength(2);
      expect(store.writes[1]).toEqual(store.writes[0]);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("login-verify", () => {
  const login = (body) => loginVerify(post("/api/auth/login-verify", { profile: "Sam", credential: { ...CRED }, ...body }));

  it("stamps consent when the body carries it", async () => {
    store.creds = stored();
    const res = await login({ consent: claim });
    expect(res.status).toBe(200);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].consent.version).toBe(CONSENT_VERSION);
    expect(store.writes[0].credentials).toEqual(stored().credentials);
    expect((await res.json()).consentRecorded).toBe(true);
    expect(dbSetAccountConsent.mock.calls).toEqual([[A, store.writes[0].consent]]);
    expect(dbTouchCredential).toHaveBeenCalledWith(A, "c1", { counter: 0, rpId: "heatwayve.app" });
  });

  it("preserves an existing consent (and every other key) on the counter-update path", async () => {
    store.creds = stored({ consent: ON_FILE, note: "keep" });
    auth.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 5, rpID: "heatwayve.app" } });
    const res = await login({});
    expect(res.status).toBe(200);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].consent).toEqual(ON_FILE);
    expect(store.writes[0].note).toBe("keep");
    expect(store.writes[0].credentials[0].counter).toBe(5);
    expect(await res.json()).not.toHaveProperty("consentRecorded");
    // Nothing stamped on this sign-in: the account row is left as it is.
    expect(dbSetAccountConsent).not.toHaveBeenCalled();
  });

  it("already recorded at this version: no doc write, still reported, no account write", async () => {
    store.creds = stored({ consent: ON_FILE });
    const res = await login({ consent: claim });
    expect(store.writes).toHaveLength(0);
    expect((await res.json()).consentRecorded).toBe(true);
    expect(dbSetAccountConsent).not.toHaveBeenCalled();
  });

  it("an account already holding the doc's record is not rewritten", async () => {
    store.creds = stored({ consent: ON_FILE });
    acct.row = { ...acct.row, consent: { at: ON_FILE.at, version: ON_FILE.version } };
    const res = await login({ consent: claim });
    expect(res.status).toBe(200);
    expect(store.writes).toHaveLength(0);
    expect(dbSetAccountConsent).not.toHaveBeenCalled();
  });

  it("a failed stamp writes no consent to the account", async () => {
    store.creds = stored({ consent: { version: "1999-01-01", at: "1999-01-01T00:00:00.000Z" } });
    writeJsonReplacingPrefix.mockRejectedValueOnce(new Error("blob"));
    const res = await login({ consent: claim });
    expect(res.status).toBe(200);
    expect((await res.json()).consentRecorded).toBe(false);
    expect(dbSetAccountConsent).not.toHaveBeenCalled();
  });

  it("a new version replaces an older record on sign-in", async () => {
    store.creds = stored({ consent: { version: "1999-01-01", at: "1999-01-01T00:00:00.000Z" } });
    const res = await login({ consent: claim });
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].consent.version).toBe(CONSENT_VERSION);
    expect(JSON.stringify(store.writes[0])).not.toContain("1999-01-01");
    expect((await res.json()).consentRecorded).toBe(true);
    expect(dbSetAccountConsent.mock.calls).toEqual([[A, store.writes[0].consent]]);
  });

  it("ignores an unknown claim", async () => {
    store.creds = stored();
    const res = await login({ consent: { version: "1999-01-01" } });
    expect(res.status).toBe(200);
    expect(store.writes).toHaveLength(0);
    expect(await res.json()).not.toHaveProperty("consentRecorded");
    expect(dbSetAccountConsent).not.toHaveBeenCalled();
  });

  it("never stamps without a verified assertion", async () => {
    store.creds = stored();
    auth.mockRejectedValue(new Error("x"));
    expect((await login({ consent: claim })).status).toBe(401);
    auth.mockResolvedValue({ verified: false });
    expect((await login({ consent: claim })).status).toBe(401);
    expect(store.writes).toHaveLength(0);
    expect(dbSetAccountConsent).not.toHaveBeenCalled();
    expect(dbTouchCredential).not.toHaveBeenCalled();
  });

  it("a keyless credential with a claim is refused before any ceremony", async () => {
    store.creds = { credentials: [{ id: "c1", counter: 0 }] };
    const res = await login({ consent: claim });
    expect(res.status).toBe(401);
    expect((await res.json()).needsReregister).toBe(true);
    expect(store.writes).toHaveLength(0);
    expect(auth).not.toHaveBeenCalled();
    expect(dbTouchCredential).not.toHaveBeenCalled();
  });

  it("a failed write never denies the login", async () => {
    store.creds = stored();
    writeJsonReplacingPrefix.mockRejectedValueOnce(new Error("blob"));
    const res = await login({ consent: claim });
    expect(res.status).toBe(200);
    expect((await res.json()).consentRecorded).toBe(false);
    // The account never claims what the doc failed to record.
    expect(dbSetAccountConsent).not.toHaveBeenCalled();
  });

  it("an index failure never denies the login", async () => {
    store.creds = stored();
    dbTouchCredential.mockRejectedValueOnce(new Error("neon"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await login({ consent: claim });
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect((await res.json()).consentRecorded).toBe(true);
    expect(store.writes).toHaveLength(1);
  });
});

describe("/api/auth/check", () => {
  const read = async () => (await check(new Request("http://localhost/api/auth/check?profile=Sam"))).json();

  it("returns the consent version alongside the existing keys, never when it was given", async () => {
    store.creds = stored({ consent: ON_FILE });
    const body = await read();
    expect(body).toEqual({ hasPasskey: true, credentialCount: 1, consent: { version: CONSENT_VERSION } });
    expect(JSON.stringify(body)).not.toContain(ON_FILE.at);
  });

  it("no account holding the name reads as no passkey", async () => {
    store.creds = stored({ consent: ON_FILE });
    acct.row = null;
    expect(await read()).toEqual({ hasPasskey: false, credentialCount: 0, consent: null });
  });

  it("null when none, no doc, malformed, or no usable passkey", async () => {
    store.creds = stored();
    expect((await read()).consent).toBeNull();
    store.creds = null;
    expect(await read()).toEqual({ hasPasskey: false, credentialCount: 0, consent: null });
    store.creds = stored({ consent: { version: 5 } });
    expect((await read()).consent).toBeNull();
    store.creds = {
      credentials: [{ id: "old", publicKey: "AQID", rpId: "example.org" }],
      consent: { version: CONSENT_VERSION, at: "2026-01-01T00:00:00.000Z" },
    };
    expect(await read()).toEqual({ hasPasskey: false, credentialCount: 0, consent: null });
  });
});
