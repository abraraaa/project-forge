// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// TrainerClientView: one client's training as their trainer sees it, built
// from the real projection (projectForTrainer) of a generated history.
//
// Locks in:
//   - "How they felt" and every session's readiness word always show;
//   - sessions page by 10, newest first;
//   - a record from the trend tier (day 200) is never listed as a session;
//   - set lines: "100 × 5, 5, 5 · RPE 8, 8, 8.5", RIR when RPE is missing,
//     bodyweight as reps or proven added kg;
//   - 24 rhythm cells, the oldest 16 behind the narrow disclosure;
//   - a breather shows as paused, never its reason; a cell's note never
//     breaks inside a word; a travel session says so, and "Away" never shows;
//   - "Stop seeing" asks first, then hands back to the dashboard;
//   - the trainer's own training (self): titled You, no sharing date, no
//     last look, nothing to stop;
//   - the source never imports sessionCount or the device store;
//   - a read-only grant says the client can turn changes on in Profile;
//   - the plan (a client with the trainer's changes on): rows by session
//     with last, next and a waiting change; the lift sheet steps over the
//     implement's rungs inside the validator's bounds, with Hold, Step, Jump
//     and Ease; reps only for bodyweight, seconds for a timed hold; a deload
//     blocks weight and says when; every change goes through the dry run
//     (the real validator behind a fake route) before Send, and the send
//     carries the same set id and ops; refusals, a stale view, Face ID and
//     the weekly limit each say so in the pane's words, never the server's;
//     "Your changes" by set, in the trainer's words, with Withdraw where it
//     still can be taken back, and "Withdraw all" only when the set id
//     reaches nothing they trained at; seconds step on the five-second grid;
//     a lift with no weight yet starts empty; Refresh reports the reload;
//     a never-lifted load names the cold-start cap, the same in the sheet
//     and a refusal; a withdraw that reaches nothing says so; the reps
//     stepper starts inside its range.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import TrainerClientView, { setsLine, rhythmCellText, refusalText, noHistoryText, leadLine, warningText } from "../../components/TrainerClientView.jsx";
import { projectForTrainer } from "../../lib/trainer-plan.js";
import { addDaysIso, todayLocalIso } from "../../lib/dates.js";
import { auditHistoryVolume } from "../../lib/volume-audit.js";
import { validateChangeSet, SET_ID_RE, MAX_KG, REP_LIMITS, TIMED_SECONDS, WEEK_JUMP_FRACTION, BIG_DROP_FRACTION } from "../../lib/trainer-change.js";
import { EFFECTIVE_REP_BAND } from "../../lib/rep-band.js";

afterEach(cleanup);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const today = todayLocalIso();
// A fixed mid-week Wednesday for the cell-note test: on a Sunday no "so far" cell exists.
const MIDWEEK = "2026-09-30";
const ago = (n) => addDaysIso(today, -n);

const squat = (weight, reps = [5, 5, 5], rpe = [8, 8, 8.5]) => ({
  name: "Barbell Back Squat", muscle: "Quads", loadType: "barbell",
  sets: reps.map((r, i) => ({ weight, reps: r, rpe: rpe[i] ?? null, rir: 2, loadType: "barbell", effectiveLoad: weight, est1rm: 1 })),
});

function rec(daysAgo, { readiness = "normal", weight = 100, letter = "A", extra = [], travel } = {}) {
  const date = ago(daysAgo);
  return {
    v: 2, id: `${date}T07:13:42.000Z`, date, readiness, session: `strength ${letter}`, scheduledLetter: letter,
    ...(travel ? { travel: true } : null),
    blocks: [
      { id: "main", type: "main", exercises: [squat(weight)] },
      ...(extra.length ? [{ id: "acc", type: "accessory", exercises: extra }] : []),
    ],
  };
}

// 25 sessions in the detail tier (every 6 days), one at day 200 (trend tier
// only) with a weight nothing else uses, one past 12 months.
function history() {
  const out = [];
  for (let i = 0; i < 25; i++) {
    out.push(rec(1 + i * 6, {
      readiness: ["fresh", "normal", "cooked"][i % 3],
      weight: 100 + (i % 4) * 2.5,
      letter: "ABC"[i % 3],
    }));
  }
  out.push(rec(200, { weight: 137.5 }));
  out.push(rec(400, { weight: 150 }));
  return out;
}

const view = (hist = history(), meta = {}) => projectForTrainer({ meta, history: hist }, { todayIso: today });
const client = { name: "Sam", since: Date.UTC(2026, 9, 3, 12) };

