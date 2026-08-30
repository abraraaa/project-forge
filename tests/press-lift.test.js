// The commit-surface press lift: the one amendment to the never-list. It must
// stay derived from --commit (off the heat ramp, which encodes effort) and
// must never appear on a bottom-anchored sheet.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(resolve(root, "app/globals.css"), "utf8");
const tokens = readFileSync(resolve(root, "lib/tokens.js"), "utf8");

const files = [];
const walk = (d) => {
  for (const f of readdirSync(resolve(root, d), { withFileTypes: true })) {
    const rel = join(d, f.name);
    if (f.isDirectory()) walk(rel);
    else if (/\.jsx$/.test(f.name)) files.push(rel.replace(/\\/g, "/"));
  }
};
walk("components");
walk("app");
const src = (rel) => readFileSync(resolve(root, rel), "utf8");

describe("--press-lift stays off the heat ramp", () => {
  it("is derived from --commit, never a literal", () => {
    const decl = css.match(/--press-lift:\s*([^;]+);/)?.[1] || "";
    expect(decl).toContain("var(--commit)");
    expect(decl, "a hex literal can drift onto a ramp step").not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it("lifts toward white rather than toward another token", () => {
    // Mixing toward --commit-ink would darken in dark mode, where ink is near
    // black; the lift has to read as light in both.
    expect(css).toMatch(/--press-lift:\s*color-mix\(in oklab, var\(--commit\) \d+%, white\)/);
  });
});

describe(".forge-lift is press-only and sheet-free", () => {
  const users = files.filter((f) => /className="[^"]*forge-lift/.test(src(f)));

  it("is actually in use", () => {
    expect(users.length).toBeGreaterThan(0);
  });

  it("never lands on a bottom-anchored sheet", () => {
    // Sheets get haptics only: transform on sheet controls reintroduced the
    // safe-area chin, twice. The lift uses no transform, but the rule is the
    // rule until something measures otherwise.
    const offenders = [];
    for (const f of users) {
      for (const tag of src(f).match(/<[a-zA-Z][^>]*className="[^"]*forge-lift[^"]*"[^>]*>/g) || []) {
        if (/forge-sheet-ground|forge-scrim|forge-vellum/.test(tag)) offenders.push(f);
      }
    }
    expect(offenders, `press visuals on a sheet: ${offenders.join(", ")}`).toEqual([]);
  });

  it("always rides .forge-press, so it follows the give timing", () => {
    const offenders = users.filter((f) =>
      (src(f).match(/className="[^"]*forge-lift[^"]*"/g) || [])
        .some((c) => !c.includes("forge-press")),
    );
    expect(offenders, `forge-lift without forge-press: ${offenders.join(", ")}`).toEqual([]);
  });

  it("uses no transform or filter, so nothing composites that did not before", () => {
    const rule = css.slice(css.indexOf(".forge-lift {"), css.indexOf(".forge-lift:active::before"));
    expect(rule).not.toMatch(/transform:|filter:|backdrop-filter:/);
  });
});

describe("the never-list records the amendment", () => {
  it("names .forge-lift as the one exception and forbids the rest", () => {
    expect(tokens).toContain("no glows");
    expect(tokens).toContain(".forge-lift");
    expect(tokens).toContain("Nothing else lights up");
  });

  it("no longer claims an enforcing test that does not exist", () => {
    expect(tokens).not.toContain("the template test, enforced");
  });
});
