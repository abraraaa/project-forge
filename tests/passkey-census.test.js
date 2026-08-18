// tests/passkey-census.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The passkey census. Two things are pinned here, and the second matters more
// than the first.
//
//   1. The counting is right — in particular it tallies only the AUTHORITATIVE
//      document per profile, the one a real ceremony resolves. A stray sibling
//      left by a failed sweep must never inflate the count.
//
//   2. The route stays READ ONLY. The 2026-07-09 incident was a job that read
//      like a caretaker and shipped with delete authority; it sat unarmed for
//      weeks and then removed every user's passkey on its first real run. A
//      census is the exact shape of thing that acquires a "while we're here"
//      cleanup later. It does not get to. This test is the lock.
//
//   3. Nothing identifying leaves the process. A census needs counts, not
//      credential ids or public keys.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { censusPasskeys, IMPLICIT_RP_ID } from "../lib/passkey-census.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const routeSrc = readFileSync(resolve(root, "app/api/diag/passkey-census/route.js"), "utf8");

const blob = (profile, name, uploadedAt, doc, size = 100) => ({
  profile, pathname: `forge/profiles/${profile}/${name}`, uploadedAt, size, doc,
});

describe("passkey census — the route can never delete", () => {
  it("imports no writer from the blob SDK", () => {
    const imports = routeSrc.match(/import\s*\{[^}]*\}\s*from\s*"@vercel\/blob"/s)?.[0] || "";
    expect(imports).toContain("list");
    for (const writer of ["put", "del", "copy"]) {
      expect(imports).not.toMatch(new RegExp(`\\b${writer}\\b`));
    }
  });

  it("calls no destructive or mutating operation anywhere in the file", () => {
    for (const banned of [/\bdel\s*\(/, /\bput\s*\(/, /\bdeleteByPrefix\b/, /\bwriteJson/, /\bDROP\b/]) {
      expect(routeSrc).not.toMatch(banned);
    }
  });

  it("exposes only GET — no method that implies a mutation", () => {
    const methods = [...routeSrc.matchAll(/export async function ([A-Z]+)/g)].map((m) => m[1]);
    expect(methods).toEqual(["GET"]);
  });

  it("fails closed when CRON_SECRET is unset, and checks the bearer", () => {
    expect(routeSrc).toContain("CRON_SECRET not configured");
    expect(routeSrc).toContain('`Bearer ${cronSecret}`');
  });

  it("scopes its listing to the credentials it owns, never the whole store", () => {
    expect(routeSrc).toContain('prefix: "forge/profiles/"');
    // A trailing slash on the prefix and a filename match: the census cannot
    // wander into a sibling namespace or a profile whose name merely shares a
    // stem with another.
    expect(routeSrc).toMatch(/\^forge\\\/profiles\\\/\(\[\^\/\]\+\)\\\/credentials/);
  });
});

describe("passkey census — counting", () => {
  it("counts only the authoritative document, never a stray sibling", () => {
    const r = censusPasskeys([
      blob("sam", "credentials-new.json", "2026-08-01T00:00:00Z", {
        credentials: [{ id: "A", publicKey: "k", createdAt: "2026-08-01T00:00:00Z" }],
      }),
      // Older sibling from a sweep that failed — invisible to a ceremony.
      blob("sam", "credentials-old.json", "2026-06-01T00:00:00Z", {
        credentials: [{ id: "B", publicKey: "k" }, { id: "C", publicKey: "k" }],
      }),
    ]);
    expect(r.totals.credentials).toBe(1);
    expect(r.totals.credentialBlobs).toBe(2);
    expect(r.totals.straySiblings).toBe(1);
  });

  it("separates keyless legacy credentials from verifiable ones", () => {
    const r = censusPasskeys([
      blob("ada", "credentials.json", "2026-08-01T00:00:00Z", {
        credentials: [
          { id: "A", publicKey: "k", createdAt: "2026-08-02T00:00:00Z" },
          { id: "B", createdAt: "2026-05-02T00:00:00Z" },            // pre-verification
          { id: "C", publicKey: "", createdAt: "2026-05-03T00:00:00Z" }, // empty key is not a key
        ],
      }),
    ]);
    expect(r.totals.verifiable).toBe(1);
    expect(r.totals.keylessLegacy).toBe(2);
    // Mirrors hasRealPasskey: one verifiable credential is protection.
    expect(r.totals.profilesProtected).toBe(1);
  });

  it("reports a profile whose only credentials are keyless as unprotected", () => {
    const r = censusPasskeys([
      blob("kit", "credentials.json", "2026-08-01T00:00:00Z", { credentials: [{ id: "A" }] }),
    ]);
    expect(r.totals.profilesProtected).toBe(0);
    expect(r.totals.profilesWithNoVerifiableCredential).toBe(1);
  });

  it("treats an unlabelled credential as bound to the legacy domain", () => {
    // The honest reading: nothing ever wrote an rpId field, and every ceremony
    // declares theforged.fit — so absent is not unknown.
    const r = censusPasskeys([
      blob("sam", "credentials.json", "2026-08-01T00:00:00Z", {
        credentials: [{ id: "A", publicKey: "k" }, { id: "B", publicKey: "k", rpId: "heatwayve.app" }],
      }),
    ]);
    expect(r.totals.rpIds[IMPLICIT_RP_ID]).toBe(1);
    expect(r.dependency.credentialsBoundToLegacyDomain).toBe(1);
    expect(r.dependency.credentialsNativeToHeatwayve).toBe(1);
  });

  it("splits minting either side of the flip", () => {
    const r = censusPasskeys([
      blob("sam", "credentials.json", "2026-08-01T00:00:00Z", {
        credentials: [
          { id: "A", publicKey: "k", createdAt: "2026-07-01T00:00:00Z" },
          { id: "B", publicKey: "k", createdAt: "2026-08-01T00:00:00Z" },
          { id: "C", publicKey: "k" },
        ],
      }),
    ], "2026-07-26");
    expect(r.totals.mintedPreFlip).toBe(1);
    expect(r.totals.mintedPostFlip).toBe(1);
    expect(r.totals.undated).toBe(1);
  });

  it("survives an unreadable document without losing the rest of the store", () => {
    const r = censusPasskeys([
      blob("ada", "credentials.json", "2026-08-01T00:00:00Z", null),
      blob("sam", "credentials.json", "2026-08-01T00:00:00Z", { credentials: [{ id: "A", publicKey: "k" }] }),
    ]);
    expect(r.totals.unreadableDocuments).toBe(1);
    expect(r.totals.credentials).toBe(1);
    expect(r.totals.profilesWithCredentialBlobs).toBe(2);
  });

  it("is empty-safe", () => {
    const r = censusPasskeys([]);
    expect(r.totals.credentials).toBe(0);
    expect(r.totals.profilesWithCredentialBlobs).toBe(0);
  });

  it("emits no credential id, public key or transport anywhere in the report", () => {
    const r = censusPasskeys([
      blob("sam", "credentials.json", "2026-08-01T00:00:00Z", {
        credentials: [{
          id: "CREDENTIAL-ID-SECRET",
          publicKey: "PUBLIC-KEY-SECRET",
          transports: ["internal"],
          createdAt: "2026-08-01T00:00:00Z",
        }],
      }),
    ]);
    const dumped = JSON.stringify(r);
    expect(dumped).not.toContain("CREDENTIAL-ID-SECRET");
    expect(dumped).not.toContain("PUBLIC-KEY-SECRET");
    expect(dumped).not.toContain("internal");
  });
});
