// @ts-check
// lib/identity-backfill.js
// ─────────────────────────────────────────────────────────────────────────────
// Identity backfill PLANNER. Pure: no I/O, no db, no blob. The dry-run and
// apply routes gather plain data and hand it here; both get the same plan.
//
// It only ever enumerates rows to CREATE (insert-or-skip). It never plans a
// delete, an update or an overwrite: a row that already exists is `present`,
// a row that would collide is a `conflict`, and any conflict blocks apply.
//
// Rules P1–P13 are in the identity-core spec (Drive); each one is a case in
// tests/identity-backfill.test.js.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import { LEGACY_RP_ID } from "./origin.js";
import { normaliseProfile } from "./profile-name.js";

const PROFILES_PREFIX = "forge/profiles/";
const ACCOUNT_ID_SHAPE = /^hwa_[a-z2-7]{26}$/;
const CREDENTIALS_FILE = /^credentials[^/]*\.json$/;
const ORPHAN_SOURCES = /** @type {const} */ (["auth_tokens", "oauth_grants", "oauth_codes"]);
const DATA_SOURCES = /** @type {const} */ (["sessions", "meta", "photos"]);

const sha256b64u = (/** @type {string} */ s) => createHash("sha256").update(s).digest("base64url");
const decode = (/** @type {string} */ s) => { try { return decodeURIComponent(s); } catch { return s; } };
const isoOrNull = (/** @type {unknown} */ v) =>
  typeof v === "string" && v && !Number.isNaN(Date.parse(v)) ? v : null;
const byString = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);

/** Same rule as credentialRpId (lib/auth-server.js), copied so this module
 *  stays free of auth-server's db import. Absent means legacy, not unknown. */
export const backfillRpId = (/** @type {any} */ c) =>
  typeof c?.rpId === "string" && c.rpId ? c.rpId : LEGACY_RP_ID;

/** Today's WebAuthn user.id for a name (register-options). */
export const legacyHandleFor = (/** @type {string} */ storageKey) => sha256b64u(storageKey);

/**
 * @typedef {object} BackfillInput
 * @property {{ pathname: string, uploadedAt?: string, size?: number }[]} [blobs]
 * @property {Record<string, { pathname?: string, uploadedAt?: string, doc: any }>} [credentialDocs]  keyed by decoded dir
 * @property {Partial<Record<"sessions"|"meta"|"photos"|"auth_tokens"|"oauth_grants"|"oauth_codes", string[]>>} [dbNames]
 * @property {Record<string, string>} [displayNames]
 * @property {{ accounts?: { id: string, storage_key: string }[], handles?: { handle: string, account_id: string }[], credentials?: { id: string, account_id: string }[] }} [existing]
 * @property {string} now  ISO
 * @property {string[]} [exclude]  owner-named test profiles (normalised keys)
 */

// Throwaway profiles from the nightly sync self-test (app/api/cron/
// sync-selftest — the same pattern its cleanup is locked to). Leftovers from
// runs before its cleanup was fixed are junk, not people: never accounts.
export const SELFTEST_KEY_RE = /^selftest-\d{13}-[a-z0-9]{1,6}$/;

/**
 * Full plan, including the rows apply inserts. Server-side only: `writes`
 * carries full credential ids and public keys. Never return it from a route.
 * @param {BackfillInput} input
 */
