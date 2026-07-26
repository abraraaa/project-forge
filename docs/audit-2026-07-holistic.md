# Deep Audit — Holistic (non-security) · 2026-07-26

**Scope.** Everything except the security surface (attack surface, auth-bypass,
CSP, CORS, cookies, secrets — carved out to a separate deliverable so the
cybersecurity topics stay in their own lane). Nine read-only dimensions audited
in parallel, every high-severity candidate put through an independent
adversarial-refute pass before earning a place here.

**Method.** 14 subagents (Opus 5 on the four reasoning-heavy dimensions —
programme logic, sync durability, data integrity, plus the verify pass; Sonnet 5
on the mechanical five). No edits, no commits — pure findings. The verify pass
demoted 4 of 5 high-severity candidates to their true size, which is exactly its
job; the count below is post-verification.

**Headline.** The codebase is in genuinely good health. The merge algebra,
cursor lifecycle, training decision tree, and the profile-wipe completeness all
verified *sound* under scrutiny. There is **one real P0** — a silent data-loss
bug in retro-logging that the delta protocol's own docs claim is impossible —
and a cluster of P2 correctness/hygiene items, several of which are the *same
recurring class* the house has already paid to fix twice.

---

## P0 — Retro-logged sessions are silently lost on delta-mode devices

**`components/ForgeApp.jsx:967` (+ `lib/sync-delta.js:19-21`, `lib/storage.js:974`)**

`handleSubmitRetro` assigns a retrospective session a **past-anchored id**
(`` `${retroDate}T12:00:00.000Z` `` — noon-UTC of the retro date) instead of a
`now()` id. The delta push ships `records = history.filter(r => r.id >
lastRecordId)`, and the watermark only ever advances forward. So the moment a
device has already pushed *any* session newer than the retro date, the
retro record sits permanently **below the watermark** and is never pushed.

Why it's silent and permanent, not self-healing:
- `recordCompletion` dirties `days` / `trainingState` / `weights`, so the delta
  push is **non-empty and succeeds** — the pending queue clears, and the
  full-history rescue path (`flushPendingPushes → blobPush`) never fires.
- The `days` meta that *does* sync carries a `sessionId` pointing at a record
  that never arrives → other devices show "strength complete" with **no
  underlying session** (divergence), and the sets/weights/volume are lost from
  the cloud entirely.
- Pulls only advance the cursor; they never re-push history. A delta device
  always has a cursor, so the full `blobPush` rescue (cursor-absent only) can
  never run for it.

**Trigger:** the ordinary catch-up-a-missed-day flow (retro date earlier than
the most recent synced session). The data survives in the origin device's
localStorage, so it's not destroyed locally — but cloud durability and
cross-device consistency, the entire point of sync, are silently broken.

