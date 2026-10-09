// Applications to coach: POST /api/trainer/apply and the admin's
// /api/diag/trainers. The Neon driver is faked with small in-memory tables
// (statements run lazily, transactions on a copy, all or nothing), so db.js,
// identity-store, trainer-store, the ceremony gates and the routes all run
// for real and every statement is captured and matched whole.
// The only writes allowed: the apply INSERT (or its named overwrite), the
// ceremony token's expiry, the admin's deny UPDATE, and the approve
// transaction (accounts roles/terms + the application). Nothing is deleted.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

const DAY = 86_400_000;
const hash = (t) => createHash("sha256").update(String(t)).digest("hex");
const id26 = (c) => "hwa_" + c.repeat(26);
const ADMIN = id26("d");
const L = id26("l"); // a lifter who applies
const K = id26("k"); // another applicant
const N = id26("n"); // already a trainer
// The launch switches, as shipped unless a test says otherwise: the dashboard
// off (TRAINER_LIVE), applications open (APPLICATIONS_OPEN).
const live = vi.hoisted(() => ({ value: false }));
const applications = vi.hoisted(() => ({ value: true }));
const hooks = vi.hoisted(() => ({ beforeInsert: null }));

let db;
const calls = [];
const flat = (q) => q.replace(/\s+/g, " ").trim();
const clone = (x) => structuredClone(x);
const asRow = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? String(v) : v]));

const S = {
  token: "SELECT profile, expires, scope, created_at, auth_at, credential_id, account_id FROM auth_tokens WHERE token = ? OR token = ? LIMIT 1",
  expire: "UPDATE auth_tokens SET expires = ? WHERE (token = ? OR token = ?) AND expires > ? RETURNING expires",
  accountById: "SELECT * FROM accounts WHERE id = ? LIMIT 1",
  credLive: "SELECT a.roles, a.plan, a.trainer_terms, a.deleted_at, EXISTS (SELECT 1 FROM credentials c WHERE c.id = ? AND c.account_id = a.id AND c.rp_id = 'heatwayve.app') AS cred_live FROM accounts a WHERE a.id = ?",
  appRow: "SELECT status, about, link, terms, applied_at, decided_at, seen_at, created_at FROM trainer_applications WHERE account_id = ?",
  openCount: "SELECT count(*)::int AS n FROM trainer_applications WHERE status = 'applied'",
  apply: "INSERT INTO trainer_applications (account_id, status, about, link, terms, applied_at, decided_at, seen_at, created_at) "
    + "VALUES (?, 'applied', ?, ?, ?::jsonb, ?, NULL, NULL, ?) "
    + "ON CONFLICT (account_id) DO UPDATE SET status = 'applied', about = EXCLUDED.about, link = EXCLUDED.link, terms = EXCLUDED.terms, "
    + "applied_at = EXCLUDED.applied_at, decided_at = NULL, seen_at = NULL "
    + "WHERE trainer_applications.status = 'withdrawn' OR (trainer_applications.status = 'denied' AND trainer_applications.decided_at <= ?) RETURNING account_id",
  deny: "UPDATE trainer_applications SET status = 'denied', decided_at = ? WHERE account_id = ? AND status = 'applied' RETURNING account_id",
  approveRole: "UPDATE accounts SET roles = CASE WHEN 'trainer' = ANY(roles) THEN roles ELSE array_append(roles, 'trainer') END, "
    + "trainer_terms = ta.terms FROM trainer_applications ta "
    + "WHERE accounts.id = ? AND accounts.deleted_at IS NULL AND ta.account_id = accounts.id AND ta.status = 'applied' RETURNING accounts.id",
  approveApp: "UPDATE trainer_applications SET status = 'approved', decided_at = ? WHERE account_id = ? AND status = 'applied' "
    + "AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = ? AND a.deleted_at IS NULL) RETURNING account_id",
};
const LIST_COLS = "SELECT ta.account_id, ta.status, ta.about, ta.link, ta.applied_at, ta.decided_at, a.created_at AS account_created_at, h.handle, h.display "
  + "FROM trainer_applications ta JOIN accounts a ON a.id = ta.account_id "
  + "LEFT JOIN handles h ON h.account_id = ta.account_id AND h.kind = 'primary' AND h.released_at IS NULL ";

