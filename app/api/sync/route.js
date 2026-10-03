import { put, list, del, get } from "@vercel/blob";
import { rateLimit } from "@/lib/rate-limit";
import { mergeMeta, mergeHistories, mergeMetaFields, fieldClosure } from "@/lib/sync-merge";
import { hasRealPasskey, readTokenData, resolveTokenIdentity, mintAuthToken } from "@/lib/auth-server";
import { hasDb, dbReadProfile, dbUpsertProfile, dbDeleteProfile, dbDeleteToken, dbReadProfileSince, dbReadMetaFields, dbCursorNow, dbListPhotos } from "@/lib/db";
import { NextResponse } from "next/server";
import { serverError as apiError } from "@/lib/api-errors";
import { normaliseProfile } from "@/lib/profile-name";
import { metaPath, historyPath, profileDir, photosPrefix, snapshotPaths } from "@/lib/storage-keys";
import { dbResolveHandle, dbAccountByStorageKey, dbClaimHandle, dbCloseAccount, CLAIM_MODE } from "@/lib/identity-store";
import { countIndexedCredentials, readCredentialSet } from "@/lib/credential-store";
import { IDENTITY_BLOB_FALLBACK, RESERVED_HANDLE_RE } from "@/lib/identity";

// Run beside Neon and Blob (London); see tests/regions.test.js.
export const preferredRegion = "lhr1";

// Generic client error + full server-side log. Raw exception text (Neon/blob
// driver detail, query fragments, schema names) must not reach the client —
// audit 2026-07-26, P3 info-disclosure. Detail stays in the server log.

const serverError = (e, opts = {}) => apiError(e, { label: "sync", ...opts });

// Blob layout, under the account's storage key (the normalised name for
// name-keyed accounts, the account id for id-keyed ones; display name lives in meta):
//   forge/profiles/{storageKey}/meta.json    — weights, reps, streak, programmeBlock, displayName
//   forge/profiles/{storageKey}/history.json — full session history (append-only)
//
// Store access: PRIVATE.
// Requires @vercel/blob@^2 (adds private-store support + get() for auth'd reads).
//
// PATH SCHEME: deterministic, and it must stay that way. Writes overwrite in
// place; never introduce randomised pathnames here. A write the reader cannot
// find back is silent — both sides return success and the data is simply gone.

// NFKC before lowercasing (deep audit 2026-07-26). Without canonicalisation,
// codepoints that lowercase to the same letter (e.g. the Kelvin sign U+212A →
// "k") collapse onto one path while visually identical composed/decomposed
// forms (café NFC vs NFD) resolve to DIFFERENT profiles — a squatting and
// impersonation surface on a namespace where the NAME is the identity.
const normalise = normaliseProfile;
// Blob paths come from lib/storage-keys, fed the storage key: the gate's
// resolved one for gated requests (the wipe included), the normalised name
// for name lookups (availability). profileDir's trailing slash is
// load-bearing: list() is a prefix match.

// Identifies legacy addRandomSuffix blobs from the broken era — pathnames of
// the form `…/meta-XXXX.json` and `…/history-XXXX.json`. Used for one-shot
// migration on read (fall back to latest suffixed blob if deterministic path
// is empty) and for cleanup on write (delete obsolete suffixed blobs once the
// new deterministic blob has been written).
const LEGACY_META_RE    = /\/meta-[^/]+\.json$/;
const LEGACY_HISTORY_RE = /\/history-[^/]+\.json$/;

// The files a profile wipe deletes from the account's folder, matched against
// the pathname after the folder (so anchored to it). Enumerated, never "all":
// photos go by their index rows, and anything unrecognised is kept.
const WIPE_FILE_RES = [
  /^meta\.json$/,
  /^history\.json$/,
  /^meta-[^/]+\.json$/,
  /^history-[^/]+\.json$/,
  /^credentials[^/]*\.json$/,
];

// ─── Input validation ─────────────────────────────────────────────────────
// Profile name validation is the single highest-leverage guard on this API.
// Without it: bad actors could POST 10MB profile names, write unicode that
// breaks blob path semantics, or sneak control chars through encodeURIComponent.
// With it: rejected cleanly with a 400 before any blob operation runs.
//
// Rules:
//   - 1-32 chars after trimming (32 is the soft limit shown in the UI;
//     we permit a slight buffer for emoji/multi-byte but cap hard at 64)
//   - Trimmed length > 0
//   - No control characters (rejects null bytes, line endings, etc)
//   - No path separators (defence-in-depth on top of encodeURIComponent)
//
// Returns { ok: true, normalised, displayName } on success, { ok: false, reason }
// otherwise. Caller wraps the reason in a NextResponse.json with 400 status.
const PROFILE_MAX_LEN = 64;     // hard ceiling — UI suggests 32
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;
const PATH_SEPS_RE     = /[/\\]/;
const DOTS_ONLY_RE     = /^\.+$/;

