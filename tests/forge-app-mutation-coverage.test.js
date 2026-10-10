// tests/forge-app-mutation-coverage.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Mutation-coverage audit. Asserts every handler that mutates a persisted
// store routes through one of the TWO canonical push helpers: pushNow() for
// class-1 (immediate) or pushDeferred() for class-2 (coalesced). Both build
// their payload from getLocalProfile — the ONE payload builder. Routing
// taxonomy: class-1 mutations push before returning; class-2 may defer to the next natural sync.
//
// A raw blobPush() with a hand-rolled meta subset is NOT accepted: that is the
// audit-S1 bug class (a partial payload without weightStamps/repStamps/
// trainingState/bodyweight loses the server merge to the blob's older stamped
// values, and engine state never reaches the blob at all). Both session-
// finalise paths did exactly this until 2026-07-15; this test now forbids it.
//
// Coverage spans BOTH hosts that own persisted mutations: ForgeApp.jsx (home +
// retro finalise) AND SessionHost.jsx (live finalise + in-session bodyweight).
// The live-finalise bug survived for as long as it did because this audit
// scanned only ForgeApp — SessionHost is in scope now.
//
// What the durability contract test in storage.test.js asserts: the SHAPE of
// the payload — every SYNCED field is read by getLocalProfile, written by
// persistToLocal, and has a merge rule. THIS test asserts the WIRING at the
// handler level. A handler that mutates a store without routing to a push
// helper strands the change locally until lifecycle flush — durable in
// theory, racy in practice.
//
// Approach: parse each host as text, find every line that calls a
// persistence-mutating primitive, locate the enclosing function body, assert
// the body contains pushNow() or pushDeferred() — or is in the EXEMPT list
// (sync-side receivers).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOSTS = [
  { name: "ForgeApp.jsx", source: readFileSync(resolve(__dirname, "../components/ForgeApp.jsx"), "utf8") },
  // The live host's store writes sit in its adapter, lib/session-source.js.
  { name: "SessionHost.jsx", source: readFileSync(resolve(__dirname, "../components/SessionHost.jsx"), "utf8") + "\n" + readFileSync(resolve(__dirname, "../lib/session-source.js"), "utf8") },
];

