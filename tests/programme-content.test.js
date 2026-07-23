// tests/programme-content.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Locks for the S&C content cluster (#58–#61, boss calls 2026-07-24):
//   #58 swaps resolve their own loadType — never inherit the slot's
//   #59 Strong keeps BOTH the pull-up and direct hamstring work (rescue sub)
//   #60 zone map is symmetric; day-B pairings kept deliberately (Decided)
//   #61 Power Clean 4×3; Svend = total; same name → same vid + eq everywhere
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  SESSIONS, ZONE_ADJ, EXERCISE_POOLS, SWAP_DB,
  applySwapsToSession, applyFocusToSession, STRONG_SLOT_SUBSTITUTIONS,
} from "../lib/programme.js";
import { swapLoadType } from "../lib/lift-translations.js";
import { inferLoadType } from "../lib/storage.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Every leaf exercise entry in programme.js, however nested.
function allEntries() {
  const src = readFileSync(resolve(root, "lib/programme.js"), "utf8");
  return [...src.matchAll(/\{\s*name:\s*"([^"]+)"\s*,([^{}]*)\}/g)].map((m) => ({
    name: m[1],
    vid: (m[2].match(/vid:\s*"([^"]+)"/) || [])[1] ?? null,
    eq: (m[2].match(/eq:\s*"([^"]+)"/) || [])[1] ?? null,
    loadType: (m[2].match(/loadType:\s*"([^"]+)"/) || [])[1] ?? null,
  }));
}

describe("#58 — swap loadType resolution", () => {
  it("a stored swap WITHOUT loadType strips the slot's type instead of inheriting it", () => {
    const swapped = applySwapsToSession(SESSIONS[1], {
      "bss2-B": { name: "Nordic Curl", muscle: "Hamstrings", reps: 8, weight: 35, vid: null },
    });
    const ex = swapped.blocks.find((b) => b.id === "bss2").exB;
    expect(ex.name).toBe("Nordic Curl");
    expect(ex.loadType).toBeUndefined();     // machine NOT inherited
    expect(ex.weight).toBeNull();            // 35kg prefill NOT inherited
    expect(inferLoadType(ex.name)).toBe("bodyweight"); // render/log fallback
  });

  it("a swap WITH loadType carries it through untouched", () => {
    const swapped = applySwapsToSession(SESSIONS[1], {
      "bss2-B": { name: "Seated Leg Curl", reps: 12, weight: 35, loadType: "machine" },
    });
    expect(swapped.blocks.find((b) => b.id === "bss2").exB.loadType).toBe("machine");
  });

  it("swapLoadType: eq mapping with single-implement DB exceptions", () => {
    expect(swapLoadType({ name: "Seal Row", eq: "Barbell" })).toBe("barbell");
    expect(swapLoadType({ name: "DB Chest Fly", eq: "Dumbbell" })).toBe("per_db");
    expect(swapLoadType({ name: "Dumbbell Leg Curl", eq: "Dumbbell" })).toBe("total"); // one DB between the feet
    expect(swapLoadType({ name: "Goblet Squat", eq: "Dumbbell" })).toBe("total");
    expect(swapLoadType({ name: "Nordic Curl", eq: "Bodyweight" })).toBe("bodyweight");
    expect(swapLoadType({ name: "Weighted Dips", eq: "Bodyweight" })).toBe("loaded_bodyweight");
    expect(swapLoadType({ name: "Swiss Ball Leg Curl", eq: "Equipment" })).toBe("bodyweight");
  });

  it("inferLoadType: machine/seated leg curls are external, ball/slider family is bodyweight", () => {
    expect(inferLoadType("Machine Hamstring Curl")).toBe("external");
    expect(inferLoadType("Seated Leg Curl")).toBe("external");
    expect(inferLoadType("Swiss Ball Leg Curl")).toBe("bodyweight");
    expect(inferLoadType("Slider Leg Curl")).toBe("bodyweight");
    expect(inferLoadType("Nordic Curl")).toBe("bodyweight");
  });

  it("the SwapOverlay stamps loadType at selection (code shape)", () => {
    const src = readFileSync(resolve(root, "components/SessionScreen.jsx"), "utf8");
    expect(src).toContain("swapLoadType(option)");
    expect(src).toContain("sameLoadMaths");
  });
});

