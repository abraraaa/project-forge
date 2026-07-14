// @ts-check
// lib/store-health.js
// ─────────────────────────────────────────────────────────────────────────────
// Continuous store-invariant checking — the proactive answer to "wait for a
// regression" (Phase 5's diag-sync item, reframed 2026-07-14). Every
// data-shape bug this project has paid for is encoded here as a READ-ONLY
// invariant, surfaced on /diag-sync: the null-scheduledType Day entries,
// the future-dated phantom completions, the duplicate history ids, the
// per-lift window overflow, the stamp orphans. A regression stops being
// something we discover in a user report and becomes a red row on a diag
// page the same day it exists.
//
// DOCTRINE, load-bearing: this module DETECTS and never repairs. Repairs
// remain one-shot, code-reviewed migrations (the wipe protocol's "no
// standing delete/repair authority"). The unknown-key check is the safe
// inversion of enumerate-garbage-never-goodness: unrecognised keys are
// REPORTED, never touched — the store may grow past this registry, and the
// registry failing loudly is exactly the point.
// ─────────────────────────────────────────────────────────────────────────────

import { ensureScheduleHistory } from "./sync-merge.js";

// Every key the app writes, device-level and per-profile. A key outside
// this registry is reported as unrecognised (informational, never acted on).
export const DEVICE_KEYS = new Set([
  "forge:profiles", "forge:active", "forge:onboarded", "forge:weekConfig",
  "forge:programmeBlock", "forge:pendingPushes", "forge:lastSyncAt",
]);
export const PROFILE_SUFFIXES = new Set([
  "weights", "weightStamps", "reps", "repStamps", "streak", "history",
  "days", "daysProjected", "daysRepaired_v1", "dayDone", "focus",
  "focusStamp", "trainingState", "breaks", "bodyweight", "passkeyNudge",
  "draft", "pendingSession", "pendingRotationSummary",
]);
const LEGACY_PREFIXES = ["bonusDone:"]; // week-keyed legacy store

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const parseableStamp = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

/**
 * Pure invariant check over a store snapshot. Returns [{check, ok, detail}].
 * `todayIso` injected for testability.
 * @param {object} snapshot
 * @param {{todayIso?: string}} [opts]
 */