// Persistence-mutating calls. Any line containing one of these regexes is a
// potential push-needed site. Keep this in sync with lib/storage.js: a new
// export that mutates LS should be added here.
const MUTATING_CALLS = [
  /\bW\.save\s*\(/,
  /\bW\.reset\s*\(/,
  /\bPB\.save\s*\(/,
  /\bPB\.reset\s*\(/,
  /\bF\.save\s*\(/,
  /\bBW\.set\s*\(/,
  /\bTS\.replaceState\s*\(/,
  /\bTS\.updateLift\s*\(/,
  /\bTS\.updateMuscleAnchor\s*\(/,
  /\bTS\.updateVolume\s*\(/,
  /\bDays\.set\s*\(/,
  /\bH\.append\s*\(/,
  /\bbumpStreak\s*\(/,
  /\bP\.setAddedLoad\s*\(/,
];

// Function names that are EXEMPT from the push requirement, with reason.
// Adding to this list requires a justification in the comment.
const EXEMPT_FUNCTIONS = {
  // handleSyncUpdate is the receive side — meta arrives from blob and is
  // landed into local. Pushing it back would create a loop.
  handleSyncUpdate: "Receive-side; lands incoming blob data into local stores. Pushing would loop.",
};

// Walk backward from `lineIdx` looking for the function whose body CONTAINS
// `mutationLineIdx`. The naive "nearest declaration backward" doesn't work
// because the source has internal IIFEs (`const dowMon = (() => {...})();`)
// whose declarations sit between the outer handler and the mutation call —
// the IIFE's body closes before the mutation line, so it's not the enclosing
// function. We walk back, candidate by candidate, and verify the mutation
// site is within the candidate's brace-balanced body. First containing
// candidate wins.
function findEnclosingDeclaration(source, lines, mutationLineIdx) {
  // Patterns require an opening { ON THE DECLARATION LINE so single-line
  // const declarations (useMemo/useState/etc, no block body) don't false-
  // match. The mutation site is always inside a multi-line function body,
  // so the enclosing function definitely has an opening brace.
  const DECL_PATTERNS = [
    // const NAME = useCallback((args) => {
    { re: /^\s*const\s+(\w+)\s*=\s*useCallback\s*\(\s*(?:async\s+)?\(?[^)]*\)?\s*=>\s*\{/, kind: "named" },
    // const NAME = (async) (args) => {     OR     const NAME = args => {
    { re: /^\s*const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>\s*\{/, kind: "named" },
    // function NAME(args) {                OR     export function NAME(args) {
    { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/, kind: "named" },
    // useEffect(() => {  — anonymous; synthesised name uses line number so
    // the failure message points at the right place. Exempt via inline
    // comment marker (see below).
    { re: /^\s*useEffect\s*\(\s*(?:async\s+)?\(?[^)]*\)?\s*=>\s*\{/, kind: "useEffect" },
  ];
  for (let i = mutationLineIdx; i >= 0; i--) {
    const line = lines[i];
    let name = null;
    let kind = null;
    for (const pat of DECL_PATTERNS) {
      const m = line.match(pat.re);
      if (m) { name = pat.kind === "useEffect" ? `useEffect@${i + 1}` : m[1]; kind = pat.kind; break; }
    }
    if (!name) continue;
    // Verify the candidate's body actually contains the mutation line.
    const startCharIdx = charIdxForLine(source, i);
    const endCharIdx = findFunctionEnd(source, startCharIdx);
    const mutationCharIdx = charIdxForLine(source, mutationLineIdx);
    if (mutationCharIdx >= startCharIdx && mutationCharIdx <= endCharIdx) {
      // Inline exemption: a line in the comment block immediately above the
      // declaration may carry `// mutation-audit: exempt — <reason>`. Walks
      // back through contiguous comment-only lines so a multi-line block
      // comment can include the marker anywhere within it. Reason must be
      // ≥10 chars so the exemption is justified.
      let exemptReason = null;
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j];
        if (!/^\s*\/\//.test(prev) && prev.trim() !== "") break; // hit non-comment, stop scanning
        const m = prev.match(/\/\/\s*mutation-audit:\s*exempt\s*(?:—|--)?\s*(.+)$/);
        if (m) { exemptReason = m[1].trim(); break; }
      }
      return { startIdx: i, name, kind, exemptReason };
    }
    // Candidate's body closes before the mutation site → it's a sibling IIFE
    // or inner const; keep walking back to find the real enclosing handler.
  }
  return null;
}

// Forward brace-balance from a starting line. Walks character by character
// from the first `{` we find on/after the start line and returns the line
// index of the matching closing `}`.
function findFunctionEnd(text, startCharIdx) {
  let depth = 0;
  let inString = null; // null, '"', "'", "`"
  let escape = false;
  let i = text.indexOf("{", startCharIdx);
  if (i === -1) return text.length;
  for (; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === "\\") { escape = true; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inString = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return text.length;
}

function charIdxForLine(text, lineIdx) {
  let idx = 0;
  for (let i = 0; i < lineIdx; i++) {
    idx = text.indexOf("\n", idx) + 1;
    if (idx === 0) return text.length;
  }
  return idx;
}

function mutationSitesIn(source) {
  const lines = source.split("\n");
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\/\//.test(line)) continue; // skip comments
    if (/^\s*\*/.test(line)) continue;
    for (const pat of MUTATING_CALLS) {
      if (pat.test(line)) {
        sites.push({ lineIdx: i, line: line.trim(), pattern: pat.source });
        break;
      }
    }
  }
  return { lines, sites };
}

describe.each(HOSTS)("$name mutation coverage — every persisted mutation pushes", ({ name, source }) => {
  const { lines, sites: mutationSites } = mutationSitesIn(source);

  it("finds mutation sites (regression on the regex list going empty)", () => {
    // Sanity: if the regex list matches nothing, every other assertion
    // passes trivially. Floor lowered 4→3 when #16 moved the engine
    // choreography (TS.updateLift/Anchor/Volume) into lib/session-engine —
    // its writes are covered by the callers' end-of-finalise pushNow, and
    // both call sites keep their own mutation sites here. Both hosts carry
    // finalise-path mutations.
    expect(mutationSites.length).toBeGreaterThanOrEqual(3);
  });

  it("every mutation site is in a function that routes through pushNow/pushDeferred", () => {
    const failures = [];
    for (const site of mutationSites) {
      const decl = findEnclosingDeclaration(source, lines, site.lineIdx);
      if (!decl) {
        failures.push(`Line ${site.lineIdx + 1}: no enclosing function found for ${site.line}`);
        continue;
      }
      if (EXEMPT_FUNCTIONS[decl.name]) continue;
      if (decl.exemptReason && decl.exemptReason.length >= 10) continue;

      const charIdx = charIdxForLine(source, decl.startIdx);
      const endIdx = findFunctionEnd(source, charIdx);
      const body = source.slice(charIdx, endIdx + 1);

      // Only the canonical builders count. A raw blobPush() is deliberately
      // NOT accepted — it is the hand-rolled-subset (audit-S1) escape hatch.
      const hasPushNow = /pushNow\s*\(/.test(body);
      const hasPushDeferred = /pushDeferred\s*\(/.test(body);
      if (!hasPushNow && !hasPushDeferred) {
        const rawPush = /blobPush\s*\(/.test(body);
        failures.push(
          `${decl.name} (around line ${site.lineIdx + 1}) mutates persisted state ` +
          `(${site.pattern}) but never calls pushNow() or pushDeferred()` +
          (rawPush
            ? ` — it calls blobPush() directly, which is the audit-S1 hand-rolled` +
              ` partial-payload class. Route through pushNow (getLocalProfile) instead.`
            : `. Pick a class (class-1 immediate vs class-2 deferred) and add the call, or — if ` +
              `intentionally not pushing — add ${decl.name} to EXEMPT_FUNCTIONS with a reason.`),
        );
      }
    }
    if (failures.length) {
      throw new Error(
        `Mutation coverage gaps found in ${name}:\n  ` +
        failures.join("\n  "),
      );
    }
  });
});

// commitSessionRecord (lib/session-commit.js) writes history, the day, the
// engine and W/R but leaves the push to its caller. Every caller in lib/ and
// components/ must sit in a function that pushes.
describe("commitSessionRecord callers push", () => {
  const root = resolve(__dirname, "..");
  const files = ["lib", "components"].flatMap((dir) =>
    readdirSync(resolve(root, dir), { recursive: true })
      .map(String)
      .filter((f) => /\.(js|jsx)$/.test(f))
      .map((f) => `${dir}/${f}`))
    .filter((f) => f !== "lib/session-commit.js");
  const calls = files.flatMap((file) => {
    const source = readFileSync(resolve(root, file), "utf8");
    const lines = source.split("\n");
    return lines
      .map((line, lineIdx) => ({ file, source, lines, lineIdx, line }))
      .filter(({ line }) => !/^\s*(\/\/|\*)/.test(line) && /\bcommitSessionRecord\s*\(/.test(line));
  });

  it("finds at least the live finish", () => {
    expect(calls.map((c) => c.file)).toContain("lib/session-source.js");
  });

  it("every call sits in a function that calls pushNow/pushDeferred", () => {
    const failures = [];
    for (const { file, source, lines, lineIdx } of calls) {
      const decl = findEnclosingDeclaration(source, lines, lineIdx);
      if (!decl) { failures.push(`${file}:${lineIdx + 1}: no enclosing function found`); continue; }
      const start = charIdxForLine(source, decl.startIdx);
      const body = source.slice(start, findFunctionEnd(source, start) + 1);
      if (!/push(?:Now|Deferred)\s*\(/.test(body)) {
        failures.push(`${file}:${lineIdx + 1}: ${decl.name} calls commitSessionRecord but never pushes`);
      }
    }
    expect(failures).toEqual([]);
  });

  // Keep is handed the commit (setSessionCommit), so it has no literal
  // commitSessionRecord( call: its push is _deliverTrainer's, which pushes
  // before it reports. storage.js's functions here are top level, so a body
  // runs from its declaration to the next line that is just "}".
  it("Keep's injected commit: every _keepSession caller delivers, and delivery pushes", () => {
    const file = "lib/storage.js";
    const lines = readFileSync(resolve(root, file), "utf8").split("\n");
    const DECL = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/;
    const bodyOf = (lineIdx) => {
      let i = lineIdx;
      while (i >= 0 && !DECL.test(lines[i])) i--;
      if (i < 0) return { name: null, body: "" };
      const end = lines.findIndex((l, j) => j > i && l === "}");
      return { name: lines[i].match(DECL)?.[1] ?? null, body: lines.slice(i, end + 1).join("\n"), end };
    };
    const declOf = (name) => lines.findIndex((l) => l.match(DECL)?.[1] === name);
    const keep = declOf("_keepSession");
    expect(bodyOf(keep).body).toMatch(/\bcommit\(profile, rec, ctx\)/);
    expect(bodyOf(declOf("_deliverTrainer")).body).toMatch(/\bpushNow\(/);
    const callers = lines.map((l, i) => ({ l, i }))
      .filter(({ l, i }) => i !== keep && /\b_keepSession\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    expect(callers.map(({ i }) => bodyOf(i).name)).toContain("keepTrainerSession");
    const failures = callers.map(({ i }) => ({ i, ...bodyOf(i) }))
      .filter(({ body }) => !/\b_deliverTrainer\(/.test(body))
      .map(({ i, name }) => `${file}:${i + 1}: ${name} keeps but never delivers`);
    expect(failures).toEqual([]);
  });
});

describe("mutation-coverage exemptions", () => {
  it("EXEMPT_FUNCTIONS entries all have a reason string", () => {
    for (const [name, reason] of Object.entries(EXEMPT_FUNCTIONS)) {
      expect(reason, `EXEMPT_FUNCTIONS["${name}"] must declare why it's exempt`).toBeTruthy();
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});
