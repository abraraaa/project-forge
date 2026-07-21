// tests/photos.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Photos P1 locks. The privacy contract is the load-bearing part: photos are
// the one gated surface (the #20/#21 revisit trigger honoured), so the
// code-shape tests assert every route verb passes the token gate and that
// the token travels in a header, never a URL. Pure pipeline math (downscale
// dims, JPEG magic) is tested directly.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { computeTargetDims, isJpegBytes, PHOTO_MAX_EDGE } from "../lib/photos.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("computeTargetDims", () => {
  it("downscales the LONG edge to the cap, preserving aspect", () => {
    expect(computeTargetDims(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(computeTargetDims(3024, 4032)).toEqual({ width: 1536, height: 2048 });
  });
  it("never upscales", () => {
    expect(computeTargetDims(800, 600)).toEqual({ width: 800, height: 600 });
    expect(computeTargetDims(PHOTO_MAX_EDGE, PHOTO_MAX_EDGE)).toEqual({ width: PHOTO_MAX_EDGE, height: PHOTO_MAX_EDGE });
  });
  it("rejects degenerate inputs", () => {
    expect(computeTargetDims(0, 100)).toEqual({ width: 0, height: 0 });
    expect(computeTargetDims(-1, 100)).toEqual({ width: 0, height: 0 });
  });
});

describe("isJpegBytes", () => {
  it("accepts a JPEG SOI header, rejects others", () => {
    expect(isJpegBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isJpegBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false); // PNG
    expect(isJpegBytes(new Uint8Array([]))).toBe(false);
    expect(isJpegBytes(null)).toBe(false);
  });
});

