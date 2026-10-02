// tests/photos.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Photos P1 locks. The privacy contract is the load-bearing part: photos are
// the one gated surface (the #20/#21 revisit trigger honoured), so the
// code-shape tests assert every route verb passes the token gate and that
// the token travels in a header, never a URL. Pure pipeline math (downscale
// dims, JPEG magic) is tested directly.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { NextRequest } from "next/server";
import { computeTargetDims, isJpegBytes, jpegDims, jpegWithinBounds, firstFitting, PHOTO_ENCODE_LADDER, PHOTO_MAX_EDGE, PHOTO_MAX_UPLOAD_BYTES } from "../lib/photos.js";

// DELETE behaviour: the index and Blob as in-memory maps, the gate's token
// lookup stubbed to one live identity. Only the route under test is real.
const mem = { rows: new Map(), blobs: new Map(), failDel: 0 };
vi.mock("@/lib/auth-server", () => ({
  readTokenData: vi.fn(async (t) => (t === "t" ? { scope: "photos" } : null)),
  resolveTokenIdentity: vi.fn(async (data) => (data ? { storageKey: "sam" } : null)),
  mintAuthToken: vi.fn(async () => null),
}));
vi.mock("@/lib/db", () => ({
  hasDb: () => true,
  dbUpsertPhoto: vi.fn(async () => {}),
  dbListPhotos: vi.fn(async () => []),
  dbHasRetiredPhotos: vi.fn(async () => false),
  dbGetPhoto: vi.fn(async (p, d) => mem.rows.get(`${p}|${d}`) || null),
  dbDeletePhoto: vi.fn(async (p, d) => mem.rows.delete(`${p}|${d}`)),
}));
vi.mock("@vercel/blob", () => ({
  put: vi.fn(async () => ({})),
  get: vi.fn(async () => null),
  list: vi.fn(async ({ prefix }) => ({
    blobs: [...mem.blobs.keys()].filter((p) => p.startsWith(prefix)).map((p) => ({ pathname: p, url: `https://blob/${p}` })),
  })),
  del: vi.fn(async (urls) => {
    if (mem.failDel > 0) { mem.failDel--; throw new Error("blob store unavailable"); }
    for (const u of [].concat(urls)) mem.blobs.delete(String(u).replace("https://blob/", ""));
  }),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => null }));

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