export function buildIdentityBackfill(input) {
  const { blobs = [], credentialDocs = {}, dbNames = {}, displayNames = {}, existing = {}, now, exclude = [] } = input || /** @type {any} */ ({});
  // Keys the owner has named as their own test profiles: left exactly where
  // they are, just never made into accounts.
  const excluded = new Set(exclude);

  /** @type {{ key: string, reason: string, [k: string]: any }[]} */
  const conflicts = [];
  /** @type {{ key: string, reason: string }[]} */
  const anomalies = [];
  const skipped = {
    retiredPhotoKeys: 0,
    /** @type {{ key: string, sources: string[] }[]} */
    orphanReferences: [],
    /** @type {{ storageKey: string, idPrefix: string }[]} */
    keyless: [],
    selftestKeys: 0,
    excludedKeys: 0,
  };
  const excludedSeen = new Set();
  const selftestSeen = new Set();

  // ── P1/P2: data-bearing keys ────────────────────────────────────────────────
  /** @type {Map<string, { earliest: number, credentialBlobs: number }>} */
  const dirs = new Map();
  for (const b of blobs) {
    const path = String(b?.pathname || "");
    if (!path.startsWith(PROFILES_PREFIX)) continue;
    const rest = path.slice(PROFILES_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) {
      anomalies.push({ key: path, reason: "blob outside a profile directory" });
      continue;
    }
    const dir = decode(rest.slice(0, slash));
    const file = rest.slice(slash + 1);
    const d = dirs.get(dir) || { earliest: Infinity, credentialBlobs: 0 };
    const t = Date.parse(b.uploadedAt || "");
    if (!Number.isNaN(t) && t < d.earliest) d.earliest = t;
    if (CREDENTIALS_FILE.test(file)) d.credentialBlobs++;
    dirs.set(dir, d);
  }

  /** @type {Map<string, Set<string>>} key → sources */
  const sourcesOf = new Map();
  const note = (/** @type {string} */ key, /** @type {string} */ source) => {
    if (typeof key !== "string" || !key) return;
    if (excluded.has(key)) { excludedSeen.add(key); skipped.excludedKeys = excludedSeen.size; return; }
    if (SELFTEST_KEY_RE.test(key)) { selftestSeen.add(key); skipped.selftestKeys = selftestSeen.size; return; }
    if (key.includes("/")) {
      if (key.includes("/retired/")) { if (source === "photos") skipped.retiredPhotoKeys++; }
      else anomalies.push({ key, reason: `contains "/" (${source})` });
      return;
    }
    if (!sourcesOf.has(key)) sourcesOf.set(key, new Set());
    sourcesOf.get(key).add(source);
  };
  for (const dir of dirs.keys()) note(dir, "blob");
  for (const src of [...DATA_SOURCES, ...ORPHAN_SOURCES]) {
    for (const key of new Set(dbNames[src] || [])) note(key, src);
  }

  const dataKeys = [];
  for (const [key, srcs] of sourcesOf) {
    const dataBearing = srcs.has("blob") || DATA_SOURCES.some((s) => srcs.has(s));
    if (dataBearing) dataKeys.push(key);
    else skipped.orphanReferences.push({ key, sources: ORPHAN_SOURCES.filter((s) => srcs.has(s)) }); // P3
  }
  dataKeys.sort(byString);

  // ── existing state (P11) ────────────────────────────────────────────────────
  /** @type {Map<string, string>} storage key → account id */
  const accountBySk = new Map((existing.accounts || []).map((a) => [a.storage_key, a.id]));
  /** @type {Map<string, string>} live handle → account id */
  const handleOwner = new Map((existing.handles || []).map((h) => [h.handle, h.account_id]));
  /** @type {Map<string, string>} credential id → account id */
  const credentialOwner = new Map((existing.credentials || []).map((c) => [c.id, c.account_id]));
  /** @type {Map<string, string>} account id → storage key */
  const skByAccount = new Map((existing.accounts || []).map((a) => [a.id, a.storage_key]));

  // ── P4/P5/P8/P9: per-key candidates ────────────────────────────────────────
  const candidates = [];
  /** @type {Map<string, string[]>} credential id → storage keys holding it (P10) */
  const credentialHolders = new Map();
  for (const key of dataKeys) {
    if (key !== normaliseProfile(key)) { conflicts.push({ key, reason: "non-canonical" }); continue; }
    if (ACCOUNT_ID_SHAPE.test(key)) { conflicts.push({ key, reason: "collides with account-id shape" }); continue; }

    const srcs = sourcesOf.get(key);
    const dir = dirs.get(key);
    const entry = credentialDocs[key];
    let doc = entry ? entry.doc : undefined;
    if (dir?.credentialBlobs && (doc === null || doc === undefined)) {
      conflicts.push({ key, reason: "credentials unreadable" }); // P9
      doc = undefined;
    } else if (doc != null && (typeof doc !== "object" || !Array.isArray(doc.credentials))) {
      conflicts.push({ key, reason: "credentials unreadable" });
      doc = undefined;
    }

    // P6
    const c = doc?.consent;
    const consent = c && typeof c === "object" && typeof c.version === "string" && typeof c.at === "string"
      ? { version: c.version, at: c.at } : null;
    const otherDocKeys = doc ? Object.keys(doc).filter((k) => k !== "credentials" && k !== "consent").sort(byString) : [];

    // P7
    let claimedAt;
    let claimedAtFromNow = false;
    if (dir && Number.isFinite(dir.earliest)) claimedAt = new Date(dir.earliest).toISOString();
    else {
      claimedAt = now;
      claimedAtFromNow = true;
      anomalies.push({ key, reason: dir ? "blob directory has no dated blob" : "db-only (no claim marker)" });
    }
    const display = typeof displayNames[key] === "string" && displayNames[key] ? displayNames[key] : key;

    // P8
    const creds = [];
    const seenInDoc = new Set();
    for (const raw of doc?.credentials || []) {
      const hasKey = typeof raw?.publicKey === "string" && raw.publicKey.length > 0;
      const id = typeof raw?.id === "string" ? raw.id : "";
      if (!hasKey) { skipped.keyless.push({ storageKey: key, idPrefix: id.slice(0, 8) }); continue; }
      if (!id) { conflicts.push({ key, reason: "keyed credential without id" }); continue; }
      if (seenInDoc.has(id)) { conflicts.push({ key, reason: "duplicate credential id in doc", idPrefix: id.slice(0, 8) }); continue; }
      seenInDoc.add(id);
      creds.push({
        id,
        storageKey: key,
        publicKey: raw.publicKey,
        counter: raw.counter || 0,
        transports: Array.isArray(raw.transports) ? raw.transports : [],
        rpId: backfillRpId(raw),
        rpIdInferred: !raw.rpId,
        createdAt: isoOrNull(raw.createdAt),
        userHandle: legacyHandleFor(key),
      });
      credentialHolders.set(id, [...(credentialHolders.get(id) || []), key]);
    }

    candidates.push({
      key,
      account: {
        storageKey: key, origin: "backfill", roles: ["lifter"], plan: "free", consent, otherDocKeys,
        evidence: {
          blobDir: srcs.has("blob"), sessions: srcs.has("sessions"), meta: srcs.has("meta"), photos: srcs.has("photos"),
          tokens: srcs.has("auth_tokens"), grants: srcs.has("oauth_grants"), codes: srcs.has("oauth_codes"),
        },
      },
      handle: { handle: key, storageKey: key, display, kind: "primary", claimedAt, claimedAtFromNow },
      creds,
    });
  }

  // P10: the same id under two directories plans on neither.
  for (const [id, holders] of credentialHolders) {
    if (holders.length < 2) continue;
    for (const key of new Set(holders)) conflicts.push({ key, reason: "credential id under two directories", idPrefix: id.slice(0, 8) });
  }

  // ── P11: status against existing ────────────────────────────────────────────
  const accounts = [];
  const handles = [];
  const credentials = [];
  for (const { key, account, handle, creds } of candidates) {
    const ownId = accountBySk.get(key);
    accounts.push({ ...account, status: ownId ? "present" : "create" });

    const holder = handleOwner.get(key);
    let hStatus = "create";
    if (holder !== undefined) {
      if (ownId && holder === ownId) hStatus = "present";
      else {
        hStatus = "conflict";
        conflicts.push({ key, reason: "live handle on another account", heldBy: skByAccount.get(holder) ?? null });
      }
    }
    handles.push({ ...handle, status: hStatus });

    for (const cr of creds) {
      if (credentialHolders.get(cr.id).length > 1) continue;
      const owner = credentialOwner.get(cr.id);
      let cStatus = "create";
      if (owner !== undefined) {
        if (ownId && owner === ownId) cStatus = "present";
        else {
          cStatus = "conflict";
          conflicts.push({ key, reason: "credential on another account", idPrefix: cr.id.slice(0, 8) });
        }
      }
      credentials.push({ ...cr, status: cStatus });
    }
  }

  // ── P12: deterministic order and hash ──────────────────────────────────────
  credentials.sort((a, b) => byString(a.storageKey, b.storageKey) || byString(a.id, b.id));
  const byKeyReason = (a, b) => byString(a.key, b.key) || byString(a.reason, b.reason) || byString(a.idPrefix || "", b.idPrefix || "");
  conflicts.sort(byKeyReason);
  anomalies.sort(byKeyReason);
  skipped.orphanReferences.sort((a, b) => byString(a.key, b.key));
  skipped.keyless.sort((a, b) => byString(a.storageKey, b.storageKey) || byString(a.idPrefix, b.idPrefix));

  const strip = (/** @type {any} */ { status: _s, claimedAtFromNow: _n, ...row }) => row;
  const writes = {
    accounts: accounts.filter((r) => r.status === "create").map(strip),
    handles: handles.filter((r) => r.status === "create").map(strip),
    credentials: credentials.filter((r) => r.status === "create").map(strip),
  };
  // A db-only handle's claimedAt is `now`, which differs between the dry-run
  // and apply; it is hashed as the literal "now" so the confirm can match.
  const hashed = {
    ...writes,
    handles: handles.filter((r) => r.status === "create")
      .map((r) => ({ ...strip(r), claimedAt: r.claimedAtFromNow ? "now" : r.claimedAt })),
  };
  const planHash = createHash("sha256").update(JSON.stringify(hashed)).digest("hex");

  const tally = (rows) => ({
    create: rows.filter((r) => r.status === "create").length,
    present: rows.filter((r) => r.status === "present").length,
    conflict: rows.filter((r) => r.status === "conflict").length,
  });

  // ── P13: the report carries no public key and no full credential id ────────
  const plan = {
    now,
    counts: { accounts: tally(accounts), handles: tally(handles), credentials: tally(credentials) },
    accounts,
    handles: handles.map(({ claimedAtFromNow: _n, ...h }) => h),
    credentials: credentials.map((c) => ({
      idPrefix: c.id.slice(0, 8), storageKey: c.storageKey, rpId: c.rpId, rpIdInferred: c.rpIdInferred,
      counter: c.counter, createdAt: c.createdAt, transports: c.transports, status: c.status,
    })),
    conflicts,
    anomalies,
    skipped,
    planHash,
  };
  return { plan, writes };
}

/**
 * The report: safe to return from the dry-run route and to log in aggregate.
 * @param {BackfillInput} input
 */
export function planIdentityBackfill(input) {
  return buildIdentityBackfill(input).plan;
}
