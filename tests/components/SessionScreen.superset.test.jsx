// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// A superset on the session screen. While a round is rated, the round stands
// where the next set's card would: both sides as they will be saved, each
// opening the drum; a finisher round the same. During A, B is one line above
// Log. One counter scheme, Round n of N, on the kicker, the logged rows and
// the end of the block. The rest ring sits with A, never B. The
// single-exercise rating is unchanged.
//
// Text queries, not getByRole: see SessionScreen.surface.test.jsx.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { SessionScreen } from "../../components/SessionScreen.jsx";

afterEach(cleanup);

const flat = (s) => s.replace(/\s+/g, " ").trim();
const squat = { name: "Barbell Back Squat", muscle: "Quads", reps: 5, weight: 100, loadType: "barbell" };
const bench = { name: "Barbell Bench Press", muscle: "Chest", reps: 5, weight: 60, loadType: "barbell" };
const row   = { name: "Seated Cable Row", muscle: "Back", reps: 10, weight: 40, loadType: "cable" };
const main  = { id: "main", type: "main", label: "Main lift", sets: 3, rest: 180, ex: squat };
const ss    = { id: "ss1", type: "superset", label: "Superset", sets: 3, rest: 90, exA: bench, exB: row };

function props(overrides = {}) {
  const block = overrides.block ?? ss;
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
    planWeights: {}, setPlanWeights: () => {}, planReps: {}, setPlanReps: () => {},
    history: [], loggedSets: [], awaitRpe: false, ssRoundDone: false,
    restActive: false, restRemain: 90, setRestActive: () => {}, setRestRemain: () => {},
    onCommit: () => {}, onLog: () => {}, onQuit: () => {}, onShowOverview: () => {},
    bodyweight: 80, canReach: false, reachStep: 2.5, reachArmed: false,
    onTakeReach: () => {}, onDeclineReach: () => {},
    nextExName: "Farmer Carry", onNext: () => {},
    ...overrides,
  };
}

// The host's plan layer, so the drum's Confirm lands back on the screen.
function WithPlan(p) {
  const [editTarget, setEditTarget] = useState(null);
  const [planReps, setPlanReps] = useState({});
  const [planWeights, setPlanWeights] = useState({});
  const getW = (e) => (e ? planWeights[e.name] ?? e.weight ?? null : null);
  const getR = (e) => (e ? planReps[e.name] ?? e.reps ?? null : null);
  return <SessionScreen {...p} {...{ editTarget, setEditTarget, planReps, setPlanReps, planWeights, setPlanWeights, getW, getR }}/>;
}

// The element whose whole text reads exactly `text`, innermost first.
const byText = (text) => screen.queryAllByText((_, el) => !!el && flat(el.textContent) === text).at(-1) ?? null;
const recapRow = (side) => screen.getByText(side, { selector: "span" }).closest("button");
const rating = (over = {}) => props({ ssRoundDone: true, phase: "A", ...over });

describe("rating a round, with the round in front of you", () => {
  it("shows the round just done, not the next set's card", () => {
    const { container } = render(<SessionScreen {...rating()} />);
    expect(byText("Round 1 of 3 · Superset")).toBeTruthy();
    expect(flat(recapRow("A").textContent)).toBe("ABarbell Bench Press60 kg × 5");
    expect(flat(recapRow("B").textContent)).toBe("BSeated Cable Row40 kg × 10");
    expect(screen.getByText("How hard was that round?")).toBeTruthy();
    expect(screen.getByText(/Log at/).closest("button")).toBeTruthy();
    // Nothing of the next set: no name heading, Swap, big number, steppers,
    // target or last-time cells, or progress ticks.
    expect(container.querySelector("h1")).toBeNull();
    expect(screen.queryByText("Swap")).toBeNull();
    expect(container.querySelector('span[style*="font-size: 72px"]')).toBeNull();
    expect(screen.queryByLabelText(/^Add .* kg$/)).toBeNull();
    expect(screen.queryByText("this lift, last time")).toBeNull();
    expect(screen.queryByText(/^Set \d/)).toBeNull();
    expect(screen.queryByText(/^Then /)).toBeNull();
  });

  it("each row opens the drum for its own side", () => {
    const setEditTarget = vi.fn();
    render(<SessionScreen {...rating({ setEditTarget })} />);
    fireEvent.click(recapRow("B"));
    expect(setEditTarget).toHaveBeenLastCalledWith(expect.objectContaining({ exName: "Seated Cable Row", currentKg: 40, currentReps: 10 }));
    fireEvent.click(recapRow("A"));
    expect(setEditTarget).toHaveBeenLastCalledWith(expect.objectContaining({ exName: "Barbell Bench Press", currentKg: 60, currentReps: 5 }));
  });

  it("B's numbers can be put right before the round is saved", () => {
    const { container } = render(<WithPlan {...rating()} />);
    fireEvent.click(recapRow("B"));
    const d = within(container.querySelector('[role="dialog"]'));
    expect(d.getByText("Seated Cable Row")).toBeTruthy();
    fireEvent.click(within(d.getAllByText("reps")[0].parentElement).getByText("8"));
    fireEvent.click(d.getByText(/Confirm/));
    expect(flat(recapRow("B").textContent)).toBe("BSeated Cable Row40 kg × 8");
    expect(flat(recapRow("A").textContent)).toBe("ABarbell Bench Press60 kg × 5");
  });

  it("an assisted lift's row shows the assist it saves", () => {
    const exB = { name: "Assisted Pull-Up", muscle: "Back", reps: 8, weight: 20, loadType: "assisted_bodyweight" };
    render(<SessionScreen {...rating({ block: { ...ss, exB }, resolvedExB: exB })} />);
    expect(flat(recapRow("B").textContent)).toBe("BAssisted Pull-Up−20 kg × 8");
  });

  it("a finisher round shows both its lifts the same way", () => {
    const legRaise = { name: "Hanging Leg Raise", muscle: "Core", reps: 10, weight: null, loadType: "bodyweight" };
    const calf     = { name: "Standing Calf Raise", muscle: "Calves", reps: 15, weight: 35, loadType: "machine" };
    const fin      = { id: "afin", type: "finisher", label: "Finisher", sets: 4, rest: 60, exA: legRaise, exB: calf };
    render(<SessionScreen {...rating({ block: fin, resolvedExA: legRaise, resolvedExB: calf })} />);
    expect(byText("Round 1 of 4 · Finisher")).toBeTruthy();
    expect(flat(recapRow("A").textContent)).toBe("AHanging Leg Raise10 reps");
    expect(flat(recapRow("B").textContent)).toBe("BStanding Calf Raise35 kg × 15");
    expect(screen.getByText("How hard was that round?")).toBeTruthy();
  });

  it("the single-exercise rating keeps its card and its label", () => {
    const { container } = render(<SessionScreen {...props({ block: main, awaitRpe: true })} />);
    expect(container.querySelector("h1").textContent).toBe("Barbell Back Squat");
    expect(screen.getByText("How hard was that?")).toBeTruthy();
    expect(screen.queryByText("How hard was that round?")).toBeNull();
  });
});

