// lib/entitlements.js is the only place roles or plan are read.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { entitled } from "../lib/entitlements.js";

describe("entitled", () => {
  it("trainers never lapse; lifters do", () => {
    expect(entitled({ roles: ["lifter"] }, "handle.neverLapse")).toBe(false);
    expect(entitled({ roles: ["lifter", "trainer"] }, "handle.neverLapse")).toBe(true);
  });

  it("unknown keys, null and shapeless accounts are never entitled", () => {
    expect(entitled({ roles: ["lifter", "trainer"] }, "no.such.rule")).toBe(false);
    expect(entitled({ roles: ["trainer"] }, "toString")).toBe(false);
    expect(entitled(null, "handle.neverLapse")).toBe(false);
    expect(entitled({}, "handle.neverLapse")).toBe(false);
  });
});

describe("single check point", () => {
  const root = new URL("..", import.meta.url).pathname;
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(m?js|jsx|ts|tsx)$/.test(f) ? [p] : [];
  });

  it("no file in app/ or lib/ but lib/entitlements.js reads roles or plan", () => {
    const files = [...walk(join(root, "app")), ...walk(join(root, "lib"))]
      .filter((p) => relative(root, p) !== join("lib", "entitlements.js"));
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((p) => /roles\.includes\(|\.plan\s*[!=]==/.test(readFileSync(p, "utf8")));
    expect(offenders.map((p) => relative(root, p))).toEqual([]);
  });
});