function validateProfile(rawName) {
  if (typeof rawName !== "string") {
    return { ok: false, reason: "Profile must be a string" };
  }
  const trimmed = rawName.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "Profile is empty" };
  }
  if (trimmed.length > PROFILE_MAX_LEN) {
    return { ok: false, reason: `Profile too long (max ${PROFILE_MAX_LEN} chars)` };
  }
  if (CONTROL_CHARS_RE.test(trimmed)) {
    return { ok: false, reason: "Profile contains control characters" };
  }
  // Paths are built from the normalised key, so the path rules below test the
  // key, not the input: NFKC folds e.g. U+2025 to ".." and U+FF0F to "/".
  const key = normalise(trimmed);
  if (!key) {
    return { ok: false, reason: "Profile is empty" };
  }
  if (PATH_SEPS_RE.test(trimmed) || PATH_SEPS_RE.test(key)) {
    return { ok: false, reason: "Profile contains path separators" };
  }
  // Dot-only names ("." / ".." / "...") — defence in depth. encodeURIComponent
  // leaves dots untouched, so such a name reaches the store as a relative path
  // segment. Whether the platform collapses it is a property of someone else's
  // code that could change without notice; the wipe gate's traversal (fixed in
  // #251) is what that assumption cost last time.
  if (DOTS_ONLY_RE.test(key)) {
    return { ok: false, reason: "Profile name cannot be dots" };
  }
  // The key must be a fixed point of normaliseProfile (NFKC runs before
  // lowercasing, so a few base+mark pairs are not): a key that moves on a
  // second pass could collide with another person's key.
  if (normalise(key) !== key) {
    return { ok: false, reason: "Profile contains characters that can't be used" };
  }
  return { ok: true, normalised: key, displayName: trimmed };
}

// Body size guard — reject > 5MB request bodies before parsing. A typical
// session record is ~2KB; 500 sessions ≈ 1MB. 5MB gives plenty of headroom
// while preventing pathological bodies from inflating storage costs.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

async function safeReadJson(request) {
  // Check Content-Length when present — many clients send it, including ours.
  const cl = request.headers.get("content-length");
  if (cl && Number(cl) > MAX_BODY_BYTES) {
    return { ok: false, reason: "Body too large", status: 413 };
  }
  try {
    // Read as TEXT and measure (audit #26): Content-Length is client-
    // asserted and absent on chunked bodies, so the header check above is
    // advisory only — this is the enforceable cap.
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return { ok: false, reason: "Body too large", status: 413 };
    }
    return { ok: true, body: JSON.parse(text) };
  } catch (e) {
    return { ok: false, reason: "Invalid JSON", status: 400 };
  }
}

// ─── The sync gate ──────────────────────────────────────────────────────────
// The contract, matching /api/photos: the token resolves to an account, the
// REQUESTED profile (a handle) must resolve to that same account, and every
// key below is the gate's storage key — no seam between what was authorised
// and what gets used. Keep it that way.
//
// Deliberately pre-identity, and must stay open:
//   · POST (name claim) — the bootstrap; you cannot hold a credential for a
//     profile that does not exist yet. Claiming grants nothing on its own.
//   · GET ?check=1 — availability, needed before a claim exists.
// Neither returns user data.
//
// A profile without a passkey keeps working locally, forever. The app is
// local-first; it simply does not sync. That is the product story, not a
// punishment.
// Sliding window, matching the photo cookie. Because any active day rotates
// it, lengthening this buys a regularly-used device nothing and only extends
// the window on a lost one. Keep the two values consistent.
const SYNC_TTL_MS = 30 * 86400000;
const SYNC_ROTATE_AFTER_MS = 86400000;   // any active day slides it
// ...but the chain is not infinite: rotation stops at 90 days from the
// ORIGINAL ceremony, so a credential used daily forever still comes back to a
// passkey once a quarter. Without a ceiling, one captured cookie renews itself
// for life (deep audit finding against the photo cookie — not repeated here).
const SYNC_ABSOLUTE_CAP_MS = 90 * 86400000;
export const SYNC_COOKIE = "hw_sync";
const SYNC_COOKIE_OPTS = {
  httpOnly: true, secure: true, sameSite: "strict",
  path: "/api/sync", maxAge: 30 * 86400,
};

/** Attach a rotated sync cookie (if the gate minted one) to a success response. */
const withSyncCookie = (res, g) => {
  if (g?.refresh) res.cookies.set(SYNC_COOKIE, g.refresh, SYNC_COOKIE_OPTS);
  return res;
};

/**
 * Resolve and verify the caller for a profile-scoped sync request.
 * Returns { profile: storageKey, identity } on success (plus `refresh` when
 * the cookie slid), or
 * { fail: NextResponse } — never a bare boolean, so a caller cannot mistake
 * a falsy result for permission.
 */
