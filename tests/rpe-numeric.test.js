// tests/rpe-numeric.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The RPE capture contract. The track drags a continuous 6–10 value in 0.5
// steps; the record keeps THAT number. Records carry number-or-string by
// era — enum-era records never migrate, numeric records never re-band.
// The invariant: what the user dragged is what every surface reads back.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { rpeToRir, newDraftLog, logSet, finaliseDraft } from "../lib/storage.js";
import { rpeValue, rpeForEffort, effortForRpe } from "../lib/tokens.js";
import { pickFlashLine } from "../lib/set-flash.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("rpeToRir — numeric era alongside enum era", () => {
  it("maps every resting track position: RIR = 10 − RPE, half-steps kept", () => {
    expect(rpeToRir(8)).toBe(2);
    expect(rpeToRir(8.5)).toBe(1.5);
    expect(rpeToRir(9.5)).toBe(0.5);
    expect(rpeToRir(10)).toBe(0);
  });

  it("clamps to the engine's 0–3 band at the easy end", () => {
    expect(rpeToRir(6)).toBe(3);      // raw 4 → clamped
    expect(rpeToRir(6.5)).toBe(3);    // raw 3.5 → clamped
    expect(rpeToRir(7)).toBe(3);
  });

  it("enum-era strings keep their exact historic mapping", () => {
    expect(rpeToRir("easy")).toBe(3);
    expect(rpeToRir("normal")).toBe(2);
    expect(rpeToRir("hard")).toBe(1);
    expect(rpeToRir("cooked")).toBe(0);
    expect(rpeToRir("limit")).toBe(0);
    expect(rpeToRir(null)).toBe(null);
  });

  it("rejects non-finite numbers rather than minting NaN RIRs", () => {
    expect(rpeToRir(NaN)).toBe(null);
    expect(rpeToRir(Infinity)).toBe(null);
  });
});

describe("rpeValue — the one read path", () => {
  it("numeric passes through exactly; enum falls back to its representative", () => {
    expect(rpeValue(8.5)).toBe(8.5);
    expect(rpeValue(6)).toBe(6);
    expect(rpeValue("normal")).toBe(rpeForEffort("normal"));
    expect(rpeValue("cooked")).toBe(rpeForEffort("cooked"));
    expect(rpeValue(null)).toBe(null);
    expect(rpeValue(undefined)).toBe(null);
  });
});

describe("the round trip that used to be lossy", () => {
  it("a logged set stores the dragged number, not a band", () => {
    const draft = newDraftLog({ profileName: "t", session: "strength-a", blockNumber: 1, readiness: "normal" });
    logSet(draft, {
      blockId: "b1", blockType: "main", exerciseName: "Squat", muscle: "quads",
      weight: 100, reps: 5, rpe: 8.5,
    });
    const set = draft.blocks.b1.exercises.Squat.sets[0];
    expect(set.rpe).toBe(8.5);
    expect(set.rir).toBe(1.5);
    expect(rpeValue(set.rpe)).toBe(8.5);   // read-back is exact
  });

  it("every resting slider position survives the store round trip", () => {
    for (let rpe = 6; rpe <= 10; rpe += 0.5) {
      const draft = newDraftLog({ profileName: "t", session: "strength-a", blockNumber: 1, readiness: "normal" });
      logSet(draft, {
        blockId: "b1", blockType: "main", exerciseName: "Squat", muscle: "quads",
        weight: 100, reps: 5, rpe,
      });
      expect(rpeValue(draft.blocks.b1.exercises.Squat.sets[0].rpe)).toBe(rpe);
    }
  });

  it("finalise carries the number into the topSet summary", () => {
    const draft = newDraftLog({ profileName: "t", session: "strength-a", blockNumber: 1, readiness: "normal" });
    logSet(draft, {
      blockId: "b1", blockType: "main", exerciseName: "Squat", muscle: "quads",
      weight: 100, reps: 5, rpe: 9,
    });
    const rec = finaliseDraft(draft);
    const top = rec.blocks[0].exercises[0].summary.topSet;
    expect(top.rpe).toBe(9);
  });

  it("an enum-era set is untouched — no migration, no re-band", () => {
    const draft = newDraftLog({ profileName: "t", session: "strength-a", blockNumber: 1, readiness: "normal" });
    logSet(draft, {
      blockId: "b1", blockType: "main", exerciseName: "Squat", muscle: "quads",
      weight: 100, reps: 5, rpe: "normal",
    });
    const set = draft.blocks.b1.exercises.Squat.sets[0];
    expect(set.rpe).toBe("normal");
    expect(set.rir).toBe(2);
  });
});

describe("banding survives where the coarse vocabulary is still spoken", () => {
  it("effortForRpe bands the track exactly at the documented cuts", () => {
    expect(effortForRpe(7.25)).toBe("easy");
    expect(effortForRpe(7.5)).toBe("normal");
    expect(effortForRpe(8.75)).toBe("normal");
    expect(effortForRpe(9)).toBe("cooked");
  });

  it("flash lines accept a numeric effort (banded internally)", () => {
    expect(typeof pickFlashLine(9.5)).toBe("string");   // cooked pool
    expect(typeof pickFlashLine(8)).toBe("string");     // normal pool
    // The ADD pool must still refuse a cooked NUMBER, not just the string.
    const add = pickFlashLine(9.5, { addLikely: true, fullReps: true });
    expect(add).not.toBe("Next time, heavier.");
    expect(add).not.toBe("It goes up from here.");
  });
});

describe("code shape — the capture point cannot quietly re-band", () => {
  it("EffortPanel commits the raw number", () => {
    const s = readFileSync(resolve(root, "components/SessionScreen.jsx"), "utf8");
    expect(s).toContain("onCommit(rpe)");
    expect(s).not.toContain("onCommit(effortForRpe(rpe))");
  });

  it("no surface reconstructs a set's RPE from its band — rpeValue is the read path", () => {
    const s = readFileSync(resolve(root, "components/SessionScreen.jsx"), "utf8");
    expect(s).not.toMatch(/rpeForEffort\(s\.rpe\)/);
  });
});
