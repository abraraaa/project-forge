// Pure identity helpers and the token-to-account match every gate will use.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  base32lower, newAccountId, newWebauthnUserId, legacyUserHandle, isAccountId,
  RESERVED_HANDLE_RE, matchTokenIdentity,
} from "../lib/identity.js";

describe("account ids", () => {
  it("1,000 fresh ids are well-formed and unique", () => {
    const ids = Array.from({ length: 1000 }, () => newAccountId());
    for (const id of ids) {
      expect(id).toMatch(/^hwa_[a-z2-7]{26}$/);
      expect(isAccountId(id)).toBe(true);
    }
    expect(new Set(ids).size).toBe(1000);
  });

  it("base32 of 16 zero bytes is 26 a's; RFC 4648 vectors hold", () => {
    expect(base32lower(new Uint8Array(16))).toBe("a".repeat(26));
    expect(base32lower(Buffer.from("foobar"))).toBe("mzxw6ytboi");
    expect(base32lower(Buffer.from("f"))).toBe("my");
    expect(base32lower(new Uint8Array(16).fill(255))).toBe("7".repeat(25) + "4");
  });

  it("isAccountId rejects near misses; the hwa_ prefix is reserved for handles", () => {
    for (const s of ["hwa_" + "a".repeat(25), "HWA_" + "a".repeat(26), "hwa_" + "1".repeat(26), null, 42]) {
      expect(isAccountId(s)).toBe(false);
    }
    expect(RESERVED_HANDLE_RE.test("hwa_abc")).toBe(true);
    expect(RESERVED_HANDLE_RE.test("sam")).toBe(false);
  });

  it("webauthn user ids are 32 random bytes, base64url", () => {
    const a = newWebauthnUserId();
    expect(Buffer.from(a, "base64url").length).toBe(32);
    expect(a).not.toBe(newWebauthnUserId());
  });

  it("legacyUserHandle is today's user.id", () => {
    expect(legacyUserHandle("sam")).toBe(createHash("sha256").update("sam").digest("base64url"));
  });
});

describe("matchTokenIdentity", () => {
  const now = 1_000_000;
  const A = { id: "hwa_" + "a".repeat(26), storageKey: "sam", roles: ["lifter"], plan: "free", deletedAt: null };
  const B = { id: "hwa_" + "b".repeat(26), storageKey: "hwa_" + "b".repeat(26), roles: ["lifter"], plan: "free", deletedAt: null };
  const live = { expires: now + 1 };
  const identityOf = (acct, handle) => ({ accountId: acct.id, storageKey: acct.storageKey, handle, roles: acct.roles, plan: acct.plan });

  it("(a) account token + handle on the same account → identity", () => {
    expect(matchTokenIdentity({ ...live, profile: "sam", accountId: A.id }, A, { handle: "sam", accountId: A.id }, now))
      .toEqual(identityOf(A, "sam"));
  });

  it("(b) handle row on another account → null", () => {
    expect(matchTokenIdentity({ ...live, profile: "sam", accountId: A.id }, A, { handle: "sam", accountId: B.id }, now)).toBeNull();
  });

  it("an account token presented against a different account → null", () => {
    expect(matchTokenIdentity({ ...live, profile: B.storageKey, accountId: B.id }, A, undefined, now)).toBeNull();
  });

  it("(c) legacy {profile} row with matching storage key → identity", () => {
    expect(matchTokenIdentity({ ...live, profile: "sam" }, A, { handle: "sam", accountId: A.id }, now))
      .toEqual(identityOf(A, "sam"));
  });

  it("(d) legacy row, handle now held by account B → null", () => {
    expect(matchTokenIdentity({ ...live, profile: "sam" }, A, { handle: "sam", accountId: B.id }, now)).toBeNull();
    // and the legacy row never reaches B's account
    expect(matchTokenIdentity({ ...live, profile: "sam" }, B, { handle: "sam", accountId: B.id }, now)).toBeNull();
  });

  it("(e) expired → null", () => {
    expect(matchTokenIdentity({ expires: now - 1, profile: "sam" }, A, undefined, now)).toBeNull();
  });

  it("(f) deleted account → null", () => {
    expect(matchTokenIdentity({ ...live, profile: "sam" }, { ...A, deletedAt: "2026-10-01T00:00:00.000Z" }, undefined, now)).toBeNull();
  });

  it("(g) snapshot-shaped record (no expires) → null", () => {
    expect(matchTokenIdentity({ profile: "sam", snappedAt: "2026-10-01", meta: {}, history: [] }, A, undefined, now)).toBeNull();
    expect(matchTokenIdentity({ profile: "sam", expires: String(now + 1) }, A, undefined, now)).toBeNull();
  });

  it("(h) no handle named → identity without a handle check", () => {
    expect(matchTokenIdentity({ ...live, profile: "sam" }, A, undefined, now)).toEqual(identityOf(A, null));
  });

  it("a named handle that resolved to nothing → null; missing inputs → null", () => {
    expect(matchTokenIdentity({ ...live, profile: "sam" }, A, null, now)).toBeNull();
    expect(matchTokenIdentity({ ...live, profile: "sam" }, null, undefined, now)).toBeNull();
    expect(matchTokenIdentity(null, A, undefined, now)).toBeNull();
  });
});
