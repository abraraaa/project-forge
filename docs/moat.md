# The moat — why the published client can't just be re-launched

The source is public by charter (verify the science). That invites the
obvious worry: what stops someone cloning the repo and shipping it as their
own? The answer is deliberately architectural, not obfuscation — and it is
recorded here so no future refactor "simplifies" the dependencies away.

## What a code-thief actually gets: a hollow client

The repository is the *client*. The product is the client **plus** the
backend and its data, and the two are bound in ways a clone cannot inherit:

1. **WebAuthn `rpId` is origin-bound and permanent.** Passkeys are minted
   against `theforged.fit` and are, by the platform's own rules, unusable
   from any other origin. A clone served from `stolenapp.com` cannot mint
   or verify a credential — its auth, sync gate, and photo capture are all
   inert. This is not a check we added; it is how WebAuthn works, and we
   built on it deliberately. `rpId` never changes (existing credentials
   would be orphaned) — so it is a fixed, un-spoofable tie to our origin.

2. **The sync/auth/registry backend is ours.** `/api/sync`, `/api/auth/*`,
   the name-claim registry, and blob/DB storage all live behind our
   infrastructure, CORS, and the J1 credential gate. A clone must stand up
   its own backend from scratch — at which point it holds no users, no
   history, and none of the tuning that makes the engine work.

3. **The engine's value is in the data, not the loops.** The progression
   thresholds, tempo prescriptions, and per-muscle contribution weightings
   are the crown jewels the licence names by name. They are copyrighted
   datasets, forensically fingerprinted (below), and licensed for zero
   reuse.

Net: cloning yields an app that cannot authenticate, cannot sync, and
carries a dataset that is itself the evidence of the theft.

## Forensic attribution (how a copy is proven)

- **Provenance beacon** (`lib/provenance.js`) — a required, retained
  attribution notice. Stripping it is a provable notice-removal breach;
  keeping it advertises our origin.
- **Dataset fingerprint** — the contribution-weighting table is a large,
  idiosyncratic dataset. Its exact shape is registered, with timestamps,
  in the internal notes (off-repo). An identical table in a competing
  product is derivation evidence that survives reskinning and minification.
- **Trap-street canaries** (if armed) — a small set of deliberately
  off-grid weight values, invisible to users and immaterial to the
  science, that no independent derivation would reproduce. Registered
  off-repo only; never labelled as canaries in the public source.

## The rule this file exists to protect

No enforcement logic that DISABLES the app on a wrong origin or missing
credential. That is a covert kill-switch — legally hazardous, useless
against someone who can read and delete it, and liable to brick honest
local runs. The moat is that the backend is ours and the data is ours and
the copy is provable. It is not a booby trap. Keep it that way.
