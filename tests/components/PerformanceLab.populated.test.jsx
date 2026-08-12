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
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
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
    // The volume list header is the contract surface.
    expect(screen.getByText(/Sets per week vs MEV\/MAV\/MRV/i)).toBeTruthy();
    // At least one of the muscles squats credit must surface as a row —
    // anatomy distributes Back Squat across Quads/Glutes/Hams/Core/Calves.
    // We pick Quads as the primary; if it doesn't render, the contract
    // between auditHistoryVolume and VolumeLandscape has broken.
    expect(screen.getAllByText("Quads").length).toBeGreaterThan(0);
  });

  it("renders the session-counts subtitle on the lab header", () => {
    render(<PerformanceLab history={buildHistory()} onBack={() => {}} />);
    // The header strip prints the logged-session count ("… · 5 logged").
    // Assert the count surfaces — the number and the word live in one
    // strip split across spans, so match on the container's text.
    expect(screen.getAllByText(/logged/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("5").length).toBeGreaterThan(0);
  });

  it("§13 sections mount on typed history: strength rows, consistency cells, group aggregates", () => {
    // Weekly cadence, most-recent-first is fine (buildSession only reads the
    // date). Dates MUST be relative to today, not pinned absolutes: the
    // volume audit's group aggregate ("in band") only judges the trailing
    // 2-week window (PerformanceLab.jsx passes { weeks: 2 }), so a hardcoded
    // month silently ages out of that window as real time passes — this
    // test found that the hard way, weeks after it was written and green.
    const today = new Date();
    const history = [0, 1, 2, 3].map((i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - i * 7);
      return buildSession(d.toISOString().slice(0, 10));
    });
    render(<PerformanceLab history={history} onBack={() => {}} />);
    // Strength — one row per main lift, with the section kicker.
    expect(screen.getByText(/Strength · e1RM/)).toBeTruthy();
    expect(screen.getByLabelText(/Barbell Back Squat: estimated 1RM/)).toBeTruthy();
    // Consistency — planned-vs-done streak in mono.
    expect(screen.getByText(/planned/)).toBeTruthy();
    // Group headers carry their aggregate as data.
    expect(screen.getAllByText(/in band/).length).toBeGreaterThan(0);
  });

  it("§07 drill-down: a muscle row unfolds the eight-week band terrain, one at a time", () => {
    render(<PerformanceLab history={buildHistory()} onBack={() => {}} />);
    const quads = screen.getByLabelText(/^Quads: .* sets per week/);
    const glutes = screen.getByLabelText(/^Glutes: .* sets per week/);
    expect(quads.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(quads);
    expect(quads.getAttribute("aria-expanded")).toBe("true");
    // The terrain names the landmarks it draws — the printed figures are
    // half the redundancy law, so their absence is a real regression.
    expect(screen.getByLabelText(/^Quads, last \d+ weeks:/)).toBeTruthy();
    expect(screen.getByText(/weeks in the productive band/)).toBeTruthy();

    // One open at a time: opening another closes the first.
    fireEvent.click(glutes);
    expect(quads.getAttribute("aria-expanded")).toBe("false");
    expect(glutes.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByLabelText(/^Quads, last \d+ weeks:/)).toBeNull();

    // And it closes on a second tap of the same row.
    fireEvent.click(glutes);
    expect(glutes.getAttribute("aria-expanded")).toBe("false");
  });

  it("§07 drill-down: keyboard opens the terrain (Enter and Space)", () => {
    render(<PerformanceLab history={buildHistory()} onBack={() => {}} />);
    const quads = screen.getByLabelText(/^Quads: .* sets per week/);
    fireEvent.keyDown(quads, { key: "Enter" });
    expect(quads.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(quads, { key: " " });
    expect(quads.getAttribute("aria-expanded")).toBe("false");
  });

  it("away suspends judgement, never history — strength and consistency survive", () => {
    // The away state mutes band verdicts and the recommendation; it must
    // NOT hide the e1RM rows or the consistency cells (regression
    // 2026-08-04: an over-eager away gate left only muted muscle rows).
    // Sessions 60+ days old put the audit in away while history exists.
    const stale = ["2026-05-04","2026-05-11","2026-05-18","2026-05-25"].map(buildSession);
    render(<PerformanceLab history={stale} onBack={() => {}} />);
    expect(screen.getByText(/Strength · e1RM/)).toBeTruthy();
    expect(screen.getByText(/planned/)).toBeTruthy();
  });
});
