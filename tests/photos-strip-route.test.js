// POST /api/photos stores the upload with its metadata segments stripped, and
// refuses a malformed segment table with the route's existing 415.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  SOI, EOI, APP0_JFIF, DQT, SOF0, DHT, SOS, SCAN, APP1_EXIF_GPS, APP1_XMP,
  GPS_RATIONALS, CLEAN, indexOfBytes, headerMarkers,
} from "./fixtures/jpeg-segments.js";

const stored = [];
vi.mock("@/lib/auth-server", () => ({
  readTokenData: vi.fn(async (t) => (t === "t-none" ? { profile: "sam", accountId: "hwa_sam", expires: Date.now() + 60000, createdAt: new Date().toISOString() } : null)),
  resolveTokenIdentity: vi.fn(async (data) => (data ? { accountId: "hwa_sam", storageKey: "sam" } : null)),
  mintAuthToken: vi.fn(async () => "rotated"),
}));
vi.mock("@/lib/db", () => ({
  hasDb: () => true,
  dbUpsertPhoto: vi.fn(async () => {}),
  dbListPhotos: vi.fn(async () => []),
  dbHasRetiredPhotos: vi.fn(async () => false),
  dbGetPhoto: vi.fn(async () => null),
  dbDeletePhoto: vi.fn(async () => {}),
}));
vi.mock("@vercel/blob", () => ({
  put: vi.fn(async (path, body) => { stored.push({ path, body: new Uint8Array(body) }); return {}; }),
  get: vi.fn(),
  list: vi.fn(),
  del: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => null }));

const photos = await import("@/app/api/photos/route");
const post = (body) => photos.POST(new NextRequest("https://heatwayve.app/api/photos?profile=sam&date=2026-09-01", {
  method: "POST", headers: { "x-hw-auth": "t-none" }, body,
}));

beforeEach(() => {
  stored.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("photo upload strips metadata on the server", () => {
  it("a direct POST carrying Exif GPS and XMP is stored without any APP1", async () => {
    const camera = new Uint8Array([...SOI, ...APP0_JFIF, ...APP1_EXIF_GPS, ...APP1_XMP, ...DQT, ...SOF0, ...DHT, ...SOS, ...SCAN, ...EOI]);
    const res = await post(camera);
    expect(res.status).toBe(200);
    expect(stored).toHaveLength(1);
    const body = stored[0].body;
    expect(headerMarkers(body)).not.toContain(0xe1);
    expect(indexOfBytes(body, GPS_RATIONALS)).toBe(-1);
    expect(body).toEqual(CLEAN());
  });

  it("a client-prepared JPEG is stored byte for byte", async () => {
    const res = await post(CLEAN());
    expect(res.status).toBe(200);
    expect(stored[0].body).toEqual(CLEAN());
  });

  it("a malformed segment table behind a valid frame header is refused, nothing stored", async () => {
    const broken = new Uint8Array([...SOI, ...APP0_JFIF, ...SOF0, 0x00, 0x00, ...SOS, ...SCAN, ...EOI]);
    const res = await post(broken);
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "Not a JPEG" });
    expect(stored).toHaveLength(0);
  });
});
