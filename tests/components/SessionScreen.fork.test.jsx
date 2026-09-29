// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// The finished-block fork. Logging the last prescribed set no longer moves on
// by itself: the screen offers "Add another set" beside a primary that names
// what comes next ("Next: <exercise>", or "Finish session" on the last block).
// The host side (commits never advance; only onNext does) is pinned in
// tests/revisit-completed-block.test.js.
//
// Text queries, not getByRole: the a11y tree computation throws on this screen.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SessionScreen } from "../../components/SessionScreen.jsx";

afterEach(cleanup);

const squat = { name: "Barbell Back Squat", muscle: "Quads", reps: 5, weight: 100, loadType: "barbell" };
const bench = { name: "Barbell Bench Press", muscle: "Chest", reps: 5, weight: 60, loadType: "barbell" };
const row   = { name: "Seated Cable Row", muscle: "Back", reps: 10, weight: 40, loadType: "cable" };
const main  = { id: "main", type: "main", label: "Main lift", sets: 3, rest: 180, ex: squat };
const ss    = { id: "ss1", type: "superset", label: "Superset", sets: 3, rest: 90, exA: bench, exB: row };

function props(overrides = {}) {
  const block = overrides.block ?? main;
  const isSS = block.type === "superset" || block.type === "finisher";
  const phase = overrides.phase ?? "A";
  const ex = isSS ? (phase === "A" ? block.exA : block.exB) : block.ex;
  return {
    session: { name: "Strength A", blocks: [block] }, block, blockIdx: 0, totalBlocks: 2,
    setNum: 1, phase, isSS,
    activeEx: ex, resolvedExA: block.exA ?? null, resolvedExB: block.exB ?? null, resolvedEx: block.ex ?? null,
    swapKey: block.id, onSwap: () => {},
    showVid: false, setShowVid: () => {}, getW: (e) => e?.weight ?? null, getR: (e) => e?.reps ?? null,
    editTarget: null, setEditTarget: () => {},
    workingWeights: {}, setWW: () => {}, workingReps: {}, setWR: () => {},
    history: [], loggedSets: [], awaitRpe: false, ssRoundDone: false,
    restActive: false, restRemain: 180, setRestActive: () => {}, setRestRemain: () => {},
    onCommit: () => {}, onLog: () => {}, onQuit: () => {}, onShowOverview: () => {},
    bodyweight: 80, canReach: false, reachStep: 2.5, reachArmed: false,
    onTakeReach: () => {}, onDeclineReach: () => {},
    nextExName: "Barbell Bench Press", onNext: () => {},
    ...overrides,
  };
}

const btn = (text) => screen.getByText(text).closest("button");

describe("the finished-block fork", () => {
  it("after the last set, offers both choices side by side, naming the next exercise", () => {
    render(<SessionScreen {...props({ setNum: 4 })} />);
    const add = btn("Add another set");
    const next = btn("Next: Barbell Bench Press");
    expect(add).toBeTruthy();
    expect(next).toBeTruthy();
    expect(add.parentElement).toBe(next.parentElement);   // same row
    expect(next.textContent).toBe("Next: Barbell Bench Press"); // the accessible name
    expect(screen.queryByText(/^Log set/)).toBeNull();
    expect(screen.queryByLabelText("Start rest timer")).toBeNull();
  });

  it("is not offered while a set is still outstanding", () => {
    render(<SessionScreen {...props({ setNum: 3 })} />);
    expect(screen.getByText("Log set")).toBeTruthy();
    expect(screen.queryByText(/^Next:/)).toBeNull();
    expect(screen.queryByText("Add another set")).toBeNull();
  });

  it("Next hands back to the host's advance, once, and logs nothing", () => {
    const onNext = vi.fn(), onLog = vi.fn();
    render(<SessionScreen {...props({ setNum: 4, onNext, onLog })} />);
    fireEvent.click(btn("Next: Barbell Bench Press"));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onLog).not.toHaveBeenCalled();
  });

  it("Add another set leads to Log set 4 with focus on it; after it, the fork returns", () => {
    const onNext = vi.fn(), onLog = vi.fn();
    const { rerender } = render(<SessionScreen {...props({ setNum: 4, onNext, onLog })} />);
    fireEvent.click(btn("Add another set"));
    expect(onNext).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Next:/)).toBeNull();
    const log = btn("Log set 4");
    expect(document.activeElement).toBe(log);
    expect(screen.getByLabelText("Start rest timer")).toBeTruthy();

    fireEvent.click(log);
    expect(onLog).toHaveBeenCalledTimes(1);
    // The host bumps to set 5 on commit; the fork shows again.
    rerender(<SessionScreen {...props({ setNum: 5, onNext, onLog })} />);
    expect(btn("Add another set")).toBeTruthy();
    expect(btn("Next: Barbell Bench Press")).toBeTruthy();
  });

  it("on the last block the primary finishes the session", () => {
    const onNext = vi.fn();
    render(<SessionScreen {...props({ setNum: 4, nextExName: null, onNext })} />);
    expect(screen.queryByText(/^Next:/)).toBeNull();
    fireEvent.click(btn("Finish session"));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("a reach's bonus set is logged, not forked past", () => {
    render(<SessionScreen {...props({ setNum: 4, blockSets: 4 })} />);
    expect(screen.getByText("Log set")).toBeTruthy();
    expect(screen.queryByText("Add another set")).toBeNull();
    cleanup();
    render(<SessionScreen {...props({ setNum: 5, blockSets: 4 })} />);
    expect(btn("Next: Barbell Bench Press")).toBeTruthy();
  });
});