function run(st, q, v) {
  const s = flat(q);
  if (/^(CREATE|ALTER)\b/.test(s)) return [];
  calls.push({ q: s, v });
  // freshCeremony's handle lookup, and the live primary handle for a name.
  if (/^SELECT a\.\*, h\.handle, h\.display, h\.kind, h\.claimed_at, h\.hold_until FROM handles h JOIN accounts a/.test(s)) {
    const h = st.handles.find((x) => x.handle === v[0] && x.released_at == null);
    const a = h && st.accounts.get(h.account_id);
    return a && !a.deleted_at ? [{ ...a, handle: h.handle, display: h.display, kind: "primary", claimed_at: null, hold_until: null }] : [];
  }
  if (s === "SELECT handle, display FROM handles WHERE account_id = ? AND kind = 'primary' AND released_at IS NULL") {
    const h = st.handles.find((x) => x.account_id === v[0] && x.released_at == null);
    return h ? [{ handle: h.handle, display: h.display }] : [];
  }
  switch (s) {
    case S.token: {
      const r = st.tokens.get(v[0]) ?? (v[1] != null ? st.tokens.get(v[1]) : undefined);
      return r ? [{ ...r }] : [];
    }
    case S.expire: {
      const [now, h, legacy, guard] = v;
      const out = [];
      for (const key of [h, legacy]) {
        const r = key != null && st.tokens.get(key);
        if (r && r.expires > guard) { r.expires = now; out.push({ expires: now }); }
      }
      return out;
    }
    case S.accountById: {
      const a = st.accounts.get(v[0]);
      return a ? [{ ...a }] : [];
    }
    case S.credLive: {
      const [cred, acct] = v;
      const a = st.accounts.get(acct);
      if (!a) return [];
      const ok = st.credentials.some((c) => c.id === cred && c.account_id === a.id && c.rp_id === "heatwayve.app");
      return [{ roles: a.roles, plan: a.plan, trainer_terms: a.trainer_terms, deleted_at: a.deleted_at, cred_live: ok }];
    }
    case S.appRow: {
      const r = st.apps.get(v[0]);
      return r ? [asRow(r)] : [];
    }
    case S.openCount:
      return [{ n: [...st.apps.values()].filter((r) => r.status === "applied").length + st.extraOpen }];
    case S.apply: {
      hooks.beforeInsert?.(st);
      const [id, about, link, terms, appliedAt, createdAt, cutoff] = v;
      const cur = st.apps.get(id);
      if (!cur) {
        st.apps.set(id, { status: "applied", about, link, terms: JSON.parse(terms), applied_at: appliedAt, decided_at: null, seen_at: null, created_at: createdAt });
        return [{ account_id: id }];
      }
      if (!(cur.status === "withdrawn" || (cur.status === "denied" && cur.decided_at <= cutoff))) return [];
      Object.assign(cur, { status: "applied", about, link, terms: JSON.parse(terms), applied_at: appliedAt, decided_at: null, seen_at: null });
      return [{ account_id: id }];
    }
    case S.deny: {
      const r = st.apps.get(v[1]);
      if (!r || r.status !== "applied") return [];
      Object.assign(r, { status: "denied", decided_at: v[0] });
      return [{ account_id: v[1] }];
    }
    case S.approveRole: {
      const a = st.accounts.get(v[0]);
      const r = st.apps.get(v[0]);
      if (!a || a.deleted_at || !r || r.status !== "applied") return [];
      if (!a.roles.includes("trainer")) a.roles = [...a.roles, "trainer"];
      a.trainer_terms = clone(r.terms);
      return [{ id: a.id }];
    }
    case S.approveApp: {
      const [now, id, again] = v;
      const r = st.apps.get(id);
      const a = st.accounts.get(again);
      if (!r || r.status !== "applied" || !a || a.deleted_at) return [];
      Object.assign(r, { status: "approved", decided_at: now });
      return [{ account_id: id }];
    }
    default:
      if (s.startsWith(LIST_COLS)) {
        const rows = [...st.apps.entries()].map(([id, r]) => {
          const a = st.accounts.get(id);
          const h = st.handles.find((x) => x.account_id === id && x.released_at == null);
          return a && { account_id: id, ...asRow(r), account_created_at: a.created_at, handle: h?.handle ?? null, display: h?.display ?? null };
        }).filter(Boolean);
        if (s === `${LIST_COLS}WHERE ta.status = 'applied' ORDER BY ta.applied_at`) {
          return rows.filter((r) => r.status === "applied").sort((x, y) => x.applied_at - y.applied_at);
        }
        if (s === `${LIST_COLS}WHERE ta.status <> 'applied' ORDER BY ta.decided_at DESC NULLS LAST LIMIT ?`) {
          return rows.filter((r) => r.status !== "applied").sort((x, y) => (y.decided_at ?? -1) - (x.decided_at ?? -1)).slice(0, v[0]);
        }
      }
      throw new Error(`unexpected SQL: ${s}`);
  }
}

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    const tag = (strings, ...v) => {
      const q = strings.join("?");
      return { q, v, then: (ok, ko) => new Promise((r) => r(run(db, q, v))).then(ok, ko) };
    };
    tag.transaction = async (queries) => {
      const draft = { ...db, tokens: new Map([...db.tokens].map(([k, x]) => [k, { ...x }])),
        accounts: new Map([...db.accounts].map(([k, a]) => [k, clone(a)])), apps: new Map([...db.apps].map(([k, r]) => [k, clone(r)])) };
      db.txns.push(queries.map((x) => flat(x.q)));
      const out = queries.map((x) => run(draft, x.q, x.v));
      if (db.failTxn) throw db.failTxn;
      Object.assign(db, { tokens: draft.tokens, accounts: draft.accounts, apps: draft.apps });
      return out;
    };
    return tag;
  },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(() => null), rateLimitShared: vi.fn(async () => null) }));
