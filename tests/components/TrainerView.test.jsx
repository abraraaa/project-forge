// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// TrainerView (/trainer) against a fake set of trainer routes.
//
// Locks in:
//   - 401 shows sign-in; the ceremony is quiet and its token is exchanged
//     at POST /api/trainer/session for the named profile;
//   - 403 notTrainer shows the upgrade panel, and the upgrade reuses that
//     ceremony (one Face ID) with 18+ and the current Trainer Terms;
//   - 403 needsTerms asks to agree again; 503 says not open yet;
//   - roster rows render every signal variant;
//   - the invite sheet shows the code, polls, flips to "is in" and reloads
//     the roster; cancel and share link; the QR of the share link shows
//     only while the code works;
//   - opening a client keeps the URL and puts only an index in history; a
//     404 reads "Not shared with you now."; a late reply for an earlier
//     client never fills the pane; remove names and posts the same client,
//     and a failed remove says so; Forward after a reorder opens nothing;
//     sign out posts what it should;
//   - a final invite status (used, cancelled) stops polling for good;
//   - an invite reply after the sheet closed, or behind a newer issue, is
//     dropped; a terms change while a client opens leaves no pane behind;
//   - the upgrade panel names the trainer by the server's name once known;
//   - your own training is the roster's pinned first row; it opens with
//     ref "me" and a self history entry, in a pane titled You;
//   - the QR plate sits inside the sheet padding; a final invite status
//     leads in ink and the dead code fades.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { projectForTrainer } from "../../lib/trainer-view.js";
import { todayLocalIso, addDaysIso } from "../../lib/dates.js";
import { TRAINER_TERMS_VERSION } from "../../lib/trainer-terms.js";
import { encodeQr, qrToSvgPath } from "../../lib/qr.js";

const { server, auth } = vi.hoisted(() => ({
  server: { calls: [], routes: {} },
  auth: { result: { verified: true, authToken: "tok-1" } },
}));

vi.mock("@/lib/webauthn", () => ({
  authenticatePasskey: vi.fn(async () => auth.result),
  registerPasskey: vi.fn(async () => ({ ok: true })),
}));
// Each route answers from server.routes[path] (a function of the body, which
// may return a promise, or a fixed reply).
vi.mock("@/lib/net", () => ({
  fetchWithTimeout: vi.fn(async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    server.calls.push({ url, method: opts.method || "GET", body });
    const route = server.routes[`${opts.method || "GET"} ${url}`];
    const reply = typeof route === "function" ? await route(body) : route || { status: 500, body: {} };
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  }),
}));

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const today = todayLocalIso();
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

const posts = (url) => server.calls.filter((c) => c.url === url && c.method === "POST");
const gets = (url) => server.calls.filter((c) => c.url === url && c.method === "GET");

const SIGNALS = [
  { ref: "hwg_a", name: "Alex", since: Date.UTC(2026, 8, 1), lastLooked: null,
    signal: { lastTrainedDaysAgo: 2, weekDone: 2, weekPlanned: 3, rhythmPct: 86, paused: false } },
  { ref: "hwg_b", name: "Bea", since: Date.UTC(2026, 8, 1), lastLooked: null,
    signal: { lastTrainedDaysAgo: 0, weekDone: 1, weekPlanned: 3, rhythmPct: 100, paused: false } },
  { ref: "hwg_c", name: "Cal", since: Date.UTC(2026, 8, 1), lastLooked: null,
    signal: { lastTrainedDaysAgo: 1, weekDone: 1, weekPlanned: 3, rhythmPct: 50, paused: false } },
  { ref: "hwg_d", name: "Dee", since: Date.UTC(2026, 8, 1), lastLooked: null,
    signal: { lastTrainedDaysAgo: 9, weekDone: 0, weekPlanned: 0, rhythmPct: null, paused: true } },
  { ref: "hwg_e", name: "Eve", since: Date.UTC(2026, 8, 1), lastLooked: null,
    signal: { lastTrainedDaysAgo: null, weekDone: 0, weekPlanned: 3, rhythmPct: 0, paused: false } },
  { ref: "hwg_f", name: "Fin", since: Date.UTC(2026, 8, 1), lastLooked: null,
    signal: { lastTrainedDaysAgo: 4, weekDone: 1, weekPlanned: 2, rhythmPct: null, paused: false } },
  { ref: "hwg_g", name: "Gus", since: Date.UTC(2026, 9, 3, 12), lastLooked: null, signal: null },
  { ref: "hwg_h", name: null, since: Date.UTC(2026, 8, 1), lastLooked: null,
    signal: { lastTrainedDaysAgo: 3, weekDone: 2, weekPlanned: 3, rhythmPct: 75, paused: false } },
];

