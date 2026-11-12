// @vitest-environment jsdom
// Home's passkey nudge through ForgeApp: a registration that throws shows a
// house line, never the server's or the browser's words, with one special
// case for a browser that can't do passkeys. Also the first-run intro's copy.
// The network edges are mocked; every store is the real one over jsdom storage.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));
vi.mock("@vercel/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/webauthn", () => ({
  isPlatformAuthenticatorAvailable: vi.fn(async () => true),
  isWebAuthnSupported: () => true,
  registerPasskey: vi.fn(async () => ({ ok: false })),
  hasPasskey: vi.fn(async () => false),
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
// Home as its contract: the nudge's button and its error line.
vi.mock("@/components/HomeScreen", () => ({
  default: ({ profileName, pnError, onPnRegister }) => (
    <div>
      <span>Home of {profileName}</span>
      <button onClick={onPnRegister}>Set up passkey</button>
      {pnError && <p data-testid="pn-error">{pnError}</p>}
    </div>
  ),
}));

const { default: ForgeApp } = await import("@/components/ForgeApp");
const { P } = await import("@/lib/storage");
const { registerPasskey } = await import("@/lib/webauthn");

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => {
  localStorage.clear();
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 404 }));
});

async function registerFromHome() {
  localStorage.setItem("forge:onboarded", "true");
  P.add("Sam");
  P.setActive("Sam");
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<ForgeApp />);
  await screen.findByText("Home of Sam");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Set up passkey" })); });
  return screen.getByTestId("pn-error").textContent;
}

describe("the home passkey nudge", () => {
  it.each([
    ["a server error", new Error("Registration verify failed SENTINEL")],
    ["a browser DOMException", new DOMException("The operation either timed out or was not allowed. SENTINEL", "NotAllowedError")],
    ["an error with no message", new Error("")],
  ])("%s says the house line", async (_, err) => {
    registerPasskey.mockRejectedValueOnce(err);
    expect(await registerFromHome()).toBe("The passkey didn't take. Another go in a bit.");
    expect(document.body.textContent).not.toContain("SENTINEL");
    expect(console.error).toHaveBeenCalled();
  });

  it("an unsupported browser says so", async () => {
    registerPasskey.mockRejectedValueOnce(new Error("WebAuthn not supported"));
    expect(await registerFromHome()).toBe("This browser can't use passkeys.");
  });
});

describe("the first-run intro", () => {
  it("sets its apostrophes typographically", async () => {
    render(<ForgeApp />);
    expect(await screen.findByText(/more when it was easy, less when it wasn’t\./)).toBeTruthy();
  });
});
