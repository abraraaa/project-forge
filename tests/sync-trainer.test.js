// The client's trainer share: status, access log and stop (/api/sync/trainer).
// The Neon driver is faked with small in-memory tables, so dbClientShare, the
// Neon OAuth store and revokeGrantFor run for real and every statement is
// captured. Sign-in is faked at readTokenData / resolveTokenIdentity.
// The only writes allowed: the client's stop, an UPDATE of revoked_at,
// "Got it" on the ended notice, an UPDATE of notice_seen_at, and on the
// caller's own application to coach, the seen and withdraw UPDATEs.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DAY = 86400000;
const NOW = Date.now();
const id26 = (c) => "hwa_" + c.repeat(26);
const A = id26("a"); // the client, "abe"
const B = id26("b"); // another client, "bea"
const T = id26("t"); // trainer "tia"
const N = id26("n"); // trainer "nia"

const db = { accounts: new Map(), handles: [], credentials: [], grants: [], applications: new Map() };
const calls = [];

// Mirrors dbClientShare's SELECT: the newest trainer grant (live first), the
// client-side join, the trainer's account, and the trainer's newest primary handle.
function clientShareRow(clientId) {
  const g = db.grants
    .filter((x) => x.account_id === clientId && x.kind === "trainer")
    .sort((x, y) => (y.revoked_at == null) - (x.revoked_at == null) || Number(y.created_at) - Number(x.created_at))[0];
  if (!g) return [];
  const a = db.accounts.get(g.account_id);
  const t = db.accounts.get(g.trainer_account_id);
  const h = db.handles
    .filter((x) => x.account_id === g.trainer_account_id && x.kind === "primary")
    .sort((x, y) => (x.released_at == null ? -1 : y.released_at == null ? 1 : y.released_at - x.released_at))[0];
  return [{
    ...g, // every column of the row, as Postgres would hand back the selected ones and more
    client_live: !!a && a.deleted_at == null
      && db.credentials.some((c) => c.id === g.credential_id && c.account_id === a.id && c.rp_id === "heatwayve.app"),
    trainer_roles: t?.roles ?? null, trainer_plan: t?.plan ?? null, trainer_terms: t?.trainer_terms ?? null,
    trainer_deleted_at: t?.deleted_at ?? null, handle: h?.handle ?? null, display: h?.display ?? null,
  }];
}

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    const q = async (strings, ...v) => {
      const text = strings.join("?");
      if (/^\s*(CREATE|ALTER)\b/.test(text)) return [];
      calls.push({ q: text, v });
      if (/^SELECT g\.id, g\.created_at, g\.revoked_at, g\.revoked_by, g\.consent_version, g\.looks, g\.look_count, g\.notice_seen_at,/.test(text)) {
        return clientShareRow(v[0]);
      }
      const flat = text.replace(/\s+/g, " ").trim();
      if (flat === "SELECT status, about, link, terms, applied_at, decided_at, seen_at, created_at FROM trainer_applications WHERE account_id = ?") {
        const r = db.applications.get(v[0]);
        // BIGINT columns come back as strings, as from Neon.
        return r ? [Object.fromEntries(Object.entries(r).map(([k, x]) => [k, typeof x === "number" ? String(x) : x]))] : [];
      }
      if (flat === "UPDATE trainer_applications SET seen_at = ? WHERE account_id = ? AND status IN ('approved', 'denied') AND seen_at IS NULL RETURNING account_id") {
        const r = db.applications.get(v[1]);
        if (!r || !["approved", "denied"].includes(r.status) || r.seen_at != null) return [];
        r.seen_at = v[0];
        return [{ account_id: v[1] }];
      }
      if (flat === "UPDATE trainer_applications SET status = 'withdrawn', decided_at = ? WHERE account_id = ? AND status = 'applied' RETURNING account_id") {
        const r = db.applications.get(v[1]);
        if (!r || r.status !== "applied") return [];
        Object.assign(r, { status: "withdrawn", decided_at: v[0] });
        return [{ account_id: v[1] }];
      }
      // The client's list of trainer changes (dbChangesForClient): the switch on
      // their live trainer grant, and no changes here (tests/sync-trainer-changes.test.js has them).
      if (flat === "SELECT edits_at, edits_off_at FROM oauth_grants WHERE account_id = ? AND kind = 'trainer' AND revoked_at IS NULL") {
        return db.grants.filter((g) => g.account_id === v[0] && g.kind === "trainer" && g.revoked_at == null)
          .map((g) => ({ edits_at: g.edits_at ?? null, edits_off_at: g.edits_off_at ?? null }));
      }
      if (/^SELECT c\.id, c\.set_id, [^]*FROM trainer_changes c [^]*WHERE c\.client_account_id = \? /.test(flat)) return [];
      if (/^SELECT \* FROM oauth_grants WHERE id = \?$/.test(text)) {
        const g = db.grants.find((x) => x.id === v[0]);
        return g ? [{ ...g }] : [];
      }
      if (/^UPDATE oauth_grants SET revoked_at = \? WHERE id = \? AND revoked_at IS NULL$/.test(text)) {
        const g = db.grants.find((x) => x.id === v[1] && x.revoked_at == null);
        if (g) g.revoked_at = v[0];
        return [];
      }
      if (/^UPDATE oauth_grants SET notice_seen_at = \?\s+WHERE id = \? AND account_id = \? AND kind = 'trainer' AND revoked_at IS NOT NULL AND notice_seen_at IS NULL\s+RETURNING id$/.test(text)) {
        const g = db.grants.find((x) => x.id === v[1] && x.account_id === v[2] && x.kind === "trainer" && x.revoked_at != null && x.notice_seen_at == null);
        if (!g) return [];
        g.notice_seen_at = v[0];
        return [{ id: g.id }];
      }
      throw new Error(`unexpected SQL: ${text}`);
    };
    q.transaction = async () => { throw new Error("no transaction expected"); };
    return q;
  },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(() => null), rateLimitShared: vi.fn(async () => null) }));
