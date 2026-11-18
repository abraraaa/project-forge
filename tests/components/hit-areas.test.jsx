// @vitest-environment jsdom
// Quit, the session overview button, the Lab's Home link and the share glyph
// each take a 44px hit area, with negative margins that keep their pixels
// where they were.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SessionScreen } from "../../components/SessionScreen.jsx";
import PerformanceLab from "../../components/PerformanceLab.jsx";

afterEach(cleanup);

const squat = { name: "Barbell Back Squat", muscle: "Quads", reps: 5, weight: 100, loadType: "barbell" };
const main = { id: "main", type: "main", label: "Main lift", sets: 3, rest: 180, ex: squat };
const sessionProps = {
  session: { name: "Strength A", blocks: [main] }, block: main, blockIdx: 0, totalBlocks: 2, setNum: 1, phase: "A", isSS: false,
  activeEx: squat, resolvedExA: null, resolvedExB: null, resolvedEx: squat, swapKey: "main", onSwap: () => {},
  showVid: false, setShowVid: () => {}, getW: (e) => e?.weight ?? null, getR: (e) => e?.reps ?? null,
  editTarget: null, setEditTarget: () => {}, planWeights: {}, setPlanWeights: () => {}, planReps: {}, setPlanReps: () => {},
  history: [], loggedSets: [], awaitRpe: false, ssRoundDone: false,
  restActive: false, restRemain: 180, setRestActive: () => {}, setRestRemain: () => {},
  onCommit: () => {}, onLog: () => {}, onQuit: () => {}, onShowOverview: () => {}, bodyweight: 80,
};

const day = (date) => ({
  v: 2, id: `${date}T10:00:00.000Z`, date, readiness: "normal", session: "strength-a",
  blocks: [{ id: "a1", type: "main", exercises: [{ name: "Barbell Back Squat", muscle: "Quads", loadType: "barbell",
    sets: Array.from({ length: 3 }, () => ({ weight: 100, reps: 5, rir: 2, loadType: "barbell", effectiveLoad: 100, est1rm: 116, volume: 500 })) }] }],
});
const history = () => {
  const out = [];
  for (let i = 0; i < 6; i++) { const d = new Date(); d.setDate(d.getDate() - i * 4); out.push(day(d.toISOString().slice(0, 10))); }
  return out;
};

/** At least 44 × 44, with the height it adds given back by its margins. */
function expectHit44(el) {
  const s = el.style;
  const h = parseFloat(s.minHeight || s.height);
  const w = parseFloat(s.minWidth || s.width);
  expect(h).toBeGreaterThanOrEqual(44);
  expect(w).toBeGreaterThanOrEqual(44);
  expect(parseFloat(s.marginTop)).toBeLessThan(0);
  expect(parseFloat(s.marginBottom)).toBeLessThan(0);
}

describe("44px hit areas, same pixels", () => {
  it("Quit and the overview button", () => {
    render(<SessionScreen {...sessionProps} />);
    expectHit44(screen.getByText("Quit").closest("button"));
    expectHit44(screen.getByLabelText("Open session overview"));
  });

  it("the Lab's Home link and the share glyph", () => {
    render(<PerformanceLab history={history()} onBack={() => {}} />);
    expectHit44(screen.getByText("Home").closest("button"));
    const share = screen.getAllByLabelText(/^Share .* trend$/)[0];
    expectHit44(share);
    // The 15 × 19 box it replaced: 29px and 25px given back.
    expect(share.style.marginLeft).toBe("-29px");
    expect(share.style.marginTop).toBe("-12.5px");
  });
});
