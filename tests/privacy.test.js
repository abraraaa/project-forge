// The privacy notice makes claims that live in code. If one of these fails,
// the code changed under the notice: update app/privacy/page.jsx with it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EXISTING_HOLDER_CONSENT_TAP } from "../lib/consent.js";
import { matchTokenIdentity } from "../lib/identity.js";
import { DETAIL_DAYS, TREND_DAYS, VIEW_KEYS, LOOK_RING } from "../lib/trainer-view.js";
import { TRAINER_COOKIE_OPTS, TRAINER_TTL_MS, TRAINER_CAP_MS } from "../lib/trainer-session.js";

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

  it("the trainer cookie matches the notice (14 days unused, 30 at most)", () => {
    expect(page).toContain("a third keeps your trainer dashboard signed in; it lapses after 14 days unused, or 30 days after you signed in, whichever comes first. None of them tracks you.");
    expect(page).not.toContain("Neither tracks you");
    expect(TRAINER_COOKIE_OPTS.maxAge).toBe(14 * 86400);
    expect(TRAINER_TTL_MS).toBe(14 * 86400000);
    expect(TRAINER_CAP_MS).toBe(30 * 86400000);
    expect(TRAINER_COOKIE_OPTS.httpOnly).toBe(true);
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
    // Trainer sharing has its own consent: recorded on each grant, ended by stopping.
    expect(page).toContain("For a trainer, you give it when you approve them, and withdraw it by stopping sharing.");
    expect(read("lib/trainer-store.js")).toMatch(/INSERT INTO oauth_grants \([^)]*consent_version/);
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

  it("an AI connection ends in the app, not by email", () => {
    expect(page).toContain("Disconnect it any time in AI coaching, on your profile.");
    expect(page).not.toContain("email us to end it sooner");
    expect(read("components/CoachView.jsx")).toContain('"Disconnect"');
    expect(read("app/api/sync/connections/route.js")).toMatch(/disconnect/);
  });

  it("the trainer section matches what a trainer is sent", () => {
    expect(page).toContain('h: "A trainer you add"');
    // The two windows, as the projection cuts them.
    expect(DETAIL_DAYS).toBe(24 * 7);
    expect(TREND_DAYS).toBe(365);
    expect(page).toContain("They see your last 24 weeks of training in full");
    expect(page).toContain("your main-lift trend and bests over 12 months");
    // What they never see: no key for any of it anywhere in the projection.
    expect(page).toContain("They never see your photos, bodyweight, sleep, why you took a breather, what time of day you trained, or your notes.");
    const keys = Object.values(VIEW_KEYS).flat();
    for (const k of keys) expect(k).not.toMatch(/photo|bodyweight|bw|sleep|reason|note|time|startedAt/i);
    expect(VIEW_KEYS.break).toEqual(["start", "endedAt"]);
    // The roster line: last trained, the week against the plan, the 28-day rhythm.
    expect(page).toContain("Their client list shows when you last trained, your sessions this week against your plan, and your recent rhythm.");
    expect(read("components/TrainerView.jsx")).toMatch(/this week`/);
    expect(read("components/TrainerView.jsx")).toMatch(/rhythm \$\{signal\.rhythmPct\}%/);
    // Added with their code and the client's passkey; looks and roster check-ins shown; one-tap stop.
    expect(page).toContain("You add a trainer yourself, with the code they show you and your passkey.");
    expect(page).toContain("Each look, and a once-a-day check-in from their client list, shows on your profile. Stop sharing in one tap");
    expect(read("components/TrainerShareView.jsx")).toContain('l.kind === "roster"');
    expect(page).toContain("What your trainer does with what they see is their responsibility.");
    expect(page).toContain("sharing with a trainer you add");
  });

  it("ending a trainer share deletes nothing, and the record keeps its dates", () => {
    expect(page).toContain("Nothing is deleted when sharing ends.");
    expect(page).toContain(`the last ${LOOK_RING} looks`);
    // Every ending is an UPDATE of the grant row; nothing deletes grant or invite rows.
    for (const f of ["lib/oauth-store.js", "lib/oauth.js", "lib/trainer-store.js", "lib/identity-store.js", "lib/db.js", "app/api/sync/trainer/route.js", "app/api/sync/route.js"]) {
      expect(read(f)).not.toMatch(/DELETE FROM (oauth_grants|trainer_invites)/);
    }
    expect(read("lib/oauth-store.js")).toContain("UPDATE oauth_grants SET revoked_at = ${at} WHERE id = ${id} AND revoked_at IS NULL");
  });

  it("is linked from the sitemap", () => {
    expect(read("app/sitemap.js")).toContain("/privacy");
  });
});
