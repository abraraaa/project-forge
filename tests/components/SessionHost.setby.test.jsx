// @vitest-environment jsdom
// The session card says who set a lift's number when a trainer's change set
// it and it still stands (spec §8.2, in-session line). Read-only: it comes
// from the device-local marks the applier leaves, and writes nothing.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, push: () => {} }) }));
vi.mock("@vercel/analytics", () => ({ track: () => {} }));

import SessionHost, { setByLine } from "../../components/SessionHost.jsx";
import { P, TL, SessionIntent } from "../../lib/storage.js";

afterEach(() => { cleanup(); localStorage.clear(); });

const WHO = "Tess";
const SQUAT = "Barbell Back Squat";
const AT = "2026-10-04T08:00:00.000Z";
const mark = (kind, after, by = "Sam") => ({ [kind]: { id: `hws_${kind}.0`, after, by, at: AT } });
const squatRecord = (id) => ({ id, date: id.slice(0, 10), blocks: [{ id: "a1", exercises: [{ name: SQUAT, prescribed: { weight: 105 } }] }] });

describe("Set by {name} on the session card", () => {
  it("renders the line in ink3 when the trainer's weight and reps stand, and writes nothing", () => {
    P.setActive(WHO);
    P.saveWeights(WHO, { [SQUAT]: 105 });
    P.saveReps(WHO, { [SQUAT]: 6 });
    TL.save(WHO, { pending: [], marks: { [SQUAT]: { ...mark("weight", 105), ...mark("reps", 6) } }, outbox: { acks: [], reverts: [] } });
    const marksBefore = localStorage.getItem(TL.key(WHO));
    SessionIntent.stash(WHO, { sessionIdx: 0 });
    render(<SessionHost />);
    fireEvent.click(screen.getByText("Normal"));
    fireEvent.click(screen.getByText(/Start session/));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(SQUAT);

    const line = screen.getByText("Set by Sam");
    expect(line.style.color).toBe("var(--ink-3)");
    // Showing it writes nothing: the marks stay byte for byte, W/R as set.
    expect(localStorage.getItem(TL.key(WHO))).toBe(marksBefore);
    expect(P.getWeights(WHO)[SQUAT]).toBe(105);
    expect(P.getReps(WHO)[SQUAT]).toBe(6);
  });
});

describe("setByLine", () => {
  const state = (over = {}) => ({ weights: { [SQUAT]: 105 }, reps: { [SQUAT]: 6 }, history: [], ...over });

  it("names the kind when only one number is the trainer's", () => {
    expect(setByLine(mark("weight", 105), SQUAT, state())).toBe("Weight set by Sam");
    expect(setByLine(mark("reps", 6), SQUAT, state())).toBe("Reps set by Sam");
    expect(setByLine({ ...mark("weight", 105), ...mark("reps", 6, "Alex") }, SQUAT, state())).toBe("Weight set by Sam, reps set by Alex");
  });

  it("falls back to 'your trainer' with no public name", () => {
    expect(setByLine(mark("weight", 105, null), SQUAT, state())).toBe("Weight set by your trainer");
  });

  it("goes quiet once the number moved or the lift was trained after it landed", () => {
    expect(setByLine(mark("weight", 105), SQUAT, state({ weights: { [SQUAT]: 107.5 } }))).toBeNull();
    expect(setByLine(mark("weight", 105), SQUAT, state({ history: [squatRecord("2026-10-05T07:00:00.000Z")] }))).toBeNull();
    // A session before it landed, or a travel session after, does not count.
    expect(setByLine(mark("weight", 105), SQUAT, state({ history: [squatRecord("2026-10-03T07:00:00.000Z")] }))).toBe("Weight set by Sam");
    expect(setByLine(mark("weight", 105), SQUAT, state({ history: [{ ...squatRecord("2026-10-05T07:00:00.000Z"), travel: true }] }))).toBe("Weight set by Sam");
  });

  it("shows nothing without a mark", () => {
    expect(setByLine(undefined, SQUAT, state())).toBeNull();
    expect(setByLine({}, SQUAT, state())).toBeNull();
  });
});
