# Deep Audit — Security · 2026-07-26 (Deliverable B)

**Scope.** Attack surface, authentication, exploits, CSP/headers, CORS, cookies
and tokens, injection/DoS, secrets hygiene. Carved out from the holistic audit
(`audit-2026-07-holistic.md`) as its own deliverable. Seven read-only
dimensions, Opus throughout, every high-severity candidate put through an
adversarial refute pass **plus** a separate "is this actually reachable"
judgment — security false-positives are expensive to act on.

**Method note, recorded honestly.** Two of the seven dimensions
(access-control, cookies-and-tokens) failed on the first run and were re-run as
standalone agents. They turned out to hold the two most serious findings, so
the re-run was not optional. The critical finding below was then verified
by hand — SDK source, URL normalisation, the NaN comparison, and the snapshot's
on-disk shape — before any fix was written.

---

## The July audit's P0s, re-checked (J1–J5)

The July pass used "Sarah" as its placeholder victim. Status now:

| | Finding | Status |
|---|---|---|
| **J1** | `/api/sync` GET/PUT/POST unauthenticated | **OPEN — untouched** |
| **J2** | Passkey auth decorative (no signature check) | **FIXED** |
| **J3** | No public key stored; no origin/rpId/counter validation | **FIXED** |
| **J4** | No security headers | **PARTIAL** |
| **J5** | No rate limiting | **PARTIAL** |

J2/J3 are genuinely, properly fixed — see "What verified clean" below. J1 is
not partially fixed; it is exactly as the July audit found it. Every piece of
auth machinery built since (SimpleWebAuthn, `auth_tokens`, the photo cookie,
admin recognition) was wired into `/api/photos` and `/api/bugs` and **never
into `/api/sync`**.

---

## FIXED IN FLIGHT (PR #251, merged 2026-07-26)

These were live and anonymously exploitable when found. Fixed same-session
rather than filed.

### ⚠️ CRITICAL — Anonymous total profile wipe via traversal in the wipe gate

**`app/api/sync/route.js`, DELETE handler.**

The gate read its auth token from the tokens prefix joined to the **raw,
unencoded** `authToken` query parameter. The blob SDK's `constructBlobUrl`
interpolates a pathname straight into a URL string, and `fetch()` normalises
`../` **before the request leaves the process** — so the store only ever saw a
clean, legitimate key.

`authToken=../snapshots/daily/<name>.json` therefore pointed the token read at
that profile's own daily snapshot: a file the app writes itself, guaranteed to
exist, whose JSON satisfied every check the gate performed.

| gate check | value from the snapshot | outcome |
|---|---|---|
| `if (!tokenData)` | truthy object | passes |
| `Date.now() > tokenData.expires` | `expires` absent → NaN comparison → `false` | passes |
| `tokenData.scope === "photos"` | `undefined` | passes |
| `tokenData.profile !== normalise(profile)` | snapshot stores the normalised name | passes |

**Attack:** one unauthenticated request destroys everything —
`dbDeleteProfile` drops sessions/meta/photos/auth_tokens rows, both snapshot
generations are deleted, then every blob under the profile prefix goes:
meta, history, **progress photos**, and `credentials.json` (the passkeys).
Deleted blobs are unrecoverable. This is precisely the 2026-07-09 incident's
damage profile, reachable from the open internet.

**Fixed:** resolved through `readTokenData` (encodes the token, and reads the
same store `mintAuthToken` writes to) + `isTokenValid` (requires `expires` to
*be* a number). Either change alone kills the forgery.

**Corollary, also fixed:** the token *mint* moved to Neon in Rec 11b while this
*read* stayed on blobs. So no DB-minted token could ever satisfy this gate —
legitimate passkey-protected wipes were 401ing in production while the forgery
worked. The lock rejected the key and admitted the crowbar. The scope check and
the DB-row consumption below it were dead code.

### ⚠️ CRITICAL — Wipe entirely ungated for any profile without a passkey

The whole auth block sat inside `if (hasPasskeys)`. A profile with no
verifiable credential fell straight through to the destructive path with **no
token required at all** — and `GET /api/auth/check?profile=<name>` is an
unauthenticated oracle that reports exactly which profiles those are. Note that
keyless legacy credentials count as *no* protection, so pre-2026-07-15
registrants who never re-registered were in this bucket while believing
themselves locked.

