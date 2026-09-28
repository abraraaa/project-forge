// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// The set screen, at the surface: what it prints and what it hands back.
//
// These replace source-text locks that pinned the shape of the code rather
// than what the screen does:
//   - the effort panel commits the dragged number, and the ledger reads it
//     back exactly (was tests/rpe-numeric.test.js "code shape");
//   - a loaded lift with no known weight never calls itself bodyweight
//     (was tests/load-type-pairings.test.js, an indexOf ordering check);
//   - bodyweight lifts take added weight on both the card and the drum
//     (was tests/added-weight-capture.test.js "two surfaces");
//   - a finished block reads as finished when you flip back to it
//     (was tests/revisit-completed-block.test.js "the screen").
//
// Text queries, not getByRole: jsdom cannot resolve this app's CSS-variable
// font sizes, and the a11y tree computation throws on this screen.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { SessionScreen } from "../../components/SessionScreen.jsx";

afterEach(cleanup);

const squat = { name: "Barbell Back Squat", muscle: "Quads", reps: 5, weight: 100, loadType: "barbell" };
const mainBlock = (ex, extra = {}) =>
  ({ id: "main", type: "main", label: "Main lift", sets: 3, rest: 180, ex, ...extra });

function props(overrides = {}) {
  const block = overrides.block ?? mainBlock(squat);
  const ex = overrides.activeEx ?? block.ex;
  return {
    session: { name: "Strength A", blocks: [block] }, block, blockIdx: 0, totalBlocks: 1,
    setNum: 1, phase: "A", isSS: false,
    activeEx: ex, resolvedExA: null, resolvedExB: null, resolvedEx: ex,
    swapKey: "main", onSwap: () => {},
    showVid: false, setShowVid: () => {}, getW: () => 100, getR: (e) => e?.reps ?? null,
    editTarget: null, setEditTarget: () => {},
    workingWeights: {}, setWW: () => {},
    workingReps: {}, setWR: () => {},
    history: [], loggedSets: [], awaitRpe: false, ssRoundDone: false,
    restActive: false, restRemain: 180, setRestActive: () => {}, setRestRemain: () => {},
    onCommit: () => {}, onLog: () => {}, onQuit: () => {}, onShowOverview: () => {},
    bodyweight: 80,
    canReach: false, reachStep: 2.5, reachArmed: false,
    onTakeReach: () => {}, onDeclineReach: () => {},
    ...overrides,
  };
}

// The host owns editTarget; this stands in for it so a tap opens the drum.
function WithDrum(p) {
  const [editTarget, setEditTarget] = useState(null);
  return <SessionScreen {...p} editTarget={editTarget} setEditTarget={setEditTarget} />;
}

const flat = (s) => s.replace(/\s+/g, " ").trim();
const drum = (container) => {
  const el = container.querySelector('[role="dialog"]');
  expect(el, "the drum did not open").toBeTruthy();
  return within(el);
};

// ─── Effort ──────────────────────────────────────────────────────────────────
describe("effort is captured and read back as the number that was dragged", () => {
  it("the effort panel commits the raw RPE, half-steps included", () => {
    const onCommit = vi.fn();
    render(<SessionScreen {...props({ awaitRpe: true, onCommit })} />);

    fireEvent.click(screen.getByText(/Log at/).closest("button"));
    expect(onCommit).toHaveBeenLastCalledWith(8);

    // One notch right on the track is 8.5, and 8.5 is what gets committed —
    // not the band ("normal") it falls in.
    fireEvent.keyDown(screen.getByLabelText("Effort, RPE 6 to 10"), { key: "ArrowRight" });
    fireEvent.click(screen.getByText(/Log at/).closest("button"));
    expect(onCommit).toHaveBeenLastCalledWith(8.5);
    expect(onCommit.mock.calls.every(([v]) => typeof v === "number")).toBe(true);
  });

  it("the set ledger prints a numeric RPE exactly and an enum-era one by its representative", () => {
    render(<SessionScreen {...props({
      setNum: 3,
      loggedSets: [
        { weight: 100, reps: 5, rpe: 8.5 },       // numeric era
        { weight: 100, reps: 5, rpe: "cooked" },  // enum era, never migrated
      ],
    })} />);
    const text = flat(document.body.textContent);
    expect(text).toContain("100 kg × 5 at 8.5");
    expect(text).toContain("100 kg × 5 at 9.5");
  });
});

