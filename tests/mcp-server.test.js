import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { memoryStore, registerClient, issueCode, exchangeCode } from "../lib/oauth.js";

// The /mcp route's I/O: an in-memory OAuth store, the account and credential
// index, the profile read. Pure tool tests below never touch these.
const route = { store: memoryStore(), accounts: new Map(), creds: new Map(), doc: null };
vi.mock("../lib/oauth-store.js", () => ({ neonOAuthStore: async () => route.store }));
vi.mock("../lib/identity-store.js", () => ({
  dbGetAccount: vi.fn(async (id) => route.accounts.get(id) || null),
  dbAccountByStorageKey: vi.fn(async (sk) => [...route.accounts.values()].find((a) => a.storageKey === sk) || null),
  dbListCredentials: vi.fn(async (id) => route.creds.get(id) || []),
  dbResolveHandle: vi.fn(async () => null),
}));
vi.mock("../lib/blob-utils.js", () => ({ readJsonByPrefix: vi.fn(async () => route.doc) }));
vi.mock("../lib/db.js", async (orig) => ({ ...(await orig()), dbReadProfile: vi.fn(async () => ({ meta: {}, history: [] })) }));
import { handleMcp, runTool, weekOn, validMainLifts, resolvedProgramme, loadTypeOfName, PROTOCOL_VERSIONS } from "../lib/mcp-server.js";
import {
  SESSIONS, EXERCISE_POOLS, SWAP_DB, MAIN_LIFT_FUNCTIONAL_EQUIVALENTS,
  applyRotationToSession, applyMainLiftsToSession, applyFocusToSession,
} from "../lib/programme.js";

const rec = (date, name, weight, reps, rpe) => ({
  id: date, date, session: "strength_a", readiness: "fresh",
  blocks: [{ exercises: [{ name, sets: [{ weight, reps, rpe }, { weight, reps, rpe }] }] }],
});
const data = {
  meta: { userFocus: "Sculpt", bodyweight: { kg: 70 }, trainingState: null },
  history: [rec("2026-09-01", "Barbell Bench Press", 60, 8, 8), rec("2026-09-03", "Barbell Hip Thrust", 100, 10, 7), rec("2026-09-05", "Barbell Bench Press", 62.5, 8, 8)],
};
const now = new Date("2026-09-24T12:00:00Z");
const T1 = "2026-09-20T10:00:00.000Z";
const call = (msg, load = async () => data) => handleMcp({ jsonrpc: "2.0", ...msg }, { load, now });

