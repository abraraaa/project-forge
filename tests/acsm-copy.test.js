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
