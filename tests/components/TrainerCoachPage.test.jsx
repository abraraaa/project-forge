// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// /trainer/coach: the page, its hand-off and its answers, the coached draft
// (resume with no network, the swap and the reach kept), and Review (the day,
// Face ID, offline, refusals). fetch is stubbed: the change route answers as
// its contract says (POST /api/trainer/change, kind "session").
//
// Text queries, not getByRole: see SessionScreen.surface.test.jsx.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@vercel/analytics", () => ({ track: () => {} }));
const passkey = vi.hoisted(() => ({ authenticatePasskey: vi.fn() }));
vi.mock("@/lib/webauthn", () => passkey);
vi.mock("@/components/client-shells", () => ({ TrainerCoachShell: () => <div data-shell="coach"/> }));

import TrainerCoachPage, { metadata } from "../../app/trainer/coach/page.jsx";
import SessionHost, { CoachedSessionPage, reviewLine } from "../../components/SessionHost.jsx";
import { SessionScreen } from "../../components/SessionScreen.jsx";
import { CD, COACH_DRAFT_KEY, coachTrainer, recordOnDay, sessionDrum, capDraftSets, coachedSource } from "../../lib/session-source.js";
import { newDraftLog, logSet, P, D, SessionIntent } from "../../lib/storage.js";
import { stableStringify } from "../../lib/sync-merge.js";
import { projectPlan } from "../../lib/trainer-plan.js";
import { SESSIONS, DEFAULT_FOCUS } from "../../lib/programme.js";
import { getLoadType } from "../../lib/lift-translations.js";

const ZONE_WAS = process.env.TZ;
process.env.TZ = "Europe/London";
afterAll(() => { if (ZONE_WAS === undefined) delete process.env.TZ; else process.env.TZ = ZONE_WAS; });

const T0 = Date.parse("2026-10-07T09:00:00.000Z");
const TODAY = "2026-10-07";
const YESTERDAY = "2026-10-06";
const REF = "g_page_1";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  router.replace.mockClear();
  passkey.authenticatePasskey.mockReset();
  coachTrainer.set(null);
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

const META = {
  weights: { "Barbell Back Squat": 100, "Barbell Bench Press": 60, "DB Reverse Lunge": 16, "Chest-Supported DB Row": 22 },
  reps: { "Barbell Back Squat": 5 },
  programmeBlock: { number: 1, config: null },
  userFocus: DEFAULT_FOCUS,
};
function planFor() {
  const plan = projectPlan({ meta: META, history: [] }, { todayIso: TODAY });
  plan.programme ??= { number: 1, config: null, focus: DEFAULT_FOCUS, mainLifts: {} };
  return plan;
}

/** fetch by path: each answer is [status, body] or a function of the body; "throw" is a network failure. */
function stub(answers) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    let a = answers[url];
    if (typeof a === "function") a = a(body, calls);
    if (!a || a === "throw") throw new TypeError("Failed to fetch");
    const [status, out] = a;
    return { ok: status === 200, status, json: async () => out };
  }));
  return calls;
}
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });
const at = (path) => window.history.replaceState(null, "", path);
const button = (re) => screen.queryAllByText(re).map((n) => n.closest("button")).filter(Boolean)[0] ?? null;

/** A whole Strength A draft, every set logged, started at `startMs`, saved as this ref's coached draft. */
function seedFinishedDraft(startMs = T0, { name = "Sam", squatSets = null } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(startMs);
  const draft = newDraftLog({ profileName: null, session: "strength-a", blockNumber: 1, readiness: "normal" });
  for (const b of SESSIONS[0].blocks) {
    for (const ex of [b.ex, b.exA, b.exB].filter(Boolean)) {
      for (let i = 0; i < (b.id === "a1" && squatSets ? squatSets : b.sets); i++) {
        logSet(draft, {
          blockId: b.id, blockType: b.type, exerciseName: ex.name, muscle: ex.muscle, swapped: false, fromPool: null,
          loadType: getLoadType(ex), bodyweight: null, weight: META.weights[ex.name] ?? ex.weight ?? null, reps: ex.reps,
          rpe: b.type === "main" ? 8 : null, prescribed: { reps: ex.reps, weight: META.weights[ex.name] ?? null, sets: b.sets },
        });
      }
    }
  }
  CD.save(REF, {
    letter: "A", name, plan: planFor(), draft, swaps: {}, sessionWeights: { "Barbell Back Squat": 102.5, "Not Logged": 50 },
    sessionReps: {}, addedLoads: {}, readiness: "normal", readinessReason: null,
  });
  vi.setSystemTime(T0 + 3_600_000);
}