describe("MCP handshake", () => {
  it("negotiates a supported version and advertises tools only", async () => {
    const r = await call({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(Object.keys(r.result.capabilities)).toEqual(["tools"]);
    const r2 = await call({ id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(r2.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });
  it("answers notifications with nothing and never loads data for them", async () => {
    let loads = 0;
    expect(await call({ method: "notifications/initialized" }, async () => { loads++; return data; })).toBeNull();
    await call({ id: 3, method: "tools/list" }, async () => { loads++; return data; });
    expect(loads).toBe(0);
  });
  it("lists six read-only tools", async () => {
    const r = await call({ id: 4, method: "tools/list" });
    expect(r.result.tools.map((t) => t.name)).toEqual(["training_snapshot", "recent_sessions", "programme", "chart_style", "current_loads", "lift_history"]);
    for (const t of r.result.tools) expect(t.annotations.readOnlyHint).toBe(true);
  });
  it("rejects unknown methods, unknown tools and malformed messages", async () => {
    expect((await call({ id: 5, method: "tools/write" })).error.code).toBe(-32601);
    expect((await call({ id: 6, method: "tools/call", params: { name: "delete_everything" } })).error.code).toBe(-32602);
    expect((await handleMcp([{ jsonrpc: "2.0", id: 1, method: "ping" }], { load: async () => data })).error.code).toBe(-32600);
  });
});

describe("tools", () => {
  it("snapshot carries the primer, focus and sessions but no profile name or main-lift guess", () => {
    const t = runTool("training_snapshot", {}, data, now).text;
    expect(t).toContain("How Heatwayve programmes");
    expect(t).toContain("Focus: Sculpt");
    expect(t).not.toContain("Main lifts: programme defaults");
  });
  it("recent_sessions clamps its limit", () => {
    expect(runTool("recent_sessions", { limit: 1 }, data, now).text.split("\n")).toHaveLength(1);
    expect(runTool("recent_sessions", { limit: 999 }, data, now).text.split("\n")).toHaveLength(3);
  });
  it("lift_history matches by name, oldest first", () => {
    const t = runTool("lift_history", { lifts: ["bench"] }, data, now).text.split("\n");
    expect(t).toHaveLength(3); // heading + two sessions
    expect(t[1]).toContain("2026-09-01");
    expect(t[2]).toContain("62.5×8 @8");
  });
  it("lift_history answers several lifts in one call and names the misses", () => {
    const t = runTool("lift_history", { lifts: ["bench", "hip thrust", "curl"] }, data, now).text;
    expect(t).toContain("## bench");
    expect(t).toContain("## hip thrust");
    expect(t).toContain("No logged sets match: curl.");
    expect(t).toContain("Logged exercises: Barbell Bench Press, Barbell Hip Thrust.");
  });
  it("current_loads covers every exercise in one call", () => {
    const d = { meta: { weights: { "Barbell Bench Press": 62.5, "Barbell Hip Thrust": 100 }, reps: { "Barbell Bench Press": "8", "Plank": "45s" } }, history: [] };
    expect(runTool("current_loads", {}, d, now).text.split("\n")).toEqual([
      "- Barbell Bench Press: 62.5 kg × 8",
      "- Barbell Hip Thrust: 100 kg",
      "- Plank: bodyweight × 45s",
    ]);
  });
  it("current_loads: pure-BW lifts show the added load, never a phantom W", () => {
    // "Barbell Glute Bridge" name-matches the bodyweight pattern but is a
    // barbell lift; "45-Degree Hip Extension" is bodyweight but unmatched.
    const d = { meta: {
      weights: { "Glute Bridge": 80, "45-Degree Hip Extension": 40, "Barbell Glute Bridge": 60 },
      reps: { "Glute Bridge": 12 },
      addedLoads: { "Glute Bridge": { kg: 10, updatedAt: T1 } },
    }, history: [] };
    expect(runTool("current_loads", {}, d, now).text.split("\n")).toEqual([
      "- 45-Degree Hip Extension: bodyweight",
      "- Barbell Glute Bridge: 60 kg",
      "- Glute Bridge: bodyweight + 10 kg × 12",
    ]);
  });
  it("current_loads: a travel backpack under a gym-loaded name never hides W", () => {
    // Single-Leg RDL is a catalogue per_db lift with no W: no row. Deficit
    // Push-Up is outside the catalogue, so its key makes it pure bodyweight.
    const d = { meta: {
      weights: { "Bulgarian Split Squat": 18 },
      addedLoads: {
        "Bulgarian Split Squat": { kg: 10, updatedAt: T1 },
        "Single-Leg RDL": { kg: 5, updatedAt: T1 },
        "Deficit Push-Up": { kg: 5, updatedAt: T1 },
      },
    }, history: [] };
    expect(runTool("current_loads", {}, d, now).text.split("\n")).toEqual([
      "- Bulgarian Split Squat: 18 kg",
      "- Deficit Push-Up: bodyweight + 5 kg",
    ]);
  });
  it("lift_history: a proven added load reads as BW+N; a phantom reads BW", () => {
    const h = [{ id: "2026-09-10", date: "2026-09-10", session: "strength_a", readiness: "normal", blocks: [{ exercises: [
      { name: "Glute Bridge", loadType: "bodyweight", sets: [
        { weight: 10, reps: 12, rpe: 8, loadType: "bodyweight", bodyweightUsed: 80, effectiveLoad: 90 },
        { weight: null, reps: 12, rpe: 8, loadType: "bodyweight", bodyweightUsed: 80, effectiveLoad: 80 },
        { weight: 40, reps: 15, rpe: 8, loadType: "bodyweight", bodyweightUsed: 80, effectiveLoad: 80 }] },
      { name: "Pull-Up", loadType: "loaded_bodyweight", sets: [{ weight: 10, reps: 8, rpe: 8, loadType: "loaded_bodyweight" }] }] }] }];
    const t = runTool("lift_history", { lifts: ["glute bridge", "pull-up"] }, { meta: {}, history: h }, now).text;
    expect(t).toContain("BW+10×12 @8, BW×12 @8, BW×15 @8");
    expect(t).toContain("BW+10×8 @8");
    expect(t).not.toContain("BW+40");
    expect(t).not.toContain("40×15");
  });
  it("an empty profile reads as empty, not an error", () => {
    expect(runTool("recent_sessions", {}, null, now).text).toBe("No sessions logged yet.");
  });
  it("weekOn picks the latest schedule in force, and reads the legacy bare-array shape", () => {
    const wk = (strengthIdx) => Array.from({ length: 7 }, (_, i) => ({ type: i === strengthIdx ? "strength" : "rest" }));
    const h = [
      { effectiveFrom: "2026-01-01", editedAt: "2026-01-01T00:00:00Z", week: wk(0) },
      { effectiveFrom: "2026-09-01", editedAt: "2026-09-01T00:00:00Z", week: wk(2) },
      { effectiveFrom: "2026-12-01", editedAt: "2026-12-01T00:00:00Z", week: wk(4) },
    ];
    expect(weekOn(h, "2026-09-24").findIndex((d) => d.type === "strength")).toBe(2);
    expect(weekOn(wk(1), "2026-09-24").findIndex((d) => d.type === "strength")).toBe(1);
    expect(weekOn("garbage", "2026-09-24")).toHaveLength(7); // falls back to the default week
  });
});

describe("/mcp route", () => {
  const src = readFileSync(resolve(__dirname, "../app/mcp/route.js"), "utf8");
  it("demands a bearer token and points 401s at the resource metadata", () => {
    expect(src).toContain('verifyAccessToken(store, token, { audience: MCP_RESOURCE, kind: "ai", credentialExists, resolveGrant: grantIdentity })');
    expect(src).toContain('error="insufficient_scope"');
    expect(src).toContain('resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"');
  });
  it("reads only the grant's storage key, and never photos", () => {
    expect(src).toContain("dbReadProfile(who.profile)");
    expect(src).not.toMatch(/photo|@vercel\/blob|dbUpsert|dbInsert|dbDelete/i);
  });
  it("one profile read serves a burst of calls", () => {
    expect(src).toContain("readCached(who.grantId, () => dbReadProfile(who.profile))");
  });
  it("a browser visit redirects to the coaching page instead of downloading", async () => {
    const { GET } = await import("../app/mcp/route.js");
    const html = GET(new Request("https://heatwayve.app/mcp", { headers: { accept: "text/html,application/xhtml+xml" } }));
    expect(html.status).toBe(307);
    expect(html.headers.get("location")).toBe("https://heatwayve.app/profile/coach");
    const client = GET(new Request("https://heatwayve.app/mcp", { headers: { accept: "text/event-stream" } }));
    expect(client.status).toBe(405);
    expect(client.headers.get("content-type")).toBe("application/json");
  });
  it("rate-limits per connection", () => {
    expect(src).toContain("rateLimit(request, `mcp:${who.grantId}`, 60)");
    expect(src).toContain(`rateLimitShared(request, "mcp-day", 2000`);
  });
});

describe("programme tool", () => {
  const SQ = "Barbell Back Squat";
  const meta = {
    userFocus: "Sculpt",
    programmeBlock: { number: 3, startDate: "2026-09-01", config: {} },
    mainLifts: { [SQ]: "Front Squat", "Barbell Bench Press": "Barbell Bench Press" },
    weights: { "Front Squat": 60 },
    reps: {},
  };
  const text = runTool("programme", {}, { meta, history: [] }, now).text;

  it("lists every exercise the app would show, in the app's composition order", () => {
    for (const template of SESSIONS) {
      const s = applyFocusToSession(applyMainLiftsToSession(applyRotationToSession(template, {}), meta.mainLifts), "Sculpt", {}, meta.mainLifts);
      expect(text).toContain(`## ${s.name}`);
      for (const b of s.blocks) for (const ex of [b.ex, b.exA, b.exB].filter(Boolean)) expect(text).toContain(ex.name);
    }
  });
  it("shows main-lift choices, the working weight, and what's next", () => {
    expect(text).toContain("Main lifts: Front Squat (for Barbell Back Squat).");
    expect(text).toContain("Front Squat 3 × 5 @ 60 kg");
    expect(text).not.toMatch(/Barbell Back Squat \d/);
    expect(text).toContain("Next up: Strength A.");
    expect(text).toContain("block 3, started 2026-09-01 · Sculpt focus");
  });
  it("marks template weights as a suggested start", () => {
    expect(text).toMatch(/Barbell Bench Press 3 × 5 @ \d+ kg \(suggested start\)/);
  });
  it("says so when main lifts were never synced, rather than guessing defaults", () => {
    const t = runTool("programme", {}, { meta: { ...meta, mainLifts: undefined }, history: [] }, now).text;
    expect(t).toContain("not synced from this user's app yet");
  });
  it("drops choices that aren't listed equivalents", () => {
    expect(validMainLifts({ mainLifts: { [SQ]: "Leg Press", "Barbell Bench Press": "Dumbbell Bench Press" } }))
      .toEqual({ "Barbell Bench Press": "Dumbbell Bench Press" });
    expect(validMainLifts({})).toBeNull();
  });
  it("the snapshot names main lifts once they sync", () => {
    const t = runTool("training_snapshot", {}, { meta, history: data.history }, now).text;
    expect(t).toContain("Main lifts: Front Squat (for Barbell Back Squat)");
  });
});

describe("programme loads read the way the session screen reads them", () => {
  const base = { programmeBlock: { number: 1, config: {} }, userFocus: "Forged", reps: {} };
  const run = (meta) => runTool("programme", {}, { meta: { ...base, ...meta }, history: [] }, now).text;

  it("a chosen main lift with no weight yet is a new lift, not bodyweight", () => {
    const t = run({ mainLifts: { "Barbell Back Squat": "Front Squat" }, weights: {} });
    expect(t).toContain("Front Squat 3 × 5 @ weight not set yet (new lift)");
    expect(t).not.toContain("Front Squat 3 × 5 @ bodyweight");
  });
  it("main-lift starts are seeded from bodyweight, as the app does", () => {
    const t = run({ mainLifts: {}, weights: {}, bodyweight: { kg: 90 } });
    expect(t).toContain("Barbell Back Squat 3 × 5 @ 67.5 kg (suggested start)");
  });
  it("a stored working weight is used as-is", () => {
    expect(run({ mainLifts: {}, weights: { "Barbell Back Squat": 100 } })).toContain("Barbell Back Squat 3 × 5 @ 100 kg");
  });
  it("dumbbells read per hand", () => {
    expect(run({ mainLifts: {}, weights: { "DB Reverse Lunge": 20 } })).toContain("DB Reverse Lunge 3 × 8/leg @ 20 kg each");
  });
  it("an edited timed hold reads in seconds", () => {
    const lsit = EXERCISE_POOLS["afin-A"].pool.find((e) => e.name === "L-Sit Hold");
    expect(lsit).toBeTruthy();
    const t = runTool("programme", {}, {
      meta: { ...base, programmeBlock: { number: 1, config: { "afin-A": lsit } }, mainLifts: {}, weights: {}, reps: { "L-Sit Hold": 30 } },
      history: [],
    }, now).text;
    expect(t).toContain("L-Sit Hold 4 × 30s hold");
  });
  it("a pure-BW slot ignores a phantom W", () => {
    const hx = EXERCISE_POOLS["ass2-A"].pool.find((e) => e.name === "45-Degree Hip Extension");
    expect(hx).toBeTruthy();
    const t = runTool("programme", {}, {
      meta: { ...base, programmeBlock: { number: 1, config: { "ass2-A": hx } }, mainLifts: {}, weights: { "45-Degree Hip Extension": 40 } },
      history: [],
    }, now).text;
    expect(t).toMatch(/45-Degree Hip Extension \d+ × \S+ @ bodyweight/);
    expect(t).not.toMatch(/45-Degree Hip Extension \d+ × \S+ @ 40 kg/);
  });
  it("a pure-BW slot reads the vest", () => {
    const hx = EXERCISE_POOLS["ass2-A"].pool.find((e) => e.name === "45-Degree Hip Extension");
    const t = runTool("programme", {}, {
      meta: {
        ...base, programmeBlock: { number: 1, config: { "ass2-A": hx } }, mainLifts: {},
        weights: { "45-Degree Hip Extension": 40 },
        addedLoads: { "45-Degree Hip Extension": { kg: 10, updatedAt: T1 } },
      },
      history: [],
    }, now).text;
    expect(t).toMatch(/45-Degree Hip Extension \d+ × \S+ @ bodyweight \+ 10 kg/);
  });
  it("malformed synced data is a tool error, never a thrown request", async () => {
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "recent_sessions" } },
      { load: async () => ({ meta: {}, history: [{ date: "x", blocks: "abc" }] }), now },
    );
    expect(r.result.isError).toBe(true);
  });
});

// Fixture metas across focus × main lifts × rotation config × loads, for the
// resolvedProgramme refactor (E8).
function e8Fixtures() {
  const names = [...new Set([
    ...SESSIONS.flatMap((s) => s.blocks.flatMap((b) => [b.ex, b.exA, b.exB].filter(Boolean).map((e) => e.name))),
    ...Object.values(EXERCISE_POOLS).flatMap((s) => s.pool.map((e) => e.name)),
    ...Object.values(SWAP_DB).flatMap((alts) => alts.map((a) => a.name)),
  ])].sort();
  const canon = Object.keys(MAIN_LIFT_FUNCTIONAL_EQUIVALENTS);
  const pick = (i) => Object.fromEntries(Object.entries(EXERCISE_POOLS).map(([k, s]) => [k, s.pool[Math.min(i, s.pool.length - 1)]]));
  const timedPicks = Object.fromEntries(Object.entries(EXERCISE_POOLS).flatMap(([k, s]) => {
    const t = s.pool.find((e) => typeof e.reps === "string" && /^\d+s$/.test(e.reps));
    return t ? [[k, t]] : [];
  }));
  const FOCI = [undefined, "Forged", "Strong", "Sculpt"];
  const MAINS = [
    undefined,
    {},
    Object.fromEntries(canon.map((c) => [c, MAIN_LIFT_FUNCTIONAL_EQUIVALENTS[c][0]])),
    Object.fromEntries(canon.map((c) => [c, MAIN_LIFT_FUNCTIONAL_EQUIVALENTS[c].at(-1)])),
    { [canon[0]]: "Leg Press", [canon[1]]: canon[1], [canon[2]]: 7 },
  ];
  const CONFIGS = [
    {},
    pick(0),
    pick(1),
    pick(99),
    { ...pick(2), ...timedPicks, "ass1-A": { name: "Not In Any Pool" }, a1: { name: "Front Squat" } },
  ];
  const loaded = (seed) => {
    const weights = {}, reps = {}, lifts = {};
    names.forEach((n, i) => {
      const k = (i + seed) % 7;
      if (k === 0) return;
      weights[n] = k === 1 ? "x" : 10 + ((i * 7 + seed) % 40) * 2.5;
      reps[n] = [null, 3, "4/leg", 30, 12, "10"][k - 1];
      if (k === 2) lifts[n] = { adoptedReps: 3 };
      if (k === 3) lifts[n] = { currentRepRange: { baseReps: 6 } };
    });
    return {
      weights, reps,
      bodyweight: { kg: 70 + seed },
      addedLoads: { "Glute Bridge": { kg: 10, updatedAt: T1 }, "Push-Up": { kg: 5, updatedAt: T1 } },
      trainingState: { lifts, muscleAnchors: { Quadriceps: { bestE1RM: 140 }, Chest: { bestE1RM: 100 }, Hamstrings: { bestE1RM: 160 } } },
    };
  };
  const wk = (d) => Array.from({ length: 7 }, (_, i) => ({ type: i === d || i === d + 2 ? "strength" : "rest" }));
  const out = [];
  let n = 0;
  for (const focus of FOCI) for (const mainLifts of MAINS) for (const config of CONFIGS) for (const seed of [0, 1]) {
    n++;
    const meta = {
      ...(focus ? { userFocus: focus } : {}),
      ...(mainLifts !== undefined ? { mainLifts } : {}),
      programmeBlock: n % 3 ? { number: n % 5, startDate: "2026-09-01", config } : { config },
      ...(seed ? loaded(n) : { weights: {}, reps: {} }),
      ...(n % 4 === 0 ? { userWeek: [{ effectiveFrom: "2026-01-05", editedAt: "2026-01-05T00:00:00Z", week: wk(n % 5) }] } : {}),
    };
    const history = n % 3 === 0 ? [] : [{ id: "2026-09-10", date: "2026-09-10", session: n % 3 === 1 ? "strength_a" : "strength_b", readiness: "normal", blocks: [] }];
    out.push({ focus: String(focus), meta, history });
  }
  return out;
}

describe("resolvedProgramme behind describeProgramme (E8)", () => {
  // Digests of the programme and current_loads tool text over e8Fixtures,
  // captured from describeProgramme before resolvedProgramme was extracted.
  const BEFORE = { undefined: "0e422ed0f16e1cc0", Forged: "b260f8b6ef1a3b8e", Strong: "0cee9f0eb5c3d8f9", Sculpt: "a7cea783948bf52d" };
  const fixtures = e8Fixtures();
  const texts = fixtures.map((f) => [runTool("programme", {}, f, now).text, runTool("current_loads", {}, f, now).text]);

  it("tool output is byte-identical to the pre-extraction output", () => {
    /** @type {Record<string, string[]>} */
    const by = {};
    fixtures.forEach((f, i) => (by[f.focus] ??= []).push(...texts[i]));
    const digest = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16)]));
    expect(digest).toEqual(BEFORE);
  });
  it("the fixtures reach every way a line renders", () => {
    expect(fixtures).toHaveLength(200);
    expect(new Set(texts.map((t) => t[0])).size).toBe(178);
    const all = texts.flat().join("\n");
    for (const m of ["s hold", "(suggested start)", "@ bodyweight + ", " kg each", "kg assistance", "weight not set yet (new lift)",
      "@ bodyweight\n", "× 4/leg", "× 6-8", "(for Barbell Back Squat)", "programme defaults", "not synced from this user's app yet",
      "Strength days:", "Next up: Strength B", "No working weights set yet."]) expect(all).toContain(m);
  });
});

