// @ts-check
// lib/trainer-apply-copy.js
// ─────────────────────────────────────────────────────────────────────────────
// The words of the trainer application: the Apply panel on /trainer, its
// replies, and the "For trainers" row in Profile. Client-safe. The field
// rules come from lib/trainer-apply.js, the same ones the apply route runs.
// Server error text is never shown; each reply maps to a line here.
// ─────────────────────────────────────────────────────────────────────────────

import { ABOUT_MAX, LINK_MAX, cleanAbout, cleanLink } from "./trainer-apply.js";

/** Field limits: the apply route's own. */
export { ABOUT_MAX, LINK_MAX };
/** The counter shows from here on. */
export const ABOUT_COUNT_FROM = 240;

export const APPLY_COPY = Object.freeze({
  lead: "Tell us where you coach. We read every application.",
  aboutLabel: "Where do you coach?",
  aboutHint: "Gym, club or online, and any qualifications",
  linkLabel: "A link (optional)",
  linkHint: "Website or Instagram",
  send: "Send application",
  sent: "Application sent. We'll let you know here and in Profile.",
  applied: "Your application is in.",
  denied: "Not this time.",
  carryOn: "Your own training carries on as normal.",
  paused: "Applications are paused for now.",
  notOpen: "Not open yet.",
  needAbout: "Say a little about where you coach.",
  badLink: "That link doesn't look right. Try the full https:// address.",
  checkFields: "Check what you wrote and try again.",
  alreadyTrainer: "You're already set up. Sign in to see your clients.",
  signInAgain: "Sign in again to send it. What you wrote is kept.",
});

/** Replies with no words of their own. */
export const REPLY_COPY = Object.freeze({
  tooMany: "Too many tries. Wait a minute and try again.",
  wentWrong: "Couldn't do that just now. Try again.",
  offline: "Couldn't reach Heatwayve. Try again.",
});

const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/** A server time (ms or ISO) as ms, or null. @param {unknown} v */
export function toMs(v) {
  const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** "Not this time. You can apply again from 4 Nov." @param {unknown} nextAt */
export function deniedLine(nextAt) {
  const t = toMs(nextAt);
  return t == null ? APPLY_COPY.denied : `${APPLY_COPY.denied} You can apply again from ${dayMonth.format(new Date(t))}.`;
}

/**
 * Why the "where you coach" text can't be sent, or null when it can. The
 * apply route's own check; its words stay on the server.
 * @param {string} about
 */
export function aboutProblem(about) {
  if (!about.trim()) return APPLY_COPY.needAbout;
  return "error" in cleanAbout(about) ? APPLY_COPY.checkFields : null;
}

/**
 * A typed link as sent: trimmed, with https:// when no scheme was typed
 * ("instagram.com/kim"), as the apply route reads it. Empty, or a link
 * linkProblem refuses, is "".
 * @param {string} link
 */
export function linkToSend(link) {
  const l = cleanLink(link);
  return "link" in l && l.link ? l.link : "";
}

/** Why a typed link can't be sent, or null when it can (empty is fine). @param {string} link */
export function linkProblem(link) {
  return "error" in cleanLink(link) ? APPLY_COPY.badLink : null;
}

/** The "For trainers" row's subline in Profile, by application state. */
export const APPLY_ROW_COPY = Object.freeze({
  none: "Set up as a trainer",
  applied: "Application sent",
  denied: "Not this time",
  // Approved while the dashboard is still behind TRAINER_LIVE.
  approved: "Approved · not open yet",
});

/**
 * A denial reads "Not this time" only while its 30 days run; after that the
 * row offers Apply again, as /trainer does.
 * @param {{ status?: unknown, nextAt?: unknown } | null | undefined} application
 * @param {number} [now]
 */
export function applyRowSub(application, now = Date.now()) {
  const s = application?.status;
  if (s === "applied") return APPLY_ROW_COPY.applied;
  if (s === "denied" && (toMs(application?.nextAt) ?? 0) > now) return APPLY_ROW_COPY.denied;
  return APPLY_ROW_COPY.none;
}

/** A decided application not yet marked seen. @param {any} application */
export function decisionUnseen(application) {
  const s = application?.status;
  return (s === "approved" || s === "denied") && application.seen !== true;
}
