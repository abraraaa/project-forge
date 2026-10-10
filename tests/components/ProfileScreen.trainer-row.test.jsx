// @vitest-environment jsdom
// The "Your trainer" row on Profile says what changed: a session waiting on
// Home first, then new trainer changes (the notices' count of change sets),
// else whether the trainer can change the plan. Changes sent before the client stopped sharing still light it.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/lib/webauthn", () => ({
  hasPasskey: vi.fn(async () => true),
  passkeyStatus: vi.fn(async () => ({ hasPasskey: true, consent: { version: 1 } })),
  registerPasskey: vi.fn(async () => null),
  authenticatePasskey: vi.fn(async () => null),
  isPlatformAuthenticatorAvailable: vi.fn(async () => true),
  isWebAuthnSupported: () => true,
}));
vi.mock("@/lib/storage", async (io) => ({ ...(await io()), checkProfileExists: vi.fn(async () => ({ exists: false })) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));

const { default: ProfileScreen } = await import("@/components/ProfileScreen");

const base = { existing: ["sam"], current: "sam", onActivate: vi.fn(), onCancel: vi.fn(),
  bodyweight: 80, setBwEditOpen: vi.fn(), onEditFocus: vi.fn() };
const live = { ref: "g", name: "Jo", since: 1, live: true, looks: [], lookCount: 0 };
const share = (over = {}) => ({ open: true, trainerOpen: false, trainer: false, sharing: live, ended: null, ...over });
const sub = (title) => screen.getByText(title).closest("a").textContent.replace(title, "");

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

describe("the trainer row says what changed", () => {
  it.each([
    ["new changes", share({ edits: { on: true, since: 1 } }), { trainerChange: 2 }, "Changed your plan · 2 new"],
    ["changes on, nothing new", share({ edits: { on: true, since: 1 } }), {}, "Sees your training · can change your plan"],
    ["changes off", share({ edits: { on: false, since: null } }), {}, "Sees your training · can't change your plan"],
    ["an older reply with no switch", share(), null, "Sees your training"],
    ["a count that isn't one", share({ edits: { on: true, since: 1 } }), { trainerChange: "3" }, "Sees your training · can change your plan"],
    ["paused, nothing new", share({ sharing: { ...live, live: false }, edits: { on: true, since: 1 } }), {}, "Paused"],
    ["paused, a new change", share({ sharing: { ...live, live: false } }), { trainerChange: 1 }, "Changed your plan · 1 new"],
    ["ended, a new change", share({ sharing: null, ended: { name: "Jo", at: Date.parse("2026-10-01T12:00:00Z") } }), { trainerChange: 1 }, "Changed your plan · 1 new"],
    ["a session waiting", share({ edits: { on: true, since: 1 } }), { trainerSession: 1 }, "Logged a session with you · on Home"],
    ["a session waiting beside new changes", share({ edits: { on: true, since: 1 } }), { trainerSession: 1, trainerChange: 2 }, "Logged a session with you · on Home"],
    ["paused, a session waiting", share({ sharing: { ...live, live: false } }), { trainerSession: 2 }, "Logged a session with you · on Home"],
    ["ended, a session still waiting", share({ sharing: null, ended: { name: "Jo", at: Date.parse("2026-10-01T12:00:00Z") } }), { trainerSession: 1 }, "Logged a session with you · on Home"],
    ["a session count that isn't one", share({ edits: { on: true, since: 1 } }), { trainerSession: true }, "Sees your training · can change your plan"],
  ])("%s", async (_, trainerShare, noticeDots, line) => {
    render(<ProfileScreen {...base} trainerShare={trainerShare} noticeDots={noticeDots} />);
    await screen.findByText("Passkey enabled");
    expect(sub("Jo")).toBe(line);
  });

  it("changes off says they can't change the plan, never read only", async () => {
    render(<ProfileScreen {...base} trainerShare={share({ edits: { on: false, since: null } })} noticeDots={{}} />);
    await screen.findByText("Passkey enabled");
    expect(sub("Jo")).not.toMatch(/read only/i);
  });

  it.each([
    ["sharing open to add another", true],
    ["sharing closed", false],
  ])("stopped by the client, with no ended notice: a new change still lights the row (%s)", async (_, open) => {
    render(<ProfileScreen {...base} trainerShare={share({ sharing: null, ended: null, open })} noticeDots={{ trainerChange: 2 }} />);
    await screen.findByText("Passkey enabled");
    expect(sub("Your trainer")).toBe("Changed your plan · 2 new");
    expect(screen.getByText("Your trainer").closest("a").getAttribute("href")).toBe("/profile/trainer");
  });

  it("stopped by the client, a session still waiting: the row says so", async () => {
    render(<ProfileScreen {...base} trainerShare={share({ sharing: null, ended: null, open: false })} noticeDots={{ trainerSession: 1 }} />);
    await screen.findByText("Passkey enabled");
    expect(sub("Your trainer")).toBe("Logged a session with you · on Home");
  });

  it("stopped by the client, nothing new: back to adding a trainer, or no row", async () => {
    render(<ProfileScreen {...base} trainerShare={share({ sharing: null, ended: null })} noticeDots={{}} />);
    await screen.findByText("Passkey enabled");
    expect(sub("Add a trainer")).toBe("Type the code they show you");
    cleanup();
    render(<ProfileScreen {...base} trainerShare={share({ sharing: null, ended: null, open: false })} noticeDots={{}} />);
    await screen.findByText("Passkey enabled");
    expect(screen.queryByText("Your trainer")).toBeNull();
  });
});
