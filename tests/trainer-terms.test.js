// Trainer Terms and share consent: copy pinned with its version, the server
// validators, the launch switches, and the public-name rule.
import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  TRAINER_LIVE, APPLICATIONS_OPEN, TRAINER_TERMS_VERSION, KNOWN_TRAINER_TERMS_VERSIONS, TRAINER_TERMS_COPY,
  acceptedTrainerTermsVersion, isCurrentTrainerTerms,
  SHARE_CONSENT_VERSION, SHARE_COPY, acceptedShareConsentVersion, TRAINER_SCOPE,
} from "../lib/trainer-terms.js";
import { trainerOpenFor, shareOpenFor, applyOpenFor } from "../lib/auth-server.js";
import { publicName, SIGNAL_KEYS } from "../lib/trainer-view.js";
import { HORIZON_DAYS, LIVE_SLICES } from "../lib/trainer-change.js";
import { PLAN_KEYS } from "../lib/trainer-plan.js";

const strings = (o) => (typeof o === "string" ? [o] : Object.values(o).flatMap(strings));

describe("trainer terms", () => {
  it("is live, with the owner's accepted version", () => {
    expect(TRAINER_LIVE).toBe(true);
    expect(APPLICATIONS_OPEN).toBe(true);
    expect(TRAINER_TERMS_VERSION).toBe("draft-2026-10-05b");
    expect(KNOWN_TRAINER_TERMS_VERSIONS).toEqual([TRAINER_TERMS_VERSION]);
    expect(TRAINER_SCOPE).toBe("trainer:read");
  });

  it("copy is the approved wording, pinned with its version", () => {
    expect(TRAINER_TERMS_COPY).toEqual({
      summary: [
        "Clients choose to share with you, and can stop at any time.",
        "Use it only to coach them, and keep it private.",
        "Change a client's plan only to coach them. They see every change and can undo it.",
        "You're 18 or over.",
        "Free.",
      ],
      line: "I'm 18 or over, and I accept the Trainer Terms.",
      href: "/trainer/terms",
    });
    expect(Object.isFrozen(TRAINER_TERMS_COPY)).toBe(true);
    expect(Object.isFrozen(TRAINER_TERMS_COPY.summary)).toBe(true);
    for (const v of strings(TRAINER_TERMS_COPY)) expect(v).not.toMatch(/server/i);
  });

  it("the version moved with the plan-changes and download lines: the previous ones are refused", () => {
    for (const old of ["draft-2026-10", "draft-2026-10-05"]) {
      expect(TRAINER_TERMS_VERSION).not.toBe(old);
      expect(acceptedTrainerTermsVersion({ version: old })).toBeNull();
      expect(isCurrentTrainerTerms({ version: old, adult: true })).toBe(false);
    }
  });

  it("the Terms page says a downloaded copy is still the client's, and when it goes", () => {
    const page = readFileSync(new URL("../app/trainer/terms/page.jsx", import.meta.url), "utf8");
    expect(page).toContain("A copy you download of what a client shares is still their data. Delete it when they stop sharing with you, or if they ask.");
  });

  it("the Terms page says what a trainer may change, and no longer says read only", () => {
    const page = readFileSync(new URL("../app/trainer/terms/page.jsx", import.meta.url), "utf8");
    expect(page).not.toContain("Read only.");
    expect(page).toContain("You can change their working weights, reps and main lifts from their next session on, within the app's limits.");
    expect(page).toContain("you also see their current working weights, reps and main lifts for every lift in their programme, whether they're on a deload, their planned week up to 4 weeks ahead,");
    expect(page).toContain("each lift's most recent top set, however long ago");
    expect(page).toContain("If they turn your changes off or stop sharing, anything not yet in their plan is cancelled.");
    // Week changes are off in this slice: the page never offers them.
    expect(page).not.toMatch(/change (them|their week|their weekly plan)\b/);
    expect(page).toContain("They see every change with what it was before, can undo it, and can turn your changes off.");
    expect(page).toContain("Change a client's plan only to coach them.");
  });

  it("the Terms link opens a page that exists", () => {
    expect(TRAINER_TERMS_COPY.href).toBe("/trainer/terms");
    expect(existsSync(new URL(`../app${TRAINER_TERMS_COPY.href}/page.jsx`, import.meta.url))).toBe(true);
  });

  it("accepts only the current version, as a string on an object", () => {
    expect(acceptedTrainerTermsVersion({ version: TRAINER_TERMS_VERSION })).toBe(TRAINER_TERMS_VERSION);
    for (const bad of [undefined, null, TRAINER_TERMS_VERSION, {}, { version: 1 }, { version: "2026-01" }, [TRAINER_TERMS_VERSION], { version: SHARE_CONSENT_VERSION }]) {
      expect(acceptedTrainerTermsVersion(bad)).toBeNull();
    }
  });

  it("a stored record is current only at this version and with adult: true", () => {
    expect(isCurrentTrainerTerms({ version: TRAINER_TERMS_VERSION, at: "2026-10-03T00:00:00.000Z", adult: true })).toBe(true);
    for (const bad of [null, undefined, {}, { version: TRAINER_TERMS_VERSION }, { version: TRAINER_TERMS_VERSION, adult: "true" },
      { version: TRAINER_TERMS_VERSION, adult: 1 }, { version: "2026-01", adult: true }]) {
      expect(isCurrentTrainerTerms(bad)).toBe(false);
    }
  });
});

