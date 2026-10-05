// Trainer store: SQL pins for the invite slot, and no destructive verb in any
// trainer file. The only invite writes are the named overwrite of the
// trainer's own slot and the cancel UPDATE.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const calls = [];
let reply = () => [];
vi.mock("@neondatabase/serverless", () => ({
  neon: () => async (strings, ...values) => {
    const q = strings.join("?");
    if (/^\s*(CREATE|ALTER)\b/.test(q)) return [];
    calls.push({ q, values });
    return reply(q, values);
  },
}));

const s = await import("../lib/trainer-store.js");
const { hashSecret } = await import("../lib/oauth.js");
const T = "hwa_" + "t".repeat(26);
const NOW = 1_790_000_000_000;
const flat = (q) => q.replace(/\s+/g, " ").trim();
const unique = () => Object.assign(new Error("duplicate key value violates unique constraint \"trainer_invites_code\""), { code: "23505" });

describe("trainer store: invites", () => {
  beforeEach(() => { calls.length = 0; reply = () => []; process.env.DATABASE_URL = "postgres://fake"; });
  afterEach(() => { delete process.env.DATABASE_URL; });

  it("returns null for every invite function with no DB", async () => {
    delete process.env.DATABASE_URL;
    expect(await s.dbIssueInvite(T, "h", NOW)).toBeNull();
    expect(await s.issueInvite(T, NOW)).toBeNull();
    expect(await s.dbCancelInvite(T, NOW)).toBeNull();
    expect(await s.dbInviteStatus(T, NOW)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("dbIssueInvite overwrites the trainer's own slot in place: ON CONFLICT pinned, 60 minutes", async () => {
    expect(await s.dbIssueInvite(T, "h1", NOW)).toEqual({ expiresAt: NOW + 3_600_000 });
    expect(calls).toHaveLength(1);
    expect(flat(calls[0].q)).toBe(
      "INSERT INTO trainer_invites (trainer_account_id, code_hash, issued_at, expires_at, used_at, grant_id) " +
      "VALUES (?, ?, ?, ?, NULL, NULL) " +
      "ON CONFLICT (trainer_account_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, issued_at = EXCLUDED.issued_at, " +
      "expires_at = EXCLUDED.expires_at, used_at = NULL, grant_id = NULL",
    );
    expect(calls[0].values).toEqual([T, "h1", NOW, NOW + 3_600_000]);
  });

  it("issueInvite stores only the hash and returns the code once", async () => {
    const r = await s.issueInvite(T, NOW);
    expect(r).toEqual({ code: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{12}$/), expiresAt: NOW + 3_600_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual([T, hashSecret(r.code), NOW, NOW + 3_600_000]);
    expect(JSON.stringify(calls)).not.toContain(r.code);
  });

  it("a code-index clash (23505) mints once more; a second clash throws", async () => {
    const mint = vi.fn().mockReturnValueOnce("AAAAAAAAAAAA").mockReturnValueOnce("BBBBBBBBBBBB").mockReturnValueOnce("CCCCCCCCCCCC");
    let n = 0;
    reply = () => { if (n++ === 0) throw unique(); return []; };
    expect(await s.issueInvite(T, NOW, mint)).toEqual({ code: "BBBBBBBBBBBB", expiresAt: NOW + 3_600_000 });
    expect(calls.map((c) => c.values[1])).toEqual([hashSecret("AAAAAAAAAAAA"), hashSecret("BBBBBBBBBBBB")]);

    calls.length = 0;
    reply = () => { throw unique(); };
    await expect(s.issueInvite(T, NOW, mint)).rejects.toMatchObject({ code: "23505" });
    expect(calls).toHaveLength(2);
  });

  it("any other store error is not retried", async () => {
    reply = () => { throw new Error("db down"); };
    await expect(s.issueInvite(T, NOW)).rejects.toThrow("db down");
    expect(calls).toHaveLength(1);
  });

  it("dbCancelInvite is an UPDATE of expires_at with its full WHERE", async () => {
    reply = () => [{ trainer_account_id: T }];
    expect(await s.dbCancelInvite(T, NOW)).toBe(true);
    expect(flat(calls[0].q)).toBe(
      "UPDATE trainer_invites SET expires_at = ? WHERE trainer_account_id = ? AND used_at IS NULL AND expires_at > ? RETURNING trainer_account_id",
    );
    expect(calls[0].values).toEqual([NOW, T, NOW]);
    reply = () => [];
    expect(await s.dbCancelInvite(T, NOW)).toBe(false);
  });

  it("dbInviteStatus is one SELECT; usedBy only through a live trainer grant naming this trainer", async () => {
    await s.dbInviteStatus(T, NOW);
    expect(calls).toHaveLength(1);
    expect(flat(calls[0].q)).toBe(
      "SELECT i.expires_at, i.used_at, h.handle, h.display FROM trainer_invites i " +
      "LEFT JOIN oauth_grants g ON g.id = i.grant_id AND g.kind = 'trainer' AND g.trainer_account_id = i.trainer_account_id AND g.revoked_at IS NULL " +
      "LEFT JOIN handles h ON h.account_id = g.account_id AND h.kind = 'primary' AND h.released_at IS NULL " +
      "WHERE i.trainer_account_id = ?",
    );
    expect(calls[0].values).toEqual([T]);
  });

  it("dbInviteStatus: none, pending, expired at the boundary, used with and without a name", async () => {
    const row = (r) => { reply = () => (r ? [{ handle: null, display: null, used_at: null, ...r }] : []); };
    row(null);
    expect(await s.dbInviteStatus(T, NOW)).toEqual({ status: "none", expiresAt: null });
    row({ expires_at: String(NOW + 1) });
    expect(await s.dbInviteStatus(T, NOW)).toEqual({ status: "pending", expiresAt: NOW + 1 });
    row({ expires_at: String(NOW) });
    expect(await s.dbInviteStatus(T, NOW)).toEqual({ status: "expired", expiresAt: NOW });
    row({ expires_at: NOW + 60_000, used_at: NOW - 1, handle: "leo", display: "Leo" });
    expect(await s.dbInviteStatus(T, NOW)).toEqual({ status: "used", expiresAt: NOW + 60_000, usedBy: "Leo" });
    // A display that does not normalise to the handle is never shown.
    row({ expires_at: NOW + 60_000, used_at: NOW - 1, handle: "leo", display: "Tia" });
    expect((await s.dbInviteStatus(T, NOW)).usedBy).toBe("leo");
    // Used, but that grant is no longer live: no name.
    row({ expires_at: NOW - 1, used_at: NOW - 2 });
    expect(await s.dbInviteStatus(T, NOW)).toEqual({ status: "used", expiresAt: NOW - 1 });
  });
});

describe("trainer store: the ended notice, seen", () => {
  beforeEach(() => { calls.length = 0; reply = () => []; process.env.DATABASE_URL = "postgres://fake"; });
  afterEach(() => { delete process.env.DATABASE_URL; });

  it("dbSeenEndedNotice is one UPDATE of notice_seen_at, scoped to the client's own ended trainer grant", async () => {
    reply = () => [{ id: "hwg_t1" }];
    expect(await s.dbSeenEndedNotice(T, "hwg_t1", NOW)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(flat(calls[0].q)).toBe(
      "UPDATE oauth_grants SET notice_seen_at = ? WHERE id = ? AND account_id = ? AND kind = 'trainer' "
      + "AND revoked_at IS NOT NULL AND notice_seen_at IS NULL RETURNING id",
    );
    expect(calls[0].values).toEqual([NOW, "hwg_t1", T]);
    reply = () => [];
    expect(await s.dbSeenEndedNotice(T, "hwg_t1", NOW)).toBe(false);
    delete process.env.DATABASE_URL;
    expect(await s.dbSeenEndedNotice(T, "hwg_t1", NOW)).toBeNull();
  });

  it("dbClientShare: a seen notice is not shown again; the seen time comes back", async () => {
    const row = { id: "hwg_t1", created_at: NOW - 9e8, revoked_at: NOW - 86_400_000, revoked_by: "trainer", handle: "tia", display: "Tia" };
    reply = () => [{ ...row, notice_seen_at: null }];
    expect(await s.dbClientShare(T, NOW)).toEqual({ sharing: null, ended: { ref: "hwg_t1", name: "Tia", at: NOW - 86_400_000, by: "trainer" }, noticeSeenAt: null });
    reply = () => [{ ...row, notice_seen_at: String(NOW - 1000) }];
    expect(await s.dbClientShare(T, NOW)).toEqual({ sharing: null, ended: null, noticeSeenAt: NOW - 1000 });
  });
});

describe("trainer store: applications to coach", () => {
  beforeEach(() => { calls.length = 0; reply = () => []; process.env.DATABASE_URL = "postgres://fake"; });
  afterEach(() => { delete process.env.DATABASE_URL; });
  const terms = { version: "draft-2026-10", at: "2026-10-04T09:00:00.000Z", adult: true };
  const DAY = 86_400_000;

  it("returns null for every application function with no DB", async () => {
    delete process.env.DATABASE_URL;
    expect(await s.dbTrainerApplication(T)).toBeNull();
    expect(await s.dbOpenApplicationCount()).toBeNull();
    expect(await s.dbApplyTrainer(T, { about: "a", link: null, terms }, NOW)).toBeNull();
    expect(await s.dbWithdrawApplication(T, NOW)).toBeNull();
    expect(await s.dbSeenApplication(T, NOW)).toBeNull();
    expect(await s.dbDenyApplication(T, NOW)).toBeNull();
    expect(await s.dbListApplications(NOW)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("dbApplyTrainer: one INSERT, the named overwrite only over a withdrawn row or a denial 30 days old", async () => {
    reply = () => [{ account_id: T }];
    expect(await s.dbApplyTrainer(T, { about: "Gym in Leeds", link: "https://kim.example", terms: { ...terms, extra: 1 } }, NOW)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(flat(calls[0].q)).toBe(
      "INSERT INTO trainer_applications (account_id, status, about, link, terms, applied_at, decided_at, seen_at, created_at) "
      + "VALUES (?, 'applied', ?, ?, ?::jsonb, ?, NULL, NULL, ?) "
      + "ON CONFLICT (account_id) DO UPDATE SET status = 'applied', about = EXCLUDED.about, link = EXCLUDED.link, terms = EXCLUDED.terms, "
      + "applied_at = EXCLUDED.applied_at, decided_at = NULL, seen_at = NULL "
      + "WHERE trainer_applications.status = 'withdrawn' "
      + "OR (trainer_applications.status = 'denied' AND trainer_applications.decided_at <= ?) RETURNING account_id",
    );
    // created_at is set on the first insert only: the overwrite never names it.
    expect(calls[0].values).toEqual([T, "Gym in Leeds", "https://kim.example", JSON.stringify(terms), NOW, NOW, NOW - 30 * DAY]);
    reply = () => [];
    expect(await s.dbApplyTrainer(T, { about: "x", link: null, terms }, NOW)).toBe(false);
    expect(calls[1].values[2]).toBeNull();
  });

  it("dbApplyTrainer refuses an empty about, a missing id or terms without 18+ before any SQL", async () => {
    for (const [id, app] of [["", { about: "a", terms }], [T, { about: "", terms }], [T, { about: "a", terms: { ...terms, adult: false } }], [T, { about: "a", terms: null }]]) {
      await expect(s.dbApplyTrainer(id, /** @type {any} */ ({ link: null, ...app }), NOW)).rejects.toThrow(/incomplete application/);
    }
    expect(calls).toEqual([]);
  });

  it("withdraw, seen and deny are single UPDATEs scoped to the one account and the one status", async () => {
    reply = () => [{ account_id: T }];
    expect(await s.dbWithdrawApplication(T, NOW)).toBe(true);
    expect(await s.dbSeenApplication(T, NOW)).toBe(true);
    expect(await s.dbDenyApplication(T, NOW)).toBe(true);
    expect(calls.map((c) => flat(c.q))).toEqual([
      "UPDATE trainer_applications SET status = 'withdrawn', decided_at = ? WHERE account_id = ? AND status = 'applied' RETURNING account_id",
      "UPDATE trainer_applications SET seen_at = ? WHERE account_id = ? AND status IN ('approved', 'denied') AND seen_at IS NULL RETURNING account_id",
      "UPDATE trainer_applications SET status = 'denied', decided_at = ? WHERE account_id = ? AND status = 'applied' RETURNING account_id",
    ]);
    for (const c of calls) expect(c.values).toEqual([NOW, T]);
    reply = () => [];
    expect(await s.dbWithdrawApplication(T, NOW)).toBe(false);
    expect(await s.dbSeenApplication(T, NOW)).toBe(false);
    expect(await s.dbDenyApplication(T, NOW)).toBe(false);
  });

  it("reads: the account's row with numbers as numbers, and the waiting count", async () => {
    reply = () => [{ status: "denied", about: "a", link: null, terms, applied_at: String(NOW - 9), decided_at: String(NOW - 5), seen_at: null, created_at: "1" }];
    expect(await s.dbTrainerApplication(T)).toEqual({ status: "denied", about: "a", link: null, terms, appliedAt: NOW - 9, decidedAt: NOW - 5, seenAt: null, createdAt: 1 });
    expect(flat(calls[0].q)).toBe("SELECT status, about, link, terms, applied_at, decided_at, seen_at, created_at FROM trainer_applications WHERE account_id = ?");
    reply = () => [];
    expect(await s.dbTrainerApplication(T)).toBeNull();
    reply = () => [{ n: 7 }];
    expect(await s.dbOpenApplicationCount()).toBe(7);
    expect(flat(calls[2].q)).toBe("SELECT count(*)::int AS n FROM trainer_applications WHERE status = 'applied'");
  });

  it("dbListApplications: waiting oldest first, the last 50 decided newest first; the live handle as the name, age in days", async () => {
    reply = (q) => (/ta\.status = 'applied'/.test(q)
      ? [{ account_id: T, status: "applied", about: "Gym", link: null, applied_at: String(NOW - DAY), decided_at: null,
        account_created_at: new Date(NOW - 12.5 * DAY), handle: "kim", display: "Kim" }]
      : [{ account_id: "hwa_x", status: "withdrawn", about: null, link: null, applied_at: "5", decided_at: "6",
        account_created_at: new Date(NOW - DAY / 2), handle: null, display: null }]);
    expect(await s.dbListApplications(NOW)).toEqual({
      open: [{ accountId: T, name: "Kim", accountAge: 12, status: "applied", about: "Gym", link: null, appliedAt: NOW - DAY, decidedAt: null }],
      decided: [{ accountId: "hwa_x", name: null, accountAge: 0, status: "withdrawn", about: null, link: null, appliedAt: 5, decidedAt: 6 }],
    });
    const [open, decided] = calls.map((c) => flat(c.q));
    const from = "FROM trainer_applications ta JOIN accounts a ON a.id = ta.account_id "
      + "LEFT JOIN handles h ON h.account_id = ta.account_id AND h.kind = 'primary' AND h.released_at IS NULL";
    const cols = "SELECT ta.account_id, ta.status, ta.about, ta.link, ta.applied_at, ta.decided_at, a.created_at AS account_created_at, h.handle, h.display";
    expect(open).toBe(`${cols} ${from} WHERE ta.status = 'applied' ORDER BY ta.applied_at`);
    expect(decided).toBe(`${cols} ${from} WHERE ta.status <> 'applied' ORDER BY ta.decided_at DESC NULLS LAST LIMIT ?`);
    expect(calls[1].values).toEqual([50]);
  });
});

describe("trainer files: no destructive SQL, every UPDATE named", () => {
  const root = resolve(__dirname, "..");
  const read = (f) => readFileSync(resolve(root, f), "utf8");
  const walk = (d) => (existsSync(resolve(root, d)) ? readdirSync(resolve(root, d)) : []).flatMap((e) => {
    const p = join(d, e);
    return statSync(resolve(root, p)).isDirectory() ? walk(p) : [p];
  });
  const FILES = ["lib/trainer-store.js", "lib/trainer-session.js", "lib/trainer-code.js", "lib/trainer-apply.js", "lib/notices.js",
    ...walk("app/api/trainer"), ...walk("app/api/share"), ...walk("app/api/diag/trainers"), "app/diag-trainers/page.jsx",
    ...walk("app/api/sync/notices")];

  it("no DELETE, DROP or TRUNCATE in lib/trainer-*, lib/notices.js, app/api/trainer, app/api/share, the notices route or the applications admin", () => {
    expect(FILES).toContain("app/api/trainer/invite/route.js");
    expect(FILES).toContain("app/api/sync/notices/route.js");
    expect(FILES).toContain("app/api/trainer/apply/route.js");
    expect(FILES).toContain("app/api/diag/trainers/route.js");
    for (const f of FILES) expect(read(f), f).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b|\bdel\(|removeItem/);
  });

  it("trainer-store's writes are exactly the invite upsert, the cancel UPDATE, the approve transaction, the look ring, the trainer's remove, the roster ring, the notice seen, and the application's apply, withdraw, seen and deny", () => {
    const src = read("lib/trainer-store.js");
    const writes = [...src.matchAll(/q`\s*(INSERT INTO \w+|UPDATE \w+)/g)].map((m) => m[1]);
    expect(writes).toEqual(["INSERT INTO trainer_invites", "UPDATE trainer_invites",
      "UPDATE trainer_invites", "UPDATE oauth_grants", "INSERT INTO oauth_grants",
      "UPDATE oauth_grants", "UPDATE oauth_grants", "UPDATE oauth_grants", "UPDATE oauth_grants",
      "INSERT INTO trainer_applications", "UPDATE trainer_applications", "UPDATE trainer_applications", "UPDATE trainer_applications"]);
    // Each one is named in the header's write list.
    const header = src.slice(0, src.indexOf("import "));
    for (const fn of ["dbIssueInvite", "dbCancelInvite", "dbApproveTrainer", "dbLogFullLook", "dbRosterSignals", "dbRemoveByTrainer", "dbSeenEndedNotice",
      "dbApplyTrainer", "dbWithdrawApplication", "dbSeenApplication", "dbDenyApplication"]) {
      expect(header).toContain(`· ${fn}:`);
    }
  });

  it("lib/notices.js's one write is the mark upsert, named in its header; the notices GET writes nothing", () => {
    const src = read("lib/notices.js");
    const writes = [...src.matchAll(/q`\s*(INSERT INTO \w+|UPDATE \w+)/g)].map((m) => m[1]);
    expect(writes).toEqual(["INSERT INTO notice_marks"]);
    expect(src).toContain("ON CONFLICT (account_id, kind) DO UPDATE SET seen_at = EXCLUDED.seen_at`");
    expect(src.slice(0, src.indexOf("import "))).toContain("· dbMarkSeen:");
    expect(read("app/api/sync/notices/route.js")).not.toMatch(/\bq`|\bsql\(|dbMarkSeen/);
  });

  it("the invite route writes only through the store, and returns the code from issue alone", () => {
    const src = read("app/api/trainer/invite/route.js");
    expect(src).not.toMatch(/\bq`|\bsql\(/);
    expect(src).toContain("json({ code: issued.code, expiresAt: issued.expiresAt })");
  });
});
