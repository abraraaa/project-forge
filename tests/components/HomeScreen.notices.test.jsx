// @vitest-environment jsdom
// The notice dot: home asks GET /api/sync/notices on mount and when the app
// comes back to the foreground (at most once a minute, memory only), and
// lights a still ink dot on the "Profile" kicker when anything is new.
// Anything but a 200 with dots reads as nothing new.
import { StrictMode } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within, act, waitFor } from "@testing-library/react";
import HomeScreen from "../../components/HomeScreen.jsx";
import { T } from "../../lib/tokens.js";
import { WEEK } from "../../lib/programme.js";
import { makeDayContext, resolveRange, sessionsFrom } from "../../lib/day-state.js";

const START = new Date(2026, 8, 25, 9, 0);
let visibility = "visible";
let fetchMock;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.visibilityState;
});

const wk = (...types) => types.map((type) => ({ ...WEEK.find((d) => d.type === type), type }));
const MWF = wk("strength", "rest", "strength", "rest", "strength", "cardio", "rest");
function weekProps() {
  const ctx = makeDayContext({ todayIso: "2026-09-25", weekFor: () => MWF });
  const week = resolveRange(ctx, "2026-09-21", "2026-09-27");
  return {
    rhythm: { completed: 0, expected: 0, ratio: 0 },
    profileName: "sam",
    userWeek: week.map((d) => d.shown),
    strengthDaySessions: sessionsFrom(week),
    dayStates: week.map((d) => ({ status: d.status, coveredBy: d.coveredBy })),
  };
}
const home = (props = {}) => <HomeScreen {...weekProps()} {...props} />;

const reply = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const kicker = () => within(screen.getByRole("button", { name: /^Profile,/ })).getByText("Profile");
const noticeDot = () => kicker().querySelector('span[aria-hidden="true"]');
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const foreground = async (state = "visible") => {
  visibility = state;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await flush();
};

