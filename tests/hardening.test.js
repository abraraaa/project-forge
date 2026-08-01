// tests/hardening.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Locks for the hardening batch (internal review, 2026-07-26).
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
    // The policy must constrain script execution, not only framing.
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

describe("one token store per deployment — the DB is authoritative", () => {
  const auth = read("lib/auth-server.js");

  it("the blob fallback is reachable ONLY when there is no DB", () => {
    // One authoritative store. A credential must not outlive the deletion
    // of the thing it authorises, so the fallback exists only where there is
    // no database to be authoritative in the first place.
    const fn = auth.slice(auth.indexOf("export async function readTokenData"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    const dbAt   = body.indexOf("if (hasDb())");
    const blobAt = body.indexOf("readJsonDirect(");
    expect(dbAt).toBeGreaterThan(-1);
    expect(blobAt).toBeGreaterThan(dbAt);          // fallback is AFTER the guard
    // ...and the DB branch must RETURN, never fall through to the blob.
    expect(body).toMatch(/if \(hasDb\(\)\)\s*\{\s*return[\s\S]{0,80}dbReadToken/);
  });

  it("mint and read agree on which store a deployment uses", () => {
    // Mint and read must agree on the store. Asymmetry here means valid
    // credentials are rejected while the gate's guarantees quietly weaken.
    const mint = auth.slice(auth.indexOf("export async function mintAuthToken"));
    expect(mint).toMatch(/if \(hasDb\(\)\)[\s\S]{0,200}dbInsertToken/);
    expect(mint).toMatch(/else[\s\S]{0,120}put\(`forge\/tokens\//);
  });
});

describe("admin wing fails closed in production", () => {
  const bugs = read("app/api/bugs/route.js");

  it("an unset ADMIN_PROFILE does not open the wing in production", () => {
    // Behaviour must not change as a side effect of an env-var being unset —
    // the 2026-07-09 failure shape. Unset means refuse, not open.
    expect(bugs).toMatch(/if \(!process\.env\.ADMIN_PROFILE\)/);
    expect(bugs).toMatch(/NODE_ENV === "production"[\s\S]{0,140}status: 403/);
  });

  it("admin is still derived from the TOKEN's profile, never the client", () => {
    expect(bugs).toContain("isAdminProfile(data.profile)");
  });
});

describe("credentials never ride URLs", () => {
  it("the wipe token is read from the header — and the query fallback is GONE", () => {
    // Credentials travel in headers only, so they cannot land in access logs
    // or Referer. Asserts both halves: header present, query absent.
    const route = read("app/api/sync/route.js");
    const del = route.slice(route.indexOf("export async function DELETE"));
    expect(del).toContain('request.headers.get("x-hw-auth")');
    expect(del).not.toContain('searchParams.get("authToken")');
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
    // One visible name must resolve to exactly one profile, and two
    // different profiles must never collapse onto one path.
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

describe("raw exception text never reaches the client", () => {
  // Neon/blob driver messages carry query fragments and schema names. The
  // routes now funnel every 5xx through a serverError() helper that logs the
  // detail server-side and returns a fixed generic string. Assert the LEAK
  // SHAPE is gone (`error: e.message` in a response) — not the substring
  // `e.message`, which still legitimately appears in server-side console.error.
  for (const f of ["app/api/sync/route.js", "app/api/photos/route.js"]) {
    it(`${f} funnels errors through serverError, not raw e.message`, () => {
      const s = read(f);
      expect(s).toContain("function serverError(");
      expect(s, "raw message must not be returned to the client")
        .not.toMatch(/error:\s*`?[^`\n]*\$\{?e\.message/);
      expect(s).not.toContain("error: e.message");
    });
  }
});

describe("unauthenticated bug intake is bounded before parse", () => {
  const bugs = read("app/api/bugs/route.js");
  it("caps the raw body and measures it as text, not post-parse", () => {
    // Open, unauthenticated intake. Reading text() and length-checking BEFORE
    // JSON.parse means a huge or chunked body is rejected 413 without ever
    // being buffered into an object.
    expect(bugs).toContain("await request.text()");
    expect(bugs).toMatch(/text\.length > \d/);
    expect(bugs).toContain("status: 413");
    expect(bugs.indexOf("request.text()")).toBeLessThan(bugs.indexOf("JSON.parse"));
  });
});

describe("the snapshot shrink-guard fails CLOSED on an unreadable prior", () => {
  const cron = read("app/api/cron/sync-snapshot/route.js");
  it("a prior that exists but won't read refuses the overwrite", () => {
    // readJsonDirect returns null for BOTH "no prior" and "read threw". A
    // transient read error must not disable the guard and clobber the restore
    // point — so when prior===null we LIST and, if the blob is really there,
    // guard rather than overwrite.
    expect(cron).toContain("import { put, list }");
    const guard = cron.slice(cron.indexOf("if (prior === null)"));
    expect(guard.slice(0, 400)).toContain("list({ prefix: dailyPath })");
    expect(guard.slice(0, 400)).toMatch(/guarded\.push\(profile\)[\s\S]{0,200}continue/);
  });
});

describe("hygiene", () => {
  const pkg = JSON.parse(read("package.json"));

  it("pins the Node major the CI, Vercel, and types all agree on", () => {
    // Moved 22 -> 24 (2026-07-27): Node 22 went to maintenance while 24 is
    // active LTS. engines.node is the SINGLE source of truth — Vercel reads
    // it and locks the production runtime to match (the dashboard shows it as
    // a non-editable override), so this one field moves prod, CI, and the
    // type-check target together. @types/node tracks the runtime major by
    // convention; a mismatch means tsc checks against APIs prod does not have
    // (the exact drift the 25-against-22 pin caused before).
    expect(pkg.engines?.node).toBe("24.x");
    expect(pkg.devDependencies["@types/node"]).toMatch(/^\^24\./);
  });

  it("carries no dependency the source never imports", () => {
    // playwright-core: genuinely unused (no import anywhere), removed in the
    // hygiene sweep and staying gone.
    expect(pkg.devDependencies, "playwright-core").not.toHaveProperty("playwright-core");
  });

  it("KEEPS babel-plugin-react-compiler while reactCompiler is enabled", () => {
    // Hard-won: the hygiene sweep removed this on the audit's (wrong) word
    // that Next 16 vendors the compiler itself. It does NOT — `reactCompiler:
    // true` in next.config.mjs needs the babel plugin resolvable, and the
    // production `next build` fails without it ("Failed to resolve package
    // babel-plugin-react-compiler"). Local builds hid it because a stale
    // node_modules still had the package; only a clean CI install surfaced
    // it. This lock ties the two together so the plugin can never be
    // "tidied away" again while the config still asks for it.
    const cfg = read("next.config.mjs");
    if (/reactCompiler:\s*true/.test(cfg)) {
      expect(pkg.devDependencies, "reactCompiler:true requires the babel plugin")
        .toHaveProperty("babel-plugin-react-compiler");
    }
  });

  it("the rejected staged manifest is gone, not lying in wait", () => {
    // The staged manifest carried a stale palette; the live manifest now
    // carries the Bone & Ember bone ground (light is the identity — the
    // launch splash and Android chrome read this value).
    expect(() => read("public/heatwayve/manifest-staged.webmanifest")).toThrow();
    expect(read("public/manifest.json")).toContain("#F2E9E3");
  });

  it("state-dependent routes stay out of the index", () => {
    expect(read("app/robots.js")).toContain("/locker-room");
  });
});
