// @ts-check
// The only place Blob paths are built from a storage key. Pure.
//
// Every builder takes the storage key VERBATIM: callers pass the already
// normalised key (today normaliseProfile(name)); nothing here normalises
// again, so a key that is not canonical stays exactly what was passed.
//
// PATH SCHEME: deterministic, and it must stay that way. Writes overwrite in
// place; a write the reader cannot find back is silent data loss.

/** @param {string} sk */
const enc = (sk) => encodeURIComponent(sk);

// Trailing slash is load-bearing: without it, list() does a prefix match that
// catches adjacent keys ("analmonk" would hit "analmonkey/meta.json").
/** @param {string} sk */
export const profileDir = (sk) => `forge/profiles/${enc(sk)}/`;

/** @param {string} sk */
export const metaPath = (sk) => `${profileDir(sk)}meta.json`;

/** @param {string} sk */
export const historyPath = (sk) => `${profileDir(sk)}history.json`;

// No trailing slash or extension: the prefix also covers the
// credentials-<suffix>.json siblings written by addRandomSuffix.
/** @param {string} sk */
export const credentialsPrefix = (sk) => `${profileDir(sk)}credentials`;

/** @param {string} sk */
export const credentialsPath = (sk) => `${credentialsPrefix(sk)}.json`;

/** @param {string} sk */
export const photosPrefix = (sk) => `${profileDir(sk)}photos/`;

/** @param {string} sk @param {string} date YYYY-MM-DD */
export const photoPath = (sk, date) => `${photosPrefix(sk)}${date}.jpg`;

// Snapshot generations live outside the profile prefix.
/** @param {string} sk */
export const snapshotPaths = (sk) => ({
  daily: `forge/snapshots/daily/${enc(sk)}.json`,
  weekly: `forge/snapshots/weekly/${enc(sk)}.json`,
});