async function syncGate(request, profile) {
  // Header token (fresh ceremony) OR the sliding sync cookie. Optional
  // chaining throughout: the nightly self-test invokes these handlers
  // DIRECTLY with a plain Request, which has no cookie jar.
  const headerToken = request.headers?.get?.("x-hw-auth") || null;
  const cookieToken = request.cookies?.get?.(SYNC_COOKIE)?.value || null;
  const token = headerToken || cookieToken;
  const data = await readTokenData(token);
  // A 401 for a name held by another account too, so a device holding one
  // profile's cookie re-runs the ceremony for the other.
  const identity = await resolveTokenIdentity(data, profile, Date.now());
  if (!identity) {
    return {
      fail: NextResponse.json(
        { error: "Sign in to sync this profile", requiresAuth: true },
        { status: 401 },
      ),
    };
  }
  // Photo-scope tokens are for photos. Accepting one here would let the
  // narrow, long-lived credential read the whole training record.
  if (data.scope && data.scope !== "sync") {
    return {
      fail: NextResponse.json(
        { error: "Sign in to sync this profile", requiresAuth: true },
        { status: 401 },
      ),
    };
  }
  // Sliding rotation — cookie-carried sync tokens only, and never past the
  // absolute ceiling measured from the ORIGINAL ceremony (authAt survives
  // rotation; createdAt does not). Past the cap the cookie simply stops
  // sliding and lapses on its own, so the next visit runs one ceremony.
  let refresh = null;
  if (data.scope === "sync" && token === cookieToken) {
    const age = Date.now() - new Date(data.createdAt || 0).getTime();
    const authAge = Date.now() - new Date(data.authAt || data.createdAt || 0).getTime();
    const withinCap = Number.isFinite(authAge) && authAge < SYNC_ABSOLUTE_CAP_MS;
    if ((!Number.isFinite(age) || age > SYNC_ROTATE_AFTER_MS) && withinCap) {
      refresh = await mintAuthToken({
        identity, ttlMs: SYNC_TTL_MS, scope: "sync",
        authAt: data.authAt || data.createdAt || null,
      });
    }
  }
  return { profile: identity.storageKey, identity, refresh };
}

// Read a private blob's JSON body via the SDK's authenticated get().
// Returns null on not-found / parse error / any other failure.
//
// NOTE: errors are intentionally swallowed for resilience — most failures
// are "blob doesn't exist yet" which is expected, not exceptional. The
// caller can distinguish this from a parse-error case only by examining
// the blob list before calling, which the existing GET/PUT do already.
async function readJson(pathname) {
  try {
    const result = await get(pathname, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    // Consume the ReadableStream into a string
    const reader = result.stream.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    const text = new TextDecoder().decode(buffer);
    return JSON.parse(text);
  } catch (e) {
    // Surface in server logs so operators can diagnose corrupt blobs vs
    // genuine 404s. Stays out of the response body to avoid leaking
    // internal paths to clients.
    if (e?.name !== "BlobNotFoundError") {
      console.error("[forge:readJson]", pathname, e?.message || e);
    }
    return null;
  }
}

// Migration helper: when the deterministic path is empty, fall back to the
// latest legacy suffixed blob for that kind (meta or history). Returns the
// parsed JSON of the latest matching blob or null if none exist.
//
// `kindRe` is LEGACY_META_RE or LEGACY_HISTORY_RE. We rely on the list call
// the caller already made (don't re-list for cost reasons).
async function readLatestLegacy(blobs, kindRe) {
  const matches = blobs.filter(b => kindRe.test(b.pathname));
  if (!matches.length) return null;
  const latest = matches.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())[0];
  return readJson(latest.pathname);
}

