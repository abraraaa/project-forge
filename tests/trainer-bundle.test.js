// What the trainer pane and the session host can reach by static import. The
// pane ships to the browser, so the server modules (storage, the MCP server,
// the database) must stay out of its graph, and the validator, the shared
// programme resolver, storage and the MCP server must not import in a circle.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { repsForSession as engineReps } from "@/lib/session-engine";
import { repsForSession } from "@/lib/programme-resolve";

const ROOT = resolve(import.meta.dirname, "..");

// import X from "…", import { … } from "…", import * as X from "…",
// import "…", export { … } from "…", export * from "…". Dynamic import() is
// not a static edge.
const IMPORT = /^\s*import\s+(?:[\w$]+\s*,?\s*)?(?:\*\s*as\s+[\w$]+|\{[^}]*\})?\s*from\s*["']([^"']+)["']/gm;
const BARE = /^\s*import\s*["']([^"']+)["']/gm;
const REEXPORT = /^\s*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/gm;

/** A specifier as a repo-relative file, or null for a package. */
function resolveSpec(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(join(ROOT, fromFile)), spec);
  else return null;
  for (const p of [base, `${base}.js`, `${base}.jsx`, `${base}.mjs`, join(base, "index.js"), join(base, "index.jsx")]) {
    if (existsSync(p) && statSync(p).isFile()) return relative(ROOT, p);
  }
  throw new Error(`unresolved import ${spec} in ${fromFile}`);
}

/** @type {Map<string, string[]>} */
const edgesCache = new Map();
function edges(file) {
  if (edgesCache.has(file)) return /** @type {string[]} */ (edgesCache.get(file));
  const out = [];
  if (/\.(jsx?|mjs)$/.test(file)) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const re of [IMPORT, BARE, REEXPORT]) {
      for (const m of text.matchAll(re)) {
        const to = resolveSpec(m[1], file);
        if (to) out.push(to);
      }
    }
  }
  edgesCache.set(file, out);
  return out;
}

/** Every file reachable from `from`, each with the import chain that reaches it. */
function reach(from) {
  /** @type {Map<string, string[]>} */
  const seen = new Map([[from, [from]]]);
  const queue = [from];
  while (queue.length) {
    const f = /** @type {string} */ (queue.shift());
    for (const to of edges(f)) {
      if (seen.has(to)) continue;
      seen.set(to, [.../** @type {string[]} */ (seen.get(f)), to]);
      queue.push(to);
    }
  }
  return seen;
}

/** The chain to each forbidden file that `from` reaches. */
const leaks = (from, forbidden) => {
  const r = reach(from);
  return forbidden.filter((f) => r.has(f)).map((f) => /** @type {string[]} */ (r.get(f)).join(" -> "));
};

const STORAGE = "lib/storage.js";
const MCP = "lib/mcp-server.js";
const DB = "lib/db.js";
const NET = "lib/net.js";
const RESOLVE = "lib/programme-resolve.js";
const CHANGE = "lib/trainer-change.js";

describe("the walker", () => {
  it("reads the static imports it is meant to", () => {
    // Guards against a regex that quietly matches nothing.
    expect(edges("components/TrainerView.jsx")).toContain("components/TrainerClientView.jsx");
    expect(edges("components/SessionHost.jsx")).toContain(STORAGE);
    expect(edges(STORAGE)).toContain(RESOLVE);
    expect(edges(MCP)).toContain(RESOLVE);
  });
});

describe("the trainer pane stays off the server modules", () => {
  it("TrainerClientView reaches none of storage, the MCP server, the database or net", () => {
    expect(leaks("components/TrainerClientView.jsx", [STORAGE, MCP, DB, NET])).toEqual([]);
  });
  it("TrainerView reaches none of storage, the MCP server or the database", () => {
    // net.js is a client fetch wrapper TrainerView imports directly for its own calls.
    expect(leaks("components/TrainerView.jsx", [STORAGE, MCP, DB])).toEqual([]);
  });
  it("SessionHost reaches neither the MCP server nor the database", () => {
    expect(leaks("components/SessionHost.jsx", [MCP, DB])).toEqual([]);
  });
});

describe("the shared modules import nothing server-side", () => {
  for (const f of [RESOLVE, CHANGE]) {
    it(`${f} imports none of storage, the MCP server, the database or net`, () => {
      expect(edges(f).filter((to) => [STORAGE, MCP, DB, NET].includes(to))).toEqual([]);
      expect(leaks(f, [STORAGE, MCP, DB, NET])).toEqual([]);
    });
  }
});

describe("no import cycle through storage, the validator, the resolver and the MCP server", () => {
  const CORE = [STORAGE, CHANGE, RESOLVE, MCP];
  for (const f of CORE) {
    it(`${f} does not reach itself`, () => {
      const back = edges(f).filter((to) => reach(to).has(f));
      expect(back.map((to) => `${f} -> ${/** @type {string[]} */ (reach(to).get(f)).join(" -> ")}`)).toEqual([]);
    });
  }
});

describe("repsForSession", () => {
  it("the resolver's copy answers as the session engine's", () => {
    const shapes = [5, "5", "8/leg", "20s", "45s", "", null, undefined, "AMRAP", "10-12"];
    const reps = [6, 9, 0, -1, 2.5, null, undefined, "6", NaN, Infinity];
    for (const s of shapes) for (const r of reps) expect(repsForSession(r, s), `${r} ${s}`).toEqual(engineReps(r, s));
  });
});