// APPLICATIONS_OPEN and TRAINER_LIVE as shipped unless a test turns them off.
const applications = vi.hoisted(() => ({ value: true }));
const live = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/trainer-terms", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, get APPLICATIONS_OPEN() { return applications.value; }, get TRAINER_LIVE() { return live.value; } };
});

// Tokens: who they belong to and their scope. Profiles are handles.
const TOKENS = {
  "tok-abe": { who: A, scope: undefined }, "tok-abe-sync": { who: A, scope: "sync" },
  "tok-abe-photos": { who: A, scope: "photos" }, "tok-abe-trainer": { who: A, scope: "trainer" },
  "tok-tia": { who: T, scope: undefined },
};
const IDENTITIES = {
  [A]: { accountId: A, storageKey: "sk-abe", handle: "abe", roles: ["lifter"], plan: "free" },
  [T]: { accountId: T, storageKey: "tia", handle: "tia", roles: ["lifter", "trainer"], plan: "free" },
};
vi.mock("@/lib/auth-server", async (importOriginal) => ({
  ...(await importOriginal()),
  readTokenData: async (t) => (TOKENS[t] ? { accountId: TOKENS[t].who, scope: TOKENS[t].scope, expires: NOW + DAY } : null),
  resolveTokenIdentity: async (d, profile) => {
    const id = d && IDENTITIES[d.accountId];
    return id && id.handle === profile ? { ...id } : null;
  },
}));

const { GET, POST } = await import("@/app/api/sync/trainer/route");
const { TRAINER_TERMS_VERSION } = await import("@/lib/trainer-terms");

const CURRENT = { version: TRAINER_TERMS_VERSION, at: "2026-10-01T00:00:00.000Z", adult: true };
const account = (id, roles, trainer_terms = null) => ({ id, roles, plan: "free", trainer_terms, deleted_at: null });
const SINCE = NOW - 40 * DAY;
const trainerGrant = (id, client, trainer, extra = {}) => ({
  id, client_id: "hw:trainer", account_id: client, profile: client === A ? "sk-abe" : "sk-bea", credential_id: `cred-${client}`,
  scope: "trainer:read", kind: "trainer", resource: "https://heatwayve.app/trainer", trainer_account_id: trainer,
  consent_version: "2026-10", created_at: SINCE, revoked_at: null, revoked_by: null, looks: [], look_count: 0,
  last_used_at: null, expires_at: null, notice_seen_at: null, ...extra,
});
const aiGrant = (id, client, extra = {}) => ({
  id, client_id: "hwc_x", account_id: client, profile: "sk-abe", credential_id: `cred-${client}`, scope: "training:read",
  kind: "ai", resource: "https://heatwayve.app/mcp", trainer_account_id: null, created_at: NOW - 5 * DAY,
  revoked_at: null, revoked_by: null, looks: null, look_count: null, last_used_at: NOW - DAY, expires_at: null, ...extra,
});