/** Resume the seeded draft and open Review. */
async function toReview(answers) {
  const calls = stub(answers);
  at("/trainer/coach");
  render(<CoachedSessionPage/>);
  await settle();
  fireEvent.click(button(/^Finish session$/));
  expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Strength A( with Sam)?$/);
  return calls;
}
const sentBody = (calls) => calls.filter((c) => c.url === "/api/trainer/change" && !c.body.dryRun).at(-1)?.body;
const changeOk = (body) => (body.dryRun
  ? [200, { preview: { letter: "A", date: body.set.ops[0].record.date, exercises: 9, sets: 27 }, budget: { used: 0, of: 7 } }]
  : [200, { sent: { set: body.set.id, ids: [`${body.set.id}.00`] }, budget: { used: 1, of: 7 } }]);

describe("the page", () => {
  it("is a thin unindexed shell", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    const { container } = render(<TrainerCoachPage/>);
    expect(container.querySelector('[data-shell="coach"]')).toBeTruthy();
  });

  it("reads the ref, takes it out of the address bar, and sends it only in the body", async () => {
    const calls = stub({ "/api/trainer/client": [404, { error: "x" }] });
    at(`/trainer/coach#ref=${REF}&letter=B`);
    render(<CoachedSessionPage/>);
    await settle();
    expect(window.location.href).not.toContain(REF);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/trainer/client");
    expect(calls[0].body.ref).toBe(REF);
    expect(screen.getByText("Not shared with you now.")).toBeTruthy();
  });

  it.each([
    [{ client: { name: "Sam" }, view: { edits: "off", sessions: [] } }, 200, "Changes are off for Sam. Ask them to turn changes on in Profile."],
    [{ client: { name: "Sam" }, view: { edits: "fresh", sessions: [] } }, 200, "Ask Sam for a fresh code to run a session with them."],
    [{}, 401, "Sign in on your trainer page first."],
    [{ needsTerms: true }, 403, "Agree to the updated Trainer Terms on your trainer page first."],
    [{}, 503, "Couldn't open that just now."],
  ])("answers in its own words: %#", async (body, status, words) => {
    stub({ "/api/trainer/client": [status, body] });
    at(`/trainer/coach#ref=${REF}`);
    render(<CoachedSessionPage/>);
    await settle();
    expect(screen.getByText(words)).toBeTruthy();
  });

  it("never reads a ref from the query: it could reach analytics before it left", async () => {
    const calls = stub({});
    at(`/trainer/coach?ref=${REF}&letter=B`);
    render(<CoachedSessionPage/>);
    await settle();
    expect(calls).toEqual([]);
    expect(window.location.href).not.toContain(REF);
    expect(screen.getByText("Open a client on your trainer page to run a session with them.")).toBeTruthy();
  });

  it("a reload reopens the client it was on, not the draft saved last", async () => {
    seedFinishedDraft();
    vi.useRealTimers();
    const alex = { "/api/trainer/client": [200, { client: { name: "Alex" }, view: { edits: "on", sessions: [], plan: planFor() } }] };
    let calls = stub(alex);
    at("/trainer/coach#ref=g_alex&letter=B");
    const first = render(<CoachedSessionPage/>);
    await settle();
    expect(window.location.href).not.toContain("g_alex");
    expect(screen.getByText(/Strength B with Alex/)).toBeTruthy();
    first.unmount();
    // The reload: same history entry, nothing in the address bar.
    calls = stub(alex);
    render(<CoachedSessionPage/>);
    await settle();
    expect(calls.map((c) => c.body.ref)).toEqual(["g_alex"]);
    expect(screen.getByText(/Strength B with Alex/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Sam/);
  });

  it("offline, and with nothing to resume, says so", async () => {
    stub({});
    at(`/trainer/coach#ref=${REF}`);
    render(<CoachedSessionPage/>);
    await settle();
    expect(screen.getByText("You're offline. Open it again when you're back.")).toBeTruthy();
  });

  it("with no ref and no draft, sends nobody anywhere", async () => {
    const calls = stub({});
    at("/trainer/coach");
    render(<CoachedSessionPage/>);
    await settle();
    expect(calls).toEqual([]);
    expect(screen.getByText("Open a client on your trainer page to run a session with them.")).toBeTruthy();
  });

  it("starts the letter the pane picked, else the next one", async () => {
    const view = { edits: "on", sessions: [], plan: planFor() };
    stub({ "/api/trainer/client": [200, { client: { name: "Sam" }, view }] });
    at(`/trainer/coach#ref=${REF}&letter=c`);
    render(<CoachedSessionPage/>);
    await settle();
    expect(screen.getByText(/Strength C with Sam/)).toBeTruthy();
    cleanup();
    at(`/trainer/coach#ref=${REF}`);
    render(<CoachedSessionPage/>);
    await settle();
    expect(screen.getByText(/Strength A with Sam/)).toBeTruthy();
  });
});