describe("resolvedProgramme", () => {
  const SQ = "Barbell Back Squat";
  it("lists every slot of the composed sessions, in order", () => {
    for (const f of e8Fixtures().filter((_, i) => i % 7 === 0)) {
      const lifts = validMainLifts(f.meta) || {};
      const config = f.meta.programmeBlock.config;
      const want = SESSIONS.flatMap((t, session) => applyFocusToSession(applyMainLiftsToSession(applyRotationToSession(t, config), lifts), f.meta.userFocus || "Forged", config, lifts)
        .blocks.flatMap((b) => [["ex", b.ex], ["exA", b.exA], ["exB", b.exB]].filter(([, ex]) => ex).map(([slot, ex]) => ({ session, block: b.id, slot, name: ex.name, sets: b.sets }))));
      expect(resolvedProgramme(f.meta).map(({ session, block, slot, name, sets }) => ({ session, block, slot, name, sets }))).toEqual(want);
    }
  });
  it("names the main-lift key a chosen main answers to, per slot", () => {
    const r = resolvedProgramme({ mainLifts: { [SQ]: "Front Squat", "Barbell Overhead Press": "Push Press", "Power Clean": "Push Press" } });
    expect(r.filter((x) => x.canonical).map((x) => `${x.block} ${x.name} <- ${x.canonical}`)).toEqual([
      "a1 Front Squat <- Barbell Back Squat",
      "a2 Barbell Bench Press <- Barbell Bench Press",
      "b1 Hex Bar Deadlift <- Hex Bar Deadlift",
      "b2 Push Press <- Barbell Overhead Press",
      "c1 Push Press <- Power Clean",
    ]);
    expect(r.filter((x) => x.type !== "main").every((x) => x.canonical === null)).toBe(true);
  });
  it("carries the target, load and start the session would use", () => {
    const lsit = EXERCISE_POOLS["afin-A"].pool.find((e) => e.name === "L-Sit Hold");
    const r = resolvedProgramme({
      programmeBlock: { config: { "afin-A": lsit } },
      bodyweight: { kg: 90 },
      weights: { "Barbell Bench Press": 80 },
      reps: { [SQ]: 3, "L-Sit Hold": 30 },
    });
    const at = (n) => r.find((x) => x.name === n);
    expect(at(SQ)).toMatchObject({ reps: 5, timed: false, w: null, start: 67.5, loadType: "barbell", sets: 3 }); // 3 is repaired to the base
    expect(at("Barbell Bench Press")).toMatchObject({ w: 80, start: 80 });
    expect(at("L-Sit Hold")).toMatchObject({ reps: 30, timed: true });
    const bw = r.find((x) => x.loadType === "bodyweight");
    expect(bw?.start).toBeNull();
  });
  it("reads a missing or malformed meta as the default programme", () => {
    expect(resolvedProgramme(null).map((x) => x.name)).toEqual(resolvedProgramme({}).map((x) => x.name));
    expect(resolvedProgramme({}).length).toBeGreaterThan(0);
  });
  it("loadTypeOfName reads the catalogue, then the name", () => {
    expect(loadTypeOfName("45-Degree Hip Extension")).toBe("bodyweight");
    expect(loadTypeOfName(SQ)).toBe("barbell");
  });
});

