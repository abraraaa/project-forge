// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// A whole live session, run through the real host and the real store, and
// every localStorage key after Finish compared with output recorded before the
// finish moved into lib/session-commit.js and the host's reads and writes moved
// into lib/session-source.js. The push's request bodies are pinned too, since
// what the finish has written by the time it pushes is part of the contract.
//
// Covers a swap that seeds a never-trained lift's W, a drum edit, an added
// set, supersets and a finisher by round, a bodyweight lift, and both return
// gaps ("Back at it" over seven days, and a normal week), checked on the done
// screen since the gap is never stored.
//
// Text queries, not getByRole: see SessionScreen.surface.test.jsx.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, push: () => {} }) }));
vi.mock("@vercel/analytics", () => ({ track: () => {} }));

import SessionHost from "../../components/SessionHost.jsx";
import { P, D, H, TS, BW, SessionIntent, newDraftLog, logSet, finaliseDraft } from "../../lib/storage.js";

const here = dirname(fileURLToPath(import.meta.url));
const recorded = JSON.parse(readFileSync(resolve(here, "../fixtures/session-finish-ls.json"), "utf8"));

// The record stamps the device's zone and local day: pin both.
const ZONE_WAS = process.env.TZ;
process.env.TZ = "Europe/London";
afterAll(() => { if (ZONE_WAS === undefined) delete process.env.TZ; else process.env.TZ = ZONE_WAS; });

const WHO = "Tess";
const T0 = Date.parse("2026-10-07T09:00:00.000Z");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function seed({ priorDaysAgo }) {
  P.setActive(WHO);
  P.saveWeights(WHO, {
    "Barbell Back Squat": 100, "Barbell Bench Press": 60,
    "DB Reverse Lunge": 16, "Chest-Supported DB Row": 22,
    "45-Degree Hip Extension": 10, "Landmine Press": 20, "Standing Calf Raise": 40,
  });
  P.saveReps(WHO, { "Barbell Back Squat": 5, "Barbell Bench Press": 6 });
  TS.updateMuscleAnchor(WHO, "Chest", { bestE1RM: 80, bestE1RMLift: "Barbell Bench Press" });
  BW.set(WHO, 78);
  // One earlier session, so the engine and the return gap have a past.
  vi.setSystemTime(T0 - priorDaysAgo * 86_400_000);
  const prior = newDraftLog({ profileName: WHO, session: "strength-b", blockNumber: 1, readiness: "normal" });
  logSet(prior, { blockId: "b1", blockType: "main", exerciseName: "Barbell Back Squat", muscle: "Quadriceps", weight: 97.5, reps: 5, rpe: 8, prescribed: { reps: 5, weight: 97.5, sets: 3 } });
  H.append(WHO, finaliseDraft(prior));
  vi.setSystemTime(T0);
}

const button = (re) => {
  const hit = screen.queryAllByText(re).map((n) => n.closest("button")).filter(Boolean);
  return hit[0] ?? null;
};

/** Run the session to the done screen, one tap at a time, with some variety. */
function runSession() {
  fireEvent.click(screen.getByText("Normal"));
  fireEvent.click(screen.getByText(/Start session/));
  let commits = 0, swapped = false, added = false, edited = false;
  for (let step = 0; step < 300; step++) {
    vi.setSystemTime(T0 + (step + 1) * 45_000);
    const heading = screen.queryByRole("heading", { level: 1 })?.textContent;
    // Bench is swapped before its first set: a lift never trained, seeded from
    // the Chest anchor.
    if (!swapped && heading === "Barbell Bench Press") {
      swapped = true;
      fireEvent.click(screen.getByText("Swap").closest("button"));
      const dialog = within(document.querySelector('[role="dialog"]'));
      fireEvent.click(dialog.getAllByRole("button")[0]);
      continue;
    }
    // A drum nudge on the squat: today's weight, never W.
    if (!edited && heading === "Barbell Back Squat") {
      edited = true;
      fireEvent.click(screen.getByLabelText("Add 1.25 kg"));
      continue;
    }
    const logAt = button(/Log at/);
    if (logAt) {
      commits++;
      for (let i = 0; i < commits % 4; i++) fireEvent.keyDown(screen.getByLabelText("Effort, RPE 6 to 10"), { key: "ArrowRight" });
      fireEvent.click(logAt);
      continue;
    }
    const log = button(/^Log (set( \d+)?|A — into B|B — round done)$/);
    if (log) { fireEvent.click(log); continue; }
    // One added set, on the first block that offers it.
    if (!added && button(/^Add another set$/)) {
      added = true;
      fireEvent.click(button(/^Add another set$/));
      continue;
    }
    const next = button(/^Next: /) ?? button(/^Finish session$/);
    if (next) { fireEvent.click(next); continue; }
    break;
  }
  return { swapped, added, edited, commits };
}

async function finishAndRead(priorDaysAgo) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  const pushes = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    pushes.push({ url: String(url), method: init.method ?? "GET", body: init.body ?? null });
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  }));
  seed({ priorDaysAgo });
  SessionIntent.stash(WHO, { sessionIdx: 0 });
  render(<SessionHost />);
  const ran = runSession();
  // Let the push settle.
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
  const store = {};
  for (const k of Object.keys(localStorage).sort()) store[k] = localStorage.getItem(k);
  return { ran, store, pushes };
}

describe("localStorage after a live finish is unchanged", () => {
  for (const [name, priorDaysAgo] of [["back after ten days", 10], ["a normal week", 2]]) {
    it(name, async () => {
      const { ran, store, pushes } = await finishAndRead(priorDaysAgo);
      expect(ran).toMatchObject({ swapped: true, added: true, edited: true });
      expect(D.load(WHO)).toBeNull();
      expect(H.get(WHO)).toHaveLength(2);
      const want = recorded[name];
      expect(Object.keys(store)).toEqual(Object.keys(want.store));
      for (const k of Object.keys(want.store)) expect([k, store[k]]).toEqual([k, want.store[k]]);
      expect(pushes).toEqual(want.pushes);
      // The return gap lives only in the done screen, so check it there.
      const backAtIt = screen.queryByText(/Back at it/);
      if (priorDaysAgo > 7) expect(backAtIt?.textContent).toMatch(new RegExp(`first one in ${priorDaysAgo} days`));
      else expect(backAtIt).toBeNull();
    });
  }
});