const URL_BASE = "https://heatwayve.app/api/sync/trainer";
const get = (token = "tok-abe", profile = "abe", how = "header") => GET(new NextRequest(`${URL_BASE}?profile=${profile}`, {
  headers: token ? (how === "cookie" ? { cookie: `hw_sync=${token}` } : { "x-hw-auth": token }) : {},
}));
const post = (body, token = "tok-abe") => POST(new NextRequest(URL_BASE, {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-hw-auth": token } : {}) }, body: JSON.stringify(body),
}));
const writes = () => calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(c.q));
const status = async (...a) => (await get(...a)).json();

const envKeys = ["DATABASE_URL", "TRAINER_PREVIEW_ACCOUNTS", "ADMIN_ACCOUNT_ID", "ADMIN_PROFILE"];
let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];
  process.env.DATABASE_URL = "postgres://fake";
  calls.length = 0;
  applications.value = true;
  live.value = true;
  db.accounts = new Map([
    [A, account(A, ["lifter"])], [B, account(B, ["lifter"])],
    [T, account(T, ["lifter", "trainer"], CURRENT)], [N, account(N, ["lifter", "trainer"], CURRENT)],
  ]);
  db.handles = [
    { handle: "abe", display: "Abe", account_id: A, kind: "primary", released_at: null },
    { handle: "tia", display: "Tia", account_id: T, kind: "primary", released_at: null },
    { handle: "nia", display: "Nia", account_id: N, kind: "primary", released_at: null },
  ];
  db.credentials = [
    { id: `cred-${A}`, account_id: A, rp_id: "heatwayve.app" },
    { id: `cred-${B}`, account_id: B, rp_id: "heatwayve.app" },
  ];
  db.grants = [];
  db.applications = new Map();
});
afterEach(() => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("GET /api/sync/trainer: status", () => {
  it("no trainer grant: sharing and ended are null, and AI grants are never read as a trainer", async () => {
    db.grants = [aiGrant("hwg_ai", A), aiGrant("hwg_legacy", A, { kind: null })];
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ open: true, trainerOpen: true, applyOpen: true, trainer: false, trainerRole: false, sharing: null, ended: null, application: null,
      edits: null, changes: [] });
    expect(writes()).toEqual([]);
  });

  it("a live share: the trainer's name, since, what was agreed, the looks mapped to kind and the total", async () => {
    const looks = [
      { k: "v", at: NOW - 60_000 },
      { k: "r", d: "2026-10-02", at: NOW - DAY },
      { k: "v", at: NOW - 3 * DAY },
    ];
    db.grants = [trainerGrant("hwg_t1", A, T, { looks, look_count: 31 })];
    const { sharing, ended } = await status();
    expect(ended).toBeNull();
    expect(sharing).toEqual({
      ref: "hwg_t1", name: "Tia", since: SINCE, live: true, consentVersion: "2026-10",
      looks: [
        { kind: "view", at: NOW - 60_000 },
        { kind: "roster", at: NOW - DAY, day: "2026-10-02" },
        { kind: "view", at: NOW - 3 * DAY },
      ],
      lookCount: 31,
    });
  });

  it("the sync cookie works as the header does; numbers come back as numbers", async () => {
    db.grants = [trainerGrant("hwg_t1", A, T, { created_at: String(SINCE), look_count: "4", looks: [{ k: "v", at: String(NOW) }] })];
    const { sharing } = await status("tok-abe-sync", "abe", "cookie");
    expect(sharing.since).toBe(SINCE);
    expect(sharing.lookCount).toBe(4);
    expect(sharing.looks).toEqual([{ kind: "view", at: NOW }]);
  });

  it("the log holds at most 20 entries, and the count says how many there were in all", async () => {
    const looks = Array.from({ length: 25 }, (_, i) => (i % 2 ? { k: "r", d: `2026-09-${String(28 - i).padStart(2, "0")}`, at: NOW - i * DAY } : { k: "v", at: NOW - i * DAY }));
    db.grants = [trainerGrant("hwg_t1", A, T, { looks, look_count: 140 })];
    const { sharing } = await status();
    expect(sharing.looks).toHaveLength(20);
    expect(sharing.looks[0]).toEqual({ kind: "view", at: NOW });
    expect(sharing.looks[1]).toEqual({ kind: "roster", at: NOW - DAY, day: "2026-09-27" });
    expect(sharing.lookCount).toBe(140);
  });

  it("an empty or missing ring is no looks, and a missing count is 0", async () => {
    db.grants = [trainerGrant("hwg_t1", A, T, { looks: null, look_count: null })];
    const { sharing } = await status();
    expect(sharing.looks).toEqual([]);
    expect(sharing.lookCount).toBe(0);
  });

  it("paused, not ended: the approving passkey gone, the trainer's terms stale, or the trainer role gone", async () => {
    db.grants = [trainerGrant("hwg_t1", A, T)];
    expect((await status()).sharing.live).toBe(true);

    db.credentials = db.credentials.map((c) => (c.account_id === A ? { ...c, rp_id: "legacy.example" } : c));
    let s = await status();
    expect([s.sharing.live, s.sharing.ref, s.ended]).toEqual([false, "hwg_t1", null]);

    db.credentials = db.credentials.map((c) => (c.account_id === A ? { ...c, rp_id: "heatwayve.app" } : c));
    db.accounts.get(T).trainer_terms = { version: "draft-2020-01", at: "2020-01-01T00:00:00.000Z", adult: true };
    s = await status();
    expect(s.sharing.live).toBe(false);

    db.accounts.get(T).trainer_terms = CURRENT;
    db.accounts.get(T).roles = ["lifter"];
    s = await status();
    expect(s.sharing.live).toBe(false);
  });

  it("ended by the trainer: a notice with the name, when and by whom, for 30 days only", async () => {
    db.grants = [trainerGrant("hwg_t1", A, T, { revoked_at: NOW - 2 * DAY, revoked_by: "trainer" })];
    expect(await status()).toMatchObject({ sharing: null, ended: { ref: "hwg_t1", name: "Tia", at: NOW - 2 * DAY, by: "trainer" } });
    db.grants[0].revoked_at = NOW - 31 * DAY;
    expect((await status()).ended).toBeNull();
  });

  it("ended by the trainer's account closing: named by the handle they had, never a later holder", async () => {
    db.accounts.get(T).deleted_at = "2026-10-01T00:00:00.000Z";
    db.handles = db.handles.map((h) => (h.account_id === T ? { ...h, released_at: NOW - DAY } : h));
    db.handles.push({ handle: "tia", display: "TIA-NEW", account_id: id26("z"), kind: "primary", released_at: null });
    db.grants = [trainerGrant("hwg_t1", A, T, { revoked_at: NOW - DAY, revoked_by: "closed" })];
    expect((await status()).ended).toEqual({ ref: "hwg_t1", name: "Tia", at: NOW - DAY, by: "closed" });
  });

  it("no notice when the client stopped it or switched trainer", async () => {
    db.grants = [trainerGrant("hwg_t1", A, T, { revoked_at: NOW - DAY, revoked_by: null })];
    expect(await status()).toMatchObject({ sharing: null, ended: null });
    db.grants = [trainerGrant("hwg_t1", A, T, { revoked_at: NOW - DAY, revoked_by: "replaced" })];
    expect(await status()).toMatchObject({ sharing: null, ended: null });
  });

  it("a live share wins over a newer ended one, and only the newest ended grant counts", async () => {
    db.grants = [
      trainerGrant("hwg_old", A, N, { created_at: SINCE - 10 * DAY, revoked_at: NOW - DAY, revoked_by: "trainer" }),
      trainerGrant("hwg_live", A, T),
    ];
    expect(await status()).toMatchObject({ sharing: { ref: "hwg_live" }, ended: null });
    db.grants = [
      trainerGrant("hwg_old", A, N, { created_at: SINCE - 10 * DAY, revoked_at: NOW - 20 * DAY, revoked_by: "trainer" }),
      trainerGrant("hwg_new", A, T, { revoked_at: NOW - DAY, revoked_by: "replaced" }),
    ];
    expect((await status()).ended).toBeNull();
  });

  it("another client's grant is never this client's share", async () => {
    db.grants = [trainerGrant("hwg_b", B, T, { looks: [{ k: "v", at: NOW }], look_count: 1 })];
    expect(await status()).toMatchObject({ sharing: null, ended: null });
  });

  it("the client is shown nothing about the trainer but a name, and nothing on a look but kind, time and day", async () => {
    db.accounts.get(T).trainer_terms = { ...CURRENT, note: "SENTINEL-terms" };
    db.grants = [trainerGrant("hwg_t1", A, T, {
      credential_id: `cred-${A}`, profile: "sk-abe",
      looks: [
        { k: "v", at: NOW, ip: "SENTINEL-ip", ua: "SENTINEL-ua", trainer: T },
        { k: "r", d: "2026-10-02", at: NOW - DAY, signal: { rhythmPct: 86 }, note: "SENTINEL-note" },
        { k: "SENTINEL-kind", at: NOW - 2 * DAY },
        { k: "v" },
      ],
      look_count: 9, last_used_at: 1777777777777,
    })];
    const body = await (await get()).text();
    const res = JSON.parse(body);
    expect(Object.keys(res).sort()).toEqual(["application", "applyOpen", "changes", "edits", "ended", "open", "sharing", "trainer", "trainerOpen", "trainerRole"]);
    // A share approved before changes existed: read only.
    expect(res.edits).toEqual({ on: false, since: null });
    expect(Object.keys(res.sharing).sort()).toEqual(["consentVersion", "live", "lookCount", "looks", "name", "ref", "since"]);
    for (const l of res.sharing.looks) expect(Object.keys(l).every((k) => ["kind", "at", "day"].includes(k))).toBe(true);
    expect(res.sharing.looks).toHaveLength(2);
    for (const bad of ["SENTINEL", T, `cred-${A}`, "sk-abe", "1777777777777", "trainer:read", "hw:trainer", "rhythmPct", "heatwayve.app/trainer"]) {
      expect(body).not.toContain(bad);
    }
  });

  it("the launch flags, live: a lifter sees Add a trainer and may apply; a trainer other than the admin is a trainer", async () => {
    expect(await status()).toMatchObject({ open: true, trainerOpen: true, applyOpen: true, trainer: false });
    // The old preview list is ignored either way.
    process.env.TRAINER_PREVIEW_ACCOUNTS = `${B}, ${A}`;
    expect(await status()).toMatchObject({ open: true, trainerOpen: true, applyOpen: true, trainer: false });
    delete process.env.TRAINER_PREVIEW_ACCOUNTS;
    expect(await status("tok-tia", "tia")).toMatchObject({ open: true, trainerOpen: true, applyOpen: true, trainer: true, trainerRole: true });
  });

  it("with the switch closed: the admin only, and a preview list opens nothing", async () => {
    live.value = false;
    expect(await status()).toMatchObject({ open: false, trainerOpen: false, applyOpen: true });
    process.env.TRAINER_PREVIEW_ACCOUNTS = `${B}, ${A}`;
    expect(await status()).toMatchObject({ open: false, trainerOpen: false });
    process.env.ADMIN_ACCOUNT_ID = A;
    expect(await status()).toMatchObject({ open: true, trainerOpen: true });
  });

  it("with applications closed, applyOpen is the admin's only, whatever the dashboard switch", async () => {
    applications.value = false;
    expect(await status()).toMatchObject({ trainerOpen: true, applyOpen: false });
    live.value = false;
    expect(await status()).toMatchObject({ trainerOpen: false, applyOpen: false });
    process.env.ADMIN_ACCOUNT_ID = A;
    expect(await status()).toMatchObject({ trainerOpen: true, applyOpen: true });
  });

  it("refuses: no sign-in, no profile, another account's profile, a photos or trainer token", async () => {
    db.grants = [trainerGrant("hwg_t1", A, T)];
    for (const res of [await get(null), await get("tok-abe", ""), await get("tok-abe", "tia"),
      await get("tok-abe-photos"), await get("tok-abe-trainer"), await get("tok-abe-trainer", "abe", "cookie")]) {
      expect(res.status).toBe(401);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Sign in to see your trainer", requiresAuth: true });
    }
    expect(calls).toEqual([]);
  });

  it("without a database: no share, still 200", async () => {
    delete process.env.DATABASE_URL;
    expect(await status()).toEqual({ open: true, trainerOpen: true, applyOpen: true, trainer: false, trainerRole: false, sharing: null, ended: null, application: null,
      edits: null, changes: [] });
  });
});