// GET /api/sync?profile=Name
// Returns { meta: {...}, history: [...] }
//
// GET /api/sync?profile=Name&check=1
// Returns { exists: boolean } — lightweight availability check for signup.
// Case-insensitive: "Sarah", "sarah", "SARAH" all resolve the same way.
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const profile = searchParams.get("profile");
  const check   = searchParams.get("check") === "1";

  // Two buckets, because these are two different requests wearing one verb.
  // An authenticated hydration GET legitimately fires often (visibility
  // change, reconnect) → 120/min. `check=1` is an UNAUTHENTICATED existence
  // oracle used only while a human types a name at signup — a person needs a
  // handful, an enumerator wants thousands. J1 made this oracle nearly
  // worthless (knowing a name exists now grants no read/write/wipe), and the
  // claim's 409 leaks existence unavoidably, so the goal is not to close it
  // (you cannot) but to make BULK probing expensive. Its own tight bucket
  // does exactly that — invisible to the one person signing up, a 12x
  // throttle on anyone mapping the namespace.
  const [bucket, budget] = check ? ["sync-check", 10] : ["sync-read", 120];
  const limited = rateLimit(request, bucket, budget);
  if (limited) return limited;

  // Profile validation — reject malformed names with 400 before doing any
  // blob work. Returns null body for compatibility with existing client code
  // that branches on status code rather than parsing error messages.
  const v = validateProfile(profile);
  if (!v.ok) {
    return NextResponse.json({ error: v.reason }, { status: 400 });
  }

  try {
    // Availability: a live handle first. While blobsHoldName(), ANY blob
    // under the name's prefix also counts, legacy suffixed ones included, so
    // a name no account row covers is never offered as free.
    if (check) {
      // Reserved names (account-id prefix) can never be claimed: report taken.
      if (RESERVED_HANDLE_RE.test(normalise(profile))) return NextResponse.json({ exists: true });
      const held = await dbResolveHandle(profile);
      if (held) return NextResponse.json({ exists: !(await unfinishedClaim(held)) });
      const { blobs } = blobsHoldName()
        ? await list({ prefix: profileDir(normalise(profile)) })
        : { blobs: [] };
      return NextResponse.json({ exists: blobs.length > 0 });
    }

    // Everything past here returns the PROFILE'S OWN DATA — gated.
    // (check=1 above is deliberately open: it predates any identity and
    // reveals only whether a name is taken, which a claim attempt would
    // reveal anyway.)
    const gate = await syncGate(request, profile);
    if (gate.fail) return gate.fail;

    // ── Delta pull (#2 family) ─────────────────────
    // GET ?since=<cursor> returns only rows whose updated_at is newer,
    // plus a fresh cursor. DB-only by definition: a client holding a
    // cursor hydrated from the DB era. Blob backfill never runs here.
    const since = searchParams.get("since");
    if (since !== null) {
      if (!/^\d{4}-\d{2}-\d{2}T[0-9:.+Z-]+$/.test(since)) {
        return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
      }
      if (!hasDb()) {
        return NextResponse.json({ error: "Delta sync unavailable" }, { status: 503 });
      }
      const delta = await dbReadProfileSince(gate.profile, since);
      return withSyncCookie(NextResponse.json({ delta: true, ...delta }), gate);
    }

    // DB-first: if the profile has rows, serve them. Blob remains the read
    // fallback. A DB failure degrades to the blob path — never a 500 here.
    if (hasDb()) {
      try {
        const fromDb = await dbReadProfile(gate.profile);
        if (fromDb) return withSyncCookie(NextResponse.json(fromDb), gate);
      } catch (e) {
        console.error("[forge:sync GET] db read failed, falling back to blob:", e?.message || e);
      }
    }

    // Fast path: read the deterministic paths in parallel. This is the
    // expected case for any profile written after the addRandomSuffix bug
    // was fixed.
    const [metaDirect, historyDirect] = await Promise.all([
      readJson(metaPath(gate.profile)),
      readJson(historyPath(gate.profile)),
    ]);

    // Both deterministic paths returned data: serve the blob. GET never
    // writes the DB — a profile that only exists in blob migrates on its
    // first PUT, which merges stamp-aware against the DB (see the PUT seed).
    if (metaDirect !== null && historyDirect !== null) {
      return withSyncCookie(NextResponse.json({
        meta: metaDirect,
        history: Array.isArray(historyDirect) ? historyDirect : [],
      }), gate);
    }

    // Slow path: one or both deterministic reads came back empty. Either
    // this profile has never been written under the new scheme (legacy
    // suffixed blobs only), or partially migrated. List once and fall
    // back to the latest legacy blob for whichever side is missing.
    const { blobs } = await list({ prefix: profileDir(gate.profile) });

    // Read-failure guard (audit #13, same class as PUT's #7): a null read
    // for a blob the LIST says exists is a transient failure, not absence.
    // Returning 200+empty here was indistinguishable from a genuinely new
    // profile — the client would then treat real data as gone. 503 lets
    // the client retry instead.
    const existsInList = (path) => blobs.some((b) => b.pathname === path);
    if ((metaDirect === null && existsInList(metaPath(gate.profile))) ||
        (historyDirect === null && existsInList(historyPath(gate.profile)))) {
      return NextResponse.json(
        { error: "Blob present but unreadable — retry" },
        { status: 503 },
      );
    }

    // Profile has never existed at all — preserve the original 404 contract
    // so the client treats this as "blob unavailable" rather than "blob
    // exists but is empty". backgroundSync's branch on `if (!remote)` depends
    // on this to queue a push when local has data that needs hoisting.
    if (!blobs.length && metaDirect === null && historyDirect === null) {
      return NextResponse.json(null, { status: 404 });
    }

    const [metaLegacy, historyLegacy] = await Promise.all([
      metaDirect === null    ? readLatestLegacy(blobs, LEGACY_META_RE)    : Promise.resolve(null),
      historyDirect === null ? readLatestLegacy(blobs, LEGACY_HISTORY_RE) : Promise.resolve(null),
    ]);

    const meta    = metaDirect    ?? metaLegacy;
    const history = historyDirect ?? historyLegacy;

    return withSyncCookie(NextResponse.json({
      meta,
      history: Array.isArray(history) ? history : [],
    }), gate);
  } catch (e) {
    return serverError(e);
  }
}

