// tests/session-fixes.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Two live-report fixes (2026-08-03), pinned as code shape.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { decimalsForStep } from "../components/ScrollDrum.jsx";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("split drum — short wheels must actually scroll", () => {
  const src = readFileSync(resolve(root, "components/ScrollDrum.jsx"), "utf8");

  it("the wheel scroller is border-box", () => {
    // content-box + height:100% grew the scroller past its clipping window,
    // so a four-detent decimal wheel never overflowed → could not scroll.
    // Centre maths is identical in both models; only short-list overflow
    // differs — which is why every long wheel masked it.
    expect(src).toContain('boxSizing: "border-box"');
    expect(src).not.toContain('boxSizing: "content-box"');
  });

  it("the geometry that exposed it: a 4-detent wheel overflows a border-box viewport", () => {
    const ITEM_H = 52, VISIBLE = 5, HALF = 2;
    const viewport = ITEM_H * VISIBLE;                       // 260
    const content = decimalsForStep(1.25).length * ITEM_H;   // 4 detents
    const scrollHeight = content + 2 * HALF * ITEM_H;        // + end padding
    expect(scrollHeight).toBeGreaterThan(viewport);          // border-box: scrolls
    expect(scrollHeight).not.toBeGreaterThan(viewport + 2 * HALF * ITEM_H); // content-box: didn't
  });
});

describe("mid-session bodyweight prompt — bodyweight family only", () => {
  it("the gate enumerates the load types that NEED a weigh-in", () => {
    // `!== "external"` also caught per_db/cable/total — a dumbbell curl
    // interrupting the session to ask your weight. Only the bodyweight
    // family's effective load is uncomputable without one.
    const src = readFileSync(resolve(root, "components/SessionHost.jsx"), "utf8");
    const gate = src.slice(src.indexOf("const needsBw"), src.indexOf("setBwEditOpen(true)"));
    expect(gate).toContain('loadType === "bodyweight"');
    expect(gate).toContain('loadType === "loaded_bodyweight"');
    expect(gate).toContain('loadType === "assisted_bodyweight"');
    expect(src).not.toMatch(/loadType !== "external" && bodyweight === null/);
  });
});
