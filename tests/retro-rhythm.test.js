// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// Retro-log → rhythm integration. User report (2026-06-12): "saved a missed
// workout — streak was 6, still shows as six after returning to main screen."
//
// This replays the EXACT retro-submission flow from handleSubmitRetro
// (newDraftLog → id/date override → logSet → finaliseDraft → H.append) through
// the real storage layer (jsdom localStorage), then asserts computeRhythm
// counts the new record. If this passes, the lib chain is sound and the bug
// lives in the React wiring or in user-side double-logging (H.append dedupes
// silently on id collision — see the dedupe test below).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import {
  H, newDraftLog, logSet, finaliseDraft, computeRhythm,
} from "../lib/storage.js";

const PROFILE = "rhythm-test";

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Live-shaped record (the kind the normal finalise path appends) — minimal
// but with a real timestamped id and a strength session string.
function liveRecord(daysAgo) {
  const date = isoDaysAgo(daysAgo);
  return {
    v: 2,
    id: `${date}T18:30:00.000Z`,
    date,
    session: "strength-a",
    readiness: "normal",
    blocks: [],
    summary: { totalVolume: 0 },
  };
}

// Replays handleSubmitRetro's record construction faithfully.
function buildRetroRecord(retroDate) {
  const draft = newDraftLog({
    profileName: PROFILE,
    session: "strength-b",
    blockNumber: 1,
    readiness: "normal",
    readinessReason: null,
    mesocyclePhase: "accumulation",
    bodyweight: 80,
    hoursSlept: null,
    daysSinceLast: null,
  });
  draft.id = `${retroDate}T12:00:00.000Z`;
  draft.date = retroDate;
  draft.dow = new Date(retroDate + "T12:00:00").getDay();
  draft.startedAt = new Date(retroDate + "T12:00:00").getTime();
  draft.retrospective = true;
  draft.loggedAt = new Date().toISOString();

  logSet(draft, {
    blockId: "main",
    blockType: "main",
    exerciseName: "Barbell Back Squat",
    muscle: "Quads",
    swapped: false,
    fromPool: null,
    loadType: "barbell",
    bodyweight: 80,
    weight: 100,
    reps: 5,
    rpe: "normal",
    prescribed: { weight: 100, reps: 5, sets: 3 },
    tempo: null,
    blockIntent: null,
  });

  const record = finaliseDraft(draft);
  record.retrospective = true;
  return record;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("retro log → rhythm count", () => {
  it("computeRhythm counts a freshly-appended retro record (6 → 7)", () => {
    // Seed six live sessions inside the 28-day window.
    for (let i = 0; i < 6; i++) {
      H.append(PROFILE, liveRecord(25 - i * 4)); // days 25,21,17,13,9,5 ago
    }
    expect(computeRhythm(H.get(PROFILE)).completed).toBe(6);

    // Retro-log a session 2 days ago (a date with no existing record).
    const record = buildRetroRecord(isoDaysAgo(2));
    const after = H.append(PROFILE, record);
    expect(computeRhythm(after).completed).toBe(7);
  });

  it("H.append silently dedupes a same-id retro re-log — count stays flat", () => {
    // This is the suspected real-world path: a retro log for a given date
    // produces a DETERMINISTIC id (noon UTC of that date). Logging the same
    // missed day twice (e.g. because the first attempt showed no visible
    // change thanks to the week-strip bug) hits the dedupe and the second
    // submit is a silent no-op: success toast shows, nothing increments.
    const retroDate = isoDaysAgo(2);
    H.append(PROFILE, buildRetroRecord(retroDate));
    expect(computeRhythm(H.get(PROFILE)).completed).toBe(1);

    const after = H.append(PROFILE, buildRetroRecord(retroDate));
    expect(after.length).toBe(1); // dedupe — no new record
    expect(computeRhythm(after).completed).toBe(1); // count unchanged
  });

  it("retro record survives the H.get migration pass with session intact", () => {
    const record = buildRetroRecord(isoDaysAgo(1));
    H.append(PROFILE, record);
    const [stored] = H.get(PROFILE);
    expect(stored.session).toBe("strength-b");
    expect(stored.retrospective).toBe(true);
    expect(stored.session.startsWith("strength")).toBe(true);
  });
});

// ─── Rhythm expectations: schedule-aware ─────────────────────────────────────
describe("computeRhythm — schedule-aware expectations", () => {
  it("expected derives from the user's weekly strength days × 4", () => {
    expect(computeRhythm([], { weeklyStrengthDays: 2 }).expected).toBe(8);   // 2-day plan can reach 100%
    expect(computeRhythm([], { weeklyStrengthDays: 4 }).expected).toBe(16);  // 4-day plan held to its own bar
    expect(computeRhythm([]).expected).toBe(12);                             // default = historic 3×/week
    expect(computeRhythm([], { weeklyStrengthDays: 0 }).expected).toBe(12);  // degenerate → default, never /0
  });

  it("counts distinct days, not records — two sessions in one day are one day", () => {
    // Yesterday, so both timestamps are inside the window regardless of the
    // wall-clock hour the test runs at (t <= now filters future ids).
    const d = new Date(Date.now() - 86400000);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const history = [
      { id: `${iso}T09:00:00.000Z`, date: iso, session: "strength-a" },
      { id: `${iso}T18:00:00.000Z`, date: iso, session: "strength-a" },
    ];
    expect(computeRhythm(history).completed).toBe(1);
  });
});

// ─── Rhythm scope: strength-only ────────────────────────────────────────────
// User hypothesised "I've swapped a cardio day to Friday — does marking it
// hit the streak badge?" The badge is meant to count strength sessions
// only. handleMarkDayDone (the cardio/Z2/HIIT tick path) writes to
// weekDone, never to history, so it can't inflate rhythm structurally.
// Even if a non-strength record DID end up in history, computeRhythm's
// filter would reject it. Lock both invariants.
describe("computeRhythm — strength-only scope", () => {
  it("non-strength history records do not count", () => {
    // Construct records that LOOK like sessions but whose session strings
    // aren't strength: z2, hiit, cardio, rest. computeRhythm should ignore
    // every one of them.
    const today = new Date().toISOString().slice(0, 10);
    const fakes = ["z2", "hiit", "cardio", "rest"].map((kind, i) => ({
      v: 2,
      id: `${today}T${String(8 + i).padStart(2, "0")}:00:00.000Z`,
      date: today,
      session: kind,
      readiness: "normal",
      blocks: [],
      summary: { totalVolume: 0 },
    }));
    fakes.forEach(r => H.append(PROFILE, r));
    expect(computeRhythm(H.get(PROFILE)).completed).toBe(0);
  });

  it("ticking a day via weekDone never produces a history record", async () => {
    // P.markDayDone updates weekDone for the current ISO week. It does NOT
    // touch the history store. This test reads the history before and
    // after a tick and asserts no record appeared — proving that the
    // streak badge can't move just from a cardio tick.
    const { P } = await import("../lib/storage.js");
    const before = H.get(PROFILE);
    P.markDayDone(PROFILE, 4); // Friday
    const after = H.get(PROFILE);
    expect(after.length).toBe(before.length);
    expect(computeRhythm(after).completed).toBe(computeRhythm(before).completed);
  });
});