// PUT /api/sync
// Body: { profile: string, data: { meta?: object, history?: array } }
// Profile is case-insensitive. Display name should be passed inside meta.displayName.
export async function PUT(request) {
  const limited = rateLimit(request, "sync-write", 120);
  if (limited) return limited;
  // Parse the body via the size-guarded reader. Rejects oversize payloads
  // (>5MB) with 413 before any blob work, and malformed JSON with 400.
  const parsed = await safeReadJson(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.reason }, { status: parsed.status });
  }
  const { profile, data } = parsed.body;

  const v = validateProfile(profile);
  if (!v.ok) return NextResponse.json({ error: v.reason }, { status: 400 });

  // Writes are the actively harmful half of J1: an open PUT let anyone
  // overwrite a stranger's bodyweight and streak, and mergeHistories unions
  // rather than replaces, so fabricated sessions could be INJECTED
  // permanently. Gated before a single byte is merged.
  const gate = await syncGate(request, profile);
  if (gate.fail) return gate.fail;

  // ── Delta push (#2 family) ────────────────────────
  // Body: { profile, delta: { meta: { field: value… }, history: [records] } }.
  // Meta fields merge via THE merge, scoped to the closure of what arrived
  // (paired stamp fields travel together — see fieldClosure); records are
  // immutable inserts. DB-only: a delta client hydrated from the DB era.
  if (parsed.body.delta && !data) {
    if (!hasDb()) {
      return NextResponse.json({ error: "Delta sync unavailable" }, { status: 503 });
    }
    const d = parsed.body.delta;
    const incoming = d?.meta && typeof d.meta === "object" && !Array.isArray(d.meta) ? d.meta : {};
    const records = Array.isArray(d?.history) ? d.history.filter((r) => r && typeof r.id === "string" && r.id.length < 64) : [];
    if (!Object.keys(incoming).length && !records.length) {
      return NextResponse.json({ error: "Empty delta" }, { status: 400 });
    }
    try {
      const norm = gate.profile;
      const cursor = await dbCursorNow();
      const closure = fieldClosure(Object.keys(incoming));
      const existing = await dbReadMetaFields(norm, closure);
      const mergedFields = mergeMetaFields(existing, incoming);
      await dbUpsertProfile(norm, { meta: mergedFields, history: records });
      return withSyncCookie(NextResponse.json({ ok: true, delta: true, cursor, meta: { fields: Object.keys(mergedFields).length }, history: { inserted: records.length } }), gate);
    } catch (e) {
      // Refuse silently-dropped deltas: the client keeps its dirty set and
      // retries — same posture as the fat path's 503s.
      return serverError(e, { status: 503, label: "sync-delta" });
    }
  }

  if (!data) return NextResponse.json({ error: "No data" }, { status: 400 });

  // ── Fat PUT, DB era (PR C): DUAL-WRITE RETIRED ────
  // The DB is the store; meta/history blobs are no longer written (the
  // snapshot cron owns blob durability now; the claim blob remains the
  // name marker). Merge base comes from the DB; a profile with no rows yet
  // (unmigrated, dormant since the blob era) seeds its base from the old
  // blobs — read-only, with the #7 unreadable-guard intact.
  if (hasDb()) {
    try {
      const norm = gate.profile;
      const fromDb = await dbReadProfile(norm);
      let baseMeta = fromDb?.meta || null;
      let baseHistory = fromDb?.history || null;
      if (!fromDb) {
        const { blobs } = await list({ prefix: profileDir(gate.profile) });
        const blobExists = (path) => blobs.some((b) => b.pathname === path);
        const meta = await readJson(metaPath(gate.profile));
        if (meta === null && blobExists(metaPath(gate.profile))) {
          return NextResponse.json({ error: "Meta blob unreadable — refusing to overwrite; retry" }, { status: 503 });
        }
        let history = await readJson(historyPath(gate.profile));
        if (history === null && blobExists(historyPath(gate.profile))) {
          return NextResponse.json({ error: "History blob unreadable — refusing to overwrite; retry" }, { status: 503 });
        }
        if (!Array.isArray(history)) history = await readLatestLegacy(blobs, LEGACY_HISTORY_RE);
        baseMeta = meta || {};
        baseHistory = Array.isArray(history) ? history : [];
      }
      const mergedMeta = data.meta ? mergeMeta(baseMeta || {}, data.meta) : null;
      const mergedHistory = Array.isArray(data.history)
        ? mergeHistories(baseHistory || [], data.history)
        : null;
      await dbUpsertProfile(norm, {
        meta: mergedMeta ? { ...mergedMeta, syncedAt: new Date().toISOString() } : {},
        history: mergedHistory || [],
      });
      return withSyncCookie(NextResponse.json({
        ok: true,
        ...(mergedMeta ? { meta: true } : {}),
        ...(mergedHistory ? { history: { count: mergedHistory.length } } : {}),
      }), gate);
    } catch (e) {
      console.error("[forge:put:db]", profile, e?.message || e);
      return serverError(e, { status: 503, label: "sync-write" });
    }
  }

  // ── Legacy blob path — ONLY when no DB is configured (dev fallback) ────
  try {
    const results = {};

    // List once up-front to identify legacy suffixed blobs for cleanup +
    // history-merge fallback. Cheap — single API call, used by everything
    // that follows.
    const { blobs } = await list({ prefix: profileDir(gate.profile) });

    // ── Meta write (merge with remote — audit S3) ───────────────
    // History always merged server-side; meta used to overwrite wholesale,
    // so a device pushing from stale local state DELETED the other
    // device's meta fields. Now the existing blob merges with the incoming
    // payload through THE merge (lib/sync-merge.js — same module the
    // client uses), with the incoming side winning ties: a push means "I
    // just did something". The blob is therefore always a merged superset.
    // Costs one blob read per PUT — colocated, cheap, and the price of
    // never losing a field. NOTE: read-merge-write is not atomic (Vercel
    // Blob has no compare-and-swap); two simultaneous PUTs can still race,
    // but with field stamps the loser's next push converges instead of
    // clobbering — accepted and documented (audit S6).
    // Read-failure guard (audit #7): readJson returns null for BOTH "blob
    // doesn't exist" and "read/parse failed". Only the first may proceed —
    // merging from nothing when the blob EXISTS but couldn't be read would
    // overwrite the other device's fields wholesale. The up-front list tells
    // the two apart: pathname present in the list + null read = failure →
    // 503 so the client's pending-push queue retries later.
    const blobExists = (path) => blobs.some((b) => b.pathname === path);

    if (data.meta) {
      const existingMeta = await readJson(metaPath(gate.profile));
      if (existingMeta === null && blobExists(metaPath(gate.profile))) {
        return NextResponse.json(
          { error: "Meta blob unreadable — refusing to overwrite; retry" },
          { status: 503 },
        );
      }
      const mergedMeta = existingMeta && typeof existingMeta === "object"
        ? mergeMeta(existingMeta, data.meta)
        : data.meta;
      const stamped = { ...mergedMeta, syncedAt: new Date().toISOString() };
      await put(
        metaPath(gate.profile),
        JSON.stringify(stamped),
        { access: "private", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false },
      );
      results.meta = true;
    }

    // ── History write (merge with remote) ───────────────────────
    // Read existing history from deterministic path first; if missing,
    // hoist from the latest legacy suffixed blob (one-time migration for
    // profiles that only have data in the broken-suffix scheme). Merge
    // by record id and write deterministic.
    if (Array.isArray(data.history)) {
      let existing = await readJson(historyPath(gate.profile));
      if (existing === null && blobExists(historyPath(gate.profile))) {
        // Same guard as meta: an unreadable-but-present history blob must not
        // be treated as empty — the union merge would then "merge" from
        // nothing and drop every record this device doesn't hold.
        return NextResponse.json(
          { error: "History blob unreadable — refusing to overwrite; retry" },
          { status: 503 },
        );
      }
      if (!Array.isArray(existing)) {
        existing = await readLatestLegacy(blobs, LEGACY_HISTORY_RE);
      }
      if (!Array.isArray(existing)) existing = [];

      // THE merge (audit #9): the same mergeHistories the client uses —
      // the hand-rolled byId union here was a second implementation that
      // could drift (and lacked mergeHistories' record-shape guards).
      const merged = mergeHistories(existing, data.history);

      await put(
        historyPath(gate.profile),
        JSON.stringify(merged),
        { access: "private", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false },
      );
      results.history = { count: merged.length };
    }

    // Legacy suffixed orphans are NOT cleaned up here (or anywhere): a
    // per-PUT batch del() caused production 500s, and the standalone cleanup
    // cron that replaced it was retired after the 2026-07-09 wipe incident —
    // no standing delete authority (see CLAUDE.md). Orphans are inert:
    // deterministic paths mean nothing reads them. PUT stays small and
    // predictable.

    return withSyncCookie(NextResponse.json({ ok: true, ...results }), gate);
  } catch (e) {
    // Tagged log so the runtime error surface tells us which call exploded
    // next time something goes wrong. Aggregate logs truncate without this.
    console.error("[forge:put:outer]", profile, e?.message || e, e?.stack);
    return serverError(e);
  }
}

