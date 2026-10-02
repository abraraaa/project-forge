// Explicit consent at passkey setup: the copy, the server-side validation,
// and the source pins that keep consent claimed only where the line shows
// and stamped only by the two verified ceremonies.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  CONSENT_VERSION, CONSENT_COPY, consentClaim, acceptedConsentVersion, consentRecord, isCurrentConsent,
} from "../lib/consent.js";

const root = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const walk = (dir, out = []) => {
  for (const f of readdirSync(resolve(root, dir), { withFileTypes: true })) {
    const rel = join(dir, f.name);
    if (f.isDirectory()) { if (f.name !== "node_modules") walk(rel, out); continue; }
    if (/\.(m?js|jsx)$/.test(f.name)) out.push(rel);
  }
  return out;
};
const filesContaining = (dirs, needle, exclude = []) =>
  dirs.flatMap((d) => walk(d)).filter((f) => !exclude.includes(f) && read(f).includes(needle)).sort();

describe("consent copy", () => {
  it("is the approved wording, in one place", () => {
    expect(CONSENT_VERSION).toBe("2026-09-29");
    expect(CONSENT_COPY.line).toBe("With a passkey, your training, bodyweight and photos live safely with us, and follow you to any device. Only you own access.");
    expect(CONSENT_COPY.age).toBe("Over-18s only.");
    expect(CONSENT_COPY.link).toBe("Full details on how we keep your data safe");
    expect(CONSENT_COPY.href).toBe("/privacy");
    // Placeholders pending the owner's copy pass; pinned so a change is deliberate.
    expect(CONSENT_COPY.confirm).toBe("Yes, keep it for me");
    expect(CONSENT_COPY.confirmed).toBe("Kept.");
    expect(CONSENT_COPY.holderLine).toBe("One thing we didn't ask when you set up your passkey. We keep your training, bodyweight and photos with us so they follow you to any device. Only you own access. Happy for us to keep going?");
    for (const v of Object.values(CONSENT_COPY)) expect(v).not.toMatch(/server/i);
  });

  it("the client claim carries the current version", () => {
    expect(consentClaim()).toEqual({ version: CONSENT_VERSION });
  });
});

describe("acceptedConsentVersion", () => {
  it("accepts only the current version, as a string on an object", () => {
    expect(acceptedConsentVersion({ version: CONSENT_VERSION })).toBe(CONSENT_VERSION);
    for (const bad of [undefined, null, "2026-09-29", {}, { version: 20260929 }, { version: "1999-01-01" }, [CONSENT_VERSION]]) {
      expect(acceptedConsentVersion(bad)).toBeNull();
    }
  });
});

describe("consentRecord / isCurrentConsent", () => {
  it("returns only the two known fields, or null", () => {
    expect(consentRecord({ consent: { version: "v", at: "t", x: 1 } })).toEqual({ version: "v", at: "t" });
    for (const bad of [null, {}, { consent: { version: "v" } }, { consent: "yes" }]) {
      expect(consentRecord(bad)).toBeNull();
    }
  });

  it("isCurrentConsent reads only the version", () => {
    expect(isCurrentConsent({ version: CONSENT_VERSION })).toBe(true);
    expect(isCurrentConsent(null)).toBe(false);
    expect(isCurrentConsent({ version: "1999-01-01" })).toBe(false);
  });
});

describe("only verified ceremonies stamp consent", () => {
  const VERIFY_ROUTES = ["app/api/auth/login-verify/route.js", "app/api/auth/register-verify/route.js"];

  it("only the two verify routes import the stamping helper", () => {
    expect(filesContaining(["app/api"], "acceptedConsentVersion")).toEqual(VERIFY_ROUTES);
  });

  it("only those two routes write the credentials doc", () => {
    expect(filesContaining(["app", "lib", "scripts"], "writeJsonReplacingPrefix(credentialsPrefix(")).toEqual(VERIFY_ROUTES);
    // Any writer must name the path (addRandomSuffix appends to it). The
    // literal lives only in lib/storage-keys; only the verify routes use it.
    expect(read("lib/storage-keys.js")).toContain("export const credentialsPath = (sk) => `${credentialsPrefix(sk)}.json`;");
    expect(filesContaining(["app", "lib", "scripts"], "credentialsPath(", ["lib/storage-keys.js"])).toEqual(VERIFY_ROUTES);
  });

  it("both writers spread the existing doc, and login-verify keeps a single write", () => {
    const reg = read("app/api/auth/register-verify/route.js");
    const login = read("app/api/auth/login-verify/route.js");
    expect(reg).toContain("{ ...existing, credentials:");
    expect(login).toContain("...credData,");
    expect(login.match(/writeJsonReplacingPrefix\(/g) || []).toHaveLength(1);
  });

  it("register-verify fails closed on an unreadable doc, before the gate", () => {
    const reg = read("app/api/auth/register-verify/route.js");
    expect(reg).toContain("if (read === null)");
    expect(reg).toContain("status: 503");
    expect(reg.indexOf("if (read === null)")).toBeLessThan(reg.indexOf("hasUsablePasskey(existing)"));
  });

  it("neither verify route deletes anything but its own challenge", () => {
    for (const f of VERIFY_ROUTES) {
      expect(read(f).match(/deleteByPrefix\([^)]*\)/g), f).toEqual(["deleteByPrefix(challengeKey)"]);
    }
    const reg = read("app/api/auth/register-verify/route.js");
    // put: only the reclaim's no-overwrite claim marker. Never del.
    expect(reg.match(/^import .* from "@vercel\/blob";$/gm)).toEqual(['import { put } from "@vercel/blob";']);
    expect(reg).not.toContain("allowOverwrite");
  });
});