describe("TrainerClientView", () => {
  it("always shows how they felt, and every session's readiness word", () => {
    const hist = history();
    hist[0].readiness = null; // the newest session has no check-in
    render(<TrainerClientView client={client} view={view(hist)}/>);
    expect(screen.getByText("How they felt")).toBeTruthy();
    const felt = screen.getByText("How they felt").parentElement;
    expect(felt.textContent).toMatch(/Fresh \d+ · Normal \d+ · Cooked \d+/);
    const rows = document.querySelectorAll("[data-session]");
    expect(rows.length).toBe(10);
    const heads = [...rows].map((r) => r.firstChild.textContent);
    expect(heads[0]).toMatch(/· Readiness not logged$/);
    for (const h of heads.slice(1)) expect(h).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2} · [ABC] · (Fresh|Normal|Cooked)$/);
  });

  it("pages sessions by 10, newest first", () => {
    render(<TrainerClientView client={client} view={view()}/>);
    const dates = () => [...document.querySelectorAll("[data-session]")].map((r) => r.getAttribute("data-session"));
    expect(dates()).toHaveLength(10);
    expect(dates()[0]).toBe(ago(1));
    expect([...dates()].sort().reverse()).toEqual(dates());
    fireEvent.click(screen.getByText("Show earlier"));
    expect(dates()).toHaveLength(20);
    fireEvent.click(screen.getByText("Show earlier"));
    expect(dates()).toHaveLength(25);
    expect(screen.queryByText("Show earlier")).toBeNull();
  });

  it("lists a day-200 record in no session row, though the trend tier holds it", () => {
    const v = view();
    expect(v.tops.map((t) => t.date)).toContain(ago(200));
    render(<TrainerClientView client={client} view={v}/>);
    let more;
    while ((more = screen.queryByText("Show earlier"))) fireEvent.click(more);
    const rows = [...document.querySelectorAll("[data-session]")];
    expect(rows).toHaveLength(25);
    expect(rows.map((r) => r.getAttribute("data-session"))).not.toContain(ago(200));
    for (const r of rows) expect(r.textContent).not.toContain("137.5");
    // It is still a point on the 12-month line, and the best.
    expect(document.querySelector('[data-section="lifts"]').textContent).toContain("137.5 × 5");
    // Nothing from past 12 months anywhere.
    expect(document.body.textContent).not.toContain("150 ×");
  });

  it("writes set lines with RPE, RIR when RPE is missing, and bodyweight as reps or proven added kg", () => {
    expect(setsLine(squat(100))).toBe("100 × 5, 5, 5 · RPE 8, 8, 8.5");
    expect(setsLine({ name: "Romanian Deadlift", loadType: "barbell", sets: [{ weight: 80, reps: 10, rpe: null, rir: 2 }, { weight: 80, reps: 10, rpe: null, rir: 1 }] }))
      .toBe("80 × 10, 10 · RIR 2, 1");
    expect(setsLine({ name: "Push-up", loadType: "bodyweight", sets: [{ weight: 0, reps: 12 }, { weight: 0, reps: 10 }, { weight: 0, reps: 9 }] }))
      .toBe("12, 10, 9");
    expect(setsLine({ name: "Dip", loadType: "bodyweight", sets: [{ weight: 10, reps: 8 }, { weight: 10, reps: 8 }] }))
      .toBe("+10 kg × 8, 8");

    // Through the projection: a stale working weight on a bodyweight set
    // ships as 0 and reads as reps; proven added kg reads as "+10 kg".
    const hist = history();
    hist[0].blocks[1] = { id: "acc", type: "accessory", exercises: [
      { name: "Push-up", muscle: "Chest", loadType: "bodyweight", sets: [12, 10, 9].map((r) => ({ weight: 20, reps: r, bodyweightUsed: 80, effectiveLoad: 80 })) },
      { name: "Dip", muscle: "Chest", loadType: "bodyweight", sets: [8, 8].map((r) => ({ weight: 10, reps: r, bodyweightUsed: 80, effectiveLoad: 90 })) },
      { name: "Romanian Deadlift", muscle: "Hamstrings", loadType: "barbell", sets: [{ weight: 80, reps: 10, rpe: null, rir: 2 }] },
    ] };
    render(<TrainerClientView client={client} view={view(hist)}/>);
    const newest = document.querySelector("[data-session]");
    expect(newest.textContent).toContain("Barbell Back Squat · 100 × 5, 5, 5 · RPE 8, 8, 8.5");
    expect(newest.textContent).toContain("Push-up · 12, 10, 9");
    expect(newest.textContent).toContain("Dip · +10 kg × 8, 8");
    expect(newest.textContent).toContain("Romanian Deadlift · 80 × 10 · RIR 2");
  });

  it("shows 24 rhythm cells, the oldest 16 behind the narrow disclosure", () => {
    render(<TrainerClientView client={client} view={view()}/>);
    const list = document.querySelector("ol.forge-wide-rhythm");
    const cells = list.querySelectorAll("li");
    expect(cells).toHaveLength(24);
    expect(list.querySelectorAll("li.forge-wide-rhythm-early")).toHaveLength(16);
    expect([...cells].slice(16).every((c) => !c.classList.contains("forge-wide-rhythm-early"))).toBe(true);
    // Oldest first; the current week reads "… so far".
    const weeks = [...cells].map((c) => c.getAttribute("data-week"));
    expect([...weeks].sort()).toEqual(weeks);
    expect(cells[23].textContent).toMatch(/\d+ of \d+ so far/);
    expect(list.hasAttribute("data-earlier")).toBe(false);
    fireEvent.click(screen.getByText("Earlier weeks"));
    expect(list.hasAttribute("data-earlier")).toBe(true);
    expect(screen.getByText("Fewer weeks").closest("button").getAttribute("aria-expanded")).toBe("true");
  });

  it("words rhythm cells in house copy", () => {
    const w = { planned: 3, plannedSoFar: 3, plannedResting: 0, done: 2, partial: false };
    expect(rhythmCellText(w)).toBe("2/3");
    expect(rhythmCellText({ ...w, partial: true, plannedSoFar: 2, done: 1 })).toBe("1 of 2 so far");
    expect(rhythmCellText({ ...w, planned: 0, plannedResting: 3, done: 0 })).toBe("paused");
    expect(rhythmCellText({ ...w, planned: 1, plannedResting: 2, done: 1 })).toBe("1/1 · part paused");
  });

  it("a rhythm cell's note breaks between words only, never inside one", () => {
    const meta = { breaks: [{ id: "b1", start: "2026-08-31", endedAt: "2026-09-14", reason: "injured" }] };
    render(<TrainerClientView client={client} view={projectForTrainer({ meta, history: history() }, { todayIso: MIDWEEK })}/>);
    const notes = [...document.querySelectorAll("ol.forge-wide-rhythm li > span[aria-hidden] > span")]
      .filter((n) => /^(so far|paused|part paused)$/.test(n.textContent));
    expect(notes.map((n) => n.textContent)).toEqual(expect.arrayContaining(["so far", "paused"]));
    for (const n of notes) {
      expect(n.style.overflowWrap).toBe("");
      expect(n.getAttribute("style")).not.toMatch(/overflow-wrap|word-break/);
    }
  });

  it("marks a travel session as one, and never says Away", () => {
    const hist = history();
    hist[0] = rec(1, { travel: true });
    const meta = { breaks: [{ id: "b1", start: ago(40), endedAt: ago(34), reason: "travelling" }] };
    render(<TrainerClientView client={client} view={view(hist, meta)}/>);
    const rows = [...document.querySelectorAll("[data-session]")];
    expect(rows[0].textContent).toContain("Travel session");
    expect(rows.filter((r) => r.textContent.includes("Travel session"))).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/\bAway\b/i);
    expect(document.body.textContent).not.toMatch(/travelling/i);
  });

  it("shows a breather as paused, never why", () => {
    const meta = { breaks: [{ id: "b1", start: ago(3), endedAt: null, reason: "injured" }] };
    render(<TrainerClientView client={client} view={view(history(), meta)}/>);
    expect(screen.getByText("On a breather")).toBeTruthy();
    expect(screen.getByText("Paused for now. Their numbers are holding.")).toBeTruthy();
    expect(document.body.textContent.toLowerCase()).not.toMatch(/injur|ill\b|away|travelling/);
  });

  it("names muscles under minimum only when flagged, at most three", () => {
    const v = view();
    // The fixture trains squats only, so well over three muscles are flagged.
    const flagged = Object.values(auditHistoryVolume(v.sessions, { weeks: 2 }).perMuscle)
      .filter((m) => m?.status === "under_mev");
    expect(flagged.length).toBeGreaterThan(3);
    render(<TrainerClientView client={client} view={v}/>);
    const under = document.querySelector('[data-section="under"]');
    expect(under).toBeTruthy();
    expect(under.textContent).toMatch(/: under minimum, last 2 weeks$/);
    const named = under.textContent.replace(/^Under minimum/, "").split(":")[0].split(", ");
    expect(named).toHaveLength(3);
    cleanup();
    // Nothing in the last two weeks: nothing is flagged, so no section.
    render(<TrainerClientView client={client} view={view(history().filter((r) => r.date < ago(14)))}/>);
    expect(document.querySelector('[data-section="under"]')).toBeNull();
  });

  it("shows each main lift's best in 12 months and the last top set", () => {
    render(<TrainerClientView client={client} view={view()}/>);
    const lifts = document.querySelector('[data-section="lifts"]');
    expect(within(lifts).getAllByText("Barbell Back Squat").length).toBeGreaterThan(0);
    expect(lifts.textContent).toMatch(/Best in 12 months: [\d.]+ kg e1RM · 137\.5 × 5 · \d{1,2} [A-Z][a-z]{2}/);
    expect(lifts.textContent).toMatch(/Last top set: [\d.]+ × 5/);
    expect(lifts.textContent).toContain("25 sessions in the last 24 weeks");
  });

  it("header: name, sharing since, and when the trainer last looked", () => {
    const now = Date.UTC(2026, 9, 5, 12);
    render(<TrainerClientView client={client} view={view()} lastLooked={now - 2 * 86_400_000} now={now}/>);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sam");
    expect(screen.getByText("Read only. Sam can let you change their plan in Profile. Sessions from the last 24 weeks; main lifts over 12 months.")).toBeTruthy();
    expect(document.body.textContent).toContain("Sharing since 3 Oct · You last looked 2 days ago");
  });

  it("falls back to 'Your client' with no name", () => {
    render(<TrainerClientView client={{ name: null }} view={view()}/>);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your client");
    expect(screen.getByText("Read only. They can stop sharing any time.")).toBeTruthy();
  });

  it("asks before it stops seeing a client, then hands back", async () => {
    const onRemove = vi.fn(async () => true);
    render(<TrainerClientView client={client} view={view()} onRemove={onRemove}/>);
    expect(screen.getByText("Read only. Sam can stop sharing any time.")).toBeTruthy();
    fireEvent.click(screen.getByText("Stop seeing Sam's training"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Stop seeing Sam's training?")).toBeTruthy();
    expect(within(dialog).getByText("They'll see you ended it. To see it again, they'd approve a new code.")).toBeTruthy();
    fireEvent.click(within(dialog).getByText("Keep"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Stop seeing Sam's training"));
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByText("Stop")); });
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the sheet open and says so when stopping didn't go through", async () => {
    const onRemove = vi.fn(async () => false);
    render(<TrainerClientView client={client} view={view()} onRemove={onRemove}/>);
    fireEvent.click(screen.getByText("Stop seeing Sam's training"));
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByText("Stop")); });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("status").textContent).toBe("Couldn't stop that just now. Try again.");
    fireEvent.click(within(dialog).getByText("Keep"));
    fireEvent.click(screen.getByText("Stop seeing Sam's training"));
    expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe("");
  });

  it("for the trainer's own training: titled You, no sharing date, no last look, nothing to stop", () => {
    const now = Date.UTC(2026, 9, 5, 12);
    render(<TrainerClientView self client={{ name: "Coach Kim", since: Date.UTC(2026, 8, 1) }} view={view()}
      lastLooked={now - 86_400_000} now={now} onRemove={vi.fn()}/>);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("You");
    expect(screen.getByText("Your training")).toBeTruthy();
    const text = document.body.textContent;
    expect(text).not.toContain("Sharing since");
    expect(text).not.toContain("You last looked");
    expect(text).not.toContain("Shared with you");
    expect(text).not.toMatch(/Stop seeing|can stop sharing/);
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
    expect(screen.getByText("How you felt")).toBeTruthy();
    expect(screen.queryByText("How they felt")).toBeNull();
    // The training itself shows as for any client.
    expect(document.querySelectorAll("[data-session]").length).toBe(10);
  });

  it("never imports sessionCount or the device store", () => {
    const src = readFileSync(resolve(root, "components/TrainerClientView.jsx"), "utf8");
    expect(src).not.toMatch(/sessionCount/);
    expect(src).not.toMatch(/lib\/storage/);
    expect(src).not.toMatch(/getActive\(|localStorage|sessionStorage|indexedDB|dangerouslySetInnerHTML/);
    expect(src).not.toMatch(/PerformanceLab/);
  });
});