// Whether blobs under a name's own prefix make it taken. Always while the
// blob fallback is on, and always without a DB. Also were claims keyed by
// the name (CLAIM_MODE not "claim"): a claim would then adopt that prefix,
// so data no account row covers must keep its name taken.
const blobsHoldName = () => IDENTITY_BLOB_FALLBACK || !hasDb() || CLAIM_MODE !== "claim";

// A claim whose account committed but whose marker put then failed (a Blob
// error) leaves the claimant holding a name their retry would refuse. The
// next claim of the name (normally that retry) finishes it, on the same
// account, as today's blob-only claim would have let it. Only an account that
// never progressed: a claim keyed by its own id (or, from before cutover, by
// its own handle), made within the retry window, with no consent on record,
// nothing under its prefix and no passkey indexed. Anything older or used
// stays taken: the account's webauthn user id and consent must never pass to
// whoever claims next.
const CLAIM_RETRY_WINDOW_MS = 15 * 60 * 1000;
/** @param {{ id: string, origin: string, kind: string, storageKey: string, handle: string, consent?: any, createdAt?: string | null }} held */
async function unfinishedClaim(held) {
  const ownKey = (held.origin === "claim" && held.storageKey === held.id)
    || (held.origin === "precutover_claim" && held.storageKey === held.handle);
  if (!ownKey || held.kind !== "primary") return false;
  if (held.consent != null) return false;
  const age = Date.now() - Date.parse(String(held.createdAt));
  if (!(age >= 0 && age <= CLAIM_RETRY_WINDOW_MS)) return false;
  const { blobs } = await list({ prefix: profileDir(held.storageKey) });
  if (blobs.length > 0) return false;
  return (await countIndexedCredentials(held.id)) === 0;
}

