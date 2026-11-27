// Copy that has to say what the evidence says (ACSM 2026 resistance-training
// position stand). Reads the shipped source so the words can't drift back.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.ACSM_ROOT || join(__dirname, "..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");

describe("MEV copy: less still counts", () => {
  const files = [
    "components/GlossarySheet.jsx",
    "app/volume-landmarks/page.jsx",
    "app/anatomy/[slug]/page.jsx",
    "lib/coach-context.js",
    "README.md",
  ];
  it.each(files)("%s never says below MEV grows nothing", (f) => {
    expect(src(f)).not.toMatch(/least that grows|stimulus to grow|maintaining at best|won't drive growth/);
  });
  it.each(["components/GlossarySheet.jsx", "app/volume-landmarks/page.jsx", "lib/coach-context.js"])(
    "%s says less still counts", (f) => {
      expect(src(f)).toMatch(/[Ll]ess still counts, it just builds more slowly/);
    });
});

describe("frequency copy: weekly sets are the growth dose", () => {
  it("the landmarks page no longer says stacked sets grow less", () => {
    const page = src("app/volume-landmarks/page.jsx");
    expect(page).not.toMatch(/not the same twelve/);
    expect(page).toMatch(/weekly sets/i);
  });
  it("the frequency source note no longer says split beats stacked", async () => {
    const { VOLUME_SOURCES } = await import(join(ROOT, "lib/volume-audit.js"));
    expect(VOLUME_SOURCES.schoenfeld2016freq.note).not.toMatch(/better split than stacked/);
  });
  it("ACSM 2026 is a volume source, with its DOI", async () => {
    const { VOLUME_SOURCES } = await import(join(ROOT, "lib/volume-audit.js"));
    expect(VOLUME_SOURCES.acsm2026.cite).toMatch(/Med Sci Sports Exerc\. 2026;58\(4\):851-872/);
    expect(VOLUME_SOURCES.acsm2026.url).toBe("https://doi.org/10.1249/MSS.0000000000003897");
  });
});

describe("tempo principles credit control, not time under tension", () => {
  // The digits are the prescription and stay exactly as they were.
  const TEMPOS = {
    "45-Degree Hip Extension": "3-1-2-0", "Barbell Back Squat": "3-1-1-0",
    "Close-Grip Push-Up": "3-0-2-0", "Donkey Calf Raise": "4-1-2-0",
    "Good Morning": "4-0-1-0", "Romanian Deadlift": "4-0-1-0",
    "Tricep Dips": "3-0-2-0", "Deficit Push-Up": "3-1-1-0",
  };
  it.each(Object.keys(TEMPOS))("%s", async (name) => {
    const { EXERCISE_TEMPO } = await import(join(ROOT, "lib/exercise-tempo.js"));
    const t = EXERCISE_TEMPO[name];
    expect(t.tempo).toBe(TEMPOS[name]);
    expect(t.principle).not.toMatch(/working longer|build(s)? muscle|grow|more to work against/i);
    expect(t.principle).toMatch(/control|bounce|full range|repeatable|same every time/i);
    expect(t.principle).not.toMatch(/[;—]/);
    expect(t.principle).toMatch(/^[A-Z].*\.$/);
  });

  // The audit's further twenty, and the Nordic's unsourced research claim.
  // No sentence that names the tempo, a pause or a slow lowering also claims
  // growth or strength for it: the gain belongs to the exercise.
  const MORE = {
    "Assisted Pull-Up": "3-1-1-0", "Cable Row": "3-1-2-0", "Face-Away Cable Row": "3-1-2-0",
    "Incline DB Row": "3-1-2-0", "Lat Pulldown": "3-1-2-0", "Meadows Row": "3-1-2-0",
    "Neutral-Grip Pull-Up": "3-1-1-0", "Nordic Curl": "5-0-X-0", "Pike Push-Up": "3-0-2-0",
    "Pull-Up": "3-1-1-0", "Resistance Band Pull-Through": "3-0-1-0", "Resistance Band Row": "3-1-2-0",
    "Reverse Crunch": "3-0-2-0", "Seal Row": "3-1-2-0", "Single-Arm DB Row": "3-1-2-0",
    "Single-Leg RDL": "4-0-1-0", "Slider Leg Curl": "3-0-2-0", "Split Squat": "3-1-1-0",
    "Standing Cable Hip Extension": "3-1-2-1", "TRX Row": "3-1-2-0", "Wide-Grip Pull-Up": "3-1-1-0",
  };
  const TEMPO_WORDS = /tempo|paus|slow|seconds|controlled pace|lowering/i;
  const GAIN_WORDS = /\bbuild|\bgrow|\bsize\b|strength|thicker|wider|harder|muscle/i;
  it.each(Object.keys({ ...TEMPOS, ...MORE }))("%s: the gain is the exercise's, the tempo is for control", async (name) => {
    const { EXERCISE_TEMPO } = await import(join(ROOT, "lib/exercise-tempo.js"));
    const t = EXERCISE_TEMPO[name];
    expect(t.tempo).toBe({ ...TEMPOS, ...MORE }[name]);
    for (const sentence of t.principle.split(/(?<=\.)\s+/)) {
      if (TEMPO_WORDS.test(sentence)) expect(sentence).not.toMatch(GAIN_WORDS);
    }
    expect(t.principle).not.toMatch(/for both size and strength|own research/i);
    expect(t.principle).not.toMatch(/[;—]/);
    expect(t.principle).toMatch(/^[A-Z].*\.$/);
  });
});

describe("rotation copy: variety for interest and coverage, not adaptation", () => {
  const files = [
    "README.md", "components/GlossarySheet.jsx", "components/HomeScreen.jsx",
    "components/ForgeApp.jsx", "components/PerformanceLab.jsx",
  ];
  it.each(files)("%s", (f) => {
    expect(src(f)).not.toMatch(/body has adapted|fresh stimulus|stimulus fresh|beats both on one/i);
  });
  it("the rotation offer and the block glossary say what rotation is for", () => {
    expect(src("components/HomeScreen.jsx")).toMatch(/New exercises for variety, same muscle targets\./);
    expect(src("components/GlossarySheet.jsx")).toMatch(/for variety and coverage/);
  });
});

describe("bodyweight progression copy matches the engine", () => {
  it("promises a rep climb to a ceiling, then a harder variation; never longer holds", async () => {
    const lib = src("lib/library.js");
    expect(lib).not.toMatch(/longer holds/);
    expect(lib).toMatch(/up to three above where you started/);
    expect(lib).toMatch(/pick a harder variation/);
  });
});

describe("the README's stall rules match the engine", () => {
  it("no add for RPE 9.5 after a failure session; power lifts never climb", () => {
    const r = src("README.md");
    expect(r).not.toMatch(/finishing the next at RPE 9\.5 or easier adds weight/);
    expect(r).toMatch(/Power lifts never climb/);
  });
});

describe("claims the position stand doesn't support are softened", () => {
  it("MRV: returns diminish, not stop; no slow injury; no junk volume", () => {
    expect(src("app/volume-landmarks/page.jsx")).not.toMatch(/adaptation does not follow|slow injury/);
    expect(src("app/volume-landmarks/page.jsx")).toMatch(/extra sets add little and cost recovery/);
    for (const f of ["README.md", "lib/volume-audit.js"]) expect(src(f), f).not.toMatch(/junk volume/);
  });
  it("weekly sets have the most say, not the deciding one; no unsourced fifty per cent", () => {
    const p = src("app/volume-landmarks/page.jsx");
    expect(p).not.toMatch(/number that decides whether it grows/);
    expect(p).not.toMatch(/fifty\s+per cent/);
  });
  it("the glossary: tonnage isn't a vanity metric; Epley's precision isn't overstated", () => {
    const g = src("components/GlossarySheet.jsx");
    expect(g).not.toMatch(/vanity metric/);
    expect(g).not.toMatch(/reliable in the 1/);
  });
  it("isolation adds direct sets; compounds aren't said to fall short", () => {
    expect(src("lib/library.js")).not.toMatch(/compounds alone don't cover it/);
    expect(src("app/library/[slug]/page.jsx")).not.toMatch(/not a replacement for direct work/);
  });
  it("landmarks and start multipliers are not called evidence-based", () => {
    expect(src("README.md")).not.toMatch(/evidence-based landmarks/);
    expect(src("lib/volume-audit.js")).not.toMatch(/evidence-based volume landmarks/);
    expect(src("lib/programme-resolve.js")).not.toMatch(/evidence-based intermediate-novice/);
  });
  it("deload cards promise no comeback", () => {
    expect(src("lib/progression.js")).not.toMatch(/come back stronger|stronger weeks ahead/);
  });
  it("a hold's page doesn't claim a direct measurement, and its placeholder source isn't structured data", () => {
    const p = src("app/library/[slug]/page.jsx");
    expect(p).toMatch(/Holds are set by time and bracing, not rep tempo\./);
    expect(p).toMatch(/\.filter\(\(src\) => src && src\.url\)/);
  });
});
