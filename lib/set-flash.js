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
//   · No repeats within a session (caller passes the `used` set); when the
//     pool is exhausted, reuse beats silence.
// ─────────────────────────────────────────────────────────────────────────────

export const FLASH_LINES = {
  easy: [
    { text: "You moved through that like a warm-up. Almost rude." },
    { text: "Light. Enjoy that while it lasts." },
    { text: "The bar will hear about this.", bar: true },
    { text: "Too comfortable. Consider it corrected." },
  ],
  normal: [
    { text: "Right in the seam." },
    { text: "Clean pull, clean release." },
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
 * @param {Set<string>} [opts.used]   Lines already shown this session.
 * @returns {string|null}
 */
export function pickFlashLine(effort, { fullReps = true, barLoaded = true, used = new Set() } = {}) {
  const pool = effort === "easy" && !fullReps ? FLASH_LINES.normal : FLASH_LINES[effort];
  if (!pool) return null;
  const eligible = pool.filter((l) => barLoaded || !l.bar);
  if (eligible.length === 0) return null;
  const fresh = eligible.filter((l) => !used.has(l.text));
  const pickFrom = fresh.length ? fresh : eligible;
  return pickFrom[Math.floor(Math.random() * pickFrom.length)].text;
}