function clientView() {
  const date = addDaysIso(today, -2);
  const history = [{ id: `${date}T07:00:00.000Z`, date, readiness: "fresh", session: "strength A", scheduledLetter: "A",
    blocks: [{ type: "main", exercises: [{ name: "Barbell Back Squat", loadType: "barbell", sets: [{ weight: 100, reps: 5, rpe: 8 }] }] }] }];
  return projectForTrainer({ meta: {}, history }, { todayIso: today });
}

function signedIn(clients = SIGNALS) {
  server.routes["POST /api/trainer/clients"] = (b) => (b && "remove" in b ? { status: 200, body: { ok: true } }
    : { status: 200, body: { me: { name: "Coach Kim" }, clients } });
  server.routes["POST /api/trainer/client"] = (b) => (b.ref === "hwg_gone"
    ? { status: 404, body: { error: "Not shared with you now." } }
    : b.ref === "me"
    ? { status: 200, body: { client: { name: "Coach Kim" }, view: clientView(), self: true } }
    : { status: 200, body: { client: { name: "Alex", since: Date.UTC(2026, 8, 1) }, view: clientView() } });
}

async function mount() {
  const { default: TrainerView } = await import("../../components/TrainerView.jsx");
  const r = render(<TrainerView/>);
  await flush();
  return r;
}