// POST /api/sync — name claim endpoint.
// Creates an account holding the name, plus a minimal meta blob (the claim
// marker) under the account's storage key. Called immediately on profile creation so concurrent devices see the claim.
// Body: { profile: string, displayName: string }
// Returns 409 if the name is already taken.
export async function POST(request) {
  const limited = rateLimit(request, "sync-claim", 20);
  if (limited) return limited;
  const parsed = await safeReadJson(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.reason }, { status: parsed.status });
  }
  const { profile, displayName } = parsed.body;

  const v = validateProfile(profile);
  if (!v.ok) return NextResponse.json({ error: v.reason }, { status: 400 });

  // displayName is what the user entered (preserves case). If they sent it
  // separately, validate it too. If not, use the validated profile.
  let resolvedDisplay = v.displayName;
  if (displayName !== undefined && displayName !== null) {
    const dv = validateProfile(displayName);
    if (!dv.ok) return NextResponse.json({ error: `displayName: ${dv.reason}` }, { status: 400 });
    resolvedDisplay = dv.displayName;
  }

  // Account ids own the "hwa_" prefix; no handle or display name may take it.
  const handle = normalise(profile);
  if (RESERVED_HANDLE_RE.test(handle) || RESERVED_HANDLE_RE.test(normalise(resolvedDisplay))) {
    return NextResponse.json({ error: "That name is reserved" }, { status: 400 });
  }
  const taken = () => NextResponse.json({ error: "Name taken", exists: true }, { status: 409 });

  try {
    // Taken = a live handle, or (while blobsHoldName()) any blob under the
    // name's prefix, legacy suffixed ones included.
    // The store normalises: pass the raw name. normaliseProfile is not
    // idempotent (NFKC runs before lowercasing), so re-normalising `handle`
    // could land on a different key from the one every route writes under.
    // A held handle whose claim never got its marker is finished, not refused.
    const held = await dbResolveHandle(profile);
    let sk;
    if (held) {
      if (!(await unfinishedClaim(held))) return taken();
      sk = held.storageKey;
    } else {
      if (blobsHoldName()) {
        const { blobs } = await list({ prefix: profileDir(handle) });
        if (blobs.length > 0) return taken();
      }

      // Account + live handle in one transaction. A concurrent claim of the
      // same name loses on the live-handle index and writes nothing. The
      // storage key is the new account's id (CLAIM_MODE "claim"; "precutover"
      // keyed it by the handle). Storage keys are never reassigned, so a name
      // still keying a closed or lapsed account is claimed keyed by the new
      // id in either mode. null = no DB (dev): blob-only, by name.
      const mode = CLAIM_MODE === "claim" || (await dbAccountByStorageKey(handle)) ? "claim" : CLAIM_MODE;
      const claim = await dbClaimHandle({ handle: profile, display: resolvedDisplay, mode });
      if (claim?.taken) return taken();
      sk = claim?.taken === false ? claim.storageKey : handle;
    }

    // The claim marker: seeds displayName into meta on first push. No
    // overwrite: this is a claim, not an update. Without a DB a racing claim
    // makes this put error and the loser gets a 500, which the UI treats as
    // "try again" / "name taken".
    await put(
      metaPath(sk),
      JSON.stringify({
        displayName: resolvedDisplay,
        claimedAt: new Date().toISOString(),
        weights: {},
        reps: {},
        streak: { count: 0, lastDate: null },
      }),
      { access: "private", contentType: "application/json", addRandomSuffix: false },
    );

    return NextResponse.json({ ok: true, claimed: true });
  } catch (e) {
    return serverError(e);
  }
}