describe("share consent", () => {
  it("copy and version are pinned together", () => {
    expect(SHARE_CONSENT_VERSION).toBe("2026-10-05b");
    expect(SHARE_COPY).toEqual({
      rows: [
        "Your sessions, sets, RPE and how you felt, from the last 24 weeks.",
        "Your main-lift trend and bests over the last 12 months.",
        "On their client list: when you last trained, your sessions this week against your plan, and your 28-day rhythm.",
        "Breathers show as paused, never why.",
        "Each look shows in your Profile, plus one check-in a day from their client list.",
        "They can download a copy of what they see.",
        "They may see a dot when any client has trained since they last opened their list. It never says who.",
        "Your current working weights, reps and main lifts for every lift in your programme, whether you're on a deload, and your planned week up to 4 weeks ahead.",
        "Each lift's most recent top set, however long ago. It keeps their changes within safe limits.",
        "They can change your working weights, reps and main lifts from your next session on, within the app's limits.",
        "Every change is checked against your training. It shows in Profile with what it was before, and you can undo it in one tap until you've trained at it. Your logged sessions never change.",
        "Turn their changes off in one tap in Profile, and keep sharing. Turning them off, or stopping sharing, cancels any change that hasn't reached your plan yet.",
      ],
      includes: "Includes sessions already logged, and new ones as you log them. Photos, bodyweight, sleep and notes stay yours.",
      line: "Only you decide. Stop any time in Profile, and they lose access straight away.",
    });
    expect(Object.isFrozen(SHARE_COPY)).toBe(true);
    expect(Object.isFrozen(SHARE_COPY.rows)).toBe(true);
  });

  it("names both windows, the roster line and never why; no server, no switch", () => {
    const all = strings(SHARE_COPY).join("\n");
    expect(all).toContain("24 weeks");
    expect(all).toContain("12 months");
    expect(all).toContain("On their client list");
    expect(all).toContain("never why");
    expect(all).not.toMatch(/server/i);
    expect(all).not.toContain("How you felt each session");
    expect(all).not.toMatch(/from now on/i);
  });

  it("names everything the client list shows, the daily check-in and the dot that names no one", () => {
    const all = strings(SHARE_COPY).join("\n");
    // The roster line, as lib/trainer-view.js rosterSignal computes it.
    expect(SIGNAL_KEYS).toEqual(["lastTrainedDaysAgo", "weekDone", "weekPlanned", "rhythmPct", "paused"]);
    expect(readFileSync(new URL("../lib/trainer-view.js", import.meta.url), "utf8")).toContain("strengthRhythm(ctx, { days: 28 })");
    for (const fact of ["when you last trained", "your sessions this week against your plan", "28-day rhythm", "paused"]) {
      expect(all).toContain(fact);
    }
    expect(all).toContain("one check-in a day from their client list");
    expect(all).toContain("It never says who.");
  });

  it("the version moved with the copy: the previous ones are refused", () => {
    for (const old of ["2026-10", "2026-10-04", "2026-10-05"]) {
      expect(SHARE_CONSENT_VERSION).not.toBe(old);
      expect(acceptedShareConsentVersion({ version: old })).toBeNull();
    }
  });

  it("names plan changes, the undo, the off switch and that logged sessions never change; never read only", () => {
    const all = strings(SHARE_COPY).join("\n");
    expect(all).not.toContain("Read only");
    for (const fact of ["working weights, reps and main lifts", "planned week up to 4 weeks ahead", "within the app's limits",
      "checked against your training", "what it was before", "undo it in one tap", "Your logged sessions never change.",
      "Turn their changes off in one tap in Profile, and keep sharing.",
      "Turning them off, or stopping sharing, cancels any change that hasn't reached your plan yet."]) {
      expect(all).toContain(fact);
    }
    // The 4 weeks are the plan's horizon; the scope stays read, edits live on the grant.
    expect(HORIZON_DAYS).toBe(28);
    expect(TRAINER_SCOPE).toBe("trainer:read");
  });

  it("offers only what ships: weights, reps and main lifts from the next session on; no week or dated changes", () => {
    const all = strings(SHARE_COPY).join("\n");
    // While these slices are off, the copy never offers them. Turning one on means new copy and a new version.
    expect(LIVE_SLICES).toEqual({ week: false, dated: false });
    expect(all).toContain("They can change your working weights, reps and main lifts from your next session on");
    expect(all).not.toMatch(/weekly plan|from a date/);
  });

  it("names every part of the plan the trainer is sent, not only the next session", () => {
    const all = strings(SHARE_COPY).join("\n");
    // One phrase per part of the projection, so a new part needs new copy.
    const named = { lifts: "every lift in your programme", mains: "main lifts", deload: "deload", week: "planned week up to 4 weeks ahead" };
    for (const k of PLAN_KEYS.plan.filter((k) => k !== "changes" && k !== "budget")) expect(all, k).toContain(named[k]);
    expect(all).toContain("Your current working weights, reps and main lifts for every lift in your programme");
    expect(all).not.toContain("Your next session's");
  });

  it("names the top set the limits come from, whatever its age", () => {
    const all = strings(SHARE_COPY).join("\n");
    expect(all).toContain("Each lift's most recent top set, however long ago.");
    // The plan carries it as the anchor, found over all of their training, not the 24-week window.
    expect(PLAN_KEYS.planLift).toContain("anchor");
    expect(PLAN_KEYS.planAnchor).toEqual(["date", "kg", "reps"]);
    const plan = readFileSync(new URL("../lib/trainer-plan.js", import.meta.url), "utf8");
    expect(plan).toContain("findMostRecentLiftSession(history, name)");
    expect(plan).not.toContain("DETAIL_DAYS");
  });

  it("accepts only the current share version", () => {
    expect(acceptedShareConsentVersion({ version: SHARE_CONSENT_VERSION })).toBe(SHARE_CONSENT_VERSION);
    for (const bad of [undefined, null, SHARE_CONSENT_VERSION, {}, { version: 202610 }, { version: TRAINER_TERMS_VERSION }, [SHARE_CONSENT_VERSION]]) {
      expect(acceptedShareConsentVersion(bad)).toBeNull();
    }
  });
});

