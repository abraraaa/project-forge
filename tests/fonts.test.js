// tests/fonts.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Font fallback: the build uses Google Fonts (app/fonts/google.js) and, if
// that fetch fails, retries with the local copies (app/fonts/local.js). The
// two modules must stay interchangeable, and the layout must only see them
// through the switch next.config.mjs aliases.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isGoogleFontFetchFailure } from "../scripts/build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(resolve(root, f), "utf8");

// { name: options-source } for each `export const name = Loader({ ... });`
function declarations(src) {
  const out = {};
  for (const m of src.matchAll(/export const (\w+) = \w+\(\{([\s\S]*?)\}\);/g)) out[m[1]] = m[2];
  return out;
}
const field = (opts, key) => opts.match(new RegExp(`${key}:\\s*([^\\n]*?),?\\n`))?.[1];

const google = declarations(read("app/fonts/google.js"));
const local = declarations(read("app/fonts/local.js"));

describe("google.js and local.js are interchangeable", () => {
  it("export the same three fonts", () => {
    expect(Object.keys(google).sort()).toEqual(["bodoni", "familjen", "spline"]);
    expect(Object.keys(local).sort()).toEqual(Object.keys(google).sort());
  });

  it("with the same variable, display and preload", () => {
    for (const name of Object.keys(google)) {
      for (const key of ["variable", "display", "preload"]) {
        expect(field(local[name], key), `${name}.${key}`).toBe(field(google[name], key));
      }
    }
  });

  it("local weight ranges cover exactly the weights google.js asks for", () => {
    for (const name of Object.keys(google)) {
      const wanted = [...field(google[name], "weight").matchAll(/"(\d+)"/g)].map((m) => Number(m[1]));
      const [min, max] = JSON.parse(field(local[name], "weight")).split(" ").map(Number);
      expect([min, max], name).toEqual([Math.min(...wanted), Math.max(...wanted)]);
    }
  });

  it("each local font points at a committed woff2 over 10 KB", () => {
    const files = Object.values(local).map((opts) => JSON.parse(field(opts, "src")));
    expect(files.sort()).toEqual([
      "./bodoni-moda-latin.woff2",
      "./familjen-grotesk-latin.woff2",
      "./spline-sans-mono-latin.woff2",
    ]);
    for (const f of files) expect(statSync(resolve(root, "app/fonts", f)).size, f).toBeGreaterThan(10 * 1024);
  });
});

describe("the layout only sees fonts through the switch", () => {
  const layout = read("app/layout.jsx");

  it("imports from @/app/fonts/active and never from next/font", () => {
    expect(layout).toContain('from "@/app/fonts/active"');
    expect(layout).not.toMatch(/from "next\/font/);
  });

  it("no other module imports the font modules (the alias only matches the exact key)", () => {
    const files = ["app", "components", "lib"].flatMap((dir) =>
      readdirSync(resolve(root, dir), { recursive: true })
        .filter((f) => /\.(m?js|jsx|tsx?)$/.test(f))
        .map((f) => `${dir}/${f}`),
    );
    for (const f of files) {
      if (f === "app/fonts/active.js") continue;
      const specifiers = [...read(f).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      for (const s of specifiers.filter((s) => /fonts\/(active|google|local)/.test(s))) {
        expect(`${f}: ${s}`).toBe(`${f}: @/app/fonts/active`);
      }
    }
  });

  it("next.config.mjs aliases the switch on HEATWAYVE_FONT_SOURCE", () => {
    const cfg = read("next.config.mjs");
    expect(cfg).toContain('"@/app/fonts/active"');
    expect(cfg).toContain('process.env.HEATWAYVE_FONT_SOURCE === "local"');
    expect(cfg).toContain('"./app/fonts/local.js"');
    expect(cfg).toContain('"./app/fonts/google.js"');
  });
});

describe("build wrapper", () => {
  const pkg = JSON.parse(read("package.json"));

  it("npm run build runs the wrapper, and postbuild still follows it", () => {
    expect(pkg.scripts.build).toBe("node scripts/build.mjs");
    expect(pkg.scripts.postbuild).toBe("node scripts/generate-sw-precache.mjs");
  });

  it("recognises the real Turbopack font fetch failure", () => {
    const output = [
      "> Build error occurred",
      "Error: Turbopack build failed with 3 errors:",
      "[next]/internal/font/google/bodoni_moda_aff26625.module.css",
      "Error: next/font: error:",
      "Failed to fetch Bodoni Moda from Google Fonts.",
      "If you are offline or behind a proxy, self-host the font with next/font/local, or set HTTP_PROXY/HTTPS_PROXY so Next.js can reach fonts.googleapis.com.",
    ].join("\n");
    expect(isGoogleFontFetchFailure(output)).toBe(true);
  });

  it("recognises a failed font file download from fonts.gstatic.com", () => {
    const output = [
      "[next]/internal/font/google/1f28a1525bf4a5c5-s.woff2",
      "Warning: Error while requesting resource",
      "There was an issue establishing a connection while requesting https://fonts.gstatic.com/s/familjengrotesk/v11/kmKkZqk0YFg5X3B-Qc4Bx9mw.woff2",
      "Error: Module not found: Can't resolve '@vercel/turbopack-next/internal/font/google/font'",
    ].join("\n");
    expect(isGoogleFontFetchFailure(output)).toBe(true);
  });

  it("recognises Turbopack failing to resolve a font file it could not download (host cut short)", () => {
    const output = [
      "> Build error occurred",
      "Error: Turbopack build failed with 8 errors:",
      "[next]/internal/font/google/bodoni_moda_aff26625.module.css:7:8",
      "Error: Module not found: Can't resolve '@vercel/turbopack-next/internal/font/google/font'",
      "  src: url(@vercel/turbopack-next/internal/font/google/font?{%22url%22:%22https://fonts.gs...",
      "next/font/google queries have exactly one entry",
    ].join("\n");
    expect(isGoogleFontFetchFailure(output)).toBe(true);
  });

  it("does not retry an unrelated build error", () => {
    const syntax = [
      "> Build error occurred",
      "Error: Turbopack build failed with 1 error:",
      "./app/page.jsx:39:23",
      "Error: Expression expected",
    ].join("\n");
    expect(isGoogleFontFetchFailure(syntax)).toBe(false);
  });

  it("does not retry a font config error (that would ship local fonts silently)", () => {
    const config = [
      "Error: Turbopack build failed with 1 error:",
      "./app/fonts/google.js",
      "Error: Module not found: Can't resolve 'next/font/google/target.css'",
      "Unknown weight 100 for font Bodoni Moda.",
    ].join("\n");
    expect(isGoogleFontFetchFailure(config)).toBe(false);
  });
});
