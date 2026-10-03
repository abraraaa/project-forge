// tests/lift-charts.test.js
// The Lab's two chart marks live in components/LiftCharts.jsx so another
// read-only view can draw them; the Lab imports them and defines neither.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as LiftCharts from "@/components/LiftCharts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

describe("LiftCharts", () => {
  it("exports LineChart and InkSpark, and nothing else", () => {
    expect(Object.keys(LiftCharts).sort()).toEqual(["InkSpark", "LineChart"]);
    expect(typeof LiftCharts.LineChart).toBe("function");
    expect(typeof LiftCharts.InkSpark).toBe("function");
  });

  it("knows nothing about the viewer: imports React and tokens only", () => {
    const imports = [...read("components/LiftCharts.jsx").matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["react", "@/lib/tokens"]);
  });

  it("the Lab imports both and defines neither", () => {
    const lab = read("components/PerformanceLab.jsx");
    expect(lab).toMatch(/^import \{ InkSpark, LineChart \} from "@\/components\/LiftCharts";$/m);
    expect(lab).not.toMatch(/function\s+(?:InkSpark|LineChart)\b/);
    expect(lab).not.toMatch(/(?:const|let|var)\s+(?:InkSpark|LineChart)\b/);
  });
});
