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

  it("trainer dashboard and invite need the trainer role, whatever the plan", () => {
    for (const key of ["trainer.dashboard", "trainer.invite"]) {
      expect(entitled({ roles: ["lifter"] }, key)).toBe(false);
      expect(entitled({ roles: ["lifter"], plan: "pro" }, key)).toBe(false);
      expect(entitled({ roles: ["lifter", "trainer"] }, key)).toBe(true);
      expect(entitled({ roles: ["trainer"], plan: "free" }, key)).toBe(true);
      expect(entitled({ roles: "trainer" }, key)).toBe(false);
      expect(entitled(null, key)).toBe(false);
    }
    expect(entitled({ roles: ["trainer"] }, "trainer")).toBe(false);
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
    // The trainer modules are inside the scan.
    for (const f of ["lib/trainer-terms.js", "lib/trainer-view.js", "lib/auth-server.js", "lib/identity-store.js"]) {
      expect(files.map((p) => relative(root, p))).toContain(f);
    }
    const offenders = files.filter((p) => /roles\.includes\(|\.plan\s*[!=]==/.test(readFileSync(p, "utf8")));
    expect(offenders.map((p) => relative(root, p))).toEqual([]);
  });
});
