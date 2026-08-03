// @vitest-environment jsdom
// tests/theme-toggle.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The appearance override (Sun · Auto · Moon in Profile). The mode contract
// is ONE axis: every token resolves through light-dark(), and color-scheme
// on <html> — `light dark` for auto, an inline "light"/"dark" for manual —
// re-resolves the whole palette. Per-profile: a shared device keeps each
// person's mode. Locks:
//   1. Tokens are declared ONCE, via light-dark() — no duplicated mode
//      blocks, no data-theme attribute machinery to drift.
//   2. The stored preference applies at PARSE time (layout.jsx script) —
//      profile resolution included — or every launch flashes.
//   3. lib/theme.js round-trips the three states per profile, crossfades
//      through the view-transition API when present, and survives a dead
//      localStorage.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getThemePreference, applyThemePreference, stampTheme } from "../lib/theme.js";
import { PROFILE_SUFFIXES } from "../lib/store-health.js";
import { GLYPH_NAMES } from "../components/Glyph.jsx";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(resolve(root, "app/globals.css"), "utf8");
const layout = readFileSync(resolve(root, "app/layout.jsx"), "utf8");
const themeSrc = readFileSync(resolve(root, "lib/theme.js"), "utf8");

describe("the mode contract is one axis — light-dark(), no twins", () => {
  it("flipped tokens declare both values once", () => {
    expect(css).toMatch(/--ground:\s*light-dark\(#F2E9E3, #1A1512\)/);
    expect(css).toMatch(/--ink:\s*light-dark\(#241C19, #F2E9E3\)/);
    // Declared exactly once — a reintroduced dark block would double these.
    expect(css.match(/--ground:/g)).toHaveLength(1);
    expect(css.match(/--ink:\s/g)).toHaveLength(1);
  });

  it("no duplicated mode blocks and no attribute machinery survive", () => {
    // The old shape was a prefers-color-scheme token block twinned with a
    // [data-theme] block plus a drift guard. light-dark() deletes all of
    // it; anything matching these is the legacy pattern coming back.
    expect(css).not.toContain("data-theme");
    expect(css).not.toMatch(/@media \(prefers-color-scheme: dark\)[\s\S]*--ground/);
  });

  it("tokens live on BODY, never :root — the eager-resolution trap", () => {
    // Verified in a live repro (2026-08-03): a light-dark() inside a
    // custom property declared on the ROOT is resolved once against the
    // page preference and ignores the color-scheme override — the manual
    // toggle silently does nothing. Declared on body, it resolves at each
    // consuming element and follows the override. Moving these back to
    // :root re-breaks the toggle while every automated colour check
    // stays green — hence this lock.
    const rootBlock = css.match(/:root \{[^}]*\}/)?.[0] ?? "";
    expect(rootBlock).toContain("color-scheme: light dark");
    expect(rootBlock).not.toContain("--ground");
    expect(css).toMatch(/body \{[^}]*--ground:/s);
    // html can't consume body-scoped vars — its ground is the direct form.
    expect(css).toMatch(/html \{[^}]*background: light-dark\(#F2E9E3, #1A1512\)/s);
  });

  it("the elevation pair stacks both edges (offsets can't ride light-dark)", () => {
    // Bottom-edge shadow on light, top-edge highlight on dark: one token,
    // two shadows, the wrong edge faded to transparent per mode.
    expect(css).toMatch(/--elev:[\s\S]{0,200}light-dark\(rgba\(36, 28, 25, 0\.08\), transparent\)/);
    expect(css).toMatch(/--elev:[\s\S]{0,200}light-dark\(transparent, rgba\(242, 233, 227, 0\.07\)\)/);
  });
});

describe("parse-time application (layout.jsx)", () => {
  it("a blocking head script resolves the ACTIVE PROFILE's preference before first paint", () => {
    expect(layout).toContain('localStorage.getItem("forge:active")');
    expect(layout).toContain('":theme"');
    // color-scheme is the single mechanism — the script sets it inline
    // (inline beats stylesheet) and touches nothing else.
    expect(layout).toMatch(/style\.colorScheme\s*=\s*t/);
    expect(layout).not.toContain("dataset.theme");
    // Fail-safe: a throwing localStorage (private mode) must not take the
    // shell down with it.
    expect(layout).toMatch(/try\{.*:theme.*\}catch/);
  });

  it("the parse-time ground tone rides the same axis", () => {
    expect(layout).toContain("html{background:light-dark(#F2E9E3,#1A1512)}");
  });
});

describe("lib/theme.js — three states, per profile", () => {
  afterEach(() => {
    applyThemePreference("sam", "auto");
    applyThemePreference("alex", "auto");
  });

  it("manual states set the inline colorScheme and the profile's key", () => {
    applyThemePreference("sam", "dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(window.localStorage.getItem("forge:sam:theme")).toBe('"dark"');
    expect(getThemePreference("sam")).toBe("dark");

    applyThemePreference("sam", "light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(getThemePreference("sam")).toBe("light");
  });

  it("profiles are independent — one person's mode never leaks to another", () => {
    applyThemePreference("sam", "dark");
    expect(getThemePreference("alex")).toBe("auto");
    expect(window.localStorage.getItem("forge:alex:theme")).toBe(null);
  });

  it("auto restores `light dark` and stores nothing", () => {
    applyThemePreference("sam", "dark");
    applyThemePreference("sam", "auto");
    expect(document.documentElement.style.colorScheme).toBe("light dark");
    expect(window.localStorage.getItem("forge:sam:theme")).toBe(null);
    expect(getThemePreference("sam")).toBe("auto");
  });

  it("junk in the key reads as auto; no profile reads as auto", () => {
    window.localStorage.setItem("forge:sam:theme", '"sepia"');
    expect(getThemePreference("sam")).toBe("auto");
    window.localStorage.removeItem("forge:sam:theme");
    expect(getThemePreference(null)).toBe("auto");
  });

  it("the suffix is registered per-profile — recognised by diag, cleared by a wipe", () => {
    expect(PROFILE_SUFFIXES.has("theme")).toBe(true);
  });

  it("stamping never touches the DOM beyond colorScheme", () => {
    expect(themeSrc).not.toContain("dataset");
  });

  it("the stamp crossfades through startViewTransition when the platform offers it", () => {
    const vt = vi.fn((cb) => cb());
    document.startViewTransition = vt;
    try {
      stampTheme("dark");
      expect(vt).toHaveBeenCalledTimes(1);
      expect(document.documentElement.style.colorScheme).toBe("dark");
      // Idempotent: re-stamping the same state must NOT mint a transition.
      stampTheme("dark");
      expect(vt).toHaveBeenCalledTimes(1);
    } finally {
      delete document.startViewTransition;
      stampTheme("auto");
    }
  });
});

describe("the switch and its glyphs", () => {
  it("sun and moon are drawn glyphs in the set", () => {
    expect(GLYPH_NAMES).toContain("sun");
    expect(GLYPH_NAMES).toContain("moon");
  });

  it("Profile hosts the radiogroup; Auto is a word, not a letterform", () => {
    const s = readFileSync(resolve(root, "components/ProfileScreen.jsx"), "utf8");
    expect(s).toContain('role="radiogroup" aria-label="Appearance"');
    expect(s).toContain('word:  "Auto"');
    expect(s).toMatch(/glyph: "sun"/);
    expect(s).toMatch(/glyph: "moon"/);
  });

  it("the chosen glyph lights up — warm sun, cool moon, own tokens", () => {
    const s = readFileSync(resolve(root, "components/ProfileScreen.jsx"), "utf8");
    expect(s).toMatch(/lit: T\.sun/);
    expect(s).toMatch(/lit: T\.moon/);
    expect(css).toMatch(/--sun:\s*light-dark\(#A65340, #BE7E62\)/);
    expect(css).toMatch(/--moon:\s*light-dark\(#4E6674, #9FB8C6\)/);
  });
});
