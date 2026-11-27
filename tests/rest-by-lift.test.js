// Rest follows the lift: 180 s after the heavy lower-body main lifts, 120 s
// after other main and power lifts, and the accessory blocks' own 60 to 90 s.
import { describe, it, expect } from "vitest";
import { SESSIONS, applyMainLiftsToSession } from "../lib/programme.js";

const load = () => import("../lib/programme.js");
const restOf = (session, name) => session.blocks.find((b) => b.ex?.name === name)?.rest;

describe("applyRestToSession", () => {
  it("the default mains: squat and hex bar 180, bench, press and power clean 120", async () => {
    const { applyRestToSession } = await load();
    const [a, b, c] = SESSIONS.map((s) => applyRestToSession(s));
    expect(restOf(a, "Barbell Back Squat")).toBe(180);
    expect(restOf(a, "Barbell Bench Press")).toBe(120);
    expect(restOf(b, "Hex Bar Deadlift")).toBe(180);
    expect(restOf(b, "Barbell Overhead Press")).toBe(120);
    expect(restOf(c, "Power Clean")).toBe(120);
  });
  it("a chosen main lift takes its own rest", async () => {
    const { applyRestToSession } = await load();
    const b = applyRestToSession(applyMainLiftsToSession(SESSIONS[1], { "Hex Bar Deadlift": "Romanian Deadlift" }));
    expect(restOf(b, "Romanian Deadlift")).toBe(180);
    const a = applyRestToSession(applyMainLiftsToSession(SESSIONS[0], { "Barbell Back Squat": "Front Squat" }));
    expect(restOf(a, "Front Squat")).toBe(180);
    const a2 = applyRestToSession(applyMainLiftsToSession(SESSIONS[0], { "Barbell Back Squat": "Hack Squat" }));
    expect(restOf(a2, "Hack Squat")).toBe(120);
  });
  it("accessories and finishers keep 60 to 90 s", async () => {
    const { applyRestToSession } = await load();
    for (const s of SESSIONS.map((x) => applyRestToSession(x))) {
      for (const blk of s.blocks.filter((x) => x.type !== "main")) {
        expect(blk.rest, blk.id).toBeGreaterThanOrEqual(60);
        expect(blk.rest, blk.id).toBeLessThanOrEqual(90);
      }
    }
  });
  it("is pure", async () => {
    const { applyRestToSession } = await load();
    const before = JSON.stringify(SESSIONS[0]);
    applyRestToSession(SESSIONS[0]);
    expect(JSON.stringify(SESSIONS[0])).toBe(before);
  });
});

describe("the session host rests by the lift", () => {
  it("composes the session through applyRestToSession", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../components/SessionHost.jsx", import.meta.url), "utf8");
    expect(src).toMatch(/applyRestToSession\(/);
  });
});
