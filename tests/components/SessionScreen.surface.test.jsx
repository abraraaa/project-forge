// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// The set screen, at the surface: what it prints and what it hands back.
//
// These replace source-text locks that pinned the shape of the code rather
// than what the screen does:
//   - the effort panel commits the dragged number, and the ledger reads it
//     back exactly (was tests/rpe-numeric.test.js "code shape");
//   - a loaded lift with no known weight never calls itself bodyweight
//     (was tests/load-type-pairings.test.js, an indexOf ordering check);
//   - bodyweight lifts take added weight on both the card and the drum,
//     optionally for pure and loaded alike (pure in its own store, loaded in W)
//     (was tests/added-weight-capture.test.js "two surfaces");
//   - a finished block reads as finished when you flip back to it
//     (was tests/revisit-completed-block.test.js "the screen").
//
// "W" below is the weight map the screen is handed: the host's plan for
// today (planWeights, session-scoped, defaulting to the prescription). The
// screen writes only the plan; the prescription is the engine's
// (tests/components/SessionHost.plan.test.jsx).
//
// Text queries, not getByRole: jsdom cannot resolve this app's CSS-variable
// font sizes, and the a11y tree computation throws on this screen.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { SessionScreen } from "../../components/SessionScreen.jsx";

afterEach(cleanup);

const squat = { name: "Barbell Back Squat", muscle: "Quads", reps: 5, weight: 100, loadType: "barbell" };
const mainBlock = (ex, extra = {}) =>
  ({ id: "main", type: "main", label: "Main lift", sets: 3, rest: 180, ex, ...extra });

function props(overrides = {}) {
  const block = overrides.block ?? mainBlock(squat);
  const ex = overrides.activeEx ?? block.ex;
  return {
    session: { name: "Strength A", blocks: [block] }, block, blockIdx: 0, totalBlocks: 1,
    setNum: 1, phase: "A", isSS: false,
    activeEx: ex, resolvedExA: null, resolvedExB: null, resolvedEx: ex,
    swapKey: "main", onSwap: () => {},
    showVid: false, setShowVid: () => {}, getW: () => 100, getR: (e) => e?.reps ?? null,
    editTarget: null, setEditTarget: () => {},
    planWeights: {}, setPlanWeights: () => {},
    planReps: {}, setPlanReps: () => {},
    history: [], loggedSets: [], awaitRpe: false, ssRoundDone: false,
    restActive: false, restRemain: 180, setRestActive: () => {}, setRestRemain: () => {},
    onCommit: () => {}, onLog: () => {}, onQuit: () => {}, onShowOverview: () => {},
    bodyweight: 80,
    canReach: false, reachStep: 2.5, reachArmed: false,
    onTakeReach: () => {}, onDeclineReach: () => {},
    ...overrides,
  };
}

// The host owns editTarget; this stands in for it so a tap opens the drum.
function WithDrum(p) {
  const [editTarget, setEditTarget] = useState(null);
  return <SessionScreen {...p} editTarget={editTarget} setEditTarget={setEditTarget} />;
}

// The host also owns the added-load store (SessionHost setAddedLoad); this
// stands in for it so a confirmed drum lands back on the card.
function WithVest({ initial = {}, onAddedLoad, ...p }) {
  const [editTarget, setEditTarget] = useState(null);
  const [addedLoads, setAddedLoads] = useState(initial);
  const setAddedLoad = (name, kg) => { onAddedLoad?.(name, kg); setAddedLoads((m) => ({ ...m, [name]: { kg, updatedAt: "2026-09-28T00:00:00.000Z" } })); };
  return <SessionScreen {...p} editTarget={editTarget} setEditTarget={setEditTarget} addedLoads={addedLoads} setAddedLoad={setAddedLoad} />;
}
// The drum's optional kg wheel, scoped through its label. Scope through the
// dialog: the card chip carries the same text while the drum is open.
const kgWheel = (d) => within(d.getByText("+ kg · optional").parentElement);
// The reps (or seconds) wheel, scoped through its label the same way.
const repsWheel = (d, label) => within(d.getAllByText(label)[0].parentElement);
// A distinct stale working weight, so reading or seeding from W is caught.
const phantom = { getW: () => 37, planWeights: { "Decline Push-Up": 37 } };

