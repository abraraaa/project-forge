// Flipping back to a finished block. The set number is no longer clamped onto
// its last set, so advancement and the reach offer are re-pinned here.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(resolve(root, p), "utf8");
const host = src("components/SessionHost.jsx");
const screen = src("components/SessionScreen.jsx");

// The landing set number, as the host computes it.
const landOn = (pairs) => pairs + 1;
const isDone = (setNum, sets) => setNum > sets;

describe("landing set number", () => {
  it("lands on the next set mid-block", () => {
    expect(landOn(0)).toBe(1);
    expect(landOn(2)).toBe(3);
    expect(isDone(landOn(2), 4)).toBe(false);
  });

  it("lands PAST the end of a finished block rather than on its last set", () => {
    expect(landOn(4)).toBe(5);
    expect(isDone(landOn(4), 4)).toBe(true);
  });

  it("a finished block is never mistaken for one set short", () => {
    // min(4+1, 4) = 4, indistinguishable from 3 logged.
    for (const sets of [2, 3, 4]) {
      expect(Math.min(landOn(sets), sets)).toBe(sets);   // what it used to give
      expect(landOn(sets)).toBeGreaterThan(sets);        // what it gives now
    }
  });

  it("fills every set pip when done — i < setNum-1 over block.sets", () => {
    const sets = 4, setNum = landOn(4);
    const filled = Array.from({ length: sets }, (_, i) => i < setNum - 1);
    expect(filled.every(Boolean)).toBe(true);
  });
});

describe("the host no longer clamps", () => {
  it("neither the jump nor the resume path clamps the set number", () => {
    expect(host).toContain("setSetNum(pairs + 1)");
    expect(host).toContain("setSetNum(setsOnCurrent + 1)");
    expect(host).not.toMatch(/setSetNum\(Math\.min\(/);
  });

  it("advancement still fires at or past the last set", () => {
    // An extra set must still advance, so the threshold stays >=.
    expect(host).toMatch(/if \(setNum >= blockSets\)/);
  });

  it("the reach is offered ON the last set, never past it", () => {
    // >= would now fire while revisiting a finished block.
    expect(host).toContain("setNum === blockSets && setNum >= REACH_EARLIEST_SET");
  });
});

describe("the screen presents a finished block as finished", () => {
  it("derives completion from the set number rather than a threaded flag", () => {
    expect(screen).toContain("const blockDone = setNum > block.sets");
  });

  it("stops claiming a set is outstanding", () => {
    expect(screen).toContain("logged · {block.label}");
  });

  it("offers adding a set as a deliberate act, not a primed commit", () => {
    expect(screen).toContain("Add another set");
    expect(screen).toContain("blockDone&&!adding");
  });

  it("resets the choice when the block or set changes", () => {
    expect(screen).toContain("`${block.id}|${setNum}`");
    expect(screen).toContain("if(addKey&&addKey!==thisKey) setAddKey(null)");
  });
});