// ─── The weight card ─────────────────────────────────────────────────────────
describe("the weight card never calls a loaded lift bodyweight", () => {
  it("a loaded lift with no known weight asks for one instead", () => {
    // A swap to a dumbbell lift never trained: no history, no anchor, so no
    // weight. It used to fall through to the "Bodyweight" line.
    const arnold = { name: "Arnold Press", muscle: "Shoulders", reps: 10, weight: null, loadType: "per_db" };
    const { container } = render(<WithDrum {...props({ block: mainBlock(arnold), getW: () => null })} />);
    expect(screen.getByText(/New lift — set your weight/)).toBeTruthy();
    expect(screen.queryByText(/Bodyweight/)).toBeNull();

    fireEvent.click(screen.getByText(/New lift — set your weight/));
    expect(drum(container).getByText("kg / db")).toBeTruthy();
  });

  it("a pure bodyweight lift reads as bodyweight, with the user's own", () => {
    const pushUp = { name: "Decline Push-Up", muscle: "Upper chest", reps: 15, weight: null, loadType: "bodyweight" };
    render(<SessionScreen {...props({ block: mainBlock(pushUp), getW: () => null })} />);
    expect(flat(document.body.textContent)).toContain("Bodyweight · 80 kg");
    expect(screen.queryByText(/New lift/)).toBeNull();
  });
});

// ─── Added weight ────────────────────────────────────────────────────────────
// Both surfaces read acceptsAddedWeight(loadType), never the programme's
// static weight: a Pull-Up is prescribed weight:null but takes a belt.
describe("bodyweight lifts accept added weight on the card and on the drum", () => {
  const pullUp = { name: "Pull-Up", muscle: "Lats", reps: 8, weight: null, loadType: "loaded_bodyweight" };

  it("a loaded-bodyweight lift with no added load offers it, and the drum has a kg wheel", () => {
    const setWW = vi.fn();
    const { container } = render(<WithDrum {...props({ block: mainBlock(pullUp), getW: () => null, setWW })} />);
    expect(flat(document.body.textContent)).toContain("Bodyweight · 80 kg");

    fireEvent.click(screen.getByText("Add weight"));
    const d = drum(container);
    expect(d.getByText("kg")).toBeTruthy();
    expect(d.getByText(/steps of/)).toBeTruthy();
    expect(d.getAllByText("reps").length).toBeGreaterThan(0);

    fireEvent.click(d.getByText(/Confirm/));
    expect(setWW).toHaveBeenCalled();
  });

  it("once it carries a working weight, the card shows the number, not the programme's null", () => {
    render(<SessionScreen {...props({ block: mainBlock(pullUp), getW: () => 10 })} />);
    expect(screen.getByText("10")).toBeTruthy();
    expect(screen.getByText("+ kg")).toBeTruthy();
    expect(screen.getByLabelText("Add 1.25 kg")).toBeTruthy();
    expect(screen.queryByText("Add weight")).toBeNull();
  });

  it("a pure bodyweight lift also shows 'Add weight' today, but its drum is reps-only", () => {
    // Current behaviour, pinned as-is: the button is offered (isBodyweightMovement
    // includes "bodyweight") yet the drum has no kg wheel, because
    // acceptsAddedWeight("bodyweight") is false. Whether pure bodyweight lifts
    // should offer the button at all is an open product question, not settled here.
    const setWW = vi.fn();
    const pushUp = { name: "Decline Push-Up", muscle: "Upper chest", reps: 15, weight: null, loadType: "bodyweight" };
    const { container } = render(<WithDrum {...props({ block: mainBlock(pushUp), getW: () => null, setWW })} />);

    fireEvent.click(screen.getByText("Add weight"));
    const d = drum(container);
    expect(d.queryByText("kg")).toBeNull();
    expect(d.queryByText(/steps of/)).toBeNull();
    expect(d.getAllByText("reps").length).toBeGreaterThan(0);

    fireEvent.click(d.getByText(/Confirm/));
    expect(setWW).not.toHaveBeenCalled();
  });
});

