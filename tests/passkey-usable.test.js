// hasUsablePasskey gates the auth surfaces; the wipe gate keeps hasRealPasskey.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { hasRealPasskey, hasUsablePasskey } from "../lib/auth-server.js";
import { NATIVE_RP_ID, LEGACY_RP_ID } from "../lib/origin.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(resolve(root, p), "utf8");
const legacy = { id: "l", publicKey: "k" };                     // no rpId field
const native = { id: "n", publicKey: "k", rpId: NATIVE_RP_ID };

describe("hasUsablePasskey — can they still get in", () => {
  it("never counts a legacy credential, labelled or not", () => {
    expect(hasUsablePasskey({ credentials: [legacy] })).toBe(false);
    expect(hasUsablePasskey({ credentials: [{ ...legacy, rpId: LEGACY_RP_ID }] })).toBe(false);
  });

  it("counts a native credential beside a legacy one", () => {
    expect(hasUsablePasskey({ credentials: [legacy, native] })).toBe(true);
    expect(hasUsablePasskey({ credentials: [native] })).toBe(true);
  });

  it("never counts a keyless credential", () => {
    expect(hasUsablePasskey({ credentials: [{ id: "a" }] })).toBe(false);
    expect(hasUsablePasskey({ credentials: [{ id: "a", rpId: NATIVE_RP_ID }] })).toBe(false);
  });

  it("keeps localhost dev credentials working", () => {
    const dev = { id: "d", publicKey: "k", rpId: "localhost" };
    expect(hasUsablePasskey({ credentials: [dev] })).toBe(true);
  });

  it("is null- and empty-safe", () => {
    expect(hasUsablePasskey(null)).toBe(false);
    expect(hasUsablePasskey({ credentials: [] })).toBe(false);
  });
});

describe("hasRealPasskey — was it ever protected (unchanged, and stays that way)", () => {
  it("still counts a legacy credential", () => {
    // Tracking usability here would open the delete path for legacy holders.
    expect(hasRealPasskey({ credentials: [legacy] })).toBe(true);
  });
});

describe("the wipe gate does not relax for legacy credentials", () => {
  it("DELETE /api/sync still gates on hasRealPasskey", () => {
    const route = src("app/api/sync/route.js");
    const del = route.slice(route.indexOf("export async function DELETE"));
    expect(del).toContain("hasRealPasskey(credData)");
    expect(del).not.toContain("hasUsablePasskey");
  });

  it("the surfaces that ask 'can they get in' use the usability predicate", () => {
    expect(src("app/api/auth/check/route.js")).toContain("hasUsablePasskey");
    expect(src("app/api/auth/register-verify/route.js")).toContain("hasUsablePasskey(existing)");
  });
});
