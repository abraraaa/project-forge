// tests/a11y-contract.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Two landmark/zoom invariants that used to live only in comments.
//
// 1. ONE <main>. app/layout.jsx marks .forge-page as the document's main
//    landmark, so every route inherits one. A route rendering its own nests a
//    second inside the first, which is a landmark error rather than a
//    duplicate — /locker-room, /not-found and /diag-bugs each did before the
//    layout took the job.
//
// 2. NO focusable input below 16px. app/layout.jsx deliberately ships no
//    maximumScale/userScalable lock so people who magnify can pinch-zoom. The
//    one thing that lock plausibly still bought was suppressing iOS's
//    zoom-on-focus, which fires on inputs under 16px — so the floor is the
//    thing keeping the lock unnecessary. BugReportSheet's textarea sat at 14px.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
const walk = (d) => {
  for (const f of readdirSync(resolve(root, d), { withFileTypes: true })) {
    const rel = join(d, f.name);
    if (f.isDirectory()) walk(rel);
    else if (/\.jsx$/.test(f.name)) files.push(rel.replace(/\\/g, "/"));
  }
};
walk("components");
walk("app");

const read = (rel) => readFileSync(resolve(root, rel), "utf8");

// Read one JSX tag from `<` to its matching `>`, ignoring the `>` inside arrow
// functions and nested braces (onChange={e=>...} is why a lazy /.*?>/ can't
// do this).
function tagAt(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

describe("a11y contract", () => {
  it("only the root layout declares <main>", () => {
    const offenders = files.filter((rel) => rel !== "app/layout.jsx" && /<main[\s>]/.test(read(rel)));
    expect(
      offenders,
      `<main> nests inside the layout's own — render a <div>: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("no focusable input sets a font-size below 16px (iOS zoom-on-focus)", () => {
    // Only explicit sub-16 values are flagged. An input that sets no fontSize
    // inherits one, which this cannot see and should not guess at; the
    // regression shape being caught is someone typing `fontSize: 14`.
    const offenders = [];
    for (const rel of files) {
      const src = read(rel);
      for (const m of src.matchAll(/<(input|textarea|select)\b/g)) {
        const tag = tagAt(src, m.index);
        // A file picker is never focused visually — both of ours are display:none.
        if (/type="file"/.test(tag) || /display:\s*["']none["']/.test(tag)) continue;
        const size = tag.match(/fontSize:\s*(\d+)/);
        if (size && Number(size[1]) < 16) offenders.push(`${rel}: <${m[1]}> at ${size[1]}px`);
      }
    }
    expect(
      offenders,
      `16px is the floor that keeps the viewport zoom lock unnecessary: ${offenders.join(" | ")}`,
    ).toEqual([]);
  });
});
