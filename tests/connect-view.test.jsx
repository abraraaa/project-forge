// @vitest-environment jsdom
// The Face ID button must work whatever filled the name: a post-hydration
// prefill or autofill that never fires an event (2026-09-25: a filled field
// sat under a button still disabled from the server render).
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("@/lib/webauthn", () => ({ authenticatePasskey: vi.fn(async () => null) }));
vi.mock("@/lib/net", () => ({ fetchWithTimeout: vi.fn() }));

describe("connect page", () => {
  it("never disables the button over an empty-looking name", () => {
    const src = readFileSync(resolve(__dirname, "../components/ConnectView.jsx"), "utf8");
    expect(src).not.toMatch(/disabled=\{!name/);
    expect(src).toContain("inputRef.current?.value");
  });

  it("reads an autofilled value straight from the field", async () => {
    const { authenticatePasskey } = await import("@/lib/webauthn");
    const { default: ConnectView } = await import("../components/ConnectView.jsx");
    render(<ConnectView clientName="Claude" host="claude.ai" params={{}} />);
    const input = screen.getByLabelText("Your Heatwayve name");
    // Autofill: the DOM value changes, React's onChange never fires.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Abrar");
    fireEvent.click(screen.getByText("Let it in"));
    await Promise.resolve();
    expect(authenticatePasskey).toHaveBeenCalledWith("Abrar");
  });

  it("an empty field asks for the name instead of doing nothing", async () => {
    const { default: ConnectView } = await import("../components/ConnectView.jsx");
    render(<ConnectView clientName="Claude" host="claude.ai" params={{}} />);
    fireEvent.click(screen.getAllByText("Let it in").at(-1));
    expect(await screen.findByText("Type your Heatwayve name first.")).toBeTruthy();
  });
});
