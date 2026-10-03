// Trainer Terms and share consent: copy pinned with its version, the server
// validators, the launch switches, and the public-name rule.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  TRAINER_LIVE, TRAINER_TERMS_VERSION, KNOWN_TRAINER_TERMS_VERSIONS, TRAINER_TERMS_COPY,
  acceptedTrainerTermsVersion, isCurrentTrainerTerms,
  SHARE_CONSENT_VERSION, SHARE_COPY, acceptedShareConsentVersion, TRAINER_SCOPE,
} from "../lib/trainer-terms.js";
import { trainerOpenFor, shareOpenFor } from "../lib/auth-server.js";
import { publicName } from "../lib/trainer-view.js";

const strings = (o) => (typeof o === "string" ? [o] : Object.values(o).flatMap(strings));

describe("trainer terms", () => {
  it("is off until launch, with the placeholder version", () => {
    expect(TRAINER_LIVE).toBe(false);
    expect(TRAINER_TERMS_VERSION).toBe("draft-2026-10");
    expect(KNOWN_TRAINER_TERMS_VERSIONS).toEqual([TRAINER_TERMS_VERSION]);
    expect(TRAINER_SCOPE).toBe("trainer:read");
  });

  it("copy is the approved wording, pinned with its version", () => {
    expect(TRAINER_TERMS_COPY).toEqual({
      summary: [
        "Clients choose to share with you, and can stop at any time.",
        "Use it only to coach them, and keep it private.",
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
    expect(SHARE_CONSENT_VERSION).toBe("2026-10");
    expect(SHARE_COPY).toEqual({
      rows: [
        "Your sessions, sets, RPE and how you felt, from the last 24 weeks.",
        "Your main-lift trend and bests over the last 12 months.",
        "On their client list: when you last trained, and your sessions this week.",
        "Breathers show as paused, never why.",
      ],
      includes: "Includes sessions already logged, and new ones as you log them. Read only. Photos, bodyweight, sleep and notes stay yours.",
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

  it("accepts only the current share version", () => {
    expect(acceptedShareConsentVersion({ version: SHARE_CONSENT_VERSION })).toBe(SHARE_CONSENT_VERSION);
    for (const bad of [undefined, null, SHARE_CONSENT_VERSION, {}, { version: 202610 }, { version: TRAINER_TERMS_VERSION }, [SHARE_CONSENT_VERSION]]) {
      expect(acceptedShareConsentVersion(bad)).toBeNull();
    }
  });
});

describe("launch switches", () => {
  const ADMIN = { accountId: "hwa_" + "b".repeat(26), storageKey: "boss" };
  const PREVIEW = { accountId: "hwa_" + "p".repeat(26), storageKey: "hwa_" + "p".repeat(26) };
  const OTHER = { accountId: "hwa_" + "o".repeat(26), storageKey: "sam" };
  const env = { ADMIN_ACCOUNT_ID: ADMIN.accountId, TRAINER_PREVIEW_ACCOUNTS: ` ${PREVIEW.accountId} , hwa_${"q".repeat(26)}` };

  afterEach(() => { vi.doUnmock("../lib/trainer-terms.js"); vi.resetModules(); });

  it("while not live, only the admin may be a trainer", () => {
    expect(trainerOpenFor(ADMIN, env)).toBe(true);
    expect(trainerOpenFor(PREVIEW, env)).toBe(false);
    expect(trainerOpenFor(OTHER, env)).toBe(false);
    expect(trainerOpenFor(null, env)).toBe(false);
    expect(trainerOpenFor(ADMIN, {})).toBe(false);
  });

  it("while not live, the admin and listed preview accounts may add a trainer", () => {
    expect(shareOpenFor(ADMIN, env)).toBe(true);
    expect(shareOpenFor(PREVIEW, env)).toBe(true);
    expect(shareOpenFor(OTHER, env)).toBe(false);
    expect(shareOpenFor(null, env)).toBe(false);
    // Matched by account id, never by storage key.
    expect(shareOpenFor({ accountId: OTHER.accountId, storageKey: PREVIEW.accountId }, env)).toBe(false);
  });

  it("an empty or unset preview list names nobody", () => {
    for (const list of [undefined, "", " ", ",", " , ,"]) {
      const e = { ADMIN_ACCOUNT_ID: ADMIN.accountId, TRAINER_PREVIEW_ACCOUNTS: list };
      expect(shareOpenFor(PREVIEW, e)).toBe(false);
      expect(shareOpenFor({ accountId: "", storageKey: "x" }, e)).toBe(false);
      expect(shareOpenFor({ storageKey: "x" }, e)).toBe(false);
      expect(shareOpenFor(ADMIN, e)).toBe(true);
    }
  });

  it("once live, both are open to everyone", async () => {
    vi.resetModules();
    vi.doMock("../lib/trainer-terms.js", async (importOriginal) => ({ ...(await importOriginal()), TRAINER_LIVE: true }));
    const live = await import("../lib/auth-server.js");
    for (const who of [ADMIN, PREVIEW, OTHER]) {
      expect(live.trainerOpenFor(who, {})).toBe(true);
      expect(live.shareOpenFor(who, {})).toBe(true);
    }
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
