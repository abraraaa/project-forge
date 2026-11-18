// @vitest-environment jsdom
// The Done screen states what was done from the session's own record:
// "Synced" only once the sync is idle, a main lift not trained today says
// so, and one line gives sets, tonnage and minutes.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { DoneScreen } from "../../components/SessionScreen.jsx";
import { SyncStatus } from "../../lib/storage.js";

afterEach(() => { cleanup(); act(() => SyncStatus._set({ state: "idle" })); });

const SQUAT = "Barbell Back Squat";
const BENCH = "Barbell Bench Press";
const session = {
  name: "Strength A",
  blocks: [
    { id: "a1", type: "main", sets: 3, ex: { name: SQUAT, reps: 5, weight: 100 } },
    { id: "a2", type: "main", sets: 3, ex: { name: BENCH, reps: 5, weight: 60 } },
  ],
};
const set = (weight, reps) => ({ weight, reps, rir: 2, loadType: "barbell", effectiveLoad: weight, volume: weight * reps });
// Squat only: 3 × 5 at 100 and 2 × 8 at 50, 52 minutes.
const record = {
  v: 2, id: "r", date: "2026-11-17", duration: 52 * 60,
  blocks: [
    { id: "a1", type: "main", exercises: [{ name: SQUAT, loadType: "barbell", sets: [set(100, 5), set(100, 5), set(100, 5)] }] },
    { id: "b1", type: "accessory", exercises: [{ name: "Goblet Squat", loadType: "dumbbell", sets: [set(50, 8), set(50, 8)] }] },
  ],
};

const done = (over = {}) => render(<DoneScreen session={session} profileName="Sam" workingWeights={{ [SQUAT]: 102.5, [BENCH]: 60 }}
  sessionStartWeights={{ [SQUAT]: 100, [BENCH]: 60 }} onHome={() => {}} record={record} {...over} />);
const flat = (s) => (s ?? "").replace(/\s+/g, " ").trim();

describe("the Done screen", () => {
  it("states one line from the session's own data", () => {
    const { container } = done();
    expect(flat(container.textContent)).toContain("5 sets · 2.30 t · 52 min");
  });

  it("a main lift not trained today reads Not trained today, never a hold", () => {
    done();
    const bench = screen.getByText(BENCH).parentElement;
    expect(flat(bench.textContent)).toContain("Not trained today");
    expect(flat(bench.textContent)).not.toContain("Hold");
    expect(flat(screen.getByText(SQUAT).parentElement.textContent)).toContain("Next time, heavier.");
  });

  it("says Synced only when the sync is idle, not while it is still pushing", () => {
    act(() => SyncStatus._set({ state: "pushing" }));
    const { container } = done();
    expect(container.textContent).not.toContain("Synced");
    expect(container.textContent).toContain("Syncing");
    act(() => SyncStatus._set({ state: "idle" }));
    expect(container.textContent).toContain("Synced");
  });
});
