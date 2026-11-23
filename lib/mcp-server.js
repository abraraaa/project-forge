// @ts-check
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2024-2026 abraraaa. Verification-only licence; no reuse. See LICENSE, NOTICE.
// lib/mcp-server.js — the MCP JSON-RPC handler behind /mcp. Stateless, read
// only, one profile per call (the one the access token names). The profile is
// loaded lazily, once, and only for tools/call — handshakes cost no DB read.
// No tool reads the server's clock or zone: a day is "YYYY-MM-DD" on the
// lifter's own calendar, the asOf the AI passes or their last logged session.

import { buildCoachContext, sessionLine, asOfSetAside } from "./coach-context.js";
import { WEEK, SESSIONS, nextStrengthIdx } from "./programme.js";
import { addDaysIso, daysBetween } from "./dates.js";
import { getLoadType, isBodyweightMovement, addedLoadFor, loggedAddedKg, deriveMuscleAnchors, sanitiseWorkingWeights } from "./lift-translations.js";
import { ensureScheduleHistory, scheduleEntryOn } from "./sync-merge.js";
import { chartStyleText } from "./chart-style.js";
import { liveDeload } from "./progression.js";
import { withLifterDeloadDate } from "./server-time.js";
import {
  validMainLifts, loadTypeOfName, hasCatalogueName, isWorkingWeight, planWeight,
  composedSessions, repTargets, resolveSessions, scheduledPlan, deloadSessionSets,
} from "./programme-resolve.js";
// The resolver moved to lib/programme-resolve.js; these keep their old path.
export { validMainLifts, loadTypeOfName, resolvedProgramme } from "./programme-resolve.js";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const INSTRUCTIONS = "Heatwayve is a strength-training app. These tools read the user's own training, read only. Start with training_snapshot: it explains how the programme works before the numbers. Use programme for what they're running next. Before you draw any chart or visual from this data, call chart_style and follow it. Progress photos are never available here. Every date is YYYY-MM-DD on the user's own calendar; Heatwayve doesn't know today's date. Pass today's date as asOf to training_snapshot, programme and current_loads; without it they read as of the user's last logged session.";

/** The one optional argument of the dated tools. */
const AS_OF = (reads) => ({
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: `Today's date on the user's calendar, YYYY-MM-DD. Pass it: ${reads}`,
});