vi.mock("@/lib/trainer-terms", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, get TRAINER_LIVE() { return live.value; }, get APPLICATIONS_OPEN() { return applications.value; } };
});

const { POST: applyPOST } = await import("@/app/api/trainer/apply/route");
const admin = await import("@/app/api/diag/trainers/route");
const { TRAINER_TERMS_VERSION } = await import("@/lib/trainer-terms");
const { APPLY_COPY } = await import("@/lib/trainer-apply");
const { rateLimit, rateLimitShared } = await import("@/lib/rate-limit");

const CURRENT = { version: TRAINER_TERMS_VERSION, at: "2026-10-01T00:00:00.000Z", adult: true };
const account = (id, roles, extra = {}) => ({
  id, storage_key: id, webauthn_user_id: "u-" + id, roles, plan: "free", consent: null, trainer_terms: null,
  origin: "claim", created_at: new Date(Date.now() - 45 * DAY), lapsed_at: null, deleted_at: null, ...extra,
});
let seq = 0;
const mint = (acct, { cred = `c-${acct}`, scope = null, authAgeMs = 60_000 } = {}) => {
  const token = `tok-${++seq}`;
  db.tokens.set(hash(token), {
    profile: acct, expires: Date.now() + 3600_000, scope, created_at: new Date(Date.now() - authAgeMs).toISOString(),
    auth_at: new Date(Date.now() - authAgeMs).toISOString(), credential_id: cred, account_id: acct,
  });
  return token;
};
const writes = () => calls.filter((c) => /^(INSERT|UPDATE|DELETE)\b/.test(c.q));
const H = "https://heatwayve.app";
const ABOUT = "Strength coach at a gym in Leeds. Level 3 PT.";
const body = (authToken, profile = "leo", extra = {}) => ({ authToken, profile, about: ABOUT, link: "https://leo.example",
  terms: { version: TRAINER_TERMS_VERSION }, adult: true, ...extra });
const apply = (b) => applyPOST(new NextRequest(`${H}/api/trainer/apply`, {
  method: "POST", headers: { "content-type": "application/json" }, body: typeof b === "string" ? b : JSON.stringify(b),
}));
const listReq = (token) => admin.GET(new NextRequest(`${H}/api/diag/trainers`, { headers: token ? { "x-hw-auth": token } : {} }));
const decide = (token, b) => admin.POST(new NextRequest(`${H}/api/diag/trainers`, {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-hw-auth": token } : {}) }, body: JSON.stringify(b),
}));