describe("photos route — privacy contract (code shape)", () => {
  const src = readFileSync(resolve(root, "app/api/photos/route.js"), "utf8");

  it("every exported verb runs the token gate", () => {
    const verbs = src.match(/export async function (GET|POST|PUT|DELETE)/g) || [];
    expect(verbs.length).toBeGreaterThanOrEqual(2);
    // Each handler body must call gate() before doing work.
    expect((src.match(/await gate\(request\)/g) || []).length).toBe(verbs.length);
    expect(src).toContain("readTokenData");
    expect(src).toContain("isTokenValid");
  });

  it("token travels in a header, never a URL", () => {
    expect(src).toContain('request.headers.get("x-forge-auth")');
    expect(src).not.toMatch(/searchParams\.get\(["'](token|key|auth)/);
  });

  it("date is regex-locked before path interpolation (no traversal)", () => {
    expect(src).toMatch(/DATE_RE\.test\(date\)/);
    expect(src).toMatch(/\$\{date\}\.jpg/);
  });

  it("blob writes are private + deterministic; responses are private-cache", () => {
    expect(src).toContain('access: "private"');
    expect(src).toContain("allowOverwrite: true");
    expect(src).toContain('"Cache-Control": "private, max-age=3600"');
  });

  it("client sends the token as a header too", () => {
    const client = readFileSync(resolve(root, "lib/photos.js"), "utf8");
    expect(client).toContain('"X-Forge-Auth"');
    expect(client).not.toMatch(/[?&]token=/);
  });
});

describe("P2 capture flow — morphing-sheet contract (code shape)", () => {
  const src = readFileSync(resolve(root, "components/BodyweightEditModal.jsx"), "utf8");

  it("ONE sheet only — the flow morphs, it never stacks scrims", () => {
    expect((src.match(/forge-scrim/g) || []).length).toBe(1);
    expect(src).toMatch(/weight → offer → \[secure\] → camera → done|weight → offer → secure → camera → done/);
  });

  it("the weight saves BEFORE any photo step (never held hostage)", () => {
    const confirmIdx = src.indexOf("const confirmWeight");
    const body = src.slice(confirmIdx, src.indexOf("}", src.indexOf('setStep("offer")')));
    expect(body.indexOf("onSave(kg)")).toBeGreaterThan(-1);
    expect(body.indexOf("onSave(kg)")).toBeLessThan(body.indexOf('setStep("offer")'));
  });

  it("passkey-less users get INLINE setup then continue (recruitment, not refusal)", () => {
    expect(src).toContain("registerPasskey(profileName)");
    expect(src).toContain("getAuthTokenWithCeremony(profileName)");
    expect(src).toMatch(/has === false.*setStep\("secure"\)/s);
  });

  it("upload is anchored to the local calendar day with the weight attached", () => {
    expect(src).toContain("todayLocalIso()");
    expect(src).toContain("bodyweightAt: kg");
  });

  it("copy is centralised and flagged for the boss pass; decline is one tap", () => {
    expect(src).toMatch(/COPY.*boss pass/i);
    expect(src).toContain("offerNo");
  });

  it("all three call sites thread profileName", () => {
    for (const f of ["components/ProfileScreen.jsx", "components/ForgeApp.jsx", "components/SessionHost.jsx"]) {
      const caller = readFileSync(resolve(root, f), "utf8");
      expect(caller, f).toMatch(/<BodyweightEditModal[^/]*profileName=/s);
    }
  });
});

describe("P2 preview safety (scanner finding, 2026-07-20)", () => {
  const src = readFileSync(resolve(root, "components/BodyweightEditModal.jsx"), "utf8");
  it("img src renders only through the blob:-invariant guard", () => {
    expect(src).toMatch(/startsWith\("blob:"\)/);
    expect(src).toContain("src={safePreviewUrl}");
    expect(src).not.toContain("src={previewUrl}");
  });
  it("non-image picks are rejected before preview or upload", () => {
    expect(src).toMatch(/f\.type\.startsWith\("image\/"\)/);
  });
});

describe("P3/P5 Locker Room scrubber (code shape)", () => {
  const src = readFileSync(resolve(root, "app/locker-room/page.jsx"), "utf8");
  it("is a diag route gated by the passkey ceremony — no ungated photo fetch", () => {
    expect(src).toContain("ensurePhotoAccess");
    // Every photo fetch call threads a token argument.
    expect(src).not.toMatch(/fetchPhotoIndex\(profile\s*\)/);
    expect(src).toMatch(/fetchPhotoObjectUrl\(profile, tok/);
    // Fail-modest: photos never render unless the toggle was used this visit.
    expect(src).toContain("const photosVisible = shown && photos !== null");
  });
  it("crossfades under the finger and snaps with the settle haptic", () => {
    expect(src).toMatch(/opacity: 1 - frac/);
    expect(src).toMatch(/opacity: frac/);
    expect(src).toContain("haptic.settle()");
  });
  it("revokes minted object URLs on unload", () => {
    expect(src).toContain("revokeObjectURL");
  });
});

describe("P4 — session tokens, delete verb, scrubber additions (code shape)", () => {
  it("auth session is memory-only (no persistence of tokens)", () => {
    const s = readFileSync(resolve(root, "lib/auth-session.js"), "utf8");
    expect(s).toContain("new Map()");
    expect(s).not.toMatch(/localStorage\.|sessionStorage\.|document\.cookie/); // API use, not the comment
  });
  it("DELETE verb exists, gated, index-row-first", () => {
    const s = readFileSync(resolve(root, "app/api/photos/route.js"), "utf8");
    expect(s).toContain("export async function DELETE");
    const del = s.slice(s.indexOf("export async function DELETE"));
    expect(del).toContain("await gate(request)");
    expect(del.indexOf("dbDeletePhoto")).toBeLessThan(del.indexOf("del(exact"));
  });
  it("photo flows route through the cached ceremony, not raw authenticate", () => {
    const bw = readFileSync(resolve(root, "components/BodyweightEditModal.jsx"), "utf8");
    const scrub = readFileSync(resolve(root, "app/locker-room/page.jsx"), "utf8");
    expect(bw).toContain("getAuthTokenWithCeremony");
    expect(bw).not.toContain("authenticatePasskey(");
    expect(scrub).toContain("ensurePhotoAccess");
    const signin = readFileSync(resolve(root, "components/TakenNameModal.jsx"), "utf8");
    expect(signin).toContain("cacheAuthToken(name, result.authToken)");
  });
  it("scrubber: pre-photo state is the bodyweight chart; delete is behind a confirm", () => {
    const s = readFileSync(resolve(root, "app/locker-room/page.jsx"), "utf8");
    expect(s).toMatch(/photos\.length === 0/);
    expect(s).toContain("Hide photos");
    expect(s).toContain("bwChart(photosVisible ? 90 : 150)");
    expect(s).toContain("confirmDelete");
    expect(s).toContain("deletePhoto(profile, token, cur.date)");
  });
});

describe("P5 — the sliding 7-day photo cookie (code shape)", () => {
  it("login-verify mints a 7-day photo-scope token and sets a hardened, path-scoped cookie", () => {
    const s = readFileSync(resolve(root, "app/api/auth/login-verify/route.js"), "utf8");
    expect(s).toContain('scope: "photos"');
    expect(s).toContain("7 * 86400000");
    expect(s).toMatch(/httpOnly: true, secure: true, sameSite: "strict", path: "\/api\/photos"/);
  });
  it("the photos gate SLIDES the window: rotates cookie-carried tokens on active use", () => {
    const s = readFileSync(resolve(root, "app/api/photos/route.js"), "utf8");
    expect(s).toContain("ROTATE_AFTER_MS");
    expect(s).toMatch(/data\.scope === "photos" && token === cookieToken/);
    expect(s).toContain("withCookie");
    // Old records lapse naturally — the rotation path must not delete tokens.
    const gateBlock = s.slice(s.indexOf("async function gate"), s.indexOf("export async function POST"));
    expect(gateBlock).not.toContain("del(");
  });
  it("the photos gate accepts header OR cookie; sync wipe REJECTS photo-scope tokens", () => {
    const photos = readFileSync(resolve(root, "app/api/photos/route.js"), "utf8");
    expect(photos).toContain('request.cookies.get("forge_photos")');
    const sync = readFileSync(resolve(root, "app/api/sync/route.js"), "utf8");
    expect(sync).toMatch(/tokenData\.scope === "photos"/);
  });
});

describe("Modal consistency (boss, 2026-07-21) — bottom-row Cancel, no corner X", () => {
  it("BodyweightEditModal has no corner close and a bottom Cancel row", () => {
    const s = readFileSync(resolve(root, "components/BodyweightEditModal.jsx"), "utf8");
    expect(s).not.toContain('aria-label="Close"');
    expect(s).toMatch(/Cancel<\/button>/);
  });
});

describe("House pattern — no corner-close buttons anywhere (boss, 2026-07-21)", () => {
  it("sheets close from the bottom row, never a corner ✕", () => {
    const { readdirSync } = require("node:fs");
    const offenders = [];
    for (const dir of ["components", "app"]) {
      const walk = (d) => {
        for (const f of readdirSync(resolve(root, d), { withFileTypes: true })) {
          const rel = `${d}/${f.name}`;
          if (f.isDirectory()) walk(rel);
          else if (/\.(jsx|js)$/.test(f.name) && readFileSync(resolve(root, rel), "utf8").includes('aria-label="Close"')) offenders.push(rel);
        }
      };
      walk(dir);
    }
    expect(offenders, `corner-close buttons found (use a bottom-row Cancel): ${offenders.join(", ")}`).toEqual([]);
  });
});
