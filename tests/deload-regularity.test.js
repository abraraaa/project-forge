// A deload offer needs a lifter who has been training. Every deload signal
// counts sessions and never time, so sporadic training manufactures the same
// shape as accumulated fatigue — and deloading the undertrained is backwards.

import { describe, it, expect } from "vitest";
import { shouldOfferDeload, trainingRegularity } from "../lib/progression.js";
import { mondayOfWeekIso, addDaysIso } from "../lib/dates.js";

// `daysByWeek[i]` is how many distinct strength days week i carries, oldest
// first, ending on the current week. Days sit at Mon/Wed/Fri/Sat offsets so
// the bucketing matches weeklyRhythm's columns whatever today is.
function historyOf(daysByWeek) {
  const monday = mondayOfWeekIso(new Date());
  const offsets = [0, 2, 4, 5, 1, 3, 6];
  const out = [];
  daysByWeek.forEach((n, i) => {
    const w = daysByWeek.length - 1 - i;
    for (let d = 0; d < n; d++) {
      const date = addDaysIso(monday, -w * 7 + offsets[d]);
      out.push({ id: `${date}T10:00:00`, date, session: "strength-a", readiness: "normal", blocks: [] });
    }
  });
  return out;
}

const stalled = () => ({
  lifts: { Squat: { stallSignal: "deep_stall" }, Bench: { stallSignal: "stall" } },
  mesocycle: { deloadSignals: {} },
});

describe("trainingRegularity", () => {
  it("is the mean of distinct strength days across the trailing 12 weeks", () => {
    const r = trainingRegularity(historyOf(Array(12).fill(3)));
    expect(r.weeks).toBe(12);
    expect(r.perWeek).toBeCloseTo(3, 5);
    expect(r.regular).toBe(true);
  });

  it("counts a day once however many records land on it", () => {
    const h = historyOf(Array(12).fill(3));
    const doubled = [...h, ...h.map((r) => ({ ...r, id: r.id + "-b", session: "strength-b" }))];
    expect(trainingRegularity(doubled).perWeek).toBeCloseTo(3, 5);
  });

  it("ignores everything that is not a strength session", () => {
    const h = historyOf(Array(12).fill(0)).concat(
      historyOf(Array(12).fill(3)).map((r) => ({ ...r, session: "cardio" })),
    );
    expect(trainingRegularity(h).perWeek).toBe(0);
  });

  it("empty history is not regular", () => {
    expect(trainingRegularity([]).regular).toBe(false);
    expect(trainingRegularity(undefined).regular).toBe(false);
  });
});

describe("shouldOfferDeload — the regularity gate", () => {
  it("holds the offer back when the trailing 12 weeks average under 2.5 days", () => {
    // Two a week, every week: perfectly consistent, still under the bar.
    expect(shouldOfferDeload(stalled(), historyOf(Array(12).fill(2)))).toBe(null);
  });

  it("holds it back for the sporadic lifter whose stalls are absence, not fatigue", () => {
    // Trained hard, drifted, came back: 4 of the last 12 weeks are empty.
    const pattern = [3, 3, 3, 0, 0, 3, 0, 3, 0, 3, 3, 3]; // 24 / 12 = 2.0
    expect(shouldOfferDeload(stalled(), historyOf(pattern))).toBe(null);
  });

  it("passes at exactly 2.5 and offers on the same signals", () => {
    const pattern = [3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2]; // 30 / 12 = 2.5
    const offer = shouldOfferDeload(stalled(), historyOf(pattern));
    expect(offer).not.toBe(null);
    // Two lifts at stall-or-worse is convergence; deep_stall only stands alone.
    expect(offer.type).toBe("stall_convergence");
  });

  it("fails just under it", () => {
    const pattern = [3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 1]; // 29 / 12
    expect(shouldOfferDeload(stalled(), historyOf(pattern))).toBe(null);
  });

  it("a new user cannot be offered a deload inside their first ~10 weeks, by design", () => {
    // Four weeks at three a day — 12 / 12 = 1.0. The window is flat on
    // purpose: the first deload belongs after a full block of accumulation.
    expect(shouldOfferDeload(stalled(), historyOf([0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3]))).toBe(null);
    // Ten weeks at three, and the door opens.
    expect(shouldOfferDeload(stalled(), historyOf([0, 0, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]))).not.toBe(null);
  });

  it("gates the OFFER, not the signals", () => {
    // Detection is unchanged; the card is what stays hidden.
    const h = historyOf(Array(12).fill(1));
    expect(shouldOfferDeload(stalled(), h)).toBe(null);
    expect(trainingRegularity(h).regular).toBe(false);
  });

  it("travel and retro sessions count — they are training", () => {
    const h = historyOf(Array(12).fill(3)).map((r, i) =>
      i % 3 === 0 ? { ...r, travel: true } : i % 3 === 1 ? { ...r, retro: true } : r,
    );
    expect(shouldOfferDeload(stalled(), h)).not.toBe(null);
  });
});
