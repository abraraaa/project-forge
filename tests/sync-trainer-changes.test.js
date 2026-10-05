// The client's side of a trainer's changes on /api/sync/trainer: the list with
// statuses on GET, and the POST verbs undo, acks, seenChanges and edits. The
// store (lib/trainer-changes-store.js, tested on its SQL in
// tests/trainer-changes-store.test.js) is faked here at its functions, so this
// pins what the route asks of it: the caller's own rows only, undo only while a
// change can be undone, a fresh Face ID before changes go back on, one verb per
// request. Statuses come from the real lib/trainer-change.js.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DAY = 86_400_000;
const NOW = Date.now();
const A = "hwa_" + "a".repeat(26); // the client, "abe"
const B = "hwa_" + "b".repeat(26); // someone else
const S1 = "hws_" + "a".repeat(26);
const S2 = "hws_" + "b".repeat(26);
const SQUAT = "Barbell Back Squat";
const BENCH = "Barbell Bench Press";
const APPLIED = "2026-10-03T09:00:00.000Z";

const store = vi.hoisted(() => ({
  list: /** @type {any} */ (null), profile: /** @type {any} */ (null),
  undo: vi.fn(), ack: vi.fn(), off: vi.fn(), on: vi.fn(), mark: vi.fn(), expire: vi.fn(), ceremony: vi.fn(),
  listCalls: /** @type {any[]} */ ([]), readCalls: /** @type {any[]} */ ([]),
}));

vi.mock("@/lib/trainer-changes-store", async (io) => ({
  ...(await io()),
  dbChangesForClient: vi.fn(async (me) => { store.listCalls.push(me); return store.list; }),
  dbUndoChanges: store.undo, dbAckChanges: store.ack, dbEditsOff: store.off, dbEditsOn: store.on,
}));
vi.mock("@/lib/db", async (io) => ({
  ...(await io()),
  dbReadProfile: vi.fn(async (key) => { store.readCalls.push(key); return store.profile; }),
  dbExpireToken: store.expire,
}));
vi.mock("@/lib/notices", async (io) => ({ ...(await io()), dbMarkSeen: store.mark }));
vi.mock("@/lib/trainer-store", async (io) => ({
  ...(await io()),
  dbClientShare: vi.fn(async () => null),
  dbTrainerApplication: vi.fn(async () => null),
}));
vi.mock("@/lib/trainer-session", async (io) => ({ ...(await io()), freshCeremony: store.ceremony }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(() => null), rateLimitShared: vi.fn(async () => null) }));
const IDENTITIES = { [A]: { accountId: A, storageKey: "sk-abe", handle: "abe", roles: ["lifter"], plan: "free" } };
vi.mock("@/lib/auth-server", async (io) => ({
  ...(await io()),
  readTokenData: async (t) => (t === "tok-abe" ? { accountId: A, scope: "sync", expires: NOW + DAY } : t === "tok-abe-photos" ? { accountId: A, scope: "photos" } : null),
  resolveTokenIdentity: async (d, profile) => (d && IDENTITIES[d.accountId]?.handle === profile ? { ...IDENTITIES[d.accountId] } : null),
}));

const { GET, POST } = await import("@/app/api/sync/trainer/route");
const { SHARE_CONSENT_VERSION } = await import("@/lib/trainer-terms");

const URL_BASE = "https://heatwayve.app/api/sync/trainer";
const get = (qs = "profile=abe") => GET(new NextRequest(`${URL_BASE}?${qs}`, { headers: { cookie: "hw_sync=tok-abe" } }));
const post = (body, token = "tok-abe") => POST(new NextRequest(URL_BASE, {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { cookie: `hw_sync=${token}` } : {}) }, body: JSON.stringify(body),
}));

// A change as dbChangesForClient returns it (camelCased, with editsLive and the trainer's name).
const row = (over = {}) => ({
  id: `${S1}.0`, set: S1, kind: "weight", target: SQUAT, before: 100, after: 105, from: null,
  basis: { anchorId: "2026-09-30T08:00:00.000Z", w: 100, r: 5 }, at: NOW - 2 * DAY, appliedAt: null, outcome: null,
  undoneAt: null, undoneBy: null, revertedAt: null, warnings: null, editsLive: true, by: "Tia", ...over,
});
// A session that trained the lift at `prescribed` kg.
const session = (id, name, kg) => ({ id, date: id.slice(0, 10), blocks: [{ exercises: [{ name, sets: [{ weight: kg, reps: 5 }], prescribed: { weight: kg, reps: 5 } }] }] });

