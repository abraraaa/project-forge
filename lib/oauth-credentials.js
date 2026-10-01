// @ts-check
// Does this passkey still belong to this profile, and can it still sign in?
// A removed passkey, or one whose domain is no longer served, ends any AI
// connection it approved. Same usability rule as sign-in (hasUsablePasskey).
import { readJsonByPrefix } from "./blob-utils.js";
import { normaliseProfile } from "./profile-name.js";
import { isUsableCredential } from "./auth-server.js";
import { acceptedRpIds } from "./origin.js";

/** @param {string} profile @param {string} credentialId @param {string[]} [accepted] */
export async function credentialExists(profile, credentialId, accepted = acceptedRpIds()) {
  if (!profile || !credentialId) return false;
  const doc = await readJsonByPrefix(`forge/profiles/${encodeURIComponent(normaliseProfile(profile))}/credentials`);
  return !!doc?.credentials?.some((/** @type {any} */ c) => c?.id === credentialId && isUsableCredential(c, accepted));
}
