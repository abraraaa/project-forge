// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// The retro ledger seeds each row's weight from W. A pure bodyweight row must
// log no weight: its column is hidden, and W for these lifts is not the
// user's, so a stale value there would otherwise be logged as an added load
// (and, with effective load = bodyweight + weight, counted as one).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RetrospectiveSessionSheet } from "../../components/ForgeApp.jsx";

afterEach(cleanup);

describe("RetrospectiveSessionSheet", () => {
  it("a pure bodyweight row logs no weight; loaded rows keep theirs", () => {
    const onSubmit = vi.fn();
    // 2026-09-21 is a Monday; with no history it resolves to Strength A,
    // whose finisher carries Hanging Leg Raise (loadType bodyweight).
    render(
      <RetrospectiveSessionSheet
        date="2026-09-21" bodyweight={80}
        workingWeights={{ "Hanging Leg Raise": 25, "Barbell Back Squat": 100 }}
        workingReps={{}} history={[]}
        onCancel={() => {}} onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByText("Log session"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const rows = onSubmit.mock.calls[0][0].exercises;

    const hlr = rows.find((r) => r.name === "Hanging Leg Raise");
    expect(hlr, "Strength A no longer carries Hanging Leg Raise").toBeTruthy();
    expect(hlr.loadType).toBe("bodyweight");
    expect(hlr.weights.every((w) => w === null)).toBe(true);
    expect(hlr.prescribed.weight).toBeNull();

    const sq = rows.find((r) => r.name === "Barbell Back Squat");
    expect(sq.weights.every((w) => w === 100)).toBe(true);
  });
});
