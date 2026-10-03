// @vitest-environment jsdom
// Profile row order: AI coaching is the first logged-in section, Your trainer
// sits under it, above Training; the breather row stays in the Training
// group, above Account/passkey.
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

describe("Profile: AI coaching placement", () => {
  it("renders AI coaching, then Your trainer, above Training, breather under Training, then Passkey", async () => {
    render(<ProfileScreen {...base} onOpenBreather={vi.fn()} trainerShare={share()} />);
    const passkey = await screen.findByText("Passkey enabled");
    expectOrder([
      screen.getByText("AI coaching"),
      screen.getByText("Talk it through"),
      screen.getByText("Your trainer"),
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
      screen.getByText("AI coaching"),
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
    expect(screen.queryByText("Your trainer")).toBeNull();
    rerender(<ProfileScreen {...base} trainerShare={share({ open: false })} />);
    expect(screen.queryByText("Your trainer")).toBeNull();
    expect(screen.queryByText("Add a trainer")).toBeNull();
  });

  it("the For trainers row shows under Account only when the trainer side is open", async () => {
    const { rerender } = render(<ProfileScreen {...base} trainerShare={share()} />);
    await screen.findByText("Passkey enabled");
    expect(screen.queryByText("For trainers")).toBeNull();
    rerender(<ProfileScreen {...base} trainerShare={share({ trainerOpen: true, trainer: true })} />);
    expect(screen.getByText("See clients who share with you")).toBeTruthy();
    expect(row("For trainers").getAttribute("href")).toBe("/trainer");
    expectOrder([screen.getByText("Account"), screen.getByText("For trainers"), screen.getByText("Device")]);
  });
});
