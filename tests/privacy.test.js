// The privacy notice makes claims that live in code. If one of these fails,
// the code changed under the notice: update app/privacy/page.jsx with it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EXISTING_HOLDER_CONSENT_TAP } from "../lib/consent.js";
import { matchTokenIdentity } from "../lib/identity.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("privacy notice stays true", () => {
  const page = read("app/privacy/page.jsx");

  it("contact address is the live one", () => {
    expect(page).toContain('CONTACT = "ab@heatwayve.app"');
    expect(page).not.toMatch(/heatwayve\.com/);
  });

  it("server functions run in London, as stated", () => {
    expect(page).toMatch(/server functions that handle your data run in London/);
    expect(read("app/api/sync/route.js")).toContain('preferredRegion = "lhr1"');
  });

  it("video embeds use privacy-enhanced mode, as stated", () => {
    expect(page).toMatch(/privacy-enhanced mode/);
    for (const f of ["components/LibraryVideo.jsx", "components/SessionScreen.jsx"]) {
      const src = read(f);
      expect(src).not.toContain("www.youtube.com/embed/");
      if (src.includes("/embed/")) expect(src).toContain("www.youtube-nocookie.com/embed/");
    }
  });

  it("cookie lifetimes match the notice (sync 30 days, photos 7)", () => {
    expect(page).toMatch(/30 days \(sync\)/);
    expect(page).toMatch(/7 days \(photos\)/);
    expect(read("app/api/photos/route.js")).toContain("maxAge: 7 * 86400");
    expect(read("app/api/sync/route.js")).toContain("maxAge: 30 * 86400");
  });

  it("analytics carry no health data, as stated", () => {
    for (const f of ["components/SessionHost.jsx", "components/ForgeApp.jsx"]) {
      const calls = read(f).match(/track\("session_complete"[^)]*\)/g) || [];
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c).not.toMatch(/readiness|bodyweight/i);
    }
  });

  it("bodyweight stays out of the photo upload URL", () => {
    expect(read("lib/photos.js")).not.toMatch(/params\.set\("bw"/);
    expect(read("app/api/photos/route.js")).toContain('request.headers.get("x-hw-bodyweight")');
  });

  it("health consent is described as the mechanism that records it", () => {
    expect(page).toContain("You give it when you add a passkey.");
    // The notice promises the Profile confirm only while the tap is switched on.
    expect(page.includes("we'll ask you once, on your profile, to confirm")).toBe(EXISTING_HOLDER_CONSENT_TAP);
    expect(page).toContain("Withdraw consent any time by deleting your profile");
    expect(page).not.toContain("which you give by entering it");
    expect(page).toContain("when you gave consent");
    expect(read("lib/consent.js")).toContain('href: "/privacy"');
    expect(read("app/api/auth/register-verify/route.js")).toContain("acceptedConsentVersion(consent)");
    expect(read("app/api/auth/login-verify/route.js")).toContain("acceptedConsentVersion(consent)");
    // "Withdraw by deleting your profile" holds only while every consent
    // record goes with the profile: the Blob credentials doc under the
    // account's folder, and accounts.consent, cleared when the wipe closes it.
    const sync = read("app/api/sync/route.js");
    expect(read("lib/storage-keys.js")).toContain("export const profileDir = (sk) => `forge/profiles/${enc(sk)}/`;");
    expect(read("lib/storage-keys.js")).toContain("export const credentialsPrefix = (sk) => `${profileDir(sk)}credentials`;");
    const wipe = sync.slice(sync.indexOf("export async function DELETE"));
    expect(wipe).toContain("const sk = id.storageKey;");
    expect(wipe).toContain("const dir = profileDir(sk);");
    expect(wipe).toContain("list({ prefix: dir, cursor })");
    expect(wipe).toContain("await del(junk.map((b) => b.url))");
    expect(sync).toContain("/^credentials[^/]*\\.json$/,");
    for (const f of ["app/api/auth/register-verify/route.js", "app/api/auth/login-verify/route.js"]) {
      expect(read(f)).toContain("writeJsonReplacingPrefix(credentialsPrefix(account.storageKey), credentialsPath(account.storageKey),");
    }
    // The age line matches the notice.
    expect(page).toContain("18 and over");
    expect(read("lib/consent.js")).toContain('"Over-18s only."');
  });

  it("deleting the profile closes the account and clears its consent", () => {
    const wipe = read("app/api/sync/route.js").slice(read("app/api/sync/route.js").indexOf("export async function DELETE"));
    // The close runs after the profile's rows go, keyed by the resolved account.
    expect(wipe.indexOf("dbDeleteProfile(")).toBeGreaterThan(-1);
    expect(wipe.indexOf("dbCloseAccount(id.accountId, sk)")).toBeGreaterThan(wipe.indexOf("dbDeleteProfile("));
    // The close clears consent in the same statement that closes the account.
    const store = read("lib/identity-store.js");
    const close = store.slice(store.indexOf("export async function dbCloseAccount"));
    expect(close).toMatch(/UPDATE accounts SET deleted_at = now\(\), consent = NULL\s+WHERE id = \$\{accountId\}/);
    // A closed account resolves to nothing: no token, no handle, no AI grant.
    const t = { profile: "sam", expires: Date.now() + 60_000 };
    const closed = { id: "hwa_" + "a".repeat(26), storageKey: "sam", roles: ["lifter"], plan: "free", deletedAt: "2026-10-02T00:00:00.000Z" };
    expect(matchTokenIdentity(t, closed, undefined, Date.now())).toBeNull();
    expect(matchTokenIdentity(t, { ...closed, deletedAt: null }, undefined, Date.now())).toMatchObject({ storageKey: "sam" });
    expect(store).toMatch(/WHERE h\.handle = \$\{h\} AND h\.released_at IS NULL AND a\.deleted_at IS NULL/);
    expect(read("lib/oauth-credentials.js")).toContain("if (!account || account.deletedAt) return null;");
  });

  it("is linked from the sitemap", () => {
    expect(read("app/sitemap.js")).toContain("/privacy");
  });
});
