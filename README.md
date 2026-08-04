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

That's `WEEK` in `lib/programme.js` — the default shape, not a cage. The week is user-editable; the engine walks whatever week you build and hands the strength slots A → B → C in order.

## Quickstart

```bash
git clone https://github.com/abraraaa/project-forge.git
cd project-forge
npm install
npm run dev           # http://localhost:3000
```

Other scripts:
- `npm test` — Vitest suite (`npm run test:watch` for watch mode).
- `npm run lint` — ESLint flat config.
- `npm run typecheck` — `tsc --noEmit` over the JSDoc-typed source.
- `npm run build` — production build; `postbuild` emits the service-worker precache manifest.
- `npm run audit:volume` — weekly weighted-set volume per muscle vs MEV/MAV/MRV bands.

The repo name, the `forge:` localStorage prefix and the `forge/` blob paths keep their old spelling on purpose: deep plumbing, invisible to users, and renaming them would be a migration with real blast area for zero felt benefit.

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 16 (App Router, Turbopack, React Compiler) | Routed pages + server API routes; View Transitions on |
| UI | React 19 | `ForgeApp.jsx` shell plus extracted screens — Home, Session, Profile, Lab |
| Lint | ESLint flat config | `react-hooks/purity` + `set-state-in-effect` on as errors |
| Types | TypeScript, `checkJs` | No `.ts` source — JSDoc types checked over plain JS |
| Tests | Vitest | 803 tests across 53 files — invariants, engines, merge algebra, component tests |
| Database | Neon Postgres | Canonical store: sessions, meta, photo index, auth tokens, bug reports |
| Blob | Vercel Blob | Photo bytes, passkey credentials, write-only snapshots. Not a database |
| Auth | WebAuthn passkeys | Optional — a lock on destructive operations, not an account system |
| Hosting | Vercel | Two daily crons, automatic preview deploys |

Node 24 (active LTS), pinned via `engines.node`. No CSS framework — design tokens in `lib/tokens.js` and inline styles.

## Architecture

```
app/
├── page.jsx · session · profile · performance · locker-room · library
├── api/sync/       # profile-bound delta pull/push + full hydration
├── api/photos/     # progress photos — token-gated, no open-read path
├── api/bugs/       # open intake, ceremony-gated triage
├── api/auth/       # WebAuthn registration + assertion verification
├── api/cron/       # daily snapshot (write-only) + nightly round-trip probe
└── diag-*          # operational surfaces, zero atmosphere by design

components/
├── ForgeApp.jsx    # client shell
├── Home · Session · SessionHost · Profile · PerformanceLab
├── BodyweightDrum  # the odometer — whole kilos, then one tenth
└── ui.jsx, sheets, modals

lib/
├── programme.js         # SESSIONS, EXERCISE_POOLS, WEEK, rotation
├── progression.js       # per-lift prescription (effort + readiness aware)
├── rotation-solver.js   # focus as a target volume shape, solved for
├── db.js                # Neon client, schema, delta reads/writes
├── sync-delta.js        # client cursor + dirty-field bookkeeping
├── sync-merge.js        # THE merge — one implementation, client and server
├── storage.js           # local cache, sync orchestration, session records
├── session-engine.js    # the one session-finalise choreography
├── analytics.js         # weekly volume, e1RM trends, plateau detection
├── exercise-anatomy.js  # muscle distribution map
├── absence.js/breaks.js # absence is derived; a breather is declared
├── auth-server.js       # rpId/origin config, signed challenges, tokens
├── store-health.js      # standing read-only invariants, on /diag-sync
└── tokens.js            # design tokens + 9-bucket muscle colours
```

### Sync

Neon Postgres is canonical; local storage is a write-through cache. Sessions are one row per record, meta one row per field, and sync ships deltas rather than the whole history on every tap.

Records are immutable and append-only. There are no tombstones — the only delete that exists is a whole profile, passkey-gated and user-initiated. A daily cron writes deterministic snapshot generations per profile, overwrite-in-place, holding zero delete authority by construction, with a guard that refuses to overwrite a restore point that has lost most of its history. A snapshot's job is to survive the disaster, not memorialise it.

Sync is bound to the profile it serves: the credential's stored profile is checked against the requested one, and every path is derived from the authorised value. A profile without a passkey keeps working locally, forever — it simply doesn't sync.

### Auth — two origins, one rpId

Passkeys are bound to `theforged.fit` and stay there. `heatwayve.app` runs ceremonies against that same rpId via **Related Origin Requests** — the `/.well-known/webauthn` document on the original origin lists the new one, and the server admits both hosts from an exact-match allow-list that is never reflected from the request. Migrating the rpId would orphan every credential, so it doesn't happen.

The passkey layer's job is narrow and deliberate: an optional lock on destructive operations and on the photo layer, not an account system.

