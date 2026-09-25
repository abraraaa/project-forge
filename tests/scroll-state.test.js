// Headline compression is a state with hysteresis, not a scrub over scroll
// position — so it feels the same at every page length (2026-09-25).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nextScrolled } from "../components/ScrollState.jsx";

describe("scrolled state", () => {
  it("turns on past 24px and off only above 8px", () => {
    let s = false;
    const trace = [0, 15, 30, 15, 12, 5, 0, 20].map((y) => (s = nextScrolled(s, y)));
    expect(trace).toEqual([false, false, true, true, true, false, false, false]);
  });
  it("the headline transitions on the state; no scroll timeline", () => {
    const css = readFileSync(resolve(__dirname, "../app/globals.css"), "utf8");
    expect(css).toMatch(/html\[data-scrolled\] \.home-headline \{[^}]*scale\(0\.94\)/);
    expect(css).not.toContain("home-header-compress");
    expect(readFileSync(resolve(__dirname, "../app/layout.jsx"), "utf8")).toContain("<ScrollState />");
  });
});
