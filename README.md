# Heatwayve

**Unveil the best you.** Evidence-based, autoregulated strength training — cast your frame, move with intent. Next.js PWA, live at [heatwayve.app](https://heatwayve.app).

A 3-day-a-week strength programme (A/B/C — Squat & Push, Hinge & Pull, Power & Volume) with a progression engine that responds to how hard the work felt, a per-muscle analytics surface that holds your training against evidence-based volume landmarks (MEV/MAV/MRV), an accessory rotation engine that keeps the stimulus fresh without you thinking about it, and the Locker Room — where the work stops being numbers and starts being a body.

```
┌─────────────────────────────────────────────────────────────┐
│  Mon   Tue   Wed   Thu   Fri   Sat   Sun                    │
│  ───   ───   ───   ───   ───   ───   ───                    │
│  A     Z2    B     Mod   C     HIIT  Rest                   │
│  Sq    60m   Hinge 35m   Pwr   8-10  ─                      │
│  +Push       +Pull       +Vol  ×20s                         │
└─────────────────────────────────────────────────────────────┘
```

That's `WEEK` in `lib/programme.js` — the default shape, not a cage. The week is user-editable; `deriveStrengthDaySessions` walks whatever week you build and hands the strength slots A → B → C in order.

## Quickstart

```bash
git clone https://github.com/abraraaa/project-forge.git
cd project-forge
npm install
npm run dev           # http://localhost:3000
```

Other scripts:
- `npm test` — Vitest suite (`npm run test:watch` for watch mode).
- `npm run lint` — ESLint 9 flat config.
- `npm run typecheck` — `tsc --noEmit` over the JSDoc-typed `lib/` and `app/`.
- `npm run build` — production build; `postbuild` emits the service-worker precache manifest.
- `npm run audit:volume` — print the programme's weekly weighted-set volume per muscle vs MEV/MAV/MRV bands.

The repo name, the `forge:` localStorage prefix and the `forge/` blob paths keep their old spelling on purpose: deep plumbing, invisible to users, and renaming them would be a migration with real blast area for zero felt benefit.

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 16 (App Router, Turbopack, React Compiler) | Routed pages + server API routes; View Transitions on |
| UI | React 19 | `ForgeApp.jsx` shell (~2.2k lines) plus extracted screens — Home, Session, Profile, Lab |
| Lint | ESLint 9 flat config | `react-hooks/purity` + `set-state-in-effect` on as errors |
| Types | TypeScript 6, `checkJs` | No `.ts` source — JSDoc types checked over plain JS |
| Tests | Vitest 4 | 717 tests across 42 files — invariants, engines, merge algebra, a few component tests |
| Database | Neon Postgres (`@neondatabase/serverless`) | Canonical store: sessions, meta, photo index, auth tokens, bug reports |
| Blob | Vercel Blob | Photo bytes, passkey credentials, and write-only snapshots. Not a database any more |
| Auth | WebAuthn passkeys via `@simplewebauthn/server` | Optional — a lock on destructive operations, not an account system |
| Hosting | Vercel | Two daily crons, automatic preview deploys |

Node 22 in CI. No CSS framework — design tokens in `lib/tokens.js` and inline styles.

## Architecture

```
app/
├── page.jsx · session · profile · performance · locker-room · library
├── api/sync/route.js         # delta pull (?since=cursor) + delta push + full hydration
├── api/photos/route.js       # progress photos — token-gated, no open-read path
├── api/bugs/route.js         # open intake, ceremony-gated triage
├── api/auth/*                # WebAuthn registration + assertion verification
├── api/cron/sync-snapshot/   # daily blob snapshot — WRITE-ONLY, shrink-guarded
├── api/cron/sync-selftest/   # nightly round-trip probe
├── .well-known/webauthn      # Related Origin Requests document
└── diag-sync · diag-bugs     # operational surfaces, zero atmosphere by design

components/
├── ForgeApp.jsx              # client shell
├── Home · Session · SessionHost · Profile · PerformanceLab
├── BodyweightDrum.jsx        # the odometer — whole kilos, then one tenth
└── ui.jsx, sync-cards.jsx, sheets, modals

lib/
├── programme.js              # SESSIONS, EXERCISE_POOLS, WEEK, rotation
├── progression.js            # per-lift prescription (RIR + readiness aware)
├── rotation-solver.js        # focus as a target volume shape, solved for
├── db.js                     # Neon client, schema, delta reads/writes
├── sync-delta.js             # client cursor + dirty-field bookkeeping
├── sync-merge.js             # THE merge — one implementation, client and server
├── storage.js                # localStorage cache, sync orchestration, session records
├── session-engine.js         # the one session-finalise choreography
├── analytics.js              # weeklyVolume, e1RM trends, plateau detection
├── volume-audit.js           # MEV/MAV/MRV audit (static programme + live history)
├── exercise-anatomy.js       # 168-exercise muscle distribution map
├── lift-translations.js      # cold-start translation, step sizes, RIR thresholds
├── absence.js · breaks.js    # absence is derived; a breather is declared
├── auth-server.js            # rpId/origin config, signed challenges, tokens
├── origin.js                 # flip-aware surfaces, dormant until the domain moves
├── store-health.js           # standing read-only invariants, surfaced on /diag-sync
└── tokens.js                 # design tokens + 9-bucket muscle colours

scripts/
├── volume-audit.mjs          # npm run audit:volume
└── generate-sw-precache.mjs  # postbuild — build-time precache manifest
```

### Sync — the delta protocol

Neon Postgres is canonical. The server was decomposed first — sessions are one row per record, meta one row per field — and the delta protocol finished the job by killing the monolith on the wire. Every tap used to ship your entire history.

- **Pull.** `GET /api/sync?since=<cursor>` returns only rows whose `updated_at` is newer, plus a fresh cursor. The cursor is the server clock taken *before* the row reads, so a row written mid-read is re-sent next time rather than lost — at-least-once, and the merge algebra makes re-application a no-op. Fresh installs still take the full pull; that's hydration, and it hands out a cursor so the client switches to deltas immediately.
- **Push.** The client keeps a sync cursor and a push state of per-field hashes plus the last acknowledged record id (`lib/sync-delta.js`), then ships only dirty meta fields and newer records. The diff never *builds* payloads — it decides which fields of the single payload builder's output get sent. Hand-rolled subsets are this project's most expensive bug class.
- **Records are immutable.** Append-only, creation-instant ISO ids, `ON CONFLICT DO NOTHING`. No tombstones; the only delete that exists is a whole profile, passkey-gated and user-initiated.
- **Snapshots, not backups-by-sweeper.** A daily cron writes two deterministic generations per profile (`forge/snapshots/{daily,weekly}/…`), overwrite-in-place, holding zero delete authority by construction. A **shrink guard** refuses to overwrite a restore point that has lost more than half its history, and fails the run loudly. A snapshot's job is to survive the disaster, not memorialise it.

### Auth — two origins, one rpId

Passkeys are bound to `theforged.fit` and stay there. `heatwayve.app` runs ceremonies against that same rpId via **Related Origin Requests** — the `/.well-known/webauthn` document served on the old origin lists the new one, and `lib/auth-server.js` admits both hosts from an exact-match allow-list that is never reflected from the request. Migrating the rpId would orphan every credential, so it does not happen. Challenges are HMAC-signed and stateless; tokens live in Neon.

The passkey layer's job is narrow and deliberate: an optional lock on destructive operations and on the photo layer, not an account system.

### Data flow — what happens when you log a session

```
┌──────────────┐   logSet     ┌──────────────┐  finaliseDraft ┌──────────────┐
│  Set picker  │ ──────────▶  │  Draft log   │ ─────────────▶ │   History    │
│  (effort)    │              │  (in-memory) │                │ (localStorage│
└──────────────┘              └──────────────┘                │  + Neon)     │
                                                              └──────┬───────┘
                    ┌────────────────────────────────────────────────┴──────┐
                    ▼                                                       ▼
   ┌──────────────────────────────────────┐    ┌───────────────────────────────┐
   │  Progression (lib/progression.js)    │    │  Delta push (lib/sync-delta)  │
   │  - rpeToRir → effective RIR          │    │  - dirty meta fields only     │
   │  - readiness gates the decision      │    │  - records since last push    │
   │  - next session's weight prescribed  │    │  - cursor advances on pull    │
   └──────────────────────────────────────┘    └───────────────────────────────┘
```

## Load-bearing design principles

These are non-negotiable without explicit sign-off. They've each saved or unwound a real bug.

0. **Local is a cache; Neon is canonical. Nothing lives in `localStorage` without an explicit decision about how it survives a reinstall.** Every new persisted store either rides the sync payload — read by `getLocalProfile`, written by `persistToLocal`, merged by `mergeProfileData`, pushed on mutation — or carries an inline comment declaring it intentionally device-local, with the reasoning. Reinstall-erased data is unrecoverable; the framing is "what survives", not "what's saved". Adding a store without picking a side is a regression.
1. **Ballerina-lean.** Incremental, monolithic, minimal. No speculative refactors. `ForgeApp.jsx` doesn't get split unless an extraction has a concrete reason — cross-screen reuse or genuine independence.
2. **Two effort scales only.**
   - Per-set effort = `easy / normal / cooked` (maps to RIR via `rpeToRir`).
   - Per-day readiness = `fresh / normal / cooked`.
   - The legacy `easy / hard / limit` scale **never appears in UI** — only as a legacy alias inside `rpeToRir`.
3. **Movement-class rep bands.** Main lift = sub-6 reps heavy; a movement that can't be loaded heavy enough for sub-6 is not a main-lift candidate. Accessory = 8–12. Finisher = 12–20 / metabolic.
4. **`pool[0] === SESSIONS default`** for every rotation slot. Enforced by a Vitest invariant. Drift means the home screen advertises one exercise and rotation serves another.
5. **Grip-fatigue rule.** No two consecutive HIGH-grip exercises in a superset.
6. **Gym-geography rule.** Superset pairs sit in the same equipment zone.
7. **Evidence-based programming** (MEV/MAV/MRV from Israetel/Nuckols/Helms), not convention.
8. **Stale-base discipline.** Branch from latest `main`, CI green and up-to-date base before merge.
9. **Curated anatomy dataset.** `lib/exercise-anatomy.js` is not edited without a concrete reason.
10. **WebKit guidance is the source of truth on iOS.** Heatwayve leans into what Safari gives PWAs on iOS 26+ rather than reverse-engineering workarounds. Home Screen web apps don't get to draw arbitrary content behind the status bar (confirmed by a WebKit dev, 2026-06), so anything that fights the platform — fixed pixel status-bar shims, deprecated `black-translucent`, hand-rolled backdrop-blur over system chrome — gets removed on sight. Translucent, sculpted surfaces are pursued where they compose cleanly; where they don't, the cleaner native fallback beats a hacked imitation.
11. **The voice: quietly sexy, innate — never patched in.** The calibration line every draft is held against: *sensation forward, not filthy; enough to excite.* Microcopy references the sensation of training — bar speed, breath, the good kind of heavy — in the serif italic, while instruction stays in the sans. Five gates, in order: clarity first (a user at RPE 9 parses every line in one pass — the mid-set test); sensation, not hype (no cheerleading, no exclamation marks, no gym-bro register); prescriptive, not punitive; quiet confidence in short declaratives; and positioning lives at the edges — inside the app it shows, it doesn't pitch. Operational surfaces (`/diag-*`) carry zero atmosphere by design.

    *Tagline, for the flip:* keep **"Unveil the best you."** The reveal reading has grown into the product — the Locker Room is literally that promise with a chart under it — and the line is already load-bearing in metadata, manifest, and the share card. The one alternative worth putting on the table is **"The heat is the point."**: heat-native, shorter, and it asserts the darkness the new name otherwise drifts bright on. `"Train with intention."` stays the imperative anchor either way.
12. **The template test.** If a choice — a word, a glyph, a layout, a loading line — would survive unnoticed in a template app, it needs a stated reason to exist here. Model defaults are the contamination source, so they get enumerated and the user's eye judges. Typewriter tics count: three-dot `...` never ships where the app's own register would set `…`.
13. **Name the system on the third fix.** When the same class of defect draws its third patch, the next deliverable is an architecture note, not a fourth patch. Local fixes feel like velocity; a recurring class is the system asking for design.

## Programme model

`SESSIONS` (`lib/programme.js`) is the three-day template:

| Day | Theme | Main lifts | Supersets | Finisher |
|---|---|---|---|---|
| **A** Mon | Squat & Push | Barbell Back Squat, Barbell Bench Press | Barbell Reverse Lunge + Chest-Supported DB Row · Barbell Hip Thrust + Landmine Press | Hanging Leg Raise + Standing Calf Raise |
| **B** Wed | Hinge & Pull | Hex Bar Deadlift, Barbell Overhead Press | Leg Press + Pull-Up · Bulgarian Split Squat + Machine Hamstring Curl | Tricep Pushdown + Lateral Raise |
| **C** Fri | Power & Volume | Power Clean | DB Walking Lunge + Cable Lateral Raise · Incline DB Press + Seated Cable Row · DB Curl + Skullcrusher | Face Pull + Low-to-High Cable Crossover |

Each accessory slot has an `EXERCISE_POOLS` entry — pre-vetted alternatives rotation can substitute in. Pools declare a `loadProfile` (`heavy_low_rep` / `moderate_mid_rep` / `light_high_rep` / `metabolic`) so rotation never crosses profiles; a heavy-low-rep movement can't sneak into a finisher slot.

Main lifts don't auto-rotate. `MAIN_LIFT_FUNCTIONAL_EQUIVALENTS` enumerates the approved swaps (Barbell Bench → Dumbbell Bench, Incline BB Press, DB Floor Press, Weighted Dips) available through the swap overlay.

## Rotation engine

Accessories rotate on a per-block cadence: `ROTATION_OPTIONAL = 4` weeks surfaces a "rotate now" card, `ROTATION_AUTO = 8` rotates before the next session starts. Those are the only two tiers — a `ROTATION_FORCED = 12` constant sat in the file for months without ever being read, and the audit deleted it rather than leave it implying a behaviour the app doesn't have. Each rotation:

1. Pushes the outgoing config onto `programmeBlock.history` — a per-slot **3-block memory** (`ROTATION_MEMORY_BLOCKS`). Kills the A→B→A ping-pong single-block memory caused.
2. Filters each pool by `loadProfile` first, then by recency exclusion, falling back gracefully when a tight pool exhausts the list. Zone compatibility is honoured by re-pick; variety wins over geography if no compatible pair survives.
3. Computes a **muscle-stimulus delta** between old and new configs (`distributeAcrossMuscles` per changed slot, weighted by sets) and surfaces the top buckets in the rotation summary.

Above that sits `lib/rotation-solver.js`, which reframes a training focus as a *target volume shape* and solves the whole set of slots for it, instead of biasing each pick locally and hoping the week adds up.

## Progression engine

`lib/progression.js` reads the last session's effort signal (via `rpeToRir`) and either advances weight, holds, or backs off. A `cooked` readiness rating forces HOLD outright — no session logged in a hole gets to set the next prescription. Step sizes and ADD thresholds live in `lib/lift-translations.js`:

| Category | Step size | ADD threshold (RIR) |
|---|---|---|
| `lower_compound` (squat, DL, hip thrust) | 2.5 kg | ≥2 |
| `upper_push` / `upper_pull` (bench, OHP, row) | 1.25 kg | ≥2 |
| `power` (Olympic) | 2.5 kg | ≥3 |
| `accessory_compound` | 1.0 kg | ≥2 |
| `accessory_arm` / `accessory_isolation` | 0.5 kg | ≥2 |
| `bw_progression` | 0 kg (progress reps) | n/a |

Missed work backs off proportionally: a light miss holds, a moderate miss drops 5%, a heavy miss drops 10%. Starting weights are bodyweight-derived (Hex Bar DL 1.0×, Back Squat 0.75×, Bench 0.65×, OHP 0.40×, Power Clean 0.50×), rounded to 2.5 kg and floored for barbell lifts. Lifts with no history get a cold-start translation from the nearest anchor lift.

## Volume audit (MEV/MAV/MRV)

Two surfaces hold actual volume against evidence-based landmarks.

**Static — the programme template:** `npm run audit:volume` prints what the default programme delivers per muscle vs MEV/MAV/MRV. Use it when designing rebalances.

**Live — your training:** Performance Lab's *Volume vs landmarks* card audits the trailing 4 weeks of logged sessions and flags muscles below MEV (won't drive growth) or above MRV (junk volume, recovery cost) with the specific shortfall — "Rear Delts · 4.9 < MEV 6". Hidden until you've logged enough sessions, so nobody gets alarmed by an audit of no data.

