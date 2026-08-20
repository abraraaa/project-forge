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
import { censusPasskeys, photosAtRisk, censusLogLine, IMPLICIT_RP_ID } from "../lib/passkey-census.js";
import { NATIVE_RP_ID } from "../lib/origin.js";

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

describe("photo exposure — the kill list, and nothing more", () => {
  const photo = (profile, date, size = 1000) => ({
    profile, pathname: `forge/profiles/${profile}/photos/${date}.jpg`, size,
  });
  const withCreds = (profile, creds) =>
    blob(profile, "credentials.json", "2026-08-01T00:00:00Z", { credentials: creds });

  it("lists a legacy-only profile's photos as at risk at the sunset", () => {
    const census = censusPasskeys([withCreds("sam", [{ id: "a", publicKey: "k" }])]);
    const r = photosAtRisk(census, [photo("sam", "2026-08-01"), photo("sam", "2026-08-02")]);
    expect(r.atSunset.profiles).toBe(1);
    expect(r.atSunset.photos).toBe(2);
    expect(r.atSunset.rows[0].prefix).toBe("forge/profiles/sam/photos/");
  });

  it("spares a profile that already holds a native passkey", () => {
    const census = censusPasskeys([
      withCreds("ada", [{ id: "a", publicKey: "k" }, { id: "b", publicKey: "k", rpId: NATIVE_RP_ID }]),
    ]);
    const r = photosAtRisk(census, [photo("ada", "2026-08-01")]);
    expect(r.atSunset.profiles).toBe(0);
    expect(r.totals.photos).toBe(1);
  });

  it("keeps already-claimable profiles in a SEPARATE bucket", () => {
    // A profile with only keyless credentials is exposed today, not at the
    // sunset. Merging the two would misdate the risk.
    const census = censusPasskeys([withCreds("kit", [{ id: "a" }])]);
    const r = photosAtRisk(census, [photo("kit", "2026-08-01")]);
    expect(r.atSunset.profiles).toBe(0);
    expect(r.alreadyOpen.profiles).toBe(1);
  });

  it("catches photos under a profile with no credential document at all", () => {
    const r = photosAtRisk(censusPasskeys([]), [photo("ghost", "2026-08-01")]);
    expect(r.alreadyOpen.profiles).toBe(1);
    expect(r.atSunset.profiles).toBe(0);
  });

  it("scopes every proposed prefix with a trailing slash", () => {
    // "sam" must never reach "sammy". The trailing slash is the whole defence.
    const census = censusPasskeys([
      withCreds("sam", [{ id: "a", publicKey: "k" }]),
      withCreds("sammy", [{ id: "b", publicKey: "k" }]),
    ]);
    const r = photosAtRisk(census, [photo("sam", "2026-08-01"), photo("sammy", "2026-08-01")]);
    for (const row of r.atSunset.rows) expect(row.prefix).toMatch(/\/photos\/$/);
    const sam = r.atSunset.rows.find((x) => x.profile === "sam");
    expect(r.atSunset.rows.find((x) => x.profile === "sammy").paths)
      .not.toContain(sam.paths[0]);
  });

  it("never truncates a path list silently", () => {
    const many = Array.from({ length: 25 }, (_, i) => photo("sam", `2026-08-${String(i + 1).padStart(2, "0")}`));
    const census = censusPasskeys([withCreds("sam", [{ id: "a", publicKey: "k" }])]);
    const row = photosAtRisk(census, many).atSunset.rows[0];
    expect(row.photos).toBe(25);
    expect(row.paths).toHaveLength(20);
    expect(row.pathsOmitted).toBe(5);
  });

  it("announces itself as a dry run that deletes nothing", () => {
    const r = photosAtRisk(censusPasskeys([]), []);
    expect(r.dryRun).toBe(true);
    expect(r.deletes).toMatch(/none/i);
  });
});

describe("the daily log line — aggregates, never identities", () => {
  const blobFor = (profile, creds) =>
    blob(profile, "credentials.json", "2026-08-01T00:00:00Z", { credentials: creds });

  it("carries no profile name, path or credential material", () => {
    // Profile name IS the identity here, and a log is retained, searched and
    // rendered in dashboards. The detailed report stays behind the
    // authenticated response; this string goes somewhere much less private.
    const census = censusPasskeys([
      blobFor("verydistinctivename", [{ id: "CRED-ID", publicKey: "PUB-KEY", rpId: NATIVE_RP_ID }]),
    ]);
    const photos = photosAtRisk(census, [{
      profile: "verydistinctivename",
      pathname: "forge/profiles/verydistinctivename/photos/2026-08-01.jpg",
      size: 10,
    }]);
    const line = censusLogLine(census, photos);
    for (const secret of ["verydistinctivename", "CRED-ID", "PUB-KEY", "forge/profiles"]) {
      expect(line).not.toContain(secret);
    }
  });

  it("reports the migration split, which is the number worth watching", () => {
    const census = censusPasskeys([
      blobFor("a", [{ id: "1", publicKey: "k" }]),
      blobFor("b", [{ id: "2", publicKey: "k", rpId: NATIVE_RP_ID }]),
    ]);
    const line = censusLogLine(census, null, new Date("2026-08-20T12:00:00").getTime());
    expect(line).toContain("native=1");
    expect(line).toContain("legacy=1");
    expect(line).toContain("sunsetInDays=88");
  });

  it("is a single greppable line and survives an empty store", () => {
    const line = censusLogLine(censusPasskeys([]), null);
    expect(line).not.toContain("\n");
    expect(line.startsWith("[forge:passkey-census] ")).toBe(true);
    expect(line).toContain("profiles=0");
    // Missing sections must read as zero, never "undefined".
    expect(line).not.toContain("undefined");
  });
});
