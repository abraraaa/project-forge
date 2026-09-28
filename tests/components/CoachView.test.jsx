// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// CoachView (/profile/coach) — at the surface.
//
// Locks in:
//   - "Copy your training" goes through the shared copy path
//     (lib/coach-share's copyCoachContext, the one the Lab uses too) for the
//     active profile, and says what happened either way.
//   - Disconnect POSTs the connection id, then shows the reloaded list.
//   - A copy-link AI (ChatGPT) puts the MCP URL on the clipboard.
//   - No active profile sends you home.
//
// next/navigation, the copy path and the network are mocked; storage is real
// (tests/setup.js clears it between tests).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

const { router, server } = vi.hoisted(() => ({
  router: { replace: () => {}, back: () => {}, push: () => {} },
  server: { connections: [] },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/coach-share", () => ({ copyCoachContext: vi.fn(async () => "ok") }));
// A tiny connections endpoint: GET lists, POST {disconnect} removes.
vi.mock("@/lib/net", () => ({
  fetchWithTimeout: vi.fn(async (url, opts) => {
    if (opts?.method === "POST") {
      const { disconnect } = JSON.parse(opts.body);
      server.connections = server.connections.filter((c) => c.id !== disconnect);
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ connections: server.connections }) };
  }),
}));

import CoachView from "../../components/CoachView.jsx";
import { P } from "@/lib/storage";
import { copyCoachContext } from "@/lib/coach-share";
import { fetchWithTimeout } from "@/lib/net";
import { MCP_URL } from "@/lib/coach-connect";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  server.connections = [];
});

// Render and let the connections fetch land, so its state update happens
// inside act.
async function renderCoach() {
  render(<CoachView />);
  await screen.findByText(server.connections.length ? "Connected" : "Nothing connected yet.");
}

describe("CoachView", () => {
  it("copies through the shared coach path for the active profile", async () => {
    P.setActive("sam");
    await renderCoach();
    await act(async () => { fireEvent.click(screen.getByText("Copy your training")); });
    expect(copyCoachContext).toHaveBeenCalledTimes(1);
    expect(copyCoachContext).toHaveBeenCalledWith("sam");
    expect(screen.getByText("Paste it into any chat.")).toBeTruthy();
    expect(screen.getByText("Copied")).toBeTruthy();
  });

  it("a failed copy says so and leaves the button to try again", async () => {
    P.setActive("sam");
    copyCoachContext.mockResolvedValueOnce("fail");
    await renderCoach();
    await act(async () => { fireEvent.click(screen.getByText("Copy your training")); });
    expect(screen.getByText("Couldn't reach the clipboard — try again.")).toBeTruthy();
    expect(screen.getByText("Copy your training")).toBeTruthy();
    expect(screen.queryByText("Paste it into any chat.")).toBeNull();
  });

  it("disconnect POSTs the connection id, then shows the reloaded list", async () => {
    P.setActive("sam");
    server.connections = [{ id: "c1", name: "Claude", lastRead: null }];
    await renderCoach();
    expect(fetchWithTimeout).toHaveBeenCalledWith("/api/sync/connections?profile=sam");
    expect(screen.getByText("Not used yet")).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByText("Disconnect")); });
    const post = fetchWithTimeout.mock.calls.find(([, o]) => o?.method === "POST");
    expect(post[0]).toBe("/api/sync/connections");
    expect(JSON.parse(post[1].body)).toMatchObject({ disconnect: "c1" });
    expect(await screen.findByText("Nothing connected yet.")).toBeTruthy();
    expect(screen.queryByText("Disconnect")).toBeNull();
  });

  it("a copy-link AI puts the MCP link on the clipboard", async () => {
    P.setActive("sam");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      await renderCoach();
      fireEvent.change(screen.getByLabelText("Your AI"), { target: { value: "chatgpt" } });
      await act(async () => { fireEvent.click(screen.getByText("Copy the link")); });
      expect(writeText).toHaveBeenCalledWith(MCP_URL);
      expect(screen.getByText("Copied")).toBeTruthy();
      expect(screen.queryByText("Copy the link")).toBeNull();
    } finally {
      delete navigator.clipboard;
    }
  });

  it("with no active profile it sends you home and renders nothing", () => {
    const replace = vi.spyOn(router, "replace");
    const { container } = render(<CoachView />);
    expect(replace).toHaveBeenCalledWith("/");
    expect(container.innerHTML).toBe("");
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    replace.mockRestore();
  });
});