## Load-bearing design principles

Non-negotiable without explicit sign-off. Each has saved or unwound a real bug.

0. **Local is a cache; the server is canonical.** Nothing persists locally without an explicit decision about how it survives a reinstall — either it rides the sync payload through all four seams, or it carries a comment declaring it device-local and why that's safe. Adding a store without picking a side is a regression.
1. **Ballerina-lean.** Incremental, minimal, no speculative refactors. Extractions need a concrete reason — cross-screen reuse or genuine independence.
2. **Two effort scales only.** Per-set effort (`easy / normal / cooked`) and per-day readiness (`fresh / normal / cooked`). The legacy scale never appears in UI.
3. **Movement-class rep bands.** Main lift = sub-6 reps heavy; a movement that can't be loaded heavy enough for sub-6 isn't a main-lift candidate. Accessory = 8–12. Finisher = 12–20 / metabolic.
4. **`pool[0] === SESSIONS default`** for every rotation slot, enforced by test. Drift means the home screen advertises one exercise and rotation serves another.
5. **Grip-fatigue rule.** No two consecutive high-grip exercises in a superset.
6. **Gym-geography rule.** Superset pairs sit in the same equipment zone.
7. **Evidence-based programming** (Israetel / Nuckols / Helms), not convention.
8. **Stale-base discipline.** Branch from latest `main`; CI green and base current before merge.
9. **Curated anatomy dataset.** `lib/exercise-anatomy.js` isn't edited without a concrete reason.
10. **WebKit guidance is the source of truth on iOS.** Heatwayve leans into what Safari gives PWAs rather than reverse-engineering workarounds. Where a translucent, sculpted surface composes cleanly it's pursued; where it doesn't, the clean native fallback beats a hacked imitation.
11. **The voice: quietly sexy, innate — never patched in.** Sensation forward, not filthy; enough to excite. Five gates in order: clarity first (a user at RPE 9 parses every line in one pass); sensation, not hype; prescriptive, not punitive; quiet confidence in short declaratives; positioning lives at the edges — inside the app it shows, it doesn't pitch. Operational surfaces carry zero atmosphere by design.
12. **The template test.** If a word, glyph, layout or loading line would survive unnoticed in a template app, it needs a stated reason to exist here.
13. **Name the system on the third fix.** When the same class of defect draws its third patch, the next deliverable is an architecture note, not a fourth patch.
14. **Reasoning stays out of the repo.** The code is public so the science can be checked; the design rationale is a separate asset. See [docs/internal-notes.md](./docs/internal-notes.md).

## Programme model

`SESSIONS` (`lib/programme.js`) is the three-day template:

| Day | Theme | Main lifts | Supersets | Finisher |
|---|---|---|---|---|
| **A** Mon | Squat & Push | Barbell Back Squat, Barbell Bench Press | Barbell Reverse Lunge + Chest-Supported DB Row · Barbell Hip Thrust + Landmine Press | Hanging Leg Raise + Standing Calf Raise |
| **B** Wed | Hinge & Pull | Hex Bar Deadlift, Barbell Overhead Press | Leg Press + Pull-Up · Bulgarian Split Squat + Machine Hamstring Curl | Tricep Pushdown + Lateral Raise |
| **C** Fri | Power & Volume | Power Clean | DB Walking Lunge + Cable Lateral Raise · Incline DB Press + Seated Cable Row · DB Curl + Skullcrusher | Face Pull + Low-to-High Cable Crossover |

Each accessory slot has an `EXERCISE_POOLS` entry — pre-vetted alternatives rotation can substitute in. Pools declare a load profile so rotation never crosses them; a heavy-low-rep movement can't sneak into a finisher slot.

Main lifts don't auto-rotate. An enumerated set of approved functional equivalents is available through the swap overlay.

## Rotation and progression

Accessories rotate on a per-block cadence: an optional "rotate now" card appears first, and rotation applies automatically if you leave it. Each rotation keeps a per-slot memory of recent blocks (killing the A→B→A ping-pong that a single-block memory caused), filters pools by load profile before recency, and surfaces the muscle-stimulus delta between old and new configs. Above that, `lib/rotation-solver.js` reframes a training focus as a *target volume shape* and solves the whole set of slots for it, rather than biasing each pick locally and hoping the week adds up.

`lib/progression.js` reads the last session's effort signal and either advances load, holds, or backs off proportionally to the miss. A `cooked` readiness rating forces a hold outright — no session logged in a hole gets to set the next prescription. Step sizes and thresholds are per movement category; starting weights are bodyweight-derived and rounded to the loadable increment. Lifts with no history cold-start from the nearest anchor lift.

The rules live in the code and are pinned by `tests/progression.test.js` — read those rather than a prose summary that can drift.

