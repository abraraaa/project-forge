# Forge

**Evidence-based, autoregulated strength programme. Next.js PWA. Live at [theforged.fit](https://theforged.fit).**

A 3-day-a-week strength programme (A/B/C — Squat & Push, Hinge & Pull, Power & Volume) with a progression engine that responds to how hard the work felt, a per-muscle analytics surface that compares your training to evidence-based volume landmarks (MEV/MAV/MRV), and an accessory rotation engine that keeps the stimulus fresh without you having to think about it.

```
┌─────────────────────────────────────────────────────────────┐
│  Mon   Tue   Wed   Thu   Fri   Sat   Sun                    │
│  ───   ───   ───   ───   ───   ───   ───                    │
│  A     Z2    B     Mod   C     HIIT  Rest                   │
│  Sq    60m   Hinge 35m   Pwr   8-10  ─                      │
│  +Push       +Pull       +Vol  ×20s                         │
└─────────────────────────────────────────────────────────────┘
```

## Quickstart

```bash
git clone https://github.com/abraraaa/project-forge.git
cd project-forge
npm install
npm run dev           # http://localhost:3000
```

Other scripts:
- `npm test` — Vitest unit + invariant suite.
- `npm run lint` — ESLint 9 flat config.
- `npm run build` — Production build (`next build`).
- `npm run audit:volume` — Print the programme's weekly weighted-set volume per muscle vs MEV/MAV/MRV bands.

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 16 (App Router, Turbopack) | Single Page-router page, server API routes |
| UI | React 19 | One main component (`ForgeApp.jsx`) + `PerformanceLab.jsx` |
| Lint | ESLint 9 flat config | `react-hooks/purity` + `set-state-in-effect` on as errors |
| Tests | Vitest 4 | ~240 invariant + correctness tests, no React Testing Library |
| Storage | localStorage + Vercel Blob | Local = write-through cache; Blob = canonical |
| Auth | WebAuthn (passkeys) via `@simplewebauthn/server` | Optional — claim a profile, sign in cross-device |
| Hosting | Vercel | Daily cron + automatic preview deploys |

Node 22 in CI. No CSS framework — design tokens in `lib/tokens.js` + inline styles.

## Architecture

```
app/                       # Next.js routes
├── page.jsx               # Single page mounts ForgeApp
├── api/sync/route.js      # Blob pull/push for profile data
├── api/cron/cleanup/      # Daily orphan-blob cleanup
└── api/auth/*             # WebAuthn registration + verification

components/
├── ForgeApp.jsx           # Main client component (~4k lines, monolithic by design)
└── PerformanceLab.jsx     # Analytics screen — trends, volume, consistency

lib/
├── programme.js           # SESSIONS, EXERCISE_POOLS, rotation engine
├── progression.js         # Per-lift weight progression (RIR-aware)
├── storage.js             # localStorage + Blob sync + RPE↔RIR
├── analytics.js           # weeklyVolume, e1RM trends, plateau detection
├── exercise-anatomy.js    # 166-exercise muscle distribution map
├── lift-translations.js   # Per-lift cold-start translation (anchor, factor)
├── volume-audit.js        # MEV/MAV/MRV audit (static programme + live history)
├── tokens.js              # Design tokens + 9-bucket muscle colours
└── webauthn.js            # Passkey ceremony helpers

scripts/
└── volume-audit.mjs       # CLI volume-audit runner (npm run audit:volume)
```

### Data flow — what happens when you log a session

```
┌──────────────┐   logSet     ┌──────────────┐  finaliseDraft ┌──────────────┐
│  Set picker  │ ──────────▶  │  Draft log   │ ─────────────▶ │   History    │
│  (RPE drum)  │              │  (in-memory  │                │ (localStorage│
└──────────────┘              │   ref)       │                │  + Blob)     │
                              └──────────────┘                └──────┬───────┘
                                                                     │
                                                                     ▼
                              ┌──────────────────────────────────────────────┐
                              │   Progression engine (lib/progression.js)    │
                              │   - rpeToRir → effective RIR                 │
                              │   - per-lift state updated                   │
                              │   - next session's weight prescribed         │
                              └──────────────────────────────────────────────┘
```

## Load-bearing design principles

These are non-negotiable without explicit sign-off. They've each saved or unwound a real bug.

1. **Ballerina-lean.** Incremental, monolithic, minimal. No speculative refactors. `ForgeApp.jsx` doesn't get split unless an extraction has a concrete reason (cross-screen reuse or genuine independence).
2. **Two effort scales only.**
   - Per-set effort = `easy / normal / cooked` (maps to RIR via `rpeToRir`).
   - Per-day readiness = `fresh / normal / cooked`.
   - The legacy `easy / hard / limit` scale **never appears in UI** — only as a legacy alias inside `rpeToRir`.
3. **Movement-class rep bands.**
   - Main lift = sub-6 reps heavy. A movement that can't be loaded heavy enough for sub-6 is NOT a main-lift candidate.
   - Accessory = 8–12 reps.
   - Finisher = 12–20 reps / metabolic.
4. **`pool[0] === SESSIONS default`** for every rotation slot. Enforced by a Vitest invariant. Drift here means the home screen advertises one exercise and rotation serves another.
5. **Grip-fatigue rule.** No two consecutive HIGH-grip exercises in a superset.
6. **Gym-geography rule.** Superset pairs sit in the same equipment zone.
7. **Evidence-based programming** (MEV/MAV/MRV from Israetel/Nuckols/Helms), not convention.
8. **Stale-base discipline.** Branch from latest `main`, CI green + up-to-date base before merge.
9. **Curated anatomy dataset.** `lib/exercise-anatomy.js` is not edited without a concrete reason.

## Programme model

`SESSIONS` (`lib/programme.js`) is the three-day template:

| Day | Theme | Main lifts | Supersets | Finisher |
|---|---|---|---|---|
| **A** Mon | Squat & Push | Barbell Back Squat, Barbell Bench Press | Reverse Lunge + Chest-Supported Row · Hip Thrust + Landmine Press | Hanging Leg Raise + Standing Calf Raise |
| **B** Wed | Hinge & Pull | Hex Bar Deadlift, Barbell OHP | Leg Press + Pull-Up · Bulgarian Split Squat + Hamstring Curl | Tricep Pushdown + Lateral Raise |
| **C** Fri | Power & Volume | Power Clean | DB Walking Lunge + Cable Lateral Raise · Incline DB Press + Cable Row · DB Curl + Skullcrusher | Face Pull + Low-to-High Cable Crossover |

Each accessory slot has an `EXERCISE_POOLS` entry — a pool of pre-vetted alternatives that rotation can substitute in. Pools declare a `loadProfile` (`heavy_low_rep`/`moderate_mid_rep`/`light_high_rep`/`metabolic`) so rotation never crosses profiles (a heavy-low-rep movement can't sneak into a finisher slot).

Main lifts don't auto-rotate — `MAIN_LIFT_FUNCTIONAL_EQUIVALENTS` enumerates the doc-approved swap alternatives (e.g. Barbell Bench → Dumbbell Bench, Incline BB Press, Weighted Dips) the user can pick via the swap overlay.

## Rotation engine

Accessories rotate on a per-block cadence (`ROTATION_OPTIONAL = 4 weeks` → optional card, `ROTATION_AUTO = 8` → auto on next session, `ROTATION_FORCED = 12`). Each rotation:

1. Pushes the about-to-be-replaced config onto `programmeBlock.history` — a per-slot **3-block memory** (`ROTATION_MEMORY_BLOCKS`) of recent picks. Kills the A→B→A ping-pong that single-block memory caused.
2. For each slot, filters the pool by `loadProfile` first, then by recency exclusion. Falls back gracefully if a tight pool exhausts the exclusion list.
3. Computes a **muscle-stimulus delta** between old and new configs (via `distributeAcrossMuscles` on each changed slot, weighted by that slot's `sets`), surfaces the top 4 buckets in the rotation summary card.

## Progression engine

`lib/progression.js` reads the last session's effort signal (via `rpeToRir`) and either advances weight, holds, or backs off. Per category:

| Category | Step size | ADD threshold (RIR) |
|---|---|---|
| `lower_compound` (squat, DL, hip thrust) | 2.5 kg | ≥2 |
| `upper_push` / `upper_pull` (bench, OHP, row) | 1.25 kg | ≥2 |
| `power` (Olympic) | 2.5 kg | ≥3 |
| `accessory_compound` | 1.0 kg | ≥2 |
| `accessory_arm` / `accessory_isolation` | 0.5 kg | ≥2 |
| `bw_progression` | 0 kg (progress reps) | n/a |

Starting weights for new profiles are BW%-derived (Hex Bar DL 1.0×, Back Squat 0.75×, Bench 0.65×, OHP 0.40×, Power Clean 0.50×), rounded to 2.5 kg, floored at 20 kg for barbell lifts.

## Volume audit (MEV/MAV/MRV)

Two surfaces compare actual volume against evidence-based landmarks.

**Static — programme template:** `npm run audit:volume` prints what the default programme delivers per muscle vs MEV/MAV/MRV. Use this when designing rebalances.

**Live — your training:** Performance Lab's **"Volume vs landmarks"** card audits the trailing 4 weeks of your actual logged sessions. Flags muscles below MEV (won't drive growth) or above MRV (junk volume / recovery cost) with the specific shortfall ("Rear Delts · 4.9 < MEV 6"). Hidden until you've logged ≥4 sessions so new users don't get alarmed by an empty-data audit.

Both surfaces operate at the **granular muscle level** (13 muscles — each delt head, biceps/triceps/forearms distinct), not the display-bucket level (9 groups). "Rear Delts under MEV" is more actionable than "Shoulders under MEV."

## Testing

```bash
npm test               # one-shot
npm run test:watch     # watch mode
```

The suite is ~240 tests strong, split across:
- Programme invariants (`pool[0] === SESSIONS default`, loadProfile coverage, main-lift equivalents alignment).
- Rotation engine (3-block exclusion, profile filter, history pushing, stimulus-delta math).
- Volume audit (set counting, anatomy distribution, classification bands).
- Live-history audit (window filtering, per-week averaging, malformed-record guards).
- Analytics (`weeklyVolume`, `rpeToRir`/`rirToRpe` boundaries, edge cases).
- Exercise library (no near-duplicate names, every programme exercise has anatomy or is allow-listed).

When you add a new SESSIONS exercise, the pool/anatomy/canonical-name invariants will tell you what you forgot.

## Documentation

- **README** — this file: what Forge is, how to run it, design principles.
- **CHANGELOG** — [CHANGELOG.md](./CHANGELOG.md): what changed and why, newest first.
- **Licensing** — [LICENSING.md](./LICENSING.md): AGPL-3.0 default + commercial-licence path.
- **Code of Conduct** — [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

Forge is dual-licensed. The default release is **AGPL-3.0** — see [LICENSE](./LICENSE) for the full terms and [LICENSING.md](./LICENSING.md) for what that means in practice. Commercial licences for use cases AGPL-3.0 doesn't cover (closed-source SaaS, white-label, proprietary integrations) are available — contact `abrar.a@outlook.com`.
