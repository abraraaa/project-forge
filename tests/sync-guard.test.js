// Per-row revision guard on meta writes (lib/db.js dbWriteMetaGuarded, the
// sync PUT's retry loop). The meta table is simulated in memory with the
// guard's rules: an upsert lands only when the row's rev equals the base it
// was merged from, and a transaction is all or nothing. A racer runs between
// a request's base read and its write: another device's whole PUT, or a
// direct row change, committed before the first request writes.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

process.env.DATABASE_URL = "postgres://memory";

const store = { meta: new Map(), sessions: new Map(), txns: [], reads: 0, races: [] };
const key = (profile, field) => `${profile}\u0000${field}`;
const stale = () => Object.assign(new Error("division by zero"), { code: "22012" });

// Base reads (with or without rev, closure or whole profile) and upserts
// (guarded or blind) are matched by shape, so a race replays the same way
// against a write path without the guard.
const META_READ = /^\s*SELECT field, value(, rev)? FROM meta WHERE profile = \?( AND field = ANY\(\?\))?$/;
function run(meta, { q, values }) {
  if (/^\s*(CREATE|ALTER)\b/.test(q)) return [];
  if (/^\s*SELECT now\(\) AS t$/.test(q)) return [{ t: new Date() }];
  if (/^\s*INSERT INTO sessions \(profile, id, record\)/.test(q)) {
    const [profile, json] = values;
    for (const r of JSON.parse(json)) if (!store.sessions.has(key(profile, r.id))) store.sessions.set(key(profile, r.id), r);
    return [];
  }
  if (/^\s*SELECT record FROM sessions WHERE profile = \? ORDER BY id$/.test(q)) {
    return [...store.sessions].filter(([k]) => k.startsWith(`${values[0]}\u0000`)).map(([, record]) => ({ record }));
  }
  const read = q.match(META_READ);
  if (read) {
    const [profile, fields] = values;
    return [...meta].filter(([k]) => k.startsWith(`${profile}\u0000`))
      .map(([k, row]) => ({ field: k.slice(profile.length + 1), value: structuredClone(row.value), rev: row.rev == null ? null : String(row.rev) }))
      .filter((r) => !read[2] || fields.includes(r.field));
  }
  const upsert = q.match(/^\s*INSERT INTO meta \(profile, field, value(, rev)?, updated_at\)/);
  if (upsert) {
    const [profile, field, json, stamp, base] = values;
    const row = meta.get(key(profile, field));
    const next = { value: JSON.parse(json), rev: upsert[1] ? stamp : row?.rev ?? null };
    if (!row || !upsert[1] || (row.rev ?? 0) === base) meta.set(key(profile, field), next);
    return [];
  }
  if (/^\s*SELECT CASE WHEN c\.n = \? THEN 0 ELSE c\.n \/ 0 END AS guard/.test(q)) {
    const [expected, profile, fields, stamp] = values;
    const n = fields.filter((f) => meta.get(key(profile, f))?.rev === stamp).length;
    if (n !== expected) throw stale();
    return [{ guard: 0 }];
  }
  throw new Error(`unexpected SQL: ${q}`);
}

const cloneMeta = (m) => new Map([...m].map(([k, row]) => [k, { ...row, value: structuredClone(row.value) }]));

vi.mock("@neondatabase/serverless", () => ({
  neon: () => {
    const tag = (strings, ...values) => {
      const stmt = { q: strings.join("?"), values };
      return {
        ...stmt,
        then: (ok, ko) => (async () => {
          const out = run(store.meta, stmt);
          if (META_READ.test(stmt.q)) {
            store.reads++;
            // The racer commits after this base read and before its write.
            const race = store.races.shift();
            if (race) await race();
          }
          return out;
        })().then(ok, ko),
      };
    };
    tag.transaction = async (queries) => {
      const draft = cloneMeta(store.meta);
      const record = { statements: queries.length, committed: false };
      store.txns.push(record);
      const out = queries.map((s) => run(draft, s)); // throws: nothing committed
      store.meta = draft;
      record.committed = true;
      return out;
    };
    return tag;
  },
}));
vi.mock("@/lib/auth-server", () => ({
  readTokenData: vi.fn(async (t) => (t ? { scope: "sync", createdAt: new Date().toISOString() } : null)),
  resolveTokenIdentity: vi.fn(async (data, profile) => (data ? { storageKey: String(profile).toLowerCase(), accountId: null } : null)),
  mintAuthToken: vi.fn(async () => null),
  hasRealPasskey: vi.fn(() => true),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => null, rateLimitShared: async () => null }));
