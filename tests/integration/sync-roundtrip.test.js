// tests/integration/sync-roundtrip.test.js
// ─────────────────────────────────────────────────────────────────────────────
// True integration test against Vercel Blob (parked → shipped).
//
// WHY THIS EXISTS: the addRandomSuffix bug (6ede9ee) was invisible to every
// client-side test — the writer and reader agreed on a broken path pattern,
// nothing threw, all tests passed, and the only signal was cross-device
// behaviour returning empty for every user. The unit suite can never catch
// that class of bug because it stubs the storage layer both sides. This
// suite calls the REAL route handlers in app/api/sync/route.js, which hit
// the REAL blob store, and asserts a PUT can be read back by a GET.
//
// GATING: requires BLOB_READ_WRITE_TOKEN. Without it (local dev, per-PR CI)
// every test is skipped — `npm test` stays green and token-free. With it,
// the suite writes under a unique throwaway profile name and deletes it in
// cleanup, so repeated runs don't pollute the store. Runs nightly via
// .github/workflows/nightly-sync-integration.yml rather than per-PR.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterAll } from "vitest";
import { GET, PUT, POST, DELETE } from "@/app/api/sync/route";

const HAS_TOKEN = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

// Unique per run so concurrent/nightly runs can't collide with each other
// or with any real profile. Passes the route's validateProfile rules
// (< 64 chars, no path separators / control chars).
const PROFILE = `it-roundtrip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const BASE = "http://localhost/api/sync";
const getReq    = (params) => new Request(`${BASE}?${new URLSearchParams(params)}`);
const jsonReq   = (method, body) =>
  new Request(BASE, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe.skipIf(!HAS_TOKEN)("sync round-trip against live Vercel Blob", () => {
  // Belt-and-braces: even if an assertion fails mid-suite, release the name.
  afterAll(async () => {
    try { await DELETE(getReq({ profile: PROFILE })); } catch { /* best effort */ }
  });

  it("GET for a never-written profile 404s (backgroundSync's hoist branch depends on this)", async () => {
    const res = await GET(getReq({ profile: PROFILE }));
    expect(res.status).toBe(404);
  });

  it("check=1 reports the name as free before claim, taken after", async () => {
    const before = await (await GET(getReq({ profile: PROFILE, check: "1" }))).json();
    expect(before.exists).toBe(false);

    const claim = await POST(jsonReq("POST", { profile: PROFILE, displayName: PROFILE }));
    expect(claim.status).toBe(200);
    expect((await claim.json()).claimed).toBe(true);

    const after = await (await GET(getReq({ profile: PROFILE, check: "1" }))).json();
    expect(after.exists).toBe(true);
  });

  it("re-claiming the same name 409s", async () => {
    const res = await POST(jsonReq("POST", { profile: PROFILE, displayName: PROFILE }));
    expect(res.status).toBe(409);
  });

  it("PUT-then-GET returns the exact payload written", async () => {
    const meta = {
      displayName: PROFILE,
      weights: { "Hex Bar Deadlift": 110 },
      reps: { "Hex Bar Deadlift": 5 },
      streak: { count: 3, lastDate: "2026-07-04" },
    };
    const history = [
      { id: "2026-07-01T10:00:00.000Z", date: "2026-07-01", type: "strength" },
      { id: "2026-07-03T10:00:00.000Z", date: "2026-07-03", type: "hiit" },
    ];

    const putRes = await PUT(jsonReq("PUT", { profile: PROFILE, data: { meta, history } }));
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.ok).toBe(true);
    expect(putBody.history.count).toBe(2);

    const got = await (await GET(getReq({ profile: PROFILE }))).json();
    // PUT stamps syncedAt into meta; everything else must round-trip exactly.
    const { syncedAt, ...metaBack } = got.meta;
    expect(typeof syncedAt).toBe("string");
    expect(metaBack).toEqual(meta);
    expect(got.history).toEqual(history);
  });

  it("case-insensitive profile resolution reads the same data back", async () => {
    const got = await (await GET(getReq({ profile: PROFILE.toUpperCase() }))).json();
    expect(got.meta.displayName).toBe(PROFILE);
  });

  it("second PUT merges history by record id instead of clobbering", async () => {
    const history = [
      // same id as an existing record — must not duplicate
      { id: "2026-07-03T10:00:00.000Z", date: "2026-07-03", type: "hiit" },
      // new record — must be added
      { id: "2026-07-05T10:00:00.000Z", date: "2026-07-05", type: "strength" },
    ];
    const putBody = await (await PUT(jsonReq("PUT", { profile: PROFILE, data: { history } }))).json();
    expect(putBody.history.count).toBe(3);

    const got = await (await GET(getReq({ profile: PROFILE }))).json();
    expect(got.history.map(r => r.id)).toEqual([
      "2026-07-01T10:00:00.000Z",
      "2026-07-03T10:00:00.000Z",
      "2026-07-05T10:00:00.000Z",
    ]);
  });

  it("DELETE releases the name; subsequent GET 404s", async () => {
    const del = await DELETE(getReq({ profile: PROFILE }));
    expect(del.status).toBe(200);
    expect((await del.json()).ok).toBe(true);

    const res = await GET(getReq({ profile: PROFILE }));
    expect(res.status).toBe(404);

    const check = await (await GET(getReq({ profile: PROFILE, check: "1" }))).json();
    expect(check.exists).toBe(false);
  });
});

// Always-on smoke: the handlers must at least be importable and reject bad
// input without a token — this half runs in the normal per-PR suite too.
describe("sync route input validation (token-free)", () => {
  it("GET without a profile 400s", async () => {
    const res = await GET(getReq({}));
    expect(res.status).toBe(400);
  });

  it("PUT with a path-separator profile 400s before any blob work", async () => {
    const res = await PUT(jsonReq("PUT", { profile: "a/b", data: { meta: {} } }));
    expect(res.status).toBe(400);
  });
});
