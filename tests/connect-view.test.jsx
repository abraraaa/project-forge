// @vitest-environment jsdom
// The Face ID button must work whatever filled the name: a post-hydration
// prefill or autofill that never fires an event (2026-09-25: a filled field
// sat under a button still disabled from the server render).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

vi.mock("@/lib/webauthn", () => ({ authenticatePasskey: vi.fn(async () => null) }));
vi.mock("@/lib/net", () => ({ fetchWithTimeout: vi.fn() }));

describe("connect page", () => {
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

describe("connect page: the server's words never show", () => {
  const reply = (status) => ({ status, ok: false, json: async () => ({ error: "Raw server words: SENTINEL" }) });

  it.each([
    [400, "Something went wrong. Try again."],
    [401, "Face ID didn't go through. Try again."],
    [429, "Too many tries. Wait a minute and try again."],
    [500, "Couldn't do that just now. Try again."],
    [503, "Couldn't do that just now. Try again."],
  ])("a %i after Face ID says a house line", async (status, copy) => {
    const { authenticatePasskey } = await import("@/lib/webauthn");
    const { fetchWithTimeout } = await import("@/lib/net");
    const { default: ConnectView } = await import("../components/ConnectView.jsx");
    authenticatePasskey.mockResolvedValueOnce({ authToken: "t" });
    fetchWithTimeout.mockResolvedValueOnce(reply(status));
    render(<ConnectView clientName="Notes" host="example.com" params={{}} />);
    fireEvent.change(screen.getByLabelText("Your Heatwayve name"), { target: { value: "sam" } });
    fireEvent.click(screen.getByText("Let it in"));
    expect(await screen.findByText(copy)).toBeTruthy();
    expect(document.body.textContent).not.toContain("SENTINEL");
  });

  it("Not now says a house line too", async () => {
    const { fetchWithTimeout } = await import("@/lib/net");
    const { default: ConnectView } = await import("../components/ConnectView.jsx");
    fetchWithTimeout.mockResolvedValueOnce(reply(400));
    render(<ConnectView clientName="Notes" host="example.com" params={{}} />);
    fireEvent.click(screen.getByText("Not now"));
    expect(await screen.findByText("Something went wrong. Try again.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SENTINEL");
  });
});

describe("connect page: offline", () => {
  const offline = "Couldn't reach Heatwayve. Try again.";

  it("a network failure after Face ID says offline, not Face ID, and frees the buttons", async () => {
    const { authenticatePasskey } = await import("@/lib/webauthn");
    const { fetchWithTimeout } = await import("@/lib/net");
    const { default: ConnectView } = await import("../components/ConnectView.jsx");
    authenticatePasskey.mockResolvedValueOnce({ authToken: "t" });
    fetchWithTimeout.mockRejectedValueOnce(new Error("The operation was aborted. SENTINEL"));
    render(<ConnectView clientName="Notes" host="example.com" params={{}} />);
    fireEvent.change(screen.getByLabelText("Your Heatwayve name"), { target: { value: "sam" } });
    fireEvent.click(screen.getByText("Let it in"));
    expect(await screen.findByText(offline)).toBeTruthy();
    expect(screen.getByText("Let it in")).toBeTruthy();
    expect(screen.getByText("Not now").disabled).toBe(false);
    expect(document.body.textContent).not.toContain("SENTINEL");
  });

  it("a network failure on Not now says offline and frees the buttons", async () => {
    const { fetchWithTimeout } = await import("@/lib/net");
    const { default: ConnectView } = await import("../components/ConnectView.jsx");
    fetchWithTimeout.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<ConnectView clientName="Notes" host="example.com" params={{}} />);
    fireEvent.click(screen.getByText("Not now"));
    expect(await screen.findByText(offline)).toBeTruthy();
    expect(screen.getByText("Let it in")).toBeTruthy();
    expect(screen.getByText("Not now").disabled).toBe(false);
  });
});

describe("connect page: legible field and status", () => {
  it("the name field is outlined in ink-3 and the status line reads in ink-2", async () => {
    const { default: ConnectView } = await import("../components/ConnectView.jsx");
    render(<ConnectView clientName="Notes" host="example.com" params={{}} />);
    expect(screen.getByLabelText("Your Heatwayve name").style.border).toBe("1px solid var(--ink-3)");
    expect(screen.getByRole("status").style.color).toBe("var(--ink-2)");
  });
});
