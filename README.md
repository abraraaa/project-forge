# Heatwayve

**Unveil the best you.** Evidence-based, autoregulated strength training — cast your frame, move with intent. Next.js PWA, live at [heatwayve.app](https://heatwayve.app).

A 3-day-a-week strength programme (A/B/C — Squat & Push, Hinge & Pull, Power & Volume) with a progression engine that responds to how hard the work felt, per-muscle volume held against evidence-based landmarks (MEV/MAV/MRV), an accessory rotation engine that keeps the stimulus fresh without you thinking about it, and the Locker Room — where the work stops being numbers and starts being a body.

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

## Why this repo is public

So the science can be checked. The programming, the progression rules and the volume landmarks are inspectable — read them, question them, hold them against the literature (Israetel / Nuckols / Helms). That's the whole grant: the repo is the evidence, not a handbook. It is source-available, not open-source — see [License](#license).

## The programme

`SESSIONS` (`lib/programme.js`) is the three-day template:

| Day | Theme | Main lifts | Supersets | Finisher |
|---|---|---|---|---|
| **A** Mon | Squat & Push | Barbell Back Squat, Barbell Bench Press | Barbell Reverse Lunge + Chest-Supported DB Row · Barbell Hip Thrust + Landmine Press | Hanging Leg Raise + Standing Calf Raise |
| **B** Wed | Hinge & Pull | Hex Bar Deadlift, Barbell Overhead Press | Leg Press + Pull-Up · Bulgarian Split Squat + Machine Hamstring Curl | Tricep Pushdown + Lateral Raise |
| **C** Fri | Power & Volume | Power Clean | DB Walking Lunge + Cable Lateral Raise · Incline DB Press + Seated Cable Row · DB Curl + Skullcrusher | Face Pull + Low-to-High Cable Crossover |

Each accessory slot has a pre-vetted pool of alternatives rotation can substitute in; pools declare a load profile so a heavy-low-rep movement can't sneak into a finisher slot. Main lifts don't auto-rotate — an enumerated set of approved functional equivalents is available through the swap overlay.

## Progression

`lib/progression.js` reads the last session's effort signal and either advances load, holds, or backs off proportionally to the miss. A `cooked` readiness rating forces a hold outright — no session logged in a hole gets to set the next prescription. Step sizes and thresholds are per movement category; starting weights are bodyweight-derived and rounded to the loadable increment. The rules live in the code and are pinned by `tests/progression.test.js` — read those rather than a prose summary that can drift.

## Volume vs landmarks (MEV/MAV/MRV)

Two surfaces hold actual volume against evidence-based landmarks. `npm run audit:volume` prints what the default programme delivers per muscle — the static audit. In the app, the Performance Lab audits the trailing four weeks of logged sessions and flags muscles below MEV (won't drive growth) or above MRV (junk volume, recovery cost) with the specific shortfall.

Both operate at the **granular muscle level** — 16 tracked muscles, each delt head and each arm muscle distinct — because "Rear Delts under MEV" is actionable and "Shoulders under MEV" is not. Traps, Erectors and Core carry `mev: 0`: fatigue ceilings that flag excess without ever nagging a shortfall nobody should chase.

## Privacy posture

Passkeys are an optional lock on destructive operations and the photo layer — not an account system; a profile without one works locally, forever. Progress photos are re-encoded on capture, stripping all EXIF by construction, and no open-read path for a photo exists. Session records are immutable and append-only; the only delete that exists is a whole profile, passkey-gated and user-initiated.

## Quickstart

```bash
git clone https://github.com/abraraaa/project-forge.git
cd project-forge
npm install
npm run dev           # http://localhost:3000
```

`npm test` · `npm run lint` · `npm run typecheck` · `npm run build` · `npm run audit:volume`

The repo name and the `forge:`/`forge/` storage prefixes keep their old spelling on purpose — deep plumbing, invisible to users, not worth a migration.

## License

Heatwayve is **source-available, not open-source**. The default terms are **PolyForm Strict 1.0.0** (read, study, run privately; no redistribution, no derivatives, no reuse of code or content) — see [LICENSE](./LICENSE) for the binding text and [LICENSING.md](./LICENSING.md) for what it means in practice. Commercial licences (SaaS, white-label, integrations, any commercial use) are available — contact `ab@heatwayve.app`.

Conduct: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). What belongs in this repo and what doesn't: [docs/internal-notes.md](./docs/internal-notes.md).
