# Forge — execution roadmap

The **order** we tackle work. `parked.md` is the detailed backlog (the *what*
and *why*, per item); this file is the *when* — the phased sequence, so context
loss between sessions never drops a thread or re-does settled work.

Crystallised 2026-07-10 after a full census (every parked Status line read, every
open PR checked). Update the phase a moved item lives in; don't let this drift.

---

## Phase 0 — Heal main (live regressions + honest backlog) · IN PROGRESS

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
- **Chin — PR #204.** Sheet-ground gradient + cross-document view transitions.
  Reviewed, green; awaiting merge + device verify.
- **Backlog reconciliation.** ~8 parked entries are RESOLVED/SHIPPED but never
  filed; the iconography + Profile-unification entries shipped in the Interface
  Sweep (PRs #195) but still read "build next session." Reconcile against reality.

**User-owned ops (not code):** merge #204 · re-add `CRON_SECRET` · re-register
passkey · status-bar dim taste call · device passes (chin, grain pop-in retest).

## Phase 1 — Self-contained WebKit-27 performance wins (small, parallel-safe)

Training data predates WebKit 27; each item implemented to spec behind
`@supports` and **verified on real Safari by device pass**, not asserted.

- **Scroll modernisation.** Adopt scroll anchoring (`overflow-anchor`, `none` on
  ScrollDrum) → closes the parked +55px restoration drift. Convert the Lab
  scroll-cue from a JS `window` scroll listener to a CSS `view()` timeline.
- **SW static routing.** Declare `/_next/static/*` as `addRoutes` bypass →
  faster app-shell. Perf change, not security — but the SW is the durable
  component (stale SW caused the "no difference in preview" confusion), so it
  keeps the `?nosw=1` hatch and the `SW_VERSION` bump, and only ever *skips*
  the SW for immutable assets, never serves something different.
- **Grain pop-in retest** (device) — Safari 27's sRGB VT-snapshot fix may have
  closed it for free.

## Phase 2 — Shell-owns-the-viewport rearchitecture (the keystone)

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
