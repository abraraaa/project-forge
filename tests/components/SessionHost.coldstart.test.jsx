// @vitest-environment jsdom
// The live host plans a lift with no working weight from the muscle anchor
// (planStartWeight), derived from the history it opened with, and logs that
// start as the set and the prescription.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, push: () => {} }) }));
vi.mock("@vercel/analytics", () => ({ track: () => {} }));

import SessionHost from "../../components/SessionHost.jsx";
import { P, D, H, TS, SessionIntent } from "../../lib/storage.js";
import { SESSIONS } from "../../lib/programme.js";

afterEach(cleanup);

const WHO = "Tess";
const SQUAT = "Barbell Back Squat";

// One earlier squat of 120 x 5: e1RM 140, the Quadriceps anchor.
const SQUAT_DAY = {
  id: "2026-10-01T10:00:00.000Z", date: "2026-10-01", schemaVersion: 3, session: "strength-a", readiness: "normal",
  blocks: [{ id: "a1", type: "main", exercises: [{ name: SQUAT, loadType: "barbell", sets: [
    { weight: 120, reps: 5, rir: 2, loadType: "barbell", effectiveLoad: 120, est1rm: 140 },
  ] }] }],
};

function start({ history = [], storedAnchors = null } = {}) {
  P.setActive(WHO);
  P.saveWeights(WHO, {});
  for (const rec of history) H.append(WHO, rec);
  if (storedAnchors) TS.save(WHO, { ...TS.get(WHO), muscleAnchors: storedAnchors });
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
    start({ history: [SQUAT_DAY] });
    logSet();
    const ex = loggedSquat();
    // 140 x 0.75 = 105.
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
  it("a stored anchor with no history plans nothing from it: the template", () => {
    const template = SESSIONS[0].blocks.find((b) => b.ex?.name === SQUAT).ex.weight;
    start({ storedAnchors: { Quadriceps: { bestE1RM: 140, bestE1RMLift: "Leg Press" } } });
    logSet();
    expect(loggedSquat().sets[0].weight).toBe(template);
  });
});
