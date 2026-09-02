// The rest timer is a deadline, not a tally of ticks. iOS suspends timers on
// lock, so a decrementing counter stopped counting and a four-minute break read
// as 2:10 on return.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { restRemaining, restDeadline } from "../lib/rest-clock.js";

const host = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../components/SessionHost.jsx"), "utf8");

const T0 = 1_700_000_000_000;

describe("restRemaining", () => {
  it("counts down against the clock", () => {
    const end = restDeadline(180, T0);
    expect(restRemaining(end, T0)).toBe(180);
    expect(restRemaining(end, T0 + 60_000)).toBe(120);
    expect(restRemaining(end, T0 + 179_000)).toBe(1);
  });

  it("is correct across a suspension, which is the whole bug", () => {
    // Phone locked at T+10s, unlocked at T+240s on a 180s rest. The old
    // counter would have read ~170; the clock says it is over.
    const end = restDeadline(180, T0);
    expect(restRemaining(end, T0 + 240_000)).toBe(0);
  });

  it("never goes negative", () => {
    expect(restRemaining(restDeadline(60, T0), T0 + 600_000)).toBe(0);
  });

  it("reads zero for a missing or nonsense deadline", () => {
    for (const v of [null, undefined, NaN, Infinity]) expect(restRemaining(v, T0)).toBe(0);
  });

  it("treats a zero or negative rest as already over", () => {
    expect(restRemaining(restDeadline(0, T0), T0)).toBe(0);
    expect(restRemaining(restDeadline(-5, T0), T0)).toBe(0);
  });
});

describe("the host runs on the deadline", () => {
  it("anchors a wall-clock deadline instead of decrementing", () => {
    expect(host).toContain("restDeadline(restRemain)");
    expect(host).toContain("restRemaining(restEndsAtRef.current)");
    // The old shape: setRestRemain(p => p - 1).
    expect(host).not.toMatch(/setRestRemain\(\s*p\s*=>/);
  });

  it("resyncs when the screen comes back", () => {
    expect(host).toContain('document.addEventListener("visibilitychange", onVisible)');
    expect(host).toContain('document.removeEventListener("visibilitychange", onVisible)');
  });

  it("does not re-anchor on every tick", () => {
    // restRemain in that dep array would make the deadline chase itself.
    const anchor = host.slice(host.indexOf("restEndsAtRef.current = restActive"));
    expect(anchor.slice(0, 400)).toMatch(/\}, \[restActive\]\);/);
  });
});
