// tests/sw-precache.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The offline shell's build step (docs/offline-shell.md). buildPrecache parses
// the shell routes' PRERENDERED HTML for /_next/static references — exact by
// construction. These lock the extraction (incl. the escaped-JSON phantom
// trap), the manifest shape the SW consumes, and the missing-route signal that
// fails the build when a shell route is renamed away.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildPrecache, extractAssets, renderPrecacheModule, htmlFileFor, SHELL_ROUTES } from "../scripts/generate-sw-precache.mjs";

const html = (...assets) =>
  `<html><head>${assets.map((a) => `<script src="${a}"></script>`).join("")}</head></html>`;

describe("extractAssets", () => {
  it("finds unique /_next/static js+css refs", () => {
    const out = extractAssets(html("/_next/static/chunks/a.js", "/_next/static/css/x.css", "/_next/static/chunks/a.js"));
    expect(out).toEqual(["/_next/static/chunks/a.js", "/_next/static/css/x.css"]);
  });
  it("does NOT emit phantom entries from escaped-JSON refs (trailing backslash)", () => {
    // Inlined RSC payloads contain refs like "chunks/a.js\" — the strict
    // charset must stop before the backslash, deduping to the clean path.
    const doc = html("/_next/static/chunks/a.js") + `<script>self.__x="/_next/static/chunks/a.js\\"</script>`;
    expect(extractAssets(doc)).toEqual(["/_next/static/chunks/a.js"]);
  });
  it("ignores non-static and cross-origin refs", () => {
    expect(extractAssets(`<img src="/icon.png"><script src="https://cdn.x/y.js"></script>`)).toEqual([]);
  });
});

describe("buildPrecache", () => {
  const byRoute = Object.fromEntries(SHELL_ROUTES.map((r, i) => [r, html(`/_next/static/chunks/shared.js`, `/_next/static/chunks/r${i}.js`)]));

  it("unions across shell routes, deduped + sorted, with build id", () => {
    const m = buildPrecache(byRoute, "BUILD123");
    expect(m.version).toBe("BUILD123");
    expect(m.shellRoutes).toEqual(SHELL_ROUTES);
    expect(m.missingRoutes).toEqual([]);
    expect(m.assets.filter((a) => a.endsWith("shared.js"))).toHaveLength(1);
    expect(m.assets).toHaveLength(SHELL_ROUTES.length + 1);
    expect(m.assets).toEqual([...m.assets].sort());
  });

  it("reports a shell route with no HTML (build-failing signal)", () => {
    const broken = { ...byRoute };
    delete broken["/session"];
    expect(buildPrecache(broken, "B").missingRoutes).toEqual(["/session"]);
  });

  it("htmlFileFor maps routes to prerender filenames", () => {
    expect(htmlFileFor("/")).toBe("index.html");
    expect(htmlFileFor("/session")).toBe("session.html");
  });

  it("renderPrecacheModule emits the self.__FORGE_PRECACHE global, minus build-check fields", () => {
    const out = renderPrecacheModule(buildPrecache(byRoute, "B1"));
    expect(out).toMatch(/^\/\/ GENERATED/);
    expect(out).toContain("self.__FORGE_PRECACHE = {");
    expect(out).not.toContain("missingRoutes");
  });
});

describe("wiring", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  it("postbuild runs the generator and the output is gitignored", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(pkg.scripts.postbuild).toContain("generate-sw-precache");
    expect(readFileSync(resolve(root, ".gitignore"), "utf8")).toContain("public/sw-precache.js");
  });
  it("sw.js imports the manifest guardedly and prunes instead of wiping", () => {
    const sw = readFileSync(resolve(root, "public/sw.js"), "utf8");
    expect(sw).toContain('importScripts("/sw-precache.js")');
    expect(sw).toMatch(/forge-static-v1/);            // persistent, not version-suffixed
    expect(sw).not.toMatch(/forge-static-\$\{SW_VERSION\}/);
    expect(sw).toContain("ignoreSearch: true");       // RSC + nav fallbacks
  });
});

describe("#39 — update UX: waiting worker, safe promotion (code shape)", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sw = readFileSync(resolve(root, "public/sw.js"), "utf8");
  const reg = readFileSync(resolve(root, "components/ServiceWorkerRegistrar.jsx"), "utf8");

  it("sw.js never skipWaitings unconditionally — only on the SKIP_WAITING message", () => {
    const installBlock = sw.slice(sw.indexOf('addEventListener("install"'));
    expect(installBlock).not.toContain("self.skipWaiting()");
    const msgBlock = sw.slice(sw.indexOf('addEventListener("message"'), sw.indexOf('addEventListener("install"'));
    expect(msgBlock).toContain('type === "SKIP_WAITING"');
    expect(msgBlock).toContain("self.skipWaiting()");
  });

  it("the registrar promotes only when hidden AND no live session draft", () => {
    const promote = reg.slice(reg.indexOf("const promoteIfSafe"), reg.indexOf("const onVisibility"));
    expect(promote).toContain('visibilityState !== "hidden"');
    expect(promote).toContain("liveSessionDraft()");
    expect(promote).toContain('postMessage({ type: "SKIP_WAITING" })');
    // The draft guard is the ONLY place a workout blocks the swap; it must
    // consult the self-purging store, not a hand-rolled LS read.
    expect(reg).toContain("D.load(profile)");
  });

  it("long-lived tabs re-check for updates on visibility, throttled", () => {
    expect(reg).toContain("UPDATE_CHECK_MS");
    expect(reg).toMatch(/registration\?\.update\(\)/);
  });

  it("first-install never reloads; sibling-tab promotion still defers to hidden", () => {
    expect(reg).toContain("hadControllerAtStart");
    expect(reg).toContain("reloadIfHidden");
  });
});