describe("the fork on a superset waits for the round", () => {
  it("never mid-round: B of the last round still logs", () => {
    render(<SessionScreen {...props({ block: ss, setNum: 3, phase: "B" })} />);
    expect(screen.getByText("Log B — round done")).toBeTruthy();
    expect(screen.queryByText(/^Next:/)).toBeNull();
  });

  it("after the round that completes the block, forks and drops the into-B cues", () => {
    render(<SessionScreen {...props({ block: ss, setNum: 4, phase: "A", nextExName: "Farmer Carry" })} />);
    expect(btn("Add another set")).toBeTruthy();
    expect(btn("Next: Farmer Carry")).toBeTruthy();
    expect(screen.queryByText("Log A — into B")).toBeNull();
    expect(screen.queryByText(/Straight into B/)).toBeNull();
    expect(screen.queryByText(/Immediately after/)).toBeNull();
    expect(document.body.textContent.replace(/\s+/g, " ")).toContain("All 3 rounds logged");
  });

  it("an extra round runs A into B as usual", () => {
    render(<SessionScreen {...props({ block: ss, setNum: 4, phase: "A" })} />);
    fireEvent.click(btn("Add another set"));
    expect(btn("Log A — into B")).toBeTruthy();
    expect(screen.queryByText(/^Next:/)).toBeNull();
  });
});

describe("the working-sets hint", () => {
  const HINT = "Log working sets only. Warm-ups don't count.";

  it("shows on a main block before its first set, under the Log button", () => {
    render(<SessionScreen {...props()} />);
    const hint = screen.getByText(HINT);
    const log = btn("Log set");
    // Follows the Log button in document order.
    expect(log.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("goes once a set is logged", () => {
    render(<SessionScreen {...props({ setNum: 2, loggedSets: [{ weight: 100, reps: 5, rpe: "normal" }] })} />);
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("never on a superset, and never at the fork", () => {
    render(<SessionScreen {...props({ block: ss })} />);
    expect(screen.queryByText(HINT)).toBeNull();
    cleanup();
    render(<SessionScreen {...props({ setNum: 4 })} />);
    expect(screen.queryByText(HINT)).toBeNull();
  });
});

describe("the last-block fork with an earlier block left short", () => {
  const last = (over = {}) => props({ setNum: 4, nextExName: null, blockIdx: 1, ...over });

  it("points back at it, keeps Finish anyway and Add another set", () => {
    render(<SessionScreen {...last({ backTo: { idx: 0, name: "Barbell Back Squat" } })} />);
    const back = btn("Back to Barbell Back Squat");
    const finish = btn("Finish anyway");
    expect(back.parentElement).toBe(finish.parentElement);   // one row
    expect(btn("Add another set").parentElement).not.toBe(back.parentElement);
    expect(screen.queryByText("Finish session")).toBeNull();
  });

  it("Back jumps to that block; Finish anyway finishes", () => {
    const onJumpToBlock = vi.fn(), onNext = vi.fn();
    render(<SessionScreen {...last({ backTo: { idx: 2, name: "Barbell Bench Press" }, onJumpToBlock, onNext })} />);
    fireEvent.click(btn("Back to Barbell Bench Press"));
    expect(onJumpToBlock).toHaveBeenCalledWith(2);
    expect(onNext).not.toHaveBeenCalled();
    fireEvent.click(btn("Finish anyway"));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("Add another set still leads to a logged set", () => {
    render(<SessionScreen {...last({ backTo: { idx: 0, name: "Barbell Back Squat" } })} />);
    fireEvent.click(btn("Add another set"));
    expect(btn("Log set 4")).toBeTruthy();
    expect(screen.queryByText(/^Back to/)).toBeNull();
  });

  it("with every earlier block complete, the fork is unchanged", () => {
    render(<SessionScreen {...last({ backTo: null })} />);
    expect(btn("Finish session")).toBeTruthy();
    expect(screen.queryByText("Finish anyway")).toBeNull();
    expect(screen.queryByText(/^Back to/)).toBeNull();
  });
});