beforeEach(() => {
  server.calls = [];
  server.routes = {};
  auth.result = { verified: true, authToken: "tok-1" };
  window.history.replaceState(null, "", "/trainer");
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

const typeName = (v) => {
  const input = screen.getByLabelText("Your Heatwayve name");
  fireEvent.change(input, { target: { value: v } });
};

describe("TrainerView: signing in", () => {
  it("401 shows sign-in; a quiet ceremony is exchanged for the trainer session", async () => {
    let session = false;
    server.routes["POST /api/trainer/clients"] = () => (session
      ? { status: 200, body: { me: { name: "Coach Kim" }, clients: [] } }
      : { status: 401, body: { error: "Sign in to see your clients", requiresAuth: true } });
    server.routes["POST /api/trainer/session"] = () => { session = true; return { status: 200, body: { ok: true, name: "Coach Kim" } }; };
    await mount();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your clients");
    expect(screen.getByText("Sign in to see training your clients share with you.")).toBeTruthy();
    expect(screen.getByLabelText("Your Heatwayve name").getAttribute("autocomplete")).toBe("username");
    typeName(" coachkim ");
    fireEvent.click(screen.getByText("Sign in with Face ID"));
    await flush();
    const { authenticatePasskey } = await import("@/lib/webauthn");
    expect(authenticatePasskey).toHaveBeenCalledWith("coachkim", { quiet: true });
    expect(posts("/api/trainer/session").map((c) => c.body)).toEqual([{ authToken: "tok-1", profile: "coachkim" }]);
    expect(screen.getByText("Add a client")).toBeTruthy();
    expect(posts("/api/trainer/clients")[1].body).toEqual({ today });
  });

  it("a cancelled ceremony returns to idle and posts nothing", async () => {
    server.routes["POST /api/trainer/clients"] = { status: 401, body: {} };
    auth.result = null;
    await mount();
    typeName("coachkim");
    fireEvent.click(screen.getByText("Sign in with Face ID"));
    await flush();
    expect(posts("/api/trainer/session")).toHaveLength(0);
    expect(screen.getByText("Sign in with Face ID")).toBeTruthy();
  });

  it("an empty name asks for it", async () => {
    server.routes["POST /api/trainer/clients"] = { status: 401, body: {} };
    await mount();
    fireEvent.click(screen.getByText("Sign in with Face ID"));
    await flush();
    expect(screen.getByText("Type your Heatwayve name first.")).toBeTruthy();
  });

  it("403 notTrainer shows the upgrade panel; the upgrade reuses the ceremony", async () => {
    let trainer = false;
    server.routes["POST /api/trainer/clients"] = () => (trainer
      ? { status: 200, body: { me: { name: "coachkim" }, clients: [] } } : { status: 401, body: {} });
    server.routes["POST /api/trainer/session"] = { status: 403, body: { notTrainer: true } };
    server.routes["POST /api/trainer/upgrade"] = () => { trainer = true; return { status: 200, body: { ok: true, name: "coachkim" } }; };
    await mount();
    typeName("coachkim");
    fireEvent.click(screen.getByText("Sign in with Face ID"));
    await flush();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Coach on Heatwayve");
    for (const line of [
      "See your clients' training once they say yes. Read only. Free.",
      "They approve you with Face ID, and can stop any time.",
      "You never see photos, bodyweight, sleep, or why someone's on a breather.",
      "Clients see you as coachkim.",
      "You're 18 or over.",
    ]) expect(screen.getByText(line)).toBeTruthy();
    const commit = screen.getByText("Set me up as a trainer");
    const terms = document.getElementById(commit.getAttribute("aria-describedby"));
    expect(terms.textContent).toBe("I'm 18 or over, and I accept the Trainer Terms.");
    expect(terms.querySelector("a").getAttribute("href")).toBe("/trainer/terms");
    fireEvent.click(commit);
    await flush();
    const { authenticatePasskey } = await import("@/lib/webauthn");
    expect(authenticatePasskey).toHaveBeenCalledTimes(1);
    expect(posts("/api/trainer/upgrade").map((c) => c.body)).toEqual([
      { authToken: "tok-1", profile: "coachkim", terms: { version: TRAINER_TERMS_VERSION }, adult: true },
    ]);
    expect(screen.getByText("Add a client")).toBeTruthy();
  });

  it("an upgrade that is not open yet says so", async () => {
    server.routes["POST /api/trainer/clients"] = { status: 401, body: {} };
    server.routes["POST /api/trainer/session"] = { status: 403, body: { notTrainer: true } };
    server.routes["POST /api/trainer/upgrade"] = { status: 503, body: { error: "Not open yet." } };
    await mount();
    typeName("coachkim");
    fireEvent.click(screen.getByText("Sign in with Face ID"));
    await flush();
    fireEvent.click(screen.getByText("Set me up as a trainer"));
    await flush();
    expect(screen.getByRole("status").textContent).toBe("Not open yet.");
  });

  it("403 needsTerms on load asks for the name and a fresh Face ID", async () => {
    let agreed = false;
    server.routes["POST /api/trainer/clients"] = () => (agreed
      ? { status: 200, body: { me: { name: "coachkim" }, clients: [] } } : { status: 403, body: { needsTerms: true } });
    server.routes["POST /api/trainer/upgrade"] = () => { agreed = true; return { status: 200, body: { ok: true } }; };
    await mount();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("The Trainer Terms changed");
    typeName("coachkim");
    fireEvent.click(screen.getByText("Agree with Face ID"));
    await flush();
    const { authenticatePasskey } = await import("@/lib/webauthn");
    expect(authenticatePasskey).toHaveBeenCalledWith("coachkim", { quiet: true });
    expect(posts("/api/trainer/upgrade")[0].body).toMatchObject({ profile: "coachkim", adult: true, terms: { version: TRAINER_TERMS_VERSION } });
    expect(screen.getByText("Add a client")).toBeTruthy();
  });

  it("a legacy passkey is asked to update first; 503 at sign-in says not open yet", async () => {
    server.routes["POST /api/trainer/clients"] = { status: 401, body: {} };
    server.routes["POST /api/trainer/session"] = { status: 409, body: { needsNativePasskey: true } };
    await mount();
    typeName("coachkim");
    fireEvent.click(screen.getByText("Sign in with Face ID"));
    await flush();
    expect(screen.getByText(/This needs a passkey for heatwayve\.app\. Update it in the Heatwayve app/)).toBeTruthy();
    expect(screen.queryByText("Update passkey")).toBeNull(); // no upgrade modal on /trainer: it would mint lifter cookies here
    server.routes["POST /api/trainer/session"] = { status: 503, body: { error: "Not open yet." } };
    fireEvent.click(screen.getByText("Sign in with Face ID"));
    await flush();
    expect(screen.getByRole("status").textContent).toBe("Not open yet.");
  });
});

describe("TrainerView: the roster", () => {
  it("renders each signal variant, numbers in the measured face", async () => {
    signedIn();
    await mount();
    const rows = [...screen.getByRole("list", { name: "Clients" }).querySelectorAll("li")].map((li) => li.textContent);
    expect(rows).toEqual([
      "AlexLast trained 2 days ago · 2 of 3 this week · rhythm 86%",
      "BeaTrained today · 1 of 3 this week · rhythm 100%",
      "CalLast trained yesterday · 1 of 3 this week · rhythm 50%",
      "DeeLast trained 9 days ago · paused",
      "EveNo sessions in the last year",
      "FinLast trained 4 days ago · 1 of 2 this week",
      "GusSharing since 3 Oct",
      "Your clientLast trained 3 days ago · 2 of 3 this week · rhythm 75%",
    ]);
    const line = screen.getByTitle("Last trained 2 days ago · 2 of 3 this week · rhythm 86%");
    expect(line.className).toBe("forge-wide-signal");
    expect([...line.querySelectorAll("span")].map((s) => s.textContent)).toEqual(["2", "2", "3", "86"]);
    expect(screen.getByText("Signed in as Coach Kim")).toBeTruthy();
  });

  it("pins your own training first, a hairline apart from the clients", async () => {
    signedIn();
    const { container } = await mount();
    const roster = container.querySelector(".forge-wide-roster");
    const you = roster.querySelector("[data-self-row]");
    const list = screen.getByRole("list", { name: "Clients" });
    expect(you).toBeTruthy();
    expect(you.textContent).toBe("Your trainingRead only here");
    expect(you.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The first row button in the roster is yours; clients follow.
    const rows = [...roster.querySelectorAll("button[aria-current], [data-self-row] button, ul button")];
    expect(rows[0].textContent).toBe("Your trainingRead only here");
    expect(rows[1].textContent).toMatch(/^Alex/);
    expect(you.style.borderBottom).toMatch(/^1px solid/);
    // It is not a client: the list holds clients only.
    expect(within(list).queryByText("Your training")).toBeNull();
  });

  it("an empty roster still shows your own training", async () => {
    signedIn([]);
    await mount();
    expect(screen.getByText("Your training")).toBeTruthy();
  });

  it("an empty roster says how clients add you", async () => {
    signedIn([]);
    await mount();
    const empty = "No clients yet. Show them a code. They add you in the app under Profile, then you see their training, read only.";
    expect(screen.getAllByText(empty).length).toBeGreaterThan(0);
  });

  it("sits in the wide shell with no inline width cap, roster then pane", async () => {
    signedIn();
    const { container } = await mount();
    const shell = container.firstChild;
    expect(shell.className).toBe("forge-wide");
    expect(shell.style.maxWidth).toBe("");
    expect(shell.getAttribute("data-view")).toBe("roster");
    expect([...shell.children].map((c) => c.className)).toEqual(["forge-wide-roster", "forge-wide-main"]);
    expect(screen.getByText("Pick a client to see their training.")).toBeTruthy();
    const src = readFileSync(resolve(root, "components/TrainerView.jsx"), "utf8");
    expect(src).not.toMatch(/position:\s*["']?(?:sticky|fixed)/);
    expect(src).not.toMatch(/maxWidth/);
    expect(src).not.toMatch(/lib\/storage|getActive\(|localStorage|sessionStorage|indexedDB|dangerouslySetInnerHTML/);
  });
});

describe("TrainerView: a client", () => {
  it("opens in the pane; history holds an index, the URL stays /trainer; Back clears it", async () => {
    signedIn();
    const { container } = await mount();
    const push = vi.spyOn(window.history, "pushState");
    fireEvent.click(screen.getByText("Alex"));
    await flush();
    expect(push).toHaveBeenCalledWith({ view: "client", i: 0 }, "");
    expect(window.location.pathname).toBe("/trainer");
    expect(posts("/api/trainer/client").map((c) => c.body)).toEqual([{ ref: "hwg_a", today }]);
    expect(container.firstChild.getAttribute("data-view")).toBe("client");
    expect(screen.getByText("Alex", { selector: "h1" })).toBeTruthy();
    expect(screen.getByText("Alex", { selector: "span" }).closest("button").getAttribute("aria-current")).toBe("true");
    // Switching clients replaces the entry rather than stacking another.
    const replace = vi.spyOn(window.history, "replaceState");
    fireEvent.click(screen.getByText("Bea"));
    await flush();
    expect(replace).toHaveBeenCalledWith({ view: "client", i: 1 }, "");
    expect(push).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate", { state: null })); });
    expect(container.firstChild.getAttribute("data-view")).toBe("roster");
    expect(screen.getByText("Pick a client to see their training.")).toBeTruthy();
    push.mockRestore(); replace.mockRestore();
  });

  it("your own row opens your training: ref me, a self history entry, a pane titled You with nothing to stop", async () => {
    signedIn();
    const { container } = await mount();
    const push = vi.spyOn(window.history, "pushState");
    fireEvent.click(screen.getByText("Your training"));
    await flush();
    expect(posts("/api/trainer/client").map((c) => c.body)).toEqual([{ ref: "me", today }]);
    expect(push).toHaveBeenCalledWith({ view: "client", self: true }, "");
    expect(window.location.pathname).toBe("/trainer");
    expect(container.firstChild.getAttribute("data-view")).toBe("client");
    expect(screen.getByText("You", { selector: "h1" })).toBeTruthy();
    expect(screen.getByText("Your training", { selector: "span" }).closest("button").getAttribute("aria-current")).toBe("true");
    const main = container.querySelector(".forge-wide-main");
    expect(main.textContent).not.toMatch(/Sharing since|You last looked|Stop seeing/);
    // Switching to a client replaces the entry; Back clears; Forward reopens yours.
    const replace = vi.spyOn(window.history, "replaceState");
    fireEvent.click(screen.getByText("Alex"));
    await flush();
    expect(replace).toHaveBeenCalledWith({ view: "client", i: 0 }, "");
    fireEvent.click(screen.getByText("Your training"));
    await flush();
    expect(replace).toHaveBeenLastCalledWith({ view: "client", self: true }, "");
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate", { state: null })); });
    expect(container.firstChild.getAttribute("data-view")).toBe("roster");
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate", { state: { view: "client", self: true } })); });
    await flush();
    expect(screen.getByText("You", { selector: "h1" })).toBeTruthy();
    expect(posts("/api/trainer/client").map((c) => c.body.ref)).toEqual(["me", "hwg_a", "me", "me"]);
    push.mockRestore(); replace.mockRestore();
  });

  it("a 404 reads 'Not shared with you now.' with a way back", async () => {
    signedIn([{ ...SIGNALS[0], ref: "hwg_gone" }]);
    await mount();
    fireEvent.click(screen.getByText("Alex"));
    await flush();
    expect(screen.getByText("Not shared with you now.")).toBeTruthy();
    expect(screen.getByText("Back to clients")).toBeTruthy();
  });

  it("remove posts the ref, then reloads the roster", async () => {
    signedIn();
    await mount();
    fireEvent.click(screen.getByText("Alex"));
    await flush();
    fireEvent.click(screen.getByText("Stop seeing Alex's training"));
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByText("Stop")); });
    await flush();
    expect(posts("/api/trainer/clients").filter((c) => "remove" in c.body).map((c) => c.body)).toEqual([{ remove: "hwg_a" }]);
    expect(posts("/api/trainer/clients").filter((c) => "today" in c.body)).toHaveLength(2);
  });

  it("a late reply for an earlier client never fills the pane; remove matches the name shown", async () => {
    signedIn();
    let releaseAlex;
    const base = server.routes["POST /api/trainer/client"];
    server.routes["POST /api/trainer/client"] = (b) => (b.ref === "hwg_a"
      ? new Promise((done) => { releaseAlex = () => done({ status: 200, body: { client: { name: "Alex", since: 0 }, view: clientView() } }); })
      : { status: 200, body: { client: { name: "Bea", since: 0 }, view: clientView() } });
    await mount();
    fireEvent.click(screen.getByText("Alex"));
    await flush();
    fireEvent.click(screen.getByText("Bea"));
    await flush();
    expect(screen.getByText("Bea", { selector: "h1" })).toBeTruthy();
    await act(async () => { releaseAlex(); });
    await flush();
    expect(screen.getByText("Bea", { selector: "h1" })).toBeTruthy();
    expect(screen.queryByText("Alex", { selector: "h1" })).toBeNull();
    expect(screen.getByText("Bea", { selector: "span" }).closest("button").getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByText("Stop seeing Bea's training"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Stop seeing Bea's training?")).toBeTruthy();
    await act(async () => { fireEvent.click(within(dialog).getByText("Stop")); });
    await flush();
    expect(posts("/api/trainer/clients").filter((c) => "remove" in c.body).map((c) => c.body)).toEqual([{ remove: "hwg_b" }]);
    server.routes["POST /api/trainer/client"] = base;
  });

  it("a failed remove keeps the sheet open and says so; a 404 counts as ended", async () => {
    signedIn();
    let reply = { status: 503, body: { error: "Not open yet." } };
    const roster = server.routes["POST /api/trainer/clients"];
    server.routes["POST /api/trainer/clients"] = (b) => ("remove" in b ? reply : roster(b));
    await mount();
    fireEvent.click(screen.getByText("Alex"));
    await flush();
    fireEvent.click(screen.getByText("Stop seeing Alex's training"));
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByText("Stop")); });
    await flush();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("status").textContent).toBe("Couldn't stop that just now. Try again.");
    expect(screen.getByText("Alex", { selector: "h1" })).toBeTruthy();
    expect(posts("/api/trainer/clients").filter((c) => "today" in c.body)).toHaveLength(1);
    reply = { status: 404, body: { error: "Not shared with you now." } };
    await act(async () => { fireEvent.click(within(dialog).getByText("Stop")); });
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts("/api/trainer/clients").filter((c) => "today" in c.body)).toHaveLength(2);
  });

  it("Forward after the roster reorders opens nothing rather than another client", async () => {
    signedIn();
    await mount();
    fireEvent.click(screen.getByText("Alex"));
    await flush();
    // Alex is removed; the reloaded roster puts Bea at index 0.
    const rest = SIGNALS.slice(1);
    server.routes["POST /api/trainer/clients"] = (b) => ("remove" in b ? { status: 200, body: { ok: true } }
      : { status: 200, body: { me: { name: "Coach Kim" }, clients: rest } });
    fireEvent.click(screen.getByText("Stop seeing Alex's training"));
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByText("Stop")); });
    await flush();
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate", { state: null })); });
    const before = posts("/api/trainer/client").length;
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate", { state: { view: "client", i: 0 } })); });
    await flush();
    expect(posts("/api/trainer/client")).toHaveLength(before);
    expect(screen.getByText("Pick a client to see their training.")).toBeTruthy();
  });

  it("sign out and sign out everywhere end the session", async () => {
    signedIn();
    server.routes["POST /api/trainer/session/end"] = { status: 200, body: { ok: true } };
    await mount();
    fireEvent.click(screen.getByText("Sign out everywhere"));
    await flush();
    expect(posts("/api/trainer/session/end").map((c) => c.body)).toEqual([{ everywhere: true }]);
    expect(screen.getByText("Sign in with Face ID")).toBeTruthy();
    expect(screen.queryByText("Alex")).toBeNull();
  });
});

