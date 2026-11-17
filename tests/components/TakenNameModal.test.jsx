// @vitest-environment jsdom
// The taken-name sheet's passkey sign-in: a sign-in that throws shows a house
// line, never the server's or the browser's words, with one special case for
// a browser that can't do passkeys.
import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("@/lib/webauthn", () => ({
  hasPasskey: vi.fn(async () => true),
  authenticatePasskey: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => ({ cacheAuthToken: vi.fn() }));

import TakenNameModal from "../../components/TakenNameModal.jsx";
import { authenticatePasskey } from "@/lib/webauthn";

afterEach(() => { cleanup(); vi.clearAllMocks(); });
globalThis.fetch = vi.fn(async () => new Response("{}"));

function Harness() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <TakenNameModal name="sam" webAuthnSupported onClose={() => {}} onActivate={() => {}}
      passkeyBusy={busy} setPasskeyBusy={setBusy} passkeyError={error} setPasskeyError={setError} />
  );
}

async function signInThrowing(err) {
  authenticatePasskey.mockRejectedValueOnce(err);
  render(<Harness />);
  const btn = await screen.findByRole("button", { name: "Sign in with passkey" });
  await act(async () => { fireEvent.click(btn); });
}

describe("taken-name passkey sign-in", () => {
  it.each([
    ["a server error", new Error("Authentication verify failed SENTINEL")],
    ["a browser DOMException", new DOMException("The operation either timed out or was not allowed. SENTINEL", "NotAllowedError")],
    ["an error with no message", new Error("")],
  ])("%s says the house line", async (_, err) => {
    await signInThrowing(err);
    expect(screen.getByText("Face ID didn't go through. Try again.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SENTINEL");
    expect(document.body.textContent).not.toContain("Passkey authentication failed");
  });

  it("a cancelled prompt says the house line", async () => {
    authenticatePasskey.mockResolvedValueOnce(null);
    render(<Harness />);
    const btn = await screen.findByRole("button", { name: "Sign in with passkey" });
    await act(async () => { fireEvent.click(btn); });
    expect(screen.getByText("Face ID didn't go through. Try again.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Authentication cancelled");
  });

  it.each([
    ["fails", (d) => d.resolve(null)],
    ["throws", (d) => d.reject(new Error("timeout"))],
  ])("a sign-in that %s after Cancel leaves no error behind", async (_, settle) => {
    const d = {};
    authenticatePasskey.mockReturnValueOnce(new Promise((res, rej) => { d.resolve = res; d.reject = rej; }));
    function Closable() {
      const [open, setOpen] = useState(true);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      return (
        <>
          <output data-testid="state" data-busy={String(busy)}>{error ?? ""}</output>
          {open && (
            <TakenNameModal name="sam" webAuthnSupported onClose={() => { setOpen(false); setError(null); }} onActivate={() => {}}
              passkeyBusy={busy} setPasskeyBusy={setBusy} passkeyError={error} setPasskeyError={setError} />
          )}
        </>
      );
    }
    render(<Closable />);
    const btn = await screen.findByRole("button", { name: "Sign in with passkey" });
    await act(async () => { fireEvent.click(btn); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel" })); });
    await act(async () => { settle(d); });
    const out = screen.getByTestId("state");
    expect(out.textContent).toBe("");
    expect(out.dataset.busy).toBe("false");
  });

  it("an unsupported browser says so", async () => {
    await signInThrowing(new Error("WebAuthn not supported"));
    expect(screen.getByText("This browser can't use passkeys.")).toBeTruthy();
  });
});
