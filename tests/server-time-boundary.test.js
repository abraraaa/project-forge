// Temporal is a Node global the browser floor (iPhone Safari) does not have,
// so it stays on the server. From every "use client" file and every file under
// components/, no module reachable by import (static or import("…")) may name
// Temporal in code or import lib/server-time.js.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SERVER_TIME = "lib/server-time.js";

const IMPORT = /^\s*import\s+(?:[\w$]+\s*,?\s*)?(?:\*\s*as\s+[\w$]+|\{[^}]*\})?\s*from\s*["']([^"']+)["']/gm;
const BARE = /^\s*import\s*["']([^"']+)["']/gm;
const REEXPORT = /^\s*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/gm;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** Source without its comment lines: prose may name Temporal, code may not. */
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");

const read = (file) => readFileSync(join(ROOT, file), "utf8");

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
    const text = read(file);
    for (const re of [IMPORT, BARE, REEXPORT, DYNAMIC]) {
      for (const m of text.matchAll(re)) {
        const to = resolveSpec(m[1], file);
        if (to) out.push(to);
      }
    }
  }
  edgesCache.set(file, out);
  return out;
}

function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const rel = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** A "use client" directive ahead of any other statement. */
const isClient = (file) => /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/.test(read(file));

const ALL = ["app", "components", "lib"].flatMap(sourceFiles);
const ROOTS = ALL.filter((f) => f.startsWith("components/") || isClient(f));

/** Every module the roots reach, each with the chain that first reaches it. */
function reach(roots) {
  /** @type {Map<string, string[]>} */
  const seen = new Map(roots.map((r) => [r, [r]]));
  const queue = [...roots];
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

const namesTemporal = (file) => /\bTemporal\b/.test(code(read(file)));

describe("the walker", () => {
  it("finds the client roots and their imports", () => {
    expect(ROOTS).toContain("components/ForgeApp.jsx");
    expect(ROOTS.some((f) => f.startsWith("app/"))).toBe(true);
    expect(ROOTS).not.toContain("app/api/sync/route.js");
    const r = reach(ROOTS);
    expect(r.has("lib/dates.js")).toBe(true);
    expect(r.has("lib/trainer-view.js")).toBe(true);
    expect(r.has("lib/storage.js")).toBe(true);
  });

  it("catches a module that names Temporal or imports the server time module", () => {
    expect(namesTemporal(SERVER_TIME)).toBe(true);
    const r = reach(["tests/server-time.test.js"]);
    expect(r.has(SERVER_TIME)).toBe(true);
  });

  it("reads Temporal in code, not in comments", () => {
    expect(/\bTemporal\b/.test(code("// Temporal\n/* Temporal\n * Temporal */\nconst a = 1;"))).toBe(false);
    expect(/\bTemporal\b/.test(code("const t = Temporal.Now; // x"))).toBe(true);
    expect(/\bTemporal\b/.test(code("const u = 1; // Temporal"))).toBe(true);
  });
});

describe("no client module reaches Temporal", () => {
  it("nothing reachable from a client file imports lib/server-time.js", () => {
    const r = reach(ROOTS);
    expect(r.has(SERVER_TIME) ? /** @type {string[]} */ (r.get(SERVER_TIME)).join(" -> ") : null).toBe(null);
  });

  it("nothing reachable from a client file names Temporal", () => {
    const r = reach(ROOTS);
    const leaks = [...r.entries()].filter(([f]) => /\.(jsx?|mjs)$/.test(f) && namesTemporal(f)).map(([, chain]) => chain.join(" -> "));
    expect(leaks).toEqual([]);
  });
});
