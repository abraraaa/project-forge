// No route hands an exception message to the client. An error can name a store,
// a path or a dependency, and on the auth routes that is a map for whoever is
// probing.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const routes = [];
const walk = (d) => {
  for (const f of readdirSync(resolve(root, d), { withFileTypes: true })) {
    const rel = join(d, f.name);
    if (f.isDirectory()) walk(rel);
    else if (f.name === "route.js") routes.push(rel.replace(/\\/g, "/"));
  }
};
walk("app/api");
const src = (r) => readFileSync(resolve(root, r), "utf8");

describe("no route leaks an exception to the client", () => {
  it("finds routes to check", () => {
    expect(routes.length).toBeGreaterThan(5);
  });

  it("never puts e.message in a response body", () => {
    const offenders = routes.filter((r) => /error:\s*e(?:rr)?\.message/.test(src(r)));
    expect(offenders, `leaks exception text: ${offenders.join(", ")}`).toEqual([]);
  });

  it("never returns a raw error object either", () => {
    const offenders = routes.filter((r) => /NextResponse\.json\(\{\s*error:\s*e\b/.test(src(r)));
    expect(offenders, `returns the error itself: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the shared helper logs server-side and says nothing useful to the client", () => {
    const helper = readFileSync(resolve(root, "lib/api-errors.js"), "utf8");
    expect(helper).toContain("console.error");
    expect(helper).toContain('error: "Something went wrong. Try again."');
    expect(helper).not.toMatch(/error:\s*[a-z]*\.message/);
  });
});
