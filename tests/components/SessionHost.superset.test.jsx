// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// Superset timing and rating through the real host and the real store: a
// round rated with the round in front of you saves what the rows say, a
// finisher round is rated the same way, rest runs between rounds and is never
// left running through B, rest carried in by Next is capped at the arriving
// block's own, a log made mid-rest restarts it, and the last round gets the
// final-set line a single block gets. Only the router and analytics are
// stubbed; the clock is faked so rest can run out on cue.
//
// Text queries, not getByRole: see SessionScreen.surface.test.jsx.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, push: () => {} }) }));
vi.mock("@vercel/analytics", () => ({ track: () => {} }));

import SessionHost from "../../components/SessionHost.jsx";
import { P, D, BW, SessionIntent } from "../../lib/storage.js";
import { FLASH_LINES } from "../../lib/set-flash.js";
import { SESSION_COPY } from "../../lib/session-copy.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const WHO = "Tess";
const flat = (s) => s.replace(/\s+/g, " ").trim();
const tap = (re) => fireEvent.click(screen.getByText(re).closest("button"));
const wait = (s) => act(() => { vi.advanceTimersByTime(s * 1000); });
const kicker = (re) => screen.queryAllByText((_, el) => !!el && re.test(flat(el.textContent))).at(-1) ?? null;
const ring = () => screen.queryByLabelText(/^Resting, |^Start rest timer$/);
const status = () => document.querySelector('[role="status"]').textContent;

function start() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(Date.parse("2026-10-07T09:00:00.000Z"));
  P.setActive(WHO);
  P.saveWeights(WHO, { "Barbell Back Squat": 100, "Barbell Bench Press": 60 });
  BW.set(WHO, 78);
  SessionIntent.stash(WHO, { sessionIdx: 0 });   // Strength A: two mains, two supersets, a finisher
  render(<SessionHost />);
  fireEvent.click(screen.getByText("Normal"));
  fireEvent.click(screen.getByText(/Start session/));
}
const logSet = () => { tap("Log set"); tap(/Log at/); };
const logRound = () => { tap("Log A — into B"); tap("Log B — round done"); tap(/Log at/); };
const mainsDone = () => { for (let b = 0; b < 2; b++) { for (let s = 0; s < 3; s++) logSet(); if (b === 0) tap(/^Next: /); } };

describe("rating a round", () => {
  it("shows the round, and a correction to B is what is saved", () => {
    start();
    mainsDone();
    tap(/^Next: /);
    tap("Log A — into B");
    tap("Log B — round done");
    expect(kicker(/^Round 1 of 3 · Superset$/)).toBeTruthy();
    expect(screen.getByText("How hard was that round?")).toBeTruthy();
    expect(document.querySelector("h1")).toBeNull();

    const rowB = screen.getByText("B", { selector: "span" }).closest("button");
    const nameB = rowB.children[0].children[1].textContent;
    fireEvent.click(rowB);
    const d = within(document.querySelector('[role="dialog"]'));
    fireEvent.click(within(d.getAllByText("reps")[0].parentElement).getByText("7"));
    fireEvent.click(d.getByText(/Confirm/));
    expect(flat(rowB.textContent)).toMatch(/× 7$/);

    tap(/Log at/);
    const saved = D.load(WHO).draft.blocks.ass1.exercises;
    expect(saved[nameB].sets).toEqual([expect.objectContaining({ reps: 7, rpe: 8 })]);
    const nameA = Object.keys(saved).find((n) => n !== nameB);
    expect(saved[nameA].sets).toEqual([expect.objectContaining({ rpe: 8 })]);
    // Round 2 begins on A, with the counter in rounds.
    expect(kicker(/^Round 2 of 3 · Superset A$/)).toBeTruthy();
  });
});