describe("the coached draft", () => {
  it("a reload resumes with no network, and the slot keeps its swap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    stub({ "/api/trainer/client": [200, { client: { name: "Sam" }, view: { edits: "on", sessions: [], plan: planFor() } }] });
    at(`/trainer/coach#ref=${REF}&letter=A`);
    const first = render(<CoachedSessionPage/>);
    await settle();
    fireEvent.click(screen.getByText("Fresh"));
    fireEvent.click(screen.getByText(/Start session/));
    // The squat to its reach, taken, then on to the bench.
    for (let i = 0; i < 20 && !button(/^Next: Barbell Bench Press$/); i++) {
      if (button(/^One more set$/)) { fireEvent.click(button(/^One more set$/)); continue; }
      if (button(/Log at/)) { fireEvent.click(button(/Log at/)); continue; }
      fireEvent.click(button(/^Log set/));
    }
    fireEvent.click(button(/^Next: Barbell Bench Press$/));
    fireEvent.click(screen.getByText("Swap").closest("button"));
    fireEvent.click(document.querySelector('[role="dialog"]').querySelectorAll("button")[0]);
    const swappedTo = screen.getByRole("heading", { level: 1 }).textContent;
    expect(swappedTo).not.toBe("Barbell Bench Press");
    fireEvent.click(button(/^Log set/));
    fireEvent.click(button(/Log at/));
    first.unmount();

    const saved = CD.load(REF);
    expect(saved.swaps.a2.name).toBe(swappedTo);
    expect(Object.keys(saved.draft.blocks)).toEqual(["a1", "a2"]);

    // The reload: no ref in the address bar, and no network.
    const calls = stub({});
    at("/trainer/coach");
    render(<CoachedSessionPage/>);
    await settle();
    expect(calls).toEqual([]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(swappedTo);
    // The session screen names the client.
    expect(screen.getByText("Strength A with Sam")).toBeTruthy();
    // The next set of the swapped lift.
    expect(document.body.textContent.replace(/\s+/g, " ")).toMatch(/Set 2 of 3/);
  });

  it("CD touches only its own key, and only the ref it is given", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    localStorage.setItem("forge:Coach:draft", "{\"keep\":1}");
    localStorage.setItem("forge:active", "\"Coach\"");
    const entry = { letter: "A", name: "Sam", plan: null, draft: { blocks: {} }, swaps: {}, sessionWeights: {}, sessionReps: {}, addedLoads: {}, readiness: null, readinessReason: null };
    CD.save("g_a", entry);
    vi.setSystemTime(T0 + 1000);
    CD.save("g_b", { ...entry, name: "Ana" });
    expect(CD.latest()).toBe("g_b");
    CD.clear("g_a");
    expect(Object.keys(CD.all())).toEqual(["g_b"]);
    CD.clear("g_zz");
    expect(Object.keys(CD.all())).toEqual(["g_b"]);
    CD.clear("g_b");
    expect(localStorage.getItem(COACH_DRAFT_KEY)).toBeNull();
    expect(localStorage.getItem("forge:Coach:draft")).toBe("{\"keep\":1}");
    expect(localStorage.getItem("forge:active")).toBe("\"Coach\"");
  });
});