// ─── Revisiting a finished block ─────────────────────────────────────────────
// The host lands one PAST the last set on a finished block (setNum = sets + 1);
// the host side is pinned in tests/revisit-completed-block.test.js.
describe("a finished block reads as finished when you flip back to it", () => {
  const kicker = () => flat(screen.getByText(/Main lift/, { selector: "div" }).textContent);

  it("on the last set, one set is still outstanding", () => {
    render(<SessionScreen {...props({ setNum: 3 })} />);
    expect(kicker()).toBe("Set 3 of 3 · Main lift");
    expect(screen.getByText("Log set")).toBeTruthy();
    expect(screen.queryByText("Add another set")).toBeNull();
  });

  it("past the last set, every set is logged and none is claimed outstanding", () => {
    render(<SessionScreen {...props({ setNum: 4 })} />);
    expect(kicker()).toBe("All 3 sets logged · Main lift");
    expect(flat(document.body.textContent)).not.toContain("Set 4 of 3");
  });

  it("adding a set is a deliberate act, not a primed commit", () => {
    const onLog = vi.fn();
    render(<SessionScreen {...props({ setNum: 4, onLog })} />);
    expect(screen.queryByText(/^Log set/)).toBeNull();
    expect(screen.queryByLabelText("Start rest timer")).toBeNull();

    fireEvent.click(screen.getByText("Add another set").closest("button"));
    expect(onLog).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Start rest timer")).toBeTruthy();

    fireEvent.click(screen.getByText("Log set 4").closest("button"));
    expect(onLog).toHaveBeenCalledTimes(1);
  });

  const other = mainBlock(
    { name: "Barbell Bench Press", muscle: "Chest", reps: 5, weight: 50, loadType: "barbell" },
    { id: "b2" },
  );

  it("the choice to add covers one set on one block, never the next", () => {
    const { rerender } = render(<SessionScreen {...props({ setNum: 4 })} />);
    fireEvent.click(screen.getByText("Add another set").closest("button"));
    expect(screen.getByText("Log set 4")).toBeTruthy();

    // The extra set is logged: the host moves to set 5, and the quiet offer
    // comes back rather than a primed "Log set 5".
    rerender(<SessionScreen {...props({ setNum: 5 })} />);
    expect(screen.getByText("Add another set")).toBeTruthy();
    expect(screen.queryByText("Log set 5")).toBeNull();

    // Flipping to another finished block at the same set number does not
    // inherit the choice either.
    fireEvent.click(screen.getByText("Add another set").closest("button"));
    rerender(<SessionScreen {...props({ block: other, setNum: 5 })} />);
    expect(screen.getByText("Add another set")).toBeTruthy();
    expect(screen.queryByText("Log set 5")).toBeNull();
  });

  it("the choice to add resets when the block changes and you come back", () => {
    const { rerender } = render(<SessionScreen {...props({ setNum: 4 })} />);
    fireEvent.click(screen.getByText("Add another set").closest("button"));
    expect(screen.getByText("Log set 4")).toBeTruthy();

    rerender(<SessionScreen {...props({ block: other, setNum: 1 })} />);
    expect(kicker()).toBe("Set 1 of 3 · Main lift");

    rerender(<SessionScreen {...props({ setNum: 4 })} />);
    expect(screen.getByText("Add another set")).toBeTruthy();
    expect(screen.queryByText("Log set 4")).toBeNull();
  });
});
