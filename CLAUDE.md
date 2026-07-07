# Working with Forge

Project context lives in `README.md` (design principles, programme model) and
`docs/` (`parked.md`, `architecture.md`, `absence-modelling.md`, …). Read those
for the *what*. This file is the *how we work together* — the collaboration
contract. Honour it.

## Verify before you build. Don't pummel.

**Confirm the approach before doing large, exploratory, or uncertain work.**
State what I'm about to do and why, and get a nod — especially when it's a
new pattern, a platform behaviour I'm not certain of, or anything that could
take more than a small, obviously-correct change. A wrong afternoon of
tweaking drains credits and often ends in redundant work.

- Small, obviously-correct changes: just do them (and say what I did).
- Anything speculative, multi-step, or platform-dependent: **propose first,
  build second.** One clear "here's the plan / here's the risk" beats ten
  tool calls into a dead end.

## Where we don't know something, we identify it together.

If I hit an unknown — a platform quirk, an API I'm unsure of, a behaviour I
can't reproduce — **name it and bring it back**, rather than burning credits
exploring solo. Surface it plainly ("I don't know whether iOS does X; here's
how we'd find out"), and we decide the next move together. Don't try to
out-engineer a wall alone.

Corollary: when the user says "back to the drawing board" or "verify this
first" or expresses doubt about an approach — **stop and reconsider**, don't
push harder on the same track. Their read of the product and the platform is
usually ahead of mine.

## Real example (2026-07-07)

Spent an afternoon trying to make drag-to-dismiss work on the breather
modal. It kept reintroducing a safe-area "chin" on iOS. I patched, re-patched,
and force-reproduced compositing bugs instead of stopping. The user had said
"back to the drawing board" early; I should have paused, named the unknown
(*how do other apps get delightful sheet animations without breaking the
safe-area layout?* — genuinely something I don't know how to do well yet),
and parked it together. Instead I burned credits reaching a revert. The
feature is parkable (revisit ~iOS 27); the lesson is not.

## House mechanics (already in force — don't relearn the hard way)

- **Rebase gate on every push:** `git fetch origin main && git merge-base
  --is-ancestor origin/main HEAD` must pass in the same `&&` chain as
  `commit`/`push`. Main moves often (PRs merge mid-flight). If main moved:
  stash → `checkout -B <branch> origin/main` → pop → recommit.
- **Verify against the real thing**, not just tests — but verify the *right*
  thing, at proportionate cost. A screenshot or one probe, not a battery.
- Commit trailers stay as configured; never put model identifiers in commits,
  PRs, or code.
