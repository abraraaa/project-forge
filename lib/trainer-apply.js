// @ts-check
// lib/trainer-apply.js
// ─────────────────────────────────────────────────────────────────────────────
// Applying to coach: the rules, pure. What an application may hold (about,
// link), when someone may apply again, the queue cap, and the applicant's
// view of their own row. The writes are in lib/trainer-store.js and
// lib/identity-store.js; the routes are app/api/trainer/apply and
// app/api/diag/trainers.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

export const ABOUT_MAX = 280;
export const LINK_MAX = 200;
/** The whole request body, measured before it is parsed. */
export const APPLY_BODY_MAX = 4096;
/** After "Not this time", the same account may apply again after this long. */
export const REAPPLY_AFTER_MS = 30 * DAY_MS;
/** With this many waiting, Apply pauses. */
export const QUEUE_CAP = 100;

export const APPLICATION_STATUSES = Object.freeze(["applied", "approved", "denied", "withdrawn"]);

export const APPLY_COPY = Object.freeze({
  notOpen: "Not open yet.",
  paused: "Applications are paused for now.",
  aboutMissing: "Tell me a little about how you coach.",
  aboutLong: `Keep it to ${ABOUT_MAX} characters.`,
  aboutPlain: "Keep it to plain text.",
  linkBad: "That link doesn't look right.",
  linkLong: `Keep the link under ${LINK_MAX} characters.`,
});

// C0 and C1 controls other than tab and newline, and the bidi overrides that
// could make a line on the admin page read as something else.
const UNSAFE_TEXT = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/;

/**
 * The "where you coach" text, trimmed, or an error in the house voice.
 * Length is counted as a browser's maxLength counts it.
 * @param {unknown} v
 * @returns {{ about: string } | { error: string }}
 */
export function cleanAbout(v) {
  if (typeof v !== "string") return { error: APPLY_COPY.aboutMissing };
  const about = v.replace(/\r\n?/g, "\n").trim();
  if (!about) return { error: APPLY_COPY.aboutMissing };
  if (about.length > ABOUT_MAX) return { error: APPLY_COPY.aboutLong };
  if (UNSAFE_TEXT.test(about)) return { error: APPLY_COPY.aboutPlain };
  return { about };
}

/**
 * The optional link: absent or blank is null; otherwise an https URL with a
 * dotted host and no credentials. A bare "instagram.com/kim" is read as
 * https. Stored as typed (plus the scheme), shown to the admin as text only.
 * @param {unknown} v
 * @returns {{ link: string | null } | { error: string }}
 */
export function cleanLink(v) {
  if (v == null) return { link: null };
  if (typeof v !== "string") return { error: APPLY_COPY.linkBad };
  const typed = v.trim();
  if (!typed) return { link: null };
  const link = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;
  if (link.length > LINK_MAX) return { error: APPLY_COPY.linkLong };
  if (/\s/.test(link) || UNSAFE_TEXT.test(link)) return { error: APPLY_COPY.linkBad };
  let url;
  try { url = new URL(link); } catch { return { error: APPLY_COPY.linkBad }; }
  if (url.protocol !== "https:" || url.username || url.password || !/^[^.]+(\.[^.]+)+$/.test(url.hostname)) {
    return { error: APPLY_COPY.linkBad };
  }
  return { link };
}

/**
 * @typedef {{ status: string, appliedAt: number | null, decidedAt: number | null, seenAt: number | null }} ApplicationRow
 */

/**
 * When a denied applicant may apply again, or null when they already may
 * (or were never denied).
 * @param {ApplicationRow | null | undefined} row
 * @param {number} now
 */
export function nextApplyAt(row, now) {
  if (row?.status !== "denied" || !Number.isFinite(row.decidedAt)) return null;
  const at = row.decidedAt + REAPPLY_AFTER_MS;
  return at > now ? at : null;
}

/**
 * Why this account may not apply now, or null when it may. Mirrors the
 * guard on the overwrite in dbApplyTrainer: a withdrawn row, or a denial at
 * least 30 days old, may be replaced; nothing else may.
 * @param {ApplicationRow | null | undefined} row
 * @param {number} now
 * @returns {null | { status: "applied" } | { status: "approved" } | { status: "denied", nextAt: number | null }}
 */
export function applyBlock(row, now) {
  if (!row || row.status === "withdrawn") return null;
  if (row.status === "denied") {
    if (!Number.isFinite(row.decidedAt)) return { status: "denied", nextAt: null };
    const nextAt = row.decidedAt + REAPPLY_AFTER_MS;
    return now >= nextAt ? null : { status: "denied", nextAt };
  }
  if (row.status === "approved") return { status: "approved" };
  return { status: "applied" };
}

/** @param {number} openCount  applications waiting now */
export const queueFull = (openCount) => !(openCount < QUEUE_CAP);

/**
 * The applicant's own view of their row, for Profile and /trainer: never
 * what they wrote, only where it stands.
 * @param {ApplicationRow | null | undefined} row
 * @param {number} now
 * @returns {null | { status: string, at: number | null, decidedAt: number | null, nextAt: number | null, seen: boolean }}
 */
export function applicationView(row, now) {
  if (!row || !APPLICATION_STATUSES.includes(row.status)) return null;
  return {
    status: row.status,
    at: row.appliedAt ?? null,
    decidedAt: row.decidedAt ?? null,
    nextAt: nextApplyAt(row, now),
    seen: row.seenAt != null,
  };
}
