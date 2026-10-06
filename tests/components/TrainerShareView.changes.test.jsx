// @vitest-environment jsdom
// TrainerShareView: the trainer's changes to the client's plan. Each shows what
// it was before and where it stands; Undo is one tap while it waits or sits in
// the plan; the list marks the notice seen; the changes switch is off in one tap
// and on with Face ID. The page never writes the plan itself.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";

const { router, server } = vi.hoisted(() => ({
  router: { replace: vi.fn(), back: vi.fn(), push: vi.fn() },
  server: { status: /** @type {any} */ (null), posts: /** @type {any[]} */ ([]), reply: /** @type {any} */ (null), after: /** @type {any} */ (null) },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/webauthn", () => ({ authenticatePasskey: vi.fn(async () => null) }));
vi.mock("@/lib/net", () => ({
  fetchWithTimeout: vi.fn(async (url, opts) => {
    if (opts?.method === "POST") {
      const body = JSON.parse(opts.body);
      server.posts.push(body);
      if (body.seenChanges) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      const [code, out] = server.reply || [200, { ok: true }];
      if (server.after) server.status = server.after(server.status, body);
      return { ok: code === 200, status: code, json: async () => out };
    }
    return { ok: true, status: 200, json: async () => server.status };
  }),
}));

import TrainerShareView from "../../components/TrainerShareView.jsx";
import { P } from "@/lib/storage";
import { authenticatePasskey } from "@/lib/webauthn";
import { SHARE_CONSENT_VERSION } from "@/lib/trainer-terms";

const NOW = Date.parse("2026-10-14T09:00:00Z");
const DAY = 86_400_000;
const S1 = "hws_" + "a".repeat(26);
const S2 = "hws_" + "b".repeat(26);
const SQUAT = "Barbell Back Squat";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  Object.assign(server, { status: null, posts: [], reply: null, after: null });
});

const sharing = (over = {}) => ({
  ref: "hwg_abc", name: "Jo", since: Date.parse("2026-09-03T12:00:00Z"), live: true,
  consentVersion: SHARE_CONSENT_VERSION, looks: [], lookCount: 0, ...over,
});
const change = (over = {}) => ({
  id: `${S1}.0`, set: S1, kind: "weight", target: SQUAT, before: 102.5, after: 105, from: null,
  status: "waiting", reason: null, date: null, at: NOW - DAY, undoable: true, warnings: [], by: "Jo", ...over,
});
const status = (over = {}) => ({ open: true, trainerOpen: false, trainer: false, sharing: sharing(), ended: null,
  edits: { on: true, since: NOW - 30 * DAY }, changes: [], ...over });

async function renderView() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  P.setActive("sam");
  await act(async () => { render(<TrainerShareView />); });
}
const posts = () => server.posts.filter((p) => !p.seenChanges);
const rowOf = (text) => screen.getByText(text).closest("li");

