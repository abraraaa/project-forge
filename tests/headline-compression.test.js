// Headline compression is a compositor-side scroll timeline scrubbed over a
// pixel range with a dead zone — no JS scroll listener, no state attribute.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const read = (rel) => readFileSync(resolve(root, rel), "utf8");
const css = read("app/globals.css");

/** Bodies of every block opened by `head` (brace-matched). */
function blocks(src, head) {
  const out = [];
  for (let i = src.indexOf(head); i !== -1; i = src.indexOf(head, i + 1)) {
    let depth = 0, j = src.indexOf("{", i);
    const start = j + 1;
    for (; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) break;
    }
    out.push(src.slice(start, j));
  }
  return out;
}
const supports = blocks(css, "@supports (animation-timeline: scroll())");
const rule = (body, sel) => blocks(body, `${sel} {`).join("\n");

describe("headline compression — scroll timeline", () => {
  it("runs on scroll(root) over 8px→56px, shorthand before the timeline", () => {
    const body = supports.map((b) => rule(b, ".home-headline")).find((r) => r.includes("headline-compress"));
    expect(body).toBeTruthy();
    const decls = /** @type {string} */ (body).replace(/\s+/g, " ");
    expect(decls).toMatch(/animation: headline-compress linear both; animation-timeline: scroll\(root\); animation-range: 8px 56px;/);
  });

  it("compresses to scale(0.94) translateY(-6px) at 0.72 opacity", () => {
    const kf = rule(css, "@keyframes headline-compress").replace(/\s+/g, " ");
    expect(kf).toMatch(/to \{ transform: scale\(0\.94\) translateY\(-6px\); opacity: 0\.72; \}/);
  });

  it("is applied only inside @supports — no unguarded animation, transition or state hook", () => {
    const outside = supports.reduce((s, b) => s.replace(b, ""), css);
    expect(rule(outside, ".home-headline")).toBe("");
    expect(css).not.toContain("data-scrolled");
  });

  it("reduced motion swaps to an opacity-only scrub, keeping the timeline", () => {
    const rm = supports.flatMap((b) => blocks(b, "@media (prefers-reduced-motion: reduce)")).map((b) => rule(b, ".home-headline")).join("");
    // animation-name only: the shorthand would reset animation-timeline.
    expect(rm.replace(/\s+/g, " ").trim()).toBe("animation-name: headline-dim;");
    const dim = rule(css, "@keyframes headline-dim");
    expect(dim).toContain("opacity: 0.72");
    expect(dim).not.toContain("transform");
  });

  it("no JS driver: ScrollState is gone from the layout and the tree", () => {
    expect(read("app/layout.jsx")).not.toContain("ScrollState");
    expect(existsSync(resolve(root, "components/ScrollState.jsx"))).toBe(false);
  });

  it("the three headlines still carry the hook class", () => {
    for (const f of ["components/HomeScreen.jsx", "components/PerformanceLab.jsx", "app/locker-room/page.jsx"]) {
      expect(read(f), f).toContain('className="home-headline"');
    }
  });
});
