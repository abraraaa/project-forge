// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/mcp-server.js — the MCP JSON-RPC handler behind /mcp. Stateless, read
// only, one profile per call (the one the access token names). The profile is
// loaded lazily, once, and only for tools/call — handshakes cost no DB read.

import { buildCoachContext, sessionLine } from "./coach-context.js";
import {
  WEEK, SESSIONS, EXERCISE_POOLS, SWAP_DB, nextStrengthIdx, isValidMainLiftChoice,
  applyRotationToSession, applyMainLiftsToSession, applyFocusToSession,
} from "./programme.js";
import { localDateStr } from "./dates.js";
import { startingWeightForLift } from "./storage.js";
import { getLoadType, isBodyweightMovement, parseTimedReps, swapLoadType, addedLoadFor, loggedAddedKg } from "./lift-translations.js";
import { ensureScheduleHistory, scheduleEntryOn } from "./sync-merge.js";
import { chartStyleText } from "./chart-style.js";
import { repTargetRepairs } from "./progression.js";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const INSTRUCTIONS = "Heatwayve is a strength-training app. These tools read the user's own training, read only. Start with training_snapshot: it explains how the programme works before the numbers. Use programme for what they're running next. Before you draw any chart or visual from this data, call chart_style and follow it. Progress photos are never available here.";

