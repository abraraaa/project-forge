// The photos gate admits a ceremony token (unscoped) or the photo cookie's own
// scope, and refuses every other scope (sync, trainer, anything new) with the
// existing 401 on every verb, before any index read, Blob call or token mint.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Token string -> stored record. "t-none" is a fresh ceremony token.
const TOKENS = {
  "t-none": {},
  "t-photos": { scope: "photos" },
  "t-sync": { scope: "sync" },
  "t-trainer": { scope: "trainer", credentialId: "cred-1" },
  "t-other": { scope: "trainer:read" },
};
const PATH = "forge/profiles/sam/photos/2026-09-01.jpg";
const calls = [];
const track = (name, fn) => vi.fn(async (...a) => { calls.push(name); return fn(...a); });

vi.mock("@/lib/auth-server", () => ({
  readTokenData: vi.fn(async (t) => {
    const rec = TOKENS[t];
    return rec ? { profile: "sam", accountId: "hwa_sam", expires: Date.now() + 60000, createdAt: new Date().toISOString(), ...rec } : null;
  }),
  resolveTokenIdentity: vi.fn(async (data) => (data ? { accountId: "hwa_sam", storageKey: "sam" } : null)),
  mintAuthToken: track("mintAuthToken", () => "rotated"),
}));
vi.mock("@/lib/db", () => ({
  hasDb: () => true,
  dbUpsertPhoto: track("dbUpsertPhoto", () => {}),
  dbListPhotos: track("dbListPhotos", () => []),
  dbHasRetiredPhotos: track("dbHasRetiredPhotos", () => false),
  dbGetPhoto: track("dbGetPhoto", () => ({ blob_path: PATH })),
  dbDeletePhoto: track("dbDeletePhoto", () => {}),
}));
vi.mock("@vercel/blob", () => ({
  put: track("put", () => ({})),
  get: track("get", () => ({ statusCode: 200, stream: new ReadableStream({ start(c) { c.close(); } }) })),
  list: track("list", () => ({ blobs: [{ pathname: PATH, url: `https://blob/${PATH}` }] })),
  del: track("del", () => {}),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => null }));

const photos = await import("@/app/api/photos/route");

// A minimal well-formed 800x600 JPEG (SOI, APP0, DQT stub, SOF0, SOS, EOI).
const JPEG = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xdb, 0x00, 0x04, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x58, 0x03, 0x20, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x02,
  0xff, 0xd9,
]);

const BASE = "https://heatwayve.app/api/photos?profile=sam";
const auth = (token, via) => (via === "cookie" ? { cookie: `hw_photos=${token}` } : { "x-hw-auth": token });
const VERBS = {
  "POST": (h) => photos.POST(new NextRequest(`${BASE}&date=2026-09-01`, { method: "POST", headers: h, body: JPEG })),
  "GET index": (h) => photos.GET(new NextRequest(BASE, { headers: h })),
  "GET image": (h) => photos.GET(new NextRequest(`${BASE}&date=2026-09-01`, { headers: h })),
  "DELETE": (h) => photos.DELETE(new NextRequest(`${BASE}&date=2026-09-01`, { method: "DELETE", headers: h })),
};

beforeEach(() => {
  calls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("photos gate refuses other scopes", () => {
  for (const token of ["t-sync", "t-trainer", "t-other"]) {
    for (const via of ["header", "cookie"]) {
      for (const [verb, run] of Object.entries(VERBS)) {
        it(`${TOKENS[token].scope} token by ${via}: ${verb} is 401 before any read or write`, async () => {
          const res = await run(auth(token, via));
          expect(res.status).toBe(401);
          expect(await res.json()).toEqual({ error: "Passkey authentication required", requiresAuth: true });
          expect(res.headers.get("set-cookie")).toBeNull();
          expect(calls).toEqual([]);
        });
      }
    }
  }
});

describe("photos gate still admits what it admits today", () => {
  const admitted = [["t-none", "header"], ["t-photos", "header"], ["t-photos", "cookie"]];
  for (const [token, via] of admitted) {
    const label = `${TOKENS[token].scope || "unscoped"} token by ${via}`;
    it(`${label}: POST writes the photo`, async () => {
      const res = await VERBS.POST(auth(token, via));
      expect(res.status).toBe(200);
      expect(calls).toEqual(expect.arrayContaining(["put", "dbUpsertPhoto"]));
    });
    it(`${label}: GET index lists`, async () => {
      const res = await VERBS["GET index"](auth(token, via));
      expect(res.status).toBe(200);
      expect(calls).toEqual(expect.arrayContaining(["dbListPhotos"]));
    });
    it(`${label}: GET image serves`, async () => {
      const res = await VERBS["GET image"](auth(token, via));
      expect(res.status).toBe(200);
      expect(calls).toEqual(expect.arrayContaining(["dbGetPhoto", "get"]));
    });
    it(`${label}: DELETE removes the one photo`, async () => {
      const res = await VERBS.DELETE(auth(token, via));
      expect(res.status).toBe(200);
      expect(calls).toEqual(expect.arrayContaining(["dbGetPhoto", "del", "dbDeletePhoto"]));
    });
  }
});
