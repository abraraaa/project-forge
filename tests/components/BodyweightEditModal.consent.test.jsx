// @vitest-environment jsdom
// The bodyweight sheet's "secure" step: the consent line sits under its
// passkey button, and the inline registration carries the claim.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/lib/webauthn", () => ({
  hasPasskey: vi.fn(async () => false),
  registerPasskey: vi.fn(async () => null),
  isWebAuthnSupported: () => true,
}));
vi.mock("@/lib/auth-session", () => ({ getAuthTokenWithCeremony: vi.fn(async () => null) }));
vi.mock("@/lib/photos", () => ({ preparePhoto: vi.fn(), uploadPhoto: vi.fn() }));

const { default: BodyweightEditModal } = await import("@/components/BodyweightEditModal");
const { registerPasskey } = await import("@/lib/webauthn");
const { CONSENT_COPY, CONSENT_VERSION } = await import("@/lib/consent");

afterEach(cleanup);

describe("bodyweight sheet — secure step consent", () => {
  it("shows the line only on the secure step, under the button that registers with the claim", async () => {
    render(<BodyweightEditModal open onClose={vi.fn()} currentKg={80} onSave={vi.fn()} profileName="sam" />);
    expect(screen.queryByText(CONSENT_COPY.line)).toBeNull(); // weight step
    fireEvent.click(screen.getByRole("button", { name: /Confirm/ }));
    expect(screen.queryByText(CONSENT_COPY.line)).toBeNull(); // offer step
    fireEvent.click(screen.getByRole("button", { name: /Add a photo/ }));
    await screen.findByText("Lock this down");

    const cta = screen.getByRole("button", { name: /Secure & continue/ });
    const line = screen.getByText(CONSENT_COPY.line);
    expect(!!(cta.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(cta.getAttribute("aria-describedby")).toBe("bw-consent");
    expect(document.getElementById("bw-consent")).toBe(line);
    expect(screen.getByRole("link", { name: /What we keep/ }).getAttribute("href")).toBe("/privacy");

    fireEvent.click(cta);
    await waitFor(() => expect(registerPasskey).toHaveBeenCalledWith("sam", null, { consent: { version: CONSENT_VERSION } }));
  });
});
