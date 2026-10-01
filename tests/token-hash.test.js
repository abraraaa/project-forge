// Sign-in tokens are stored hashed (2026-09-27): a database read never yields
// a usable cookie. Legacy raw rows keep working until they age out.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

const table = new Map();
vi.mock("@neondatabase/serverless", () => ({
  neon: () => async (strings, ...values) => {
    const q = strings.join("?");
    if (q.includes("INSERT INTO auth_tokens")) { table.set(values[0], { profile: values[1], expires: values[2], scope: values[3], created_at: values[4], auth_at: values[5], credential_id: values[6], account_id: values[7] }); return []; }
    if (q.includes("DELETE FROM auth_tokens")) { table.delete(values[0]); if (values[1] != null) table.delete(values[1]); return []; }
    if (q.includes("FROM auth_tokens")) { const r = table.get(values[0]) || (values[1] != null ? table.get(values[1]) : undefined); return r ? [r] : []; }
    return [];
  },
}));

const sha = (t) => createHash("sha256").update(t).digest("hex");

describe("sign-in tokens at rest", () => {
  beforeEach(() => { table.clear(); process.env.DATABASE_URL = "postgres://fake"; });
  afterEach(() => { delete process.env.DATABASE_URL; });

  it("stores the hash, never the token, and reads it back", async () => {
    const { dbInsertToken, dbReadToken } = await import("../lib/db.js");
    await dbInsertToken("tok-abc", { profile: "sam", expires: 9e12, scope: "sync" });
    expect(table.has("tok-abc")).toBe(false);
    expect(table.has(sha("tok-abc"))).toBe(true);
    expect((await dbReadToken("tok-abc"))?.profile).toBe("sam");
  });

  it("a legacy raw row still reads and consumes", async () => {
    const { dbReadToken, dbDeleteToken } = await import("../lib/db.js");
    table.set("legacy-tok", { profile: "sam", expires: 9e12, scope: null, created_at: "2026-09-01T00:00:00.000Z" });
    expect((await dbReadToken("legacy-tok"))?.profile).toBe("sam");
    await dbDeleteToken("legacy-tok");
    expect(await dbReadToken("legacy-tok")).toBeNull();
  });

  it("carries the account id: written when given, absent on legacy rows", async () => {
    const { dbInsertToken, dbReadToken } = await import("../lib/db.js");
    await dbInsertToken("tok-acc", { profile: "sam", expires: 9e12, scope: "sync", accountId: "hwa_" + "a".repeat(26) });
    expect(table.get(sha("tok-acc"))?.account_id).toBe("hwa_" + "a".repeat(26));
    expect((await dbReadToken("tok-acc"))?.accountId).toBe("hwa_" + "a".repeat(26));
    await dbInsertToken("tok-old", { profile: "sam", expires: 9e12 });
    expect(table.get(sha("tok-old"))?.account_id).toBeNull();
    const legacy = await dbReadToken("tok-old");
    expect(legacy?.profile).toBe("sam");
    expect(legacy && "accountId" in legacy).toBe(false);
  });

  it("knowing the stored hash doesn't sign you in", async () => {
    const { dbInsertToken, dbReadToken } = await import("../lib/db.js");
    await dbInsertToken("tok-xyz", { profile: "sam", expires: 9e12 });
    // The hash is not a valid token: presenting it looks up sha(sha(t)).
    expect(await dbReadToken(sha("tok-xyz")).then((r) => r?.profile)).not.toBe("sam");
  });
});
