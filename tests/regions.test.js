// Every API function runs in London, beside Neon and Blob. The project also
// serves from other regions; a DB-bound function there would pay a
// cross-ocean round trip per query instead of one per request.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../app/api", import.meta.url).pathname;
const routes = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name === "route.js") routes.push(p);
  }
})(root);

describe("API routes are pinned beside the data", () => {
  it.each(routes.map((p) => [p.slice(root.length)]))("%s runs in lhr1", (rel) => {
    expect(readFileSync(join(root, rel), "utf8")).toMatch(/export const preferredRegion = "lhr1";/);
  });
});
