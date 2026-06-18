# Forge architecture — data model + sync contract

Single source of truth for what the data layer looks like, what survives what failure, and what semantic rules hold. Kept terse on purpose. If a rule isn't here, it doesn't exist.

## Information model

Four entities, explicit relationships:

```
Profile
└── ProgrammeBlock         (number, startDate, focus, config, history)
    └── Week               (weekStart = Monday ISO date)
        └── Day            (date, scheduledType, completedType?, sessionId?, marks)
            └── Session    (id, scheduledLetter A|B|C, blocks[], readiness)
                └── SetLog (unchanged shape)
```

### Session record v3 (was v2)

Every history record carries its context. No more decontextualised "date + session" tuples.

| Field | Source | Used for |
|---|---|---|
| `id` | ISO timestamp | Primary key, merge-by-id |
| `date` | ISO YYYY-MM-DD | Calendar lookup |
| `weekStart` | Monday of `date` | Week-level aggregation, per-week caps |
| `programmeBlockNumber` | block at log time | Per-block analytics, plateau detection |
| `scheduledLetter` | A \| B \| C | What letter this session was meant to be |
| `expectedType` | strength \| z2 \| cardio \| hiit | Schedule-effective-on-date type |
| `blocks[]` | existing v2 shape | Set logs, prescriptions |
| `readiness` | fresh \| normal \| cooked | Effort modulation |

Pre-v3 records get `null` for the new fields on lazy migration. Analytics tolerates nulls.

### Day entity (new)

Replaces `dayDone`, `bonusDone`, and the projected `weekDone`. Single date-keyed source of truth.

| Field | Type | Meaning |
|---|---|---|
| `date` | ISO YYYY-MM-DD (PK) | Calendar date |
| `scheduledType` | strength \| z2 \| cardio \| hiit \| rest | Schedule-effective-on-date type |
| `completedType` | same set \| `null` | What actually happened |
| `sessionId` | string \| `null` | If strength, the session record's id |
| `marks` | `{ bonus?: true }` | Extras (cardio-day bonus, etc.) |
| `updatedAt` | ISO timestamp | Merge tiebreaker |

### Schedule = append-only edit log

Schedule is not a single mutable config. It is a list of edits:

```ts
type ScheduleEdit = {
  editedAt: string;       // ISO timestamp — when the user tapped Save
  effectiveFrom: string;  // ISO date — from which day the edit applies
  week: DayConfig[7];     // the 7-day shape
};
type ScheduleHistory = ScheduleEdit[]; // sorted by editedAt ascending
```

`effectiveFrom` can be in the past — retroactive edits supported. Helper `scheduleEffectiveOn(date)` returns the edit with the latest `effectiveFrom ≤ date`. Edits are facts. Nothing mutates in place.

## Invariants

These are rules, not preferences. Tests enforce each.

1. **Session records are immutable once committed.** No code path mutates a stored record. Edits append a corrective record; deletes are an explicit user action with confirmation.
2. **Per-week strength cap.** `count(strength records in week) ≤ count(strength days in schedule effective for that week)`. Enforced at write (retro picker) and audited at read (Performance Lab flags overage).
3. **Per-date single completion.** A given `Day.date` has at most one `completedType` and at most one `sessionId`. Re-logging the same date is a confirmation-gated overwrite, not an append.
4. **Schedule edits never touch history.** `handleSaveWeek` writes only to the schedule log. Day records keep their `completedType` regardless of edits.
5. **All persisted state lives in the blob meta payload OR is explicitly device-local with a documented reason.** Enforced by `tests/storage.test.js#durability-contract`.

## Sync contract

`localStorage` is a write-through cache. Vercel Blob is canonical. The contract is what survives what failure.

| Failure mode | What must survive | Mechanism |
|---|---|---|
| App backgrounded mid-set | Draft log + every committed set | `D.save` on every set; `visibilitychange=hidden` push |
| Tab killed by OS | Draft log + committed sets up to last hidden | Same as above |
| Reinstall on same device | Everything in blob | Pull-on-mount; merge with empty local |
| Network offline mid-session | All locally logged sets + final session record | `PQ` retry queue; flush on `online` |
| Blob 5xx during push | Local state intact; push retried | `PQ.add` on failure; flush on `online` or visibility hidden |
| Concurrent edit on second device | Both edits, merged per entity rule below | Pull + merge on every visibility change |

### Save points (push triggers)

Three. Removing one needs a written argument for what now covers the failure mode it owned.

1. **On mutation** — every handler that changes persisted state calls `pushUserStateSnapshot` before returning.
2. **On `visibilitychange = hidden`** — `_flushSnapshotPush` fires from the listener in `lib/storage.js`. The user's "I'll close this for now" event.
3. **On `pagehide`** — same flush. iOS Safari's more reliable termination signal in PWA install mode.

### Merge rules, per entity

| Entity | Rule |
|---|---|
| Session records | Union by `id`. Server-side already does this. |
| Day | Latest `updatedAt` wins per date. |
| ScheduleHistory | Union by `editedAt`. Identity. |
| ProgrammeBlock | Higher `number` wins; `config` + `history` merged on tie. |
| Profile fields (weights/reps/streak/bodyweight/trainingState) | Latest `updatedAt` wins per scalar; for objects, see individual field comments. |

## Out of scope (deliberately)

- Storage technology swap (IndexedDB, SQLite, server-side Postgres). The bugs are model bugs, not storage bugs.
- UI/UX changes. Foundation pass is data layer only.
- Auth changes.
- Progression engine changes.
- New features.
