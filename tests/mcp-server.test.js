import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handleMcp, runTool, weekOn, validMainLifts, PROTOCOL_VERSIONS } from "../lib/mcp-server.js";
import { SESSIONS, EXERCISE_POOLS, applyRotationToSession, applyMainLiftsToSession, applyFocusToSession } from "../lib/programme.js";

const rec = (date, name, weight, reps, rpe) => ({
  id: date, date, session: "strength_a", readiness: "fresh",
  blocks: [{ exercises: [{ name, sets: [{ weight, reps, rpe }, { weight, reps, rpe }] }] }],
});
const data = {
  meta: { userFocus: "Sculpt", bodyweight: { kg: 70 }, trainingState: null },
  history: [rec("2026-09-01", "Barbell Bench Press", 60, 8, 8), rec("2026-09-03", "Barbell Hip Thrust", 100, 10, 7), rec("2026-09-05", "Barbell Bench Press", 62.5, 8, 8)],
};
const now = new Date("2026-09-24T12:00:00Z");
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
    expect(src).toContain("verifyAccessToken(store, token, { credentialExists })");
    expect(src).toContain('resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"');
  });
  it("reads only the token's profile, and never photos", () => {
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
  it("malformed synced data is a tool error, never a thrown request", async () => {
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "recent_sessions" } },
      { load: async () => ({ meta: {}, history: [{ date: "x", blocks: "abc" }] }), now },
    );
    expect(r.result.isError).toBe(true);
  });
});
