# Parked

Things we explicitly chose not to ship right now, with enough context to pick
them back up without re-deriving why. Add new entries at the top; move
items to "Shipped" with the resolving commit when they land.

Format per entry: title · status · context (what's parked and why) · the
specific next step that would unblock it.

---

## Active parking list

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

**Next step (post-PR3):** (1) Confirm whether the SW flag is a real gap or
a PWABuilder artifact — test the deployed URL, check SW scope. (2) Add the
high-value manifest fields first: `screenshots` (install-sheet polish),
`shortcuts` (quick actions), `categories`. (3) Evaluate `share_target` /
`file_handlers` against actual user flows — only add capabilities we'll
genuinely wire up, not score-chasing. Re-run PWABuilder to confirm lift.

### Packaging — scroll-under status bar / chin

**Status:** Designed, gated rollout pending.

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

**Status:** Designed, blocked on packaging cutover above.

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

**Status:** Wanted, not yet scoped.

**Context:** The addRandomSuffix bug found on 2026-06-22 was invisible to
client-side tests — the writer and reader agreed on a broken pattern,
no errors thrown, every test passed. The only signal was cross-device
behavior. Future regressions in `app/api/sync/route.js` are equally
invisible to the current suite.

**Next step:** Add a `tests/integration/sync-roundtrip.test.js` that
requires `BLOB_READ_WRITE_TOKEN`, hits the actual route handlers (or a
local Vercel dev server), and verifies PUT-then-GET returns the exact
payload written. Run nightly in CI rather than per-PR to avoid Vercel
Blob test pollution. Gate behind an env-var so it skips locally without
a token.

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
