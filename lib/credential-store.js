// @ts-check
// lib/credential-store.js
// ─────────────────────────────────────────────────────────────────────────────
// Passkey credential reads, and the per-ceremony index writes, for the auth
// routes: the credential index is Neon `credentials`, one row per passkey,
// keyed to an account. (dbReclaimHandle and the backfill apply also insert
// rows, inside their own transactions.)
//
// Sign-in reads come from the index. While IDENTITY_BLOB_FALLBACK is on they
// are unioned, per credential id, with the account's Blob credentials doc
// (the index wins on a duplicate id). The verify routes keep writing that doc
// as a mirror while the dual-write window is open (credentialMirrorOpen).
//
// Writes here, named: INSERT into credentials (an id held by another account
// is never re-pointed); UPDATE of credentials.counter / rp_id / last_used_at;
// UPDATE of accounts.consent. Blob is only read here. Nothing here deletes.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "node:crypto";
import { list } from "@vercel/blob";
import { readJsonByPrefix } from "./blob-utils.js";
import { sql, ensureSchema } from "./db.js";
import { dbInsertCredential, dbTouchCredential, dbListCredentials, dbSetAccountConsent } from "./identity-store.js";
import { IDENTITY_BLOB_FALLBACK, CREDENTIAL_BLOB_DUALWRITE_UNTIL } from "./identity.js";
import { credentialsPrefix } from "./storage-keys.js";

export { IDENTITY_BLOB_FALLBACK };

/**
 * @typedef {{ version: string, at: string }} Consent
 * @typedef {{ id: string, consent?: Consent | null }} IndexedAccount
 * @typedef {{ id: string, storageKey: string, consent?: Consent | null }} ReadableAccount
 * @typedef {{ id: string, publicKey?: string, counter?: number, transports?: string[], rpId?: string,
 *   createdAt?: string | null, userHandle?: string }} StoredCredential
 * @typedef {{ id: string, publicKey: string, counter?: number, transports?: string[], rpId: string, createdAt?: string }} VerifiedCredential
 */

/** Same record: jsonb hands keys back in its own order, so compare fields.
 *  @param {Consent | null | undefined} a @param {Consent | null | undefined} b */
const sameConsent = (a, b) => (a ?? null) === (b ?? null) || (!!a && !!b && a.version === b.version && a.at === b.at);

/**
 * Bring accounts.consent in line with a consent record the ceremony just
 * settled on. Writes only a value, and only on a difference: nothing here
 * clears an account's consent.
 * @param {IndexedAccount} account
 * @param {Consent | null | undefined} consent
 * @returns {Promise<boolean>} whether a write was issued
 */
export async function mirrorAccountConsent(account, consent) {
  if (!consent || sameConsent(account.consent, consent)) return false;
  await dbSetAccountConsent(account.id, consent);
  return true;
}

/**
 * An account's passkeys, as the sign-in routes read them.
 * `credentials`: the index rows in the credentials-doc shape, unioned (while
 * the fallback is on) with the Blob doc's entries the index does not hold.
 * `blobDoc`: the Blob doc as read (null when absent, unreadable, or the
 * fallback is off); the verify routes mirror their writes onto it.
 * `blobUnreadable` (only with `probe`): the doc read failed while a doc is
 * listed, so the set may be missing passkeys.
 * `consent`: the account's record first, then the doc's.
 * `doc` reads the Blob doc even with the fallback off. Registration needs it:
 * its protection gate must see every passkey on file, and its mirror write
 * must start from the doc it replaces.
 * On a duplicate id the higher signature counter of the two copies is kept,
 * so clone detection never runs against a counter older than either store's.
 * @param {ReadableAccount} account
 * @param {{ probe?: boolean, doc?: boolean }} [opts]
 * @returns {Promise<{ credentials: StoredCredential[], consent: Consent | null, blobDoc: any, blobUnreadable: boolean }>}
 */
export async function readCredentialSet(account, { probe = false, doc = IDENTITY_BLOB_FALLBACK } = {}) {
  const rows = (await dbListCredentials(account.id)) || [];
  /** @type {StoredCredential[]} */
  const credentials = rows.map((r) => ({
    id: r.id,
    publicKey: r.publicKey,
    counter: r.counter,
    transports: r.transports,
    rpId: r.rpId,
    createdAt: r.createdAt,
    userHandle: r.userHandle,
  }));
  let blobDoc = null;
  let blobUnreadable = false;
  if (doc) {
    const prefix = credentialsPrefix(account.storageKey);
    blobDoc = await readJsonByPrefix(prefix);
    // readJsonByPrefix returns null for both "no doc" and "read threw".
    if (blobDoc === null && probe) {
      try { blobUnreadable = (await list({ prefix })).blobs.length > 0; } catch { blobUnreadable = true; }
    }
    const held = new Map(credentials.map((c) => [c.id, c]));
    for (const c of Array.isArray(blobDoc?.credentials) ? blobDoc.credentials : []) {
      if (!c) continue;
      const row = held.get(c.id);
      if (!row) credentials.push(c);
      else if (typeof c.counter === "number" && c.counter > (row.counter || 0)) row.counter = c.counter;
    }
  }
  return { credentials, consent: account.consent ?? blobDoc?.consent ?? null, blobDoc, blobUnreadable };
}