describe("home — the notice dot", () => {
  it("asks for the active profile's notices on mount and lights the kicker", async () => {
    fetchMock.mockReturnValue(reply(200, { dots: { bugs: 2 }, admin: true }));
    render(home({ profileName: "sam & co" }));
    await screen.findByRole("button", { name: "Profile, sam & co, something new" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/sync/notices?profile=sam%20%26%20co");
    expect(fetchMock.mock.calls[0][1]?.method ?? "GET").toBe("GET");
  });

  it("the dot is a still 6px ink dot after the word, hidden from assistive tech", async () => {
    fetchMock.mockReturnValue(reply(200, { dots: { clients: true } }));
    render(home());
    await screen.findByRole("button", { name: "Profile, sam, something new" });
    const dot = noticeDot();
    expect(dot).not.toBeNull();
    expect(dot.style.width).toBe("6px");
    expect(dot.style.height).toBe("6px");
    expect(dot.style.borderRadius).toBe("50%");
    expect(dot.style.background).toBe(T.ink);
    expect(dot.style.animation).toBe("");
    expect(dot.style.position).toBe("absolute");
    expect(dot.style.left).toBe("calc(100% + 5px)");
    expect(kicker().firstChild.nodeValue).toBe("Profile");
    expect(kicker().lastElementChild).toBe(dot);
  });

  it("never sits on the name line, and the sync dot stays where it is", async () => {
    fetchMock.mockReturnValue(reply(200, { dots: { application: "approved" } }));
    render(home({ syncState: "error" }));
    const btn = await screen.findByRole("button", { name: "Profile, sam, something new" });
    const nameLine = within(btn).getByText("sam").parentElement;
    const round = nameLine.querySelectorAll('span[style*="border-radius: 50%"]');
    expect(round).toHaveLength(1);
    expect(round[0].style.background).toBe(T.heat[3]);
    expect(kicker().querySelectorAll('span[style*="border-radius: 50%"]')).toHaveLength(1);
  });

  it.each([
    ["no keys", () => reply(200, { dots: {} })],
    ["no dots field", () => reply(200, {})],
    ["signed out (401)", () => reply(401, { error: "unauthorised" })],
    ["rate limited (429)", () => reply(429, {})],
    ["server error", () => reply(500, { dots: { bugs: 1 } })],
    ["a 204", () => Promise.resolve(new Response(null, { status: 204 }))],
    ["a bad body", () => Promise.resolve(new Response("not json", { status: 200 }))],
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("stays unlit on %s", async (_label, answer) => {
    fetchMock.mockImplementation(answer);
    render(home());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flush();
    expect(screen.getByRole("button", { name: "Profile, sam" })).toBeTruthy();
    expect(noticeDot()).toBeNull();
  });

  it("offline: no request, no dot", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    render(home());
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(noticeDot()).toBeNull();
  });

  it("no active profile: no request", async () => {
    render(home({ profileName: null }));
    await flush();
    render(home({ profileName: "" }));
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks again on return to the foreground, at most once a minute", async () => {
    fetchMock.mockReturnValueOnce(reply(200, { dots: { bugs: 1 } }));
    render(home());
    await screen.findByRole("button", { name: "Profile, sam, something new" });

    vi.setSystemTime(new Date(START.getTime() + 30_000));
    await foreground();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Going to the background never asks.
    vi.setSystemTime(new Date(START.getTime() + 61_000));
    await foreground("hidden");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReturnValueOnce(reply(200, { dots: {} }));
    await foreground();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Profile, sam" })).toBeTruthy();
    expect(noticeDot()).toBeNull();
  });

  it("a failed check after a lit one clears the dot", async () => {
    fetchMock.mockReturnValueOnce(reply(200, { dots: { applications: 1 } }));
    render(home());
    await screen.findByRole("button", { name: "Profile, sam, something new" });
    fetchMock.mockReturnValueOnce(reply(401, {}));
    vi.setSystemTime(new Date(START.getTime() + 60_000));
    await foreground();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(noticeDot()).toBeNull();
  });

  it("a profile switch asks for the new profile and never shows the old one's dot", async () => {
    fetchMock.mockReturnValueOnce(reply(200, { dots: { bugs: 3 } }));
    const { rerender } = render(home());
    await screen.findByRole("button", { name: "Profile, sam, something new" });
    let resolveNext;
    fetchMock.mockReturnValueOnce(new Promise((r) => { resolveNext = r; }));
    rerender(home({ profileName: "alex" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/sync/notices?profile=alex");
    expect(screen.getByRole("button", { name: "Profile, alex" })).toBeTruthy();
    expect(noticeDot()).toBeNull();
    await act(async () => { resolveNext(await reply(200, { dots: { clients: true } })); });
    await screen.findByRole("button", { name: "Profile, alex, something new" });
  });

  it("lands under StrictMode's double effect run (the dev server's mode)", async () => {
    fetchMock.mockReturnValue(reply(200, { dots: { bugs: 1 } }));
    render(<StrictMode>{home()}</StrictMode>);
    await screen.findByRole("button", { name: "Profile, sam, something new" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a slow older answer never overwrites a newer one", async () => {
    let resolveOld;
    fetchMock.mockReturnValueOnce(new Promise((r) => { resolveOld = r; }));
    render(home());
    await flush();
    fetchMock.mockReturnValueOnce(reply(200, { dots: {} }));
    vi.setSystemTime(new Date(START.getTime() + 60_000));
    await foreground();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { resolveOld(await reply(200, { dots: { bugs: 4 } })); });
    await flush();
    expect(screen.getByRole("button", { name: "Profile, sam" })).toBeTruthy();
    expect(noticeDot()).toBeNull();
  });

  it("keeps it in memory only, and stops listening when home unmounts", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    fetchMock.mockReturnValue(reply(200, { dots: { bugs: 1 } }));
    const { unmount } = render(home());
    await screen.findByRole("button", { name: "Profile, sam, something new" });
    expect(setItem).not.toHaveBeenCalled();
    unmount();
    vi.setSystemTime(new Date(START.getTime() + 120_000));
    await foreground();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
