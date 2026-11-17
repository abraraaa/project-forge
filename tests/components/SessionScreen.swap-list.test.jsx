// @vitest-environment jsdom
// The swap list never offers a lift already in today's session, other than
// the lift being swapped.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { SessionScreen } from "../../components/SessionScreen.jsx";
import { SESSIONS, SWAP_DB, swapOptionsFor } from "../../lib/programme.js";

afterEach(cleanup);

const DAY_C = SESSIONS[2];
const PRESS = "Incline DB Press";
const CROSSOVER = "Low-to-High Cable Crossover";
const names = (opts) => opts.map((o) => o.name);

describe("swapOptionsFor", () => {
  it("Day C: swapping Incline DB Press no longer offers the day's own finisher", () => {
    expect(names(SWAP_DB[PRESS])).toContain(CROSSOVER);
    expect(DAY_C.blocks.some((b) => b.exB?.name === CROSSOVER)).toBe(true);
    const opts = names(swapOptionsFor(PRESS, DAY_C));
    expect(opts).not.toContain(CROSSOVER);
    expect(opts).toEqual(names(SWAP_DB[PRESS]).filter((n) => n !== CROSSOVER));
    expect(opts.length).toBeGreaterThan(0);
  });

  it("a lift not in the session is still offered", () => {
    const elsewhere = { name: "Elsewhere", blocks: [{ id: "x", type: "main", ex: { name: PRESS } }] };
    expect(names(swapOptionsFor(PRESS, elsewhere))).toEqual(names(SWAP_DB[PRESS]));
  });

  it("swapping back to the original is still offered", () => {
    // Day B's Lateral Raise swapped for Cable Lateral Raise: the session now shows the cable raise.
    const DAY_B = SESSIONS[1];
    const swapped = { ...DAY_B, blocks: DAY_B.blocks.map((b) => (b.exB?.name === "Lateral Raise" ? { ...b, exB: { ...b.exB, name: "Cable Lateral Raise" } } : b)) };
    expect(names(SWAP_DB["Cable Lateral Raise"])).toContain("Lateral Raise");
    expect(names(swapOptionsFor("Cable Lateral Raise", swapped))).toContain("Lateral Raise");
    // The lift being swapped never removes itself: a list holding it keeps it.
    const self = { name: "Self", blocks: [{ id: "x", type: "main", ex: { name: "Lateral Raise" } }] };
    expect(names(swapOptionsFor("Lateral Raise", self))).toEqual(names(SWAP_DB["Lateral Raise"]));
  });

  it("a list emptied by the session is empty; an unknown lift has none", () => {
    const opts = SWAP_DB[PRESS];
    const full = { name: "Full", blocks: [{ id: "x", type: "superset", exA: { name: PRESS }, exB: { name: opts[0].name } },
      ...opts.slice(1).map((o, i) => ({ id: `y${i}`, type: "main", ex: { name: o.name } }))] };
    expect(swapOptionsFor(PRESS, full)).toEqual([]);
    expect(swapOptionsFor("Not A Lift", DAY_C)).toEqual([]);
    expect(swapOptionsFor("constructor", DAY_C)).toEqual([]);
  });
});

describe("the swap sheet", () => {
  const block = DAY_C.blocks.find((b) => b.exA?.name === PRESS);
  const ex = block.exA;
  const base = {
    session: DAY_C, block, blockIdx: DAY_C.blocks.indexOf(block), totalBlocks: DAY_C.blocks.length,
    setNum: 1, phase: "A", isSS: true, blockSets: block.sets,
    activeEx: ex, resolvedExA: ex, resolvedExB: block.exB, resolvedEx: null,
    swapKey: `${block.id}-A`, onSwap: () => {},
    showVid: false, setShowVid: () => {}, getW: () => 18, getR: (e) => e?.reps ?? null,
    editTarget: null, setEditTarget: () => {},
    planWeights: {}, setPlanWeights: () => {}, planReps: {}, setPlanReps: () => {},
    history: [], loggedSets: [], awaitRpe: false, ssRoundDone: false,
    restActive: false, restRemain: 90, setRestActive: () => {}, setRestRemain: () => {},
    onCommit: () => {}, onLog: () => {}, onQuit: () => {}, onShowOverview: () => {},
    bodyweight: 80, canReach: false, reachStep: 2.5, reachArmed: false,
    onTakeReach: () => {}, onDeclineReach: () => {},
  };
  const openSheet = (p) => {
    render(<SessionScreen {...p}/>);
    fireEvent.click(screen.getByText("Swap"));
    return within(screen.getByRole("dialog"));
  };

  it("lists the day's alternatives without the lift already in it", () => {
    const sheet = openSheet(base);
    expect(sheet.queryByText(CROSSOVER)).toBeNull();
    expect(sheet.getByText("Landmine Press")).toBeTruthy();
  });

  it("shows the empty line when the session holds every alternative", () => {
    const extra = SWAP_DB[PRESS].map((o, i) => ({ id: `z${i}`, type: "main", label: "Main lift", sets: 3, rest: 90, ex: { name: o.name } }));
    const sheet = openSheet({ ...base, session: { ...DAY_C, blocks: [...DAY_C.blocks, ...extra] } });
    expect(sheet.getByText("No approved alternatives for this lift")).toBeTruthy();
  });
});