describe("launch switches", () => {
  const ADMIN = { accountId: "hwa_" + "b".repeat(26), storageKey: "boss" };
  const LISTED = { accountId: "hwa_" + "p".repeat(26), storageKey: "hwa_" + "p".repeat(26) };
  const OTHER = { accountId: "hwa_" + "o".repeat(26), storageKey: "sam" };
  const env = { ADMIN_ACCOUNT_ID: ADMIN.accountId };
  // The old preview list, still set until the owner deletes it: never read.
  const listed = { ...env, TRAINER_PREVIEW_ACCOUNTS: ` ${LISTED.accountId} , hwa_${"q".repeat(26)}` };

  afterEach(() => { vi.doUnmock("../lib/trainer-terms.js"); vi.resetModules(); });

  it("live: every account may be a trainer, add a trainer and apply, without any env", () => {
    for (const who of [ADMIN, LISTED, OTHER]) {
      for (const e of [env, {}]) {
        expect(trainerOpenFor(who, e)).toBe(true);
        expect(shareOpenFor(who, e)).toBe(true);
        expect(applyOpenFor(who, e)).toBe(true);
      }
    }
  });

  it("shareOpenFor ignores TRAINER_PREVIEW_ACCOUNTS: it is trainerOpenFor, whatever the list says", async () => {
    for (const who of [ADMIN, LISTED, OTHER, { accountId: "", storageKey: "x" }, { storageKey: "x" }]) {
      expect(shareOpenFor(who, listed)).toBe(shareOpenFor(who, env));
    }
    expect(readFileSync(new URL("../lib/auth-server.js", import.meta.url), "utf8")).not.toMatch(/env\.TRAINER_PREVIEW_ACCOUNTS/);
    // With the switch closed, the list opens nothing: the admin only.
    vi.resetModules();
    vi.doMock("../lib/trainer-terms.js", async (importOriginal) => ({ ...(await importOriginal()), TRAINER_LIVE: false }));
    const closed = await import("../lib/auth-server.js");
    expect(closed.shareOpenFor(ADMIN, listed)).toBe(true);
    expect(closed.shareOpenFor(LISTED, listed)).toBe(false);
    expect(closed.shareOpenFor(OTHER, listed)).toBe(false);
    expect(closed.shareOpenFor(null, listed)).toBe(false);
  });

  it("with the switch closed, only the admin may be a trainer", async () => {
    vi.resetModules();
    vi.doMock("../lib/trainer-terms.js", async (importOriginal) => ({ ...(await importOriginal()), TRAINER_LIVE: false }));
    const closed = await import("../lib/auth-server.js");
    expect(closed.trainerOpenFor(ADMIN, env)).toBe(true);
    expect(closed.trainerOpenFor(OTHER, env)).toBe(false);
    expect(closed.trainerOpenFor(null, env)).toBe(false);
    expect(closed.trainerOpenFor(ADMIN, {})).toBe(false);
  });

  // The truth table: APPLICATIONS_OPEN on or off, TRAINER_LIVE on or off,
  // admin or not. Applications off leaves the admin only, whatever the dashboard.
  it.each([
    [true, false, { admin: true, other: true }],
    [false, false, { admin: true, other: false }],
    [false, true, { admin: true, other: false }],
    [true, true, { admin: true, other: true }],
  ])("applyOpenFor with APPLICATIONS_OPEN %s and TRAINER_LIVE %s", async (applications, live, want) => {
    vi.resetModules();
    vi.doMock("../lib/trainer-terms.js", async (importOriginal) => ({
      ...(await importOriginal()), APPLICATIONS_OPEN: applications, TRAINER_LIVE: live,
    }));
    const m = await import("../lib/auth-server.js");
    expect(m.applyOpenFor(ADMIN, env)).toBe(want.admin);
    expect(m.applyOpenFor(OTHER, env)).toBe(want.other);
    expect(m.applyOpenFor(LISTED, listed)).toBe(want.other);
    // No admin configured: only the applications switch opens it.
    expect(m.applyOpenFor(ADMIN, {})).toBe(applications);
    // The dashboard never follows APPLICATIONS_OPEN.
    expect(m.trainerOpenFor(OTHER, env)).toBe(live);
  });
});

describe("publicName", () => {
  it("shows the display form only when it normalises to the handle", () => {
    expect(publicName({ handle: "sam", display: "Sam" })).toBe("Sam");
    expect(publicName({ handle: "sam", display: "ＳＡＭ" })).toBe("ＳＡＭ");
    expect(publicName({ handle: "sam", display: "sam" })).toBe("sam");
    // A display bound to another name never stands in for the handle.
    expect(publicName({ handle: "sam", display: "Coach Alex" })).toBe("sam");
    expect(publicName({ handle: "sam", display: "Samuel" })).toBe("sam");
    expect(publicName({ handle: "sam", display: null })).toBe("sam");
    expect(publicName({ handle: "sam" })).toBe("sam");
  });

  it("no live primary handle gives no name", () => {
    expect(publicName(null)).toBeNull();
    expect(publicName(undefined)).toBeNull();
    expect(publicName({ handle: "", display: "" })).toBeNull();
    expect(publicName({ handle: null, display: "Sam" })).toBeNull();
  });
});
