// The home week, one resolver. Each case is a report or a schedule-edit
// timeline that used to make the strip, headline and ticks disagree.
import { describe, it, expect } from "vitest";
import { resolveWeek, sessionsFrom } from "../lib/day-state.js";

const MON = "2026-09-21"; // a Monday
const day = (type) => ({ s: "x", label: type, type });
const weekOf = (...types) => types.map(day);
// Old plan: strength Mon/Wed/Fri. Edited Thursday to strength Tue/Thu/Sat.
const OLD = weekOf("strength", "rest", "strength", "rest", "strength", "cardio", "rest");
const NEW = weekOf("rest", "strength", "rest", "strength", "rest", "strength", "cardio");
const editedThursday = (iso) => (iso >= "2026-09-24" ? NEW : OLD);
const rec = (date, letter, id = `${date}T10:00`) => ({ id, date, session: `strength_${letter.toLowerCase()}`, scheduledLetter: letter });

describe("a schedule edit never rewrites the past", () => {
  const w = resolveWeek({ mondayIso: MON, todayIdx: 4, history: [rec("2026-09-21", "A")], days: {}, weekFor: editedThursday });

  it("past days keep the plan that was in force", () => {
    expect(w[1].planned).toBe("rest");      // Tue was rest then; strength now
    expect(w[1].session).toBeNull();        // so no session borrowed from today's schedule
    expect(w[1].shown.type).toBe("rest");
  });
  it("today and later follow the new plan", () => {
    expect(w[3].planned).toBe("strength");
    expect(w[5].planned).toBe("strength");
    expect(w[5].session).not.toBeNull();
  });
});

describe("a done day wears what was done", () => {
  it("strength on a rest day shows as strength, done, with the logged session", () => {
    const w = resolveWeek({ mondayIso: MON, todayIdx: 3, history: [rec("2026-09-22", "B")], days: {}, weekFor: () => OLD });
    expect(w[1].planned).toBe("rest");
    expect(w[1].done).toBe(true);
    expect(w[1].shown.type).toBe("strength");
    expect(w[1].session).toBe(1);
  });
  it("a past strength day shows the session actually logged, not the projection", () => {
    const w = resolveWeek({ mondayIso: MON, todayIdx: 4, history: [rec("2026-09-21", "C")], days: {}, weekFor: () => OLD });
    expect(w[0].session).toBe(2);
  });
  it("a manual tick only completes its own type", () => {
    const days = { "2026-09-26": { completedType: "cardio" }, "2026-09-23": { completedType: "cardio" } };
    const w = resolveWeek({ mondayIso: MON, todayIdx: 6, history: [], days, weekFor: () => OLD });
    expect(w[5].done).toBe(true);           // Sat cardio ticked cardio
    expect(w[5].shown.type).toBe("cardio");
    expect(w[2].done).toBe(false);          // Wed strength ticked cardio: not done
    expect(w[2].shown.type).toBe("strength");
  });
  it("undone days keep their planned colour", () => {
    const w = resolveWeek({ mondayIso: MON, todayIdx: 0, history: [], days: {}, weekFor: () => OLD });
    expect(w.map((d) => d.shown.type)).toEqual(OLD.map((d) => d.type));
    expect(w.every((d) => !d.done)).toBe(true);
  });
});

describe("the session map", () => {
  it("only strength-bearing days get a letter", () => {
    const w = resolveWeek({ mondayIso: MON, todayIdx: 0, history: [], days: {}, weekFor: () => OLD });
    expect(Object.keys(sessionsFrom(w)).map(Number)).toEqual([0, 2, 4]);
    expect(sessionsFrom(w)[0]).toBe(0); // no history → A first
  });
});