describe("the list", () => {
  it("groups by set, says what changed and where it stands, with warnings in words", async () => {
    server.status = status({ changes: [
      change({ id: `${S2}.0`, set: S2, at: NOW - DAY, warnings: ["big_drop", "nonsense"], kind: "weight", before: 120, after: 100, target: "Barbell Deadlift" }),
      change({ id: `${S2}.1`, set: S2, at: NOW - DAY, kind: "reps", target: "DB Reverse Lunge", before: "8/leg", after: "10/leg", status: "in_force" }),
      change({ id: `${S1}.0`, at: NOW - 3 * DAY, status: "trained_yours", date: "2026-10-12", undoable: false }),
      change({ id: `${S1}.1`, at: NOW - 3 * DAY, kind: "mainLift", target: SQUAT, before: SQUAT, after: "Front Squat", status: "not_applied", reason: "superseded", undoable: false }),
      change({ id: `${S1}.2`, at: NOW - 3 * DAY, target: "Barbell Bench Press", before: null, after: 60, status: "withdrawn", undoable: false }),
    ] });
    await renderView();
    expect(screen.getByRole("heading", { name: "Changes from Jo" })).toBeTruthy();
    const sets = screen.getAllByRole("region", { name: /^Sent/ });
    expect(sets.map((s) => s.getAttribute("aria-label"))).toEqual(["Sent 13 Oct", "Sent 11 Oct"]);
    expect(within(rowOf("Barbell Deadlift · 100 kg, was 120")).getByText("Next time you open the app")).toBeTruthy();
    expect(within(rowOf("Barbell Deadlift · 100 kg, was 120")).getByText("A big drop from your last top set.")).toBeTruthy();
    expect(within(rowOf("DB Reverse Lunge · 10 reps a leg, was 8")).getByText("In your plan")).toBeTruthy();
    expect(within(rowOf("Barbell Back Squat · 105 kg, was 102.5")).getByText("You trained at it, 12 Oct")).toBeTruthy();
    expect(within(rowOf("Main lift · Front Squat, was Barbell Back Squat")).getByText("You trained before it arrived")).toBeTruthy();
    expect(within(rowOf("Barbell Bench Press · 60 kg")).getByText("Withdrawn by Jo")).toBeTruthy();
    // Undo only where it can be undone; Undo all on a set with more than one.
    expect(screen.getAllByRole("button", { name: /^Undo (?!all$)/ }).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Undo Barbell Deadlift · 100 kg, was 120", "Undo DB Reverse Lunge · 10 reps a leg, was 8",
    ]);
    expect(within(sets[0]).getByText("Undo all")).toBeTruthy();
    expect(within(sets[1]).queryByText("Undo all")).toBeNull();
    // Server words never show: an unknown warning code says nothing.
    expect(document.body.textContent).not.toContain("nonsense");
  });

  it("with changes on, the live line says what they see and can change; off, that they can't", async () => {
    server.status = status();
    await renderView();
    const sees = () => [...screen.getByRole("list", { name: "What Jo sees" }).querySelectorAll("li")].map((li) => li.textContent);
    expect(sees()).toEqual([
      "Your sessions, sets, RPE and how you felt, from the last 24 weeks.",
      "Your main-lift trend and bests over the last 12 months.",
      "On their client list: when you last trained, your sessions this week against your plan, and your 28-day rhythm.",
      "Your current working weights, reps and main lifts for every lift in your programme, whether you're on a deload, and your planned week up to 4 weeks ahead.",
      "Each lift's most recent top set, however long ago. It keeps their changes within safe limits.",
      "They can change your working weights, reps and main lifts from your next session on, within the app's limits.",
    ]);
    cleanup();
    server.status = status({ edits: { on: false, since: null } });
    await renderView();
    expect(sees()).toEqual([
      "Your sessions, sets, RPE and how you felt, from the last 24 weeks.",
      "Your main-lift trend and bests over the last 12 months.",
      "On their client list: when you last trained, your sessions this week against your plan, and your 28-day rhythm.",
      "Can't change your plan.",
    ]);
    expect(document.body.textContent).not.toMatch(/read only/i);
  });

  it("a stopped change says why; a week in the plan offers no Undo here", async () => {
    server.status = status({ edits: { on: false, since: null }, changes: [
      change({ status: "not_applied", reason: "stopped", undoable: false }),
      change({ id: `${S1}.1`, kind: "week", target: "week", before: null, after: [], from: "2026-10-12", status: "in_force", undoable: true }),
    ] });
    await renderView();
    expect(screen.getByText("Changes were off")).toBeTruthy();
    expect(screen.getByText("Your week from Mon 12 Oct")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo / })).toBeNull();
  });

  it("why a change never arrived comes from the change, not from the switch as it is now", async () => {
    const stopped = (over) => change({ status: "not_applied", reason: "stopped", undoable: false, ...over });
    // Changes went off, then back on: a change cancelled on this share still reads as changes off.
    server.status = status({ edits: { on: true, since: NOW - DAY / 2 }, changes: [stopped({ at: NOW - DAY })] });
    await renderView();
    expect(within(rowOf("Barbell Back Squat · 105 kg, was 102.5")).getByText("Changes were off")).toBeTruthy();
    cleanup();
    // The same trainer, re-added with a fresh code: a change from the earlier share ended when that sharing stopped,
    // even with changes off on this one.
    server.status = status({ sharing: sharing({ since: NOW - 2 * DAY }), edits: { on: false, since: null },
      changes: [stopped({ at: NOW - 5 * DAY })] });
    await renderView();
    expect(within(rowOf("Barbell Back Squat · 105 kg, was 102.5")).getByText("Sharing stopped")).toBeTruthy();
    cleanup();
    // No share now: sharing stopped.
    server.status = status({ sharing: null, edits: null, changes: [stopped()] });
    await renderView();
    expect(within(rowOf("Barbell Back Squat · 105 kg, was 102.5")).getByText("Sharing stopped")).toBeTruthy();
    cleanup();
    // This share, paused.
    server.status = status({ sharing: sharing({ live: false }), changes: [stopped()] });
    await renderView();
    expect(within(rowOf("Barbell Back Squat · 105 kg, was 102.5")).getByText("Sharing paused")).toBeTruthy();
  });

  it("after sharing ends, changes still show and those in the plan can still be undone", async () => {
    server.status = status({ sharing: null, edits: null, changes: [change({ status: "in_force" })] });
    await renderView();
    expect(screen.getByRole("heading", { name: "Changes to your plan" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo Barbell Back Squat · 105 kg, was 102.5" })).toBeTruthy();
  });

  it("marks the notice seen once the list shows, and never with nothing to show", async () => {
    server.status = status({ changes: [change()] });
    await renderView();
    expect(server.posts).toEqual([{ profile: "sam", seenChanges: true }]);
    cleanup();
    server.posts = [];
    server.status = status();
    await renderView();
    expect(server.posts).toEqual([]);
  });
});

describe("Undo", () => {
  it("is one tap: one POST naming the change, no dialog, then says what happens; the plan on this device is untouched", async () => {
    P.saveWeights("sam", { [SQUAT]: 105 });
    const confirm = vi.spyOn(window, "confirm");
    server.status = status({ changes: [change({ status: "in_force" })] });
    server.reply = [200, { ok: true, undone: [`${S1}.0`] }];
    server.after = (s) => ({ ...s, changes: s.changes.map((c) => ({ ...c, status: "undone", undoable: false })) });
    await renderView();
    const before = JSON.stringify({ ...localStorage });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo Barbell Back Squat · 105 kg, was 102.5" })); });
    expect(confirm).not.toHaveBeenCalled();
    expect(posts()).toEqual([{ profile: "sam", undo: `${S1}.0` }]);
    const line = screen.getByText("Undone. Back to 102.5 kg next time you open the app.");
    expect(line.getAttribute("role")).toBe("status");
    expect(document.activeElement).toBe(line);
    expect(within(rowOf("Barbell Back Squat · 105 kg, was 102.5")).getByText("Undone")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo / })).toBeNull();
    // The app puts it back on its next pull; this page writes nothing on the device.
    expect(JSON.stringify({ ...localStorage })).toBe(before);
  });

  it("a waiting change: it won't change the plan", async () => {
    server.status = status({ changes: [change()] });
    server.reply = [200, { ok: true, undone: [`${S1}.0`] }];
    await renderView();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Undo / })); });
    expect(screen.getByText("Undone. It won't change your plan.")).toBeTruthy();
  });

  it("a weight or reps they never had: the number stays until their next session, never \"goes back\"; this page writes nothing", async () => {
    const undoOne = async (c) => {
      server.status = status({ changes: [c] });
      server.reply = [200, { ok: true, undone: [c.id] }];
      await renderView();
      const before = JSON.stringify({ ...localStorage });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Undo / })); });
      expect(JSON.stringify({ ...localStorage })).toBe(before);
    };
    const HELD = "Undone. The number stays until your next session changes it.";
    // A lift with a template weight is held all the same: nothing is put in its place.
    await undoOne(change({ status: "in_force", before: null }));
    expect(screen.getByText(HELD)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/goes back|go back|starting weight/);
    cleanup();
    P.setMainLift("sam", SQUAT, "Front Squat");
    await undoOne(change({ status: "in_force", before: null, target: "Front Squat" }));
    expect(screen.getByText(HELD)).toBeTruthy();
    cleanup();
    await undoOne(change({ status: "in_force", kind: "reps", before: null, after: 8 }));
    expect(screen.getByText(HELD)).toBeTruthy();
    cleanup();
    // With a number to go back to, the line names it, as before.
    await undoOne(change({ status: "in_force" }));
    expect(screen.getByText("Undone. Back to 102.5 kg next time you open the app.")).toBeTruthy();
  });

  it("Undo all sends the set and says the plan goes back", async () => {
    server.status = status({ changes: [change({ status: "in_force" }), change({ id: `${S1}.1`, target: "Barbell Bench Press", before: 80, after: 82.5, status: "in_force" })] });
    server.reply = [200, { ok: true, undone: [`${S1}.0`, `${S1}.1`] }];
    await renderView();
    await act(async () => { fireEvent.click(screen.getByText("Undo all")); });
    expect(posts()).toEqual([{ profile: "sam", undo: S1 }]);
    expect(screen.getByText("Undone. Your plan goes back next time you open the app.")).toBeTruthy();
  });

  it("Undo all with a held row says numbers they had go back and a first weight stays; all held, that they stay", async () => {
    const undoAll = async (rows) => {
      server.status = status({ changes: rows });
      server.reply = [200, { ok: true, undone: rows.map((r) => r.id) }];
      await renderView();
      const before = JSON.stringify({ ...localStorage });
      await act(async () => { fireEvent.click(screen.getByText("Undo all")); });
      expect(JSON.stringify({ ...localStorage })).toBe(before);
    };
    const MIXED = "Undone. Numbers you had before go back next time you open the app. A first weight stays until your next session changes it.";
    const bench = { id: `${S1}.1`, target: "Barbell Bench Press", before: 80, after: 82.5, status: "in_force" };
    const repsNew = { id: `${S1}.2`, kind: "reps", before: null, after: 8, status: "in_force" };
    // One restored, one held (reps they never set).
    await undoAll([change({ ...bench, id: `${S1}.0` }), change(repsNew)]);
    expect(screen.getByText(MIXED)).toBeTruthy();
    cleanup();
    // One restored, one first weight.
    await undoAll([change({ ...bench }), change({ status: "in_force", before: null })]);
    expect(screen.getByText(MIXED)).toBeTruthy();
    cleanup();
    // All held: nothing goes back, so the line never says it does.
    await undoAll([change({ status: "in_force", before: null }), change(repsNew)]);
    expect(screen.getByText("Undone. These numbers stay until your next session changes them.")).toBeTruthy();
    expect(screen.queryByText(MIXED)).toBeNull();
    cleanup();
    // A waiting row changes nothing: one live held row reads as the single line.
    await undoAll([change({ ...bench, status: "waiting" }), change(repsNew)]);
    expect(screen.getByText("Undone. The number stays until your next session changes it.")).toBeTruthy();
  });

  it("refused (trained at since) or offline: says so in its own words", async () => {
    server.status = status({ changes: [change({ status: "in_force" })] });
    server.reply = [409, { error: "SERVER-WORDS" }];
    await renderView();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Undo / })); });
    expect(screen.getByText("That can't be undone now. You've trained at it since, or it was already changed.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SERVER-WORDS");
  });
});

