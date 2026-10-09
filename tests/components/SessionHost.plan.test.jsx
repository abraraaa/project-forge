// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// The drum is what you did. The live host keeps two layers:
//   - the PRESCRIPTION (W / R in the store): what the engine set. The drum's
//     dot marks it, and every logged exercise records it as `prescribed`.
//   - today's PLAN: the drum's edits, session-scoped. The card shows it, the
//     log records it, the next set inherits it. It never reaches W / R.
// Rendered through the real host and the real store; only the router and
// analytics are stubbed.
//
// Text queries, not getByRole: see SessionScreen.surface.test.jsx.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, push: () => {} }) }));
vi.mock("@vercel/analytics", () => ({ track: () => {} }));

import SessionHost from "../../components/SessionHost.jsx";
import { P, D, TS, SessionIntent } from "../../lib/storage.js";

afterEach(cleanup);

const WHO = "Tess";
const SQUAT = "Barbell Back Squat";
const flat = (s) => s.replace(/\s+/g, " ").trim();

function start({ weights = { [SQUAT]: 100 }, reps = {}, lifts = null } = {}) {
  P.setActive(WHO);
  P.saveWeights(WHO, weights);
  P.saveReps(WHO, reps);
  if (lifts) for (const [name, st] of Object.entries(lifts)) TS.updateLift(WHO, name, st);
  SessionIntent.stash(WHO, { sessionIdx: 0 });
  const view = render(<SessionHost />);
  fireEvent.click(screen.getByText("Normal"));
  fireEvent.click(screen.getByText(/Start session/));
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(SQUAT);
  return view;
}

// The reps cell on the card: its number sits above the "reps" caption.
const repsCell = () => screen.getByText("reps", { selector: "div" }).previousSibling;
const drum = (container) => within(container.querySelector('[role="dialog"]'));
const repsWheel = (d) => within(d.getAllByText("reps")[0].parentElement);
const logSetAt = (notchesUp = 0) => {
  fireEvent.click(screen.getByText("Log set"));
  for (let i = 0; i < notchesUp; i++) fireEvent.keyDown(screen.getByLabelText("Effort, RPE 6 to 10"), { key: "ArrowRight" });
  fireEvent.click(screen.getByText(/Log at/).closest("button"));
};
const loggedSquat = () => D.load(WHO).draft.blocks.a1.exercises[SQUAT];

describe("the drum is today's plan, never the prescription", () => {
  it("spin to 3 and log: the set logs 3, W/R stay, and the next set pre-fills 3", () => {
    const { container } = start();
    expect(repsCell().textContent).toBe("5");

    fireEvent.click(repsCell());
    const d = drum(container);
    fireEvent.click(repsWheel(d).getByText("3"));
    fireEvent.click(d.getByText(/Confirm/));
    expect(repsCell().textContent).toBe("3");

    logSetAt();
    expect(loggedSquat().sets.map((s) => [s.weight, s.reps])).toEqual([[100, 3]]);
    // The prescription is untouched, in state and in the store.
    expect(P.getReps(WHO)).toEqual({});
    expect(P.getWeights(WHO)).toEqual({ [SQUAT]: 100 });

    // The next set inherits the plan, and logs it untouched.
    expect(repsCell().textContent).toBe("3");
    logSetAt();
    expect(loggedSquat().sets.map((s) => s.reps)).toEqual([3, 3]);
  });

  it("a stepper nudge is today's weight too: logged, never written to W", () => {
    start();
    fireEvent.click(screen.getByLabelText("Add 1.25 kg"));
    logSetAt();
    expect(loggedSquat().sets[0].weight).toBe(101.25);
    expect(P.getWeights(WHO)).toEqual({ [SQUAT]: 100 });
  });

  it("the logged exercise carries the prescription, not the drum", () => {
    const { container } = start({ reps: { [SQUAT]: 6 } });
    fireEvent.click(repsCell());
    const d = drum(container);
    fireEvent.click(repsWheel(d).getByText("4"));
    fireEvent.click(d.getByText(/Confirm/));
    fireEvent.click(screen.getByLabelText("Remove 1.25 kg"));
    logSetAt();
    const ex = loggedSquat();
    expect(ex.prescribed).toEqual({ reps: 6, weight: 100, sets: 3 });
    expect(ex.sets[0]).toMatchObject({ reps: 4, weight: 98.75 });
  });

  it("the drum's dot marks the prescription while the wheel sits on the plan", () => {
    const { container } = start({ reps: { [SQUAT]: 6 } });
    fireEvent.click(repsCell());
    let d = drum(container);
    fireEvent.click(repsWheel(d).getByText("4"));
    fireEvent.click(d.getByText(/Confirm/));
    fireEvent.click(repsCell());
    d = drum(container);
    const dotted = (n) => !!repsWheel(d).getByText(String(n)).querySelector('span[aria-hidden="true"]');
    expect(dotted(6)).toBe(true);
    expect(dotted(4)).toBe(false);
  });

  it("a fresh session pre-fills the prescription, whatever the last one spun", () => {
    const { container, unmount } = start();
    fireEvent.click(repsCell());
    const d = drum(container);
    fireEvent.click(repsWheel(d).getByText("3"));
    fireEvent.click(d.getByText(/Confirm/));
    fireEvent.click(screen.getByLabelText("Add 1.25 kg"));
    logSetAt();
    unmount();
    D.clear(WHO);

    start();
    expect(repsCell().textContent).toBe("5");
    expect(flat(document.body.textContent)).toContain("100kg");
  });

  it("a refresh mid-session resumes the plan from the draft", () => {
    const { container, unmount } = start();
    fireEvent.click(repsCell());
    const d = drum(container);
    fireEvent.click(repsWheel(d).getByText("3"));
    fireEvent.click(d.getByText(/Confirm/));
    logSetAt();
    unmount();

    // No intent, a live draft: the host resumes it.
    render(<SessionHost />);
    expect(repsCell().textContent).toBe("3");
    expect(P.getReps(WHO)).toEqual({});
  });
});

