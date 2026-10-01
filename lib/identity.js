// @ts-check
// lib/identity.js
// ─────────────────────────────────────────────────────────────────────────────
// Account identity: pure helpers, no I/O. An identity is
//   { accountId, storageKey, handle, roles, plan }
// where the storage key (SK) is frozen at account creation and is what every
// Neon `profile` column and Blob path is built from. Handles can move; storage
// keys never do.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from "node:crypto";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase alphabet, no padding. @param {Uint8Array} bytes */
export function base32lower(bytes) {
  let out = "";
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(buf >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buf &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(buf << (5 - bits)) & 31];
  return out;
}

export const ACCOUNT_ID_RE = /^hwa_[a-z2-7]{26}$/;
/** Handles may never take the account-id shape's prefix. */
export const RESERVED_HANDLE_RE = /^hwa_/;

/** "hwa_" + 26 base32 chars from 16 random bytes. */
export const newAccountId = () => "hwa_" + base32lower(randomBytes(16));

/** Random per-account WebAuthn user.id (base64url, 32 bytes). */
export const newWebauthnUserId = () => randomBytes(32).toString("base64url");

/** The user.id baked into pre-account passkeys: sha256(storage key), base64url.
 *  @param {string} sk */
export const legacyUserHandle = (sk) => createHash("sha256").update(sk).digest("base64url");

/** @param {unknown} s */
export const isAccountId = (s) => typeof s === "string" && ACCOUNT_ID_RE.test(s);

// While true: credential reads fall back to the Blob doc, and availability
// unions the blob prefix. Flipped to false after cutover verification.
export const IDENTITY_BLOB_FALLBACK = true;
// While null or in the future, credential writes are mirrored to Blob.
/** @type {string | null} */
export const CREDENTIAL_BLOB_DUALWRITE_UNTIL = null;

/**
 * @typedef {{ id: string, storageKey: string, roles: string[], plan: string, deletedAt?: string | null }} Account
 * @typedef {{ handle: string, accountId: string }} HandleRow
 * @typedef {{ accountId: string, storageKey: string, handle: string | null, roles: string[], plan: string }} Identity
 */

/**
 * Pure core of every token gate. Fail-closed.
 * @param {any} tokenData  stored token / grant record
 * @param {Account | null | undefined} account  the account the token points at
 * @param {HandleRow | null | undefined} handleRow  undefined = caller named no handle
 * @param {number} now
 * @returns {Identity | null}
 */
export function matchTokenIdentity(tokenData, account, handleRow, now) {
  if (!tokenData || typeof tokenData !== "object") return null;
  if (typeof tokenData.expires !== "number" || now > tokenData.expires) return null;
  if (!account || account.deletedAt) return null;
  if (tokenData.accountId) {
    if (tokenData.accountId !== account.id) return null;
  } else if (tokenData.profile !== account.storageKey) {
    // Legacy row (no account id): its `profile` is a storage key, never a handle.
    return null;
  }
  if (handleRow !== undefined && !(handleRow && handleRow.accountId === account.id)) return null;
  return {
    accountId: account.id,
    storageKey: account.storageKey,
    handle: handleRow?.handle ?? null,
    roles: account.roles,
    plan: account.plan,
  };
}
