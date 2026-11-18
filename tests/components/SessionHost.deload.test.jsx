// @vitest-environment jsdom
// While a deload runs the session opens at the deload weight from a lift's
// first visit, logs it as the prescription, says so in one quiet tag, and
// still lets the lifter dial up. W is never written by the card.
// Text queries, not getByRole: see SessionScreen.surface.test.jsx.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, push: () => {} }) }));
vi.mock("@vercel/analytics", () => ({ track: () => {} }));

import SessionHost from "../../components/SessionHost.jsx";
import { P, D, TS, SessionIntent } from "../../lib/storage.js";
import { T } from "../../lib/tokens.js";

afterEach(cleanup);

const WHO = "Tess";
const SQUAT = "Barbell Back Squat";
const state = (currentWeight) => ({
  currentWeight, nextPrescribed: currentWeight, sessionsCount: 8, consecutiveAdds: 0, consecutiveHolds: 0,
  consecutiveLightMisses: 0, stallSignal: null, history: [], currentRepRange: { reps: 5, sets: 3, baseReps: 5 },
});

function start({ deload }) {
  P.setActive(WHO);
  P.saveWeights(WHO, { [SQUAT]: 100 });
  P.saveReps(WHO, {});
  TS.updateLift(WHO, SQUAT, state(100));
  if (deload) {
    TS.updateMesocycle(WHO, {
      ...TS.get(WHO).mesocycle, currentPhase: "deload",
      activeDeload: { startedAt: new Date().toISOString(), plannedDays: 5, triggeredBy: "stall_convergence", triggeredLifts: [SQUAT], preDeloadWeights: { [SQUAT]: 100 } },
    });
  }
  SessionIntent.stash(WHO, { sessionIdx: 0 });
  const view = render(<SessionHost />);
  fireEvent.click(screen.getByText("Normal"));
  fireEvent.click(screen.getByText(/Start session/));
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(SQUAT);
  return view;
}

const logSet = () => {
  fireEvent.click(screen.getByText("Log set"));
  fireEvent.click(screen.getByText(/Log at/).closest("button"));
};
const loggedSquat = () => D.load(WHO).draft.blocks.a1.exercises[SQUAT];
const flat = (s) => (s ?? "").replace(/\s+/g, " ").trim();

describe("a session inside a deload", () => {
  it("opens at the deload weight, logs it as the prescription, and leaves W alone", () => {
    start({ deload: true });
    logSet();
    expect(loggedSquat().sets[0].weight).toBe(65);
    expect(loggedSquat().prescribed).toMatchObject({ weight: 65 });
    expect(P.getWeights(WHO)).toEqual({ [SQUAT]: 100 });
  });

  it("folds the deload day into the kicker, the word in ink underlined in the day's key", () => {
    const { container } = start({ deload: true });
    expect(flat(container.textContent)).toContain("Set 1 of 3 · Main lift · deload day 1 of 5");
    expect(flat(container.textContent)).not.toContain("deload · day");
    const word = [...container.querySelectorAll("span")].find((s) => s.textContent === "deload");
    expect(word.style).toMatchObject({ color: T.ink, textDecorationLine: "underline", textDecorationColor: T.dayKey.strength, textDecorationThickness: "1px", textUnderlineOffset: "3px" });
  });

  it("dials up with the normal controls, nothing in the way", () => {
    start({ deload: true });
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByLabelText("Add 1.25 kg"));
    logSet();
    expect(loggedSquat().sets[0].weight).toBe(70);
    expect(loggedSquat().prescribed).toMatchObject({ weight: 65 });
  });
});

describe("a session with no deload", () => {
  it("opens at W and never mentions a deload", () => {
    const { container } = start({ deload: false });
    logSet();
    expect(loggedSquat().sets[0].weight).toBe(100);
    expect(container.textContent.toLowerCase()).not.toContain("deload");
    expect(container.innerHTML).not.toContain("underline");
  });
});