describe("#59 — Strong keeps hamstrings AND the pull-up", () => {
  const strongB = applyFocusToSession(SESSIONS[1], "Strong");
  const names = strongB.blocks.flatMap((b) => [b.ex?.name, b.exA?.name, b.exB?.name]).filter(Boolean);

  it("day B under Strong: ham curl substituted in, pull-up survives, quad accessories are what's lost", () => {
    expect(names).toContain("Machine Hamstring Curl");
    expect(names).toContain("Pull-Up");
    expect(names).not.toContain("Leg Press");
    expect(names).not.toContain("Bulgarian Split Squat");
  });

  it("the substitution gets the Strong 6–8 rep + load treatment like every accessory", () => {
    const exA = strongB.blocks.find((b) => b.id === "bss1").exA;
    expect(exA.name).toBe("Machine Hamstring Curl");
    expect(exA.reps).toBe("6-8");
    expect(exA.weight).toBeGreaterThan(35); // pool default raised by the Strong bump
  });

  it("honours the leg-curl rotation when the pick is heavy-capable (boss, 2026-07-25)", () => {
    const withNordic = applyFocusToSession(SESSIONS[1], "Strong", { "bss2-B": { name: "Nordic Curl" } });
    const nordic = withNordic.blocks.find((b) => b.id === "bss1").exA;
    expect(nordic.name).toBe("Nordic Curl");
    expect(nordic.loadType).toBe("bodyweight"); // canonical pool metadata, not a duplicate literal
    expect(nordic.reps).toBe("6-8");

    const withSeated = applyFocusToSession(SESSIONS[1], "Strong", { "bss2-B": { name: "Seated Leg Curl" } });
    expect(withSeated.blocks.find((b) => b.id === "bss1").exA.name).toBe("Seated Leg Curl");

    // Light variants can't honestly carry a 6–8 prescription → fallback.
    const withSlider = applyFocusToSession(SESSIONS[1], "Strong", { "bss2-B": { name: "Slider Leg Curl" } });
    expect(withSlider.blocks.find((b) => b.id === "bss1").exA.name).toBe("Machine Hamstring Curl");
    expect(STRONG_SLOT_SUBSTITUTIONS["bss1-A"].allowed).toEqual(
      ["Machine Hamstring Curl", "Nordic Curl", "Seated Leg Curl"],
    );
  });

  it("Forged and Sculpt are untouched by the substitution", () => {
    for (const focus of ["Forged", "Sculpt"]) {
      const s = applyFocusToSession(SESSIONS[1], focus);
      const n = s.blocks.flatMap((b) => [b.exA?.name, b.exB?.name]).filter(Boolean);
      expect(n, focus).toContain("Leg Press");
    }
  });
});

describe("#60 — zone adjacency (Decided: day-B pairings kept, map must be symmetric)", () => {
  it("every adjacency is listed in both directions", () => {
    for (const [zone, adj] of Object.entries(ZONE_ADJ)) {
      for (const other of adj) {
        expect(ZONE_ADJ[other], `${zone}→${other} listed but not ${other}→${zone}`).toContain(zone);
      }
    }
  });
});

describe("#61 — content nits", () => {
  it("Power Clean is 4×3 (boss call: triples for bar speed, extra set keeps volume)", () => {
    const c1 = SESSIONS[2].blocks.find((b) => b.id === "c1");
    expect(c1.sets).toBe(4);
    expect(c1.ex.reps).toBe(3);
  });

  it("Svend Press is total (one plate, both palms — never per_db double-count)", () => {
    for (const e of allEntries().filter((e) => e.name === "Svend Press")) {
      if (e.loadType) expect(e.loadType).toBe("total");
    }
  });

  it("no loaded_bw shorthand survives — computeEffectiveLoad only knows the long form", () => {
    expect(allEntries().filter((e) => e.loadType === "loaded_bw")).toEqual([]);
  });

  it("CLASS LOCK: same exercise name → same vid and same eq everywhere", () => {
    const byName = new Map();
    const offenders = [];
    for (const e of allEntries()) {
      const prior = byName.get(e.name);
      if (!prior) { byName.set(e.name, e); continue; }
      if (e.vid && prior.vid && e.vid !== prior.vid) offenders.push(`${e.name}: vid ${prior.vid} vs ${e.vid}`);
      if (e.eq && prior.eq && e.eq !== prior.eq) offenders.push(`${e.name}: eq ${prior.eq} vs ${e.eq}`);
      if (e.vid && !prior.vid) byName.set(e.name, { ...prior, vid: e.vid });
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("a name with a video ANYWHERE has it EVERYWHERE (no vid:null shadows)", () => {
    const hasVid = new Set(allEntries().filter((e) => e.vid).map((e) => e.name));
    const shadows = allEntries().filter((e) => !e.vid && hasVid.has(e.name)).map((e) => e.name);
    expect([...new Set(shadows)]).toEqual([]);
  });
});
