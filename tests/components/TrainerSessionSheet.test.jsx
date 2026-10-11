// @vitest-environment jsdom
// The coached session on the client's phone: the Home card, the sheet it
// opens, and ForgeApp's auto-keep timer. The words come from the record's
// own day; felt is adjustable per set; Keep is final (no undo); "Not mine"
// asks before it discards. W-G: with the sheet open past keepsAt nothing is
// kept, and closing it asks for the pull that keeps it. Auto-keep happens
// only on a pull that lands (sharing as it is now), never from the card held
// here. lib/storage.js's keep, discard, hold and pull are mocked here
// (tests/trainer-session-apply covers the store's side).
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));
vi.mock("@vercel/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/webauthn", () => ({
  isPlatformAuthenticatorAvailable: vi.fn(async () => false),
  isWebAuthnSupported: () => false,
  registerPasskey: vi.fn(async () => ({ ok: false })),
  hasPasskey: vi.fn(async () => true),
  passkeyStatus: vi.fn(async () => null),
  authenticatePasskey: vi.fn(async () => null),
}));
// The network edges, and the session decisions: keep and discard take the
// card off the list as the store does, and report what they were asked.
// Keep is async, like the store's (it loads the commit path first).
vi.mock("@/lib/storage", async (io) => {
  const real = await io();
  const decide = (profile, id) => {
    const tl = real.TL.get(profile);
    real.TL.save(profile, { ...tl, pendingSessions: (tl.pendingSessions ?? []).filter((c) => c.id !== id) });
  };
  return {
    ...real,
    backgroundSync: vi.fn(async () => {}),
    enableAutoSync: vi.fn(),
    disableAutoSync: vi.fn(),
    pushNow: vi.fn(async () => ({ ok: true })),
    flushPendingPushes: vi.fn(async () => {}),
    ensurePersistentStorage: vi.fn(async () => {}),
    keepTrainerSession: vi.fn(async (profile, id, { auto = false } = {}) => {
      await new Promise((r) => setTimeout(r, 0));
      decide(profile, id);
      return { kept: true, outcome: auto ? "auto_kept" : "kept", reason: null, delivery: Promise.resolve(true) };
    }),
    discardTrainerSession: vi.fn((profile, id) => {
      decide(profile, id);
      return { discarded: true, delivery: Promise.resolve(true) };
    }),
    holdTrainerSession: vi.fn(),
    setSessionCommit: vi.fn((fn) => real.setSessionCommit(fn)),
  };
});
// Home as its contract: the first waiting session and a way to open it.
vi.mock("@/components/HomeScreen", () => ({
  default: ({ profileName, trainerSessions = [], onOpenTrainerSession }) => (
    <div>
      <span>Home of {profileName}</span>
      <span data-testid="waiting">{trainerSessions.length}</span>
      {trainerSessions[0] && <button onClick={() => onOpenTrainerSession(trainerSessions[0].id)}>Review</button>}
    </div>
  ),
}));

const { default: TrainerSessionSheet, TrainerSessionCard, sessionTitle, keepsAtWords, sessionCardsFrom } = await import("@/components/TrainerSessionSheet");
const { default: ForgeApp } = await import("@/components/ForgeApp");
// What ForgeApp handed Keep at load, read before any test clears the mocks.
const handedIn = (await import("@/lib/storage")).setSessionCommit.mock.calls.map((c) => c[0]);
const { commitSessionRecord } = await import("@/lib/session-commit");
const { default: HomeScreenReal } = await vi.importActual("@/components/HomeScreen");
const { P, TL, backgroundSync, keepTrainerSession, discardTrainerSession, holdTrainerSession } = await import("@/lib/storage");
const { AUTO_KEEP_MS } = await import("@/lib/trainer-change");
const { todayLocalIso, addDaysIso } = await import("@/lib/dates");
const { WEEK } = await import("@/lib/programme");