describe("TrainerView: the invite sheet", () => {
  const CODE = "ABCD0EFGH1JK";
  const issuedAt = Date.UTC(2026, 9, 3, 13, 0);

  function inviteRoutes(status = { status: "pending", expiresAt: issuedAt + 3_600_000 }) {
    server.routes["POST /api/trainer/invite"] = (b) => (b.action === "issue"
      ? { status: 200, body: { code: CODE, expiresAt: issuedAt + 3_600_000 } }
      : { status: 200, body: { ok: true } });
    server.routes["GET /api/trainer/invite"] = () => ({ status: 200, body: status });
  }

  it("shows the code, polls every 3 s, flips to 'is in' and reloads the roster", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(issuedAt);
    signedIn();
    const reply = { status: "pending", expiresAt: issuedAt + 3_600_000 };
    inviteRoutes(reply);
    await mount();
    await act(async () => { fireEvent.click(screen.getByText("Add a client")); });
    await flush();
    expect(posts("/api/trainer/invite").map((c) => c.body)).toEqual([{ action: "issue" }]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Show them this")).toBeTruthy();
    expect(dialog.querySelector("[data-code]").textContent).toBe("ABCD 0EFG H1JK");
    expect(dialog.textContent).toContain("In Heatwayve, they go to Profile → Add a trainer and type this code. Works once, until");
    expect(dialog.textContent).toContain("60 min left");
    expect(within(dialog).getByRole("status").textContent).toBe("Waiting for them…");

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(gets("/api/trainer/invite")).toHaveLength(1);
    expect(within(dialog).getByRole("status").textContent).toBe("Waiting for them…");

    Object.assign(reply, { status: "used", usedBy: "Sam" });
    const before = posts("/api/trainer/clients").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await flush();
    expect(within(dialog).getByRole("status").textContent).toBe("Sam is in.");
    expect(posts("/api/trainer/clients").length).toBe(before + 1);
    expect(within(dialog).getByText("New code")).toBeTruthy();
    // Polling stopped with the final status, and coming back to the tab
    // does not start it again.
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(gets("/api/trainer/invite")).toHaveLength(2);
    const rosterLoads = posts("/api/trainer/clients").length;
    const vis = vi.spyOn(document, "visibilityState", "get");
    for (let i = 0; i < 3; i++) {
      vis.mockReturnValue("hidden");
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      vis.mockReturnValue("visible");
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(3000); });
    }
    await flush();
    expect(gets("/api/trainer/invite")).toHaveLength(2);
    expect(posts("/api/trainer/clients")).toHaveLength(rosterLoads);
    vis.mockRestore();
  });

  it("pauses while hidden and resumes when visible again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(issuedAt);
    signedIn();
    inviteRoutes();
    await mount();
    await act(async () => { fireEvent.click(screen.getByText("Add a client")); });
    await flush();
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(9000); });
    expect(gets("/api/trainer/invite")).toHaveLength(0);
    vis.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await flush();
    expect(gets("/api/trainer/invite")).toHaveLength(1);
    vis.mockRestore();
  });

  it("stops polling after 20 minutes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(issuedAt);
    signedIn();
    inviteRoutes();
    await mount();
    await act(async () => { fireEvent.click(screen.getByText("Add a client")); });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(20 * 60_000); });
    const n = gets("/api/trainer/invite").length;
    expect(n).toBe(400);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(gets("/api/trainer/invite")).toHaveLength(n);
  });

  it("cancel ends the code and its poll; share link falls back to the clipboard", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(issuedAt);
    signedIn();
    // After a cancel the server reports the code as expired.
    inviteRoutes({ status: "expired", expiresAt: issuedAt });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount();
    await act(async () => { fireEvent.click(screen.getByText("Add a client")); });
    await flush();
    const dialog = screen.getByRole("dialog");
    await act(async () => { fireEvent.click(within(dialog).getByText("Share link")); });
    expect(writeText).toHaveBeenCalledWith(`https://heatwayve.app/share#${CODE}`);
    expect(within(dialog).getByText("Copied")).toBeTruthy();
    await act(async () => { fireEvent.click(within(dialog).getByText("Cancel code")); });
    await flush();
    expect(posts("/api/trainer/invite").map((c) => c.body)).toEqual([{ action: "issue" }, { action: "cancel" }]);
    expect(within(dialog).getByRole("status").textContent).toBe("Cancelled. This code no longer works.");
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(gets("/api/trainer/invite")).toHaveLength(0);
    expect(within(dialog).getByRole("status").textContent).toBe("Cancelled. This code no longer works.");
    expect(within(dialog).getByText("New code")).toBeTruthy();
    fireEvent.click(within(dialog).getByText("Done"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the share link as a QR above the code while it works, and drops it on cancel", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(issuedAt);
    signedIn();
    inviteRoutes();
    await mount();
    await act(async () => { fireEvent.click(screen.getByText("Add a client")); });
    await flush();
    const dialog = screen.getByRole("dialog");
    const qr = within(dialog).getByRole("img", { name: "QR code for the share link" });
    const { size, modules } = encodeQr(`https://heatwayve.app/share#${CODE}`);
    expect(qr.querySelector("path").getAttribute("d")).toBe(qrToSvgPath(modules, size));
    expect([qr.getAttribute("width"), qr.getAttribute("height")]).toEqual(["185", "185"]);
    // The code sits beneath it.
    const code = dialog.querySelector("[data-code]");
    expect(qr.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog).getByText("Share link")).toBeTruthy();
    await act(async () => { fireEvent.click(within(dialog).getByText("Cancel code")); });
    await flush();
    expect(within(dialog).getByRole("status").textContent).toBe("Cancelled. This code no longer works.");
    expect(within(dialog).queryByRole("img", { name: "QR code for the share link" })).toBeNull();
    expect(dialog.querySelector("[data-qr]")).toBeNull();
    expect(dialog.querySelector("[data-code]").textContent).toBe("ABCD 0EFG H1JK");
  });

  it("the QR plate sits inside the sheet's padding, its left edge on the text's", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(issuedAt);
    signedIn();
    inviteRoutes();
    await mount();
    await act(async () => { fireEvent.click(screen.getByText("Add a client")); });
    await flush();
    const plate = screen.getByRole("dialog").querySelector("[data-qr]");
    for (const side of ["marginLeft", "marginRight", "marginTop"]) {
      expect(plate.style[side] === "" || parseFloat(plate.style[side]) >= 0, side).toBe(true);
    }
    expect(plate.style.width).toBe("185px");
  });

  it("once the code is cancelled, used or run out, the status leads in ink and the dead code fades", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(issuedAt);
    signedIn();
    const reply = { status: "pending", expiresAt: issuedAt + 3_600_000 };
    inviteRoutes(reply);
    await mount();
    await act(async () => { fireEvent.click(screen.getByText("Add a client")); });
    await flush();
    const dialog = screen.getByRole("dialog");
    const status = within(dialog).getByRole("status");
    const code = dialog.querySelector("[data-code]");
    // Live: the code in ink; the status (first in the DOM, one live region) sits after the how-to by order.
    expect(code.style.opacity).toBe("1");
    expect(status.style.order).toBe("3");
    expect(status.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(status.style.fontSize).toBe("14px");
    expect(status.hasAttribute("data-final")).toBe(false);

    await act(async () => { fireEvent.click(within(dialog).getByText("Cancel code")); });
    await flush();
    const after = within(dialog).getByRole("status");
    expect(after).toBe(status); // one live region throughout, so it is announced
    expect(after.textContent).toBe("Cancelled. This code no longer works.");
    expect(after.hasAttribute("data-final")).toBe(true);
    expect(after.style.order).toBe(""); // first in the DOM and on screen
    expect(within(dialog).queryByText(/Works once, until/)).toBeNull(); // the how-to goes with the dead code
    expect(after.parentElement.style.display).toBe("flex");
    expect(after.parentElement.style.flexDirection).toBe("column");
    expect(after.style.fontSize).toBe("15px");
    expect(after.style.fontWeight).toBe("500");
    expect(after.style.color).toBe("var(--ink)");
    expect(code.style.opacity).toBe("0.3");
    expect(code.style.color).toBe("var(--ink-3)");

    // Used reads the same way, on a fresh code.
    server.routes["POST /api/trainer/invite"] = () => ({ status: 200, body: { code: "MNPQ2RSTV3WX", expiresAt: issuedAt + 3_600_000 } });
    await act(async () => { fireEvent.click(within(dialog).getByText("New code")); });
    await flush();
    expect(within(dialog).getByRole("status").hasAttribute("data-final")).toBe(false);
    Object.assign(reply, { status: "used", usedBy: "Sam" });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await flush();
    const used = within(dialog).getByRole("status");
    expect(used.textContent).toBe("Sam is in.");
    expect(used.style.order).toBe("");
    expect(dialog.querySelector("[data-code]").style.opacity).toBe("0.3");
  });

  it("an issue that is not open yet says so", async () => {
    signedIn();
    server.routes["POST /api/trainer/invite"] = { status: 503, body: { error: "Not open yet." } };
    await mount();
    await act(async () => { fireEvent.click(screen.getByText("Add a client")); });
    await flush();
    expect(within(screen.getByRole("dialog")).getByText("Not open yet.")).toBeTruthy();
  });
});

