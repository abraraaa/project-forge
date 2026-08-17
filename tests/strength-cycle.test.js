// tests/strength-cycle.test.js
// ────────────────────────────────────────────────────────────────────────────
// The A/B/C split is a CONTINUING cycle, not a weekday map.
//
// The old deriveStrengthDaySessions mapped a position in the week to a
// session — { 0:0, 2:1, 4:2 } — so Monday was always A. That is fine only for
// a user who trains exactly Mon/Wed/Fri, every week, forever. Everyone else
// got a broken split, silently:
//
//   - trains Mon + Wed only    → A, B, A, B … and never meets C
//   - trains Wed + Fri only    → B, C, B, C … and never meets A
//   - trains four days in a week → the 4th lands back on A, the same week
//   - misses a week            → resets to A instead of resuming
//
// None of it was covered by a test, which is why it survived. These are that
// test. They assert behaviour a user would recognise, not the shape of the
// lookup table.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  SESSIONS, WEEK, lastStrengthIdx, nextStrengthIdx, projectStrengthDaySessions,
  sessionMetaForDate,
} from "../lib/programme.js";

const LETTERS = ["A", "B", "C"];
const idxToLetter = (i) => LETTERS[i];

// A logged strength session, as the record layer writes it.
function logged(date, letter, extra = {}) {
  return {
    v: 2,
    id: `${date}T18:30:00.000Z`,
    date,
    session: `strength-${letter.toLowerCase()}`,
    scheduledLetter: letter,
    blocks: [],
    ...extra,
  };
}

// Walk N sessions, each time taking whatever the cycle offers next.
function walk(n, seed = []) {
  const history = [...seed];
  const out = [];
  for (let i = 0; i < n; i++) {
    const letter = idxToLetter(nextStrengthIdx(history));
    out.push(letter);
    // Dates ascend so "most recent" is unambiguous.
    history.push(logged(`2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, "0")}`, letter));
  }
  return out;
}

describe("the A/B/C cycle advances from what you trained, not from the weekday", () => {
  it("starts at A with no history", () => {
    expect(lastStrengthIdx([])).toBeNull();
    expect(nextStrengthIdx([])).toBe(0);
  });

  it("advances A → B → C → A", () => {
    expect(walk(6)).toEqual(["A", "B", "C", "A", "B", "C"]);
  });

  it("a two-sessions-a-week user still meets C — the original bug", () => {
    // Under the old weekday map this user trained Mon(A) and Wed(B) forever
    // and C never existed for them. Six sessions must cover all three twice.
    const letters = walk(6);
    expect(new Set(letters)).toEqual(new Set(["A", "B", "C"]));
  });

  it("a four-sessions-a-week user does not repeat a session inside the week", () => {
    // Old behaviour cycled the 4th strength day back to A in the same week
    // the user had already trained A.
    expect(walk(4)).toEqual(["A", "B", "C", "A"]);
  });

  it("a missed week resumes where it stopped rather than resetting to A", () => {
    // Trained A and B in January, then nothing until March.
    const seed = [logged("2026-01-05", "A"), logged("2026-01-07", "B")];
    expect(idxToLetter(nextStrengthIdx(seed))).toBe("C");
  });

  it("counts travel sessions — a hotel-room A is still an A", () => {
    const seed = [logged("2026-02-02", "A"), logged("2026-02-04", "B", { travel: true })];
    expect(idxToLetter(nextStrengthIdx(seed))).toBe("C");
  });

  it("reads pre-v2 records that carry only a session name", () => {
    const legacy = [{ id: "2026-02-02T10:00:00.000Z", date: "2026-02-02", session: "Strength B" }];
    expect(idxToLetter(nextStrengthIdx(legacy))).toBe("C");
  });

  it("ignores records with no readable letter rather than guessing", () => {
    const noisy = [logged("2026-02-02", "B"), { id: "x", date: "2026-02-03", session: "zone2" }];
    expect(idxToLetter(nextStrengthIdx(noisy))).toBe("C");
  });

  it("resolves same-day ties by id, so two sessions in a day still advance once", () => {
    const sameDay = [
      { ...logged("2026-02-02", "A"), id: "2026-02-02T08:00:00.000Z" },
      { ...logged("2026-02-02", "B"), id: "2026-02-02T18:00:00.000Z" },
    ];
    expect(idxToLetter(nextStrengthIdx(sameDay))).toBe("C");
  });
});

