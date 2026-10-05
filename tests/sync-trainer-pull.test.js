// GET /api/sync carries a read-only `trainer` key on its DB reads (spec §3.3):
// the rows a trainer has waiting for this profile's app, and nothing at all
// when there are none, so the pull's shape is unchanged without them (E7).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { normaliseProfile } from "../lib/profile-name.js";

const A = { id: "hwa_" + "a".repeat(26), storageKey: "sam" };
const tokens = new Map();
const calls = [];
const events = [];
const track = (name, fn) => vi.fn(async (...a) => {
  calls.push([name, ...a]);
  events.push(`${name}:start`);
  await new Promise((done) => setTimeout(done, 1));
  const out = fn(...a);
  events.push(`${name}:end`);
  return out;
});
const state = { rows: [], fail: false };

vi.mock("@/lib/identity-store", async (importOriginal) => {
  const acct = { ...A, webauthnUserId: "u", roles: ["lifter"], plan: "free", consent: null, origin: "claim", deletedAt: null };
  return {
    ...(await importOriginal()),
    dbGetAccount: vi.fn(async (id) => (id === A.id ? acct : null)),
    dbAccountByStorageKey: vi.fn(async (sk) => (sk === A.storageKey ? acct : null)),
    dbResolveHandle: vi.fn(async (name) => (normaliseProfile(name) === "sam" ? { ...acct, accountId: A.id, handle: "sam", display: "Sam", kind: "primary" } : null)),
  };
});
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal()),
  hasDb: () => true,
  dbReadToken: vi.fn(async (t) => tokens.get(t) || null),
  dbReadProfile: track("dbReadProfile", () => ({ meta: { weights: { Squat: 100 } }, history: [], cursor: "2026-10-05T10:00:00.000Z" })),
  dbReadProfileSince: track("dbReadProfileSince", () => ({ meta: {}, history: [], cursor: "2026-10-05T11:00:00.000Z" })),
  dbUpsertMetaFields: track("dbUpsertMetaFields", () => true),
  dbUpsertProfile: track("dbUpsertProfile", () => true),
}));
vi.mock("@/lib/trainer-changes-store", () => ({
  dbOpenChangesFor: track("dbOpenChangesFor", () => {
    if (state.fail) throw new Error("neon down");
    return state.rows;
  }),
}));
vi.mock("@vercel/blob", () => ({ list: vi.fn(async () => ({ blobs: [] })), put: vi.fn(), get: vi.fn(async () => null), del: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => null, rateLimitShared: async () => null }));

const sync = await import("@/app/api/sync/route");

const ROW = {
  id: "hws_" + "a".repeat(26) + ".0", set: "hws_" + "a".repeat(26), kind: "weight", target: "Barbell Back Squat",
  from: null, before: 100, after: 105, basis: { anchorId: "2026-10-01T10:00:00.000Z", w: 100, r: 5 },
  at: 1, appliedAt: null, undone: false, by: "Alex",
};
const H = "https://heatwayve.app";
const get = (q = "") => sync.GET(new NextRequest(`${H}/api/sync?profile=sam${q}`, { headers: { "x-hw-auth": "t" } }));

beforeEach(() => {
  tokens.clear();
  calls.length = 0;
  events.length = 0;
  state.rows = [];
  state.fail = false;
  tokens.set("t", {
    profile: A.storageKey, accountId: A.id, expires: Date.now() + 3600_000, credentialId: "cred-1",
    createdAt: new Date(Date.now() - 60_000).toISOString(), authAt: new Date(Date.now() - 60_000).toISOString(),
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/sync: trainer rows", () => {
  for (const [name, q, base] of [
    ["full DB read", "", { meta: { weights: { Squat: 100 } }, history: [], cursor: "2026-10-05T10:00:00.000Z" }],
    ["delta read", "&since=2026-10-05T09:00:00.000Z", { delta: true, meta: {}, history: [], cursor: "2026-10-05T11:00:00.000Z" }],
  ]) {
    it(`${name}: the trainer read runs after the profile read, never beside it`, async () => {
      state.rows = [ROW];
      await get(q);
      const read = q ? "dbReadProfileSince" : "dbReadProfile";
      expect(events).toEqual([`${read}:start`, `${read}:end`, "dbOpenChangesFor:start", "dbOpenChangesFor:end"]);
    });

    it(`${name}: carries the rows for the gated profile`, async () => {
      state.rows = [ROW];
      const res = await get(q);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ...base, trainer: { rows: [ROW] } });
      expect(calls.filter(([n]) => n === "dbOpenChangesFor")).toEqual([["dbOpenChangesFor", "sam"]]);
    });

    it(`${name}: no rows, no key: the body is byte-identical to before`, async () => {
      const res = await get(q);
      expect(await res.text()).toBe(JSON.stringify(base));
    });

    it(`${name}: a failed trainer read never fails the pull`, async () => {
      state.fail = true;
      const res = await get(q);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(base);
    });
  }

  it("passes an undone row through unchanged, before: null included", async () => {
    const undone = { ...ROW, before: null, undone: true, appliedAt: "2026-10-04T08:00:00.000Z" };
    state.rows = [undone];
    const body = await (await get()).json();
    expect(body.trainer.rows).toEqual([undone]);
    expect(Object.hasOwn(body.trainer.rows[0], "before")).toBe(true);
  });

  it("reads only: the pull writes nothing", async () => {
    state.rows = [ROW];
    await get();
    await get("&since=2026-10-05T09:00:00.000Z");
    expect(calls.map(([n]) => n).filter((n) => /Upsert|Insert|Update|Ack|Undo/.test(n))).toEqual([]);
  });

  it("an ungated caller gets no rows", async () => {
    state.rows = [ROW];
    const res = await sync.GET(new NextRequest(`${H}/api/sync?profile=sam`));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("the route imports only reads from the change store: the delivery read and the wipe's dry run", () => {
    const src = readFileSync(join(import.meta.dirname, "../app/api/sync/route.js"), "utf8");
    expect(src).toContain('import { dbOpenChangesFor, dbWipeReportTrainerChanges } from "@/lib/trainer-changes-store";');
    expect(src).not.toMatch(/dbInsertChangeSet|dbAckChanges|dbUndoChanges|dbWithdrawChanges|trainer_changes/);
  });
});
