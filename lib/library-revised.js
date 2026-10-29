// @ts-check
// lib/library-revised.js
// The library's revision date on its own. lib/library.js builds the whole
// catalogue when it loads; the app's re-plans (lib/profile-actions.js) key
// on this date and must not pay for that build.

/**
 * When the catalogue or the data behind it last changed — the sitemap's
 * lastmod for every library URL.
 *
 * A DELIBERATE constant rather than build time: a redeploy that changed no
 * exercise data would otherwise claim every one of the 168 pages was revised,
 * which is the freshness equivalent of keyword stuffing. Retrieval systems
 * weight recency, so the signal is only worth having if it's true.
 *
 * BUMP THIS when EXERCISE_ANATOMY, EXERCISE_TEMPO or SWAP_DB gain or change
 * entries. Last: 2026-10-29, Push Press gains a Calves credit.
 */
export const LIBRARY_REVISED = "2026-10-29";
