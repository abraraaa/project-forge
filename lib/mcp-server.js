// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/mcp-server.js — the MCP JSON-RPC handler behind /mcp. Stateless, read
// only, one profile per call (the one the access token names). The profile is
// loaded lazily, once, and only for tools/call — handshakes cost no DB read.

import { buildCoachContext, sessionLine } from "./coach-context.js";
import { WEEK, SESSIONS, nextStrengthIdx } from "./programme.js";
import { localDateStr } from "./dates.js";
import { getLoadType, isBodyweightMovement, addedLoadFor, loggedAddedKg } from "./lift-translations.js";
import { ensureScheduleHistory, scheduleEntryOn } from "./sync-merge.js";
import { chartStyleText } from "./chart-style.js";
import {
  validMainLifts, loadTypeOfName, hasCatalogueName, muscleAnchorsOf, isWorkingWeight, planWeight,
  composedSessions, repTargets, resolveSessions,
} from "./programme-resolve.js";
// The resolver moved to lib/programme-resolve.js; these keep their old path.
export { validMainLifts, loadTypeOfName, resolvedProgramme } from "./programme-resolve.js";

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

const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const own = (obj, k) => (obj && Object.hasOwn(obj, k) ? obj[k] : undefined);

/** A pure bodyweight lift reads as bodyweight, plus the user's optional added load. */
const bodyweightLoad = (addedLoads, name) => {
  const kg = addedLoadFor(addedLoads, name);
  return kg != null ? `bodyweight + ${kg} kg` : "bodyweight";
};

/**
 * An exercise's plan weight as it reads: resolved the way the session screen
 * resolves it (planStartWeight), worded by load type. A lift with no working
 * weight is marked as a suggested start. Shared by programme and current_loads.
 */
function planLoad(ex, weights, bw, addedLoads, anchors) {
  const lt = getLoadType(ex);
  if (lt === "bodyweight") return bodyweightLoad(addedLoads, ex.name); // W is never read for these
  const w = planWeight(ex, weights, bw, anchors);
  const start = isWorkingWeight(own(weights, ex.name)) ? "" : " (suggested start)";
  if (typeof w !== "number" || !(w > 0)) return isBodyweightMovement(lt) ? "bodyweight" : "weight not set yet (new lift)";
  if (lt === "assisted_bodyweight") return `${w} kg assistance${start}`;
  if (lt === "loaded_bodyweight" || lt === "loaded_bw") return `bodyweight + ${w} kg${start}`;
  return `${w} kg${lt === "per_db" ? " each" : ""}${start}`;
}

/** One resolved lift as a prescription line fragment. */
function liftLine(lift, weights, bw, addedLoads, anchors) {
  const r = lift.timed && typeof lift.reps === "number" ? `${lift.reps}s hold` : lift.reps;
  return `${lift.name} ${lift.sets} × ${r} @ ${planLoad(lift.ex, weights, bw, addedLoads, anchors)}`;
}

/** The programme exactly as the app composes it: rotation → main lifts → focus. */
export function describeProgramme(meta, history, todayIso) {
  const block = meta.programmeBlock || {};
  const focus = meta.userFocus || "Forged";
  const lifts = validMainLifts(meta);
  const weights = meta.weights && typeof meta.weights === "object" ? meta.weights : {};
  const sessions = resolveSessions(meta);
  const bw = typeof meta.bodyweight?.kg === "number" ? meta.bodyweight.kg : null;
  const addedLoads = meta.addedLoads && typeof meta.addedLoads === "object" && !Array.isArray(meta.addedLoads) ? meta.addedLoads : {};
  const anchors = muscleAnchorsOf(meta);
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
    for (const { label, slots: { ex, exA, exB } } of session.blocks) {
      if (ex) out.push(`- ${label}: ${liftLine(ex, weights, bw, addedLoads, anchors)}`);
      else if (exA && exB) out.push(`- ${label}: ${liftLine(exA, weights, bw, addedLoads, anchors)} + ${liftLine(exB, weights, bw, addedLoads, anchors)}`);
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
    // A stored null is an unset: no value, so it names no lift.
    const names = [...new Set([...Object.keys(weights).filter((n) => weights[n] !== null), ...Object.keys(reps).filter((n) => reps[n] != null), ...Object.keys(added).filter(pureBw)])].sort();
    if (!names.length) return { text: "No working weights set yet." };
    // A lift with a target but no working weight shows the start the session
    // would plan, worded as programme words it (planLoad), from the composed
    // plan's entry when it has one.
    const bw = typeof meta.bodyweight?.kg === "number" ? meta.bodyweight.kg : null;
    const anchors = muscleAnchorsOf(meta);
    const planned = new Map();
    for (const s of composedSessions(meta)) for (const b of s.blocks || []) for (const ex of [b.ex, b.exA, b.exB]) if (ex?.name && !planned.has(ex.name)) planned.set(ex.name, ex);
    const suggested = (n) => planLoad(planned.get(n) ?? { name: n, loadType: loadTypeOfName(n) }, weights, bw, added, anchors);
    return { text: names.map((n) => {
      const load = pureBw(n) ? bodyweightLoad(added, n) : (isWorkingWeight(weights[n]) ? `${weights[n]} kg` : suggested(n));
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