// ── The plan ────────────────────────────────────────────────────────────────

const bench = (weight) => ({
  name: "Barbell Bench Press", muscle: "Chest", loadType: "barbell",
  sets: [5, 5, 5].map((r) => ({ weight, reps: r, rpe: 8, loadType: "barbell", effectiveLoad: weight })),
});

// Squat last at 100 (W 102.5), bench at 60: the validator's limits for the
// squat are 65 to 110 on the 1.25 kg grid.
function planData(meta = {}) {
  const history = [];
  for (let i = 0; i < 6; i++) {
    const letter = "ABC"[i % 3];
    const date = ago(1 + i * 2);
    history.push({ v: 2, id: `${date}T07:00:00.000Z`, date, readiness: "normal", session: `strength ${letter}`, scheduledLetter: letter,
      blocks: [{ id: "main", type: "main", exercises: [letter === "A" ? squat(100) : bench(60)] }] });
  }
  history.reverse(); // oldest first, as the store keeps it
  return { meta: { weights: { "Barbell Back Squat": 102.5 }, bodyweight: { kg: 80 }, ...meta }, history };
}
const planView = (data = planData(), edits = {}) =>
  projectForTrainer(data, { todayIso: today, edits: { rows: [], used: 3, freeAt: null, ...edits } });

const SERVER_WORDS = "Server words, never shown";
// The change route's answers, from the real validator over the same data
// (app/api/trainer/change/route.js), so a change the pane drafts passes only
// with the ops and basis the route reads.
function fakeRoute(data = planData()) {
  return vi.fn(async (body) => {
    if ("withdraw" in body) return { status: 200, body: { withdrawn: [body.withdraw] } };
    const v = validateChangeSet(body.set, { meta: data.meta, history: data.history, todayIso: today, phase: "write", basis: body.basis || {} });
    if (!v.ok) {
      return v.refusals.length ? { status: 422, body: { refusals: v.refusals, error: SERVER_WORDS } } : { status: 409, body: { stale: true, error: SERVER_WORDS } };
    }
    const ops = v.ops.map(({ i, kind, target, from, before, after, warnings }) => ({ i, kind, target, from, before, after, warnings }));
    if ("dryRun" in body && body.dryRun !== false) return { status: 200, body: { preview: { ops, warnings: v.warnings }, budget: { used: 3, of: 10 } } };
    return { status: 200, body: { sent: { set: body.set.id, ids: ops.map((_, i) => `${body.set.id}.${i}`) }, budget: { used: 4, of: 10 } } };
  });
}

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const openLift = (name) => fireEvent.click(document.querySelector(`[data-plan-lift="${name}"]`));
const dialog = () => screen.getByRole("dialog");
const tap = (label) => fireEvent.click(within(dialog()).getByRole("button", { name: label }));
async function review() {
  await act(async () => { fireEvent.click(within(document.querySelector("[data-tray]")).getByRole("button", { name: /Review/ })); });
  await settle();
}

