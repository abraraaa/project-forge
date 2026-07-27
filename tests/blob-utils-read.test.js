// tests/blob-utils-read.test.js
// ─────────────────────────────────────────────────────────────────────────────
// blob-utils READ path. The write path (writeJsonReplacingPrefix) is already
// covered by durability-fixes.test.js — audit #6, the write-then-delete order
// that stopped a mid-operation failure destroying every passkey. The read
// helpers had nothing.
//
// They matter because they FAIL SOFT BY DESIGN: every failure mode returns
// null, so a caller cannot tell "absent" from "corrupt" from "network died".
// That is a deliberate resilience choice (most misses are "blob doesn't exist
// yet"), but it means a regression here is invisible — a helper that started
// THROWING instead of returning null would take down auth ceremonies and
// snapshot reads with no local signal. Hence: pin every branch.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the SDK before importing the module under test.
const mockGet = vi.fn();
const mockList = vi.fn();
vi.mock("@vercel/blob", () => ({
  get: (...a) => mockGet(...a),
  list: (...a) => mockList(...a),
  put: vi.fn(),
  del: vi.fn(),
}));

const { readJsonDirect, readJsonByPrefix } = await import("../lib/blob-utils.js");

// Build a fake SDK result whose stream yields `text` in two chunks — the
// multi-chunk path is the one the manual reader loop actually has to get
// right (a single-chunk fixture would pass even if the loop were broken).
const streamOf = (text) => {
  const bytes = new TextEncoder().encode(text);
  const mid = Math.floor(bytes.length / 2);
  const parts = [bytes.slice(0, mid), bytes.slice(mid)];
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (i < parts.length ? { done: false, value: parts[i++] } : { done: true }),
    }),
  };
};
const ok = (text) => ({ statusCode: 200, stream: streamOf(text) });

beforeEach(() => {
  mockGet.mockReset();
  mockList.mockReset();
});

describe("readJsonDirect", () => {
  it("parses a JSON body reassembled across multiple stream chunks", async () => {
    const payload = { profile: "sarah", weights: { Squat: 100 }, nested: { deep: [1, 2, 3] } };
    mockGet.mockResolvedValue(ok(JSON.stringify(payload)));
    await expect(readJsonDirect("forge/x.json")).resolves.toEqual(payload);
    expect(mockGet).toHaveBeenCalledWith("forge/x.json", { access: "private" });
  });

  it("returns null when the blob is absent (get throws)", async () => {
    mockGet.mockRejectedValue(Object.assign(new Error("not found"), { name: "BlobNotFoundError" }));
    await expect(readJsonDirect("forge/missing.json")).resolves.toBeNull();
  });

  it("returns null on a non-200 status", async () => {
    mockGet.mockResolvedValue({ statusCode: 403, stream: streamOf("{}") });
    await expect(readJsonDirect("forge/forbidden.json")).resolves.toBeNull();
  });

  it("returns null when the SDK yields no stream", async () => {
    mockGet.mockResolvedValue({ statusCode: 200, stream: null });
    await expect(readJsonDirect("forge/x.json")).resolves.toBeNull();
  });

  it("returns null — never throws — on a corrupt JSON body", async () => {
    // The branch that matters most: a truncated or garbled blob must not
    // take down the calling route with an unhandled parse error.
    mockGet.mockResolvedValue(ok('{"weights": {"Squat": 10'));
    await expect(readJsonDirect("forge/corrupt.json")).resolves.toBeNull();
  });

  it("returns null when the stream dies mid-read", async () => {
    mockGet.mockResolvedValue({
      statusCode: 200,
      stream: { getReader: () => ({ read: async () => { throw new Error("socket reset"); } }) },
    });
    await expect(readJsonDirect("forge/flaky.json")).resolves.toBeNull();
  });
});

describe("readJsonByPrefix", () => {
  it("reads the MOST RECENT blob when several share a prefix", async () => {
    // Suffixed blobs accumulate; reading a stale one would serve outdated
    // credentials or challenges.
    mockList.mockResolvedValue({
      blobs: [
        { pathname: "forge/c-old.json",  uploadedAt: "2026-07-01T00:00:00Z" },
        { pathname: "forge/c-new.json",  uploadedAt: "2026-07-26T00:00:00Z" },
        { pathname: "forge/c-mid.json",  uploadedAt: "2026-07-10T00:00:00Z" },
      ],
    });
    mockGet.mockResolvedValue(ok(JSON.stringify({ which: "newest" })));

    await expect(readJsonByPrefix("forge/c")).resolves.toEqual({ which: "newest" });
    expect(mockGet).toHaveBeenCalledWith("forge/c-new.json", { access: "private" });
  });

  it("returns null when nothing matches the prefix", async () => {
    mockList.mockResolvedValue({ blobs: [] });
    await expect(readJsonByPrefix("forge/none")).resolves.toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("returns null when list() itself fails", async () => {
    mockList.mockRejectedValue(new Error("blob store unreachable"));
    await expect(readJsonByPrefix("forge/x")).resolves.toBeNull();
  });

  it("propagates the inner null when the newest blob is corrupt", async () => {
    mockList.mockResolvedValue({ blobs: [{ pathname: "forge/x-1.json", uploadedAt: "2026-07-26T00:00:00Z" }] });
    mockGet.mockResolvedValue(ok("not json at all"));
    await expect(readJsonByPrefix("forge/x")).resolves.toBeNull();
  });
});