Both operate at the **granular muscle level** — 16 tracked muscles, each delt head and each arm muscle distinct — not the 9 display buckets the charts use. "Rear Delts under MEV" is actionable; "Shoulders under MEV" is not. Traps, Erectors and Core carry `mev: 0`: they are fatigue ceilings, flagging excess without ever nagging a shortfall nobody should chase. Forearms are tracked and reported untargeted.

## The Locker Room

The Lab is what you lift. The Locker Room is what it's doing to you.

The bodyweight journal sits on top, ungated and always safe to open in public: a chart sourced from session-record snapshots — that timeline predates the photo feature — with readings, deltas, and numbered points. Entry is **the odometer**: whole kilos on one drum, a single tenths digit on the other, the same grammar as a beam scale. The precision earns its keep — a sensible cut runs 0.3–0.5 kg a week, and the old half-kilo step quantised an honest week into "nothing" or "double".

Progress photos are a hidden layer behind a *Show photos* toggle, and the toggle **is** the auth boundary. Fail-modest every visit: nothing renders until asked. The reveal is usually zero-prompt thanks to a short-lived, path-scoped, httpOnly cookie; the passkey ceremony only runs when no live token exists. The upload pipeline re-encodes through a canvas, stripping all EXIF by construction while keeping orientation baked into the pixels. There is no open-read path for a photo, ever. Per-photo delete sits behind a confirm and a server-side token gate — regret has to be reversible.