const flat = (s) => s.replace(/\s+/g, " ").trim();
const drum = (container) => {
  const el = container.querySelector('[role="dialog"]');
  expect(el, "the drum did not open").toBeTruthy();
  return within(el);
};

// ─── Effort ──────────────────────────────────────────────────────────────────
describe("effort is captured and read back as the number that was dragged", () => {
  it("the effort panel commits the raw RPE, half-steps included", () => {
    const onCommit = vi.fn();
    render(<SessionScreen {...props({ awaitRpe: true, onCommit })} />);

    fireEvent.click(screen.getByText(/Log at/).closest("button"));
    expect(onCommit).toHaveBeenLastCalledWith(8);

    // One notch right on the track is 8.5, and 8.5 is what gets committed —
    // not the band ("normal") it falls in.
    fireEvent.keyDown(screen.getByLabelText("Effort, RPE 6 to 10"), { key: "ArrowRight" });
    fireEvent.click(screen.getByText(/Log at/).closest("button"));
    expect(onCommit).toHaveBeenLastCalledWith(8.5);
    expect(onCommit.mock.calls.every(([v]) => typeof v === "number")).toBe(true);
  });

  it("the set ledger prints a numeric RPE exactly and an enum-era one by its representative", () => {
    render(<SessionScreen {...props({
      setNum: 3,
      loggedSets: [
        { weight: 100, reps: 5, rpe: 8.5 },       // numeric era
        { weight: 100, reps: 5, rpe: "cooked" },  // enum era, never migrated
      ],
    })} />);
    const text = flat(document.body.textContent);
    expect(text).toContain("100 kg × 5 at 8.5");
    expect(text).toContain("100 kg × 5 at 9.5");
  });
});

// ─── The weight card ─────────────────────────────────────────────────────────
describe("the weight card never calls a loaded lift bodyweight", () => {
  it("a loaded lift with no known weight asks for one instead", () => {
    // A swap to a dumbbell lift never trained: no history, no anchor, so no
    // weight. It used to fall through to the "Bodyweight" line.
    const arnold = { name: "Arnold Press", muscle: "Shoulders", reps: 10, weight: null, loadType: "per_db" };
    const { container } = render(<WithDrum {...props({ block: mainBlock(arnold), getW: () => null })} />);
    expect(screen.getByText(/New lift — set your weight/)).toBeTruthy();
    expect(screen.queryByText(/Bodyweight/)).toBeNull();

    fireEvent.click(screen.getByText(/New lift — set your weight/));
    expect(drum(container).getByText("kg / db")).toBeTruthy();
  });

  it("a pure bodyweight lift reads as bodyweight, with the user's own", () => {
    const pushUp = { name: "Decline Push-Up", muscle: "Upper chest", reps: 15, weight: null, loadType: "bodyweight" };
    render(<SessionScreen {...props({ block: mainBlock(pushUp), getW: () => null })} />);
    expect(flat(document.body.textContent)).toContain("Bodyweight · 80 kg");
    expect(screen.queryByText(/New lift/)).toBeNull();
  });
});

// ─── Added weight ────────────────────────────────────────────────────────────
// Loaded lifts read acceptsAddedWeight(loadType), never the programme's
// static weight: a Pull-Up is prescribed weight:null but takes a belt. Pure
// and loaded bodyweight share the optional chrome (usesOptionalChrome); only
// the store differs — pure bodyweight has its own, loaded bodyweight keeps W.

// The host's plan for a loaded-bodyweight lift: getW reads it, setPlanWeights
// writes it, so a confirmed drum lands back on the card.
function WithBelt({ initial = {}, onSetWW, ...p }) {
  const [editTarget, setEditTarget] = useState(null);
  const [ww, setWWState] = useState(initial);
  const setPlanWeights = (fn) => { const next = fn(ww); onSetWW?.(next); setWWState(next); };
  return <SessionScreen {...p} editTarget={editTarget} setEditTarget={setEditTarget}
    planWeights={ww} setPlanWeights={setPlanWeights} getW={(ex) => ww[ex?.name] ?? ex?.weight ?? null} />;
}