describe("projectStrengthDaySessions — the week strip follows the cycle", () => {
  it("gives the next session to the first strength day from today onward", () => {
    const history = [logged("2026-02-02", "A")];      // next is B
    const strengthDays = WEEK.map((d, i) => (d?.type === "strength" ? i : null)).filter((i) => i !== null);
    const map = projectStrengthDaySessions(WEEK, history, 0);
    expect(map[strengthDays[0]]).toBe(1);             // B
    expect(map[strengthDays[1]]).toBe(2);             // C
    expect(map[strengthDays[2]]).toBe(0);             // A, wrapping
  });

  it("keeps the same shape as the map it replaces (drop-in for the strip)", () => {
    const map = projectStrengthDaySessions(WEEK, [], 0);
    for (const [weekIdx, sessionIdx] of Object.entries(map)) {
      expect(WEEK[Number(weekIdx)].type).toBe("strength");
      expect(sessionIdx).toBeGreaterThanOrEqual(0);
      expect(sessionIdx).toBeLessThan(SESSIONS.length);
    }
  });

  it("anchors on today, so days already past read behind the cursor", () => {
    // Today is late in the week: earlier strength days show what came before
    // the cursor, not what comes after it.
    const strengthDays = WEEK.map((d, i) => (d?.type === "strength" ? i : null)).filter((i) => i !== null);
    const last = strengthDays[strengthDays.length - 1];
    const map = projectStrengthDaySessions(WEEK, [], last);
    expect(map[last]).toBe(0);                        // today takes `next` = A
    expect(map[strengthDays[0]]).toBe(1);             // two before A, wrapped
  });

  it("returns nothing for a week with no strength days rather than throwing", () => {
    expect(projectStrengthDaySessions([{ type: "rest" }, { type: "rest" }], [], 0)).toEqual({});
  });
});

// ────────────────────────────────────────────────────────────────────────────
// The reach is offered late, on purpose.
//
// SessionHost gates on `setNum >= blockSets && setNum >= REACH_EARLIEST_SET`.
// The second clause is the one that matters: asking after set one is asking
// before the user knows what kind of day it is. Every main block in the
// programme is 3 or 4 sets, so the floor is currently redundant — this test
// exists so it stays redundant, and fails loudly if a shorter main block ever
// lands and quietly moves the question earlier.
// ────────────────────────────────────────────────────────────────────────────
describe("the reach is never offered before the third set", () => {
  it("every main block runs at least three sets", () => {
    const shortMains = [];
    for (const s of SESSIONS) {
      for (const b of s.blocks || []) {
        if (b.type === "main" && (b.sets ?? 0) < 3) {
          shortMains.push(`${s.name} · ${b.id} · ${b.sets} sets`);
        }
      }
    }
    expect(shortMains, shortMains.join(", ")).toEqual([]);
  });

  it("the headline block is a main block, so the offer rides its set count", () => {
    // projectStrengthDaySessions decides WHICH session; the offer attaches to
    // the first main block of whichever one it is. Every session must have one.
    for (const s of SESSIONS) {
      expect(
        (s.blocks || []).some((b) => b.type === "main"),
        `${s.name} has no main block for the reach to attach to`,
      ).toBe(true);
    }
  });
});


// ────────────────────────────────────────────────────────────────────────────
// Retro-logging has to speak the same language as the live session.
//
// The live session follows the cycle; sessionMetaForDate followed the WEEKDAY.
// So "your next session is C" could sit beside a retro picker offering the
// same date as B, and accepting it wrote a letter the cycle never chose —
// leaving a duplicate and a gap. Given history, the retro letter now continues
// the cycle from whatever was trained BEFORE that date.
// ────────────────────────────────────────────────────────────────────────────
describe("a retro-logged session continues the cycle, not the weekday", () => {
  // Mon/Wed/Fri of one week — the default schedule's three strength days.
  const MON = "2026-06-15", WED = "2026-06-17", FRI = "2026-06-19";

  it("takes the letter that follows the last session before that date", () => {
    // Trained A on Monday. Wednesday's gap is B — and Wednesday's weekday map
    // would also say B here, so the next test is the one that proves it.
    const history = [logged(MON, "A")];
    expect(sessionMetaForDate(WED, WEEK, history).sessionName).toBe("Strength B");
  });

  it("follows the cycle even when the weekday map disagrees", () => {
    // Trained C on Monday. The weekday map says Wednesday is B; the cycle says
    // A, because A is what comes after C. The cycle wins.
    const history = [logged(MON, "C")];
    expect(sessionMetaForDate(WED, WEEK, history).sessionName).toBe("Strength A");
  });

  it("ignores sessions logged AFTER the date being filled in", () => {
    // Today's session must not decide what last Wednesday's gap was.
    const history = [logged(MON, "A"), logged("2026-06-26", "C")];
    expect(sessionMetaForDate(WED, WEEK, history).sessionName).toBe("Strength B");
  });

  it("falls back to the weekday map when no history is passed", () => {
    // Existing callers that pass no history keep the old behaviour exactly.
    expect(sessionMetaForDate(MON)?.sessionName).toBe("Strength A");
    expect(sessionMetaForDate(FRI)?.sessionName).toBe("Strength C");
  });

  it("today's session still moves the cursor on — the boss's own case", () => {
    // Cycle says C. Do C today, and tomorrow is A — regardless of a
    // backfilled session sitting in last week.
    const history = [logged("2026-06-01", "B"), logged("2026-06-08", "C")];
    expect(idxToLetter(nextStrengthIdx(history))).toBe("A");
    // ...and backfilling last week does not disturb it.
    const withBackfill = [...history, logged("2026-06-03", "A")];
    expect(idxToLetter(nextStrengthIdx(withBackfill))).toBe("A");
  });
});
