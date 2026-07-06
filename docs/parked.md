# Parked

Things we explicitly chose not to ship right now, with enough context to pick
them back up without re-deriving why. Add new entries at the top; move
items to "Shipped" with the resolving commit when they land.

Format per entry: title · status · context (what's parked and why) · the
specific next step that would unblock it.

---

## Active parking list

### Microcopy & tone-of-voice pass — "quietly sexy", sensation-forward

**Status:** RESOLVED 2026-07-06 — both passes shipped same day. First
batch (readiness, RPE, rest, done screen, home) reviewed with two vetoes
honoured ("grinding" stays — "Hold — grind it smooth."; rest-day line is
"That's where *you* grow."). Positioning shipped: "Unveil the best you."
across metadata/manifest/README; onboarding's "A lean strength tracker"
(the last self-description as a tracker) replaced in the second pass.
Second-pass inventory found the remaining surfaces (retro link, passkey
nudges, overlays, glossary) already in register or correctly exempt as
pure instruction. docs/voice.md was deliberately RETIRED after shipping:
the register is codified as README design principle #11 (voice as innate
doctrine, not a patch log); the review record lives in PR #186. Entry
retained below for the original brief.

**Context:** Forge's visual language (Portra warmth, serif italics, film
grain) already carries the "quietly sexy" aesthetic; the microcopy mostly
doesn't — it's clear but utilitarian. The brief: lean the words into the
*sensation* of training — the stretch, the drive, the held breath, the
weight settling — **without obscuring clarity**. Clarity remains the gate:
a user mid-set gets instruction first, atmosphere second. The voice is
already "prescriptive, not punitive"; this pass adds *sensory* to that,
not slang or hype (no "crush it", no gym-bro register).

