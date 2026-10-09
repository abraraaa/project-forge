// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// /trainer for someone who isn't a trainer: the Apply panel, against fake
// routes (POST /api/trainer/apply as the shared API contract has it).
//
// Locks in:
//   - a 403 notTrainer without admin opens Apply, never the self-upgrade;
//     the admin's 403 still opens the upgrade; an upgrade answering
//     403 { apply } falls back to Apply;
//   - Send checks the fields first, then reuses sign-in's ceremony (one
//     Face ID) and posts about, the link only when typed, the Terms
//     version and 18+;
//   - each reply has its own words: sent, already in, not this time (with
//     the date), paused, not open, already a trainer, sign in again; an
//     outage 503 is "something went wrong", never "not open";
//   - the outcome that replaces the form is announced and takes focus;
//   - the fields follow the apply route's own rules (lib/trainer-apply.js);
//   - the server's error text is never shown, here or at sign-in or on an
//     invite: 429, 5xx and offline map to house copy;
//   - the counter shows from 240 and the field stops at 280.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TRAINER_TERMS_VERSION } from "../../lib/trainer-terms.js";
import { APPLY_COPY, REPLY_COPY, ABOUT_MAX, LINK_MAX, aboutProblem, deniedLine, linkProblem, linkToSend, applyRowSub, decisionUnseen } from "../../lib/trainer-apply-copy.js";
import * as rules from "../../lib/trainer-apply.js";

const { server, auth, nav } = vi.hoisted(() => ({
  server: { calls: [], routes: {} },
  auth: { result: { verified: true, authToken: "tok-1" } },
  nav: { back: () => {}, replace: () => {}, push: () => {} },
}));

vi.mock("next/navigation", () => ({ useRouter: () => nav }));

vi.mock("@/lib/webauthn", () => ({
  authenticatePasskey: vi.fn(async () => auth.result),
  registerPasskey: vi.fn(async () => ({ ok: true })),
}));
// A route may answer "offline": the fetch rejects, as a dropped network does.
vi.mock("@/lib/net", () => ({
  fetchWithTimeout: vi.fn(async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    server.calls.push({ url, method: opts.method || "GET", body });
    const route = server.routes[`${opts.method || "GET"} ${url}`];
    const reply = typeof route === "function" ? await route(body) : route || { status: 500, body: {} };
    if (reply === "offline") throw new TypeError("Failed to fetch");
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  }),
}));

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const posts = (url) => server.calls.filter((c) => c.url === url && c.method === "POST");
const SERVER_TEXT = "relation \"trainer_applications\" does not exist";

