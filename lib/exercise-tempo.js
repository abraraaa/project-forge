// @ts-check
// lib/exercise-tempo.js
// ─────────────────────────────────────────────────────────────────────────────
// Evidence-based lifting tempo per exercise, in standard 4-digit notation
// E-P1-C-P2: eccentric seconds – stretch-position pause – concentric seconds –
// contracted-position pause. X = explosive intent (power work is prescribed
// by speed, not seconds). null = isometric hold (guidance lives in note).
//
// PROVENANCE: compiled 2026-07-06 by an external research model from
// the tempo sourcing prompt (internal notes), then reviewed before ingestion.
// Every entry is honestly labelled: evidence 'derived' means the tempo comes
// from a movement-class principle in the cited literature (which is the case
// for nearly all exercises — per-exercise tempo studies barely exist);
// 'none' means an isometric where rep tempo doesn't apply. No entry claims
// more precision than the research carries.
// Principle strings rewritten in plain English on 2026-11-12, meanings unchanged.
//
// Keys are canonical exercise names (byte-for-byte with EXERCISE_ANATOMY);
// tests/library.test.js locks the join. Citations are normalised into
// TEMPO_SOURCES because two references back most entries.
// ─────────────────────────────────────────────────────────────────────────────

export const TEMPO_SOURCES = {
  schoenfeld2015: {
    cite: 'Schoenfeld BJ, Ogborn DI, Krieger JW. Effect of Repetition Duration During Resistance Training on Muscle Hypertrophy: A Systematic Review and Meta-Analysis. Sports Med. 2015;45(4):577-585.',
    url: 'https://doi.org/10.1007/s40279-015-0304-0',
  },
  wilk2021: {
    cite: 'Wilk M, Zając A, Tufano JJ. The Influence of Movement Tempo During Resistance Training on Muscular Strength and Hypertrophy Responses: A Review. Sports Med. 2021;51(8):1629-1650.',
    url: 'https://doi.org/10.1007/s40279-021-01465-2',
  },
  isometric: {
    cite: 'General isometric training literature — holds are prescribed by duration and bracing quality, not rep tempo.',
    url: null,
  },
};

