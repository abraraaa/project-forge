// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// PerformanceLab — analytics ↔ VolumeLandscape contract.
//
// The previous smoke tests covered the empty-state plumbing. This file
// exercises the populated-history path: builds a realistic session record,
// renders the lab, and asserts that the VolumeLandscape card actually
// surfaces muscle rows. Catches the bug class where lib/ changes shape
// (e.g. auditHistoryVolume renames a field) and the chart silently breaks.
//
// We don't assert exact set counts — the anatomy distribution is the unit
// concern of lib/exercise-anatomy tests. We just confirm the wiring:
//   - given ≥4 sessions, the lab transitions out of the empty state
//   - the volume-per-muscle card mounts
//   - at least one muscle row renders (the contract has not collapsed)
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import PerformanceLab from "../../components/PerformanceLab.jsx";

afterEach(() => {
  cleanup();
});

// Build a session record close enough to v2-shape that analytics + audit
// happily consume it. Uses a real exercise name (Barbell Back Squat) so
// distributeAcrossMuscles finds an anatomy entry and credits multiple
// muscle groups — keeps the test robust to anatomy table changes.
function buildSession(date) {
  return {
    v: 2,
    id: `${date}T10:00:00.000Z`,
    date,
    readiness: "normal",
    session: "strength A",
    blocks: [
      {
        id: "main", type: "main", sets: 3, rest: 180,
        exercises: [
          {
            name: "Barbell Back Squat",
            muscle: "Quads",
            loadType: "barbell",
            sets: [
              { weight: 100, reps: 5, rir: 2, loadType: "barbell", effectiveLoad: 100, volume: 500 },
              { weight: 100, reps: 5, rir: 2, loadType: "barbell", effectiveLoad: 100, volume: 500 },
              { weight: 100, reps: 5, rir: 2, loadType: "barbell", effectiveLoad: 100, volume: 500 },
            ],
            summary: { totalVolume: 1500 },
          },
        ],
      },
    ],
    summary: { totalVolume: 1500 },
  };
}

// Use dates within the trailing 4-week audit window (window ends `now`).
// VolumeLandscape gates on `audit.sessionsAnalysed >= 4` — feed it five.
function buildHistory() {
  const today = new Date();
  const out = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i * 4); // four-day cadence, all in last 4 weeks
    out.push(buildSession(d.toISOString().slice(0, 10)));
  }
  return out;
}

describe("PerformanceLab — populated history", () => {
  it("exits the empty state and renders the volume-per-muscle card", () => {
    render(<PerformanceLab history={buildHistory()} onBack={() => {}} />);
    // Empty-state copy must NOT be present.
    expect(screen.queryByText(/Nothing to show/i)).toBeNull();
    // Volume card title is the contract surface.
    expect(screen.getByText("Volume per muscle")).toBeTruthy();
    // At least one of the muscles squats credit must surface as a row —
    // anatomy distributes Back Squat across Quads/Glutes/Hams/Core/Calves.
    // We pick Quads as the primary; if it doesn't render, the contract
    // between auditHistoryVolume and VolumeLandscape has broken.
    expect(screen.getAllByText("Quads").length).toBeGreaterThan(0);
  });

  it("renders the session-counts subtitle on the lab header", () => {
    render(<PerformanceLab history={buildHistory()} onBack={() => {}} />);
    // Two surfaces reference the session count: the header subtitle ("5
    // sessions · 2 this week · ...") and the volume landscape footer
    // ("Audited over 4 weeks · 5 sessions"). Both should render — assert
    // we see at least the count appearing somewhere, not exactly once.
    expect(screen.getAllByText(/5 sessions?/i).length).toBeGreaterThan(0);
  });
});
