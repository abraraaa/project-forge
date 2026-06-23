# Push refactor — design doc

## Goal

Stop pushing on every mutation. Bound the per-workout advanced-op cost to a
single-digit number, deterministically, without compromising "never lose
user data" semantics.

## Three classes

Every mutation handler falls into exactly one class. The class determines
whether the push fires immediately, is deferred to a save-point, or is
already covered by an existing lifecycle handler.

### Class 1 — `pushNow` (immediate)

Rare, high-stakes, no in-session amortisation available.

| Handler | Reason |
|---|---|
| `handleFinalizeSession` | One push captures the whole workout (every set, history record, streak). |
| `updateBodyweight` | Health data, sensitive, low frequency. |
| `handleSaveWeek` / `handleResetWeek` | Schedule edit, infrequent, propagates to other devices' projection. |
| `handleResetProgramme` / `handleRotate` | Programme structure change, rare. |
| `handleAcceptDeload` / `handleDismissDeload` | Training-state machine transition. |
| `handleSaveFocus` | Focus change ripples through accessory selection. |
| `handleMarkDayDone` (retro picker path) | User's explicit "yes I did this", needs cross-device parity within seconds. |
| `handleMarkBonusDone` | Symmetric with above. |

### Class 2 — `pushDeferred` (in-session, coalesced)

Frequent during an active session. Already redundant with the local
draft + the lifecycle flush. Each call sets an in-memory dirty flag;
no advanced op consumed.

| Handler | Reason |
|---|---|
| Per-set RPE / weight / completion writes | Coalesced into the eventual `handleFinalizeSession` push. |
| In-session `Days.set` calls (not retro picker) | Same draft envelope. |
| Live volume mutations during a session | Pure derived state, no urgency. |

### Class 3 — lifecycle flush (catch-all)

Already wired today (`_handleVisibilityChange`, `_handlePageHide`). These
become the safety net: on `visibilitychange=hidden` or `pagehide`, call
`flushDeferred(profile)`. If the dirty flag is clear, no-op (zero advanced
ops). If set, fires one push and clears the flag.

App open / profile activation continues to pull only — no push triggered
on read, unless `backgroundSync` detects `localHadMore` and queues one
(existing behaviour, preserved).

## API surface

```js
// lib/storage.js — new exports
export function pushNow(profile)                   // → Promise<boolean>
export function pushDeferred(profile)              // → void; sets dirty flag
export function flushDeferred(profile)             // → Promise<boolean>
```

`pushDeferred` is fire-and-forget. The dirty flag lives in module-scope
memory, scoped per profile. The flag does NOT persist to localStorage —
if the app closes before flush, the next open's `backgroundSync` will
detect `localHadMore` and push, which is the existing recovery path for
this exact scenario.

`pushUserStateSnapshot` is removed. Every existing call site routes to
`pushNow` or `pushDeferred` per the table above.

## Sync now button

Profile screen, immediately below the Sync diagnostics row.

```
Sync now ↗
Force an immediate cloud sync · last sync: 4m ago
```

Tap → `pushNow(profile)`. Brief "Syncing…" → "Synced". Two purposes:
power-user reassurance + manual escape hatch if observability shows
something stale. Uses the existing `SyncStatus` subscription so the
indicator updates without separate plumbing.

## Lifecycle wiring change

`lib/storage.js` already has `_handleVisibilityChange` and
`_handlePageHide` calling a snapshot push directly. Both change to call
`flushDeferred(profile)`. Net behaviour change:

- Before: every visibility-hidden fires a push regardless of whether
  anything changed → 2 advanced ops per backgrounding.
- After: visibility-hidden fires a push only if dirty → 0 ops on the
  common "user backgrounded after viewing data" case, 2 ops on the
  uncommon "user mutated then immediately backgrounded" case.

### Cold-start recovery stays independent

`flushDeferred` is the WARM-state save-point path. The COLD-start
recovery path remains `backgroundSync` checking `merged.localHadMore`
against the merge rules and pushing if local has unflushed data the
remote doesn't. Those are independent mechanisms by design:

- `backgroundSync.localHadMore` is computed from the actual data diff
  against the remote snapshot, not from any in-memory flag.