vi.mock("@vercel/blob", () => ({ list: vi.fn(async () => ({ blobs: [] })), put: vi.fn(), get: vi.fn(async () => null), del: vi.fn() }));
vi.mock("@/lib/trainer-changes-store", () => ({ dbOpenChangesFor: vi.fn(async () => []), dbWipeReportTrainerChanges: vi.fn() }));

const { PUT } = await import("@/app/api/sync/route");
const { mintRevStamp } = await import("@/lib/db");

const put = (body) => PUT(new NextRequest("https://heatwayve.app/api/sync", {
  method: "PUT", headers: { "x-hw-auth": "t", "content-type": "application/json" },
  body: JSON.stringify({ profile: "sam", ...body }),
}));
const delta = (meta, history = []) => put({ delta: { meta, history } });
const row = (field) => store.meta.get(key("sam", field));
const value = (field) => row(field)?.value;
const seed = (meta, rev = 1) => { for (const [f, v] of Object.entries(meta)) store.meta.set(key("sam", f), { value: v, rev }); };
const T0 = "2026-10-01T10:00:00.000Z";
const T1 = "2026-10-08T10:00:00.000Z";
const T2 = "2026-10-08T10:00:05.000Z";
const T3 = "2026-10-08T10:00:09.000Z";

beforeEach(() => {
  Object.assign(store, { meta: new Map(), sessions: new Map(), txns: [], reads: 0, races: [] });
});

describe("two devices, one closure", () => {
  it("different lifts in the same weights row both survive", async () => {
    seed({ weights: { Squat: 100, Bench: 80 }, weightStamps: { Squat: T0, Bench: T0 } });
    // Phone pushes a new squat; the tablet's new bench lands between the
    // phone's read and its write.
    store.races.push(async () => {
      const res = await delta({ weights: { Squat: 100, Bench: 85 }, weightStamps: { Squat: T0, Bench: T2 } });
      expect(res.status).toBe(200);
    });
    const res = await delta({ weights: { Squat: 105, Bench: 80 }, weightStamps: { Squat: T1, Bench: T0 } });
    expect(res.status).toBe(200);
    expect(value("weights")).toEqual({ Squat: 105, Bench: 85 });
    expect(value("weightStamps")).toEqual({ Squat: T1, Bench: T2 });
  });

  it("same lift from two devices: the newer stamp wins in either order, and neither write is lost", async () => {
    for (const [first, second] of [["phone", "tablet"], ["tablet", "phone"]]) {
      Object.assign(store, { meta: new Map(), txns: [], races: [] });
      seed({ weights: { Squat: 100 }, weightStamps: { Squat: T0 } });
      const body = {
        phone: { weights: { Squat: 110 }, weightStamps: { Squat: T3 } },
        tablet: { weights: { Squat: 107, Deadlift: 140 }, weightStamps: { Squat: T2, Deadlift: T2 } },
      };
      store.races.push(async () => { expect((await delta(body[second])).status).toBe(200); });
      expect((await delta(body[first])).status, first).toBe(200);
      expect(value("weights"), first).toEqual({ Squat: 110, Deadlift: 140 });
      expect(value("weightStamps"), first).toEqual({ Squat: T3, Deadlift: T2 });
      expect(store.txns.filter((t) => t.committed)).toHaveLength(2);
    }
  });

  it("a PUT that lands 15 seconds late from an older base cannot regress a newer value", async () => {
    seed({ bodyweight: { kg: 81, updatedAt: T0 } });
    // The phone read its base at 10:00:01 and stalled; the tablet's 10:00:09
    // reading committed while it waited.
    store.races.push(async () => { expect((await delta({ bodyweight: { kg: 79, updatedAt: T3 } })).status).toBe(200); });
    const late = await delta({ bodyweight: { kg: 80, updatedAt: T1 } });
    expect(late.status).toBe(200);
    expect(value("bodyweight")).toEqual({ kg: 79, updatedAt: T3 });
  });

  it("first insert collision: both create the row, the loser re-merges and its keys survive", async () => {
    store.races.push(async () => {
      expect((await delta({ weights: { Bench: 40 }, weightStamps: { Bench: T2 } })).status).toBe(200);
    });
    expect((await delta({ weights: { Squat: 60 }, weightStamps: { Squat: T1 } })).status).toBe(200);
    expect(value("weights")).toEqual({ Squat: 60, Bench: 40 });
    expect(value("weightStamps")).toEqual({ Squat: T1, Bench: T2 });
    // The tablet's insert, the phone's rolled-back attempt, the phone's retry.
    expect(store.txns.map((t) => t.committed)).toEqual([true, false, true]);
  });

  it("a fat PUT and a delta PUT racing: both survive", async () => {
    seed({ weights: { Squat: 100, Bench: 80 }, weightStamps: { Squat: T0, Bench: T0 }, streak: { count: 3, lastDate: "2026-10-07" } });
    store.races.push(async () => {}); // dbReadProfile's read: not the merge base
    store.races.push(async () => {
      expect((await delta({ weights: { Squat: 100, Bench: 85 }, weightStamps: { Squat: T0, Bench: T2 } })).status).toBe(200);
    });
    const res = await put({ data: { meta: { weights: { Squat: 105, Bench: 80 }, weightStamps: { Squat: T1, Bench: T0 } } } });
    expect(res.status).toBe(200);
    expect(value("weights")).toEqual({ Squat: 105, Bench: 85 });
    expect(value("streak")).toEqual({ count: 3, lastDate: "2026-10-07" });
  });
});