beforeEach(() => {
  process.env.DATABASE_URL = "postgres://fake";
  store.list = { edits: { on: true, since: NOW - 10 * DAY }, rows: [] };
  store.profile = { meta: { weights: { [SQUAT]: 100, [BENCH]: 80 }, reps: {} }, history: [] };
  store.listCalls = [];
  store.readCalls = [];
  for (const f of [store.undo, store.ack, store.off, store.on, store.mark, store.expire, store.ceremony]) f.mockReset();
  store.undo.mockImplementation(async (_me, x) => [x]);
  store.ack.mockImplementation(async () => ({ acked: [], reverted: [] }));
  store.mark.mockImplementation(async () => true);
  store.off.mockImplementation(async () => true);
  store.on.mockImplementation(async () => "on");
  store.expire.mockImplementation(async () => true);
});

const anyWrite = () => [store.undo, store.ack, store.off, store.on, store.mark, store.expire].some((f) => f.mock.calls.length > 0);

describe("GET: the client's list of changes", () => {
  it("no changes: edits from the store, changes empty, and their training is not read", async () => {
    const body = await (await get()).json();
    expect(body.edits).toEqual({ on: true, since: NOW - 10 * DAY });
    expect(body.changes).toEqual([]);
    expect(store.listCalls).toEqual([A]);
    expect(store.readCalls).toEqual([]);
    expect(anyWrite()).toBe(false);
  });

  it("each change says where it stands, read against their synced training; never the basis", async () => {
    store.profile = {
      meta: { weights: { [SQUAT]: 105, [BENCH]: 82.5, "Romanian Deadlift": 90 }, reps: {} },
      history: [session("2026-10-04T08:00:00.000Z", BENCH, 82.5)],
    };
    store.list.rows = [
      row({ id: `${S2}.0`, set: S2, target: "Romanian Deadlift", before: 85, after: 87.5, at: NOW - DAY }),
      row({ id: `${S2}.1`, set: S2, target: "Romanian Deadlift", kind: "reps", before: 8, after: 10, at: NOW - DAY, editsLive: false }),
      row({ outcome: "applied", appliedAt: APPLIED, warnings: ["big_drop", 7, "x".repeat(40)] }),
      row({ id: `${S1}.1`, target: BENCH, before: 80, after: 82.5, outcome: "applied", appliedAt: APPLIED }),
      row({ id: `${S1}.2`, target: "Overhead Press", before: 40, after: 42.5, outcome: "superseded" }),
      row({ id: `${S1}.3`, target: "Pull-Up", undoneAt: NOW - DAY, undoneBy: "trainer" }),
    ];
    const res = await get("profile=abe&today=2026-10-05");
    const text = await res.text();
    const { changes } = JSON.parse(text);
    expect(changes.map((c) => [c.id, c.status, c.reason, c.undoable])).toEqual([
      [`${S2}.0`, "waiting", null, true],
      [`${S2}.1`, "not_applied", "stopped", false],
      [`${S1}.0`, "in_force", null, true],
      [`${S1}.1`, "trained_yours", null, false],
      [`${S1}.2`, "not_applied", "superseded", false],
      [`${S1}.3`, "withdrawn", null, false],
    ]);
    expect(changes[3].date).toBe("2026-10-04");
    expect(Object.keys(changes[0]).sort()).toEqual(
      ["after", "at", "before", "by", "date", "from", "id", "kind", "reason", "set", "status", "target", "undoable", "warnings"]);
    // Warnings are codes only; the basis, record ids and the device's instants never go out.
    expect(changes[2].warnings).toEqual(["big_drop"]);
    expect(text).not.toContain("anchorId");
    expect(text).not.toContain("2026-09-30T08:00:00.000Z");
    expect(text).not.toContain(APPLIED);
    expect(store.readCalls).toEqual(["sk-abe"]);
    expect(anyWrite()).toBe(false);
  });

  it("no database: edits null, no changes", async () => {
    store.list = null;
    const body = await (await get()).json();
    expect([body.edits, body.changes]).toEqual([null, []]);
  });
});

