# Absence modelling

Design + roadmap for the Performance Lab correctness item *"Lab paints
history once; doesn't model 'currently off'"* (docs/parked.md, correctness
log item 3). Started as exploratory work 2026-07-06; the engine landed,
the surfaces are staged below.

## The core decision: derived, never stored

An absence is a **pure function of activity dates + the user's cadence**.
It is computed on read, never written. This is the whole design in one
line, and it's deliberate:

- **Design principle #0 is satisfied for free.** No new localStorage
  store means nothing to include in the blob `meta` payload, nothing to
  merge on sync, nothing that can desync across devices, nothing that can
  corrupt or need a repair migration. The activity dates it reads
  (strength history + Day-store ticks) already survive reinstall by their
  own existing arrangements.
- **It cannot drift from reality.** A stored "you're away" flag would need
  invalidating the moment the user trains; a derived one is simply true or
  false every time it's asked.

The one thing that could ever justify a store is an *optional user
annotation* on an absence ("I was travelling", "injured") — and that is a
deliberate phase-2 call (see Roadmap), not a prerequisite. The engine
ships and is useful with zero storage.

## Semantics (locked by tests/absence.test.js)

The tests are the specification. In prose:

- **Measured against the schedule, not the calendar.** The unit is
  *missed expected sessions*, not raw days. Someone training 2×/week is
  not "away" after a quiet long weekend; someone training 6×/week is.
- **Cadence** = `7 / weeklySlots`, where `weeklySlots` is the count of
  non-rest days in the effective week (`weeklySlotsFromWeek`). Conditioning
  days count — activity dates include them, so the denominator must too.
- **Threshold** = `max(ceil(cadence × 2) + 1, MIN_ABSENCE_DAYS)` quiet
  days. Two missed expected sessions is the floor of what counts; missing
  one slot is life. `MIN_ABSENCE_DAYS = 5` stops a high-frequency
  athlete's long weekend from ever flagging.
- **Quiet days** are days with no activity. A closed gap's quiet days run
  from the day after the last activity to the day before the return; an
  ongoing absence's run through `today`. **Both are judged by the same
  rule** — symmetry is a tested invariant.
- **Every gap registers**, not just the largest — a history with three
  separate lapses returns three absences.
- **No activity at all → nothing.** You cannot be absent from a practice
  you haven't started; a fresh, never-trained profile is not "away".

### Worked thresholds

| Schedule | weeklySlots | cadence (days) | threshold (quiet days) |
|---|---|---|---|
| 6×/week (default WEEK) | 6 | 1.17 | 5 (floor) |
| 3×/week strength only | 3 | 2.33 | 6 |
| 2×/week | 2 | 3.5 | 8 |
| 1×/week | 1 | 7 | 15 |

## API (lib/absence.js)

```js
detectAbsences({ activityDates, weeklySlots, today }) → {
  absences: [{ start, end, days, missedSessions, ongoing }],  // end=null if ongoing
  current,                 // the ongoing absence, or null
  thresholdDays,
  daysSinceLastActivity,   // null if never active
}
absencesFromHistory(history, { weeklySlots?, today?, extraDates? })  // history-only convenience
weeklySlotsFromWeek(week)      // non-rest day count, → 3 on garbage
absenceThresholdDays(weeklySlots)
MIN_ABSENCE_DAYS
```

`today` is always passed in, never read from the clock inside the engine —
that keeps it pure and is why the tests can pin exact dates. Live callers
pass `new Date().toISOString().slice(0,10)` (local-noon parsing inside the
engine handles DST/timezone edges).

## Roadmap

### Phase 0 — engine + spec — DONE (this commit)
`lib/absence.js` + `tests/absence.test.js`. Pure, no UI, no storage, no
wiring. Safe to build on.

### Phase 1 — Lab surface (next; NOT yet built)
Wire `current` into the Performance Lab as an honest, non-alarming banner.

Exact wiring (the data is all already in `PerformanceLabView`):

```js
import { absencesFromHistory, weeklySlotsFromWeek } from "@/lib/absence";
import { W } from "@/lib/storage";
import { WEEK } from "@/lib/programme";

const weeklySlots = weeklySlotsFromWeek(W.get() || WEEK);
// extraDates: Day-store completion dates (HIIT/Z2 ticks) so conditioning-
// only weeks read as present. P.getWeekDone(profile) / bonus store — the
// same dates the consistency grid already reads. Merge their ISO keys.
const { current } = absencesFromHistory(history, { weeklySlots, extraDates });
```

Surface, in the away-state register (calm, never scolding — reuse the
VolumeLandscape `away` voice: *"A lighter stretch — that's part of
training."*):
- If `current`: a single quiet line at the top of the Lab — e.g.
  *"{days} days since your last session. Pick it up when you're ready."* —
  gold/italic, no red, no streak-shaming.
- The `VolumeLandscape` `away` state already handles the empty-recent-
  window case; this is the *complementary* signal (history exists, but the
  tail is quiet). Make sure the two don't double up — if `audit.away` is
  already showing its philosophy line, the absence banner is redundant;
  show one, not both.

Open surface question for review (don't guess — this is a product call):
does the absence banner belong ONLY in the Lab, or also as a gentle
home-screen re-engagement nudge? The parked item frames a "log a missed
stretch" flow. Recommend shipping the Lab banner first (read-only,
low-risk), then deciding home-screen treatment with the user.

### Phase 2 — annotations (deferred; needs the storage decision)
Let the user tag an absence ("travelling", "injured", "deload") so the Lab
can distinguish *deliberately rested* from *fell off*. This is the ONLY
part that needs a store: a small date-keyed `forge:{profile}:absenceNotes`
map, which then MUST join the blob meta payload per principle #0 (include
in `getLocalProfile` / `persistToLocal` / `mergeProfileData` / push). Do
not start this until the Lab banner has proven the model is worth
annotating.

## Why this was simpler than the parked note feared

The parked item wondered whether absence needed "a re-engagement flow, a
modal that qualifies 'you've been away N days'". It doesn't — that's a
*surface*, downstream of the model. The model itself is ~90 lines of pure
arithmetic over dates the app already keeps. The hard part was never the
detection; it was resisting the urge to store it.
