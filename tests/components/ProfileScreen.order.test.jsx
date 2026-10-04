// @vitest-environment jsdom
// Profile row order: Coaching is the first logged-in section (your AI, your
// trainer, and for trainers their clients); Your trainer
// sits under it, above Training; the breather row stays in the Training
// group, above Account/passkey. Someone who isn't a trainer yet finds
// "For trainers" as the last row of More, after Privacy; its subline says
// where an application stands, and opening it after a decision marks the
// decision seen.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

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

const { default: ProfileScreen } = await import("@/components/ProfileScreen");

afterEach(cleanup);

const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const expectOrder = (els) => {
  for (let i = 1; i < els.length; i++) {
    expect(before(els[i - 1], els[i]), `${els[i - 1].textContent} before ${els[i].textContent}`).toBe(true);
  }
};
const base = { existing: ["sam"], current: "sam", onActivate: vi.fn(), onCancel: vi.fn(),
  bodyweight: 80, setBwEditOpen: vi.fn(), onEditFocus: vi.fn() };

// GET /api/sync/trainer, as ProfileView passes it on.
const share = (over = {}) => ({ open: true, trainerOpen: false, trainer: false, sharing: null, ended: null, ...over });

describe("Profile: Coaching placement", () => {
  it("renders Coaching, then the trainer row, above Training, breather under Training, then Passkey", async () => {
    render(<ProfileScreen {...base} onOpenBreather={vi.fn()} trainerShare={share()} />);
    const passkey = await screen.findByText("Passkey enabled");
    expectOrder([
      screen.getByText("Coaching"),
      screen.getByText("Talk it through"),
      screen.getByText("Add a trainer"),
      screen.getByText("Training"),
      screen.getByText("Training focus"),
      screen.getByText("Main lifts"),
      screen.getByText("Bodyweight"),
      screen.getByText("Need a breather?"),
      screen.getByText("Account"),
      passkey,
    ]);
    // The coach link is the section's row and still points at /profile/coach.
    expect(screen.getByText("Talk it through").closest("a").getAttribute("href")).toBe("/profile/coach");
  });

  it("keeps the resting 'On a breather' row in the Training group", async () => {
    render(<ProfileScreen {...base} resting onEndBreather={vi.fn()} />);
    const passkey = await screen.findByText("Passkey enabled");
    expectOrder([
      screen.getByText("Coaching"),
      screen.getByText("Training"),
      screen.getByText("Bodyweight"),
      screen.getByText("On a breather"),
      screen.getByText("Account"),
      passkey,
    ]);
  });
});

describe("Profile: Your trainer row", () => {
  const row = (title) => screen.getByText(title).closest("a");

  it.each([
    ["sharing, live", share({ sharing: { ref: "g", name: "Jo", since: 1, live: true, looks: [], lookCount: 0 } }), "Jo", "Sees your training · read only"],
    ["sharing, paused", share({ sharing: { ref: "g", name: "Jo", since: 1, live: false, looks: [], lookCount: 0 } }), "Jo", "Paused"],
    ["ended by the trainer", share({ ended: { name: "Max", at: Date.parse("2026-09-20T12:00:00Z"), by: "trainer" } }), "Max", /^Ended 20 Sept?$/],
    ["none, open", share(), "Add a trainer", "Type the code they show you"],
  ])("%s", async (_, trainerShare, title, sub) => {
    render(<ProfileScreen {...base} trainerShare={trainerShare} />);
    await screen.findByText("Passkey enabled");
    expect(row(title).getAttribute("href")).toBe("/profile/trainer");
    expect(row(title).textContent.replace(title, "")).toMatch(sub instanceof RegExp ? sub : new RegExp(`^${sub}$`));
  });

  it("shows nothing when signed out or offline, or when sharing isn't open and there is no trainer", async () => {
    const { rerender } = render(<ProfileScreen {...base} trainerShare={null} />);
    await screen.findByText("Passkey enabled");
    expect(screen.queryByText("Add a trainer")).toBeNull();
    rerender(<ProfileScreen {...base} trainerShare={share({ open: false })} />);
    expect(screen.queryByText("Add a trainer")).toBeNull();
    expect(screen.queryByText("Add a trainer")).toBeNull();
  });

  it("a trainer gets Your clients under Coaching, and no For trainers row", async () => {
    const { rerender } = render(<ProfileScreen {...base} trainerShare={share({ trainer: true })} />);
    await screen.findByText("Passkey enabled");
    expect(screen.queryByText("Your clients")).toBeNull();
    rerender(<ProfileScreen {...base} trainerShare={share({ trainerOpen: true, trainer: true })} />);
    expect(row("Your clients").getAttribute("href")).toBe("/trainer");
    expect(row("Your clients").textContent.replace("Your clients", "")).toBe("See clients who share with you");
    expect(screen.queryByText("For trainers")).toBeNull();
    expect(screen.queryByText("Set up as a trainer")).toBeNull();
    expectOrder([screen.getByText("Coaching"), screen.getByText("Your clients"), screen.getByText("Training"), screen.getByText("Account")]);
  });

  it("everyone else gets For trainers as the last row of More, after Privacy, only when the trainer side is open", async () => {
    const { rerender } = render(<ProfileScreen {...base} trainerShare={share()} />);
    await screen.findByText("Passkey enabled");
    expect(screen.queryByText("For trainers")).toBeNull();
    rerender(<ProfileScreen {...base} trainerShare={share({ trainerOpen: true })} />);
    const forTrainers = row("For trainers");
    expect(forTrainers.getAttribute("href")).toBe("/trainer");
    expect(forTrainers.textContent.replace("For trainers", "")).toBe("Set up as a trainer");
    expect(screen.queryByText("Your clients")).toBeNull();
    const privacy = row("Privacy");
    expectOrder([screen.getByText("Coaching"), screen.getByText("Training"), screen.getByText("Account"),
      screen.getByText("More"), privacy, forTrainers]);
    // Nothing between Privacy and it: it is the next row, and the last link of More.
    expect(privacy.parentElement.nextElementSibling?.contains(forTrainers)).toBe(true);
    const links = [...document.querySelectorAll("a[href]")].filter((a) => before(screen.getByText("More"), a));
    expect(links.filter((a) => a.getAttribute("href").startsWith("/")).at(-1)).toBe(forTrainers);
  });
});

