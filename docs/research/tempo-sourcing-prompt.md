# Research prompt — evidence-based lifting tempo per exercise

**Purpose:** enrich Forge's exercise library (`lib/exercise-anatomy.js`, 166
hand-tuned movements, surfaced at theforged.fit/library) with per-exercise
tempo guidance, to be discovered in the session screen. This prompt is
written for a *different* AI with strong live-search/citation ability (Grok,
Gemini Deep Research, etc.) whose job is to FACT-CHECK and SOURCE the data —
not to be creative. We will review its output before any of it enters the
app.

**How to use:** paste everything below the divider into the other model,
including the exercise list. Ask for the JSON block as a file/artifact if
the chat truncates.

---

You are a strength-training research assistant. Your task is to compile
evidence-based lifting **tempo** recommendations for a fixed list of
exercises, with sources. Accuracy and honesty about uncertainty matter more
than completeness.

## Definitions and rules

1. Use the standard 4-digit tempo notation `E-P1-C-P2`:
   eccentric seconds – stretched-position pause – concentric seconds –
   contracted-position pause. `X` = explosive intent. Example: `3-1-1-0`
   for a 3s lowering, 1s pause, controlled drive up, no pause at top.
2. For each exercise, give the tempo that best supports its PRIMARY role in
   a hypertrophy-leaning strength programme for intermediate lifters
   (Forge's audience). Where strength and hypertrophy prescriptions
   genuinely diverge (e.g. power cleans, heavy triples), say so in `note`.
3. Ground every claim in the strongest available evidence, in this order:
   (a) peer-reviewed research or meta-analyses (e.g. Schoenfeld et al. 2015
   on repetition duration; Wilk et al. on movement tempo), (b) systematic
   reviews of eccentric training, (c) published coaching literature from
   named, credible coaches (Helms, Israetel, Nuckols, Contreras — cite the
   specific article/book, not the person). Blog spam, AI content farms, and
   uncited listicles are not sources.
4. **Do not invent per-exercise precision the literature doesn't have.**
   Research mostly supports tempo RANGES and principles (controlled
   eccentric ~2–4s, no meaningful hypertrophy difference across moderate
   tempos, explosive concentric intent for power). Where a specific
   exercise has no direct tempo study — which is most of them — derive the
   recommendation from its movement class, mark `evidence: "derived"`, and
   name the principle you derived it from. Only mark `evidence: "direct"`
   when a study examined that exercise (or a trivially equivalent variant).
5. Isometric holds (planks, Copenhagen plank, dead hangs) and carries don't
   have a rep tempo — use `tempo: null` and put the hold/breathing guidance
   in `note`.
6. Timed/explosive conditioning movements (swings, slams, burpees) should
   be marked `tempo: "X"` semantics via the notation (e.g. `1-0-X-0`) with
   a note that intent, not seconds, is the prescription.
7. Every entry needs at least one source. Repeating the same meta-analysis
   across many derived entries is fine and expected.
8. If you cannot source an exercise at all, set `tempo: null`,
   `evidence: "none"` and say why in `note`. Do not guess silently.

## Output format

Return ONE fenced JSON block, keyed by the EXACT exercise names given below
(byte-for-byte — they are database keys). Schema per entry:

```json
{
  "Barbell Back Squat": {
    "tempo": "3-1-1-0",
    "evidence": "direct | derived | none",
    "principle": "one line: why this tempo for this movement",
    "note": "optional: divergences, safety caveats, isometric guidance",
    "sources": [
      { "cite": "Schoenfeld, Ogborn & Krieger (2015), J Sports Sci — repetition duration meta-analysis", "url": "https://..." }
    ]
  }
}
```

After the JSON block, add a short prose section titled **Confidence
summary**: which entries you consider weakest and what a human should
double-check first.

## Exercise list (166 — use these exact strings as keys)

- 45-Degree Hip Extension
- Ab Wheel
- Adductor Stretch Lunge
- Arnold Press
- Assisted Pull-Up
- B-Stance Hip Thrust
- Band Face Pull
- Band Lateral Raise
- Band Pull-Apart
- Banded Glute Bridge
- Banded Hip Thrust
- Barbell Back Squat
- Barbell Bench Press
- Barbell Front Rack Lunge
- Barbell Glute Bridge
- Barbell Hip Thrust
- Barbell Overhead Press
- Barbell Reverse Lunge
- Barbell Step-Up
- Barbell Walking Lunge
- Belt Squat
- Bench Dips
- Bird Dog
- Bulgarian Split Squat
- Cable Chest Fly
- Cable Crossover
- Cable Hip Abduction
- Cable Lateral Raise
- Cable Pull-Through
- Cable Rear Delt Fly
- Cable Row
- Cable Straight-Arm Pulldown
- Captain's Chair Raise
- Chest-Supported DB Row
- Chin-Up
- Close-Grip Push-Up
- Concentration Curl
- Copenhagen Plank
- Cossack Squat
- Curtsy Lunge
- DB Chest Fly
- DB Curl
- DB Floor Press
- DB Front Squat
- DB Lateral Lunge
- DB Lu Raise
- DB Reverse Lunge
- DB Split Squat
- DB Step-Up
- DB Sumo Squat
- DB Walking Lunge
- Dead Bug
- Decline Push-Up
- Deficit Reverse Lunge
- Diamond Push-Up
- Donkey Calf Raise
- Dumbbell Bench Press
- Dumbbell Bent-Over Row
- Dumbbell Deadlift
- Dumbbell Hang Clean
- Dumbbell Leg Curl
- Dumbbell Shoulder Press
- EZ Bar Curl
- Face Pull
- Face-Away Cable Row
- Floor Press
- Frog Pump
- Glute Bridge
- Goblet Squat
- Good Morning
- Hack Squat
- Half-Kneeling Cable Row
- Hammer Curl
- Hang Power Clean
- Hanging Knee Raise
- Hanging Leg Raise
- Hex Bar Deadlift
- Hip Adduction
- Hollow Body Hold
- Incline DB Curl
- Incline DB Press
- Incline DB Row
- Incline Landmine Press
- Incline Push-Up
- Kettlebell Swing
- Kneeling Landmine Press
- L-Sit Hold
- Landmine Press
- Landmine Squeeze Press
- Lat Pulldown
- Lateral Band Walk
- Lateral Raise
- Leaning Lateral Raise
- Leg Extension
- Leg Press
- Low-to-High Cable Crossover
- Low-to-High Cable Fly
- Lying Leg Raise
- Machine Hamstring Curl
- Meadows Row
- Neutral-Grip DB Press
- Neutral-Grip Pull-Up
- Nordic Curl
- Overhead Tricep Extension
- Pallof Press
- Pec Deck
- Pendulum Squat
- Pike Push-Up
- Plank
- Power Clean
- Preacher Curl
- Prone Y Raise
- Pull-Up
- Push Press
- Push-Up
- Rear Delt Fly
- Resistance Band Crossover
- Resistance Band Curl
- Resistance Band Face Pull
- Resistance Band Lateral
- Resistance Band Pull-Down
- Resistance Band Pull-Through
- Resistance Band Pushdown
- Resistance Band Row
- Reverse Crunch
- Reverse Hyperextension
- Reverse Lunge
- Romanian Deadlift
- Seal Row
- Seated Cable Row
- Seated Calf Raise
- Seated Lateral Raise
- Seated Leg Curl
- Side Plank
- Side-Lying Adduction
- Single-Arm Cable Fly
- Single-Arm Cable Row
- Single-Arm DB Row
- Single-Arm Landmine Press
- Single-Leg Calf Raise
- Single-Leg Curl
- Single-Leg Hip Thrust
- Single-Leg RDL
- Sissy Squat
- Skullcrusher
- Slider Leg Curl
- Split Squat
- Standing Cable Hip Extension
- Standing Calf Raise
- Step-Up
- Stir the Pot
- Sumo Deadlift
- Svend Press
- Swiss Ball Leg Curl
- TRX Row
- Toes-to-Bar
- Tricep Dips
- Tricep Pushdown
- V-Squat
- Wall Sit
- Weighted Pull-Up
- Wide-Grip Cable Row
- Wide-Grip Pull-Up
- Windshield Wiper
- Y-T-W Raise
- Zottman Curl
