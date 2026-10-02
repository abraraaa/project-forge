// @vitest-environment jsdom
// Profile row order: AI coaching is the first logged-in section; the breather
// row stays in the Training group, above Account/passkey.
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

describe("Profile: AI coaching placement", () => {
  it("renders AI coaching above Training, breather under Training, then Passkey", async () => {
    render(<ProfileScreen {...base} onOpenBreather={vi.fn()} />);
    const passkey = await screen.findByText("Passkey enabled");
    expectOrder([
      screen.getByText("AI coaching"),
      screen.getByText("Talk it through"),
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