export function checkStoreHealth(snapshot, { todayIso } = {}) {
  const today = todayIso || (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const results = [];
  const add = (check, ok, detail = "") => results.push({ check, ok, detail });
  const s = snapshot || {};

  // Weights/reps: numeric values, stamps parseable, no orphan stamps.
  for (const [label, map, stamps] of [
    ["weights", s.weights, s.weightStamps],
    ["reps", s.reps, s.repStamps],
  ]) {
    const badVals = Object.entries(map || {}).filter(([, v]) => typeof v !== "number" && v !== null);
    add(`${label}: values numeric`, badVals.length === 0, badVals.map(([k]) => k).join(", "));
    const badStamps = Object.entries(stamps || {}).filter(([, v]) => !parseableStamp(v));
    add(`${label}: stamps parseable`, badStamps.length === 0, badStamps.map(([k]) => k).join(", "));
    const orphans = Object.keys(stamps || {}).filter((k) => !(k in (map || {})));
    add(`${label}: no orphan stamps`, orphans.length === 0, orphans.join(", "));
  }

  // Days: the store this project has repaired twice — every paid-for bug
  // class checks here forever.
  const dayIssues = { keyMismatch: [], badStamp: [], nullNull: [], phantom: [] };
  for (const [date, e] of Object.entries(s.days || {})) {
    if (!e || typeof e !== "object" || e.date !== date || !ISO_DATE.test(date)) {
      dayIssues.keyMismatch.push(date); continue;
    }
    if (e.updatedAt && !parseableStamp(e.updatedAt)) dayIssues.badStamp.push(date);
    // The pre-d6772c1 signature: claims nothing, blocks the retro picker.
    if (!e.completedType && !e.sessionId && !e.scheduledType) dayIssues.nullNull.push(date);
    // The straddle-phantom signature (census check, now standing):
    // completion claimed before its own date happened.
    const written = String(e.updatedAt || "").slice(0, 10);
    if (e.completedType && !e.sessionId && ISO_DATE.test(written) && date > written && date > today) {
      dayIssues.phantom.push(date);
    }
  }
  add("days: keys match entry dates", dayIssues.keyMismatch.length === 0, dayIssues.keyMismatch.join(", "));
  add("days: updatedAt parseable", dayIssues.badStamp.length === 0, dayIssues.badStamp.join(", "));
  add("days: no null/null/null entries (pre-d6772c1 class)", dayIssues.nullNull.length === 0, dayIssues.nullNull.join(", "));
  add("days: no future-dated phantom completions (straddle class)", dayIssues.phantom.length === 0, dayIssues.phantom.join(", "));

  // Schedule log: parses under the shared normaliser, or is absent.
  add("schedule log: valid shape or absent",
    s.userWeek == null || ensureScheduleHistory(s.userWeek) !== null,
    s.userWeek == null ? "" : "unparseable edit log");

  // Breaks: well-formed, at most one open.
  const breaks = Array.isArray(s.breaks) ? s.breaks : [];
  const malformed = breaks.filter((b) => !b || !b.id || !b.start);
  const open = breaks.filter((b) => b && b.start && !b.endedAt);
  add("breaks: entries well-formed", malformed.length === 0, `${malformed.length} malformed`);
  add("breaks: at most one open", open.length <= 1, `${open.length} open`);

  // History: unique ids, sorted, ISO dates.
  const hist = Array.isArray(s.history) ? s.history : [];
  const ids = hist.map((r) => r?.id).filter(Boolean);
  add("history: ids unique", new Set(ids).size === ids.length,
    `${ids.length - new Set(ids).size} duplicates`);
  const sorted = [...ids].sort().every((id, i) => id === ids[i]);
  add("history: sorted by id", sorted);
  const badDates = hist.filter((r) => r?.date && !ISO_DATE.test(r.date));
  add("history: dates ISO", badDates.length === 0, badDates.map((r) => r.id).join(", "));

  // trainingState: per-lift window respected (12 — the cap the engine
  // maintains; overflow means a writer bypassed updateLiftStateFromSession).
  const lifts = s.trainingState?.lifts || {};
  const overflowing = Object.entries(lifts)
    .filter(([, st]) => Array.isArray(st?.history) && st.history.length > 12)
    .map(([name]) => name);
  add("trainingState: per-lift window ≤ 12", overflowing.length === 0, overflowing.join(", "));

  // programmeBlock: sane number, exclusion memory within cap.
  const pb = s.programmeBlock;
  add("programmeBlock: number ≥ 1", !pb || (pb.number || 0) >= 1, String(pb?.number));
  const overMem = Object.entries(pb?.history || {})
    .filter(([, v]) => Array.isArray(v) && v.length > 3).map(([k]) => k);
  add("programmeBlock: exclusion memory ≤ 3", overMem.length === 0, overMem.join(", "));

  // Unknown keys: reported, never touched.
  add("no unrecognised forge:* keys", (s.unknownKeys || []).length === 0,
    (s.unknownKeys || []).join(", "));

  return results;
}

/**
 * Browser-side snapshot collector for /diag-sync. Walks localStorage,
 * classifies every forge:* key against the registry, parses the known ones.
 */
export function collectStoreSnapshot(profile) {
  if (typeof window === "undefined") return null;
  const get = (k) => {
    try { return JSON.parse(window.localStorage.getItem(k)); } catch { return undefined; }
  };
  const unknownKeys = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (!k || !k.startsWith("forge:")) continue;
    if (DEVICE_KEYS.has(k)) continue;
    const m = k.match(/^forge:([^:]+):(.+)$/);
    if (m && (PROFILE_SUFFIXES.has(m[2]) || LEGACY_PREFIXES.some((p) => m[2].startsWith(p)))) continue;
    unknownKeys.push(k);
  }
  return {
    weights: get(`forge:${profile}:weights`) || {},
    weightStamps: get(`forge:${profile}:weightStamps`) || {},
    reps: get(`forge:${profile}:reps`) || {},
    repStamps: get(`forge:${profile}:repStamps`) || {},
    days: get(`forge:${profile}:days`) || {},
    userWeek: get("forge:weekConfig"),
    breaks: get(`forge:${profile}:breaks`) || [],
    history: get(`forge:${profile}:history`) || [],
    trainingState: get(`forge:${profile}:trainingState`) || null,
    programmeBlock: get("forge:programmeBlock"),
    unknownKeys,
  };
}
