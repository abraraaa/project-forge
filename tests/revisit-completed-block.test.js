// Flipping back to a finished block. The set number is no longer clamped onto
// its last set, so advancement and the reach offer are re-pinned here. What the
// screen shows for a finished block is rendered in
// tests/components/SessionScreen.surface.test.jsx.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(resolve(root, p), "utf8");
const host = src("components/SessionHost.jsx");

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

  it("logging the last set forks rather than advancing; only Next moves on", () => {
    // Every commit (straight set, superset round, finisher round) bumps the
    // set number, so a finished block lands one past its end: the fork.
    expect(host).not.toMatch(/if \(setNum >= blockSets\)/);
    // The block advance lives in exactly one handler, handed to the screen,
    // and it goes to the next block still short of its sets, never p + 1.
    expect(host).not.toMatch(/setBlockIdx\(p => p \+ 1\)/);
    const next = host.slice(host.indexOf("const handleNext = () => {"));
    expect(next.slice(0, 420)).toContain("const target = nextUnfinishedIdx(activeSession, draftLogRef.current, blockIdx);");
    expect(next.slice(0, 420)).toContain("if (target === null) { finishSession(); return; }");
    expect(next.slice(0, 420)).toContain("setSetNum(loggedOnBlock(draftLogRef.current, activeSession.blocks[target].id) + 1);");
    expect(host).toContain("onNext: handleNext");
    // The screen forks on the host's count, reach bonus included.
    expect(host).toContain("blockSets, nextExName, onNext: handleNext");
  });

  it("the reach is offered ON the last set, never past it", () => {
    // >= would now fire while revisiting a finished block.
    expect(host).toContain("setNum === blockSets && setNum >= REACH_EARLIEST_SET");
  });
});
