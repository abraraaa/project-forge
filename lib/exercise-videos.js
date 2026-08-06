// @ts-check
// lib/exercise-videos.js
// ─────────────────────────────────────────────────────────────────────────────
// Demo footage for exercises that have no natural home in programme.js —
// anatomy-only names (travel movements, standalone catalogue entries) whose
// video cannot ride a SESSIONS/pool/swap entry.
//
// EVERY id here must be VERIFIED footage: either an id the app already
// serves elsewhere, or one that has passed the oEmbed check
// (scripts/verify-videos.mjs, run from the Verify videos workflow — the
// authoring sandbox has no YouTube egress). The 2026-08-06 sourcing batch is
// the cautionary tale: 24 of its 32 fresh ids were fabricated, and most of
// the metadata around the real ones was confabulated. Nothing lands here on
// a model's say-so.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Record<string, string>} */
export const EXTRA_VIDEOS = {
  // Same-movement reuse of footage the app already serves (2026-08-06):
  // the DB Floor Press demo IS a floor press; Slider and Sliding Leg Curl
  // are one movement; the dips demo covers both dips entries.
  "Floor Press": "uUGDRwge4F8",       // DB Floor Press
  "Sliding Leg Curl": "lLUniqm00KM",  // Slider Leg Curl
  "Tricep Dips": "2z8JmcrW-As",       // Weighted Dips
};