describe("POST undo: one tap, the caller's own changes, only while it can be undone", () => {
  it("a change waiting to land: one UPDATE, as the caller, with no put-back instant and no Face ID", async () => {
    store.list.rows = [row()];
    const res = await post({ profile: "abe", undo: `${S1}.0` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, undone: [`${S1}.0`] });
    expect(store.listCalls).toEqual([A]);
    expect(store.undo.mock.calls.map((c) => c.slice(0, 3))).toEqual([[A, `${S1}.0`, null]]);
    expect(store.ceremony).not.toHaveBeenCalled();
  });

  it("a change in their plan: undone and left for their app to put back (reverted_at stays empty)", async () => {
    store.profile.meta.weights[SQUAT] = 105;
    store.list.rows = [row({ outcome: "applied", appliedAt: APPLIED })];
    expect((await post({ profile: "abe", undo: `${S1}.0` })).status).toBe(200);
    expect(store.undo.mock.calls.map((c) => c.slice(0, 3))).toEqual([[A, `${S1}.0`, null]]);
  });

  it("undo all takes back only what can be undone: never a change already trained at or not landed", async () => {
    store.profile = {
      meta: { weights: { [SQUAT]: 105, [BENCH]: 82.5 }, reps: {} },
      history: [session("2026-10-04T08:00:00.000Z", BENCH, 82.5)],
    };
    store.list.rows = [
      row({ outcome: "applied", appliedAt: APPLIED }),
      row({ id: `${S1}.1`, target: BENCH, before: 80, after: 82.5, outcome: "applied", appliedAt: APPLIED }),
      row({ id: `${S1}.2`, target: "Overhead Press", outcome: "superseded" }),
      row({ id: `${S1}.3`, target: "Romanian Deadlift", before: 85, after: 87.5 }),
      row({ id: `${S2}.0`, set: S2, target: "Pull-Up" }),
    ];
    const res = await post({ profile: "abe", undo: S1 });
    expect(await res.json()).toEqual({ ok: true, undone: [`${S1}.0`, `${S1}.3`] });
    expect(store.undo.mock.calls.map((c) => c[1])).toEqual([`${S1}.0`, `${S1}.3`]);
  });

  it("nothing undoable: 409 and no write; already undone: 200 with nothing new; unknown or another's: 404", async () => {
    store.list.rows = [row({ outcome: "superseded" })];
    expect((await post({ profile: "abe", undo: `${S1}.0` })).status).toBe(409);
    store.list.rows = [row({ undoneAt: NOW - DAY, undoneBy: "client" })];
    const again = await post({ profile: "abe", undo: S1 });
    expect([again.status, await again.json()]).toEqual([200, { ok: true, undone: [] }]);
    // The store lists the caller's own rows only; anything else is not there.
    store.list.rows = [row()];
    for (const undo of [`${S2}.0`, "", 42, null, "x".repeat(65)]) {
      expect((await post({ profile: "abe", undo })).status, String(undo)).toBe(404);
    }
    expect(store.undo).not.toHaveBeenCalled();
  });

  it("a week in their plan goes back only with the instant their app put it back", async () => {
    const id = `${S1}.0`;
    store.profile.meta.userWeek = [{ effectiveFrom: "2026-10-05", editedAt: "2026-10-05T07:00:00.000Z", changeId: id,
      week: ["strength", "rest", "strength", "cardio", "strength", "rest", "rest"].map((type) => ({ type, s: type === "strength" })) }];
    store.list.rows = [row({ id, kind: "week", target: "week", before: null, after: [], from: "2026-10-05", outcome: "applied", appliedAt: "2026-10-05T07:00:00.000Z" })];
    expect((await post({ profile: "abe", undo: id })).status).toBe(409);
    expect((await post({ profile: "abe", undo: id, reverted: "not-an-instant" })).status).toBe(400);
    const put = "2026-10-05T10:00:00.000Z";
    expect((await post({ profile: "abe", undo: id, reverted: put })).status).toBe(200);
    expect(store.undo.mock.calls.map((c) => c.slice(0, 3))).toEqual([[A, id, put]]);
  });

  it("no database: 503", async () => {
    store.list = null;
    expect((await post({ profile: "abe", undo: S1 })).status).toBe(503);
    expect(store.undo).not.toHaveBeenCalled();
  });
});

describe("POST acks: their app's report", () => {
  it("passes a clean report to the store as the caller", async () => {
    store.ack.mockImplementation(async () => ({ acked: [`${S1}.0`], reverted: [] }));
    const acks = [{ id: `${S1}.0`, outcome: "applied", at: APPLIED }];
    const res = await post({ profile: "abe", acks });
    expect(await res.json()).toEqual({ ok: true, acked: [`${S1}.0`], reverted: [] });
    expect(store.ack.mock.calls).toEqual([[A, { acks, reverts: undefined }]]);
    // Reverts alone are a report too.
    expect((await post({ profile: "abe", reverts: [{ id: `${S1}.0`, at: APPLIED }] })).status).toBe(200);
  });

  it("an outcome off the list, a bad instant, or too many: 400 and nothing written", async () => {
    for (const acks of [[{ id: `${S1}.0`, outcome: "whatever", at: APPLIED }], [{ id: `${S1}.0`, outcome: "applied", at: "yesterday" }],
      Array.from({ length: 65 }, (_, i) => ({ id: `${S1}.${i}`, outcome: "applied", at: APPLIED })), "applied"]) {
      expect((await post({ profile: "abe", acks })).status).toBe(400);
    }
    expect(store.ack).not.toHaveBeenCalled();
  });
});

