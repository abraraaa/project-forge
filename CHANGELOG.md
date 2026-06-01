# Changelog

All notable changes to Forge.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Dates are when changes landed on `main`. Entries are grouped by release theme rather than calendar.

## Unreleased

Items in flight on `main` but not yet tagged. Tagged releases will move them into a dated section below.

### Changed
- **Licensing clarified — AGPL-3.0 + commercial dual-licence path.** Added an explicit copyright preamble to `LICENSE`, set `"license": "AGPL-3.0-only"` in `package.json`, and added `LICENSING.md` documenting the dual-licence terms. The underlying AGPL-3.0 text is unchanged — what changed is *attribution* (copyright is now explicitly held by wondabrar) and *commercial reservation* (a paid licence is available for use cases AGPL-3.0 doesn't cover: closed-source SaaS, white-label, proprietary integrations).

---

## Tier 2 — programme intelligence

The volume-audit foundation and the Rotation V2 overhaul that builds on it.

### Added
- **Live volume-vs-MEV/MAV/MRV card** (PR #76). Performance Lab surfaces the trailing 4 weeks of actual training, flagging muscles below MEV or above MRV per granular muscle (per-delt-head, biceps/triceps distinct). `auditHistoryVolume(history, opts)` helper.
- **Main-lift functional swap pools** (PR #75). `SWAP_DB` rewritten for all five main lifts to heavy-low-rep equivalents only (Front Squat / Hack Squat / DB Bench / Incline BB Press / Sumo DL / Push Press / Hang Power Clean). Lighter substitutes (Goblet Squat, Push-Up, Kettlebell Swing) removed. New canonical `MAIN_LIFT_FUNCTIONAL_EQUIVALENTS` map enforced by invariant tests.
- **Anatomy-aware rotation summary card** (PR #74). Top muscle-stimulus deltas (e.g. *"+2.4 Shoulders · −1.8 Glutes"*) rendered as coloured pills in the rotation modal. `computeRotationStimulusDelta(oldConfig, newConfig)` helper.
- **`loadProfile` tag + slot filter** (PR #73). Every exercise instance and every `EXERCISE_POOLS` slot declares one of `heavy_low_rep` / `moderate_mid_rep` / `light_high_rep` / `metabolic`. Rotation filters candidates by profile so a heavy lift can't leak into a finisher slot. New pool-integrity invariant.
- **3-block rotation memory** (PR #72). `ROTATION_MEMORY_BLOCKS = 3`. Kills the A→B→A ping-pong single-block exclusion caused. Per-slot history is now a `[name1, name2, name3]` array; legacy single-string entries are accepted transparently. New `pushHistoryBlock(prev, activeConfig)` helper.
- **Programme rebalance v1** (PR #71). Cleared every flag the audit raised: Day C `css1.exB` Cable Pull-Through → Cable Lateral Raise; Day A finisher 2→3 sets; Day C finisher 2→3 sets. Glutes 17.4 → 14.4 (clears MRV), Side Delts 3.4 → 6.5 / Rear Delts 4.9 → 6.2 / Calves 5.9 → 6.9 (all clear MEV).
- **Volume-audit helper** (PR #70). `lib/volume-audit.js` + `npm run audit:volume` script. Weekly weighted-set volume per granular muscle, banded against MEV/MAV/MRV. The measurement foundation for the rebalance.

---

## Tier 1 — launch backlog finish

### Added
- **Verified YouTube IDs for 119 exercises** (PRs #67, #69). Five batches of Gemini-verified video IDs applied to `lib/programme.js` `vid:` fields. 168 → 45 null slots remaining.
- **VideoEmbed search-deeplink fallback** (PR #68). When an exercise has no demo video linked yet, the modal now renders a "Search YouTube ↗" link pointing at `youtube.com/results?search_query=<name> form` — so every exercise has at least a path to a tutorial.

### Fixed
- **Hooks hygiene** (PR #66). Resolved `react-hooks/purity` + `set-state-in-effect` errors surfaced by `eslint-config-next` 16. Rules back to `error` (no warn downgrade).

---

## Polish + housekeeping (ongoing)

### Added
- **Programme-config reset button** (PR #77). Small "Reset accessories to defaults" link on home, only visible when there's rotation drift. Two-tap inline confirmation, no modal, 5s auto-disarm. Keeps `programmeBlock.number` and `startDate` — only undoes the rotation drift.

### Changed
- **`rpeToRir` boundary handling** (PR #77). Now emits a `console.warn` for unrecognised inputs (typos, casing drift, future labels) instead of silently returning `null`. Legitimate "no RPE" values (`null` / `undefined` / `""`) stay silent. Comprehensive boundary test coverage added (`tests/rpe-rir.test.js`, +31 tests).

---

## Earlier ship history (pre-CHANGELOG)

Selected milestones from the project doc's "SHIPPED" list — captured here for posterity. Detail per change lives in the relevant PR.

### Stack
- Upgraded to Next.js 16 / React 19 / ESLint 9 flat config / Turbopack. Node 22 in CI.

### Programme & engine
- 9-bucket muscle palette + analytics `DISPLAY_BUCKET` migration (Quads / Glutes / Hamstrings / Calves / Chest / Back / Shoulders / Arms / Core).
- Grok-driven weight recalibration to intermediate-novice floors + `loadType` on every exercise.
- `loadType` wired through analytics (per-DB exercises doubled for systemic volume) and the set-logging UI (per-DB / barbell / machine / added-weight captions).
- BW%-based starting weights for main lifts (Hex Bar DL 1.0× · Back Squat 0.75× · Bench 0.65× · OHP 0.40× · Power Clean 0.50×).
- Progression engine reconciliation fix — `liftState` now reconciles with the performed weight (the *"100 kg @ hard suggested >100 kg"* bug).
- Retro/missed-workout timezone fix — BST users can no longer slip a day in the retro picker.
- 7 duplicate exercise names canonicalised (Skullcrusher, Tricep Pushdown, Hammer Curl, DB Kickback, Incline DB Press, DB Floor Press, Bulgarian Split Squat).
- Critical `rpeToRir` fix — `easy / normal / cooked / hard / limit` all mapped (an earlier version dropped every default-RPE set to `null` and broke progression across the entire user base).

### UX
- Hydrating "Restoring" gate on profile activation (blocks the empty-UI flash).
- Heatmap label / square alignment fix.
- Programme finisher swaps: Day A calf raise · Day B Tricep Pushdown · Day C Skullcrusher.

### Infrastructure
- Deterministic blob paths (`allowOverwrite`) + daily cleanup cron + `vercel.json` schedule.
- CI workflow (lint / test / build) + branch protection on `main`.