describe("/mcp reads the grant's account by its storage key", () => {
  const A = "hwa_" + "a".repeat(26);
  const B = "hwa_" + "b".repeat(26);
  const REDIRECT = "https://claude.ai/cb";
  const verifier = "v".repeat(50);
  const NATIVE = "heatwayve.app";
  let dbReadProfile;

  const account = (id, storageKey, deletedAt = null) => route.accounts.set(id, { id, storageKey, deletedAt, roles: ["lifter"], plan: "free" });
  async function connect({ accountId, profile, credentialId = "k1", legacy = false }) {
    const { client } = await registerClient(route.store, { redirect_uris: [REDIRECT] });
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const { code } = await issueCode(route.store, { clientId: client.id, accountId, profile, credentialId, redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256" });
    const { tokens } = await exchangeCode(route.store, { code, clientId: client.id, redirectUri: REDIRECT, codeVerifier: verifier });
    if (legacy) for (const g of await route.store.listGrants({ accountId, storageKey: profile })) g.accountId = null;
    return tokens.access_token;
  }
  const call = async (token) => {
    const { POST } = await import("../app/mcp/route.js");
    return POST(new Request("https://heatwayve.app/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "training_snapshot", arguments: {} } }),
    }));
  };

  beforeEach(async () => {
    route.store = memoryStore(); route.accounts.clear(); route.creds.clear(); route.doc = null;
    ({ dbReadProfile } = await import("../lib/db.js"));
    vi.mocked(dbReadProfile).mockClear();
  });

  it("a pre-account grant {profile: \"sam\", no account id} reads \"sam\", exactly as before", async () => {
    account(A, "sam");
    route.creds.set(A, [{ id: "k1", publicKey: "pk", rpId: NATIVE }]);
    const res = await call(await connect({ accountId: A, profile: "sam", legacy: true }));
    expect(res.status).toBe(200);
    expect(vi.mocked(dbReadProfile).mock.calls).toEqual([["sam"]]);
  });

  it("an account grant reads that account's storage key", async () => {
    account(B, B);
    route.creds.set(B, [{ id: "k2", publicKey: "pk", rpId: NATIVE }]);
    const res = await call(await connect({ accountId: B, profile: B, credentialId: "k2" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(dbReadProfile).mock.calls).toEqual([[B]]);
  });

  it("after the name is reclaimed, the old holder's grant still reads only the old holder's data", async () => {
    account(A, "sam");
    account(B, B); // B now holds the handle "sam"
    route.creds.set(A, [{ id: "k1", publicKey: "pk", rpId: NATIVE }]);
    route.creds.set(B, [{ id: "k2", publicKey: "pk", rpId: NATIVE }]);
    await call(await connect({ accountId: A, profile: "sam", legacy: true }));
    expect(vi.mocked(dbReadProfile).mock.calls).toEqual([["sam"]]);
  });

  it("a passkey indexed on another account, or a closed account, gets 401 and no read", async () => {
    account(A, "sam");
    route.creds.set(B, [{ id: "k1", publicKey: "pk", rpId: NATIVE }]);
    expect((await call(await connect({ accountId: A, profile: "sam" }))).status).toBe(401);
    account(A, "sam", "2026-10-01T00:00:00Z");
    route.creds.set(A, [{ id: "k1", publicKey: "pk", rpId: NATIVE }]);
    expect((await call(await connect({ accountId: A, profile: "sam" }))).status).toBe(401);
    expect(vi.mocked(dbReadProfile)).not.toHaveBeenCalled();
  });
});
