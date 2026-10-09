// @ts-check
// lib/trainer-terms.js
// ─────────────────────────────────────────────────────────────────────────────
// Trainer Terms and the client's share consent: copy and version live
// together, as in lib/consent.js. Change the words, bump the version.
// Client-safe and dependency-free; server routes import it for validation.
// The launch switches that read server env (trainerOpenFor, shareOpenFor,
// applyOpenFor) live in lib/auth-server.js.
// ─────────────────────────────────────────────────────────────────────────────

/** Live: "Add a trainer" is open to every account; the dashboard and invites to every approved trainer.
 *  Applying keeps its own switch, APPLICATIONS_OPEN; the Terms version stays as is. */
export const TRAINER_LIVE = true;

/** Applications are open to everyone signed in; approval stays the admin's. */
export const APPLICATIONS_OPEN = true;

/** The current Terms: the owner accepted this text as written, so the string
 *  stays. A bump makes every trainer re-accept: trainer_terms is overwritten
 *  in place on the next upgrade.
 *  draft-2026-10-05b: adds the line on a downloaded copy. */
export const TRAINER_TERMS_VERSION = "draft-2026-10-05b";

/** Only the current version may be stamped. */
export const KNOWN_TRAINER_TERMS_VERSIONS = Object.freeze([TRAINER_TERMS_VERSION]);

export const TRAINER_TERMS_COPY = Object.freeze({
  // The summary on the upgrade sheet; the full Terms are at `href`.
  summary: Object.freeze([
    "Clients choose to share with you, and can stop at any time.",
    "Use it only to coach them, and keep it private.",
    "Change a client's plan only to coach them. They see every change and can undo it.",
    "You're 18 or over.",
    "Free.",
  ]),
  // Under "Set me up as a trainer", in ConsentLine grammar.
  line: "I'm 18 or over, and I accept the Trainer Terms.",
  href: "/trainer/terms",
});

/**
 * Server side: the Trainer Terms version to stamp, or null for anything unknown.
 * @param {any} claim
 * @returns {string | null}
 */
export function acceptedTrainerTermsVersion(claim) {
  const v = claim && typeof claim === "object" ? claim.version : null;
  return typeof v === "string" && KNOWN_TRAINER_TERMS_VERSIONS.includes(v) ? v : null;
}

/**
 * Whether a stored accounts.trainer_terms record is current and attests 18+.
 * @param {{ version?: unknown, adult?: unknown } | null | undefined} rec
 */
export function isCurrentTrainerTerms(rec) {
  return rec?.version === TRAINER_TERMS_VERSION && rec?.adult === true;
}

/** Bump whenever SHARE_COPY changes what is shared. Each grant records the
 *  version its client saw; a wider share needs a new version and a fresh approval.
 *  2026-10-05: adds the trainer's plan changes. Grants approved at this version
 *  start with changes on (oauth_grants.edits_at); older ones stay read only.
 *  2026-10-05b: adds the trainer's download of what they see. The download
 *  is the same view, logged as a look, so it is not a wider share: older
 *  grants can download too, and the bump only asks for a fresh approval to
 *  turn changes on (dbEditsOn). */
export const SHARE_CONSENT_VERSION = "2026-10-05b";

/** Only the current version may be stamped on a grant. */
export const KNOWN_SHARE_CONSENT_VERSIONS = Object.freeze([SHARE_CONSENT_VERSION]);

/** The fixed scope of every trainer grant. There is no client choice. Plan
 *  changes are not a scope: they live on the grant (edits_at, edits_off_at). */
export const TRAINER_SCOPE = "trainer:read";

// What the client agrees to when approving a trainer: fixed rows (no
// switches), what the share includes, and the line under the commit.
export const SHARE_COPY = Object.freeze({
  rows: Object.freeze([
    "Your sessions, sets, RPE and how you felt, from the last 24 weeks.",
    "Your main-lift trend and bests over the last 12 months.",
    "On their client list: when you last trained, your sessions this week against your plan, and your 28-day rhythm.",
    "Breathers show as paused, never why.",
    "Each look shows in your Profile, plus one check-in a day from their client list.",
    // The CSV download (app/api/trainer/export): what the pane shows, logged as a look.
    "They can download a copy of what they see.",
    // Covers the trainer's notice dot ahead of its build: one yes/no across all clients.
    "They may see a dot when any client has trained since they last opened their list. It never says who.",
    // Plan changes, as far as they ship: what they see to make them (the whole
    // plan projection, lib/trainer-plan.js; the top set is the basis for the
    // limits, so it shows whatever its age), what they can change, and the
    // client's controls. Week and dated changes are off (lib/trainer-change.js
    // LIVE_SLICES); widening them needs a new version.
    "Your current working weights, reps and main lifts for every lift in your programme, whether you're on a deload, and your planned week up to 4 weeks ahead.",
    "Each lift's most recent top set, however long ago. It keeps their changes within safe limits.",
    "They can change your working weights, reps and main lifts from your next session on, within the app's limits.",
    "Every change is checked against your training. It shows in Profile with what it was before, and you can undo it in one tap until you've trained at it. Your logged sessions never change.",
    "Turn their changes off in one tap in Profile, and keep sharing. Turning them off, or stopping sharing, cancels any change that hasn't reached your plan yet.",
  ]),
  includes: "Includes sessions already logged, and new ones as you log them. Photos, bodyweight, sleep and notes stay yours.",
  line: "Only you decide. Stop any time in Profile, and they lose access straight away.",
});

/**
 * Server side: the share-consent version to record on a grant, or null.
 * @param {any} claim
 * @returns {string | null}
 */
export function acceptedShareConsentVersion(claim) {
  const v = claim && typeof claim === "object" ? claim.version : null;
  return typeof v === "string" && KNOWN_SHARE_CONSENT_VERSIONS.includes(v) ? v : null;
}
