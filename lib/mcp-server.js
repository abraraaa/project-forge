// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/mcp-server.js — the MCP JSON-RPC handler behind /mcp. Stateless, read
// only, one profile per call (the one the access token names). The profile is
// loaded lazily, once, and only for tools/call — handshakes cost no DB read.

import { buildCoachContext, sessionLine } from "./coach-context.js";
import { WEEK } from "./programme.js";
import { localDateStr } from "./dates.js";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const INSTRUCTIONS = "Heatwayve is a strength-training app. These tools read the user's own training, read only. Start with training_snapshot: it explains how the programme works before the numbers. Progress photos are never available here.";

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
    name: "current_loads",
    title: "Current loads",
    description: "Every exercise's current working weight and rep target, in one call — the whole programme's loading at a glance.",
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
  let best = null;
  for (const e of Array.isArray(history) ? history : []) {
    if (!e || !Array.isArray(e.week) || !(e.effectiveFrom <= todayIso)) continue;
    if (!best || e.effectiveFrom > best.effectiveFrom || (e.effectiveFrom === best.effectiveFrom && e.editedAt > best.editedAt)) best = e;
  }
  return best ? best.week : WEEK;
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
        mainLifts: null, // main-lift choices stay on the device
        week: weekOn(meta.userWeek, localDateStr(now)),
        bodyweightKg: meta.bodyweight?.kg ?? null,
        now,
      }),
    };
  }
  if (name === "recent_sessions") {
    const recent = history.slice(-clampInt(args?.limit, 1, 30, 10));
    return { text: recent.length ? recent.map(sessionLine).join("\n") : "No sessions logged yet." };
  }
  if (name === "current_loads") {
    const weights = meta.weights && typeof meta.weights === "object" ? meta.weights : {};
    const reps = meta.reps && typeof meta.reps === "object" ? meta.reps : {};
    const names = [...new Set([...Object.keys(weights), ...Object.keys(reps)])].sort();
    if (!names.length) return { text: "No working weights set yet." };
    return { text: names.map((n) => `- ${n}: ${weights[n] != null ? `${weights[n]} kg` : "bodyweight"}${reps[n] != null ? ` × ${reps[n]}` : ""}`).join("\n") };
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
          lines.push(`- ${rec.date} · ${ex.name}: ${sets.map((s) => `${s.weight ?? "BW"}×${s.reps}${s.rpe != null ? ` @${s.rpe}` : ""}`).join(", ")}`);
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
      const r = runTool(name, params?.arguments || {}, await load(), now);
      return ok(id, { content: [{ type: "text", text: r.text }], isError: !!r.isError });
    }
    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}