const SET = "hws_" + "a".repeat(26);
const ID = `${SET}.0`;
const set = (weight, reps, rpe) => ({ weight, reps, rir: rpe === null ? null : Math.min(3, 10 - rpe), rpe, loadType: "external", bodyweightUsed: null, effectiveLoad: weight, est1rm: null, volume: null });
/** A sent record, as the sheet reads it: Strength A, a squat and a swapped-in push-up superset. */
function record(date) {
  return {
    id: `${date}T09:00:00.000Z`, date, session: "strength-a", scheduledLetter: "A", duration: 3120,
    blocks: [
      { id: "main1", type: "main", intent: null, exercises: [
        { name: "Barbell Back Squat", loadType: "external", swapped: false, sets: [set(100, 5, 7.5), set(100, 5, 8), set(100, 4, 9)] },
      ] },
      { id: "ss1", type: "superset", intent: null, exercises: [
        { name: "Push-Up", loadType: "bodyweight", swapped: true, sets: [{ ...set(null, 12, null), loadType: "bodyweight" }] },
      ] },
    ],
  };
}
const card = (over = {}) => ({ id: ID, record: record(over.date ?? "2026-10-09"), drum: {}, by: "Sam", startMs: 0, keepsAt: null, ...over });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ── The words ───────────────────────────────────────────────────────────────

describe("the record's day words", () => {
  it("names the day from the record against the client's today, never 'today' when the dates differ", () => {
    expect(sessionTitle(card({ date: "2026-10-10" }), "2026-10-10")).toBe("Sam ran Strength A with you today");
    expect(sessionTitle(card({ date: "2026-10-09" }), "2026-10-10")).toBe("Sam ran Strength A with you yesterday");
    // The trainer's today is a day ahead of the client's: the record's own date, in words.
    expect(sessionTitle(card({ date: "2026-10-10" }), "2026-10-09")).toBe("Sam ran Strength A with you on Saturday 10 Oct");
    expect(sessionTitle(card({ date: "2026-10-06" }), "2026-10-10")).toBe("Sam ran Strength A with you on Tuesday 6 Oct");
    expect(sessionTitle(card({ by: null }), "2026-10-10")).toBe("Your trainer ran Strength A with you yesterday");
  });

  it("gives the keep time in the client's clock, and the day when it is not today", () => {
    const now = new Date(2026, 9, 10, 11, 40).getTime();
    expect(keepsAtWords(new Date(2026, 9, 10, 16, 40).getTime(), now)).toBe("16:40");
    expect(keepsAtWords(new Date(2026, 9, 11, 2, 10).getTime(), now)).toBe("02:10 tomorrow");
    expect(keepsAtWords(null, now)).toBeNull();
  });

  it("reads the waiting cards oldest first, leaving out any decided here", () => {
    const a = card({ id: `${SET}.0`, startMs: 300 });
    const b = card({ id: `${SET}.1`, startMs: 100 });
    const c = card({ id: `${SET}.2`, startMs: 200 });
    const tl = { pendingSessions: [a, b, c, { id: "broken" }], sessions: { [`${SET}.2`]: { decided: "kept" } }, outbox: { acks: [] } };
    expect(sessionCardsFrom(tl).map((x) => x.id)).toEqual([`${SET}.1`, `${SET}.0`]);
    expect(sessionCardsFrom({ ...tl, outbox: { acks: [{ id: `${SET}.1` }] } }).map((x) => x.id)).toEqual([`${SET}.0`]);
    expect(sessionCardsFrom(null)).toEqual([]);
  });
});

// ── The sheet ───────────────────────────────────────────────────────────────

function sheet(over = {}, props = {}) {
  const handlers = { onFelt: vi.fn(), onKeep: vi.fn(), onDiscard: vi.fn(), onClose: vi.fn() };
  const r = render(<TrainerSessionSheet card={card(over)} todayIso="2026-10-10" {...handlers} {...props}/>);
  return { ...r, ...handlers };
}