describe("the partner is one line, during A only", () => {
  it("during A: what follows and at what numbers, above Log, and no card", () => {
    render(<SessionScreen {...props()} />);
    const line = byText("Then Seated Cable Row · 40 kg × 10, no rest");
    expect(line).toBeTruthy();
    const log = screen.getByText("Log A — into B").closest("button");
    expect(line.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/Straight into B/)).toBeNull();
    expect(screen.queryByText(/Immediately after/)).toBeNull();
  });

  it("nothing during B", () => {
    render(<SessionScreen {...props({ phase: "B" })} />);
    expect(screen.queryByText(/^Then /)).toBeNull();
    expect(screen.queryByText(/Just completed/)).toBeNull();
  });

  it("a target with its own unit prints as it is; a bodyweight partner prints its reps alone", () => {
    const line = (exB) => {
      render(<SessionScreen {...props({ block: { ...ss, exB } })} />);
      const text = flat(screen.getByText(/^Then /).textContent);
      cleanup();
      return text;
    };
    expect(line({ name: "DB Reverse Lunge", reps: "8/leg", weight: 18, loadType: "per_db" }))
      .toBe("Then DB Reverse Lunge · 18 kg × 8/leg, no rest");
    expect(line({ name: "Plank", reps: "20s", weight: null, loadType: "bodyweight" }))
      .toBe("Then Plank · 20s, no rest");
    // Loaded bodyweight keeps its working load, as its rating row does.
    expect(line({ name: "Pull-Up", reps: 8, weight: 10, loadType: "loaded_bodyweight" }))
      .toBe("Then Pull-Up · +10 kg × 8, no rest");
    expect(line({ name: "Push-Up", reps: 12, weight: null, loadType: "bodyweight" }))
      .toBe("Then Push-Up · 12 reps, no rest");
  });
});

describe("one counter: Round n of N", () => {
  it("on the kicker, the logged rows and the end of the block", () => {
    const logged = [{ weight: 60, reps: 5, rpe: 8 }];
    render(<SessionScreen {...props({ setNum: 2, phase: "B", loggedSets: logged })} />);
    expect(byText("Round 2 of 3 · Superset B")).toBeTruthy();
    expect(byText("Round 1")).toBeTruthy();
    expect(screen.queryByText(/^Set\b/)).toBeNull();
    cleanup();
    render(<SessionScreen {...props({ setNum: 4 })} />);
    expect(byText("All 3 rounds logged · Superset")).toBeTruthy();
  });

  it("a single block still counts sets", () => {
    render(<SessionScreen {...props({ block: main, setNum: 2, loggedSets: [{ weight: 100, reps: 5, rpe: 8 }] })} />);
    expect(byText("Set 2 of 3 · Main lift")).toBeTruthy();
    expect(byText("Set 1")).toBeTruthy();
  });
});

describe("the rest ring on a superset", () => {
  it("sits with A, reading the superset's own rest", () => {
    render(<SessionScreen {...props()} />);
    expect(screen.getByLabelText("Start rest timer").textContent).toBe("1:30");
    cleanup();
    render(<SessionScreen {...props({ restActive: true, restRemain: 75 })} />);
    expect(screen.getByLabelText("Resting, 1:15 left — tap to skip")).toBeTruthy();
  });

  it("never during B", () => {
    render(<SessionScreen {...props({ phase: "B" })} />);
    expect(screen.queryByLabelText("Start rest timer")).toBeNull();
    expect(screen.queryByLabelText(/^Resting/)).toBeNull();
  });
});
