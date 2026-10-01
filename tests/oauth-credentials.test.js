// tests/oauth-credentials.test.js
// An AI grant lives only as long as the passkey that approved it can still
// sign in: removed, keyless, or on a domain no longer served all end it.
import { describe, it, expect, vi, beforeEach } from "vitest";

let doc = null;
vi.mock("../lib/blob-utils.js", () => ({ readJsonByPrefix: vi.fn(async () => doc) }));

const { credentialExists } = await import("../lib/oauth-credentials.js");
const { NATIVE_RP_ID, LEGACY_RP_ID } = await import("../lib/origin.js");

const BOTH = [NATIVE_RP_ID, LEGACY_RP_ID];
const AFTER_SUNSET = [NATIVE_RP_ID];
const cred = (id, rpId, publicKey = "pk") => ({ id, publicKey, rpId });

describe("credentialExists", () => {
  beforeEach(() => { doc = null; });

  it("a native passkey on the profile keeps its grant", async () => {
    doc = { credentials: [cred("n1", NATIVE_RP_ID)] };
    expect(await credentialExists("sam", "n1", AFTER_SUNSET)).toBe(true);
  });

  it("an old-domain passkey keeps its grant only while that domain is served", async () => {
    doc = { credentials: [cred("l1", LEGACY_RP_ID)] };
    expect(await credentialExists("sam", "l1", BOTH)).toBe(true);
    expect(await credentialExists("sam", "l1", AFTER_SUNSET)).toBe(false);
  });

  it("a record without an rpId reads as the old domain", async () => {
    doc = { credentials: [{ id: "x1", publicKey: "pk" }] };
    expect(await credentialExists("sam", "x1", BOTH)).toBe(true);
    expect(await credentialExists("sam", "x1", AFTER_SUNSET)).toBe(false);
  });

  it("a removed or keyless passkey ends the grant", async () => {
    doc = { credentials: [cred("n1", NATIVE_RP_ID), cred("k1", NATIVE_RP_ID, "")] };
    expect(await credentialExists("sam", "gone", BOTH)).toBe(false);
    expect(await credentialExists("sam", "k1", BOTH)).toBe(false);
    doc = null;
    expect(await credentialExists("sam", "n1", BOTH)).toBe(false);
  });

  it("missing inputs never match", async () => {
    doc = { credentials: [cred("n1", NATIVE_RP_ID)] };
    expect(await credentialExists("", "n1", BOTH)).toBe(false);
    expect(await credentialExists("sam", "", BOTH)).toBe(false);
  });
});
