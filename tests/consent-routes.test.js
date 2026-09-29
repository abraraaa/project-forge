// Consent on the credentials doc: stamped only after a verified ceremony,
// preserved by both writers, and reported additively (version only) by
// /api/auth/check.
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
  verifyAuthToken: vi.fn(async () => true),
  mintAuthToken: vi.fn(async () => "tok"), // the real one needs a DB
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
const { GET: check } = await import("@/app/api/auth/check/route");
const { CONSENT_VERSION } = await import("@/lib/consent");
const { verifyAuthToken } = await import("@/lib/auth-server");
const { dbRetirePhotos } = await import("@/lib/db");
const { writeJsonReplacingPrefix, deleteByPrefix } = await import("@/lib/blob-utils");
const { list, del } = await import("@vercel/blob");

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
  });

  it("preserves an existing consent (and every other key) when a second passkey is added without a claim", async () => {
    store.creds = stored({ consent: ON_FILE, note: "keep" });
    const res = await register({ authToken: "t" });
    expect(res.status).toBe(200);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].consent).toEqual(ON_FILE);
    expect(store.writes[0].note).toBe("keep");
    expect(store.writes[0].credentials.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("the same version re-claimed keeps the original date", async () => {
    store.creds = stored({ consent: ON_FILE });
    await register({ authToken: "t", consent: claim });
    expect(store.writes[0].consent).toEqual(ON_FILE);
  });

  it("a new version replaces an older record in place", async () => {
    store.creds = stored({ consent: { version: "1999-01-01", at: "1999-01-01T00:00:00.000Z" } });
    await register({ authToken: "t", consent: claim });
    expect(store.writes[0].consent.version).toBe(CONSENT_VERSION);
    expect(JSON.stringify(store.writes[0])).not.toContain("1999-01-01");
  });

  it("ignores an unknown claim without failing the ceremony", async () => {
    for (const consent of [{ version: "1999-01-01" }, { version: 1 }, "yes"]) {
      store.writes = [];
      const res = await register({ consent });
      expect(res.status).toBe(200);
      expect(store.writes[0].consent).toBeUndefined();
    }
  });

  it("never stamps without a verified attestation", async () => {
    reg.mockRejectedValue(new Error("bad"));
    expect((await register({ consent: claim })).status).toBe(400);
    expect(store.writes).toHaveLength(0);
    reg.mockResolvedValue({ verified: false });
    expect((await register({ consent: claim })).status).toBe(400);
    expect(store.writes).toHaveLength(0);
  });

  it("a reclaim does not inherit the previous holder's consent", async () => {
    const lapsed = () => ({
      credentials: [{ id: "old", publicKey: "AQID", rpId: "example.org" }],
      consent: { version: CONSENT_VERSION, at: "2026-01-01T00:00:00.000Z" },
    });
    store.creds = lapsed();
    expect((await register({})).status).toBe(200);
    expect(store.writes[0].consent).toBeUndefined();
    expect(dbRetirePhotos).toHaveBeenCalled();

    store.creds = lapsed(); store.writes = [];
    await register({ consent: claim });
    expect(store.writes[0].consent.version).toBe(CONSENT_VERSION);
    expect(store.writes[0].consent.at).not.toBe("2026-01-01T00:00:00.000Z");
  });

  it("the anti-stuffing gate holds with a claim in the body", async () => {
    store.creds = stored();
    verifyAuthToken.mockResolvedValueOnce(false);
    const res = await register({ authToken: "bad", consent: claim });
    expect(res.status).toBe(401);
    expect(store.writes).toHaveLength(0);
    expect(reg).not.toHaveBeenCalled();
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
  });

  it("already recorded at this version: no write, still reported", async () => {
    store.creds = stored({ consent: ON_FILE });
    const res = await login({ consent: claim });
    expect(store.writes).toHaveLength(0);
    expect((await res.json()).consentRecorded).toBe(true);
  });

  it("a new version replaces an older record on sign-in", async () => {
    store.creds = stored({ consent: { version: "1999-01-01", at: "1999-01-01T00:00:00.000Z" } });
    const res = await login({ consent: claim });
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].consent.version).toBe(CONSENT_VERSION);
    expect(JSON.stringify(store.writes[0])).not.toContain("1999-01-01");
    expect((await res.json()).consentRecorded).toBe(true);
  });

  it("ignores an unknown claim", async () => {
    store.creds = stored();
    const res = await login({ consent: { version: "1999-01-01" } });
    expect(res.status).toBe(200);
    expect(store.writes).toHaveLength(0);
    expect(await res.json()).not.toHaveProperty("consentRecorded");
  });

  it("never stamps without a verified assertion", async () => {
    store.creds = stored();
    auth.mockRejectedValue(new Error("x"));
    expect((await login({ consent: claim })).status).toBe(401);
    auth.mockResolvedValue({ verified: false });
    expect((await login({ consent: claim })).status).toBe(401);
    expect(store.writes).toHaveLength(0);
  });

  it("a keyless credential with a claim is refused before any ceremony", async () => {
    store.creds = { credentials: [{ id: "c1", counter: 0 }] };
    const res = await login({ consent: claim });
    expect(res.status).toBe(401);
    expect((await res.json()).needsReregister).toBe(true);
    expect(store.writes).toHaveLength(0);
    expect(auth).not.toHaveBeenCalled();
  });

  it("a failed write never denies the login", async () => {
    store.creds = stored();
    writeJsonReplacingPrefix.mockRejectedValueOnce(new Error("blob"));
    const res = await login({ consent: claim });
    expect(res.status).toBe(200);
    expect((await res.json()).consentRecorded).toBe(false);
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