describe("POST seenChanges: the notice's mark", () => {
  it("true marks the caller's trainerChange kind; anything else is not found", async () => {
    expect((await post({ profile: "abe", seenChanges: true })).status).toBe(200);
    expect(store.mark.mock.calls.map((c) => c.slice(0, 2))).toEqual([[A, "trainerChange"]]);
    expect((await post({ profile: "abe", seenChanges: "yes" })).status).toBe(404);
    store.mark.mockImplementation(async () => null);
    expect((await post({ profile: "abe", seenChanges: true })).status).toBe(503);
  });
});

describe("POST edits: the switch", () => {
  it("off needs no Face ID: one UPDATE of the caller's grant; no grant with changes is not found", async () => {
    expect((await post({ profile: "abe", edits: false })).status).toBe(200);
    expect(store.off.mock.calls.map((c) => c[0])).toEqual([A]);
    expect(store.ceremony).not.toHaveBeenCalled();
    store.off.mockImplementation(async () => false);
    expect((await post({ profile: "abe", edits: false })).status).toBe(404);
  });

  it("on needs a fresh Face ID first; a failed one writes nothing", async () => {
    store.ceremony.mockImplementation(async () => ({ fail: Response.json({ error: "Face ID didn't go through. Try again.", requiresAuth: true }, { status: 401 }) }));
    expect((await post({ profile: "abe", edits: true, authToken: "cer" })).status).toBe(401);
    expect(store.on).not.toHaveBeenCalled();
    expect(store.ceremony.mock.calls[0][0]).toEqual({ authToken: "cer", profile: "abe" });
  });

  it("on: the Face ID must be the caller's own", async () => {
    store.ceremony.mockImplementation(async () => ({ identity: { accountId: B }, credentialId: "c", authAt: null, account: {} }));
    expect((await post({ profile: "abe", edits: true, authToken: "cer" })).status).toBe(401);
    expect(store.on).not.toHaveBeenCalled();
  });

  it("on: the grant on the current consent goes on, then the ceremony token expires; an older share asks for a fresh code", async () => {
    store.ceremony.mockImplementation(async () => ({ identity: { accountId: A }, credentialId: "c", authAt: null, account: {} }));
    expect((await post({ profile: "abe", edits: true, authToken: "cer" })).status).toBe(200);
    expect(store.on.mock.calls.map((c) => c.slice(0, 2))).toEqual([[A, SHARE_CONSENT_VERSION]]);
    expect(store.expire.mock.calls).toEqual([["cer"]]);
    store.on.mockImplementation(async () => "fresh");
    const res = await post({ profile: "abe", edits: true, authToken: "cer" });
    expect(res.status).toBe(409);
    expect((await res.json()).fresh).toBe(true);
    store.on.mockImplementation(async () => "none");
    expect((await post({ profile: "abe", edits: true, authToken: "cer" })).status).toBe(404);
    expect((await post({ profile: "abe", edits: "on", authToken: "cer" })).status).toBe(404);
  });
});

describe("one verb per request, behind the sync sign-in", () => {
  it("two verbs, or a verb beside another branch's key: 404 and nothing touched", async () => {
    store.list.rows = [row()];
    for (const body of [{ undo: S1, edits: false }, { undo: S1, seenChanges: true }, { acks: [], undo: S1 }, { undo: S1, stop: "hwg_x" },
      { edits: false, seen: "hwg_x" }, { seenChanges: true, withdrawApplication: true }]) {
      expect((await post({ profile: "abe", ...body })).status, JSON.stringify(body)).toBe(404);
    }
    expect(anyWrite()).toBe(false);
    expect(store.listCalls).toEqual([]);
  });

  it("no sign-in, another profile or a photos token: 401 and nothing touched", async () => {
    for (const [token, profile] of [[null, "abe"], ["tok-abe", "tia"], ["tok-abe-photos", "abe"]]) {
      for (const body of [{ undo: S1 }, { acks: [] }, { seenChanges: true }, { edits: false }, { edits: true, authToken: "x" }]) {
        expect((await post({ profile, ...body }, token)).status).toBe(401);
      }
    }
    expect(anyWrite()).toBe(false);
    expect(store.ceremony).not.toHaveBeenCalled();
  });
});

describe("source pins", () => {
  const route = readFileSync(resolve(__dirname, "../app/api/sync/trainer/route.js"), "utf8");
  it("the route never writes the client's plan: no meta or profile upsert, no raw SQL", () => {
    expect(route).not.toMatch(/dbUpsertMetaFields|dbUpsertProfile|dbInsertRecords|\bq`|\bsql\(/);
  });
});