beforeEach(() => {
  calls.length = 0;
  live.value = false;
  applications.value = true;
  hooks.beforeInsert = null;
  db = {
    tokens: new Map(),
    accounts: new Map([[ADMIN, account(ADMIN, ["lifter"])], [L, account(L, ["lifter"])], [K, account(K, ["lifter"])],
      [N, account(N, ["lifter", "trainer"], { trainer_terms: CURRENT })]]),
    handles: [
      { handle: "dee", display: "Dee", account_id: ADMIN, released_at: null },
      { handle: "leo", display: "Leo", account_id: L, released_at: null },
      { handle: "kim", display: "Kim", account_id: K, released_at: null },
      { handle: "nia", display: "Nia", account_id: N, released_at: null },
    ],
    credentials: [ADMIN, L, K, N].map((a) => ({ id: `c-${a}`, account_id: a, rp_id: "heatwayve.app" }))
      .concat([{ id: "c-legacy", account_id: L, rp_id: "theforged.fit" }]),
    apps: new Map(),
    extraOpen: 0,
    txns: [],
    failTxn: null,
  };
  process.env.DATABASE_URL = "postgres://fake";
  process.env.ADMIN_ACCOUNT_ID = ADMIN;
  vi.mocked(rateLimit).mockClear();
  vi.mocked(rateLimitShared).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.ADMIN_ACCOUNT_ID;
  delete process.env.ADMIN_PROFILE;
});

