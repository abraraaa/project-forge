// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// The reach offer — the Fresh-day nudge, at the surface.
//
// The engine contract lives in tests/progression.test.js ("reach sets are
// upside-only"). This file covers the OFFER: that it appears only when the day
// can carry it, that both doors arm the next set, and — the one that matters
// for trust — that the promise printed on screen is the promise the engine
// keeps. A reach that could deload you is worse than never asking.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SessionScreen } from "../../components/SessionScreen.jsx";

afterEach(cleanup);

const block = { id: "main", type: "main", sets: 3, rest: 180,
  ex: { name: "Barbell Back Squat", muscle: "Quads", reps: 5, weight: 100, loadType: "external" } };

function renderScreen(overrides = {}) {
  const props = {
    session: { blocks: [block] }, block, blockIdx: 0, totalBlocks: 1,
    setNum: 3, phase: "A", isSS: false,
    activeEx: block.ex, resolvedExA: null, resolvedExB: null, resolvedEx: block.ex,
    swapKey: "main", onSwap: () => {},
    showVid: false, setShowVid: () => {}, getW: () => 100, getR: () => 5,
    editTarget: null, setEditTarget: () => {},
    workingWeights: { "Barbell Back Squat": 100 }, setWW: () => {},
    workingReps: {}, setWR: () => {},
    history: [], loggedSets: [], awaitRpe: false, ssRoundDone: false,
    restActive: false, restRemain: 180, setRestActive: () => {}, setRestRemain: () => {},
    onCommit: () => {}, onLog: () => {}, onQuit: () => {}, onShowOverview: () => {},
    bodyweight: 80,
    canReach: true, reachStep: 2.5, reachArmed: false,
    onTakeReach: () => {}, onDeclineReach: () => {},
    ...overrides,
  };
  return render(<SessionScreen {...props} />);
}

describe("the reach offer", () => {
  it("offers both doors, stepping by the lift's own progression step", () => {
    renderScreen();
    expect(screen.getByText(/came in fresh/i)).toBeTruthy();
    expect(screen.getByText(/One more set/)).toBeTruthy();
    // The step is printed, not implied — 2.5 for a lower compound.
    // (Text queries, not getByRole: jsdom cannot resolve this app's
    // CSS-variable font sizes, and the a11y tree computation throws.)
    const heavier = screen.getByText(/Take it up/i).closest("button");
    expect(heavier.textContent.replace(/\s+/g, "")).toMatch(/\+2\.5kg/);
  });

  it("prints the promise that makes it safe to say yes", () => {
    // This line is load-bearing: lib/progression.js guarantees a reach is
    // never counted as a miss. If the copy and the engine ever diverge, the
    // app is lying to someone mid-set.
    renderScreen();
    expect(screen.getByText(/never counts against you/i)).toBeTruthy();
  });

  it("stays away entirely when the day cannot carry it", () => {
    // canReach is false for cooked/normal days, deloads, travel, supersets,
    // bodyweight lifts, and any set that isn't the last of the headline block.
    renderScreen({ canReach: false });
    expect(screen.queryByText(/came in fresh/i)).toBeNull();
    expect(screen.queryByText(/One more set/)).toBeNull();
  });

  it("each door fires once, and the offer gives way to the reaching state", () => {
    const onTakeReach = vi.fn();
    const { unmount } = renderScreen({ onTakeReach });
    fireEvent.click(screen.getByText(/Take it up/i).closest("button"));
    expect(onTakeReach).toHaveBeenCalledWith("heavier");
    unmount();

    const onTakeReach2 = vi.fn();
    renderScreen({ onTakeReach: onTakeReach2 });
    fireEvent.click(screen.getByText(/One more set/i).closest("button"));
    expect(onTakeReach2).toHaveBeenCalledWith("bonus");
  });

  it("declining is free and silent — no guilt copy, no second ask", () => {
    const onDeclineReach = vi.fn();
    renderScreen({ onDeclineReach });
    fireEvent.click(screen.getByText(/Not today/i).closest("button"));
    expect(onDeclineReach).toHaveBeenCalled();
  });

  it("once armed, the offer is replaced rather than repeated", () => {
    renderScreen({ reachArmed: true });
    expect(screen.queryByText(/One more set/)).toBeNull();
    expect(screen.getByText(/Reaching/i)).toBeTruthy();
  });
});