describe("loaded bodyweight lifts present added weight as optional, stored in W", () => {
  const pullUp = { name: "Pull-Up", muscle: "Lats", reps: 8, weight: null, loadType: "loaded_bodyweight" };
  const bigNumber = (container) => container.querySelector('span[style*="font-size: 72px"]');

  for (const [label, initial] of [["null", {}], ["0", { "Pull-Up": 0 }]]) {
    it(`with W ${label}: "Bodyweight · 80 kg" and the quiet optional chip`, () => {
      const { container } = render(<WithBelt {...props({ block: mainBlock(pullUp) })} initial={initial} />);
      expect(flat(document.body.textContent)).toContain("Bodyweight · 80 kg");
      expect(screen.getByText("+ kg · optional")).toBeTruthy();
      expect(screen.getByLabelText(/tap to add weight/)).toBeTruthy();
      expect(screen.queryByText("Add weight")).toBeNull();
      expect(screen.queryByText("Added load")).toBeNull();
      expect(screen.queryByLabelText("Add 1.25 kg")).toBeNull();
      expect(bigNumber(container)).toBeNull();
    });
  }

  it("with W 5: \"Bodyweight + 5 kg\", tap to edit — no big number, no steppers", () => {
    const { container } = render(<WithBelt {...props({ block: mainBlock(pullUp) })} initial={{ "Pull-Up": 5 }} />);
    expect(flat(document.body.textContent)).toContain("Bodyweight + 5 kg");
    expect(screen.getByLabelText(/edit added weight/)).toBeTruthy();
    expect(screen.queryByText("+ kg · optional")).toBeNull();
    expect(screen.queryByLabelText("Add 1.25 kg")).toBeNull();
    expect(bigNumber(container)).toBeNull();
  });

  it("the chip opens the optional wheel; Confirm 7.5 writes today's W, never the added-load store", () => {
    const onSetWW = vi.fn(), onAddedLoad = vi.fn(), setPlanReps = vi.fn();
    const { container } = render(<WithBelt {...props({ block: mainBlock(pullUp), setAddedLoad: onAddedLoad, setPlanReps })} onSetWW={onSetWW} />);
    fireEvent.click(screen.getByText("+ kg · optional"));
    const d = drum(container);
    expect(kgWheel(d).getByText("none")).toBeTruthy();
    expect(d.queryByText(/steps of/)).toBeNull();
    fireEvent.click(kgWheel(d).getByText("7.5"));
    fireEvent.click(d.getByText(/Confirm/));
    expect(onSetWW).toHaveBeenLastCalledWith({ "Pull-Up": 7.5 });
    expect(onAddedLoad).not.toHaveBeenCalled();
    // Reps behave as on any loaded lift: Confirm writes today's reps.
    expect(setPlanReps).toHaveBeenCalled();
    expect(flat(document.body.textContent)).toContain("Bodyweight + 7.5 kg");

    // "none" writes 0 — the engine reads that as unloaded — and the chip returns.
    fireEvent.click(screen.getByLabelText(/edit added weight/));
    const d2 = drum(container);
    fireEvent.click(kgWheel(d2).getByText("none"));
    fireEvent.click(d2.getByText(/Confirm/));
    expect(onSetWW).toHaveBeenLastCalledWith({ "Pull-Up": 0 });
    expect(onAddedLoad).not.toHaveBeenCalled();
    expect(screen.getByText("+ kg · optional")).toBeTruthy();
  });

  it("\"this lift, last time\" reads a loaded-bodyweight set's weight as added kg", () => {
    const history = [{ id: "2026-09-20T10:00:00.000Z", date: "2026-09-20", blocks: [{ exercises: [
      { name: "Pull-Up", loadType: "loaded_bodyweight", sets: [{ weight: 5, reps: 6, rpe: 8, loadType: "loaded_bodyweight" }] }] }] }];
    render(<WithBelt {...props({ block: mainBlock(pullUp), history })} />);
    expect(flat(document.body.textContent)).toContain("5 × 6");
    fireEvent.click(screen.getByLabelText(/Recent history for/));
    expect(flat(screen.getByRole("dialog").textContent)).toContain("1×6 @ 5 kg");
  });

  it("a pure bodyweight lift still writes its added-load store, not W", () => {
    const pushUp = { name: "Decline Push-Up", muscle: "Upper chest", reps: 15, weight: null, loadType: "bodyweight" };
    const setPlanWeights = vi.fn(), onAddedLoad = vi.fn();
    const { container } = render(<WithVest {...props({ block: mainBlock(pushUp), getW: () => null, setPlanWeights })} onAddedLoad={onAddedLoad} />);
    fireEvent.click(screen.getByText("+ kg · optional"));
    const d = drum(container);
    fireEvent.click(kgWheel(d).getByText("7.5"));
    fireEvent.click(d.getByText(/Confirm/));
    expect(onAddedLoad).toHaveBeenCalledWith("Decline Push-Up", 7.5);
    expect(setPlanWeights).not.toHaveBeenCalled();
  });

  it("an assisted lift keeps its assistance drum", () => {
    const assisted = { name: "Assisted Pull-Up", muscle: "Lats", loadType: "assisted_bodyweight", weight: null, reps: 8 };
    const { container } = render(<WithDrum {...props({ block: mainBlock(assisted), getW: () => null })} />);
    expect(screen.getByText("Set assistance")).toBeTruthy();
    expect(screen.queryByText("+ kg · optional")).toBeNull();

    fireEvent.click(screen.getByText("Set assistance"));
    const d = drum(container);
    expect(d.getByText(/steps of/)).toBeTruthy();
    expect(d.queryByText("none")).toBeNull();
  });

  it("a superset of Push-Up and Pull-Up wears the same chrome on both", () => {
    const pushUp = { name: "Push-Up", muscle: "Chest", reps: 12, weight: null, loadType: "bodyweight" };
    const ss = { id: "ss1", type: "superset", label: "Superset", sets: 3, rest: 90, exA: pushUp, exB: pullUp };
    const card = (ex) => {
      const { container, unmount } = render(<WithBelt {...props({ block: ss, activeEx: ex, isSS: true, resolvedExA: pushUp, resolvedExB: pullUp })} />);
      const chip = screen.getByLabelText(/tap to add weight/);
      const out = { line: flat(chip.parentElement.textContent), chip: chip.getAttribute("style"),
        big: !!bigNumber(container), steppers: !!screen.queryByLabelText("Add 1.25 kg") };
      unmount();
      return out;
    };
    const a = card(pushUp), b = card(pullUp);
    expect(a.line).toBe("Bodyweight · 80 kg+ kg · optional");
    expect(b).toEqual(a);
  });
});