describe("POST /api/trainer/apply", () => {
  it("with applications closed and the dashboard not live: 503 for anyone but the admin, nothing written", async () => {
    applications.value = false;
    const authToken = mint(L);
    const res = await apply(body(authToken));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Not open yet." });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(writes()).toEqual([]);
    expect(db.apps.size).toBe(0);
    // The ceremony token is kept.
    expect(db.tokens.get(hash(authToken)).expires).toBeGreaterThan(Date.now());
    // The admin is always open.
    expect((await apply(body(mint(ADMIN), "dee"))).status).toBe(200);
    // Once live, everyone is.
    live.value = true;
    expect((await apply(body(mint(K), "kim"))).status).toBe(200);
  });

  it("open to a signed-in non-admin while applications are open, before the dashboard is live", async () => {
    expect(live.value).toBe(false);
    expect(applications.value).toBe(true);
    const res = await apply(body(mint(L)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "applied" });
    // The Terms on the application are the current version.
    expect(db.apps.get(L).terms).toMatchObject({ version: TRAINER_TERMS_VERSION, adult: true });
  });

  it("sends an application: one INSERT of the caller's own row, then the ceremony token's expiry", async () => {
    const authToken = mint(L);
    const before = Date.now();
    const res = await apply(body(authToken, "Leo", { about: `  ${ABOUT}\r\n` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, status: "applied" });
    expect(writes().map((c) => c.q)).toEqual([S.apply, S.expire]);
    const row = db.apps.get(L);
    expect(row).toMatchObject({ status: "applied", about: ABOUT, link: "https://leo.example", decided_at: null, seen_at: null });
    expect(row.applied_at).toBeGreaterThanOrEqual(before);
    expect(row.created_at).toBe(row.applied_at);
    expect(Object.keys(row.terms).sort()).toEqual(["adult", "at", "version"]);
    expect(row.terms).toMatchObject({ version: TRAINER_TERMS_VERSION, adult: true });
    // The role is not granted by applying.
    expect(db.accounts.get(L).roles).toEqual(["lifter"]);
    expect(db.tokens.get(hash(authToken)).expires).toBeLessThanOrEqual(Date.now());
  });

  it("the link is optional", async () => {
    expect((await apply(body(mint(L), "leo", { link: undefined }))).status).toBe(200);
    expect(db.apps.get(L).link).toBeNull();
  });

  it("a trainer is told so: 403 { trainer }, nothing written", async () => {
    const res = await apply(body(mint(N), "nia"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ trainer: true });
    expect(writes()).toEqual([]);
  });

  const bad = {
    "an unknown terms version": [{ terms: { version: "draft-2020-01" } }, "Accept the Trainer Terms to continue."],
    "no adult attestation": [{ adult: undefined }, "Accept the Trainer Terms to continue."],
    "adult as a string": [{ adult: "true" }, "Accept the Trainer Terms to continue."],
    "no about": [{ about: "  " }, APPLY_COPY.aboutMissing],
    "a long about": [{ about: "x".repeat(281) }, APPLY_COPY.aboutLong],
    "an http link": [{ link: "http://leo.example" }, APPLY_COPY.linkBad],
    "a script link": [{ link: "javascript:alert(1)" }, APPLY_COPY.linkBad],
    "a long link": [{ link: `https://leo.example/${"a".repeat(190)}` }, APPLY_COPY.linkLong],
  };
  for (const [label, [extra, error]] of Object.entries(bad)) {
    it(`refuses ${label} with 400, nothing written`, async () => {
      const res = await apply(body(mint(L), "leo", extra));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
      expect(writes()).toEqual([]);
    });
  }

  it("a body over 4 KB is refused before it is parsed or any token read", async () => {
    const res = await apply(JSON.stringify(body(mint(L), "leo", { pad: "x".repeat(4096) })));
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("a failed, stale or legacy ceremony writes nothing", async () => {
    expect((await apply(body("nope"))).status).toBe(401);
    expect((await apply(body(mint(L, { authAgeMs: 6 * 60_000 })))).status).toBe(401);
    expect((await apply(body(mint(L), "kim"))).status).toBe(401);
    const legacy = await apply(body(mint(L, { cred: "c-legacy" })));
    expect(legacy.status).toBe(409);
    expect(await legacy.json()).toEqual({ needsNativePasskey: true });
    expect((await apply(body(mint(L, { scope: "sync" })))).status).toBe(401);
    expect(writes()).toEqual([]);
  });

  it("one waiting application per account: 409 { status: applied }, nothing replaced", async () => {
    expect((await apply(body(mint(L)))).status).toBe(200);
    const first = clone(db.apps.get(L));
    calls.length = 0;
    const res = await apply(body(mint(L), "leo", { about: "Second go" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: "applied" });
    expect(writes()).toEqual([]);
    expect(db.apps.get(L)).toEqual(first);
  });

  it("after a denial: 409 with nextAt inside 30 days; the named overwrite after", async () => {
    const decided = Date.now() - 10 * DAY;
    db.apps.set(L, { status: "denied", about: "old", link: null, terms: CURRENT, applied_at: decided - DAY, decided_at: decided, seen_at: decided, created_at: 5 });
    const res = await apply(body(mint(L)));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: "denied", nextAt: decided + 30 * DAY });
    expect(writes()).toEqual([]);

    db.apps.get(L).decided_at = Date.now() - 31 * DAY;
    expect((await apply(body(mint(L)))).status).toBe(200);
    // Overwritten in place: the new words, decision and seen cleared, the first apply kept.
    expect(db.apps.get(L)).toMatchObject({ status: "applied", about: ABOUT, decided_at: null, seen_at: null, created_at: 5 });
  });

  it("after a withdrawal: apply again at once, over the same row", async () => {
    db.apps.set(L, { status: "withdrawn", about: "old", link: "https://old.example", terms: CURRENT, applied_at: 1, decided_at: Date.now() - 1000, seen_at: null, created_at: 1 });
    expect((await apply(body(mint(L), "leo", { link: "" }))).status).toBe(200);
    expect(db.apps.get(L)).toMatchObject({ status: "applied", about: ABOUT, link: null, decided_at: null, created_at: 1 });
    expect(db.apps.size).toBe(1);
  });

  it("an approved row without the role is not replaced", async () => {
    db.apps.set(L, { status: "approved", about: "a", link: null, terms: CURRENT, applied_at: 1, decided_at: 2, seen_at: null, created_at: 1 });
    const res = await apply(body(mint(L)));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: "approved" });
    expect(writes()).toEqual([]);
  });

  it("the cap: with 100 waiting, applications pause; at 99 they go through", async () => {
    db.extraOpen = 100;
    const res = await apply(body(mint(L)));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Applications are paused for now." });
    expect(writes()).toEqual([]);
    db.extraOpen = 99;
    expect((await apply(body(mint(L)))).status).toBe(200);
  });

  it("a row that changed under the request is not overwritten: 409, the ceremony token kept", async () => {
    const authToken = mint(L);
    hooks.beforeInsert = (st) => st.apps.set(L, { status: "applied", about: "raced", link: null, terms: CURRENT, applied_at: 1, decided_at: null, seen_at: null, created_at: 1 });
    const res = await apply(body(authToken));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: "applied" });
    expect(db.apps.get(L).about).toBe("raced");
    expect(writes().map((c) => c.q)).toEqual([S.apply]);
  });

  it("limits: 5 a minute in memory, 10 shared", async () => {
    await apply(body("nope"));
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["trainer-apply", 5]);
    expect(vi.mocked(rateLimitShared).mock.calls[0].slice(1)).toEqual(["trainer-apply", 10]);
  });

  it("a store failure is a generic 500", async () => {
    db.failTxn = null;
    hooks.beforeInsert = () => { throw new Error("db down"); };
    const res = await apply(body(mint(L)));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Something went wrong. Try again." });
  });
});