describe("the sheet", () => {
  it("titles it from the record, lists every set, and says when it keeps itself", () => {
    const keepsAt = Date.now() + 2 * 3600e3;
    sheet({ keepsAt });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Sam ran Strength A with you yesterday");
    expect(dialog.textContent).toContain("Friday 9 Oct · 4 sets · 52 min");
    expect(dialog.textContent).toContain(`Kept at ${keepsAtWords(keepsAt, Date.now())} unless you say otherwise`);
    const squat = within(dialog).getByRole("region", { name: "Barbell Back Squat" });
    expect(squat.textContent).toContain("Barbell Back Squat · 100 kg");
    expect(within(squat).getAllByRole("group").map((g) => g.textContent)).toEqual(["felt 7.5", "felt 8", "felt 9"]);
    expect(squat.textContent).toContain("4 reps");
    const pushUp = within(dialog).getByRole("region", { name: "Push-Up" });
    expect(pushUp.textContent).toContain("Swapped in on the day");
    expect(pushUp.textContent).toContain("12 reps");
    // A superset set logs no felt, so it has nothing to adjust.
    expect(within(pushUp).queryByRole("group")).toBeNull();
    expect(dialog.textContent).toContain("Keep adds it to your training, like a session you logged. You can't undo it.");
  });

  it("says nothing keeps it once sharing has stopped, and that it keeps on the next sync once due", () => {
    sheet({ keepsAt: null });
    expect(screen.getByRole("dialog").textContent).toContain("Sharing has stopped, so it waits here until you decide.");
    cleanup();
    sheet({ keepsAt: Date.now() - 1000 });
    expect(screen.getByRole("dialog").textContent).toContain("Five hours have passed. It's kept the next time the app syncs, unless you say otherwise.");
    expect(screen.getByRole("dialog").textContent).not.toMatch(/Kept at/);
    // Closing now keeps it, so the close says so rather than "Later".
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Later" })).toBeNull();
  });

  it("adjusts felt per set in half steps within 6 to 10, keyed by block, exercise and set", () => {
    const { onFelt, rerender, onKeep, onDiscard, onClose } = sheet();
    fireEvent.click(screen.getByRole("button", { name: "Harder, Barbell Back Squat set 1" }));
    expect(onFelt).toHaveBeenLastCalledWith({ "0.0.0": 8 });
    // Held edits show, and the next edit keeps them.
    rerender(<TrainerSessionSheet card={card()} todayIso="2026-10-10" felt={{ "0.0.0": 8 }} onFelt={onFelt} onKeep={onKeep} onDiscard={onDiscard} onClose={onClose}/>);
    expect(screen.getByRole("group", { name: "Felt, Barbell Back Squat set 1" }).textContent).toBe("felt 8");
    fireEvent.click(screen.getByRole("button", { name: "Easier, Barbell Back Squat set 3" }));
    expect(onFelt).toHaveBeenLastCalledWith({ "0.0.0": 8, "0.0.2": 8.5 });
    rerender(<TrainerSessionSheet card={card()} todayIso="2026-10-10" felt={{ "0.0.2": 10 }} onFelt={onFelt} onKeep={onKeep} onDiscard={onDiscard} onClose={onClose}/>);
    expect(screen.getByRole("button", { name: "Harder, Barbell Back Squat set 3" }).disabled).toBe(true);
  });

  it("Keep keeps, with no undo after", () => {
    const { onKeep, onDiscard } = sheet();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
  });

  it("'Not mine' asks first; Discard discards and Back goes back", () => {
    const { onDiscard, onKeep } = sheet();
    fireEvent.click(screen.getByRole("button", { name: "Not mine" }));
    expect(onDiscard).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").textContent).toContain("Discard Sam's session? Sam will see you didn't keep it.");
    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Keep" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not mine" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onKeep).not.toHaveBeenCalled();
  });

  it("focus stays in the sheet through the confirm, so Escape still closes it", () => {
    const { onClose } = sheet();
    for (let i = 0; i < 2; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Not mine" }));
      // The confirm's first control, never the page behind.
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Discard" }));
      expect(document.activeElement).not.toBe(document.body);
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Not mine" }));
      expect(document.activeElement).not.toBe(document.body);
    }
    fireEvent.keyDown(/** @type {Element} */ (document.activeElement), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from its bottom row and from Escape", () => {
    const { onClose } = sheet();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

// ── Home's slot ─────────────────────────────────────────────────────────────

describe("Home's card", () => {
  it("once due, names the next sync rather than a time already past", () => {
    render(<TrainerSessionCard card={card({ keepsAt: Date.now() - 60_000 })} todayIso="2026-10-10" onReview={vi.fn()}/>);
    expect(document.body.textContent).toContain("Five hours have passed. It's kept the next time the app syncs, unless you say otherwise.");
    expect(document.body.textContent).not.toMatch(/Kept at/);
  });

  it("shows the oldest waiting session in its slot and opens it", () => {
    const onReview = vi.fn();
    const keepsAt = Date.now() + 3600e3;
    render(<TrainerSessionCard card={card({ keepsAt })} more={1} todayIso="2026-10-10" onReview={onReview}/>);
    expect(screen.getByText("Sam ran Strength A with you yesterday. Keep it?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review", description: "Sam ran Strength A with you yesterday. Keep it?" })).toBeTruthy();
    expect(document.body.textContent).toContain(`Kept at ${keepsAtWords(keepsAt, Date.now())} unless you say otherwise · 1 more after this`);
    // The time first: "Kept at 16:40 unless you say otherwise", nothing after the clause.
    expect(keepsAtWords(keepsAt, Date.now())).toMatch(/^\d{2}:\d{2}( tomorrow| on .+)?$/);
    fireEvent.click(screen.getByRole("button", { name: /Review/ }));
    expect(onReview).toHaveBeenCalledWith(ID);
  });

  it("HomeScreen renders the card from trainerSessions, and nothing without one", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const props = { rhythm: { completed: 0, expected: 0, ratio: 0 }, profileName: "sam", userWeek: WEEK, strengthDaySessions: [0, undefined, 1, undefined, 2, undefined, undefined] };
    const onOpen = vi.fn();
    const today = todayLocalIso();
    const { rerender } = render(<HomeScreenReal {...props} trainerSessions={[card({ date: addDaysIso(today, -1) })]} onOpenTrainerSession={onOpen}/>);
    expect(screen.getByText("Sam ran Strength A with you yesterday. Keep it?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Review/ }));
    expect(onOpen).toHaveBeenCalledWith(ID);
    rerender(<HomeScreenReal {...props} trainerSessions={[]} onOpenTrainerSession={onOpen}/>);
    expect(screen.queryByText(/ran Strength A with you/)).toBeNull();
    vi.unstubAllGlobals();
  });
});

// ── ForgeApp: the mount and the timer (W-G) ─────────────────────────────────

describe("ForgeApp: the card, the sheet and auto-keep", () => {
  it("hands Keep the live finish's commit at load, so a Keep offline has nothing to fetch", () => {
    expect(handedIn).toEqual([commitSessionRecord]);
  });

  const FIVE_H = AUTO_KEEP_MS;
  let T0;
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(2026, 9, 10, 9, 0));
    T0 = Date.now();
    localStorage.setItem("forge:onboarded", "true");
    P.add("Sam");
    P.setActive("Sam");
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 404 }));
  });
  afterEach(() => { backgroundSync.mockReset(); });
  /** One session waiting on this device: arrived at T0, keeps five hours later. */
  const waiting = (over = {}) => {
    const c = { ...card({ date: todayLocalIso(), startMs: T0, keepsAt: T0 + FIVE_H }), set: SET, at: T0, deliveredAt: null, editsLive: true, authorId: null, ...over };
    TL.save("Sam", { pending: [], marks: {}, outbox: { acks: [], reverts: [] }, sessions: { [c.id]: { seenAt: T0 } }, pendingSessions: [c] });
    return c;
  };
  const advance = (ms) => act(async () => { vi.advanceTimersByTime(ms); });
  /** A pull that lands with sharing live: the store's own step keeps what is due. */
  const landedPull = async (profile, opts) => {
    const tl = TL.get(profile);
    const now = Date.now();
    const due = (tl?.pendingSessions ?? []).filter((c) => opts?.applyTrainer && c.editsLive && typeof c.keepsAt === "number" && c.keepsAt <= now);
    if (!due.length) return { source: "local", changed: false };
    TL.save(profile, { ...tl, pendingSessions: tl.pendingSessions.filter((c) => !due.includes(c)) });
    return { source: "local", changed: false, trainer: { wrote: true, acks: due.length, reverts: 0, delivery: Promise.resolve(true) } };
  };
  const home = async () => {
    render(<ForgeApp/>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Home of Sam")).toBeTruthy();
  };

  it("keeps at keepsAt on Home, and not a moment before, through a pull that lands", async () => {
    backgroundSync.mockImplementation(landedPull);
    waiting();
    await home();
    expect(screen.getByTestId("waiting").textContent).toBe("1");
    expect(backgroundSync).toHaveBeenCalledTimes(1);
    await advance(FIVE_H - 1000);
    expect(backgroundSync).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("waiting").textContent).toBe("1");
    await advance(1000);
    // The due session asks for a pull; the pull's own step keeps it.
    expect(backgroundSync).toHaveBeenCalledTimes(2);
    expect(backgroundSync).toHaveBeenLastCalledWith("Sam", expect.objectContaining({ applyTrainer: true }));
    await advance(1);
    expect(screen.getByTestId("waiting").textContent).toBe("0");
    expect(keepTrainerSession).not.toHaveBeenCalled();
  });

  it("a due session whose pull does not land keeps nothing: auto-keep needs sharing as it is now", async () => {
    // Offline, a server error or a failed auth all read the same: no trainer key.
    waiting();
    await home();
    await advance(FIVE_H);
    expect(backgroundSync).toHaveBeenCalledTimes(2);
    expect(backgroundSync).toHaveBeenLastCalledWith("Sam", expect.objectContaining({ applyTrainer: true }));
    await advance(1);
    expect(keepTrainerSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("waiting").textContent).toBe("1");
    await advance(3 * FIVE_H);
    expect(keepTrainerSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("waiting").textContent).toBe("1");
  });

  it("back in the foreground past keepsAt, a pull that says sharing stopped keeps nothing", async () => {
    waiting();
    await home();
    // While they were away, sharing stopped: the next pull serves the row
    // with editsLive false, and the store lists it with no keep time.
    backgroundSync.mockImplementation(async () => {
      const tl = TL.get("Sam");
      TL.save("Sam", { ...tl, pendingSessions: tl.pendingSessions.map((c) => ({ ...c, keepsAt: null, editsLive: false })) });
      return { source: "local", changed: false, trainer: { wrote: false, acks: 0, reverts: 0, delivery: Promise.resolve(true) } };
    });
    // The clock jumps past keepsAt with the timers asleep, then the app returns.
    vi.setSystemTime(T0 + FIVE_H + 3 * 3_600_000);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await advance(1);
    expect(keepTrainerSession).not.toHaveBeenCalled();
    expect(backgroundSync).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("waiting").textContent).toBe("1");
    await advance(3 * FIVE_H);
    expect(keepTrainerSession).not.toHaveBeenCalled();
  });

  it("W-G: with the sheet open past keepsAt nothing is kept; closing it asks for the pull that keeps it", async () => {
    backgroundSync.mockImplementation(landedPull);
    waiting();
    await home();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(holdTrainerSession).toHaveBeenLastCalledWith(ID);
    await advance(FIVE_H + 60_000);
    expect(keepTrainerSession).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").textContent).toContain("It's kept the next time the app syncs");
    expect(screen.queryByRole("button", { name: "Later" })).toBeNull();
    expect(backgroundSync).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(holdTrainerSession).toHaveBeenLastCalledWith(null);
    await advance(1);
    expect(backgroundSync).toHaveBeenCalledTimes(2);
    expect(backgroundSync).toHaveBeenLastCalledWith("Sam", expect.objectContaining({ applyTrainer: true }));
    await advance(1);
    expect(screen.getByTestId("waiting").textContent).toBe("0");
    expect(keepTrainerSession).not.toHaveBeenCalled();
  });

  it("never auto-keeps once sharing has stopped", async () => {
    waiting({ keepsAt: null, editsLive: false });
    await home();
    await advance(3 * FIVE_H);
    expect(keepTrainerSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("waiting").textContent).toBe("1");
  });

  it("holds felt edits on the device, and Keep sends them", async () => {
    waiting();
    await home();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Easier, Barbell Back Squat set 3" }));
    expect(TL.get("Sam").sessions[ID]).toEqual({ seenAt: T0, felt: { "0.0.2": 8.5 } });
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("group", { name: "Felt, Barbell Back Squat set 3" }).textContent).toBe("felt 8.5");
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(keepTrainerSession).toHaveBeenCalledWith("Sam", ID, { auto: false, felt: { "0.0.2": 8.5 } });
    expect(screen.queryByRole("dialog")).toBeNull();
    await advance(1);
    expect(screen.getByTestId("waiting").textContent).toBe("0");
  });

  it("a manual Keep on a due session is the only keep sent", async () => {
    waiting();
    await home();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await advance(FIVE_H + 60_000);
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    await advance(1);
    await advance(1);
    expect(keepTrainerSession).toHaveBeenCalledTimes(1);
    expect(keepTrainerSession).toHaveBeenCalledWith("Sam", ID, { auto: false, felt: {} });
    expect(backgroundSync).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("waiting").textContent).toBe("0");
  });

  it("Not mine, then Discard, discards and keeps nothing", async () => {
    waiting();
    await home();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Not mine" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(discardTrainerSession).toHaveBeenCalledWith("Sam", ID);
    expect(screen.queryByRole("dialog")).toBeNull();
    await advance(2 * FIVE_H);
    expect(keepTrainerSession).not.toHaveBeenCalled();
  });
});
