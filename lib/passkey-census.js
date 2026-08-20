// @ts-check
// lib/passkey-census.js
// ─────────────────────────────────────────────────────────────────────────────
// Wipe-protocol step 2 for the passkey store: enumerate what actually lives
// under forge/profiles/*/credentials TODAY, rather than reciting what the code
// should have written. Pure — the route hands it blobs it already read, so
// every branch is testable without a network or a store.
//
// It exists because "legacy passkey" names TWO different populations and they
// need separate counts:
//
//   1. KEYLESS legacy — written by the pre-verification code, carrying an id
//      and a raw attestation but no usable publicKey. hasRealPasskey ignores
//      them (lib/auth-server.js), so their owners read as unprotected and heal
//      on re-registration. Inert, but they still occupy the document.
//
//   2. rpId legacy — EVERY credential, including ones minted this morning, is
//      scoped to rpId "theforged.fit"; nothing in the stored shape says so
//      because nothing ever wrote an rpId field. That is the load-bearing
//      count: a credential's rpId is fixed at creation and cannot be migrated
//      server-side, so this number is a re-enrolment backlog, not a data fix.
//
// NEVER emits credential ids, public keys or transports. The census answers
// "how many, of what kind, how old" — the identifying material is exactly what
// a census does not need.
// ─────────────────────────────────────────────────────────────────────────────

import { FLIP_DATE, LEGACY_RP_ID, NATIVE_RP_ID, daysUntilPasskeySunset } from "./origin.js";

// What an unlabelled credential IS. Every ceremony declares this rpId
// (lib/auth-server.js rpConfigFromRequest), so a stored credential carrying no
// rpId field is a theforged.fit credential — not an unknown one.
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

  // One document per profile is authoritative: readJsonByPrefix picks the
  // NEWEST by uploadedAt, so the census must read the same one the auth
  // routes would. Older siblings are counted as strays and never tallied —
  // tallying them would double-count credentials that no ceremony can see.
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
    // Mirrors hasRealPasskey: a profile is protected only by a credential a
    // signature can actually be checked against.
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
    // Stated as a finding rather than left for the reader to derive: this is
    // the number the census exists to produce.
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

// ─── Photo exposure ──────────────────────────────────────────────────────────
// Wipe-protocol step 1: report what a wipe WOULD remove, and remove nothing.
//
// The hazard, stated plainly (boss ruling, 2026-08-18): when the legacy rpId
// retires, a profile whose only passkey was legacy can no longer be proved by
// anyone, so the next person to register the name takes it. Training history
// can be squatted on. Progress photos cannot — handing a stranger someone
// else's body is the one outcome that has to be impossible.
//
// This produces the kill list and nothing else. It has no delete authority, is
// not reachable from a scheduler, and the route that calls it imports no
// writer. Whatever executes this later must be a separate, explicitly enabled
// path that the boss arms after reading the numbers below.
//
// It reports TWO buckets, deliberately not merged:
//   · atSunset      — legacy-only profiles that hold a verifiable passkey now
//                     and lose it on the sunset date.
//   · alreadyOpen   — profiles with NO verifiable credential at all. These are
//                     claimable TODAY, not at the sunset; their photos are a
//                     pre-existing exposure and a different decision.

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

// ─── The log line ────────────────────────────────────────────────────────────
// One greppable line of AGGREGATES, emitted on every census run. There is no
// usage dashboard and it is far too early to want one, so a daily line in the
// runtime log is the cheapest possible time series: migration progress
// (legacy → native) and rough scale, readable by eye or by grep.
//
// AGGREGATES ONLY. Profile name IS the identity in this app, so the detailed
// report stays behind the authenticated response where one person reads it —
// it never goes to a log that is retained, searched and shown in dashboards.
// tests/passkey-census.test.js asserts no name reaches this string.
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
