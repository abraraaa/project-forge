// @vitest-environment jsdom
// tests/delta-sync-client.test.js
// ─────────────────────────────────────────────────────────────────────────────
// PR B locks (#2 family — docs/delta-sync.md, client half).
// The two traps that matter most:
//   1. a partial delta must NEVER clobber local fields it didn't carry
//   2. the delta pull must NEVER trigger the localHadMore push-back
//      (against a partial, local always looks richer)
// Plus: cursor discipline (pulls advance it, pushes don't), dirty-diff
// correctness, and the keepalive budget.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DeltaSync, hashValue } from "../lib/sync-delta.js";
import { P, H, backgroundSync, pushNow, blobPushDelta } from "../lib/storage.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const okJson = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

let fetchCalls;
beforeEach(() => {
  localStorage.clear();
  fetchCalls = [];
});
afterEach(() => vi.unstubAllGlobals());

const stubFetch = (responder) => {
  vi.stubGlobal("fetch", (url, opts = {}) => {
    fetchCalls.push({ url: String(url), opts });
    return responder(String(url), opts);
  });
};

describe("DeltaSync bookkeeping", () => {
  it("diffMeta ships only changed fields; displayName never ships", () => {
    const meta = { weights: { a: 1 }, streak: { count: 2 }, displayName: "Probe" };
    const first = DeltaSync.diffMeta(meta, {});
    expect(Object.keys(first.dirty).sort()).toEqual(["streak", "weights"]);
    const second = DeltaSync.diffMeta(meta, first.newHashes);
    expect(second.dirty).toEqual({});
    const third = DeltaSync.diffMeta({ ...meta, streak: { count: 3 } }, first.newHashes);
    expect(Object.keys(third.dirty)).toEqual(["streak"]);
  });

  it("newRecords: creation-instant ids order lexically past the watermark", () => {
    const hist = [{ id: "2026-07-01T10:00:00.000Z" }, { id: "2026-07-20T10:00:00.000Z" }];
    expect(DeltaSync.newRecords(hist, "2026-07-10T00:00:00.000Z").map((r) => r.id))
      .toEqual(["2026-07-20T10:00:00.000Z"]);
    expect(DeltaSync.newRecords(hist, "").length).toBe(2);
  });

  it("hashValue is stable across key order (stableStringify underneath)", () => {
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
  });
});

describe("delta pull — the two traps", () => {
  beforeEach(() => {
    P.saveWeightsRaw("p", { Squat: 100 }, { Squat: "2026-07-20T00:00:00.000Z" });
    H.save("p", [{ id: "2026-07-01T10:00:00.000Z", date: "2026-07-01", type: "strength" }]);
    DeltaSync.setCursor("p", "2026-07-24T00:00:00.000Z");
  });

  it("a partial delta merges in without clobbering absent local fields, advances the cursor, and NEVER pushes back", async () => {
    stubFetch((url, opts) => {
      if (opts.method === "PUT") throw new Error("push-back must not happen on a delta pull");
      return okJson({
        delta: true,
        meta: { streak: { count: 9, lastDate: "2026-07-24" } }, // weights ABSENT
        history: [{ id: "2026-07-24T09:00:00.000Z", date: "2026-07-24", type: "strength" }],
        cursor: "2026-07-25T00:00:00.000Z",
      });
    });
    const res = await backgroundSync("p");
    expect(res.changed).toBe(true);
    expect(P.getWeights("p").Squat).toBe(100);              // trap 1: survived
    expect(H.get("p").length).toBe(2);                       // record unioned in
    expect(P.getStreak("p").count).toBe(9);
    expect(DeltaSync.getCursor("p")).toBe("2026-07-25T00:00:00.000Z");
    expect(fetchCalls.filter((c) => c.opts.method === "PUT")).toEqual([]); // trap 2
    expect(fetchCalls[0].url).toContain("since=");
  });

  it("a 400 (invalid cursor) drops the cursor so the next cycle re-hydrates fully", async () => {
    stubFetch(() => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({}) }));
    await backgroundSync("p");
    expect(DeltaSync.getCursor("p")).toBeNull();
  });

  it("a full pull adopts the response cursor — how a device enters delta mode", async () => {
    DeltaSync.clearCursor("p");
    stubFetch((url, opts) => {
      if (opts.method === "PUT") return okJson({ ok: true }); // push-back allowed on FULL path
      return okJson({ meta: { streak: { count: 1, lastDate: "2026-07-01" } }, history: [], cursor: "2026-07-25T01:00:00.000Z" });
    });
    await backgroundSync("p");
    expect(DeltaSync.getCursor("p")).toBe("2026-07-25T01:00:00.000Z");
  });

  it("hydration ACKNOWLEDGES the merged state — no phantom all-dirty baseline (boss find, 2026-07-26)", async () => {
    DeltaSync.clearCursor("p");
    stubFetch((url, opts) => {
      if (opts.method === "PUT") return okJson({ ok: true });
      return okJson({ meta: { streak: { count: 1, lastDate: "2026-07-01" } }, history: [], cursor: "2026-07-25T02:00:00.000Z" });
    });
    await backgroundSync("p");
    const push = DeltaSync.getPushState("p");
    expect(Object.keys(push.fieldHashes).length).toBeGreaterThan(0); // baseline acknowledged
    const { dirty } = DeltaSync.diffMeta(
      { weights: { Squat: 100 }, streak: { count: 1, lastDate: "2026-07-01" } },
      push.fieldHashes,
    );
    // The freshly-merged fields must NOT read as dirty.
    expect(dirty.weights).toBeUndefined();
  });
});