/**
 * Whether the verify routes still mirror credential writes onto the Blob doc:
 * always while sign-in reads it, then until CREDENTIAL_BLOB_DUALWRITE_UNTIL
 * (null: no end set yet).
 * @param {number} [now]
 */
export function credentialMirrorOpen(now = Date.now()) {
  if (IDENTITY_BLOB_FALLBACK) return true;
  return CREDENTIAL_BLOB_DUALWRITE_UNTIL == null || now < Date.parse(CREDENTIAL_BLOB_DUALWRITE_UNTIL);
}

/**
 * The Blob doc a sign-in mirrors its write onto, or null (no doc, or the
 * window has closed). Once sign-in stops reading the doc, it is read here for
 * the mirror alone and never joins the sign-in set.
 * @param {ReadableAccount} account
 * @param {{ blobDoc: any }} set  as readCredentialSet returned it
 */
export async function credentialMirrorDoc(account, set) {
  if (!credentialMirrorOpen()) return null;
  if (IDENTITY_BLOB_FALLBACK) return set.blobDoc;
  return readJsonByPrefix(credentialsPrefix(account.storageKey));
}

/**
 * The WebAuthn user.id for a reclaim of a lapsed handle. The new account does
 * not exist while options run (options never write), so the id is derived
 * from the ceremony's own challenge and recomputed at verify.
 * @param {string} challenge
 */
export function reclaimUserId(challenge) {
  const secret = process.env.CHALLENGE_SECRET;
  if (typeof secret !== "string" || !secret) throw new Error("CHALLENGE_SECRET unset");
  return crypto.createHmac("sha256", secret).update(`hw-reclaim-uid.${challenge}`).digest("base64url");
}

/**
 * Index a freshly verified registration on the account it was made for.
 * user_handle is the user.id register-options baked into the passkey.
 * Idempotent: a repeat for the same account inserts nothing.
 * @param {IndexedAccount} account
 * @param {VerifiedCredential} credential  as written to the Blob doc
 * @param {{ userHandle: string, consent?: Consent | null }} opts  consent: the record after this registration
 * @returns {Promise<{ accountId: string, inserted: boolean | null, consentWritten: boolean }>}
 */
export async function indexRegistration(account, credential, { userHandle, consent = null }) {
  const inserted = await dbInsertCredential({
    id: credential.id,
    accountId: account.id,
    publicKey: credential.publicKey,
    counter: credential.counter || 0,
    transports: credential.transports || [],
    rpId: credential.rpId,
    userHandle,
    source: "register",
    createdAt: credential.createdAt || null,
  });
  const consentWritten = await mirrorAccountConsent(account, consent);
  return { accountId: account.id, inserted, consentWritten };
}

/**
 * Record a verified sign-in on the index: the new counter, the rpId the
 * assertion matched, and last_used_at. Runs on every success; a credential
 * the index does not hold for this account is left alone (touched: false).
 * @param {IndexedAccount} account
 * @param {string} credentialId
 * @param {{ counter?: number | null, rpId?: string | null, consent?: Consent | null }} [opts]
 *   consent: the record this sign-in just stamped, if any
 * @returns {Promise<{ accountId: string, touched: boolean | null, consentWritten: boolean }>}
 */
export async function indexSignIn(account, credentialId, { counter = null, rpId = null, consent = null } = {}) {
  const touched = await dbTouchCredential(account.id, credentialId, {
    counter: typeof counter === "number" ? counter : null,
    rpId: rpId || null,
  });
  const consentWritten = await mirrorAccountConsent(account, consent);
  return { accountId: account.id, touched, consentWritten };
}

/**
 * The account a credential id is indexed to, or null (none, or no DB).
 * @param {string} credentialId
 * @returns {Promise<string | null>}
 */
export async function credentialHolder(credentialId) {
  const q = sql();
  if (!q) return null;
  await ensureSchema(q);
  const rows = await q`SELECT account_id FROM credentials WHERE id = ${credentialId} LIMIT 1`;
  return rows.length ? rows[0].account_id : null;
}

/**
 * How many passkeys the index holds for an account; null when there is no DB.
 * @param {string} accountId
 * @returns {Promise<number | null>}
 */
export async function countIndexedCredentials(accountId) {
  const rows = await dbListCredentials(accountId);
  return rows ? rows.length : null;
}
