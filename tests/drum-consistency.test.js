// The fine wheel is the same on every lift; the engine still snaps its own
// prescriptions. Loosening one must not loosen the other.

import { describe, it, expect } from "vitest";
import { WHEEL_DECIMALS } from "../components/ScrollDrum.jsx";
import { snapToImplement, weightStepForLoadType } from "../lib/lift-translations.js";

const LOAD_TYPES = ["per_db", "total", "cable", "machine", "barbell", "loaded_bodyweight", "assisted_bodyweight"];

describe("the fine wheel is the same control on every lift", () => {
  it("always offers four detents", () => {
    expect(WHEEL_DECIMALS).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it("does not vary with the equipment increment", () => {
    // Was 4 detents for a 1.25 step, 2 for 2.5, 1 for a whole-kg dumbbell.
    const perLoadType = LOAD_TYPES.map(() => WHEEL_DECIMALS.length);
    expect(new Set(perLoadType).size, "every lift must present the same wheel").toBe(1);
  });

  it("can express a rack converted from pounds", () => {
    // 45lb is 20.41kg; nearest detent 20.5. per_db could only say 20 before.
    const nearest = WHEEL_DECIMALS.reduce(
      (best, d) => (Math.abs(d - 0.41) < Math.abs(best - 0.41) ? d : best),
      WHEEL_DECIMALS[0],
    );
    expect(nearest).toBe(0.5);
  });
});

describe("the engine still refuses to invent a weight", () => {
  it("snaps a dumbbell prescription to whole kilos", () => {
    // ADD once produced 13.75 on a whole-kg rack.
    expect(weightStepForLoadType("per_db")).toBe(1);
    expect(snapToImplement(13.75, "per_db") % 1).toBe(0);
  });

  it("keeps each load type on its own grid", () => {
    for (const lt of LOAD_TYPES) {
      const step = weightStepForLoadType(lt);
      const snapped = snapToImplement(37.37, lt);
      const rungs = snapped / step;
      expect(Math.abs(rungs - Math.round(rungs)), `${lt} off-grid`).toBeLessThan(1e-6);
    }
  });

  it("the wheel being open has not loosened the engine", () => {
    // Letting the engine use the wheel's freedom is the old bug returning.
    expect(snapToImplement(20.41, "per_db")).toBe(20);
  });
});
