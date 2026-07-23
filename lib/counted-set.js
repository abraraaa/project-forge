// @ts-check
// lib/counted-set.js
// ─────────────────────────────────────────────────────────────────────────────
// THE counted-set rule (audit #68 — previously copy-pasted 5× with drifting
// guards). A set is performed evidence when it carries a logged weight OR
// logged reps; a row with neither is scaffold the user never touched.
//
// Semantics, deliberately unified:
//   - `s` itself may be null/undefined (defensive vs malformed history rows).
//   - weight: null AND undefined both mean "not logged". Canonical writers
//     normalise to null (`weight: weight ?? null`, lib/storage.js logSet), so
//     on real data this is identical to the old `!== null` copies; undefined
//     only appears in hand-crafted or pre-normalisation rows, where counting
//     it as logged was always wrong.
//   - reps: truthy check — 0 reps is not evidence of a performed set.
// ─────────────────────────────────────────────────────────────────────────────

export function isCountedSet(s) {
  return !!s && (s.weight != null || !!s.reps);
}