describe("what the session says about how the engine read the lift", () => {
  const liftState = (extra) => ({
    currentWeight: 100, sessionsCount: 5, consecutiveHolds: 0, consecutiveLightMisses: 1,
    currentRepRange: { reps: 5, sets: 3, baseReps: 5 }, ...extra,
  });

  it("after a final-set miss, the card asks to own every set", () => {
    start({ lifts: { [SQUAT]: liftState({ history: [{ date: "2026-09-22", decision: "HOLD", rationale: ["last_performance=MISSED_LIGHT", "decision_reason=final_set_miss"] }] }) } });
    expect(screen.getByText("Own all three before we add weight.")).toBeTruthy();
  });

  it("after an adoption, the card says the target moved", () => {
    start({
      reps: { [SQUAT]: 4 },
      lifts: { [SQUAT]: liftState({ adoptedAt: "2026-09-22", adoptedReps: 4, history: [{ date: "2026-09-22", decision: "HOLD", rationale: ["decision_reason=voluntary_shortfall"] }] }) },
    });
    expect(screen.getByText("Moved your target to 4s. You've done that three times.")).toBeTruthy();
  });

  it("says nothing on an ordinary lift", () => {
    start({ lifts: { [SQUAT]: liftState({ history: [{ date: "2026-09-22", decision: "ADD", rationale: ["decision_reason=performed_full_with_rir"] }] }) } });
    expect(screen.queryByText(/Own all/)).toBeNull();
    expect(screen.queryByText(/Moved your target/)).toBeNull();
  });

  it("a last set short at full effort, the rest on target, is celebrated", async () => {
    const { container } = start();
    logSetAt();
    logSetAt();
    fireEvent.click(repsCell());
    const d = drum(container);
    fireEvent.click(repsWheel(d).getByText("4"));
    fireEvent.click(d.getByText(/Confirm/));
    logSetAt(3); // RPE 9.5
    expect(await screen.findByText("Spent. That's the set.", {}, { timeout: 2000 })).toBeTruthy();
    expect(loggedSquat().sets.map((s) => s.reps)).toEqual([5, 5, 4]);
  });
});

describe("a rep target left below its lift's base", () => {
  it("bench stored at 3 under a base of 5: the card shows 5 and the set logs against 5; R waits for finalise", () => {
    const BENCH = "Barbell Bench Press";
    start({
      weights: { [SQUAT]: 100, [BENCH]: 95 },
      reps: { [BENCH]: 3 },
      lifts: { [BENCH]: { currentWeight: 95, sessionsCount: 9, consecutiveHolds: 0, history: [], currentRepRange: { reps: 5, sets: 3, baseReps: 5 } } },
    });
    logSetAt(); logSetAt(); logSetAt();
    fireEvent.click(screen.getByText(`Next: ${BENCH}`));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(BENCH);
    expect(repsCell().textContent).toBe("5");
    logSetAt();
    const ex = D.load(WHO).draft.blocks.a2.exercises[BENCH];
    expect(ex.prescribed.reps).toBe(5);
    expect(ex.sets[0].reps).toBe(5);
    expect(P.getReps(WHO)).toEqual({ [BENCH]: 3 });
  });
});
