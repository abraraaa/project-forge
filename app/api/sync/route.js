import { put, list, del, get } from "@vercel/blob";
import { rateLimit } from "@/lib/rate-limit";
import { mergeMeta, mergeHistories, mergeMetaFields, fieldClosure } from "@/lib/sync-merge";
import { readJsonByPrefix } from "@/lib/blob-utils";
import { hasRealPasskey, readTokenData, isTokenValid, mintAuthToken } from "@/lib/auth-server";
import { hasDb, dbReadProfile, dbUpsertProfile, dbDeleteProfile, dbDeleteToken, dbReadProfileSince, dbReadMetaFields, dbCursorNow } from "@/lib/db";
import { NextResponse } from "next/server";

// Generic client error + full server-side log. Raw exception text (Neon/blob
// driver detail, query fragments, schema names) must not reach the client —
// audit 2026-07-26, P3 info-disclosure. Detail stays in the server log.
function serverError(e, { status = 500, label = "sync" } = {}) {
  console.error(`[forge:${label}]`, e?.stack || e?.message || e);
  return NextResponse.json({ error: "Something went wrong. Try again." }, { status });
}

// Blob layout (case-insensitive — path uses lowercase, display name lives in meta):
//   forge/profiles/{lowerName}/meta.json    — weights, reps, streak, programmeBlock, displayName
//   forge/profiles/{lowerName}/history.json — full session history (append-only)
//
// Store access: PRIVATE.
// Requires @vercel/blob@^2 (adds private-store support + get() for auth'd reads).
//
// PATH SCHEME: deterministic. We use { allowOverwrite: true } rather than
// addRandomSuffix because addRandomSuffix inserts the suffix BEFORE the
// extension (per Vercel docs: 'avatar-oYnXSVc….jpg', not 'avatar.jpg-oYnXSVc…').
// An earlier version used addRandomSuffix and tried to find writes back via
// `pathname === path || pathname.startsWith(path + '-')` — that pattern
// never matches the actual format, so every PUT wrote a blob the GET could
// never read. Sync looked silently fine (200s on both sides) but cross-
// device round-trip returned empty for every user. Determ paths eliminate
// the read-back guesswork entirely.