describe("delta push — dirty diff over THE payload builder", () => {
  it("no cursor → fat push (pre-hydration behaviour unchanged)", async () => {
    P.saveWeightsRaw("p2", { Bench: 60 }, {});
    stubFetch((url, opts) => okJson({ ok: true }));
    await pushNow("p2");
    const put = fetchCalls.find((c) => c.opts.method === "PUT");
    expect(JSON.parse(put.opts.body).data).toBeTruthy();     // fat shape
    expect(JSON.parse(put.opts.body).delta).toBeUndefined();
  });

  it("with a cursor: ships only dirty fields + new records; commits state so the next push is empty (and skips the wire)", async () => {
    P.saveWeightsRaw("p3", { Squat: 100 }, { Squat: "2026-07-20T00:00:00.000Z" });
    DeltaSync.setCursor("p3", "2026-07-24T00:00:00.000Z");
    stubFetch(() => okJson({ ok: true, delta: true, cursor: "x" }));
    await pushNow("p3");
    const put = fetchCalls.find((c) => c.opts.method === "PUT");
    const body = JSON.parse(put.opts.body);
    expect(body.delta.meta.weights).toEqual({ Squat: 100 });
    expect(body.data).toBeUndefined();

    fetchCalls = [];
    const ok = await pushNow("p3");                          // nothing dirty now
    expect(ok).toBe(true);
    expect(fetchCalls).toEqual([]);                          // no wire call at all
    expect(DeltaSync.getCursor("p3")).toBe("2026-07-24T00:00:00.000Z"); // pushes never move the cursor
  });

  it("keepalive rides only when requested AND under the 64KB budget", async () => {
    stubFetch(() => okJson({ ok: true }));
    await blobPushDelta("p4", { meta: { streak: 1 }, history: [] }, { keepalive: true });
    expect(fetchCalls[0].opts.keepalive).toBe(true);
    fetchCalls = [];
    const huge = { meta: { blob: "x".repeat(70_000) }, history: [] };
    await blobPushDelta("p4", huge, { keepalive: true });
    expect(fetchCalls[0].opts.keepalive).toBeUndefined();    // over budget → plain fetch
  });
});

describe("wiring (code shape)", () => {
  const src = readFileSync(resolve(root, "lib/storage.js"), "utf8");
  it("lifecycle flushes request keepalive (#12)", () => {
    expect((src.match(/flushOnLifecycle\(_lifecycleProfile\(\)\)/g) || []).length).toBe(2);
    expect(src).toMatch(/flushOnLifecycle\(profile\) \{\s*if \(!profile \|\| !DeltaSync\.getCursor/);
  });
  it("full pushes acknowledge into the delta push-state (single choke point)", () => {
    const push = src.slice(src.indexOf("export async function blobPush("), src.indexOf("export async function blobPushDelta"));
    expect(push).toContain("DeltaSync.commitPushState(profile, data");
  });
});