**Fixed:** deletion now requires proof of control unconditionally. A
passkey-less profile receives `requiresPasskeySetup` — a recoverable prompt —
rather than an unrecoverable wipe. Legacy leniency is right for reads and wrong
for the one irreversible verb.

**Behaviour change of record:** a profile with no passkey can no longer be
deleted server-side until one is registered.

### HIGH — `GET /api/diag/db-import` enumerated the whole namespace, unauthenticated

The file header advertised `Authorization: Bearer <CRON_SECRET>`; the handler
implemented no check at all (a later comment declared it "deliberately
ungated"). One anonymous request returned every profile name, per-profile blob
filenames, byte sizes, meta field names (revealing who logs bodyweight),
session row counts, and the live Postgres version.

Profile name **is** the identity in this system, so a census hands over every
user's key at once. That is categorically different from serving one
already-known name, which is what the open-reads doctrine actually licenses.
Chained with J1 it yields every user's training data; chained with the wipe
holes above, it yielded every user's destruction.

Its "no sensitive data" ruling (audit #20/#21, 2026-07-19) carried an explicit
expiry — *"revisit only if the data model gains something private"*. Progress
photos landed 2026-07-21 and the bodyweight journal rides sync meta. The
condition was met and the decision was never revisited.

**Fixed:** gated behind `CRON_SECRET`, fail-closed when the env var is unset
(matching the cron routes). Gated rather than deleted so the capability
survives for operator use.

**Locks:** `tests/wipe-gate.test.js` (8 tests) pins all three shut, including a
live assertion that `Date.now() > undefined === false` so the bare expiry
compare cannot return, and an ordering assertion that the token guard precedes
every destructive call.

---

## OPEN — the architecture decision (needs the boss)

### J1 · `/api/sync` GET/PUT/POST are fully unauthenticated

**`app/api/sync/route.js`** — GET, PUT and POST gate on nothing but a rate
limiter and a name-format validator. No token is read, no cookie checked, no
profile binding exists. A repo-wide grep for the auth header finds it in
`/api/photos`, `/api/bugs` and the diag page — never on a sync call.

- **Read:** `GET /api/sync?profile=<name>` returns the complete `meta`
  (bodyweight, `bodyweightLog`, displayName, training state) and full session
  history. The `?since=<cursor>` delta variant is equally open.
- **Write:** `PUT` merges attacker-supplied data into any profile. The merge is
  incoming-wins on ties, and `mergeHistories` unions rather than replaces — so
  an attacker can both overwrite bodyweight/streak and permanently **inject**
  fabricated sessions.
- **Squat:** `POST` claims any free name with no proof of anything; 409s make it
  a second existence oracle.

This is not a patch. It needs a migration path for legacy profiles that have no
passkey, and it changes the shape of every sync call. **Recommended framing:**
this, plus both wipe holes above, are one missing contract — *no route asserts
"the caller is this profile"* — and `/api/photos` is the only route that has
it. Per the house rule (third fix in the same territory → name the system), the
next deliverable here is that design note, with `/api/photos` as the template.

**Interim posture, stated plainly:** anyone who knows or guesses a profile name
can read that person's complete training history and bodyweight. The user base
is currently a trusted handful, which is the only reason this is a decision and
not an emergency.

---

## P1/P2 — token-path defects (one seam, three symptoms)

All three are the same seam: the blob→Neon token migration moved the mint and
two of three readers, leaving the rest behind.

1. **P1 · The blob token fallback outlives its profile.** `readTokenData` falls
   through to a `forge/tokens/*` blob read, but the wipe deletes only DB rows
   plus the profile prefix and the two snapshots — **`forge/tokens/` is never
   swept**. A pre-migration photo cookie therefore survives a full wipe, and
   because the profile key is a low-entropy *name*, once that name is re-claimed
   the same token reads the **new** profile's photos — and the photos route will
   rotate it into a fresh DB token, converting a dead credential into a live,
   self-renewing one. #78 is only half-closed.
   *Recommended:* retire the fallback entirely (every pre-migration 7-day cookie
   is long dead), which collapses this finding to nothing.
2. **P2 · `register-verify`'s anti-stuffing gate is scope-blind.** It calls
   `verifyAuthToken` → `isTokenValid`, which checks shape/expiry/profile but
   **not scope**. A 7-day photo-scope token therefore satisfies *adding a new
   passkey* to an already-protected profile — a read-only credential escalating
   to permanent account takeover. Blocked in practice today only because the
   cookie is path-scoped to `/api/photos` and never sent to that endpoint; the
   other two privileged gates both reject `scope === "photos"` explicitly, so
   the invariant was understood and this call site simply forgot it.
   *Recommended:* make the shared helper fail-closed on scope so the default for
   any new gate is "full-scope only", rather than adding a fourth copy of the
   check.
3. **P2 · Sliding rotation is uncapped and never invalidates its predecessor.**
   Each rotation mints a fresh 7-day token with a new `createdAt` and leaves the
   old one alive. One captured cookie, used once a week, renews forever; there
   is no absolute session lifetime, no `authAt`, and no revocation surface for
   the user (the only revocation path is the wipe).
   *Recommended:* carry an immutable original-ceremony timestamp and refuse to
   rotate past an absolute ceiling (30–90 days — one Face ID moment per quarter);
   delete the predecessor row in the same rotation (delete-on-use, not a sweeper).

---

## P2/P3 — the rest

- **P2 · CSP has no `script-src` or `default-src`.** The policy is exactly
  `frame-ancestors 'none'; object-src 'none'; base-uri 'self'`. The directives
  present are correct and well-chosen (framing on passkey pages is genuinely
  killed), but scripts are entirely unconstrained, so the CSP offers **zero XSS
  containment**. *Recommended baseline, low breakage risk:* add
  `default-src 'self'`, `script-src 'self' 'unsafe-inline'` (Next hydration
  needs inline; Vercel Analytics/Speed Insights load from same-origin
  `/_vercel/*`), `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob:`,
  `connect-src 'self'`, plus `form-action 'self'`. Nonces are the better
  end-state but need a middleware pass — measure before promising.
- **P2 · Rate limiting is per-warm-instance and IP-source is fail-open.**
  Buckets are a module-level in-memory `Map`, so effective quota multiplies by
  instance count; `clientIp()` prefers `x-real-ip` (platform-set on Vercel, so
  the XFF spoof is mostly neutralised **in production**) but falls back to a
  shared `"unknown"` bucket when absent. Honest burst protection; not an
  enumeration control. **Open question worth one probe:** can a client set
  `x-real-ip` through Vercel's edge?
- **P2 · Profile names permit bare `.` and `..`.** `validateProfile` blocks
  `/`, `\` and control chars but not dots, so `profile=..` produces a path
  containing `../`. Inert under literal object-key semantics (most likely), but
  the DELETE prefix is built the same way — reject all-dot names as defence in
  depth regardless of platform behaviour.
- **P2 · Admin gate degrades open when `ADMIN_PROFILE` is unset.** The check is
  `if (process.env.ADMIN_PROFILE && !isAdminProfile(...))`, so an absent, empty
  or mistyped var means *any* passkey holder can read every bug report
  (submitter names, free text, route, user-agent) and mutate triage. Documented
  as dev convenience, but it is the exact failure shape as the 2026-07-09
  incident: **behaviour changing as a side effect of an env-var state**. The
  cron routes get this right (500 when `CRON_SECRET` is missing).
  *Recommended:* fail closed in production; gate the fallback on `NODE_ENV`.
- **P3 · Tokens stored in plaintext and used as their own primary key.** A
  read-only compromise of Neon (backup export, snapshot, a stray `SELECT *`)
  yields directly replayable bearer credentials. Store `sha256(token)`; identical
  lookup cost, neutralises the class.
- **P3 · Full-scope wipe token rides the URL.** `DELETE /api/sync?…&authToken=`
  puts the one credential authorising irreversible deletion into the request
  URI, where it lands in access logs — against the app's own stated law ("keys
  don't ride URLs"), which `/api/photos` obeys via the `X-HW-Auth` header.
  *Recommended:* move it to the header.
- **P3 · Raw exception messages returned to clients.** Nearly every catch block
  returns `e.message`, surfacing driver/schema detail (and the Postgres version
  via the diag route). No secret material found in any of them. Return a generic
  body plus a server-side log id.
- **P3 · No HSTS asserted in-repo** (relying on an unstated Vercel default).
  Add `Strict-Transport-Security: max-age=63072000; includeSubDomains` —
  `preload` only after confirming every subdomain of both domains is HTTPS.
- **P3 · Stateless challenges are not single-use** — replayable for their ~120s
  TTL (the blob path deletes on use; the HMAC path has no nonce store).
  Requires capturing a valid assertion first. Accepted trade-off, recorded.
- **P3 · Body caps measure after buffering**, and the 5MB sync cap sits *above*
  Vercel's ~4.5MB platform limit, so the app-level guard never fires first.
  `/api/bugs` POST has no in-app cap at all.
- **P3 · Photo upload validates only the 3-byte JPEG marker** — no dimension or
  structure check. Contained (the server never decodes; `nosniff` is set), but a
  decompression bomb is storable.
- **P3 · Profile normalisation lacks Unicode NFC/NFKC** — trim + lowercase only,
  so confusable/decomposed names can squat or collide.
- **nit · `login-options` / `auth/check` remain existence oracles** for a named
  profile. Accepted under the open-reads posture; noted for completeness.
- **nit · `GET /api/sync` is side-effecting** (lazy DB backfill on a read verb),
  so a cross-site `<img>` can trigger a write. Idempotent, unauthenticated
  anyway — but a GET should not mutate.

---

## What verified CLEAN (and it matters)

- **Passkey auth is real now.** `verifyAuthenticationResponse` runs with the
  stored public key, `requireUserVerification: true`, and fails closed on both a
  thrown exception and `!verified`; the token is minted only afterward. Keyless
  legacy credentials are rejected with `needsReregister`. `expectedOrigin` /
  `expectedRPID` come from an **exact-match Set** — no wildcard, no suffix
  matching, never reflected from the request. Challenges are `randomBytes(16)`
  with a `timingSafeEqual` HMAC comparison. Tokens are `randomBytes(32)`
  base64url — 256 bits, unforgeable.
- **`/api/photos` is the model the rest of the codebase should copy.** The gate
  compares the token record's stored profile against the request's profile, and
  every downstream path key is derived from the *gate's* normalised value —
  there is no seam between what was authorised and what is used. It also has the
  `typeof expires !== "number"` check whose absence created the critical finding
  above, and it encodes the token. A cookie minted for A cannot touch B's photos.
- **Cookie hygiene is correct and unwidenable.** `httpOnly, secure,
  sameSite:"strict", path:"/api/photos"` are hard-coded literals — no
  request-derived value reaches the cookie options. No `domain` attribute
  (host-only). Zero `document.cookie` anywhere in app code. The service worker
  skips `/api/*` entirely, and photo responses are `Cache-Control: private`.
- **The bugs admin gate re-verifies server-side**, from the *token record* —
  never from the request body or the client's `adminHint`. `adminHint` is
  UI-only; a forged one buys exactly the 403s its comment predicts.
- **No CORS holes.** Zero `Access-Control-*` headers anywhere, no OPTIONS
  handlers — cross-origin JS cannot read any API response. Adding credentialed
  CORS reflection *would* have been the regression; it wasn't added.
- **No SQL injection.** Every query uses parameterised tagged templates,
  including the profile name and the `ANY(...)` list.
- **Secrets are clean** in both the working tree and git history. Everything
  reads from `process.env` with no real-value defaults; `CHALLENGE_SECRET`
  defaults to `""` (fail-closed HMAC). No `NEXT_PUBLIC_*` exists at all, so no
  client-bundle leakage. `ADMIN_PROFILE`'s value never reaches the client. The
  only secret-shaped literals are an obvious CI placeholder and test fixtures.
- **Cron routes fail closed** on a missing `CRON_SECRET`, and the snapshot job
  holds zero delete authority — wipe-protocol rule 4, correctly implemented.
- **Blob paths never leak to clients** — the photos index route maps only date /
  bodyweight / takenAt.

---

## Open questions worth one probe each

1. Can a client set `x-real-ip` through Vercel's edge, or is it overwritten?
   Determines whether the rate limiter is real at all.
2. How many production profiles lack a verifiable passkey? That number was the
   blast radius of the no-passkey wipe hole, and it sizes the J1 migration.

---

## Disposition

1. ~~Wipe-gate traversal + no-passkey pass-through + census gate~~ — **DONE, PR #251.**
2. **J1** — the design note and its migration path. Boss decision; nothing else
   should be built on the current posture.
3. **Token-path seam** — retire the blob fallback (collapses finding 1), add
   scope-fail-closed to the shared helper, cap rotation. One PR, one seam.
4. **CSP tightening + HSTS** — measurable, low risk, do it with the hygiene sweep.
5. **Admin-gate fail-closed, dot-name rejection, token-out-of-URL, generic error
   bodies** — small hardening batch.
6. The P3 tail as-and-when.
