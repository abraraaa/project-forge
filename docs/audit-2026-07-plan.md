# Deep Audit — Merged Disposition · 2026-07-26

The two audits (`audit-2026-07-holistic.md`, `audit-2026-07-security.md`) found
overlapping territory. This file is the bridge: **work keyed by file and
subsystem, not by which audit raised it**, so each PR touches a file once with
every change it needs, and no two PRs fight over `app/api/sync/route.js`.

Read this to decide what to build. Read the other two for the evidence.

---

## Where the two audits collided

| Subsystem | Holistic found | Security found | Consequence |
|---|---|---|---|
| `app/api/sync/route.js` | retro-id P0 (data loss); DB N+1 | wipe-gate traversal; no-passkey wipe; **J1 open** | One file, four reasons to open it — sequence deliberately |
| Token path (`auth-server`/`db`/wipe) | wipe completeness verified clean | blob fallback outlives profile; scope-blind helper; uncapped rotation | Holistic verified the *announced* wipe; security found the *unswept* store. Both true |
| Diag surface | `/locker-room` unindexed; diag sunset question | census route ungated | Sunset question is now answered — gate landed; deletion still open |
| `lib/store-health.js` | phantom invariant over-narrow; ordering mismatch | — | Clean, no collision |
| `next.config.mjs` | — | CSP has no `script-src`; no HSTS | Clean, no collision |