// DELETE /api/sync?profile=Name (X-HW-Auth: ceremony token)
// Deletes a profile's cloud data under its account's storage key: its photos
// (by its own index rows), its DB rows, its two snapshots and the enumerated
// files in its folder (meta, history, legacy suffixed copies, credentials
// docs). Anything else in the folder is kept and counted. Then closes the
// account: grants revoked, handles released (the name is free), consent
// cleared, passkey rows deleted. Requires a fresh, unscoped passkey ceremony
// token; a profile with no passkey must register one first.
export async function DELETE(request) {
  const limited = rateLimit(request, "sync-delete", 10);
  if (limited) return limited;
  try {
    const { searchParams } = new URL(request.url);
    const profile = searchParams.get("profile");
    // Header ONLY (finalised 2026-07-27). The app's law is "keys don't ride
    // URLs"; the query fallback existed briefly so a mid-deploy client wasn't
    // stranded, and every client has long since reloaded onto the header path
    // (lib/storage.js blobDelete). Retired so a wipe token can never land in
    // an access log or Referer again.
    const authToken = request.headers.get("x-hw-auth");

    const v = validateProfile(profile);
    if (!v.ok) return NextResponse.json({ error: v.reason }, { status: 400 });

    // ── The wipe gate. FAILS CLOSED, always. ────────────────────────────
    // Rewritten 2026-07-26 after the deep audit found two ways past it:
    //
    //  1. TRAVERSAL (critical): the token used to be read with a route-local
    //     blob helper, from the tokens prefix joined to the RAW, unencoded
    //     authToken. The SDK interpolates a pathname into a URL string and
    //     fetch() collapses "../" before the request leaves the process, so
    //     `authToken=../snapshots/daily/<name>.json` pointed the "token"
    //     read at that profile's own snapshot. The snapshot JSON then
    //     satisfied every check: it is truthy; `Date.now() > undefined` is
    //     false (NaN comparison, not a rejection); it has no `scope`; and
    //     its `profile` field matches. An anonymous caller could wipe anyone.
    //     readTokenData() encodes the token, and resolveTokenIdentity() requires
    //     `typeof expires === "number"` — either one alone kills that trick.
    //
    //  2. NO-PASSKEY PASS-THROUGH: the gate only ran `if (hasPasskeys)`, so
    //     any profile without a verifiable credential was deletable by
    //     anyone who could name it (/api/auth/check tells you which). The
    //     "don't lock legacy users out" intent was right for reads and
    //     wrong for the one irreversible verb. Deletion now requires proof
    //     of control, full stop — a profile with no passkey must register
    //     one first (requiresPasskeySetup), which is a recoverable prompt;
    //     an unrecoverable wipe is not.
    //
    // Reads the SAME token store the mint writes (readTokenData is DB-first
    // with the transition-era blob fallback) — the old blob-only read also
    // meant no DB-minted token could ever satisfy this gate, so the
    // legitimate passkey-protected wipe was broken in production.
    if (!authToken) {
      // The hint reads the passkeys of the account holding the name now.
      const account = await dbResolveHandle(profile);
      const credData = account ? await readCredentialSet(account) : null;
      return NextResponse.json(
        hasRealPasskey(credData)
          ? { error: "Passkey authentication required", requiresAuth: true }
          : { error: "Set up a passkey before deleting this profile", requiresPasskeySetup: true },
        { status: 401 },
      );
    }

    const tokenData = await readTokenData(authToken);
    const id = await resolveTokenIdentity(tokenData, profile, Date.now());
    if (!id) {
      return NextResponse.json(
        { error: "Invalid or expired auth token", requiresAuth: true },
        { status: 401 },
      );
    }
    // NO scoped token EVER satisfies the wipe gate — destructive ops keep
    // fresh-ceremony, short-lived, full-scope tokens.
    //
    // This is now load-bearing in a way it wasn't: the sync cookie added with
    // J1 is path-scoped to /api/sync, and DELETE lives on that path, so the
    // browser WILL attach it to a wipe request. Checking for one named scope
    // ("photos") would have let a 30-day sliding cookie authorise permanent
    // destruction. Rejecting ANY scope is the fail-closed shape: a new scope
    // added later is refused by default rather than silently admitted.
    if (tokenData.scope) {
      return NextResponse.json(
        { error: "Fresh passkey authentication required", requiresAuth: true },
        { status: 401 },
      );
    }
    // Everything below keys by the account's storage key, never the name.
    // Order: every step before the close can fail and be retried (the
    // account, its handle and its passkeys survive until the last step).
    const sk = id.storageKey;

    // Consume the used ceremony token (its DB row). Same announced
    // behaviour — the wipe path has always deleted its ceremony token.
    try { await dbDeleteToken(authToken); } catch {}

    let deleted = 0;
    if (hasDb()) {
      // Photo blobs by the account's OWN index rows, read before the rows go;
      // each path must sit under its own photos prefix. A previous holder's
      // retired rows are keyed elsewhere, so their blobs are never matched.
      const rows = await dbListPhotos(sk);
      const photoBlobs = rows
        .map((r) => r.blob_path)
        .filter((p) => typeof p === "string" && p.startsWith(photosPrefix(sk)));
      if (photoBlobs.length) {
        try { await del(photoBlobs); }
        catch (e) { return serverError(e, { label: "sync-delete-photos" }); }
        deleted += photoBlobs.length;
      }
      // DB rows go too (announced 2026-07-19, wipe protocol): same
      // user-initiated, passkey-gated scope as the blob deletes below —
      // enumerated tables, one storage key, nothing else.
      try { await dbDeleteProfile(sk); }
      catch (e) {
        // Refuse a half-wipe: if DB rows survive while blobs die, the next
        // GET would serve the "deleted" profile straight back from the DB.
        return serverError(e, { label: "sync-delete-db" });
      }
    }
    // Snapshot generations live OUTSIDE the profile prefix and must die
    // with the profile (announced with PR C, wipe protocol): two EXACT
    // enumerated paths, same user-initiated passkey-gated scope as
    // everything above. Best-effort — a missing snapshot is not an error.
    const snaps = snapshotPaths(sk);
    try {
      await del([snaps.daily, snaps.weekly]);
    } catch (e) {
      // Not fatal. del() resolves for a missing path ("does not throw if the
      // blob URL does not exist" — vercel.com/docs/vercel-blob/using-blob-sdk), so this
      // catch fires only on transport/auth/rate-limit/store errors — and it
      // is never silent: a failure here orphans a backup nothing rewrites.
      console.error(`[forge:sync-delete] snapshot delete failed: ${e?.message || e}`);
    }

    // The rest of the folder: only the enumerated file patterns, anchored to
    // this folder. Anything else under it is kept and counted.
    const dir = profileDir(sk);
    const listed = [];
    let cursor;
    do {
      const page = await list({ prefix: dir, cursor });
      listed.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    const junk = listed.filter((b) => b.pathname.startsWith(dir) && WIPE_FILE_RES.some((re) => re.test(b.pathname.slice(dir.length))));
    if (junk.length) {
      try {
        await del(junk.map((b) => b.url));
      } catch (e) {
        return serverError(e, { label: "sync-delete" });
      }
      deleted += junk.length;
    }

    // Close the account LAST (lib/identity-store.js dbCloseAccount): revoke
    // its grants (AI, and any trainer share it gave), release its handles,
    // close it and clear its consent, delete its passkey rows, revoke the
    // trainer grants naming it as trainer.
    // One transaction; a failure leaves it open and the wipe retryable.
    if (hasDb()) {
      try { await dbCloseAccount(id.accountId, sk); }
      catch (e) { return serverError(e, { label: "sync-delete-close" }); }
    }

    return NextResponse.json({ ok: true, deleted, kept: listed.length - junk.length });
  } catch (e) {
    return serverError(e);
  }
}