describe("Review", () => {
  it("lists the sets, sends on the day picked, and the draft goes only on a 200", async () => {
    seedFinishedDraft();
    const calls = await toReview({ "/api/trainer/change": (b) => changeOk(b) });
    expect(screen.getByText("Barbell Back Squat · 100 × 5, 5, 5 · felt 8, 8, 8")).toBeTruthy();
    expect(screen.getByText("Sam sees it next time they open the app. It's kept after five hours unless they say otherwise.")).toBeTruthy();
    expect(button(/^Today$/).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button(/^Yesterday$/));
    fireEvent.click(button(/^Send to Sam$/));
    await settle();
    const { record, drum } = sentBody(calls).set.ops[0];
    expect(record).toMatchObject({ date: YESTERDAY, dow: 2, weekStart: "2026-10-05" });
    // Today's plan at the finish: the saved drum over the last logged weights, for logged lifts only.
    expect(drum["Barbell Back Squat"]).toBe(102.5);
    expect(drum["Barbell Bench Press"]).toBe(60);
    expect(drum).not.toHaveProperty("Not Logged");
    expect(CD.load(REF)).toBeNull();
    expect(router.replace).toHaveBeenCalledWith("/trainer");
  });

  it("Face ID: asks, retries, then sends", async () => {
    seedFinishedDraft();
    let fresh = false;
    const calls = await toReview({
      "/api/trainer/change": (b) => (fresh ? changeOk(b) : [403, { needsFaceId: true }]),
      "/api/trainer/session": () => { fresh = true; return [200, { ok: true, name: "Coach" }]; },
    });
    fireEvent.click(button(/^Send to Sam$/));
    await settle();
    // No name in memory (a reload): it can't ask, and says where to go.
    fireEvent.click(button(/^Confirm it's you$/));
    await settle();
    expect(screen.getByText("Open Sam again from your trainer page to confirm it's you. It's saved here.")).toBeTruthy();
    expect(passkey.authenticatePasskey).not.toHaveBeenCalled();
    expect(CD.load(REF)).not.toBeNull();
    coachTrainer.set("Coach");
    passkey.authenticatePasskey.mockRejectedValueOnce(new Error("cancelled"));
    fireEvent.click(button(/^Confirm it's you$/));
    await settle();
    expect(screen.getByText("Face ID didn't go through. Try again.")).toBeTruthy();
    passkey.authenticatePasskey.mockResolvedValue({ authToken: "tok" });
    fireEvent.click(button(/^Confirm it's you$/));
    await settle();
    expect(passkey.authenticatePasskey).toHaveBeenCalledWith("Coach", { quiet: true });
    expect(calls.find((c) => c.url === "/api/trainer/session").body).toEqual({ authToken: "tok", profile: "Coach" });
    expect(CD.load(REF)).toBeNull();
    expect(router.replace).toHaveBeenCalledWith("/trainer");
  });

  it.each([
    ["throw", "Not sent. It's saved here. Send when you're back online."],
    [[422, { refusals: [{ i: 0, code: "already_logged", rule: "S13" }] }], "Sam already logged Strength A for today."],
    [[422, { refusals: [{ i: 0, code: "day", rule: "S4", field: "date" }] }], "That day can't be sent now. Go back and review it again to pick the day. It's saved here."],
    [[409, { alreadySent: true }], "You've already sent Strength A for today."],
    [[409, { stale: true }], "Sam's plan changed since this session started, so it can't be sent as it is. It's saved here."],
    [[429, { budget: { used: 7, of: 7 } }], "That's seven sessions with Sam this week. It's saved here."],
    [[403, { fresh: true }], "Ask Sam for a fresh code. It's saved here."],
  ])("a send that doesn't go keeps the draft: %#", async (answer, words) => {
    seedFinishedDraft();
    await toReview({ "/api/trainer/change": answer });
    fireEvent.click(button(/^Send to Sam$/));
    await settle();
    expect(screen.getByText(words)).toBeTruthy();
    expect(CD.load(REF)).not.toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    // A session that can't go can still be discarded from here.
    expect(button(/^Discard this session$/)).toBeTruthy();
  });

  it("a send whose reply was lost: the dry run finds it, the same set id replays as sent", async () => {
    seedFinishedDraft();
    let landed = null;
    // The route's replay: the same set id with the record and drum as stored
    // (app/api/trainer/change/route.js sameOp); the same id otherwise is a mismatch.
    const stored = (b) => stableStringify({ record: b.set.ops[0].record, drum: b.set.ops[0].drum ?? {} });
    const calls = await toReview({
      "/api/trainer/change": (b) => {
        if (!landed) {
          if (b.dryRun) return changeOk(b);
          landed = { id: b.set.id, body: stored(b) };
          return "throw";
        }
        if (b.set.id !== landed.id) return [409, { code: "already_sent" }];
        if (stored(b) !== landed.body) return [409, { code: "replay_mismatch" }];
        if (b.dryRun) return [409, { code: "already_sent" }];
        return [200, { sent: { set: b.set.id, ids: [] }, replay: true }];
      },
    });
    fireEvent.click(button(/^Send to Sam$/));
    await settle();
    expect(screen.getByText("Not sent. It's saved here. Send when you're back online.")).toBeTruthy();
    // Back and Review again, a little later, keep the set id and the record.
    fireEvent.click(button(/^Back to the session$/));
    vi.setSystemTime(Date.now() + 20_000);
    fireEvent.click(button(/^Finish session$/));
    fireEvent.click(button(/^Send to Sam$/));
    await settle();
    const real = calls.filter((c) => c.url === "/api/trainer/change" && !c.body.dryRun);
    expect(real.map((c) => c.body.set.id)).toEqual([landed.id, landed.id]);
    expect(stableStringify(real[1].body.set.ops[0])).toBe(stableStringify(real[0].body.set.ops[0]));
    expect(CD.load(REF)).toBeNull();
    expect(router.replace).toHaveBeenCalledWith("/trainer");
  });

  it("a set id the route holds for other changes is replaced before the next try", async () => {
    seedFinishedDraft();
    const calls = await toReview({ "/api/trainer/change": (b) => (b.dryRun ? changeOk(b) : [409, { code: "replay_mismatch" }]) });
    fireEvent.click(button(/^Send to Sam$/));
    await settle();
    expect(screen.getByText("That didn't send. Try again.")).toBeTruthy();
    fireEvent.click(button(/^Send to Sam$/));
    await settle();
    const ids = calls.filter((c) => !c.body.dryRun).map((c) => c.body.set.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(CD.load(REF)).not.toBeNull();
  });

  it("with no name, the already-logged line reads They", async () => {
    seedFinishedDraft(T0, { name: null });
    await toReview({ "/api/trainer/change": [422, { refusals: [{ i: 0, code: "already_logged", rule: "S13" }] }] });
    fireEvent.click(button(/^Send$/));
    await settle();
    expect(screen.getByText("They already logged Strength A for today.")).toBeTruthy();
  });

  it("a lift past ten sets sends its first ten, and says so; the draft keeps them all", async () => {
    seedFinishedDraft(T0, { squatSets: 11 });
    const calls = await toReview({ "/api/trainer/change": (b) => changeOk(b) });
    expect(screen.getByText("Only the first ten sets of Barbell Back Squat go. Ten is the most for one lift.")).toBeTruthy();
    expect(CD.load(REF).draft.blocks.a1.exercises["Barbell Back Squat"].sets).toHaveLength(11);
    fireEvent.click(button(/^Send to Sam$/));
    await settle();
    const squat = sentBody(calls).set.ops[0].record.blocks.flatMap((b) => b.exercises).find((e) => e.name === "Barbell Back Squat");
    expect(squat.sets).toHaveLength(10);
  });

  it("Back returns to the session with every set kept", async () => {
    seedFinishedDraft();
    const calls = await toReview({});
    fireEvent.click(button(/^Back to the session$/));
    expect(button(/^Finish session$/)).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("a draft started more than a day before both offers is too old to send", async () => {
    seedFinishedDraft(T0 - 3 * 86_400_000);
    await toReview({});
    expect(screen.getByText("Too old to send. It started Sunday 4 Oct.")).toBeTruthy();
    expect(button(/^Send/)).toBeNull();
    expect(button(/^Discard this session$/)).toBeTruthy();
  });

  it("a lost reply, then a reload: Review reuses the held set id and duration, and replays as sent", async () => {
    seedFinishedDraft();
    let landed = null;
    const stored = (b) => stableStringify({ record: b.set.ops[0].record, drum: b.set.ops[0].drum ?? {} });
    const route = (b) => {
      if (!landed) {
        if (b.dryRun) return changeOk(b);
        landed = { id: b.set.id, body: stored(b) };
        return "throw";
      }
      if (b.set.id !== landed.id) return [409, { code: "already_sent" }];
      if (stored(b) !== landed.body) return [409, { code: "replay_mismatch" }];
      if (b.dryRun) return [409, { code: "already_sent" }];
      return [200, { sent: { set: b.set.id, ids: [] }, replay: true }];
    };
    const first = await toReview({ "/api/trainer/change": route });
    fireEvent.click(button(/^Send to Sam$/));
    await settle();
    expect(screen.getByText("Not sent. It's saved here. Send when you're back online.")).toBeTruthy();
    const held = CD.load(REF);
    expect(held.setId).toBe(landed.id);
    expect(held.duration).toBe(3600);
    cleanup();
    // The reload, twenty minutes on: the page resumes the draft and Review opens again.
    vi.setSystemTime(Date.now() + 20 * 60_000);
    const calls = await toReview({ "/api/trainer/change": route });
    fireEvent.click(button(/^Send to Sam$/));
    await settle();
    const real = [...first, ...calls].filter((c) => c.url === "/api/trainer/change" && !c.body.dryRun);
    expect(real.map((c) => c.body.set.id)).toEqual([landed.id, landed.id]);
    expect(real[1].body.set.ops[0].record.duration).toBe(3600);
    expect(stableStringify(real[1].body.set.ops[0])).toBe(stableStringify(real[0].body.set.ops[0]));
    expect(CD.load(REF)).toBeNull();
    expect(router.replace).toHaveBeenCalledWith("/trainer");
  });

  it("a set logged after Review drops the held duration and keeps the set id", async () => {
    seedFinishedDraft();
    await toReview({});
    const { setId } = CD.load(REF);
    expect(typeof setId).toBe("string");
    fireEvent.click(button(/^Back to the session$/));
    fireEvent.click(button(/^Add another set$/));
    // The last block is a pair: A, then B logs the round.
    for (let i = 0; i < 4 && CD.load(REF).duration !== undefined; i++) fireEvent.click(button(/^(Log |One more set)/));
    const after = CD.load(REF);
    expect(after.setId).toBe(setId);
    expect(after).not.toHaveProperty("duration");
  });
});

/** Every localStorage key and value, with each coached draft as a key of its own. */
function snapshot() {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = /** @type {string} */ (localStorage.key(i));
    const v = /** @type {string} */ (localStorage.getItem(k));
    if (k !== COACH_DRAFT_KEY) { out[k] = v; continue; }
    for (const [ref, e] of Object.entries(JSON.parse(v))) out[`${k}/${ref}`] = JSON.stringify(e);
  }
  return out;
}

describe("Discard this session", () => {
  it("asks first, then removes exactly this client's draft: one key gone, every other key untouched", async () => {
    seedFinishedDraft();
    // Everything else on the device: another client's draft, and the trainer's own lifter keys.
    const other = { ...CD.load(REF), name: "Ana" };
    vi.setSystemTime(T0 - 60_000);
    CD.save("g_other", other);
    vi.setSystemTime(T0 + 3_600_000);
    localStorage.setItem("forge:active", "\"Coach\"");
    localStorage.setItem("forge:Coach:draft", "{\"keep\":1}");
    localStorage.setItem("forge:Coach:weights", "{\"Barbell Back Squat\":120}");
    localStorage.setItem("forge:lastSyncAt", "1700000000000");
    const before = snapshot();
    expect(Object.keys(before)).toContain(`${COACH_DRAFT_KEY}/${REF}`);

    const calls = await toReview({});
    fireEvent.click(button(/^Discard this session$/));
    // The first tap only asks; focus moves to the confirm, and Keep editing goes back.
    expect(screen.getByText("Discard this session? It's removed from this device.")).toBeTruthy();
    expect(document.activeElement).toBe(button(/^Discard$/));
    expect(CD.load(REF)).not.toBeNull();
    fireEvent.click(button(/^Keep editing$/));
    expect(document.activeElement).toBe(button(/^Discard this session$/));
    expect(CD.load(REF)).not.toBeNull();
    fireEvent.click(button(/^Discard this session$/));
    fireEvent.click(button(/^Discard$/));

    const after = snapshot();
    const gone = Object.keys(before).filter((k) => !(k in after));
    expect(gone).toEqual([`${COACH_DRAFT_KEY}/${REF}`]);
    expect(Object.keys(after).filter((k) => !(k in before))).toEqual([]);
    for (const k of Object.keys(after)) expect(after[k], k).toBe(before[k]);
    expect(calls).toEqual([]);
    expect(router.replace).toHaveBeenCalledWith("/trainer");
  });

  it("the last draft on the device takes its key with it, and nothing else", async () => {
    seedFinishedDraft();
    localStorage.setItem("forge:active", "\"Coach\"");
    await toReview({});
    fireEvent.click(button(/^Discard this session$/));
    fireEvent.click(button(/^Discard$/));
    expect(localStorage.getItem(COACH_DRAFT_KEY)).toBeNull();
    expect(Object.keys(snapshot())).toEqual(["forge:active"]);
  });

  it("does nothing while a send is in flight", async () => {
    seedFinishedDraft();
    await toReview({});
    /** @type {(v: any) => void} */
    let answer = () => {};
    const pending = vi.fn(() => new Promise((r) => { answer = r; }));
    vi.stubGlobal("fetch", pending);
    fireEvent.click(button(/^Discard this session$/));
    fireEvent.click(button(/^Send to Sam$/));
    await settle();
    expect(pending).toHaveBeenCalledTimes(1);
    fireEvent.click(button(/^Discard$/));
    expect(CD.load(REF)).not.toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    await act(async () => { answer({ ok: false, status: 500, json: async () => ({}) }); });
    await settle();
  });

  it("Quit in a coached session keeps the draft", async () => {
    seedFinishedDraft();
    stub({});
    at("/trainer/coach");
    render(<CoachedSessionPage/>);
    await settle();
    fireEvent.click(button(/Quit/));
    expect(CD.load(REF)).not.toBeNull();
    expect(router.replace).toHaveBeenCalledWith("/trainer");
  });
});

describe("pure helpers", () => {
  it("reviewLine reads as the spec's line", () => {
    const sets = (pairs, rpe = []) => pairs.map(([weight, reps], i) => ({ weight, reps, rpe: rpe[i] ?? null }));
    expect(reviewLine({ name: "Back Squat", loadType: "external", sets: sets([[100, 5], [100, 5], [100, 5]], [8, 8, 9]) })).toBe("Back Squat · 100 × 5, 5, 5 · felt 8, 8, 9");
    expect(reviewLine({ name: "Bench", loadType: "external", sets: sets([[60, 6], [62.5, 5]]) })).toBe("Bench · 60 × 6, 62.5 × 5");
    expect(reviewLine({ name: "Push-Up", loadType: "bodyweight", sets: sets([[null, 12], [null, 10]]) })).toBe("Push-Up · 12, 10");
    expect(reviewLine({ name: "Dip", loadType: "bodyweight", sets: sets([[10, 8]]) })).toBe("Dip · +10 × 8");
  });
  it("recordOnDay moves the day and its fields, and holds the duration to the route's bound", () => {
    const r = recordOnDay({ id: "x", date: TODAY, dow: 3, weekStart: "2026-10-05", duration: 90_000, blocks: [] }, "2026-10-05");
    expect(r).toEqual({ id: "x", date: "2026-10-05", dow: 1, weekStart: "2026-10-05", duration: 21600, blocks: [] });
  });
  it("capDraftSets trims a copy to ten sets a lift, and names the lifts", () => {
    const sets = (n) => Array.from({ length: n }, () => ({ reps: 5 }));
    const draft = { blocks: { a1: { exercises: { Squat: { name: "Squat", sets: sets(12) } } }, a2: { exercises: { Bench: { name: "Bench", sets: sets(10) } } } } };
    const { draft: out, over } = capDraftSets(draft);
    expect(over).toEqual(["Squat"]);
    expect(out.blocks.a1.exercises.Squat.sets).toHaveLength(10);
    expect(out.blocks.a2.exercises.Bench.sets).toHaveLength(10);
    expect(draft.blocks.a1.exercises.Squat.sets).toHaveLength(12);
  });
  it("coachedSource reads the rep targets in force, not the first slot's template", () => {
    const plan = { lifts: [{ name: "DB Step-Up", reps: 8 }, { name: "Squat", reps: 5 }], programme: { reps: { Squat: 5 } } };
    expect(coachedSource(plan, null).reps()).toEqual({ Squat: 5 });
    expect(coachedSource({ lifts: plan.lifts }, null).reps()).toEqual({ "DB Step-Up": 8, Squat: 5 });
  });
  it("sessionDrum keeps only the record's lifts, as numbers", () => {
    const record = { blocks: [{ exercises: [{ name: "A" }, { name: "B" }] }] };
    expect(sessionDrum(record, { A: 50, B: null, C: 20, D: -1 })).toEqual({ A: 50 });
  });
});

describe("ten sets a lift in a coached session", () => {
  const squat = { name: "Barbell Back Squat", muscle: "Quads", reps: 5, weight: 100, loadType: "barbell" };
  const main = { id: "main", type: "main", label: "Main lift", sets: 3, rest: 180, ex: squat };
  /** The screen at a finished block with `logged` sets in, as the host hands it over. */
  const screenAt = (logged, extra = {}) => render(<SessionScreen {...{
    session: { name: "Strength A", blocks: [main] }, block: main, blockIdx: 0, totalBlocks: 2, setNum: logged + 1, phase: "A", isSS: false,
    activeEx: squat, resolvedExA: null, resolvedExB: null, resolvedEx: squat, swapKey: "main", onSwap: () => {},
    showVid: false, setShowVid: () => {}, getW: (e) => e?.weight ?? null, getR: (e) => e?.reps ?? null, editTarget: null, setEditTarget: () => {},
    planWeights: {}, setPlanWeights: () => {}, planReps: {}, setPlanReps: () => {}, history: [],
    loggedSets: Array.from({ length: logged }, () => ({ weight: 100, reps: 5, rpe: 8 })), awaitRpe: false, ssRoundDone: false,
    restActive: false, restRemain: 180, setRestActive: () => {}, setRestRemain: () => {},
    onCommit: () => {}, onLog: () => {}, onQuit: () => {}, onShowOverview: () => {}, bodyweight: 80,
    nextExName: "Barbell Bench Press", onNext: () => {}, ...extra,
  }}/>);

  it("the screen offers no eleventh set when capped, and is unchanged without a cap", () => {
    screenAt(9, { maxSets: 10 });
    expect(button(/^Add another set$/)).toBeTruthy();
    cleanup();
    screenAt(10, { maxSets: 10 });
    expect(button(/^Add another set$/)).toBeNull();
    expect(button(/^Next: Barbell Bench Press$/)).toBeTruthy();
    cleanup();
    // The guarded fork (an earlier block left short) drops its quiet control too.
    screenAt(10, { maxSets: 10, backTo: { idx: 1, name: "Barbell Bench Press" } });
    expect(button(/^Add another set$/)).toBeNull();
    expect(button(/^Finish anyway$/)).toBeTruthy();
    cleanup();
    screenAt(10);
    expect(button(/^Add another set$/)).toBeTruthy();
    cleanup();
    screenAt(12);
    expect(button(/^Add another set$/)).toBeTruthy();
  });

  /** A Strength A draft holding `n` squat sets and nothing else. */
  const squatDraft = (n, profileName) => {
    const draft = newDraftLog({ profileName, session: "strength-a", blockNumber: 1, readiness: "normal" });
    const b = SESSIONS[0].blocks[0];
    for (let i = 0; i < n; i++) {
      logSet(draft, { blockId: b.id, blockType: b.type, exerciseName: b.ex.name, muscle: b.ex.muscle, swapped: false, fromPool: null,
        loadType: getLoadType(b.ex), bodyweight: null, weight: 100, reps: 5, rpe: 8, prescribed: { reps: 5, weight: 100, sets: b.sets } });
    }
    return draft;
  };

  it("the coached page passes the cap: at ten squat sets the fork offers only what comes next", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    for (const [n, offered] of [[9, true], [10, false]]) {
      CD.save(REF, { letter: "A", name: "Sam", plan: planFor(), draft: squatDraft(n, null), swaps: {}, sessionWeights: {}, sessionReps: {}, addedLoads: {}, readiness: "normal", readinessReason: null });
      stub({});
      at("/trainer/coach");
      render(<CoachedSessionPage/>);
      await settle();
      expect(!!button(/^Add another set$/), `${n} sets`).toBe(offered);
      cleanup();
    }
  });

  it("the live session has no cap: ten squat sets still offer another", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    P.setActive("Tess");
    D.save("Tess", squatDraft(10, "Tess"));
    SessionIntent.stash("Tess", { resume: true });
    render(<SessionHost/>);
    await settle();
    expect(document.body.textContent).toMatch(/All 3 sets logged/);
    expect(button(/^Add another set$/)).toBeTruthy();
  });
});
