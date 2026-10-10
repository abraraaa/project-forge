// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// W-A: a trainer's device writes no client store. The /trainer/coach page runs
// a whole coached session through the real host on a device that also holds
// the trainer's own profile: readiness, a swap on a main block, the reach, an
// added set, superset rounds and a finisher, Finish, Review, then Send. The
// only key ever written or removed is forge:coachDraft; after the session it
// is the only new key, and after Send the device is exactly as it was. The
// only requests are the one look and the change route (fetch is stubbed:
// the route answers as its contract says).
//
// Text queries, not getByRole: see SessionScreen.surface.test.jsx.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";

const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@vercel/analytics", () => ({ track: () => {} }));

import { CoachedSessionPage } from "../../components/SessionHost.jsx";
import { P, BW } from "../../lib/storage.js";
import { COACH_DRAFT_KEY, CD } from "../../lib/session-source.js";
import { collectStoreSnapshot } from "../../lib/store-health.js";
import { projectPlan } from "../../lib/trainer-plan.js";
import { validateSessionSet, sessionTarget } from "../../lib/trainer-change.js";
import { DEFAULT_FOCUS } from "../../lib/programme.js";

const ZONE_WAS = process.env.TZ;
process.env.TZ = "Europe/London";
afterAll(() => { if (ZONE_WAS === undefined) delete process.env.TZ; else process.env.TZ = ZONE_WAS; });

const T0 = Date.parse("2026-10-07T09:00:00.000Z");
const TODAY = "2026-10-07";
const REF = "g_coached_1";
const COACH = "Coach";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  router.replace.mockClear();
  localStorage.clear();
});

// The client's plan as the trainer route would send it.
const META = {
  weights: {
    "Barbell Back Squat": 100, "Barbell Bench Press": 60,
    "DB Reverse Lunge": 16, "Chest-Supported DB Row": 22,
    "45-Degree Hip Extension": 10, "Landmine Press": 20, "Standing Calf Raise": 40,
  },
  reps: { "Barbell Back Squat": 5, "Barbell Bench Press": 6 },
  programmeBlock: { number: 2, config: null },
  userFocus: DEFAULT_FOCUS,
};
function viewFor(meta = META) {
  const plan = projectPlan({ meta, history: [] }, { todayIso: TODAY });
  // The programme inputs (spec §3.4); filled here if the projection doesn't carry them yet.
  plan.programme ??= { number: meta.programmeBlock.number, config: meta.programmeBlock.config, focus: meta.userFocus, mainLifts: {} };
  return { sessions: [], edits: "on", plan };
}

/** Every localStorage key and value, sorted. */
const snapshot = () => Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)]));

/** The trainer's own profile on the same device: the coached session must leave it alone. */
function seedTrainerDevice() {
  P.setActive(COACH);
  P.saveWeights(COACH, { "Barbell Back Squat": 140 });
  P.saveReps(COACH, { "Barbell Back Squat": 3 });
  BW.set(COACH, 90);
}

/** fetch as the two trainer routes answer, recording every call. */
function stubRoutes(view = viewFor()) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    let out = { error: "unexpected" }, status = 500;
    if (url === "/api/trainer/client") { status = 200; out = { client: { name: "Sam", since: T0 - 30 * 86_400_000 }, view }; }
    if (url === "/api/trainer/change" && body?.dryRun) { status = 200; out = { preview: { letter: "A", date: body.set.ops[0].record.date, exercises: 9, sets: 30 }, budget: { used: 0, of: 7 } }; }
    else if (url === "/api/trainer/change") { status = 200; out = { sent: { set: body.set.id, ids: [`${body.set.id}.00`] }, budget: { used: 1, of: 7 } }; }
    return { ok: status === 200, status, json: async () => out, text: async () => JSON.stringify(out) };
  }));
  return calls;
}

const button = (re) => screen.queryAllByText(re).map((n) => n.closest("button")).filter(Boolean)[0] ?? null;

