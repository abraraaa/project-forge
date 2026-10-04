// @vitest-environment jsdom
// Profile row order: Coaching is the first logged-in section (your AI, your
// trainer, and for trainers their clients); Your trainer
// sits under it, above Training; the breather row stays in the Training
// group, above Account/passkey. Someone who isn't a trainer yet finds
// "For trainers" as the last row of More, after Privacy.
import { describe, it, expect, vi, afterEach } from "vitest";
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
