import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { censusNameKeys, canonicalName } from "../lib/name-census.js";

const routeSrc = readFileSync(new URL("../app/api/diag/name-census/route.js", import.meta.url), "utf8");

describe("name census — read only", () => {
  it("imports only list from blob and runs only SELECTs", () => {
    const imports = routeSrc.match(/import\s*\{[^}]*\}\s*from\s*"@vercel\/blob"/s)?.[0] || "";
    expect(imports).toContain("list");
    for (const w of ["put", "del", "copy"]) expect(imports).not.toMatch(new RegExp(`\\b${w}\\b`));
    expect(routeSrc).not.toMatch(/\b(DELETE|UPDATE|INSERT|DROP|ALTER|TRUNCATE)\b/);
    expect([...routeSrc.matchAll(/export async function ([A-Z]+)/g)].map((m) => m[1])).toEqual(["GET"]);
  });

  it("fails closed without CRON_SECRET", () => {
    expect(routeSrc).toContain("CRON_SECRET not configured");
    expect(routeSrc).toContain("`Bearer ${cronSecret}`");
  });
});

describe("censusNameKeys", () => {
  it("flags keys a shared NFKC normaliser would move, with their sources", () => {
    const r = censusNameKeys([
      { source: "blob", key: "sam" },
      { source: "photos", key: "ｓam" },          // fullwidth s, lowercase-only key
      { source: "blob", key: "ｓam" },
      { source: "auth_tokens", key: "café" }, // decomposed é
    ]);
    expect(r.distinct).toBe(3);
    expect(r.divergent).toEqual([
      { key: "café", canonical: "café", sources: ["auth_tokens"] },
      { key: "ｓam", canonical: "sam", sources: ["blob", "photos"] },
    ]);
  });

  it("ordinary names are not flagged", () => {
    expect(censusNameKeys([{ source: "blob", key: "abrar" }]).divergent).toEqual([]);
    expect(canonicalName(" KelvinK ")).toBe("kelvink");
  });
});
