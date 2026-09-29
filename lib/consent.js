// @ts-check
// lib/consent.js
// ─────────────────────────────────────────────────────────────────────────────
// The explicit-consent statement shown under every "add a passkey" button,
// and its version. Copy and version live together: change the words, bump
// the version. Server routes import this for validation, so it stays
// dependency-free.
// ─────────────────────────────────────────────────────────────────────────────

/** Bump whenever CONSENT_COPY changes meaning. A bump makes the next
 *  ceremony overwrite the stored { version, at } in place; the previous
 *  record is not kept. */
export const CONSENT_VERSION = "2026-09-29";

/** Versions a ceremony may stamp. Only the current one: a stale client
 *  showing older words must not record consent to these. */
export const KNOWN_CONSENT_VERSIONS = Object.freeze([CONSENT_VERSION]);

// Existing-holder quiet tap on the Profile passkey row: off until the owner's nod (a separate commit).
// Enabling it: each holder's first tap writes a new credentials file, then DELETES every older blob under forge/profiles/<name>/credentials (writeJsonReplacingPrefix's sweep).
export const EXISTING_HOLDER_CONSENT_TAP = false;

export const CONSENT_COPY = Object.freeze({
  line: "With a passkey, your training, bodyweight and photos live safely with us, and follow you to any device. Only you can see them.",
  age: "Over-18s only",
  link: "What we keep, and how to delete it",
  href: "/privacy",
  // Existing passkey holders: the quiet one-tap on the Profile passkey row.
  confirm: "Yes, keep it for me",
  // Shown in place of the tap once it's recorded.
  confirmed: "Noted. Thank you.",
});

/** What a client sends with a ceremony started from a surface that showed CONSENT_COPY. */
export function consentClaim() {
  return { version: CONSENT_VERSION };
}

/**
 * Server side: the version to stamp, or null. Anything unrecognised is
 * ignored, never an error, so a bad claim can't fail a ceremony.
 * @param {any} claim
 * @returns {string | null}
 */
export function acceptedConsentVersion(claim) {
  const v = claim && typeof claim === "object" ? claim.version : null;
  return typeof v === "string" && KNOWN_CONSENT_VERSIONS.includes(v) ? v : null;
}

/**
 * The consent record on a credentials doc (server side), or null when absent
 * or malformed. Returns only the two known fields. /api/auth/check replies
 * with { version } only, never `at`.
 * @param {any} doc
 * @returns {{ version: string, at: string } | null}
 */
export function consentRecord(doc) {
  const c = doc && typeof doc === "object" ? doc.consent : null;
  return c && typeof c.version === "string" && typeof c.at === "string"
    ? { version: c.version, at: c.at }
    : null;
}

/** @param {{ version?: string } | null | undefined} consent */
export function isCurrentConsent(consent) {
  return consent?.version === CONSENT_VERSION;
}