// NFKC before lowercasing (deep audit 2026-07-26). Without canonicalisation,
// codepoints that lowercase to the same letter (e.g. the Kelvin sign U+212A →
// "k") collapse onto one path while visually identical composed/decomposed
// forms (café NFC vs NFD) resolve to DIFFERENT profiles — a squatting and
// impersonation surface on a namespace where the NAME is the identity.
const normalise    = (name) => String(name || "").normalize("NFKC").trim().toLowerCase();
const metaPath     = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/meta.json`;
const historyPath  = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/history.json`;
// Trailing slash is load-bearing — without it, list() does a prefix match that
// catches adjacent names (e.g. "analmonk" would hit "analmonkey/meta.json").
const legacyPrefix = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/`;

// Identifies legacy addRandomSuffix blobs from the broken era — pathnames of
// the form `…/meta-XXXX.json` and `…/history-XXXX.json`. Used for one-shot
// migration on read (fall back to latest suffixed blob if deterministic path
// is empty) and for cleanup on write (delete obsolete suffixed blobs once the
// new deterministic blob has been written).
const LEGACY_META_RE    = /\/meta-[^/]+\.json$/;
const LEGACY_HISTORY_RE = /\/history-[^/]+\.json$/;

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
  if (PATH_SEPS_RE.test(trimmed)) {
    return { ok: false, reason: "Profile contains path separators" };
  }
  // Dot-only names ("." / ".." / "...") — defence in depth. encodeURIComponent
  // leaves dots untouched, so such a name reaches the store as a relative path
  // segment. Whether the platform collapses it is a property of someone else's
  // code that could change without notice; the wipe gate's traversal (fixed in
  // #251) is what that assumption cost last time.
  if (/^\.+$/.test(trimmed)) {
    return { ok: false, reason: "Profile name cannot be dots" };
  }
  return { ok: true, normalised: normalise(trimmed), displayName: trimmed };
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

// ─── The sync gate (J1, boss decision 2026-07-26) ───────────────────────────
// Until now GET/PUT/POST here asserted nothing about WHO was calling: the
// profile name was the only key, so anyone who could guess a handle could
// read a stranger's training history and bodyweight, and merge-write into it.
// The auth machinery built through July (SimpleWebAuthn, auth_tokens, the
// photo cookie) was wired into /api/photos and /api/bugs and never into the
// route that carries the most data.
//
// The contract now matches /api/photos exactly — the token's STORED profile
// is compared against the REQUESTED profile, and every path below is derived
// from the gate's normalised value, so there is no seam between what was
// authorised and what gets used.
//
// WHY A COOKIE, not the in-memory ceremony token: sync is ambient (visibility
// change, reconnect, every mutation). A memory-only token dies with the tab,
// so binding sync to it would demand Face ID before a fresh tab could sync.
// The sliding httpOnly cookie means a ceremony only after a week of NOT
// using the app on this device — never once per tab. It
// is never readable by JS, so lib/auth-session.js's "nothing plaintext gets
// thrown around" law holds — that law governs JS-readable persistence.
//
// WHAT STAYS OPEN, deliberately:
//   · POST (name claim) — the bootstrap. You cannot hold a token for a
//     profile that does not exist yet. Claiming grants nothing: a claimed
//     profile with no passkey syncs nothing in or out.
//   · GET ?check=1 — name availability, needed BEFORE a claim exists.
// Both are pre-identity by construction, and neither returns user data.
//
// A profile with no passkey keeps working FOREVER, locally: the app is
// local-first (lib/storage.js — "loads INSTANTLY from localStorage, works
// offline"). It simply does not sync. That is the product story, not a
// punishment: your training lives on your device; a passkey is what carries
// it between devices.
// SLIDING 7 days, matching hw_photos exactly (boss, 2026-07-26). The window
// length is not a UX dial: because ANY active day rotates it, a trusted
// high-touch device never re-auths no matter what this number is. A longer
// window therefore buys the honest user nothing and hands a LOST phone extra
// days. 7 is the tighter choice at identical convenience — the same reasoning
// that set the photo cookie, applied consistently rather than re-litigated.
const SYNC_TTL_MS = 7 * 86400000;
const SYNC_ROTATE_AFTER_MS = 86400000;   // any active day slides it
// ...but the chain is not infinite: rotation stops at 90 days from the
// ORIGINAL ceremony, so a credential used daily forever still comes back to a
// passkey once a quarter. Without a ceiling, one captured cookie renews itself
// for life (deep audit finding against the photo cookie — not repeated here).
const SYNC_ABSOLUTE_CAP_MS = 90 * 86400000;
export const SYNC_COOKIE = "hw_sync";
const SYNC_COOKIE_OPTS = {
  httpOnly: true, secure: true, sameSite: "strict",
  path: "/api/sync", maxAge: 7 * 86400,
};

/** Attach a rotated sync cookie (if the gate minted one) to a success response. */
const withSyncCookie = (res, g) => {
  if (g?.refresh) res.cookies.set(SYNC_COOKIE, g.refresh, SYNC_COOKIE_OPTS);
  return res;
};

/**
 * Resolve and verify the caller for a profile-scoped sync request.
 * Returns { profile } on success (plus `refresh` when the cookie slid), or
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
  if (!isTokenValid(data, profile, Date.now())) {
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
        profile, ttlMs: SYNC_TTL_MS, scope: "sync",
        authAt: data.authAt || data.createdAt || null,
      });
    }
  }
  return { profile: normalise(profile), refresh };
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
    // The check=1 endpoint still uses list because it needs to know if ANY
    // blob exists for this profile name (including legacy suffixed ones —
    // we don't want to release a name that was previously claimed under the
    // old broken scheme).
    if (check) {
      const { blobs } = await list({ prefix: legacyPrefix(profile) });
      return NextResponse.json({ exists: blobs.length > 0 });
    }

    // Everything past here returns the PROFILE'S OWN DATA — gated.
    // (check=1 above is deliberately open: it predates any identity and
    // reveals only whether a name is taken, which a claim attempt would
    // reveal anyway.)
    const gate = await syncGate(request, profile);
    if (gate.fail) return gate.fail;

    // ── Delta pull (#2 family — docs/delta-sync.md) ─────────────────────
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
      const delta = await dbReadProfileSince(normalise(profile), since);
      return withSyncCookie(NextResponse.json({ delta: true, ...delta }), gate);
    }

    // DB-first (Neon migration step 2): if the profile has rows, serve them.
    // Blob remains the fallback + the lazy-migration source below. A DB
    // failure degrades to the blob path — never a 500 from this branch.
    if (hasDb()) {
      try {
        const fromDb = await dbReadProfile(normalise(profile));
        if (fromDb) return withSyncCookie(NextResponse.json(fromDb), gate);
      } catch (e) {
        console.error("[forge:sync GET] db read failed, falling back to blob:", e?.message || e);
      }
    }

    // Fast path: read the deterministic paths in parallel. This is the
    // expected case for any profile written after the addRandomSuffix bug
    // was fixed.
    const [metaDirect, historyDirect] = await Promise.all([
      readJson(metaPath(profile)),
      readJson(historyPath(profile)),
    ]);

    // If both deterministic paths returned data, we're done — and this is
    // the LAZY MIGRATION moment: the DB had no rows for this profile, the
    // blob does, so backfill the DB from what we just read (idempotent:
    // sessions ON CONFLICT DO NOTHING, meta upsert). No import ceremony,
    // no separate endpoint; each profile migrates on its first post-deploy
    // read. Blobs are never deleted. Failure is logged and harmless — the
    // next read retries.
    if (metaDirect !== null && historyDirect !== null) {
      if (hasDb()) {
        try {
          await dbUpsertProfile(normalise(profile), {
            meta: metaDirect,
            history: Array.isArray(historyDirect) ? historyDirect : [],
          });
        } catch (e) {
          console.error("[forge:sync GET] lazy backfill failed:", e?.message || e);
        }
      }
      return withSyncCookie(NextResponse.json({
        meta: metaDirect,
        history: Array.isArray(historyDirect) ? historyDirect : [],
      }), gate);
    }

    // Slow path: one or both deterministic reads came back empty. Either
    // this profile has never been written under the new scheme (legacy
    // suffixed blobs only), or partially migrated. List once and fall
    // back to the latest legacy blob for whichever side is missing.
    const { blobs } = await list({ prefix: legacyPrefix(profile) });

    // Read-failure guard (audit #13, same class as PUT's #7): a null read
    // for a blob the LIST says exists is a transient failure, not absence.
    // Returning 200+empty here was indistinguishable from a genuinely new
    // profile — the client would then treat real data as gone. 503 lets
    // the client retry instead.
    const existsInList = (path) => blobs.some((b) => b.pathname === path);
    if ((metaDirect === null && existsInList(metaPath(profile))) ||
        (historyDirect === null && existsInList(historyPath(profile)))) {
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

  // ── Delta push (#2 family — docs/delta-sync.md) ────────────────────────
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
      const norm = normalise(profile);
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

  // ── Fat PUT, DB era (PR C — docs/delta-sync.md): DUAL-WRITE RETIRED ────
  // The DB is the store; meta/history blobs are no longer written (the
  // snapshot cron owns blob durability now; the claim blob remains the
  // name marker). Merge base comes from the DB; a profile with no rows yet
  // (unmigrated, dormant since the blob era) seeds its base from the old
  // blobs — read-only, with the #7 unreadable-guard intact.
  if (hasDb()) {
    try {
      const norm = normalise(profile);
      const fromDb = await dbReadProfile(norm);
      let baseMeta = fromDb?.meta || null;
      let baseHistory = fromDb?.history || null;
      if (!fromDb) {
        const { blobs } = await list({ prefix: legacyPrefix(profile) });
        const blobExists = (path) => blobs.some((b) => b.pathname === path);
        const meta = await readJson(metaPath(profile));
        if (meta === null && blobExists(metaPath(profile))) {
          return NextResponse.json({ error: "Meta blob unreadable — refusing to overwrite; retry" }, { status: 503 });
        }
        let history = await readJson(historyPath(profile));
        if (history === null && blobExists(historyPath(profile))) {
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
    const { blobs } = await list({ prefix: legacyPrefix(profile) });

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
      const existingMeta = await readJson(metaPath(profile));
      if (existingMeta === null && blobExists(metaPath(profile))) {
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
        metaPath(profile),
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
      let existing = await readJson(historyPath(profile));
      if (existing === null && blobExists(historyPath(profile))) {
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
        historyPath(profile),
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

// POST /api/sync — name claim endpoint.
// Reserves a name with a minimal meta blob so subsequent existence checks resolve.
// Called immediately on profile creation so concurrent devices see the claim.
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

  try {
    // Existence check stays list-based so it catches legacy suffixed
    // blobs from the broken-suffix era — a name claimed previously under
    // that scheme should still be treated as taken.
    const { blobs } = await list({ prefix: legacyPrefix(profile) });
    if (blobs.length > 0) {
      return NextResponse.json({ error: "Name taken", exists: true }, { status: 409 });
    }

    // Deterministic write. allowOverwrite stays false (default) — this is
    // a claim, not an update, and the list check above already proved the
    // name is free. If a concurrent claim races, the put errors and the
    // race-loser gets a 500; the UI's claim flow treats that as "try
    // again" / "name taken" anyway.
    await put(
      metaPath(profile),
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

// DELETE /api/sync?profile=Name&authToken=xxx
// Nukes all cloud data for a profile: meta, history, credentials, the lot.
// Releases the name so it can be claimed again.
//
// If the profile has passkeys registered, requires a valid authToken from
// successful passkey authentication. Profiles without passkeys can still
// be deleted freely (legacy behaviour for migration).
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
    //     readTokenData() encodes the token, and isTokenValid() requires
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
      const credData = await readJsonByPrefix(
        `forge/profiles/${encodeURIComponent(normalise(profile))}/credentials`,
      );
      return NextResponse.json(
        hasRealPasskey(credData)
          ? { error: "Passkey authentication required", requiresAuth: true }
          : { error: "Set up a passkey before deleting this profile", requiresPasskeySetup: true },
        { status: 401 },
      );
    }

    const tokenData = await readTokenData(authToken);
    if (!isTokenValid(tokenData, profile, Date.now())) {
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

    // Consume the used token (relocated with Rec 11b: DB row first, blob
    // best-effort for transition-era tokens). Same announced behaviour —
    // the wipe path has always deleted its ceremony token on success.
    // Encoded to match the mint path, so the delete aims where the write landed.
    try {
      await dbDeleteToken(authToken);
      const { blobs: tokenBlobs } = await list({
        prefix: `forge/tokens/${encodeURIComponent(authToken)}`,
      });
      if (tokenBlobs.length) {
        await del(tokenBlobs.map(b => b.url));
      }
    } catch {}

    // Proceed with deletion. DB rows go too (announced 2026-07-19, wipe
    // protocol): same user-initiated, passkey-gated scope as the blob
    // deletes below — enumerated tables, single profile, nothing else.
    if (hasDb()) {
      try { await dbDeleteProfile(normalise(profile)); }
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
    const enc = encodeURIComponent(normalise(profile));
    try {
      await del([
        `forge/snapshots/daily/${enc}.json`,
        `forge/snapshots/weekly/${enc}.json`,
      ]);
    } catch { /* nonexistent snapshots — nothing to remove */ }

    const { blobs } = await list({ prefix: legacyPrefix(profile) });
    if (!blobs.length) {
      return NextResponse.json({ ok: true, deleted: 0 });
    }

    try {
      await del(blobs.map(b => b.url));
    } catch (e) {
      return serverError(e, { label: "sync-delete" });
    }

    return NextResponse.json({ ok: true, deleted: blobs.length });
  } catch (e) {
    return serverError(e);
  }
}