**The unifying observation.** Three of the security findings and one of the
holistic ones are the same missing contract: **no route asserts "the caller is
this profile"** — `/api/photos` is the only one that does. And three token
defects are the same seam: the blob→Neon migration moved the mint and two
readers, leaving the third reader, the wipe's sweep, and the fallback's
authority behind. Per the house rule (third fix in the same territory → name the
system, don't ship a fourth patch), both deserve a design note before more
patching.

---

## DONE — shipped during the audit

**PR #251** (merged 2026-07-26): wipe-gate traversal, no-passkey wipe
pass-through, census route gated. `tests/wipe-gate.test.js` locks all three.
These were live and anonymously exploitable; they did not wait for this plan.

---

## 1. The two design decisions (boss, before any more building)

Neither is a patch. Both change shape, and building on the current posture
without settling them wastes the work.

### 1a. J1 — `/api/sync` has no auth at all
Anyone who knows a profile name reads that person's complete training history
and bodyweight, and can merge-write into it. The migration problem is real:
legacy profiles have no passkey, so requiring a token locks them out until they
register one. Options, roughly ascending in cost:

- **Bind reads/writes to a ceremony token** (the `/api/photos` model), with a
  grace path for passkey-less profiles — strongest, most work.
- **Require a token for writes only**, leave reads open — halves the exposure
  (no tampering, no injected sessions), much smaller migration.
- **Accept the posture** and document it as a deliberate product decision for a
  trusted-circle app — legitimate while the user base is what it is, but it must
  be a *decision*, not an inheritance, and it caps who Heatwayve can be offered to.

### 1b. The one-token-store note
Retire the blob token fallback (every pre-migration cookie is long dead). That
single move collapses the "token outlives its profile" finding entirely and
makes the remaining token work small. The note to write: **one token reader, one
token store, and the wipe must sweep the same store the read honours.**

---

## 2. The P0 data-loss fix (highest non-decision priority)

**Retro-logged sessions are silently lost on delta devices** —
`components/ForgeApp.jsx` assigns a past-anchored id, so the record sinks below
the push watermark and never reaches the cloud, while the `days` meta that *does*
sync points at a `sessionId` no other device will ever see.

Fix: decouple ordering-id from calendar date (retro records mint a `now()` id;
the retro date lives in its own field). Add an engine-level regression test.
Correct `lib/sync-delta.js`'s header comment, which currently asserts this is
impossible and is what hid the bug.

**Own PR.** It touches sync's correctness core and shouldn't ride with anything.

---

## 3. Programme-logic correctness (changes the training itself)

Both in `lib/progression.js`, one PR, engine-level tests:

- **HOLD prescriptions get silently re-rounded** — a HOLD at 18kg on an
  accessory_compound lift resolves to 17.5, a *drop*. Never round on HOLD; drive
  the increment from `STEP_SIZES` rather than the hard-coded 1.25/0.5 fork.
- **Post-deload recovery collapses 3 sessions → 1** — the state writer drops
  `inRecoveryUntil`/`preDeloadWeight`, making the entire recovery arc
  unreachable. A hand-rolled test masked it.
- *(nit, same file: cold-start hardcodes 5×3, disagreeing with Power Clean's 4×3.)*

---

## 4. The date-doctrine class — third appearance, so name it

`lib/analytics.js` reintroduced `new Date(str)` + `toISOString()` **in the same
file whose comment documents removing it**, silently dropping volume across DST;
`lib/storage.js` hand-rolls the Monday-shift that `lib/dates.js` already exports
and that the file already imports.

Fix both sites **and the class**: a lint rule (or class-lock test) banning that
pattern anywhere outside `lib/dates.js`. That's the contract the three fixes have
been circling.

---

## 5. Security hardening batch

- **CSP**: add `default-src 'self'`, `script-src 'self' 'unsafe-inline'`,
  `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob:`,
  `connect-src 'self'`, `form-action 'self'`. Nonces are the better end-state but
  need a middleware pass — measure first.
- **HSTS** header (`preload` only after confirming all subdomains).
- **Admin gate fails closed** when `ADMIN_PROFILE` is unset (currently degrades
  to "any passkey holder" — the same env-var-state failure shape as 2026-07-09).
- **Reject all-dot profile names**; add NFKC normalisation.
- **Move the wipe token out of the URL** into `X-HW-Auth`.
- **Generic error bodies** + server-side log id, instead of raw `e.message`.
- **Hash tokens at rest** (`sha256`), so a read-only DB compromise yields nothing
  replayable.
- **Scope-fail-closed** in the shared token helper (fixes the photo-token →
  add-a-passkey escalation properly, rather than a fourth copy of the check).
- **Cap token rotation** with an immutable `authAt`; delete the predecessor row
  in the same rotation.
- **SPF + DMARC** DNS records on heatwayve.app (`v=spf1 -all` + reject policy) —
  registrar work, no code.

---

## 6. Hygiene sweep (low risk, one PR)

- `engines: {node: "22.x"}`; re-pin `@types/node` to `^22.x` (currently three
  majors ahead of the runtime).
- Remove unused `babel-plugin-react-compiler` and `playwright-core`.
- `npm update` for the trivial patches (next, react/-dom, @vercel/blob, vitest).
- Bump `overrides.postcss` floor.
- Delete `public/heatwayve/manifest-staged.webmanifest` (carries the *rejected*
  `#131110`) and strike its runbook line.
- Re-capture `public/screenshots/profile.png` — still says "**Forge** keeps your
  data yours" in the Android install prompt. Same brand-neutral-filename class as
  the apple-touch-icon miss.
- Add `/locker-room` to `robots.js` disallow; add the homepage canonical.
- Hold: TypeScript 6→7 and ESLint 9→10 (majors, need dedicated verification runs).

---

## 7. Polish → folds into the intimacy/style sitting (Phase 6 / #75)

Corner-✕ on the iOS install overlay (breaks modal doctrine); dead
`paddingRight:40` in `TakenNameModal`; inconsistent coral-glow rule on sheet
CTAs; `GlossaryTrigger`'s 18×18 tap target (below the 24×24 minimum);
hardcoded `#fff` in `SessionScreen`.

---

## 8. Tests — shrink slightly, grow where it counts

The suite is *not* bloated: reading all 40 files found no dead-feature coverage,
no duplicate paths, no tautologies. The real gap runs opposite to the brief —
**~17 of 21 components have no render test**; the UI is verified by
string-matching its own source.

Add, in priority order: `ErrorBoundary` (throw → fallback), `BreatherModal`
(CLAUDE.md's own incident log flags it), the `lib/a11y.js` modal hooks (focus
trap / Escape / restore-focus), `lib/webauthn.js` base64url round-trip,
`lib/blob-utils.js` read-path error handling. Optional count-compaction: collapse
the 32-case `analytics.test.js` table into one looping test.

---

## Two probes worth running

1. **Can a client set `x-real-ip` through Vercel's edge?** Determines whether the
   rate limiter is real or theatre.
2. **How many production profiles lack a verifiable passkey?** Sizes the J1
   migration and was the blast radius of the wipe hole now closed.

---

## Suggested order

1. Boss settles **1a** (J1 posture) — everything downstream depends on it
2. **P0 retro-id** (data loss, own PR)
3. **Programme-logic pair** (changes real training)
4. **Date-doctrine class + lint guard**
5. **Security hardening batch** (§5) and **hygiene sweep** (§6) — parallel, low risk
6. **Token-store note + blob-fallback retirement** (§1b) if not taken with §5
7. Polish into the sitting; tests as-and-when