describe("the changes switch", () => {
  it("on: one tap turns it off, with no Face ID", async () => {
    server.status = status();
    server.after = (s) => ({ ...s, edits: { on: false, since: null } });
    await renderView();
    await act(async () => { fireEvent.click(screen.getByText("Stop Jo changing your plan")); });
    expect(authenticatePasskey).not.toHaveBeenCalled();
    expect(posts()).toEqual([{ profile: "sam", edits: false }]);
    expect(screen.getByText("Jo can't change your plan now. Anything not in it yet won't arrive.")).toBeTruthy();
    expect(screen.getByText("Let Jo change your plan")).toBeTruthy();
    expect(screen.getByText(/Can't change your plan\.$/)).toBeTruthy();
  });

  it("off: Face ID first, then on; a cancelled Face ID sends nothing", async () => {
    server.status = status({ edits: { on: false, since: null } });
    await renderView();
    await act(async () => { fireEvent.click(screen.getByText("Let Jo change your plan")); });
    expect(authenticatePasskey).toHaveBeenCalledWith("sam", { quiet: true });
    expect(posts()).toEqual([]);
    vi.mocked(authenticatePasskey).mockResolvedValueOnce({ authToken: "cer" });
    server.after = (s) => ({ ...s, edits: { on: true, since: NOW } });
    await act(async () => { fireEvent.click(screen.getByText("Let Jo change your plan")); });
    expect(posts()).toEqual([{ profile: "sam", edits: true, authToken: "cer" }]);
    expect(screen.getByText("Jo can change your plan now. Every change shows here.")).toBeTruthy();
    expect(screen.getByText("Stop Jo changing your plan")).toBeTruthy();
  });

  it("a share from before changes existed asks for a fresh code instead of offering the switch", async () => {
    server.status = status({ sharing: sharing({ consentVersion: "2026-10" }), edits: { on: false, since: null } });
    await renderView();
    expect(screen.getByText("Ask Jo for a fresh code to let them change your plan.")).toBeTruthy();
    expect(screen.queryByText("Let Jo change your plan")).toBeNull();
  });

  it("the server says a fresh code is needed: says so", async () => {
    server.status = status({ edits: { on: false, since: null } });
    server.reply = [409, { fresh: true }];
    vi.mocked(authenticatePasskey).mockResolvedValueOnce({ authToken: "cer" });
    await renderView();
    await act(async () => { fireEvent.click(screen.getByText("Let Jo change your plan")); });
    expect(screen.getAllByText("Ask Jo for a fresh code to let them change your plan.")).toHaveLength(1);
  });

  it("no switch on a paused share, or with no live grant", async () => {
    server.status = status({ sharing: sharing({ live: false }) });
    await renderView();
    expect(screen.queryByText(/changing your plan|change your plan$/)).toBeNull();
    cleanup();
    server.status = status({ edits: null });
    await renderView();
    expect(screen.queryByText("Stop Jo changing your plan")).toBeNull();
    expect(screen.queryByText("Let Jo change your plan")).toBeNull();
  });
});