/** Run the coached session to Review: fresh, a swap on the bench, the reach, an added set, every round. */
function runSession() {
  fireEvent.click(screen.getByText("Fresh"));
  fireEvent.click(screen.getByText(/Start session/));
  const did = { swapped: false, reach: false, added: false, commits: 0 };
  for (let step = 0; step < 400; step++) {
    vi.setSystemTime(T0 + (step + 1) * 30_000);
    const heading = screen.queryByRole("heading", { level: 1 })?.textContent;
    if (!did.swapped && heading === "Barbell Bench Press") {
      did.swapped = true;
      fireEvent.click(screen.getByText("Swap").closest("button"));
      fireEvent.click(within(document.querySelector('[role="dialog"]')).getAllByRole("button")[0]);
      continue;
    }
    if (!did.reach && button(/^One more set$/)) { did.reach = true; fireEvent.click(button(/^One more set$/)); continue; }
    const logAt = button(/Log at/);
    if (logAt) {
      did.commits++;
      for (let i = 0; i < did.commits % 4; i++) fireEvent.keyDown(screen.getByLabelText("Effort, RPE 6 to 10"), { key: "ArrowRight" });
      fireEvent.click(logAt);
      continue;
    }
    const log = button(/^Log (set( \d+)?|A — into B|B — round done)$/);
    if (log) { fireEvent.click(log); continue; }
    if (!did.added && did.swapped && button(/^Add another set$/)) { did.added = true; fireEvent.click(button(/^Add another set$/)); continue; }
    const next = button(/^Next: /) ?? button(/^Finish session$/);
    if (next) { fireEvent.click(next); continue; }
    break;
  }
  return did;
}

const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });

describe("W-A: the trainer's device writes no client store", () => {
  it("a full coached session writes only forge:coachDraft, and Send leaves the device as it was", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    seedTrainerDevice();
    const before = snapshot();
    const calls = stubRoutes();
    const sets = vi.spyOn(Storage.prototype, "setItem");
    const removes = vi.spyOn(Storage.prototype, "removeItem");
    window.history.replaceState(null, "", `/trainer/coach#ref=${REF}&letter=A`);

    render(<CoachedSessionPage/>);
    await settle();
    // The ref leaves the address bar once read.
    expect(window.location.pathname + window.location.search).toBe("/trainer/coach");
    // No travel on a trainer's device.
    expect(screen.queryByText("Travel mode")).toBeNull();
    expect(screen.getByText(/Strength A with Sam/)).toBeTruthy();

    const did = runSession();
    expect(did).toMatchObject({ swapped: true, reach: true, added: true });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Strength A with Sam");

    // After the session: one new key, the draft; nothing else moved.
    const mid = snapshot();
    expect(Object.keys(mid)).toEqual([...Object.keys(before), COACH_DRAFT_KEY].sort());
    for (const k of Object.keys(before)) expect([k, mid[k]]).toEqual([k, before[k]]);
    // /diag-sync knows the key.
    expect(collectStoreSnapshot(COACH).unknownKeys).toEqual([]);
    expect(CD.load(REF)).toMatchObject({ letter: "A", name: "Sam" });

    fireEvent.click(screen.getByText("Send to Sam").closest("button"));
    await settle();

    // Every write and remove was the draft key.
    const touched = new Set([...sets.mock.calls, ...removes.mock.calls].map(([k]) => k));
    expect([...touched]).toEqual([COACH_DRAFT_KEY]);
    expect(sets.mock.calls.every(([k]) => !/^forge:[^:]+:/.test(k))).toBe(true);
    // After Send: exactly as before.
    expect(snapshot()).toEqual(before);
    expect(router.replace).toHaveBeenCalledWith("/trainer");

    // One look, a dry run, then the send with the same set.
    expect(calls.map((c) => c.url)).toEqual(["/api/trainer/client", "/api/trainer/change", "/api/trainer/change"]);
    expect(calls[0].body).toEqual({ ref: REF, today: TODAY });
    const [, dry, sent] = calls;
    expect(dry.body.dryRun).toBe(true);
    expect(sent.body.dryRun).toBeUndefined();
    expect(sent.body.set).toEqual(dry.body.set);
    expect(sent.body).toMatchObject({ ref: REF, today: TODAY, basis: { programme: { number: 2 } } });

    // The record the route gets passes the route's own checks against the
    // client's stored plan, and carries everything the session did.
    const v = validateSessionSet(sent.body.set, { meta: META, history: [], todayIso: TODAY, phase: "write" });
    expect(v.refusals).toEqual([]);
    expect(v.ok).toBe(true);
    const { record, drum } = sent.body.set.ops[0];
    expect(sessionTarget(record)).toBe(`${TODAY}:A`);
    expect(record).toMatchObject({ profileName: null, bodyweight: null, readiness: "fresh", blockNumber: 2 });
    expect(record.travel).toBeUndefined();
    const exercises = record.blocks.flatMap((b) => b.exercises);
    expect(exercises.some((e) => e.swapped)).toBe(true);
    expect(exercises.some((e) => e.sets.some((st) => st.reach === true))).toBe(true);
    expect(exercises.some((e) => e.sets.length > e.prescribed.sets)).toBe(true);
    expect(record.blocks.some((b) => b.type === "superset")).toBe(true);
    expect(exercises.every((e) => e.sets.every((st) => st.bodyweightUsed === null))).toBe(true);
    expect(Object.keys(drum).every((k) => exercises.some((e) => e.name === k))).toBe(true);
  });
});
