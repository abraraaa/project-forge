// @ts-check
// Does this passkey still belong to this profile? A removed passkey ends any
// AI connection it approved. Reads the same credentials doc login-verify does.
import { readJsonByPrefix } from "./blob-utils.js";
import { normaliseProfile } from "./profile-name.js";

/** @param {string} profile @param {string} credentialId */
export async function credentialExists(profile, credentialId) {
  if (!profile || !credentialId) return false;
  const doc = await readJsonByPrefix(`forge/profiles/${encodeURIComponent(normaliseProfile(profile))}/credentials`);
  return !!doc?.credentials?.some((/** @type {any} */ c) => c.id === credentialId);
}
