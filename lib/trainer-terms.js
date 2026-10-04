// @ts-check
// lib/trainer-terms.js
// ─────────────────────────────────────────────────────────────────────────────
// Trainer Terms and the client's share consent: copy and version live
// together, as in lib/consent.js. Change the words, bump the version.
// Client-safe and dependency-free; server routes import it for validation.
// The launch switches that read server env (trainerOpenFor, shareOpenFor) live
// in lib/auth-server.js.
// ─────────────────────────────────────────────────────────────────────────────

/** Off until launch: only the admin can be a trainer while this is false. */
export const TRAINER_LIVE = false;

/** Placeholder until the owner's Terms text lands. A bump makes every trainer
 *  re-accept: trainer_terms is overwritten in place on the next upgrade. */
export const TRAINER_TERMS_VERSION = "draft-2026-10";

/** Only the current version may be stamped. */
export const KNOWN_TRAINER_TERMS_VERSIONS = Object.freeze([TRAINER_TERMS_VERSION]);

export const TRAINER_TERMS_COPY = Object.freeze({
  // The summary on the upgrade sheet; the full Terms are at `href`.
  summary: Object.freeze([
    "Clients choose to share with you, and can stop at any time.",
    "Use it only to coach them, and keep it private.",
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
 *  version its client saw; a wider share needs a new version and a fresh approval. */
export const SHARE_CONSENT_VERSION = "2026-10-04";

/** Only the current version may be stamped on a grant. */
export const KNOWN_SHARE_CONSENT_VERSIONS = Object.freeze([SHARE_CONSENT_VERSION]);

/** The fixed scope of every trainer grant. There is no client choice. */
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
    // Covers the trainer's notice dot ahead of its build: one yes/no across all clients.
    "They may see a dot when any client has trained since they last opened their list. It never says who.",
  ]),
  includes: "Includes sessions already logged, and new ones as you log them. Read only. Photos, bodyweight, sleep and notes stay yours.",
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
