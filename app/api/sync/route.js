import { put, list, del, get } from "@vercel/blob";
import { mergeMeta } from "@/lib/sync-merge";
import { readJsonByPrefix } from "@/lib/blob-utils";
import { hasRealPasskey } from "@/lib/auth-server";
import { NextResponse } from "next/server";

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

const normalise    = (name) => String(name || "").trim().toLowerCase();
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
  return { ok: true, normalised: trimmed.toLowerCase(), displayName: trimmed };
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
    const body = await request.json();
    return { ok: true, body };
  } catch (e) {
    return { ok: false, reason: "Invalid JSON", status: 400 };
  }
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
  const latest = matches.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
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

    // Fast path: read the deterministic paths in parallel. This is the
    // expected case for any profile written after the addRandomSuffix bug
    // was fixed.
    const [metaDirect, historyDirect] = await Promise.all([
      readJson(metaPath(profile)),
      readJson(historyPath(profile)),
    ]);

    // If both deterministic paths returned data, we're done.
    if (metaDirect !== null && historyDirect !== null) {
      return NextResponse.json({
        meta: metaDirect,
        history: Array.isArray(historyDirect) ? historyDirect : [],
      });
    }

    // Slow path: one or both deterministic reads came back empty. Either
    // this profile has never been written under the new scheme (legacy
    // suffixed blobs only), or partially migrated. List once and fall
    // back to the latest legacy blob for whichever side is missing.
    const { blobs } = await list({ prefix: legacyPrefix(profile) });

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

    return NextResponse.json({
      meta,
      history: Array.isArray(history) ? history : [],
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// PUT /api/sync
// Body: { profile: string, data: { meta?: object, history?: array } }
// Profile is case-insensitive. Display name should be passed inside meta.displayName.
export async function PUT(request) {
  // Parse the body via the size-guarded reader. Rejects oversize payloads
  // (>5MB) with 413 before any blob work, and malformed JSON with 400.
  const parsed = await safeReadJson(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.reason }, { status: parsed.status });
  }
  const { profile, data } = parsed.body;

  const v = validateProfile(profile);
  if (!v.ok) return NextResponse.json({ error: v.reason }, { status: 400 });
  if (!data) return NextResponse.json({ error: "No data" }, { status: 400 });

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
    if (data.meta) {
      const existingMeta = await readJson(metaPath(profile));
      const mergedMeta = existingMeta && typeof existingMeta === "object"
        ? mergeMeta(existingMeta, data.meta)
        : data.meta;
      await put(
        metaPath(profile),
        JSON.stringify({ ...mergedMeta, syncedAt: new Date().toISOString() }),
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
      if (!Array.isArray(existing)) {
        existing = await readLatestLegacy(blobs, LEGACY_HISTORY_RE);
      }
      if (!Array.isArray(existing)) existing = [];

      const byId = new Map();
      [...existing, ...data.history].forEach(rec => {
        if (rec && rec.id) byId.set(rec.id, rec);
      });
      const merged = Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));

      await put(
        historyPath(profile),
        JSON.stringify(merged),
        { access: "private", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false },
      );
      results.history = { count: merged.length };
    }

    // Legacy suffixed blob cleanup runs in the cron job (/api/cron/cleanup),
    // NOT in this hot path. An earlier version did it here per-PUT and was
    // implicated in production 500s — for profiles with hundreds of pre-
    // migration suffixed orphans, the batch `del()` either timed out the
    // function or hit a Vercel Blob API limit. The cron is the right home
    // for it: runs daily, paginates the list, batch-deletes in chunks,
    // tolerates failure. PUT stays small and predictable.

    return NextResponse.json({ ok: true, ...results });
  } catch (e) {
    // Tagged log so the runtime error surface tells us which call exploded
    // next time something goes wrong. Aggregate logs truncate without this.
    console.error("[forge:put:outer]", profile, e?.message || e, e?.stack);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/sync — name claim endpoint.
// Reserves a name with a minimal meta blob so subsequent existence checks resolve.
// Called immediately on profile creation so concurrent devices see the claim.
// Body: { profile: string, displayName: string }
// Returns 409 if the name is already taken.
export async function POST(request) {
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
    return NextResponse.json({ error: e.message }, { status: 500 });
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
  try {
    const { searchParams } = new URL(request.url);
    const profile = searchParams.get("profile");
    const authToken = searchParams.get("authToken");

    const v = validateProfile(profile);
    if (!v.ok) return NextResponse.json({ error: v.reason }, { status: 400 });

    // Gate deletion on a VERIFIABLE passkey. Read the credentials doc (blobs
    // carry a random suffix, so match the extensionless prefix — the old
    // `credentials.json` prefix never matched `credentials-XXX.json`, which
    // silently left this gate open) and require auth only when a real,
    // key-bearing credential exists. Keyless legacy credentials don't lock a
    // user out; they can re-register to re-protect. See lib/auth-server.js.
    const credData = await readJsonByPrefix(
      `forge/profiles/${encodeURIComponent(normalise(profile))}/credentials`,
    );
    const hasPasskeys = hasRealPasskey(credData);

    // If a real passkey exists, require a valid auth token.
    if (hasPasskeys) {
      if (!authToken) {
        return NextResponse.json(
          { error: "Passkey authentication required", requiresAuth: true },
          { status: 401 }
        );
      }

      // Verify auth token
      const tokenKey = `forge/tokens/${authToken}`;
      const tokenData = await readJson(tokenKey);

      if (!tokenData) {
        return NextResponse.json(
          { error: "Invalid or expired auth token", requiresAuth: true },
          { status: 401 }
        );
      }

      if (Date.now() > tokenData.expires) {
        return NextResponse.json(
          { error: "Auth token expired", requiresAuth: true },
          { status: 401 }
        );
      }

      if (tokenData.profile !== normalise(profile)) {
        return NextResponse.json(
          { error: "Auth token does not match profile" },
          { status: 403 }
        );
      }

      // Clean up the used token
      try {
        const { blobs: tokenBlobs } = await list({ prefix: tokenKey });
        if (tokenBlobs.length) {
          await del(tokenBlobs.map(b => b.url));
        }
      } catch {}
    }

    // Proceed with deletion
    const { blobs } = await list({ prefix: legacyPrefix(profile) });
    if (!blobs.length) {
      return NextResponse.json({ ok: true, deleted: 0 });
    }

    try {
      await del(blobs.map(b => b.url));
    } catch (e) {
      return NextResponse.json({ error: `Delete failed: ${e.message}` }, { status: 500 });
    }

    return NextResponse.json({ ok: true, deleted: blobs.length });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
