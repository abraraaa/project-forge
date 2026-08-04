// tests/provenance.test.js
// ─────────────────────────────────────────────────────────────────────────────
// IP-attribution invariants. Not a feature — a legal posture that must not
// erode. The provenance beacon and licence notices are load-bearing for a
// takedown; a refactor that quietly drops them removes a defence, so they
// are pinned here. Equally load-bearing: the beacon must stay INERT — the
// moment app behaviour depends on it, it becomes a covert kill-switch, so
// this file also guards that it is never wired into runtime gating.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PROVENANCE } from "../lib/provenance.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

describe("provenance beacon", () => {
  it("carries the origin, licence, and permanent rpId", () => {
    expect(PROVENANCE.origin).toBe("heatwayve.app");
    expect(PROVENANCE.license).toBe("PolyForm-Strict-1.0.0");
    expect(PROVENANCE.rpId).toBe("theforged.fit"); // matches the WebAuthn rpId, permanently
    expect(Object.isFrozen(PROVENANCE)).toBe(true);
  });

  it("is INERT — never imported by runtime code (no covert kill-switch)", () => {
    // The beacon is evidence, not enforcement. If any app module imports it,
    // that's the first step toward gating behaviour on it — refuse here.
    // Docs and this test may reference it; nothing under lib/app/components
    // that runs may.
    const runtime = [
      "lib/storage.js", "lib/progression.js", "lib/session-engine.js",
      "lib/sync-delta.js", "lib/auth-server.js", "components/ForgeApp.jsx",
      "app/api/sync/route.js",
    ];
    for (const f of runtime) {
      if (!existsSync(resolve(root, f))) continue;
      expect(read(f), `${f} must not import the provenance beacon`)
        .not.toMatch(/from\s+["']@?\/?.*provenance/);
    }
  });
});

describe("licence notices are present and retained", () => {
  it("NOTICE and LICENSE exist and name the terms", () => {
    expect(read("NOTICE")).toContain("PolyForm Strict License 1.0.0");
    expect(read("NOTICE")).toContain("lib/provenance.js");
    expect(read("LICENSE")).toContain("PolyForm Strict License 1.0.0");
  });

  it("crown-jewel modules carry the SPDX header", () => {
    // The engine and datasets the licence names by name each carry a
    // per-file notice — each file is individually marked, which strengthens
    // the claim over a repo-root LICENSE alone.
    for (const f of ["lib/progression.js", "lib/volume-audit.js",
                     "lib/exercise-anatomy.js", "lib/storage.js"]) {
      expect(read(f), `${f} missing SPDX header`)
        .toContain("SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0");
    }
  });
});
