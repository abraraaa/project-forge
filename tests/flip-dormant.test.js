// tests/flip-dormant.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The flip package's dormant UX layer (docs/heatwayve-flip.md): built and
// shipped BEFORE the flip, gated on lib/origin.js, asleep on theforged.fit.
// The locks here guarantee both halves: it wakes on the new origin, and it
// cannot leak onto the old one.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isHeatwayveOrigin, HEATWAYVE_HOSTS, migrationWindowOpen, hasPreFlipStory, MIGRATION_WINDOW_DAYS } from "../lib/origin.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("origin predicate — the only switch the dormant layer answers to", () => {
  it("wakes on heatwayve.app (and www), case-insensitively", () => {
    expect(isHeatwayveOrigin("heatwayve.app")).toBe(true);
    expect(isHeatwayveOrigin("www.heatwayve.app")).toBe(true);
    expect(isHeatwayveOrigin("HEATWAYVE.APP")).toBe(true);
  });
  it("sleeps everywhere else — the live brand never sees it", () => {
    for (const h of ["theforged.fit", "www.theforged.fit", "localhost", "heatwayve.fit", "evil-heatwayve.app", "heatwayve.app.evil.com", "", null, undefined]) {
      expect(isHeatwayveOrigin(h), String(h)).toBe(false);
    }
    expect(HEATWAYVE_HOSTS.size).toBe(2); // exact allow-list, never a suffix match
  });
});

describe("who + when gates (boss catches, 2026-07-27)", () => {
  it("null FLIP_DATE double-locks everything off — even on the new origin", () => {
    expect(migrationWindowOpen(Date.now(), null)).toBe(false);
    expect(hasPreFlipStory([{ date: "2020-01-01" }], null)).toBe(false);
  });
  it("the window opens at the flip and self-retires after 60 days", () => {
    const flip = "2026-08-01";
    const day = 86400000;
    const start = new Date(2026, 7, 1).getTime(); // local midnight, Aug 1
    expect(migrationWindowOpen(start - day, flip)).toBe(false);          // eve of flip
    expect(migrationWindowOpen(start + day, flip)).toBe(true);           // day after
    expect(migrationWindowOpen(start + (MIGRATION_WINDOW_DAYS - 1) * day, flip)).toBe(true);
    expect(migrationWindowOpen(start + (MIGRATION_WINDOW_DAYS + 1) * day, flip)).toBe(false); // retired
  });
  it("pre-flip story: veterans yes, Heatwayve-born users never", () => {
    const flip = "2026-08-01";
    expect(hasPreFlipStory([{ date: "2026-07-20" }, { date: "2026-08-05" }], flip)).toBe(true);
    expect(hasPreFlipStory([{ date: "2026-08-05" }], flip)).toBe(false);  // first-timer
    expect(hasPreFlipStory([], flip)).toBe(false);
    expect(hasPreFlipStory(null, flip)).toBe(false);
  });
});

describe("dormant surfaces (code shape)", () => {
  it("the install overlay carries the migration voice behind the prop", () => {
    const s = readFileSync(resolve(root, "components/ForgeApp.jsx"), "utf8");
    expect(s).toContain("IosInstallOverlay migration={isHeatwayveOrigin() && migrationWindowOpen() && hasPreFlipStory(history)}");
    expect(s).toContain("Same fire, new home");
    expect(s).toContain("Add <span");
    // the pre-flip voice remains the default
    expect(s).toContain("Install <span");
  });
  it("the welcome-back beat greets the move only on the new origin", () => {
    const s = readFileSync(resolve(root, "components/TakenNameModal.jsx"), "utf8");
    expect(s).toMatch(/isHeatwayveOrigin\(\) && migrationWindowOpen\(\)\s*\?\s*"Forge grew into Heatwayve/);
    expect(s).toContain('"Fetching your stuff…"');
  });
});