describe("TrainerView: the terms change under an open session", () => {
  it("a 403 needsTerms on a client leaves no half-open pane: after agreeing, the roster comes back clean", async () => {
    signedIn();
    server.routes["POST /api/trainer/client"] = { status: 403, body: { needsTerms: true } };
    server.routes["POST /api/trainer/upgrade"] = { status: 200, body: { ok: true, name: "Coach Kim" } };
    const { container } = await mount();
    fireEvent.click(screen.getByText("Alex"));
    await flush();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("The Trainer Terms changed");
    expect(window.history.state?.view).not.toBe("client");
    typeName("coachkim");
    fireEvent.click(screen.getByText("Agree with Face ID"));
    await flush();
    expect(screen.getByText("Add a client")).toBeTruthy();
    expect(container.firstChild.getAttribute("data-view")).toBe("roster");
    expect(screen.queryByText("One moment")).toBeNull();
    expect(screen.getByText("Pick a client to see their training.")).toBeTruthy();
    expect(screen.getByText("Alex", { selector: "span" }).closest("button").getAttribute("aria-current")).toBeNull();
    // The same client opens again from the roster.
    server.routes["POST /api/trainer/client"] = { status: 200, body: { client: { name: "Alex", since: 0 }, view: clientView() } };
    fireEvent.click(screen.getByText("Alex"));
    await flush();
    expect(screen.getByText("Alex", { selector: "h1" })).toBeTruthy();
  });

  it("names the trainer as clients see them: the server's name, not what was typed", async () => {
    let session = false;
    server.routes["POST /api/trainer/clients"] = () => (session
      ? { status: 200, body: { me: { name: "Coach Kim" }, clients: SIGNALS } }
      : { status: 401, body: {} });
    server.routes["POST /api/trainer/session"] = () => { session = true; return { status: 200, body: { ok: true, name: "Coach Kim" } }; };
    server.routes["POST /api/trainer/client"] = { status: 403, body: { needsTerms: true } };
    await mount();
    typeName("  COACHKIM ");
    fireEvent.click(screen.getByText("Sign in with Face ID"));
    await flush();
    fireEvent.click(screen.getByText("Alex"));
    await flush();
    expect(screen.getByText("Clients see you as Coach Kim.")).toBeTruthy();
    expect(screen.queryByText(/Clients see you as COACHKIM/)).toBeNull();
  });
});

