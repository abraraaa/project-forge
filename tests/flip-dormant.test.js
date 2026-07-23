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
import { isHeatwayveOrigin, HEATWAYVE_HOSTS } from "../lib/origin.js";

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

describe("dormant surfaces (code shape)", () => {
  it("the install overlay carries the migration voice behind the prop", () => {
    const s = readFileSync(resolve(root, "components/ForgeApp.jsx"), "utf8");
    expect(s).toContain("IosInstallOverlay migration={isHeatwayveOrigin()}");
    expect(s).toContain("Same fire, new home");
    expect(s).toContain("Add <span");
    // the pre-flip voice remains the default
    expect(s).toContain("Install <span");
  });
  it("the welcome-back beat greets the move only on the new origin", () => {
    const s = readFileSync(resolve(root, "components/TakenNameModal.jsx"), "utf8");
    expect(s).toMatch(/isHeatwayveOrigin\(\)\s*\?\s*"Forge grew into Heatwayve/);
    expect(s).toContain('"Fetching your stuff…"');
  });
});
