// @vitest-environment jsdom
// The passkey re-enrolment card and modal: an upgrade that throws shows a
// house line, never the server's or the browser's words, with one special
// case for a browser that can't do passkeys.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("@/lib/webauthn", () => ({ registerPasskey: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({ getAuthTokenWithCeremony: vi.fn(async () => "t") }));
vi.mock("@/lib/passkey-upgrade", () => ({ snoozePrompt: vi.fn() }));

import { PasskeyUpgradeCard, PasskeyUpgradeModal } from "../../components/PasskeyUpgrade.jsx";
import { registerPasskey } from "@/lib/webauthn";
import { getAuthTokenWithCeremony } from "@/lib/auth-session";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const state = { needed: true, daysLeft: 10 };
const surfaces = [
  ["card", () => render(<PasskeyUpgradeCard profile="sam" state={state} onDone={() => {}} />), "Set up"],
  ["modal", () => render(<PasskeyUpgradeModal profile="sam" state={state} onDone={() => {}} onSnooze={() => {}} />), "Set up a new passkey"],
];

describe.each(surfaces)("passkey upgrade %s", (_, mount, cta) => {
  it.each([
    ["a server error from registration", () => registerPasskey.mockRejectedValueOnce(new Error("Registration verify failed SENTINEL"))],
    ["a browser DOMException", () => registerPasskey.mockRejectedValueOnce(new DOMException("The operation either timed out or was not allowed. SENTINEL", "NotAllowedError"))],
    ["a failed sign-in ceremony", () => getAuthTokenWithCeremony.mockRejectedValueOnce(new Error("Authentication failed SENTINEL"))],
  ])("%s says the house line", async (_, arrange) => {
    arrange();
    mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: cta })); });
    expect(screen.getByText("That didn’t work. Try again in a moment.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SENTINEL");
  });

  it("an unsupported browser says so", async () => {
    registerPasskey.mockRejectedValueOnce(new Error("WebAuthn not supported"));
    mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: cta })); });
    expect(screen.getByText("This browser can’t use passkeys.")).toBeTruthy();
  });
});
