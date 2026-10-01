// @ts-check
// lib/identity-backfill-inputs.js
// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY input gathering for the identity backfill, shared by the dry-run
// routes and apply so all three plan from identical inputs:
//   · blob listing of forge/profiles/ (fully paginated, enumeration only);
//   · the newest credentials*.json per decoded directory, read directly;
//   · DISTINCT profile from the data and token tables, displayName from meta;
//   · the three identity tables as they stand.
// Reads, list and SELECTs only. Imports no writer; asserted by
// tests/identity-backfill-routes.test.js.
//
// Also the admin ceremony gate for the owner's /diag-sync view and apply:
// a full-scope (unscoped) passkey ceremony token belonging to ADMIN_PROFILE.
// ─────────────────────────────────────────────────────────────────────────────

import { normaliseProfile } from "./profile-name.js";
import { NextResponse } from "next/server";
import { list } from "@vercel/blob";
import { readJsonDirect } from "./blob-utils.js";
import { sql, ensureSchema } from "./db.js";
import { readTokenData, isTokenValid, isAdminProfile } from "./auth-server.js";

const PREFIX = "forge/profiles/";
const decode = (/** @type {string} */ s) => { try { return decodeURIComponent(s); } catch { return s; } };

/**
 * @param {string} now ISO
 * @returns {Promise<{ db: boolean, input: import("./identity-backfill.js").BackfillInput }>}
 */
export async function gatherBackfillInputs(now) {
  /** @type {{ pathname: string, uploadedAt: string, size: number }[]} */
  const blobs = [];
  /** @type {Map<string, { pathname: string, uploadedAt: string, t: number }>} */
  const newestCred = new Map();
  let cursor;
  do {
    const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
    for (const b of page.blobs) {
      const uploadedAt = b.uploadedAt ? new Date(b.uploadedAt).toISOString() : "";
      blobs.push({ pathname: b.pathname, uploadedAt, size: b.size || 0 });
      const m = b.pathname.match(/^forge\/profiles\/([^/]+)\/credentials[^/]*\.json$/);
      if (m) {
        const dir = decode(m[1]);
        const t = Date.parse(uploadedAt) || 0;
        const cur = newestCred.get(dir);
        if (!cur || t >= cur.t) newestCred.set(dir, { pathname: b.pathname, uploadedAt, t });
      }
    }
    cursor = page.cursor;
  } while (cursor);

  /** @type {Record<string, { pathname: string, uploadedAt: string, doc: any }>} */
  const credentialDocs = {};
  for (const [dir, f] of newestCred) {
    credentialDocs[dir] = { pathname: f.pathname, uploadedAt: f.uploadedAt, doc: await readJsonDirect(f.pathname) };
  }

  const q = sql();
  if (!q) return { db: false, input: { blobs, credentialDocs, dbNames: {}, displayNames: {}, existing: {}, now, exclude: backfillExclusions() } };
  await ensureSchema(q);

  const names = (/** @type {any[]} */ rows) => rows.map((r) => r.profile).filter((p) => typeof p === "string" && p);
  const dbNames = {
    sessions: names(await q`SELECT DISTINCT profile FROM sessions`),
    meta: names(await q`SELECT DISTINCT profile FROM meta`),
    photos: names(await q`SELECT DISTINCT profile FROM photos`),
    auth_tokens: names(await q`SELECT DISTINCT profile FROM auth_tokens`),
    oauth_grants: names(await q`SELECT DISTINCT profile FROM oauth_grants`),
    oauth_codes: names(await q`SELECT DISTINCT profile FROM oauth_codes`),
  };
  /** @type {Record<string, string>} */
  const displayNames = {};
  for (const r of await q`SELECT profile, value FROM meta WHERE field = 'displayName'`) {
    if (typeof r.value === "string" && r.value) displayNames[r.profile] = r.value;
  }
  const existing = {
    accounts: /** @type {any[]} */ (await q`SELECT id, storage_key FROM accounts`),
    handles: /** @type {any[]} */ (await q`SELECT handle, account_id FROM handles WHERE released_at IS NULL`),
    credentials: /** @type {any[]} */ (await q`SELECT id, account_id FROM credentials`),
  };
  return { db: true, input: { blobs, credentialDocs, dbNames, displayNames, existing, now, exclude: backfillExclusions() } };
}

/** Owner-named test profiles to leave out (env, comma-separated; kept out of
 *  the public repo). Normalised like every key. */
export function backfillExclusions(raw = process.env.IDENTITY_BACKFILL_EXCLUDE) {
  return String(raw || "").split(",").map((n) => normaliseProfile(n)).filter(Boolean);
}

/** Aggregates only — no names, no ids. @param {any} plan @param {string} [extra] */
export function backfillLogLine(plan, extra = "") {
  const c = plan.counts;
  // Counts are rows to CREATE; `present` is accounts/handles/credentials already there.
  return `[forge:identity-backfill] accounts=${c.accounts.create} handles=${c.handles.create}` +
    ` credentials=${c.credentials.create} conflicts=${plan.conflicts.length}` +
    ` orphans=${plan.skipped.orphanReferences.length} anomalies=${plan.anomalies.length}` +
    ` present=${c.accounts.present}/${c.handles.present}/${c.credentials.present} hash=${plan.planHash}${extra}`;
}

export const BACKFILL_FRESH_MS = 5 * 60 * 1000;

/**
 * The owner gate: a full-scope passkey ceremony token (X-HW-Auth) held by
 * ADMIN_PROFILE. Fails closed when ADMIN_PROFILE is unset, in every
 * environment. With `freshMs`, the ceremony itself (authAt) must be that
 * recent — apply uses this; the read view does not.
 * @param {Request} request
 * @param {{ freshMs?: number | null }} [opts]
 * @returns {Promise<{ error: Response } | { profile: string }>}
 */
export async function requireAdminCeremony(request, { freshMs = null } = {}) {
  const token = request.headers.get("x-hw-auth") || null;
  const data = token ? await readTokenData(token) : null;
  const now = Date.now();
  const fresh = freshMs == null || (typeof data?.authAt === "string" && now - Date.parse(data.authAt) <= freshMs);
  if (!data || !isTokenValid(data, data.profile, now) || data.scope || !fresh) {
    return { error: NextResponse.json({ error: "Fresh passkey authentication required", requiresAuth: true }, { status: 401 }) };
  }
  if (!process.env.ADMIN_PROFILE || !isAdminProfile(data.profile)) {
    return { error: NextResponse.json({ error: "Admin only" }, { status: 403 }) };
  }
  return { profile: data.profile };
}
