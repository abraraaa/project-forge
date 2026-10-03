// tests/trainer-surfaces.test.js
// The trainer surfaces: wired pages, the wide shell, and what the trainer
// and share components may never touch (device storage, raw HTML).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const walk = (dir) => readdirSync(resolve(ROOT, dir)).flatMap((n) => {
  const p = join(dir, n);
  return statSync(resolve(ROOT, p)).isDirectory() ? walk(p) : [p];
});

const PAGES = ["app/trainer/page.jsx", "app/share/page.jsx", "app/profile/trainer/page.jsx"];
const SURFACES = ["components/TrainerView.jsx", "components/TrainerClientView.jsx", "components/TrainerShareView.jsx",
  "components/ShareApprove.jsx", "components/ShareView.jsx", "components/LiftCharts.jsx", "components/AnalyticsScrubbed.jsx"];
const NAME_ONLY = new Set(["components/ShareView.jsx", "components/TrainerShareView.jsx"]);

describe("the three pages are thin, unindexed shells", () => {
  it.each(PAGES)("%s", (p) => {
    const src = read(p);
    expect(src).toMatch(/robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
    expect(src).toMatch(/from "@\/components\/client-shells"/);
    expect(src).not.toMatch(/lib\/(db|trainer-store|identity-store|oauth-store)/);
  });
  it("each has its own ssr:false shell and an X-Robots-Tag header", () => {
    const shells = read("components/client-shells.jsx");
    for (const name of ["TrainerShell", "TrainerShareShell", "ShareShell"]) {
      expect(shells).toMatch(new RegExp(`export const ${name} = dynamic\\(\\(\\) => import\\("@/components/[A-Za-z]+"\\), \\{\\n  ssr: false,`));
    }
    const cfg = read("next.config.mjs");
    expect(cfg).toContain('source: "/(trainer|share)",');
    expect(cfg).toContain('source: "/profile/trainer",');
  });
});

describe("the wide shell", () => {
  const css = read("app/globals.css");
  it(".forge-wide owns the breakpoints and the side insets, never height or the top inset", () => {
    const rule = css.match(/\n\.forge-wide \{([^}]*)\}/);
    expect(rule, ".forge-wide rule").toBeTruthy();
    expect(rule[1]).toMatch(/safe-area-inset-(left|right)/);
    expect(rule[1]).not.toMatch(/height|safe-area-inset-top/);
    expect(css).toMatch(/@media \(min-width: 640px\)[\s\S]*\.forge-wide \{/);
    expect(css).toMatch(/@media \(min-width: 1024px\)[\s\S]*\.forge-wide \{/);
  });
  it("TrainerView mounts on the shell class with nothing sticky or fixed", () => {
    const src = read("components/TrainerView.jsx");
    expect(src).toMatch(/className: "forge-wide",/);
    expect(src).not.toMatch(/position:\s*["']?(sticky|fixed)/);
  });
});

describe("trainer and share components know nothing of the device", () => {
  it.each(SURFACES)("%s", (p) => {
    const src = read(p);
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|caches\.|dangerouslySetInnerHTML/);
    if (NAME_ONLY.has(p)) {
      // The signed-in name only: P.getActive(), nothing else from the store.
      const uses = src.match(/\bP\.[a-zA-Z]+\(/g) || [];
      expect(uses.every((u) => u === "P.getActive(")).toBe(true);
    } else {
      expect(src).not.toMatch(/@\/lib\/storage|getActive\(/);
    }
  });
});

describe("every trainer and share route runs in London and never caches", () => {
  const routes = [...walk("app/api/trainer"), ...walk("app/api/share"), ...walk("app/api/sync/trainer")].filter((p) => p.endsWith("route.js"));
  it("finds the routes", () => { expect(routes.length).toBeGreaterThanOrEqual(8); });
  it.each(routes)("%s", (p) => {
    const src = read(p);
    expect(src).toContain('preferredRegion = "lhr1"');
    // no-store rides the json/noStore helpers of lib/trainer-session.js
    expect(src).toMatch(/\b(noStore|json)\(/);
    expect(src).not.toMatch(/e\.message/);
  });
});
