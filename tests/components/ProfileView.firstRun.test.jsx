// @vitest-environment jsdom
// A claim on the /profile route: the shell that holds first run is not
// mounted there, so a successful claim stashes the one-shot marker for the
// claimed name and goes home (ForgeApp takes it: FirstRun.flow.test.jsx).
// Anything short of a successful claim leaves no marker.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
// The network edges only; every store is the real one over jsdom storage.
vi.mock("@/lib/storage", async (io) => ({
  ...(await io()),
  claimProfile: vi.fn(async () => ({ ok: true })),
  pushNow: vi.fn(async () => ({ ok: true })),
}));
// One button per way in. ProfileScreen's own name flow has its tests.
vi.mock("@/components/ProfileScreen", () => ({
  default: ({ onActivate }) => (
    <div>
      <button onClick={() => onActivate("Ali", { claim: true })}>Claim Ali</button>
      <button onClick={() => onActivate("Ali")}>Switch to Ali</button>
    </div>
  ),
}));

const { default: ProfileView } = await import("@/components/ProfileView");
const { P, claimProfile } = await import("@/lib/storage");

const MARKER = "forge:pendingFirstRun";
const press = (name) => act(async () => { fireEvent.click(screen.getByRole("button", { name })); });

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 404 }));
  P.add("Sam");
  P.setActive("Sam");
});
afterEach(cleanup);

describe("/profile activation and first run", () => {
  it("a successful claim stashes the marker for the claimed name and goes home", async () => {
    render(<ProfileView />);
    await press("Claim Ali");
    expect(claimProfile).toHaveBeenCalledWith("Ali", "Ali");
    expect(JSON.parse(localStorage.getItem(MARKER))).toBe("Ali");
    expect(P.getActive()).toBe("Ali");
    expect(nav.push).toHaveBeenCalledWith("/");
  });

  it("switching to a name already on the device leaves no marker", async () => {
    P.add("Ali");
    render(<ProfileView />);
    await press("Switch to Ali");
    expect(localStorage.getItem(MARKER)).toBeNull();
    expect(nav.push).toHaveBeenCalledWith("/");
  });

  it.each([
    ["taken", { ok: false, taken: true }],
    ["network", { ok: false }],
  ])("a failed claim (%s) leaves no marker and stays put", async (_, answer) => {
    claimProfile.mockResolvedValueOnce(answer);
    render(<ProfileView />);
    await press("Claim Ali");
    expect(localStorage.getItem(MARKER)).toBeNull();
    expect(P.getActive()).toBe("Sam");
    expect(nav.push).not.toHaveBeenCalled();
  });
});
