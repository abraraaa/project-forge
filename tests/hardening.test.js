// tests/hardening.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Locks for the hardening batch (deep audit 2026-07-26, docs/audit-2026-07-*).
// Each of these is a posture that is easy to weaken accidentally and hard to
// notice once weakened — which is why they are pinned rather than trusted.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isTokenValid } from "../lib/auth-server.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(resolve(root, f), "utf8");

describe("CSP — a real allow-list, not a framing-only gesture", () => {
  const cfg = read("next.config.mjs");

  it("constrains scripts at all (the whole point of the tightening)", () => {
    // Before: `frame-ancestors 'none'; object-src 'none'; base-uri 'self'`
    // with no default-src and no script-src, so scripts were unconstrained
    // and the policy offered zero XSS containment.
    expect(cfg).toContain("default-src 'self'");
    expect(cfg).toContain("script-src 'self' 'unsafe-inline'");
  });

  it("names YouTube explicitly and nothing else external", () => {
    // The exercise embeds are the ONLY external resource in the app. If a
    // second host ever appears here it should be a deliberate decision, not
    // a copy-paste from a template.
    expect(cfg).toContain("frame-src https://www.youtube.com");
    const frameSrc = cfg.match(/"frame-src ([^"]+)"/)?.[1] || "";
    expect(frameSrc.split(/\s+/).filter((t) => t.startsWith("http")))
      .toEqual(["https://www.youtube.com"]);
  });

  it("keeps the classic escapes shut", () => {
    for (const d of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
      expect(cfg, d).toContain(d);
    }
  });

  it("img-src permits the app's own blob/data URLs", () => {
    // Photo object URLs are blob:; the share card is a data: canvas export.
    // Losing these breaks the Locker Room and sharing, silently.
    expect(cfg).toContain("img-src 'self' data: blob:");
  });

  it("asserts HSTS in-repo rather than assuming a platform default", () => {
    expect(cfg).toContain("Strict-Transport-Security");
    expect(cfg).toContain("max-age=63072000; includeSubDomains");
    // NOT preloaded — effectively irreversible, and it would bind every
    // subdomain of both domains to HTTPS forever. Assert the HEADER VALUE
    // rather than the file: the comment above the header explains the
    // decision and contains the word, and a lock that trips on its own
    // documentation gets "fixed" by deleting the documentation.
    const hsts = cfg.match(/"Strict-Transport-Security", value: "([^"]+)"/)?.[1] || "";
    expect(hsts).not.toContain("preload");
  });
});

describe("token scope fails closed by default", () => {
  const auth = read("lib/auth-server.js");

  it("verifyAuthToken rejects a scoped token unless the caller opts in", () => {
    expect(auth).toMatch(/tokenData\.scope && tokenData\.scope !== allowScope/);
    expect(auth).toContain("allowScope = null");
  });

  it("isTokenValid stays scope-blind on purpose — the gates decide", () => {
    // Documented so nobody 'fixes' this by adding scope logic here and
    // quietly changing every caller's meaning at once.
    const now = Date.now();
    const scoped = { profile: "sarah", expires: now + 1000, scope: "photos" };
    expect(isTokenValid(scoped, "sarah", now)).toBe(true);
  });
});

describe("admin wing fails closed in production", () => {
  const bugs = read("app/api/bugs/route.js");

  it("an unset ADMIN_PROFILE does not open the wing in production", () => {
    // The old shape (`env && !isAdmin`) meant an absent/mistyped var silently
    // admitted ANY passkey holder — behaviour changing as a side effect of an
    // env-var state, which is the 2026-07-09 failure shape exactly.
    expect(bugs).toMatch(/if \(!process\.env\.ADMIN_PROFILE\)/);
    expect(bugs).toMatch(/NODE_ENV === "production"[\s\S]{0,140}status: 403/);
  });

  it("admin is still derived from the TOKEN's profile, never the client", () => {
    expect(bugs).toContain("isAdminProfile(data.profile)");
  });
});

describe("credentials never ride URLs", () => {
  it("the wipe token is read from the header first", () => {
    const route = read("app/api/sync/route.js");
    const del = route.slice(route.indexOf("export async function DELETE"));
    expect(del).toContain('request.headers.get("x-hw-auth")');
  });

  it("the client sends it as a header, not a query param", () => {
    const storage = read("lib/storage.js");
    const fn = storage.slice(storage.indexOf("export async function blobDelete"));
    expect(fn.slice(0, 900)).toContain('"X-HW-Auth"');
    expect(fn.slice(0, 900)).not.toContain("&authToken=");
  });
});

describe("profile names cannot be path fragments or homoglyph collisions", () => {
  const route = read("app/api/sync/route.js");

  it("NFKC-normalises before lowercasing", () => {
    // Without it, U+212A (Kelvin) lowercases to "k" and collapses onto
    // another profile's path, while NFC/NFD variants of the same visible
    // name resolve to DIFFERENT profiles.
    expect(route).toContain('.normalize("NFKC")');
  });

  it("rejects dot-only names", () => {
    expect(route).toMatch(/\^\\\.\+\$/);
    expect(route).toContain("Profile name cannot be dots");
  });
});

describe("sliding cookies cannot renew themselves forever", () => {
  it("both cookies cap rotation against the ORIGINAL ceremony", () => {
    for (const [f, cap] of [
      ["app/api/photos/route.js", "PHOTO_ABSOLUTE_CAP_MS"],
      ["app/api/sync/route.js", "SYNC_ABSOLUTE_CAP_MS"],
    ]) {
      const s = read(f);
      expect(s, f).toContain(cap);
      // authAt is carried forward through rotation; createdAt resets, so
      // measuring the cap against createdAt would never trigger.
      expect(s, f).toContain("data.authAt");
      expect(s, f).toMatch(/authAt: data\.authAt \|\| data\.createdAt \|\| null/);
    }
  });

  it("mintAuthToken preserves an inherited authAt rather than re-stamping", () => {
    expect(read("lib/auth-server.js")).toContain("authAt: authAt || new Date().toISOString()");
  });
});

describe("hygiene", () => {
  const pkg = JSON.parse(read("package.json"));

  it("pins the Node major the CI and types agree on", () => {
    expect(pkg.engines?.node).toBe("22.x");
    // @types/node tracks Node's major by convention; it was pinned at 25.x
    // against a Node 22 runtime, so tsc was checking against APIs that do
    // not exist in production.
    expect(pkg.devDependencies["@types/node"]).toMatch(/^\^22\./);
  });

  it("carries no dependency the source never imports", () => {
    for (const dead of ["babel-plugin-react-compiler", "playwright-core"]) {
      expect(pkg.devDependencies, dead).not.toHaveProperty(dead);
    }
  });

  it("the rejected staged manifest is gone, not lying in wait", () => {
    // It carried the raw #131110 that lost to the grain-lifted #1D1A19.
    // A stale to-do pointing at it was a regression waiting for a tidy-up.
    expect(() => read("public/heatwayve/manifest-staged.webmanifest")).toThrow();
    expect(read("public/manifest.json")).toContain("#1D1A19");
  });

  it("state-dependent routes stay out of the index", () => {
    expect(read("app/robots.js")).toContain("/locker-room");
  });
});