describe("TrainerView: invite replies in order", () => {
  // Each issue waits until the test answers it.
  function heldIssues() {
    const held = [];
    server.routes["POST /api/trainer/invite"] = (b) => (b.action === "issue"
      ? new Promise((done) => held.push(done)) : { status: 200, body: { ok: true } });
    server.routes["GET /api/trainer/invite"] = { status: 200, body: { status: "pending", expiresAt: Date.now() + 3_600_000 } };
    const code = (c) => ({ status: 200, body: { code: c, expiresAt: Date.now() + 3_600_000 } });
    return { held, code };
  }

  it("a reply that lands after Done never reopens the sheet", async () => {
    signedIn();
    const { held, code } = heldIssues();
    await mount();
    await act(async () => { fireEvent.click(screen.getByText("Add a client")); });
    expect(within(screen.getByRole("dialog")).getByText("One moment")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Done"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { held[0](code("ABCD0EFGH1JK")); });
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a reply that lands after the scrim closes it never reopens the sheet, nor an error", async () => {
    signedIn();
    const { held } = heldIssues();
    await mount();
    await act(async () => { fireEvent.click(screen.getByText("Add a client")); });
    fireEvent.click(document.querySelector(".forge-scrim"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { held[0]({ status: 503, body: { error: "Not open yet." } }); });
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("of two issues in flight, only the later one fills the sheet", async () => {
    signedIn();
    const { held, code } = heldIssues();
    await mount();
    await act(async () => { fireEvent.click(screen.getByText("Add a client")); });
    await act(async () => { fireEvent.click(screen.getByText("Add a client")); });
    expect(held).toHaveLength(2);
    await act(async () => { held[1](code("ZZZZ0EFGH1JK")); });
    await flush();
    expect(screen.getByRole("dialog").querySelector("[data-code]").textContent).toBe("ZZZZ 0EFG H1JK");
    await act(async () => { held[0](code("ABCD0EFGH1JK")); });
    await flush();
    expect(screen.getByRole("dialog").querySelector("[data-code]").textContent).toBe("ZZZZ 0EFG H1JK");
  });
});