const TOOLS = [
  {
    name: "training_snapshot",
    title: "Training snapshot",
    description: "How the programme works, the user's setup, 8-week consistency, main-lift trends, weekly volume against MEV/MRV, and the last six sessions. Call this first.",
    inputSchema: { type: "object", properties: { asOf: AS_OF("the snapshot reads through it. Without it, as of their last logged session.") }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "recent_sessions",
    title: "Recent sessions",
    description: "The most recent logged sessions, newest last: date, readiness, each exercise's weight, reps and effort (RPE), and whether a trainer logged it with them.",
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
    inputSchema: { type: "object", properties: { asOf: AS_OF("the schedule and the deload calendar read on it. Without it, on their last logged session's date.") }, additionalProperties: false },
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
    inputSchema: { type: "object", properties: { asOf: AS_OF("the deload calendar reads on it. Without it, on their last logged session's date.") }, additionalProperties: false },
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date, "YYYY-MM-DD". */
const isRealDate = (v) => typeof v === "string" && ISO_DATE.test(v) && addDaysIso(v, 0) === v;
/** How far asOf may sit from the last logged session: a day before, 366 days after. */
const AS_OF_BEFORE_DAYS = 1;
const AS_OF_AFTER_DAYS = 366;
/** With nothing logged and no asOf: the schedule as last set; a stored deload reads as over. */
const UNDATED = "9999-12-31";

/**
 * The day the dated tools read on, from the log and the AI's asOf alone:
 * asOf when it is a real date from a day before the last logged session to
 * 366 days after it (any real date with nothing logged), else the last
 * logged session's date, else null. A real asOf outside that range comes
 * back as `rejected`, `after` when it is past the range.
 * @param {any[]} history
 * @param {unknown} asOf
 * @returns {{ day: string | null, asOf: boolean, last: string | null, rejected: { asOf: string, after: boolean } | null }}
 */
export function readingDay(history, asOf) {
  let last = null;
  for (const r of history) if (isRealDate(r?.date) && (last === null || r.date > last)) last = r.date;
  let rejected = null;
  if (isRealDate(asOf)) {
    const day = /** @type {string} */ (asOf);
    const gap = last === null ? 0 : daysBetween(last, day);
    if (gap !== null && gap >= -AS_OF_BEFORE_DAYS && gap <= AS_OF_AFTER_DAYS) return { day, asOf: true, last, rejected: null };
    if (gap !== null) rejected = { asOf: day, after: gap > AS_OF_AFTER_DAYS };
  }
  return { day: last, asOf: false, last, rejected };
}

/** The schedule in force on a day, from the synced edit log. */
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

/** One resolved lift as a prescription line fragment, at `reps` when given. */
function liftLine(lift, weights, bw, addedLoads, anchors, reps = {}) {
  const target = own(reps, lift.name) ?? lift.reps;
  const r = lift.timed && typeof target === "number" ? `${target}s hold` : target;
  return `${lift.name} ${lift.sets} × ${r} @ ${planLoad(lift.ex, weights, bw, addedLoads, anchors)}`;
}

/** The programme exactly as the app composes it: rotation → main lifts → focus. */
export function describeProgramme(meta, history, todayIso, dayNote = null) {
  const block = meta.programmeBlock || {};
  const focus = meta.userFocus || "Forged";
  const lifts = validMainLifts(meta);
  // As the card shows them: the deload calendar's weight and reps in place.
  const due = scheduledPlan({
    weights: meta.weights && typeof meta.weights === "object" ? sanitiseWorkingWeights(meta.weights) : {},
    reps: repTargets(meta), trainingState: meta.trainingState, history, todayIso,
  });
  const weights = due.weights;
  const sessions = resolveSessions(meta, history);
  const bw = typeof meta.bodyweight?.kg === "number" ? meta.bodyweight.kg : null;
  const addedLoads = meta.addedLoads && typeof meta.addedLoads === "object" && !Array.isArray(meta.addedLoads) ? meta.addedLoads : {};
  const anchors = deriveMuscleAnchors(history);
  const week = weekOn(meta.userWeek, todayIso);
  const out = [];

  out.push(`# Programme — block ${block.number || 1}${block.startDate ? `, started ${block.startDate}` : ""} · ${focus} focus`);
  if (dayNote) out.push(dayNote);
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
  if (liveDeload(meta.trainingState?.mesocycle?.activeDeload, history, todayIso)) out.push("Deload week: the weights and reps below are the deload's.");

  for (const session of sessions) {
    out.push("", `## ${session.name} — ${session.subtitle}`);
    // The set counts the card shows (deloadSessionSets).
    const shown = deloadSessionSets({ blocks: session.blocks.map(({ slots }) => ({ ...slots, sets: (slots.ex ?? slots.exA)?.sets ?? 0 })) }, due.sets);
    session.blocks.forEach(({ label, slots: { ex, exA, exB } }, i) => {
      const sets = shown.blocks[i].sets;
      if (ex) out.push(`- ${label}: ${liftLine({ ...ex, sets }, weights, bw, addedLoads, anchors, due.reps)}`);
      else if (exA && exB) out.push(`- ${label}: ${liftLine({ ...exA, sets }, weights, bw, addedLoads, anchors, due.reps)} + ${liftLine({ ...exB, sets }, weights, bw, addedLoads, anchors, due.reps)}`);
    });
  }
  out.push("", "Accessories rotate at block boundaries, not session to session. Weights and reps move with the progression engine after each session.");
  return out.join("\n");
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Number.isInteger(v) ? v : dflt;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * Run one tool against a loaded profile. Pure: reads no clock.
 * @param {string} name
 * @param {any} args
 * @param {{ meta: any, history: any[] } | null} data
 * @returns {{ text: string, isError?: boolean }}
 */
export function runTool(name, args, data) {
  const history = Array.isArray(data?.history) ? data.history : [];
  // A deload's window reads on the lifter's calendar, not the server's zone.
  const meta = withLifterDeloadDate(data?.meta || {}, history);
  const on = () => readingDay(history, args?.asOf);
  if (name === "training_snapshot") {
    const read = on();
    return {
      text: buildCoachContext({
        history,
        trainingState: meta.trainingState || null,
        focus: meta.userFocus || "Forged",
        mainLifts: validMainLifts(meta), // null (unknown) until the app syncs them
        week: weekOn(meta.userWeek, read.day ?? UNDATED),
        weekFor: (iso) => weekOn(meta.userWeek, iso),
        breaks: Array.isArray(meta.breaks) ? meta.breaks : [],
        bodyweightKg: meta.bodyweight?.kg ?? null,
        on: read,
      }),
    };
  }
  if (name === "recent_sessions") {
    const recent = history.slice(-clampInt(args?.limit, 1, 30, 10));
    return { text: recent.length ? recent.map(sessionLine).join("\n") : "No sessions logged yet." };
  }
  if (name === "chart_style") return { text: chartStyleText() };
  if (name === "programme") {
    const read = on();
    return { text: describeProgramme(meta, history, read.day ?? UNDATED, asOfSetAside(read)) };
  }
  if (name === "current_loads") {
    const read = on();
    const head = [asOfSetAside(read)].filter(Boolean);
    // As the card shows them: the deload calendar's weight and reps in place.
    const { weights, reps } = scheduledPlan({
      weights: meta.weights && typeof meta.weights === "object" ? sanitiseWorkingWeights(meta.weights) : {},
      reps: repTargets(meta), trainingState: meta.trainingState, history, todayIso: read.day ?? UNDATED,
    });
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
    if (!names.length) return { text: [...head, "No working weights set yet."].join("\n") };
    // A lift with a target but no working weight shows the start the session
    // would plan, worded as programme words it (planLoad), from the composed
    // plan's entry when it has one.
    const bw = typeof meta.bodyweight?.kg === "number" ? meta.bodyweight.kg : null;
    const anchors = deriveMuscleAnchors(history);
    const planned = new Map();
    for (const s of composedSessions(meta)) for (const b of s.blocks || []) for (const ex of [b.ex, b.exA, b.exB]) if (ex?.name && !planned.has(ex.name)) planned.set(ex.name, ex);
    const suggested = (n) => planLoad(planned.get(n) ?? { name: n, loadType: loadTypeOfName(n) }, weights, bw, added, anchors);
    return { text: [...head, ...names.map((n) => {
      const load = pureBw(n) ? bodyweightLoad(added, n) : (isWorkingWeight(weights[n]) ? `${weights[n]} kg` : suggested(n));
      return `- ${n}: ${load}${reps[n] != null ? ` × ${reps[n]}` : ""}`;
    })].join("\n") };
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
 * @param {{ load: () => Promise<{ meta: any, history: any[] } | null> }} ctx
 */
export async function handleMcp(msg, { load }) {
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
      try { r = runTool(name, params?.arguments || {}, name === "chart_style" ? null : await load()); }
      catch { r = { text: "Couldn't read part of this training record. Ask the user to open Heatwayve so it re-syncs.", isError: true }; }
      return ok(id, { content: [{ type: "text", text: r.text }], isError: !!r.isError });
    }
    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}
