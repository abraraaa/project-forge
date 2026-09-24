// Moments that are visual-only (pep line, reach offer) or a haptic iOS ignores
// (rest over) reach VoiceOver through one always-mounted live region; Auto
// appearance follows an OS flip on every route, not just home.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("session live region", () => {
  const src = read("components/SessionHost.jsx");
  it("is always mounted, not inserted with its content", () => {
    expect(src).toMatch(/<div role="status" aria-live="polite"[^>]*>\{srMsg\}<\/div>/);
    expect(src).not.toMatch(/\{srMsg && /);
  });
  it("announces the pep line, rest over and the reach offer", () => {
    expect(src).toContain("announce(line)");
    expect(src).toContain('announce("Rest over")');
    expect(src).toContain('announce("Last set, and you came in fresh.")');
  });
});

describe("Auto appearance", () => {
  it("follows the OS from the layout, not from the home route", () => {
    expect(read("app/layout.jsx")).toContain("<ThemeFollower />");
    expect(read("components/ForgeApp.jsx")).not.toContain('matchMedia("(prefers-color-scheme: dark)")');
  });
});
