// @vitest-environment jsdom
// TrainerShareView (/profile/trainer): who sees your training, every look
// they took, Stop sharing in one tap, and adding a trainer as the profile the
// app is already in.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

const { router, server } = vi.hoisted(() => ({
  router: { replace: vi.fn(), back: vi.fn(), push: vi.fn() },
  server: { status: null, posts: [], peek: null, stopReply: null, afterStop: undefined, failReload: false, afterApprove: null },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/webauthn", () => ({ authenticatePasskey: vi.fn(async () => null) }));
vi.mock("@/lib/net", () => ({
  fetchWithTimeout: vi.fn(async (url, opts) => {
    if (url === "/api/share/peek") return { ok: true, status: 200, json: async () => server.peek };
    if (url === "/api/share/approve") {
      server.status = server.afterApprove;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (opts?.method === "POST") {
      server.posts.push(JSON.parse(opts.body));
      if (server.stopReply) {
        const [code, body] = server.stopReply;
        if (server.afterStop !== undefined) server.status = server.afterStop;
        return { ok: false, status: code, json: async () => body };
      }
      // Stopping ends the share; the reload shows nothing shared.
      server.status = { ...server.status, sharing: null };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (server.failReload && server.posts.length) throw new Error("offline");
    return { ok: true, status: 200, json: async () => server.status };
  }),
}));

import TrainerShareView from "../../components/TrainerShareView.jsx";
import { P } from "@/lib/storage";
import { authenticatePasskey } from "@/lib/webauthn";
import { fetchWithTimeout } from "@/lib/net";

// Wednesday 1 October 2026, 10:00 in London.
const NOW = Date.parse("2026-10-01T09:00:00Z");
const DAY = 86_400_000;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  server.status = null;
  server.posts = [];
  server.peek = null;
  server.stopReply = null;
  server.afterStop = undefined;
  server.failReload = false;
  server.afterApprove = null;
});

const sharing = (over = {}) => ({
  ref: "hwg_abc", name: "Jo", since: Date.parse("2026-09-03T12:00:00Z"), live: true,
  consentVersion: "2026-10", looks: [], lookCount: 0, ...over,
});
const status = (over = {}) => ({ open: true, trainerOpen: false, trainer: false, sharing: null, ended: null, ...over });

async function renderView() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  P.setActive("sam");
  await act(async () => { render(<TrainerShareView />); });
}

describe("TrainerShareView: sharing", () => {
  it("names the trainer, what they see and since when, from the share status", async () => {
    server.status = status({ sharing: sharing() });
    await renderView();
    expect(fetchWithTimeout).toHaveBeenCalledWith("/api/sync/trainer?profile=sam");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Jo");
    expect(screen.getByText("Sees your sessions, sets and how you felt for the last 24 weeks, and your main-lift trend and bests for 12 months. Read only.")).toBeTruthy();
    expect(screen.getByText("Sharing since 3 September.")).toBeTruthy();
    expect(screen.getByText("Not looked yet.")).toBeTruthy();
  });

  it("the access log tells a look from a roster check-in, holds at most 20 rows, and counts them all", async () => {
    const looks = Array.from({ length: 25 }, (_, i) => (i % 2
      ? { kind: "roster", at: NOW - i * DAY, day: new Date(NOW - i * DAY).toISOString().slice(0, 10) }
      : { kind: "view", at: NOW - i * DAY - 3_600_000 }));
    server.status = status({ sharing: sharing({ looks, lookCount: 37 }) });
    await renderView();
    const rows = screen.getByRole("list", { name: "When Jo looked" }).querySelectorAll("li");
    expect(rows).toHaveLength(20);
    expect(rows[0].textContent).toBe("Jo looked at your training1 hour ago");
    expect(rows[1].textContent).toBe("Jo checked in on the rosteryesterday");
    // en-GB short month, as Home shows dates ("Sep" or "Sept" by ICU version).
    expect(rows[3].textContent).toMatch(/^Jo checked in on the rosterMon 28 Sept?$/);
    expect(screen.getByText("37 looks in all. The latest 20 show here.")).toBeTruthy();
    expect(screen.getByText(/A roster check-in is Jo's client list/)).toBeTruthy();
  });

  it("a roster check-in today says today, and a short log counts what it has", async () => {
    server.status = status({ sharing: sharing({ looks: [{ kind: "roster", at: NOW, day: "2026-10-01" }], lookCount: 1 }) });
    await renderView();
    expect(screen.getByText("today")).toBeTruthy();
    expect(screen.getByText("1 look so far.")).toBeTruthy();
  });

  it("Stop sharing is one tap: no dialog, one POST, then says it stopped", async () => {
    const confirm = vi.spyOn(window, "confirm");
    server.status = status({ sharing: sharing() });
    await renderView();
    await act(async () => { fireEvent.click(screen.getByText("Stop sharing")); });
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(server.posts).toEqual([{ profile: "sam", stop: "hwg_abc" }]);
    expect(screen.getByText("Stopped. Jo can't see your training now.")).toBeTruthy();
    expect(screen.queryByText("Stop sharing")).toBeNull();
  });

  it("a stop that went through says so even when the reload can't get through", async () => {
    server.status = status({ sharing: sharing() });
    server.failReload = true;
    await renderView();
    await act(async () => { fireEvent.click(screen.getByText("Stop sharing")); });
    const line = screen.getByText("Stopped. Jo can't see your training now.");
    expect(document.activeElement).toBe(line);
    expect(screen.queryByText("Stop sharing")).toBeNull();
    expect(screen.queryByText(/Sharing since/)).toBeNull();
    expect(document.body.textContent).not.toContain("Couldn't reach Heatwayve");
  });

  it("a refused stop lets the reload speak, and never blames the network", async () => {
    server.status = status({ sharing: sharing() });
    server.stopReply = [404, { error: "Not found" }];
    server.afterStop = status();   // ended elsewhere meanwhile
    await renderView();
    await act(async () => { fireEvent.click(screen.getByText("Stop sharing")); });
    expect(document.body.textContent).not.toContain("Couldn't reach Heatwayve");
    expect(document.body.textContent).not.toContain("Not found");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Add a trainer");
  });

  it("a refused stop with the share still there says it didn't go through", async () => {
    server.status = status({ sharing: sharing() });
    server.stopReply = [503, { error: "Unavailable" }];
    await renderView();
    await act(async () => { fireEvent.click(screen.getByText("Stop sharing")); });
    expect(screen.getByText("That didn't go through. Try again.")).toBeTruthy();
    expect(screen.getByText("Stop sharing")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Couldn't reach Heatwayve");
  });

  it("a fresh code approved while paused reloads the share and lands on it", async () => {
    server.status = status({ sharing: sharing({ live: false }) });
    server.peek = { trainer: { name: "Jo" }, expiresAt: 1 };
    server.afterApprove = status({ sharing: sharing({ since: NOW }) });
    authenticatePasskey.mockResolvedValueOnce({ authToken: "tok" });
    await renderView();
    expect(screen.getByText("Got a fresh code from Jo?")).toBeTruthy();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("The code your trainer showed you"), { target: { value: "ABCD0EFGH1JK" } });
    });
    await act(async () => { fireEvent.click(screen.getByText("Share with Jo")); });
    expect(screen.queryByText(/^Paused\./)).toBeNull();
    expect(screen.queryByText("Jo can see your training.")).toBeNull();
    expect(screen.getByText("Sharing since 1 October.")).toBeTruthy();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Jo");
    expect(document.activeElement).toBe(h1);
  });

  it("a paused share says so without a reason, and keeps Stop", async () => {
    server.status = status({ sharing: sharing({ live: false }) });
    await renderView();
    expect(screen.getByText("Paused. Jo can't see your training right now. Stop sharing, or ask Jo for a fresh code.")).toBeTruthy();
    expect(screen.getByText("Stop sharing")).toBeTruthy();
    expect(screen.queryByText(/Sharing since/)).toBeNull();
    // A fresh code goes in under the paused share, below its heading.
    expect(screen.getByLabelText("The code your trainer showed you")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});

describe("TrainerShareView: no trainer", () => {
  it("adds a trainer as the active profile, with no name field", async () => {
    server.status = status();
    server.peek = { trainer: { name: "Jo" }, expiresAt: 1 };
    await renderView();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Add a trainer");
    // The code is the only thing typed here.
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByLabelText(/name/i)).toBeNull();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("The code your trainer showed you"), { target: { value: "ABCD0EFGH1JK" } });
    });
    // One page heading, and it now says whose code it is.
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Jo wants to see your training"]);
    expect(screen.getByText("You'll approve as sam with Face ID.")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText("Share with Jo")); });
    expect(authenticatePasskey).toHaveBeenCalledWith("sam", { quiet: true });
  });

  it("shows the ended notice above the code entry: by the trainer", async () => {
    server.status = status({ ended: { name: "Max", at: Date.parse("2026-09-20T10:00:00Z"), by: "trainer" } });
    await renderView();
    const notice = screen.getByText("Max stopped seeing your training on 20 September.");
    // Kicker, the "Add a trainer" heading, the notice, then the code field.
    const h1 = screen.getByRole("heading", { level: 1 });
    const field = screen.getByLabelText("The code your trainer showed you");
    expect(h1.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the ended notice: by account closure", async () => {
    server.status = status({ ended: { name: "Max", at: NOW - DAY, by: "closed" } });
    await renderView();
    expect(screen.getByText("Max's account has closed. They no longer see your training.")).toBeTruthy();
  });

  it("offers no code entry while sharing isn't open to this account", async () => {
    server.status = status({ open: false });
    await renderView();
    expect(screen.queryByLabelText("The code your trainer showed you")).toBeNull();
  });

  it("says when the status can't be reached", async () => {
    fetchWithTimeout.mockRejectedValueOnce(new Error("offline"));
    await renderView();
    expect(screen.getByRole("status").textContent).toBe("Couldn't reach Heatwayve. Try again.");
    expect(screen.queryByText("Stop sharing")).toBeNull();
  });

  it("with no active profile, goes home and fetches nothing", async () => {
    await act(async () => { render(<TrainerShareView />); });
    expect(router.replace).toHaveBeenCalledWith("/");
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});
