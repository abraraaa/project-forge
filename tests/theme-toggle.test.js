// @vitest-environment jsdom
// tests/theme-toggle.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The appearance override (Sun · Auto · Moon in Profile). The mode contract
// stays CSS-owned: manual states stamp data-theme on <html> and the token
// blocks key off it. Three locks:
//   1. The dark tokens exist as TWIN blocks (system media query + manual
//      attribute) — CSS can't express the disjunction without duplication,
//      so the twins must never drift.
//   2. The stored preference applies at PARSE time (layout.jsx script) —
//      otherwise every launch flashes the system mode first.
//   3. lib/theme.js round-trips the three states and survives a dead
//      localStorage.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getThemePreference, applyThemePreference, THEME_KEY } from "../lib/theme.js";
import { DEVICE_KEYS } from "../lib/store-health.js";
import { GLYPH_NAMES } from "../components/Glyph.jsx";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(resolve(root, "app/globals.css"), "utf8");
const layout = readFileSync(resolve(root, "app/layout.jsx"), "utf8");

const dedent = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");

describe("twin dark-token blocks", () => {
  it("the media block and the manual block carry identical declarations", () => {
    const mediaStart = css.indexOf('@media (prefers-color-scheme: dark) {');
    const mediaOpen = css.indexOf(':root:not([data-theme="light"]) {', mediaStart);
    expect(mediaOpen).toBeGreaterThan(-1);
    const mediaBody = css.slice(
      mediaOpen + ':root:not([data-theme="light"]) {'.length,
      css.indexOf("\n  }\n}", mediaOpen),
    );
    const manualOpen = css.indexOf(':root[data-theme="dark"] {');
    expect(manualOpen).toBeGreaterThan(-1);
    const manualBody = css.slice(
      manualOpen + ':root[data-theme="dark"] {'.length,
      css.indexOf("\n}", manualOpen),
    );
    expect(dedent(manualBody)).toBe(dedent(mediaBody));
    expect(dedent(mediaBody)).toContain("--ground:");   // extraction sanity
  });

  it("the system block yields to a manual light override", () => {
    // The media query must scope to :not([data-theme="light"]) — a plain
    // :root inside it would beat the light tokens whenever the system is
    // dark, making the Sun position a no-op exactly when it matters.
    expect(css).toContain(':root:not([data-theme="light"])');
  });
});

describe("parse-time application (layout.jsx)", () => {
  it("a blocking head script applies the stored preference before first paint", () => {
    expect(layout).toContain('localStorage.getItem("forge:theme")');
    expect(layout).toMatch(/dataset\.theme\s*=\s*t/);
    // The inline colorScheme on <html> wins over any stylesheet rule, so
    // the script must override it too or UA chrome follows the system.
    expect(layout).toMatch(/style\.colorScheme\s*=\s*t/);
    // Fail-safe: a throwing localStorage (private mode) must not take the
    // shell down with it.
    expect(layout).toMatch(/try\{.*forge:theme.*\}catch/);
  });

  it("the parse-time ground style resolves the same race, manual rules last", () => {
    const style = layout.match(/html\{background:#F2E9E3\}[^"]+/)?.[0] ?? "";
    expect(style).toContain("html:not([data-theme=light]){background:#1A1512}");
    // Manual dark must appear AFTER the media rule — equal specificity,
    // source order decides.
    expect(style.indexOf("html[data-theme=dark]")).toBeGreaterThan(
      style.indexOf("prefers-color-scheme:dark"),
    );
  });
});

describe("lib/theme.js — the three states", () => {
  afterEach(() => applyThemePreference("auto"));

  it("manual states stamp the attribute, the inline colorScheme, and the key", () => {
    applyThemePreference("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(getThemePreference()).toBe("dark");

    applyThemePreference("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(getThemePreference()).toBe("light");
  });

  it("auto removes all three — nothing stored, nothing stamped", () => {
    applyThemePreference("dark");
    applyThemePreference("auto");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.documentElement.style.colorScheme).toBe("light dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe(null);
    expect(getThemePreference()).toBe("auto");
  });

  it("junk in the key reads as auto, never as a mode", () => {
    window.localStorage.setItem(THEME_KEY, "sepia");
    expect(getThemePreference()).toBe("auto");
    window.localStorage.removeItem(THEME_KEY);
  });

  it("the key is registered device-level — diag must not flag it", () => {
    expect(DEVICE_KEYS.has(THEME_KEY)).toBe(true);
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
});
