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

## Destructive operations — the wipe protocol

**TELL THE BOSS BEFORE ISSUING WIPE COMMANDS. Every time. No exceptions.**
Before writing any code that deletes, overwrites, or migrates stored user
data — blob deletes, localStorage wipes, schema rewrites, "cleanups" — say,
in plain words: *"this will issue delete commands against X."* Deletion
never rides silently inside an unrelated change, never ships as a helpful
side quest, never gets summarised away. If the diff contains `del(`,
`removeItem`, `DROP`, or their moral equivalents touching user data, the
conversation names it before the code exists.

Then, in order, none skippable:

1. **Dry-run before teeth.** The first version of anything destructive
   reports what it WOULD delete and deletes nothing. The boss reads the
   actual kill list from the real store before the destructive path gains
   a separate, explicit enable switch.
2. **Census the blast area.** Enumerate what actually lives in the target
   namespace TODAY — list the real store, don't recite what the code
   "should" have written. Prove the operation can't touch what it doesn't
   own (prefix-scoped, trailing slash, the lot).
3. **Enumerate garbage, never goodness.** Deletion matches known-junk
   patterns explicitly. "Delete everything except what I recognise" is
   forbidden — the store WILL grow past any snapshot of what's recognised.
4. **No standing delete authority.** Design so sweepers are never needed:
   deterministic paths, overwrite-in-place, delete-on-use. A scheduled job
   with delete permissions is a wipe waiting for a config change to arm it.
   (The design goal is to build without ever needing a sweeper — if one
   seems needed, that's a design smell to raise, not a cron to write.)

## Real example (2026-07-09) — why the wipe protocol exists

The cleanup cron deleted every blob under `forge/profiles/` that wasn't on
its list of known-good filenames. The list was written before passkeys
existed; `credentials.json` was never added; the cron sat unarmed for weeks
behind a missing CRON_SECRET, then an unrelated ops fix armed it and its
first-ever run deleted every user's passkey credentials AND the only copies
of unmigrated profiles (37 blobs, one run, zero errors). The user had asked
repeatedly about protecting the blob; every answer addressed accumulation,
never the janitor itself. No dry-run existed. Deleted blobs are
unrecoverable. Every rule above would have stopped it — the sweeper is now
deleted rather than guarded, per the design goal.

## House mechanics (already in force — don't relearn the hard way)

- **Rebase gate on every push:** `git fetch origin main && git merge-base
  --is-ancestor origin/main HEAD` must pass in the same `&&` chain as
  `commit`/`push`. Main moves often (PRs merge mid-flight). If main moved:
  stash → `checkout -B <branch> origin/main` → pop → recommit.
- **Verify against the real thing**, not just tests — but verify the *right*
  thing, at proportionate cost. A screenshot or one probe, not a battery.
- Commit trailers stay as configured; never put model identifiers in commits,
  PRs, or code.
