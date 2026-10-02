// @ts-check
// Does this passkey still belong to this account, and can it still sign in?
// A removed passkey, or one whose domain is no longer served, ends any AI
// connection it approved. Same usability rule as sign-in (hasUsablePasskey).
// Reads only.
import { readCredentialSet } from "./credential-store.js";
import { isUsableCredential } from "./auth-server.js";
import { acceptedRpIds } from "./origin.js";
import { dbGetAccount, dbAccountByStorageKey } from "./identity-store.js";

/**
 * The account's credential index row for this id decides. With no row and
 * the Blob fallback on, the account's own Blob credentials doc decides
 * (readCredentialSet: the index wins on a duplicate id).
 * @param {{ accountId?: string | null, storageKey?: string } | null | undefined} identity
 * @param {string} credentialId
 * @param {string[]} [accepted]
 */
export async function credentialExists(identity, credentialId, accepted = acceptedRpIds()) {
  if (!identity?.accountId || !identity.storageKey || !credentialId) return false;
  const { credentials } = await readCredentialSet({ id: identity.accountId, storageKey: identity.storageKey });
  const c = credentials.find((x) => x?.id === credentialId);
  return !!c && isUsableCredential(c, accepted);
}

/**
 * The account an AI grant belongs to: by its account id, or (a grant from
 * before accounts) by its `profile` as a storage key. Null when the account
 * is gone or closed.
 * @param {{ accountId?: string | null, profile?: string } | null | undefined} grant
 * @returns {Promise<{ accountId: string, storageKey: string } | null>}
 */
export async function grantIdentity(grant) {
  if (!grant) return null;
  const account = grant.accountId
    ? await dbGetAccount(grant.accountId)
    : grant.profile ? await dbAccountByStorageKey(grant.profile) : null;
  if (!account || account.deletedAt) return null;
  return { accountId: account.id, storageKey: account.storageKey };
}
