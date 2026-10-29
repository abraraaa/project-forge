// @vitest-environment jsdom
// Home's accessory reset through ForgeApp: a reset that has to re-plan
// (Strong with Romanian Deadlift) shows what it swapped in the rotation
// summary, with a reset's own copy, and closes on home; a reset that stands
// as the template shows none. The network edges are mocked; every store is
// the real one over jsdom storage.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }) }));
vi.mock("@vercel/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/webauthn", () => ({
  isPlatformAuthenticatorAvailable: vi.fn(async () => false),
  isWebAuthnSupported: () => false,
  registerPasskey: vi.fn(async () => ({ ok: false })),
  hasPasskey: vi.fn(async () => true),
  passkeyStatus: vi.fn(async () => null),
  authenticatePasskey: vi.fn(async () => null),
}));
vi.mock("@/lib/storage", async (io) => ({
  ...(await io()),
  backgroundSync: vi.fn(async () => {}),
  enableAutoSync: vi.fn(),
  disableAutoSync: vi.fn(),
  pushNow: vi.fn(async () => ({ ok: true })),
  flushPendingPushes: vi.fn(async () => {}),
  ensurePersistentStorage: vi.fn(async () => {}),
}));
// Home as its contract: the link's confirmed tap.
vi.mock("@/components/HomeScreen", () => ({
  default: ({ profileName, onResetProgramme }) => (
    <div>
      <span>Home of {profileName}</span>
      <button onClick={onResetProgramme}>Reset accessories</button>
    </div>
  ),
}));

const { default: ForgeApp } = await import("@/components/ForgeApp");
const { P, PB, F } = await import("@/lib/storage");
const { solveRotation } = await import("@/lib/rotation-solver");
const { saveMainLiftCore, stashRotationSummary } = await import("@/lib/profile-actions");
const { todayLocalIso } = await import("@/lib/dates");

const HINGE = "Hex Bar Deadlift";
const RDL = "Romanian Deadlift";
const mulberry = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

afterEach(cleanup);
beforeEach(() => {
  push.mockClear();
  localStorage.clear();
  localStorage.setItem("forge:onboarded", "true");
  P.add("Sam");
  P.setActive("Sam");
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 404 }));
});

/** A rotated block 4, started today, under this focus and these main lifts. */
const rotatedBlock = (focus, mainLifts) => PB.save({
  number: 4, startDate: todayLocalIso(), history: {},
  config: solveRotation({ history: {}, focus, mainLifts, rng: mulberry(7) }).config,
}, { profile: "Sam" });

async function resetFromHome() {
  render(<ForgeApp />);
  await screen.findByText("Home of Sam");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reset accessories" })); });
}

describe("the accessory reset on home", () => {
  it("a reset that re-plans shows what it swapped, as a reset, and closes on home", async () => {
    F.save("Sam", "Strong");
    P.setMainLift("Sam", HINGE, RDL);
    rotatedBlock("Strong", { [HINGE]: RDL });
    await resetFromHome();
    expect(screen.getByText("Reset and rebalanced")).toBeTruthy();
    expect(screen.getByText(/swapped from the defaults so every muscle stays in its range with your main lifts/)).toBeTruthy();
    expect(screen.queryByText("Rebalanced for your lift")).toBeNull();
    expect(Object.keys(PB.get("Sam").config).length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Home of Sam")).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it("a reset that stands as the template shows nothing", async () => {
    F.save("Sam", "Forged");
    rotatedBlock("Forged", {});
    await resetFromHome();
    expect(PB.get("Sam").config).toEqual({});
    expect(screen.queryByText("Reset and rebalanced")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a main-lift change's re-plan still continues to the session", async () => {
    F.save("Sam", "Strong");
    PB.save({ number: 4, startDate: todayLocalIso(), config: {}, history: {} }, { profile: "Sam" });
    stashRotationSummary("Sam", saveMainLiftCore("Sam", HINGE, RDL).summary);
    render(<ForgeApp />);
    expect(await screen.findByText("Rebalanced for your lift")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue to readiness" })); });
    expect(push).toHaveBeenCalledWith("/session");
  });
});
