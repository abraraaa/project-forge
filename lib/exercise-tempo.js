// @ts-check
// lib/exercise-tempo.js
// ─────────────────────────────────────────────────────────────────────────────
// Evidence-based lifting tempo per exercise, in standard 4-digit notation
// E-P1-C-P2: eccentric seconds – stretch-position pause – concentric seconds –
// contracted-position pause. X = explosive intent (power work is prescribed
// by speed, not seconds). null = isometric hold (guidance lives in note).
//
// PROVENANCE: compiled 2026-07-06 by an external research model from
// docs/research/tempo-sourcing-prompt.md, then reviewed before ingestion.
// Every entry is honestly labelled: evidence 'derived' means the tempo comes
// from a movement-class principle in the cited literature (which is the case
// for nearly all exercises — per-exercise tempo studies barely exist);
// 'none' means an isometric where rep tempo doesn't apply. No entry claims
// more precision than the research carries.
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
    principle: "Controlled eccentric with brief top squeeze for glute/ham focus; slower lowering increases TUT per Schoenfeld 2015 principles applied to hip-extension pattern.",
    note: "Squeeze glutes hard at top; keep neutral spine.",
    sources: [
      "schoenfeld2015",
      "wilk2021"
    ]
  },
  "Ab Wheel": {
    tempo: "4-0-2-0",
    evidence: "derived",
    principle: "Extended eccentric rollout maximises anti-extension demand and core lengthened-position tension; controlled return prevents lumbar compensation.",
    note: "Scale with band assistance or knee variation if full ROM lost.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Adductor Stretch Lunge": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Slow eccentric into stretch position with pause builds adductor control and mobility under load.",
    note: "Keep front knee tracking over ankle; breathe into the stretch.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Arnold Press": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Controlled eccentric + deliberate concentric rotation emphasises medial deltoid and rotator cuff stability; slower tempo reduces momentum common in pressing variations.",
    note: "Full rotation at top; avoid flaring elbows excessively.",
    sources: [
      "wilk2021"
    ]
  },
  "Assisted Pull-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "3 s eccentric + brief bottom pause builds vertical pulling strength and scapular control; tempo allows progressive overload toward unassisted reps.",
    note: "Use minimal assistance needed for full ROM.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "B-Stance Hip Thrust": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Slower eccentric + top pause maximises glute contraction and lengthened-position tension; single-leg bias increases stability demand.",
    note: "Drive through heel of working leg; keep ribs down.",
    sources: [
      "wilk2021"
    ]
  },
  "Band Face Pull": {
    tempo: "2-1-2-1",
    evidence: "derived",
    principle: "Controlled tempo with rear-delt emphasis and external rotation pause improves posture and shoulder health; lighter load allows strict form.",
    note: "Lead with elbows; think 'separate the band at the face'.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Band Lateral Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Slow eccentric minimises momentum (common cheat in raises); controlled concentric maintains constant tension on medial delts.",
    note: "Slight lean away from anchor; pinky slightly higher than thumb at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Band Pull-Apart": {
    tempo: "2-1-2-1",
    evidence: "derived",
    principle: "Short pauses and controlled tempo reinforce scapular retraction and external rotation without heavy load.",
    note: "Keep slight elbow bend; focus on rear delts and rhomboids.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Banded Glute Bridge": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Top pause + controlled eccentric maximises glute squeeze and time in shortened position; band adds accommodating resistance.",
    note: "Drive knees out against band; full hip extension at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Banded Hip Thrust": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Same glute-emphasis logic as barbell version; band allows constant tension and top squeeze without heavy axial loading.",
    note: "Chin tucked, ribs down; drive through heels.",
    sources: [
      "wilk2021"
    ]
  },
  "Barbell Back Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "3 s eccentric + 1 s pause builds stability, removes stretch reflex, and increases time in lengthened position — classic hypertrophy-leaning compound prescription supported by Schoenfeld 2015 range and Wilk 2021 ecc+conc combo.",
    note: "Pause at depth you can control with good form; brace hard.",
    sources: [
      "schoenfeld2015",
      "wilk2021"
    ]
  },
  "Barbell Bench Press": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Pause rep removes bounce, increases chest/shoulder demand in lengthened position; controlled tempo keeps load honest for hypertrophy.",
    note: "Bar to lower chest or nipple line; scapulae retracted throughout.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Barbell Front Rack Lunge": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Front-rack position increases core and quad demand; tempo keeps movement controlled and unilateral strength balanced.",
    note: "Knee tracks over ankle; upright torso.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Barbell Glute Bridge": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Top pause + controlled eccentric maximises glute maximus recruitment in shortened position.",
    note: "Chin tucked; avoid over-extending lumbar.",
    sources: [
      "wilk2021"
    ]
  },
  "Barbell Hip Thrust": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Classic glute movement; top pause and slower eccentric per Wilk 2021 ecc emphasis + practical coaching for peak contraction.",
    note: "Bar pad recommended; drive through heels, squeeze hard at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Barbell Overhead Press": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Explosive concentric intent with controlled eccentric maintains shoulder stability and power transfer; 3 s lowering keeps load honest.",
    note: "Bar path slightly arced; core braced, no excessive lean back.",
    sources: [
      "wilk2021"
    ]
  },
  "Barbell Reverse Lunge": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Same unilateral compound logic as forward lunge; pause adds stability demand.",
    note: "Step back far enough for good hip hinge; front knee tracks over ankle.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Barbell Step-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Controlled tempo emphasises quad and glute drive without momentum; unilateral strength and stability.",
    note: "Drive through whole foot; avoid pushing off back leg.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Barbell Walking Lunge": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Slightly faster concentric for locomotion specificity while keeping eccentric controlled; practical for higher-rep hypertrophy work.",
    note: "Keep torso upright; alternate legs smoothly.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Belt Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Same squat logic as barbell back squat; belt removes axial loading so tempo can stay strict without spinal fatigue limiting reps.",
    note: "Great for quad emphasis or when back is fatigued.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Bench Dips": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Controlled eccentric protects shoulders; slower tempo increases tricep and chest demand without excessive bodyweight leverage.",
    note: "Keep elbows close; only go as deep as shoulder comfort allows.",
    sources: [
      "wilk2021"
    ]
  },
  "Bird Dog": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Slow, braced movement with pauses builds anti-rotation and core stability; tempo forces deliberate control.",
    note: "Opposite arm/leg; maintain neutral spine and level hips.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Bulgarian Split Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Unilateral quad/glute dominant; pause and controlled tempo increases stability and lengthened-position work.",
    note: "Front foot far enough for good hip hinge; back knee kisses floor gently.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Cable Chest Fly": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Slow eccentric + controlled concentric maximises pec stretch and constant tension; cable keeps resistance curve favourable.",
    note: "Slight elbow bend; squeeze at midline.",
    sources: [
      "wilk2021"
    ]
  },
  "Cable Crossover": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Same fly logic with high-to-low or low-to-high angle variation for upper/lower pec emphasis.",
    note: "Cross hands slightly at bottom; controlled return.",
    sources: [
      "wilk2021"
    ]
  },
  "Cable Hip Abduction": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Slow tempo keeps glute med/min under constant tension; minimises momentum common in standing abduction.",
    note: "Stand tall, slight hinge if needed; lead with heel.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Cable Lateral Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Same strict raise logic as band version; cable provides consistent tension throughout arc.",
    note: "Lead with elbow; slight lean away from machine.",
    sources: [
      "wilk2021"
    ]
  },
  "Cable Pull-Through": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Hinge pattern with controlled eccentric; faster concentric for posterior chain power while keeping load on hams/glutes.",
    note: "Soft knees, neutral spine; snap hips through at top.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Cable Rear Delt Fly": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Pause at stretch + slow concentric emphasises rear delts and scapular retractors; tempo prevents swinging.",
    note: "Slight elbow bend; lead with elbows, not hands.",
    sources: [
      "wilk2021"
    ]
  },
  "Cable Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Controlled eccentric + pause at stretch builds mid-back and lat thickness; tempo keeps scapulae moving properly.",
    note: "Neutral or slight thoracic extension; squeeze shoulder blades.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Cable Straight-Arm Pulldown": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Lat isolation with constant tension; slow eccentric maximises stretch and mind-muscle connection.",
    note: "Slight lean, arms straight; think 'pull elbows to hips'.",
    sources: [
      "wilk2021"
    ]
  },
  "Captain's Chair Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Controlled tempo on hanging leg raise variation builds lower ab and hip flexor strength without momentum.",
    note: "Posterior pelvic tilt at top; avoid swinging.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Chest-Supported DB Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Supported position allows stricter tempo and heavier loading on lats/rhomboids; pause removes momentum.",
    note: "Chest glued to pad; full stretch at bottom.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Chin-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Same vertical pull logic as pull-up; pause at bottom increases difficulty and scapular control.",
    note: "Supinated grip; full extension at bottom if shoulder mobility allows.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Close-Grip Push-Up": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Tricep emphasis with controlled tempo; slower eccentric protects shoulders and increases time under tension.",
    note: "Hands under shoulders or slightly narrower; elbows track back.",
    sources: [
      "wilk2021"
    ]
  },
  "Concentration Curl": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Strict tempo + pause at stretch maximises biceps long-head stretch and peak contraction; eliminates cheating.",
    note: "Elbow pinned to inner thigh; full supination at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Copenhagen Plank": {
    tempo: null,
    evidence: "none",
    principle: "Isometric adductor and core stability hold — tempo notation not applicable.",
    note: "Hold 20–45 s per side; maintain straight body line, brace hard. Progress by lifting top leg or adding movement. See also eccentric adductor studies for injury-prevention context.",
    sources: [
      "isometric"
    ]
  },
  "Cossack Squat": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Deep lateral squat with controlled tempo builds adductor, glute, and ankle mobility under load.",
    note: "Keep chest up; one leg straightens while other bends deeply.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Curtsy Lunge": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Unilateral glute/quad emphasis with rotational stability demand; tempo keeps form strict.",
    note: "Back knee tracks behind front heel; upright torso.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "DB Chest Fly": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Same fly principles as cable; dumbbells allow greater stretch at bottom.",
    note: "Slight elbow bend; arc motion, not pressing.",
    sources: [
      "wilk2021"
    ]
  },
  "DB Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Strict tempo prevents swinging; slow eccentric maximises biceps tension throughout ROM.",
    note: "Supinate at top; control the negative.",
    sources: [
      "wilk2021"
    ]
  },
  "DB Floor Press": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Limited ROM + pause reduces shoulder stress while maintaining tricep/chest work; tempo keeps it honest.",
    note: "Elbows at 45°; pause with triceps on floor.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "DB Front Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Front-rack squat tempo same as barbell; upright torso emphasis on quads.",
    note: "Elbows high; knees track over toes.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "DB Lateral Lunge": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Lateral movement with controlled tempo builds adductor and glute med strength + mobility.",
    note: "Sit back into working hip; keep chest up.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "DB Lu Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Strict lateral raise variation with tempo control for medial delt isolation.",
    note: "Lead with elbows; slight external rotation at top.",
    sources: [
      "wilk2021"
    ]
  },
  "DB Reverse Lunge": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Unilateral lunge tempo same as barbell version; dumbbells allow natural arm swing or goblet hold.",
    note: "Step back far enough; front knee stable.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "DB Split Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Stationary lunge variation; tempo increases quad and glute demand plus balance.",
    note: "Back knee gently kisses floor; front foot stable.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "DB Step-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Same step-up logic; dumbbells increase load or allow unilateral emphasis.",
    note: "Drive through whole foot of working leg.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "DB Sumo Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Wide stance squat with tempo for adductor and glute emphasis; pause at bottom increases difficulty.",
    note: "Toes out 30–45°; knees track over toes.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "DB Walking Lunge": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Locomotion lunge with slightly faster concentric; still controlled for hypertrophy.",
    note: "Alternate legs smoothly; torso upright.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Dead Bug": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Slow, braced anti-extension movement with pauses builds deep core control and breathing coordination.",
    note: "Lower back stays glued to floor; exhale on effort.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Decline Push-Up": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Elevated feet increase upper chest and shoulder demand; controlled tempo keeps form strict.",
    note: "Hands slightly wider than shoulders; core tight.",
    sources: [
      "wilk2021"
    ]
  },
  "Deficit Reverse Lunge": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Deficit increases ROM and lengthened-position demand on glutes/quads; tempo keeps it controlled.",
    note: "Back foot on small platform; front knee stable.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Diamond Push-Up": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Close-grip tricep emphasis with tempo control; protects shoulders better than full ROM dips for some.",
    note: "Hands under sternum, diamond shape; elbows track back.",
    sources: [
      "wilk2021"
    ]
  },
  "Donkey Calf Raise": {
    tempo: "4-1-2-0",
    evidence: "derived",
    principle: "Extended eccentric + pause at bottom maximises soleus/gastroc stretch and time under tension; classic calf hypertrophy approach.",
    note: "Full dorsiflexion at bottom; controlled plantarflexion.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Dumbbell Bench Press": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Same bench logic as barbell; dumbbells allow greater ROM and independent arm control.",
    note: "Dumbbells to sides of chest; slight arc at top.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Dumbbell Bent-Over Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Hinge row with pause at stretch; tempo builds mid-back thickness and anti-rotation stability.",
    note: "Flat back, 45° torso; pull elbow to hip.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Dumbbell Deadlift": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Conventional deadlift pattern with dumbbells; controlled eccentric for posterior chain while allowing natural ROM.",
    note: "Hinge at hips; neutral spine throughout.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Dumbbell Hang Clean": {
    tempo: "1-0-X-0",
    evidence: "derived",
    principle: "Explosive concentric intent (triple extension) for power development; minimal pauses preserve elastic energy and specificity.",
    note: "Focus on speed and hip drive; catch in front rack or hang position as prescribed.",
    sources: [
      "wilk2021"
    ]
  },
  "Dumbbell Leg Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Hamstring isolation with slow eccentric; tempo maximises stretch and contraction without momentum.",
    note: "Full extension at bottom; squeeze at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Dumbbell Shoulder Press": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Same overhead press logic; dumbbells allow natural scapular movement and independent arm work.",
    note: "Neutral or pronated grip as preferred; core braced.",
    sources: [
      "wilk2021"
    ]
  },
  "EZ Bar Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Strict biceps curl tempo; EZ bar reduces wrist stress while allowing heavier loading than straight bar for some.",
    note: "Full supination or semi-supinated; control the negative.",
    sources: [
      "wilk2021"
    ]
  },
  "Face Pull": {
    tempo: "2-1-2-1",
    evidence: "derived",
    principle: "Rear delt and external rotator emphasis with pauses; tempo reinforces scapular health and posture.",
    note: "Lead with elbows; external rotation at face level.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Face-Away Cable Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Standing cable row variation with stretch emphasis; tempo builds lat and mid-back while challenging anti-rotation.",
    note: "Face away from stack; step forward for tension at start.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Floor Press": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Same floor press logic as DB version; barbell allows heavier loading and bilateral work.",
    note: "Pause with triceps on floor; elbows at ~45°.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Frog Pump": {
    tempo: "2-1-2-1",
    evidence: "derived",
    principle: "Glute isolation with short pauses; tempo maximises squeeze without heavy axial load.",
    note: "Feet together, knees out; small range, big squeeze.",
    sources: [
      "wilk2021"
    ]
  },
  "Glute Bridge": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Bodyweight glute bridge with tempo and top pause; foundation for hip thrust progression.",
    note: "Drive through heels; full hip extension at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Goblet Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Goblet position encourages upright torso and quad emphasis; tempo same as barbell squat for consistency.",
    note: "Elbows inside knees at bottom; brace hard.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Good Morning": {
    tempo: "4-0-1-0",
    evidence: "derived",
    principle: "Extended eccentric for hamstring and glute stretch; hinge pattern with controlled tempo reduces injury risk and increases stimulus.",
    note: "Soft knees, neutral spine; hinge from hips, not lumbar.",
    sources: [
      "schoenfeld2015",
      "wilk2021"
    ]
  },
  "Hack Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Machine squat with fixed path; tempo allows quad emphasis and controlled depth without balance demand.",
    note: "Feet high and narrow for quad bias; full ROM if knee health allows.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Half-Kneeling Cable Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Unilateral row with half-kneeling base increases anti-rotation and core demand; tempo keeps it strict.",
    note: "Tall half-kneeling posture; pull to hip.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Hammer Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Neutral grip biceps/brachialis emphasis; strict tempo prevents swinging and maximises tension.",
    note: "Elbows pinned; full ROM without shoulder involvement.",
    sources: [
      "wilk2021"
    ]
  },
  "Hang Power Clean": {
    tempo: "1-0-X-0",
    evidence: "derived",
    principle: "Explosive concentric from hang position; minimal pauses for power and rate of force development.",
    note: "Triple extension focus; catch in power position. Speed over seconds.",
    sources: [
      "wilk2021"
    ]
  },
  "Hanging Knee Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Controlled hanging leg raise variation; tempo builds lower ab and hip flexor strength without momentum.",
    note: "Posterior pelvic tilt; avoid swinging.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Hanging Leg Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Full leg raise with tempo; greater demand on lower abs and hip flexors than knee version.",
    note: "Legs straight if hamstring mobility allows; controlled return.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Hex Bar Deadlift": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Trap bar deadlift with controlled eccentric; more quad and less shear than conventional for many lifters.",
    note: "Neutral grip; hinge or slight squat pattern depending on height.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Hip Adduction": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Machine or cable adduction with tempo; slow eccentric maximises adductor stretch and contraction.",
    note: "Full ROM; avoid using body momentum.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Hollow Body Hold": {
    tempo: null,
    evidence: "none",
    principle: "Isometric anti-extension hold — tempo notation not applicable.",
    note: "Hold 20–45 s; ribs down, lower back pressed into floor, legs and arms extended or tucked as prescribed. Breathe steadily.",
    sources: [
      "isometric"
    ]
  },
  "Incline DB Curl": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Incline position increases long-head biceps stretch; tempo + pause maximises that stimulus.",
    note: "Arms hang straight at bottom; supinate at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Incline DB Press": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Incline bench press with pause; upper chest emphasis and controlled tempo.",
    note: "Bench at 30–45°; bar or dumbbells to upper chest.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Incline DB Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Supported incline row; tempo builds upper back with less lower back demand.",
    note: "Chest on bench; full stretch at bottom.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Incline Landmine Press": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Landmine arc + incline angle for upper chest/shoulder; controlled eccentric with explosive intent.",
    note: "Neutral grip; drive through heel of hand.",
    sources: [
      "wilk2021"
    ]
  },
  "Incline Push-Up": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Elevated hands reduce load while maintaining push-up pattern; tempo keeps form strict for beginners or volume work.",
    note: "Hands on bench or box; core tight, full ROM.",
    sources: [
      "wilk2021"
    ]
  },
  "Kettlebell Swing": {
    tempo: "X-0-X-0",
    evidence: "derived",
    principle: "Explosive hip drive (X) for posterior chain power and conditioning; intent over strict seconds.",
    note: "Hip snap, not arm pull; Russian or American style as prescribed. Speed and power primary.",
    sources: [
      "wilk2021"
    ]
  },
  "Kneeling Landmine Press": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Half-kneeling landmine press; tempo + unilateral base adds anti-rotation and core demand.",
    note: "Tall kneeling; drive through heel of hand, brace core.",
    sources: [
      "wilk2021"
    ]
  },
  "L-Sit Hold": {
    tempo: null,
    evidence: "none",
    principle: "Isometric core and hip flexor hold — tempo notation not applicable.",
    note: "Hold 10–30 s; legs straight and elevated, shoulders depressed, chest up. Progress by tucking then extending legs.",
    sources: [
      "isometric"
    ]
  },
  "Landmine Press": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Standing landmine press; arc path and tempo allow natural scapular movement and core engagement.",
    note: "Split stance or square; drive through heel of hand.",
    sources: [
      "wilk2021"
    ]
  },
  "Landmine Squeeze Press": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Landmine + squeeze at top for inner chest and tricep emphasis; tempo keeps constant tension.",
    note: "Hands together on bar; squeeze hard at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Lat Pulldown": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Vertical pull with pause at stretch; tempo builds lat width and mid-back strength while teaching scapular control.",
    note: "Lean back slightly; pull to upper chest or behind neck as mobility allows.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Lateral Band Walk": {
    tempo: "2-0-2-0",
    evidence: "derived",
    principle: "Mini-band glute medius activation with controlled tempo; builds hip stability for compound lifts.",
    note: "Athletic stance, knees soft; step out against band tension.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Lateral Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Strict tempo prevents momentum (biggest cheat in raises); slow eccentric maximises medial delt tension.",
    note: "Lead with elbows; slight lean if needed; pinky slightly higher than thumb.",
    sources: [
      "wilk2021"
    ]
  },
  "Leaning Lateral Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Leaning variation increases range and delt stretch; tempo keeps it strict.",
    note: "Hold support with non-working hand; lean away slightly.",
    sources: [
      "wilk2021"
    ]
  },
  "Leg Extension": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Quad isolation with slow eccentric; tempo maximises vastus medialis/lateralis tension and knee stability work.",
    note: "Full extension at top; control the negative, avoid locking harshly.",
    sources: [
      "wilk2021"
    ]
  },
  "Leg Press": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Machine compound with pause; tempo allows heavy quad/glute work with controlled depth and reduced spinal load.",
    note: "Feet high and narrow for quad bias or low/wide for glute; full ROM if knee health allows.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Low-to-High Cable Crossover": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Upper chest fly variation; slow tempo and constant cable tension.",
    note: "Low pulley; bring hands up and in, squeeze upper pecs.",
    sources: [
      "wilk2021"
    ]
  },
  "Low-to-High Cable Fly": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Same low-to-high fly logic; tempo maximises upper chest stretch and contraction.",
    note: "Slight elbow bend; arc upward and inward.",
    sources: [
      "wilk2021"
    ]
  },
  "Lying Leg Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Supine leg raise with tempo; builds lower ab and hip flexor strength with controlled return.",
    note: "Lower back stays down; exhale on raise.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Machine Hamstring Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Seated or lying hamstring curl with slow eccentric; tempo maximises stretch and peak contraction.",
    note: "Full extension at bottom; squeeze at top, avoid using momentum.",
    sources: [
      "wilk2021"
    ]
  },
  "Meadows Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Landmine single-arm row; tempo + stretch position builds upper back and lat thickness with anti-rotation demand.",
    note: "Hinge at hips; pull elbow high and back.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Neutral-Grip DB Press": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Neutral grip bench variation; tempo same as standard DB bench, often shoulder-friendlier.",
    note: "Palms facing; slight arc at top.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Neutral-Grip Pull-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Neutral grip vertical pull; tempo builds lats and biceps with often more shoulder-friendly position.",
    note: "Full extension at bottom if mobility allows; pull chest to bar.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Nordic Curl": {
    tempo: "5-0-X-0",
    evidence: "derived",
    principle: "Very slow eccentric (5 s) maximises hamstring loading and lengthened-position stimulus; Nordic curls have specific evidence for strength and injury-prevention adaptations.",
    note: "Use band or partner assistance as needed to complete full eccentric ROM. Concentric can be assisted or explosive return.",
    sources: [
      "schoenfeld2015",
      "wilk2021"
    ]
  },
  "Overhead Tricep Extension": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Long-head tricep stretch position with tempo; slow eccentric maximises tension in lengthened state.",
    note: "Elbows point up/stay close to head; full extension at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Pallof Press": {
    tempo: "2-1-2-1",
    evidence: "derived",
    principle: "Anti-rotation press with pauses; tempo builds core bracing and shoulder stability under offset load.",
    note: "Tall posture; press out and resist rotation, return with control.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Pec Deck": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Machine chest fly with pause at contraction; tempo maximises inner chest squeeze and constant tension.",
    note: "Slight elbow bend; squeeze hard at midline.",
    sources: [
      "wilk2021"
    ]
  },
  "Pendulum Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Machine squat with arc path; tempo allows deep quad work with reduced spinal loading.",
    note: "Feet position per machine; full controlled depth if knee health allows.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Pike Push-Up": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Shoulder press push-up variation; tempo builds overhead pressing strength with bodyweight.",
    note: "Hips high; head travels toward hands; scale with box or band if needed.",
    sources: [
      "wilk2021"
    ]
  },
  "Plank": {
    tempo: null,
    evidence: "none",
    principle: "Isometric anti-extension hold — tempo notation not applicable.",
    note: "Hold 20–60 s; body straight, ribs down, glutes and quads engaged, breathe steadily. Progress by adding movement or instability.",
    sources: [
      "isometric"
    ]
  },
  "Power Clean": {
    tempo: "1-0-X-0",
    evidence: "derived",
    principle: "Explosive concentric (triple extension) for power; minimal pauses preserve elastic energy and movement specificity. Hypertrophy secondary to power development.",
    note: "Speed and intent primary. Catch in power position. Focus on hip drive and bar path.",
    sources: [
      "wilk2021"
    ]
  },
  "Preacher Curl": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Preacher bench fixes elbows; tempo + stretch pause maximises biceps long-head work.",
    note: "Full extension at bottom without locking elbow joint harshly; supinate at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Prone Y Raise": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Prone Y for lower trap and rear delt; tempo with pause builds scapular stability and posture.",
    note: "Thumbs up; lift arms into Y shape, squeeze shoulder blades.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Pull-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Vertical pull with pause at bottom; tempo builds lat strength and scapular control for hypertrophy and strength.",
    note: "Full extension at bottom if shoulder mobility allows; pull chest to bar.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Push Press": {
    tempo: "1-0-X-0",
    evidence: "derived",
    principle: "Explosive concentric with dip-drive; power development primary, tempo notation reflects intent over strict seconds.",
    note: "Dip, drive, press. Speed and power focus; catch overhead stable.",
    sources: [
      "wilk2021"
    ]
  },
  "Push-Up": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Classic push-up with controlled tempo; builds chest, triceps, and core stability.",
    note: "Hands under shoulders or slightly wider; full ROM, core tight.",
    sources: [
      "wilk2021"
    ]
  },
  "Rear Delt Fly": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Dumbbell or machine rear delt fly with pause; tempo maximises rear delt and scapular retractor work.",
    note: "Slight elbow bend; lead with elbows, squeeze at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Resistance Band Crossover": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Band fly variation; tempo keeps constant tension and prevents momentum.",
    note: "Cross hands at midline; controlled return.",
    sources: [
      "wilk2021"
    ]
  },
  "Resistance Band Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Band biceps curl; tempo maximises tension throughout ROM, especially at top.",
    note: "Elbows pinned; supinate against band resistance.",
    sources: [
      "wilk2021"
    ]
  },
  "Resistance Band Face Pull": {
    tempo: "2-1-2-1",
    evidence: "derived",
    principle: "Band face pull with pauses; reinforces scapular health and rear delt work with accommodating resistance.",
    note: "Lead with elbows; external rotation at face.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Resistance Band Lateral": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Band lateral raise; tempo prevents momentum and keeps constant tension on medial delts.",
    note: "Lead with elbows; slight lean if anchored low.",
    sources: [
      "wilk2021"
    ]
  },
  "Resistance Band Pull-Down": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Band lat pulldown; tempo builds vertical pulling strength with constant tension.",
    note: "Lean back slightly; pull to upper chest.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Resistance Band Pull-Through": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Band hinge pattern; tempo builds posterior chain with accommodating resistance.",
    note: "Soft knees; snap hips through, squeeze glutes.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Resistance Band Pushdown": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Tricep pushdown with tempo; slow eccentric maximises long-head tension.",
    note: "Elbows pinned to sides; full extension at bottom.",
    sources: [
      "wilk2021"
    ]
  },
  "Resistance Band Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Band row; tempo builds mid-back and lats with constant tension and scapular control.",
    note: "Hinge slightly; pull elbows back, squeeze shoulder blades.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Reverse Crunch": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Controlled reverse crunch; tempo builds lower ab strength and posterior pelvic tilt control.",
    note: "Lift hips off floor with control; exhale on effort.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Reverse Hyperextension": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Glute and hamstring extension with top pause; tempo maximises contraction and lengthened work.",
    note: "Controlled swing or strict; squeeze at top, avoid lumbar over-extension.",
    sources: [
      "wilk2021"
    ]
  },
  "Reverse Lunge": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Unilateral lunge with tempo; builds quad, glute, and balance with less forward knee stress than forward lunge for some.",
    note: "Step back far enough; front knee stable over ankle.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Romanian Deadlift": {
    tempo: "4-0-1-0",
    evidence: "derived",
    principle: "Extended eccentric (4 s) emphasises hamstring and glute stretch in lengthened position; classic posterior-chain hypertrophy approach per Wilk 2021 ecc emphasis.",
    note: "Soft knees, neutral spine; feel hamstring stretch, hinge from hips.",
    sources: [
      "schoenfeld2015",
      "wilk2021"
    ]
  },
  "Seal Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Chest-supported row; tempo builds upper back thickness with zero lower back demand and strict form.",
    note: "Chest glued to bench; full stretch at bottom, squeeze at top.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Seated Cable Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Seated cable row with pause; tempo builds mid-back and lats with constant tension and scapular control.",
    note: "Slight lean back; pull to lower chest or abdomen, squeeze shoulder blades.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Seated Calf Raise": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Seated calf raise emphasises soleus; tempo with pause at bottom maximises stretch and contraction.",
    note: "Full dorsiflexion at bottom; controlled plantarflexion, pause at top if desired.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Seated Lateral Raise": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Seated strict lateral raise; tempo eliminates leg drive and keeps constant delt tension.",
    note: "Lead with elbows; slight lean if needed.",
    sources: [
      "wilk2021"
    ]
  },
  "Seated Leg Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Seated hamstring curl; tempo maximises stretch and peak contraction with constant tension.",
    note: "Full extension at bottom; squeeze at top, avoid momentum.",
    sources: [
      "wilk2021"
    ]
  },
  "Side Plank": {
    tempo: null,
    evidence: "none",
    principle: "Isometric anti-lateral flexion hold — tempo notation not applicable.",
    note: "Hold 20–45 s per side; body straight, hips lifted, brace obliques and glutes. Progress by lifting top leg or adding movement.",
    sources: [
      "isometric"
    ]
  },
  "Side-Lying Adduction": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Side-lying adductor work with tempo; slow eccentric maximises adductor stretch and contraction.",
    note: "Bottom leg works; top leg can be bent for support or straight for added challenge.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Single-Arm Cable Fly": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Unilateral cable fly; tempo maximises stretch and constant tension on working pec.",
    note: "Slight elbow bend; arc across body, squeeze at midline.",
    sources: [
      "wilk2021"
    ]
  },
  "Single-Arm Cable Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Unilateral cable row; tempo builds lat and mid-back with anti-rotation demand.",
    note: "Hinge or tall posture; pull to hip, squeeze shoulder blade.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Single-Arm DB Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Classic single-arm row; tempo + stretch pause builds upper back thickness and anti-rotation stability.",
    note: "Hinge at hips; pull elbow to hip, squeeze at top.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Single-Arm Landmine Press": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Unilateral landmine press; tempo + arc path builds shoulder and core stability.",
    note: "Split stance or square; drive through heel of hand.",
    sources: [
      "wilk2021"
    ]
  },
  "Single-Leg Calf Raise": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Unilateral calf raise; tempo maximises soleus/gastroc work and addresses imbalances.",
    note: "Full dorsiflexion at bottom; controlled plantarflexion, pause at top if desired.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Single-Leg Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Unilateral hamstring curl; tempo maximises stretch and contraction while addressing imbalances.",
    note: "Full extension at bottom; squeeze at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Single-Leg Hip Thrust": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Unilateral hip thrust; tempo + top pause maximises glute work and addresses imbalances.",
    note: "Drive through heel of working leg; keep hips level.",
    sources: [
      "wilk2021"
    ]
  },
  "Single-Leg RDL": {
    tempo: "4-0-1-0",
    evidence: "derived",
    principle: "Unilateral RDL with extended eccentric; builds hamstring/glute strength, balance, and addresses imbalances.",
    note: "Hinge from hips, neutral spine; feel stretch in working hamstring.",
    sources: [
      "schoenfeld2015",
      "wilk2021"
    ]
  },
  "Sissy Squat": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Quad isolation squat variation; tempo maximises quad stretch and contraction with knee travel over toes.",
    note: "Lean back slightly; knees track forward over toes, heels may lift.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Skullcrusher": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Tricep extension with tempo; slow eccentric maximises long-head stretch and tension.",
    note: "Elbows point up/stay close to head; full extension without locking harshly.",
    sources: [
      "wilk2021"
    ]
  },
  "Slider Leg Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Sliding leg curl (or Swiss ball); tempo builds hamstring strength and posterior chain control with bodyweight.",
    note: "Hips up, slide feet out and back with control; avoid lumbar sag.",
    sources: [
      "wilk2021"
    ]
  },
  "Split Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Stationary lunge; tempo increases quad/glute demand and unilateral stability.",
    note: "Back knee gently kisses floor; front knee tracks over ankle.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Standing Cable Hip Extension": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Standing cable hip extension; tempo + top pause maximises glute contraction and hip extension strength.",
    note: "Slight hinge; drive heel back, squeeze glute at top.",
    sources: [
      "wilk2021"
    ]
  },
  "Standing Calf Raise": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Standing calf raise; tempo with pause maximises gastrocnemius stretch and contraction.",
    note: "Full dorsiflexion at bottom; controlled plantarflexion, pause at top if desired.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Step-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Step-up with tempo; builds quad and glute drive plus unilateral stability.",
    note: "Drive through whole foot of working leg; avoid pushing off back leg.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Stir the Pot": {
    tempo: "2-0-2-0",
    evidence: "derived",
    principle: "Swiss ball anti-extension/rotation with tempo; builds deep core stability and shoulder control.",
    note: "Plank on ball; small controlled circles, brace hard, minimal hip movement.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Sumo Deadlift": {
    tempo: "3-0-1-0",
    evidence: "derived",
    principle: "Wide stance deadlift with tempo; increases adductor and glute demand, controlled eccentric for posterior chain.",
    note: "Toes out 30–45°; hips lower than conventional; neutral spine.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Svend Press": {
    tempo: "3-1-2-1",
    evidence: "derived",
    principle: "Plate squeeze press; tempo + top pause maximises inner chest and tricep constant tension.",
    note: "Squeeze plates hard together throughout; press in arc.",
    sources: [
      "wilk2021"
    ]
  },
  "Swiss Ball Leg Curl": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Swiss ball hamstring curl; tempo builds posterior chain and core stability with bodyweight.",
    note: "Hips up; slide ball in and out with control, avoid lumbar sag.",
    sources: [
      "wilk2021"
    ]
  },
  "TRX Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Suspension row; tempo builds upper back and core stability with bodyweight angle adjustment.",
    note: "Lean back to increase difficulty; pull chest to handles, squeeze shoulder blades.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Toes-to-Bar": {
    tempo: "2-0-2-0",
    evidence: "derived",
    principle: "Dynamic hanging core movement with tempo; builds lower ab and hip flexor strength plus grip.",
    note: "Controlled swing or strict; touch bar with toes, lower with control.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Tricep Dips": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Tricep and chest dip with tempo; controlled eccentric protects shoulders, increases time under tension.",
    note: "Elbows track back; only go as deep as shoulder comfort allows.",
    sources: [
      "wilk2021"
    ]
  },
  "Tricep Pushdown": {
    tempo: "3-0-2-0",
    evidence: "derived",
    principle: "Cable tricep pushdown with tempo; slow eccentric maximises long-head tension.",
    note: "Elbows pinned to sides; full extension at bottom without locking harshly.",
    sources: [
      "wilk2021"
    ]
  },
  "V-Squat": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Machine squat variation with V path; tempo allows quad emphasis with fixed movement pattern.",
    note: "Feet position per machine; full controlled depth if knee health allows.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Wall Sit": {
    tempo: null,
    evidence: "none",
    principle: "Isometric quad and glute hold — tempo notation not applicable.",
    note: "Hold 20–60 s; back flat against wall, thighs parallel to floor or as prescribed, brace core. Breathe steadily.",
    sources: [
      "isometric"
    ]
  },
  "Weighted Pull-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Weighted vertical pull; tempo builds lat and upper back strength with added load while maintaining scapular control.",
    note: "Add weight via belt or vest; full extension at bottom if mobility allows.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Wide-Grip Cable Row": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Wide grip cable row; tempo emphasises upper back and rear delts with constant tension.",
    note: "Wide overhand grip; pull to lower chest, squeeze shoulder blades.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Wide-Grip Pull-Up": {
    tempo: "3-1-1-0",
    evidence: "derived",
    principle: "Wide grip vertical pull; tempo builds lat width and upper back strength.",
    note: "Wide overhand grip; full extension at bottom if mobility allows; pull chest to bar.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Windshield Wiper": {
    tempo: "2-1-2-1",
    evidence: "derived",
    principle: "Hanging rotational core movement with tempo; builds obliques and rotational control with anti-extension demand.",
    note: "Controlled side-to-side or strict; maintain hollow body position, avoid excessive swing.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Y-T-W Raise": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Prone Y-T-W sequence; tempo with pauses builds lower trap, rear delt, and scapular stability for posture and shoulder health.",
    note: "Thumbs up; lift into Y then T then W shapes, squeeze shoulder blades throughout.",
    sources: [
      "schoenfeld2015"
    ]
  },
  "Zottman Curl": {
    tempo: "3-1-2-0",
    evidence: "derived",
    principle: "Zottman (supinated up, pronated down) with tempo; combines biceps and brachioradialis work with controlled eccentric in pronated position.",
    note: "Supinate on way up, pronate at top, controlled pronated eccentric; full ROM.",
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