## Offline, and telling us it broke

Heatwayve installs as a PWA and the shell survives a dead network. A `postbuild` step parses the prerendered HTML of each shell route and emits `public/sw-precache.js` — a build-time manifest of exactly the assets that shell will request, bundler-agnostic and exact by construction. The service worker precaches on install, prunes by manifest instead of wiping caches on a version rename, and carries an RSC fallback so client-side navigations don't slip past it. The 168-page exercise library is deliberately not precached; visited pages still cache at runtime.

Bug intake went live before the flip on purpose — breakage should arrive through the app rather than the void. A quiet row on the Profile page opens a one-sheet report; submitting needs no auth (spam is bounded by a hard rate limit and a length cap, and rows are inert text). Triage is ceremony-gated on `/diag-bugs` and **status-only**: `new → in_scope → filled | killed`. Killing a report closes it without destroying it. No delete verb exists for that table anywhere in the codebase.

## Testing

```bash
npm test               # one-shot
npm run test:watch     # watch mode
```

717 tests across 42 files:

- Programme invariants — `pool[0] === SESSIONS default`, loadProfile coverage, main-lift equivalents alignment; and library invariants (no near-duplicate names, every programme exercise has anatomy or is allow-listed).
- Engines — rotation (3-block exclusion, profile filter, stimulus-delta maths, the volume solver), progression (decision table, cold starts, readiness gating), session finalise.
- Sync — merge algebra client and server, delta cursor and dirty-field bookkeeping, payload shape, dual-write retirement.
- Volume audit — set counting, anatomy distribution, classification bands, live-history windowing and malformed-record guards.
- Everything else that has cost us once — storage, store health, absence and breaks, photos, auth, rate limiting, the precache generator, the viewport contract, the dormant flip surfaces.

Add a new `SESSIONS` exercise and the pool/anatomy/canonical-name invariants will tell you what you forgot.

## Documentation

- **CHANGELOG** — [CHANGELOG.md](./CHANGELOG.md): what changed and why, newest first.
- **Design notes** — `docs/`: [delta-sync.md](./docs/delta-sync.md), [architecture.md](./docs/architecture.md), [absence-modelling.md](./docs/absence-modelling.md), [offline-shell.md](./docs/offline-shell.md), [heatwayve-flip.md](./docs/heatwayve-flip.md), and [parked.md](./docs/parked.md) for everything deliberately not built yet.
- **Licensing** — [LICENSING.md](./LICENSING.md) · **Code of Conduct** — [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

Heatwayve is **source-available, not open-source** — the code is public so you can validate the research and the engineering, and that transparency is the whole grant. The default terms are **PolyForm Strict 1.0.0** (read, study, run privately; no redistribution, no derivatives, no reuse of code or content) — see [LICENSE](./LICENSE) for the binding text and [LICENSING.md](./LICENSING.md) for what it means in practice. Commercial licences (SaaS, white-label, integrations, any commercial use) are available — contact `abrar.a@outlook.com`.