describe("pure bodyweight lifts take an optional added weight — never W", () => {
  const pushUp = { name: "Decline Push-Up", muscle: "Upper chest", reps: 15, weight: null, loadType: "bodyweight" };
  const bigNumber = (container) => container.querySelector('span[style*="font-size: 72px"]');

  it("no vest: bodyweight line plus a quiet optional chip; the phantom never shows", () => {
    const { container } = render(<WithVest {...props({ block: mainBlock(pushUp), ...phantom })} />);
    const text = flat(document.body.textContent);
    expect(text).toContain("Bodyweight · 80 kg");
    expect(text).not.toContain("37");
    expect(bigNumber(container)).toBeNull();
    expect(screen.queryByLabelText("Add 1.25 kg")).toBeNull();
    expect(screen.queryByText("Add weight")).toBeNull();
    expect(screen.getByText("+ kg · optional")).toBeTruthy();
    expect(screen.getByLabelText(/tap to add weight/)).toBeTruthy();
  });

  it("the chip opens a drum: optional kg wheel, 0 reads \"none\" in the text face, reps unchanged", () => {
    const { container } = render(<WithVest {...props({ block: mainBlock(pushUp), ...phantom })} />);
    fireEvent.click(screen.getByText("+ kg · optional"));
    const d = drum(container);
    expect(d.getByText("+ kg · optional")).toBeTruthy();
    expect(kgWheel(d).getByText("none").style.fontFamily).toContain("familjen");
    expect(kgWheel(d).getByText("10").style.fontFamily).toContain("spline");
    expect(d.queryByText(/steps of/)).toBeNull();
    expect(d.getAllByText("reps").length).toBeGreaterThan(0);
  });

  it("Confirm writes the added load, never W", () => {
    const setPlanWeights = vi.fn(), setPlanReps = vi.fn(), onAddedLoad = vi.fn();
    const { container } = render(<WithVest {...props({ block: mainBlock(pushUp), ...phantom, setPlanWeights, setPlanReps })} onAddedLoad={onAddedLoad} />);
    fireEvent.click(screen.getByText("+ kg · optional"));
    const d = drum(container);
    fireEvent.click(kgWheel(d).getByText("10"));
    fireEvent.click(d.getByText(/Confirm/));
    expect(onAddedLoad).toHaveBeenCalledWith("Decline Push-Up", 10);
    expect(setPlanWeights).not.toHaveBeenCalled();
    // The reps wheel was left alone, so the rep target is too.
    expect(setPlanReps).not.toHaveBeenCalled();
  });

  it("a vest on a per-leg lift keeps its per-leg reps", () => {
    // A string target seeds the reps wheel at 8; a vest-only confirm wrote
    // that 8 over "15/leg" (and, keyed by name, over the gym lift's target).
    const calf = { name: "Single-Leg Calf Raise", muscle: "Calves", reps: "15/leg", weight: null, loadType: "bodyweight" };
    const setPlanWeights = vi.fn(), setPlanReps = vi.fn(), onAddedLoad = vi.fn();
    const { container } = render(<WithVest {...props({ block: mainBlock(calf), getW: () => 37, planWeights: { "Single-Leg Calf Raise": 37 }, setPlanWeights, setPlanReps })} onAddedLoad={onAddedLoad} />);
    fireEvent.click(screen.getByText("+ kg · optional"));
    const d = drum(container);
    fireEvent.click(kgWheel(d).getByText("10"));
    fireEvent.click(d.getByText(/Confirm/));
    expect(onAddedLoad).toHaveBeenCalledWith("Single-Leg Calf Raise", 10);
    expect(setPlanReps).not.toHaveBeenCalled();
    expect(setPlanWeights).not.toHaveBeenCalled();
  });

  it("a touched reps wheel writes its value, even when it lands back on the seed", () => {
    const calf = { name: "Single-Leg Calf Raise", muscle: "Calves", reps: "15/leg", weight: null, loadType: "bodyweight" };
    const setPlanWeights = vi.fn(), setPlanReps = vi.fn(), onAddedLoad = vi.fn();
    const { container } = render(<WithVest {...props({ block: mainBlock(calf), getW: () => 37, planWeights: { "Single-Leg Calf Raise": 37 }, setPlanWeights, setPlanReps })} onAddedLoad={onAddedLoad} />);
    fireEvent.click(screen.getByText("15/leg"));
    const d = drum(container);
    fireEvent.click(repsWheel(d, "reps").getByText("9"));
    fireEvent.click(repsWheel(d, "reps").getByText("8"));
    fireEvent.click(d.getByText(/Confirm/));
    expect(setPlanReps.mock.calls[0][0]({})).toEqual({ "Single-Leg Calf Raise": 8 });
    expect(onAddedLoad).not.toHaveBeenCalled();
    expect(setPlanWeights).not.toHaveBeenCalled();
  });

  it("focus returns to the added-weight control after the drum closes, both ways", () => {
    const { container } = render(<WithVest {...props({ block: mainBlock(pushUp), ...phantom })} />);
    const chip = screen.getByLabelText(/tap to add weight/);
    chip.focus();
    fireEvent.click(chip);
    const d = drum(container);
    fireEvent.click(kgWheel(d).getByText("10"));
    fireEvent.click(d.getByText(/Confirm/));
    const edit = screen.getByLabelText(/edit added weight/);
    expect(document.activeElement).toBe(edit);

    fireEvent.click(edit);
    const d2 = drum(container);
    fireEvent.click(kgWheel(d2).getByText("none"));
    fireEvent.click(d2.getByText(/Confirm/));
    expect(document.activeElement).toBe(screen.getByLabelText(/tap to add weight/));
  });

  it("reps-only confirm leaves the added load alone", () => {
    const setPlanWeights = vi.fn(), setPlanReps = vi.fn(), onAddedLoad = vi.fn();
    const { container } = render(<WithVest {...props({ block: mainBlock(pushUp), ...phantom, setPlanWeights, setPlanReps })} onAddedLoad={onAddedLoad} />);
    fireEvent.click(screen.getByText("+ kg · optional"));
    fireEvent.click(drum(container).getByText(/Confirm/));
    expect(onAddedLoad).not.toHaveBeenCalled();
    expect(setPlanWeights).not.toHaveBeenCalled();
  });

  it("a fresh drum starts at \"none\", never at W", () => {
    // Seeded from W (37), picking "none" would be a change and write 0.
    const setPlanWeights = vi.fn(), setPlanReps = vi.fn(), onAddedLoad = vi.fn();
    const { container } = render(<WithVest {...props({ block: mainBlock(pushUp), ...phantom, setPlanWeights, setPlanReps })} onAddedLoad={onAddedLoad} />);
    fireEvent.click(screen.getByText("+ kg · optional"));
    const d = drum(container);
    fireEvent.click(kgWheel(d).getByText("none"));
    fireEvent.click(d.getByText(/Confirm/));
    expect(onAddedLoad).not.toHaveBeenCalled();
  });

  it("a vest reads \"Bodyweight + 10 kg\" — no big number, no steppers", () => {
    const { container } = render(<WithVest {...props({ block: mainBlock(pushUp), ...phantom })} initial={{ "Decline Push-Up": { kg: 10, updatedAt: "x" } }} />);
    const text = flat(document.body.textContent);
    expect(text).toContain("Bodyweight + 10 kg");
    expect(text).not.toContain("37");
    expect(screen.getByLabelText(/edit added weight/)).toBeTruthy();
    expect(screen.queryByText("+ kg · optional")).toBeNull();
    expect(screen.queryByLabelText("Add 1.25 kg")).toBeNull();
    expect(screen.queryByText("Add weight")).toBeNull();
    expect(bigNumber(container)).toBeNull();
  });

  it("round trip 0 → 10 → 0: \"none\" writes 0, the card returns to the chip", () => {
    const setPlanWeights = vi.fn(), onAddedLoad = vi.fn();
    const { container } = render(<WithVest {...props({ block: mainBlock(pushUp), ...phantom, setPlanWeights })} onAddedLoad={onAddedLoad} />);

    fireEvent.click(screen.getByText("+ kg · optional"));
    const d = drum(container);
    fireEvent.click(kgWheel(d).getByText("10"));
    fireEvent.click(d.getByText(/Confirm/));
    expect(flat(document.body.textContent)).toContain("Bodyweight + 10 kg");

    fireEvent.click(screen.getByLabelText(/edit added weight/));
    const d2 = drum(container);
    fireEvent.click(kgWheel(d2).getByText("none"));
    fireEvent.click(d2.getByText(/Confirm/));

    expect(onAddedLoad.mock.calls).toEqual([["Decline Push-Up", 10], ["Decline Push-Up", 0]]);
    expect(flat(document.body.textContent)).toContain("Bodyweight · 80 kg");
    expect(screen.getByText("+ kg · optional")).toBeTruthy();
    expect(setPlanWeights).not.toHaveBeenCalled();
  });

  it("a timed hold opens the drum in seconds and keeps its seconds", () => {
    // Without the timed flag the drum opened in reps mode, seeded 8, and
    // Confirm silently turned the 20s hold into 8.
    const lsit = { name: "L-Sit Hold", muscle: "Core", reps: "20s", weight: null, loadType: "bodyweight" };
    const setPlanReps = vi.fn();
    const { container } = render(<WithVest {...props({ block: mainBlock(lsit), getW: () => 37, planWeights: { "L-Sit Hold": 37 }, setPlanReps })} />);
    fireEvent.click(screen.getByText("+ kg · optional"));
    const d = drum(container);
    expect(d.getAllByText("sec").length).toBeGreaterThan(0);
    expect(kgWheel(d).getByText("none")).toBeTruthy();
    fireEvent.click(d.getByText(/Confirm/));
    // Untouched, the hold keeps its "20s".
    expect(setPlanReps).not.toHaveBeenCalled();

    // Moved, it writes seconds.
    fireEvent.click(screen.getByText("+ kg · optional"));
    const d2 = drum(container);
    fireEvent.click(repsWheel(d2, "sec").getByText("25"));
    fireEvent.click(d2.getByText(/Confirm/));
    expect(setPlanReps.mock.calls[0][0]({})).toEqual({ "L-Sit Hold": 25 });
  });

  it("the reps cell opens the optional wheel too, and writes nothing to it untouched", () => {
    const setPlanWeights = vi.fn(), setPlanReps = vi.fn(), onAddedLoad = vi.fn();
    const { container } = render(<WithVest {...props({ block: mainBlock(pushUp), ...phantom, setPlanWeights, setPlanReps })} onAddedLoad={onAddedLoad} />);
    fireEvent.click(screen.getByText("15"));
    const d = drum(container);
    expect(kgWheel(d).getByText("none")).toBeTruthy();
    fireEvent.click(repsWheel(d, "reps").getByText("12"));
    fireEvent.click(d.getByText(/Confirm/));
    expect(onAddedLoad).not.toHaveBeenCalled();
    expect(setPlanWeights).not.toHaveBeenCalled();
    expect(setPlanReps.mock.calls[0][0]({})).toEqual({ "Decline Push-Up": 12 });
  });

  it("\"this lift, last time\" never shows a phantom as a vest", () => {
    const rec = (set) => [{ id: "2026-09-20T10:00:00.000Z", date: "2026-09-20", blocks: [{ exercises: [
      { name: "Decline Push-Up", loadType: "bodyweight", sets: [set] }] }] }];
    const phantomSet = { weight: 40, reps: 15, rpe: 8, loadType: "bodyweight", bodyweightUsed: 80, effectiveLoad: 80 };
    const vestSet = { weight: 10, reps: 12, rpe: 8, loadType: "bodyweight", bodyweightUsed: 80, effectiveLoad: 90 };

    const { unmount } = render(<WithVest {...props({ block: mainBlock(pushUp), ...phantom, history: rec(phantomSet) })} />);
    let text = flat(document.body.textContent);
    expect(text).toContain("— × 15");
    expect(text).not.toContain("40 × 15");
    // The sheet the cell opens reads the same kg.
    fireEvent.click(screen.getByLabelText(/Recent history for/));
    text = flat(screen.getByRole("dialog").textContent);
    expect(text).toContain("1×15");
    expect(text).not.toContain("@ 40 kg");
    unmount();

    render(<WithVest {...props({ block: mainBlock(pushUp), ...phantom, history: rec(vestSet) })} />);
    text = flat(document.body.textContent);
    expect(text).toContain("10 × 12");
    fireEvent.click(screen.getByLabelText(/Recent history for/));
    expect(flat(screen.getByRole("dialog").textContent)).toContain("1×12 @ 10 kg");
  });

  // "This lift, last time" reads records of the session's own kind: a gym
  // session skips travel records for the same lift, and a travel session
  // reads only travel records (lib/analytics.js recentForExercise).
  const bss = { name: "Bulgarian Split Squat", muscle: "Quads", reps: 8, weight: 18, loadType: "per_db" };
  const travelRec = { id: "2026-09-20T10:00:00.000Z", date: "2026-09-20", travel: true, blocks: [{ type: "main", exercises: [
    { name: "Bulgarian Split Squat", loadType: "bodyweight", sets: [
      { weight: 10, reps: 8, rpe: 8, loadType: "bodyweight", bodyweightUsed: 80, effectiveLoad: 90 }] }] }] };
  const gymRec = { id: "2026-09-13T10:00:00.000Z", date: "2026-09-13", blocks: [{ type: "main", exercises: [
    { name: "Bulgarian Split Squat", loadType: "per_db", sets: [
      { weight: 16, reps: 8, rpe: 8, loadType: "per_db", effectiveLoad: 16 }] }] }] };

  it("a travel backpack set never becomes a gym delta", () => {
    render(<WithVest {...props({ block: mainBlock(bss), getW: () => 18, history: [travelRec] })} />);
    expect(screen.queryByText(/on last time/)).toBeNull();
    expect(flat(document.body.textContent)).not.toContain("10 × 8");
    // Nor, one tap deeper: a gym session has no travel history to open.
    expect(screen.queryByLabelText(/Recent history for/)).toBeNull();
  });

  it("a gym session's last-time cell skips a newer travel record for the same lift", () => {
    render(<WithVest {...props({ block: mainBlock(bss), getW: () => 18, history: [gymRec, travelRec] })} />);
    const text = flat(document.body.textContent);
    expect(text).toContain("16 × 8");
    expect(text).not.toContain("10 × 8");
    expect(text).toContain("+2 on last time");
  });

  it("a travel session reads its own kind", () => {
    render(<WithVest {...props({ block: mainBlock(bss), getW: () => 18, history: [gymRec, travelRec], travel: true })} />);
    const text = flat(document.body.textContent);
    expect(text).not.toContain("16 × 8");
    fireEvent.click(screen.getByLabelText(/Recent history for/));
    expect(flat(screen.getByRole("dialog").textContent)).not.toContain("@ 16 kg");
  });
});

