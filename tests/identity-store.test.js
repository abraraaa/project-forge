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
    // handles: each release pinned by its whole scope — the claim's expired
    // alias, a reclaim's release of the lapsed account's own row, and the
    // close's release of the closed account's own rows.
    expect([...code.matchAll(/UPDATE handles SET ([^\n]*)\s+(WHERE [^`]*)`/g)].map((m) => [m[1].trim(), m[2].replace(/\s+/g, " ").trim()])).toEqual([
      ["released_at = now()", "WHERE handle = ${h} AND kind = 'alias' AND hold_until <= now() AND released_at IS NULL"],
      ["released_at = now()", "WHERE handle = ${h} AND account_id = ${fromAccountId} AND released_at IS NULL"],
      ["released_at = now()", "WHERE account_id = ${accountId} AND released_at IS NULL"],
    ]);
    // Grants are revoked only by the close, scoped to the account (or its legacy storage-key rows).
    expect([...code.matchAll(/UPDATE oauth_grants SET ([^\n]*)\s+(WHERE [^`]*)`/g)].map((m) => [m[1].trim(), m[2].replace(/\s+/g, " ").trim()])).toEqual([
      ["revoked_at = ${nowMs}", "WHERE (account_id = ${accountId} OR (account_id IS NULL AND profile = ${storageKey})) AND revoked_at IS NULL"],
    ]);
  });

  describe("dbCloseAccount", () => {
    beforeEach(() => { process.env.DATABASE_URL = "postgres://fake"; });

    it("one transaction: revoke grants, release handles, close and clear consent, delete credentials", async () => {
      const { dbCloseAccount } = await import("../lib/identity-store.js");
      const before = Date.now();
      expect(await dbCloseAccount(A_ID, "sam")).toBe(true);
      expect(txns).toEqual([4]);
      expect(calls.map((c) => c.q.replace(/\s+/g, " ").trim())).toEqual([
        "UPDATE oauth_grants SET revoked_at = ? WHERE (account_id = ? OR (account_id IS NULL AND profile = ?)) AND revoked_at IS NULL",
        "UPDATE handles SET released_at = now() WHERE account_id = ? AND released_at IS NULL",
        "UPDATE accounts SET deleted_at = now(), consent = NULL WHERE id = ?",
        "DELETE FROM credentials WHERE account_id = ?",
      ]);
      const [revokedAt, ...grantScope] = calls[0].values;
      expect(revokedAt).toBeGreaterThanOrEqual(before);
      expect(grantScope).toEqual([A_ID, "sam"]);
      expect(calls.slice(1).map((c) => c.values)).toEqual([[A_ID], [A_ID], [A_ID]]);
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
