// tests/token-store-no-db.test.js
// No database configured → sign-in fails closed: nothing is minted anywhere
// else, and no token reads as valid.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const DB_VARS = ["forge_DATABASE_URL", "forge_POSTGRES_URL", "DATABASE_URL", "POSTGRES_URL"];

describe("token store without a DB", () => {
  beforeEach(() => { for (const k of DB_VARS) vi.stubEnv(k, ""); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("mint throws instead of writing a second store", async () => {
    const { mintAuthToken } = await import("../lib/auth-server.js");
    await expect(mintAuthToken({ profile: "sam", ttlMs: 60_000 })).rejects.toThrow(/unavailable/);
  });

  it("no token reads as valid", async () => {
    const { readTokenData, verifyAuthToken } = await import("../lib/auth-server.js");
    expect(await readTokenData("anything")).toBeNull();
    expect(await verifyAuthToken("sam", "anything")).toBe(false);
  });
});
