// @vitest-environment jsdom
// Consent on the Profile surfaces: the line under both "add a passkey"
// buttons, and the quiet one-tap for existing holders with none on file.
// The tap is switched off in lib/consent.js; tests that exercise it switch
// the flag on here, and one pins that the real (off) flag hides it.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";

vi.mock("@/lib/webauthn", () => ({
  hasPasskey: vi.fn(async () => false),
  passkeyStatus: vi.fn(async () => ({ hasPasskey: false, consent: null })),
  registerPasskey: vi.fn(async () => ({ ok: true })),
  authenticatePasskey: vi.fn(async () => null),
  isPlatformAuthenticatorAvailable: vi.fn(async () => true),
  isWebAuthnSupported: () => true, // BodyweightEditModal is imported by ProfileScreen
}));
const tapFlag = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/consent", async (io) => {
  const actual = await io();
  return { ...actual, get EXISTING_HOLDER_CONSENT_TAP() { return tapFlag.on; } };
});
vi.mock("@/lib/storage", async (io) => ({ ...(await io()), checkProfileExists: vi.fn(async () => ({ exists: false })) }));
vi.mock("@/lib/auth-session", async (io) => ({ ...(await io()), cacheAuthToken: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }) => <a href={href} {...p}>{children}</a> }));

const { default: ProfileScreen } = await import("@/components/ProfileScreen");
const { passkeyStatus, registerPasskey, authenticatePasskey, isPlatformAuthenticatorAvailable } = await import("@/lib/webauthn");
const { checkProfileExists } = await import("@/lib/storage");
const { cacheAuthToken } = await import("@/lib/auth-session");
const { CONSENT_COPY, CONSENT_VERSION } = await import("@/lib/consent");
const { EXISTING_HOLDER_CONSENT_TAP: REAL_TAP_FLAG } = await vi.importActual("@/lib/consent");

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  tapFlag.on = true;
  passkeyStatus.mockResolvedValue({ hasPasskey: false, consent: null });
  registerPasskey.mockResolvedValue({ ok: true });
  authenticatePasskey.mockResolvedValue(null);
});

const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const profile = () => render(<ProfileScreen existing={["sam"]} current="sam" onActivate={vi.fn()} onCancel={vi.fn()} />);
const passkeyRow = async () => (await screen.findByText("Passkey enabled")).closest('div[style*="border-top"]');
const TAP = /Yes, keep it for me/;

describe("Profile passkey setup card", () => {
  it("shows the line under Set up, and registers with the claim", async () => {
    profile();
    const btn = await screen.findByRole("button", { name: "Set up" });
    const line = screen.getByText(CONSENT_COPY.line);
    expect(follows(btn, line)).toBe(true);
    expect(btn.getAttribute("aria-describedby")).toBe("consent-profile");
    expect(document.getElementById("consent-profile")).toBe(line);
    fireEvent.click(btn);
    await waitFor(() => expect(registerPasskey).toHaveBeenCalledWith("sam", null, { consent: { version: CONSENT_VERSION } }));
    // Registering is the consent: no follow-up tap on the enabled row.
    await screen.findByText("Passkey enabled");
    expect(screen.queryByRole("button", { name: TAP })).toBeNull();
  });
});

