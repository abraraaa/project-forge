# Changelog

All notable changes to Forge.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Dates are when changes landed on `main`. Entries are grouped by release theme rather than calendar.

## Unreleased

Items in flight on `main` but not yet tagged. Tagged releases will move them into a dated section below.

### Added
- **Visual polish — focus-aware accents, per-day rim glows, victory gradient, Kodak Portra grain.** Four small touches that add depth without breaking the editorial restraint:
  - **Focus-aware accent.** New `T.focusAccent` palette (Forged = gold, Strong = deeper coral, Sculpt = soft mauve-rose). Surfaces as a third backdrop rim glow on home + the italic flourish colour on the home headline ("Squat & Push" italic now reads in the user's identity colour). Day-type accent stays dominant — focus is the quieter "you-are-here" layer.
  - **Per-day rim lighting.** Each day type's secondary glow now sits in a different corner with a different size — strength leads from top-right (intense), Z2 drifts from bottom-left (settled), HIIT counterbalances top-left (sharp), cardio sits mid-right (sustained), rest near-invisible. Backdrop gains dimensional depth without adding chrome.
  - **DoneScreen victory gradient.** Tighter warm-peach radial above the headline + a broader linear wash extending down. Lands a small triumph beat at the moment the user has just put the work in — non-patronising, on-brand.
  - **Kodak Portra grain.** New `<GrainOverlay/>` component mounted once in `app/layout.jsx`. Inline SVG `feTurbulence` noise, warm-tinted via colour matrix, ~5% opacity, `mix-blend-mode: overlay`. Adds a lived-in tactility to every surface without competing with any content. Pure CSS / no asset to ship.
- **Session overview sheet — jump to any block mid-session.** Tap the session-name area in the SessionScreen header (now with a small `▾` indicator) to open a bottom-sheet listing every block in today's session with its state (Current · Done · Partial · Up next) and `pairs/total sets` progress. Tap any block to jump to it; the engine resumes `setNum` from the draft log so a partially-completed block picks up at the right next set. Auto-advance still happens for users who don't open this surface — it's an escape hatch for busy gyms, not a default-flow change.

### Fixed
- **DoneScreen "weight updated" no longer references the SESSIONS template starting weight.** A user training at 100kg Bench for weeks was seeing `50 → 100kg` after every session because `base` was reading from `b.ex.weight` (the template seed) instead of "your weight at the start of this session." Now `base` snapshots `workingWeights` on `handleReadinessStart`; the `current → base` diff only shows when the engine genuinely bumped weight during the session.
- **"Edit week →" link visibility** on the home screen — was `T.text4` (dimmest tone, easy to miss); now `T.sage` so it reads as a session-control affordance rather than a dim hint.

### Added (continued)
- **Focus volume + rep-range adjustments (PR-D of N).** The focus picker now actually changes the *programming*, not just the exercise selection. **Strong** drops one accessory superset per day (`ass2` / `bss2` / `css3` — the lowest-yield-for-strength supersets) and shifts surviving accessory reps to **6–8**; mains and finishers untouched. **Sculpt** identifies slots whose currently-active exercise has a **visible-muscle primary** (`SCULPT_ALIGNED_PRIMARIES` = Chest / Front+Side Delts / Biceps / Triceps / Glutes) and adds **+1 set** to those slots with reps shifted to **12–15**; non-aligned slots and other day blocks untouched. **Forged** is bit-identical to prior behaviour. Primary-only alignment was chosen over score-based to keep the bump honest — bumping a Quads-primary compound just because it has a Glutes secondary would add more Quads than Glutes per set, contradicting the spec. Volume audit now accepts `{focus, config}` so per-muscle totals reflect what the user actually does, not the static template. UI threads focus through the live session render + the home-screen session preview, so today's block list and the upcoming-session card show the user's real plan. Static audit run with `npm run audit:volume` still surfaces the trade-offs honestly: Sculpt keeps the programme within MEV..MRV; Strong drops Biceps + Triceps under MEV (the explicit "fewer isolations" trade-off acknowledged in the Strong summary copy).
- **Verified YouTube IDs for 9 more exercises (batch 6).** Applied Gemini's verified video JSON for the always-null set surfaced after the focus-picker library deepening: 45-Degree Hip Extension, Captain's Chair Raise, Hanging Knee Raise, L-Sit Hold, Reverse Hyperextension, Single-Leg RDL, Sissy Squat, Toes-to-Bar, Windshield Wiper. All 9 names matched, 0 overwrites (all previously null). Cumulative `vid: null` slot count: 45 → 38.
- **Rotation choice prompt at 8 weeks (PR-C of N).** At `ROTATION_AUTO` weeks on a block, the rotate card now offers a "Choose →" button instead of going straight to rotation. The choice modal asks: (1) Refresh exercises within the current focus, or (2) Change focus altogether (which re-rotates as a side effect of the focus-save handler). Pre-8-weeks behaviour unchanged — the card still rotates on tap. Auto-rotate at session start (the `beginSession` path) is unchanged too.
- **Focus picker — engine + Profile UI (PR-B of N).** New training-focus option per profile: **Forged** (balanced default), **Strong** (compound-priority, strength-first), **Sculpt** (visible-muscle bias — chest, shoulders, arms, glutes). Engine biases via anatomy-driven scoring + weighted random pick inside `rotateAccessories(history, { focus })`. Forged is bit-identical to prior uniform behaviour; Strong scores compoundness (primary + secondary muscle sum); Sculpt scores via a visible-muscle weight vector. Comprehensive by construction — every accessory slot still rotates; bias only changes *which alternative within each slot* is favoured. Saving a new focus re-rotates accessories immediately within the current block (block number / startDate preserved). Picker is a Profile-screen sheet with per-focus summary copy; the resulting rotation-summary modal shows the user exactly what shifted. `FOCUS_SUMMARIES` is the single source of truth for the per-focus copy so picker + Profile row stay aligned. **Mass** was deliberately renamed to **Sculpt** for unisex framing — locked by an invariant test so it doesn't regress.
- **Library deepening for focus picker (PR-A of N).** Five new curated anatomy entries and four new pool members targeting glute / posterior chain / quad isolation depth, in preparation for the focus-picker feature. Pool adds: **Single-Leg RDL**, **45-Degree Hip Extension**, **Reverse Hyperextension** → `ass2-A` (hip thrust slot); **Sissy Squat** → `bss1-A` (Leg Press slot). Anatomy-only (no clean slot fit): **Hip Adduction**. All adds carry the correct `loadProfile` and slot the existing invariants pass cleanly. Volume audit unchanged (additions are alternatives, not slot defaults).
- **Cardio-day bonus challenges (Tier 3 #8, absorbing #7).** Optional 5-minute capacity finishers — Hyrox/calisthenic flavour (sled push, wall balls, sandbag/farmer carries, pistol squats, KB swings, devil's press, row/bike sprints) — offered on Moderate Cardio + HIIT days only. Never on Zone 2 (anaerobic spikes defeat Z2's recovery purpose), rest, or strength days. Framed as "Today's bonus · optional", never homework. Deterministic per-day pick (stable within a day, varies day-to-day). Completion tracked in a separate `bonusDone` store with **zero streak/rhythm impact**. Tier 3 #7 (Hyrox finishers in the strength-day finisher slots) was folded into this — those movements are metabolic + full-body and don't belong in the muscle-specific, `light_high_rep` isolation finisher slots; the calisthenic *core* variety #7 envisioned (L-Sit, Toes-to-Bar, Windshield Wiper) already exists in the finisher pools.
- **Service-worker silent update (PR-C of N).** When a new service-worker build takes control of an existing tab, the registrar schedules a `window.location.reload()` for the next moment the tab is hidden (background, switch app, lock screen). User never sees a reload flash — next time they look at the tab, it's already on the new version. First-time installs do NOT trigger a reload; only the upgrade case does. No popups, no banners — Ballerina-lean.
- **Service-worker app-shell cache (PR-B of N).** The SW now precaches the small static set (manifest + icons) at install, and applies per-path runtime caching: cache-first for `/_next/static/*` (immutable, content-hashed) and root binary assets (icons / fonts), network-first with cache fallback for HTML / navigation (online users get fresh, offline users get the last cached shell), network-only for `/api/*` (auth + sync must never see stale responses). Cache versioning via `SW_VERSION` — `activate` cleans up older `forge-*` caches automatically.
- **Service-worker scaffold (PR-A of N).** Wires up the SW lifecycle — `public/sw.js` installs and activates, `<ServiceWorkerRegistrar/>` registers it from the layout. No fetch interception, no caching yet — zero behavioural change. Foundation for the incremental offline-PWA work (app-shell precache → API strategy → IndexedDB session-log queue → background sync → update prompt). Escape hatch: `?nosw=1` on any URL unregisters all SWs + clears caches.

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
