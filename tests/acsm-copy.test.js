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