describe("consent is claimed only where the line shows", () => {
  const CLAIMERS = ["components/BodyweightEditModal.jsx", "components/ForgeApp.jsx", "components/ProfileScreen.jsx"];

  it("only the surfaces that render ConsentLine build a claim", () => {
    expect(filesContaining(["components", "lib", "app"], "consentClaim(", ["lib/consent.js"])).toEqual(CLAIMERS);
    expect(read("components/PasskeyUpgrade.jsx")).not.toContain("consentClaim");
  });

  it("every registration in those files carries the claim", () => {
    for (const f of CLAIMERS) {
      const calls = read(f).match(/await registerPasskey\(([^()]|\([^()]*\))*\)/g) || [];
      expect(calls.length, f).toBeGreaterThan(0);
      for (const c of calls) expect(c, f).toContain(", null, { consent: consentClaim() })");
    }
  });

  it("only the Profile quiet tap passes a claim to the sign-in ceremony", () => {
    const hits = [];
    for (const f of ["components", "lib", "app"].flatMap((d) => walk(d))) {
      if (f === "lib/webauthn.js") continue;
      // Balanced to one nesting level; a call this can't read fails the count.
      const src = read(f);
      const calls = src.match(/authenticatePasskey\(([^()]|\([^()]*\))*\)/g) || [];
      expect(calls.length, f).toBe((src.match(/authenticatePasskey\(/g) || []).length);
      for (const c of calls) if (c.slice(20, -1).replace(/\([^()]*\)/g, "").includes(",")) hits.push(`${f}: ${c}`);
    }
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^components\/ProfileScreen\.jsx: /);
    expect(hits[0]).toContain("authenticatePasskey(current, { consent: consentClaim() })");
  });

  it("the quiet tap is the only sign-in claim trigger, and sits behind the flag", () => {
    const src = read("components/ProfileScreen.jsx");
    expect(src).toContain("const askConsent = EXISTING_HOLDER_CONSENT_TAP && ");
    expect(src.match(/onClick=\{handleConfirmConsent\}/g) || []).toHaveLength(1);
    expect(src.match(/handleConfirmConsent/g) || []).toHaveLength(2);
    const gate = src.indexOf("{askConsent && (");
    const tap = src.indexOf("onClick={handleConfirmConsent}");
    expect(gate).toBeGreaterThan(-1);
    expect(tap - gate).toBeGreaterThan(0);
    expect(tap - gate).toBeLessThanOrEqual(200);
  });

  it("the name-status line keeps its live region", () => {
    // The consent acknowledgement adds a second role="status"; pin the original.
    expect(read("components/ProfileScreen.jsx")).toContain('id="name-status" role="status" aria-live="polite"');
  });

  it("ConsentLine renders on every add-a-passkey surface", () => {
    const count = (f) => (read(f).match(/<ConsentLine/g) || []).length;
    expect(count("components/ProfileScreen.jsx")).toBe(3);
    expect(count("components/HomeScreen.jsx")).toBe(1);
    expect(count("components/BodyweightEditModal.jsx")).toBe(1);
  });

  it("every consenting button points at its statement", () => {
    const pairs = [
      ["components/ProfileScreen.jsx", 'aria-describedby="consent-onboarding"', "consent-onboarding"],
      ["components/ProfileScreen.jsx", 'aria-describedby="consent-profile"', "consent-profile"],
      ["components/ProfileScreen.jsx", 'aria-describedby="consent-confirm"', "consent-confirm"],
      ["components/HomeScreen.jsx", 'aria-describedby="consent-home"', "consent-home"],
      ["components/BodyweightEditModal.jsx", 'describedBy: "bw-consent"', "bw-consent"],
    ];
    for (const [f, attr, id] of pairs) {
      const src = read(f);
      expect(src, f).toContain(attr);
      expect(src, f).toContain(`<ConsentLine id="${id}"`);
    }
  });
});
