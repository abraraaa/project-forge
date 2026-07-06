# Forge voice — "quietly sexy", sensation-forward

The visual language (Portra warmth, serif italics, film grain) already
carries the aesthetic; this document brings the words up to it. Status:
**first batch reviewed and shipped 2026-07-06** — two proposals vetoed
with replacements (recorded below so we never re-litigate), the rest
approved and live.

## The register

1. **Clarity is the gate.** A user mid-set, between breaths, gets
   instruction first and atmosphere second. If a line needs re-reading,
   it fails — whatever else it does well.
2. **Sensation, not hype.** Reference the felt experience of training —
   bar speed, the stretch, breath, weight settling, the good kind of
   heavy. Never cheerleading ("crush it", "beast mode"), never
   exclamation marks.
3. **Prescriptive, not punitive** (existing doctrine, unchanged). The app
   tells you what to do next; it never scolds what you didn't.
4. **Quiet confidence.** Short declaratives. The serif italic is where
   the voice breathes — sensory lines belong there; instructions stay in
   the sans.
5. **The mid-set test.** Read the line aloud imagining RPE 9 two sets
   ago. If you can't parse it in one pass, cut it.

**Reference lines that already hit the register** (calibrate against
these): "Train with intention." · "back knee kisses floor gently" (tempo
note) · "A lighter stretch — that's part of training." (Lab away-state) ·
"Coming back is what counts." (return line) · "Strength session next.
Load up."

## Proposals

Verdicts: **keep** (already right) · **proposed** (needs your sign-off).

### Readiness screen

| Where | Current | Proposal | Verdict |
|---|---|---|---|
| Headline | How are you *feeling today?* | — | keep — already the voice |
| Fresh sub | Full programme. Push today. | Full programme. The good kind of heavy. | shipped |
| Normal sub | Standard session. | The work, as written. | shipped |
| Cooked sub | Deload weights · trimmed volume. | — | keep — engine terms, information-dense, exactly clear |

### Session screen

| Where | Current | Proposal | Verdict |
|---|---|---|---|
| RPE prompt | How was that set? | How did that one move? | shipped — bar-speed is the sensation lifters actually read |
| RPE easy sub | More in the tank | — | keep |
| RPE normal sub | Working effort | — | keep |
| RPE cooked sub | Max effort | Nothing left | shipped |
| Rest hint | ~3 min rest | ~3 min. Catch your breath. | shipped |
| Superset round label | Round N of M — rate the effort | — | keep |

### Done screen

| Where | Current | Proposal | Verdict |
|---|---|---|---|
| Headlines pool | Solid work. / That's a session. / Job done. / Nothing wasted. | ADD to pool: "Heavy, handled." · "The bar moved." | shipped — additions, not replacements |
| Weight nudge (changed) | Weight updated for next session | Next time, heavier. | shipped |
| Weight nudge (hold) | Hold — keep grinding | ~~Hold — it'll move next time.~~ → **Hold — grind it smooth.** | VETOED dropping "grinding" ("best move on the dancefloor") — the word stays, rephrased to read for everyone. Shipped |
| Next: rest | Rest day tomorrow. You've earned it. | ~~That's where it grows.~~ → **That's where *you* grow.** | VETOED "it grows" (reads anatomical). User's wording shipped — subtler, and better |
| Next: strength | Strength session next. Load up. | — | keep — reference register |
| Next: zone2 / cardio / hiit | (times + prescriptions) | — | keep — pure instruction rows |
| Deload line | Deload complete. Welcome back. | — | keep |
| Return line | Back at it — first one in N days. Coming back is what counts. | — | keep |

### Home screen

| Where | Current | Proposal | Verdict |
|---|---|---|---|
| CTA | Begin session | — | keep — the CTA is sacred clarity |
| Day-done line | Done. Streak maintained. | Done. Rhythm kept. | shipped — "rhythm" is already the app's own vocabulary |

### Performance Lab · Library · Share card

| Where | Current | Proposal | Verdict |
|---|---|---|---|
| Lab away-state | A lighter stretch — that's part of training. | — | keep — this IS the voice |
| Lab volume philosophy line | Measured recent, not lifetime — because consistency over time builds where single big weeks don't. | — | keep |
| Library contribution caption | …meaningful help, not a replacement for direct work. | — | keep |
| Share-card footer | Train with intention. | — | keep — the anchor line |

## Positioning (decided 2026-07-06)

Forge is not described as a "tracker" anywhere we control. The line is:

> **Unveil the best you.**

The brand is already quietly sexy — the decision is to stop apologising
for it. Supporting ethos line where a second beat fits: *fire and
pressure, applied with intent* (it's a forge; the metaphor was always
there). "Train with intention." remains the imperative anchor (titles,
share card); "Unveil the best you." is the promise (descriptions,
manifest, README, OG).

Applied to: layout metadata description + OG + twitter + JSON-LD,
manifest.json description, README hero. NOT applied to in-app UI chrome —
the app itself shows, it doesn't pitch.

Considered and declined: a Grok review pass over the exercise
descriptions themselves — the tempo notes already carry the register,
and grading our own curation with a second model veers into pantomime.

## Still to inventory (second pass)

Onboarding flow, swap overlay, drum-edit overlay, retro-logging picker,
push-notification prompts, glossary sheet intros, /diag-sync operational
copy (probably exempt — diagnostic surfaces want zero atmosphere).

## Process

One table row = one reviewable decision. When approved rows ship, the
commit references this file; rejected proposals get struck through and
kept as a record of what we decided against, so we don't re-litigate.