export const EXERCISE_TEMPO = {
  "45-Degree Hip Extension": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Lower slowly and squeeze at the top to keep the work on your glutes and hamstrings. The slow lowering keeps them working longer.",
    note: "Squeeze glutes hard at top; keep neutral spine.",
    sources: [
      "schoenfeld2015",
      "wilk2021"
    ]
  },
  "Ab Wheel": {
    tempo: "4-0-2-0",
    evidence: "derived",
    principle: "The slow rollout keeps your core working to stop your back arching at full stretch. A controlled return stops your lower back taking over.",
    note: "Use band assistance or roll from the knees if you lose the full range.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Adductor Stretch Lunge": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Sinking slowly into the stretch and pausing there builds control and mobility in your inner thighs under load.",
    note: "Keep front knee tracking over ankle; breathe into the stretch.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Arnold Press": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Lower slowly and rotate deliberately on the way up to work the side delts and keep the rotator cuff stable. The slower pace cuts out momentum.",
    note: "Full rotation at top; avoid flaring elbows excessively.",
    sources: [
      "wilk2021"
    ]
  },
  "Assisted Pull-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Three seconds down and a short pause at the bottom build pulling strength and shoulder-blade control, so you can cut the assistance over time.",
    note: "Use the least assistance you need for the full range.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "B-Stance Hip Thrust": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Slow lowering and a pause at the top work your glutes at full squeeze and full stretch. Favouring one leg adds a balance challenge.",
    note: "Drive through heel of working leg; keep ribs down.",
    sources: [
      "wilk2021"
    ]
  },
  "Band Face Pull": {
    tempo: "2-1-2-1",
    evidence: "derived",
    principle: "Steady reps with a pause in the rotated-out position train the rear delts for posture and shoulder health. A light band keeps form strict.",
    note: "Lead with elbows; think 'separate the band at the face'.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Band Lateral Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Lowering slowly stops you swinging, the usual cheat on raises. A controlled lift keeps steady tension on the side delts.",
    note: "Slight lean away from anchor; pinky slightly higher than thumb at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Band Pull-Apart": {
    tempo: "2-1-2-1",
    evidence: "derived",
    principle: "Short pauses at a controlled pace teach you to pull the shoulder blades back and rotate the arms out, without needing heavy load.",
    note: "Keep slight elbow bend; focus on rear delts and rhomboids.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Banded Glute Bridge": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Hold the top and lower under control to keep your glutes squeezed for longer. The band gets harder as you rise.",
    note: "Drive knees out against band; full hip extension at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Banded Hip Thrust": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Same glute focus as the barbell version. The band keeps constant tension and gives a hard top squeeze without heavy load through your spine.",
    note: "Chin tucked, ribs down; drive through heels.",
    sources: [
      "wilk2021"
    ]
  },
  "Barbell Back Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Three seconds down and a pause at the bottom remove the bounce and build stability. Staying deep for longer is a standard way to build muscle.",
    note: "Pause at depth you can control with good form; brace hard.",
    sources: [
      "schoenfeld2015",
      "wilk2021"
    ]
  },
  "Barbell Bench Press": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Pausing on the chest takes out the bounce and loads your chest and shoulders at the stretch. The controlled pace keeps the weight honest.",
    note: "Bar to lower chest or nipple line; scapulae retracted throughout.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Barbell Front Rack Lunge": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Holding the bar in the front rack asks more of your core and quads. The tempo keeps each rep controlled and both legs equally strong.",
    note: "Knee tracks over ankle; upright torso.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Barbell Glute Bridge": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Pausing at the top and lowering under control gets the most from your glutes where they are fully squeezed.",
    note: "Chin tucked; avoid over-extending lumbar.",
    sources: [
      "wilk2021"
    ]
  },
  "Barbell Hip Thrust": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "A classic glute lift. Lower slowly and hold the top, where the squeeze is hardest.",
    note: "Bar pad recommended; drive through heels, squeeze hard at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Barbell Overhead Press": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Drive the bar up hard, then take three seconds to lower it. That keeps your shoulders stable and the weight honest.",
    note: "Bar path slightly arced; core braced, no excessive lean back.",
    sources: [
      "wilk2021"
    ]
  },
  "Barbell Reverse Lunge": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Works like the forward lunge, one leg at a time. The pause at the bottom makes you hold your balance.",
    note: "Step back far enough for good hip hinge; front knee tracks over ankle.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Barbell Step-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Drive the step with your quads and glutes, not momentum. The controlled pace builds single-leg strength and balance.",
    note: "Drive through whole foot; avoid pushing off back leg.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Barbell Walking Lunge": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Come up a little quicker, as you would when walking, but keep the lowering slow. It suits higher-rep muscle-building work.",
    note: "Keep torso upright; alternate legs smoothly.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Bayesian Cable Curl": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Reaching behind you stretches the biceps' long head and the cable keeps it loaded at the bottom. Lower slowly and pause there, like the incline curl.",
    note: "Face away from the stack, elbow behind the body; let the arm straighten fully, then curl without the elbow drifting forward.",
    sources: [
      "wilk2021"
    ]
  },
  "Belt Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "The same tempo as the back squat, with the load off your spine. You can keep it strict without a tired back ending the set.",
    note: "Great for quad emphasis or when back is fatigued.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Bench Dips": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Lower with control to protect your shoulders. Going slower works the triceps and chest harder without excessive leverage from your bodyweight.",
    note: "Keep elbows close; only go as deep as shoulder comfort allows.",
    sources: [
      "wilk2021"
    ]
  },
  "Bird Dog": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Slow, braced reps with pauses train your core to stop your body twisting. The tempo forces each move to be deliberate.",
    note: "Reach with the opposite arm and leg. Keep your spine neutral and hips level.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Bulgarian Split Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "A single-leg lift for quads and glutes. The pause and slow lowering demand balance and keep the muscles working in the deep stretch.",
    note: "Front foot far enough for good hip hinge; back knee kisses floor gently.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Cable Chest Fly": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Open slowly and close under control for a deep chest stretch and constant tension. The cable keeps the resistance well spread through the arc.",
    note: "Slight elbow bend; squeeze at midline.",
    sources: [
      "wilk2021"
    ]
  },
  "Cable Crossover": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Run it like the cable fly, slow on the way out. Changing the cable angle lets you bias the upper or lower chest.",
    note: "Cross hands slightly at bottom; controlled return.",
    sources: [
      "wilk2021"
    ]
  },
  "Cable Hip Abduction": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Moving slowly keeps constant tension on the smaller glutes at the side of your hip and stops the swing that creeps into standing abduction.",
    note: "Stand tall, slight hinge if needed; lead with heel.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Cable Lateral Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Keep it as strict as the band raise. The cable gives steady tension all the way through the arc.",
    note: "Lead with elbow; slight lean away from machine.",
    sources: [
      "wilk2021"
    ]
  },
  "Cable Pull-Through": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Hinge back slowly, then drive the hips through faster for power, keeping the load on your hamstrings and glutes.",
    note: "Soft knees, neutral spine; snap hips through at top.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Cable Rear Delt Fly": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Pause at the stretch and lift slowly to load the rear delts and the muscles that draw your shoulder blades back. It stops you swinging.",
    note: "Slight elbow bend; lead with elbows, not hands.",
    sources: [
      "wilk2021"
    ]
  },
  "Cable Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Lower under control and pause at the stretch to build a thicker mid-back and lats. The tempo keeps your shoulder blades moving properly.",
    note: "Neutral or slight thoracic extension; squeeze shoulder blades.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Cable Straight-Arm Pulldown": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "This isolates the lats with constant tension. Letting the bar rise slowly gives a full stretch and helps you feel the muscle working.",
    note: "Slight lean, arms straight; think 'pull elbows to hips'.",
    sources: [
      "wilk2021"
    ]
  },
  "Captain's Chair Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Raising and lowering at a steady pace builds strength in the lower abs and hip flexors, with no swinging.",
    note: "Posterior pelvic tilt at top; avoid swinging.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Chest-Supported DB Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "The pad lets you keep a strict tempo and load up your lats and the muscles between your shoulder blades. The pause kills momentum.",
    note: "Chest glued to pad; full stretch at bottom.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Chin-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Pulls like the pull-up. Pausing at the bottom makes it harder and teaches shoulder-blade control.",
    note: "Supinated grip; full extension at bottom if shoulder mobility allows.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Close-Grip Push-Up": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "The narrow hands put the triceps to work. Lowering slowly protects your shoulders and keeps the muscle working longer.",
    note: "Hands under shoulders or slightly narrower; elbows track back.",
    sources: [
      "wilk2021"
    ]
  },
  "Concentration Curl": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Pause at the bottom to stretch the biceps' long head, then squeeze hard at the top. Strict reps leave no room to cheat.",
    note: "Elbow pinned to inner thigh; full supination at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Copenhagen Plank": {
    tempo: null,
    evidence: "none",
    principle: "A side hold for your inner thighs and core. There is no rep tempo, so work to time instead.",
    note: "Hold 20–45 s per side. Keep your body in a straight line and brace hard. Progress by lifting the top leg or adding movement.",
    sources: [
      "isometric"
    ]
  },
  "Cossack Squat": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Sink deep to each side at a controlled pace. It builds inner-thigh, glute and ankle mobility under load.",
    note: "Keep chest up; one leg straightens while other bends deeply.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Curtsy Lunge": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Works glutes and quads one leg at a time while you resist twisting. The tempo keeps the form strict.",
    note: "Back knee tracks behind front heel; upright torso.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "DB Chest Fly": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Same tempo as the cable fly. Dumbbells let you sink into a deeper stretch at the bottom.",
    note: "Slight elbow bend; arc motion, not pressing.",
    sources: [
      "wilk2021"
    ]
  },
  "DB Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Keep the tempo strict so the weight never swings. Lowering slowly holds tension on the biceps through the whole range.",
    note: "Supinate at top; control the negative.",
    sources: [
      "wilk2021"
    ]
  },
  "DB Floor Press": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "The floor shortens the range and the pause eases stress on your shoulders, while still working the triceps and chest. The tempo keeps it honest.",
    note: "Elbows at 45°; pause with triceps on floor.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Front Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Same tempo as the back squat. The front rack punishes losing position on the slow way down, and that control is what you are training.",
    note: "Elbows high the whole way; the bar drops the moment they do.",
    sources: [
      "schoenfeld2015",
      "wilk2021"
    ]
  },
  "DB Front Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Same tempo as the barbell version. Holding the weights in front keeps you upright and puts the emphasis on your quads.",
    note: "Elbows high; knees track over toes.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "DB Lateral Lunge": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Moving sideways at a controlled pace builds strength and mobility in your inner thighs and the side of your glutes.",
    note: "Sit back into working hip; keep chest up.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "DB Lu Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Controlling the tempo on this strict lateral raise variation keeps the work on your side delts.",
    note: "Lead with elbows; slight external rotation at top.",
    sources: [
      "wilk2021"
    ]
  },
  "DB Reverse Lunge": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Same lunge tempo as the barbell version. Dumbbells let your arms hang naturally, or hold one at your chest goblet style.",
    note: "Step back far enough; front knee stable.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "DB Split Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "A lunge without the step. The tempo asks more of your quads and glutes and tests your balance.",
    note: "Back knee gently kisses floor; front foot stable.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "DB Step-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Dumbbells let you add load or focus on one side. Otherwise it follows the same tempo as any step-up.",
    note: "Drive through whole foot of working leg.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "DB Sumo Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "The wide stance and slow tempo bring in your inner thighs and glutes. Pausing at the bottom makes it harder.",
    note: "Toes out 30–45°; knees track over toes.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "DB Walking Lunge": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Rise a little faster, as you would walking, but stay in control so the lunge still builds muscle.",
    note: "Alternate legs smoothly; torso upright.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Dead Bug": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Slow, braced reps with pauses stop your lower back arching and train deep core control in time with your breathing.",
    note: "Lower back stays glued to floor; exhale on effort.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Decline Push-Up": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Raising your feet shifts more work to the upper chest and shoulders. A controlled pace keeps the form strict.",
    note: "Hands slightly wider than shoulders; core tight.",
    sources: [
      "wilk2021"
    ]
  },
  "Deficit Reverse Lunge": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Standing on a step lets you sink deeper, so your glutes and quads work harder at the stretch. The tempo keeps it controlled.",
    note: "Back foot on small platform; front knee stable.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Diamond Push-Up": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "The close hands put the triceps to work under a controlled tempo. For some lifters it is easier on the shoulders than full-depth dips.",
    note: "Hands under sternum, diamond shape; elbows track back.",
    sources: [
      "wilk2021"
    ]
  },
  "Donkey Calf Raise": {
    tempo: "4-1-2-0",
    evidence: "derived",
    principle: "Four seconds down and a pause at the bottom give your calves a long stretch and keep them working longer, a classic way to grow calves.",
    note: "Full dorsiflexion at bottom; controlled plantarflexion.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Dumbbell Bench Press": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Dumbbells give a longer range than the barbell and let each arm work on its own. The tempo stays the same.",
    note: "Dumbbells to sides of chest; slight arc at top.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Dumbbell Bent-Over Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Hinged over with a pause at the stretch, this builds a thicker mid-back and trains you to resist twisting.",
    note: "Flat back, 45° torso; pull elbow to hip.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Dumbbell Deadlift": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Lower slowly to load the whole back of your body. Dumbbells let you move through whatever range feels natural.",
    note: "Hinge at hips; neutral spine throughout.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Dumbbell Hang Clean": {
    tempo: "1-0-X-0",
    evidence: "derived",
    principle: "Drive up as fast as you can through hips, knees and ankles to build power. Keep pauses out so the movement stays springy.",
    note: "Focus on speed and hip drive; catch in front rack or hang position as prescribed.",
    sources: [
      "wilk2021"
    ]
  },
  "Dumbbell Leg Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Lowering slowly gives your hamstrings a full stretch and a strong squeeze without swinging the weight.",
    note: "Full extension at bottom; squeeze at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Dumbbell Shoulder Press": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Same pressing tempo as the barbell. Dumbbells let your shoulder blades move freely and each arm work on its own.",
    note: "Neutral or pronated grip as preferred; core braced.",
    sources: [
      "wilk2021"
    ]
  },
  "EZ Bar Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "The angled bar is easier on the wrists and, for some, allows heavier curls than a straight bar. Keep the biceps tempo strict.",
    note: "Full supination or semi-supinated; control the negative.",
    sources: [
      "wilk2021"
    ]
  },
  "Face Pull": {
    tempo: "2-1-2-1",
    evidence: "derived",
    principle: "Pauses put the work on your rear delts and the muscles that rotate the shoulder outward. The tempo reinforces healthy shoulders and posture.",
    note: "Lead with elbows; external rotation at face level.",
    sources: [
      "schoenfeld2015"
    ]
  },
  // retired 2026-10-11: not a real exercise; kept so stored sets and weights still resolve
  "Face-Away Cable Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Standing facing away puts your back at a stretch. The tempo builds lats and mid-back while you work to stop your body twisting.",
    note: "Face away from stack; step forward for tension at start.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Floor Press": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Same floor press tempo as the dumbbell version. The barbell lets you lift heavier with both arms together.",
    note: "Pause with triceps on floor; elbows at ~45°.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Frog Pump": {
    tempo: "2-1-2-1",
    evidence: "derived",
    principle: "Short pauses at both ends let you squeeze the glutes hard without heavy load on your spine.",
    note: "Feet together, knees out; small range, big squeeze.",
    sources: [
      "wilk2021"
    ]
  },
  "Glute Bridge": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "A bodyweight glute exercise. Slow reps and a pause at the top build the base for the hip thrust.",
    note: "Drive through heels; full hip extension at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Goblet Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Holding the weight at your chest keeps you upright and works the quads. The tempo matches the barbell squat so your training stays consistent.",
    note: "Elbows inside knees at bottom; brace hard.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Good Morning": {
    tempo: "4-0-1-0",
    evidence: "derived",
    principle: "Four seconds down stretches your hamstrings and glutes. The controlled hinge lowers injury risk and gives the muscles more to work against.",
    note: "Soft knees, neutral spine; hinge from hips, not lumbar.",
    sources: [
      "schoenfeld2015",
      "wilk2021"
    ]
  },
  "Hack Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "The machine fixes your path, so you can put the effort into your quads and control the depth without balancing.",
    note: "Feet high and narrow for quad bias. Use the full range if your knees allow.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Half-Kneeling Cable Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Kneeling on one knee makes your core work to stop you twisting. The tempo keeps each rep strict.",
    note: "Tall half-kneeling posture; pull to hip.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Hammer Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Holding the dumbbells thumbs up works the biceps and brachialis. A strict tempo stops you swinging and keeps the tension on.",
    note: "Elbows pinned. Use the full range without bringing the shoulders in.",
    sources: [
      "wilk2021"
    ]
  },
  "Hang Power Clean": {
    tempo: "1-0-X-0",
    evidence: "derived",
    principle: "Explode up from the hang. Skipping pauses trains power and how quickly you can produce force.",
    note: "Triple extension focus; catch in power position. Speed over seconds.",
    sources: [
      "wilk2021"
    ]
  },
  "Hanging Knee Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Hang still and raise at a controlled pace to build lower abs and hip flexors without swinging.",
    note: "Posterior pelvic tilt; avoid swinging.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Hanging Leg Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Straight legs ask more of your lower abs and hip flexors than the knee raise. Keep the same steady tempo.",
    note: "Legs straight if hamstring mobility allows; controlled return.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Hex Bar Deadlift": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Lower under control. For many lifters the hex bar brings in more quads and puts less shearing stress on the back than a straight bar.",
    note: "Neutral grip; hinge or slight squat pattern depending on height.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Hip Adduction": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Opening slowly against the machine or cable stretches your inner thighs, then squeeze them back together.",
    note: "Use the full range and avoid using body momentum.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Hollow Body Hold": {
    tempo: null,
    evidence: "none",
    principle: "A hold that trains your core to stop your back arching. It runs on time, not a rep tempo.",
    note: "Hold 20–45 s; ribs down, lower back pressed into floor, legs and arms extended or tucked as prescribed. Breathe steadily.",
    sources: [
      "isometric"
    ]
  },
  "Incline DB Curl": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Leaning back on the incline stretches the long head of the biceps. Lower slowly and pause at the bottom to make the most of it.",
    note: "Arms hang straight at bottom; supinate at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Incline BB Press": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "A paused barbell press on an incline for the upper chest. Keep the tempo controlled from start to finish.",
    note: "Bench at 30–45°; bar to upper chest, pause before pressing.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Incline DB Press": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Pause at the bottom and keep the pace steady. The incline shifts the emphasis to your upper chest.",
    note: "Bench at 30–45°; bar or dumbbells to upper chest.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Incline DB Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Lying on an incline bench supports you, so the tempo builds your upper back with less strain on the lower back.",
    note: "Chest on bench; full stretch at bottom.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Incline Landmine Press": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "The landmine arc and incline angle aim at the upper chest and shoulders. Lower under control, then press with intent.",
    note: "Neutral grip; drive through heel of hand.",
    sources: [
      "wilk2021"
    ]
  },
  "Incline Push-Up": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Hands up on a bench makes the push-up lighter. A controlled tempo keeps form strict, which suits beginners or high-volume work.",
    note: "Hands on a bench or box. Keep your core tight and use the full range.",
    sources: [
      "wilk2021"
    ]
  },
  "Kettlebell Swing": {
    tempo: "X-0-X-0",
    evidence: "derived",
    principle: "Snap the hips hard for power and conditioning in the back of your body. Intent matters more than counting seconds.",
    note: "Hip snap, not arm pull; Russian or American style as prescribed. Speed and power primary.",
    sources: [
      "wilk2021"
    ]
  },
  "Kneeling Landmine Press": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Pressing from one knee makes your core resist twisting, and the tempo keeps that demand on every rep.",
    note: "Tall kneeling; drive through heel of hand, brace core.",
    sources: [
      "wilk2021"
    ]
  },
  "L-Sit Hold": {
    tempo: null,
    evidence: "none",
    principle: "A static hold for your core and hip flexors, so time it instead of counting a tempo.",
    note: "Hold 10–30 s; legs straight and elevated, shoulders depressed, chest up. Progress by tucking then extending legs.",
    sources: [
      "isometric"
    ]
  },
  "Landmine Press": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Standing with the bar on an arc lets your shoulder blades move naturally, and the tempo keeps your core switched on.",
    note: "Split stance or square; drive through heel of hand.",
    sources: [
      "wilk2021"
    ]
  },
  "Landmine Squeeze Press": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Pressing the hands together on the bar and holding the top keeps constant tension on the inner chest and triceps.",
    note: "Hands together on bar; squeeze hard at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Lat Pulldown": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Pause with the arms stretched overhead, then pull. The tempo builds wider lats and mid-back strength and teaches control of your shoulder blades.",
    note: "Lean back slightly; pull to upper chest or behind neck as mobility allows.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Lateral Band Walk": {
    tempo: "2-0-2-0",
    evidence: "derived",
    principle: "Steady steps against a mini band switch on the side of your glutes and build the hip stability your big lifts rely on.",
    note: "Athletic stance, knees soft; step out against band tension.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Lateral Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Swinging is the biggest cheat on raises, and a strict tempo stops it. Lowering slowly keeps the side delts under tension.",
    note: "Lead with elbows; slight lean if needed; pinky slightly higher than thumb.",
    sources: [
      "wilk2021"
    ]
  },
  "Leaning Lateral Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Leaning away adds range and stretches the side delt further. The tempo keeps every rep strict.",
    note: "Hold support with non-working hand; lean away slightly.",
    sources: [
      "wilk2021"
    ]
  },
  "Leg Extension": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "This isolates the quads. Lowering slowly keeps the inner and outer quad muscles under tension and works on knee stability.",
    note: "Full extension at top; control the negative, avoid locking harshly.",
    sources: [
      "wilk2021"
    ]
  },
  "Leg Press": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "The machine takes load off your spine, so the pause and tempo let you work quads and glutes hard while controlling depth.",
    note: "Feet high and narrow for quad bias, or low and wide for glutes. Use the full range if your knees allow.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Low-to-High Cable Crossover": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Aimed at the upper chest, this fly uses slow reps to keep the cable tension on throughout.",
    note: "Low pulley; bring hands up and in, squeeze upper pecs.",
    sources: [
      "wilk2021"
    ]
  },
  "Low-to-High Cable Fly": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Sweeping up from a low pulley at a slow tempo stretches and squeezes the upper chest.",
    note: "Slight elbow bend; arc upward and inward.",
    sources: [
      "wilk2021"
    ]
  },
  "Lying Leg Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Lying on your back, raise and lower with control to build lower abs and hip flexors.",
    note: "Lower back stays down; exhale on raise.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Machine Hamstring Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Whether seated or lying, let the weight return slowly to stretch the hamstrings, then curl under control for a strong squeeze.",
    note: "Full extension at bottom; squeeze at top, avoid using momentum.",
    sources: [
      "wilk2021"
    ]
  },
  "Meadows Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "A one-arm landmine row. The pause at the stretch builds a thicker upper back and lats while you resist twisting.",
    note: "Hinge at hips; pull elbow high and back.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Neutral-Grip DB Press": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Same tempo as the standard dumbbell bench. Palms facing each other is often kinder to the shoulders.",
    note: "Palms facing; slight arc at top.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Neutral-Grip Lat Pulldown": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Pause at the stretch, as on the lat pulldown. The neutral handle drives your elbows down to the ribs for a long lat range under heavy load.",
    note: "Full stretch overhead at the top; pull the handle to the upper chest, elbows close to the body.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Neutral-Grip Pull-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Palms facing each other is often easier on the shoulders. The tempo builds your lats and biceps.",
    note: "Full extension at bottom if mobility allows; pull chest to bar.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Nordic Curl": {
    tempo: "5-0-X-0",
    evidence: "derived",
    principle: "Five seconds down loads your hamstrings hard at long lengths. Nordics have their own research behind them for strength and injury prevention.",
    note: "Use a band or partner to help you control the full way down. Come back up with assistance or push back explosively.",
    sources: [
      "schoenfeld2015",
      "wilk2021"
    ]
  },
  "Overhead Tricep Extension": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Overhead puts the long head of the triceps on stretch. Lowering slowly keeps it loaded at that length.",
    note: "Elbows point up and stay close to your head. Fully extend at the top.",
    sources: [
      "wilk2021"
    ]
  },
  "Pallof Press": {
    tempo: "2-1-2-1",
    evidence: "derived",
    principle: "Pressing out and pausing against the pull builds core bracing and shoulder stability as you resist rotation.",
    note: "Tall posture; press out and resist rotation, return with control.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Pec Deck": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Holding the squeeze where the arms meet keeps constant tension on the inner chest.",
    note: "Slight elbow bend; squeeze hard at midline.",
    sources: [
      "wilk2021"
    ]
  },
  "Pendulum Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "The swinging machine path lets you squat deep for your quads with less load on your spine, and the tempo keeps it controlled.",
    note: "Feet position per machine; full controlled depth if knee health allows.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Pike Push-Up": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "A push-up turned into a shoulder press. The tempo builds overhead pressing strength with bodyweight alone.",
    note: "Hips high; head travels toward hands; scale with box or band if needed.",
    sources: [
      "wilk2021"
    ]
  },
  "Plank": {
    tempo: null,
    evidence: "none",
    principle: "A hold that keeps your back from sagging. Time it and focus on bracing, as there is no rep tempo.",
    note: "Hold 20–60 s; body straight, ribs down, glutes and quads engaged, breathe steadily. Progress by adding movement or instability.",
    sources: [
      "isometric"
    ]
  },
  "Power Clean": {
    tempo: "1-0-X-0",
    evidence: "derived",
    principle: "Speed is the goal. Extend hard through hips, knees and ankles without pausing, and treat muscle growth as secondary to building power.",
    note: "Speed and intent primary. Catch in power position. Focus on hip drive and bar path.",
    sources: [
      "wilk2021"
    ]
  },
  "Preacher Curl": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "The pad locks your elbows in place. Lowering slowly and pausing in the stretch puts the work on the biceps' long head.",
    note: "Full extension at bottom without locking elbow joint harshly; supinate at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Prone Y Raise": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "In the face-down Y position you target the lower traps and rear delts. A paused tempo builds shoulder-blade stability and posture.",
    note: "Thumbs up; lift arms into Y shape, squeeze shoulder blades.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Pull-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Pausing at the bottom of the hang builds lat strength and shoulder-blade control, for both size and strength.",
    note: "Full extension at bottom if shoulder mobility allows; pull chest to bar.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Push Press": {
    tempo: "1-0-X-0",
    evidence: "derived",
    principle: "Dip and drive explosively. The goal is power, so the tempo shows intent rather than counted seconds.",
    note: "Dip, drive, press. Speed and power focus; catch overhead stable.",
    sources: [
      "wilk2021"
    ]
  },
  "Push-Up": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Done under control, the push-up works your chest and triceps and keeps your core stable throughout.",
    note: "Hands under your shoulders or slightly wider. Use the full range and keep your core tight.",
    sources: [
      "wilk2021"
    ]
  },
  "Rear Delt Fly": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Whether with dumbbells or a machine, the pause and slow tempo load the rear delts and the muscles that pull your shoulder blades back.",
    note: "Slight elbow bend; lead with elbows, squeeze at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Rear Delt Row": {
    tempo: "3-0-2-1",
    evidence: "derived",
    principle: "Elbows flared and chest supported, lower under control and hold the top so your rear delts move the weight, not momentum.",
    note: "Chest on an incline bench; elbows out at about 60 to 75 degrees, pull to the lower chest, hold a beat at the top.",
    sources: [
      "wilk2021"
    ]
  },
  "Reverse Pec Deck": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "The machine's fixed arc and a pause keep tension on the rear delts through the whole range.",
    note: "Handles at shoulder height, slight elbow bend; sweep back until the arms are in line with the body, squeeze, then return slowly.",
    sources: [
      "wilk2021"
    ]
  },
  "Resistance Band Crossover": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "On a band fly, the tempo keeps tension constant and stops you using momentum.",
    note: "Cross hands at midline; controlled return.",
    sources: [
      "wilk2021"
    ]
  },
  "Resistance Band Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Curling against a band at a steady pace keeps the biceps under tension through the full range, most of all at the top.",
    note: "Elbows pinned; supinate against band resistance.",
    sources: [
      "wilk2021"
    ]
  },
  "Resistance Band Face Pull": {
    tempo: "2-1-2-1",
    evidence: "derived",
    principle: "Pauses against a band that gets harder as you pull train the rear delts and keep your shoulder blades healthy.",
    note: "Lead with elbows; external rotation at face.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Resistance Band Lateral": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Raise against the band slowly. The tempo stops momentum and keeps tension on the side delts.",
    note: "Lead with elbows; slight lean if anchored low.",
    sources: [
      "wilk2021"
    ]
  },
  "Resistance Band Pull-Down": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "A band version of the lat pulldown. The tempo keeps tension on as you build pulling strength.",
    note: "Lean back slightly; pull to upper chest.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Resistance Band Pull-Through": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "A band hinge. The tempo builds the back of your body against resistance that grows as you stand up.",
    note: "Soft knees; snap hips through, squeeze glutes.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Resistance Band Pushdown": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "A triceps pushdown with a band. Letting it rise slowly keeps tension on the triceps' long head.",
    note: "Elbows pinned to sides; full extension at bottom.",
    sources: [
      "wilk2021"
    ]
  },
  "Resistance Band Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Rowing against a band with a pause builds the mid-back and lats, with constant tension and control of your shoulder blades.",
    note: "Hinge slightly; pull elbows back, squeeze shoulder blades.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Reverse Crunch": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Curling the hips up and lowering them slowly builds lower-ab strength and teaches you to tuck your pelvis under.",
    note: "Lift hips off floor with control; exhale on effort.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Reverse Hyperextension": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Holding the top squeezes the glutes and hamstrings hard, and the slow return works them at length.",
    note: "Controlled swing or strict; squeeze at top, avoid lumbar over-extension.",
    sources: [
      "wilk2021"
    ]
  },
  "Reverse Lunge": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Stepping back builds quads, glutes and balance, and for some lifters it is easier on the knees than a forward lunge.",
    note: "Step back far enough; front knee stable over ankle.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Romanian Deadlift": {
    tempo: "4-0-1-0",
    evidence: "derived",
    principle: "Take four seconds to lower, stretching your hamstrings and glutes. It is a classic way to build muscle along the back of your body.",
    note: "Soft knees, neutral spine; feel hamstring stretch, hinge from hips.",
    sources: [
      "schoenfeld2015",
      "wilk2021"
    ]
  },
  "Seal Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Lying flat on the bench takes your lower back out of it completely, so the tempo builds a thicker upper back with strict form.",
    note: "Chest glued to bench; full stretch at bottom, squeeze at top.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Seated Cable Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "With a pause at the stretch, the seated cable row keeps tension on your mid-back and lats while you control the shoulder blades.",
    note: "Slight lean back; pull to lower chest or abdomen, squeeze shoulder blades.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Seated Calf Raise": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Sitting puts the emphasis on the soleus, the deeper calf muscle. A pause at the bottom gives a full stretch before each squeeze.",
    note: "Full dorsiflexion at bottom; controlled plantarflexion, pause at top if desired.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Seated Lateral Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Sitting down takes your legs out of it, and the tempo keeps steady tension on the delts.",
    note: "Lead with elbows; slight lean if needed.",
    sources: [
      "wilk2021"
    ]
  },
  "Seated Leg Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Your hamstrings stay under constant tension at a steady tempo, with a full stretch and a strong squeeze.",
    note: "Full extension at bottom; squeeze at top, avoid momentum.",
    sources: [
      "wilk2021"
    ]
  },
  "Side Plank": {
    tempo: null,
    evidence: "none",
    principle: "A hold that stops you bending sideways. Work to time and bracing, not a rep tempo.",
    note: "Hold 20–45 s per side; body straight, hips lifted, brace obliques and glutes. Progress by lifting top leg or adding movement.",
    sources: [
      "isometric"
    ]
  },
  "Side-Lying Adduction": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Lying on your side, lower slowly to stretch the inner thigh and lift with control to squeeze it.",
    note: "Bottom leg works; top leg can be bent for support or straight for added challenge.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Single-Arm Cable Fly": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Fly one arm at a time. The slow tempo gives a full stretch and constant tension on the working side of your chest.",
    note: "Slight elbow bend; arc across body, squeeze at midline.",
    sources: [
      "wilk2021"
    ]
  },
  "Single-Arm Cable Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Rowing one arm at a time builds lats and mid-back while your core works to stop you twisting.",
    note: "Hinge or tall posture; pull to hip, squeeze shoulder blade.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Single-Arm DB Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "A classic one-arm row. Pausing at the stretch builds a thicker upper back and teaches you to resist twisting.",
    note: "Hinge at hips; pull elbow to hip, squeeze at top.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Single-Arm High Cable Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "On this one-arm row from a high pulley, a pause and a slow return keep your upper back and rear delts under tension, like the other rows.",
    note: "Cable set above the head; pull the handle toward the upper chest, elbow out and back, and let the shoulder blade reach forward on the return.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Single-Arm Landmine Press": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Pressing one side at a time along the arc builds shoulder and core stability.",
    note: "Split stance or square; drive through heel of hand.",
    sources: [
      "wilk2021"
    ]
  },
  "Single-Leg Calf Raise": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "One leg at a time evens out side-to-side differences, and the tempo keeps both calf muscles working.",
    note: "Full dorsiflexion at bottom; controlled plantarflexion, pause at top if desired.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Single-Leg Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Curling one leg at a time evens out imbalances, and the tempo gives each hamstring a full stretch and squeeze.",
    note: "Full extension at bottom; squeeze at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Single-Leg Hip Thrust": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "One leg at a time with a pause at the top works the glutes hard and helps even out imbalances.",
    note: "Drive through heel of working leg; keep hips level.",
    sources: [
      "wilk2021"
    ]
  },
  "Single-Leg RDL": {
    tempo: "4-0-1-0",
    evidence: "derived",
    principle: "Four seconds down on one leg builds hamstring and glute strength, improves balance and evens out imbalances.",
    note: "Hinge from hips, neutral spine; feel stretch in working hamstring.",
    sources: [
      "schoenfeld2015",
      "wilk2021"
    ]
  },
  "Sissy Squat": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "The knees travel forward over the toes on purpose. The tempo gives your quads a deep stretch and a strong squeeze.",
    note: "Lean back slightly; knees track forward over toes, heels may lift.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Skullcrusher": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Lowering slowly while lying down stretches and loads the long head of the triceps.",
    note: "Elbows point up and stay close to your head. Fully extend without locking out harshly.",
    sources: [
      "wilk2021"
    ]
  },
  "Slider Leg Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "On sliders or a Swiss ball, the tempo builds hamstring strength and control along the back of your body using bodyweight.",
    note: "Hips up, slide feet out and back with control; avoid lumbar sag.",
    sources: [
      "wilk2021"
    ]
  },
  "Split Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "With your feet staying put, the tempo works your quads and glutes harder and builds single-leg stability.",
    note: "Back knee gently kisses floor; front knee tracks over ankle.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Standing Cable Hip Extension": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Drive the leg back and hold at the top. The pause squeezes your glute and builds strength in pushing the hip back.",
    note: "Slight hinge; drive heel back, squeeze glute at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Standing Calf Raise": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Standing targets the big calf muscle. A pause at the bottom stretches it fully before you push up.",
    note: "Full dorsiflexion at bottom; controlled plantarflexion, pause at top if desired.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Step-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Stepping up at a steady pace builds quad and glute drive and stability on one leg.",
    note: "Drive through whole foot of working leg; avoid pushing off back leg.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Stir the Pot": {
    tempo: "2-0-2-0",
    evidence: "derived",
    principle: "Slow circles on a Swiss ball make your core resist arching and twisting, and they build shoulder control too.",
    note: "Plank on ball; small controlled circles, brace hard, minimal hip movement.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Sumo Deadlift": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "The wide stance brings in your inner thighs and glutes. Lower under control to load the back of your body.",
    note: "Toes out 30–45°; hips lower than conventional; neutral spine.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Svend Press": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Squeeze the plates together as you press and hold at the top. That keeps constant tension on your inner chest and triceps.",
    note: "Squeeze plates hard together throughout; press in arc.",
    sources: [
      "wilk2021"
    ]
  },
  "Swiss Ball Leg Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Curling the ball in and out at a steady pace builds the back of your body and core stability with bodyweight.",
    note: "Hips up; slide ball in and out with control, avoid lumbar sag.",
    sources: [
      "wilk2021"
    ]
  },
  "TRX Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Change your body angle to set the difficulty. The tempo builds your upper back and core stability using bodyweight.",
    note: "Lean back to increase difficulty; pull chest to handles, squeeze shoulder blades.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Toes-to-Bar": {
    tempo: "2-0-2-0",
    evidence: "derived",
    principle: "Done at a set tempo, this hanging move builds lower abs and hip flexors, plus grip.",
    note: "Controlled swing or strict; touch bar with toes, lower with control.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Tricep Dips": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Lowering slowly protects your shoulders and keeps the triceps and chest working longer.",
    note: "Elbows track back; only go as deep as shoulder comfort allows.",
    sources: [
      "wilk2021"
    ]
  },
  "Weighted Dips": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Lean forward and lower under control with added load. It builds pressing strength and stands in for the bench press.",
    note: "Lean the torso forward for chest emphasis. Add load with a belt or vest, and go only as deep as your shoulders allow.",
    sources: [
      "wilk2021"
    ]
  },
  "Tricep Pushdown": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "On the cable, let the bar rise slowly to keep the long head of the triceps under tension.",
    note: "Elbows pinned to sides; full extension at bottom without locking harshly.",
    sources: [
      "wilk2021"
    ]
  },
  "V-Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "The machine's V-shaped path fixes the movement, so the tempo lets you focus on your quads.",
    note: "Feet position per machine; full controlled depth if knee health allows.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Wall Sit": {
    tempo: null,
    evidence: "none",
    principle: "A static hold for quads and glutes. No rep tempo here, so time the set.",
    note: "Hold 20–60 s; back flat against wall, thighs parallel to floor or as prescribed, brace core. Breathe steadily.",
    sources: [
      "isometric"
    ]
  },
  "Weighted Pull-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Added load builds lat and upper-back strength, and the tempo makes sure your shoulder blades stay under control.",
    note: "Add weight via belt or vest; full extension at bottom if mobility allows.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Wide-Grip Cable Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Rowing with a wide grip shifts the work to your upper back and rear delts, and the cable keeps tension on all the way.",
    note: "Wide overhand grip; pull to lower chest, squeeze shoulder blades.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Wide-Grip Pull-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Hands wide and a controlled tempo build wider lats and a stronger upper back.",
    note: "Wide overhand grip; full extension at bottom if mobility allows; pull chest to bar.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Windshield Wiper": {
    tempo: "2-1-2-1",
    evidence: "derived",
    principle: "Swinging the legs side to side under control builds the obliques and rotational control, while your core stops your back arching.",
    note: "Controlled side-to-side or strict; maintain hollow body position, avoid excessive swing.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Y-T-W Raise": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Moving through Y, T and W face down with pauses builds the lower traps, rear delts and shoulder-blade stability for posture and shoulder health.",
    note: "Thumbs up; lift into Y then T then W shapes, squeeze shoulder blades throughout.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Zottman Curl": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Curl up with palms up, then lower slowly with palms down. That works the biceps and the brachioradialis in the forearm together.",
    note: "Palms up on the way up, turn them down at the top, then lower slowly with palms down. Use the full range.",
    sources: [
      "wilk2021"
    ]
  }
