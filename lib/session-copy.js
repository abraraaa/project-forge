// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/session-copy.js
// Lines the session speaks about how the engine read a lift. One place, so
// the wording can change without hunting through the screens.

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** @param {number} n */
const inWords = (n) => (Number.isInteger(n) && n >= 0 && n < WORDS.length ? WORDS[n] : String(n));

export const SESSION_COPY = {
  /** After logging a final set that came up short at full effort. */
  finalSetMiss: "Spent. That's the set.",
  /** Next card, when the lift's last session ended on a final-set miss.
   * @param {number} sets  the sets prescribed today */
  ownAllSets: (sets) => `Own all ${inWords(sets)} before we add weight.`,
  /** Next card, when the engine adopted the lifter's repeated rep choice.
   * @param {number|string} reps  @param {number} sessions */
  adoptedTarget: (reps, sessions) => `Moved your target to ${reps}s. You've done that ${inWords(sessions)} times.`,
  /** Next card, when the lift's last session went to failure. */
  afterFailure: "Last time went to failure. Finish at 9.5 or lower today and the weight goes up next time.",
  /** Next card, while the rep target sits above base to break a stall.
   * @param {{ reps: number, base: number, holds: number, banks: boolean }} climb */
  repClimb: ({ reps, base, holds, banks }) => [
    `${reps} reps, not ${base}.`,
    holds > 0
      ? `The weight has held for ${inWords(holds)} session${holds === 1 ? "" : "s"}, so the reps climb to break the stall.`
      : "The reps climb to break the stall.",
    banks ? `Hit ${reps} at 9.5 or lower and the weight goes up next time.` : null,
  ].filter(Boolean).join(" "),
};