describe("Profile: For trainers, by application state", () => {
  const row = (title) => screen.getByText(title).closest("a");
  const sub = () => row("For trainers").textContent.replace("For trainers", "");
  const open = (over) => share({ trainerOpen: true, ...over });
  // A denial's wait: still running, and run out.
  const waiting = Date.now() + 5 * 864e5;
  const waited = Date.now() - 864e5;

  it.each([
    ["none", undefined, "Set up as a trainer"],
    ["withdrawn", { status: "withdrawn", at: 1, decidedAt: 2, nextAt: null, seen: false }, "Set up as a trainer"],
    ["applied", { status: "applied", at: 1, decidedAt: null, nextAt: null, seen: false }, "Application sent"],
    ["denied", { status: "denied", at: 1, decidedAt: 2, nextAt: waiting, seen: false }, "Not this time"],
    ["denied, its 30 days over", { status: "denied", at: 1, decidedAt: 2, nextAt: waited, seen: true }, "Set up as a trainer"],
    ["denied, no date left", { status: "denied", at: 1, decidedAt: 2, nextAt: null, seen: true }, "Set up as a trainer"],
  ])("%s", async (_, application, line) => {
    render(<ProfileScreen {...base} trainerShare={open({ application: application ?? null })} />);
    await screen.findByText("Passkey enabled");
    expect(sub()).toBe(line);
    expect(row("For trainers").getAttribute("href")).toBe("/trainer");
  });

  it("approved: the role moves the row to Your clients under Coaching", async () => {
    render(<ProfileScreen {...base} trainerShare={open({ trainer: true, trainerRole: true,
      application: { status: "approved", at: 1, decidedAt: 2, nextAt: null, seen: false } })} />);
    await screen.findByText("Passkey enabled");
    expect(screen.queryByText("For trainers")).toBeNull();
    expect(row("Your clients").getAttribute("href")).toBe("/trainer");
  });

  const seenPosts = (spy) => spy.mock.calls.filter(([url, o]) => url === "/api/sync/trainer" && o?.method === "POST");

  it("opening it after a decision marks the decision seen, once per tap, for the caller's own profile", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      render(<ProfileScreen {...base} trainerShare={open({ application: { status: "denied", at: 1, decidedAt: 2, nextAt: waiting, seen: false } })} />);
      await screen.findByText("Passkey enabled");
      fireEvent.click(row("For trainers"));
      const calls = seenPosts(spy);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0][1].body)).toEqual({ profile: "sam", seenApplication: true });
    } finally { spy.mockRestore(); }
  });

  it("approved and unseen: opening Your clients marks it seen", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      render(<ProfileScreen {...base} trainerShare={open({ trainer: true, application: { status: "approved", at: 1, decidedAt: 2, nextAt: null, seen: false } })} />);
      await screen.findByText("Passkey enabled");
      fireEvent.click(row("Your clients"));
      expect(seenPosts(spy)).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  it.each([
    ["no application", null],
    ["applied", { status: "applied", at: 1, decidedAt: null, nextAt: null, seen: false }],
    ["a decision already seen", { status: "denied", at: 1, decidedAt: 2, nextAt: waiting, seen: true }],
  ])("%s: opening it writes nothing", async (_, application) => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      render(<ProfileScreen {...base} trainerShare={open({ application })} />);
      await screen.findByText("Passkey enabled");
      fireEvent.click(row("For trainers"));
      expect(seenPosts(spy)).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
});