beforeEach(() => {
  server.calls = [];
  server.routes = {};
  auth.result = { verified: true, authToken: "tok-1" };
  server.routes["POST /api/trainer/clients"] = { status: 401, body: {} };
  server.routes["POST /api/trainer/session"] = { status: 403, body: { notTrainer: true, name: "Coach Kim" } };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function signIn(name = "coachkim") {
  const { default: TrainerView } = await import("../../components/TrainerView.jsx");
  const r = render(<TrainerView/>);
  await flush();
  fireEvent.change(screen.getByLabelText("Your Heatwayve name"), { target: { value: name } });
  fireEvent.click(screen.getByText("Sign in with Face ID"));
  await flush();
  return r;
}
const write = (about, link) => {
  fireEvent.change(screen.getByLabelText("Where do you coach?"), { target: { value: about } });
  if (link !== undefined) fireEvent.change(screen.getByLabelText("A link (optional)"), { target: { value: link } });
};
const send = async () => { fireEvent.click(screen.getByText("Send application")); await flush(); };
const status = () => screen.getAllByRole("status").at(-1).textContent;

describe("Apply: the panel", () => {
  it("a non-admin's 403 opens Apply, named as the server names them, with the Terms line", async () => {
    await signIn("  COACHKIM ");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Coach on Heatwayve");
    expect(screen.queryByText("Set me up as a trainer")).toBeNull();
    expect(screen.getByText(/see you as Coach Kim\.$/)).toBeTruthy();
    expect(screen.queryByText(/COACHKIM/)).toBeNull();
    expect(screen.getByText(APPLY_COPY.lead)).toBeTruthy();
    expect(screen.getByLabelText("Where do you coach?").tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("A link (optional)").getAttribute("type")).toBe("url");
    expect(screen.getByText("You're 18 or over.")).toBeTruthy();
    const commit = screen.getByText("Send application");
    const terms = document.getElementById(commit.getAttribute("aria-describedby"));
    expect(terms.textContent).toBe("I'm 18 or over, and I accept the Trainer Terms.");
    expect(terms.querySelector("a").getAttribute("href")).toBe("/trainer/terms");
    // Signed in already: no second name field.
    expect(screen.queryByLabelText("Your Heatwayve name")).toBeNull();
  });

  it("sends with sign-in's ceremony: one Face ID, the fields trimmed, no link when none is typed", async () => {
    server.routes["POST /api/trainer/apply"] = { status: 200, body: { ok: true, status: "applied" } };
    await signIn();
    write("  Strength coach at Iron Works, London. Level 3 PT.  ");
    await send();
    const { authenticatePasskey } = await import("@/lib/webauthn");
    expect(authenticatePasskey).toHaveBeenCalledTimes(1);
    expect(posts("/api/trainer/apply").map((c) => c.body)).toEqual([{
      authToken: "tok-1", profile: "coachkim", about: "Strength coach at Iron Works, London. Level 3 PT.",
      terms: { version: TRAINER_TERMS_VERSION }, adult: true,
    }]);
    expect(posts("/api/trainer/upgrade")).toHaveLength(0);
    expect(screen.getByText("Application sent. We'll let you know here and in Profile.")).toBeTruthy();
    expect(screen.getByText(APPLY_COPY.carryOn)).toBeTruthy();
    expect(screen.queryByText("Send application")).toBeNull();
  });

  it("posts the link when one is typed, as an https address", async () => {
    server.routes["POST /api/trainer/apply"] = { status: 200, body: { ok: true, status: "applied" } };
    await signIn();
    write("Online coaching.", " https://ironworks.example/coach ");
    await send();
    expect(posts("/api/trainer/apply")[0].body).toMatchObject({ about: "Online coaching.", link: "https://ironworks.example/coach" });
    cleanup();
    await signIn();
    write("Online coaching.", "instagram.com/coachkim");
    await send();
    expect(posts("/api/trainer/apply")[1].body.link).toBe("https://instagram.com/coachkim");
  });

  it("checks the fields before any Face ID or post", async () => {
    await signIn();
    await send();
    expect(status()).toBe(APPLY_COPY.needAbout);
    write("Gym floor.", "http://ironworks.example");
    await send();
    expect(status()).toBe(APPLY_COPY.badLink);
    write("Gym floor.", "instagram");
    await send();
    expect(status()).toBe(APPLY_COPY.badLink);
    write("Gym floor.", "ftp://ironworks.example");
    await send();
    expect(status()).toBe(APPLY_COPY.badLink);
    const { authenticatePasskey } = await import("@/lib/webauthn");
    expect(authenticatePasskey).toHaveBeenCalledTimes(1); // sign-in's only
    expect(posts("/api/trainer/apply")).toHaveLength(0);
  });

  it("counts from 240 characters, and the field stops at 280", async () => {
    await signIn();
    const field = screen.getByLabelText("Where do you coach?");
    expect(field.getAttribute("maxlength")).toBe(String(ABOUT_MAX));
    write("a".repeat(239));
    expect(document.getElementById("hw-apply-count").textContent).toBe("");
    expect(field.hasAttribute("aria-describedby")).toBe(false);
    write("a".repeat(240));
    expect(document.getElementById("hw-apply-count").textContent).toBe("40 left");
    expect(field.getAttribute("aria-describedby")).toBe("hw-apply-count");
    write("a".repeat(280));
    expect(document.getElementById("hw-apply-count").textContent).toBe("0 left");
  });
});

describe("Apply: each reply in its own words", () => {
  it("409 applied: Your application is in.", async () => {
    server.routes["POST /api/trainer/apply"] = { status: 409, body: { status: "applied" } };
    await signIn();
    write("Gym floor.");
    await send();
    expect(screen.getByText("Your application is in.")).toBeTruthy();
    expect(screen.queryByText("Send application")).toBeNull();
  });

  it("409 denied inside 30 days: Not this time, with the date", async () => {
    const nextAt = new Date(2026, 10, 4, 12).toISOString();
    server.routes["POST /api/trainer/apply"] = { status: 409, body: { status: "denied", nextAt } };
    await signIn();
    write("Gym floor.");
    await send();
    expect(screen.getByText("Not this time. You can apply again from 4 Nov.")).toBeTruthy();
    expect(screen.queryByText("Send application")).toBeNull();
  });

  it("503 at the cap says paused; 503 before launch says not open; the form stays", async () => {
    server.routes["POST /api/trainer/apply"] = { status: 503, body: { error: "Applications are paused for now." } };
    await signIn();
    write("Gym floor.");
    await send();
    expect(status()).toBe("Applications are paused for now.");
    server.routes["POST /api/trainer/apply"] = { status: 503, body: { error: "Not open yet." } };
    await send();
    expect(status()).toBe("Not open yet.");
    expect(screen.getByLabelText("Where do you coach?").value).toBe("Gym floor.");
  });

  it("503 for any other reason (an outage after launch) says something went wrong, not not open", async () => {
    server.routes["POST /api/trainer/apply"] = { status: 503, body: { error: "Unavailable" } };
    await signIn();
    write("Gym floor.");
    await send();
    expect(status()).toBe(REPLY_COPY.wentWrong);
    expect(document.body.textContent).not.toContain("Not open yet.");
    expect(document.body.textContent).not.toContain("Unavailable");
    expect(screen.getByLabelText("Where do you coach?").value).toBe("Gym floor.");
  });

  it("the outcome replacing the form is a status, and takes focus from the gone Send button", async () => {
    server.routes["POST /api/trainer/apply"] = { status: 200, body: { ok: true, status: "applied" } };
    await signIn();
    write("Gym floor.");
    await send();
    const result = document.querySelector("[data-apply-result]");
    expect(result.getAttribute("role")).toBe("status");
    expect(result.textContent).toContain(APPLY_COPY.sent);
    expect(document.activeElement).toBe(result);
  });

  it("text the apply route would refuse is caught before any Face ID", async () => {
    await signIn();
    write("Gym\u0007 floor.");
    await send();
    expect(status()).toBe(APPLY_COPY.checkFields);
    write("Gym floor.", "ironworks.example/\u202Ecoach");
    await send();
    expect(status()).toBe(APPLY_COPY.badLink);
    const { authenticatePasskey } = await import("@/lib/webauthn");
    expect(authenticatePasskey).toHaveBeenCalledTimes(1);
    expect(posts("/api/trainer/apply")).toHaveLength(0);
  });

  it.each([
    ["403 trainer", { status: 403, body: { trainer: true } }],
    ["409 approved", { status: 409, body: { status: "approved" } }],
  ])("%s: already set up, back to sign-in", async (_, reply) => {
    server.routes["POST /api/trainer/apply"] = reply;
    await signIn();
    write("Gym floor.");
    await send();
    expect(screen.getByText("Sign in with Face ID")).toBeTruthy();
    expect(status()).toBe(APPLY_COPY.alreadyTrainer);
  });

  it("401: back to sign-in, and what was written is still there after", async () => {
    server.routes["POST /api/trainer/apply"] = { status: 401, body: { error: SERVER_TEXT } };
    await signIn();
    write("Gym floor.", "https://ironworks.example");
    await send();
    expect(screen.getByText("Sign in with Face ID")).toBeTruthy();
    expect(status()).toBe(APPLY_COPY.signInAgain);
    fireEvent.change(screen.getByLabelText("Your Heatwayve name"), { target: { value: "coachkim" } });
    fireEvent.click(screen.getByText("Sign in with Face ID"));
    await flush();
    expect(screen.getByLabelText("Where do you coach?").value).toBe("Gym floor.");
    expect(screen.getByLabelText("A link (optional)").value).toBe("https://ironworks.example");
  });

  it.each([
    ["400", { status: 400, body: { error: SERVER_TEXT } }, APPLY_COPY.checkFields],
    ["429", { status: 429, body: { error: SERVER_TEXT } }, "Too many tries. Wait a minute and try again."],
    ["500", { status: 500, body: { error: SERVER_TEXT } }, "Couldn't do that just now. Try again."],
    ["offline", "offline", "Couldn't reach Heatwayve. Try again."],
  ])("%s never shows the server's text", async (_, reply, words) => {
    server.routes["POST /api/trainer/apply"] = reply;
    await signIn();
    write("Gym floor.");
    await send();
    expect(status()).toBe(words);
    expect(document.body.textContent).not.toContain(SERVER_TEXT);
  });
});

describe("Apply: where it already stands, and the admin's path", () => {
  it("a session 403 carrying an open application shows it, with no form", async () => {
    server.routes["POST /api/trainer/session"] = { status: 403, body: { notTrainer: true, application: { status: "applied", at: 1 } } };
    await signIn();
    expect(screen.getByText("Your application is in.")).toBeTruthy();
    expect(screen.queryByText("Send application")).toBeNull();
  });

  it("a recent denial shows its date; a denial whose wait is over shows the form", async () => {
    const soon = Date.now() + 5 * 864e5;
    server.routes["POST /api/trainer/session"] = { status: 403, body: { notTrainer: true, application: { status: "denied", nextAt: soon } } };
    await signIn();
    expect(screen.getByText(deniedLine(soon))).toBeTruthy();
    cleanup();
    server.routes["POST /api/trainer/session"] = { status: 403, body: { notTrainer: true, application: { status: "denied", nextAt: Date.now() - 864e5 } } };
    await signIn();
    expect(screen.getByText("Send application")).toBeTruthy();
  });

  it("a needsTerms 403 names the trainer by the server's name too", async () => {
    server.routes["POST /api/trainer/session"] = { status: 403, body: { needsTerms: true, name: "Coach Kim" } };
    await signIn("COACHKIM");
    expect(screen.getByText("Agree with Face ID")).toBeTruthy();
    expect(screen.getByText(/see you as Coach Kim\.$/)).toBeTruthy();
  });

  it("the admin's 403 opens the upgrade and never posts an application", async () => {
    server.routes["POST /api/trainer/session"] = { status: 403, body: { notTrainer: true, admin: true, name: "Coach Kim" } };
    server.routes["POST /api/trainer/upgrade"] = { status: 403, body: { apply: true } };
    await signIn();
    expect(screen.getByText("Set me up as a trainer")).toBeTruthy();
    expect(screen.queryByText("Send application")).toBeNull();
    // An upgrade that says apply falls back to the Apply panel.
    fireEvent.click(screen.getByText("Set me up as a trainer"));
    await flush();
    expect(posts("/api/trainer/upgrade")).toHaveLength(1);
    expect(screen.getByText("Send application")).toBeTruthy();
    expect(posts("/api/trainer/apply")).toHaveLength(0);
  });
});

describe("TrainerView never shows the server's error text", () => {
  it.each([
    [429, "Too many tries. Wait a minute and try again."],
    [500, "Couldn't do that just now. Try again."],
    [401, "Face ID didn't go through. Try again."],
  ])("sign-in %s", async (code, words) => {
    server.routes["POST /api/trainer/session"] = { status: code, body: { error: SERVER_TEXT } };
    await signIn();
    expect(status()).toBe(words);
    expect(document.body.textContent).not.toContain(SERVER_TEXT);
  });

  it("sign-in offline", async () => {
    server.routes["POST /api/trainer/session"] = "offline";
    await signIn();
    expect(status()).toBe(REPLY_COPY.offline);
  });

  it("an invite that fails", async () => {
    server.routes["POST /api/trainer/clients"] = { status: 200, body: { me: { name: "Coach Kim" }, clients: [] } };
    server.routes["POST /api/trainer/invite"] = { status: 500, body: { error: SERVER_TEXT } };
    const { default: TrainerView } = await import("../../components/TrainerView.jsx");
    render(<TrainerView/>);
    await flush();
    await act(async () => { fireEvent.click(screen.getByText("Add a client")); });
    await flush();
    expect(within(screen.getByRole("dialog")).getByText("Couldn't do that just now. Try again.")).toBeTruthy();
    expect(document.body.textContent).not.toContain(SERVER_TEXT);
  });

  it("the source never renders a reply's error field", () => {
    const src = readFileSync(resolve(root, "components/TrainerView.jsx"), "utf8");
    // The one read classifies a 503; it is never shown.
    expect(src.match(/body\.error/g)).toHaveLength(1);
    expect(src).toMatch(/const said = String\(r\.body\.error/);
  });
});

describe("the apply copy helpers", () => {
  it("linkProblem: https only, 200 at most, empty is fine; a bare address reads as https", () => {
    expect(linkProblem("")).toBeNull();
    expect(linkProblem("  ")).toBeNull();
    expect(linkProblem("https://ironworks.example")).toBeNull();
    expect(linkProblem("ironworks.example/coach")).toBeNull();
    expect(linkToSend(" ironworks.example/coach ")).toBe("https://ironworks.example/coach");
    expect(linkToSend("https://ironworks.example")).toBe("https://ironworks.example");
    expect(linkProblem("http://ironworks.example")).toBe(APPLY_COPY.badLink);
    expect(linkProblem("https://user:pw@ironworks.example")).toBe(APPLY_COPY.badLink);
    expect(linkProblem("https://")).toBe(APPLY_COPY.badLink);
    expect(linkProblem("javascript:alert(1)")).toBe(APPLY_COPY.badLink);
    expect(linkProblem(`https://a.example/${"x".repeat(200)}`)).toBe(APPLY_COPY.badLink);
  });

  it("the limits and link rule are the apply route's own", () => {
    expect(ABOUT_MAX).toBe(rules.ABOUT_MAX);
    expect(LINK_MAX).toBe(rules.LINK_MAX);
    for (const v of ["", " ", "ironworks.example", "https://ironworks.example/a", "http://ironworks.example",
      "https://user@ironworks.example", "instagram", "https://a.example/\u202E", `https://a.example/${"x".repeat(190)}`]) {
      const server = rules.cleanLink(v);
      expect(linkProblem(v) === null).toBe(!("error" in server));
      if ("link" in server) expect(linkToSend(v)).toBe(server.link ?? "");
    }
    expect(aboutProblem("  ")).toBe(APPLY_COPY.needAbout);
    expect(aboutProblem("Gym floor.")).toBeNull();
    expect(aboutProblem("x".repeat(ABOUT_MAX + 1))).toBe(APPLY_COPY.checkFields);
  });

  it("deniedLine with no date says only Not this time.", () => {
    expect(deniedLine(undefined)).toBe("Not this time.");
    expect(deniedLine(new Date(2026, 10, 4, 12).getTime())).toBe("Not this time. You can apply again from 4 Nov.");
  });

  it("the Profile row's subline and the unseen decision", () => {
    expect(applyRowSub(null)).toBe("Set up as a trainer");
    expect(applyRowSub({ status: "withdrawn" })).toBe("Set up as a trainer");
    expect(applyRowSub({ status: "applied" })).toBe("Application sent");
    const now = Date.now();
    expect(applyRowSub({ status: "denied", nextAt: now + 864e5 }, now)).toBe("Not this time");
    expect(applyRowSub({ status: "denied", nextAt: new Date(now + 864e5).toISOString() }, now)).toBe("Not this time");
    // Once the 30 days are over the row offers Apply again, as /trainer does.
    expect(applyRowSub({ status: "denied", nextAt: now - 1 }, now)).toBe("Set up as a trainer");
    expect(applyRowSub({ status: "denied", nextAt: null }, now)).toBe("Set up as a trainer");
    expect(decisionUnseen({ status: "denied", seen: false })).toBe(true);
    expect(decisionUnseen({ status: "approved", seen: false })).toBe(true);
    expect(decisionUnseen({ status: "denied", seen: true })).toBe(false);
    expect(decisionUnseen({ status: "applied", seen: false })).toBe(false);
    expect(decisionUnseen(null)).toBe(false);
  });
});
