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
//   - a breather shows as paused, never its reason;
//   - "Stop seeing" asks first, then hands back to the dashboard;
//   - the source never imports sessionCount or the device store.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import TrainerClientView, { setsLine, rhythmCellText } from "../../components/TrainerClientView.jsx";
import { projectForTrainer } from "../../lib/trainer-view.js";
import { addDaysIso, todayLocalIso } from "../../lib/dates.js";
import { auditHistoryVolume } from "../../lib/volume-audit.js";

afterEach(cleanup);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const today = todayLocalIso();
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
    expect(screen.getByText("Read only. Sessions from the last 24 weeks; main lifts over 12 months.")).toBeTruthy();
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

  it("never imports sessionCount or the device store", () => {
    const src = readFileSync(resolve(root, "components/TrainerClientView.jsx"), "utf8");
    expect(src).not.toMatch(/sessionCount/);
    expect(src).not.toMatch(/lib\/storage/);
    expect(src).not.toMatch(/getActive\(|localStorage|sessionStorage|indexedDB|dangerouslySetInnerHTML/);
    expect(src).not.toMatch(/PerformanceLab/);
  });
});