**Note the meta-lesson:** `lib/sync-delta.js:19-21` explicitly documents this
as *impossible* ("retro-logged sessions still mint `now()` ids and are never
missed"). The comment is wrong and masked the bug. The watermark's correctness
rests on one invariant — record ids are creation-instant and therefore
monotonic in push order — and the retro path is the one writer that violates it.

**Fix (two clean options):**
1. **Decouple ordering-id from calendar date.** Give retro records a `now()`
   id and store the retro date in a separate `date`/`loggedFor` field (history
   already sorts by id; the Day entry already carries the true date). *Preferred
   — it restores the documented invariant rather than working around it.*
2. Select delta records by an explicit dirty-record set / monotonic push-order
   stamp rather than `id > lastRecordId`.

Interim safety valve: force a full `blobPush` on the retro path so the
below-watermark record still ships until the real fix lands.

---

## Programme-logic correctness (P2 — affects the training the user actually gets)

**1. `roundToCategoryIncrement` corrupts HOLD prescriptions — `lib/progression.js:106,283`.**
`applyMovement` snaps *every* decision, including HOLD, to a 1.25kg grid, and
`accessory_compound` (step 1.0kg) never lands cleanly. Verified numerically: a
HOLD at 18kg on an accessory_compound lift (Bulgarian split squat / lunges) →
17.5 — a **drop on a HOLD**; ADD at 18 → 18.75 (a +0.75, not the intended
+1.0). `currentWeight` is the user's real performed load, so this silently
re-prescribes weights the engine meant to hold.
*Fix:* never round on HOLD (return `currentWeight` unchanged); drive the
rounding increment from `STEP_SIZES` (the same source as the step) rather than
the hard-coded 1.25/0.5 fork.

**2. Post-deload recovery window collapses 3 → 1 — `lib/progression.js:518`.**
`updateLiftStateFromSession` rebuilds lift state from scratch and drops
`inRecoveryUntil` + `preDeloadWeight`, so the first recovery session reads
`undefined → 0` and the lift immediately exits recovery.
`RECOVERY_SESSIONS_PER_LIFT` (3), the `mesocyclePhase: 'recovery'` tagging, and
`computeRecoveryPrescription`'s session-2/3 branch are all **unreachable**. A
hand-rolled test masks it.
*Fix:* carry `inRecoveryUntil` + `preDeloadWeight` through
`updateLiftStateFromSession`, and add an **engine-level** (not hand-rolled) test
that runs a full deload → recovery arc through `applySessionToEngine`.

*(nit — `lib/progression.js:338`: cold-start hardcodes 5 reps / 3 sets, so Power
Clean's first prescription disagrees with its 4×3 template. Seed cold-start from
the template block.)*

---

## The date-doctrine class is on its THIRD appearance — name it, don't patch it

Per the house rule ("third fix in the same territory → down tools and name the
system"), this has earned an architecture note, not a third patch:

- **`lib/analytics.js:383`** — `weeklyVolumeByMuscle` builds week columns with
  `new Date(todayMon)` + `.toISOString().slice(0,10)`, the exact UTC-parse +
  UTC-format anti-pattern `lib/dates.js` was created to kill. Across a DST
  transition the `weekStart` label shifts off its Monday and stops matching
  `mondayOfWeekIso(rec.date)` — **volume silently drops out of the histogram.**
  This is in the *same file* whose own comment (lines 482-486) documents having
  removed this pattern from a sibling function.
- **`lib/storage.js:1487`** — `dateOfWeekdayIdxInCurrentWeek` hand-rolls the
  Monday-shift + local-format that `lib/dates.js` already exports (and which
  `storage.js` already imports a few lines up for `weekKey()`).

**The system-level fix** isn't the two patches — it's a guard so the class stops
recurring: a lint rule (or a `dates.js`-internal convention enforced by a
class-lock test) banning `new Date(<string>)` + `.toISOString().slice(0,10)`
anywhere outside `lib/dates.js`. Every date formatted in the app should route
through the local-day helpers. That's the contract the three fixes have been
circling.

---

## Data integrity (P2/P3)

- **P2 · Phantom-completion invariant over-narrows — `lib/store-health.js:95`.**
  The straddle-phantom check requires `date > written` **AND** `date > today`,
  so it stops detecting a phantom the day after its date — even though the
  phantom persists forever. Drop the `&& date > today` clause; the remaining
  signature is exact and time-invariant.
- **P2 · Snapshot shrink-guard fails OPEN — `app/api/cron/sync-snapshot/route.js:76`.**
  `readJsonDirect` returns `null` for both "no prior snapshot" and "prior exists
  but the read threw", so a *transient* blob read failure disables the guard and
  lets the run overwrite a good restore point with post-disaster empty state —
  the guard failing in exactly the disaster it exists for. Make an
  unreadable-but-present prior mean "cannot judge → refuse + alarm", not
  "nothing to protect".
- **P3 · Cursor advances even if `persistToLocal` partially fails under quota —
  `lib/storage.js:1294`.** A silent localStorage quota failure drops remote rows
  that are now *past* the advanced cursor; a delta device never re-pulls them.
  Only advance the cursor when the local writes are confirmed.
- **P3 · Three orderings for one "sorted by id" notion —
  `lib/store-health.js:121`.** Health check uses bare `.sort()` (UTF-16),
  merge uses `localeCompare`, DB uses SQL `ORDER BY id`. Align the health check
  to `localeCompare` (the merge's canonical order).
- **P3 · Unknown-key classifier false-positives on profile names with `:` —
  `lib/store-health.js:162`.** The greedy `[^:]+` first segment mis-slices such
  names, flagging every one of that profile's keys as unrecognised on
  /diag-sync. Anchor to the known-profile set.

---

## Dependencies & version hygiene

Runtime deps are all current or one trivial patch behind, with narrow usage —
safe to bump. The real issues are hygiene:

- **P2 · No `engines.node` pin** while CI hardcodes Node 22 and `@types/node` is
  pinned to **25.9.3 — three majors ahead of the runtime**. `tsc` type-checks
  against APIs that may not exist at runtime. Add `"engines": {"node": "22.x"}`
  and re-pin `@types/node` to `^22.x`.
- **P2 · `babel-plugin-react-compiler` unused** (Next 16's `reactCompiler: true`
  vendors it; zero imports in source) — remove.
- **P2 · TypeScript 6→7** is the Go-rewrite; needs a dedicated `typecheck` pass,
  and the stale `ignoreDeprecations: "6.0"` marker needs re-deciding. Hold as
  needs-testing.
- **P3 · `playwright-core` unused** — remove or comment the intent.
- **P3 · ESLint 9→10** major — bump in isolation, run lint.
- **P3 · `overrides.postcss ^8.5.5`** resolves to a version `npm audit` flags;
  bump the floor to `^8.5.18` next time overrides are touched (pure hygiene).
- **nit · Trivial patches** (next, react/-dom, @vercel/blob, vitest) — a plain
  `npm update` picks these up, zero risk.

---

## Performance (both P2 after verification)

- **Photo reveal is an N+1 full-resolution fetch — `app/locker-room/page.jsx:80`.**
  `reveal()` mints an authenticated full-JPEG GET for **every** photo in history
  in one loop, though the scrubber only ever shows two frames. At weekly cadence
  a year ≈ 52 parallel multi-hundred-KB fetches to render two `<img>`; past ~89
  photos the 90/min read limit starts returning 429s → blank frames. *This is
  the exact "under real photo volume" case you flagged for the Locker Room
  shakedown.* Fix: lazy-load i0/i1 + a small prefetch window with LRU eviction.
  (One-hour browser cache softens repeat reveals, which is why it's P2 not P1.)
- **Full sync writes one row at a time — `lib/db.js:162-177`.** `dbInsertRecords`
  / `dbUpsertMetaFields` await one INSERT per element over the Neon HTTP driver
  (no pipelining) → N sequential round-trips. Real, but P2 not P1: the hot delta
  path passes N≈1-2; the large-N case is confined to the one-time-per-profile
  backfill and the retiring fat-PUT path. Batch into a single multi-row INSERT
  when convenient.

---

## UI polish & design-system consistency (P2/nit)

- **P2 · iOS install overlay has a corner ✕ — `components/ForgeApp.jsx:2084`.**
  A genuine modal-doctrine violation (bottom-row "Maybe later" already covers
  dismiss; every other `role="dialog"` follows the no-✕ rule). Drop it. *(Surfaced
  independently by both the UI and onboarding auditors.)*
- **P2 · Dead `paddingRight:40` — `components/TakenNameModal.jsx:107`.** Leftover
  reserving space for a removed corner-✕; skews the eyebrow off the sheet rhythm.
- **P2 · Primary-CTA glow applied inconsistently — `components/FocusPickerSheet.jsx:70`.**
  Some coral primaries carry the glow boxShadow, some don't, with no documented
  rule. Codify (e.g. "glow reserved for session-flow actions") in tokens, or
  apply uniformly.
- **P2 · `GlossaryTrigger` tap target 18×18 — `components/GlossarySheet.jsx:158`.**
  Below the 24×24 WCAG minimum. Keep the glyph, extend the hit area to ~32-44px.
- **nit · Hardcoded `#fff` — `components/SessionScreen.jsx:691`.** Travel-toggle
  knob bypasses the T token scale; swap to `T.text1`.
- *(`TakenNameModal` success flash breaking sheet grammar — verified down to a
  nit: it's a transient 800ms non-interactive beat with nothing to trap; the
  only real gap is `aria-live` for the announcement, not `role="dialog"`.)*

---

## Test suite — the count is fine; the gap is one layer up

The suite is unusually disciplined: reading all 40 files found **no** dead-feature
coverage, no near-duplicate paths, no tautologies. The high count reflects
genuine breadth (programme.test.js's 115 and progression.test.js's 73 each cover
a large rules engine). So the pruning brief is short and cosmetic:

- **nit · `analytics.test.js:207`** generates 32 `it` blocks from one data table
  — the single biggest count-compaction win, but every case is a real
  disambiguation rule; collapse to one looping test only if the raw count is the
  pain. (Same option for other table-driven specs.)
- **P3 · `flip-dormant.test.js:55` / `photos.test.js:136,186`** lock exact
  literal JSX/statement source; loosen to regex on the invariant next time those
  files are touched. Not urgent — they catch real regressions today.

**The finding that inverts the brief (P2): the gap is coverage, not count.**
~17 of ~21 components have **no render/interaction test** — the UI is verified
almost entirely by `readFileSync + toContain` on its own source, not by mounting
it. Priorities to *add*: `ErrorBoundary` (throw → fallback), `BreatherModal`
(CLAUDE.md's own incident log flags it), and the modal-a11y hooks in
`lib/a11y.js` (focus trap / Escape / restore-focus — untested). Also untested:
`lib/webauthn.js` base64url helpers, `lib/blob-utils.js` read helpers,
`lib/share-card.js` data-prep. Net: the suite could *shrink slightly* in count
while *growing* in real coverage.

---

## Onboarding & SEO (P2/P3)

- **P2 · Stale PWA install screenshot — `public/screenshots/profile.png`.**
  Still renders "**Forge** keeps your data yours" (the live component already
  says "Heatwayve"). Wired into `manifest.json`'s `screenshots` array, which
  Android/Chrome shows in the richer install prompt — a first-run surface. Same
  root cause as the apple-touch-icon miss: the asset's *filename* is
  brand-neutral, so the rename sweep couldn't see the stale copy *inside* the
  image. Re-capture profile.png (and re-verify home.png) at 1206×2622.
- **P3 · `/locker-room` has no `noindex`.** State-dependent exactly like
  `/session` (which sets `robots:{index:false}`), but it's a client component so
  it can't export `metadata`, and `robots.js` doesn't disallow it either.
  Cheapest fix: add `/locker-room` to `robots.js`'s disallow list.
- **P3 · Homepage has no explicit canonical** while the library routes do. Add
  `alternates:{canonical:"https://heatwayve.app/"}` to root metadata.
- **P3 · Orphaned `public/heatwayve/manifest-staged.webmanifest`** still carries
  the *rejected* raw `#131110` theme colour. It's linked from nothing (only a
  to-do line in the flip runbook) — but if anyone ever "finishes" that checkbox
  it regresses the deliberate `#1D1A19`. Delete it and strike the runbook line.

---

## Structural note (P3, for the record, not for now)

`ForgeApp.jsx` is a single ~1120-line function component carrying **75 hooks**
(`components/ForgeApp.jsx:59-1181`). No bug found inside it, but it's past the
point where a change's blast radius is locally reasonable — and it's where the
P0 (retro id), the corner-✕, and the phantom `sessionId` all live. Per the
CLAUDE.md guidance to name recurring-pain systems rather than patch them, this is
a decomposition candidate to raise deliberately, not a fire.

---

## What verified *clean* (the reassurance)

Under adversarial scrutiny, these held: the delta merge algebra
(`lib/sync-merge.js` — idempotent, loser-facts preserved, echoes genuine
no-ops); the cursor lifecycle (taken-before-read, advances on pulls only); the
field-level meta rows genuinely retiring the partial-write/clobber class; the
training decision tree (`evaluatePerformance → decideMovement → applyMovement`),
Epley math, per-db volume doubling, deload *detection*, and the retro
`isLatestForLift` guard; the profile wipe's completeness (DB + blobs + snapshots
+ tokens + legacy week-keyed LS via the canonical registry); and the snapshot
cron's write-only construction. The house's fail-safe error handling around
network/localStorage is consistent and commented with intent throughout.

---

## Suggested disposition

1. **P0 first, on its own PR** — the retro-id decoupling, with an engine-level
   regression test and the interim full-push valve. This is the one that loses
   user data.
2. **Programme-logic P2s** (HOLD rounding, recovery-window collapse) — these
   change the training itself; worth a focused PR with engine-level tests.
3. **The date-doctrine architecture note + lint guard** — fix the two sites *and*
   the class, together.
4. **Hygiene sweep** (engines pin, @types/node re-pin, drop unused deps, trivial
   patches, delete staged manifest, /locker-room noindex, stale screenshot) —
   one low-risk housekeeping PR.
5. **Polish** (corner-✕, tap target, glow rule, dead padding) — folds naturally
   into the intimacy/style sitting (#75 / Phase 6).
6. **Test coverage adds** (render tests, a11y-hook tests) — as-and-when.

Security findings are a **separate deliverable** (Deliverable B) — not in this
document by design.
