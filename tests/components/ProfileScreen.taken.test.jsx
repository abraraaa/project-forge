// @vitest-environment jsdom
// The taken-name sheet shares Profile's passkey error line. Closing the sheet
// clears it, so a failed sign-in there never shows on the setup card or in
// the Verify dialog afterwards.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";

vi.mock("@/lib/webauthn", () => ({
  passkeyStatus: vi.fn(async () => ({ hasPasskey: false, consent: { version: 1 } })),
  hasPasskey: vi.fn(async () => true),
  registerPasskey: vi.fn(async () => null),
  authenticatePasskey: vi.fn(async () => null),
  isPlatformAuthenticatorAvailable: vi.fn(async () => true),
}));
vi.mock("@/lib/auth-session", async (io) => ({ ...(await io()), cacheAuthToken: vi.fn() }));
vi.mock("@/lib/storage", async (io) => ({
  ...(await io()),
  checkProfileExists: vi.fn(async () => ({ exists: true })),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }) => <a href={href} {...p}>{children}</a> }));

const { default: ProfileScreen } = await import("@/components/ProfileScreen");

const LINE = "Face ID didn't go through. Try again.";
const props = () => ({ existing: ["sam", "alex"], current: "sam", onActivate: vi.fn(async () => ({ ok: true })),
  onCancel: vi.fn(), bodyweight: 80, setBwEditOpen: vi.fn(), onEditFocus: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = vi.fn(async () => new Response("{}"));
});
afterEach(() => cleanup());

async function failInTakenSheet() {
  render(<ProfileScreen {...props()} />);
  await screen.findByText("Add a passkey");
  fireEvent.click(screen.getByRole("button", { name: /^Not you\?/ }));
  fireEvent.click(screen.getByRole("button", { name: "Sign in as someone else" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), { target: { value: "Kim" } });
  fireEvent.click(await screen.findByRole("button", { name: /That's me/ }, { timeout: 2000 }));
  const btn = await screen.findByRole("button", { name: "Sign in with passkey" });
  await act(async () => { fireEvent.click(btn); });
  await waitFor(() => expect(screen.getAllByText(LINE).length).toBeGreaterThan(0));
}

describe("taken-name sheet: its error leaves with it", () => {
  it("Cancel clears the line, so the setup card shows none", async () => {
    await failInTakenSheet();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Sign in with passkey" })).toBeNull();
    expect(screen.getByText("Add a passkey")).toBeTruthy();
    expect(screen.queryByText(LINE)).toBeNull();
  });

  it("Escape clears it too", async () => {
    await failInTakenSheet();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Sign in with passkey" })).toBeNull();
    expect(screen.queryByText(LINE)).toBeNull();
  });
});
