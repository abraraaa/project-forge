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
import { handleMcp, runTool, readingDay, weekOn, validMainLifts, resolvedProgramme, loadTypeOfName, PROTOCOL_VERSIONS } from "../lib/mcp-server.js";
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
const T1 = "2026-09-20T10:00:00.000Z";
const call = (msg, load = async () => data) => handleMcp({ jsonrpc: "2.0", ...msg }, { load });

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
    const t = runTool("training_snapshot", {}, data).text;
    expect(t).toContain("How Heatwayve programmes");
    expect(t).toContain("Focus: Sculpt");
    expect(t).not.toContain("Main lifts: programme defaults");
  });
  it("recent_sessions: a trainer-logged session says so, without the name or account; the description says it does", async () => {
    const withTrainer = { ...data, history: [...data.history, { ...rec("2026-09-07", "Barbell Bench Press", 65, 8, 8),
      loggedBy: { name: "Sam Price", accountId: "hwa_" + "t".repeat(26) } }] };
    const text = runTool("recent_sessions", {}, withTrainer).text;
    expect(text.split("\n").at(-1)).toMatch(/^- 2026-09-07 · fresh · logged with your trainer: /);
    expect(text.split("\n").filter((l) => l.includes("trainer"))).toHaveLength(1);
    expect(text).not.toMatch(/Sam|hwa_/);
    const r = await call({ id: 4, method: "tools/list" });
    expect(r.result.tools.find((t) => t.name === "recent_sessions").description).toMatch(/whether a trainer logged it with them/);
  });
  it("recent_sessions clamps its limit", () => {
    expect(runTool("recent_sessions", { limit: 1 }, data).text.split("\n")).toHaveLength(1);
    expect(runTool("recent_sessions", { limit: 999 }, data).text.split("\n")).toHaveLength(3);
  });
  it("lift_history matches by name, oldest first", () => {
    const t = runTool("lift_history", { lifts: ["bench"] }, data).text.split("\n");
    expect(t).toHaveLength(3); // heading + two sessions
    expect(t[1]).toContain("2026-09-01");
    expect(t[2]).toContain("62.5×8 @8");
  });
  it("lift_history answers several lifts in one call and names the misses", () => {
    const t = runTool("lift_history", { lifts: ["bench", "hip thrust", "curl"] }, data).text;
    expect(t).toContain("## bench");
    expect(t).toContain("## hip thrust");
    expect(t).toContain("No logged sets match: curl.");
    expect(t).toContain("Logged exercises: Barbell Bench Press, Barbell Hip Thrust.");
  });
  it("current_loads covers every exercise in one call", () => {
    const d = { meta: { weights: { "Barbell Bench Press": 62.5, "Barbell Hip Thrust": 100 }, reps: { "Barbell Bench Press": "8", "Plank": "45s" } }, history: [] };
    expect(runTool("current_loads", {}, d).text.split("\n")).toEqual([
      "- Barbell Bench Press: 62.5 kg × 8",
      "- Barbell Hip Thrust: 100 kg",
      "- Plank: bodyweight × 45s",
    ]);
  });
  it("current_loads reads a corrupt stored W as no W", () => {
    const d = { meta: { weights: { "Barbell Bench Press": 9000, "Barbell Hip Thrust": -5, "Hex Bar Deadlift": 300 } }, history: [] };
    expect(runTool("current_loads", {}, d).text.split("\n")).toEqual(["- Hex Bar Deadlift: 300 kg"]);
  });
  it("current_loads: pure-BW lifts show the added load, never a phantom W", () => {
    // "Barbell Glute Bridge" name-matches the bodyweight pattern but is a
    // barbell lift; "45-Degree Hip Extension" is bodyweight but unmatched.
    const d = { meta: {
      weights: { "Glute Bridge": 80, "45-Degree Hip Extension": 40, "Barbell Glute Bridge": 60 },
      reps: { "Glute Bridge": 12 },
      addedLoads: { "Glute Bridge": { kg: 10, updatedAt: T1 } },
    }, history: [] };
    expect(runTool("current_loads", {}, d).text.split("\n")).toEqual([
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
    expect(runTool("current_loads", {}, d).text.split("\n")).toEqual([
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
    const t = runTool("lift_history", { lifts: ["glute bridge", "pull-up"] }, { meta: {}, history: h }).text;
    expect(t).toContain("BW+10×12 @8, BW×12 @8, BW×15 @8");
    expect(t).toContain("BW+10×8 @8");
    expect(t).not.toContain("BW+40");
    expect(t).not.toContain("40×15");
  });
  it("an empty profile reads as empty, not an error", () => {
    expect(runTool("recent_sessions", {}, null).text).toBe("No sessions logged yet.");
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

describe("dates: the lifter's own calendar, never the server's clock or zone", () => {
  const LAST = "2026-09-05";
  const snapshot = (args = {}, d = data) => runTool("training_snapshot", args, d).text;
  const tool = (name, args = {}, d = data) => runTool(name, args, d).text;
  const SINCE = ["training_snapshot", "programme", "current_loads"];

  /** Run `fn` with the server's clock at `ms` and its zone `zone`. */
  function atServer(ms, zone, fn) {
    const was = process.env.TZ;
    process.env.TZ = zone;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ms);
    try { return fn(); } finally {
      vi.useRealTimers();
      if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
    }
  }
  const CLOCKS = [Date.parse("2026-09-05T23:30:00Z"), Date.parse("2026-11-18T08:00:00Z"), Date.parse("2031-02-01T12:00:00Z")];
  const ZONES = ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Kiritimati"];
  const deloaded = {
    ...data,
    meta: { ...data.meta, trainingState: { lifts: {}, mesocycle: { currentPhase: "deload",
      activeDeload: { startedAt: "2026-09-03T12:00:00.000Z", plannedDays: 5, triggeredBy: "stall_convergence", triggeredLifts: [], preDeloadWeights: {} } } } },
  };

  it("the instructions and the three dated tools' schemas say dates are YYYY-MM-DD on the user's calendar", async () => {
    const init = await call({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.result.instructions).toMatch(/YYYY-MM-DD on the user's own calendar/);
    expect(init.result.instructions).toMatch(/asOf/);
    const tools = (await call({ id: 2, method: "tools/list" })).result.tools;
    for (const t of tools) {
      const props = Object.keys(t.inputSchema.properties);
      if (SINCE.includes(t.name)) {
        expect(t.inputSchema.properties.asOf, t.name).toMatchObject({ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
        expect(t.inputSchema.properties.asOf.description, t.name).toMatch(/today's date/i);
        expect(t.inputSchema.required ?? [], t.name).not.toContain("asOf");
      } else {
        expect(props, t.name).not.toContain("asOf");
      }
    }
    expect(tools.filter((t) => !SINCE.includes(t.name)).map((t) => t.name).sort()).toEqual(["chart_style", "lift_history", "recent_sessions"]);
  });

  it("without asOf, every tool's output is the same whatever the server's clock or zone", () => {
    for (const d of [data, deloaded, { meta: {}, history: [] }]) {
      for (const name of [...SINCE, "recent_sessions", "chart_style", "lift_history"]) {
        const args = name === "lift_history" ? { lifts: ["bench"] } : {};
        const outs = new Set(CLOCKS.flatMap((ms) => ZONES.map((z) => atServer(ms, z, () => tool(name, args, d)))));
        expect(outs.size, name).toBe(1);
      }
    }
  });

  it("with asOf, the output is the same whatever the server's clock or zone", () => {
    for (const name of SINCE) {
      const outs = new Set(CLOCKS.flatMap((ms) => ZONES.map((z) => atServer(ms, z, () => tool(name, { asOf: "2026-11-18" }, deloaded)))));
      expect(outs.size, name).toBe(1);
    }
  });

  it("without asOf, the snapshot reads as of the last logged session and names no other day", () => {
    const t = atServer(CLOCKS[2], "Asia/Tokyo", () => snapshot());
    expect(t.split("\n").slice(0, 2)).toEqual([
      `# My training — Heatwayve snapshot as of ${LAST}, my last logged session`,
      `Dates are my own calendar's. It shows what I'd done by my last session, ${LAST}; it doesn't say how long ago that was.`,
    ]);
    const days = new Set(t.match(/\d{4}-\d{2}-\d{2}/g));
    for (const day of days) expect(day <= LAST, day).toBe(true);
    expect(t).not.toMatch(/this week|in progress|2031-|last 2 weeks/);
  });

  it("with asOf, the snapshot reads through it, states the gap, names weeks by their Mondays and ends the volume window there", () => {
    const t = snapshot({ asOf: "2026-11-18" });
    const lines = t.split("\n");
    expect(lines.slice(0, 2)).toEqual([
      "# My training — Heatwayve snapshot through 2026-11-18",
      "Dates are my own calendar's. It shows what I'd done through 2026-11-18, nothing after. My last session was 2026-09-05, 74 days before 2026-11-18.",
    ]);
    const head = lines.findIndex((l) => l.startsWith("## Consistency"));
    expect(lines[head]).toBe("## Consistency, 8 weeks to 2026-11-18 (strength days done/planned, oldest first, each week named by its Monday)");
    const cells = lines[head + 2].split(" · ");
    expect(cells).toHaveLength(8);
    expect(cells.map((c) => c.slice(0, 12))).toEqual(["2026-09-28: ", "2026-10-05: ", "2026-10-12: ", "2026-10-19: ", "2026-10-26: ", "2026-11-02: ", "2026-11-09: ", "2026-11-16: "]);
    expect(cells[7]).toMatch(/^2026-11-16: 0\/\d+ through 2026-11-18 \(\d+ planned\)$/);
    // Nothing in the two weeks to 2026-11-18: the volume section stands down.
    expect(t).not.toContain("## Weekly volume");
  });

  it("the volume window is the two weeks to asOf: a session after it is left out", () => {
    const at = (asOf) => {
      const t = snapshot(asOf ? { asOf } : {});
      const lines = t.split("\n");
      const i = lines.findIndex((l) => l.startsWith("## Weekly volume"));
      return [lines[i], lines.slice(i + 1).find((l) => l.startsWith("- Chest:"))];
    };
    expect(at(null)[0]).toBe(`## Weekly volume vs landmarks, 2 weeks to ${LAST} (sets per week)`);
    const before = at("2026-09-04");
    expect(before[0]).toBe("## Weekly volume vs landmarks, 2 weeks to 2026-09-04 (sets per week)");
    const chest = (line) => Number(line.match(/^- Chest: ([\d.]+)/)[1]);
    expect(chest(before[1]) * 2).toBeCloseTo(chest(at(null)[1]), 5);
    expect(snapshot({ asOf: "2026-09-04" }).split("\n")[1]).toBe(
      "Dates are my own calendar's. It shows what I'd done through 2026-09-04, nothing after. My last session was 2026-09-05, the day after 2026-09-04.");
    expect(snapshot({ asOf: "2026-09-06" }).split("\n")[1]).toMatch(/My last session was 2026-09-05, the day before 2026-09-06\.$/);
    expect(snapshot({ asOf: LAST }).split("\n")[1]).toMatch(/My last session was on 2026-09-05\.$/);
  });

  it("asOf counts only as a real date from a day before the last session to 366 days after it; a malformed one is as if absent", () => {
    const plain = snapshot();
    for (const asOf of ["2026-02-30", "2026-9-5", "2026-09-05T00:00", "", 20260905, null, "tomorrow"]) {
      expect(snapshot({ asOf }), String(asOf)).toBe(plain);
      for (const name of ["programme", "current_loads"]) expect(tool(name, { asOf }, deloaded), `${name} ${asOf}`).toBe(tool(name, {}, deloaded));
    }
    expect(snapshot({ asOf: "2027-09-06" }).split("\n")[0]).toBe("# My training — Heatwayve snapshot through 2027-09-06");
    expect(snapshot({ asOf: "2026-09-04" }).split("\n")[0]).toBe("# My training — Heatwayve snapshot through 2026-09-04");
  });

  it("a real asOf outside that range is set aside: the snapshot, programme and current_loads say so once, and why", () => {
    const cases = [
      ["2026-09-03", `asOf 2026-09-03 is more than a day before my last session (${LAST}), so this reads on ${LAST}.`],
      ["2027-09-07", `asOf 2027-09-07 is more than a year after my last session (${LAST}), so this reads on ${LAST}.`],
    ];
    expect(readingDay(data.history, "2027-09-07")).toEqual({ day: LAST, asOf: false, last: LAST, rejected: { asOf: "2027-09-07", after: true } });
    expect(readingDay(data.history, "2026-09-03").rejected).toEqual({ asOf: "2026-09-03", after: false });
    expect(readingDay(data.history, "2026-09-04").rejected).toBe(null);
    expect(readingDay(data.history, "2026-9-3").rejected).toBe(null);
    for (const [asOf, said] of cases) {
      const lines = snapshot({ asOf }).split("\n");
      expect(lines[2], asOf).toBe(said);
      expect(lines.filter((l) => l !== said).join("\n")).toBe(snapshot());
      for (const name of ["programme", "current_loads"]) {
        const text = tool(name, { asOf }, deloaded);
        expect(text.split("\n").filter((l) => l === said), `${name} ${asOf}`).toHaveLength(1);
        expect(text.match(/asOf /g), `${name} ${asOf}`).toHaveLength(1);
      }
    }
  });

  it("with no sessions, any real asOf counts; without one there is no date at all", () => {
    const none = { meta: {}, history: [] };
    expect(snapshot({ asOf: "2031-02-01" }, none).split("\n").slice(0, 2)).toEqual([
      "# My training — Heatwayve snapshot through 2031-02-01", "Dates are my own calendar's. It shows what I'd done through 2031-02-01, nothing after."]);
    const t = snapshot({}, none);
    expect(t.split("\n").slice(0, 2)).toEqual(["# My training — Heatwayve snapshot", "Dates are my own calendar's."]);
    expect(t).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(t).toContain("No sessions logged yet.");
  });

  it("programme and current_loads name the day they read on, once", () => {
    const none = { meta: {}, history: [] };
    for (const [name, at] of [["programme", 1], ["current_loads", 0]]) {
      const read = (args, d = deloaded) => tool(name, args, d).split("\n");
      expect(read({})[at], name).toBe(`Read on ${LAST} (my last logged session).`);
      expect(read({ asOf: "2026-11-18" })[at], name).toBe("Read on 2026-11-18.");
      expect(read({ asOf: "2026-09-04" })[at], name).toBe("Read on 2026-09-04.");
      for (const args of [{}, { asOf: "2026-11-18" }]) expect(read(args).filter((l) => l.startsWith("Read on")), name).toHaveLength(1);
      // Set aside: its own line names the day instead.
      expect(read({ asOf: "2027-09-07" }).some((l) => l.startsWith("Read on")), name).toBe(false);
      expect(read({}, none).some((l) => l.startsWith("Read on")), name).toBe(false);
      expect(read({ asOf: "2031-02-01" }, none)[at], name).toBe("Read on 2031-02-01.");
    }
  });

  it("programme and current_loads read the deload calendar on asOf, else on the last session's date", () => {
    const tool = (name, args, d) => runTool(name, args, d).text.split("\n").filter((l) => !l.startsWith("Read on")).join("\n");
    // The deload runs 2026-09-03 to 2026-09-07 on the lifter's calendar; the last session is in it.
    const inWindow = tool("programme", {}, deloaded);
    expect(inWindow).toContain("Deload week");
    expect(tool("programme", { asOf: "2026-09-06" }, deloaded)).toBe(inWindow);
    expect(tool("programme", { asOf: "2026-09-20" }, deloaded)).not.toContain("Deload week");
    expect(tool("current_loads", { asOf: "2026-09-06" }, deloaded)).toBe(tool("current_loads", {}, deloaded));
  });

  it("recent_sessions, lift_history and chart_style ignore an asOf", () => {
    for (const [name, args] of [["recent_sessions", {}], ["lift_history", { lifts: ["bench"] }], ["chart_style", {}]]) {
      expect(tool(name, { ...args, asOf: "2026-11-18" }), name).toBe(tool(name, args));
    }
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
  const text = runTool("programme", {}, { meta, history: [] }).text;

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
    const t = runTool("programme", {}, { meta: { ...meta, mainLifts: undefined }, history: [] }).text;
    expect(t).toContain("not synced from this user's app yet");
  });
  it("drops choices that aren't listed equivalents", () => {
    expect(validMainLifts({ mainLifts: { [SQ]: "Leg Press", "Barbell Bench Press": "Dumbbell Bench Press" } }))
      .toEqual({ "Barbell Bench Press": "Dumbbell Bench Press" });
    expect(validMainLifts({})).toBeNull();
  });
  it("the snapshot names main lifts once they sync", () => {
    const t = runTool("training_snapshot", {}, { meta, history: data.history }).text;
    expect(t).toContain("Main lifts: Front Squat (for Barbell Back Squat)");
  });
});

describe("programme loads read the way the session screen reads them", () => {
  const base = { programmeBlock: { number: 1, config: {} }, userFocus: "Forged", reps: {} };
  const run = (meta) => runTool("programme", {}, { meta: { ...base, ...meta }, history: [] }).text;

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
    }).text;
    expect(t).toContain("L-Sit Hold 4 × 30s hold");
  });
  it("a pure-BW slot ignores a phantom W", () => {
    const hx = EXERCISE_POOLS["ass2-A"].pool.find((e) => e.name === "45-Degree Hip Extension");
    expect(hx).toBeTruthy();
    const t = runTool("programme", {}, {
      meta: { ...base, programmeBlock: { number: 1, config: { "ass2-A": hx } }, mainLifts: {}, weights: { "45-Degree Hip Extension": 40 } },
      history: [],
    }).text;
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
    }).text;
    expect(t).toMatch(/45-Degree Hip Extension \d+ × \S+ @ bodyweight \+ 10 kg/);
  });
  it("malformed synced data is a tool error, never a thrown request", async () => {
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "recent_sessions" } },
      { load: async () => ({ meta: {}, history: [{ date: "x", blocks: "abc" }] }) },
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
      trainingState: { lifts },
    };
  };
  // A loaded fixture's anchors, from history: one record with no session
  // letter (the next session reads as without it). Quadriceps 140, Chest 100,
  // Hamstrings 120 / 0.75 = 160.
  const set = (weight, reps, est1rm) => ({ weight, reps, rir: 2, loadType: "barbell", effectiveLoad: weight, est1rm });
  const ANCHOR_RECORD = {
    id: "2026-09-01T10:00:00.000Z", date: "2026-09-01", schemaVersion: 3, readiness: "normal",
    blocks: [{ id: "m1", type: "main", exercises: [
      { name: "Barbell Back Squat", loadType: "barbell", sets: [set(120, 5, 140)] },
      { name: "Barbell Bench Press", loadType: "barbell", sets: [set(75, 10, 100)] },
      { name: "Romanian Deadlift", loadType: "barbell", sets: [set(100, 6, 120)] },
    ] }],
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
    const history = [
      ...(seed ? [ANCHOR_RECORD] : []),
      ...(n % 3 === 0 ? [] : [{ id: "2026-09-10", date: "2026-09-10", session: n % 3 === 1 ? "strength_a" : "strength_b", readiness: "normal", blocks: [] }]),
    ];
    out.push({ focus: String(focus), meta, history });
  }
  return out;
}

describe("an unset (a stored null weight or reps) reads as no stored value", () => {
  const SQ = "Barbell Back Squat";
  const BENCH = "Barbell Bench Press";
  const base = { programmeBlock: { number: 1, config: {} }, userFocus: "Forged", mainLifts: {}, bodyweight: { kg: 80 } };
  const planted = { ...base, weights: { [SQ]: null, [BENCH]: 60 }, weightStamps: { [SQ]: T1, [BENCH]: T1 }, reps: { [SQ]: null, [BENCH]: 8 }, repStamps: { [SQ]: T1, [BENCH]: T1 } };
  const absent = { ...base, weights: { [BENCH]: 60 }, reps: { [BENCH]: 8 } };
  const tools = ["programme", "current_loads", "training_snapshot"];

  it("no tool prints null, NaN or undefined, or throws", () => {
    for (const t of tools) {
      const text = runTool(t, {}, { meta: planted, history: data.history }).text;
      expect(text, t).not.toMatch(/null|NaN|undefined/);
    }
  });
  it("the programme reads exactly as with the key absent: the squat a suggested start at its template reps", () => {
    const a = runTool("programme", {}, { meta: planted, history: [] }).text;
    expect(a).toBe(runTool("programme", {}, { meta: absent, history: [] }).text);
    expect(a).toContain(`${SQ} 3 × 5 @ 60 kg (suggested start)`);
    expect(a).toContain(`${BENCH} 3 × 8 @ 60 kg`);
  });
  it("current_loads reads exactly as with the key absent", () => {
    const a = runTool("current_loads", {}, { meta: planted, history: [] }).text;
    expect(a).toBe(runTool("current_loads", {}, { meta: absent, history: [] }).text);
    expect(a).toBe(`- ${BENCH}: 60 kg × 8`);
  });
  it("current_loads with only unsets reads as no working weights", () => {
    const onlyUnsets = { ...base, weights: { [SQ]: null }, weightStamps: { [SQ]: T1 }, reps: { [SQ]: null }, repStamps: { [SQ]: T1 } };
    expect(runTool("current_loads", {}, { meta: onlyUnsets, history: [] }).text).toBe("No working weights set yet.");
  });
  it("resolvedProgramme: w null, start the planned number", () => {
    const l = resolvedProgramme(planted).find((x) => x.name === SQ);
    expect(l.w).toBeNull();
    expect(l.reps).toBe(5);
    expect(l.start).toBe(60);
  });
});

describe("resolvedProgramme behind describeProgramme (E8)", () => {
  // Digests of the programme and current_loads tool text over e8Fixtures,
  // captured from describeProgramme before resolvedProgramme was extracted.
  // The fixtures read the live pools, swaps and lift profiles, so a library
  // change re-captures them. Re-captured 2026-10-13 for library data only
  // (the Single-Leg RDL profile dropped); the tool code was unchanged.
  // Re-captured for Day A's pairing (lunge + landmine press, hip extension +
  // row): the two B pools changed places; the tool code was unchanged. Strong
  // re-captured for the same re-pair and its Day A drop moving to the lunge +
  // landmine superset (ass1), so Strong's Day A keeps the hip extension + row.
  // Re-captured 2026-11-03: the pool edits of that day moved the solved weeks.
  // Re-captured 2026-11-16 for library data only (factors, templates, the
  // Triceps reference, template starts and the machine isolation ceiling),
  // and again for that day's pool edits and load types.
  const BEFORE = { undefined: "3cb1f70048934ff3", Forged: "1f1ed1f00d78b35b", Strong: "808c7f291ffe98fc", Sculpt: "b19e5e99b4ffd0be" };
  const fixtures = e8Fixtures();
  // The day line came later; the rest of each text is pinned as it was.
  const undated = (text) => text.split("\n").filter((l) => !l.startsWith("Read on ")).join("\n");
  const texts = fixtures.map((f) => [undated(runTool("programme", {}, f).text), undated(runTool("current_loads", {}, f).text)]);

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