**Surfaces to inventory (first pass):** session screen (RPE card labels,
rest hints, deload tag, done screen), home screen day cards + streak
copy, Lab editorial lines (away-state, volume philosophy), library page
prose (contribution caption, tempo principles, footer), onboarding, and
the share-card footer line ("Train with intention." is the register to
match). Existing tempo notes ("back knee kisses floor", "feel the
stretch") already hit the target voice — use them as the reference.

**Progress (2026-07-06):** docs/voice.md drafted — register rules (the
five: clarity gate, sensation-not-hype, prescriptive-not-punitive, quiet
confidence, mid-set test) + before/after tables covering readiness, RPE,
rest, done screen, home, Lab, library, share card. ~10 proposed changes,
the rest explicitly marked keep. Awaiting joint review; no strings
changed in code yet.

**Next step:** review docs/voice.md together, approve/strike per row,
then ship approved rows in one commit referencing the doc. Second-pass
inventory (onboarding, overlays, notifications) after the first batch
lands.

### Fresh-visitor hydration mismatch on / (React #418)

**Status:** RESOLVED 2026-07-06 — and it was bigger than filed: the
unminified diff showed the server ALWAYS rendered ProfileScreen ("Who's
training?") and React regenerated the whole tree for EVERY cohort on
every cold document load (fresh, profile-less, and seeded active users
all threw #418; /performance and /profile mismatched the same way).
Fix: components/client-shells.jsx — all four LS-determined route views
(/, /performance, /profile, /session) now mount client-only via
next/dynamic ssr:false with an empty full-height field as the loading
shell. No server tree → no mismatch; the #179 lazy initializers work
unchanged; probed before/after, client-back and reload scroll numbers
are identical (166→221 drift and reload→0 are PRE-EXISTING, see below)
and all routes are hydration-clean for fresh and seeded contexts.
Two pre-existing observations spun out while probing: client-side back
restores with a +55px drift (content shift between visits — likely a
Fade/nudge card), and document-RELOAD restoration misses entirely
(166→0, both before and after the fix) — these are the parked
"first-traversal restoration miss", now with measurements.

**Repro:** brand-new browser context (no localStorage at all), production
build, load `/` → React error #418 (server text ≠ client text,
`args[]=text&args[]=` — one side rendered text, the other empty), React
regenerates the tree client-side. Console-only for users but it means
first paint gets thrown away on the first-ever visit.

**Suspect:** the instant-home-hydration lazy LS initializers (#179) —
verified at the time with SEEDED storage (existing profile), never with
a truly empty browser. Something in the ForgeApp screen gate or a
date-derived string renders differently server-side vs fresh-client.

**Next step:** run the non-minified dev build in a fresh context and read
the full #418 diff to identify the exact text node; fix at the source
(likely a lazy initializer branching differently on `typeof window` vs
empty-LS, or a locale/timezone-dependent date string). Do NOT wallpaper
with suppressHydrationWarning.

### PWA manifest + app-capabilities enrichment (PWABuilder gaps)

**Status:** Identified via PWABuilder audit; deferred until after PR3.

**Context:** PWABuilder scored Forge 16/45 on manifest fields and flagged
Service Worker + App Capabilities. Breakdown:

- **Service Worker flag is likely a false negative.** Our SW
  (`public/sw.js`, client-registered via `components/ServiceWorkerRegistrar.jsx`)
  demonstrably works — sync runs through it, cache versioning + the SW
  update lifecycle are live. PWABuilder's static/headless analyzer often
  misses client-registered SWs because it doesn't always execute the
  registration JS at fetch time. VERIFY before "fixing" — there may be
  nothing to fix. If it IS a real gap, the cause is most likely the SW
  not being registered/scoped where PWABuilder's crawler looks.

- **Manifest 16/45 is real but all-additive.** `public/manifest.json` is
  deliberately minimal (name, short_name, description, start_url, display,
  background/theme color, orientation, icons). The ~29 unused fields are
  optional richness: `screenshots` (powers the richer iOS/Android install
  sheet), `shortcuts` (long-press app-icon quick actions — e.g. "Start
  today's session", "Log past workout"), `categories`, `display_override`
  (e.g. `window-controls-overlay`), `launch_handler`, `share_target`
  (receive shared content), `file_handlers`, `protocol_handlers`,
  `edge_side_panel`, `widgets`, `iarc_rating_id`, `related_applications`.

- **App Capabilities** flagged for the same unused-surface reasons —
  share target, shortcuts, side panel, file handling, etc.

**Why deferred:** none are urgent and several intersect the PR3
routes-vs-SPA decision (e.g. `shortcuts` deep-link to specific app states,
which is cleaner with real routes than with `setScreen` state). Doing them
before PR3 risks rework. Also: most "experiential chrome" wins (shortcuts,
share_target) are higher-value once the app has stable URLs to target.

**Progress (2026-07-04):** `categories` + `shortcuts` shipped — the 3d/3e
route work gave shortcuts stable URLs to target (Performance Lab →
/performance, Profile → /profile; both long-press quick actions reuse the
flat maskable icon). Manifest theme/background colours aligned with the
chrome-sampling tone (#1D1A19). `screenshots` shipped 2026-07-05
(Chromium-captured home + profile at 1206x2622, form_factor narrow —
richer install sheet). Still parked: the SW-flag verification and the
share_target / file_handlers evaluation.

**Next step:** (1) Confirm whether the SW flag is a real gap or a
PWABuilder artifact — test the deployed URL, check SW scope. (2) Add
`screenshots` once capture assets exist (install-sheet polish). (3)
Evaluate `share_target` / `file_handlers` against actual user flows —
only add capabilities we'll genuinely wire up, not score-chasing. Re-run
PWABuilder to confirm lift.

**"Share metrics" button (Performance Lab) — SHIPPED 2026-07-05:** a
one-way export of a point-in-time trend-line snapshot. Stays true to
"deliberately not social" — streamlines the social-CURIOUS without
building a social graph (no account-linking, feed, or Forge-side sharing
backend; the user pushes an artifact to wherever THEY choose).
Implementation: `lib/share-card.js` renders the active lift's e1RM series
to a 1080×1350 branded canvas (Forge palette, headline value + delta,
coral trend line, theforged.fit footer); "Share ↗" in the 1RM card hands
the PNG to `navigator.share({ files })`, with a plain download fallback
where file-share is unsupported (desktop Safari/Firefox — the fallback is
also the Chromium-verifiable branch; the share sheet needs a device).

IMPORTANT distinction so we build the right primitive:
- This is the **Web Share API** (`navigator.share({ files: [...] })`) —
  OUTBOUND. A runtime API, NOT a manifest field.
- It is NOT manifest `share_target`, which is INBOUND (makes Forge appear
  in other apps' share sheets to RECEIVE content) — off-brand here.

Real work is the artifact generation, not the share call: render the
Performance Lab trend line to a canvas → PNG (or a styled snapshot card),
then hand it to `navigator.share`. The share call itself is trivial.
Graceful fallback where Web Share is unsupported (desktop Safari/Firefox):
download the PNG or copy-to-clipboard. Belongs with the Performance Lab
polish item.

### Packaging — scroll-under status bar / chin

**Status:** RESOLVED (2026-07-03/04) — superseded by the chrome-
translucency arc: viewport-fit cover + black-translucent, no fixed
elements at viewport edges, natural root scroller, `.forge-page`
substrate carrying safe-area padding, and chrome-sampling tone matched
to the grain-lifted field (#1D1A19). The scroll-under look this entry
wanted is live; the /diag-status experiment below never became
necessary. Entry retained for history.

**Context:** Current iOS PWA recipe (no `viewport-fit: cover`, fixed 52px
top padding on screens) renders three visible bands — flat #131110 status
bar / grain-textured body / flat #131110 home indicator. The grain
overlay's `mix-blend-mode: screen` at 12% opacity lifts the body's
perceived luminance just enough that the bar zones read as separate
"black" surfaces. WebKit dev guidance (2026-06) confirms Home Screen web
apps can't draw arbitrary content behind the status bar, so the recipe
is "lean into native iOS PWA conventions" not "imitate Safari Chrome."

**Next step:** Build `/diag-status` route with its own nested layout that
sets `viewportFit: "cover"` for that path only (Next.js App Router
supports per-segment viewport metadata; manifest is global and carries
no viewport info, so no conflict). Mirror a real screen on the page with
the proposed packaging: viewport-fit:cover + grain via `body::before`
background-image with a `mask-image` gradient that fades grain out in
the top safe-area-inset zone and bottom chin zone, plus a visible
vertical ruler so scroll motion is observable. Compare on PWA before
cutting over `app/layout.jsx`.

### Grain texture — move from full-viewport overlay to body background

**Status:** RESOLVED (2026-07-03) — superseded by the appearance-coherence
pass. Final architecture: grain lives in the GrainOverlay component at
z-index −1 (BEHIND the app — v0's restoration kept the substrate
semantics), and surfaces sit over it as glass via the shared
`.forge-glass` class in globals.css (translucent bg2 + blur/saturate,
with `@supports` opaque fallback and a `prefers-reduced-transparency`
fallback). Applied to: ui.jsx Card, PerformanceLab cards, the sync
cards, and the six ProfileScreen panels. Deliberately excluded: form
inputs (caret legibility) and dialog surfaces on blurred scrims
(glass-on-glass double-blur). Cross-referenced against WebKit: unprefixed
backdrop-filter (Safari 18+; our baseline 26.2+), Safari 26.5 ships no
web material primitives (blur+saturate is the web ceiling), reduced-
transparency support pending in WebKit (bug 175497) but the fallback is
in place for the day it ships. Entry retained for the history; original
plan below.

**Amendment (2026-07-03):** the grain layer is no longer `position:
fixed`. Live-device screenshots showed Safari 26 rendering opaque
colour-extension slabs behind the status bar and URL bar (no
scroll-under translucency, and an unpredictable toolbar tint that picked
up the Begin-session CTA). Root cause per WebKit bug 301756 + the iOS 26
tinting write-ups: any fixed/sticky element bordering a viewport edge
opts the page out of translucent chrome, and our full-viewport fixed
grain bordered both edges on every screen. Grain now lives as an
absolute z −1 child of the document-height `.forge-page` wrapper
(app/layout.jsx) and scrolls with content — no fixed element at the
edges, chrome tint falls back to body's solid #131110, content slides
under the bars natively. This is close in spirit to the original
body-background plan below, but keeps the element (blend mode + view-
transition opt-out need one) rather than a `body::before`.

**Context:** `components/GrainOverlay.jsx` is a `position: fixed` element
at zIndex 1, mix-blend-mode: screen. It composites over EVERYTHING below
zIndex 300 (modals) — including cards, buttons, headers. The visual
result is "everything is one photo" rather than "cards and buttons sit
on a textured field as physical objects." Also produces the band-seam
issue (above) because the overlay extends to the body's edges but the
iOS-reserved bar/chin zones aren't covered by the overlay.

**Next step:** Replace the GrainOverlay component with a body-background
implementation. Same SVG turbulence data URI; lives in
`globals.css :root::before` or `body { background-image: … }` with a
mask-image linear-gradient that fades the texture to transparent in the
first ~env(safe-area-inset-top) + 80px and the last ~80px so the grain
band sits cleanly inside the safe area. Cards retain their flat T.bg2
backgrounds; the texture only paints behind them.

### Glow drift "hops" on short pages (non-strength days)

**Status:** RESOLVED (2026-07-04) — `animation-range: 0 200vh` on
`.forge-glow-anchor` pins the timeline to an absolute length, making the
drift rate constant (~0.21×) on every page; verified in Chromium that
progress now tracks scroll distance, not per-page span. Diagnosis
retained below.

**Symptom:** on non-strength days the home page is short (small scroll
range), and the day-accent glow visibly hops up/down while scrolling.

**Diagnosis:** `.forge-glow-anchor`'s scroll-driven animation maps
0→42vh of translate over the FULL document scroll range (`scroll(root)`
with default range). On a long page that's a gentle ~0.4× drift; on a
~150px-range rest-day page the same 42vh compresses into that tiny
range, so the glow moves at >2× scroll speed — and iOS rubber-band
overscroll drives the timeline progress past its bounds and back,
reading as a hop.

**Fix sketch (one line):** pin the mapping to an absolute length so the
drift rate is constant on every page: add `animation-range: 0 200vh;`
to `.forge-glow-anchor` (progress = scrollY / 200vh regardless of page
length → 42vh drift over 200vh of scroll ≈ 0.21× everywhere; short
pages simply use the first slice of the curve). Already inside the
@supports gate; test on a rest day + Performance Lab.

### Performance Lab scroll-under — blocked on instant home hydration

**Status:** RESOLVED 2026-07-06 — instant home hydration shipped (mount
gate removed, hydrating splash only fires for genuinely-empty LS,
history lazy-hydrated) and the @overlay interception deleted. The twist:
the overlay PARALLEL SLOT itself was suppressing the browser's native
popstate scroll restoration (removing it, back-from-Lab restores
natively — measured 166 → 166 in Chromium; headless-native probe
confirmed browser machinery works). The Lab is a real route everywhere:
scroll-under, VT slide, substrate — all inherited. Follow-up
observation: the FIRST traversal after a fresh load missed restoration
once in Chromium while subsequent ones restored; watch on device.

**Context:** the Lab (opened from Home) renders in the @overlay
intercepted route — a position:fixed opaque internal scroller. Fixed
internal scrollers can never get Safari's status-bar scroll-under (that
belongs to the ROOT scroller only), so the Lab is the one surface where
content doesn't slide under the clock. Removing the interception fixes
that instantly BUT regresses the thing the overlay was built for:
measured in Chromium, back-from-Lab loses Home's scroll (300 → 0)
because ForgeApp's mount/hydration gate collapses Home's height at the
exact moment the browser applies scroll restoration — the documented
"restore-then-jump" the overlay avoids.

**Next step (the real unlock):** make Home render at full height on
first client paint — hydrate ForgeApp's screen-critical state from LS
in lazy initializers instead of behind the mounted gate, so browser
scroll restoration lands on a full-height page. Once that holds, delete
app/@overlay entirely (one route architecture everywhere), and the Lab
inherits scroll-under + the ViewTransition slide for free. Do NOT
band-aid with a sessionStorage scroll stash — explicitly rejected
before.

### Grain "pops in" on route switch to /profile

**Status:** REOPENED 2026-07-06 — device says the pop-in is unchanged, so
the two shipped changes below were hygiene, not the cure. Next session:
reproduce with Safari devtools on-device (Web Inspector timeline over the
transition) rather than headless Chromium; the remaining suspects are
Safari-specific compositing of the isolated .forge-page (isolation +
blend layer re-rasterising after navigation commit) and the standalone
safe-area padding shifting layout post-commit. Shipped hygiene: (1) old(root) VT pseudo now opacity:0 — with animation:
none on both pseudos the UA default composited old AND new at full
opacity (plus-lighter), altering the substrate for the transition's
duration and snapping back at completion; (2) the grain's
view-transition-name is retired (its double-capture rationale died when
the grain moved outside the boundary), so browsers no longer snapshot
the document-height blended layer separately per transition. Not
reproducible in headless Chromium — if the device still shows it,
reopen with the angles below.

**Symptom:** navigating to profile view, the grain appears a beat after
the page instead of painting with it.

**Angles for next session:** (1) the ViewTransition boundary swaps
content while GrainOverlay lives OUTSIDE it at layout level — during
the slide, document height changes and the grain's inset:0 box resizes
after the new page commits; (2) the root VT group is pinned static
(animation:none) — check whether the new-root snapshot (which includes
grain) lands a frame late vs the boundary snapshot; (3) ProfileView's
bounce/hydration double-render may shrink then grow .forge-page.
Reproduce in Chromium with slowed VT durations before touching anything.

### Performance Lab — ideal rebuild (dedicated session)

**Status:** Queued by user 2026-07-05 for a fresh-credits session.

**Scope to unpack together:** instant home hydration (unlocks deleting
the @overlay interception → Lab gets scroll-under + VT slide as the
real route everywhere); the parked surface-polish + adherence-view
rethink; absence modelling (item 3 of the correctness log); share-
metrics export. One coherent design pass rather than four patches.

### Chrome-tone gaps on secondary surfaces (top/bottom bands)

**Status:** RESOLVED 2026-07-05 — user supplied screenshots for every
surface; all reduced to the substrate-edge rule (glow luminance clipped
at shell tops) + diag-sync's opaque background, fixed and
device-confirmed same day. The Lab status-bar scroll-under remains the
one exception, parked separately behind instant home hydration. Entry
retained for the recipe below, which is now the canonical diagnosis
path for any future band report.

**Report:** the status-bar/chin tone work doesn't extend to: onboarding
pages (both ends), /profile (status bar only), Performance Lab (chin
only), /diag-sync (both — also lacks a back button; swipe-back works, so
not urgent).

**Recipe (all remedies already proven elsewhere in this codebase):**
1. Chin = something crossing/stopping at the document end — check for
   bottom-anchored glow boxes cut mid-gradient (fix: anchor inside the
   page, see HomeScreen bottom:24) or an opaque background that ends
   before the chrome zone.
2. Status bar = the first ~safe-area of the page painting a tone other
   than the field — check for opaque headers/screens covering the
   .forge-page substrate near y=0, or screens that paint their own
   background instead of staying transparent over the substrate.
3. Fixed/sticky elements near either edge carrying background-color or
   backdrop-filter re-tint chrome — move paint to an absolute child
   (.forge-scrim pattern) or remove.

**Next step:** screenshot each surface at rest + full scroll on device,
match against the three causes, apply the matching fix. Also give
/diag-sync a "← Home" back nav while in there.

### In-session RIR threshold hints (power-user affordance)

**Status:** Parked 2026-07-04 (from the Copilot v1.5 review, item 9).

**Context:** The progression engine's ADD thresholds vary by exercise
category (e.g. lower_compound needs RIR ≥ 2, power ≥ 3) but the session
screen never says so — the engine reads as "quietly smarter" by design,
and for most users that opacity is the feature. For power users, though,
a tiny affordance ("2 reps in reserve adds weight next time") turns the
RPE tap from a mood report into a lever they understand.

**Next step:** Design call first, not code: does surfacing the mechanism
break the "prescriptive, not punitive" voice? If it survives that test,
the shape is a one-line hint under the RPE card (RpeCard already takes a
`label` prop), sourced from the same category-threshold table the engine
uses so it can never drift. Belongs with the session-screen polish pass.

### Progression history window depth (12 sessions) — v2 question

**Status:** Parked 2026-07-04 (from the Copilot v1.5 review, item 5).
Likely only material for true power users with long, consistent history.

**Context:** `liftState.history` caps at 12 sessions per lift. For the
current Phase 3 signals (stall detection, fatigue override) that window
is deliberately tight — roughly one mesocycle at 3 strength days/week —
so signals react to the CURRENT block rather than archaeology. The open
question for multi-year users: do slow-burn patterns (e.g. a lift that
stalls every third block, seasonal regression) need a deeper window or a
second, coarser aggregate (per-block summaries) alongside the tight one?

**Next step:** Decide with data, not speculation: once real users have
6+ months of history, sample whether any Phase 3 misfires trace to the
window edge. If a deeper view is needed, prefer adding a per-block
summary layer over widening the raw window (keeps signal reactivity).

### Performance Lab — correctness bugs (logged 2026-07-01, from real use)

**Status:** Confirmed bugs in live use; fix before the surface polish below.

1. **MEV / volume audit recency — FIXED** (`auditHistoryVolume` window 4→2
   weeks). Diagnosis: not a computation bug — the 4-week trailing average was
   too smoothing (one skipped week only moved it 25%, staying above MEV for
   muscles programmed at MAV). Shortened the rolling window to 2 weeks so a
   genuinely-skipped recent week halves the per-week figure and registers.
   Added an `away` state (empty window) that surfaces Forge's philosophy —
   *consistency over time compounds; a lighter stretch is not failure* — plus
   an editorial line under the card, rather than a wall of under-MEV alarms.
   New-user gate moved from window-session-count to total-session-count so a
   consistent user isn't mistaken for a beginner. Tests added. This also
   partially addresses item 3's "no concept of being off".

2. **Consistency grid day-letter alignment — FIXED.** Not a weekday-index
   bug (ordering was correct, both Monday-start): the labels were a
   fixed-pixel HTML flex column beside a width-scaled SVG, so on any real
   screen the SVG rows rendered taller than the 14px labels and drifted
   apart. Labels now live inside the SVG's own coordinate system, scaling
   with the cells — aligned at any width. STILL OPEN from this item: the
   presentation rethink ("a clearer way to present adherence-over-time
   than the grid") — that's design work, folded into the surface-polish
   item below.

3. **Lab paints history once; doesn't model "currently off".** — ENGINE
   LANDED 2026-07-06 (phase 0). `lib/absence.js` + `tests/absence.test.js`:
   absence is DERIVED (pure function of activity dates + cadence, zero new
   storage — principle #0 satisfied for free), measured in quiet days
   against the user's schedule, symmetric between closed and ongoing gaps.
   Turned out far simpler than this note feared — the "re-engagement flow"
   worry was a surface question downstream of a ~90-line model. Full design
   + roadmap + exact Lab wiring in **docs/absence-modelling.md**. STILL
   OPEN (phase 1, the surface): wire `current` into the Lab as a calm
   away-state banner (not built — deliberately left as the reviewable
   product call: Lab-only vs. also a home-screen nudge). Phase 2 (optional
   user annotations "travelling/injured") deferred — it's the only part
   that would need a store, gated behind proving the banner first.

### Performance Lab — surface polish

**Status:** Functionally complete, visually conservative.

**Context:** Performance Lab is a core pillar — the volume-vs-landmarks
audit + live history surfaces are accurate and operationally correct.
But the visual treatment doesn't pull its weight compared to the home
screen or session flow. Cards are utilitarian, the data is presented
without much editorial.

**Next step:** Design pass on the Lab screen. Apply the post-packaging
grain/scroll recipe. Consider whether the volume audit deserves a richer
visual format (small charts, sparklines, anatomy heatmap) or whether the
current text-led format is correct for the audience. Tied to the
"Modern interaction layer" item below.

### Modern interaction layer — beyond view transitions

**Status:** Aspiration, no design yet.

**Context:** The slide-up/slide-down view transitions ship and feel
right. But the rest of the app's interaction language is mostly
opacity/transform fades. iOS native conventions — rubber-band overscroll,
spring-based sheet drags, momentum-aware modal dismissal — would lift the
"native PWA" feel further. Tied to the iOS 26+ design principle.

**Next step:** Inventory existing transitions, pick three highest-leverage
moments (likely: sheet drag-to-dismiss, scroll-to-top in long lists,
button press feedback) and apply a spring physics curve. Use
`@vercel/web-vitals` to verify no jank introduced.

### Sync layer — true integration test against Vercel Blob

**Status:** SHIPPED 2026-07-05. `tests/integration/sync-roundtrip.test.js`
calls the real route handlers (GET/PUT/POST/DELETE with real Request
objects) against the live store: 404 contract for unwritten profiles,
claim/409/check=1 lifecycle, PUT-then-GET exact round-trip, case-
insensitive resolution, history merge-by-id, DELETE releasing the name.
Gated on `BLOB_READ_WRITE_TOKEN` (skips cleanly in local + per-PR runs;
a token-free validation half still runs everywhere); writes under a
unique throwaway profile and deletes it in cleanup. Runs nightly via
`.github/workflows/nightly-sync-integration.yml` (cron + manual
dispatch). REMAINING SETUP: add the `BLOB_READ_WRITE_TOKEN` repository
secret, then trigger the workflow manually once to confirm the live
path is green — without the secret the job passes vacuously.

**Context:** The addRandomSuffix bug found on 2026-06-22 was invisible to
client-side tests — the writer and reader agreed on a broken pattern,
no errors thrown, every test passed. The only signal was cross-device
behavior. Future regressions in `app/api/sync/route.js` are equally
invisible to the current suite.

### Repair button on diag-sync — wider repair scenarios

**Status:** Initial version shipped (Force-repair Day entries).

**Context:** Each new data-shape bug has historically required a fresh
migration commit. Worth thinking about a more general "store inspector"
that can show raw localStorage shape per key and run targeted repairs
without code changes.

**Next step:** If we hit another data-shape regression, generalize
rather than add a per-bug button.

---

## Shipped (rolling)

Entries graduate here with the resolving commit. Keep most recent on top;
trim entries older than the last block once they're no longer
discussion-relevant.

- **Bonus-only Day entry write fix** — `8431f42` (2026-06-22).
  `handleMarkBonusDone` now derives + stamps `scheduledType` from the
  effective schedule (or `WEEK` fallback) alongside the bonus mark. Closes
  the door on null-scheduledType entries entering the Day store via the
  bonus path; eliminates the false-positive risk in `Days._maybeRepair`'s
  loosened guard.
- **Push refactor** — `3eb7fc1` (2026-06-23). pushNow / pushDeferred /
  flushDeferred replace the per-mutation pushUserStateSnapshot pattern.
  Per-workout cost drops from ~30 advanced ops to 2; Sync now row on
  Profile screen exposes manual flush for power-user reassurance.
  Routing taxonomy in `docs/push-refactor.md`.
- **iOS Safari "chin" fix** — `9124425` + `5f6f073` (2026-06-23).
  `color-scheme: dark` on :root + restoring `background: #131110` on
  html, body. UA-painted chrome (toolbar surround, overscroll edges,
  scrollbars) now matches page content; the mismatched dark band that
  surfaced as a "chin" is gone.
- **Sync layer addRandomSuffix bug** — `6ede9ee` (2026-06-22). The
  root-cause of cross-device sync silently returning empty for every
  user.
- **In-app diag-sync entry point** — `aef148c` (2026-06-22). PWAs have
  no address bar; row on the Profile screen links to `/diag-sync`.
- **Mutation coverage audit** — `2ba14af` (2026-06-22). Static test
  asserts every persisted mutation pushes; fixed four unsynced handlers
  (bodyweight, reset programme, accept/dismiss deload).
- **/diag-sync page** — `ffffb02` (2026-06-22). Observability surface
  for the sync layer.
- **iOS PWA viewport-fit:cover removal** — `c6c5668` (2026-06-22).
  Followed WebKit dev guidance; let iOS auto-reserve the status bar
  zone.
- **manualTickDates filter fix** — `d6772c1` (2026-06-21). Fallback to
  DEFAULT_WEEK when no schedule edit log exists. Write-path only —
  existing broken entries still needed the repair migration.
- **Day-entry repair migration** — `0820c59` + this commit
  (2026-06-22). One-shot heal for null/null entries from before
  d6772c1; loosened in this release to also cover bonus-marked
  variants.
- **Design principle #10 — iOS 26+ WebKit guidance** — `c182a04`
  (2026-06-22). Codified the "as far as PWAs can support" doctrine.