describe("/api/diag/trainers: the admin's list", () => {
  const seedApps = () => {
    const now = Date.now();
    db.apps.set(L, { status: "applied", about: ABOUT, link: "https://leo.example", terms: CURRENT, applied_at: now - 2 * DAY, decided_at: null, seen_at: null, created_at: now - 2 * DAY });
    db.apps.set(K, { status: "applied", about: "Online coaching.", link: null, terms: CURRENT, applied_at: now - 5 * DAY, decided_at: null, seen_at: null, created_at: now - 5 * DAY });
    db.apps.set(N, { status: "withdrawn", about: null, link: null, terms: CURRENT, applied_at: now - 9 * DAY, decided_at: now - 8 * DAY, seen_at: null, created_at: now - 9 * DAY });
    return now;
  };

  it("lists waiting (oldest first) and decided: live name, age in days, about, link, appliedAt; nothing written", async () => {
    const now = seedApps();
    db.handles.find((h) => h.handle === "nia").released_at = "2026-10-01";
    const res = await listReq(mint(ADMIN, { authAgeMs: 30 * 60_000 }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { open, decided } = await res.json();
    expect(open.map((r) => [r.accountId, r.name, r.accountAge, r.about, r.link])).toEqual([
      [K, "Kim", 45, "Online coaching.", null],
      [L, "Leo", 45, ABOUT, "https://leo.example"],
    ]);
    expect(open[1].appliedAt).toBe(now - 2 * DAY);
    expect(decided).toEqual([{ accountId: N, name: null, accountAge: 45, status: "withdrawn", about: null, link: null, appliedAt: now - 9 * DAY, decidedAt: now - 8 * DAY }]);
    expect(writes()).toEqual([]);
  });

  it("refuses without an admin ceremony, and fails closed with no admin configured", async () => {
    seedApps();
    expect((await listReq(null)).status).toBe(401);
    expect((await listReq(mint(L))).status).toBe(403);
    expect((await listReq(mint(ADMIN, { scope: "sync" }))).status).toBe(401);
    delete process.env.ADMIN_ACCOUNT_ID;
    const res = await listReq(mint(ADMIN));
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(writes()).toEqual([]);
  });
});

describe("/api/diag/trainers: decisions", () => {
  const applied = (id, extra = {}) => db.apps.set(id, { status: "applied", about: ABOUT, link: null,
    terms: { ...CURRENT, at: "2026-10-03T08:00:00.000Z" }, applied_at: Date.now() - DAY, decided_at: null, seen_at: null, created_at: Date.now() - DAY, ...extra });

  it("approve is one transaction: the role and the application's terms, then the application approved", async () => {
    applied(L);
    applied(K);
    const res = await decide(mint(ADMIN), { decision: "approve", accountId: L });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, status: "approved" });
    expect(db.txns).toEqual([[S.approveRole, S.approveApp]]);
    expect(writes().map((c) => c.q)).toEqual([S.approveRole, S.approveApp]);
    expect(db.accounts.get(L)).toMatchObject({ roles: ["lifter", "trainer"], plan: "free", trainer_terms: { ...CURRENT, at: "2026-10-03T08:00:00.000Z" } });
    expect(db.apps.get(L)).toMatchObject({ status: "approved", seen_at: null });
    expect(db.apps.get(L).decided_at).toBeGreaterThan(0);
    // Nobody else moved: the other applicant, an existing trainer, the admin.
    expect(db.apps.get(K).status).toBe("applied");
    expect(db.accounts.get(K).roles).toEqual(["lifter"]);
    expect(db.accounts.get(N)).toMatchObject({ roles: ["lifter", "trainer"], trainer_terms: CURRENT });
    expect(db.accounts.get(ADMIN).roles).toEqual(["lifter"]);
    // Once decided, it is not decided again.
    expect((await decide(mint(ADMIN), { decision: "approve", accountId: L })).status).toBe(404);
    expect((await decide(mint(ADMIN), { decision: "deny", accountId: L })).status).toBe(404);
  });

  it("deny is one UPDATE; the applicant then waits 30 days to apply again", async () => {
    applied(L);
    const res = await decide(mint(ADMIN), { decision: "deny", accountId: L });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "denied" });
    expect(writes().map((c) => c.q)).toEqual([S.deny]);
    expect(db.txns).toEqual([]);
    const { decided_at: at } = db.apps.get(L);
    expect(db.apps.get(L)).toMatchObject({ status: "denied", about: ABOUT });
    expect(db.accounts.get(L).roles).toEqual(["lifter"]);
    const again = await apply(body(mint(L)));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ status: "denied", nextAt: at + 30 * DAY });
  });

  it("an approval on a closed account changes nothing", async () => {
    applied(L);
    db.accounts.get(L).deleted_at = "2026-10-02";
    expect((await decide(mint(ADMIN), { decision: "approve", accountId: L })).status).toBe(404);
    expect(db.accounts.get(L).roles).toEqual(["lifter"]);
    expect(db.apps.get(L).status).toBe("applied");
  });

  it("a failed transaction leaves both rows as they were", async () => {
    applied(L);
    db.failTxn = new Error("connection reset");
    expect((await decide(mint(ADMIN), { decision: "approve", accountId: L })).status).toBe(500);
    expect(db.accounts.get(L).roles).toEqual(["lifter"]);
    expect(db.apps.get(L).status).toBe("applied");
  });

  it("needs an admin ceremony from the last 5 minutes; anything else writes nothing", async () => {
    applied(L);
    const stale = await decide(mint(ADMIN, { authAgeMs: 6 * 60_000 }), { decision: "approve", accountId: L });
    expect(stale.status).toBe(401);
    expect(stale.headers.get("cache-control")).toBe("no-store");
    expect((await decide(null, { decision: "approve", accountId: L })).status).toBe(401);
    expect((await decide(mint(L), { decision: "approve", accountId: L })).status).toBe(403);
    expect((await decide(mint(N), { decision: "deny", accountId: L })).status).toBe(403);
    delete process.env.ADMIN_ACCOUNT_ID;
    expect((await decide(mint(ADMIN), { decision: "approve", accountId: L })).status).toBe(403);
    expect(writes()).toEqual([]);
    expect(db.apps.get(L).status).toBe("applied");
  });

  it("an unknown decision or a malformed account id is not found, before any write", async () => {
    applied(L);
    for (const b of [{ decision: "delete", accountId: L }, { decision: "approve" }, { decision: "approve", accountId: "leo" },
      { decision: "deny", accountId: `${L} ` }, { decision: ["approve"], accountId: L }]) {
      expect((await decide(mint(ADMIN), b)).status, JSON.stringify(b)).toBe(404);
    }
    expect(writes()).toEqual([]);
  });

  it("no one waiting under that id is not found", async () => {
    expect((await decide(mint(ADMIN), { decision: "deny", accountId: K })).status).toBe(404);
    db.apps.set(K, { status: "withdrawn", about: null, link: null, terms: CURRENT, applied_at: 1, decided_at: 2, seen_at: null, created_at: 1 });
    expect((await decide(mint(ADMIN), { decision: "approve", accountId: K })).status).toBe(404);
    expect(db.accounts.get(K).roles).toEqual(["lifter"]);
  });
});
