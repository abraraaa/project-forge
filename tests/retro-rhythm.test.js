// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// Retro-log → rhythm integration. User report (2026-06-12): "saved a missed
// workout — streak was 6, still shows as six after returning to main screen."
//
// This replays the EXACT retro-submission flow from handleSubmitRetro
// (newDraftLog → id/date override → logSet → finaliseDraft → H.append) through
// the real storage layer (jsdom localStorage), then asserts the day-state
// rhythm counts the new record. If this passes, the lib chain is sound and the bug
// lives in the React wiring or in user-side double-logging (H.append dedupes
// silently on id collision — see the dedupe test below).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import { H, newDraftLog, logSet, finaliseDraft } from "../lib/storage.js";
import { makeDayContext, strengthRhythm } from "../lib/day-state.js";
import { WEEK } from "../lib/programme.js";
import { todayLocalIso } from "../lib/dates.js";

// Strength days done in the last 28 days, as the Lab reads them.
const completedDays = (history) =>
  strengthRhythm(makeDayContext({ todayIso: todayLocalIso(), history, weekFor: () => WEEK })).completed;

const PROFILE = "rhythm-test";

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  it("the rhythm counts a freshly-appended retro record (6 → 7)", () => {
    // Seed six live sessions inside the 28-day window.
    for (let i = 0; i < 6; i++) {
      H.append(PROFILE, liveRecord(25 - i * 4)); // days 25,21,17,13,9,5 ago
    }
    expect(completedDays(H.get(PROFILE))).toBe(6);

    // Retro-log a session 2 days ago (a date with no existing record).
    const record = buildRetroRecord(isoDaysAgo(2));
    const after = H.append(PROFILE, record);
    expect(completedDays(after)).toBe(7);
  });

  it("H.append silently dedupes a same-id retro re-log — count stays flat", () => {
    // This is the suspected real-world path: a retro log for a given date
    // produces a DETERMINISTIC id (noon UTC of that date). Logging the same
    // missed day twice (e.g. because the first attempt showed no visible
    // change thanks to the week-strip bug) hits the dedupe and the second
    // submit is a silent no-op: success toast shows, nothing increments.
    const retroDate = isoDaysAgo(2);
    H.append(PROFILE, buildRetroRecord(retroDate));
    expect(completedDays(H.get(PROFILE))).toBe(1);

    const after = H.append(PROFILE, buildRetroRecord(retroDate));
    expect(after.length).toBe(1); // dedupe — no new record
    expect(completedDays(after)).toBe(1); // count unchanged
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

// ─── Distinct days, not records ──────────────────────────────────────────────
describe("rhythm counts distinct days", () => {
  it("two sessions in one day are one day", () => {
    const iso = isoDaysAgo(1);
    const history = [
      { id: `${iso}T09:00:00.000Z`, date: iso, session: "strength-a" },
      { id: `${iso}T18:00:00.000Z`, date: iso, session: "strength-a" },
    ];
    expect(completedDays(history)).toBe(1);
  });
});

// ─── Rhythm scope: strength-only ────────────────────────────────────────────
// A cardio tick lives in the Days store, never in history, so it cannot
// inflate the strength rhythm. Even a non-strength record in history does
// not count.
describe("rhythm — strength-only scope", () => {
  it("non-strength history records do not count", () => {
    // Construct records that LOOK like sessions but whose session strings
    // aren't strength: z2, hiit, cardio, rest. None of them count.
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
    expect(completedDays(H.get(PROFILE))).toBe(0);
  });
});
