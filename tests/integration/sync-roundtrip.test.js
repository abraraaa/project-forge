// tests/integration/sync-roundtrip.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Per-PR route validation for app/api/sync/route.js — the token-FREE half.
// These run in the normal suite (no Blob token needed): they prove the
// handlers import cleanly and reject malformed input before any blob work.
//
// The token-GATED live round-trip (PUT-then-GET against the real Blob store)
// used to live here behind a BLOB_READ_WRITE_TOKEN gate and run in a GitHub
// Actions nightly. It MOVED to a Vercel cron self-test
// (app/api/cron/sync-selftest/route.js) so the Blob credential stays where it
// belongs — in Vercel, never hand-copied into a second tool. See that route
// for the live scenario; visibility is Vercel cron logs + monitoring.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { GET, PUT } from "@/app/api/sync/route";

const BASE = "http://localhost/api/sync";
const getReq  = (params) => new Request(`${BASE}?${new URLSearchParams(params)}`);
const jsonReq = (method, body) =>
  new Request(BASE, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("sync route input validation (token-free)", () => {
  it("handlers import and are callable", () => {
    expect(typeof GET).toBe("function");
    expect(typeof PUT).toBe("function");
  });

  it("GET without a profile 400s", async () => {
    const res = await GET(getReq({}));
    expect(res.status).toBe(400);
  });

  it("PUT with a path-separator profile 400s before any blob work", async () => {
    const res = await PUT(jsonReq("PUT", { profile: "a/b", data: { meta: {} } }));
    expect(res.status).toBe(400);
  });
});