const TOOLS = [
  {
    name: "training_snapshot",
    title: "Training snapshot",
    description: "How the programme works, the user's setup, 8-week consistency, main-lift trends, weekly volume against MEV/MRV, and the last six sessions. Call this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "recent_sessions",
    title: "Recent sessions",
    description: "The most recent logged sessions, newest last: date, readiness, and each exercise's weight, reps and effort (RPE).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 30, default: 10 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "programme",
    title: "Programme",
    description: "The programme the user is running right now: block, focus, main-lift choices, which session is next, and every exercise in sessions A, B and C with sets × reps and working weight — exactly what the app shows.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "chart_style",
    title: "Chart style",
    description: "Heatwayve's palette (light and dark), typefaces and chart rules. Call this before drawing any chart, graph or visual of the user's training so it matches the app.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "current_loads",
    title: "Current loads",
    description: "Every exercise's current working weight (bodyweight lifts: any added load) and rep target, in one call — the whole programme's loading at a glance.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "lift_history",
    title: "Lift history",
    description: "Logged sets for up to 10 exercises in one call, oldest first. Matches by name, e.g. [\"bench\", \"hip thrust\"]. Ask for several at once rather than one per call.",
    inputSchema: {
      type: "object",
      properties: {
        lifts: { type: "array", items: { type: "string", minLength: 2, maxLength: 60 }, minItems: 1, maxItems: 10 },
        limit: { type: "integer", minimum: 1, maximum: 60, default: 20, description: "Most recent sets-lines per lift." },
      },
      required: ["lifts"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

/** Every exercise name in the log, for "did you mean". */
const knownNames = (history) => [...new Set(history.flatMap((rec) => (rec.blocks || []).flatMap((b) => (b.exercises || []).map((e) => e.name)).filter(Boolean)))].sort();

/** The schedule in force today, from the synced edit log. */
export function weekOn(history, todayIso) {
  // Same shapes and resolution rule as the app, including a legacy bare 7-day array.
  const best = scheduleEntryOn(ensureScheduleHistory(history), todayIso);
  return best ? best.week : WEEK;
}

/**
 * Main-lift choices as synced, keeping only listed equivalents. `null` when
 * the profile has never synced the field (an older app) — unknown, which is
 * not the same as "programme defaults".
 * @param {any} meta
 * @returns {Record<string, string> | null}
 */
export function validMainLifts(meta) {
  if (!meta || meta.mainLifts == null || typeof meta.mainLifts !== "object") return null;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [canonical, choice] of Object.entries(meta.mainLifts)) {
    if (typeof choice === "string" && isValidMainLiftChoice(canonical, choice)) out[canonical] = choice;
  }
  return out;
}

const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const own = (obj, k) => (obj && Object.hasOwn(obj, k) ? obj[k] : undefined);

// Name → load type through every door the programme has (sessions, pools,
// swaps); tests/load-type-pairings.test.js holds that each name resolves one
// way. Built once. Names outside the catalogue fall back to inference.
/** @type {Map<string, string> | null} */
let _loadTypeByName = null;
function catalogueLoadTypes() {
  if (!_loadTypeByName) {
    const m = new Map();
    const put = (ex, lt) => { if (ex?.name && !m.has(ex.name)) m.set(ex.name, lt); };
    for (const s of SESSIONS) for (const b of s.blocks || []) for (const ex of [b.ex, b.exA, b.exB]) if (ex) put(ex, getLoadType(ex));
    for (const slot of Object.values(EXERCISE_POOLS)) for (const p of slot.pool || []) put(p, getLoadType(p));
    for (const alts of Object.values(SWAP_DB)) for (const a of alts || []) put(a, swapLoadType(a));
    _loadTypeByName = m;
  }
  return _loadTypeByName;
}
const loadTypeOfName = (name) => catalogueLoadTypes().get(name) ?? getLoadType({ name });
const hasCatalogueName = (name) => catalogueLoadTypes().has(name);
/** A pure bodyweight lift reads as bodyweight, plus the user's optional added load. */
const bodyweightLoad = (addedLoads, name) => {
  const kg = addedLoadFor(addedLoads, name);
  return kg != null ? `bodyweight + ${kg} kg` : "bodyweight";
};

/**
 * One exercise as a prescription line fragment, resolved the way the session
 * screen does: working weight, else a bodyweight-seeded start (main lifts),
 * else the template; load type decides how the number reads.
 */
function exLine(ex, sets, weights, reps, bw, addedLoads) {
  const wr = own(reps, ex.name);
  const r = wr !== undefined && parseTimedReps(ex.reps) && typeof wr === "number" ? `${wr}s hold` : (wr ?? ex.reps);
  const stored = own(weights, ex.name);
  const w = stored !== undefined ? stored : (startingWeightForLift(ex.name, bw, ex.weight) ?? ex.weight);
  const lt = getLoadType(ex);
  const start = stored === undefined ? " (suggested start)" : "";
  let load;
  if (lt === "bodyweight") load = bodyweightLoad(addedLoads, ex.name); // W is never read for these
  else if (typeof w !== "number" || !(w > 0)) load = isBodyweightMovement(lt) ? "bodyweight" : "weight not set yet (new lift)";
  else if (lt === "assisted_bodyweight") load = `${w} kg assistance${start}`;
  else if (lt === "loaded_bodyweight" || lt === "loaded_bw") load = `bodyweight + ${w} kg${start}`;
  else load = `${w} kg${lt === "per_db" ? " each" : ""}${start}`;
  return `${ex.name} ${sets} × ${r} @ ${load}`;
}

/** Sessions A, B and C exactly as the app composes them: rotation → main lifts → focus. */
function composedSessions(meta) {
  const config = meta.programmeBlock?.config || {};
  const focus = meta.userFocus || "Forged";
  const lifts = validMainLifts(meta) || {};
  return SESSIONS.map((template) => applyFocusToSession(
    applyMainLiftsToSession(applyRotationToSession(template, config), lifts),
    focus, config, lifts,
  ));
}

/** Rep targets as the next session shows them: the stored ones, with any the
 * session would repair (repTargetRepairs, the same rule the app plans with).
 * Without synced lift state an adoption can't be told from a relic, so the
 * stored targets show as they are. A lift in two slots takes the first's template. */
function repTargets(meta, sessions = composedSessions(meta)) {
  const reps = meta.reps && typeof meta.reps === "object" ? meta.reps : {};
  // No synced lift state reads as none for every lift, so the template base
  // still repairs a relic: the same answer the app gives on that device.
  const lifts = meta.trainingState?.lifts && typeof meta.trainingState.lifts === "object" ? meta.trainingState.lifts : {};
  return { ...reps, ...repTargetRepairs({ reps, lifts, sessions }) };
}

/** The programme exactly as the app composes it: rotation → main lifts → focus. */
export function describeProgramme(meta, history, todayIso) {
  const block = meta.programmeBlock || {};
  const focus = meta.userFocus || "Forged";
  const lifts = validMainLifts(meta);
  const weights = meta.weights && typeof meta.weights === "object" ? meta.weights : {};
  const sessions = composedSessions(meta);
  const reps = repTargets(meta, sessions);
  const bw = typeof meta.bodyweight?.kg === "number" ? meta.bodyweight.kg : null;
  const addedLoads = meta.addedLoads && typeof meta.addedLoads === "object" && !Array.isArray(meta.addedLoads) ? meta.addedLoads : {};
  const week = weekOn(meta.userWeek, todayIso);
  const out = [];

  out.push(`# Programme — block ${block.number || 1}${block.startDate ? `, started ${block.startDate}` : ""} · ${focus} focus`);
  const days = (week || []).map((d, i) => (d?.type === "strength" ? DAY_ABBR[i] : null)).filter(Boolean);
  if (days.length) out.push(`Strength days: ${days.join(", ")}. Sessions run A → B → C in order, whichever day they land on.`);
  const next = SESSIONS[nextStrengthIdx(history)];
  if (next) out.push(`Next up: ${next.name}.`);
  if (lifts) {
    const swaps = Object.entries(lifts).filter(([k, v]) => v !== k).map(([k, v]) => `${v} (for ${k})`);
    out.push(`Main lifts: ${swaps.length ? swaps.join("; ") : "programme defaults"}.`);
  } else {
    out.push("Main lifts: not synced from this user's app yet — assume programme defaults, and ask.");
  }

  for (const session of sessions) {
    out.push("", `## ${session.name} — ${session.subtitle}`);
    for (const b of session.blocks || []) {
      const sets = b.sets || 0;
      if (b.ex) out.push(`- ${b.label}: ${exLine(b.ex, sets, weights, reps, bw, addedLoads)}`);
      else if (b.exA && b.exB) out.push(`- ${b.label}: ${exLine(b.exA, sets, weights, reps, bw, addedLoads)} + ${exLine(b.exB, sets, weights, reps, bw, addedLoads)}`);
    }
  }
  out.push("", "Accessories rotate at block boundaries, not session to session. Weights and reps move with the progression engine after each session.");
  return out.join("\n");
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Number.isInteger(v) ? v : dflt;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * Run one tool against a loaded profile. Pure.
 * @param {string} name
 * @param {any} args
 * @param {{ meta: any, history: any[] } | null} data
 * @param {Date} now
 * @returns {{ text: string, isError?: boolean }}
 */
export function runTool(name, args, data, now) {
  const meta = data?.meta || {};
  const history = Array.isArray(data?.history) ? data.history : [];
  if (name === "training_snapshot") {
    return {
      text: buildCoachContext({
        history,
        trainingState: meta.trainingState || null,
        focus: meta.userFocus || "Forged",
        mainLifts: validMainLifts(meta), // null (unknown) until the app syncs them
        week: weekOn(meta.userWeek, localDateStr(now)),
        weekFor: (iso) => weekOn(meta.userWeek, iso),
        breaks: Array.isArray(meta.breaks) ? meta.breaks : [],
        bodyweightKg: meta.bodyweight?.kg ?? null,
        now,
      }),
    };
  }
  if (name === "recent_sessions") {
    const recent = history.slice(-clampInt(args?.limit, 1, 30, 10));
    return { text: recent.length ? recent.map(sessionLine).join("\n") : "No sessions logged yet." };
  }
  if (name === "chart_style") return { text: chartStyleText() };
  if (name === "programme") {
    return { text: describeProgramme(meta, history, localDateStr(now)) };
  }
  if (name === "current_loads") {
    const weights = meta.weights && typeof meta.weights === "object" ? meta.weights : {};
    const reps = repTargets(meta);
    // A pure bodyweight lift never shows a stale working weight: its load is
    // the body plus the user's optional added load. Catalogue type decides;
    // key presence decides only for names outside the catalogue (travel
    // twins), so a backpack entry under a gym-loaded name never hides its W.
    const added = meta.addedLoads && typeof meta.addedLoads === "object" && !Array.isArray(meta.addedLoads) ? meta.addedLoads : {};
    const pureBw = (n) => hasCatalogueName(n)
      ? loadTypeOfName(n) === "bodyweight"
      : (Object.hasOwn(added, n) || loadTypeOfName(n) === "bodyweight");
    const names = [...new Set([...Object.keys(weights), ...Object.keys(reps), ...Object.keys(added).filter(pureBw)])].sort();
    if (!names.length) return { text: "No working weights set yet." };
    return { text: names.map((n) => {
      const load = pureBw(n) ? bodyweightLoad(added, n) : (weights[n] != null ? `${weights[n]} kg` : "bodyweight");
      return `- ${n}: ${load}${reps[n] != null ? ` × ${reps[n]}` : ""}`;
    }).join("\n") };
  }
  if (name === "lift_history") {
    const asked = (Array.isArray(args?.lifts) ? args.lifts : args?.lift != null ? [args.lift] : [])
      .map((x) => String(x).trim()).filter((x) => x.length >= 2).slice(0, 10);
    if (!asked.length) return { text: "Name at least one lift, e.g. [\"bench\"].", isError: true };
    const limit = clampInt(args?.limit, 1, 60, 20);
    const sections = [], missed = [];
    for (const want of asked) {
      const q = want.toLowerCase();
      const lines = [];
      for (const rec of history) {
        for (const ex of (rec.blocks || []).flatMap((b) => b.exercises || [])) {
          if (!String(ex.name || "").toLowerCase().includes(q)) continue;
          const sets = (ex.sets || []).filter((s) => s && s.reps != null);
          if (!sets.length) continue;
          lines.push(`- ${rec.date} · ${ex.name}: ${sets.map((s) => {
            // Bodyweight lifts store ADDED load in weight: "BW+10". A pure
            // bodyweight set's weight counts only when its effective load
            // proves it was worn (loggedAddedKg).
            const lt = s.loadType ?? ex.loadType;
            const ADDED = lt === "bodyweight" || lt === "loaded_bodyweight" || lt === "loaded_bw";
            const kg = ADDED ? loggedAddedKg(s, lt) : null;
            const w = ADDED ? (kg != null ? `BW+${kg}` : "BW") : (s.weight ?? "BW");
            // Effort only from a number: enum-era records hold labels.
            return `${w}×${s.reps}${Number.isFinite(s.rpe) ? ` @${s.rpe}` : ""}`;
          }).join(", ")}`);
        }
      }
      if (lines.length) sections.push(`## ${want}\n${lines.slice(-limit).join("\n")}`);
      else missed.push(want);
    }
    if (missed.length) {
      const known = knownNames(history);
      sections.push(`No logged sets match: ${missed.join(", ")}.${known.length ? ` Logged exercises: ${known.join(", ")}.` : ""}`);
    }
    return { text: sections.join("\n\n") };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/**
 * Handle one JSON-RPC message. Returns the response object, or null for a
 * notification (the route answers 202 with no body).
 * @param {any} msg
 * @param {{ load: () => Promise<{ meta: any, history: any[] } | null>, now?: Date }} ctx
 */
export async function handleMcp(msg, { load, now = new Date() }) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return err(msg?.id, -32600, "Invalid request");
  }
  const { id, method, params } = msg;
  if (id === undefined) return null; // notification
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return ok(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "heatwayve", title: "Heatwayve", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) return err(id, -32602, `Unknown tool: ${name}`);
      let r;
      // Synced data is client-written; a malformed field reads as a tool
      // error the AI can report, never a 500 that looks like an outage.
      // chart_style reads no training, so it costs no database read.
      try { r = runTool(name, params?.arguments || {}, name === "chart_style" ? null : await load(), now); }
      catch { r = { text: "Couldn't read part of this training record. Ask the user to open Heatwayve so it re-syncs.", isError: true }; }
      return ok(id, { content: [{ type: "text", text: r.text }], isError: !!r.isError });
    }
    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}
