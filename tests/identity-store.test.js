// Identity store: null without a DB, handles normalised before SQL, and the
// only writes are the named INSERT / UPDATEs, plus the one DELETE the profile
// wipe's close runs on the closed account's own credentials rows.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const calls = [];
const txns = [];
let reply = () => [];
let txnError = null;
vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    const tag = async (strings, ...values) => {
      const q = strings.join("?");
      if (/^\s*(CREATE|ALTER)\b/.test(q)) return [];
      calls.push({ q, values });
      return reply(q, values);
    };
    // The statements are built (and recorded) by the caller; the batch either
    // fails whole or resolves to one result per statement.
    tag.transaction = async (queries) => {
      txns.push(queries.length);
      const results = await Promise.all(queries);
      if (txnError) throw txnError;
      return results;
    };
    return tag;
  },
}));

const A_ID = "hwa_" + "a".repeat(26);
const accountRow = { id: A_ID, storage_key: "sam", webauthn_user_id: "uid", roles: ["lifter"], plan: "free",
  consent: null, origin: "backfill", created_at: new Date("2026-10-01T00:00:00Z"), lapsed_at: null, deleted_at: null };

describe("identity store", () => {
  beforeEach(() => { calls.length = 0; txns.length = 0; reply = () => []; txnError = null; });
  afterEach(() => { delete process.env.DATABASE_URL; });

  it("returns null for every function with no DB", async () => {
    const s = await import("../lib/identity-store.js");
    expect(await s.dbResolveHandle("sam")).toBeNull();
    expect(await s.dbGetAccount(A_ID)).toBeNull();
    expect(await s.dbAccountByStorageKey("sam")).toBeNull();
    expect(await s.dbListCredentials(A_ID)).toBeNull();
    expect(await s.dbInsertCredential({ id: "c", accountId: A_ID, publicKey: "pk", rpId: "heatwayve.app", userHandle: "u" })).toBeNull();
    expect(await s.dbTouchCredential(A_ID, "c", { counter: 1 })).toBeNull();
    expect(await s.dbSetAccountConsent(A_ID, null)).toBeNull();
    expect(await s.dbClaimHandle({ handle: "sam", display: "Sam", mode: "precutover" })).toBeNull();
    expect(await s.dbCloseAccount(A_ID, "sam")).toBeNull();
    expect(await s.dbGrantTrainerRole(A_ID, { version: "v", at: "2026-10-03T00:00:00.000Z", adult: true })).toBeNull();
    expect(await s.dbPrimaryHandle(A_ID)).toBeNull();
    expect(calls).toEqual([]);
    expect(txns).toEqual([]);
  });

  it("normalises the handle before it reaches SQL and maps the row", async () => {
    process.env.DATABASE_URL = "postgres://fake";
    reply = () => [{ ...accountRow, handle: "sam", display: "Sam", kind: "primary", claimed_at: "2026-09-01T00:00:00.000Z", hold_until: null }];
    const { dbResolveHandle } = await import("../lib/identity-store.js");
    const r = await dbResolveHandle("  ＳＡＭ ");
    expect(calls[0].values).toEqual(["sam"]);
    expect(calls[0].q).toMatch(/released_at IS NULL AND a\.deleted_at IS NULL/);
    expect(r).toMatchObject({ id: A_ID, accountId: A_ID, storageKey: "sam", handle: "sam", display: "Sam", roles: ["lifter"], plan: "free", deletedAt: null });
  });

  it("accounts carry their trainer terms record, null when absent", async () => {
    process.env.DATABASE_URL = "postgres://fake";
    const { dbGetAccount } = await import("../lib/identity-store.js");
    expect((await dbGetAccount(A_ID)) ?? "no row").toBe("no row");
    reply = () => [accountRow];
    expect(await dbGetAccount(A_ID)).toMatchObject({ id: A_ID, trainerTerms: null, consent: null });
    const terms = { version: "draft-2026-10", at: "2026-10-03T00:00:00.000Z", adult: true };
    reply = () => [{ ...accountRow, roles: ["lifter", "trainer"], trainer_terms: terms }];
    expect(await dbGetAccount(A_ID)).toMatchObject({ roles: ["lifter", "trainer"], trainerTerms: terms });
  });

  describe("dbGrantTrainerRole", () => {
    beforeEach(() => { process.env.DATABASE_URL = "postgres://fake"; });
    const terms = { version: "draft-2026-10", at: "2026-10-03T09:00:00.000Z", adult: true };

    it("one UPDATE on the caller's live row: append the role once, overwrite trainer_terms; plan untouched", async () => {
      const { dbGrantTrainerRole } = await import("../lib/identity-store.js");
      reply = () => [{ id: A_ID }];
      expect(await dbGrantTrainerRole(A_ID, terms)).toBe(true);
      expect(txns).toEqual([]);
      expect(calls).toHaveLength(1);
      expect(calls[0].q.replace(/\s+/g, " ").trim()).toBe(
        "UPDATE accounts SET roles = CASE WHEN 'trainer' = ANY(roles) THEN roles ELSE array_append(roles, 'trainer') END, "
        + "trainer_terms = ?::jsonb WHERE id = ? AND deleted_at IS NULL RETURNING id");
      expect(calls[0].q).not.toMatch(/\bplan\b|\|\||handles/);
      expect(calls[0].values).toEqual([JSON.stringify(terms), A_ID]);
    });

    it("stores only version, at and adult; a closed account matches nothing", async () => {
      const { dbGrantTrainerRole } = await import("../lib/identity-store.js");
      reply = () => [];
      expect(await dbGrantTrainerRole(A_ID, { ...terms, roles: ["admin"], plan: "pro" })).toBe(false);
      expect(JSON.parse(calls[0].values[0])).toEqual(terms);
    });

    it("refuses missing ids, versions, times or the 18+ attestation before any SQL", async () => {
      const { dbGrantTrainerRole } = await import("../lib/identity-store.js");
      for (const [id, t] of [["", terms], [A_ID, null], [A_ID, { ...terms, version: 1 }], [A_ID, { ...terms, at: undefined }],
        [A_ID, { ...terms, adult: false }], [A_ID, { ...terms, adult: "true" }]]) {
        await expect(dbGrantTrainerRole(id, /** @type {any} */ (t))).rejects.toThrow(/incomplete trainer terms/);
      }
      expect(calls).toEqual([]);
    });
  });

  describe("dbPrimaryHandle", () => {
    beforeEach(() => { process.env.DATABASE_URL = "postgres://fake"; });

    it("reads the account's live primary handle only", async () => {
      const { dbPrimaryHandle } = await import("../lib/identity-store.js");
      reply = () => [{ handle: "sam", display: "Sam", extra: 1 }];
      expect(await dbPrimaryHandle(A_ID)).toEqual({ handle: "sam", display: "Sam" });
      expect(calls[0].q.replace(/\s+/g, " ").trim()).toBe(
        "SELECT handle, display FROM handles WHERE account_id = ? AND kind = 'primary' AND released_at IS NULL");
      expect(calls[0].values).toEqual([A_ID]);
      reply = () => [];
      expect(await dbPrimaryHandle(A_ID)).toBeNull();
      expect(txns).toEqual([]);
    });

    it("is SELECT-only in source", () => {
      const src = readFileSync(new URL("../lib/identity-store.js", import.meta.url), "utf8");
      const fn = src.slice(src.indexOf("export async function dbPrimaryHandle"));
      const body = fn.slice(0, fn.indexOf("\n}"));
      expect(body).toContain("SELECT handle, display FROM handles");
      expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b|transaction/);
    });
  });

  it("credential insert is idempotent on its account and refuses another account's id", async () => {
    process.env.DATABASE_URL = "postgres://fake";
    const { dbInsertCredential } = await import("../lib/identity-store.js");
    const row = { id: "cred1", accountId: A_ID, publicKey: "pk", rpId: "heatwayve.app", userHandle: "u" };
    reply = (q) => (q.includes("INSERT") ? [{ id: "cred1" }] : []);
    expect(await dbInsertCredential(row)).toBe(true);
    expect(calls[0].q).toMatch(/INSERT INTO credentials[\s\S]*ON CONFLICT \(id\) DO NOTHING RETURNING id/);
    reply = (q) => (q.includes("SELECT account_id") ? [{ account_id: A_ID }] : []);
    expect(await dbInsertCredential(row)).toBe(false);
    reply = (q) => (q.includes("SELECT account_id") ? [{ account_id: "hwa_" + "b".repeat(26) }] : []);
    await expect(dbInsertCredential(row)).rejects.toThrow(/another account/);
  });

  it("touch and consent writes are scoped to one account", async () => {
    process.env.DATABASE_URL = "postgres://fake";
    const { dbTouchCredential, dbSetAccountConsent } = await import("../lib/identity-store.js");
    reply = () => [{ id: "x" }];
    expect(await dbTouchCredential(A_ID, "cred1", { counter: 7 })).toBe(true);
    expect(calls[0].q).toMatch(/UPDATE credentials[\s\S]*WHERE id = \? AND account_id = \?/);
    expect(await dbSetAccountConsent(A_ID, { version: "v1", at: "2026-10-01" })).toBe(true);
    expect(calls[1].q).toMatch(/UPDATE accounts SET consent = \?::jsonb\s+WHERE id = \?/);
    expect(calls[1].values).toEqual([JSON.stringify({ version: "v1", at: "2026-10-01" }), A_ID]);
  });

  it("source holds one DELETE, inside the close; updates touch only credentials, accounts, grants and scoped handle releases", () => {
    const src = readFileSync(new URL("../lib/identity-store.js", import.meta.url), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/\bDROP\b|\bTRUNCATE\b/);
    // Exactly one DELETE in the file: the closed account's own credentials rows, inside dbCloseAccount.
    expect([...code.matchAll(/\bDELETE\b[^`]*/g)].map((m) => m[0])).toEqual(["DELETE FROM credentials WHERE account_id = ${accountId}"]);
    const close = code.slice(code.indexOf("export async function dbCloseAccount"));
    expect(close.slice(0, close.indexOf("\n}"))).toContain("q`DELETE FROM credentials WHERE account_id = ${accountId}`");
    expect(code.slice(0, code.indexOf("export async function dbCloseAccount"))).not.toMatch(/\bDELETE\b/);
    expect([...new Set([...code.matchAll(/UPDATE (\w+)/g)].map((m) => m[1]))].sort()).toEqual(["accounts", "credentials", "handles", "oauth_grants"]);
    // accounts: each write pinned by its whole scope: consent, the trainer upgrade on a live row, and the close.
    expect([...code.matchAll(/UPDATE accounts SET ([\s\S]*?)\s+(WHERE [^`]*)`/g)].map((m) => [m[1].replace(/\s+/g, " ").trim(), m[2].replace(/\s+/g, " ").trim()])).toEqual([
      ["consent = ${consent == null ? null : JSON.stringify(consent)}::jsonb", "WHERE id = ${accountId} RETURNING id"],
      ["roles = CASE WHEN 'trainer' = ANY(roles) THEN roles ELSE array_append(roles, 'trainer') END, trainer_terms = ${JSON.stringify(rec)}::jsonb",
        "WHERE id = ${accountId} AND deleted_at IS NULL RETURNING id"],
      ["deleted_at = now(), consent = NULL", "WHERE id = ${accountId}"],
    ]);
    // handles: each release pinned by its whole scope — the claim's expired
    // alias, a reclaim's release of the lapsed account's own row, and the
    // close's release of the closed account's own rows.
    expect([...code.matchAll(/UPDATE handles SET ([^\n]*)\s+(WHERE [^`]*)`/g)].map((m) => [m[1].trim(), m[2].replace(/\s+/g, " ").trim()])).toEqual([
      ["released_at = now()", "WHERE handle = ${h} AND kind = 'alias' AND hold_until <= now() AND released_at IS NULL"],
      ["released_at = now()", "WHERE handle = ${h} AND account_id = ${fromAccountId} AND released_at IS NULL"],
      ["released_at = now()", "WHERE account_id = ${accountId} AND released_at IS NULL"],
    ]);
    // Grants are revoked only by the close: the account's own (or its legacy storage-key rows),
    // and the trainer grants that name it as trainer.
    expect([...code.matchAll(/UPDATE oauth_grants SET ([^\n]*)\s+(WHERE [^`]*)`/g)].map((m) => [m[1].trim(), m[2].replace(/\s+/g, " ").trim()])).toEqual([
      ["revoked_at = ${nowMs}", "WHERE (account_id = ${accountId} OR (account_id IS NULL AND profile = ${storageKey})) AND revoked_at IS NULL"],
      ["revoked_at = ${nowMs}, revoked_by = 'closed'", "WHERE kind = 'trainer' AND trainer_account_id = ${accountId} AND revoked_at IS NULL"],
    ]);
  });

  describe("dbCloseAccount", () => {
    beforeEach(() => { process.env.DATABASE_URL = "postgres://fake"; });

    it("one transaction: revoke grants, release handles, close and clear consent, delete credentials, revoke trainer-side grants", async () => {
      const { dbCloseAccount } = await import("../lib/identity-store.js");
      const before = Date.now();
      expect(await dbCloseAccount(A_ID, "sam")).toBe(true);
      expect(txns).toEqual([5]);
      expect(calls.map((c) => c.q.replace(/\s+/g, " ").trim())).toEqual([
        "UPDATE oauth_grants SET revoked_at = ? WHERE (account_id = ? OR (account_id IS NULL AND profile = ?)) AND revoked_at IS NULL",
        "UPDATE handles SET released_at = now() WHERE account_id = ? AND released_at IS NULL",
        "UPDATE accounts SET deleted_at = now(), consent = NULL WHERE id = ?",
        "DELETE FROM credentials WHERE account_id = ?",
        "UPDATE oauth_grants SET revoked_at = ?, revoked_by = 'closed' WHERE kind = 'trainer' AND trainer_account_id = ? AND revoked_at IS NULL",
      ]);
      const [revokedAt, ...grantScope] = calls[0].values;
      expect(revokedAt).toBeGreaterThanOrEqual(before);
      expect(grantScope).toEqual([A_ID, "sam"]);
      expect(calls.slice(1, 4).map((c) => c.values)).toEqual([[A_ID], [A_ID], [A_ID]]);
      // The trainer-side revoke shares the close's timestamp and is keyed by the account id alone.
      expect(calls[4].values).toEqual([revokedAt, A_ID]);
    });

    it("a failed transaction propagates; missing ids throw before any SQL", async () => {
      const { dbCloseAccount } = await import("../lib/identity-store.js");
      txnError = new Error("connection reset");
      await expect(dbCloseAccount(A_ID, "sam")).rejects.toThrow(/connection reset/);
      calls.length = 0; txns.length = 0; txnError = null;
      await expect(dbCloseAccount("", "sam")).rejects.toThrow();
      await expect(dbCloseAccount(A_ID, "")).rejects.toThrow();
      expect(calls).toEqual([]);
      expect(txns).toEqual([]);
    });
  });

  describe("dbClaimHandle", () => {
    beforeEach(() => { process.env.DATABASE_URL = "postgres://fake"; });

    it("pre-cutover: one transaction, alias release then account then handle; storage key = normalised handle", async () => {
      const { dbClaimHandle } = await import("../lib/identity-store.js");
      const r = await dbClaimHandle({ handle: "  ＳＡＭ ", display: "Sam", mode: "precutover" });
      expect(txns).toEqual([3]);
      expect(calls.map((c) => c.q.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
        "UPDATE handles SET", "INSERT INTO accounts", "INSERT INTO handles",
      ]);
      expect(calls[0].q).toMatch(/WHERE handle = \? AND kind = 'alias' AND hold_until <= now\(\) AND released_at IS NULL/);
      expect(calls[0].values).toEqual(["sam"]);
      const [id, sk, uid, origin] = calls[1].values;
      expect(id).toMatch(/^hwa_[a-z2-7]{26}$/);
      expect([sk, origin]).toEqual(["sam", "precutover_claim"]);
      expect(uid).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(calls[1].q).not.toMatch(/roles|plan/); // column defaults: ['lifter'], 'free'
      expect(calls[2].values).toEqual(["sam", id, "Sam"]);
      expect(calls[2].q).not.toMatch(/ON CONFLICT/);
      expect(r).toEqual({ taken: false, accountId: id, storageKey: "sam", webauthnUserId: uid });
    });

    it("cutover mode: the storage key is the new account id", async () => {
      const { dbClaimHandle } = await import("../lib/identity-store.js");
      const r = await dbClaimHandle({ handle: "sam", display: "sam", mode: "claim" });
      const [id, sk, , origin] = calls[1].values;
      expect(sk).toBe(id);
      expect(origin).toBe("claim");
      expect(r).toMatchObject({ taken: false, accountId: id, storageKey: id });
    });

    it("a unique violation is taken; any other failure propagates", async () => {
      const { dbClaimHandle } = await import("../lib/identity-store.js");
      txnError = Object.assign(new Error("duplicate key value violates unique constraint \"handles_live\""), { code: "23505" });
      expect(await dbClaimHandle({ handle: "sam", display: "Sam", mode: "precutover" })).toEqual({ taken: true });
      txnError = Object.assign(new Error("connection reset"), { code: "08006" });
      await expect(dbClaimHandle({ handle: "sam", display: "Sam", mode: "precutover" })).rejects.toThrow(/connection reset/);
    });

    it("refuses reserved and empty handles and unknown modes before any SQL", async () => {
      const { dbClaimHandle } = await import("../lib/identity-store.js");
      await expect(dbClaimHandle({ handle: "HWA_abc", display: "x", mode: "precutover" })).rejects.toThrow();
      await expect(dbClaimHandle({ handle: "  ", display: "x", mode: "precutover" })).rejects.toThrow();
      await expect(dbClaimHandle({ handle: "sam", display: "x", mode: "later" })).rejects.toThrow();
      expect(calls).toEqual([]);
      expect(txns).toEqual([]);
    });
  });
});