describe("POST /api/sync/trainer: stop", () => {
  it("stops the client's own trainer share with one UPDATE of revoked_at; revoked_by stays null", async () => {
    db.grants = [trainerGrant("hwg_t1", A, T, { looks: [{ k: "v", at: NOW }], look_count: 1 })];
    const res = await post({ profile: "abe", stop: "hwg_t1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
    const w = writes();
    expect(w.map((c) => c.q)).toEqual(["UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"]);
    expect(w[0].v[1]).toBe("hwg_t1");
    const g = db.grants[0];
    expect(g.revoked_at).toBeGreaterThan(0);
    expect(g.revoked_by).toBeNull();
    // The row and its log stay; the client sees no ended notice for their own stop.
    expect([g.looks, g.look_count]).toEqual([[{ k: "v", at: NOW }], 1]);
    expect(await status()).toMatchObject({ sharing: null, ended: null });
  });

  it("an AI grant id is not found, and the AI grant is untouched", async () => {
    db.grants = [aiGrant("hwg_ai", A), aiGrant("hwg_legacy", A, { kind: null }), trainerGrant("hwg_t1", A, T)];
    for (const stop of ["hwg_ai", "hwg_legacy"]) {
      const res = await post({ profile: "abe", stop });
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(writes()).toEqual([]);
    expect(db.grants.map((g) => g.revoked_at)).toEqual([null, null, null]);
  });

  it("another client's trainer grant, an unknown id, or a malformed stop is not found and writes nothing", async () => {
    db.grants = [trainerGrant("hwg_b", B, T)];
    for (const stop of ["hwg_b", "hwg_nope", "", 42, null, "x".repeat(129)]) {
      expect((await post({ profile: "abe", stop })).status).toBe(404);
    }
    expect((await post({ profile: "abe" })).status).toBe(404);
    expect(writes()).toEqual([]);
    expect(db.grants[0].revoked_at).toBeNull();
  });

  it("stopping again is still ok and writes nothing new", async () => {
    db.grants = [trainerGrant("hwg_t1", A, T, { revoked_at: NOW - DAY })];
    expect((await post({ profile: "abe", stop: "hwg_t1" })).status).toBe(200);
    expect(writes()).toEqual([]);
    expect(db.grants[0].revoked_at).toBe(NOW - DAY);
  });

  it("refuses without the sync sign-in, and never on a photos or trainer token", async () => {
    db.grants = [trainerGrant("hwg_t1", A, T)];
    for (const [token, profile] of [[null, "abe"], ["tok-abe-photos", "abe"], ["tok-abe-trainer", "abe"], ["tok-abe", "tia"], ["tok-abe", ""]]) {
      const res = await post({ profile, stop: "hwg_t1" }, token);
      expect(res.status).toBe(401);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(calls).toEqual([]);
    expect(db.grants[0].revoked_at).toBeNull();
  });
});

describe("POST /api/sync/trainer: the ended notice, seen", () => {
  it("'Got it' is one UPDATE of notice_seen_at on the client's own ended grant; the notice stays gone", async () => {
    db.grants = [trainerGrant("hwg_t1", A, T, { revoked_at: NOW - 2 * DAY, revoked_by: "trainer", looks: [{ k: "v", at: NOW - 3 * DAY }], look_count: 1 })];
    expect((await status()).ended).toMatchObject({ ref: "hwg_t1", name: "Tia" });
    calls.length = 0;
    const res = await post({ profile: "abe", seen: "hwg_t1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0].q.replace(/\s+/g, " ")).toBe(
      "UPDATE oauth_grants SET notice_seen_at = ? WHERE id = ? AND account_id = ? AND kind = 'trainer' "
      + "AND revoked_at IS NOT NULL AND notice_seen_at IS NULL RETURNING id",
    );
    expect(w[0].v.slice(1)).toEqual(["hwg_t1", A]);
    const g = db.grants[0];
    expect(g.notice_seen_at).toBeGreaterThan(0);
    // The ending itself and the log are untouched.
    expect([g.revoked_at, g.revoked_by, g.looks, g.look_count]).toEqual([NOW - 2 * DAY, "trainer", [{ k: "v", at: NOW - 3 * DAY }], 1]);
    expect(await status()).toMatchObject({ sharing: null, ended: null });
    // Seen twice: nothing left to mark.
    expect((await post({ profile: "abe", seen: "hwg_t1" })).status).toBe(404);
  });

  it("closure notices are dismissed the same way; the 30-day age-out still holds when never seen", async () => {
    db.grants = [trainerGrant("hwg_t1", A, T, { revoked_at: NOW - DAY, revoked_by: "closed" })];
    expect((await post({ profile: "abe", seen: "hwg_t1" })).status).toBe(200);
    expect((await status()).ended).toBeNull();
    db.grants = [trainerGrant("hwg_t2", A, T, { revoked_at: NOW - 31 * DAY, revoked_by: "trainer" })];
    expect((await status()).ended).toBeNull();
  });

  it("a live grant, another client's, an AI grant or a malformed id is not found and marks nothing", async () => {
    db.grants = [
      trainerGrant("hwg_live", A, T),
      trainerGrant("hwg_b", B, T, { revoked_at: NOW - DAY, revoked_by: "trainer" }),
      aiGrant("hwg_ai", A, { revoked_at: NOW - DAY }),
    ];
    for (const seen of ["hwg_live", "hwg_b", "hwg_ai", "hwg_nope", "", 42, null, "x".repeat(129)]) {
      expect((await post({ profile: "abe", seen })).status, String(seen)).toBe(404);
    }
    expect(db.grants.map((g) => g.notice_seen_at ?? null)).toEqual([null, null, null]);
    expect(db.grants.map((g) => g.revoked_at)).toEqual([null, NOW - DAY, NOW - DAY]);
  });

  it("refuses without the sync sign-in, and never on a photos or trainer token", async () => {
    db.grants = [trainerGrant("hwg_t1", A, T, { revoked_at: NOW - DAY, revoked_by: "trainer" })];
    for (const [token, profile] of [[null, "abe"], ["tok-abe-photos", "abe"], ["tok-abe-trainer", "abe"], ["tok-abe", "tia"]]) {
      expect((await post({ profile, seen: "hwg_t1" }, token)).status).toBe(401);
    }
    expect(calls).toEqual([]);
    expect(db.grants[0].notice_seen_at).toBeNull();
  });

  it("without a database: 503, nothing written", async () => {
    delete process.env.DATABASE_URL;
    expect((await post({ profile: "abe", seen: "hwg_t1" })).status).toBe(503);
    expect(calls).toEqual([]);
  });
});

describe("the caller's application to coach", () => {
  const app = (status, extra = {}) => ({ account_id: A, status, about: "SENTINEL-ABOUT", link: "https://sentinel.example",
    terms: { version: TRAINER_TERMS_VERSION, at: "x", adult: true }, applied_at: NOW - 3 * DAY, decided_at: null, seen_at: null,
    created_at: NOW - 40 * DAY, ...extra });

  it("GET carries where it stands, never what was written; numbers come back as numbers", async () => {
    db.applications.set(A, app("applied"));
    const body = await (await get()).text();
    expect(JSON.parse(body).application).toEqual({ status: "applied", at: NOW - 3 * DAY, decidedAt: null, nextAt: null, seen: false });
    for (const bad of ["SENTINEL-ABOUT", "sentinel.example", TRAINER_TERMS_VERSION]) expect(body).not.toContain(bad);
    expect(writes()).toEqual([]);
  });

  it("a denial: nextAt is 30 days on while that is ahead, then null; seen once marked", async () => {
    db.applications.set(A, app("denied", { decided_at: NOW - 2 * DAY }));
    expect((await status()).application).toEqual({ status: "denied", at: NOW - 3 * DAY, decidedAt: NOW - 2 * DAY, nextAt: NOW + 28 * DAY, seen: false });
    db.applications.set(A, app("denied", { decided_at: NOW - 31 * DAY, seen_at: NOW - 30 * DAY }));
    expect((await status()).application).toMatchObject({ status: "denied", nextAt: null, seen: true });
    // Another account's row is never this caller's.
    db.applications = new Map([[B, { ...app("approved"), account_id: B }]]);
    expect((await status()).application).toBeNull();
  });

  it("seenApplication is one UPDATE of seen_at on the caller's own decided row, once", async () => {
    db.applications.set(A, app("approved", { decided_at: NOW - DAY }));
    db.applications.set(B, { ...app("approved", { decided_at: NOW - DAY }), account_id: B });
    const res = await post({ profile: "abe", seenApplication: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const w = writes();
    expect(w.map((c) => c.q.replace(/\s+/g, " ").trim())).toEqual([
      "UPDATE trainer_applications SET seen_at = ? WHERE account_id = ? AND status IN ('approved', 'denied') AND seen_at IS NULL RETURNING account_id",
    ]);
    expect(w[0].v[1]).toBe(A);
    expect(db.applications.get(A).seen_at).toBeGreaterThan(0);
    expect(db.applications.get(B).seen_at).toBeNull();
    expect((await post({ profile: "abe", seenApplication: true })).status).toBe(404);
  });

  it("seenApplication on a waiting or withdrawn row, or none, is not found and marks nothing", async () => {
    expect((await post({ profile: "abe", seenApplication: true })).status).toBe(404);
    for (const st of ["applied", "withdrawn"]) {
      db.applications.set(A, app(st));
      expect((await post({ profile: "abe", seenApplication: true })).status).toBe(404);
      expect(db.applications.get(A).seen_at).toBeNull();
    }
  });

  it("withdrawApplication is one UPDATE to 'withdrawn' on the caller's own waiting row; what they wrote is not touched", async () => {
    db.applications.set(A, app("applied"));
    const res = await post({ profile: "abe", withdrawApplication: true });
    expect(res.status).toBe(200);
    const w = writes();
    expect(w.map((c) => c.q.replace(/\s+/g, " ").trim())).toEqual([
      "UPDATE trainer_applications SET status = 'withdrawn', decided_at = ? WHERE account_id = ? AND status = 'applied' RETURNING account_id",
    ]);
    expect(w[0].v[1]).toBe(A);
    expect(db.applications.get(A)).toMatchObject({ status: "withdrawn", about: "SENTINEL-ABOUT", link: "https://sentinel.example" });
    expect((await status()).application).toMatchObject({ status: "withdrawn", nextAt: null });
    // Only a waiting row: again, or a decided one, is not found.
    expect((await post({ profile: "abe", withdrawApplication: true })).status).toBe(404);
    db.applications.set(A, app("denied", { decided_at: NOW - DAY }));
    expect((await post({ profile: "abe", withdrawApplication: true })).status).toBe(404);
    expect(db.applications.get(A).status).toBe("denied");
  });

  it("only a literal true counts; both at once, or either beside stop or seen, is not an application write", async () => {
    db.applications.set(A, app("applied"));
    for (const body of [{ withdrawApplication: "true" }, { withdrawApplication: 1 }, { seenApplication: true, withdrawApplication: true },
      { withdrawApplication: true, stop: "hwg_x" }, { withdrawApplication: true, seen: "hwg_x" }]) {
      expect((await post({ profile: "abe", ...body })).status, JSON.stringify(body)).toBe(404);
    }
    // Beside seen, the ended-notice path ran (and matched nothing); no application write was sent.
    expect(writes().filter((c) => /trainer_applications/.test(c.q))).toEqual([]);
    expect(db.applications.get(A).status).toBe("applied");
  });

  it("refuses without the sync sign-in, and never on a photos or trainer token; 503 without a database", async () => {
    db.applications.set(A, app("applied"));
    for (const [token, profile] of [[null, "abe"], ["tok-abe-photos", "abe"], ["tok-abe-trainer", "abe"], ["tok-abe", "tia"]]) {
      expect((await post({ profile, withdrawApplication: true }, token)).status).toBe(401);
      expect((await post({ profile, seenApplication: true }, token)).status).toBe(401);
    }
    expect(calls).toEqual([]);
    delete process.env.DATABASE_URL;
    expect((await post({ profile: "abe", withdrawApplication: true })).status).toBe(503);
    expect(calls).toEqual([]);
  });
});

describe("source pins", () => {
  const root = resolve(__dirname, "..");
  const read = (f) => readFileSync(resolve(root, f), "utf8");
  const route = read("app/api/sync/trainer/route.js");

  it("the gate is the connections gate: sync sign-in only, never another scope", () => {
    expect(route).toContain('request.cookies.get("hw_sync")');
    expect(route).toContain('return !data.scope || data.scope === "sync" ? identity : null;');
  });

  it("stop is revokeGrantFor for trainer grants: an UPDATE, nothing deleted", () => {
    expect(route).toContain('revokeGrantFor(store, identity, stop, Date.now(), { kind: "trainer" })');
    expect(route).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b|\bdel\(|removeItem|\bq`|\bsql\(/);
    expect(read("lib/oauth-store.js").replace(/\s+/g, " "))
      .toContain("UPDATE oauth_grants SET revoked_at = ${at} WHERE id = ${id} AND revoked_at IS NULL");
  });

  it("runs in lhr1, is dynamic, never returns e.message", () => {
    expect(route).toContain('export const preferredRegion = "lhr1";');
    expect(route).toContain('export const dynamic = "force-dynamic";');
    expect(route).not.toMatch(/e(rr)?\.message/);
  });

  it("dbClientShare is one SELECT, pinned", () => {
    const src = read("lib/trainer-store.js");
    const fn = src.slice(src.indexOf("export async function dbClientShare"), src.indexOf("export async function dbSeenEndedNotice"));
    expect(fn.match(/q`/g)).toHaveLength(1);
    expect(fn.slice(fn.indexOf("q`") + 2, fn.indexOf("`;")).replace(/\s+/g, " ").trim()).toBe(
      "SELECT g.id, g.created_at, g.revoked_at, g.revoked_by, g.consent_version, g.looks, g.look_count, g.notice_seen_at, "
      + "EXISTS (SELECT 1 FROM accounts a JOIN credentials c ON c.account_id = a.id "
      + "WHERE a.id = g.account_id AND a.deleted_at IS NULL AND c.id = g.credential_id AND c.rp_id = 'heatwayve.app') AS client_live, "
      + "t.roles AS trainer_roles, t.plan AS trainer_plan, t.trainer_terms, t.deleted_at AS trainer_deleted_at, h.handle, h.display "
      + "FROM oauth_grants g LEFT JOIN accounts t ON t.id = g.trainer_account_id "
      + "LEFT JOIN LATERAL (SELECT handle, display FROM handles WHERE account_id = g.trainer_account_id AND kind = 'primary' "
      + "ORDER BY released_at DESC NULLS FIRST LIMIT 1) h ON true "
      + "WHERE g.account_id = ${clientId} AND g.kind = 'trainer' "
      + "ORDER BY (g.revoked_at IS NULL) DESC, g.created_at DESC LIMIT 1",
    );
  });
});
