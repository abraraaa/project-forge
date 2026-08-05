// tests/indexnow.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The IndexNow ownership contract. Bing verifies us by fetching a text file
// named for the key whose CONTENTS are that same key — if the filename and
// the contents ever drift, every submission returns 403 and the failure is
// silent from our side (we'd see a status code, not a broken site). Cheap to
// pin, expensive to notice otherwise.
//
// Also pins the relative-import contract in app/sitemap.js: scripts/
// indexnow.mjs loads it under plain node, where the @/ alias does not exist.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import sitemap, { BASE } from "../app/sitemap.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_RE = /^[a-f0-9]{8,128}\.txt$/;

describe("IndexNow key file", () => {
  const keyFiles = readdirSync(join(root, "public")).filter((f) => KEY_RE.test(f));

  it("exists at the site root, exactly one of them", () => {
    expect(keyFiles).toHaveLength(1);
  });

  it("contains the key it is named for", () => {
    const [file] = keyFiles;
    const body = readFileSync(join(root, "public", file), "utf8").trim();
    expect(body).toBe(file.replace(/\.txt$/, ""));
  });

  it("is the key the submitter actually sends", () => {
    const [file] = keyFiles;
    const script = readFileSync(join(root, "scripts", "indexnow.mjs"), "utf8");
    expect(script).toContain(`const KEY = "${file.replace(/\.txt$/, "")}"`);
  });
});

describe("what we submit", () => {
  it("app/sitemap.js is loadable outside Next — the submitter depends on it", () => {
    // A @/ alias here would throw only when the script runs, which is exactly
    // when nobody is watching.
    const src = readFileSync(join(root, "app", "sitemap.js"), "utf8");
    expect(src).not.toMatch(/from ["']@\//);
    expect(typeof sitemap).toBe("function");
  });

  it("every URL is on the canonical host, or IndexNow 422s the whole batch", () => {
    const host = new URL(BASE).host;
    const foreign = sitemap().map((e) => e.url).filter((u) => new URL(u).host !== host);
    expect(foreign).toEqual([]);
  });

  it("submits the library, not just the app shell", () => {
    const urls = sitemap().map((e) => e.url);
    expect(urls.filter((u) => u.includes("/library/")).length).toBeGreaterThan(100);
  });

  it("stays inside IndexNow's 10,000-URL batch limit", () => {
    expect(sitemap().length).toBeLessThanOrEqual(10000);
  });
});

describe("the deployment-side route", () => {
  const routePath = join(root, "app", "api", "indexnow", "route.js");
  const src = readFileSync(routePath, "utf8");

  it("is POST-only — a GET could be fired by a prefetcher if the URL leaked", () => {
    expect(src).toMatch(/export async function POST/);
    expect(src).not.toMatch(/export async function GET/);
  });

  it("fails closed when CRON_SECRET is unset, and rejects a wrong bearer", () => {
    expect(src).toContain("CRON_SECRET not configured");
    expect(src).toMatch(/authorization[\s\S]{0,120}Bearer \$\{cronSecret\}/);
    expect(src).toContain("Unauthorized");
  });

  it("submits the sitemap's list, not a hand-kept copy", () => {
    expect(src).toMatch(/from "@\/app\/sitemap"/);
  });

  it("sends the same key the site hosts", () => {
    const [file] = readdirSync(join(root, "public")).filter((f) => KEY_RE.test(f));
    expect(src).toContain(`const KEY = "${file.replace(/\.txt$/, "")}"`);
  });

  it("is disallowed to crawlers along with the rest of /api", () => {
    const robots = readFileSync(join(root, "app", "robots.js"), "utf8");
    expect(robots).toMatch(/"\/api\/"/);
  });
});

describe("no standing authority", () => {
  it("submission is never wired into build or a cron", () => {
    // House rule: a scheduled job firing outward requests unattended is a
    // thing that misfires later, quietly. IndexNow runs when a human bumps
    // LIBRARY_REVISED and says so.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.postbuild).not.toMatch(/indexnow/);
    expect(pkg.scripts.build).not.toMatch(/indexnow/);
    const crons = join(root, "app", "api", "cron");
    for (const entry of readdirSync(crons, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = readFileSync(join(crons, entry.name, "route.js"), "utf8");
      expect(src, `${entry.name} cron must not submit to IndexNow`).not.toMatch(/indexnow/i);
    }
  });
});
