// @ts-check
// lib/session-progress.js
// How far each block of a live session has got, read from the draft. A block's
// count is the most sets logged against any one of its exercises: a superset
// logs A and B once per round, so that is its rounds. Same maths as the
// overview sheet and the jump/resume paths in SessionHost.

/**
 * Sets (supersets: rounds) logged on one block of the draft.
 * @param {any} draft  the live draft log, or null
 * @param {string} blockId
 * @returns {number}
 */
export function loggedOnBlock(draft, blockId) {
  const saved = draft?.blocks?.[blockId];
  if (!saved?.exercises) return 0;
  return Math.max(0, ...Object.values(saved.exercises).map((ex) => (ex?.sets || []).length));
}

/** The name a block goes by on a button: its exercise, or a superset's A. */
export function leadExerciseName(block) {
  return (block?.ex ?? block?.exA)?.name ?? block?.label ?? null;
}

/**
 * Blocks, other than the current one, with fewer sets logged than prescribed.
 * Skipped blocks (0 logged) count; extra sets past the prescription are fine.
 * @param {{ blocks: any[] }} session  the active (scaled) session
 * @param {any} draft
 * @param {number} [currentIdx]  excluded; defaults to the last block
 * @returns {{ idx: number, block: any, logged: number, total: number }[]}
 */
export function unfinishedBlocks(session, draft, currentIdx) {
  const blocks = session?.blocks || [];
  const skip = currentIdx ?? blocks.length - 1;
  const out = [];
  blocks.forEach((block, idx) => {
    if (idx === skip) return;
    const total = block?.sets || 0;
    const logged = loggedOnBlock(draft, block?.id);
    if (logged < total) out.push({ idx, block, logged, total });
  });
  return out;
}
