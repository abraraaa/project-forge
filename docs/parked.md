# Parked

Things we explicitly chose not to ship right now, with enough context to pick
them back up without re-deriving why. Add new entries at the top; move
items to "Shipped" with the resolving commit when they land.

Format per entry: title · status · context (what's parked and why) · the
specific next step that would unblock it.

---

## Execution roadmap — the order we tackle work

Crystallised 2026-07-10 after a full census; folded into this file 2026-07-11
(one backlog file, per review). Update the phase a moved item lives in.

## Phase 0 — Heal main · DONE 2026-07-11 (PRs #204–#205 merged, device-verified)

Bugs shipped by recent work, fixed here; plus making the backlog trustworthy.

- **Session-screen overflow — FIXED (this PR).** The three-zone relayout shipped
  with a bare `100dvh` root; `.forge-page` pads the top by the safe-area inset,
  so the column overflowed and the Log button fell below the fold on device.
  Root now `calc(100dvh − env(safe-area-inset-top))` + capped first spacer.
  Interim — superseded by `height: stretch` in Phase 2.
- **Grain print — REVERTED off Home (this PR).** The shipped prototype was
  imperceptible (React re-render clobbered the class mid-tap). Dead wiring
  removed; the working fix (data-attribute + commit-on-tap) is recorded in
  parked.md and returns in Phase 3.
- **Chin — PR #204.** RESOLVED by sheet grammar per edge-ownership: browser
  sheets are detached floating cards (the scrim owns both chrome edges and
  blends, exactly as the top edge always did); PWA stays flush full-bleed.
  The gradient experiment is deleted (couldn't recolour Safari's slab and
  broke the buttons in its fade zone). slideUp rise survives everywhere.
  Diag variant T verifies the treatment in one tap. Plus cross-document
  view transitions for /library.
- **Backlog reconciliation.** ~8 parked entries are RESOLVED/SHIPPED but never
  filed; the iconography + Profile-unification entries shipped in the Interface
  Sweep (PRs #195) but still read "build next session." Reconcile against reality.

**User-owned ops (not code):** merge #204 · re-add `CRON_SECRET` · re-register
passkey · status-bar dim taste call · device passes (chin, grain pop-in retest).

## Phase 1 — WebKit-27 performance wins · DONE 2026-07-11 (PR #206, device-verified)

Scroll drift fixed ("works beautifully"), sync unaffected, cue + drum good.

- **Scroll modernisation.** Adopt scroll anchoring (`overflow-anchor`, `none` on
  ScrollDrum) → closes the parked +55px restoration drift. Convert the Lab
  scroll-cue from a JS `window` scroll listener to a CSS `view()` timeline.
- **SW static routing — SHIPPED (Phase 1 PR), rescoped by research.**
  Routed: `/api/*` → network (semantics-identical; the worker no longer
  wakes for every sync call) and the precache set → cache. NOT routed:
  `/_next/static/*` — a "cache" route never runs the fetch handler, so
  runtime caching would never populate and offline statics would silently
  break after each deploy. That bypass needs precache-manifest work first
  (revisit with the next SW change). `?nosw=1` hatch + SW_VERSION bump kept.
- **Grain pop-in retest** (device) — Safari 27's sRGB VT-snapshot fix may have
  closed it for free. (Still owed — fold into the Phase 2 device pass.)

## Phase 2 — Shell-owns-the-viewport rearchitecture (the keystone) · DESIGN IN REVIEW

Design note: **docs/shell-viewport.md** (2026-07-11) — awaiting approval;
main open question is the height-unit ladder vs the PWA cold-start dvh scar.
Unblocked (chin evidence is in). Absorbs three things at once so they're not
patched separately: the interim session `calc`, `height: stretch`, and Phase-1
scroll anchoring. **Design note first → review → build → device screenshot
matrix.** Acceptance criteria include non-standard-shape robustness:
- Never break at tiny heights (split-screen, flip covers) — the general form of
  the session-overflow class.
- Never hide behind an inset (safe-area discipline, unified in the shell).
- Look intentional in a large canvas (desktop ambient backdrop already does
  this; extends to foldable-unfolded for free).
- **Fold-crease avoidance: explicitly out of scope** (product owns the opinion —
  one centered column; we accept it may sit near a crease).

## Phase 3 — Intimacy pass (rides on the new shell)

- Grain-under-finger (batch 3) re-applied — fix already written + Chromium-
  verified (data-attribute + commit-on-tap; 220px / 0.22 / 420ms hold).
- Press-state refinements.

## Phase 4 — Performance Lab rebuild + muscle taxonomy (dedicated session)

Correctness is already fixed (the 2026-07-01 bug list — MEV window, grid
alignment, currently-off modelling all shipped). This is enhancement, not repair:
- Data restructure (delt-head collapse, traps gap, Upper/Lower Back/Shoulders;
  lower back informational, no bands).
- Consistency-grid presentation rethink (the one open design residual from the
  correctness list).

## Phase 5 — Long tail (as-and-when)

PWA manifest enrichment · in-session RIR copy (blocked on sign-off) · progression
history-window depth v2 · diag-sync wider repair scenarios · rebrand (~2027).

---

## Active parking list

### Shell-owns-the-viewport rearchitecture — NEXT UP, gated on chin evidence

**Status:** Agreed 2026-07-09. Blocked only on the /diag-chin device pass.

**Problem (the named system):** every screen negotiates raw with the
viewport — each carries its own guesses about insets, heights, and chrome.
Dozens of appearance PRs (chin bestiary, 100vh/dvh fights, safe-area
calcs) are symptoms of the missing contract, not independent platform
quirks.

**Design:** `.forge-page` becomes the single owner of chrome accounting —
a flex column sized to the viewport with its safe-area padding inside the
box. Screens that want "fill the viewport exactly" (session) say `flex: 1`;
scroll-shaped screens flow as before. No child ever touches
env(safe-area-inset-*) for height maths again.
Safari 27 note (2026-07-10, user base is on the beta): `height: stretch`
ships in 27 — "fill available space accounting for margins" — and may
replace the flex plumbing for the fill-viewport case entirely, behind
@supports. Evaluate during design; WebKit explicitly recommends it over
the -webkit-fill-available class of hack.

**Order of work (none skippable):**
1. DONE — the /diag-chin instrument answered it across five device
   passes (sheet-level transform entrances trigger the slab; detachment
   sidesteps it; verdicts in the Phase-0 entries above). The instrument
   is deleted per its charter (2026-07-11).
2. Baseline screenshot matrix BEFORE any change: every route ×
   {browser, PWA} × key states.
3. The shell change ships alone in its own PR.
4. Same matrix after; visual diff. Risk register = the globals.css scar
   comments (chrome sampling, natural-root-scroller requirement, grain
   stacking/isolation, negative-z paint) — each re-verified explicitly.
5. Session screen then uses `flex: 1` (its calc(100dvh − inset) workaround
   was dropped from the queue unmerged, by design).
6. THEN the intimacy pass rebuilds on the new foundation (grain print
   below, press-state refinements).

### Status bar goes black while modals are open (browser)

**Status:** Parked 2026-07-10 as a DESIGN decision, not a bug. Safari
extends the page's top-edge pixels into the status zone; with a sheet
open those pixels are the scrim dim (rgba(10,9,8,0.82) over near-black),
so the zone renders effectively black. That's the dim faithfully
extended — native sheets behave the same — but the user flags it as odd
combined with the darkened page ("letterboxing"). Any fix is a choice
about scrim tone/strength (e.g. lighter dim, or a dim that fades near
the top edge), to be made with eyes on device, not a sampler hunt. The
bottom-zone counterpart is SOLVED by sheet detachment in browser
(.forge-sheet-ground, globals.css): the scrim owns both chrome edges
and blends into both, as the top edge always did.

### Safari 27 opportunistic follow-ups (user base is on the beta)

- **ScrollDrum feel:** 27 fixes scroll-snap overshoot-to-farther-point
  and re-snap-after-layout. Any drum quirk reports: retest on current
  beta before tuning our code.
- **SW static routing:** declare /_next/static/* as service-worker
  bypass (addRoutes) — the cache-first logic for hashed assets becomes
  browser-native. Small win, do alongside the next SW change.
- **Scroll anchoring — DONE, device-verified 2026-07-11 (PR #206):**
  the +55px restoration drift is FIXED ("works beautifully") by leaving
  anchoring on app-wide with overflow-anchor: none on ScrollDrum only.

### Possible rebrand — "Forge" is diluted in fitness

**Status:** Parked 2026-07-08 (user's call). Revisit when the current
domain ownership lapses, roughly **March/April 2027**.

**Context:** "Forge" as a strength-training name is heavily diluted
across the fitness space. No urgency — the product identity (voice,
palette, grain) carries more brand than the word does — but worth a
proper naming session before committing to another year of domain +
SEO equity on theforged.fit.

**Scope map for whenever this lands** (rebrand is mostly cosmetic, with
two landmines that look like rename targets and must NOT change):
- **NEVER rename:** the `forge:` localStorage key prefix and the
  `forge/profiles/` blob paths. They're internal, invisible to users,
  and renaming them silently orphans every existing user's local data
  and cloud blobs. They can stay "forge" forever under any brand.
- Safe, mechanical: display strings, PWA manifest (name/short_name/
  icons), share-card wordmark, opengraph image, README, onboarding copy.
- Costly, plan-first: domain + 166 library-page canonicals/sitemap
  (301s from theforged.fit, re-index takes months — move early, not
  last), the PolyForm license branding-reservation clause names the
  brand, and installed PWAs keep the old name/icon until users
  reinstall (manifest updates don't rename an installed app on iOS).

**Unblock:** a naming session + domain check, ~Feb 2027, before the
lapse date so the 301 window starts while the old domain still serves.

### Tactility pass — "the reach, not the flourish"

**Status:** Batches 1+2 SHIPPED 2026-07-08 (`.forge-press` /
`.forge-press-warm` in globals.css; `toggle` + `settle` haptics in
lib/a11y.js; wired across session, home, profile, breather, BW modal,
Lab lift chips). Batch 3 (grain under finger) — prototype shipped
2026-07-08 is IMPERCEPTIBLE by mechanism; the fix is written, verified
in Chromium (2026-07-09), and DEFERRED to the intimacy pass on the new
shell (see rearchitecture entry above). Rebuild knowledge, so nothing
is re-derived:
- **Why the shipped version shows nothing:** every wired Home card
  re-renders Home on tap (modal opens / route changes) and React
  rewrites className, wiping the imperatively-added `forge-grain-on`
  class ~80ms in. Also a real tap is ~70ms, so clearing on pointerup
  killed the bloom before full warmth.
- **The fix, both halves:** (1) mark the print with a DATA ATTRIBUTE
  (`data-grain-on`), not a class — React's diffing never touches
  attributes it didn't render (the --gx/--gy custom props already
  survive for the same reason). CSS:
  `.forge-grain-touch[data-grain-on]::after`. (2) Commit the print on
  touch: release schedules removal for 420ms AFTER pointerdown, so a
  quick tap buys the full 60ms bloom + 480ms exhale (~0.9s visible);
  a long hold releases naturally on lift.
- Values that read well: 220px radius, rgba(242,200,158,0.22).
- Verified by event trace: set at pointerdown, timer removal at +420ms
  from useGrainTouch, mid-press screenshot shows the bloom clearly.

**Brief:** surfaces should feel warm and inviting at the moment of touch —
press states that give, contact that responds. Not glass slabs, not fake
leather. The grain/glass/rim-light system already carries most of it; the
gap is yield and temperature at the point of contact.

**Batches, in order of safety:**
1. SAFE, cheap: extend the haptic vocabulary (chip toggle, drum settle) and
   warm press states via colour + a slightly slower release curve. Pure CSS
   + existing haptic module.
2. SAFE with one hard rule: a small press scale (~0.985) on cards and
   primary buttons — but NEVER on a bottom-anchored sheet. A scale is a
   transform; a transform makes iOS composite the sheet and clip the
   safe-area (the proven chin bug, 2026-07-07, see BreatherModal header).
3. UNKNOWN, prototype-first: grain that responds under the finger
   (localised warm lift on tap). Touches masking + blend layers — exactly
   the territory that has burned credits before. Build on ONE surface,
   verify on device together, then decide rollout. Per CLAUDE.md.

### Lab muscle taxonomy — collapse the surface, split the regions

**Status:** Parked 2026-07-08 (same review; needs a dedicated session with
a short design doc approved before any code — this is a data restructure,
not a tweak).

**Three connected ideas:**
1. **Collapse delt heads in the Lab rows.** The chart already collapses
   (DISPLAY_BUCKET); the per-muscle ROW list is deliberately granular
   because MEV/MAV/MRV are defined per head. A merged "Shoulders" row must
   decide how to report its band — proposal: aggregate sets + the WORST
   head's band state, expandable for the split. Engine stays granular.
2. **Traps gap is real** (verified: no TRAPS key in MUSCLES) — shrug/
   carry/deadlift trap work currently leaks into Back.
3. **Region split: Upper Back / Lower Back / Shoulders.** Sharper levers
   for focus personalisation (Strong→hinge volume, Sculpt→upper-back
   thickness). PUSHBACK recorded: evidence-based sources don't give lower
   back an MEV/MRV — nobody programs erector volume directly. A Lower Back
   row with bands would nag "under target" for a muscle users shouldn't
   chase. If split, Lower Back is informational (no bands) or stays
   internal.

**Scope warning:** re-weighting EXERCISE_ANATOMY across 166 exercises +
volume landmarks + analytics + Lab display + focus scoring move together;
history re-derives automatically (anatomy applied at read) but check the
precomputed volume aggregates in trainingState. This IS the parked "Lab
ideal rebuild" — treat it as that session.

### Iconography + Profile cards + colour doctrine — SPEC AGREED 2026-07-08

**Status:** SHIPPED 2026-07-08 in the Interface Sweep (PR #195, commits
ae8050f phase 1 + 139f0a4 phase 2). Kept here as the doctrine reference;
the build is done. Original spec below.

**KEY BUG (from the user's device screenshot):** `↗` (U+2197) renders as
a BLUE EMOJI on iOS (dual-presentation character) while `→` renders as
text — this is the "symbols vs emoji" mix originally reported. Fix: pin
any kept `↗` to text with U+FE0E (text variation selector), and reduce
`↗` usage per the rule below. Chromium renders both as text, so verify
arrow work on DEVICE.

**Phase 1 (agreed, mechanical):**
1. Breather Profile row: remove the inline `background:"none"` that
   overrides its own forge-glass class (ProfileScreen ~line 548) — this
   is the flat/blank card in the screenshot.
2. Arrow rule: `→` = acts or opens IN PLACE; `↗︎` (with U+FE0E) = leaves
   the surface. Per-site: Bodyweight row ↗→`→`; Focus row ↗→`→`;
   "Not set — add one ↗"→`→`; SessionScreen "Recent ↗" (opens sheet in
   place)→`→`; diag-sync row keeps ↗ +FE0E; PerformanceLab "Share ↗"
   keeps +FE0E (leaves app); "Watch/Search YouTube ↗" keeps +FE0E;
   HomeScreen:230 profile link — decide by the rule (in-app route: `→`).
   Unchanged and already consistent: → ✕ ← ✓ ↻ ⇄ ↕ ▶ ◔ ▾.

**Phase 2 (agreed in principle; show exact before/after for veto first):**
3. Effort scale: emoji faces (😮‍💨😤🔥) → the ○◐● geometry already used by
   readiness. Rationale agreed: the whimsy job moved to the final-set
   flash lines; geometry on buttons, personality in words. User "weakly
   agrees" — show it before shipping.
4. Colour doctrine (user's own model): ACTIONS one consistent style
   (coral primary) everywhere; DOMAIN colour expressed as sheet rim/tint/
   glow, not on the buttons (e.g. Bodyweight's sage Confirm → coral
   button, sage rim on the sheet); STATE colours keep meaning
   (sage=good/resting, gold=caution, rose=danger/over). Lab keeps its
   data-segmentation variety — it's "themed", exempt.
5. Profile cards: every interactive row identical (glass tint, bg3
   border, 14/18 padding, arrow per rule); accent borders only for STATE
   (resting=sage); sync status chip stays clear (non-interactive).

**Register note:** "polish the human interface to remain sexy but not
obnoxiously delicate" — keep glyphs legible-first, in-context; never
decoration hunting for meaning.

### Profile page — card unification

**Status:** SHIPPED 2026-07-08 in the Interface Sweep (PR #195). Original
report below, kept for the doctrine.
Prior: Parked 2026-07-08 (user report).

**Report:** the Profile cards are inconsistent — some have blank
backgrounds, some don't; drill-ins vary in UI and colour treatment. Rule
for the pass: interactive cards share one consistent treatment (background,
border, drill-in affordance); the ONLY intentionally "clear" element is the
sync status chip, because it's a status readout, not an interactive card.

**Next step:** inventory every Profile card + its drill-in (breather,
bodyweight, focus, passkey, sync group, wipe), table the inconsistencies,
agree the single treatment, apply in one pass.

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

**Status:** REOPENED 2026-07-06 — RETEST FIRST (2026-07-10): Safari 27
beta fixes View Transition snapshots being stored in sRGB (bug
167634138) — our grain is a screen-blend on a wide-gamut display, so an
sRGB snapshot would shift tone during every transition and pop back on
completion, matching this symptom exactly and explaining why Chromium
never reproduces it. The user base is on the 27 beta already: check the
pop-in on device before any further investigation — likely closes free.
Prior status: device says the pop-in is unchanged, so
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

### In-session RIR feedback — redesigned 2026-07-08, awaiting copy sign-off

**Status:** Direction changed in review. The original shape (a standing
instructional hint under the RPE card, "Easy or Normal on full reps adds
weight") was REJECTED — a permanent line is more annoying than helpful,
and instructional copy reads like an ad jingle, off-voice.

**Approved direction (user's design):** the moment appears ONLY on the
final set of an exercise. The user taps their effort; a subtle line
flashes with what to expect next time; they move on. Outcome, not lecture
— the consequence surfaces exactly when it's decided, which is the
"quietly smarter" contract done properly.

**Honesty constraint for the build:** the real decision happens at
session finalise with more context (deload state, stalls, recovery).
The flash must never promise what the engine might not deliver — so it
only speaks in the unambiguous case (full reps + effort at/above the
category threshold, no active deload) and stays silent otherwise. No
exact numbers (step size can vary); two or three quiet words.

**Next step:** copy sign-off (proposals with the user), then build:
compute from the just-tapped effort + logged reps via the same
ADD_THRESHOLD_RIR table the engine uses; render as a brief fade in the
set-confirm transition, last set only, never on superset rounds.

**Related close-out (2026-07-07): the PWABuilder service-worker flag is a
FALSE NEGATIVE — verified.** /sw.js serves correctly (200,
application/javascript) but registration lives in a post-hydration client
chunk, so the scanner never sees "serviceWorker" in the initial HTML. The
worker demonstrably works (sync runs through it). Decision: no patch —
adding a duplicate inline registration purely to satisfy an audit tool is
score-chasing. Closed.

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
   + roadmap + exact Lab wiring in **docs/absence-modelling.md**. SHIPPED IN FULL 2026-07-06 — phases 1+2 rolled together as declared
   breathers (Bk store, reason annotation, rhythm-rest badge, Home nudge,
   breather modal, Profile row, Lab banner; resume on next session/tick).
   See docs/absence-modelling.md.

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

**Status:** SHIPPED 2026-07-05, RE-HOMED 2026-07-07. The live round-trip
runs INSIDE Vercel now — `app/api/cron/sync-selftest/route.js`, a
CRON_SECRET-guarded route that exercises the real sync handlers
(GET/PUT/POST/DELETE) against the live store (404 contract, claim/409/
check=1, PUT-then-GET exact round-trip, case-insensitive resolution,
history merge-by-id) and cleans up its throwaway profile. Vercel Cron
fires it daily (vercel.json, 04:00 UTC); visibility is Vercel cron logs
+ monitoring. The token-FREE validation half stays in
`tests/integration/sync-roundtrip.test.js` for the per-PR suite.

WHY re-homed: the original GitHub Actions nightly needed
`BLOB_READ_WRITE_TOKEN` as a hand-synced repo secret — a second copy of
a credential whose home is Vercel. That copy went stale (Vercel rotates
Blob tokens / store mismatch) and the nightly failed "access denied" on a
clean paste. Duplication was the bug. Keeping the key where it belongs
(Vercel) and running the test there removes the copy entirely. The GitHub
workflow was deleted.

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