describe("rating a finisher round", () => {
  it("asks after B with both lifts in front of you, saves the rating on both, then rests", () => {
    start();
    mainsDone();
    tap(/^Next: /);
    for (let r = 0; r < 3; r++) logRound();
    tap(/^Next: /);
    for (let r = 0; r < 3; r++) logRound();
    tap(/^Next: /);
    wait(60);   // the carried rest runs out; the finisher's own is what follows

    // A into B asks nothing and saves nothing yet: one rating per round.
    tap("Log A — into B");
    expect(screen.queryByText("How hard was that round?")).toBeNull();
    expect(D.load(WHO).draft.blocks.afin).toBeUndefined();

    tap("Log B — round done");
    expect(screen.getByText("How hard was that round?")).toBeTruthy();
    expect(kicker(/^Round 1 of 4 · Finisher$/)).toBeTruthy();
    const names = ["A", "B"].map((side) =>
      screen.getByText(side, { selector: "span" }).closest("button").children[0].children[1].textContent);
    expect(names.every(Boolean)).toBe(true);

    tap(/Log at/);
    const saved = D.load(WHO).draft.blocks.afin.exercises;
    expect(Object.keys(saved).sort()).toEqual([...names].sort());
    for (const n of names) expect(saved[n].sets).toEqual([expect.objectContaining({ rpe: 8, rir: 2 })]);
    expect(kicker(/^Round 2 of 4 · Finisher A$/)).toBeTruthy();
    expect(screen.getByLabelText("Resting, 1:00 left — tap to skip")).toBeTruthy();
  });
});

describe("rest on a superset", () => {
  it("is on the ring once the round is rated, and never runs out mid-B", () => {
    start();
    mainsDone();
    tap(/^Next: /);
    logRound();
    expect(screen.getByLabelText("Resting, 1:30 left — tap to skip")).toBeTruthy();

    tap("Log A — into B");
    expect(ring()).toBeNull();
    wait(200);
    wait(1);   // the announcement lands a beat after the tick that ends rest
    expect(status()).not.toBe("Rest over");
    expect(screen.getByText("Log B — round done")).toBeTruthy();
  });

  it("main → superset: the main lift's rest is capped at the superset's", () => {
    start();
    mainsDone();   // the fork: rest runs on, off screen
    wait(10);
    tap(/^Next: /);
    expect(kicker(/^Round 1 of 3 · Superset A$/)).toBeTruthy();
    expect(screen.getByLabelText("Resting, 1:30 left — tap to skip")).toBeTruthy();
    // The cap holds on the next tick: the deadline moved with it.
    wait(5);
    expect(screen.getByLabelText("Resting, 1:25 left — tap to skip")).toBeTruthy();
  });

  it("superset → finisher: the superset's rest is capped at the finisher's", () => {
    start();
    mainsDone();
    tap(/^Next: /);
    for (let r = 0; r < 3; r++) logRound();
    tap(/^Next: /);
    for (let r = 0; r < 3; r++) logRound();
    tap(/^Next: /);
    expect(kicker(/^Round 1 of 4 · Finisher A$/)).toBeTruthy();
    expect(screen.getByLabelText("Resting, 1:00 left — tap to skip")).toBeTruthy();
  });

  it("a set logged while rest still runs starts rest afresh, not from the old deadline", () => {
    start();
    logSet();
    wait(60);
    expect(screen.getByLabelText("Resting, 2:00 left — tap to skip")).toBeTruthy();
    logSet();
    wait(3);
    expect(screen.getByLabelText("Resting, 2:57 left — tap to skip")).toBeTruthy();
  });

  it("a shorter carried rest is left as it is", () => {
    start();
    mainsDone();
    wait(150);
    tap(/^Next: /);
    expect(screen.getByLabelText("Resting, 0:30 left — tap to skip")).toBeTruthy();
  });
});

describe("the last round gets the final-set line", () => {
  const LINES = [...Object.values(FLASH_LINES).flat().map((l) => l.text), SESSION_COPY.finalSetMiss];
  // On screen, not the screen-reader region, which keeps the last line said.
  const flashed = () => LINES.find((l) => screen.queryAllByText(l).some((el) => !el.closest('[role="status"]'))) ?? null;

  it("after rating the superset's last round, and not before", () => {
    start();
    mainsDone();
    tap(/^Next: /);
    wait(5);   // let the main lift's line clear
    logRound();
    logRound();
    wait(1);
    expect(flashed()).toBeNull();
    logRound();
    wait(1);
    expect(flashed()).toBeTruthy();
  });

  it("after rating a finisher's last round, and not before", () => {
    start();
    mainsDone();
    tap(/^Next: /);
    for (let r = 0; r < 3; r++) logRound();
    tap(/^Next: /);
    for (let r = 0; r < 3; r++) logRound();
    tap(/^Next: /);
    wait(5);   // let the superset's line clear
    for (let r = 0; r < 3; r++) logRound();
    wait(1);
    expect(flashed()).toBeNull();
    logRound();
    wait(1);
    expect(flashed()).toBeTruthy();
  });
});