describe("TrainerClientView: the plan", () => {
  it("says what the trainer can do: change the plan, or ask for changes in Profile", () => {
    render(<TrainerClientView client={client} view={planView()}/>);
    expect(screen.getByText("You can change their plan. They see every change and can undo it. Sessions from the last 24 weeks; main lifts over 12 months.")).toBeTruthy();
    expect(screen.getByText("They see every change and can undo it. Sam can stop sharing any time.")).toBeTruthy();
    expect(document.querySelector('[data-section="plan"]')).toBeTruthy();
    cleanup();
    // No plan on the view: read only, and the way to change that.
    render(<TrainerClientView client={client} view={view()}/>);
    expect(document.querySelector('[data-section="plan"]')).toBeNull();
    expect(screen.getByText("Read only. Sam can stop sharing any time.")).toBeTruthy();
    cleanup();
    // Your own training never carries a plan section.
    render(<TrainerClientView self client={{ name: "Coach Kim" }} view={planView()}/>);
    expect(document.querySelector('[data-section="plan"]')).toBeNull();
    expect(screen.getByText("Read only. Sessions from the last 24 weeks; main lifts over 12 months.")).toBeTruthy();
  });

  it("changes off, a fresh approval needed, and a plan that couldn't load each read differently", () => {
    const lead = (edits) => {
      const v = { ...view(), ...(edits === undefined ? {} : { edits }) };
      render(<TrainerClientView client={client} view={v}/>);
      const text = document.querySelector("p").textContent;
      cleanup();
      return text;
    };
    const tail = " Sessions from the last 24 weeks; main lifts over 12 months.";
    expect(lead("off")).toBe(`Read only. Sam can let you change their plan in Profile.${tail}`);
    expect(lead("fresh")).toBe(`Read only. Sam needs to approve a fresh code before you can change their plan.${tail}`);
    expect(lead("unavailable")).toBe(`Couldn't load their plan just now. Try again in a moment.${tail}`);
    expect(lead(undefined)).toBe(lead("off"));
    expect(new Set(["off", "fresh", "unavailable"].map(lead)).size).toBe(3);
    // No name: still a sentence.
    expect(leadLine("fresh", null)).toBe("Read only. They need to approve a fresh code before you can change their plan.");
    expect(leadLine("off", null)).toBe("Read only. They can let you change their plan in Profile.");
    // On, with the plan: the plan line; on without one (it couldn't be read) is the unavailable line.
    render(<TrainerClientView client={client} view={{ ...view(), edits: "on" }}/>);
    expect(document.querySelector("p").textContent).toBe(`Couldn't load their plan just now. Try again in a moment.${tail}`);
    // Changes on but unread: the footer still says they see every change.
    expect(screen.getByText("They see every change and can undo it. Sam can stop sharing any time.")).toBeTruthy();
    cleanup();
    render(<TrainerClientView client={client} view={planView()}/>);
    expect(document.querySelector("p").textContent).toBe(`You can change their plan. They see every change and can undo it.${tail}`);
  });

  it("sits after Rhythm and before Main lifts, rows by session: last, next, and a waiting change", () => {
    const rows = [{ id: "hws_aaaaaaaaaaaaaaaaaaaaaaaaaa.0", set: "hws_aaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "weight", target: "Barbell Back Squat",
      before: 102.5, after: 105, from: null, at: Date.now() - 3600e3, appliedAt: null, outcome: null, undoneAt: null }];
    render(<TrainerClientView client={client} view={planView(planData(), { rows })}/>);
    const order = [...document.querySelectorAll("[data-section]")].map((n) => n.getAttribute("data-section"));
    expect(order.indexOf("plan")).toBe(order.indexOf("rhythm") + 1);
    expect(order.indexOf("lifts")).toBeGreaterThan(order.indexOf("plan"));
    const squatRow = document.querySelector('[data-plan-lift="Barbell Back Squat"]');
    expect(squatRow.closest("[data-plan-session]").getAttribute("data-plan-session")).toBe("A");
    expect(squatRow.textContent).toBe("Barbell Back SquatMain liftlast 100 × 5 · next 102.5 × 5 · yours 105 (waiting)");
    expect(document.querySelector('[data-plan-lift="Barbell Bench Press"]').textContent).toContain("last 60 × 5 · next 5 reps");
    expect(document.querySelector('[data-plan-lift="45-Degree Hip Extension"]').textContent).toContain("not lifted yet · next 15 reps");
    // Nothing drafted: nothing to review.
    expect(within(document.querySelector("[data-tray]")).getByRole("button").textContent).toBe("No changes yet");
  });

  it("steps the weight over the implement's rungs inside the validator's bounds, with Hold, Step, Jump and Ease", () => {
    render(<TrainerClientView client={client} view={planView()}/>);
    openLift("Barbell Back Squat");
    const d = dialog();
    expect(d.textContent).toContain("Up to 110 kg: last top set 100");
    expect(d.textContent).toContain("From 65 kg");
    expect(d.textContent).toContain("A one-off. After their next session the app carries on from what they lift.");
    const pace = within(d).getByRole("group", { name: "Pace" });
    expect([...pace.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Hold 100", "Step 102.5", "Jump 110", "Ease 95"]);
    const kg = () => within(d).getByLabelText("Weight in kg").value;
    expect(kg()).toBe("102.5");
    tap("More weight");
    expect(kg()).toBe("103.75");
    fireEvent.click(within(pace).getByText("Jump"));
    expect(kg()).toBe("110");
    expect(within(d).getByRole("button", { name: "More weight" }).disabled).toBe(true);
    // Typed: snapped to the grid and held inside the range, on show.
    const input = within(d).getByLabelText("Weight in kg");
    fireEvent.change(input, { target: { value: "131" } });
    fireEvent.blur(input);
    expect(kg()).toBe("110");
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.blur(input);
    expect(kg()).toBe("65");
    expect(within(d).getByRole("button", { name: "Less weight" }).disabled).toBe(true);
    // A big drop warns, never blocks.
    expect(d.textContent).toContain("More than 15% under their last top set.");
  });

  it("a bodyweight lift changes reps only; a timed hold changes seconds", () => {
    const v = planView();
    v.plan.lifts.push({ name: "L-Sit Hold", session: "C", loadType: "bodyweight", w: null, reps: "20s", anchor: null, bounds: null, blocked: null, pending: null,
      basis: { anchorDate: null, anchorKg: null, w: null, r: null } });
    render(<TrainerClientView client={client} view={v}/>);
    openLift("45-Degree Hip Extension");
    expect(dialog().querySelector("[data-weight]")).toBeNull();
    expect(dialog().textContent).toContain("Bodyweight, so reps only.");
    expect(within(dialog()).getByRole("group", { name: "Reps" }).textContent).toContain("15");
    tap("Cancel");
    expect(document.querySelector('[data-plan-lift="L-Sit Hold"]').textContent).toContain("next 20 s");
    openLift("L-Sit Hold");
    expect(dialog().textContent).toContain("A timed hold, so seconds only.");
    const secs = within(dialog()).getByRole("group", { name: "Seconds" });
    expect(secs.textContent).toContain("20");
    tap("More seconds");
    expect(secs.textContent).toContain("25");
  });

  it("a deload blocks weight changes and says when it ends; reps still change", () => {
    const data = planData({ trainingState: { mesocycle: { activeDeload: { startedAt: `${ago(2)}T08:00:00.000Z`, plannedDays: 7 } } } });
    render(<TrainerClientView client={client} view={planView(data)}/>);
    const until = isoDayMonthOf(addDaysIso(ago(2), 7));
    expect(document.querySelector("[data-deload]").textContent).toBe(`On a deload until about ${until}. Weights can change once it ends.`);
    openLift("Barbell Back Squat");
    expect(dialog().querySelector("[data-weight]").textContent).toContain(`After their deload ends, about ${until}`);
    expect(within(dialog()).queryByLabelText("Weight in kg")).toBeNull();
    expect(within(dialog()).getByRole("button", { name: "More reps" }).disabled).toBe(false);
  });

  it("a top set past the app's top for the lift blocks weight changes and says why; reps still change", () => {
    // Standing Calf Raise at 100 kg: its deload floor (70) sits over the ceiling (37.5) their app clamps to.
    const data = planData();
    const calf = { name: "Standing Calf Raise", muscle: "Calves", loadType: "machine",
      sets: [12, 12, 12].map((r) => ({ weight: 100, reps: r, rir: 2, loadType: "machine", effectiveLoad: 100 })) };
    data.history.push({ v: 2, id: `${ago(1)}T09:00:00.000Z`, date: ago(1), readiness: "normal", session: "strength A", scheduledLetter: "A",
      blocks: [{ id: "main", type: "main", exercises: [calf] }] });
    const view = planView(data);
    expect(view.plan.lifts.find((l) => l.name === "Standing Calf Raise").blocked).toEqual({ code: "ceiling", until: null });
    render(<TrainerClientView client={client} view={view}/>);
    openLift("Standing Calf Raise");
    expect(dialog().querySelector("[data-weight]").textContent).toContain("Their last top set is past the app's top for this lift. Change their reps instead.");
    expect(within(dialog()).queryByLabelText("Weight in kg")).toBeNull();
    expect(within(dialog()).getByRole("button", { name: "More reps" }).disabled).toBe(false);
  });

  it("every change goes through the dry run first; Send carries the same set and ops, once", async () => {
    const route = fakeRoute();
    const onChanged = vi.fn();
    render(<TrainerClientView client={client} view={planView()} onChange={route} onChanged={onChanged}/>);
    openLift("Barbell Back Squat");
    tap("More weight"); tap("More weight");
    tap("Add to changes");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector('[data-plan-lift="Barbell Back Squat"]').textContent).toContain("new 105, not sent");
    expect(route).not.toHaveBeenCalled();

    await review();
    expect(route).toHaveBeenCalledTimes(1);
    const check = route.mock.calls[0][0];
    expect(check.dryRun).toBe(true);
    expect(check.set.id).toMatch(SET_ID_RE);
    expect(check.set.ops).toEqual([{ kind: "weight", lift: "Barbell Back Squat", kg: 105, from: null }]);
    expect(check.basis).toEqual({ lifts: { "Barbell Back Squat": { anchorDate: ago(1), anchorKg: 100, w: 102.5, r: null } }, mains: {}, week: {} });
    const d = dialog();
    expect(within(d).getByText("Change Sam's plan?")).toBeTruthy();
    expect(d.querySelector('[data-op="0"]').textContent).toBe("Barbell Back Squat · 102.5 → 105 kg");
    expect(d.textContent).toContain("They'll see each change and can undo it.");
    expect(d.textContent).toContain("3 of 10 this week");

    // A double tap sends one set: the same id and ops the dry run passed.
    await act(async () => { tap("Send to Sam"); tap("Send to Sam"); });
    await settle();
    expect(route).toHaveBeenCalledTimes(2);
    const sent = route.mock.calls[1][0];
    expect("dryRun" in sent).toBe(false);
    expect(sent.set).toEqual(check.set);
    expect(sent.basis).toEqual(check.basis);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector('[data-section="plan"]').textContent).toContain("Sent. Sam sees it next time they open the app, and can undo it.");
    expect(within(document.querySelector("[data-tray]")).getByRole("button").textContent).toBe("No changes yet");
  });

  it("the top of the range passes the route's own check; reps ride in the same set with their warning", async () => {
    // Stored reps, so raising both reads as a double step.
    const data = planData({ reps: { "Barbell Back Squat": 5 } });
    const route = fakeRoute(data);
    render(<TrainerClientView client={client} view={planView(data)} onChange={route}/>);
    openLift("Barbell Back Squat");
    fireEvent.click(within(within(dialog()).getByRole("group", { name: "Pace" })).getByText("Jump"));
    tap("More reps"); tap("More reps"); tap("More reps");
    tap("Add to changes");
    await review();
    const d = dialog();
    expect(route.mock.calls[0][0].set.ops).toEqual([
      { kind: "weight", lift: "Barbell Back Squat", kg: 110, from: null },
      { kind: "reps", lift: "Barbell Back Squat", reps: 8, from: null },
    ]);
    expect(d.querySelector('[data-op="0"]').textContent).toBe("Barbell Back Squat · 102.5 → 110 kgRaises weight and reps together.");
    expect(d.querySelector('[data-op="1"]').textContent).toContain("Barbell Back Squat · 5 → 8 reps");
    expect(within(d).getByRole("button", { name: "Send to Sam" }).getAttribute("aria-disabled")).toBe("false");
  });

  it("a lift with no cap (max 0) reads as blocked, never as up to 0 kg; reps only names the lift", () => {
    const blocked = "Not lifted yet. Their app sets the first weight.";
    expect(noHistoryText(0)).toBe(blocked);
    expect(refusalText("no_history", { bounds: { max: 0 } })).toBe(blocked);
    expect(refusalText("reps_only", { lift: "Pull-Up" })).toBe("Pull-Up's last top set has no weight to show here. Change their reps instead.");
    expect(refusalText("reps_only")).toBe("That lift's last top set has no weight to show here. Change their reps instead.");
  });

  it("range and rep refusals read the validator's own limits", () => {
    expect(MAX_KG).toBe(400);
    expect(REP_LIMITS).toEqual({ min: 3, max: 30 });
    expect(refusalText("range")).toBe("Pick a weight up to 400 kg.");
    expect(refusalText("reps_range")).toBe("3 to 30 reps.");
    const src = readFileSync(resolve(root, "components/TrainerClientView.jsx"), "utf8");
    expect(src).toContain('case "range": return `Pick a weight up to ${MAX_KG} kg.`;');
    expect(src).toContain('case "reps_range": return `${REP_LIMITS.min} to ${REP_LIMITS.max} reps.`;');
  });

  it("the weekly and timed refusals read the validator's own limits, and the weekly one holds when the week-ago set is withheld", () => {
    expect(WEEK_JUMP_FRACTION).toBe(0.15);
    expect(TIMED_SECONDS).toEqual({ min: 5, max: 180, step: 5 });
    expect(refusalText("per_week", { bounds: { max: 110 } })).toBe("Up to 110 kg this week.");
    expect(refusalText("per_week")).toBe("Up to 15% a week over their top set of a week ago, or one step when that set can't be shown here.");
    expect(refusalText("timed_range")).toBe("5 to 180 seconds, in steps of 5.");
    const src = readFileSync(resolve(root, "components/TrainerClientView.jsx"), "utf8");
    expect(src).toContain("Math.round(WEEK_JUMP_FRACTION * 100)");
    expect(src).toContain("`${TIMED_SECONDS.min} to ${TIMED_SECONDS.max} seconds");
    expect(src).not.toContain("Up to 15%");
    expect(src).not.toMatch(/\b(?:5|180) (?:to|seconds)\b/);
    // Each copy moves with its constant, not with a number typed beside it.
    const body = (code) => src.slice(src.indexOf(`case "${code}":`), src.indexOf("case ", src.indexOf(`case "${code}":`) + 6));
    expect(body("per_week")).toContain("WEEK_JUMP_FRACTION");
    expect(body("per_week")).not.toMatch(/\d+%/);
    expect(body("timed_range")).toContain("TIMED_SECONDS.min");
    expect(body("timed_range")).toContain("TIMED_SECONDS.max");
    expect(body("timed_range")).toContain("TIMED_SECONDS.step");
    expect(body("timed_range")).not.toMatch(/\b(?:180|5) /);
  });

  it("the big-drop and rep-band warnings read their constants", () => {
    expect(BIG_DROP_FRACTION).toBe(0.85);
    expect(EFFECTIVE_REP_BAND.min).toBe(6);
    expect(warningText("big_drop")).toBe("More than 15% under their last top set.");
    expect(warningText("below_rep_band")).toBe("Under 6 reps: heavier work than the programme's band.");
    const src = readFileSync(resolve(root, "components/TrainerClientView.jsx"), "utf8");
    const body = (code) => src.slice(src.indexOf(`case "${code}":`), src.indexOf("case ", src.indexOf(`case "${code}":`) + 6));
    expect(body("big_drop")).toContain("BIG_DROP_FRACTION");
    expect(body("big_drop")).not.toMatch(/\d+%/);
    expect(body("below_rep_band")).toContain("EFFECTIVE_REP_BAND.min");
    expect(body("below_rep_band")).not.toMatch(/Under \d/);
  });

  it("a never-lifted lift with no known top says review checks it", () => {
    expect(noHistoryText(null)).toBe("Not lifted yet. Review checks a first weight.");
    expect(noHistoryText(undefined)).toBe("Not lifted yet. Review checks a first weight.");
    expect(refusalText("no_history")).toBe("Not lifted yet. Review checks a first weight.");
    expect(refusalText("no_history", { bounds: { max: null } })).toBe("Not lifted yet. Review checks a first weight.");
    const src = readFileSync(resolve(root, "components/TrainerClientView.jsx"), "utf8");
    expect(src).not.toContain("There's a top for a first weight");
    expect(src).not.toContain("A first weight has a top for this lift");
  });

  it("a never-lifted load names the public number (the cap, or the template where larger): the sheet and a refusal say the same, at any bodyweight", () => {
    const line = "Not lifted yet. Up to 250 kg for a first weight.";
    expect(noHistoryText(250)).toBe(line);
    expect(refusalText("no_history", { bounds: { max: 250 } })).toBe(line);
    for (const kg of [40, 160]) {
      render(<TrainerClientView client={client} view={planView(planData({ bodyweight: { kg } }))}/>);
      openLift("Hex Bar Deadlift");
      expect(dialog().textContent).toContain(line);
      const input = within(dialog()).getByLabelText("Weight in kg");
      fireEvent.change(input, { target: { value: "300" } });
      fireEvent.blur(input);
      expect(input.value).toBe("250");
      cleanup();
      // The calf raise's template (35 kg) is over its category cap (25): the sheet names 35.
      render(<TrainerClientView client={client} view={planView(planData({ bodyweight: { kg } }))}/>);
      openLift("Standing Calf Raise");
      expect(dialog().textContent).toContain("Not lifted yet. Up to 35 kg for a first weight.");
      cleanup();
    }
  });

  it("a refused change names the validator's reason in the pane's words, and can be left out", async () => {
    const route = fakeRoute();
    // A view without the cap (an older projection): the pane can't know the top, the route can.
    const v = planView();
    v.plan.lifts.find((l) => l.name === "Hex Bar Deadlift").bounds.max = null;
    render(<TrainerClientView client={client} view={v} onChange={route}/>);
    openLift("Hex Bar Deadlift");
    expect(dialog().textContent).toContain("Not lifted yet. Review checks a first weight.");
    const input = within(dialog()).getByLabelText("Weight in kg");
    fireEvent.change(input, { target: { value: "300" } });
    fireEvent.blur(input);
    tap("Add to changes");
    openLift("Barbell Back Squat");
    tap("More weight");
    tap("Add to changes");
    await review();
    const d = dialog();
    expect(d.querySelector('[data-op="0"]').textContent).toBe("Hex Bar Deadlift · 300 kgNot lifted yet. Review checks a first weight.");
    expect(d.querySelector('[data-op="1"] [data-refused]')).toBeNull();
    expect(within(d).getByRole("status").textContent).toBe("Some of these are outside their limits.");
    expect(within(d).queryByRole("button", { name: "Send to Sam" })).toBeNull();
    expect(document.body.textContent).not.toContain(SERVER_WORDS);
    fireEvent.click(within(d).getByRole("button", { name: "Leave those out" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector('[data-plan-lift="Hex Bar Deadlift"]').textContent).not.toContain("not sent");
    expect(document.querySelector('[data-plan-lift="Barbell Back Squat"]').textContent).toContain("new 103.75, not sent");
  });

  it("a main lift's options: the send carries the choice and what the pane showed", async () => {
    const route = fakeRoute();
    render(<TrainerClientView client={client} view={planView()} onChange={route}/>);
    openLift("Barbell Back Squat");
    const group = within(dialog()).getByRole("radiogroup", { name: "Main lift" });
    expect([...group.querySelectorAll('[role="radio"]')].map((b) => b.textContent)).toEqual(["Barbell Back Squat", "Front Squat", "Hack Squat"]);
    fireEvent.click(within(group).getByText("Front Squat"));
    expect(dialog().querySelector("[data-weight]")).toBeNull();
    expect(dialog().textContent).toContain("Front Squat takes this slot from their next session.");
    tap("Add to changes");
    expect(document.querySelector('[data-plan-lift="Barbell Back Squat"]').textContent).toContain("new main lift Front Squat, not sent");
    await review();
    expect(route.mock.calls[0][0].set.ops).toEqual([{ kind: "mainLift", canonical: "Barbell Back Squat", choice: "Front Squat", from: null }]);
    expect(route.mock.calls[0][0].basis.mains).toEqual({ "Barbell Back Squat": "Barbell Back Squat" });
    expect(dialog().querySelector('[data-op="0"]').textContent).toBe("Main lift · Barbell Back Squat → Front Squat");
  });

  it("a stale view asks for a refresh; Face ID is asked for, then the check runs again", async () => {
    // The client trained since the pane loaded: the route's data moved on.
    const moved = planData({ weights: { "Barbell Back Squat": 103.75 } });
    const onChanged = vi.fn();
    render(<TrainerClientView client={client} view={planView()} onChange={fakeRoute(moved)} onChanged={onChanged}/>);
    openLift("Barbell Back Squat"); tap("More weight"); tap("Add to changes");
    await review();
    expect(within(dialog()).getByRole("status").textContent).toBe("They've trained or changed it since you looked. Refresh to see their latest.");
    expect(document.body.textContent).not.toContain(SERVER_WORDS);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Refresh" }));
    expect(onChanged).toHaveBeenCalledTimes(1);
    cleanup();

    const real = fakeRoute();
    let fresh = false;
    const route = vi.fn(async (body) => (fresh ? real(body) : { status: 403, body: { needsFaceId: true } }));
    const onFaceId = vi.fn(async () => { fresh = true; return true; });
    render(<TrainerClientView client={client} view={planView()} onChange={route} onFaceId={onFaceId}/>);
    openLift("Barbell Back Squat"); tap("More weight"); tap("Add to changes");
    await review();
    expect(within(dialog()).getByRole("status").textContent).toBe("Confirm it's you to check changes.");
    await act(async () => { tap("Confirm it's you"); });
    await settle();
    expect(onFaceId).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledTimes(2);
    expect(route.mock.calls[1][0].dryRun).toBe(true);
    expect(within(dialog()).getByRole("button", { name: "Send to Sam" }).getAttribute("aria-disabled")).toBe("false");
  });

  it("this week's limit: Review is off and says when more come", () => {
    const freeAt = new Date(2026, 9, 12, 9).getTime();
    render(<TrainerClientView client={client} view={planView(planData(), { used: 10, freeAt })} onChange={fakeRoute()}/>);
    openLift("Barbell Back Squat"); tap("More weight"); tap("Add to changes");
    expect(within(document.querySelector("[data-tray]")).getByRole("button", { name: /Review/ }).disabled).toBe(true);
    expect(document.querySelector('[data-section="changes"]').textContent).toContain("10 of 10 this week · more from Mon 12 Oct");
  });

  it("your changes: by set, newest first, in the trainer's words, with Withdraw only where it can be taken back", async () => {
    const v = planView();
    const at = Date.now();
    v.plan.changes = [
      { id: "s1.0", set: "s1", kind: "weight", target: "Barbell Back Squat", before: 102.5, after: 105, from: null, status: "waiting", reason: null, date: null, at, warnings: [] },
      { id: "s1.1", set: "s1", kind: "reps", target: "Barbell Bench Press", before: 5, after: 8, from: null, status: "in_force", reason: null, date: null, at, warnings: ["off_programme_reps"] },
      { id: "s0.0", set: "s0", kind: "weight", target: "Barbell Bench Press", before: 57.5, after: 60, from: null, status: "trained_yours", reason: null, date: ago(3), cooked: true, at: at - 5 * 864e5, warnings: [] },
      { id: "s0.1", set: "s0", kind: "mainLift", target: "Barbell Back Squat", before: "Barbell Back Squat", after: "Front Squat", from: null, status: "not_applied", reason: "superseded", date: null, at: at - 5 * 864e5, warnings: [] },
      { id: "s0.2", set: "s0", kind: "reps", target: "Barbell Back Squat", before: 5, after: 6, from: null, status: "withdrawn", reason: null, date: null, at: at - 5 * 864e5, warnings: [] },
    ];
    const route = fakeRoute();
    const onChanged = vi.fn();
    render(<TrainerClientView client={client} view={v} onChange={route} onChanged={onChanged}/>);
    const box = document.querySelector('[data-section="changes"]');
    expect([...box.querySelectorAll("[data-set]")].map((n) => n.getAttribute("data-set"))).toEqual(["s1", "s0"]);
    const row = (id) => box.querySelector(`[data-change="${id}"]`);
    expect(row("s1.0").textContent).toBe("Barbell Back Squat · 105 kg, was 102.5Waiting for Sam's appWithdraw");
    expect(row("s1.1").textContent).toBe("Barbell Bench Press · 8 reps, was 5In their planOutside the programme's usual reps for this lift.Withdraw");
    expect(row("s0.0").textContent).toBe(`Barbell Bench Press · 60 kg, was 57.5Done at your number, ${isoDayMonthOf(ago(3))} · cooked day`);
    expect(row("s0.1").textContent).toBe("Main lift · Front Squat, was Barbell Back SquatThey trained before it arrived");
    expect(row("s0.2").textContent).toBe("Barbell Back Squat · 6 reps, was 5Withdrawn");
    expect(within(box.querySelector('[data-set="s1"]')).getByRole("button", { name: "Withdraw all" })).toBeTruthy();
    expect(box.querySelector('[data-set="s0"]').querySelector("button")).toBeNull();

    await act(async () => { fireEvent.click(within(row("s1.0")).getByRole("button", { name: "Withdraw" })); });
    await settle();
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0][0]).toEqual({ withdraw: "s1.0" });
    expect(within(box).getByRole("status").textContent).toBe("Withdrawn. It won't reach Sam.");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("Withdraw all only when the set id reaches nothing they trained at or changed since; Face ID keeps the set's wording", async () => {
    const v = planView();
    const at = Date.now();
    const ch = (id, set, status, extra = {}) => ({ id, set, kind: "weight", target: "Barbell Back Squat", before: 102.5, after: 105, from: null, status, reason: null, date: null, at, warnings: [], ...extra });
    v.plan.changes = [
      // Mixed: a withdraw by set id would also mark the trained row withdrawn.
      ch("m.0", "m", "trained_yours", { date: ago(1) }),
      ch("m.1", "m", "in_force", { kind: "reps", target: "Barbell Bench Press", before: 5, after: 8 }),
      ch("m.2", "m", "waiting", { target: "Barbell Bench Press", before: 60, after: 62.5 }),
      // Sent while changes were off: never lands, and the set id reaches it too.
      ch("o.0", "o", "not_applied", { reason: "stopped", at: at - 864e5 }),
      ch("o.1", "o", "waiting", { at: at - 864e5 }),
      ch("o.2", "o", "waiting", { kind: "reps", at: at - 864e5 }),
      // Waiting first, in force second: the whole set goes, and some of it was in force.
      ch("w.0", "w", "waiting", { at: at - 2 * 864e5 }),
      ch("w.1", "w", "in_force", { kind: "reps", before: 5, after: 6, at: at - 2 * 864e5 }),
    ];
    let fresh = false;
    const route = vi.fn(async (body) => (fresh ? { status: 200, body: { withdrawn: [body.withdraw] } } : { status: 403, body: { needsFaceId: true } }));
    const onFaceId = vi.fn(async () => { fresh = true; return true; });
    render(<TrainerClientView client={client} view={v} onChange={route} onFaceId={onFaceId} onChanged={vi.fn()}/>);
    const box = document.querySelector('[data-section="changes"]');
    const set = (id) => box.querySelector(`[data-set="${id}"]`);
    expect(within(set("m")).queryByRole("button", { name: "Withdraw all" })).toBeNull();
    expect(within(set("m")).getAllByRole("button", { name: "Withdraw" })).toHaveLength(2);
    expect(within(set("o")).queryByRole("button", { name: "Withdraw all" })).toBeNull();
    expect(within(set("o")).getAllByRole("button", { name: "Withdraw" })).toHaveLength(2);

    await act(async () => { fireEvent.click(within(set("w")).getByRole("button", { name: "Withdraw all" })); });
    await settle();
    expect(route.mock.calls[0][0]).toEqual({ withdraw: "w" });
    expect(within(box).getByRole("status").textContent).toBe("Confirm it's you to withdraw a change.");
    await act(async () => { fireEvent.click(within(box).getByRole("button", { name: "Confirm it's you" })); });
    await settle();
    expect(route.mock.calls.map((c) => c[0])).toEqual([{ withdraw: "w" }, { withdraw: "w" }]);
    expect(within(box).getByRole("status").textContent).toBe("Withdrawn. Sam's app puts it back next time it opens.");
  });

  it("a withdraw that reaches nothing says so, and reloads", async () => {
    const v = planView();
    v.plan.changes = [{ id: "s1.0", set: "s1", kind: "weight", target: "Barbell Back Squat", before: 102.5, after: 105, from: null, status: "waiting", reason: null, date: null, at: Date.now(), warnings: [] }];
    const route = vi.fn(async () => ({ status: 200, body: { withdrawn: [] } }));
    const onChanged = vi.fn();
    render(<TrainerClientView client={client} view={v} onChange={route} onChanged={onChanged}/>);
    const box = document.querySelector('[data-section="changes"]');
    await act(async () => { fireEvent.click(within(box).getByRole("button", { name: "Withdraw" })); });
    await settle();
    expect(within(box).getByRole("status").textContent).toBe("Nothing to withdraw. It's already undone, or it can't be taken back now.");
    expect(within(box).getByRole("status").textContent).not.toContain("Withdrawn");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("the reps stepper starts inside its range, so every step lands inside it", () => {
    for (const [plan, shown, after] of [[40, "30", "29"], [2, "3", "4"]]) {
      const v = planView();
      v.plan.lifts.find((l) => l.name === "Barbell Back Squat").reps = plan;
      render(<TrainerClientView client={client} view={v}/>);
      openLift("Barbell Back Squat");
      const reps = within(dialog()).getByRole("group", { name: "Reps" });
      expect(reps.querySelector("span").textContent).toBe(shown);
      const [less, more] = within(reps).getAllByRole("button");
      expect((plan > 30 ? more : less).disabled).toBe(true);
      tap(plan > 30 ? "Less reps" : "More reps");
      expect(reps.querySelector("span").textContent).toBe(after);
      cleanup();
    }
  });

  it("seconds step onto the five-second grid from a value off it", () => {
    const v = planView();
    v.plan.lifts.push({ name: "L-Sit Hold", session: "C", loadType: "bodyweight", w: null, reps: "32s", anchor: null, bounds: null, blocked: null, pending: null,
      basis: { anchorDate: null, anchorKg: null, w: null, r: null } });
    render(<TrainerClientView client={client} view={v}/>);
    openLift("L-Sit Hold");
    const secs = within(dialog()).getByRole("group", { name: "Seconds" });
    expect(secs.textContent).toContain("32");
    tap("More seconds");
    expect(secs.textContent).toContain("35");
    tap("Less seconds"); tap("Less seconds");
    expect(secs.textContent).toContain("25");
    expect(secs.textContent).not.toContain("27");
  });

  it("the weight field widens for a number on the 1.25 kg grid", () => {
    render(<TrainerClientView client={client} view={planView()}/>);
    openLift("Barbell Back Squat");
    tap("More weight");
    const input = within(dialog()).getByLabelText("Weight in kg");
    expect(input.value).toBe("103.75");
    expect(input.style.width).toBe("7ch");
  });

  it("a lift with limits but no weight yet starts empty, not at one step, and only a touched weight becomes a change", () => {
    const v = planView();
    const lm = v.plan.lifts.find((l) => l.name === "Landmine Press");
    expect(lm).toMatchObject({ w: null, anchor: null, bounds: { min: 1.25 } });
    render(<TrainerClientView client={client} view={v}/>);
    openLift("Landmine Press");
    const kg = () => within(dialog()).getByLabelText("Weight in kg");
    expect(kg().value).toBe("");
    expect(within(dialog()).getByRole("button", { name: "Less weight" }).disabled).toBe(true);
    tap("Add to changes");
    expect(within(document.querySelector("[data-tray]")).getByRole("button").textContent).toBe("No changes yet");
    openLift("Landmine Press");
    fireEvent.change(kg(), { target: { value: "30.6" } });
    fireEvent.blur(kg());
    expect(kg().value).toBe("30");
    tap("Add to changes");
    expect(document.querySelector('[data-plan-lift="Landmine Press"]').textContent).toContain("new 30, not sent");
  });

  it("Refresh says it shows their latest only once the reload lands, and says so when it didn't", async () => {
    const moved = planData({ weights: { "Barbell Back Squat": 103.75 } });
    for (const [answer, line] of [[false, "Couldn't get their latest just now. Try again."], [true, "Showing their latest."]]) {
      let land;
      const onChanged = vi.fn(() => new Promise((r) => { land = r; }));
      render(<TrainerClientView client={client} view={planView()} onChange={fakeRoute(moved)} onChanged={onChanged}/>);
      openLift("Barbell Back Squat"); tap("More weight"); tap("Add to changes");
      await review();
      await act(async () => { fireEvent.click(within(dialog()).getByRole("button", { name: "Refresh" })); });
      const status = () => document.querySelector('[data-section="plan"] > [role="status"]').textContent;
      expect(status()).toBe("Getting their latest.");
      await act(async () => { land(answer); });
      await settle();
      expect(status()).toBe(line);
      cleanup();
    }
  });

  it("the pane never fetches: every request goes through the parent", () => {
    const src = readFileSync(resolve(root, "components/TrainerClientView.jsx"), "utf8");
    expect(src).not.toMatch(/\bfetch(WithTimeout)?\(|@\/lib\/net/);
  });
});

/** "7 Oct" from an ISO date, as the pane prints it. */
function isoDayMonthOf(iso) {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]}`;
}