// ─── Revisiting a finished block ─────────────────────────────────────────────
// The host lands one PAST the last set on a finished block (setNum = sets + 1);
// the host side is pinned in tests/revisit-completed-block.test.js.
describe("a finished block reads as finished when you flip back to it", () => {
  const kicker = () => flat(screen.getByText(/Main lift/, { selector: "div" }).textContent);

  it("on the last set, one set is still outstanding", () => {
    render(<SessionScreen {...props({ setNum: 3 })} />);
    expect(kicker()).toBe("Set 3 of 3 · Main lift");
    expect(screen.getByText("Log set")).toBeTruthy();
    expect(screen.queryByText("Add another set")).toBeNull();
  });

  it("past the last set, every set is logged and none is claimed outstanding", () => {
    render(<SessionScreen {...props({ setNum: 4 })} />);
    expect(kicker()).toBe("All 3 sets logged · Main lift");
    expect(flat(document.body.textContent)).not.toContain("Set 4 of 3");
  });

  it("adding a set is a deliberate act, not a primed commit", () => {
    const onLog = vi.fn();
    render(<SessionScreen {...props({ setNum: 4, onLog })} />);
    expect(screen.queryByText(/^Log set/)).toBeNull();
    expect(screen.queryByLabelText("Start rest timer")).toBeNull();

    fireEvent.click(screen.getByText("Add another set").closest("button"));
    expect(onLog).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Start rest timer")).toBeTruthy();

    fireEvent.click(screen.getByText("Log set 4").closest("button"));
    expect(onLog).toHaveBeenCalledTimes(1);
  });

  const other = mainBlock(
    { name: "Barbell Bench Press", muscle: "Chest", reps: 5, weight: 50, loadType: "barbell" },
    { id: "b2" },
  );

  it("the choice to add covers one set on one block, never the next", () => {
    const { rerender } = render(<SessionScreen {...props({ setNum: 4 })} />);
    fireEvent.click(screen.getByText("Add another set").closest("button"));
    expect(screen.getByText("Log set 4")).toBeTruthy();

    // The extra set is logged: the host moves to set 5, and the quiet offer
    // comes back rather than a primed "Log set 5".
    rerender(<SessionScreen {...props({ setNum: 5 })} />);
    expect(screen.getByText("Add another set")).toBeTruthy();
    expect(screen.queryByText("Log set 5")).toBeNull();

    // Flipping to another finished block at the same set number does not
    // inherit the choice either.
    fireEvent.click(screen.getByText("Add another set").closest("button"));
    rerender(<SessionScreen {...props({ block: other, setNum: 5 })} />);
    expect(screen.getByText("Add another set")).toBeTruthy();
    expect(screen.queryByText("Log set 5")).toBeNull();
  });

  it("the choice to add resets when the block changes and you come back", () => {
    const { rerender } = render(<SessionScreen {...props({ setNum: 4 })} />);
    fireEvent.click(screen.getByText("Add another set").closest("button"));
    expect(screen.getByText("Log set 4")).toBeTruthy();

    rerender(<SessionScreen {...props({ block: other, setNum: 1 })} />);
    expect(kicker()).toBe("Set 1 of 3 · Main lift");

    rerender(<SessionScreen {...props({ setNum: 4 })} />);
    expect(screen.getByText("Add another set")).toBeTruthy();
    expect(screen.queryByText("Log set 4")).toBeNull();
  });
});
