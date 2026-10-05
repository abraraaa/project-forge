// @vitest-environment jsdom
// The live host plans a lift with no working weight from the muscle anchor
// (planStartWeight), and logs that start as the set and the prescription.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, push: () => {} }) }));
vi.mock("@vercel/analytics", () => ({ track: () => {} }));

import SessionHost from "../../components/SessionHost.jsx";
import { P, D, TS, SessionIntent } from "../../lib/storage.js";
import { SESSIONS } from "../../lib/programme.js";

afterEach(cleanup);

const WHO = "Tess";
const SQUAT = "Barbell Back Squat";

function start({ anchors = {} } = {}) {
  P.setActive(WHO);
  P.saveWeights(WHO, {});
  for (const [muscle, a] of Object.entries(anchors)) TS.updateMuscleAnchor(WHO, muscle, a);
  SessionIntent.stash(WHO, { sessionIdx: 0 });
  render(<SessionHost />);
  fireEvent.click(screen.getByText("Normal"));
  fireEvent.click(screen.getByText(/Start session/));
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(SQUAT);
}
const logSet = () => {
  fireEvent.click(screen.getByText("Log set"));
  fireEvent.click(screen.getByText(/Log at/).closest("button"));
};
const loggedSquat = () => D.load(WHO).draft.blocks.a1.exercises[SQUAT];

describe("cold start in the live session", () => {
  it("no working weight, a Quadriceps anchor: the squat plans and logs the anchor start", () => {
    start({ anchors: { Quadriceps: { bestE1RM: 140, bestE1RMLift: "Leg Press" } } });
    logSet();
    const ex = loggedSquat();
    expect(ex.sets[0].weight).toBe(105);
    expect(ex.prescribed.weight).toBe(105);
  });
  it("no anchor and no bodyweight: the template, as before", () => {
    const template = SESSIONS[0].blocks.find((b) => b.ex?.name === SQUAT).ex.weight;
    start();
    logSet();
    expect(loggedSquat().sets[0].weight).toBe(template);
    expect(loggedSquat().prescribed.weight).toBe(template);
  });
});