## Volume audit (MEV/MAV/MRV)

Two surfaces hold actual volume against evidence-based landmarks.

**Static — the programme template:** `npm run audit:volume` prints what the default programme delivers per muscle. Use it when designing rebalances.

**Live — your training:** Performance Lab's *Volume vs landmarks* card audits the trailing 4 weeks of logged sessions and flags muscles below MEV (won't drive growth) or above MRV (junk volume, recovery cost) with the specific shortfall — "Rear Delts · 4.9 < MEV 6". Hidden until you've logged enough sessions, so nobody gets alarmed by an audit of no data.

Both operate at the **granular muscle level** — 16 tracked muscles, each delt head and each arm muscle distinct — not the 9 display buckets the charts use. "Rear Delts under MEV" is actionable; "Shoulders under MEV" is not. Traps, Erectors and Core carry `mev: 0`: fatigue ceilings that flag excess without ever nagging a shortfall nobody should chase.

## The Locker Room

The Lab is what you lift. The Locker Room is what it's doing to you.

The bodyweight journal sits on top, ungated and always safe to open in public: a chart with readings, deltas and numbered points, sourced from session snapshots — that timeline predates the photo feature. Entry is **the odometer**: whole kilos on one drum, a single tenths digit on the other, the same grammar as a beam scale. The precision earns its keep — a sensible cut runs 0.3–0.5 kg a week, and a half-kilo step quantised an honest week into "nothing" or "double".

Progress photos are a hidden layer behind a *Show photos* toggle, and the toggle **is** the auth boundary. Fail-modest every visit: nothing renders until asked. The reveal is usually zero-prompt; the passkey ceremony only runs when no live session exists. Uploads are re-encoded through a canvas, stripping all EXIF by construction while keeping orientation baked into the pixels. There is no open-read path for a photo, ever. Per-photo delete sits behind a confirm and a server-side gate — regret has to be reversible.

## Offline, and telling us it broke

Heatwayve installs as a PWA and the shell survives a dead network. A `postbuild` step parses the prerendered HTML of each shell route and emits a build-time precache manifest — bundler-agnostic and exact by construction. The service worker precaches on install, prunes by manifest instead of wiping caches on a version rename, and carries an RSC fallback so client-side navigations don't slip past it. The exercise library is deliberately not precached; visited pages still cache at runtime.

Bug intake went live before the rebrand on purpose — breakage should arrive through the app rather than the void. A quiet row on the Profile page opens a one-sheet report; submitting needs no auth (spam is bounded by a rate limit and a length cap, and rows are inert text). Triage is ceremony-gated and **status-only**: `new → in_scope → filled | killed`. Killing a report closes it without destroying it. No delete verb exists for that table anywhere in the codebase.

## Testing

```bash
npm test               # one-shot
npm run test:watch     # watch mode
```

803 tests across 53 files:

- Programme invariants — `pool[0] === SESSIONS default`, load-profile coverage, main-lift equivalents alignment, library invariants.
- Engines — rotation (block exclusion, profile filter, stimulus-delta maths, the volume solver), progression (decision table, cold starts, readiness gating), session finalise.
- Sync — merge algebra client and server, delta cursor and dirty-field bookkeeping, payload shape.
- Volume audit — set counting, anatomy distribution, classification bands, live-history windowing, malformed-record guards.
- Everything else that has cost us once — storage, store health, absence and breaks, photos, auth, rate limiting, the precache generator, the viewport contract.

Add a new `SESSIONS` exercise and the pool/anatomy/canonical-name invariants will tell you what you forgot.

## Documentation

- **CHANGELOG** — [CHANGELOG.md](./CHANGELOG.md): what changed and why, newest first.
- **Design notes** — `docs/`: [architecture.md](./docs/architecture.md), [delta-sync.md](./docs/delta-sync.md), [absence-modelling.md](./docs/absence-modelling.md), and [offline-shell.md](./docs/offline-shell.md).
- **Platform research** — [frontend-audit.md](./docs/frontend-audit.md): the living map of how the app sits against Next and Safari/iOS, including what's been ruled out and why. Cited sources throughout.
- **Working practice** — [docs/internal-notes.md](./docs/internal-notes.md): what belongs in this repo and what doesn't.
- **Licensing** — [LICENSING.md](./LICENSING.md) · **Code of Conduct** — [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

Heatwayve is **source-available, not open-source** — the code is public so you can validate the research and the engineering, and that transparency is the whole grant. The default terms are **PolyForm Strict 1.0.0** (read, study, run privately; no redistribution, no derivatives, no reuse of code or content) — see [LICENSE](./LICENSE) for the binding text and [LICENSING.md](./LICENSING.md) for what it means in practice. Commercial licences (SaaS, white-label, integrations, any commercial use) are available — contact `abrar.a@outlook.com`.