- The deferred dirty flag is freshly initialised on every cold start
  (in-memory map, no localStorage persistence). It carries no signal
  from previous sessions and never could.
- Therefore a session that died mid-mutation re-pushes on next open via
  `backgroundSync`, untouched by anything in the new deferred path.

Implementation discipline: profile activation must run `backgroundSync`
before any user-driven `pushDeferred` can fire. The current activation
order already guarantees this — flag for the implementation PR's
review checklist anyway.

## Cost shape (target)

**Workout (class-2 heavy):**
- Open app → 1 GET (simple op, free)
- 30 mutations during session → `pushDeferred` × 30 → 0 advanced ops, 1 dirty flag set
- `handleFinalizeSession` → `pushNow` → 2 advanced ops (PUT meta + PUT history), clears dirty flag
- Background app → `flushDeferred` → no-op (flag already clear)
- **Total: 2 advanced ops per workout**

**Non-workout interaction (class-1 only):**
- Open app → 1 GET (simple op)
- Tick a missed day OR edit BW OR change focus → `pushNow` → 2 advanced ops each
- Background app → `flushDeferred` → no-op
- **Typical day: 0–6 advanced ops, capped at one push per discrete event**

**Steady-state estimate at 3 users, 4 workouts/week each:**
- Workout pushes: 3 × 4 × 4 weeks × 2 ops = ~96 ops/month
- Non-workout pushes (BW, schedule, retro, focus): ~3 × 8 events × 2 ops = ~48 ops/month
- **~150 advanced ops/month** vs 2000 quota on Hobby. ~7% utilisation.

10× users (30) lands around 1,500 ops/month — still under the Hobby cap.

## Not in scope

- Integration test against real Blob — you've called this; we monitor via Vercel observability instead.
- R2 migration — you've called this; staying on Vercel Blob.
- Cron `/api/cron/cleanup` — unchanged, runs nightly.
- Comment rot cleanup in `lib/storage.js` — happens in the same PR but listed separately so the diff is readable.

## Test plan

Update `tests/forge-app-mutation-coverage.test.js`:

- Walk every mutation site as today.
- Assert the enclosing handler contains EITHER `pushNow(` OR `pushDeferred(` — not both, not neither.
- Exempt list updates: receive-side handlers, the push helpers themselves, lifecycle handlers.
- Failure mode: new mutation handler ships without picking a class → test fails with a clear "pick `pushNow` or `pushDeferred`" message.

This is a static parser test (same shape as today) — does not actually
exercise the Blob SDK, does not consume ops. The user explicitly chose
observability over integration tests for the runtime layer.

## Open question for review

Should `pushNow` also clear the deferred dirty flag for the same profile?

**Yes (proposed):** any class-1 mutation while class-2 mutations are
pending should sweep them into the same push — they're already in the
local snapshot the push reads. Net: at most one push per discrete user
action, never two back-to-back.

**No:** keep them independent, deferred push fires later regardless.
Risk: rare double-push if a class-1 mutation happens to land 100ms
before lifecycle hides the app.

Going with yes unless Grok flags a case I'm missing.

## File-by-file diff sketch

- `lib/storage.js`
  - Remove `pushUserStateSnapshot`.
  - Add `pushNow`, `pushDeferred`, `flushDeferred`, and a `deferredPushProfiles` map (profile → boolean dirty flag, in-memory, per-module).
  - Change `_handleVisibilityChange` + `_handlePageHide` to call `flushDeferred`.
  - Strip rot comments in the sync-related section. Call this out explicitly in the PR description so reviewers don't try to read the cleanup as part of the architectural change.
- `components/ForgeApp.jsx`
  - Replace every `pushUserStateSnapshot()` call with `pushNow(activeProfile)` or `pushDeferred(activeProfile)` per the routing table.
  - Add **Sync now** row on Profile screen.
- `tests/forge-app-mutation-coverage.test.js`
  - Update audit to accept either function.
  - Update EXEMPT list if any handler genuinely doesn't fit either class.
- `app/diag-sync/page.jsx`
  - No change required — Force push already calls the API directly.

Single PR, single review, single deploy.
