// Identity store: null without a DB, handles normalised before SQL, and the
// only writes are the named INSERT / UPDATEs (no DELETE anywhere).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

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

const A_ID = "hwa_" + "a".repeat(26);
const accountRow = { id: A_ID, storage_key: "sam", webauthn_user_id: "uid", roles: ["lifter"], plan: "free",
  consent: null, origin: "backfill", created_at: new Date("2026-10-01T00:00:00Z"), lapsed_at: null, deleted_at: null };

describe("identity store", () => {
  beforeEach(() => { calls.length = 0; reply = () => []; });
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
    expect(calls).toEqual([]);
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

  it("source holds no DELETE and updates only credentials and accounts", () => {
    const src = readFileSync(new URL("../lib/identity-store.js", import.meta.url), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b/);
    expect([...code.matchAll(/UPDATE (\w+)/g)].map((m) => m[1]).sort()).toEqual(["accounts", "credentials"]);
  });
});
