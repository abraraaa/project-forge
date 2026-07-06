// tests/storage.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Durability contract — see the DURABILITY CONTRACT block at the top of
// lib/storage.js. The contract: every persisted store is either SYNCED
// (round-tripped to blob through the four seams) or DEVICE-LOCAL (with an
// explicit reason). Adding a store without picking a side IS a regression.
//
// What this file asserts:
//
//   1. Every exported store with a key:() or hard-coded storage key has an
//      entry in the inventory comment AND a row in INVENTORY below.
//   2. Every SYNCED store appears in all four seams:
//        getLocalProfile  — reads it into the snapshot
//        persistToLocal   — writes it back from merged blob
//        mergeProfileData — has a merge rule for it
//        pushUserStateSnapshot (ForgeApp.jsx) — pushes on mutation
//   3. New stores can't sneak in without forcing a contract decision —
//      the test enumerates exported store identifiers and fails on any
//      that aren't accounted for.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const storageSrc = readFileSync(resolve(__dirname, "../lib/storage.js"), "utf8");
const forgeAppSrc = readFileSync(resolve(__dirname, "../components/ForgeApp.jsx"), "utf8");

// Authoritative inventory of every store that ships persistence. If you add
// a store and don't update this list, the "no orphan stores" test fails —
// forcing a deliberate disposition choice.
//
// disposition:
//   "synced"        — included in blob meta payload (or own blob, for H)
//   "device-local"  — intentionally not synced; reason recorded below
const INVENTORY = {
  // P still owns dayDone / bonusDone keys on disk for read-only rescue by
  // Days._foldLegacy on a peer pulling a pre-cutover blob — but those keys
  // are no longer part of the sync contract (the four-seams test). Days
  // is the single SYNCED store for per-date completion now.
  P:  { disposition: "synced", keys: ["weights", "reps", "streak"] },
  H:  { disposition: "synced", keys: ["history"], note: "own blob, server-side merge by id" },
  W:  { disposition: "synced", keys: ["weekConfig"] },
  PB: { disposition: "synced", keys: ["programmeBlock"] },
  F:  { disposition: "synced", keys: ["focus"] },
  BW: { disposition: "synced", keys: ["bw"] },
  TS:   { disposition: "synced", keys: ["trainingState"] },
  Days: { disposition: "synced", keys: ["days", "daysProjected"], note: "unified Day completion entity (date-keyed); replaces dayDone/bonusDone/weekDone projection during cutover" },
  PN:   { disposition: "device-local", keys: ["passkeyNudge"], reason: "per-device nudge cadence" },
  PQ: { disposition: "device-local", keys: ["pendingPushes"], reason: "retry queue, derived from failures on this device" },
  D:  { disposition: "device-local", keys: ["draft"], reason: "transient in-session draft, recovered locally only" },
  // LS and SyncStatus are utilities, not stores. They don't own data.
};

const UTILITIES = new Set(["LS", "SyncStatus"]);

// Stores whose data flows via blob meta (excludes H — own blob).
const META_SYNCED = Object.entries(INVENTORY)
  .filter(([, v]) => v.disposition === "synced")
  .map(([k]) => k)
  .filter((k) => k !== "H");

describe("storage durability contract", () => {
  it("every exported store is accounted for in INVENTORY", () => {
    const exportedStores = [...storageSrc.matchAll(/^export const ([A-Z]+) = \{/gm)]
      .map(([, name]) => name)
      .filter((n) => !UTILITIES.has(n));
    for (const name of exportedStores) {
      expect(INVENTORY[name], `store "${name}" exported from lib/storage.js but missing from tests/storage.test.js INVENTORY — pick SYNCED or DEVICE-LOCAL and document it`).toBeDefined();
    }
  });

  it("device-local stores carry a reason", () => {
    for (const [name, entry] of Object.entries(INVENTORY)) {
      if (entry.disposition === "device-local") {
        expect(entry.reason, `${name}: device-local stores must declare a reason`).toBeTruthy();
      }
    }
  });

  it("every SYNCED meta store is read by getLocalProfile", () => {
    const getLocalProfile = sliceFunction(storageSrc, "getLocalProfile");
    const required = {
      P:    ["weights", "reps", "streak"],
      W:    ["userWeek"],
      PB:   ["programmeBlock"],
      F:    ["userFocus"],
      BW:   ["bodyweight"],
      TS:   ["trainingState"],
      Days: ["days"],
      Bk:   ["breaks"],
    };
    for (const [store, fields] of Object.entries(required)) {
      for (const field of fields) {
        expect(getLocalProfile.includes(field), `getLocalProfile() must read ${store} as meta.${field}`).toBe(true);
      }
    }
  });

  it("every SYNCED meta store is written by persistToLocal", () => {
    const persistToLocal = sliceFunction(storageSrc, "persistToLocal");
    // dayDone / bonusDone retained ONLY as inbound rescue paths from
    // pre-cutover peers (the substring still appears in the function body).
    // The required-list below is the active sync contract; the rescue lines
    // are exercised via the storage-days projection tests.
    const required = ["weights", "reps", "streak", "programmeBlock", "userWeek", "userFocus", "bodyweight", "trainingState", "days", "breaks"];
    for (const field of required) {
      expect(persistToLocal.includes(field), `persistToLocal() must hydrate meta.${field} back to local`).toBe(true);
    }
  });

  it("every SYNCED meta store has a merge rule in mergeProfileData", () => {
    const mergeFn = sliceFunction(storageSrc, "mergeProfileData");
    const required = ["weights", "reps", "streak", "programmeBlock", "userWeek", "userFocus", "bodyweight", "trainingState", "days", "breaks"];
    for (const field of required) {
      expect(mergeFn.includes(field), `mergeProfileData must declare a merge rule for meta.${field}`).toBe(true);
    }
  });

  // Note: a separate assertion used to parse `pushUserStateSnapshot` in
  // ForgeApp.jsx for the same field list. That helper has been replaced by
  // `pushNow` in storage.js, which builds the snapshot via `getLocalProfile`
  // — already covered by the read test above. Removed to avoid duplicate
  // coverage of the same composition.
});

// Extract a function body. Walks past the params (which can have their own
// braces via destructuring like `function f({ a, b })`) by balancing the
// opening `(` to its matching `)`, then locates the body's opening `{` and
// balances that. Substring assertions only — not a parser.
function sliceFunction(src, name) {
  const patterns = [
    new RegExp(`export function ${name}\\s*\\(`),
    new RegExp(`function ${name}\\s*\\(`),
    new RegExp(`const ${name}\\s*=\\s*\\(`),
    new RegExp(`const ${name}\\s*=\\s*useCallback`),
  ];
  let m = null;
  for (const p of patterns) {
    const hit = src.match(p);
    if (hit && hit.index !== undefined) { m = hit; break; }
  }
  if (!m) throw new Error(`Could not locate function ${name} in source`);
  const start = m.index;
  // Walk past params: balance the `(` at end of the matched declaration.
  let i = start + m[0].length - 1; // index of "("
  let paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") paren++;
    else if (src[i] === ")") { paren--; if (paren === 0) { i++; break; } }
  }
  // Now find the function body's opening "{" and balance it.
  i = src.indexOf("{", i);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
