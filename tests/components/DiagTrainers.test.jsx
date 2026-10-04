// @vitest-environment jsdom
// /diag-trainers against fake admin routes: unlock with the admin ceremony,
// waiting rows with what applicants wrote as plain text (the link never an
// anchor), approve and "Not this time" with a fresh ceremony reused inside
// 4 minutes, the page's own words for failures, and the decided list.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";

const { routes, auth } = vi.hoisted(() => ({ routes: {}, auth: { calls: 0, ok: true } }));
vi.mock("@/lib/storage", () => ({ P: { getActive: () => "dee" } }));
vi.mock("@/lib/auth-session", () => ({ getAuthTokenWithCeremony: vi.fn(async () => "tok-read") }));
vi.mock("@/lib/webauthn", () => ({
  authenticatePasskey: vi.fn(async () => { auth.calls++; return auth.ok ? { verified: true, authToken: `tok-fresh-${auth.calls}` } : null; }),
}));
vi.mock("@/lib/net", () => ({
  fetchWithTimeout: vi.fn(async (url, opts = {}) => {
    const r = routes[`${opts.method || "GET"} ${url}`];
    const reply = typeof r === "function" ? r(opts.body ? JSON.parse(opts.body) : undefined, opts.headers || {}) : r;
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  }),
}));

const { default: DiagTrainers } = await import("@/app/diag-trainers/page");
const { fetchWithTimeout } = await import("@/lib/net");

const DAY = 86_400_000;
const L = "hwa_" + "l".repeat(26);
const K = "hwa_" + "k".repeat(26);
const open = () => [
  { accountId: K, name: "Kim", accountAge: 45, status: "applied", about: "Online coaching.\nLevel 3.", link: null, appliedAt: Date.now() - 5 * DAY, decidedAt: null },
  { accountId: L, name: "Leo", accountAge: 1, status: "applied", about: "Gym in Leeds.", link: "https://leo.example/<b>x</b>", appliedAt: Date.now() - 2 * DAY, decidedAt: null },
];
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const unlock = async () => { fireEvent.click(screen.getByText("Unlock with Face ID")); await flush(); };

beforeEach(() => {
  auth.calls = 0; auth.ok = true;
  for (const k of Object.keys(routes)) delete routes[k];
  routes["GET /api/diag/trainers"] = { status: 200, body: { open: open(), decided: [{ accountId: "hwa_x", name: null, accountAge: 3, status: "withdrawn", about: null, link: null, appliedAt: 1, decidedAt: Date.now() - DAY }] } };
  routes["POST /api/diag/trainers"] = (b) => ({ status: 200, body: { ok: true, status: b.decision === "approve" ? "approved" : "denied" } });
  vi.mocked(fetchWithTimeout).mockClear();
});
afterEach(() => cleanup());

describe("/diag-trainers", () => {
  it("is locked until the admin ceremony; the kicker is sentence case", async () => {
    render(<DiagTrainers />);
    expect(screen.getByText("Admin")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Trainer applications");
    expect(screen.queryByText("Kim")).toBeNull();
    await unlock();
    expect(vi.mocked(fetchWithTimeout).mock.calls[0]).toEqual(["/api/diag/trainers", { headers: { "X-HW-Auth": "tok-read" } }]);
    expect(screen.getByText("2 waiting")).toBeTruthy();
  });

  it("shows each waiting row: name, when, age, about as text, the link as text only", async () => {
    const { container } = render(<DiagTrainers />);
    await unlock();
    const leo = container.querySelector(`[data-application="${L}"]`);
    expect(within(leo).getByText("Leo")).toBeTruthy();
    expect(leo.textContent).toContain("1 day on Heatwayve");
    expect(within(leo).getByText("Gym in Leeds.")).toBeTruthy();
    expect(leo.querySelector("[data-link]").textContent).toBe("https://leo.example/<b>x</b>");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    // Waiting oldest first, as the route sends them.
    expect([...container.querySelectorAll("[data-application]")].map((e) => e.getAttribute("data-application"))).toEqual([K, L]);
    // A closed profile has no name to show.
    expect(screen.getByText("Closed profile")).toBeTruthy();
  });

  it("approve runs a fresh ceremony, posts the decision, and moves the row to Decided; a second decision reuses it", async () => {
    const { container } = render(<DiagTrainers />);
    await unlock();
    fireEvent.click(within(container.querySelector(`[data-application="${K}"]`)).getByText("Approve"));
    await flush();
    const post = vi.mocked(fetchWithTimeout).mock.calls.find(([, o]) => o?.method === "POST");
    expect(JSON.parse(post[1].body)).toEqual({ decision: "approve", accountId: K });
    expect(post[1].headers["X-HW-Auth"]).toBe("tok-fresh-1");
    expect(container.querySelector(`[data-application="${K}"]`)).toBeNull();
    expect(container.querySelector('[data-decided="approved"]').textContent).toContain("Kim");
    expect(screen.getByText("1 waiting")).toBeTruthy();

    fireEvent.click(within(container.querySelector(`[data-application="${L}"]`)).getByText("Not this time"));
    await flush();
    const posts = vi.mocked(fetchWithTimeout).mock.calls.filter(([, o]) => o?.method === "POST");
    expect(JSON.parse(posts[1][1].body)).toEqual({ decision: "deny", accountId: L });
    expect(posts[1][1].headers["X-HW-Auth"]).toBe("tok-fresh-1");
    expect(auth.calls).toBe(1);
    expect(screen.getByText("No one waiting.")).toBeTruthy();
    expect(container.querySelector('[data-decided="denied"]').textContent).toContain("Not this time");
  });

  it("a cancelled ceremony posts nothing; a 404 says already decided and reloads; failures use the page's own words", async () => {
    const { container } = render(<DiagTrainers />);
    await unlock();
    auth.ok = false;
    fireEvent.click(within(container.querySelector(`[data-application="${K}"]`)).getByText("Approve"));
    await flush();
    expect(screen.getByRole("status").textContent).toBe("Face ID didn't go through. Try again.");
    expect(vi.mocked(fetchWithTimeout).mock.calls.some(([, o]) => o?.method === "POST")).toBe(false);

    auth.ok = true;
    routes["POST /api/diag/trainers"] = { status: 404, body: { error: "Not found" } };
    routes["GET /api/diag/trainers"] = { status: 200, body: { open: open().slice(1), decided: [] } };
    fireEvent.click(within(container.querySelector(`[data-application="${K}"]`)).getByText("Approve"));
    await flush();
    expect(screen.getByRole("status").textContent).toBe("Already decided. The list is up to date.");
    expect(container.querySelector(`[data-application="${K}"]`)).toBeNull();

    routes["POST /api/diag/trainers"] = { status: 403, body: { error: "Admin only" } };
    fireEvent.click(within(container.querySelector(`[data-application="${L}"]`)).getByText("Approve"));
    await flush();
    expect(screen.getByRole("status").textContent).toBe("This page is for the admin.");
    expect(container.textContent).not.toContain("Admin only");
  });

  it("an unlock refused by the server shows the page's words, not the server's", async () => {
    routes["GET /api/diag/trainers"] = { status: 403, body: { error: "Admin only" } };
    render(<DiagTrainers />);
    await unlock();
    expect(screen.getByRole("status").textContent).toBe("This page is for the admin.");
    expect(screen.getByText("Unlock with Face ID")).toBeTruthy();
  });
});