,

  // ── Travel-mode movements (lib/travel.js) ─────────────────────────────────
  // All "derived": no study prescribes a tempo for a towel leg curl. Each is
  // reasoned from its movement class and the same two tempo reviews the rest
  // of the dataset leans on — which is exactly what the label claims, and why
  // it isn't "direct".
  "Deficit Push-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "The blocks let your chest sink lower, adding a deeper stretch and a longer way down. Lowering slowly builds muscle even at bodyweight.",
    note: "Hands on blocks so the chest passes below them; pause in the stretch, don't bounce.",
    sources: [
      "schoenfeld2015",
      "wilk2021"
    ]
  },
  "Inverted Row": {
    tempo: "2-1-1-1",
    evidence: "derived",
    principle: "Your bodyweight is a fixed load, so the hold at the top, with shoulder blades pulled back, is what makes the set work.",
    note: "Table edge or bar; squeeze shoulder blades at the top, body straight throughout.",
    sources: [
      "wilk2021"
    ]
  },
  "Sliding Leg Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Hold the bridge throughout. At bodyweight, the slow slide out is what does the work for your hamstrings.",
    note: "Heels on a towel, hips up the whole set; extend slowly, curl back under control.",
    sources: [
      "schoenfeld2015",
      "wilk2021"
    ]
  },
  "Bottle Lateral Raise": {
    tempo: "2-0-2-1",
    evidence: "derived",
    principle: "With light weights, tempo has to do the work that load cannot. The pause at the top keeps the delt working where leverage is hardest.",
    note: "Filled bottles; lead with the elbows, stop at shoulder height, no swing.",
    sources: [
      "wilk2021"
    ]
  },
  "Walking Lunge": {
    tempo: "2-0-1-0",
    evidence: "derived",
    principle: "Control each step down to protect your knee and keep tension on the working leg.",
    note: "Long stride, torso tall; drive through the front heel.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Backpack Curl": {
    tempo: "3-0-1-1",
    evidence: "derived",
    principle: "You can't fine-tune a backpack's weight, so a long lowering and a squeeze at the top make up for it.",
    note: "Load the pack with books; keep elbows pinned, squeeze at the top.",
    sources: [
      "wilk2021"
    ]
  },
  "Bodyweight Skullcrusher": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Once your body angle is set, lowering more slowly is the only way to make this harder.",
    note: "Hands on a table edge, body straight; lower the forehead to the edge, press back out.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Towel Face Pull": {
    tempo: "2-1-1-1",
    evidence: "derived",
    principle: "Rear-delt work is about holding the end position. The pause with shoulder blades fully pulled back matters more than the pull.",
    note: "Towel round a door anchor; pull to the forehead, elbows high, hold a beat.",
    sources: [
      "wilk2021"
    ]
  },
  "Sliding Fly": {
    tempo: "4-0-2-0",
    evidence: "derived",
    principle: "Opening slowly over four seconds also makes your core stop your back arching. It works like an ab-wheel rollout with the chest doing the work.",
    note: "Hands on towels, floor smooth; open only as far as you can close under control.",
    sources: [
      "schoenfeld2015",
      "wilk2021"
    ]
  },
  "Backpack Shrug": {
    tempo: "2-0-1-1",
    evidence: "derived",
    principle: "Shrug straight up and hold the top. Your traps get more from the hold than from the range.",
    note: "Loaded pack held at the sides; shrug straight up, squeeze, no rolling.",
    sources: [
      "wilk2021"
    ]
  },
  "Chair Dip": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "This puts your shoulders in a vulnerable position, so lower under control and stop where it feels comfortable.",
    note: "Hands on a chair edge; stop when the upper arm is parallel, no deeper.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Broad Jump": {
    tempo: "2-0-X-0",
    evidence: "derived",
    principle: "Jump with full, explosive intent. The counted seconds only apply to the loading dip before you take off.",
    note: "Low reps, full recovery between them. Land soft, reset every rep — this is not conditioning.",
    sources: [
      "wilk2021"
    ]
  },
  "Bar Hang": {
    tempo: null,
    evidence: "none",
    principle: "This is a hold, so time it and focus on your grip rather than a rep tempo.",
    note: "Dead hang from the bar, shoulders active not slack. Time the set.",
    sources: [
      "isometric"
    ]
  },
  "Mountain Climber": {
    tempo: "1-0-1-0",
    evidence: "derived",
    principle: "Hold a braced plank while your legs drive fast in turn, so keep the rhythm quick and even.",
    note: "Hips level, no piking; drive the knees, keep the shoulders stacked.",
    sources: [
      "wilk2021"
    ]
  },
  "Burpee": {
    tempo: "1-0-X-0",
    evidence: "derived",
    principle: "Finish every rep with an explosive jump, but control the drop to the floor enough to protect your shoulders.",
    note: "Chest to floor, then drive up and jump. Quality over speed once fatigue arrives.",
    sources: [
      "wilk2021"
    ]
  }
};

// Human-readable decode of a tempo string for UI surfaces.
// '3-1-1-0' → [{n:'3', label:'down'}, {n:'1', label:'pause'}, ...]
export function decodeTempo(tempo) {
  if (!tempo) return null;
  const [e, p1, c, p2] = tempo.split('-');
  const seg = (n, label) => ({ n, label });
  return [
    seg(e, e === 'X' ? 'drop fast' : 'down'),
    seg(p1, 'pause'),
    seg(c, c === 'X' ? 'explode' : 'up'),
    seg(p2, 'squeeze'),
  ];
}

export function getTempo(exerciseName) {
  return EXERCISE_TEMPO[exerciseName] || null;
}
