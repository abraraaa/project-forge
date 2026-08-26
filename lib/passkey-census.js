// @ts-check
// lib/passkey-census.js
// Counts what is actually under forge/profiles/*/credentials. Pure; the route
// does the I/O. Two separate populations: KEYLESS legacy (no publicKey, inert)
// and rpId legacy (every credential, since nothing ever wrote an rpId field).
// Never emits ids, public keys or transports.

import { FLIP_DATE, LEGACY_RP_ID, NATIVE_RP_ID, daysUntilPasskeySunset } from "./origin.js";

// Every ceremony declared this rpId, so absent means legacy, not unknown.
export const IMPLICIT_RP_ID = LEGACY_RP_ID;

/** @param {{ publicKey?: string }} c */
const isVerifiable = (c) => !!c && typeof c.publicKey === "string" && c.publicKey.length > 0;

/** @param {{ rpId?: string }} c */
const rpIdOf = (c) => (typeof c?.rpId === "string" && c.rpId ? c.rpId : IMPLICIT_RP_ID);

const bump = (/** @type {Record<string, number>} */ m, /** @type {string} */ k) => {
  m[k] = (m[k] || 0) + 1;
};

/**
 * @typedef {object} CredentialBlob
 * @property {string} profile   decoded profile directory name
 * @property {string} pathname  full blob path
 * @property {string} [uploadedAt]
 * @property {number} [size]
 * @property {any} doc          parsed JSON, or null when unreadable
 */

/**
 * @param {CredentialBlob[]} blobs every blob under a credentials prefix
 * @param {string} flipDate       ISO date the domain moved
 */
export function censusPasskeys(blobs = [], flipDate = FLIP_DATE) {
  /** @type {Record<string, any>} */
  const profiles = {};

  for (const b of blobs) {
    const p = (profiles[b.profile] ||= {
      blobs: 0, strays: 0, bytes: 0, unreadableBlobs: 0,
      credentials: 0, verifiable: 0, keyless: 0,
      rpIds: {}, preFlip: 0, postFlip: 0, undated: 0,
      oldest: null, newest: null,
    });
    p.blobs++;
    p.bytes += b.size || 0;
  }

  // Newest per profile is authoritative (readJsonByPrefix picks it). Older
  // siblings count as strays and are never tallied.
  const byProfile = new Map();
  for (const b of blobs) {
    const cur = byProfile.get(b.profile);
    const t = Date.parse(b.uploadedAt || "") || 0;
    if (!cur || t >= cur.t) byProfile.set(b.profile, { blob: b, t });
  }

  for (const [profile, { blob }] of byProfile) {
    const p = profiles[profile];
    p.strays = p.blobs - 1;
    p.authoritative = blob.pathname;

    const creds = Array.isArray(blob.doc?.credentials) ? blob.doc.credentials : null;
    if (!creds) {
      p.unreadableBlobs = 1;
      continue;
    }
    for (const c of creds) {
      p.credentials++;
      if (isVerifiable(c)) p.verifiable++;
      else p.keyless++;
      bump(p.rpIds, rpIdOf(c));
      const created = typeof c?.createdAt === "string" ? c.createdAt.slice(0, 10) : null;
      if (!created) p.undated++;
      else {
        if (flipDate && created < flipDate) p.preFlip++;
        else p.postFlip++;
        if (!p.oldest || created < p.oldest) p.oldest = created;
        if (!p.newest || created > p.newest) p.newest = created;
      }
    }
    p.protected = p.verifiable > 0;
  }

  const all = Object.values(profiles);
  const sum = (/** @type {(p: any) => number} */ f) => all.reduce((n, p) => n + (f(p) || 0), 0);
  /** @type {Record<string, number>} */
  const rpIds = {};
  for (const p of all) for (const [k, n] of Object.entries(p.rpIds)) rpIds[k] = (rpIds[k] || 0) + (/** @type {number} */ (n));

  const credentials = sum((p) => p.credentials);
  const native = Object.entries(rpIds)
    .filter(([k]) => k !== IMPLICIT_RP_ID)
    .reduce((n, [, v]) => n + v, 0);

  return {
    totals: {
      profilesWithCredentialBlobs: all.length,
      credentialBlobs: sum((p) => p.blobs),
      straySiblings: sum((p) => p.strays),
      unreadableDocuments: sum((p) => p.unreadableBlobs),
      bytes: sum((p) => p.bytes),
      credentials,
      verifiable: sum((p) => p.verifiable),
      keylessLegacy: sum((p) => p.keyless),
      profilesProtected: all.filter((p) => p.protected).length,
      profilesWithNoVerifiableCredential: all.filter((p) => p.credentials > 0 && !p.protected).length,
      mintedPreFlip: sum((p) => p.preFlip),
      mintedPostFlip: sum((p) => p.postFlip),
      undated: sum((p) => p.undated),
      rpIds,
    },
    dependency: {
      rpIdInUse: IMPLICIT_RP_ID,
      credentialsBoundToLegacyDomain: rpIds[IMPLICIT_RP_ID] || 0,
      credentialsNativeToHeatwayve: native,
      note:
        `Every ceremony declares rpId "${IMPLICIT_RP_ID}", so browsers must fetch ` +
        `https://${IMPLICIT_RP_ID}/.well-known/webauthn to permit a login from heatwayve.app. ` +
        `While that is true, ${IMPLICIT_RP_ID} is a hard authentication dependency: if it stops ` +
        `resolving, no passkey can complete a ceremony. An rpId is fixed at credential ` +
        `creation and cannot be rewritten server-side — clearing this requires each holder ` +
        `to register a new passkey, not a migration script.`,
    },
    profiles,
  };
}