describe("rows advance together or not at all", () => {
  it("weights and weightStamps carry the same stamp after a write", async () => {
    seed({ weights: { Squat: 100 }, weightStamps: { Squat: T0 } });
    expect((await delta({ weights: { Squat: 105 }, weightStamps: { Squat: T1 } })).status).toBe(200);
    expect(row("weights").rev).toBe(row("weightStamps").rev);
    expect(row("weights").rev).not.toBe(1);
  });

  it("when only weightStamps moved, weights is not written either; after three misses: 409, nothing written", async () => {
    seed({ weights: { Squat: 100 }, weightStamps: { Squat: T0 } });
    const before = cloneMeta(store.meta);
    const moved = [];
    for (let i = 0; i < 3; i++) {
      store.races.push(async () => {
        const r = row("weightStamps");
        r.rev = 1000 + i;
        moved.push(r.rev);
      });
    }
    const res = await delta({ weights: { Squat: 105 }, weightStamps: { Squat: T1 } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale" });
    expect(store.txns.map((t) => t.committed)).toEqual([false, false, false]);
    expect(store.reads).toBe(3);
    expect(row("weights")).toEqual(before.get(key("sam", "weights")));
    expect(row("weightStamps")).toEqual({ ...before.get(key("sam", "weightStamps")), rev: moved.at(-1) });
  });

  it("a miss then a clean read succeeds on the retry", async () => {
    seed({ streak: { count: 3, lastDate: "2026-10-07" } });
    store.races.push(async () => { row("streak").rev = 77; });
    expect((await delta({ streak: { count: 4, lastDate: "2026-10-08" } })).status).toBe(200);
    expect(value("streak")).toEqual({ count: 4, lastDate: "2026-10-08" });
    expect(store.txns.map((t) => t.committed)).toEqual([false, true]);
  });
});

describe("stamp and statements (code)", () => {
  const db = readFileSync(new URL("../lib/db.js", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/sync/route.js", import.meta.url), "utf8");
  const guarded = db.slice(db.indexOf("export async function dbWriteMetaGuarded"), db.indexOf("// ─── Delta sync"));
  const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");

  it("mints a random positive integer below 2^53, never rev + 1", () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const s = mintRevStamp();
      expect(Number.isSafeInteger(s) && s > 0).toBe(true);
      seen.add(s);
    }
    expect(seen.size).toBe(2000);
    const mint = db.slice(db.indexOf("export function mintRevStamp"), db.indexOf("export async function dbReadMetaBase"));
    expect(mint).toContain("randomBytes(8)");
    expect(code(db)).not.toMatch(/rev\s*\+\s*1/);
  });

  it("one transaction: guarded upserts, then a raise that divides a count, not a literal", () => {
    expect(guarded).toContain("await q.transaction([");
    expect(guarded).toContain("WHERE COALESCE(meta.rev, 0) = ${Number(baseRevs?.[field] ?? 0)}");
    expect(guarded).toContain("SELECT CASE WHEN c.n = ${fields.length} THEN 0 ELSE c.n / 0 END AS guard");
    expect(code(guarded)).not.toMatch(/\b1 \/ 0\b/);
    expect(guarded).toContain('e)?.code === "22012") return false;');
  });

  it("the route mints one stamp per request, retries three times, re-merges the original incoming", () => {
    const loop = route.slice(route.indexOf("async function writeMetaGuarded"), route.indexOf("const staleWrite"));
    expect(loop.indexOf("mintRevStamp()")).toBeLessThan(loop.indexOf("for (let i = 0"));
    expect(route).toContain("const META_WRITE_TRIES = 3;");
    expect(route).toContain("(existing) => mergeMetaFields(existing, incoming)");
    expect(route).toContain('NextResponse.json({ error: "stale" }, { status: 409 })');
  });
});
