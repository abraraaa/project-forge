# Sync payload windowing — design note (audit #2; unblocks #3, #8, #14)

**Status: PROPOSAL — nothing here is built. Boss reads, we argue, then code.**

This is the "name the system" deliverable for the sync-monolith root. Per the
house rule, the third fix in this territory doesn't get a fourth patch — it
gets this note.

## The problem, with numbers

Every sync moves the ENTIRE profile: `meta` (weights + stamps, trainingState,
days, schedule log, …) **plus the full session history array**, both
directions — pushed after every mutation, pulled on every home visit.

- A session record is ~2 KB. Three sessions/week ≈ 300 KB/year of history.
- `meta` is small and roughly constant (~20–50 KB). History is the monolith.
- The server rejects bodies > 5 MB (413). At ~4.6 MB — **roughly year 5** — a
  loyal user's every push starts failing **silently** (the client swallows
  sync errors by design). Before that cliff: every set logged at the gym
  re-uploads years of immutable records over gym wifi, and every foreground
  pull re-downloads them.

The deeper defect the monolith causes: because the whole payload rides on
every write, the merge must be whole-payload too — which is why deletions
resurrect (#4, fixed by stamping), why `mergeMeta` is a lossy whitelist (#8),
and why a stale tab's whole-map save can re-stamp regressions (#14).

## Constraints (what makes this Forge-shaped)

1. **Vercel Blob is the only store.** No DB, no transactions, no
   compare-and-swap. Merge must stay idempotent and commutative-enough.
2. **History records are immutable once finalised.** The only mutable window
   is "recent" (retro-ticks, the occasional same-week edit).
3. **Offline-first**: the client's copy is authoritative-until-merged;
   pending-push queue retries.
4. **The wipe protocol**: migration may never delete or orphan user data.
   Old blobs stay readable until proven redundant, and no sweeper gets built.

## Proposal

### 1. Segment the history by month

```
forge/profiles/<name>/history/2026-07.json   (~25 KB/month at 3x/week)
forge/profiles/<name>/history/index.json     ({ months: ["2026-06", …], counts, updatedAt })
```

- **Push**: only the segment(s) containing changed records — in practice the
  current month, ~25 KB instead of megabytes. Server merges per-segment by
  record id (same union it does today, just scoped).
- **Pull**: `index.json` + the months not already cached locally. Closed
  months are immutable → fetched once per device, ever. A fresh install
  fetches everything once (unavoidable), then never again.
- Analytics/Lab keep operating on the full local array — assembly happens
  client-side; no consumer changes.

### 2. Meta stays whole-doc, but envelope-versioned (fixes #8)

Meta is small; splitting it buys nothing. Instead the payload gains
`{ v: 2, fields: {...} }` and `mergeMeta` switches from field whitelist to
**stamp-envelope passthrough**: unknown fields merge by their stamp instead
of being silently dropped. New fields then sync without touching the merge —
the #8 class (and the S1 "hand-rolled subset" class) ends structurally.

### 3. Deletion = stamped tombstones, everywhere (finishes #4's doctrine)

`PB.reset` now stamps; generalise the rule: **absence is never expressed by
omission, only by a newer stamped empty/null**. Concretely: day-unticks write
`{ completedType: null, updatedAt }` (Days already does this), weight resets
write stamped nulls. One sentence of doctrine in `sync-merge.js`, enforced by
a test that greps for `delete map[` in mutation paths.

### 4. The deferred tier becomes real (fixes #3)

With segments, the two-class push taxonomy finally has a job:
- **Class 1 (immediate)**: meta — small, every mutation, as today.
- **Class 2 (deferred)**: the current history segment — flushed on
  `visibilitychange`/`pagehide` **with `keepalive`** (also closes #12), and
  by the pending-push retry queue.
Finalise stays class-1 (a finished session is the crown jewel — push now).

### 5. Multi-tab (#14), cheaply

No election, no locks: before any push, re-read localStorage (not React
state) so a stale tab pushes fresh data; plus a `BroadcastChannel` "I
pushed" ping that makes other tabs re-pull stamps. Per-field stamps already
resolve the rest. (Full single-writer coordination is over-engineering for a
gym PWA — documented as the accepted trade.)

## Migration (wipe-protocol-compliant)

1. **Server, read path**: GET serves `history/` segments if `index.json`
   exists, else falls back to the legacy `history.json`. No deletes.
2. **Server, write path**: PUT accepts both shapes. A v2 client's first push
   triggers a one-time split: read legacy blob, write segments + index,
   **leave `history.json` in place** (inert, like the suffixed orphans —
   no sweeper, per the design goal).
3. **Clients**: old clients keep pushing v1 whole-history; the server merges
   v1 pushes INTO segments once the index exists (union by id, scoped to the
   record's month). No flag day; devices upgrade whenever they upgrade.
4. Dry-run tooling: a diag read-only endpoint that reports what a split
   WOULD produce for a profile before any write ships.

## What this does NOT do

- No compression, no binary formats, no DB — not needed at this scale.
- No per-record blobs (fan-out would multiply Blob API calls and cost).
- No changes to the progression engine, analytics, or any UI surface.

## Order of work (each its own PR, once approved)

1. Server dual-read + dual-write + split-on-first-v2-push (+ dry-run diag).
2. Client segment push/pull + local month cache + deferred tier wiring.
3. Meta envelope v2 + mergeMeta passthrough (#8) + tombstone doctrine test.
4. Multi-tab re-read-before-push + BroadcastChannel ping (#14).

Rough sizes: (1) and (2) are the real work; (3) and (4) are small. The
whole arc is independent of everything else on the board.

## Open questions for the boss

- Month segments vs quarter? Month = smaller pushes, more blobs (~12/year).
  Quarter = 3× fewer blobs, 3× bigger mutable window. **Recommend month.**
- Keep serving v1 GET forever, or add a "please update" nudge once v2
  clients dominate? (No forced cutover either way.)
