// tests/lint-scope.test.js
// The live service worker is linted; the generated precache manifest is not.

import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("lint scope under public/", () => {
  const eslint = new ESLint({ cwd: root });

  it("public/sw.js is linted, with worker-scope globals", async () => {
    expect(await eslint.isPathIgnored(resolve(root, "public/sw.js"))).toBe(false);
    const cfg = await eslint.calculateConfigForFile(resolve(root, "public/sw.js"));
    expect(cfg.languageOptions.globals).toMatchObject({ importScripts: "readonly", clients: "readonly" });
  });

  it("the generated precache manifest and other public files stay ignored", async () => {
    expect(await eslint.isPathIgnored(resolve(root, "public/sw-precache.js"))).toBe(true);
    expect(await eslint.isPathIgnored(resolve(root, "public/manifest.json"))).toBe(true);
  });
});
