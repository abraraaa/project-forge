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
    expect(src).toContain("verifyAuthToken");
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
    expect(src).toContain("authenticatePasskey(profileName)");
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
