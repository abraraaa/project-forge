// A cooked day keeps its full routine; every load-progressed lift's card
// opens 15% lighter than its working weight, rounded to the lift's step. The
// cut is today's plan, never the prescription: nothing stored moves.
import { describe, it, expect } from "vitest";
import { scaleForReadiness } from "../lib/storage.js";
import { SESSIONS } from "../lib/programme.js";

const load = () => import("../lib/programme-resolve.js");

describe("scaleForReadiness: a cooked day is the full session", () => {
  it("keeps every block, every finisher and every set", () => {
    for (const s of SESSIONS) {
      expect(scaleForReadiness(s, "cooked"), s.name).toEqual(s);
    }
  });
});

describe("cookedWeights", () => {
  const W = {
    "Barbell Back Squat": 100, "Barbell Bench Press": 62.5, "DB Curl": 14,
    "Pull-Up": 10, "Assisted Pull-Up": 20, "Push-Up": 0,
  };
  it("takes 15% off each load-progressed lift, rounded to its increment", async () => {
    const { cookedWeights } = await load();
    const out = cookedWeights(W, { working: W });
    expect(out["Barbell Back Squat"]).toBe(85);
    expect(out["Barbell Bench Press"]).toBe(53.75);      // 53.125 to the 1.25 step
    expect(out["DB Curl"]).toBe(12);                      // 11.9, a dumbbell that exists
  });
  it("leaves bodyweight and assisted lifts alone", async () => {
    const { cookedWeights } = await load();
    const out = cookedWeights(W, { working: W });
    expect(out["Pull-Up"]).toBe(10);
    expect(out["Assisted Pull-Up"]).toBe(20);
    expect(out["Push-Up"]).toBe(0);
  });
  it("a deload wins: nothing stacks on a deload day or on a deload calendar's weight", async () => {
    const { cookedWeights } = await load();
    expect(cookedWeights(W, { working: W, deload: true })).toEqual(W);
    const scheduled = { ...W, "Barbell Back Squat": 65 };
    expect(cookedWeights(scheduled, { working: W })["Barbell Back Squat"]).toBe(65);
  });
  it("never touches its input", async () => {
    const { cookedWeights } = await load();
    const copy = { ...W };
    cookedWeights(W, { working: W });
    expect(W).toEqual(copy);
  });
});