// Reports which profiles' photos a wipe WOULD target. No delete authority.
// Two buckets, deliberately unmerged:
//   atSunset    — legacy-only profiles that lose their lock on the sunset date
//   alreadyOpen — no verifiable credential at all; claimable TODAY

const PATHS_PER_PROFILE = 20;

/**
 * @param {ReturnType<typeof censusPasskeys>} census
 * @param {Array<{ profile: string, pathname: string, size?: number }>} photoBlobs
 */
export function photosAtRisk(census, photoBlobs = []) {
  /** @type {Record<string, { photos: number, bytes: number, paths: string[] }>} */
  const byProfile = {};
  for (const b of photoBlobs) {
    const e = (byProfile[b.profile] ||= { photos: 0, bytes: 0, paths: [] });
    e.photos++;
    e.bytes += b.size || 0;
    e.paths.push(b.pathname);
  }

  const bucket = (/** @type {string[]} */ names) => {
    const rows = names
      .filter((n) => byProfile[n])
      .map((n) => {
        const e = byProfile[n];
        return {
          profile: n,
          photos: e.photos,
          bytes: e.bytes,
          // The prefix a wipe would scope itself to. Trailing slash: it cannot
          // reach a sibling profile whose name merely starts the same way.
          prefix: `forge/profiles/${encodeURIComponent(n)}/photos/`,
          paths: e.paths.slice(0, PATHS_PER_PROFILE).sort(),
          // Never a silent cap — a truncated list must say so, or the reader
          // takes a sample for the whole.
          pathsOmitted: Math.max(0, e.paths.length - PATHS_PER_PROFILE),
        };
      })
      .sort((a, b) => b.photos - a.photos);
    return {
      profiles: rows.length,
      photos: rows.reduce((n, r) => n + r.photos, 0),
      bytes: rows.reduce((n, r) => n + r.bytes, 0),
      rows,
    };
  };

  const entries = Object.entries(census.profiles || {});
  // Loses its lock at the sunset: holds a verifiable credential, none native.
  const atSunsetNames = entries
    .filter(([, p]) => p.verifiable > 0 && !(p.rpIds?.[NATIVE_RP_ID] > 0))
    .map(([n]) => n);
  // Already unprotected: a credential document exists but nothing in it can be
  // verified. hasRealPasskey already reports these profiles as having no
  // passkey, so the name is claimable now.
  const alreadyOpenNames = entries
    .filter(([, p]) => p.verifiable === 0)
    .map(([n]) => n);
  // Photos under a profile with no credential document at all.
  const known = new Set(entries.map(([n]) => n));
  const noCredentials = Object.keys(byProfile).filter((n) => !known.has(n));

  return {
    dryRun: true,
    deletes: "none — this reports a proposed kill list and nothing else",
    scope: "forge/profiles/<profile>/photos/ — prefix-scoped, per profile",
    totals: {
      profilesWithPhotos: Object.keys(byProfile).length,
      photos: Object.values(byProfile).reduce((n, e) => n + e.photos, 0),
      bytes: Object.values(byProfile).reduce((n, e) => n + e.bytes, 0),
    },
    atSunset: bucket(atSunsetNames),
    alreadyOpen: bucket([...alreadyOpenNames, ...noCredentials]),
  };
}

// One greppable line of AGGREGATES per run — a cheap time series for migration
// progress. Never names: the detailed report stays behind the gated response.
export function censusLogLine(census, photoExposure = null, now = Date.now()) {
  const t = census?.totals || {};
  const d = census?.dependency || {};
  const p = photoExposure || {};
  const fields = [
    ["profiles", t.profilesWithCredentialBlobs],
    ["credentials", t.credentials],
    ["verifiable", t.verifiable],
    ["keyless", t.keylessLegacy],
    ["native", d.credentialsNativeToHeatwayve],
    ["legacy", d.credentialsBoundToLegacyDomain],
    ["preFlip", t.mintedPreFlip],
    ["postFlip", t.mintedPostFlip],
    ["strays", t.straySiblings],
    ["unreadable", t.unreadableDocuments],
    ["photos", p.totals?.photos],
    ["atSunset", p.atSunset?.profiles],
    ["alreadyOpen", p.alreadyOpen?.profiles],
    ["sunsetInDays", daysUntilPasskeySunset(now)],
  ];
  return `[forge:passkey-census] ${fields.map(([k, v]) => `${k}=${v ?? 0}`).join(" ")}`;
}