describe("isJpegBytes — SOI head AND EOI tail (2026-07-27 tightening)", () => {
  // A real JPEG opens FF D8 FF and closes FF D9. Checking both ends rejects
  // the "JPEG header stapled to an arbitrary payload" class (a zip/junk body
  // wearing a JPEG hat) without decoding anything.
  const jpeg = (...mid) => new Uint8Array([0xff, 0xd8, 0xff, ...mid, 0xff, 0xd9]);

  it("accepts a well-formed JPEG (SOI + EOI)", () => {
    expect(isJpegBytes(jpeg(0xe0, 0x00, 0x10))).toBe(true);
  });

  it("REJECTS a JPEG header with no EOI — the payload-smuggling case", () => {
    // This exact shape used to PASS (header-only check). It's a JPEG magic
    // number followed by arbitrary bytes that never terminate as a JPEG.
    expect(isJpegBytes(new Uint8Array([0xff, 0xd8, 0xff, 0x50, 0x4b, 0x03, 0x04]))).toBe(false); // ...PK.. (zip)
  });

  it("rejects non-JPEG and malformed inputs", () => {
    expect(isJpegBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false); // PNG
    expect(isJpegBytes(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(false);       // too short for a tail
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
    expect(src).toContain("resolveTokenIdentity(data, profile, Date.now())");
  });

  it("token travels in a header, never a URL", () => {
    expect(src).toContain('request.headers.get("x-hw-auth")');
    expect(src).not.toMatch(/searchParams\.get\(["'](token|key|auth)/);
  });

  it("date is regex-locked before path interpolation (no traversal)", () => {
    expect(src).toMatch(/DATE_RE\.test\(date\)/);
    // The interpolation lives in lib/storage-keys; the route only passes the locked date.
    expect(src).toContain("photoPath(g.profile, g.date)");
    expect(readFileSync(resolve(root, "lib/storage-keys.js"), "utf8")).toMatch(/\$\{date\}\.jpg/);
  });

  it("blob writes are private + deterministic; responses are private-cache", () => {
    expect(src).toContain('access: "private"');
    expect(src).toContain("allowOverwrite: true");
    expect(src).toContain('"Cache-Control": "private, max-age=3600"');
  });

  it("client sends the token as a header too", () => {
    const client = readFileSync(resolve(root, "lib/photos.js"), "utf8");
    expect(client).toContain('"X-HW-Auth"');
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
    expect(src).toContain("registerPasskey(profileName, null, { consent: consentClaim() })");
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
    // Invariant, not exact JSX: the raw preview URL must never reach src —
    // only the guarded value derived from it.
    expect(src).toMatch(/startsWith\("blob:"\)/);
    expect(src).toMatch(/src=\{\s*safePreviewUrl\s*\}/);
    expect(src).not.toMatch(/src=\{\s*previewUrl\s*\}/);
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
  it("auth session: TOKENS are memory-only; the only persistence is the admin-visibility hint", () => {
    const s = readFileSync(resolve(root, "lib/auth-session.js"), "utf8");
    expect(s).toContain("new Map()");
    // The lock's real contract (refined 2026-07-28 with the standalone
    // admin-hint fix): no token/credential material ever persists. The
    // adminHint is a boolean UI-visibility flag — it grants nothing and
    // every admin API re-verifies server-side. So: every localStorage use
    // in this file must be the adminHint key, and nothing else; no
    // sessionStorage or cookies at all.
    // One nesting level in the arg matcher: the key template contains
    // `${norm(profile)}`, whose inner parens would truncate a naive [^)]*.
    const lsUses = s.match(/localStorage\.[A-Za-z]+\((?:[^()]|\([^()]*\))*\)/g) || [];
    expect(lsUses.length).toBeGreaterThan(0);
    for (const use of lsUses) expect(use).toContain("adminHint");
    expect(s).not.toMatch(/sessionStorage\.|document\.cookie/);
    expect(s).not.toMatch(/localStorage\.setItem\([^)]*token/i); // a token can never ride this path
  });
  it("DELETE verb exists, gated, blob-first then index row", () => {
    const s = readFileSync(resolve(root, "app/api/photos/route.js"), "utf8");
    expect(s).toContain("export async function DELETE");
    const del = s.slice(s.indexOf("export async function DELETE"));
    expect(del).toContain("await gate(request)");
    expect(del.indexOf("del(exact")).toBeLessThan(del.indexOf("dbDeletePhoto"));
    // Still exactly one blob delete and one row delete.
    expect(del.match(/\bdel\(/g)).toHaveLength(1);
    expect(del.match(/dbDeletePhoto\(/g)).toHaveLength(1);
  });
  it("photo flows route through the cached ceremony, not raw authenticate", () => {
    const bw = readFileSync(resolve(root, "components/BodyweightEditModal.jsx"), "utf8");
    const scrub = readFileSync(resolve(root, "app/locker-room/page.jsx"), "utf8");
    expect(bw).toContain("getAuthTokenWithCeremony");
    expect(bw).not.toContain("authenticatePasskey(");
    expect(scrub).toContain("ensurePhotoAccess");
    const signin = readFileSync(resolve(root, "components/TakenNameModal.jsx"), "utf8");
    expect(signin).toContain("cacheAuthToken(name, result.authToken, { admin: !!result.admin })");
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
    expect(photos).toContain('request.cookies.get("hw_photos")');
    const sync = readFileSync(resolve(root, "app/api/sync/route.js"), "utf8");
    // Strengthened with J1 (2026-07-26): the wipe gate now rejects ANY scoped
    // token, not just the photo scope. The sync cookie is path-scoped to
    // /api/sync and DELETE lives there, so the browser attaches it to wipe
    // requests — a named-scope check would have admitted it.
    expect(sync).toMatch(/if \(tokenData\.scope\)/);
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

describe("jpegDims / jpegWithinBounds", () => {
  // SOI, APP0 (JFIF, 16 bytes), DQT stub, SOF0 w×h, SOS, EOI.
  const jpeg = (w, h, sof = 0xc0) => new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x00,
    0xff, sof, 0x00, 0x0b, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x02,
    0xff, 0xd9,
  ]);
  it("reads the frame header, baseline and progressive", () => {
    expect(jpegDims(jpeg(1536, 2048))).toEqual({ width: 1536, height: 2048 });
    expect(jpegDims(jpeg(800, 600, 0xc2))).toEqual({ width: 800, height: 600 });
  });
  it("accepts what the client produces and refuses anything larger", () => {
    expect(jpegWithinBounds(jpeg(PHOTO_MAX_EDGE, 1536))).toBe(true);
    expect(jpegWithinBounds(jpeg(PHOTO_MAX_EDGE + 1, 10))).toBe(false);
    expect(jpegWithinBounds(jpeg(60000, 60000))).toBe(false);
  });
  it("refuses a stream with no frame header or a zero dimension", () => {
    expect(jpegDims(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]))).toBeNull();
    expect(jpegDims(jpeg(0, 100))).toBeNull();
    expect(jpegDims(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});

describe("firstFitting — size steps down, never refuses", () => {
  const fake = (sizes) => {
    const seen = [];
    return { seen, encode: async (step) => { seen.push(step); return { size: sizes[seen.length - 1] }; } };
  };
  it("keeps the best encode when it fits", async () => {
    const f = fake([500_000]);
    expect((await firstFitting(PHOTO_ENCODE_LADDER, f.encode))?.size).toBe(500_000);
    expect(f.seen).toHaveLength(1);
  });
  it("steps down until one fits", async () => {
    const big = PHOTO_MAX_UPLOAD_BYTES + 1;
    const f = fake([big, big, 900_000]);
    expect((await firstFitting(PHOTO_ENCODE_LADDER, f.encode))?.size).toBe(900_000);
    expect(f.seen[2]).toEqual(PHOTO_ENCODE_LADDER[2]);
  });
  it("null only when encoding itself fails", async () => {
    expect(await firstFitting(PHOTO_ENCODE_LADDER, async () => null)).toBeNull();
  });
  it("every step stays within the server's accepted edge", () => {
    for (const s of PHOTO_ENCODE_LADDER) expect(s.edge).toBeLessThanOrEqual(PHOTO_MAX_EDGE);
    expect(PHOTO_ENCODE_LADDER[0]).toEqual({ edge: PHOTO_MAX_EDGE, quality: 0.85 });
  });
});

describe("photos DELETE is retry-safe", () => {
  const PATH = "forge/profiles/sam/photos/2026-09-01.jpg";
  const req = () => new NextRequest("https://heatwayve.app/api/photos?profile=sam&date=2026-09-01", { method: "DELETE", headers: { "x-hw-auth": "t" } });
  let photos;
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mem.rows = new Map([["sam|2026-09-01", { blob_path: PATH }]]);
    mem.blobs = new Map([[PATH, "x"]]);
    mem.failDel = 0;
    photos = await import("@/app/api/photos/route");
  });

  it("a failed blob delete keeps the index row and returns 500", async () => {
    mem.failDel = 1;
    const res = await photos.DELETE(req());
    expect(res.status).toBe(500);
    expect(mem.rows.has("sam|2026-09-01")).toBe(true);
    expect(mem.blobs.has(PATH)).toBe(true);
  });

  it("a retry after the failure removes both blob and row", async () => {
    mem.failDel = 1;
    expect((await photos.DELETE(req())).status).toBe(500);
    const res = await photos.DELETE(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: "2026-09-01" });
    expect(mem.blobs.has(PATH)).toBe(false);
    expect(mem.rows.has("sam|2026-09-01")).toBe(false);
  });

  it("a retry after the blob went but the row stayed clears the row", async () => {
    mem.blobs.clear();
    const res = await photos.DELETE(req());
    expect(res.status).toBe(200);
    expect(mem.rows.has("sam|2026-09-01")).toBe(false);
  });
});
