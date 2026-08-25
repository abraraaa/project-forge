// hasUsablePasskey gates the auth surfaces; the wipe gate keeps hasRealPasskey.
// Plus the re-enrolment prompt's record/clear/snooze rules.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { hasRealPasskey, hasUsablePasskey } from "../lib/auth-server.js";
import { NATIVE_RP_ID, LEGACY_RP_ID, acceptedRpIds } from "../lib/origin.js";
import {
  recordUpgradeNeed, readUpgradeNeed, clearUpgradeNeed,
  snoozePrompt, shouldInterrupt, SNOOZE_DAYS,
} from "../lib/passkey-upgrade.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(resolve(root, p), "utf8");
const at = (d) => new Date(`${d}T12:00:00`).getTime();
const legacy = { id: "l", publicKey: "k" };                     // no rpId field
const native = { id: "n", publicKey: "k", rpId: NATIVE_RP_ID };

describe("hasUsablePasskey — can they still get in", () => {
  it("counts a legacy credential while the window is open", () => {
    expect(hasUsablePasskey({ credentials: [legacy] }, acceptedRpIds(at("2026-09-01")))).toBe(true);
  });

  it("stops counting it once the domain is retired", () => {
    expect(hasUsablePasskey({ credentials: [legacy] }, acceptedRpIds(at("2026-12-01")))).toBe(false);
  });

  it("still counts a native credential after the sunset", () => {
    expect(hasUsablePasskey({ credentials: [legacy, native] }, acceptedRpIds(at("2026-12-01")))).toBe(true);
  });

  it("never counts a keyless credential", () => {
    expect(hasUsablePasskey({ credentials: [{ id: "a" }] }, acceptedRpIds(at("2026-09-01")))).toBe(false);
  });

  it("keeps localhost dev credentials working regardless of the window", () => {
    const dev = { id: "d", publicKey: "k", rpId: "localhost" };
    expect(hasUsablePasskey({ credentials: [dev] }, acceptedRpIds(at("2026-12-01")))).toBe(true);
  });

  it("is null- and empty-safe", () => {
    expect(hasUsablePasskey(null)).toBe(false);
    expect(hasUsablePasskey({ credentials: [] })).toBe(false);
  });
});

describe("hasRealPasskey — was it ever protected (unchanged, and stays that way)", () => {
  it("still counts a legacy credential after the sunset", () => {
    // Tracking the sunset here would open the delete path on expiry.
    expect(hasRealPasskey({ credentials: [legacy] })).toBe(true);
  });
});

describe("the wipe gate does not relax at the sunset", () => {
  it("DELETE /api/sync still gates on hasRealPasskey", () => {
    const route = src("app/api/sync/route.js");
    const del = route.slice(route.indexOf("export async function DELETE"));
    expect(del).toContain("hasRealPasskey(credData)");
    expect(del).not.toContain("hasUsablePasskey");
  });

  it("the surfaces that ask 'can they get in' use the sunset-aware predicate", () => {
    expect(src("app/api/auth/check/route.js")).toContain("hasUsablePasskey");
    expect(src("app/api/auth/register-verify/route.js")).toContain("hasUsablePasskey(existing)");
  });
});

describe("the prompt records what the server matched, and clears only on a native mint", () => {
  beforeEach(() => {
    const store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    });
    vi.stubGlobal("window", /** @type {any} */ ({}));
  });

  it("records a need reported by the server", () => {
    recordUpgradeNeed("sam", { needed: true, urgent: false, daysLeft: 88 });
    expect(readUpgradeNeed("sam")).toMatchObject({ needed: true, urgent: false, daysLeft: 88 });
  });

  it("ignores a login that reported nothing", () => {
    recordUpgradeNeed("sam", undefined);
    recordUpgradeNeed("sam", { needed: false });
    expect(readUpgradeNeed("sam")).toBeNull();
  });

  it("does NOT clear when the registration minted another legacy credential", () => {
    // The old origin still mints legacy, so the prompt stands.
    recordUpgradeNeed("sam", { needed: true, urgent: true, daysLeft: 10 });
    clearUpgradeNeed("sam", LEGACY_RP_ID);
    expect(readUpgradeNeed("sam")).not.toBeNull();
  });

  it("clears on a native mint", () => {
    recordUpgradeNeed("sam", { needed: true, urgent: true, daysLeft: 10 });
    clearUpgradeNeed("sam", NATIVE_RP_ID);
    expect(readUpgradeNeed("sam")).toBeNull();
  });

  it("keeps profiles separate", () => {
    recordUpgradeNeed("sam", { needed: true, urgent: true });
    expect(readUpgradeNeed("ada")).toBeNull();
  });
});

describe("interrupting is rationed", () => {
  it("never interrupts before the closing stretch", () => {
    expect(shouldInterrupt({ needed: true, urgent: false })).toBe(false);
  });

  it("interrupts once urgent", () => {
    expect(shouldInterrupt({ needed: true, urgent: true })).toBe(true);
  });

  it("rests after a dismissal, then returns", () => {
    const now = at("2026-10-20");
    const state = { needed: true, urgent: true, snoozedUntil: now + SNOOZE_DAYS * 86400000 };
    expect(shouldInterrupt(state, now + 86400000)).toBe(false);
    expect(shouldInterrupt(state, now + (SNOOZE_DAYS + 1) * 86400000)).toBe(true);
  });

  it("never interrupts when no upgrade is needed", () => {
    expect(shouldInterrupt(null)).toBe(false);
    expect(shouldInterrupt({ needed: false, urgent: true })).toBe(false);
  });
});

describe("the prompt is wired where it cannot be forgotten", () => {
  it("recording happens inside authenticatePasskey, not at each call site", () => {
    // Four surfaces authenticate; recording at one of them misses the rest.
    const s = src("lib/webauthn.js");
    expect(s).toContain("recordUpgradeNeed");
    expect(s).toContain("clearUpgradeNeed");
  });

  it("neither hook can fail a sign-in or a registration", () => {
    const s = src("lib/webauthn.js");
    for (const fn of ["recordUpgradeNeed", "clearUpgradeNeed"]) {
      const i = s.indexOf(fn + "(");
      expect(s.slice(i, i + 260)).toMatch(/\} catch \{/);
    }
  });
});
