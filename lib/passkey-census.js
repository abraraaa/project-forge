// @ts-check
// lib/passkey-census.js
// Counts what is actually under forge/profiles/*/credentials. Pure; the route
// does the I/O. Two populations that can never complete a ceremony: KEYLESS
// legacy (no publicKey) and rpId legacy (bound to theforged.fit, including
// every credential with no rpId field). Only a verifiable native credential
// is usable. Never emits ids, public keys or transports.

import { FLIP_DATE, LEGACY_RP_ID, NATIVE_RP_ID } from "./origin.js";
import { photosPrefix } from "./storage-keys.js";

// Every ceremony declared this rpId, so absent means legacy, not unknown.
export const IMPLICIT_RP_ID = LEGACY_RP_ID;

/** @param {{ publicKey?: string }} c */
const isVerifiable = (c) => !!c && typeof c.publicKey === "string" && c.publicKey.length > 0;

/** @param {{ rpId?: string }} c */
const rpIdOf = (c) => (typeof c?.rpId === "string" && c.rpId ? c.rpId : IMPLICIT_RP_ID);

/** Verifiable credentials on file, none of them native. */
const isLegacyOnly = (/** @type {any} */ p) => p.verifiable > 0 && !(p.usable > 0);

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
      credentials: 0, verifiable: 0, usable: 0, keyless: 0,
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
      if (isVerifiable(c)) {
        p.verifiable++;
        if (rpIdOf(c) === NATIVE_RP_ID) p.usable++;
      } else p.keyless++;
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
      // Keyless-only and legacy-only alike: no ceremony can prove control.
      profilesWithNoUsableCredential: all.filter((p) => p.credentials > 0 && !(p.usable > 0)).length,
      profilesLegacyOnly: all.filter(isLegacyOnly).length,
      mintedPreFlip: sum((p) => p.preFlip),
      mintedPostFlip: sum((p) => p.postFlip),
      undated: sum((p) => p.undated),
      rpIds,
    },
    dependency: {
      rpIdInUse: NATIVE_RP_ID,
      credentialsBoundToLegacyDomain: rpIds[IMPLICIT_RP_ID] || 0,
      credentialsNativeToHeatwayve: native,
      note:
        `Ceremonies verify against rpId "${NATIVE_RP_ID}" only. A credential bound to ` +
        `"${IMPLICIT_RP_ID}" stays on file and cannot complete a ceremony, so its holder ` +
        `counts as having no usable passkey until they set up a new one.`,
    },
    profiles,
  };
}

// Reports which profiles' photos a wipe WOULD target. No delete authority.
// One bucket, alreadyOpen: no usable credential (keyless-only, legacy-only,
// unreadable or no credential document), so the name is claimable today.
// legacyOnly counts the legacy-only profiles among them.

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
          prefix: photosPrefix(n),
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
  // A credential document exists but nothing in it can complete a ceremony.
  // hasUsablePasskey reports these profiles as having no passkey.
  const alreadyOpenNames = entries
    .filter(([, p]) => !(p.usable > 0))
    .map(([n]) => n);
  const legacyOnly = new Set(entries.filter(([, p]) => isLegacyOnly(p)).map(([n]) => n));
  // Photos under a profile with no credential document at all.
  const known = new Set(entries.map(([n]) => n));
  const noCredentials = Object.keys(byProfile).filter((n) => !known.has(n));

  const totals = {
    profilesWithPhotos: Object.keys(byProfile).length,
    photos: Object.values(byProfile).reduce((n, e) => n + e.photos, 0),
    bytes: Object.values(byProfile).reduce((n, e) => n + e.bytes, 0),
  };
  const alreadyOpen = bucket([...alreadyOpenNames, ...noCredentials]);
  return {
    dryRun: true,
    deletes: "none — this reports a proposed kill list and nothing else",
    scope: "forge/profiles/<profile>/photos/ — prefix-scoped, per profile",
    totals,
    alreadyOpen: { ...alreadyOpen, legacyOnly: alreadyOpen.rows.filter((r) => legacyOnly.has(r.profile)).length },
  };
}

// Profiles holding cloud data (a sync blob or a live account row) with no
// credential that can complete a ceremony, from the Blob doc or the Neon
// index. Split by whether any credential record exists. Counts only.

/**
 * @param {ReturnType<typeof censusPasskeys>} census
 * @param {{
 *   syncKeys?: Iterable<string>,
 *   accounts?: Array<{ id: string, storageKey: string }> | null,
 *   indexCredentials?: Array<{ accountId: string, rpId?: string, keyed?: boolean }> | null,
 * }} [cloud] accounts/indexCredentials null: no database to read
 */
export function cloudExposure(census, { syncKeys = [], accounts = null, indexCredentials = null } = {}) {
  const db = Array.isArray(accounts) && Array.isArray(indexCredentials);
  const syncSet = new Set(syncKeys);
  const accountKeys = new Set((accounts || []).map((a) => a.storageKey));
  const keyOf = new Map((accounts || []).map((a) => [a.id, a.storageKey]));

  /** @type {Map<string, { rows: number, usable: number }>} */
  const index = new Map();
  for (const r of indexCredentials || []) {
    const sk = keyOf.get(r.accountId);
    if (sk == null) continue;
    const e = index.get(sk) || { rows: 0, usable: 0 };
    e.rows++;
    if (r.keyed && rpIdOf(r) === NATIVE_RP_ID) e.usable++;
    index.set(sk, e);
  }

  const docs = census?.profiles || {};
  const cloud = new Set([...syncSet, ...accountKeys]);
  let noUsable = 0;
  let noRecord = 0;
  for (const sk of cloud) {
    const doc = docs[sk];
    const idx = index.get(sk);
    if ((doc?.usable || 0) + (idx?.usable || 0) > 0) continue;
    noUsable++;
    // A doc on file counts as a record even when it would not read.
    if (!doc && !((idx?.rows || 0) > 0)) noRecord++;
  }
  return {
    db,
    profilesWithCloudData: cloud.size,
    withSyncBlob: syncSet.size,
    withAccountRow: accountKeys.size,
    noUsableCredential: noUsable,
    noUsableWithRecord: noUsable - noRecord,
    noUsableNoRecord: noRecord,
  };
}

// One greppable line of AGGREGATES per run — a cheap time series of passkey
// coverage. Never names: the detailed report stays behind the gated response.
export function censusLogLine(census, photoExposure = null, cloud = null) {
  const t = census?.totals || {};
  const d = census?.dependency || {};
  const p = photoExposure || {};
  const c = cloud || {};
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
    ["noUsable", t.profilesWithNoUsableCredential],
    ["legacyOnly", t.profilesLegacyOnly],
    ["alreadyOpen", p.alreadyOpen?.profiles],
    ["cloud", c.profilesWithCloudData],
    ["cloudNoUsable", c.noUsableCredential],
    ["cloudWithRecord", c.noUsableWithRecord],
    ["cloudNoRecord", c.noUsableNoRecord],
    ["db", c.db ? 1 : 0],
  ];
  return `[forge:passkey-census] ${fields.map(([k, v]) => `${k}=${v ?? 0}`).join(" ")}`;
}
