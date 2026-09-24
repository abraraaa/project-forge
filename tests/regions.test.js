// Every route handler (API, OAuth, .well-known) runs in London, beside Neon and Blob. The project also
// serves from other regions; a DB-bound function there would pay a
// cross-ocean round trip per query instead of one per request.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../app", import.meta.url).pathname;
const routes = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name === "route.js") routes.push(p);
  }
})(root);

describe("server routes are pinned beside the data", () => {
  it.each(routes.map((p) => [p.slice(root.length)]))("%s runs in lhr1", (rel) => {
    const src = readFileSync(join(root, rel), "utf8");
    if (/export const dynamic = "force-static";/.test(src)) return; // built once, served from the CDN
    expect(src).toMatch(/export const preferredRegion = "lhr1";/);
  });
});
