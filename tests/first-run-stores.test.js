// tests/first-run-stores.test.js
// Source pins for the first run: the step UI never touches storage itself
// (every write goes through a ForgeApp save prop, which uses the same cores
// as Profile), it deletes nothing, and there is one path to the steps.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(resolve(root, rel), "utf8");
// Comments may name what the code must not do.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const STEP_FILES = [
  "components/FirstRun.jsx",
  ...readdirSync(resolve(root, "components/first-run"))
    .filter((f) => f.endsWith(".jsx"))
    .map((f) => `components/first-run/${f}`),
];

// The persistence primitives the mutation-coverage audit scans for
// (tests/forge-app-mutation-coverage.test.js), plus the delete paths.
const STORE_CALLS = [
  /\bLS\./, /\blocalStorage\b/, /\bremoveItem\b/, /\bW\.reset\s*\(/,
  /\bW\.save(?:Edit)?\s*\(/, /\bPB\.(?:save|reset)\s*\(/, /\bF\.save\s*\(/, /\bBW\.set\s*\(/,
  /\bP\.(?:setMainLift|setAddedLoad|saveWeights|saveReps)\s*\(/, /\bTS\.\w+\s*\(/,
  /\bDays\.set\s*\(/, /\bH\.append\s*\(/, /\bbumpStreak\s*\(/, /\bpushNow\s*\(/,
];

describe("first-run UI never touches storage", () => {
  it("covers FirstRun and the three steps", () => {
    expect(STEP_FILES).toEqual(expect.arrayContaining([
      "components/FirstRun.jsx",
      "components/first-run/FocusStep.jsx",
      "components/first-run/MainLiftsStep.jsx",
      "components/first-run/DaysStep.jsx",
    ]));
  });

  it.each(STEP_FILES)("%s: no store call, no delete", (rel) => {
    const src = code(read(rel));
    for (const re of STORE_CALLS) expect(src, `${rel} matches ${re}`).not.toMatch(re);
    expect(src).not.toMatch(/from "@\/lib\/(?:storage|profile-actions)"/);
  });
});

describe("ForgeApp hands FirstRun the existing save paths", () => {
  const src = read("components/ForgeApp.jsx");
  const body = (name) => {
    const start = src.indexOf(`const ${name} = `);
    expect(start, name).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("\n  };", start));
  };

  it("wires each save prop to a core-backed handler", () => {
    expect(src).toContain("onSaveFocus={handleFirstRunFocus}");
    expect(src).toContain("onSaveMainLift={handleFirstRunMainLift}");
    expect(src).toContain("onSaveWeek={handleSaveWeek}");
    expect(src).toContain("onSaveBodyweight={updateBodyweight}");
    expect(body("handleFirstRunFocus")).toContain("saveFocusCore(activeProfile, focus)");
    expect(body("handleFirstRunMainLift")).toContain("saveMainLiftCore(activeProfile, canonical, choice)");
  });

  it("drops the rotation summary during the first run", () => {
    expect(body("handleFirstRunFocus")).not.toContain("setRotationSummary");
    expect(body("handleFirstRunMainLift")).not.toContain("setRotationSummary");
    expect(body("handleFirstRunMainLift")).not.toContain("stashRotationSummary");
  });

  it("opens only on a claim that is the device's first profile, in memory only", () => {
    const act = body("activateProfile");
    expect(act).toMatch(/const fresh = !!opts\.claim && existing\.length === 0;/);
    expect(act).toContain('setScreenRaw("first-run")');
    expect(code(act)).not.toMatch(/\bLS\.set\s*\(/);
  });

  it("finishes home with a forward transition, not a back one", () => {
    expect(src).toMatch(/const finishFirstRun = useCallback\(\(\) => \{\s*setFirstRun\(null\);\s*withNavTransition\(\(\) => setScreenRaw\("home"\), null\);/);
  });
});

describe("one path to the post-claim steps", () => {
  it("ProfileScreen no longer holds the passkey or bodyweight step", () => {
    const src = read("components/ProfileScreen.jsx");
    for (const gone of ["showPasskeyStep", "showBwStep", "claimedName", "pendingBw", "<BodyweightDrum"]) {
      expect(src).not.toContain(gone);
    }
  });
});

describe("the week editor says what the continuing cycle does", () => {
  it("no claim that B/C go unreached or that a 4th day restarts at A", () => {
    const src = read("components/ForgeApp.jsx");
    expect(src).not.toContain("won't be reached");
    expect(src).not.toContain("4th = A again");
    expect(src).toContain("dayNote(strengthCount)");
  });
});
