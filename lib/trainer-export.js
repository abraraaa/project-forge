// @ts-check
// lib/trainer-export.js
// ─────────────────────────────────────────────────────────────────────────────
// A trainer's download of what they see of a client, as CSV (RFC 4180, CRLF).
// Pure: it reads only the trainer view (lib/trainer-view.js VIEW_KEYS, plus
// plan.changes from lib/trainer-plan.js PLAN_KEYS), so nothing the pane does
// not show can reach the file.
// ─────────────────────────────────────────────────────────────────────────────

import { mainLiftTrend } from "./analytics.js";
import { getLoadType } from "./lift-translations.js";
import { isCountedSet } from "./counted-set.js";

export const EXPORT_COLUMNS = Object.freeze([
  "date", "session", "block", "lift", "set", "prescribed_reps", "reps", "kg", "felt", "top_set", "set_by",
]);

const CRLF = "\r\n";

/**
 * One CSV field. Text that a spreadsheet would run as a formula is prefixed
 * with an apostrophe; a field with a comma, quote or line break is quoted.
 * @param {unknown} v
 */
export function csvField(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A name inside the comment line: one line, no commas or quotes, never a formula. */
const headerName = (v) => {
  const s = String(v ?? "").replace(/[\r\n,"]+/g, " ").replace(/\s+/g, " ").trim();
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
};

/** A set is shown when it was logged: the house rule (lib/counted-set.js).
 *  The pane also shows a set with reps 0 and no weight; the file leaves it
 *  out, so it stays a subset of the pane. */
const counted = isCountedSet;
const loadTypeOf = (s, ex) => s?.loadType ?? ex?.loadType ?? null;

/**
 * kg as the pane shows it: blank for a reps-only set; on a bodyweight set,
 * the added kg only when there is some.
 */
function kgOf(s, ex) {
  const w = typeof s?.weight === "number" && Number.isFinite(s.weight) ? s.weight : null;
  if (loadTypeOf(s, ex) === "bodyweight") return w !== null && w > 0 ? w : null;
  return w;
}

/** Effort as the pane reads it: RPE, else RIR, else blank. */
function feltOf(s) {
  if (typeof s?.rpe === "number" && Number.isFinite(s.rpe)) return `RPE ${s.rpe}`;
  if (typeof s?.rir === "number" && Number.isFinite(s.rir)) return `RIR ${s.rir}`;
  return null;
}

/**
 * Index of a main-block exercise's top set by the trend's own rule
 * (mainLiftTrend: highest e1RM, first on ties; never a bodyweight lift), or -1.
 * An untyped lift is typed by its name: the view does not carry the
 * programme's load type, so a rare custom lift may flag differently from the
 * pane's trend. Only the 1/0 differs; the numbers are the view's.
 */
function topIndex(ex, sets) {
  const own = ex?.loadType ?? sets.find((s) => s?.loadType)?.loadType ?? getLoadType({ name: ex?.name ?? "" });
  const name = typeof ex?.name === "string" ? ex.name : "";
  const trend = mainLiftTrend([{ date: "", blocks: [{ type: "main", exercises: [{ name, loadType: own, sets }] }] }], { includeCooked: true });
  const top = trend[name]?.[0]?.topSet;
  if (!top) return -1;
  return sets.findIndex((s) => s.weight === top.weight && s.reps === top.reps);
}

/**
 * The trainer's changes that the client trained at, by lift and date:
 * who set it, and the reps it prescribed (a reps change).
 * @param {any} plan  view.plan, when the client's changes are on
 * @param {string | null} by  what set_by shows
 */
function changesByLiftDate(plan, by) {
  /** @type {Map<string, { by: string | null, reps: any }>} */
  const out = new Map();
  for (const c of Array.isArray(plan?.changes) ? plan.changes : []) {
    if (c?.status !== "trained_yours" || typeof c.date !== "string") continue;
    const lift = c.kind === "weight" || c.kind === "reps" ? c.target : c.kind === "mainLift" ? c.after : null;
    if (typeof lift !== "string") continue;
    const key = `${c.date}\u0000${lift}`;
    const prev = out.get(key) ?? { by, reps: null };
    if (c.kind === "reps" && (typeof c.after === "number" || typeof c.after === "string")) prev.reps = c.after;
    out.set(key, prev);
  }
  return out;
}

/**
 * The CSV a trainer downloads: a comment line, the header, one row per shown
 * set of view.sessions (24 weeks), then one 'top' row per main lift per
 * session of view.tops (to 12 months).
 * @param {any} view  projectForTrainer's result (lib/trainer-plan.js)
 * @param {{ name?: string | null, trainer?: string | null, date: string }} opts
 *   name: the client's public name; trainer: the trainer's (left out on their own export)
 * @returns {string}
 */
export function csvFromView(view, { name = null, trainer = null, date }) {
  const changes = changesByLiftDate(view?.plan, trainer ? headerName(trainer) : null);
  const shared = trainer ? `, shared with ${headerName(trainer)}` : "";
  // The comment line comes first, as briefed: spreadsheets show it as a row;
  // a parser that takes line 1 as the header needs to skip it.
  const lines = [`# Heatwayve export for ${headerName(name)}, ${headerName(date)}${shared}`, EXPORT_COLUMNS.join(",")];
  const row = (cells) => lines.push(cells.map(csvField).join(","));

  for (const ses of Array.isArray(view?.sessions) ? view.sessions : []) {
    const label = ses?.scheduledLetter ?? ses?.session ?? null;
    for (const b of Array.isArray(ses?.blocks) ? ses.blocks : []) {
      for (const ex of Array.isArray(b?.exercises) ? b.exercises : []) {
        const sets = (Array.isArray(ex?.sets) ? ex.sets : []).filter(counted);
        const top = b?.type === "main" ? topIndex(ex, sets) : -1;
        const ch = changes.get(`${ses.date}\u0000${ex?.name}`);
        sets.forEach((s, i) => {
          row([ses.date, label, b?.type, ex?.name, i + 1, ch?.reps ?? null, s.reps, kgOf(s, ex), feltOf(s), i === top ? 1 : 0, ch?.by ?? null]);
        });
      }
    }
  }
  for (const t of Array.isArray(view?.tops) ? view.tops : []) {
    for (const b of Array.isArray(t?.blocks) ? t.blocks : []) {
      for (const ex of Array.isArray(b?.exercises) ? b.exercises : []) {
        const ch = changes.get(`${t.date}\u0000${ex?.name}`);
        for (const s of (Array.isArray(ex?.sets) ? ex.sets : []).filter(counted)) {
          row([t.date, null, b?.type, ex?.name, "top", ch?.reps ?? null, s.reps, kgOf(s, ex), feltOf(s), 1, ch?.by ?? null]);
        }
      }
    }
  }
  return lines.join(CRLF) + CRLF;
}

/**
 * The download's file name: heatwayve-<who>-<date>.csv, ASCII only. `who` is
 * the handle, else the fallback label ("me", or nothing for "client") when
 * the handle leaves nothing ASCII. Never pass a grant ref as the fallback.
 * @param {string | null | undefined} handle
 * @param {string} fallback
 * @param {string} date
 */
export function exportFilename(handle, fallback, date) {
  const safe = (v) => String(v ?? "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const who = safe(handle) || safe(fallback) || "client";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "export";
  return `heatwayve-${who}-${day}.csv`;
}
