// Profiles the server has confirmed have no passkey, this app session only.
// Sync can't store anything for them (every push 401s), so pushes stay on
// the device instead of shipping training data just to be turned away.
// In memory by design: every launch re-checks (ForgeApp mount), so a passkey
// added on another device is picked up next open — no stale flag to strand
// a profile.

/** @type {Set<string>} */
const known = new Set();
const key = (profile) => String(profile || "").trim().toLowerCase();

/** @param {string} profile @param {boolean | null} has — hasPasskey()'s answer; null (unknown) changes nothing */
export function notePasskey(profile, has) {
  if (has === false) known.add(key(profile));
  else if (has === true) known.delete(key(profile));
}

/** @param {string} profile */
export const isKnownPasskeyless = (profile) => known.has(key(profile));
