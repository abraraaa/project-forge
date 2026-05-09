import { put, list, del, get } from "@vercel/blob";
import { NextResponse } from "next/server";

// Blob layout (case-insensitive — path uses lowercase, display name lives in meta):
//   forge/profiles/{lowerName}/meta.json    — weights, reps, streak, programmeBlock, displayName
//   forge/profiles/{lowerName}/history.json — full session history (append-only)
//
// Store access: PRIVATE.
// Requires @vercel/blob@^2 (adds private-store support + get() for auth'd reads).

const normalise    = (name) => String(name || "").trim().toLowerCase();
const metaPath     = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/meta.json`;
const historyPath  = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/history.json`;
// Trailing slash is load-bearing — without it, list() does a prefix match that
// catches adjacent names (e.g. "analmonk" would hit "analmonkey/meta.json").
const legacyPrefix = (name) => `forge/profiles/${encodeURIComponent(normalise(name))}/`;

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
    const { blobs } = await list({ prefix: legacyPrefix(profile) });

    if (check) {
      return NextResponse.json({ exists: blobs.length > 0 });
    }

    if (!blobs.length) return NextResponse.json(null, { status: 404 });

    const findLatest = (pathMatch) => {
      const matches = blobs.filter(b => b.pathname === pathMatch || b.pathname.startsWith(`${pathMatch}-`));
      if (!matches.length) return null;
      return matches.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    };

    const metaBlob    = findLatest(metaPath(profile));
    const historyBlob = findLatest(historyPath(profile));

    const [meta, history] = await Promise.all([
      metaBlob    ? readJson(metaBlob.pathname)    : Promise.resolve(null),
      historyBlob ? readJson(historyBlob.pathname) : Promise.resolve(null),
    ]);

    return NextResponse.json({ meta, history: Array.isArray(history) ? history : [] });
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

    // ── Meta write ──────────────────────────────────────────────
    if (data.meta) {
      // Clear prior meta blobs (they have random suffixes, so no natural overwrite)
      const { blobs } = await list({ prefix: legacyPrefix(profile) });
      const obsolete = blobs.filter(b =>
        b.pathname === metaPath(profile) ||
        b.pathname.startsWith(`${metaPath(profile)}-`)
      );
      if (obsolete.length) {
        try { await del(obsolete.map(b => b.url)); } catch {}
      }
      await put(
        metaPath(profile),
        JSON.stringify({ ...data.meta, syncedAt: new Date().toISOString() }),
        { access: "private", contentType: "application/json", addRandomSuffix: true }
      );
      results.meta = true;
    }

    // ── History write (merge with remote) ───────────────────────
    if (Array.isArray(data.history)) {
      const { blobs } = await list({ prefix: historyPath(profile) });

      let existing = [];
      const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
      if (latest) {
        const pulled = await readJson(latest.pathname);
        if (Array.isArray(pulled)) existing = pulled;
      }

      const byId = new Map();
      [...existing, ...data.history].forEach(rec => {
        if (rec && rec.id) byId.set(rec.id, rec);
      });
      const merged = Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));

      if (blobs.length) {
        try { await del(blobs.map(b => b.url)); } catch {}
      }
      await put(
        historyPath(profile),
        JSON.stringify(merged),
        { access: "private", contentType: "application/json", addRandomSuffix: true }
      );
      results.history = { count: merged.length };
    }

    return NextResponse.json({ ok: true, ...results });
  } catch (e) {
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
    const { blobs } = await list({ prefix: legacyPrefix(profile) });
    if (blobs.length > 0) {
      return NextResponse.json({ error: "Name taken", exists: true }, { status: 409 });
    }

    await put(
      metaPath(profile),
      JSON.stringify({
        displayName: resolvedDisplay,
        claimedAt: new Date().toISOString(),
        weights: {},
        reps: {},
        streak: { count: 0, lastDate: null },
      }),
      { access: "private", contentType: "application/json", addRandomSuffix: true }
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

    // Check if this profile has passkeys
    const credentialsPrefix = `forge/profiles/${encodeURIComponent(normalise(profile))}/credentials.json`;
    const { blobs: credBlobs } = await list({ prefix: credentialsPrefix });
    const hasPasskeys = credBlobs.length > 0;

    // If passkeys exist, require auth token
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
