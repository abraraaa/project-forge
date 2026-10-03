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

describe("trainer files: no destructive SQL, every UPDATE named", () => {
  const root = resolve(__dirname, "..");
  const read = (f) => readFileSync(resolve(root, f), "utf8");
  const walk = (d) => (existsSync(resolve(root, d)) ? readdirSync(resolve(root, d)) : []).flatMap((e) => {
    const p = join(d, e);
    return statSync(resolve(root, p)).isDirectory() ? walk(p) : [p];
  });
  const FILES = ["lib/trainer-store.js", "lib/trainer-session.js", "lib/trainer-code.js", ...walk("app/api/trainer"), ...walk("app/api/share")];

  it("no DELETE, DROP or TRUNCATE in lib/trainer-*, app/api/trainer or app/api/share", () => {
    expect(FILES).toContain("app/api/trainer/invite/route.js");
    for (const f of FILES) expect(read(f), f).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b|\bdel\(|removeItem/);
  });

  it("trainer-store's writes are exactly the invite upsert, the cancel UPDATE, the approve transaction, the look ring, the trainer's remove and the roster ring", () => {
    const src = read("lib/trainer-store.js");
    const writes = [...src.matchAll(/q`\s*(INSERT INTO \w+|UPDATE \w+)/g)].map((m) => m[1]);
    expect(writes).toEqual(["INSERT INTO trainer_invites", "UPDATE trainer_invites",
      "UPDATE trainer_invites", "UPDATE oauth_grants", "INSERT INTO oauth_grants",
      "UPDATE oauth_grants", "UPDATE oauth_grants", "UPDATE oauth_grants"]);
  });

  it("the invite route writes only through the store, and returns the code from issue alone", () => {
    const src = read("app/api/trainer/invite/route.js");
    expect(src).not.toMatch(/\bq`|\bsql\(/);
    expect(src).toContain("json({ code: issued.code, expiresAt: issued.expiresAt })");
  });
});
