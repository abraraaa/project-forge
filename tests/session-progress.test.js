// Which blocks of a live session are left short, read from the draft. Drives
// the last-block fork's "Back to …" in SessionHost.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { unfinishedBlocks, loggedOnBlock, leadExerciseName, nextUnfinishedIdx } from "../lib/session-progress.js";

const host = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../components/SessionHost.jsx"), "utf8");

const sets = (n) => Array.from({ length: n }, () => ({ weight: 50, reps: 5 }));
const session = {
  blocks: [
    { id: "main", type: "main", sets: 3, ex: { name: "Squat" } },
    { id: "ss1", type: "superset", sets: 3, exA: { name: "Bench" }, exB: { name: "Row" } },
    { id: "fin", type: "finisher", sets: 2, exA: { name: "Carry" }, exB: { name: "Plank" } },
  ],
};
const draft = (blocks) => ({ blocks });

describe("nextUnfinishedIdx", () => {
  const sess = { blocks: [{ id: "b1", sets: 3 }, { id: "b2", sets: 3 }, { id: "b3", sets: 3 }, { id: "b4", sets: 3 }] };
  const done = (n) => ({ exercises: { x: { sets: Array(n).fill({}) } } });
  it("skips a block already done out of order and lands on the next short one", () => {
    // b3 was done first via the overview; from b2, Next goes to b4.
    const draft = { blocks: { b2: done(3), b3: done(3) } };
    expect(nextUnfinishedIdx(sess, draft, 1)).toBe(3);
  });
  it("goes to the very next block when it is short", () => {
    expect(nextUnfinishedIdx(sess, { blocks: { b1: done(3), b3: done(2) } }, 0)).toBe(1);
  });
  it("is null when every later block is done, so the fork finishes or points back", () => {
    expect(nextUnfinishedIdx(sess, { blocks: { b3: done(3), b4: done(4) } }, 1)).toBeNull();
    expect(nextUnfinishedIdx(sess, { blocks: {} }, 3)).toBeNull();
  });
  it("counts a superset by rounds and extra sets as complete", () => {
    const ss = { blocks: [{ id: "s1", sets: 3 }, { id: "s2", sets: 3 }] };
    expect(nextUnfinishedIdx(ss, { blocks: { s2: { exercises: { a: { sets: [{}, {}, {}] }, b: { sets: [{}, {}, {}] } } } } }, 0)).toBeNull();
    expect(nextUnfinishedIdx(ss, { blocks: { s2: { exercises: { a: { sets: [{}, {}] }, b: { sets: [{}, {}] } } } } }, 0)).toBe(1);
  });
});

describe("unfinishedBlocks", () => {
  it("straight sets: short and skipped blocks count, in order", () => {
    const d = draft({ main: { exercises: { Squat: { sets: sets(2) } } } });
    expect(unfinishedBlocks(session, d, 2).map((u) => u.idx)).toEqual([0, 1]);
    expect(unfinishedBlocks(session, d, 2)[0]).toMatchObject({ logged: 2, total: 3 });
  });

  it("supersets count rounds, not A+B sets", () => {
    const d = draft({
      main: { exercises: { Squat: { sets: sets(3) } } },
      ss1:  { exercises: { Bench: { sets: sets(2) }, Row: { sets: sets(2) } } },
    });
    expect(unfinishedBlocks(session, d, 2)).toMatchObject([{ idx: 1, logged: 2, total: 3 }]);
    d.blocks.ss1.exercises.Bench.sets = sets(3);
    d.blocks.ss1.exercises.Row.sets = sets(3);
    expect(unfinishedBlocks(session, d, 2)).toEqual([]);
  });

  it("the current block is excluded (defaults to the last)", () => {
    const d = draft({
      main: { exercises: { Squat: { sets: sets(3) } } },
      ss1:  { exercises: { Bench: { sets: sets(3) }, Row: { sets: sets(3) } } },
    });
    expect(unfinishedBlocks(session, d)).toEqual([]);
    expect(unfinishedBlocks(session, d, 0).map((u) => u.idx)).toEqual([2]);
  });

  it("extra sets past the prescription count as complete", () => {
    const d = draft({
      main: { exercises: { Squat: { sets: sets(5) } } },
      ss1:  { exercises: { Bench: { sets: sets(4) }, Row: { sets: sets(4) } } },
    });
    expect(unfinishedBlocks(session, d, 2)).toEqual([]);
  });

  it("no draft: every other block is unfinished", () => {
    expect(unfinishedBlocks(session, null, 2).map((u) => u.idx)).toEqual([0, 1]);
    expect(loggedOnBlock(null, "main")).toBe(0);
  });

  it("names a block by its exercise, or a superset's A", () => {
    expect(leadExerciseName(session.blocks[0])).toBe("Squat");
    expect(leadExerciseName(session.blocks[1])).toBe("Bench");
  });
});

describe("SessionHost wiring", () => {
  it("offers Back only on the last block, through the overview's jump", () => {
    expect(host).toContain("const firstShort  = !nextBlock ? (unfinishedBlocks(activeSession, draftView, blockIdx)[0] ?? null) : null;");
    expect(host).toContain("backTo, onJumpToBlock: handleJumpToBlock,");
    // One jump path: the overview and the fork share it.
    expect(host).toContain("onJumpToBlock={handleJumpToBlock}");
    expect(host.match(/setBlockIdx\(targetIdx\)/g)).toHaveLength(1);
  });
});
