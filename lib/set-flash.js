// @ts-check
// lib/set-flash.js
// ─────────────────────────────────────────────────────────────────────────────
// Final-set flash lines. After the user rates the LAST set of an exercise,
// one quiet line fades through the transition — acknowledgement in the
// house voice, never a lecture. Copy signed off 2026-07-08 (several lines
// are the user's own, kept verbatim).
//
// Honesty rules, enforced here so the surface can't lie:
//   · Easy lines imply more weight is coming, which is only true on full
//     reps — short reps fall back to the Normal register (acknowledge,
//     don't promise).
//   · Cooked lines never imply an add (the engine holds on cooked).
//   · Lines that mention "the bar" are skipped for bodyweight movements.
//   · Lines that describe a pull are skipped for everything else — "clean
//     pull, clean release" landed on a bench press.
//   · No repeats within a session (caller passes the `used` set); when the
//     pool is exhausted, reuse beats silence.
//   · The ADD pool states the consequence outright ("Next time, heavier.")
//     and therefore only speaks when the caller certifies `addLikely` —
//     full reps + effort at/above the lift's ADD_THRESHOLD_RIR + no
//     active deload + not in recovery. The real decision happens at
//     session finalise with more context; every ambiguous case falls
//     back to acknowledgement pools that promise nothing. No numbers —
//     step size varies by lift. Copy signed off 2026-07-13 ("The bar
//     gains a little" struck in review).
// ─────────────────────────────────────────────────────────────────────────────

import { effortForRpe } from "./tokens.js";

const PULL_PRIMARIES = new Set(["Lats", "Upper Back", "Rear Delts", "Traps", "Biceps", "Forearms", "Hamstrings", "Erectors"]);

// Is this movement a pull — rows, pull-ups, hinges, cleans, curls? Judged
// from the anatomy primary when the caller has it, the name otherwise.
export function isPullMovement(name, primary = null) {
  if (primary && PULL_PRIMARIES.has(primary)) return true;
  return /\b(row|pull|chin|deadlift|rdl|clean|shrug|curl|swing|pull-?through|hyperextension|hip extension)\b/i.test(String(name || ""));
}

export const FLASH_LINES = {
  add: [
    { text: "Next time, heavier." },
    { text: "It goes up from here." },
  ],
  easy: [
    { text: "You moved through that like a warm-up. Almost rude." },
    { text: "Light. Enjoy that while it lasts." },
    { text: "The bar will hear about this.", bar: true },
    { text: "Too comfortable. Consider it corrected." },
  ],
  normal: [
    { text: "Right in the seam." },
    { text: "Clean pull, clean release.", pull: true },
    { text: "You rode the edge." },
    { text: "Honest work. It counts." },
  ],
  cooked: [
    { text: "Still standing. Beautiful." },
    { text: "Everything you had. Well spent." },
    { text: "Nothing left in it. Good." },
    { text: "Same bar next time. It'll feel different.", bar: true },
  ],
};

/**
 * Pick a flash line for the just-rated final set.
 * @param {string} effort  "easy" | "normal" | "cooked"
 * @param {object} [opts]
 * @param {boolean} [opts.fullReps]   Did the set hit its rep/second target?
 * @param {boolean} [opts.barLoaded]  False for bodyweight movements.
 * @param {boolean} [opts.pullMovement] True for rows, pull-ups, hinges — gates pull-specific copy.
 * @param {Set<string>} [opts.used]   Lines already shown this session.
 * @param {boolean} [opts.addLikely]  Caller-certified unambiguous ADD case —
 *   see the honesty rules above. Only then may the line state a consequence.
 * @returns {string|null}
 */
export function pickFlashLine(effort, { fullReps = true, barLoaded = true, pullMovement = true, used = new Set(), addLikely = false } = {}) {
  // Numeric RPE (the continuous track) bands to the pool vocabulary here;
  // enum-era strings pass through.
  if (typeof effort === "number" && Number.isFinite(effort)) effort = effortForRpe(effort);
  const pool = addLikely && fullReps && effort !== "cooked"
    ? FLASH_LINES.add
    : effort === "easy" && !fullReps ? FLASH_LINES.normal : FLASH_LINES[effort];
  if (!pool) return null;
  const eligible = pool.filter((l) => (barLoaded || !l.bar) && (pullMovement || !l.pull));
  if (eligible.length === 0) return null;
  const fresh = eligible.filter((l) => !used.has(l.text));
  const pickFrom = fresh.length ? fresh : eligible;
  return pickFrom[Math.floor(Math.random() * pickFrom.length)].text;
}