describe("quiet consent tap for existing holders", () => {
  it("with the real flag (off), never renders, even with no consent on file", async () => {
    expect(REAL_TAP_FLAG).toBe(false);
    tapFlag.on = REAL_TAP_FLAG;
    passkeyStatus.mockResolvedValue({ hasPasskey: true, consent: null });
    profile();
    await screen.findByText("Passkey enabled");
    await waitFor(() => expect(passkeyStatus).toHaveBeenCalledWith("sam"));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: TAP })).toBeNull();
    expect(screen.queryByText(CONSENT_COPY.line)).toBeNull();
    expect(authenticatePasskey).not.toHaveBeenCalled();
  });

  it("shows only for a passkey holder with no consent on file", async () => {
    passkeyStatus.mockResolvedValue({ hasPasskey: true, consent: null });
    profile();
    const tap = await screen.findByRole("button", { name: TAP });
    expect(screen.getByText(CONSENT_COPY.line)).toBeTruthy();
    expect(document.getElementById(tap.getAttribute("aria-describedby")).textContent).toBe(CONSENT_COPY.line);
  });

  it("runs the sign-in ceremony with the claim, then acknowledges and keeps focus", async () => {
    passkeyStatus.mockResolvedValue({ hasPasskey: true, consent: null });
    authenticatePasskey.mockResolvedValue({ verified: true, authToken: "t", consentRecorded: true });
    profile();
    fireEvent.click(await screen.findByRole("button", { name: TAP }));
    expect(authenticatePasskey).toHaveBeenCalledWith("sam", { consent: { version: CONSENT_VERSION } });
    await waitFor(() => expect(screen.queryByRole("button", { name: TAP })).toBeNull());
    expect(cacheAuthToken).toHaveBeenCalledWith("sam", "t", { admin: false });
    const status = within(await passkeyRow()).getByRole("status");
    expect(status.textContent).toBe(CONSENT_COPY.confirmed);
    expect(document.activeElement).toBe(status);
  });

  for (const [label, outcome] of [["cancel", () => authenticatePasskey.mockResolvedValue(null)], ["failure", () => authenticatePasskey.mockRejectedValue(new Error("x"))]]) {
    it(`stays quiet on ${label}: the tap remains, no error`, async () => {
      passkeyStatus.mockResolvedValue({ hasPasskey: true, consent: null });
      outcome();
      profile();
      fireEvent.click(await screen.findByRole("button", { name: TAP }));
      await waitFor(() => expect(authenticatePasskey).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByRole("button", { name: TAP }).disabled).toBe(false));
      expect(within(await passkeyRow()).queryByText(/cancel|didn.t|failed|error/i)).toBeNull();
      expect(screen.queryByText(/Authentication cancelled or failed|Passkey authentication failed/)).toBeNull();
    });
  }

  it("verified but not recorded: the tap remains, no acknowledgement", async () => {
    passkeyStatus.mockResolvedValue({ hasPasskey: true, consent: null });
    authenticatePasskey.mockResolvedValue({ verified: true, authToken: "t", consentRecorded: false });
    profile();
    fireEvent.click(await screen.findByRole("button", { name: TAP }));
    await waitFor(() => expect(authenticatePasskey).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: TAP }).disabled).toBe(false));
    expect(within(await passkeyRow()).queryByRole("status")).toBeNull();
  });

  it("already consented: no tap, no line", async () => {
    passkeyStatus.mockResolvedValue({ hasPasskey: true, consent: { version: CONSENT_VERSION } });
    profile();
    await screen.findByText("Passkey enabled");
    expect(screen.queryByRole("button", { name: TAP })).toBeNull();
    expect(screen.queryByText(CONSENT_COPY.line)).toBeNull();
  });

  it("unknown status: no tap and no card", async () => {
    passkeyStatus.mockResolvedValue(null);
    profile();
    await waitFor(() => expect(passkeyStatus).toHaveBeenCalled());
    await waitFor(() => expect(isPlatformAuthenticatorAvailable).toHaveBeenCalled());
    expect(screen.queryByText(CONSENT_COPY.line)).toBeNull();
  });
});

describe("onboarding passkey step", () => {
  it("shows the line under Add passkey, and registers with the claim", async () => {
    render(<ProfileScreen existing={[]} current={null} onActivate={vi.fn(async () => ({ ok: true }))} onCancel={vi.fn()} />);
    await waitFor(() => expect(isPlatformAuthenticatorAvailable).toHaveBeenCalled());
    const input = screen.getByLabelText("Your name");
    fireEvent.change(input, { target: { value: "Sam" } });
    await waitFor(() => expect(checkProfileExists).toHaveBeenCalled(), { timeout: 2000 });
    await screen.findByText(/Available · this will be your username/);
    fireEvent.keyDown(input, { key: "Enter" });
    const add = await screen.findByRole("button", { name: /Add passkey/ });
    expect(follows(add, screen.getByText(CONSENT_COPY.line))).toBe(true);
    expect(add.getAttribute("aria-describedby")).toBe("consent-onboarding");
    fireEvent.click(add);
    await waitFor(() => expect(registerPasskey).toHaveBeenCalledWith("Sam", null, { consent: { version: CONSENT_VERSION } }));
  });

  // Both status-check sites: via the existing list, and the current-only fallback.
  it.each([[["Sam"]], [[]]])("a status reply that lands after registering does not bring the tap back (existing=%j)", async (existingAfter) => {
    // The claim makes "Sam" current, so the status check starts before the
    // passkey step and can resolve after it with a pre-registration read.
    let replyStatus;
    passkeyStatus.mockImplementation(() => new Promise((r) => { replyStatus = r; }));
    let activated;
    const onActivate = vi.fn(() => new Promise((r) => { activated = r; }));
    const props = { onActivate, onCancel: vi.fn() };
    const { rerender } = render(<ProfileScreen existing={[]} current={null} {...props} />);
    await waitFor(() => expect(isPlatformAuthenticatorAvailable).toHaveBeenCalled());
    const input = screen.getByLabelText("Your name");
    fireEvent.change(input, { target: { value: "Sam" } });
    await screen.findByText(/Available · this will be your username/, {}, { timeout: 2000 });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onActivate).toHaveBeenCalled());
    rerender(<ProfileScreen existing={existingAfter} current="Sam" {...props} />);
    await waitFor(() => expect(passkeyStatus).toHaveBeenCalledWith("Sam"));
    await act(async () => { activated({ ok: true }); });
    fireEvent.click(await screen.findByRole("button", { name: /Add passkey/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    await screen.findByText("Passkey enabled");
    await act(async () => { replyStatus({ hasPasskey: true, consent: null }); });
    expect(screen.getByText("Passkey enabled")).toBeTruthy();
    expect(screen.queryByRole("button", { name: TAP })).toBeNull();
  });
});
